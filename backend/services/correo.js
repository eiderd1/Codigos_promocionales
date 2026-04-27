const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

async function enviarCorreo(destino, codigos) {

  const lista = codigos.map(c => `<div style="font-size:18px">${c}</div>`).join("");

  await transporter.sendMail({
    from: process.env.EMAIL_USER,
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
}

module.exports = { enviarCorreo };