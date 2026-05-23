const express = require('express');
const router  = express.Router();
const supabase = require('../config/supabase');
const { activarPromo, desactivarPromo, getPromoActiva } = require('../services/promociones');
const ExcelJS = require('exceljs');

// ════════════════════════════════════════
// MIDDLEWARE AUTH — solo rutas /admin/*
// Agrega ADMIN_SECRET=tu_clave en .env
// ════════════════════════════════════════
function authAdmin(req, res, next) {
  const token  = req.headers['x-admin-token'] || req.query.token;
  const SECRET = process.env.ADMIN_SECRET;
  if (!SECRET)          return res.status(500).json({ error: 'ADMIN_SECRET no configurado' });
  if (!token || token !== SECRET) return res.status(401).json({ error: 'No autorizado' });
  next();
}

// ════════════════════════════════════════
// RUTAS PÚBLICAS (sin auth)
// ════════════════════════════════════════
// ── POST /api/admin/verificar ← usado por el login del frontend
// Esta ruta SÍ requiere auth, a diferencia de promo-activa
router.post('/admin/verificar', authAdmin, (req, res) => {
  res.json({ ok: true });
});


// GET /api/admin/promo-activa  ← pública, la usa el frontend
router.get('/admin/promo-activa', async (req, res) => {
  try {
    const promo = await getPromoActiva();
    if (!promo) return res.json({ activa: false });
    res.json({ activa: true, ...promo });
  } catch (e) {
    console.error('💥 promo-activa:', e);
    res.status(500).json({ ok: false });
  }
});

// GET /api/admin/codigos-dorados  ← pública, la usa el frontend para mostrar ganadores
router.get('/admin/codigos-dorados', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('codigos')
      .select('codigo')
      .eq('dorado', true)
      .eq('vendido', true);
    if (error) return res.status(500).json({ ok: false });
    res.json(data);
  } catch (e) {
    console.error('💥 codigos-dorados:', e);
    res.status(500).json({ ok: false });
  }
});

// ════════════════════════════════════════
// RUTAS PRIVADAS — requieren x-admin-token
// ════════════════════════════════════════
router.use('/admin', authAdmin);

// ── GET /api/admin/compras-stats ─────────────────────────────
router.get('/admin/compras-stats', async (req, res) => {
  try {
    const { data: pagadas, error: e1 } = await supabase
      .from('compras')
      .select('cantidad, fecha')
      .eq('estado', 'pagado')
      .order('fecha', { ascending: false });

    const { count: pendientes } = await supabase
      .from('compras')
      .select('*', { count: 'exact', head: true })
      .eq('estado', 'pendiente');

    if (e1) return res.status(500).json({ ok: false });

    const PRECIO_POR_CODIGO = 3750;
    const ingresos = (pagadas || []).reduce((sum, c) => sum + (c.cantidad * PRECIO_POR_CODIGO), 0);
    const ultima   = pagadas?.[0]?.fecha || null;

    res.json({
      pagadas:    pagadas?.length || 0,
      pendientes: pendientes || 0,
      ingresos,
      ultima
    });
  } catch (e) {
    console.error('💥 compras-stats:', e);
    res.status(500).json({ ok: false });
  }
});

// ── GET /api/admin/compradores ────────────────────────────────
// Devuelve todas las compras con sus códigos asignados
router.get('/admin/compradores', async (req, res) => {
  try {
    // 1. Todas las compras ordenadas por fecha desc
    const { data: compras, error: e1 } = await supabase
      .from('compras')
      .select('referencia, nombre, correo, cedula, telefono, cantidad, estado, fecha, premio_dorado')
      .order('fecha', { ascending: false })
      .limit(500);

    if (e1) return res.status(500).json({ ok: false });

    // 2. Para compras pagadas, traer sus códigos
    const refsPagadas = (compras || [])
      .filter(c => c.estado === 'pagado')
      .map(c => c.referencia);

    let codigosMap = {};
    if (refsPagadas.length > 0) {
      const { data: codigos } = await supabase
        .from('codigos')
        .select('codigo, dorado, referencia')
        .in('referencia', refsPagadas);

      (codigos || []).forEach(c => {
        if (!codigosMap[c.referencia]) codigosMap[c.referencia] = [];
        codigosMap[c.referencia].push({ codigo: c.codigo, dorado: c.dorado });
      });
    }

    const resultado = (compras || []).map(c => ({
      ...c,
      codigos: codigosMap[c.referencia] || []
    }));

    res.json({ compradores: resultado });
  } catch (e) {
    console.error('💥 compradores:', e);
    res.status(500).json({ ok: false });
  }
});

