const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');

router.post('/mis-codigos', async (req, res) => {
  try {
    const { dato } = req.body;

    if (!dato) {
      return res.status(400).json({ error: "Dato requerido" });
    }

    // Buscar por email en transacciones O por correo en compras
    const { data: porEmail } = await supabase
      .from('transacciones')
      .select('referencia')
      .eq('email', dato);

    const { data: porCedula } = await supabase
      .from('compras')
      .select('referencia')
      .eq('cedula', dato);

    const todasRefs = [
      ...(porEmail || []),
      ...(porCedula || [])
    ].map(t => t.referencia);

    if (todasRefs.length === 0) {
      return res.json({ codigos: [] });
    }

    // Eliminar duplicados
    const referencias = [...new Set(todasRefs)];

    const { data: codigos, error: errorCod } = await supabase
      .from('codigos')
      .select('codigo, dorado')
      .in('referencia', referencias);

    if (errorCod) {
      console.error("❌ Error buscando códigos:", errorCod);
      return res.status(500).json({ error: "Error obteniendo códigos" });
    }

    res.json({ codigos: codigos || [] });

  } catch (error) {
    console.error("💥 Error mis-codigos:", error);
    res.status(500).json({ error: "Error interno" });
  }
});

module.exports = router;