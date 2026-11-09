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

// Pages: ?key= in the URL. A missing or wrong key gets a friendly page, never the key back.
const page = (keyName) => (req, res, next) => {
  if (ok(keyName, req.query.key)) return next();
  res.status(401).type('html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Key needed</title>
</head>
<body>
  <main>
    <h1>Key needed</h1>
    <p>This page needs the staff or speaker key in the link — ask the organizer.</p>
    <p><a href="/org">Organizer overview</a></p>
  </main>
</body>
</html>`);
};

module.exports = { ok, api, page };
