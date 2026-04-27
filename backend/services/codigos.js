const supabase = require('../config/supabase');

async function generarCodigos(cantidad) {
  try {

    // 🎟️ OBTENER CÓDIGOS DISPONIBLES
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

    // 🔄 MARCAR COMO VENDIDOS
    const { error: updateError } = await supabase
      .from('codigos')
      .update({ vendido: true })
      .in('id', ids);

    if (updateError) {
      console.error("❌ Error actualizando códigos:", updateError);
      return [];
    }

    // 📊 CONTAR VENDIDOS
    const { count, error: countError } = await supabase
      .from('codigos')
      .select('*', { count: 'exact', head: true })
      .eq('vendido', true);

    if (countError) {
      console.error("❌ Error contando vendidos:", countError);
      return codigos;
    }

    const total = 10000;
    const porcentaje = (count / total) * 100;

    let activarDorado = false;

    // 🎯 lógica dorado por porcentaje
    if ([15, 30, 60, 99].some(p => porcentaje >= p)) {
      activarDorado = true;
    }

    if (activarDorado && codigos.length > 0) {
      const elegido = codigos[Math.floor(Math.random() * codigos.length)];

      await supabase
        .from('codigos')
        .update({ dorado: true })
        .eq('codigo', elegido);

      console.log("✨ Código dorado activado:", elegido);
    }

    return codigos;

  } catch (error) {
    console.error("💥 Error generarCodigos:", error);
    return [];
  }
}

module.exports = { generarCodigos };