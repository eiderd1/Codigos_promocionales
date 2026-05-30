// routes/notif-admin.js
// ─────────────────────────────────────────────────────────────────────────────
// Endpoints exclusivos del admin para los 3 features nuevos:
//   POST /admin/recordatorio-transferencias  → envía recordatorio a pendientes +12h
//   POST /admin/correo-masivo                → envía correo masivo a compradores
//   GET  /admin/notif-stats                  → estadísticas rápidas para el panel
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();
const supabase = require('../config/supabase');
const { recordatorioTransferencias, correoMasivo, recordatorioPagosIncompletos } = require('../services/notificaciones');

// ── Auth middleware ──────────────────────────────────────────────────────────
function authAdmin(req, res, next) {
  const token  = req.headers['x-admin-token'] || req.query.token;
  const SECRET = process.env.ADMIN_SECRET;
  if (!SECRET) return res.status(500).json({ error: 'ADMIN_SECRET no configurado' });
  if (!token || token !== SECRET) return res.status(401).json({ error: 'No autorizado' });
  next();
}

// ════════════════════════════════════════════════════════════════════════════
// GET /admin/notif-stats
// Devuelve cuántas transferencias pendientes +12h hay y cuántos compradores
// tienen códigos, para mostrar en el panel antes de ejecutar cada acción.
// ════════════════════════════════════════════════════════════════════════════
router.get('/admin/notif-stats', authAdmin, async (req, res) => {
  try {
    const hace12h = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();

    // Ejecutar cada query de forma independiente para que un fallo no rompa todo
    let transf12h = 0, incompletos12h = 0, emailsUnicos = new Set();

    // ── Transferencias pendientes +12h ───────────────────────────────────────
    try {
      // Intentar con columna 'fecha' primero, luego 'created_at'
      let q = await supabase
        .from('compras')
        .select('referencia', { count: 'exact', head: false })
        .eq('estado', 'transferencia_pendiente')
        .lt('fecha', hace12h);

      if (q.error) {
        q = await supabase
          .from('compras')
          .select('referencia', { count: 'exact', head: false })
          .eq('estado', 'transferencia_pendiente')
          .lt('created_at', hace12h);
      }
      transf12h = (q.data || []).length;
    } catch(e) { console.error('stat transf12h:', e.message); }

    // ── Pagos incompletos +12h (Wompi + transferencias) ──────────────────────
    try {
      const q = await supabase
        .from('compras')
        .select('correo, estado, fecha')
        .in('estado', ['pendiente', 'transferencia_pendiente'])
        .not('correo', 'is', null);

      if (q.error) throw q.error;

      // Filtrar por +12h y deduplicar por correo
      const correos = new Set(
        (q.data || [])
          .filter(c => c.fecha && new Date(c.fecha) < new Date(hace12h))
          .map(c => c.correo)
          .filter(Boolean)
      );
      incompletos12h = correos.size;
    } catch(e) { console.error('stat incompletos:', e.message); }

    // ── Compradores con códigos ──────────────────────────────────────────────
    try {
      const { data: compradores } = await supabase
        .from('codigos')
        .select('email')
        .eq('vendido', true)
        .not('email', 'is', null);
      emailsUnicos = new Set((compradores || []).map(c => c.email).filter(Boolean));
    } catch(e) { console.error('stat compradores:', e.message); }

    res.json({
      transferencias_pendientes_12h: transf12h,
      pagos_incompletos_12h:         incompletos12h,
      compradores_con_codigos:       emailsUnicos.size
    });
  } catch (e) {
    console.error('💥 Error notif-stats:', e);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// POST /admin/recordatorio-transferencias
// Envía recordatorio a todos los clientes con transferencia_pendiente +12h
// ════════════════════════════════════════════════════════════════════════════
router.post('/admin/recordatorio-transferencias', authAdmin, async (req, res) => {
  try {
    console.log('📤 Admin activó recordatorio de transferencias pendientes');
    const resultado = await recordatorioTransferencias(supabase);
    res.json({ ok: true, ...resultado });
  } catch (e) {
    console.error('💥 Error recordatorio:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// POST /admin/correo-masivo
// Body: { asunto, mensaje, tituloDestacado? }
// Envía correo a todos los compradores con códigos asignados
// ════════════════════════════════════════════════════════════════════════════
router.post('/admin/correo-masivo', authAdmin, async (req, res) => {
  try {
    const { asunto, mensaje, tituloDestacado } = req.body;

    if (!asunto || !asunto.trim()) {
      return res.status(400).json({ error: 'El asunto es requerido' });
    }
    if (!mensaje || !mensaje.trim()) {
      return res.status(400).json({ error: 'El mensaje es requerido' });
    }
    if (asunto.length > 150) {
      return res.status(400).json({ error: 'El asunto no puede superar 150 caracteres' });
    }
    if (mensaje.length > 2000) {
      return res.status(400).json({ error: 'El mensaje no puede superar 2000 caracteres' });
    }

    console.log(`📢 Admin activó correo masivo: "${asunto}"`);
    const resultado = await correoMasivo(supabase, { asunto, mensaje, tituloDestacado });
    res.json({ ok: true, ...resultado });
  } catch (e) {
    console.error('💥 Error correo masivo:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// POST /admin/recordatorio-pagos-incompletos
// Envía recordatorio a compras 'pendiente' (Wompi) y 'transferencia_pendiente'
// con más de 12h sin completar. Un solo correo por email aunque tenga varios intentos.
// ════════════════════════════════════════════════════════════════════════════
router.post('/admin/recordatorio-pagos-incompletos', authAdmin, async (req, res) => {
  try {
    console.log('📤 Admin activó recordatorio de pagos incompletos');
    const resultado = await recordatorioPagosIncompletos(supabase);
    res.json({ ok: true, ...resultado });
  } catch (e) {
    console.error('💥 Error recordatorio incompletos:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;