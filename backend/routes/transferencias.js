// routes/transferencias.js
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();
const https   = require('https');
const supabase = require('../config/supabase');
const { liberarReservasTransferenciaExpiradas } = require('../services/codigos');
const { enviarCorreo }   = require('../services/correo');
const { enviarWhatsApp } = require('../services/whatsapp');
const { enviarNotifAdmin } = require('../services/notificaciones');
const { CONFIG } = require('../services/appState');
const { leerClaveLive } = require('../services/configStore');

// ── Validación básica de correo ──────────────────────────────────────────────
function esCorreoValido(correo) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo);
}

const SOPORTE_MAX_BYTES = 5 * 1024 * 1024;
const SOPORTE_TIPOS = new Set(['image/jpeg', 'image/png', 'application/pdf']);

function limpiarNombreArchivo(nombre = 'comprobante') {
  return String(nombre).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'comprobante';
}

function detectarFirmaArchivo(buffer) {
  if (!buffer || buffer.length < 4) return null;
  if (buffer.subarray(0, 4).equals(Buffer.from([0x25,0x50,0x44,0x46]))) return 'application/pdf';
  if (buffer.subarray(0, 3).equals(Buffer.from([0xFF,0xD8,0xFF]))) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]))) return 'image/png';
  return null;
}

async function guardarSoporte(referencia, soporte) {
  if (!soporte?.base64) throw new Error('Debes adjuntar el comprobante de pago para registrar la transferencia.');
  const contentType = String(soporte.contentType || '').toLowerCase();
  if (!SOPORTE_TIPOS.has(contentType)) throw new Error('El soporte debe ser PDF, JPG o PNG.');
  const base64 = String(soporte.base64).replace(/^data:[^;]+;base64,/, '');
  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length || buffer.length > SOPORTE_MAX_BYTES) throw new Error('El soporte no puede superar 5 MB.');
  const firma = detectarFirmaArchivo(buffer);
  if (firma !== contentType) throw new Error('El tipo real del archivo no coincide con el archivo declarado.');
  const original = limpiarNombreArchivo(soporte.filename);
  const ext = contentType === 'application/pdf' ? 'pdf' : (contentType === 'image/png' ? 'png' : 'jpg');
  const path = `transferencias/${referencia}-${Date.now()}.${ext}`;
  const { error } = await supabase.storage.from('comprobantes').upload(path, buffer, { contentType, upsert: false });
  if (error) {
    console.error('❌ Error subiendo comprobante:', error.message);
    throw new Error('No se pudo guardar el soporte de pago. Verifica el bucket "comprobantes" en Supabase.');
  }
  return { path, nombre: original, contentType, bytes: buffer.length };
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
    const { nombre, correo, cedula, telefono, direccion, cantidad, soporte } = req.body;

    await liberarReservasTransferenciaExpiradas();

    const ventasActivas = await leerClaveLive('ventas_activas', CONFIG.ventas_activas);
    if (!ventasActivas) {
      return res.status(400).json({ error: 'Las ventas están pausadas en este momento' });
    }

    if (!nombre || !correo || !cantidad) {
      return res.status(400).json({ error: 'Nombre, correo y cantidad son obligatorios' });
    }
    if (!esCorreoValido(correo)) {
      return res.status(400).json({ error: 'Correo electrónico inválido' });
    }
    const CANTIDAD_MIN = 4;
    const CANTIDAD_MAX = 500;
    const cantidadNum  = Number(cantidad);
    if (
      !Number.isInteger(cantidadNum) ||
      cantidadNum < CANTIDAD_MIN ||
      cantidadNum > CANTIDAD_MAX
    ) {
      return res.status(400).json({
        error: `La cantidad debe ser un número entero entre ${CANTIDAD_MIN} y ${CANTIDAD_MAX}`
      });
    }

    if (!soporte?.base64) {
      return res.status(400).json({ error: 'Debes adjuntar el comprobante de pago para registrar la transferencia.' });
    }

    const { count: disponibles } = await supabase
      .from('codigos')
      .select('*', { count: 'exact', head: true })
      .eq('vendido', false)
      .eq('reservado', false);

    if (!disponibles || disponibles < cantidadNum) {
      return res.status(409).json({ error: `No hay suficientes códigos libres para reservar ${cantidadNum}. Quedan ${disponibles || 0} códigos disponibles; los códigos reservados por otras transferencias no se pueden reasignar.` });
    }

    const cantidadFinal = cantidadNum;
    const precioPorCodigo = await leerClaveLive('precio_codigo', CONFIG.precio_codigo || 3750);
    const montoTotal = cantidadFinal * precioPorCodigo;
    const referencia = `TRF-${Date.now()}-${Math.floor(Math.random() * 9999)}`;
    const reservaExpiraAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const { data: reservados, error: errorReserva } = await supabase.rpc('reservar_codigos_transferencia', {
      p_referencia: referencia,
      p_cantidad: cantidadFinal
    });
    const cantidadReservada = Number(reservados || 0);
    if (errorReserva || cantidadReservada !== cantidadFinal) {
      console.error('❌ No se pudo reservar el lote completo:', errorReserva?.message);
      return res.status(409).json({ error: 'Los códigos disponibles cambiaron mientras procesábamos tu solicitud. Intenta nuevamente.' });
    }

    let soporteGuardado = null;
    try {
      soporteGuardado = await guardarSoporte(referencia, soporte);
    } catch (err) {
      await supabase.from('codigos').update({ reservado: false, referencia: null }).eq('referencia', referencia).eq('reservado', true);
      return res.status(400).json({ error: err.message });
    }

    const { error: errorCompra } = await supabase
      .from('compras')
      .insert([{
        nombre,
        cedula: cedula || '',
        telefono: telefono || '',
        correo,
        direccion: direccion || '',
        cantidad: cantidadFinal,
        monto: montoTotal,
        referencia,
        estado: 'transferencia_pendiente',
        fecha: new Date(),
        reserva_expira_at: reservaExpiraAt,
        soporte_pago_path: soporteGuardado?.path || null,
        soporte_pago_nombre: soporteGuardado?.nombre || null,
        soporte_pago_tipo: soporteGuardado?.contentType || null,
        soporte_pago_subido_at: soporteGuardado ? new Date() : null
      }]);

    if (errorCompra) {
      console.error('❌ Error guardando transferencia:', errorCompra);
      await supabase.from('codigos').update({ reservado: false, referencia: null }).eq('referencia', referencia).eq('reservado', true);
      if (soporteGuardado?.path) await supabase.storage.from('comprobantes').remove([soporteGuardado.path]);
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
    await liberarReservasTransferenciaExpiradas();
    const { data: compras, error } = await supabase
      .from('compras')
      .select('referencia, nombre, correo, cedula, telefono, direccion, cantidad, monto, estado, fecha, reserva_expira_at, soporte_pago_path, soporte_pago_nombre, soporte_pago_tipo, soporte_pago_subido_at, premio_dorado, notas_admin')
      .in('estado', ['transferencia_pendiente', 'transferencia_aprobada', 'transferencia_rechazada', 'transferencia_expirada'])
      .order('fecha', { ascending: false })
      .limit(200);

    if (error) return res.status(500).json({ ok: false });

    const transferenciasConSoporte = await Promise.all(
  (compras || []).map(async c => {
    let soporte_url = null;
    let soporte_error = null;

    if (c.soporte_pago_path) {
      const { data: signed, error: signedError } =
        await supabase.storage
          .from('comprobantes')
          .createSignedUrl(c.soporte_pago_path, 60 * 60);

      if (signedError) {
        console.error(
          '❌ Error generando URL del comprobante:',
          c.referencia,
          signedError
        );

        soporte_error = signedError.message;
      } else {
        soporte_url = signed?.signedUrl || null;

        if (!soporte_url) {
          console.error(
            '⚠️ No se generó URL firmada para:',
            c.referencia,
            c.soporte_pago_path
          );

          soporte_error = 'Supabase no devolvió una URL firmada.';
        }
      }
    }

    return {
      ...c,
      soporte_url,
      soporte_error
    };
  })
);

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
      transferencias: transferenciasConSoporte.map(c => ({
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

    const { data: previa } = await supabase
      .from('compras')
      .select('*')
      .eq('referencia', referencia)
      .eq('estado', 'transferencia_pendiente')
      .maybeSingle();

    if (!previa) {
      return res.status(404).json({ error: 'Transferencia no encontrada, ya procesada o está siendo revisada por otro administrador.' });
    }

    if (!previa.soporte_pago_path) {
      return res.status(409).json({ error: 'No hay comprobante adjunto. Solicita al cliente el soporte de pago antes de aprobar.' });
    }

    // Cerrojamos la revisión: solo un administrador puede pasar esta referencia
    // de pendiente a procesando. Esto evita doble aprobación/doble envío.
    const { data: compra, error: errClaim } = await supabase
      .from('compras')
      .update({ estado: 'transferencia_procesando' })
      .eq('referencia', referencia)
      .eq('estado', 'transferencia_pendiente')
      .select('*')
      .maybeSingle();
    if (errClaim || !compra) {
      return res.status(409).json({ error: 'Esta transferencia ya está siendo revisada o fue procesada por otro administrador.' });
    }

    const { data: codigosReservados, error: errReserva } = await supabase
      .from('codigos')
      .select('codigo, dorado, premio_dorado')
      .eq('referencia', referencia)
      .eq('reservado', true)
      .eq('vendido', false);
    if (errReserva || !codigosReservados || codigosReservados.length !== compra.cantidad) {
      await supabase.from('compras').update({ estado: 'transferencia_pendiente' }).eq('referencia', referencia).eq('estado', 'transferencia_procesando');
      return res.status(409).json({ error: 'La reserva de códigos de esta transferencia ya no está completa. No se enviarán códigos.' });
    }

    const codigos = codigosReservados.map(c => ({
      codigo: c.codigo,
      dorado: !!c.dorado,
      premioDorado: c.premio_dorado || null
    })).sort(() => Math.random() - 0.5);

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
      await supabase.from('compras').update({ estado: 'transferencia_pendiente' }).eq('referencia', referencia).eq('estado', 'transferencia_procesando');
      return res.status(500).json({ error: 'Error interno. La transferencia sigue pendiente y no se enviaron códigos.' });
    }

    const codigoDorado = codigos.find(c => c.dorado);
    const updateData = {
      estado:      'transferencia_aprobada',
      notas_admin: notas || null
    };
    if (codigoDorado?.premioDorado) {
      updateData.premio_dorado = codigoDorado.premioDorado;
    }

    let actualizados = 0;
    for (const c of codigos) {
      const { data: actualizadosFila, error: errCodigo } = await supabase
        .from('codigos')
        .update({
          vendido: true,
          reservado: false,
          referencia,
          email: compra.correo,
          nombre: compra.nombre,
          telefono: compra.telefono || '',
          direccion: compra.direccion || ''
        })
        .eq('codigo', c.codigo)
        .eq('reservado', true)
        .eq('vendido', false)
        .select('codigo');
      if (errCodigo || !actualizadosFila?.length) break;
      actualizados += actualizadosFila.length;
    }

    if (actualizados !== compra.cantidad) {
      console.error(`❌ Aprobación incompleta: ${actualizados}/${compra.cantidad} códigos para ${referencia}`);
      await supabase.from('codigos').update({ vendido:false, reservado:true, referencia, email:null, nombre:null, telefono:null, direccion:null }).eq('referencia', referencia);
      await supabase.from('transacciones').delete().eq('referencia', referencia);
      await supabase.from('compras').update({ estado: 'transferencia_pendiente' }).eq('referencia', referencia).eq('estado', 'transferencia_procesando');
      return res.status(409).json({ error: 'No se pudo convertir toda la reserva en códigos vendidos. La transferencia sigue pendiente y no se enviaron códigos.' });
    }

    const { error: errorEstadoCompra } = await supabase.from('compras').update(updateData).eq('referencia', referencia).eq('estado', 'transferencia_procesando');
    if (errorEstadoCompra) {
      console.error('❌ Error actualizando estado de transferencia:', errorEstadoCompra);
      return res.status(500).json({ error: 'Los códigos fueron asignados, pero no se pudo cerrar el estado. Revisa esta referencia antes de volver a procesarla.' });
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

    await supabase.from('codigos')
      .update({ reservado: false, referencia: null, dorado: false, premio_dorado: null, nombre: null, email: null, telefono: null, direccion: null })
      .eq('referencia', referencia)
      .eq('reservado', true);

    const motivo = notas || 'No pudimos verificar tu transferencia.';
    const precioPorCodigo = await leerClaveLive('precio_codigo', CONFIG.precio_codigo || 3750);
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