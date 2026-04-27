const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');

router.get('/progreso', async (req, res) => {
  try {
    const total = 10000;

    const { count, error } = await supabase
      .from('codigos')
      .select('*', { count: 'exact', head: true })
      .eq('vendido', true);

    if (error) {
      console.error(error);
      return res.status(500).json({ ok: false });
    }

    const cantidadVendidos = count || 0;

    const porcentaje = (cantidadVendidos / total) * 100;

    res.json({
      porcentaje: Number(porcentaje.toFixed(2)),
      vendidos: cantidadVendidos,
      total
    });

  } catch (error) {
    console.error("💥 Error progreso:", error);

    res.status(500).json({
      error: "Error obteniendo progreso"
    });
  }
});

module.exports = router;