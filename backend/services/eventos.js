// services/eventos.js
// Archiva la dinámica/evento actual (compras, códigos vendidos, ganador y
// config) en la tabla `eventos_historial` y deja las tablas activas listas
// para arrancar un evento nuevo.
const supabase = require('../config/supabase');
const { CONFIG } = require('./appState');

// Campos que se limpian en cada código que estaba vendido, para devolverlo
// al pool disponible. El pool de códigos (0000-9999) NUNCA se borra, solo
// se resetea su estado.
const RESET_CODIGO = {
  vendido:       false,
  dorado:        false,
  referencia:    null,
  premio_dorado: null,
  nombre:        null,
  email:         null,
  telefono:      null
};

async function leerConfigCompleta() {
  const { data, error } = await supabase.from('config').select('clave, valor');
  if (error) throw error;
  const cfg = {};
  (data || []).forEach(r => {
    try { cfg[r.clave] = JSON.parse(r.valor); }
    catch (e) { cfg[r.clave] = r.valor; }
  });
  return cfg;
}

function construirResumen(compras, codigosVendidos, ganador, precioCodigo) {
  const pagadas = (compras || []).filter(c => ['pagado', 'transferencia_aprobada'].includes(c.estado));
  const codigosVendidosCount = pagadas.reduce((s, c) => s + (c.cantidad || 0), 0);
  return {
    total_compras:              (compras || []).length,
    compras_pagadas:            pagadas.length,
    codigos_vendidos:           codigosVendidosCount,
    ingresos:                   codigosVendidosCount * (precioCodigo || 0),
    codigos_dorados_entregados: (codigosVendidos || []).filter(c => c.dorado).length,
    ganador:                    ganador || { activo: false, codigo: '', nombre: '' }
  };
}

// ── Cierra el evento actual: archiva todo y deja las tablas activas en cero ──
async function cerrarEventoYArchivar(nombre) {
  // 1. Leer todo lo que está activo ahora mismo
  const { data: compras, error: errCompras } = await supabase.from('compras').select('*');
  if (errCompras) throw errCompras;

  const { data: codigosVendidos, error: errCodigos } = await supabase
    .from('codigos').select('*').eq('vendido', true);
  if (errCodigos) throw errCodigos;

  const { data: promos, error: errPromos } = await supabase.from('promociones').select('*');
  if (errPromos) throw errPromos;

  const cfg = await leerConfigCompleta();
  const ganador = cfg.ganador || { activo: false, codigo: '', nombre: '' };
  const precioCodigo = cfg.precio_codigo ?? CONFIG.precio_codigo ?? 3750;

  const resumen = construirResumen(compras, codigosVendidos, ganador, precioCodigo);
  const nombreFinal = (nombre && nombre.trim())
    ? nombre.trim()
    : `Evento cerrado ${new Date().toLocaleString('es-CO')}`;

  // 2. Guardar snapshot completo en el historial
  const { data: evento, error: errInsert } = await supabase
    .from('eventos_historial')
    .insert({
      nombre:      nombreFinal,
      resumen,
      compras:     compras || [],
      codigos:     codigosVendidos || [],
      ganador,
      config:      cfg,
      promociones: promos || []
    })
    .select()
    .single();
  if (errInsert) throw errInsert;

  // 3. Vaciar la tabla de compras (todo quedó guardado en el historial)
  const { error: errDelCompras } = await supabase.from('compras').delete().not('fecha', 'is', null);
  if (errDelCompras) throw errDelCompras;

  // 4. Resetear el pool de códigos (no se borra, solo se libera lo vendido)
  const { error: errResetCodigos } = await supabase
    .from('codigos').update(RESET_CODIGO).eq('vendido', true);
  if (errResetCodigos) throw errResetCodigos;

  // 5. Desactivar cualquier promoción vigente
  await supabase.from('promociones').update({ activa: false }).eq('activa', true);

  // 6. Resetear ganador y banner en la config de Supabase
  await supabase.from('config').upsert([
    { clave: 'ganador', valor: JSON.stringify({ activo: false, codigo: '', nombre: '' }) },
    { clave: 'banner',  valor: JSON.stringify({ activo: false, texto: '', color: 'gold' }) }
  ], { onConflict: 'clave' });

  // 7. Resetear el estado en memoria (services/appState.js), usado por admin.js
  CONFIG.ganador     = { activo: false, codigo: '', nombre: '' };
  CONFIG.aviso_texto = '';

  return evento;
}

async function listarEventosHistorial() {
  const { data, error } = await supabase
    .from('eventos_historial')
    .select('id, nombre, fecha_cierre, resumen')
    .order('fecha_cierre', { ascending: false });
  if (error) throw error;
  return data || [];
}

async function obtenerEventoHistorial(id) {
  const { data, error } = await supabase
    .from('eventos_historial').select('*').eq('id', id).single();
  if (error) throw error;
  return data;
}

module.exports = { cerrarEventoYArchivar, listarEventosHistorial, obtenerEventoHistorial };