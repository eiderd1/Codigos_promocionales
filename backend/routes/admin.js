const express = require('express');
const router  = express.Router();
const supabase = require('../config/supabase');
const { activarPromo, desactivarPromo, getPromoActiva } = require('../services/promociones');
const { enviarCorreo } = require('../services/correo');
const ExcelJS = require('exceljs');

// ════════════════════════════════════════════
// RATE LIMITING — bloqueo tras 3 fallos
// ════════════════════════════════════════════
const loginAttempts = new Map(); // ip -> { count, blockedUntil }

function checkLoginRateLimit(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip) || { count: 0, blockedUntil: 0 };
  if (entry.blockedUntil > now) {
    const segsRestantes = Math.ceil((entry.blockedUntil - now) / 1000);
    return { bloqueado: true, segs: segsRestantes };
  }
  return { bloqueado: false };
}

function registrarFalloLogin(ip) {
  const entry = loginAttempts.get(ip) || { count: 0, blockedUntil: 0 };
  entry.count += 1;
  if (entry.count >= 3) {
    entry.blockedUntil = Date.now() + 5 * 60 * 1000; // 5 minutos bloqueado
    entry.count = 0;
    console.warn(`🔒 IP bloqueada por 5 min: ${ip}`);
  }
  loginAttempts.set(ip, entry);
}

function limpiarFallosLogin(ip) {
  loginAttempts.delete(ip);
}

// ════════════════════════════════════════════
// AUTH MIDDLEWARE — rutas privadas /admin/*
// ════════════════════════════════════════════
function authAdmin(req, res, next) {
  const token  = req.headers['x-admin-token'] || req.query.token;
  const SECRET = process.env.ADMIN_SECRET;
  if (!SECRET) return res.status(500).json({ error: 'ADMIN_SECRET no configurado en .env' });
  if (!token || token !== SECRET) return res.status(401).json({ error: 'No autorizado' });
  next();
}

// ════════════════════════════════════════════
// CONFIG en memoria (persiste mientras corre)
// Para persistencia real, guárdalos en Supabase
// ════════════════════════════════════════════
let CONFIG = {
  ventas_activas: true,
  precio_codigo:  3750,
  aviso_texto:    '',
  aviso_color:    'gold',
  correo_pie:     ''
};

// ════════════════════════════════════════════
// RUTAS PÚBLICAS
// ════════════════════════════════════════════

// Promo activa — la usa el frontend público
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

// Códigos dorados — los muestra el frontend público
router.get('/admin/codigos-dorados', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('codigos').select('codigo').eq('dorado', true).eq('vendido', true);
    if (error) return res.status(500).json({ ok: false });
    res.json(data);
  } catch (e) {
    res.status(500).json({ ok: false });
  }
});

// Config pública — aviso banner y estado ventas
router.get('/config-publica', (req, res) => {
  res.json({
    ventas_activas: CONFIG.ventas_activas,
    aviso_texto:    CONFIG.aviso_texto,
    aviso_color:    CONFIG.aviso_color,
    precio_codigo:  CONFIG.precio_codigo
  });
});

// ════════════════════════════════════════════
// VERIFICAR LOGIN — con rate limiting
// ════════════════════════════════════════════
router.post('/admin/verificar', (req, res) => {
  const ip     = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  const token  = req.headers['x-admin-token'] || req.query.token;
  const SECRET = process.env.ADMIN_SECRET;

  if (!SECRET) return res.status(500).json({ error: 'ADMIN_SECRET no configurado' });

  // Verificar bloqueo
  const rl = checkLoginRateLimit(ip);
  if (rl.bloqueado) {
    registrarAcceso(ip, false, `Bloqueado (${rl.segs}s restantes)`);
    return res.status(429).json({ error: `Demasiados intentos. Espera ${rl.segs} segundos.` });
  }

  if (!token || token !== SECRET) {
    registrarFalloLogin(ip);
    const intentos = (loginAttempts.get(ip) || {}).count || 1;
    const restantes = 3 - intentos;
    registrarAcceso(ip, false);
    return res.status(401).json({
      error: restantes > 0
        ? `Clave incorrecta. ${restantes} intento(s) restante(s).`
        : 'Cuenta bloqueada 5 minutos por seguridad.'
    });
  }

  limpiarFallosLogin(ip);
  registrarAcceso(ip, true);
  res.json({ ok: true });
});

// ════════════════════════════════════════════
// LOG de accesos (en memoria, últimos 200)
// ════════════════════════════════════════════
const LOG_ACCESOS = [];
function registrarAcceso(ip, exito, nota = '') {
  LOG_ACCESOS.unshift({ ip, exito, nota, fecha: new Date().toISOString() });
  if (LOG_ACCESOS.length > 200) LOG_ACCESOS.pop();
}

// ════════════════════════════════════════════
// TODAS LAS RUTAS SIGUIENTES REQUIEREN AUTH
// ════════════════════════════════════════════
router.use('/admin', authAdmin);

