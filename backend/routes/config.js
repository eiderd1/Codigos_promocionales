// routes/config.js
const express = require('express');
const router  = express.Router();
const supabase = require('../config/supabase');
const ExcelJS  = require('exceljs');
const {
  cerrarEventoYArchivar,
  listarEventosHistorial,
  obtenerEventoHistorial
} = require('../services/eventos');

function authAdmin(req, res, next) {
  const token  = req.headers['x-admin-token'] || req.query.token;
  const SECRET = process.env.ADMIN_SECRET;
  if (!SECRET) return res.status(500).json({ error: 'ADMIN_SECRET no configurado' });
  if (!token || token !== SECRET) return res.status(401).json({ error: 'No autorizado' });
  next();
}

// ── Helpers Supabase ──────────────────────────────────────────────────────────
async function leerConfig() {
  const { data, error } = await supabase
    .from('config')
    .select('clave, valor');
  if (error) throw error;
  const cfg = {};
  (data || []).forEach(r => {
    try { cfg[r.clave] = JSON.parse(r.valor); }
    catch(e) { cfg[r.clave] = r.valor; }
  });
  return cfg;
}

async function guardarConfig(clave, valor) {
  const valorStr = typeof valor === 'string' ? valor : JSON.stringify(valor);
  const { error } = await supabase
    .from('config')
    .upsert({ clave, valor: valorStr }, { onConflict: 'clave' });
  if (error) throw error;
}

// ── Ganador desde Supabase ────────────────────────────────────────────────────
async function leerGanador() {
  try {
    const { data, error } = await supabase
      .from('config')
      .select('valor')
      .eq('clave', 'ganador')
      .single();
    if (error || !data) return { activo: false, codigo: '', nombre: '' };
    return JSON.parse(data.valor);
  } catch(e) {
    return { activo: false, codigo: '', nombre: '' };
  }
}

async function guardarGanador(ganador) {
  const { error } = await supabase
    .from('config')
    .upsert(
      { clave: 'ganador', valor: JSON.stringify(ganador) },
      { onConflict: 'clave' }
    );
  if (error) throw error;
}

