const supabase = require('../config/supabase');

async function generarCodigos(cantidad, referencia) {
  try {

    const { data: disponibles, error } = await supabase
      .from('codigos')
      .select('id, codigo, dorado')
      .eq('vendido', false)
      .limit(cantidad);

    if (error) {
      console.error("❌ Error obteniendo códigos:", error);
      return [];
    }

    if (!disponibles || disponibles.length === 0) {
      return [];
    }

    const ids = disponibles.map(r => r.id);

    // 🔄 marcar vendidos
    const { error: updateError } = await supabase
      .from('codigos')
      .update({ 
        vendido: true,
        referencia 
      })
      .in('id', ids);

    if (updateError) {
      console.error("❌ Error actualizando códigos:", updateError);
      return [];
    }

    // 🎯 devolver códigos con info dorado
    return disponibles.map(c => ({
      codigo: c.codigo,
      dorado: c.dorado
    }));

  } catch (error) {
    console.error("💥 Error generarCodigos:", error);
    return [];
  }
}

module.exports = { generarCodigos };