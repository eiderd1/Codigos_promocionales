const express = require('express');
const router = express.Router();
const crypto = require('crypto');

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

    if (!secret) {
      console.log("⚠️ WOMPI_EVENTS_SECRET no configurado - aceptando");
      return true;
    }

    const checksum = event.signature?.checksum;
    const properties = event.signature?.properties || [];
    const timestamp = event.timestamp;

    if (!checksum || !timestamp) {
      console.log("⚠️ Firma o timestamp ausente");
      return false;
    }

    const valores = properties.map(prop => {
      const keys = prop.split('.');
      let val = event.data;
      for (const k of keys) val = val?.[k];
      return val ?? '';
    });

    const cadena = [...valores, timestamp, secret].join('');

    const firmaCalculada = crypto
      .createHash('sha256')
      .update(cadena)
      .digest('hex');

    console.log("🔐 Firma calculada:", firmaCalculada);
    console.log("🔐 Firma recibida: ", checksum);
    console.log("🔐 Coincide:", firmaCalculada === checksum);

    return firmaCalculada === checksum;

  } catch (error) {
    console.error("❌ Error validando firma:", error);
    return false;
  }
}

function mezclar(array) {
  return [...array].sort(() => Math.random() - 0.5);
}

// ========================
// 🚀 WEBHOOK
// ========================
router.post('/webhook-wompi', async (req, res) => {
  try {
    console.log("📩 Evento recibido");

    if (!validarFirma(req.body)) {
      console.log("❌ Firma inválida");
      return res.sendStatus(403);
    }

    const evento = req.body?.data?.transaction;
    if (!evento) return res.sendStatus(200);

    console.log("📦 TX:", { id: evento.id, ref: evento.reference, status: evento.status });

    if (evento.status !== "APPROVED") return res.sendStatus(200);

    const wompiId = evento.id;
    const referencia = evento.reference;
    const metadata = evento.metadata || {};

    const cantidad = parseInt(metadata.cantidad || 0);
    const email = metadata.correo;
    const nombre = metadata.nombre || "Cliente";
    const cedula = metadata.cedula || "";
    const direccion = metadata.direccion || "";
    const telefono = evento.customer_data?.phone_number || "";

    if (!cantidad || !email) {
      console.log("⚠️ Metadata incompleta - cantidad:", cantidad, "email:", email);
      return res.sendStatus(200);
    }

    // ========================
    // 🔒 ANTIDUPLICADO
    // ========================
    const { data: existe, error: errorExiste } = await supabase
      .from('transacciones')
      .select('wompi_id')
      .eq('wompi_id', wompiId)
      .limit(1);

    if (errorExiste) {
      console.error("❌ Error consultando:", errorExiste);
      return res.sendStatus(500);
    }

    if (existe && existe.length > 0) {
      console.log("⚠️ Ya procesado:", wompiId);
      return res.sendStatus(200);
    }

    // ========================
    // 🎟️ GENERAR CÓDIGOS
    // ========================
    let codigos;
    try {
      codigos = await generarCodigos(cantidad, referencia);
    } catch (err) {
      console.error("❌ Error generando códigos:", err);
      return res.sendStatus(500);
    }

    if (!codigos || codigos.length === 0) {
      console.log("❌ Sin stock disponible");
      return res.sendStatus(200);
    }

    codigos = mezclar(codigos);

    // ========================
    // 💾 GUARDAR EN transacciones
    // ========================
    const { error: errorTx } = await supabase
      .from('transacciones')
      .insert([{
        referencia,
        wompi_id: wompiId,
        estado: "APROBADO",
        email,
        cantidad,
        created_at: new Date()
      }]);

    if (errorTx) {
      console.error("❌ Error insertando transacción:", errorTx);
      return res.sendStatus(500);
    }

    // ========================
    // 💾 GUARDAR EN compras
    // ========================
    const { error: errorCompra } = await supabase
      .from('compras')
      .insert([{
        nombre,
        cedula,
        telefono,
        correo: email,
        direccion,
        cantidad,
        referencia,
        fecha: new Date()
      }]);

    if (errorCompra) {
      console.error("❌ Error insertando compra:", errorCompra);
    }

    // ========================
    // 💾 MARCAR CÓDIGOS VENDIDOS
    // ========================
    for (const c of codigos) {
      const { error: errorUpdate } = await supabase
        .from('codigos')
        .update({ vendido: true, referencia, email })
        .eq('codigo', c.codigo);

      if (errorUpdate) {
        console.error("❌ Error actualizando código:", c.codigo, errorUpdate);
      }
    }

    // ========================
    // 📧 EMAIL
    // ========================
    try {
      await enviarCorreo(email, codigos);
    } catch (err) {
      console.error("❌ Error email:", err.message);
    }

    // ========================
    // 📱 WHATSAPP
    // ========================
    if (telefono) {
      try {
        await enviarWhatsApp(telefono, nombre, codigos);
      } catch (err) {
        console.error("❌ Error WhatsApp:", err.message);
      }
    }

    console.log("✅ ENTREGA COMPLETA:", referencia);
    res.sendStatus(200);

  } catch (error) {
    console.error("💥 Error webhook:", error);
    res.sendStatus(500);
  }
});

module.exports = router;