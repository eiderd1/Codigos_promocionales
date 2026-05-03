const nodemailer = require('nodemailer');

const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;

let transporter = null;

if (EMAIL_USER && EMAIL_PASS) {
  transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: {
      user: EMAIL_USER,
      pass: EMAIL_PASS
    }
  });
}

async function enviarCorreo(destino, codigos) {
  try {

    if (!transporter || !destino || !codigos?.length) return;

    // 🔥 SEPARAR
    const dorados = codigos.filter(c => c.dorado);
    const normales = codigos.filter(c => !c.dorado);

    // 🟡 NORMALES
    const listaNormales = normales.map(c => `
      <div style="
        background:#1f2937;
        color:white;
        padding:12px;
        margin:6px 0;
        border-radius:8px;
        font-size:18px;
        letter-spacing:2px;
      ">
        🎟️ ${c.codigo}
      </div>
    `).join("");

    // ✨ DORADOS
    const listaDorados = dorados.map(c => `
      <div style="
        background: linear-gradient(45deg, gold, orange);
        color:black;
        padding:15px;
        margin:10px 0;
        border-radius:10px;
        font-size:22px;
        font-weight:bold;
        letter-spacing:3px;
        box-shadow:0 0 15px gold;
      ">
        ✨ ${c.codigo} ✨
      </div>
    `).join("");

    await transporter.sendMail({
      from: `"EiderTech Soluciones" <${EMAIL_USER}>`,
      to: destino,
      subject: "🎟️ Compra Confirmada - Tus Códigos",
      html: `
      <div style="background:#0f172a; padding:30px; font-family:Arial; color:white; text-align:center;">

        <div style="max-width:500px; margin:auto; background:#111827; border-radius:15px; padding:25px;">

          <h1 style="color:gold;">🎉 ¡Compra Exitosa!</h1>

          <p style="color:#ccc;">Estos son tus códigos:</p>

          ${listaNormales ? `
          <div style="margin-top:20px;">
            <h3 style="color:#ccc;">🎟️ Códigos</h3>
            ${listaNormales}
          </div>
          ` : ""}

          ${listaDorados ? `
          <div style="margin-top:25px; padding:15px; background:#020617; border-radius:10px; border:2px solid gold;">
            <h2 style="color:gold;">💎 CÓDIGO DORADO</h2>
            ${listaDorados}
            <p style="color:gold;">🎉 ¡Podrías ser ganador!</p>
          </div>
          ` : ""}

          <p style="margin-top:20px; font-size:12px; color:#888;">
            Guarda este correo como comprobante.
          </p>

        </div>

      </div>
      `
    });

    console.log("📧 Email PRO enviado a:", destino);

  } catch (error) {
    console.error("❌ Error email:", error.message);
  }
}

module.exports = { enviarCorreo };