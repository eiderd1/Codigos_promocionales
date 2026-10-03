const supabase = require('../config/supabase');
const { getPromoActiva } = require('./promociones');
const { CONFIG } = require('./appState');
const { actualizarConfig } = require('./configStore');

// Hitos dorados como % del total de números de la dinámica actual, para que
// escalen automáticamente sin importar si el pool tiene 1.000 o 100.000 números.
const PORCENTAJES_HITOS_DORADOS = [0.07, 0.80, 0.90, 0.9999];

function calcularHitosDorados(totalReal) {
  const total = totalReal || CONFIG.total_numeros || 10000;
  return PORCENTAJES_HITOS_DORADOS
    .map(p => Math.max(1, Math.round(total * p)))
    .sort((a, b) => a - b);
}

async function liberarReservasTransferenciaExpiradas() {
  try {
    const ahora = new Date().toISOString();
    const { data: vencidas, error } = await supabase
      .from('compras')
      .select('referencia')
      .eq('estado', 'transferencia_pendiente')
      .not('reserva_expira_at', 'is', null)
      .lt('reserva_expira_at', ahora)
      .limit(500);
    if (error || !vencidas?.length) return 0;

    const refs = vencidas.map(x => x.referencia);
    const { error: errCodigos } = await supabase
      .from('codigos')
      .update({ reservado: false, referencia: null })
      .eq('reservado', true)
      .in('referencia', refs);
    if (errCodigos) throw errCodigos;

    const { error: errCompras } = await supabase
      .from('compras')
      .update({ estado: 'transferencia_expirada' })
      .in('referencia', refs)
      .eq('estado', 'transferencia_pendiente');
    if (errCompras) throw errCompras;

    console.log(`⏰ Reservas de transferencia liberadas: ${refs.length}`);
    return refs.length;
  } catch (e) {
    console.error('❌ Error liberando reservas expiradas:', e.message);
    return 0;
  }
}

async function generarCodigos(cantidad, referencia, datosComprador = {}) {
  const { nombre = null, email = null, telefono = null } = datosComprador;
  try {
    await liberarReservasTransferenciaExpiradas();

    const { count: vendidos } = await supabase
      .from('codigos')
      .select('*', { count: 'exact', head: true })
      .eq('vendido', true);

    const { count: totalPool } = await supabase
      .from('codigos')
      .select('*', { count: 'exact', head: true });

    const { count: doradosEntregados } = await supabase
      .from('codigos')
      .select('*', { count: 'exact', head: true })
      .eq('dorado', true)
      .eq('vendido', true);

    // ─── 1. Obtener TODOS los códigos disponibles (ordenados) ────────────────
    const { data: disponibles, error } = await supabase
      .from('codigos')
      .select('codigo')
      .eq('vendido', false)
      .eq('reservado', false)
      .order('codigo', { ascending: true }); // orden numérico

    if (error || !disponibles?.length) {
      console.error("❌ Error obteniendo códigos:", error);
      return [];
    }

    // ─── 2. Dividir en zonas y tomar uno aleatorio de cada zona ──────────────
    const total = disponibles.length;
    const tamañoZona = Math.floor(total / cantidad);
    const mezclados = [];

    for (let i = 0; i < cantidad; i++) {
      const inicio = i * tamañoZona;
      const fin = i === cantidad - 1 ? total : inicio + tamañoZona;
      // índice aleatorio dentro de esta zona
      const idx = inicio + Math.floor(Math.random() * (fin - inicio));
      mezclados.push(disponibles[idx]);
    }

    // ─── 3. Lógica de código dorado — revisa TODOS los hitos que esta compra
    // cruza de una vez (no solo el siguiente), por si la compra es grande y
    // salta varios hitos en una sola transacción ──────────────────────────
    const HITOS_DORADOS = calcularHitosDorados(totalPool);
    const hitosPendientes = HITOS_DORADOS.slice(doradosEntregados);
    const hitosCruzados = hitosPendientes.filter(
      h => vendidos < h && (vendidos + cantidad) >= h
    );

    // Elegir tantos índices dorados como hitos se cruzaron (sin repetir),
    // sin pasarse de la cantidad de códigos que se están vendiendo
    const cantidadDorados = Math.min(hitosCruzados.length, mezclados.length);
    const indicesDisponibles = [...Array(mezclados.length).keys()];
    const indicesDorados = [];
    for (let i = 0; i < cantidadDorados; i++) {
      const pos = Math.floor(Math.random() * indicesDisponibles.length);
      indicesDorados.push(indicesDisponibles.splice(pos, 1)[0]);
    }

    // ─── 4. Consultar promo activa para guardar el premio ───────────────────────
    const promo = await getPromoActiva();
    const premioDorado = promo ? promo.precio_dorado : (CONFIG.precio_dorado || 500000);

    // ─── 5. Actualizar en BD (anti-repetición igual que antes) ───────────────
    const resultado = [];

    for (let i = 0; i < mezclados.length; i++) {
      const c = mezclados[i];
      const esDorado = indicesDorados.includes(i);

      const { data: actualizado, error: errorUpdate } = await supabase
        .from('codigos')
        .update({
          vendido: true, referencia, dorado: esDorado, premio_dorado: esDorado ? premioDorado : null,
          nombre, email, telefono
        })
        .eq('codigo', c.codigo)
        .eq('vendido', false)
        .eq('reservado', false)
        .select('codigo');

      if (errorUpdate) {
        console.error("❌ Error actualizando código:", c.codigo, errorUpdate);
        continue;
      }

      if (!actualizado || actualizado.length === 0) {
        console.log("⚠️ Código ya vendido, saltando:", c.codigo);
        continue;
      }

      resultado.push({ codigo: c.codigo, dorado: esDorado, premioDorado: esDorado ? premioDorado : null });
    }

    if (resultado.length < cantidad) {
      console.warn(`⚠️ Solo se pudieron asignar ${resultado.length} de ${cantidad} códigos; se revierte la reserva.`);
      if (resultado.length > 0) {
        const refs = resultado.map(c => c.codigo);
        await supabase.from('codigos')
          .update({ vendido:false, referencia:null, premio_dorado:null, nombre:null, email:null, telefono:null, dorado:false })
          .in('codigo', refs);
      }
      return [];
    }

    // ─── 6. Si con esta venta se agotó el pool, pausar ventas automáticamente ──
    const { count: disponiblesFinal } = await supabase
      .from('codigos')
      .select('*', { count: 'exact', head: true })
      .eq('vendido', false);

    if (disponiblesFinal === 0 && CONFIG.ventas_activas) {
      await actualizarConfig({ ventas_activas: false });
      console.log('🔒 Pool agotado — ventas pausadas automáticamente');
    }

    return resultado;

  } catch (error) {
    console.error("💥 Error generarCodigos:", error);
    return [];
  }
}

module.exports = { generarCodigos, liberarReservasTransferenciaExpiradas };