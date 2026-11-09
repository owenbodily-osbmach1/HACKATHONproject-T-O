// What may leave the pod in telemetry (otel.js). The HTTP auto-instrumentation records the caller's
// IP address, port and user agent, and the full URL with its query string (search terms, clientIds,
// keys). None of that goes to Dash0: those attributes are dropped, and a URL keeps only its path,
// with the route template (/r/:room, /api/clients/:clientId/mute) in place of raw ids when known.
// Applied to every span right before export, so it also covers spans this code doesn't create.

const DROP = new Set([
  'client.address', 'client.port',
  'network.peer.address', 'network.peer.port',
  'net.peer.ip', 'net.peer.name', 'net.peer.port',
  'net.sock.peer.addr', 'net.sock.peer.name', 'net.sock.peer.port',
  'http.client_ip',
  'user_agent.original', 'http.user_agent',
  'url.query',
]);
const DROP_PREFIX = ['http.request.header.', 'http.response.header.'];
const URL_KEYS = ['url.full', 'http.url'];
const PATH_KEYS = ['url.path', 'http.target'];

const pathOnly = (v) => String(v).split(/[?#]/)[0];

function scrubAttributes(attrs) {
  if (!attrs || typeof attrs !== 'object') return attrs;
  const route = typeof attrs['http.route'] === 'string' && attrs['http.route'] ? attrs['http.route'] : null;
  for (const k of Object.keys(attrs)) {
    if (DROP.has(k) || DROP_PREFIX.some((p) => k.startsWith(p))) { delete attrs[k]; continue; }
    if (PATH_KEYS.includes(k)) attrs[k] = route || pathOnly(attrs[k]);
    if (URL_KEYS.includes(k)) {
      try {
        const u = new URL(String(attrs[k]), 'http://x');
        attrs[k] = `${u.protocol}//${u.host}${route || u.pathname}`;
      } catch { attrs[k] = pathOnly(attrs[k]); }
    }
  }
  return attrs;
}

// Wraps a span exporter: every span is scrubbed in place before the real exporter sees it.
function scrubbingExporter(inner) {
  return {
    export(spans, done) {
      for (const s of spans) {
        try { scrubAttributes(s.attributes); } catch { /* never block export */ }
        for (const ev of s.events || []) { try { scrubAttributes(ev.attributes); } catch { /* ignore */ } }
      }
      return inner.export(spans, done);
    },
    shutdown: () => inner.shutdown(),
    forceFlush: () => (inner.forceFlush ? inner.forceFlush() : Promise.resolve()),
  };
}

module.exports = { scrubAttributes, scrubbingExporter, DROP };
