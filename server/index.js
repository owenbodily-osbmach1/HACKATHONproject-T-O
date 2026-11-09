// Pulse server entry. One pod, all live state in memory (see CONTRACT.md).
// Each feature lives in its own module exporting register(app, ctx); this file only wires them.
const http = require('http');
const path = require('path');
const express = require('express');

const config = require('./config');
const state = require('./state');
const auth = require('./auth');
const otel = require('./otel');
const es = require('./es');
const hub = require('./hub');
const audio = require('./audio');
const tickets = require('./tickets');
const talks = require('./talks');
const questions = require('./questions');

otel.start();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

// Mic lock: only the podium mic page may ask for the microphone.
app.use((req, res, next) => {
  const isMic = req.path.startsWith('/mic/');
  res.setHeader('Permissions-Policy', isMic ? 'microphone=(self), camera=()' : 'microphone=(), camera=()');
  next();
});

app.get('/healthz', (req, res) => res.type('text').send('ok'));

const pub = path.join(__dirname, '..', 'public');
const page = (file) => (req, res) => res.sendFile(path.join(pub, file));
app.get('/r/:room', page('r.html'));
app.get('/t/:talkId', page('t.html'));
app.get('/room/:room', page('t.html'));
app.get('/org', page('org.html'));
app.get('/tech', auth.page('TECH_KEY'), page('tech.html'));
app.get('/mic/:room', auth.page('SPEAKER_KEY'), page('mic.html'));
app.get('/present/:room', auth.page('SPEAKER_KEY'), page('present.html'));
// Keyed pages are reachable only through their routes above, never as static files.
const keyedFiles = /^\/(tech|mic|present)(\.html)?$/i;
app.use((req, res, next) => (keyedFiles.test(req.path) ? res.status(404).end() : next()));
app.use(express.static(pub, { extensions: ['html'], index: false }));

const ctx = { config, state, auth, es, hub, otel };
for (const m of [tickets, talks, questions]) m.register(app, ctx);

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

server.listen(config.PORT, () => console.log(`pulse listening on :${config.PORT}`));
module.exports = { app, server };
