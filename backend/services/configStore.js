// services/configStore.js
// Fuente única de verdad para la configuración de la dinámica.
// Lee/escribe en la tabla `config` de Supabase y mantiene sincronizado
// el estado en memoria (services/appState.js) que usan admin.js y
// crear-transaccion.js para no tener que consultar Supabase en cada compra.
const supabase = require('../config/supabase');
const { CONFIG } = require('./appState');

// Claves que se persisten en la tabla `config` (clave/valor JSON)
const CLAVES_SIMPLES = [
  'ventas_activas', 'precio_codigo', 'precio_dorado', 'premio_total',
  'premio_imagen', 'nombre_dinamica', 'total_numeros',
  'aviso_texto', 'aviso_color', 'correo_pie'
];

async function leerTodaLaConfig() {
  const { data, error } = await supabase.from('config').select('clave, valor');
  if (error) throw error;
  const cfg = {};
  (data || []).forEach(r => {
    try { cfg[r.clave] = JSON.parse(r.valor); }
    catch (e) { cfg[r.clave] = r.valor; }
  });
  return cfg;
}

async function guardarClave(clave, valor) {
  const valorStr = typeof valor === 'string' ? valor : JSON.stringify(valor);
  const { error } = await supabase
    .from('config')
    .upsert({ clave, valor: valorStr }, { onConflict: 'clave' });
  if (error) throw error;
}

// ── Carga inicial: se llama una vez al arrancar el servidor ──────────────
async function cargarConfigInicial() {
  try {
    const cfg = await leerTodaLaConfig();
    CLAVES_SIMPLES.forEach(clave => {
      if (cfg[clave] !== undefined) CONFIG[clave] = cfg[clave];
    });
    if (cfg.ganador) CONFIG.ganador = cfg.ganador;
    console.log('⚙️ Config cargada desde Supabase:', {
      precio_codigo: CONFIG.precio_codigo,
      precio_dorado: CONFIG.precio_dorado,
      total_numeros: CONFIG.total_numeros,
      nombre_dinamica: CONFIG.nombre_dinamica
    });
  } catch (e) {
    console.error('❌ No se pudo cargar config inicial desde Supabase, usando valores por defecto:', e.message);
  }
}

// ── Actualiza una o más claves: guarda en Supabase Y en memoria ──────────
async function actualizarConfig(cambios) {
  const aplicados = {};
  for (const clave of Object.keys(cambios)) {
    if (!CLAVES_SIMPLES.includes(clave)) continue;
    const valor = cambios[clave];
    await guardarClave(clave, valor);
    CONFIG[clave] = valor;
    aplicados[clave] = valor;
  }
  return aplicados;
}

module.exports = { cargarConfigInicial, actualizarConfig, leerTodaLaConfig, guardarClave };