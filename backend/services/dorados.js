const supabase = require('../config/supabase');

async function generarDoradosIniciales() {
  try {
    // 🔍 Verificar si ya existen dorados
    const { data: existentes } = await supabase
      .from('codigos')
      .select('codigo')
      .eq('dorado', true);

    if (existentes && existentes.length >= 4) {
      console.log("✅ Dorados ya existen:", existentes.map(d => d.codigo));
      return existentes.map(d => d.codigo);
    }

    // 📦 Obtener todos los disponibles
    const { data: todos, error } = await supabase
      .from('codigos')
      .select('id, codigo')
      .eq('vendido', false);

    if (error) throw error;

    if (!todos || todos.length < 4) {
      throw new Error("No hay suficientes códigos disponibles");
    }

    // 🔀 Mezclar
    const mezclados = todos.sort(() => 0.5 - Math.random());

    const elegidos = mezclados.slice(0, 4);
    const ids = elegidos.map(e => e.id);

    // ✨ Marcar como dorados
    await supabase
      .from('codigos')
      .update({ dorado: true })
      .in('id', ids);

    console.log("✨ Dorados creados:", elegidos.map(e => e.codigo));

    return elegidos.map(e => e.codigo);

  } catch (err) {
    console.error("❌ Error generando dorados:", err);
    return [];
  }
}

module.exports = { generarDoradosIniciales };