// Pulse server entry. One pod, all live state in memory (see CONTRACT.md).
// Each feature lives in its own module exporting register(app, ctx); this file only wires them.
const http = require('http');
const path = require('path');
const express = require('express');

const config = require('./config');
const log = require('./log');
const state = require('./state');
const auth = require('./auth');
const otel = require('./otel');
const es = require('./es');
const hub = require('./hub');
const audio = require('./audio');
const tickets = require('./tickets');
const talks = require('./talks');
const questions = require('./questions');
const qr = require('./qr');
const booths = require('./booths');
const schedule = require('./schedule');
const mockroom = require('./mockroom');
const stats = require('./stats');
const signin = require('./signin');
const retention = require('./es-retention');
const privacy = require('./privacy');
const metrics = require('./metrics');
const avMetrics = require('./av-metrics');

otel.start();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

// Mic lock: only the podium mic page may ask for the microphone.
app.use((req, res, next) => {
  let p = req.path;
  try { p = path.posix.normalize(decodeURIComponent(req.path)).replace(/\/+/g, '/').toLowerCase(); } catch {}
  // /go/:room is the one-button control page: it runs the same podium mic.
  const isMic = p.startsWith('/mic/') || p.startsWith('/go/');
  res.setHeader('Permissions-Policy', isMic ? 'microphone=(self), camera=()' : 'microphone=(), camera=()');
  next();
});

// Ids from the public: room/booth ids are short slugs, clientIds are short random ids (security audit:
// unbounded ids were stored forever). Rejected before any route creates state.
const ROOM_RE = /^[A-Za-z0-9_-]{1,32}$/;
app.use((req, res, next) => {
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const room = b.room ?? req.query.room;
  if (room != null && !ROOM_RE.test(String(room))) return res.status(400).json({ error: 'bad room id' });
  const cid = b.clientId ?? req.query.clientId;
  if (cid != null && String(cid).length > 64) return res.status(400).json({ error: 'bad clientId' });
  next();
});
app.param('room', (req, res, next, v) => (ROOM_RE.test(v) ? next() : res.status(400).json({ error: 'bad room id' })));

app.get('/healthz', (req, res) => res.type('text').send('ok'));
// Browsers still probe /favicon.ico; point them at the SVG instead of 404ing.
app.get('/favicon.ico', (req, res) => res.redirect(301, '/favicon.svg'));

// Public browser config: ingest-only Dash0 token, never the OTLP auth secret.
app.get('/rum-config.js', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.type('application/javascript');
  if (!config.DASH0_RUM_TOKEN) return res.send('window.PULSE_RUM = null;');
  const body = JSON.stringify({
    serviceName: 'pulse-web',
    endpoint: config.DASH0_RUM_ENDPOINT,
    token: config.DASH0_RUM_TOKEN,
  }).replace(/</g, '\\u003c');
  return res.send(`window.PULSE_RUM = ${body};`);
});

const pub = path.join(__dirname, '..', 'public');
const page = (file) => (req, res) => res.sendFile(path.join(pub, file));
// Counts the scan (server-issued visitor cookie), then the sign-in form until this phone has signed in.
app.get('/r/:room', stats.scan, signin.gate, page('r.html'));
app.get('/t/:talkId', page('t.html'));
app.get('/room/:room', page('t.html'));
app.get('/org', page('org.html'));
app.get('/tech', auth.page('TECH_KEY'), page('tech.html'));
app.get('/b/:booth', page('b.html'));
app.get('/booth/:booth', auth.page('BOOTH_KEY'), page('booth.html')); // booth staff: their own key, no sign-ins
app.get('/find', page('find.html'));
app.get('/privacy', page('privacy.html'));
app.get('/cards', page('cards.html'));
app.get('/mic/:room', auth.page('SPEAKER_KEY'), page('mic.html'));
app.get('/present/:room', auth.page('SPEAKER_KEY'), page('present.html'));
app.get('/relay/:room', auth.page('SPEAKER_KEY'), page('relay.html'));
app.get('/go/:room', auth.page('SPEAKER_KEY'), page('go.html'));
// Keyed pages are reachable only through their routes above, never as static files.
const keyedFiles = /^\/(tech|mic|present|booth|relay|go)(\.html)?\/?$/i;
app.use((req, res, next) => {
  let p;
  try { p = path.posix.normalize(decodeURIComponent(req.path)).replace(/\/+/g, '/'); } catch { return res.status(400).end(); }
  return keyedFiles.test(p) ? res.status(404).end() : next();
});
app.use(express.static(pub, { extensions: ['html'], index: false }));

const ctx = { config, state, auth, es, hub, otel };
// signin first: its guards on votes/questions/feedback must run before those routes.
for (const m of [signin, tickets, talks, questions, booths, qr, schedule, privacy, metrics, avMetrics, mockroom, stats, retention]) m.register(app, ctx);

const server = http.createServer(app);
hub.attach(server, ctx);
audio.attach(server, ctx);

// Route WebSocket upgrades by path; anything unknown is refused.
server.on('upgrade', (req, socket, head) => {
  let pathname;
  try { ({ pathname } = new URL(req.url, 'http://x')); } catch { return socket.destroy(); }
  const target = pathname === '/ws' ? hub : pathname.startsWith('/ws/audio-') ? audio : null;
  if (!target) return socket.destroy();
  target.handleUpgrade(req, socket, head);
});

server.listen(config.PORT, () => log.info('server.listening', { port: config.PORT }));
module.exports = { app, server };
