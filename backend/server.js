require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { generarDoradosIniciales } = require('./services/dorados');

// 🚀 Ejecutar una sola vez al iniciar servidor
generarDoradosIniciales();
console.log("🔥 Iniciando servidor...");

// ========================
// VALIDAR VARIABLES CRÍTICAS
// ========================
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ Faltan variables de Supabase");
}

// ========================
const app = express();

// ========================
// MIDDLEWARES
// ========================
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ========================
// RUTAS (con protección)
// ========================
function safeRequire(path) {
  try {
    return require(path);
  } catch (err) {
    console.error(`❌ Error cargando ruta ${path}:`, err.message);
    return (req, res) => res.status(500).json({ error: "Ruta no disponible" });
  }
}

app.use('/api', safeRequire('./routes/crear-transaccion'));
app.use('/api', safeRequire('./routes/estado'));
app.use('/api', safeRequire('./routes/webhook'));
app.use('/api', safeRequire('./routes/progreso'));
app.use('/api', safeRequire('./routes/admin'));
app.use('/api', safeRequire('./routes/exportar'));

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
    message: 'Servidor funcionando 🚀'
  });
});

// ========================
// ERROR HANDLER GLOBAL
// ========================
app.use((err, req, res, next) => {
  console.error('💥 ERROR GLOBAL:', err);
  res.status(500).json({
    ok: false,
    message: 'Error interno'
  });
});

// ========================
// EVITAR CRASH TOTAL
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
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});