// ── POST /api/admin/activar-promo ────────────────────────────
router.post('/admin/activar-promo', async (req, res) => {
  try {
    const { precioDorado, precioNormal, expiraEn } = req.body;
    if (!precioDorado || !precioNormal || !expiraEn)
      return res.status(400).json({ error: 'Datos incompletos' });
    const promo = await activarPromo(Number(precioDorado), Number(precioNormal), expiraEn);
    if (!promo) return res.status(500).json({ error: 'Error activando promo' });
    res.json({ ok: true, promo });
  } catch (e) {
    console.error('💥 activar-promo:', e);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── POST /api/admin/desactivar-promo ─────────────────────────
router.post('/admin/desactivar-promo', async (req, res) => {
  try {
    await desactivarPromo();
    res.json({ ok: true });
  } catch (e) {
    console.error('💥 desactivar-promo:', e);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── GET /api/admin/exportar ───────────────────────────────────
// Excel con códigos dorados
router.get('/admin/exportar', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('codigos')
      .select('codigo, dorado, referencia, nombre, email, telefono')
      .eq('dorado', true)
      .eq('vendido', true);
    if (error) return res.status(500).json({ ok: false });

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Ganadores dorados');
    ws.columns = [
      { header: 'Código',     key: 'codigo',     width: 14 },
      { header: 'Referencia', key: 'referencia', width: 28 },
      { header: 'Nombre',     key: 'nombre',     width: 28 },
      { header: 'Email',      key: 'email',      width: 32 },
      { header: 'Teléfono',   key: 'telefono',   width: 16 },
    ];
    ws.getRow(1).font = { bold: true };
    data.forEach(row => ws.addRow(row));

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=ganadores.xlsx');
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error('💥 exportar:', e);
    res.status(500).json({ ok: false });
  }
});

// ── GET /api/admin/exportar-compradores ──────────────────────
// Excel con TODAS las compras pagadas + sus códigos
router.get('/admin/exportar-compradores', async (req, res) => {
  try {
    const { data: compras, error: e1 } = await supabase
      .from('compras')
      .select('referencia, nombre, correo, cedula, telefono, cantidad, estado, fecha, premio_dorado')
      .eq('estado', 'pagado')
      .order('fecha', { ascending: false });
    if (e1) return res.status(500).json({ ok: false });

    const refs = (compras || []).map(c => c.referencia);
    let codigosMap = {};
    if (refs.length > 0) {
      const { data: codigos } = await supabase
        .from('codigos')
        .select('codigo, dorado, referencia')
        .in('referencia', refs);
      (codigos || []).forEach(c => {
        if (!codigosMap[c.referencia]) codigosMap[c.referencia] = [];
        codigosMap[c.referencia].push(c);
      });
    }

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Compradores');
    ws.columns = [
      { header: 'Nombre',       key: 'nombre',       width: 28 },
      { header: 'Correo',       key: 'correo',       width: 32 },
      { header: 'Cédula',       key: 'cedula',       width: 16 },
      { header: 'Teléfono',     key: 'telefono',     width: 16 },
      { header: 'Cantidad',     key: 'cantidad',     width: 10 },
      { header: 'Estado',       key: 'estado',       width: 12 },
      { header: 'Fecha',        key: 'fecha',        width: 20 },
      { header: 'Premio dorado',key: 'premio_dorado',width: 16 },
      { header: 'Códigos',      key: 'codigos',      width: 60 },
      { header: 'Referencia',   key: 'referencia',   width: 30 },
    ];
    ws.getRow(1).font = { bold: true };

    (compras || []).forEach(c => {
      const cods = (codigosMap[c.referencia] || []).map(x => (x.dorado ? '⭐' : '') + x.codigo).join(', ');
      ws.addRow({
        nombre:       c.nombre || '',
        correo:       c.correo || '',
        cedula:       c.cedula || '',
        telefono:     c.telefono || '',
        cantidad:     c.cantidad,
        estado:       c.estado,
        fecha:        c.fecha ? new Date(c.fecha).toLocaleString('es-CO') : '',
        premio_dorado:c.premio_dorado ? '$' + Number(c.premio_dorado).toLocaleString('es-CO') : '',
        codigos:      cods,
        referencia:   c.referencia,
      });
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=compradores.xlsx');
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error('💥 exportar-compradores:', e);
    res.status(500).json({ ok: false });
  }
});

module.exports = router;