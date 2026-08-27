const express = require('express');
const router  = express.Router();
const supabase = require('../config/supabase');
const { activarPromo, desactivarPromo, getPromoActiva } = require('../services/promociones');
const { actualizarConfig } = require('../services/configStore');
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
      .from('codigos')
      .select('codigo, nombre, email, telefono')
      .eq('dorado', true).eq('vendido', true);
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

// ── Reenviar correo (con opción de corregir el email) ────────
// Body: { referencia, correoNuevo? }
// Si el cliente escribió mal su correo, se puede pasar `correoNuevo`
// para corregirlo en `compras` y `codigos` antes de reenviar.
router.post('/admin/reenviar-correo', async (req, res) => {
  try {
    const { referencia, correoNuevo } = req.body;
    if (!referencia) {
      return res.status(400).json({ ok: false, error: 'Referencia requerida' });
    }

    const { data: compra, error: errCompra } = await supabase
      .from('compras')
      .select('*')
      .eq('referencia', referencia)
      .single();

    if (errCompra || !compra) {
      return res.status(404).json({ ok: false, error: 'Compra no encontrada' });
    }

    if (!['pagado', 'transferencia_aprobada'].includes(compra.estado)) {
      return res.status(400).json({ ok: false, error: 'Esta compra no tiene códigos asignados (aún no está pagada/aprobada)' });
    }

    // ── Corregir correo si se envió uno nuevo y es distinto ────────────────
    let correoFinal = compra.correo;
    if (correoNuevo && correoNuevo.trim() && correoNuevo.trim() !== compra.correo) {
      const nuevo = correoNuevo.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nuevo)) {
        return res.status(400).json({ ok: false, error: 'Correo electrónico inválido' });
      }

      const { error: errUpdCompra } = await supabase
        .from('compras').update({ correo: nuevo }).eq('referencia', referencia);
      if (errUpdCompra) {
        console.error('❌ Error actualizando correo en compras:', errUpdCompra);
        return res.status(500).json({ ok: false, error: 'Error actualizando correo' });
      }

      const { error: errUpdCodigos } = await supabase
        .from('codigos').update({ email: nuevo }).eq('referencia', referencia);
      if (errUpdCodigos) {
        console.error('❌ Error actualizando correo en códigos:', errUpdCodigos);
        // no bloqueamos el reenvío por esto, pero queda logueado
      }

      correoFinal = nuevo;
      console.log(`✏️ Correo corregido para ${referencia}: ${compra.correo} → ${nuevo}`);
    }

    // ── Traer los códigos asignados a esta referencia ──────────────────────
    const { data: codigos, error: errCodigos } = await supabase
      .from('codigos')
      .select('codigo, dorado, premio_dorado')
      .eq('referencia', referencia);

    if (errCodigos || !codigos || codigos.length === 0) {
      return res.status(404).json({ ok: false, error: 'No se encontraron códigos para esta referencia' });
    }

    const codigosParaCorreo = codigos.map(c => ({
      codigo: c.codigo,
      dorado: c.dorado,
      premioDorado: c.premio_dorado || null
    }));
    const codigoDorado = codigosParaCorreo.find(c => c.dorado);

    try {
      await enviarCorreo(correoFinal, codigosParaCorreo, codigoDorado?.premioDorado || null);
      console.log(`📧 Correo reenviado manualmente a ${correoFinal} (${referencia})`);
    } catch (err) {
      console.error(`❌ FALLO AL REENVIAR CORREO a ${correoFinal}:`, err.message);
      return res.status(500).json({ ok: false, error: `No se pudo enviar el correo: ${err.message}` });
    }

    res.json({ ok: true, mensaje: `✅ Correo reenviado a ${correoFinal}`, correo: correoFinal });
  } catch (e) {
    console.error('💥 Error reenviar-correo:', e);
    res.status(500).json({ ok: false, error: 'Error interno del servidor' });
  }
});


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

