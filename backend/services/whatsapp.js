const axios = require('axios');

async function enviarWhatsApp(numero, codigos) {

  const mensaje =
`🎟️ Compra confirmada

Tus códigos:
${codigos.join(", ")}

Guárdalos.`;

  await axios.post(
    `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_SID}/Messages.json`,
    new URLSearchParams({
      From: process.env.TWILIO_FROM,
      To: "whatsapp:" + numero,
      Body: mensaje
    }),
    {
      auth: {
        username: process.env.TWILIO_SID,
        password: process.env.TWILIO_TOKEN
      }
    }
  );
}

module.exports = { enviarWhatsApp };