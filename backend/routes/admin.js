const express = require('express');
const router  = express.Router();
const supabase = require('../config/supabase');
const { activarPromo, desactivarPromo, getPromoActiva } = require('../services/promociones');
const { enviarCorreo } = require('../services/correo');
const ExcelJS = require('exceljs');

// ════════════════════════════════════════════
// RATE LIMITING — bloqueo tras 3 fallos
// ════════════════════════════════════════════
const loginAttempts = new Map();

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
    entry.blockedUntil = Date.now() + 5 * 60 * 1000;
    entry.count = 0;
    console.warn(`🔒 IP bloqueada por 5 min: ${ip}`);
  }
  loginAttempts.set(ip, entry);
}

function limpiarFallosLogin(ip) {
  loginAttempts.delete(ip);
}

// ════════════════════════════════════════════
// AUTH MIDDLEWARE
// ════════════════════════════════════════════
function authAdmin(req, res, next) {
  const token  = req.headers['x-admin-token'] || req.query.token;
  const SECRET = process.env.ADMIN_SECRET;
  if (!SECRET) return res.status(500).json({ error: 'ADMIN_SECRET no configurado en .env' });
  if (!token || token !== SECRET) return res.status(401).json({ error: 'No autorizado' });
  next();
}

// ════════════════════════════════════════════
// CONFIG compartido (services/appState.js)
// ════════════════════════════════════════════
const { CONFIG } = require('../services/appState');

// ════════════════════════════════════════════
// RUTAS PÚBLICAS
// ════════════════════════════════════════════

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

router.get('/config-publica', (req, res) => {
  res.json({
    ventas_activas: CONFIG.ventas_activas,
    aviso_texto:    CONFIG.aviso_texto,
    aviso_color:    CONFIG.aviso_color,
    precio_codigo:  CONFIG.precio_codigo,
    ganador:        CONFIG.ganador
  });
});

// NOTA: GET /config es manejado por routes/config.js (lee de Supabase)
// No registrar aquí para evitar conflicto de rutas.

