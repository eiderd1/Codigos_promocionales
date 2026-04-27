const express = require('express');
const crypto = require('crypto');
const router = express.Router();

router.post('/crear-transaccion', async (req, res) => {
  try {
    const { cliente, cantidad } = req.body;

    if (!cliente || !cantidad) {
      return res.status(400).json({ error: "Datos incompletos" });
    }

    if (!cliente.nombre || !cliente.correo) {
      return res.status(400).json({ error: "Faltan datos del cliente" });
    }

    const precios = {
      20: 10000,
      40: 20000,
      60: 30000
    };

    const monto = precios[cantidad];

    if (!monto) {
      return res.status(400).json({ error: "Cantidad inválida" });
    }

    const referencia = `Acc-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const amountInCents = monto * 100;
    const currency = "COP";

    if (!process.env.WOMPI_PUBLIC_KEY || !process.env.WOMPI_INTEGRITY_SECRET) {
      return res.status(500).json({ error: "Faltan variables WOMPI" });
    }

    const cadena = `${referencia}${amountInCents}${currency}${process.env.WOMPI_INTEGRITY_SECRET}`;

    const firma = crypto
      .createHash('sha256')
      .update(cadena)
      .digest('hex');

    const tx = {
      amount_in_cents: amountInCents,
      currency,
      reference: referencia,
      signature: firma,
      customer_data: {
        full_name: cliente.nombre,
        email: cliente.correo,
        phone_number: cliente.telefono || ""
      },
      metadata: {
        cedula: cliente.cedula || "",
        direccion: cliente.direccion || "",
        cantidad,
        correo: cliente.correo
      }
    };

    console.log("🧾 Nueva transacción:");
    console.log(JSON.stringify(tx, null, 2));

    res.json({
      publicKey: process.env.WOMPI_PUBLIC_KEY,
      tx
    });

  } catch (error) {
    console.error("❌ Error crear-transaccion:", error);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

module.exports = router;