const axios = require('axios');

const TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_ID = process.env.PHONE_NUMBER_ID;
const TEMPLATE = process.env.WHATSAPP_TEMPLATE;

async function enviarWhatsApp(numero, nombre, codigos) {
  try {

    if (!TOKEN || !PHONE_ID || !TEMPLATE) {
      console.warn("⚠️ WhatsApp no configurado");
      return;
    }

    if (!numero || !codigos?.length) {
      console.warn("⚠️ Datos incompletos WhatsApp");
      return;
    }

    // ✅ codigos es array de objetos {codigo, dorado}
    const listaCodigos = codigos
      .map(c => c.dorado ? `✨ ${c.codigo} ✨` : c.codigo)
      .join("\n");

    await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: numero,
        type: "template",
        template: {
          name: TEMPLATE,
          language: { code: "es" },
          components: [
            {
              type: "body",
              parameters: [
                { type: "text", text: nombre || "Cliente" },
                { type: "text", text: listaCodigos }
              ]
            }
          ]
        }
      },
      {
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log("📱 WhatsApp enviado a:", numero);

  } catch (error) {
    console.error("❌ Error WhatsApp:", error.response?.data || error.message);
  }
}

module.exports = { enviarWhatsApp };