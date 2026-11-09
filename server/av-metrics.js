// AV console metrics: GET /api/metrics?room=<id> (TECH_KEY).
// Shows the series this pod records for Dash0 (server/otel.js keeps a local mirror of them), so the
// tech sees service health without leaving the console. The values are local; nothing is read back
// from Dash0. Also registers the process, socket and Elasticsearch gauges, which go to Dash0 too.
const { monitorEventLoopDelay } = require('perf_hooks');
const otel = require('./otel');

const ROLES = ['attendee', 'viewer', 'mic', 'present', 'tech', 'org'];
const LOOP_RESOLUTION_MS = 10;
const ES_FIELDS = ['writes', 'writeErrors', 'searches', 'searchErrors', 'queued', 'dropped', 'lastWriteMs', 'lastSearchMs', 'lastErrorAt'];

let ctx = null;
let registered = false;
let loop = null;
let lag = null; // {p99, max} seconds over the last 5 s window

function startLoopMonitor() {
  if (loop) return;
  try {
    loop = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
    loop.enable();
    const timer = setInterval(() => {
      try {
        const floor = LOOP_RESOLUTION_MS * 1e6; // the histogram includes the sampling interval itself
        lag = { p99: Math.max(0, loop.percentile(99) - floor) / 1e9, max: Math.max(0, loop.max - floor) / 1e9 };
        loop.reset();
      } catch (_) {}
    }, 5000);
    if (timer.unref) timer.unref();
  } catch (_) {
    loop = null;
  }
}

function roomIds() {
  return ctx && ctx.state && ctx.state.rooms ? [...ctx.state.rooms.keys()].map(String) : [];
}

function esStats() {
  try {
    const es = ctx && ctx.es;
    const raw = es && typeof es.stats === 'function' ? es.stats() : null;
    const enabled = Boolean(raw ? raw.enabled : es && es.enabled);
    const out = { enabled };
    for (const f of ES_FIELDS) out[f] = raw && typeof raw[f] === 'number' && Number.isFinite(raw[f]) ? raw[f] : null;
    return out;
  } catch (_) {
    return { enabled: false };
  }
}

function esGauge(field) {
  return () => {
    const s = esStats();
    return s.enabled && s[field] !== null && s[field] !== undefined ? s[field] : [];
  };
}

function perRoom(fn) {
  return () => {
    const points = [];
    for (const id of roomIds()) {
      const value = fn(id);
      if (typeof value === 'number') points.push({ value, attributes: { 'pulse.room': id } });
    }
    return points;
  };
}

function registerGauges() {
  if (registered) return;
  registered = true;
  const hub = ctx.hub;

  otel.observableGauge('pulse.audio.listeners', 'Open listen-in audio sockets per room', perRoom((id) => {
    try { return require('./audio').outCount(id); } catch (_) { return undefined; }
  }), '{socket}');

  otel.observableGauge('pulse.tickets.open', 'Open, reopened or claimed tickets per room', perRoom((id) => {
    try { return require('./tickets').openTickets(id); } catch (_) { return undefined; }
  }), '{ticket}');

  otel.observableGauge('pulse.ws.connections', 'Open WebSocket connections by role', () => {
    if (!hub || typeof hub.roleCount !== 'function') return [];
    const ids = roomIds();
    return ROLES.map((role) => {
      let n = 0;
      for (const id of ids) n += hub.roleCount(id, role);
      return { value: n, attributes: { 'pulse.role': role } };
    });
  }, '{connection}');

  otel.observableGauge('process.memory.usage', 'Resident set size', () => process.memoryUsage().rss, 'By');
  otel.observableGauge('v8js.memory.heap.used', 'V8 heap in use', () => process.memoryUsage().heapUsed, 'By');
  otel.observableGauge('nodejs.eventloop.delay.p99', 'Event loop delay, 99th percentile over the last 5 s', () => (lag ? lag.p99 : []), 's');
  otel.observableGauge('nodejs.eventloop.delay.max', 'Event loop delay, maximum over the last 5 s', () => (lag ? lag.max : []), 's');

  otel.observableGauge('pulse.es.writes', 'Elasticsearch writes since start', esGauge('writes'), '{write}');
  otel.observableGauge('pulse.es.write_errors', 'Elasticsearch writes that failed since start', esGauge('writeErrors'), '{write}');
  otel.observableGauge('pulse.es.search_errors', 'Elasticsearch searches that failed since start', esGauge('searchErrors'), '{search}');
  otel.observableGauge('pulse.es.queue.depth', 'Elasticsearch writes waiting to be sent', esGauge('queued'), '{write}');
  otel.observableGauge('pulse.es.dropped', 'Elasticsearch writes dropped since start', esGauge('dropped'), '{write}');
  otel.observableGauge('pulse.es.last_write.duration', 'Duration of the last Elasticsearch write', esGauge('lastWriteMs'), 'ms');
}

function dashUrl() {
  const url = String((ctx && ctx.config && ctx.config.DASH0_URL) || '');
  return /^https?:\/\/[^\s]+$/i.test(url) ? url : null;
}

function body(room) {
  const snap = otel.snapshot(room);
  const { export: exp, ...rest } = snap;
  return {
    at: snap.at,
    room,
    dash0: {
      enabled: exp.enabled,
      startFailed: exp.startFailed,
      endpointHost: exp.endpointHost,
      lastExportAt: exp.lastExportAt,
      lastExportOk: exp.lastExportOk,
      exportFailures: exp.exportFailures,
      traces: exp.traces,
      url: dashUrl(),
    },
    service: rest.service,
    es: esStats(),
    series: rest.series,
  };
}

module.exports = {
  register(app, c) {
    ctx = c;
    startLoopMonitor();
    registerGauges();
    app.get('/api/metrics', ctx.auth.api('TECH_KEY'), (req, res) => {
      res.set('Cache-Control', 'no-store');
      const q = typeof req.query.room === 'string' ? req.query.room.slice(0, 64) : '';
      try {
        res.json(body(q || null));
      } catch (_) {
        res.status(500).json({ error: 'metrics_unavailable' });
      }
    });
  },
  _test: { body, esStats },
};