// ── Compras stats ────────────────────────────
router.get('/admin/compras-stats', async (req, res) => {
  try {
    const { data: pagadas } = await supabase
      .from('compras').select('cantidad, fecha').in('estado', ['pagado', 'transferencia_aprobada']).order('fecha', { ascending: false });
    const { count: pendientes } = await supabase
      .from('compras').select('*', { count: 'exact', head: true }).eq('estado', 'pendiente');

    const PRECIO = CONFIG.precio_codigo || 3750;
    const ingresos = (pagadas || []).reduce((s, c) => s + c.cantidad * PRECIO, 0);
    res.json({ pagadas: pagadas?.length || 0, pendientes: pendientes || 0, ingresos, ultima: pagadas?.[0]?.fecha || null });
  } catch (e) {
    res.status(500).json({ ok: false });
  }
});

// ── Compradores ──────────────────────────────
router.get('/admin/compradores', async (req, res) => {
  try {
    const { data: compras, error } = await supabase
      .from('compras')
      .select('referencia, nombre, correo, cedula, telefono, cantidad, estado, fecha, premio_dorado')
      .order('fecha', { ascending: false }).limit(500);
    if (error) return res.status(500).json({ ok: false });

    const refs = (compras || []).filter(c => c.estado === 'pagado' || c.estado === 'transferencia_aprobada').map(c => c.referencia);
    let codigosMap = {};
    if (refs.length) {
      const { data: codigos } = await supabase
        .from('codigos').select('codigo, dorado, referencia').in('referencia', refs);
      (codigos || []).forEach(c => {
        if (!codigosMap[c.referencia]) codigosMap[c.referencia] = [];
        codigosMap[c.referencia].push({ codigo: c.codigo, dorado: c.dorado });
      });
    }

    res.json({ compradores: (compras || []).map(c => ({ ...c, codigos: codigosMap[c.referencia] || [] })) });
  } catch (e) {
    res.status(500).json({ ok: false });
  }
});

// ── Activar / desactivar promo ───────────────
router.post('/admin/activar-promo', async (req, res) => {
  try {
    const { precioDorado, precioNormal, expiraEn } = req.body;
    if (!precioDorado || !precioNormal || !expiraEn) return res.status(400).json({ error: 'Datos incompletos' });
    const promo = await activarPromo(Number(precioDorado), Number(precioNormal), expiraEn);
    if (!promo) return res.status(500).json({ error: 'Error activando promo' });
    res.json({ ok: true, promo });
  } catch (e) { res.status(500).json({ error: 'Error interno' }); }
});

router.post('/admin/desactivar-promo', async (req, res) => {
  try {
    await desactivarPromo();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Error interno' }); }
});

// ── Historial de promos ──────────────────────
router.get('/admin/historial-promos', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('promociones').select('*').order('id', { ascending: false }).limit(50);
    if (error) return res.status(500).json({ ok: false });
    res.json({ promos: data || [] });
  } catch (e) { res.status(500).json({ ok: false }); }
});

// ── Log de accesos ───────────────────────────
router.get('/admin/log-accesos', (req, res) => {
  res.json({ logs: LOG_ACCESOS });
});

// ── Config ───────────────────────────────────
router.get('/admin/config', (req, res) => {
  res.json(CONFIG);
});

router.post('/admin/config', (req, res) => {
  const { ventas_activas, precio_codigo, aviso_texto, aviso_color, correo_pie } = req.body;
  if (ventas_activas  !== undefined) CONFIG.ventas_activas = ventas_activas;
  if (precio_codigo   !== undefined) CONFIG.precio_codigo  = Number(precio_codigo);
  if (aviso_texto     !== undefined) CONFIG.aviso_texto    = aviso_texto;
  if (aviso_color     !== undefined) CONFIG.aviso_color    = aviso_color;
  if (correo_pie      !== undefined) CONFIG.correo_pie     = correo_pie;
  console.log('⚙️ Config actualizada:', CONFIG);
  res.json({ ok: true, config: CONFIG });
});

