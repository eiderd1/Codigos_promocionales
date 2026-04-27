// routes/estado.js
const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');

router.get('/estado', async (req, res) => {
  try {
    const { reference } = req.query;

    if (!reference) {
      return res.status(400).json({ error: "Falta reference" });
    }

    // 🔎 Buscar transacción por referencia
    const { data: compra, error: errorCompra } = await supabase
      .from('transacciones')
      .select('*')
      .eq('referencia', reference)
      .maybeSingle();

    if (errorCompra) {
      console.error(errorCompra);
      return res.status(500).json({ ok: false });
    }

    if (!compra) {
      return res.json({ aprobado: false });
    }

    // 🟡 Ver si HAY algún dorado en el sistema
    const { data: dorados, error: errorDorado } = await supabase
      .from('codigos')
      .select('dorado')
      .eq('dorado', true)
      .limit(1);

    if (errorDorado) {
      console.error(errorDorado);
      return res.status(500).json({ ok: false });
    }

    res.json({
      aprobado: true,
      hayDorado: dorados.length > 0
    });

  } catch (error) {
    console.error("💥 Error estado:", error);
    res.status(500).json({ ok: false });
  }
});

module.exports = router;