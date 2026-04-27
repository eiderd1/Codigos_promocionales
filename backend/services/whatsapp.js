const axios = require('axios');

const SID = process.env.TWILIO_SID;
const TOKEN = process.env.TWILIO_TOKEN;
const FROM = process.env.TWILIO_FROM;

async function enviarWhatsApp(numero, codigos) {
  try {

    if (!SID || !TOKEN || !FROM) {
      console.warn("⚠️ WhatsApp no configurado (faltan variables)");
      return;
    }

    if (!numero) {
      console.warn("⚠️ Número vacío, no se envía WhatsApp");
      return;
    }

    const mensaje = `🎟️ Compra confirmada

Tus códigos:
${codigos.join(", ")}

Guárdalos.`;

    await axios.post(
      `https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`,
      new URLSearchParams({
        From: FROM,
        To: "whatsapp:" + numero,
        Body: mensaje
      }),
      {
        auth: {
          username: SID,
          password: TOKEN
        }
      }
    );

    console.log("📱 WhatsApp enviado a:", numero);

  } catch (error) {
    console.error("❌ Error enviando WhatsApp:", error.response?.data || error.message);
  }
}

module.exports = { enviarWhatsApp };