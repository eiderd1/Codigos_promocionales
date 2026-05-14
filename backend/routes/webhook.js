const express = require('express');
const router = express.Router();
const crypto = require('crypto');

const { generarCodigos } = require('../services/codigos');
const { enviarCorreo } = require('../services/correo');
const { enviarWhatsApp } = require('../services/whatsapp');
const supabase = require('../config/supabase');

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

    const wompiId    = evento.id;
    const referencia = evento.reference;

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
    // 📋 BUSCAR DATOS POR REFERENCIA
    // ========================
    const { data: compra, error: errorCompra } = await supabase
      .from('compras')
      .select('*')
      .eq('referencia', referencia)
      .limit(1)
      .single();

    if (errorCompra || !compra) {
      console.log("⚠️ No se encontró compra para:", referencia);
      return res.sendStatus(200);
    }

    const cantidad  = compra.cantidad;
    const email     = compra.correo;
    const nombre    = compra.nombre    || "Cliente";
    const cedula    = compra.cedula    || "";
    const direccion = compra.direccion || "";
    const telefono  = compra.telefono  || evento.customer_data?.phone_number || "";

    console.log("📋 Compra encontrada:", { cantidad, email, nombre });

    // ========================
    // 🎟️ GENERAR CÓDIGOS
    // Los códigos son asignados automáticamente por el sistema de forma aleatoria.
    // Ninguna persona interviene en la selección.
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
        wompi_id:   wompiId,
        estado:     "APROBADO",
        email,
        cantidad,
        created_at: new Date()
      }]);

    if (errorTx) {
      console.error("❌ Error insertando transacción:", errorTx);
      return res.sendStatus(500);
    }

    // ========================
    // 💰 GUARDAR PREMIO DORADO EN COMPRA (si aplica)
    // ========================
    const codigoDorado = codigos.find(c => c.dorado);
    if (codigoDorado && codigoDorado.premioDorado) {
      await supabase
        .from('compras')
        .update({ premio_dorado: codigoDorado.premioDorado })
        .eq('referencia', referencia);
      console.log(`💎 Premio dorado guardado: $${codigoDorado.premioDorado.toLocaleString()} → ${referencia}`);
    }

    // ========================
    // ✅ MARCAR COMPRA COMO PAGADA
    // Solo aquí, cuando Wompi confirma el pago, se cambia el estado.
    // Las compras "pendiente" son intentos que no se completaron.
    // ========================
    const { error: errorEstado } = await supabase
      .from('compras')
      .update({ estado: "pagado" })
      .eq('referencia', referencia);

    if (errorEstado) {
      console.error("⚠️ Error actualizando estado de compra:", errorEstado);
    } else {
      console.log("✅ Compra marcada como pagada:", referencia);
    }

    // ========================
    // 💾 MARCAR CÓDIGOS VENDIDOS
    // Se guardan todos los datos del comprador para identificar al ganador fácilmente
    // ========================
    for (const c of codigos) {
      const { error: errorUpdate } = await supabase
        .from('codigos')
        .update({
          vendido:   true,
          referencia,
          email,
          nombre,
          telefono,
          direccion
        })
        .eq('codigo', c.codigo);

      if (errorUpdate) {
        console.error("❌ Error actualizando código:", c.codigo, errorUpdate);
      }
    }

    // ========================
    // 📧 EMAIL
    // ========================
    try {
      const dorado = codigos.find(c => c.dorado);
      await enviarCorreo(email, codigos, dorado?.premioDorado || null);
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