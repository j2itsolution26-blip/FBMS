'use strict';
/**
 * Real-time fan-out to KDS, queue boards and POS terminals via Server-Sent
 * Events. Payloads are deliberately minimal (id, number, statuses) because
 * the stream is public for the customer-facing board; clients re-fetch
 * details over authenticated endpoints.
 */
const { EventEmitter } = require('node:events');

function createEventBus() {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  const clients = new Set();

  function publish(type, order) {
    const payload = { type, id: order.id, order_no: order.order_no, status: order.status, kitchen_status: order.kitchen_status, source: order.source, at: Date.now() };
    emitter.emit('event', payload);
    const frame = `event: order\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of clients) res.write(frame);
  }

  function subscribe(req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
  }

  function closeAll() { for (const res of clients) res.end(); clients.clear(); }

  return { publish, subscribe, closeAll, on: (fn) => emitter.on('event', fn), get clientCount() { return clients.size; } };
}

module.exports = { createEventBus };