router.post('/admin/config', async (req, res) => {
  try {
    const {
      ventas_activas, precio_codigo, aviso_texto, aviso_color, correo_pie,
      precio_dorado, premio_total, premio_imagen, nombre_dinamica
    } = req.body;

    const cambios = {};
    if (ventas_activas  !== undefined) cambios.ventas_activas  = !!ventas_activas;
    if (precio_codigo   !== undefined) cambios.precio_codigo   = Number(precio_codigo);
    if (aviso_texto     !== undefined) cambios.aviso_texto     = aviso_texto;
    if (aviso_color     !== undefined) cambios.aviso_color     = aviso_color;
    if (correo_pie      !== undefined) cambios.correo_pie      = correo_pie;
    if (precio_dorado   !== undefined) cambios.precio_dorado   = Number(precio_dorado);
    if (premio_total    !== undefined) cambios.premio_total    = Number(premio_total);
    if (premio_imagen   !== undefined) cambios.premio_imagen   = premio_imagen;
    if (nombre_dinamica  !== undefined) cambios.nombre_dinamica = nombre_dinamica;

    // Se guarda en Supabase Y en memoria, para que sobreviva reinicios del servidor
    await actualizarConfig(cambios);

    console.log('⚙️ Config actualizada:', CONFIG);
    res.json({ ok: true, config: CONFIG });
  } catch (e) {
    console.error('❌ Error guardando config:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
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

// NOTA: las rutas /admin/transferencia-aprobar y /admin/transferencia-rechazar
// se eliminaron de este archivo. Estaban duplicadas con routes/transferencias.js
// y, al registrarse primero en server.js, interceptaban la petición e impedían
// que la versión correcta (con generarCodigos, notif admin y envío de correo
// con la firma adecuada) se ejecutara. Ahora esas rutas viven únicamente en
// routes/transferencias.js.

// ════════════════════════════════════════════
// WOMPI — pagos por pasarela
// ════════════════════════════════════════════

router.get('/admin/wompi', authAdmin, async (req, res) => {
  try {
    const { data: compras, error } = await supabase
      .from('compras')
      .select('*')
      .in('estado', ['pagado', 'pendiente', 'DECLINED'])
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

    res.json({ ok: true, wompi: (compras || []).map(c => ({ ...c, codigos: codigosMap[c.referencia] || [] })) });
  } catch (e) {
    console.error('💥 wompi:', e);
    res.status(500).json({ ok: false });
  }
});


// ════════════════════════════════════════════
// BUSCAR COMPRADOR POR CÓDIGO EXACTO (para autocompletar el nombre del ganador)
// ════════════════════════════════════════════
router.get('/admin/codigo/:codigo', authAdmin, async (req, res) => {
  try {
    const codigo = (req.params.codigo || '').trim();
    if (!codigo) return res.status(400).json({ ok: false, error: 'Código requerido' });

    const { data, error } = await supabase
      .from('codigos')
      .select('codigo, nombre, email, telefono, vendido, dorado')
      .eq('codigo', codigo)
      .maybeSingle();

    if (error) return res.status(500).json({ ok: false, error: 'Error buscando código' });
    if (!data || !data.vendido) return res.json({ ok: true, encontrado: false });

    res.json({ ok: true, encontrado: true, ...data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
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

    // Misma fuente de verdad que /api/progreso: conteo directo y en vivo de la
    // tabla completa, sin sumar dos conteos parciales por separado.
    const { count: totalPool } = await supabase
      .from('codigos')
      .select('*', { count: 'exact', head: true });

    const { count: vendidosReal } = await supabase
      .from('codigos')
      .select('*', { count: 'exact', head: true })
      .eq('vendido', true);

    const disponibles = Math.max(0, (totalPool || 0) - (vendidosReal || 0));

    const PRECIO        = CONFIG.precio_codigo || 3750;
    const totalVentas   = pagadas?.length || 0;
    const totalCodigos  = vendidosReal || 0;
    const ingresos      = totalCodigos * PRECIO;

    const payload = JSON.stringify({
      ventas:              totalVentas,
      codigos_vendidos:    totalCodigos,
      codigos_disponibles: disponibles,
      codigos_total:       totalPool || 0,
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