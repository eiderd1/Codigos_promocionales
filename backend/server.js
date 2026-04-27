require('dotenv').config();
const express = require('express');
const cors = require('cors');

// ========================
// SUPABASE (AGREGADO AQUÍ)
// ========================
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// (opcional) exportarlo si lo quieres usar en otros archivos
module.exports.supabase = supabase;

// ========================
const app = express();

// ========================
// MIDDLEWARES
// ========================
app.use(cors({
  origin: '*',
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ========================
// RUTAS
// ========================
const webhook = require('./routes/webhook');
const progreso = require('./routes/progreso');
const admin = require('./routes/admin');
const exportar = require('./routes/exportar');
const crearTx = require('./routes/crear-transaccion');
const estado = require('./routes/estado');

// API ROUTES
app.use('/api', crearTx);
app.use('/api', estado);
app.use('/api', webhook);
app.use('/api', progreso);
app.use('/api', admin);
app.use('/api', exportar);

// ========================
// FRONTEND
// ========================
app.use(express.static('frontend'));

// ========================
// HEALTH CHECK
// ========================
app.get('/api/test', (req, res) => {
  res.json({
    ok: true,
    message: 'Servidor funcionando correctamente 🚀'
  });
});

// ========================
// ERROR HANDLER GLOBAL
// ========================
app.use((err, req, res, next) => {
  console.error('💥 ERROR GLOBAL:', err);
  res.status(500).json({
    ok: false,
    message: 'Error interno del servidor'
  });
});

// ========================
// PROCESOS (EVITA CRASH)
// ========================
process.on('uncaughtException', (err) => {
  console.error('🔥 Uncaught Exception:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('🔥 Unhandled Rejection:', err);
});

// ========================
// PUERTO
// ========================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Servidor listo en http://localhost:${PORT}`);
});