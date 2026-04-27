const supabase = require('../config/supabase');

async function generarCodigos(cantidad, referencia) {
  try {

    const { data: disponibles, error } = await supabase
      .from('codigos')
      .select('id, codigo')
      .eq('vendido', false)
      .limit(cantidad);

    if (error) {
      console.error("❌ Error obteniendo códigos:", error);
      return [];
    }

    if (!disponibles || disponibles.length === 0) {
      return [];
    }

    const codigos = disponibles.map(r => r.codigo);
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

    // 📊 total vendidos
    const { count: vendidos } = await supabase
      .from('codigos')
      .select('*', { count: 'exact', head: true })
      .eq('vendido', true);

    const { count: total } = await supabase
      .from('codigos')
      .select('*', { count: 'exact', head: true });

    const porcentaje = (vendidos / total) * 100;

    let activarDorado = false;

    if ([15, 30, 60, 99].includes(Math.floor(porcentaje))) {
      activarDorado = true;
    }

    if (activarDorado && codigos.length > 0) {
      const elegido = codigos[Math.floor(Math.random() * codigos.length)];

      console.log("✨ Código dorado activado:", elegido);
    }

    return codigos;

  } catch (error) {
    console.error("💥 Error generarCodigos:", error);
    return [];
  }
}

module.exports = { generarCodigos };