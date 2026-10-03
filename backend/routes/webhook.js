const express = require('express');
const router = express.Router();
const crypto = require('crypto');

const { generarCodigos } = require('../services/codigos');
const { enviarCorreo } = require('../services/correo');
const { enviarWhatsApp } = require('../services/whatsapp');
const { enviarNotifAdmin } = require('../services/notificaciones');
const supabase = require('../config/supabase');

function validarFirma(event) {
  try {
    const secret = process.env.WOMPI_EVENTS_SECRET;

    if (!secret) {
      console.error("❌ WOMPI_EVENTS_SECRET no configurado");
      return false;
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
    if (evento.status !== "APPROVED") return res.sendStatus(200);

    const wompiId = evento.id;
    const referencia = evento.reference;
    if (!wompiId || !referencia) return res.sendStatus(200);

    console.log("📦 TX:", { id: wompiId, ref: referencia, status: evento.status });

    // 🔒 Idempotencia: si Wompi reenvía el webhook, jamás se generan códigos otra vez.
    const { data: existe, error: errorExiste } = await supabase
      .from('transacciones')
      .select('wompi_id, estado, referencia')
      .eq('wompi_id', wompiId)
      .limit(1);

    if (errorExiste) {
      console.error("❌ Error consultando transacción:", errorExiste);
      return res.sendStatus(500);
    }
    if (existe && existe.length > 0) {
      console.log("⚠️ Webhook ya procesado/registrado:", wompiId);
      return res.sendStatus(200);
    }

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

    // Si la compra ya fue pagada, no reasignar códigos.
    if (['pagado', 'transferencia_aprobada'].includes(compra.estado)) {
      console.log("⚠️ Compra ya procesada:", referencia);
      return res.sendStatus(200);
    }

    // Validar el importe real contra la compra creada por nuestro servidor.
    if (Number(evento.amount_in_cents) !== Number(compra.monto) * 100 || evento.currency !== 'COP') {
      console.error("❌ Importe/moneda no coincide", {
        referencia,
        wompi: evento.amount_in_cents,
        esperado: Number(compra.monto) * 100,
        moneda: evento.currency
      });
      return res.sendStatus(400);
    }

    const cantidad = Number(compra.cantidad);
    const email = compra.correo;
    const nombre = compra.nombre || "Cliente";
    const cedula = compra.cedula || "";
    const direccion = compra.direccion || "";
    const telefono = compra.telefono || evento.customer_data?.phone_number || "";

    // Registrar el evento ANTES de asignar códigos. La columna wompi_id debe
    // tener restricción UNIQUE en Supabase para que esto funcione como cerrojo.
    const { error: errorTxInicial } = await supabase
      .from('transacciones')
      .insert([{
        referencia,
        wompi_id: wompiId,
        estado: "PROCESANDO",
        email,
        cantidad,
        created_at: new Date()
      }]);

    if (errorTxInicial) {
      // Un segundo webhook concurrente normalmente llegará aquí por UNIQUE(wompi_id).
      if (/duplicate|unique/i.test(errorTxInicial.message || '')) return res.sendStatus(200);
      console.error("❌ Error registrando transacción:", errorTxInicial);
      return res.sendStatus(500);
    }

    console.log("📋 Compra validada:", { cantidad, email, nombre, referencia });

    let codigos = [];
    try {
      codigos = await generarCodigos(cantidad, referencia, { nombre, email, telefono });
    } catch (err) {
      console.error("❌ Error generando códigos:", err);
    }

    if (!codigos || codigos.length !== cantidad) {
      await supabase.from('transacciones').update({ estado: 'ERROR_STOCK' }).eq('wompi_id', wompiId);
      console.log("❌ No se pudo asignar el lote completo:", referencia);
      return res.sendStatus(200);
    }

    // Completar la transacción y la compra solo después de tener todos los códigos.
    const { error: errorTx } = await supabase
      .from('transacciones')
      .update({ estado: "APROBADO" })
      .eq('wompi_id', wompiId);
    if (errorTx) {
      console.error("❌ Error finalizando transacción:", errorTx);
      return res.sendStatus(500);
    }

    const codigoDorado = codigos.find(c => c.dorado);
    const compraUpdate = { estado: "pagado" };
    if (codigoDorado?.premioDorado) compraUpdate.premio_dorado = codigoDorado.premioDorado;

    const { error: errorEstado } = await supabase
      .from('compras')
      .update(compraUpdate)
      .eq('referencia', referencia);

    if (errorEstado) {
      console.error("⚠️ Error actualizando estado de compra:", errorEstado);
      return res.sendStatus(500);
    }

    // Los códigos ya quedaron reservados por generarCodigos(). Solo completamos
    // los campos adicionales del comprador.
    const { error: errorDatosCodigos } = await supabase
      .from('codigos')
      .update({ direccion })
      .eq('referencia', referencia);
    if (errorDatosCodigos) console.error("⚠️ Error guardando dirección en códigos:", errorDatosCodigos);

    try {
      await enviarNotifAdmin({
        tipo: 'wompi', nombre, correo: email, cedula, telefono,
        cantidad, referencia, monto: compra.monto
      });
    } catch (err) {
      console.error("❌ Error notif admin:", err.message);
    }

    try {
      await enviarCorreo(email, codigos, codigoDorado?.premioDorado || null);
    } catch (err) {
      console.error("❌ Error email:", err.message);
    }

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