// routes/config.js
const express = require('express');
const router  = express.Router();
const supabase = require('../config/supabase');
const ExcelJS  = require('exceljs');
const {
  cerrarEventoYArchivar,
  listarEventosHistorial,
  obtenerEventoHistorial
} = require('../services/eventos');
const { actualizarConfig } = require('../services/configStore');
const { CONFIG } = require('../services/appState');

function authAdmin(req, res, next) {
  const token  = req.headers['x-admin-token'] || req.query.token;
  const SECRET = process.env.ADMIN_SECRET;
  if (!SECRET) return res.status(500).json({ error: 'ADMIN_SECRET no configurado' });
  if (!token || token !== SECRET) return res.status(401).json({ error: 'No autorizado' });
  next();
}

// ════════════════════════════════════════════════════════════════════════════
// GET /api/ganadores-historial — PÚBLICO, sin auth. Muestra dinámicas
// anteriores que ya tuvieron un ganador publicado, para generar confianza en
// nuevos compradores. Solo expone lo necesario (nunca compras/códigos crudos).
// ════════════════════════════════════════════════════════════════════════════
router.get('/ganadores-historial', async (req, res) => {
  try {
    const eventos = await listarEventosHistorial();
    const conGanador = eventos
      .filter(e => e.resumen?.ganador?.activo && e.resumen.ganador.codigo)
      .slice(0, 12) // los últimos 12, la lista puede crecer mucho con el tiempo
      .map(e => ({
        id:              e.id,
        nombre_dinamica: e.nombre,
        fecha:           e.fecha_cierre,
        codigo_ganador:  e.resumen.ganador.codigo,
        nombre_ganador:  e.resumen.ganador.nombre
      }));

    // El premio real de cada dinámica vive en el snapshot de config guardado
    // al cerrar el evento, no en "resumen" — se busca solo para los que sí
    // tienen ganador, para no traer de más.
    const idsNecesarios = conGanador.map(e => e.id);
    let premiosPorId = {};
    if (idsNecesarios.length) {
      const { data: llenos } = await supabase
        .from('eventos_historial')
        .select('id, config')
        .in('id', idsNecesarios);
      (llenos || []).forEach(e => {
        premiosPorId[e.id] = {
          premio_total:  e.config?.premio_total ?? null,
          premio_imagen: e.config?.premio_imagen ?? ''
        };
      });
    }

    const resultado = conGanador.map(e => ({
      ...e,
      premio_total:  premiosPorId[e.id]?.premio_total ?? null,
      premio_imagen: premiosPorId[e.id]?.premio_imagen ?? ''
    }));

    res.json({ ganadores: resultado });
  } catch (e) {
    console.error('❌ Error obteniendo ganadores históricos:', e.message);
    res.status(500).json({ ganadores: [] });
  }
});

// ── Helpers Supabase ──────────────────────────────────────────────────────────
async function leerConfig() {
  const { data, error } = await supabase
    .from('config')
    .select('clave, valor');
  if (error) throw error;
  const cfg = {};
  (data || []).forEach(r => {
    try { cfg[r.clave] = JSON.parse(r.valor); }
    catch(e) { cfg[r.clave] = r.valor; }
  });
  return cfg;
}

async function guardarConfig(clave, valor) {
  const valorStr = typeof valor === 'string' ? valor : JSON.stringify(valor);
  const { error } = await supabase
    .from('config')
    .upsert({ clave, valor: valorStr }, { onConflict: 'clave' });
  if (error) throw error;
}

// ── Ganador desde Supabase ────────────────────────────────────────────────────
async function leerGanador() {
  try {
    const { data, error } = await supabase
      .from('config')
      .select('valor')
      .eq('clave', 'ganador')
      .single();
    if (error || !data) return { activo: false, codigo: '', nombre: '' };
    return JSON.parse(data.valor);
  } catch(e) {
    return { activo: false, codigo: '', nombre: '' };
  }
}

async function guardarGanador(ganador) {
  const { error } = await supabase
    .from('config')
    .upsert(
      { clave: 'ganador', valor: JSON.stringify(ganador) },
      { onConflict: 'clave' }
    );
  if (error) throw error;
}

