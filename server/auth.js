// One key mechanism (CONTRACT.md "Auth"): x-pulse-key header for HTTP, ?key= for pages and WebSockets.
const crypto = require('crypto');
const config = require('./config');

function same(a, b) {
  if (!a || !b) return false;
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// keyName: 'TECH_KEY' | 'SPEAKER_KEY' | 'BOOTH_KEY'. An unset key locks the route rather than opening it.
const ok = (keyName, given) => same(given, config[keyName]);

// A real key, but for something else (e.g. the booth key on a tech route): 403, not 401.
const KEYS = ['TECH_KEY', 'SPEAKER_KEY', 'BOOTH_KEY'];
const otherKey = (keyName, given) => KEYS.some((k) => k !== keyName && ok(k, given));

// HTTP API routes: header only.
const api = (keyName) => (req, res, next) => {
  const given = req.get('x-pulse-key');
  if (ok(keyName, given)) return next();
  return otherKey(keyName, given) ? res.status(403).json({ error: 'forbidden' }) : res.status(401).json({ error: 'unauthorized' });
};

// Pages: ?key= in the URL. A missing or wrong key gets a friendly page, never the key back.
const page = (keyName) => (req, res, next) => {
  if (ok(keyName, req.query.key)) return next();
  res.status(otherKey(keyName, req.query.key) ? 403 : 401).type('html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Pulse · Key needed</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <main class="join">
    <span class="wordmark">PULSE</span>
    <h1>Key needed</h1>
    <p class="join-sub">This page needs the staff or speaker key in the link, and the key here is missing or wrong.</p>
    <p class="join-sub">Use the exact link printed by <b>start-pulse</b> (Go live, AV tech, mic, relay): it changes every time Pulse starts. Or ask the organizer.</p>
    <p><a href="/org">Organizer overview</a></p>
  </main>
</body>
</html>`);
};

module.exports = { ok, api, page, otherKey };
