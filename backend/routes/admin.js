const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { activarPromo, desactivarPromo, getPromoActiva } = require('../services/promociones');

// ========================
// MIDDLEWARE DE AUTENTICACIÓN
// ========================
// Coloca ADMIN_SECRET=una_clave_segura en tu .env
function authAdmin(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  const SECRET = process.env.ADMIN_SECRET;

  if (!SECRET) {
    console.error('❌ ADMIN_SECRET no definido en .env');
    return res.status(500).json({ error: 'Servidor mal configurado' });
  }

  if (!token || token !== SECRET) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  next();
}

// Aplica autenticación a todas las rutas /admin/*
router.use('/admin', authAdmin);

// ========================
// GET /api/admin/codigos-dorados
// ========================
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
    console.error('💥 Error admin codigos-dorados:', error);
    res.status(500).json({ ok: false });
  }
});

// ========================
// GET /api/admin/promo-activa
// ========================
router.get('/admin/promo-activa', async (req, res) => {
  try {
    const promo = await getPromoActiva();

    if (!promo) return res.json({ activa: false });

    res.json({ activa: true, ...promo });
  } catch (error) {
    console.error('💥 Error promo-activa:', error);
    res.status(500).json({ ok: false });
  }
});

// ========================
// POST /api/admin/activar-promo
// ========================
router.post('/admin/activar-promo', async (req, res) => {
  try {
    const { precioDorado, precioNormal, expiraEn } = req.body;

    if (!precioDorado || !precioNormal || !expiraEn) {
      return res.status(400).json({ error: 'Datos incompletos' });
    }

    if (isNaN(Number(precioDorado)) || isNaN(Number(precioNormal))) {
      return res.status(400).json({ error: 'Precios inválidos' });
    }

    const promo = await activarPromo(
      Number(precioDorado),
      Number(precioNormal),
      expiraEn
    );

    if (!promo) return res.status(500).json({ error: 'Error activando promo' });

    res.json({ ok: true, promo });
  } catch (error) {
    console.error('💥 Error activar-promo:', error);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ========================
// POST /api/admin/desactivar-promo
// ========================
router.post('/admin/desactivar-promo', async (req, res) => {
  try {
    await desactivarPromo();
    res.json({ ok: true });
  } catch (error) {
    console.error('💥 Error desactivar-promo:', error);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ========================
// GET /api/admin/exportar
// ========================
const ExcelJS = require('exceljs');

router.get('/admin/exportar', async (req, res) => {
  try {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Ganadores');

    sheet.columns = [
      { header: 'Código', key: 'codigo' },
      { header: 'Dorado', key: 'dorado' }
    ];

    const { data, error } = await supabase
      .from('codigos')
      .select('codigo, dorado')
      .eq('dorado', true);

    if (error) {
      console.error(error);
      return res.status(500).json({ ok: false });
    }

    data.forEach(row => sheet.addRow(row));

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      'attachment; filename=ganadores.xlsx'
    );

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error('💥 Error exportar:', error);
    res.status(500).json({ ok: false });
  }
});

module.exports = router;