const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const supabase = require('../supabase');

router.post('/crear-transaccion', async (req, res) => {
  try {
    const { cliente, cantidad } = req.body;

    /* ✅ VALIDACIONES */
    if (!cliente || !cantidad) {
      return res.status(400).json({ error: "Datos incompletos" });
    }

    if (!cliente.nombre || !cliente.correo) {
      return res.status(400).json({ error: "Faltan datos del cliente" });
    }

    /* 💰 PRECIOS */
    const precios = {
      4: 1500,
      8: 40000,
      16: 80000
    };

    const monto = precios[cantidad];

    if (!monto) {
      return res.status(400).json({ error: "Cantidad inválida" });
    }

    /* 🔑 VARIABLES */
    const PUBLIC_KEY = process.env.WOMPI_PUBLIC_KEY;
    const INTEGRITY = process.env.WOMPI_INTEGRITY_SECRET;

    if (!PUBLIC_KEY || !INTEGRITY) {
      console.error("❌ Faltan variables de entorno WOMPI");
      return res.status(500).json({ error: "Configurar WOMPI en .env" });
    }

    /* 🔢 DATOS TRANSACCIÓN */
    const referencia = `ACC-${Date.now()}-${Math.floor(Math.random() * 9999)}`;
    const amountInCents = monto * 100;
    const currency = "COP";

    /* 🔐 FIRMA (CLAVE PARA QUE FUNCIONE) */
    const cadena = `${referencia}${amountInCents}${currency}${INTEGRITY}`;

    const firma = crypto
      .createHash('sha256')
      .update(cadena)
      .digest('hex');

    /* 🧾 OBJETO FINAL */
    const tx = {
      amount_in_cents: amountInCents,
      currency: currency,
      reference: referencia,

      /* ⚠️ IMPORTANTE: FORMATO CORRECTO */
      signature: {
        integrity: firma
      },

      customer_data: {
        full_name: cliente.nombre,
        email: cliente.correo,
        phone_number: cliente.telefono || ""
      },

      metadata: {
        nombre: cliente.nombre,
        cedula: cliente.cedula || "",
        direccion: cliente.direccion || "",
        cantidad: cantidad,
        correo: cliente.correo
      }
    };

    console.log("🧾 TRANSACCIÓN GENERADA:");
    console.log(JSON.stringify(tx, null, 2));

    /* 🚀 RESPUESTA */
    res.json({
      publicKey: PUBLIC_KEY,
      tx
    });

  } catch (error) {
    console.error("❌ Error crear-transaccion:", error);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

module.exports = router;