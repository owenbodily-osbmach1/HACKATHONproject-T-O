// Prometheus scrape endpoint (CONTRACT.md "Metrics"). Hand-written text format, no dependency.
// Values come from the same in-memory state the live path uses; replicas: 1.
const boothConfig = require('./booths.json');
const booths = require('./booths');
const tickets = require('./tickets');

const TYPE = 'text/plain; version=0.0.4; charset=utf-8';

function escapeLabel(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function sample(name, labels, value) {
  const pairs = Object.entries(labels || {}).map(([k, v]) => `${k}="${escapeLabel(v)}"`);
  const suffix = pairs.length ? `{${pairs.join(',')}}` : '';
  return `${name}${suffix} ${Number.isFinite(value) ? value : 0}`;
}

// Deterministic order so a scrape reads the same while nothing changes.
function roomIds(ctx) {
  const ids = [];
  for (const room of ctx.state.rooms.values()) {
    ids.push(room && room.room != null ? String(room.room) : String(room));
  }
  return ids.sort();
}

function register(app, ctx) {
  app.get('/metrics', (req, res) => {
    const lines = [];
    const rooms = roomIds(ctx);

    lines.push('# HELP pulse_up 1 when the Pulse process is serving requests');
    lines.push('# TYPE pulse_up gauge');
    lines.push('pulse_up 1');

    lines.push('# HELP pulse_listeners Open attendee sockets per room');
    lines.push('# TYPE pulse_listeners gauge');
    for (const room of rooms) lines.push(sample('pulse_listeners', { room }, ctx.hub.listeners(room)));

    const alerting = rooms.filter((room) => tickets.openTickets(room) > 0).length;
    lines.push('# HELP pulse_rooms_alerting Rooms with an active ticket');
    lines.push('# TYPE pulse_rooms_alerting gauge');
    lines.push(sample('pulse_rooms_alerting', {}, alerting));

    lines.push('# HELP pulse_open_tickets Active tickets per room');
    lines.push('# TYPE pulse_open_tickets gauge');
    for (const room of rooms) lines.push(sample('pulse_open_tickets', { room }, tickets.openTickets(room)));

    lines.push('# HELP pulse_booth_open_requests Requests waiting for booth staff');
    lines.push('# TYPE pulse_booth_open_requests gauge');
    const boothsById = boothConfig.map((b) => String(b.id)).sort();
    for (const id of boothsById) lines.push(sample('pulse_booth_open_requests', { booth: id }, booths.openRequestCount(id)));

    lines.push('# HELP process_resident_memory_bytes Resident memory size in bytes');
    lines.push('# TYPE process_resident_memory_bytes gauge');
    lines.push(sample('process_resident_memory_bytes', {}, process.memoryUsage().rss));

    res.setHeader('Content-Type', TYPE);
    res.setHeader('Cache-Control', 'no-store');
    res.send(lines.join('\n') + '\n');
  });
}

module.exports = { register, _test: { escapeLabel, sample } };
