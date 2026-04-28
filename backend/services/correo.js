const nodemailer = require('nodemailer');

const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;

let transporter = null;

// Crear transporter solo si hay credenciales
if (EMAIL_USER && EMAIL_PASS) {
  transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
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

    if (!destino) {
      console.warn("⚠️ Email omitido: destino vacío");
      return;
    }

    if (!Array.isArray(codigos) || codigos.length === 0) {
      console.warn("⚠️ Email omitido: sin códigos");
      return;
    }

    const lista = codigos
      .map(c => `
        <div style="
          font-size:20px;
          font-weight:bold;
          color:gold;
          margin:5px 0;
          letter-spacing:2px;
        ">
          ${c}
        </div>
      `)
      .join("");

    await transporter.sendMail({
      from: `"Tickets" <${EMAIL_USER}>`,
      to: destino,
      subject: "🎟️ Compra Confirmada - Tus Códigos",
      html: `
        <div style="
          background:#111;
          padding:25px;
          color:white;
          font-family:Arial;
          text-align:center;
        ">

          <h2 style="color:gold;">🎟️ Compra Confirmada</h2>

          <p>Gracias por tu compra. Estos son tus códigos:</p>

          <div style="
            background:#000;
            padding:20px;
            border-radius:10px;
            margin-top:15px;
          ">
            ${lista}
          </div>

          <p style="margin-top:20px;color:#aaa;font-size:13px;">
            Guarda estos códigos como comprobante.
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