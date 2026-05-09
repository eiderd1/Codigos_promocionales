const https = require('https');

async function enviarCorreo(destino, codigos) {
  try {
    if (!process.env.BREVO_API_KEY || !destino || !codigos?.length) return;

    const dorados = codigos.filter(c => c.dorado);
    const normales = codigos.filter(c => !c.dorado);

    // ── Listas de códigos en HTML ─────────────────────────────
    const listaNormales = normales.map(c => `
      <div style="background:#1f2937;color:white;padding:12px;margin:6px 0;border-radius:8px;font-size:18px;letter-spacing:2px;text-align:center;">
        🎟️ ${c.codigo}
      </div>
    `).join("");

    const listaDorados = dorados.map(c => `
      <div style="background:linear-gradient(45deg,gold,orange);color:black;padding:15px;margin:10px 0;border-radius:10px;font-size:22px;font-weight:bold;letter-spacing:3px;text-align:center;">
        ✨ ${c.codigo} ✨
      </div>
    `).join("");

    // ── Texto plano de los códigos para el mensaje de WhatsApp ─
    const textoCodigosWA = codigos
      .map(c => c.dorado ? `✨ ${c.codigo} ✨ (DORADO)` : `🎟️ ${c.codigo}`)
      .join('%0A');  // %0A = salto de línea en URL

    const mensajeCompartir = encodeURIComponent(
      `🎟️ *Mis códigos del sorteo EiderTech Soluciones*\n\n` +
      codigos.map(c => c.dorado ? `✨ ${c.codigo} ✨ (DORADO)` : `🎟️ ${c.codigo}`).join('\n') +
      `\n\n💰 Premio: $15.000.000 COP\n🍀 ¡Suerte a todos!`
    );

    // Número de soporte (sin + ni espacios)
    const NUM_SOPORTE = process.env.WHATSAPP_SOPORTE || '573053228703';
    const mensajeSoporte = encodeURIComponent('Hola, compré códigos y tengo una pregunta 🎟️');

    const waCompartir = `https://wa.me/?text=${mensajeCompartir}`;
    const waSoporte   = `https://wa.me/${NUM_SOPORTE}?text=${mensajeSoporte}`;

    // ── HTML del correo ───────────────────────────────────────
    const htmlContent = `
      <div style="background:#0f172a;padding:24px 16px;font-family:Arial,sans-serif;color:white;">
        <div style="max-width:480px;margin:auto;background:#111827;border-radius:16px;padding:28px 24px;">

          <!-- Encabezado -->
          <div style="text-align:center;margin-bottom:20px;">
            <div style="font-size:48px;">🎉</div>
            <h1 style="color:gold;margin:8px 0 4px;font-size:24px;">¡Compra Exitosa!</h1>
            <p style="color:#9ca3af;margin:0;font-size:14px;">Tus códigos han sido asignados automáticamente por el sistema</p>
          </div>

          <!-- Sellos de confianza -->
          <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-bottom:20px;">
            <span style="background:#1f2937;color:#4ade80;font-size:12px;padding:4px 10px;border-radius:20px;border:1px solid #22c55e;">✅ Pago verificado por Wompi</span>
            <span style="background:#1f2937;color:#60a5fa;font-size:12px;padding:4px 10px;border-radius:20px;border:1px solid #3b82f6;">🔒 Transacción segura</span>
            <span style="background:#1f2937;color:#facc15;font-size:12px;padding:4px 10px;border-radius:20px;border:1px solid #eab308;">🎰 Asignación aleatoria</span>
          </div>

          <!-- Códigos normales -->
          ${listaNormales ? `
          <div style="margin-bottom:20px;">
            <h3 style="color:#9ca3af;text-align:center;font-size:14px;margin:0 0 10px;text-transform:uppercase;letter-spacing:1px;">Tus códigos</h3>
            ${listaNormales}
          </div>` : ''}

          <!-- Código dorado -->
          ${listaDorados ? `
          <div style="margin-bottom:24px;padding:18px;background:#020617;border-radius:12px;border:2px solid gold;text-align:center;">
            <h2 style="color:gold;margin:0 0 10px;font-size:18px;">💎 ¡CÓDIGO DORADO!</h2>
            ${listaDorados}
            <p style="color:gold;margin:10px 0 0;font-size:13px;">🎉 ¡Tienes un código especial! Podría darte un premio adicional.</p>
          </div>` : ''}

          <!-- Divisor -->
          <hr style="border:none;border-top:1px solid #1f2937;margin:20px 0;">

          <!-- BOTÓN A: Compartir por WhatsApp -->
          <div style="text-align:center;margin-bottom:14px;">
            <p style="color:#9ca3af;font-size:13px;margin:0 0 10px;">¿Quieres compartir tus códigos con alguien?</p>
            <a href="${waCompartir}"
               style="display:inline-block;background:#25D366;color:white;text-decoration:none;padding:13px 28px;border-radius:10px;font-weight:bold;font-size:15px;letter-spacing:.3px;">
              📤 Compartir mis códigos por WhatsApp
            </a>
          </div>

          <!-- BOTÓN B: Soporte por WhatsApp -->
          <div style="text-align:center;margin-bottom:24px;">
            <p style="color:#9ca3af;font-size:13px;margin:0 0 10px;">¿Tienes alguna pregunta o necesitas ayuda?</p>
            <a href="${waSoporte}"
               style="display:inline-block;background:#1f2937;color:#25D366;text-decoration:none;padding:13px 28px;border-radius:10px;font-weight:bold;font-size:15px;border:2px solid #25D366;">
              💬 Contactar soporte por WhatsApp
            </a>
          </div>

          <!-- Info sorteo -->
          <div style="background:#0f172a;border-radius:10px;padding:16px;margin-bottom:20px;text-align:center;">
            <p style="color:#facc15;font-weight:bold;margin:0 0 6px;font-size:14px;">🏆 ¿Cómo se determina el ganador?</p>
            <p style="color:#9ca3af;font-size:13px;margin:0;line-height:1.6;">
              Se toman los <strong style="color:white;">3 últimos dígitos del premio mayor</strong> + el
              <strong style="color:white;">primer número de la serie</strong> de la
              <strong style="color:white;">Lotería de Medellín</strong> del día del cierre.
            </p>
          </div>

          <!-- Footer -->
          <p style="text-align:center;color:#6b7280;font-size:11px;margin:0;line-height:1.6;">
            Guarda este correo como comprobante de tu compra.<br>
            📧 eidercobo383@gmail.com &nbsp;|&nbsp; EiderTech Soluciones
          </p>

        </div>
      </div>
    `;

    const payload = JSON.stringify({
      sender: {
        name:  "EiderTech Soluciones",
        email: process.env.BREVO_FROM_EMAIL || "eidercobo383@gmail.com"
      },
      to:      [{ email: destino }],
      subject: "🎟️ ¡Compra confirmada! Tus códigos están listos",
      htmlContent
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

    console.log("📧 Email enviado a:", destino);

  } catch (error) {
    console.error("❌ Error email:", error.message);
  }
}

module.exports = { enviarCorreo };