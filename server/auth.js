// One key mechanism (CONTRACT.md "Auth"): x-pulse-key header for HTTP, ?key= for pages and WebSockets.
const crypto = require('crypto');
const config = require('./config');

function same(a, b) {
  if (!a || !b) return false;
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// keyName: 'TECH_KEY' | 'SPEAKER_KEY'. An unset key locks the route rather than opening it.
const ok = (keyName, given) => same(given, config[keyName]);

// HTTP API routes: header only.
const api = (keyName) => (req, res, next) =>
  ok(keyName, req.get('x-pulse-key')) ? next() : res.status(401).json({ error: 'unauthorized' });

// Pages: ?key= in the URL.
const page = (keyName) => (req, res, next) =>
  ok(keyName, req.query.key) ? next() : res.status(401).type('text').send('unauthorized');

module.exports = { ok, api, page };
