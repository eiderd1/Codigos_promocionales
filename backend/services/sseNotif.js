// services/sseNotif.js
const clientes = new Set();

function agregarCliente(req, res) {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write('retry: 5000\n');
  res.write('event: ping\ndata: ok\n\n');

  clientes.add(res);

  const hb = setInterval(() => {
    try { res.write(': hb\n\n'); } catch (_) {}
  }, 25000);

  req.on('close', () => {
    clearInterval(hb);
    clientes.delete(res);
  });
}

function emitir(evento, datos) {
  if (!clientes.size) return;
  const msg = `event: ${evento}\ndata: ${JSON.stringify(datos || {})}\n\n`;
  for (const res of clientes) {
    try { res.write(msg); } catch (_) { clientes.delete(res); }
  }
}

module.exports = { agregarCliente, emitir };