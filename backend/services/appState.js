// services/appState.js
// Estado compartido entre rutas (admin.js, crear-transaccion.js, etc.)
// Usar siempre appState.CONFIG — nunca hacer una copia local.

const CONFIG = {
  ventas_activas: true,
  precio_codigo:  3750,
  aviso_texto:    '',
  aviso_color:    'gold',
  correo_pie:     '',
  ganador:        { activo: false, codigo: '', nombre: '' }
};

module.exports = { CONFIG };