const supabase = require('../config/supabase');

// 🎯 HITOS CONTROLADOS (para 10.000 códigos)
const HITOS_DORADOS = [7000, 8000, 9000, 9800];

async function generarCodigos(cantidad, referencia) {
  try {

    // 🔢 TOTAL VENDIDOS
    const { count: vendidos } = await supabase
      .from('codigos')
      .select('*', { count: 'exact', head: true })
      .eq('vendido', true);

    // 🔢 CUÁNTOS DORADOS YA SALIERON
    const { count: doradosEntregados } = await supabase
      .from('codigos')
      .select('*', { count: 'exact', head: true })
      .eq('dorado', true);

    // 🎟️ CÓDIGOS DISPONIBLES
    const { data: disponibles, error } = await supabase
      .from('codigos')
      .select('id, codigo')
      .eq('vendido', false)
      .limit(cantidad);

    if (error || !disponibles?.length) {
      console.error("❌ Error obteniendo códigos:", error);
      return [];
    }

    let indexDorado = -1;

    // 🎯 VALIDAR SI DEBE SALIR UN DORADO
    if (doradosEntregados < HITOS_DORADOS.length) {

      const siguienteHito = HITOS_DORADOS[doradosEntregados];

      // 🔥 SOLO CUANDO SE CRUZA EL HITO
      if (vendidos < siguienteHito && (vendidos + cantidad) >= siguienteHito) {
        indexDorado = Math.floor(Math.random() * disponibles.length);
      }
    }

    const resultado = [];

    for (let i = 0; i < disponibles.length; i++) {

      const c = disponibles[i];
      const esDorado = i === indexDorado;

      await supabase
        .from('codigos')
        .update({
          vendido: true,
          referencia,
          dorado: esDorado
        })
        .eq('id', c.id);

      resultado.push({
        codigo: c.codigo,
        dorado: esDorado
      });
    }

    return resultado;

  } catch (error) {
    console.error("💥 Error generarCodigos:", error);
    return [];
  }
}

module.exports = { generarCodigos };