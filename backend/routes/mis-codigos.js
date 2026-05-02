const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');

// 🔍 CONSULTAR CÓDIGOS POR CORREO O CÉDULA
router.post('/mis-codigos', async (req, res) => {
  try {
    const { dato } = req.body;

    if (!dato) {
      return res.status(400).json({ error: "Dato requerido" });
    }

    // 🔎 Buscar transacciones por email o cedula
    const { data: transacciones, error: errorTx } = await supabase
      .from('transacciones')
      .select('referencia')
      .or(`email.eq.${dato},cedula.eq.${dato}`);

    if (errorTx) {
      console.error("❌ Error buscando transacciones:", errorTx);
      return res.status(500).json({ error: "Error consultando" });
    }

    if (!transacciones || transacciones.length === 0) {
      return res.json({ codigos: [] });
    }

    // 📌 Obtener referencias
    const referencias = transacciones.map(t => t.referencia);

    // 🔎 Buscar códigos asociados
    const { data: codigos, error: errorCod } = await supabase
      .from('codigos')
      .select('codigo, dorado')
      .in('referencia', referencias);

    if (errorCod) {
      console.error("❌ Error buscando códigos:", errorCod);
      return res.status(500).json({ error: "Error obteniendo códigos" });
    }

    res.json({
      codigos: codigos || []
    });

  } catch (error) {
    console.error("💥 Error mis-codigos:", error);
    res.status(500).json({ error: "Error interno" });
  }
});

module.exports = router;