require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const helmet = require('helmet');

const { generarDoradosIniciales } = require('./services/dorados');

const app = express();

console.log("🔥 Iniciando servidor...");

// ========================
// VALIDAR VARIABLES
// ========================
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ Faltan variables de Supabase");
  process.exit(1);
}

// ========================
// MIDDLEWARES
// ========================
app.use(
  helmet({
    contentSecurityPolicy: false
  })
);

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// 🔥 DESACTIVAR CACHE (CLAVE PARA RENDER)
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});

// ========================
// RUTAS API
// ========================
app.use('/api', require('./routes/crear-transaccion'));
app.use('/api', require('./routes/estado'));
app.use('/api', require('./routes/webhook'));
app.use('/api', require('./routes/progreso'));
app.use('/api', require('./routes/admin'));
app.use('/api', require('./routes/exportar'));
app.use('/api', require('./routes/mis-codigos'));

// ========================
// FRONTEND
// ========================
const frontendPath = path.join(__dirname, '../frontend');

app.use(express.static(frontendPath));

app.get('*', (req, res) => {
  res.sendFile(path.join(frontendPath, 'index.html'));
});

// ========================
// TEST
// ========================
app.get('/api/test', (req, res) => {
  res.json({ ok: true });
});

// ========================
// ERROR GLOBAL
// ========================
app.use((err, req, res, next) => {
  console.error('💥 ERROR:', err);
  res.status(500).json({ error: 'Error interno' });
});

// ========================
// INICIAR
// ========================
const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log(`🚀 Servidor en puerto ${PORT}`);
  await generarDoradosIniciales();
});