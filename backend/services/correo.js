const Brevo = require('@getbrevo/brevo');

async function enviarCorreo(destino, codigos) {
  try {
    if (!process.env.BREVO_API_KEY || !destino || !codigos?.length) return;

    const apiInstance = new Brevo.TransactionalEmailsApi();
    const apiKey = apiInstance.authentications['api-key'];
    apiKey.apiKey = process.env.BREVO_API_KEY;

    const dorados = codigos.filter(c => c.dorado);
    const normales = codigos.filter(c => !c.dorado);

    const listaNormales = normales.map(c => `
      <div style="background:#1f2937;color:white;padding:12px;margin:6px 0;border-radius:8px;font-size:18px;letter-spacing:2px;">
        🎟️ ${c.codigo}
      </div>
    `).join("");

    const listaDorados = dorados.map(c => `
      <div style="background:linear-gradient(45deg,gold,orange);color:black;padding:15px;margin:10px 0;border-radius:10px;font-size:22px;font-weight:bold;letter-spacing:3px;">
        ✨ ${c.codigo} ✨
      </div>
    `).join("");

    const sendSmtpEmail = new Brevo.SendSmtpEmail();
    sendSmtpEmail.subject = "🎟️ Compra Confirmada - Tus Códigos";
    sendSmtpEmail.to = [{ email: destino }];
    sendSmtpEmail.sender = {
      name: "EiderTech Soluciones",
      email: process.env.BREVO_FROM_EMAIL || "eidercobo383@gmail.com"
    };
    sendSmtpEmail.htmlContent = `
      <div style="background:#0f172a;padding:30px;font-family:Arial;color:white;text-align:center;">
        <div style="max-width:500px;margin:auto;background:#111827;border-radius:15px;padding:25px;">
          <h1 style="color:gold;">🎉 ¡Compra Exitosa!</h1>
          <p style="color:#ccc;">Estos son tus códigos:</p>
          ${listaNormales ? `<div style="margin-top:20px;"><h3 style="color:#ccc;">🎟️ Códigos</h3>${listaNormales}</div>` : ""}
          ${listaDorados ? `<div style="margin-top:25px;padding:15px;background:#020617;border-radius:10px;border:2px solid gold;"><h2 style="color:gold;">💎 CÓDIGO DORADO</h2>${listaDorados}<p style="color:gold;">🎉 ¡Podrías ser ganador!</p></div>` : ""}
          <p style="margin-top:20px;font-size:12px;color:#888;">Guarda este correo como comprobante.</p>
        </div>
      </div>
    `;

    await apiInstance.sendTransacEmail(sendSmtpEmail);
    console.log("📧 Email enviado a:", destino);

  } catch (error) {
    console.error("❌ Error email:", error.message);
  }
}

module.exports = { enviarCorreo };