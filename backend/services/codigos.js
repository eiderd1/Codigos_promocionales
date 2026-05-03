const supabase = require('../config/supabase');

const HITOS_DORADOS = [30, 8000, 9000, 9800];

async function generarCodigos(cantidad, referencia) {
  try {

    const { count: vendidos } = await supabase
      .from('codigos')
      .select('*', { count: 'exact', head: true })
      .eq('vendido', true);

    const { count: doradosEntregados } = await supabase
      .from('codigos')
      .select('*', { count: 'exact', head: true })
      .eq('dorado', true)
      .eq('vendido', true);

    // 🔀 Obtener más códigos para mezclar
    const { data: disponibles, error } = await supabase
      .from('codigos')
      .select('codigo')
      .eq('vendido', false)
      .limit(cantidad * 10);

    if (error || !disponibles?.length) {
      console.error("❌ Error obteniendo códigos:", error);
      return [];
    }

    // 🔀 Mezclar y tomar los necesarios
    const mezclados = disponibles
      .sort(() => Math.random() - 0.5)
      .slice(0, cantidad);

    let indexDorado = -1;

    if (doradosEntregados < HITOS_DORADOS.length) {
      const siguienteHito = HITOS_DORADOS[doradosEntregados];
      if (vendidos < siguienteHito && (vendidos + cantidad) >= siguienteHito) {
        indexDorado = Math.floor(Math.random() * mezclados.length);
      }
    }

    const resultado = [];

    for (let i = 0; i < mezclados.length; i++) {
      const c = mezclados[i];
      const esDorado = i === indexDorado;

      // 🔒 Solo actualiza si sigue disponible (anti-repetición)
      const { data: actualizado, error: errorUpdate } = await supabase
        .from('codigos')
        .update({
          vendido: true,
          referencia,
          dorado: esDorado
        })
        .eq('codigo', c.codigo)
        .eq('vendido', false)  // ← solo si no fue vendido por otra transacción
        .select('codigo');

      if (errorUpdate) {
        console.error("❌ Error actualizando código:", c.codigo, errorUpdate);
        continue;
      }

      // Si no se actualizó es porque ya fue vendido — saltar
      if (!actualizado || actualizado.length === 0) {
        console.log("⚠️ Código ya vendido, saltando:", c.codigo);
        continue;
      }

      resultado.push({ codigo: c.codigo, dorado: esDorado });
    }

    // Si no alcanzaron los códigos únicos, avisar
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