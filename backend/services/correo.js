const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

async function enviarCorreo(destino, codigos) {
  const lista = codigos.join(', ');

  await transporter.sendMail({
    from: process.env.EMAIL_USER,
    to: destino,
    subject: "🎟️ Tus códigos",
    html: `<h2>Gracias por tu compra</h2>
           <p>Tus códigos son:</p>
           <b>${lista}</b>`
  });
}

module.exports = { enviarCorreo };