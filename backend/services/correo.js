const https = require('https');

async function enviarCorreo(destino, codigos, premioDoradoOverride = null) {
  try {
    if (!process.env.BREVO_API_KEY || !destino || !codigos?.length) return;

    const dorados = codigos.filter(c => c.dorado);
    const normales = codigos.filter(c => !c.dorado);

    // Premio dorado: usar el que viene del código (ya tiene la promo aplicada)
    // Si no viene, usar 500000 como base
    const codigoDorado = dorados[0];
    const premioDorado = premioDoradoOverride || codigoDorado?.premioDorado || 500000;

    // ── Función para generar un tiquete SVG inline (como imagen en email) ──
    // Usamos una tabla HTML que simula la forma de tiquete con bordes dentados
    function tiqueteNormal(codigo) {
      return `
        <table cellpadding="0" cellspacing="0" border="0" style="margin:8px auto;width:260px;">
          <tr>
            <td style="
              background: linear-gradient(135deg, #1e3a5f 0%, #2563eb 100%);
              border-radius: 10px;
              padding: 0;
              position: relative;
            ">
              <table cellpadding="0" cellspacing="0" border="0" width="100%">
                <tr>
                  <!-- Lado izquierdo (cuerpo del tiquete) -->
                  <td style="
                    background: linear-gradient(135deg, #1e3a5f 0%, #1d4ed8 100%);
                    border-radius: 10px 0 0 10px;
                    padding: 14px 10px;
                    width: 72%;
                    vertical-align: middle;
                    border-right: 3px dashed rgba(255,255,255,0.35);
                  ">
                    <div style="color:#93c5fd;font-size:10px;letter-spacing:2px;text-transform:uppercase;margin-bottom:4px;font-family:Arial,sans-serif;">🎟️ Código</div>
                    <div style="color:#ffffff;font-size:22px;font-weight:bold;letter-spacing:4px;font-family:'Courier New',monospace;">${codigo}</div>
                    <div style="color:#60a5fa;font-size:10px;margin-top:4px;font-family:Arial,sans-serif;">Sorteo EiderTech</div>
                  </td>
                  <!-- Lado derecho (talón) -->
                  <td style="
                    background: linear-gradient(135deg, #1e40af 0%, #1d4ed8 100%);
                    border-radius: 0 10px 10px 0;
                    padding: 10px 8px;
                    width: 28%;
                    vertical-align: middle;
                    text-align: center;
                  ">
                    <div style="color:#bfdbfe;font-size:9px;writing-mode:vertical-rl;transform:rotate(180deg);letter-spacing:1px;font-family:Arial,sans-serif;line-height:1.4;">VÁLIDO • OFICIAL</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      `;
    }

    function tiqueteDorado(codigo) {
      return `
        <table cellpadding="0" cellspacing="0" border="0" style="margin:10px auto;width:270px;">
          <tr>
            <td style="
              background: linear-gradient(135deg, #92400e 0%, #d97706 100%);
              border-radius: 10px;
              box-shadow: 0 0 16px rgba(234,179,8,0.6);
            ">
              <table cellpadding="0" cellspacing="0" border="0" width="100%">
                <tr>
                  <!-- Lado izquierdo dorado -->
                  <td style="
                    background: linear-gradient(135deg, #78350f 0%, #b45309 100%);
                    border-radius: 10px 0 0 10px;
                    padding: 16px 10px;
                    width: 72%;
                    vertical-align: middle;
                    border-right: 3px dashed rgba(255,220,0,0.5);
                  ">
                    <div style="color:#fde68a;font-size:10px;letter-spacing:2px;text-transform:uppercase;margin-bottom:4px;font-family:Arial,sans-serif;">✨ Código Dorado</div>
                    <div style="color:#fef08a;font-size:22px;font-weight:bold;letter-spacing:4px;font-family:'Courier New',monospace;text-shadow:0 0 8px rgba(255,215,0,0.8);">${codigo}</div>
                    <div style="color:#fcd34d;font-size:10px;margin-top:4px;font-family:Arial,sans-serif;">💎 Premio Especial</div>
                  </td>
                  <!-- Talón dorado -->
                  <td style="
                    background: linear-gradient(135deg, #92400e 0%, #d97706 100%);
                    border-radius: 0 10px 10px 0;
                    padding: 10px 8px;
                    width: 28%;
                    vertical-align: middle;
                    text-align: center;
                  ">
                    <div style="color:#fef3c7;font-size:9px;writing-mode:vertical-rl;transform:rotate(180deg);letter-spacing:1px;font-family:Arial,sans-serif;line-height:1.4;">ORO • DORADO</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      `;
    }

    // ── Construir bloques de tiquetes ────────────────────────
    const tiquetesNormales = normales.map(c => tiqueteNormal(c.codigo)).join('');
    const tiquetesDorados  = dorados.map(c => tiqueteDorado(c.codigo)).join('');

    // ── Links WhatsApp ───────────────────────────────────────
    const mensajeCompartir = encodeURIComponent(
      `🎟️ *Mis códigos del sorteo EiderTech Soluciones*\n\n` +
      codigos.map(c => c.dorado ? `✨ ${c.codigo} ✨ (DORADO)` : `🎟️ ${c.codigo}`).join('\n') +
      `\n\n💰 Premio: $15.000.000 COP\n🍀 ¡Suerte a todos!`
    );

    const NUM_SOPORTE   = process.env.WHATSAPP_SOPORTE || '573053228703';
    const mensajeSoporte = encodeURIComponent('Hola, compré códigos y tengo una pregunta 🎟️');
    const waCompartir   = `https://wa.me/?text=${mensajeCompartir}`;
    const waSoporte     = `https://wa.me/${NUM_SOPORTE}?text=${mensajeSoporte}`;

    // ── HTML completo ────────────────────────────────────────
    const htmlContent = `
      <div style="background:#0f172a;padding:24px 16px;font-family:Arial,sans-serif;color:white;">
        <div style="max-width:500px;margin:auto;background:#111827;border-radius:16px;padding:28px 20px;">

          <!-- Encabezado -->
          <div style="text-align:center;margin-bottom:20px;">
            <div style="font-size:48px;">🎉</div>
            <h1 style="color:gold;margin:8px 0 4px;font-size:24px;">¡Compra Exitosa!</h1>
            <p style="color:#9ca3af;margin:0;font-size:13px;">Tus códigos han sido asignados automáticamente por el sistema</p>
          </div>

          <!-- Sellos de confianza -->
          <div style="text-align:center;margin-bottom:24px;">
            <span style="display:inline-block;background:#1f2937;color:#4ade80;font-size:11px;padding:4px 10px;border-radius:20px;border:1px solid #22c55e;margin:3px;">✅ Pago verificado por Wompi</span>
            <span style="display:inline-block;background:#1f2937;color:#60a5fa;font-size:11px;padding:4px 10px;border-radius:20px;border:1px solid #3b82f6;margin:3px;">🔒 Transacción segura</span>
            <span style="display:inline-block;background:#1f2937;color:#facc15;font-size:11px;padding:4px 10px;border-radius:20px;border:1px solid #eab308;margin:3px;">🎰 Asignación aleatoria</span>
          </div>

          <!-- TIQUETES NORMALES -->
          ${normales.length > 0 ? `
          <div style="margin-bottom:20px;">
            <h3 style="color:#9ca3af;text-align:center;font-size:12px;margin:0 0 12px;text-transform:uppercase;letter-spacing:2px;">Tus tiquetes</h3>
            ${tiquetesNormales}
          </div>` : ''}

          <!-- TIQUETES DORADOS -->
          ${dorados.length > 0 ? `
          <div style="margin-bottom:24px;padding:16px;background:#020617;border-radius:12px;border:2px solid gold;">
            <h2 style="color:gold;margin:0 0 12px;font-size:18px;text-align:center;">💎 ¡CÓDIGO DORADO!</h2>
            ${tiquetesDorados}
            <p style="color:#fde68a;margin:12px 0 0;font-size:12px;text-align:center;">🎉 ¡Tienes un código especial! Podría darte un premio adicional.</p>
          </div>` : ''}

          <!-- Divisor -->
          <hr style="border:none;border-top:1px solid #1f2937;margin:20px 0;">

          <!-- Compartir por WhatsApp -->
          <div style="text-align:center;margin-bottom:14px;">
            <p style="color:#9ca3af;font-size:12px;margin:0 0 10px;">¿Quieres compartir tus códigos con alguien?</p>
            <a href="${waCompartir}"
               style="display:inline-block;background:#25D366;color:white;text-decoration:none;padding:13px 28px;border-radius:10px;font-weight:bold;font-size:14px;">
              📤 Compartir por WhatsApp
            </a>
          </div>

          <!-- Soporte por WhatsApp -->
          <div style="text-align:center;margin-bottom:24px;">
            <p style="color:#9ca3af;font-size:12px;margin:0 0 10px;">¿Tienes alguna pregunta o necesitas ayuda?</p>
            <a href="${waSoporte}"
               style="display:inline-block;background:#1f2937;color:#25D366;text-decoration:none;padding:13px 28px;border-radius:10px;font-weight:bold;font-size:14px;border:2px solid #25D366;">
              💬 Contactar soporte
            </a>
          </div>

          <!-- Info sorteo -->
          <div style="background:#0f172a;border-radius:10px;padding:16px;margin-bottom:20px;text-align:center;">
            <p style="color:#facc15;font-weight:bold;margin:0 0 6px;font-size:13px;">🏆 ¿Cómo se determina el ganador?</p>
            <p style="color:#9ca3af;font-size:12px;margin:0;line-height:1.7;">
              Se toman los <strong style="color:white;">3 últimos dígitos del premio mayor</strong> + el
              <strong style="color:white;">primer número de la serie</strong> de la
              <strong style="color:white;">Lotería de Medellín</strong> del día del cierre.
            </p>
          </div>

          <!-- Footer -->
          <p style="text-align:center;color:#6b7280;font-size:11px;margin:0;line-height:1.7;">
            Guarda este correo como comprobante de tu compra.<br>
            📧 infoeidertechsoluciones@gmail.com &nbsp;|&nbsp; EiderTech Soluciones
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