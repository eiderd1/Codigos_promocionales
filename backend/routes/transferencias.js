// routes/transferencias.js
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();
const https   = require('https');
const supabase = require('../config/supabase');
const { generarCodigos } = require('../services/codigos');
const { enviarCorreo }   = require('../services/correo');
const { enviarWhatsApp } = require('../services/whatsapp');
const { enviarNotifAdmin } = require('../services/notificaciones');

// ── Validación básica de correo ──────────────────────────────────────────────
function esCorreoValido(correo) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo);
}

// ── Auth middleware ──────────────────────────────────────────────────────────
function authAdmin(req, res, next) {
  const token  = req.headers['x-admin-token'] || req.query.token;
  const SECRET = process.env.ADMIN_SECRET;
  if (!SECRET) return res.status(500).json({ error: 'ADMIN_SECRET no configurado' });
  if (!token || token !== SECRET) return res.status(401).json({ error: 'No autorizado' });
  next();
}

// ════════════════════════════════════════════════════════════════════════════
// PÚBLICA — El cliente registra su intención de pago por transferencia
// ════════════════════════════════════════════════════════════════════════════
router.post('/transferencia-registrar', async (req, res) => {
  try {
    const { nombre, correo, cedula, telefono, direccion, cantidad } = req.body;

    if (!nombre || !correo || !cantidad) {
      return res.status(400).json({ error: 'Nombre, correo y cantidad son obligatorios' });
    }
    if (!esCorreoValido(correo)) {
      return res.status(400).json({ error: 'Correo electrónico inválido' });
    }
    const cantidadesValidas = [4, 8, 16];
    if (!cantidadesValidas.includes(Number(cantidad))) {
      return res.status(400).json({ error: 'Cantidad inválida. Elige 4, 8 o 16' });
    }

    const { count: disponibles } = await supabase
      .from('codigos')
      .select('*', { count: 'exact', head: true })
      .eq('vendido', false);

    if (!disponibles || disponibles === 0) {
      return res.status(400).json({ error: 'No hay códigos disponibles' });
    }

    const cantidadFinal    = Math.min(Number(cantidad), disponibles);
    const precioPorCodigo  = 3750;
    const montoTotal       = cantidadFinal * precioPorCodigo;
    const referencia       = `TRF-${Date.now()}-${Math.floor(Math.random() * 9999)}`;

    const { error: errorCompra } = await supabase
      .from('compras')
      .insert([{
        nombre,
        cedula:    cedula    || '',
        telefono:  telefono  || '',
        correo,
        direccion: direccion || '',
        cantidad:  cantidadFinal,
        referencia,
        estado:    'transferencia_pendiente',
        fecha:     new Date()
      }]);

    if (errorCompra) {
      console.error('❌ Error guardando transferencia:', errorCompra);
      return res.status(500).json({ error: 'Error interno del servidor' });
    }

    console.log(`🏦 Transferencia registrada: ${referencia} | ${cantidadFinal} códigos | $${montoTotal.toLocaleString()}`);

    // ── Notificar al admin de la nueva transferencia pendiente ───────────────
    try {
      await enviarNotifAdmin({
        tipo:      'transferencia',
        nombre,
        correo,
        cedula:    cedula    || '',
        telefono:  telefono  || '',
        cantidad:  cantidadFinal,
        referencia,
        monto:     montoTotal
      });
    } catch (err) {
      console.error('❌ Error notif admin transferencia:', err.message);
    }

    res.json({
      ok: true,
      referencia,
      cantidadFinal,
      montoTotal,
      mensaje: `Tu solicitud fue registrada. Una vez confirmemos la transferencia de $${montoTotal.toLocaleString('es-CO')} COP te enviaremos los códigos a tu correo.`
    });

  } catch (error) {
    console.error('💥 Error transferencia-registrar:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ADMIN — Listar transferencias pendientes y procesadas
// ════════════════════════════════════════════════════════════════════════════
router.get('/admin/transferencias', authAdmin, async (req, res) => {
  try {
    const { data: compras, error } = await supabase
      .from('compras')
      .select('referencia, nombre, correo, cedula, telefono, cantidad, estado, fecha, premio_dorado, notas_admin')
      .in('estado', ['transferencia_pendiente', 'transferencia_aprobada', 'transferencia_rechazada'])
      .order('fecha', { ascending: false })
      .limit(200);

    if (error) return res.status(500).json({ ok: false });

    const refs = (compras || [])
      .filter(c => c.estado === 'transferencia_aprobada')
      .map(c => c.referencia);

    let codigosMap = {};
    if (refs.length) {
      const { data: codigos } = await supabase
        .from('codigos').select('codigo, dorado, referencia').in('referencia', refs);
      (codigos || []).forEach(c => {
        if (!codigosMap[c.referencia]) codigosMap[c.referencia] = [];
        codigosMap[c.referencia].push({ codigo: c.codigo, dorado: c.dorado });
      });
    }

    res.json({
      transferencias: (compras || []).map(c => ({
        ...c,
        codigos: codigosMap[c.referencia] || []
      }))
    });

  } catch (e) {
    console.error('💥 Error listando transferencias:', e);
    res.status(500).json({ ok: false });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ADMIN — Aprobar transferencia → genera códigos automáticamente
// ════════════════════════════════════════════════════════════════════════════
router.post('/admin/transferencia-aprobar', authAdmin, async (req, res) => {
  try {
    const { referencia, notas } = req.body;
    if (!referencia) return res.status(400).json({ error: 'Referencia requerida' });

    const { data: compra, error: errCompra } = await supabase
      .from('compras')
      .select('*')
      .eq('referencia', referencia)
      .eq('estado', 'transferencia_pendiente')
      .single();

    if (errCompra || !compra) {
      return res.status(404).json({ error: 'Transferencia no encontrada o ya procesada' });
    }

    let codigos;
    try {
      codigos = await generarCodigos(compra.cantidad, referencia);
    } catch (err) {
      console.error('❌ Error generando códigos:', err);
      return res.status(500).json({ error: 'Error generando códigos' });
    }

    if (!codigos || codigos.length === 0) {
      return res.status(400).json({ error: 'Sin stock disponible para asignar' });
    }

    codigos = [...codigos].sort(() => Math.random() - 0.5);

    const wompiId = `MANUAL-${referencia}`;
    const { error: errorTx } = await supabase
      .from('transacciones')
      .insert([{
        referencia,
        wompi_id:   wompiId,
        estado:     'APROBADO',
        email:      compra.correo,
        cantidad:   compra.cantidad,
        created_at: new Date()
      }]);

    if (errorTx && !errorTx.message?.includes('duplicate')) {
      console.error('❌ Error insertando transacción:', errorTx);
      return res.status(500).json({ error: 'Error interno' });
    }

    const codigoDorado = codigos.find(c => c.dorado);
    const updateData = {
      estado:      'transferencia_aprobada',
      notas_admin: notas || null
    };
    if (codigoDorado?.premioDorado) {
      updateData.premio_dorado = codigoDorado.premioDorado;
    }

    await supabase.from('compras').update(updateData).eq('referencia', referencia);

    for (const c of codigos) {
      await supabase
        .from('codigos')
        .update({
          vendido:   true,
          referencia,
          email:     compra.correo,
          nombre:    compra.nombre,
          telefono:  compra.telefono || '',
          direccion: compra.direccion || ''
        })
        .eq('codigo', c.codigo);
    }

    // ── Enviar correo (con log explícito para detectar fallos) ───────────────
    try {
      await enviarCorreo(compra.correo, codigos, codigoDorado?.premioDorado || null);
      console.log(`📧 Correo de aprobación enviado a ${compra.correo}`);
    } catch (err) {
      // 🔧 FIX: el error ya no se traga silenciosamente
      console.error(`❌ FALLO AL ENVIAR CORREO a ${compra.correo}:`, err.message);
      // Continúa y responde OK para no bloquear la aprobación,
      // pero el admin verá el error en los logs
    }

    if (compra.telefono) {
      try {
        await enviarWhatsApp(compra.telefono, compra.nombre, codigos);
      } catch (err) {
        console.error('❌ Error WhatsApp:', err.message);
      }
    }

    console.log(`✅ Transferencia aprobada: ${referencia} → ${codigos.length} códigos generados`);

    res.json({
      ok: true,
      codigos,
      mensaje: `✅ ${codigos.length} códigos generados y enviados a ${compra.correo}`
    });

  } catch (e) {
    console.error('💥 Error aprobando transferencia:', e);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ADMIN — Rechazar transferencia
// 🔧 FIX: migrado de nodemailer a Brevo (igual que el resto del sistema)
// ════════════════════════════════════════════════════════════════════════════
router.post('/admin/transferencia-rechazar', authAdmin, async (req, res) => {
  try {
    const { referencia, notas } = req.body;
    if (!referencia) return res.status(400).json({ error: 'Referencia requerida' });

    const { data: compra, error: errCompra } = await supabase
      .from('compras')
      .select('correo, nombre, cantidad')
      .eq('referencia', referencia)
      .eq('estado', 'transferencia_pendiente')
      .single();

    if (errCompra || !compra) {
      return res.status(404).json({ error: 'Transferencia no encontrada o ya procesada' });
    }

    const { error } = await supabase
      .from('compras')
      .update({ estado: 'transferencia_rechazada', notas_admin: notas || null })
      .eq('referencia', referencia);

    if (error) return res.status(500).json({ error: 'Error actualizando estado' });

    const motivo = notas || 'No pudimos verificar tu transferencia.';
    const precioPorCodigo = 3750;
    const monto = compra.cantidad * precioPorCodigo;

    try {
      await enviarCorreoRechazo(compra.correo, compra.nombre, referencia, motivo, monto);
    } catch (err) {
      console.error('❌ Error enviando correo de rechazo:', err.message);
    }

    console.log(`🚫 Transferencia rechazada: ${referencia} | Motivo: ${motivo}`);
    res.json({ ok: true });

  } catch (e) {
    console.error('💥 Error rechazando transferencia:', e);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── Correo de rechazo via Brevo (igual que el resto del sistema) ─────────────
// 🔧 FIX: reemplaza nodemailer que requería variables SMTP_* no configuradas
async function enviarCorreoRechazo(correo, nombre, referencia, motivo, monto) {
  if (!process.env.BREVO_API_KEY) {
    console.error("❌ BREVO_API_KEY no configurada para correo de rechazo");
    return;
  }

  const html = `
  <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;background:#0f172a;color:#f1f5f9;border-radius:12px;overflow:hidden">
    <div style="background:#dc2626;padding:20px 24px;text-align:center">
      <h2 style="color:white;margin:0;font-size:20px">❌ Transferencia no aprobada</h2>
    </div>
    <div style="padding:24px">
      <p>Hola <strong>${nombre || 'cliente'}</strong>,</p>
      <p>Lamentablemente no pudimos verificar tu transferencia con referencia <strong>${referencia}</strong>.</p>
      <div style="background:#1e293b;border-left:4px solid #ef4444;padding:12px 16px;border-radius:6px;margin:16px 0">
        <p style="margin:0;font-size:14px;color:#fca5a5"><strong>Motivo:</strong> ${motivo}</p>
      </div>
      <p>Si crees que es un error, por favor contáctanos directamente con tu comprobante de pago y la referencia.</p>
      <p style="color:#94a3b8;font-size:13px">Ref: <code style="background:#1e293b;padding:2px 6px;border-radius:4px">${referencia}</code></p>
    </div>
    <div style="background:#1e293b;padding:14px 24px;text-align:center">
      <p style="color:#64748b;font-size:12px;margin:0">EiderTech Soluciones — soporte disponible por WhatsApp</p>
    </div>
  </div>`;

  const payload = JSON.stringify({
    sender:      { name: "EiderTech Soluciones", email: process.env.BREVO_FROM_EMAIL || "eidercobo383@gmail.com" },
    to:          [{ email: correo }],
    subject:     `❌ Tu transferencia no pudo ser verificada — Ref. ${referencia}`,
    htmlContent: html
  });

  await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.brevo.com',
      path:     '/v3/smtp/email',
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'api-key':        process.env.BREVO_API_KEY,
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          reject(new Error(`Brevo error ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });

  console.log(`📧 Correo de rechazo enviado a ${correo}`);
}

module.exports = router;