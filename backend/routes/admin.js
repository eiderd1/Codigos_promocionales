const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');

router.get('/admin/codigos-dorados', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('codigos')
      .select('codigo')
      .eq('dorado', true)
      .eq('vendido', true);

    if (error) {
      console.error(error);
      return res.status(500).json({ ok: false });
    }

    res.json(data);

  } catch (error) {
    console.error("💥 Error admin:", error);
    res.status(500).json({ ok: false });
  }
});

// ── GET promo activa ─────────────────────────────────────────
router.get('/admin/promo-activa', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('promociones')
      .select('*')
      .eq('activa', true)
      .maybeSingle();

    if (error) return res.status(500).json({ ok: false });

    if (!data) return res.json({ activa: false });

    // Auto-expirar
    if (data.expira_en && new Date(data.expira_en) < new Date()) {
      await supabase.from('promociones').update({ activa: false }).eq('id', data.id);
      return res.json({ activa: false });
    }

    res.json({ activa: true, ...data });
  } catch (error) {
    console.error("💥 Error promo-activa:", error);
    res.status(500).json({ ok: false });
  }
});

module.exports = router;