// ════════════════════════════════════════════════════════════════════════════
// GET /api/config  — PÚBLICO
// ════════════════════════════════════════════════════════════════════════════
router.get('/config', async (req, res) => {
  try {
    let cfg = {};
    try { cfg = await leerConfig(); } catch(e) {}

    const precioCodigo = cfg.precio_codigo ?? 3750;
    const paquetes     = cfg.paquetes ?? [
      { cantidad: 4,  popular: false },
      { cantidad: 8,  popular: true  },
      { cantidad: 16, popular: false }
    ];
    const banner        = cfg.banner       ?? null;
    const premioTotal   = cfg.premio_total ?? 15000000;
    const ganador       = cfg.ganador      ?? { activo: false, codigo: '', nombre: '' };
    const ventasActivas = cfg.ventas_activas !== undefined ? cfg.ventas_activas : true;
    const avisoTexto    = cfg.aviso_texto  ?? '';
    const avisoColor    = cfg.aviso_color  ?? 'gold';

    const paquetesConPrecio = paquetes.map(p => ({
      ...p,
      precio: p.cantidad * precioCodigo
    }));

    res.json({
      ventas_activas: ventasActivas,
      aviso_texto:    avisoTexto,
      aviso_color:    avisoColor,
      precioCodigo,
      paquetes: paquetesConPrecio,
      banner,
      ganador,
      premioTotal
    });
  } catch (e) {
    console.error('❌ Error en /config:', e.message);
    res.json({
      ventas_activas: true,
      aviso_texto:    '',
      aviso_color:    'gold',
      precioCodigo: 3750,
      paquetes: [
        { cantidad: 4,  popular: false, precio: 15000 },
        { cantidad: 8,  popular: true,  precio: 30000 },
        { cantidad: 16, popular: false, precio: 60000 }
      ],
      banner:    null,
      ganador:   { activo: false, codigo: '', nombre: '' },
      premioTotal: 15000000
    });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// POST /api/admin/config/ganador  — guarda ganador en Supabase
// ════════════════════════════════════════════════════════════════════════════
router.post('/admin/config/ganador', authAdmin, async (req, res) => {
  try {
    const { activo, codigo, nombre } = req.body;

    if (activo === false || activo === 'false') {
      await guardarGanador({ activo: false, codigo: '', nombre: '' });
      console.log('🏆 Ganador ocultado');
      return res.json({ ok: true, mensaje: 'Ganador ocultado' });
    }

    if (!codigo || !nombre) {
      return res.status(400).json({ ok: false, error: 'Código y nombre son obligatorios' });
    }

    const ganador = { activo: true, codigo: codigo.trim(), nombre: nombre.trim() };
    await guardarGanador(ganador);
    console.log(`🏆 Ganador publicado: ${codigo} — ${nombre}`);
    res.json({ ok: true, mensaje: `Ganador publicado: ${codigo}` });
  } catch (e) {
    console.error('❌ Error guardando ganador:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// POST /api/admin/config/precios
// ════════════════════════════════════════════════════════════════════════════
router.post('/admin/config/precios', authAdmin, async (req, res) => {
  try {
    const { precioCodigo, paquetes, premioTotal } = req.body;
    if (!precioCodigo || precioCodigo < 100)
      return res.status(400).json({ error: 'Precio por código inválido (mínimo $100)' });
    if (!Array.isArray(paquetes) || paquetes.length === 0)
      return res.status(400).json({ error: 'Debes tener al menos 1 paquete' });

    await guardarConfig('precio_codigo', precioCodigo);
    await guardarConfig('paquetes', paquetes);
    if (premioTotal) await guardarConfig('premio_total', premioTotal);

    console.log(`⚙️ Precios actualizados: $${precioCodigo}/código`);
    res.json({ ok: true, mensaje: 'Precios y paquetes actualizados correctamente' });
  } catch (e) {
    console.error('❌ Error guardando precios:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// POST /api/admin/config/banner
// ════════════════════════════════════════════════════════════════════════════
router.post('/admin/config/banner', authAdmin, async (req, res) => {
  try {
    const { activo, texto, color } = req.body;
    if (activo && (!texto || !texto.trim()))
      return res.status(400).json({ error: 'El texto del banner es requerido' });
    await guardarConfig('banner', { activo: !!activo, texto: texto?.trim() || '', color: color || 'gold' });
    console.log(`📢 Banner ${activo ? 'activado' : 'desactivado'}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('❌ Error guardando banner:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// GET /api/admin/config  — lee config completa para el panel admin
// ════════════════════════════════════════════════════════════════════════════
router.get('/admin/config', authAdmin, async (req, res) => {
  try {
    let cfg = {};
    try { cfg = await leerConfig(); } catch(e) {}

    res.json({
      precioCodigo: cfg.precio_codigo ?? 3750,
      paquetes:     cfg.paquetes ?? [{cantidad:4,popular:false},{cantidad:8,popular:true},{cantidad:16,popular:false}],
      banner:       cfg.banner   ?? { activo: false, texto: '', color: 'gold' },
      ganador:      cfg.ganador  ?? { activo: false, codigo: '', nombre: '' },
      premioTotal:  cfg.premio_total ?? 15000000
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// EVENTOS — archivar el evento actual y dejar todo en cero
// ════════════════════════════════════════════════════════════════════════════

// POST /api/admin/eventos/cerrar — guarda todo en el historial y reinicia
router.post('/admin/eventos/cerrar', authAdmin, async (req, res) => {
  try {
    const { nombre } = req.body;
    const evento = await cerrarEventoYArchivar(nombre);
    console.log(`🗄️ Evento archivado y reiniciado: ${evento.nombre}`);
    res.json({ ok: true, evento });
  } catch (e) {
    console.error('❌ Error cerrando evento:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/admin/eventos — lista de eventos archivados (para el panel)
router.get('/admin/eventos', authAdmin, async (req, res) => {
  try {
    const eventos = await listarEventosHistorial();
    res.json({ ok: true, eventos });
  } catch (e) {
    console.error('❌ Error listando eventos:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/admin/eventos/:id — detalle completo de un evento archivado
router.get('/admin/eventos/:id', authAdmin, async (req, res) => {
  try {
    const evento = await obtenerEventoHistorial(req.params.id);
    res.json({ ok: true, evento });
  } catch (e) {
    console.error('❌ Error obteniendo evento:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/admin/eventos/:id/exportar — Excel con compras y códigos del evento
router.get('/admin/eventos/:id/exportar', authAdmin, async (req, res) => {
  try {
    const evento = await obtenerEventoHistorial(req.params.id);
    if (!evento) return res.status(404).json({ ok: false, error: 'Evento no encontrado' });

    const wb = new ExcelJS.Workbook();

    const wsCompras = wb.addWorksheet('Compras');
    wsCompras.columns = [
      { header: 'Referencia', key: 'referencia', width: 30 },
      { header: 'Nombre',     key: 'nombre',     width: 26 },
      { header: 'Correo',     key: 'correo',     width: 30 },
      { header: 'Cédula',     key: 'cedula',     width: 14 },
      { header: 'Teléfono',   key: 'telefono',   width: 14 },
      { header: 'Cantidad',   key: 'cantidad',   width: 10 },
      { header: 'Estado',     key: 'estado',     width: 14 },
      { header: 'Fecha',      key: 'fecha',      width: 22 }
    ];
    wsCompras.getRow(1).font = { bold: true };
    (evento.compras || []).forEach(c => wsCompras.addRow(c));

    const wsCodigos = wb.addWorksheet('Códigos vendidos');
    wsCodigos.columns = [
      { header: 'Código',     key: 'codigo',     width: 14 },
      { header: 'Dorado',     key: 'dorado',     width: 10 },
      { header: 'Referencia', key: 'referencia', width: 30 },
      { header: 'Nombre',     key: 'nombre',     width: 26 },
      { header: 'Email',      key: 'email',      width: 30 },
      { header: 'Teléfono',   key: 'telefono',   width: 14 }
    ];
    wsCodigos.getRow(1).font = { bold: true };
    (evento.codigos || []).forEach(c => wsCodigos.addRow(c));

    const safeName = evento.nombre.replace(/[^a-z0-9]+/gi, '_').slice(0, 40);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=evento_${safeName}.xlsx`);
    await wb.xlsx.write(res); res.end();
  } catch (e) {
    console.error('❌ Error exportando evento:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;