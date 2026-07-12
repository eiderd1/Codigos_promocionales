const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();
const supabase = require('../config/supabase');
const { getPromoActiva } = require('../services/promociones');
const { CONFIG } = require('../services/appState');

// Validación básica de formato de correo
function esCorreoValido(correo) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo);
}

router.post('/crear-transaccion', async (req, res) => {
  try {
    // ── Verificar si las ventas están activas ─────────────────
    if (!CONFIG.ventas_activas) {
      return res.status(403).json({
        error: 'Las ventas están temporalmente pausadas. Intenta de nuevo más tarde.'
      });
    }

    const { cliente, cantidad } = req.body;

    // ── Validaciones básicas ──────────────────────────────────
    if (!cliente || !cantidad) {
      return res.status(400).json({ error: "Datos incompletos" });
    }

    if (typeof cliente !== "object" || Array.isArray(cliente)) {
      return res.status(400).json({ error: "Cliente inválido" });
    }

    if (!cliente.nombre || !cliente.correo) {
      return res.status(400).json({ error: "Faltan datos del cliente" });
    }

    if (!esCorreoValido(cliente.correo)) {
      return res.status(400).json({ error: "Correo electrónico inválido" });
    }

    // ── Validar correo registrado en Supabase Auth ────────────
    // Descomenta si quieres exigir que el correo exista en auth.users:
    /*
    const { data: usuarioAuth } = await supabase
      .from('profiles')           // ← cambia por tu tabla de usuarios si usas una
      .select('id')
      .eq('email', cliente.correo)
      .maybeSingle();

    if (!usuarioAuth) {
      return res.status(400).json({ error: "Correo no registrado en el sistema" });
    }
    */

    // ── Precios base (precio por código individual) ───────────
    const precioPorCodigo = CONFIG.precio_codigo || 3750;

    const cantidadesValidas = [4, 8, 16];
    if (!cantidadesValidas.includes(Number(cantidad))) {
      return res.status(400).json({ error: "Cantidad inválida" });
    }

    // ── Verificar stock disponible ────────────────────────────
    const { count: disponibles, error: errorStock } = await supabase
      .from('codigos')
      .select('*', { count: 'exact', head: true })
      .eq('vendido', false);

    if (errorStock) {
      console.error("❌ Error consultando stock:", errorStock);
      return res.status(500).json({ error: "Error interno del servidor" });
    }

    if (!disponibles || disponibles === 0) {
      return res.status(400).json({ error: "No hay códigos disponibles" });
    }

    // ── Ajustar cantidad al stock real ────────────────────────
    // Si el cliente pidió 16 pero solo hay 2, se cobra solo por 2
    const cantidadFinal = Math.min(Number(cantidad), disponibles);
    const monto         = cantidadFinal * precioPorCodigo;

    // ── Variables Wompi ───────────────────────────────────────
    const PUBLIC_KEY = process.env.WOMPI_PUBLIC_KEY;
    const INTEGRITY  = process.env.WOMPI_INTEGRITY_SECRET;

    if (!PUBLIC_KEY || !INTEGRITY) {
      console.error("❌ Faltan variables de entorno WOMPI");
      return res.status(500).json({ error: "Configurar WOMPI en .env" });
    }

    const referencia    = `ACC-${Date.now()}-${Math.floor(Math.random() * 9999)}`;
    const amountInCents = monto * 100;
    const currency      = "COP";

    const cadena = `${referencia}${amountInCents}${currency}${INTEGRITY}`;
    const firma  = crypto.createHash('sha256').update(cadena).digest('hex');

    // ── Guardar compra con estado "pendiente" ─────────────────
    // El estado cambia a "pagado" solo cuando Wompi confirma en el webhook.
    // Si el cliente abandona el pago, queda "pendiente" y nunca recibe códigos.
    const { error: errorCompra } = await supabase
      .from('compras')
      .insert([{
        nombre:    cliente.nombre,
        cedula:    cliente.cedula    || "",
        telefono:  cliente.telefono  || "",
        correo:    cliente.correo,
        direccion: cliente.direccion || "",
        cantidad:  cantidadFinal,
        referencia,
        estado:    "pendiente",
        fecha:     new Date()
      }]);

    if (errorCompra) {
      console.error("❌ Error guardando compra:", errorCompra);
      return res.status(500).json({ error: "Error interno del servidor" });
    }

    console.log(`💾 Compra pendiente: ${referencia} | ${cantidadFinal} códigos | $${monto.toLocaleString()}`);

    const tx = {
      amount_in_cents: amountInCents,
      currency,
      reference: referencia,
      signature: { integrity: firma },
      customer_data: {
        full_name:    cliente.nombre,
        email:        cliente.correo,
        phone_number: cliente.telefono || ""
      },
      metadata: {
        nombre:    cliente.nombre,
        cedula:    cliente.cedula    || "",
        direccion: cliente.direccion || "",
        cantidad:  cantidadFinal,
        correo:    cliente.correo
      }
    };

    // El frontend usa 'ajustado' para mostrar aviso si se redujo la cantidad
    // Verificar si hay promo activa para informar al frontend
    const promo = await getPromoActiva();

    res.json({
      publicKey:          PUBLIC_KEY,
      tx,
      cantidadFinal,
      cantidadSolicitada: Number(cantidad),
      montoTotal:         monto,
      ajustado:           cantidadFinal < Number(cantidad),
      promoActiva:        promo ? {
        precioDorado: promo.precio_dorado,  // ej: 1500000
        expiraEn:     promo.expira_en
      } : null
    });

  } catch (error) {
    console.error("❌ Error crear-transaccion:", error);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

module.exports = router;