// ════════════════════════════════════════════
// VERIFICAR LOGIN
// ════════════════════════════════════════════
router.post('/admin/verificar', (req, res) => {
  const ip     = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  const token  = req.headers['x-admin-token'] || req.query.token;
  const SECRET = process.env.ADMIN_SECRET;

  if (!SECRET) return res.status(500).json({ error: 'ADMIN_SECRET no configurado' });

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
// LOG de accesos
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

// ════════════════════════════════════════════
// TRANSFERENCIAS
// ════════════════════════════════════════════

router.get('/admin/transferencias', async (req, res) => {
  try {
    const { data: compras, error } = await supabase
      .from('compras')
      .select('*')
      .in('estado', ['transferencia_pendiente', 'transferencia_aprobada', 'transferencia_rechazada'])
      .order('fecha', { ascending: false });

    if (error) return res.status(500).json({ ok: false });

    const refs = (compras || []).map(x => x.referencia);
    let codigosMap = {};
    if (refs.length) {
      const { data: codigos } = await supabase
        .from('codigos').select('codigo, dorado, referencia').in('referencia', refs);
      (codigos || []).forEach(c => {
        if (!codigosMap[c.referencia]) codigosMap[c.referencia] = [];
        codigosMap[c.referencia].push(c);
      });
    }

    res.json({ ok: true, transferencias: (compras || []).map(c => ({ ...c, codigos: codigosMap[c.referencia] || [] })) });
  } catch (e) {
    console.error('💥 transferencias:', e);
    res.status(500).json({ ok: false });
  }
});

router.post('/admin/transferencia-aprobar', async (req, res) => {
  try {
    const { referencia, notas } = req.body;
    if (!referencia) return res.status(400).json({ ok: false, error: 'Referencia requerida' });

    const { data: compra, error } = await supabase
      .from('compras').select('*').eq('referencia', referencia).single();
    if (error || !compra) return res.status(404).json({ ok: false, error: 'Compra no encontrada' });
    if (compra.estado !== 'transferencia_pendiente') return res.status(400).json({ ok: false, error: 'La transferencia ya fue procesada' });

    const { data: disponibles, error: errCodigos } = await supabase
      .from('codigos').select('*').eq('vendido', false).limit(compra.cantidad);
    if (errCodigos || !disponibles || disponibles.length < compra.cantidad)
      return res.status(400).json({ ok: false, error: 'No hay suficientes códigos disponibles' });

    for (const cod of disponibles) {
      await supabase.from('codigos').update({
        vendido: true, referencia: compra.referencia,
        nombre: compra.nombre, email: compra.correo, telefono: compra.telefono
      }).eq('id', cod.id);
    }

    await supabase.from('compras').update({ estado: 'transferencia_aprobada', notas_admin: notas || null }).eq('referencia', referencia);

    const { data: codigosAsignados } = await supabase.from('codigos').select('codigo, dorado').eq('referencia', referencia);

    try {
      const listaCodigos = (codigosAsignados || []).map(c => `${c.dorado ? '⭐ ' : ''}${c.codigo}`).join(', ');
      await enviarCorreo({
        para: compra.correo,
        asunto: '✅ Compra aprobada — Tus códigos',
        html: `<div style="font-family:Arial;padding:20px">
          <h2>✅ Pago aprobado</h2>
          <p>Hola <strong>${compra.nombre}</strong>,</p>
          <p>Tu transferencia fue aprobada correctamente.</p>
          <p><strong>Tus códigos:</strong></p>
          <div style="padding:12px;background:#f5f5f5;border-radius:8px;margin:10px 0">${listaCodigos}</div>
          <p>Referencia: <strong>${referencia}</strong></p>
          <p>Gracias por tu compra.</p>
        </div>`
      });
    } catch (correoErr) { console.error('❌ Error enviando correo:', correoErr); }

    res.json({ ok: true, mensaje: '✅ Transferencia aprobada correctamente' });
  } catch (e) {
    console.error('💥 aprobar transferencia:', e);
    res.status(500).json({ ok: false, error: 'Error interno' });
  }
});

router.post('/admin/transferencia-rechazar', async (req, res) => {
  try {
    const { referencia, notas } = req.body;
    if (!referencia) return res.status(400).json({ ok: false, error: 'Referencia requerida' });

    const { data: compra, error } = await supabase.from('compras').select('*').eq('referencia', referencia).single();
    if (error || !compra) return res.status(404).json({ ok: false, error: 'Compra no encontrada' });

    await supabase.from('compras').update({ estado: 'transferencia_rechazada', notas_admin: notas || null }).eq('referencia', referencia);

    try {
      await enviarCorreo({
        para: compra.correo,
        asunto: '❌ Transferencia rechazada',
        html: `<div style="font-family:Arial;padding:20px">
          <h2>❌ Transferencia rechazada</h2>
          <p>Hola <strong>${compra.nombre}</strong>,</p>
          <p>Tu transferencia no pudo ser validada.</p>
          ${notas ? `<p><strong>Motivo:</strong> ${notas}</p>` : ''}
          <p>Si crees que esto es un error puedes comunicarte con soporte.</p>
        </div>`
      });
    } catch (correoErr) { console.error(correoErr); }

    res.json({ ok: true, mensaje: '✕ Transferencia rechazada' });
  } catch (e) {
    console.error('💥 rechazar transferencia:', e);
    res.status(500).json({ ok: false, error: 'Error interno' });
  }
});

// ════════════════════════════════════════════
// BUSCADOR GLOBAL
// ════════════════════════════════════════════

router.get('/admin/buscar', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json({ resultados: [] });

    // Buscar en compras por nombre, correo, cédula, teléfono o referencia
    const { data: compras, error } = await supabase
      .from('compras')
      .select('referencia, nombre, correo, cedula, telefono, cantidad, estado, fecha')
      .or(`nombre.ilike.%${q}%,correo.ilike.%${q}%,cedula.ilike.%${q}%,telefono.ilike.%${q}%,referencia.ilike.%${q}%`)
      .order('fecha', { ascending: false })
      .limit(50);

    if (error) return res.status(500).json({ ok: false, error: 'Error en búsqueda' });

    // También buscar por código si el query parece un código
    let refsPorCodigo = [];
    if (/^\d{3,6}$/.test(q)) {
      const { data: codsBuscados } = await supabase
        .from('codigos').select('referencia').ilike('codigo', `%${q}%`).limit(20);
      refsPorCodigo = (codsBuscados || []).map(c => c.referencia).filter(Boolean);
    }

    let comprasPorCodigo = [];
    if (refsPorCodigo.length) {
      const { data: extra } = await supabase
        .from('compras')
        .select('referencia, nombre, correo, cedula, telefono, cantidad, estado, fecha')
        .in('referencia', refsPorCodigo);
      comprasPorCodigo = extra || [];
    }

    // Unir y deduplicar
    const todasRefs = new Set();
    const todas = [...(compras || []), ...comprasPorCodigo].filter(c => {
      if (todasRefs.has(c.referencia)) return false;
      todasRefs.add(c.referencia);
      return true;
    });

    // Obtener códigos de las compras encontradas
    const refs = todas.filter(c => ['pagado','transferencia_aprobada'].includes(c.estado)).map(c => c.referencia);
    let codigosMap = {};
    if (refs.length) {
      const { data: codigos } = await supabase
        .from('codigos').select('codigo, dorado, referencia').in('referencia', refs);
      (codigos || []).forEach(c => {
        if (!codigosMap[c.referencia]) codigosMap[c.referencia] = [];
        codigosMap[c.referencia].push({ codigo: c.codigo, dorado: c.dorado });
      });
    }

    res.json({ resultados: todas.map(c => ({ ...c, codigos: codigosMap[c.referencia] || [] })) });
  } catch (e) {
    console.error('💥 buscar:', e);
    res.status(500).json({ ok: false, error: 'Error interno' });
  }
});

