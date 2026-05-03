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

module.exports = router;