// ════════════════════════════════════════════════════════════════════════════
// GET /api/config  — PÚBLICO
// ════════════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════════════
// GET /api/ganadores-historial  — ganadores de dinámicas anteriores (público)
// Solo expone lo necesario para mostrar confianza (nombre, premio, ganador,
// fecha). NUNCA expone la lista de compradores ni sus datos personales.
// ════════════════════════════════════════════════════════════════════════════
router.get('/ganadores-historial', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('eventos_historial')
      .select('id, nombre, resumen, config, created_at')
      .order('created_at', { ascending: false })
      .limit(12);

    if (error) return res.status(500).json({ ok: false, error: error.message });

    const ganadores = (data || [])
      .filter(ev => ev.resumen?.ganador?.activo)
      .map(ev => ({
        nombre_ganador:  ev.resumen.ganador.nombre,
        codigo_ganador:  ev.resumen.ganador.codigo,
        nombre_dinamica: ev.config?.nombre_dinamica || ev.nombre,
        fecha:           ev.created_at,
        premio_total:    ev.config?.premio_total ?? null,
        premio_imagen:   ev.config?.premio_imagen ?? null
      }));

    res.json({ ok: true, ganadores });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/config', async (req, res) => {
  try {
    let cfg = {};
    try { cfg = await leerConfig(); } catch(e) {}

    const precioCodigo = cfg.precio_codigo ?? 3750;
    const paquetes     = cfg.paquetes ?? [
      { cantidad: 4,  popular: false },
      { cantidad: 8,  popular: true  },
      { cantidad: 16, popular: false }
    ];
    const banner        = cfg.banner       ?? null;
    const premioTotal   = cfg.premio_total ?? 15000000;
    const ganador       = cfg.ganador      ?? { activo: false, codigo: '', nombre: '' };
    const ventasActivas = cfg.ventas_activas !== undefined ? cfg.ventas_activas : true;
    const avisoTexto    = cfg.aviso_texto  ?? '';
    const avisoColor    = cfg.aviso_color  ?? 'gold';
    const precioDorado  = cfg.precio_dorado   ?? 500000;
    const premioImagen  = cfg.premio_imagen   ?? '';
    const nombreDinamica = cfg.nombre_dinamica ?? 'Dinámica';
    const totalNumeros  = cfg.total_numeros   ?? 10000;

    const paquetesConPrecio = paquetes.map(p => ({
      ...p,
      precio: p.cantidad * precioCodigo
    }));

    res.json({
      ventas_activas: ventasActivas,
      aviso_texto:    avisoTexto,
      aviso_color:    avisoColor,
      precioCodigo,
      precioDorado,
      paquetes: paquetesConPrecio,
      banner,
      ganador,
      premioTotal,
      premioImagen,
      nombreDinamica,
      totalNumeros
    });
  } catch (e) {
    console.error('❌ Error en /config:', e.message);
    res.json({
      ventas_activas: true,
      aviso_texto:    '',
      aviso_color:    'gold',
      precioCodigo: 3750,
      paquetes: [
        { cantidad: 4,  popular: false, precio: 15000 },
        { cantidad: 8,  popular: true,  precio: 30000 },
        { cantidad: 16, popular: false, precio: 60000 }
      ],
      banner:    null,
      ganador:   { activo: false, codigo: '', nombre: '' },
      premioTotal: 15000000,
      precioDorado: 500000,
      premioImagen: '',
      nombreDinamica: 'Dinámica',
      totalNumeros: 10000
    });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// POST /api/admin/config/ganador  — guarda ganador en Supabase
// ════════════════════════════════════════════════════════════════════════════
const { enviarCorreoGanador } = require('../services/correo');

router.post('/admin/config/ganador', authAdmin, async (req, res) => {
  try {
    const { activo, codigo, nombre } = req.body;

    if (activo === false || activo === 'false') {
      const oculto = { activo: false, codigo: '', nombre: '' };
      await guardarGanador(oculto);
      CONFIG.ganador = oculto;
      console.log('🏆 Ganador ocultado');
      return res.json({ ok: true, mensaje: 'Ganador ocultado' });
    }

    if (!codigo || !nombre) {
      return res.status(400).json({ ok: false, error: 'Código y nombre son obligatorios' });
    }

    const ganador = { activo: true, codigo: codigo.trim(), nombre: nombre.trim() };
    await guardarGanador(ganador);
    CONFIG.ganador = ganador;
    console.log(`🏆 Ganador publicado: ${codigo} — ${nombre}`);

    // Enviar correo al ganador con su código y el premio real de la dinámica,
    // buscando su email guardado en la tabla codigos por el código ganador.
    let correoEnviado = false;
    try {
      const { data: fila } = await supabase
        .from('codigos').select('email').eq('codigo', codigo.trim()).maybeSingle();
      if (fila?.email) {
        await enviarCorreoGanador(fila.email, nombre.trim(), codigo.trim(), CONFIG.premio_total);
        correoEnviado = true;
      } else {
        console.warn(`⚠️ No se encontró correo para el código ${codigo} — no se envió correo al ganador`);
      }
    } catch (eCorreo) {
      console.error('❌ Error enviando correo al ganador:', eCorreo.message);
    }

    res.json({ ok: true, mensaje: `Ganador publicado: ${codigo}`, correoEnviado });
  } catch (e) {
    console.error('❌ Error guardando ganador:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// POST /api/admin/config/precios
// ════════════════════════════════════════════════════════════════════════════
router.post('/admin/config/precios', authAdmin, async (req, res) => {
  try {
    const { precioCodigo, paquetes, premioTotal } = req.body;
    if (!precioCodigo || precioCodigo < 100)
      return res.status(400).json({ error: 'Precio por código inválido (mínimo $100)' });
    if (!Array.isArray(paquetes) || paquetes.length === 0)
      return res.status(400).json({ error: 'Debes tener al menos 1 paquete' });

    await guardarConfig('paquetes', paquetes);
    const cambios = { precio_codigo: precioCodigo };
    if (premioTotal) cambios.premio_total = premioTotal;
    await actualizarConfig(cambios); // guarda en Supabase Y sincroniza appState.CONFIG

    console.log(`⚙️ Precios actualizados: $${precioCodigo}/código`);
    res.json({ ok: true, mensaje: 'Precios y paquetes actualizados correctamente' });
  } catch (e) {
    console.error('❌ Error guardando precios:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// POST /api/admin/config/banner
// ════════════════════════════════════════════════════════════════════════════
router.post('/admin/config/banner', authAdmin, async (req, res) => {
  try {
    const { activo, texto, color } = req.body;
    if (activo && (!texto || !texto.trim()))
      return res.status(400).json({ error: 'El texto del banner es requerido' });
    await guardarConfig('banner', { activo: !!activo, texto: texto?.trim() || '', color: color || 'gold' });
    console.log(`📢 Banner ${activo ? 'activado' : 'desactivado'}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('❌ Error guardando banner:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// NOTA: GET /api/admin/config es manejado por routes/admin.js (devuelve el
// estado en memoria appState.CONFIG, ya sincronizado con Supabase por
// services/configStore.js). No se registra aquí de nuevo para evitar que
// Express use la primera ruta registrada y esta quede sin usarse.

// ════════════════════════════════════════════════════════════════════════════
// EVENTOS — archivar el evento actual y dejar todo en cero
// ════════════════════════════════════════════════════════════════════════════

// POST /api/admin/eventos/cerrar — guarda todo en el historial y reinicia
router.post('/admin/eventos/cerrar', authAdmin, async (req, res) => {
  try {
    const { nombre, nuevaDinamica } = req.body;

    if (nuevaDinamica?.cantidad_numeros) {
      const cant = Number(nuevaDinamica.cantidad_numeros);
      if (!Number.isInteger(cant) || cant < 10 || cant > 1000000) {
        return res.status(400).json({ ok: false, error: 'Cantidad de números inválida (entre 10 y 1.000.000)' });
      }
    }

    const evento = await cerrarEventoYArchivar(nombre, nuevaDinamica);
    console.log(`🗄️ Evento archivado y reiniciado: ${evento.nombre}`);
    res.json({ ok: true, evento });
  } catch (e) {
    console.error('❌ Error cerrando evento:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/admin/eventos — lista de eventos archivados (para el panel)
router.get('/admin/eventos', authAdmin, async (req, res) => {
  try {
    const eventos = await listarEventosHistorial();
    res.json({ ok: true, eventos });
  } catch (e) {
    console.error('❌ Error listando eventos:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/admin/eventos/:id — detalle completo de un evento archivado
router.get('/admin/eventos/:id', authAdmin, async (req, res) => {
  try {
    const evento = await obtenerEventoHistorial(req.params.id);
    res.json({ ok: true, evento });
  } catch (e) {
    console.error('❌ Error obteniendo evento:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/admin/eventos/:id/exportar — Excel con compras y códigos del evento
router.get('/admin/eventos/:id/exportar', authAdmin, async (req, res) => {
  try {
    const evento = await obtenerEventoHistorial(req.params.id);
    if (!evento) return res.status(404).json({ ok: false, error: 'Evento no encontrado' });

    const wb = new ExcelJS.Workbook();

    const wsCompras = wb.addWorksheet('Compras');
    wsCompras.columns = [
      { header: 'Referencia', key: 'referencia', width: 30 },
      { header: 'Nombre',     key: 'nombre',     width: 26 },
      { header: 'Correo',     key: 'correo',     width: 30 },
      { header: 'Cédula',     key: 'cedula',     width: 14 },
      { header: 'Teléfono',   key: 'telefono',   width: 14 },
      { header: 'Cantidad',   key: 'cantidad',   width: 10 },
      { header: 'Estado',     key: 'estado',     width: 14 },
      { header: 'Fecha',      key: 'fecha',      width: 22 }
    ];
    wsCompras.getRow(1).font = { bold: true };
    (evento.compras || []).forEach(c => wsCompras.addRow(c));

    const wsCodigos = wb.addWorksheet('Códigos vendidos');
    wsCodigos.columns = [
      { header: 'Código',     key: 'codigo',     width: 14 },
      { header: 'Dorado',     key: 'dorado',     width: 10 },
      { header: 'Referencia', key: 'referencia', width: 30 },
      { header: 'Nombre',     key: 'nombre',     width: 26 },
      { header: 'Email',      key: 'email',      width: 30 },
      { header: 'Teléfono',   key: 'telefono',   width: 14 }
    ];
    wsCodigos.getRow(1).font = { bold: true };
    (evento.codigos || []).forEach(c => wsCodigos.addRow(c));

    const safeName = evento.nombre.replace(/[^a-z0-9]+/gi, '_').slice(0, 40);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=evento_${safeName}.xlsx`);
    await wb.xlsx.write(res); res.end();
  } catch (e) {
    console.error('❌ Error exportando evento:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;