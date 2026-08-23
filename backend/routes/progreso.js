const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { CONFIG } = require('../services/appState');

router.get('/progreso', async (req, res) => {
  try {
    // El total SIEMPRE se cuenta directo de la tabla (fuente de verdad real),
    // en vez de confiar en un valor guardado aparte que se puede desincronizar.
    const { count: total, error: errorTotal } = await supabase
      .from('codigos')
      .select('*', { count: 'exact', head: true });

    if (errorTotal) {
      console.error(errorTotal);
      return res.status(500).json({ ok: false });
    }

    const { count: vendidos, error } = await supabase
      .from('codigos')
      .select('*', { count: 'exact', head: true })
      .eq('vendido', true);

    if (error) {
      console.error(error);
      return res.status(500).json({ ok: false });
    }

    const totalReal = total || 0;
    const cantidadVendidos = vendidos || 0;
    const disponibles = totalReal - cantidadVendidos;
    const porcentaje = totalReal > 0 ? (cantidadVendidos / totalReal) * 100 : 0;

    // Mantener CONFIG.total_numeros sincronizado con la realidad (por si se
    // desincronizó, por ejemplo por una edición manual en Supabase)
    if (CONFIG.total_numeros !== totalReal) CONFIG.total_numeros = totalReal;

    res.json({
      porcentaje: Number(porcentaje.toFixed(2)),
      vendidos: cantidadVendidos,
      disponibles,
      total: totalReal
    });

  } catch (error) {
    console.error("💥 Error progreso:", error);
    res.status(500).json({ error: "Error obteniendo progreso" });
  }
});

module.exports = router;