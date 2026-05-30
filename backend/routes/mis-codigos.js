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

    // 🔧 FIX: también buscar en compras por email (cubre transferencias aprobadas manualmente)
    const { data: porEmailCompras } = await supabase
      .from('compras')
      .select('referencia')
      .eq('correo', dato);

    const todasRefs = [
      ...(porEmail || []),
      ...(porCedula || []),
      ...(porEmailCompras || [])
    ].map(t => t.referencia);

    // 🔧 FIX: si no hay referencias por transacción, buscar directamente en codigos por email
    // (cubre transferencias donde no se creó registro en 'transacciones')
    if (todasRefs.length === 0) {
      const { data: codigosDirectos, error: errorDirecto } = await supabase
        .from('codigos')
        .select('codigo, dorado')
        .eq('email', dato);

      if (errorDirecto) {
        console.error("❌ Error buscando códigos directos:", errorDirecto);
        return res.status(500).json({ error: "Error obteniendo códigos" });
      }

      return res.json({ codigos: codigosDirectos || [] });
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

    // 🔧 FIX: buscar también en compras por email (transferencias)
    const { data: porEmailCompras } = await supabase
      .from('compras')
      .select('referencia, correo')
      .eq('correo', dato);

    if ((!porEmail || porEmail.length === 0) && (!porCedula || porCedula.length === 0) && (!porEmailCompras || porEmailCompras.length === 0)) {
      return res.json({ ok: false, mensaje: "No se encontraron compras" });
    }

    const email = porEmail?.[0]?.email || porCedula?.[0]?.correo || porEmailCompras?.[0]?.correo;
    const referencias = [
      ...(porEmail || []).map(t => t.referencia),
      ...(porCedula || []).map(t => t.referencia),
      ...(porEmailCompras || []).map(t => t.referencia)
    ];

    const refUnicas = [...new Set(referencias)];

    let codigos;
    if (refUnicas.length > 0) {
      const { data } = await supabase
        .from('codigos')
        .select('codigo, dorado')
        .in('referencia', refUnicas);
      codigos = data;
    }

    // 🔧 FIX: si no encontró por referencias, buscar directo por email en codigos
    if (!codigos || codigos.length === 0) {
      const { data } = await supabase
        .from('codigos')
        .select('codigo, dorado')
        .eq('email', dato);
      codigos = data;
    }

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