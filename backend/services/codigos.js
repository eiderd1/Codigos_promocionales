const supabase = require('../config/supabase');

const HITOS_DORADOS = [7000, 8000, 9000, 9800];

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

    const { data: disponibles, error } = await supabase
      .from('codigos')
      .select('codigo')
      .eq('vendido', false)
      .limit(cantidad);

    if (error || !disponibles?.length) {
      console.error("❌ Error obteniendo códigos:", error);
      return [];
    }

    let indexDorado = -1;

    if (doradosEntregados < HITOS_DORADOS.length) {
      const siguienteHito = HITOS_DORADOS[doradosEntregados];
      if (vendidos < siguienteHito && (vendidos + cantidad) >= siguienteHito) {
        indexDorado = Math.floor(Math.random() * disponibles.length);
      }
    }

    const resultado = [];

    for (let i = 0; i < disponibles.length; i++) {
      const c = disponibles[i];
      const esDorado = i === indexDorado;

      const { error: errorUpdate } = await supabase
        .from('codigos')
        .update({
          vendido: true,
          referencia,
          dorado: esDorado
        })
        .eq('codigo', c.codigo)
        .eq('vendido', false);

      if (errorUpdate) {
        console.error("❌ Error actualizando código:", c.codigo, errorUpdate);
      }

      resultado.push({ codigo: c.codigo, dorado: esDorado });
    }

    return resultado;

  } catch (error) {
    console.error("💥 Error generarCodigos:", error);
    return [];
  }
}

module.exports = { generarCodigos };