// ════════════════════════════════════════════
// NOTIF STATS
// ════════════════════════════════════════════

router.get('/admin/notif-stats', async (req, res) => {
  try {
    const hace12h = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();

    // Transferencias pendientes con más de 12h
    const { count: trf12h } = await supabase
      .from('compras')
      .select('*', { count: 'exact', head: true })
      .eq('estado', 'transferencia_pendiente')
      .lt('fecha', hace12h);

    // Pagos incompletos (pendiente o transferencia_pendiente) con más de 12h
    const { count: inc12h } = await supabase
      .from('compras')
      .select('*', { count: 'exact', head: true })
      .in('estado', ['pendiente', 'transferencia_pendiente'])
      .lt('fecha', hace12h);

    // Compradores con códigos asignados (pagado o transferencia_aprobada)
    const { count: conCodigos } = await supabase
      .from('compras')
      .select('*', { count: 'exact', head: true })
      .in('estado', ['pagado', 'transferencia_aprobada']);

    res.json({
      transferencias_pendientes_12h: trf12h  || 0,
      pagos_incompletos_12h:         inc12h  || 0,
      compradores_con_codigos:       conCodigos || 0
    });
  } catch (e) {
    console.error('💥 notif-stats:', e);
    res.status(500).json({ ok: false });
  }
});

// ════════════════════════════════════════════
// GANADOR
// ════════════════════════════════════════════

// GET — obtener estado actual del ganador (ya disponible vía /admin/config)
// POST — publicar o limpiar ganador
router.post('/admin/ganador', (req, res) => {
  try {
    const { activo, codigo, nombre } = req.body;

    if (activo === false) {
      // Ocultar ganador
      CONFIG.ganador = { activo: false, codigo: '', nombre: '' };
      console.log('🏆 Ganador ocultado');
      return res.json({ ok: true, mensaje: 'Ganador ocultado' });
    }

    if (!codigo || !nombre) {
      return res.status(400).json({ ok: false, error: 'Código y nombre son obligatorios' });
    }

    CONFIG.ganador = { activo: true, codigo: codigo.trim(), nombre: nombre.trim() };
    console.log(`🏆 Ganador publicado: ${codigo} — ${nombre}`);
    res.json({ ok: true, mensaje: `🏆 Ganador publicado: ${codigo}` });
  } catch (e) {
    console.error('💥 ganador:', e);
    res.status(500).json({ ok: false, error: 'Error interno' });
  }
});

