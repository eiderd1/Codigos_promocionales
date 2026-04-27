const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

// ========================
// EMAIL
// ========================
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// ========================
// VALIDAR FIRMA WOMPI
// ========================
function validarFirma(event) {
  try {
    const secret = process.env.WOMPI_EVENTS_SECRET;

    const signature = event.signature?.checksum;
    const timestamp = event.timestamp;

    const payload = JSON.stringify(event.data);

    const cadena = `${timestamp}.${payload}`;

    const hash = crypto
      .createHmac('sha256', secret)
      .update(cadena)
      .digest('hex');

    return hash === signature;
  } catch (e) {
    return false;
  }
}

// ========================
// WEBHOOK
// ========================
router.post('/webhook-wompi', async (req, res) => {
  try {

    console.log("📩 Evento recibido");

    // 🔐 VALIDAR FIRMA
    if (!validarFirma(req.body)) {
      console.log("❌ Firma inválida");
      return res.sendStatus(403);
    }

    if (!req.body?.data?.transaction) {
      return res.sendStatus(200);
    }

    const evento = req.body.data.transaction;

    console.log("📦 TX:", {
      id: evento.id,
      ref: evento.reference,
      status: evento.status
    });

    // SOLO APROBADOS
    if (evento.status !== "APPROVED") {
      return res.sendStatus(200);
    }

    const referencia = evento.reference;
    const wompiId = evento.id;
    const metadata = evento.metadata || {};

    const cantidad = parseInt(metadata.cantidad || 0);
    const email = metadata.correo;

    if (!cantidad || !email) {
      console.log("⚠️ Metadata incompleta");
      return res.sendStatus(200);
    }

    // 🔒 ANTIDUPLICADO REAL (POR WOMPI ID)
    const { data: existe } = await supabase
      .from('transacciones')
      .select('id')
      .eq('wompi_id', wompiId)
      .maybeSingle();

    if (existe) {
      console.log("⚠️ Evento duplicado:", wompiId);
      return res.sendStatus(200);
    }

    // ========================
    // 🎟️ COMPRA SEGURA (RPC)
    // ========================
    const { data: codigos, error: rpcError } = await supabase
      .rpc('comprar_codigos', {
        cantidad,
        referencia
      });

    if (rpcError) {
      console.error("❌ Error RPC:", rpcError);
      return res.sendStatus(500);
    }

    if (!codigos || codigos.length === 0) {
      console.log("❌ Sin stock");
      return res.sendStatus(200);
    }

    const lista = codigos.map(c => c.codigo);

    // ========================
    // 💾 GUARDAR TRANSACCIÓN
    // ========================
    const { error: txError } = await supabase
      .from('transacciones')
      .insert([
        {
          referencia,
          wompi_id: wompiId,
          estado: "APROBADO",
          email,
          cantidad,
          created_at: new Date()
        }
      ]);

    if (txError) {
      console.error("❌ Error guardando:", txError);
      return res.sendStatus(500);
    }

    // ========================
    // 📧 EMAIL (NO BLOQUEANTE)
    // ========================
    try {
      await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: email,
        subject: "🎟️ Tus códigos",
        html: `
          <h2>Pago confirmado</h2>
          <p>Aquí tienes tus códigos:</p>
          <h3>${lista.join("<br>")}</h3>
        `
      });

      console.log("📧 Email enviado a:", email);

    } catch (emailError) {
      console.error("⚠️ Error enviando email:", emailError);
    }

    console.log("✅ PROCESADO:", referencia);

    res.sendStatus(200);

  } catch (error) {
    console.error("💥 Error webhook:", error);
    res.sendStatus(500);
  }
});

module.exports = router;