// ── Correo masivo ────────────────────────────
router.post('/admin/correo-masivo', async (req, res) => {
  try {
    const { asunto, mensaje } = req.body;
    if (!asunto || !mensaje) return res.status(400).json({ error: 'Asunto y mensaje requeridos' });

    // Obtener todos los correos únicos de compradores pagados
    const { data: compras, error } = await supabase
      .from('compras').select('correo, nombre').in('estado', ['pagado', 'transferencia_aprobada']);
    if (error) return res.status(500).json({ error: 'Error obteniendo compradores' });

    const vistos = new Set();
    const destinatarios = (compras || []).filter(c => {
      if (!c.correo || vistos.has(c.correo)) return false;
      vistos.add(c.correo);
      return true;
    });

    if (!destinatarios.length) return res.json({ ok: true, enviados: 0 });

    const https = require('https');
    let enviados = 0;

    for (const comp of destinatarios) {
      try {
        const htmlContent = `
          <div style="background:#0f172a;padding:24px 16px;font-family:Arial,sans-serif;color:white;">
            <div style="max-width:500px;margin:auto;background:#111827;border-radius:16px;padding:28px 20px;">
              <div style="text-align:center;margin-bottom:20px;">
                <div style="font-size:40px;">📢</div>
                <h1 style="color:gold;margin:8px 0 4px;font-size:20px;">EiderTech Soluciones</h1>
              </div>
              <div style="font-size:14px;line-height:1.7;color:#e2e8f0;">${mensaje}</div>
              ${CONFIG.correo_pie ? `<hr style="border:none;border-top:1px solid #1f2937;margin:20px 0">
              <p style="font-size:12px;color:#6b7280;text-align:center">${CONFIG.correo_pie}</p>` : ''}
              <p style="text-align:center;color:#6b7280;font-size:11px;margin-top:16px;">
                📧 infoeidertechsoluciones@gmail.com &nbsp;|&nbsp; EiderTech Soluciones
              </p>
            </div>
          </div>`;

        const payload = JSON.stringify({
          sender: { name: 'EiderTech Soluciones', email: process.env.BREVO_FROM_EMAIL || 'eidercobo383@gmail.com' },
          to: [{ email: comp.correo, name: comp.nombre || '' }],
          subject: asunto,
          htmlContent
        });

        await new Promise((resolve, reject) => {
          const r = https.request({
            hostname: 'api.brevo.com', path: '/v3/smtp/email', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'api-key': process.env.BREVO_API_KEY, 'Content-Length': Buffer.byteLength(payload) }
          }, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => res.statusCode < 300 ? resolve() : reject(new Error(data)));
          });
          r.on('error', reject);
          r.write(payload); r.end();
        });

        enviados++;
        // Pausa pequeña para no saturar la API de Brevo
        await new Promise(r => setTimeout(r, 150));
      } catch (err) {
        console.error(`❌ Error enviando a ${comp.correo}:`, err.message);
      }
    }

    console.log(`📤 Correo masivo enviado: ${enviados}/${destinatarios.length}`);
    res.json({ ok: true, enviados, total: destinatarios.length });
  } catch (e) {
    console.error('💥 correo-masivo:', e);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── Exportar ganadores ───────────────────────
router.get('/admin/exportar', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('codigos').select('codigo, dorado, referencia, nombre, email, telefono')
      .eq('dorado', true).eq('vendido', true);
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
    await wb.xlsx.write(res); res.end();
  } catch (e) { res.status(500).json({ ok: false }); }
});

// ── Exportar compradores ─────────────────────
router.get('/admin/exportar-compradores', async (req, res) => {
  try {
    const { data: compras, error } = await supabase
      .from('compras')
      .select('referencia, nombre, correo, cedula, telefono, cantidad, estado, fecha, premio_dorado')
      .in('estado', ['pagado', 'transferencia_aprobada']).order('fecha', { ascending: false });
    if (error) return res.status(500).json({ ok: false });

    const refs = (compras || []).map(c => c.referencia);
    let codigosMap = {};
    if (refs.length) {
      const { data: codigos } = await supabase
        .from('codigos').select('codigo, dorado, referencia').in('referencia', refs);
      (codigos || []).forEach(c => {
        if (!codigosMap[c.referencia]) codigosMap[c.referencia] = [];
        codigosMap[c.referencia].push(c);
      });
    }

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Compradores');
    ws.columns = [
      { header: 'Nombre',        key: 'nombre',       width: 28 },
      { header: 'Correo',        key: 'correo',       width: 32 },
      { header: 'Cédula',        key: 'cedula',       width: 16 },
      { header: 'Teléfono',      key: 'telefono',     width: 16 },
      { header: 'Cantidad',      key: 'cantidad',     width: 10 },
      { header: 'Estado',        key: 'estado',       width: 12 },
      { header: 'Fecha',         key: 'fecha',        width: 22 },
      { header: 'Premio dorado', key: 'premio_dorado',width: 16 },
      { header: 'Códigos',       key: 'codigos',      width: 60 },
      { header: 'Referencia',    key: 'referencia',   width: 30 },
    ];
    ws.getRow(1).font = { bold: true };

    (compras || []).forEach(c => {
      const cods = (codigosMap[c.referencia] || []).map(x => (x.dorado ? '⭐' : '') + x.codigo).join(', ');
      ws.addRow({
        nombre: c.nombre || '', correo: c.correo || '', cedula: c.cedula || '',
        telefono: c.telefono || '', cantidad: c.cantidad, estado: c.estado,
        fecha: c.fecha ? new Date(c.fecha).toLocaleString('es-CO') : '',
        premio_dorado: c.premio_dorado ? '$' + Number(c.premio_dorado).toLocaleString('es-CO') : '',
        codigos: cods, referencia: c.referencia,
      });
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=compradores.xlsx');
    await wb.xlsx.write(res); res.end();
  } catch (e) { res.status(500).json({ ok: false }); }
});

module.exports = router;