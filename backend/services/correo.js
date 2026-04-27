const nodemailer = require('nodemailer');

const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;

let transporter = null;

// Crear transporter solo si hay credenciales
if (EMAIL_USER && EMAIL_PASS) {
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: EMAIL_USER,
      pass: EMAIL_PASS
    }
  });
} else {
  console.warn("⚠️ Email no configurado (faltan variables)");
}

async function enviarCorreo(destino, codigos) {
  try {

    if (!transporter) {
      console.warn("⚠️ Email omitido: transporter no configurado");
      return;
    }

    const lista = codigos
      .map(c => `<div style="font-size:18px">${c}</div>`)
      .join("");

    await transporter.sendMail({
      from: EMAIL_USER,
      to: destino,
      subject: "🎟️ Ticket de compra - Códigos",
      html: `
        <div style="background:#111;padding:20px;color:white;font-family:Arial">
          <h2 style="color:gold">🎟️ Compra Confirmada</h2>
          <p>Estos son tus códigos:</p>

          <div style="background:#000;padding:15px;border-radius:10px">
            ${lista}
          </div>

          <p style="margin-top:20px;color:#aaa">
            Guarda este ticket como comprobante.
          </p>
        </div>
      `
    });

    console.log("📧 Email enviado a:", destino);

  } catch (error) {
    console.error("❌ Error enviando email:", error.message);
  }
}

module.exports = { enviarCorreo };