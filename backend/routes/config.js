// routes/config.js
const express = require('express');
const router  = express.Router();
const supabase = require('../config/supabase');
const fs   = require('fs');
const path = require('path');

// Archivo local para ganador (no depende de Supabase)
const GANADOR_FILE = path.join(__dirname, '../ganador.json');

function leerGanadorLocal() {
  try {
    if (fs.existsSync(GANADOR_FILE)) {
      return JSON.parse(fs.readFileSync(GANADOR_FILE, 'utf8'));
    }
  } catch(e) {}
  return { activo: false, codigo: '', nombre: '' };
}

function guardarGanadorLocal(ganador) {
  fs.writeFileSync(GANADOR_FILE, JSON.stringify(ganador, null, 2), 'utf8');
}

function authAdmin(req, res, next) {
  const token  = req.headers['x-admin-token'] || req.query.token;
  const SECRET = process.env.ADMIN_SECRET;
  if (!SECRET) return res.status(500).json({ error: 'ADMIN_SECRET no configurado' });
  if (!token || token !== SECRET) return res.status(401).json({ error: 'No autorizado' });
  next();
}

// ── Helper: leer config de Supabase ──────────────────────────────────────
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

// ════════════════════════════════════════════════════════════════════════════
// GET /api/config  — PÚBLICO — la página principal lo llama al cargar
// ════════════════════════════════════════════════════════════════════════════
router.get('/config', async (req, res) => {
  try {
    let cfg = {};
    try { cfg = await leerConfig(); } catch(e) { /* Supabase falló, usar defaults */ }

    const precioCodigo = cfg.precio_codigo ?? 3750;
    const paquetes     = cfg.paquetes ?? [
      { cantidad: 4,  popular: false },
      { cantidad: 8,  popular: true  },
      { cantidad: 16, popular: false }
    ];
    const banner    = cfg.banner    ?? null;
    const premioTotal = cfg.premio_total ?? 15000000;

    // Ganador siempre desde archivo local (más confiable)
    const ganador = leerGanadorLocal();

    const paquetesConPrecio = paquetes.map(p => ({
      ...p,
      precio: p.cantidad * precioCodigo
    }));

    res.json({ precioCodigo, paquetes: paquetesConPrecio, banner, ganador, premioTotal });
  } catch (e) {
    console.error('❌ Error en /config:', e.message);
    res.json({
      precioCodigo: 3750,
      paquetes: [
        { cantidad: 4,  popular: false, precio: 15000 },
        { cantidad: 8,  popular: true,  precio: 30000 },
        { cantidad: 16, popular: false, precio: 60000 }
      ],
      banner:    null,
      ganador:   leerGanadorLocal(),
      premioTotal: 15000000
    });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// POST /api/admin/config/ganador  — guarda ganador en archivo local
// ════════════════════════════════════════════════════════════════════════════
router.post('/admin/config/ganador', authAdmin, (req, res) => {
  try {
    const { activo, codigo, nombre } = req.body;

    if (activo === false || activo === 'false') {
      guardarGanadorLocal({ activo: false, codigo: '', nombre: '' });
      console.log('🏆 Ganador ocultado');
      return res.json({ ok: true, mensaje: 'Ganador ocultado' });
    }

    if (!codigo || !nombre) {
      return res.status(400).json({ ok: false, error: 'Código y nombre son obligatorios' });
    }

    const ganador = { activo: true, codigo: codigo.trim(), nombre: nombre.trim() };
    guardarGanadorLocal(ganador);
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
      banner:       cfg.banner  ?? { activo: false, texto: '', color: 'gold' },
      ganador:      leerGanadorLocal(),   // siempre desde archivo
      premioTotal:  cfg.premio_total ?? 15000000
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;