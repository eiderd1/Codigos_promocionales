const supabase = require('../config/supabase');
const { getPromoActiva } = require('./promociones');
const { CONFIG } = require('./appState');

// Hitos dorados como % del total de números de la dinámica actual, para que
// escalen automáticamente sin importar si el pool tiene 1.000 o 100.000 números.
const PORCENTAJES_HITOS_DORADOS = [0.07, 0.80, 0.90, 0.9999];

function calcularHitosDorados(totalReal) {
  const total = totalReal || CONFIG.total_numeros || 10000;
  return PORCENTAJES_HITOS_DORADOS
    .map(p => Math.max(1, Math.round(total * p)))
    .sort((a, b) => a - b);
}

async function generarCodigos(cantidad, referencia, datosComprador = {}) {
  const { nombre = null, email = null, telefono = null } = datosComprador;
  try {
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

    // ─── 3. Lógica de código dorado (hitos calculados sobre el total real) ───
    const HITOS_DORADOS = calcularHitosDorados(totalPool);
    let indexDorado = -1;
    if (doradosEntregados < HITOS_DORADOS.length) {
      const siguienteHito = HITOS_DORADOS[doradosEntregados];
      if (vendidos < siguienteHito && (vendidos + cantidad) >= siguienteHito) {
        indexDorado = Math.floor(Math.random() * mezclados.length);
      }
    }

    // ─── 4. Consultar promo activa para guardar el premio ───────────────────────
    const promo = await getPromoActiva();
    const premioDorado = promo ? promo.precio_dorado : (CONFIG.precio_dorado || 500000);

    // ─── 5. Actualizar en BD (anti-repetición igual que antes) ───────────────
    const resultado = [];

    for (let i = 0; i < mezclados.length; i++) {
      const c = mezclados[i];
      const esDorado = i === indexDorado;

      const { data: actualizado, error: errorUpdate } = await supabase
        .from('codigos')
        .update({
          vendido: true, referencia, dorado: esDorado, premio_dorado: esDorado ? premioDorado : null,
          nombre, email, telefono
        })
        .eq('codigo', c.codigo)
        .eq('vendido', false)
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
      console.warn(`⚠️ Solo se pudieron asignar ${resultado.length} de ${cantidad} códigos`);
    }

    return resultado;

  } catch (error) {
    console.error("💥 Error generarCodigos:", error);
    return [];
  }
}

module.exports = { generarCodigos };