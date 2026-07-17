// services/notificaciones.js
// ─────────────────────────────────────────────────────────────────────────────
// Centraliza 3 funciones de notificación:
//   1. enviarNotifAdmin()   → correo al admin cuando llega nueva compra
//   2. recordatorioTransf() → correo al cliente con transferencia pendiente +12h
//   3. correoMasivo()       → correo a todos los compradores con códigos asignados
// ─────────────────────────────────────────────────────────────────────────────

const https = require('https');

// ── Helper: enviar un correo via Brevo ───────────────────────────────────────
async function brevoEnviar({ para, asunto, html, nombrePara }) {
  if (!process.env.BREVO_API_KEY) throw new Error('BREVO_API_KEY no configurada');

  const payload = JSON.stringify({
    sender:      { name: 'EiderTech Soluciones', email: process.env.BREVO_FROM_EMAIL || 'eidercobo383@gmail.com' },
    to:          [{ email: para, name: nombrePara || para }],
    subject:     asunto,
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
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
        else reject(new Error(`Brevo ${res.statusCode}: ${data}`));
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ════════════════════════════════════════════════════════════════════════════
// 1. NOTIFICACIÓN AL ADMIN — nueva compra (Wompi o transferencia)
//    Llamar desde webhook.js y transferencias.js después de guardar la compra
// ════════════════════════════════════════════════════════════════════════════
async function enviarNotifAdmin({ tipo, nombre, correo, cedula, telefono, cantidad, referencia, monto }) {
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) {
    console.warn('⚠️ ADMIN_EMAIL no configurado — notif admin omitida');
    return;
  }

  const tipoLabel = tipo === 'transferencia' ? '🏦 Transferencia bancaria' : '💳 Pago Wompi';
  const tipoColor = tipo === 'transferencia' ? '#f59e0b' : '#22c55e';
  const badge     = tipo === 'transferencia'
    ? '<span style="background:#f59e0b;color:#000;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:bold;">PENDIENTE VERIFICACIÓN</span>'
    : '<span style="background:#22c55e;color:#fff;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:bold;">PAGO APROBADO</span>';

  const montoFmt = monto ? `$${Number(monto).toLocaleString('es-CO')} COP` : '—';
  const fechaFmt = new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' });

  const html = `
  <div style="font-family:Arial,sans-serif;background:#0f172a;padding:20px;border-radius:12px;max-width:520px;margin:0 auto;color:#f1f5f9;">
    <div style="background:${tipoColor};padding:16px 20px;border-radius:10px 10px 0 0;text-align:center;">
      <h2 style="margin:0;color:#fff;font-size:20px;">🛒 Nueva compra recibida</h2>
    </div>
    <div style="background:#1e293b;padding:20px;border-radius:0 0 10px 10px;">
      <div style="text-align:center;margin-bottom:16px;">${badge}</div>
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <tr style="border-bottom:1px solid #334155;">
          <td style="padding:9px 4px;color:#94a3b8;">Tipo</td>
          <td style="padding:9px 4px;font-weight:bold;">${tipoLabel}</td>
        </tr>
        <tr style="border-bottom:1px solid #334155;">
          <td style="padding:9px 4px;color:#94a3b8;">Cliente</td>
          <td style="padding:9px 4px;">${nombre || '—'}</td>
        </tr>
        <tr style="border-bottom:1px solid #334155;">
          <td style="padding:9px 4px;color:#94a3b8;">Correo</td>
          <td style="padding:9px 4px;">${correo || '—'}</td>
        </tr>
        <tr style="border-bottom:1px solid #334155;">
          <td style="padding:9px 4px;color:#94a3b8;">Cédula</td>
          <td style="padding:9px 4px;">${cedula || '—'}</td>
        </tr>
        <tr style="border-bottom:1px solid #334155;">
          <td style="padding:9px 4px;color:#94a3b8;">Teléfono</td>
          <td style="padding:9px 4px;">${telefono || '—'}</td>
        </tr>
        <tr style="border-bottom:1px solid #334155;">
          <td style="padding:9px 4px;color:#94a3b8;">Cantidad</td>
          <td style="padding:9px 4px;font-weight:bold;">${cantidad} códigos</td>
        </tr>
        <tr style="border-bottom:1px solid #334155;">
          <td style="padding:9px 4px;color:#94a3b8;">Monto</td>
          <td style="padding:9px 4px;font-weight:bold;color:#4ade80;">${montoFmt}</td>
        </tr>
        <tr style="border-bottom:1px solid #334155;">
          <td style="padding:9px 4px;color:#94a3b8;">Referencia</td>
          <td style="padding:9px 4px;font-family:monospace;font-size:12px;">${referencia}</td>
        </tr>
        <tr>
          <td style="padding:9px 4px;color:#94a3b8;">Fecha</td>
          <td style="padding:9px 4px;">${fechaFmt}</td>
        </tr>
      </table>
      ${tipo === 'transferencia' ? `
      <div style="margin-top:16px;padding:12px;background:#292524;border-left:4px solid #f59e0b;border-radius:6px;font-size:13px;color:#fde68a;">
        ⚠️ Esta transferencia requiere verificación manual en el panel de administración.
      </div>` : ''}
    </div>
  </div>`;

  await brevoEnviar({ para: adminEmail, asunto: `🛒 Nueva compra — ${nombre} (${cantidad} códigos)`, html });
  console.log(`📧 Notif admin enviada a ${adminEmail} — compra ${referencia}`);
}

// ════════════════════════════════════════════════════════════════════════════
// 2. RECORDATORIO A TRANSFERENCIAS PENDIENTES +12H
//    Se activa desde el botón en el panel admin
// ════════════════════════════════════════════════════════════════════════════
async function recordatorioTransferencias(supabase) {
  const hace12h = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();

  const { data: todasPendientes, error } = await supabase
    .from('compras')
    .select('referencia, nombre, correo, cantidad, fecha')
    .eq('estado', 'transferencia_pendiente');

  if (error) throw new Error(`Error consultando pendientes: ${error.message}`);

  // Filtrar por +12h usando columna 'fecha'
  const pendientes = (todasPendientes || []).filter(c => {
    return c.fecha && new Date(c.fecha) < new Date(hace12h);
  });

  if (pendientes.length === 0) return { enviados: 0, detalle: [] };

  const precioPorCodigo = 3750;
  const resultados = [];

  for (const compra of pendientes) {
    const monto    = compra.cantidad * precioPorCodigo;
    const montoFmt = `$${monto.toLocaleString('es-CO')} COP`;
    const adminWA  = process.env.WHATSAPP_SOPORTE || '573053228703';
    const msgWA    = encodeURIComponent(`Hola, quiero completar mi pago. Referencia: ${compra.referencia}`);

    const html = `
    <div style="font-family:Arial,sans-serif;background:#0f172a;padding:20px;border-radius:12px;max-width:500px;margin:0 auto;color:#f1f5f9;">
      <div style="background:linear-gradient(135deg,#92400e,#d97706);padding:18px 20px;border-radius:10px 10px 0 0;text-align:center;">
        <div style="font-size:36px;">⏰</div>
        <h2 style="margin:6px 0 0;color:#fff;font-size:20px;">¿Olvidaste completar tu compra?</h2>
      </div>
      <div style="background:#1e293b;padding:22px;border-radius:0 0 10px 10px;">
        <p style="margin:0 0 14px;">Hola <strong>${compra.nombre || 'cliente'}</strong>,</p>
        <p style="color:#cbd5e1;font-size:14px;line-height:1.7;">
          Registramos tu intención de compra de <strong>${compra.cantidad} códigos</strong> 
          por un valor de <strong style="color:#4ade80;">${montoFmt}</strong>, 
          pero aún no hemos recibido tu transferencia.
        </p>

        <div style="background:#0f172a;border-radius:10px;padding:14px 16px;margin:16px 0;border:1px solid #334155;">
          <p style="margin:0 0 8px;font-size:13px;color:#94a3b8;">Tu referencia de pago:</p>
          <p style="margin:0;font-family:monospace;font-size:16px;font-weight:bold;color:#f59e0b;letter-spacing:1px;">${compra.referencia}</p>
        </div>

        <p style="color:#cbd5e1;font-size:13px;line-height:1.7;">
          Recuerda incluir esta referencia en la descripción de tu transferencia para que podamos identificar tu pago rápidamente.
        </p>

        <div style="text-align:center;margin:20px 0 8px;">
          <a href="https://wa.me/${adminWA}?text=${msgWA}"
             style="display:inline-block;background:#25D366;color:white;text-decoration:none;padding:13px 28px;border-radius:10px;font-weight:bold;font-size:14px;">
            💬 Confirmar pago por WhatsApp
          </a>
        </div>
        <p style="text-align:center;color:#64748b;font-size:12px;margin:8px 0 0;">
          Si ya realizaste el pago, ignora este mensaje. Lo verificaremos pronto.
        </p>
      </div>
    </div>`;

    try {
      await brevoEnviar({
        para:       compra.correo,
        nombrePara: compra.nombre,
        asunto:     `⏰ ¿Olvidaste tu transferencia? — Ref. ${compra.referencia}`,
        html
      });
      resultados.push({ referencia: compra.referencia, correo: compra.correo, ok: true });
      console.log(`📧 Recordatorio enviado → ${compra.correo} (${compra.referencia})`);
    } catch (err) {
      resultados.push({ referencia: compra.referencia, correo: compra.correo, ok: false, error: err.message });
      console.error(`❌ Error recordatorio → ${compra.correo}:`, err.message);
    }

    // Pausa de 300ms entre envíos para respetar rate limit de Brevo
    await new Promise(r => setTimeout(r, 300));
  }

  const enviados = resultados.filter(r => r.ok).length;
  console.log(`✅ Recordatorios: ${enviados}/${pendientes.length} enviados`);
  return { enviados, total: pendientes.length, detalle: resultados };
}

// ════════════════════════════════════════════════════════════════════════════
// 3. CORREO MASIVO — solo a compradores con códigos asignados
//    asunto, mensaje: texto libre desde el panel admin
// ════════════════════════════════════════════════════════════════════════════
async function correoMasivo(supabase, { asunto, mensaje, tituloDestacado }) {
  if (!asunto || !mensaje) throw new Error('Asunto y mensaje son requeridos');

  // Traer todos los correos únicos con códigos vendidos
  const { data: compradores, error } = await supabase
    .from('codigos')
    .select('email, nombre, referencia')
    .eq('vendido', true)
    .not('email', 'is', null);

  if (error) throw new Error(`Error consultando compradores: ${error.message}`);
  if (!compradores || compradores.length === 0) return { enviados: 0, total: 0 };

  // Deduplicar por email y contar sus códigos
  const mapaCompradores = {};
  for (const c of compradores) {
    if (!c.email) continue;
    if (!mapaCompradores[c.email]) {
      mapaCompradores[c.email] = { email: c.email, nombre: c.nombre, cantidad: 0 };
    }
    mapaCompradores[c.email].cantidad++;
  }

  const lista = Object.values(mapaCompradores);
  console.log(`📢 Correo masivo → ${lista.length} compradores únicos`);

  const resultados = [];

  for (const comprador of lista) {
    const html = `
    <div style="font-family:Arial,sans-serif;background:#0f172a;padding:20px;border-radius:12px;max-width:500px;margin:0 auto;color:#f1f5f9;">

      ${tituloDestacado ? `
      <div style="background:linear-gradient(135deg,#1e3a5f,#2563eb);padding:20px;border-radius:10px 10px 0 0;text-align:center;">
        <div style="font-size:40px;">🎉</div>
        <h1 style="margin:8px 0 0;color:gold;font-size:22px;">${tituloDestacado}</h1>
      </div>` : `
      <div style="background:linear-gradient(135deg,#1e3a5f,#2563eb);padding:18px 20px;border-radius:10px 10px 0 0;text-align:center;">
        <h2 style="margin:0;color:#fff;font-size:20px;">📢 Mensaje del evento</h2>
      </div>`}

      <div style="background:#1e293b;padding:22px;border-radius:${tituloDestacado ? '0 0 10px 10px' : '0 0 10px 10px'};">
        <p style="margin:0 0 16px;">Hola <strong>${comprador.nombre || 'participante'}</strong>,</p>

        <div style="background:#0f172a;border-radius:10px;padding:16px 18px;margin-bottom:18px;font-size:15px;line-height:1.8;color:#e2e8f0;white-space:pre-line;">${mensaje}</div>

        <div style="background:#172554;border-radius:8px;padding:12px 14px;margin-bottom:18px;text-align:center;">
          <p style="margin:0;font-size:13px;color:#93c5fd;">Tus códigos activos</p>
          <p style="margin:4px 0 0;font-size:24px;font-weight:bold;color:#fff;">${comprador.cantidad} 🎟️</p>
        </div>

        <p style="text-align:center;color:#64748b;font-size:12px;margin:0;line-height:1.7;">
          Guarda este correo.<br>
          📧 infoeidertechsoluciones@gmail.com &nbsp;|&nbsp; EiderTech Soluciones
        </p>
      </div>
    </div>`;

    try {
      await brevoEnviar({
        para:       comprador.email,
        nombrePara: comprador.nombre,
        asunto,
        html
      });
      resultados.push({ email: comprador.email, ok: true });
    } catch (err) {
      resultados.push({ email: comprador.email, ok: false, error: err.message });
      console.error(`❌ Masivo fallo → ${comprador.email}:`, err.message);
    }

    // Pausa 300ms para respetar rate limit de Brevo
    await new Promise(r => setTimeout(r, 300));
  }

  const enviados = resultados.filter(r => r.ok).length;
  console.log(`✅ Masivo: ${enviados}/${lista.length} enviados`);
  return { enviados, total: lista.length, detalle: resultados };
}

module.exports = { enviarNotifAdmin, recordatorioTransferencias, correoMasivo, recordatorioPagosIncompletos };

// ════════════════════════════════════════════════════════════════════════════
// 4. RECORDATORIO A PAGOS INCOMPLETOS +12H
//    Cubre dos casos:
//      a) compras con estado 'pendiente'       → iniciaron Wompi pero no pagaron
//      b) compras con estado 'transferencia_pendiente' → ya cubierto en función 2,
//         pero aquí se unifican ambos en un solo correo de "completa tu pago"
//    Se activa desde el botón en el panel admin
// ════════════════════════════════════════════════════════════════════════════
async function recordatorioPagosIncompletos(supabase) {
  const hace12h = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();

  // Intentar con 'fecha', si falla con 'created_at'
  let pendientes, error;

  ({ data: pendientes, error } = await supabase
    .from('compras')
    .select('referencia, nombre, correo, cantidad, fecha, estado')
    .in('estado', ['pendiente', 'transferencia_pendiente'])
    .not('correo', 'is', null));

  if (error) throw new Error(`Error consultando pendientes: ${error.message}`);
  if (!pendientes || pendientes.length === 0) return { enviados: 0, total: 0, detalle: [] };

  // Filtrar manualmente por +12h usando columna 'fecha'
  pendientes = pendientes.filter(c => {
    return c.fecha && new Date(c.fecha) < new Date(hace12h);
  });

  // Deduplicar por correo — si alguien tiene varios intentos, un solo correo
  const mapaCorreos = {};
  for (const c of pendientes) {
    if (!c.correo) continue;
    if (!mapaCorreos[c.correo]) {
      mapaCorreos[c.correo] = c;
    }
  }
  const lista = Object.values(mapaCorreos);

  const precioPorCodigo = 3750;
  const adminWA = process.env.WHATSAPP_SOPORTE || '573053228703';
  const resultados = [];

  for (const compra of lista) {
    const esTransferencia = compra.estado === 'transferencia_pendiente';
    const monto    = compra.cantidad * precioPorCodigo;
    const montoFmt = `$${monto.toLocaleString('es-CO')} COP`;

    const msgWA = encodeURIComponent(
      esTransferencia
        ? `Hola, quiero confirmar mi transferencia. Ref: ${compra.referencia}`
        : `Hola, tuve un problema al pagar con Wompi. Ref: ${compra.referencia}`
    );

    const instruccion = esTransferencia
      ? `<p style="color:#cbd5e1;font-size:14px;line-height:1.7;margin:0 0 14px;">
           Registramos tu intención de pago por transferencia bancaria de
           <strong style="color:#4ade80;">${montoFmt}</strong> por <strong>${compra.cantidad} códigos</strong>.
           <br>Aún no hemos recibido tu transferencia.
         </p>
         <div style="background:#0f172a;border-radius:10px;padding:14px 16px;margin:16px 0;border:1px solid #334155;">
           <p style="margin:0 0 6px;font-size:12px;color:#94a3b8;">Incluye esta referencia en tu transferencia:</p>
           <p style="margin:0;font-family:monospace;font-size:16px;font-weight:bold;color:#f59e0b;letter-spacing:1px;">${compra.referencia}</p>
         </div>`
      : `<p style="color:#cbd5e1;font-size:14px;line-height:1.7;margin:0 0 14px;">
           Iniciaste una compra de <strong>${compra.cantidad} códigos</strong> por
           <strong style="color:#4ade80;">${montoFmt}</strong> pero el pago no se completó.
           <br>Puedes intentarlo nuevamente o contactarnos si necesitas ayuda.
         </p>
         <div style="text-align:center;margin:16px 0;">
           <a href="${process.env.FRONTEND_URL || 'https://eidertechsoluciones.online/'}"
              style="display:inline-block;background:#2563eb;color:white;text-decoration:none;padding:13px 28px;border-radius:10px;font-weight:bold;font-size:14px;">
             🎟️ Volver a comprar
           </a>
         </div>`;

    const html = `
    <div style="font-family:Arial,sans-serif;background:#0f172a;padding:20px;border-radius:12px;max-width:500px;margin:0 auto;color:#f1f5f9;">
      <div style="background:linear-gradient(135deg,#1e3a5f,#2563eb);padding:18px 20px;border-radius:10px 10px 0 0;text-align:center;">
        <div style="font-size:36px;">💳</div>
        <h2 style="margin:6px 0 0;color:#fff;font-size:20px;">¡Tu compra está incompleta!</h2>
        <p style="margin:6px 0 0;color:#93c5fd;font-size:13px;">
          ${esTransferencia ? '🏦 Transferencia bancaria pendiente' : '⚡ Pago Wompi no completado'}
        </p>
      </div>
      <div style="background:#1e293b;padding:22px;border-radius:0 0 10px 10px;">
        <p style="margin:0 0 14px;">Hola <strong>${compra.nombre || 'cliente'}</strong>,</p>
        ${instruccion}
        <div style="text-align:center;margin:20px 0 8px;">
          <a href="https://wa.me/${adminWA}?text=${msgWA}"
             style="display:inline-block;background:#25D366;color:white;text-decoration:none;padding:13px 28px;border-radius:10px;font-weight:bold;font-size:14px;">
            💬 Necesito ayuda por WhatsApp
          </a>
        </div>
        <p style="text-align:center;color:#64748b;font-size:12px;margin:12px 0 0;">
          Si ya completaste tu pago, ignora este mensaje. Lo procesaremos pronto.
        </p>
      </div>
    </div>`;

    try {
      await brevoEnviar({
        para:       compra.correo,
        nombrePara: compra.nombre,
        asunto:     `💳 Completa tu compra — ${compra.cantidad} códigos te esperan`,
        html
      });
      resultados.push({ referencia: compra.referencia, correo: compra.correo, tipo: compra.estado, ok: true });
      console.log(`📧 Recordatorio incompleto → ${compra.correo} (${compra.estado})`);
    } catch (err) {
      resultados.push({ referencia: compra.referencia, correo: compra.correo, ok: false, error: err.message });
      console.error(`❌ Error recordatorio incompleto → ${compra.correo}:`, err.message);
    }

    await new Promise(r => setTimeout(r, 300));
  }

  const enviados = resultados.filter(r => r.ok).length;
  console.log(`✅ Recordatorios incompletos: ${enviados}/${lista.length} enviados`);
  return { enviados, total: lista.length, detalle: resultados };
}