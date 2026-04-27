const express = require('express');
const router = express.Router();
const crypto = require('crypto');

// módulos tuyos
const { generarCodigos } = require('../services/codigos');
const { enviarCorreo } = require('../services/correo');
const { enviarWhatsApp } = require('../services/whatsapp');
const supabase = require('../config/supabase');

// ========================
// 🔐 VALIDAR FIRMA WOMPI
// ========================
function validarFirma(event) {
  try {
    const secret = process.env.WOMPI_EVENTS_SECRET;

    const firmaRecibida = event.signature?.checksum;
    const timestamp = event.timestamp;
    const payload = JSON.stringify(event.data);

    const cadena = `${timestamp}.${payload}`;

    const firmaCalculada = crypto
      .createHmac('sha256', secret)
      .update(cadena)
      .digest('hex');

    return firmaCalculada === firmaRecibida;

  } catch (error) {
    console.error("❌ Error validando firma:", error);
    return false;
  }
}

// ========================
// 🎲 MEZCLAR CÓDIGOS
// ========================
function mezclar(array) {
  return array.sort(() => Math.random() - 0.5);
}

// ========================
// 🚀 WEBHOOK
// ========================
router.post('/webhook-wompi', async (req, res) => {
  try {

    console.log("📩 Evento recibido");

    // 🔐 validar firma
    if (!validarFirma(req.body)) {
      console.log("❌ Firma inválida");
      return res.sendStatus(403);
    }

    const evento = req.body?.data?.transaction;

    if (!evento) return res.sendStatus(200);

    console.log("📦 TX:", {
      id: evento.id,
      ref: evento.reference,
      status: evento.status
    });

    if (evento.status !== "APPROVED") {
      return res.sendStatus(200);
    }

    const wompiId = evento.id;
    const referencia = evento.reference;
    const metadata = evento.metadata || {};

    const cantidad = parseInt(metadata.cantidad || 0);
    const email = metadata.correo;
    const telefono = evento.customer_data?.phone_number || "";

    if (!cantidad || !email) {
      console.log("⚠️ Datos incompletos");
      return res.sendStatus(200);
    }

    // ========================
    // 🔒 ANTIDUPLICADO
    // ========================
    const { data: existe } = await supabase
      .from('transacciones')
      .select('id')
      .eq('wompi_id', wompiId)
      .maybeSingle();

    if (existe) {
      console.log("⚠️ Ya procesado");
      return res.sendStatus(200);
    }

    // ========================
    // 🎟️ GENERAR CÓDIGOS
    // ========================
    let codigos = await generarCodigos(cantidad);

    if (!codigos || codigos.length === 0) {
      console.log("❌ Sin stock");
      return res.sendStatus(200);
    }

    // 🔀 DESORDENAR
    codigos = mezclar(codigos);

    // ========================
    // 💾 GUARDAR
    // ========================
    await supabase.from('transacciones').insert([{
      referencia,
      wompi_id: wompiId,
      estado: "APROBADO",
      email,
      cantidad,
      created_at: new Date()
    }]);

    // ========================
    // 📧 EMAIL tipo ticket
    // ========================
    await enviarCorreo(email, codigos);

    // ========================
    // 📱 WHATSAPP
    // ========================
    if (telefono) {
      await enviarWhatsApp(telefono, codigos);
    }

    console.log("✅ ENTREGA COMPLETA:", referencia);

    res.sendStatus(200);

  } catch (error) {
    console.error("💥 Error webhook:", error);
    res.sendStatus(500);
  }
});

module.exports = router;