// ════════════════════════════════════════════
// GET /api/admin/resumen-financiero
// ════════════════════════════════════════════
router.get('/admin/resumen-financiero', authAdmin, async (req, res) => {
  try {
    const { data: compras, error } = await supabase
      .from('compras')
      .select('nombre, correo, cantidad, referencia, estado, fecha')
      .order('fecha', { ascending: false });

    if (error) throw error;

    const PRECIO = CONFIG.precio_codigo || 3750;

    const pagadas       = compras.filter(c => c.estado === 'pagado');
    const transferencias = compras.filter(c => c.estado === 'transferencia_aprobada');
    const pendientes    = compras.filter(c => c.estado === 'pendiente');
    const rechazadas    = compras.filter(c => ['DECLINED','transferencia_rechazada'].includes(c.estado));

    const sumCodigos = arr => arr.reduce((s, c) => s + (c.cantidad || 0), 0);

    const codigosPagados      = sumCodigos(pagadas);
    const codigosTransf       = sumCodigos(transferencias);
    const codigosTotales      = codigosPagados + codigosTransf;
    const ingresosPagados     = codigosPagados * PRECIO;
    const ingresosTransf      = codigosTransf  * PRECIO;
    const ingresosTotal       = codigosTotales * PRECIO;
    const ingresosPendientes  = sumCodigos(pendientes) * PRECIO;

    res.json({
      resumen: {
        ingresos_total:      ingresosTotal,
        ingresos_wompi:      ingresosPagados,
        ingresos_transf:     ingresosTransf,
        ingresos_pendientes: ingresosPendientes,
        codigos_vendidos:    codigosTotales,
        ventas_wompi:        pagadas.length,
        ventas_transf:       transferencias.length,
        ventas_pendientes:   pendientes.length,
        ventas_rechazadas:   rechazadas.length,
        precio_codigo:       PRECIO,
      },
      compras: compras.map(c => ({
        nombre:     c.nombre,
        correo:     c.correo,
        cantidad:   c.cantidad,
        monto:      (c.cantidad || 0) * PRECIO,
        referencia: c.referencia,
        estado:     c.estado,
        fecha:      c.fecha,
      }))
    });
  } catch(e) {
    console.error('❌ Error resumen financiero:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════
// SSE — Contador de ventas en tiempo real
// ════════════════════════════════════════════
const sseStatsClientes = [];

router.get('/admin/stats-stream', authAdmin, (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  const cliente = { res };
  sseStatsClientes.push(cliente);
  res.write('event: ping\ndata: ok\n\n');

  req.on('close', () => {
    const idx = sseStatsClientes.indexOf(cliente);
    if (idx !== -1) sseStatsClientes.splice(idx, 1);
  });
});

async function emitirStatsVentas() {
  if (sseStatsClientes.length === 0) return;
  try {
    const { data: pagadas } = await supabase
      .from('compras')
      .select('cantidad, fecha')
      .in('estado', ['pagado', 'transferencia_aprobada'])
      .order('fecha', { ascending: false });

    const { count: pendientes } = await supabase
      .from('compras')
      .select('*', { count: 'exact', head: true })
      .eq('estado', 'pendiente');

    const { count: disponibles } = await supabase
      .from('codigos')
      .select('*', { count: 'exact', head: true })
      .eq('vendido', false);

    const PRECIO        = CONFIG.precio_codigo || 3750;
    const totalVentas   = pagadas?.length || 0;
    const totalCodigos  = (pagadas || []).reduce((s, c) => s + (c.cantidad || 0), 0);
    const ingresos      = totalCodigos * PRECIO;

    const payload = JSON.stringify({
      ventas:              totalVentas,
      codigos_vendidos:    totalCodigos,
      codigos_disponibles: disponibles || 0,
      pendientes:          pendientes  || 0,
      ingresos,
      ultima_venta:        pagadas?.[0]?.fecha || null,
      ventas_activas:      CONFIG.ventas_activas,
      ts:                  Date.now()
    });

    for (const c of sseStatsClientes) {
      try { c.res.write(`event: stats\ndata: ${payload}\n\n`); }
      catch (_) {}
    }
  } catch (e) {
    console.error('💥 SSE stats error:', e.message);
  }
}

setInterval(emitirStatsVentas, 6000);

module.exports = router;
module.exports.emitirStatsVentas = emitirStatsVentas;