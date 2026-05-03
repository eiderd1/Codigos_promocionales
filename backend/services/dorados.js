const supabase = require('../config/supabase');

async function generarDoradosIniciales() {
  try {
    console.log("✅ Sistema de dorados por hitos activo");
    return [];
  } catch (err) {
    console.error("❌ Error dorados:", err);
    return [];
  }
}

module.exports = { generarDoradosIniciales };