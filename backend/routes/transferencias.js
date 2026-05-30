// routes/transferencias.js
// ─────────────────────────────────────────────────────────────────────────────
// Maneja compras por transferencia bancaria.
//
//  POST /api/transferencia-registrar   (PÚBLICO)
//    - El cliente llena el formulario y envía sus datos + comprobante
//    - Queda en estado "transferencia_pendiente"
//
//  GET  /api/admin/transferencias       (ADMIN)
//    - Lista todas las transferencias pendientes/procesadas
//
//  POST /api/admin/transferencia-aprobar  (ADMIN)
//    - El admin aprueba, genera los códigos automáticamente y envía correo
//
//  POST /api/admin/transferencia-rechazar (ADMIN)
//    - El admin rechaza y puede dejar una nota
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();
const supabase = require('../config/supabase');
const { generarCodigos } = require('../services/codigos');
const { enviarCorreo }   = require('../services/correo');
const { enviarWhatsApp } = require('../services/whatsapp');

// ── Validación básica de correo ──────────────────────────────────────────────
function esCorreoValido(correo) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo);
}

// ── Auth middleware (reutilizable igual que en admin.js) ─────────────────────
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

    // ── Validaciones ────────────────────────────────────────────────────────
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

    // ── Verificar stock ──────────────────────────────────────────────────────
    const { count: disponibles } = await supabase
      .from('codigos')
      .select('*', { count: 'exact', head: true })
      .eq('vendido', false);

    if (!disponibles || disponibles === 0) {
      return res.status(400).json({ error: 'No hay códigos disponibles' });
    }

    const cantidadFinal = Math.min(Number(cantidad), disponibles);
    const precioPorCodigo = 3750;
    const montoTotal = cantidadFinal * precioPorCodigo;

    // ── Generar referencia única ─────────────────────────────────────────────
    const referencia = `TRF-${Date.now()}-${Math.floor(Math.random() * 9999)}`;

    // ── Guardar en tabla compras con estado especial ─────────────────────────
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

    // Adjuntar códigos a las aprobadas
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

    // ── Verificar que exista y esté pendiente ────────────────────────────────
    const { data: compra, error: errCompra } = await supabase
      .from('compras')
      .select('*')
      .eq('referencia', referencia)
      .eq('estado', 'transferencia_pendiente')
      .single();

    if (errCompra || !compra) {
      return res.status(404).json({ error: 'Transferencia no encontrada o ya procesada' });
    }

    // ── Generar códigos (misma lógica que webhook) ───────────────────────────
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

    // Mezclar aleatoriamente antes de entregar
    codigos = [...codigos].sort(() => Math.random() - 0.5);

    // ── Guardar transacción ──────────────────────────────────────────────────
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

    // ── Premio dorado si aplica ──────────────────────────────────────────────
    const codigoDorado = codigos.find(c => c.dorado);
    const updateData = {
      estado:     'transferencia_aprobada',
      notas_admin: notas || null
    };
    if (codigoDorado?.premioDorado) {
      updateData.premio_dorado = codigoDorado.premioDorado;
    }

    await supabase.from('compras').update(updateData).eq('referencia', referencia);

    // ── Actualizar códigos con datos del comprador ───────────────────────────
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

    // ── Enviar correo ────────────────────────────────────────────────────────
    try {
      await enviarCorreo(compra.correo, codigos, codigoDorado?.premioDorado || null);
    } catch (err) {
      console.error('❌ Error correo:', err.message);
    }

    // ── Enviar WhatsApp si hay teléfono ──────────────────────────────────────
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
// ADMIN — Rechazar transferencia + correo al cliente
// ════════════════════════════════════════════════════════════════════════════
router.post('/admin/transferencia-rechazar', authAdmin, async (req, res) => {
  try {
    const { referencia, notas } = req.body;
    if (!referencia) return res.status(400).json({ error: 'Referencia requerida' });

    // Obtener datos del comprador antes de actualizar
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

    // Enviar correo de rechazo al cliente
    const motivo = notas || 'No pudimos verificar tu transferencia.';
    const precioPorCodigo = 3750;
    const monto = compra.cantidad * precioPorCodigo;
    try {
      await enviarCorreoRechazo(compra.correo, compra.nombre, referencia, motivo, monto);
    } catch (err) {
      console.error('❌ Error enviando correo de rechazo:', err.message);
      // No falla el endpoint si el correo falla
    }

    console.log(`🚫 Transferencia rechazada: ${referencia} | Motivo: ${motivo}`);
    res.json({ ok: true });

  } catch (e) {
    console.error('💥 Error rechazando transferencia:', e);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});


// ── Correo de rechazo (independiente de enviarCorreo) ────────────────────────
async function enviarCorreoRechazo(correo, nombre, referencia, motivo, monto) {
  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });

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
      <p style="color:#64748b;font-size:12px;margin:0">© Rifa Colombia — soporte disponible por WhatsApp</p>
    </div>
  </div>`;

  await transporter.sendMail({
    from:    `"Rifa Colombia" <${process.env.SMTP_USER}>`,
    to:      correo,
    subject: `❌ Tu transferencia no pudo ser verificada — Ref. ${referencia}`,
    html
  });
  console.log(`📧 Correo de rechazo enviado a ${correo}`);
}

module.exports = router;