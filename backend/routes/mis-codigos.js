const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { enviarCorreo } = require('../services/correo');

router.post('/mis-codigos', async (req, res) => {
  try {
    const { dato } = req.body;

    if (!dato) {
      return res.status(400).json({ error: "Dato requerido" });
    }

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

// 🔁 REENVIAR CORREO
router.post('/reenviar-correo', async (req, res) => {
  try {
    const { dato } = req.body;

    if (!dato) {
      return res.status(400).json({ error: "Dato requerido" });
    }

    const { data: porEmail } = await supabase
      .from('transacciones')
      .select('referencia, email')
      .eq('email', dato);

    const { data: porCedula } = await supabase
      .from('compras')
      .select('referencia, correo')
      .eq('cedula', dato);

    if ((!porEmail || porEmail.length === 0) && (!porCedula || porCedula.length === 0)) {
      return res.json({ ok: false, mensaje: "No se encontraron compras" });
    }

    const email = porEmail?.[0]?.email || porCedula?.[0]?.correo;
    const referencias = [
      ...(porEmail || []).map(t => t.referencia),
      ...(porCedula || []).map(t => t.referencia)
    ];

    const refUnicas = [...new Set(referencias)];

    const { data: codigos } = await supabase
      .from('codigos')
      .select('codigo, dorado')
      .in('referencia', refUnicas);

    if (!codigos || codigos.length === 0) {
      return res.json({ ok: false, mensaje: "No se encontraron códigos" });
    }

    await enviarCorreo(email, codigos);

    res.json({ ok: true, mensaje: `✅ Correo reenviado a ${email}` });

  } catch (error) {
    console.error("💥 Error reenviar:", error);
    res.status(500).json({ error: "Error interno" });
  }
});

module.exports = router;