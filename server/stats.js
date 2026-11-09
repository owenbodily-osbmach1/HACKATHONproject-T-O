// Room stats + AV telemetry (CONTRACT.md "room_stats", "room_telemetry").
//
// Scans: the server counts them itself. Opening /r/:room sets a random visitor cookie that the
// server issues (`pulse_v`, httpOnly); each room counts the unique visitors it has seen. The phone
// never reports a number. Clearing cookies can inflate the count; it is a headcount, not identity.
// "Here" = open attendee sockets right now (plus the demo room's simulated phones).
// Capacity: per room, ROOM_CAPACITY by default, changed by the tech via POST /api/rooms/:room/settings.
//
// Every 2 s: `room_stats` to every socket in the room (only when it changed), and `room_telemetry`
// to tech/org sockets: what the AV needs to see without walking to the podium.
const crypto = require('crypto');

const DEFAULT_CAPACITY = Number(process.env.ROOM_CAPACITY || 120);
const visitors = new Map(); // room -> Set(visitor id)
const lastStats = new Map(); // room -> JSON of the last room_stats sent
const phoneLog = new Map(); // room -> {left: Map(clientId -> ts), reconnects: [ts]}
let ctx = null;

function cookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return '';
}

// Middleware for GET /r/:room: count this visitor once per room.
function scan(req, res, next) {
  if (req.method !== 'GET') return next();
  let vid = cookie(req, 'pulse_v');
  if (!/^[a-f0-9]{16}$/.test(vid)) {
    vid = crypto.randomBytes(8).toString('hex');
    const https = req.secure || req.get('x-forwarded-proto') === 'https';
    res.append('Set-Cookie', `pulse_v=${vid}; Path=/; Max-Age=86400; HttpOnly; SameSite=Lax${https ? '; Secure' : ''}`);
  }
  const room = String(req.params.room);
  let set = visitors.get(room);
  if (!set) visitors.set(room, (set = new Set()));
  set.add(vid);
  if (ctx) ctx.state.room(room); // a scanned room shows up in /api/rooms even before its talk
  next();
}

function capacityOf(r) {
  const c = Number(r && r.capacity);
  return Number.isFinite(c) && c > 0 ? Math.round(c) : DEFAULT_CAPACITY;
}

function statsFor(id) {
  const r = ctx.state.room(id);
  const sim = r.simulated && r.sim ? r.sim : null;
  const joined = (visitors.get(id)?.size || 0) + (sim ? sim.joined || 0 : 0);
  const here = ctx.hub.listeners(id) + (sim ? sim.here || 0 : 0);
  const capacity = capacityOf(r);
  return { room: id, joined: Math.max(joined, here), here, capacity, fill: capacity ? Math.min(1, here / capacity) : 0 };
}

function statsMessage(id) { return { t: 'room_stats', ...statsFor(id) }; }

// Phone connection log, for "reconnected in the last 5 min" on the AV panel.
function onJoin(room, role, clientId) {
  if (role !== 'attendee' || !clientId) return;
  const log = phoneLog.get(room);
  const left = log && log.left.get(clientId);
  if (left && Date.now() - left < 5 * 60 * 1000) log.reconnects.push(Date.now());
  if (log) log.left.delete(clientId);
}
function onLeave(room, role, clientId) {
  if (role !== 'attendee' || !clientId) return;
  let log = phoneLog.get(room);
  if (!log) phoneLog.set(room, (log = { left: new Map(), reconnects: [] }));
  log.left.set(clientId, Date.now());
  if (log.left.size > 5000) log.left.delete(log.left.keys().next().value);
}

function telemetry(id) {
  const { state, hub } = ctx;
  const audio = require('./audio');
  const r = state.room(id);
  const now = Date.now();
  const talk = state.talkMessage(id);
  const live = talk.status === 'live';
  const sim = r.simulated && r.sim ? r.sim : null;

  const sender = audio.senderInfo ? audio.senderInfo(id) : { connected: false, lastFrameAt: 0 };
  const micFlowing = sender.connected && now - sender.lastFrameAt < 3000;
  const db = Number.isFinite(r.micDb) ? r.micDb : null;
  const micLive = sim ? live : micFlowing;

  const lastCap = Number(r.lastCaptionTs) || 0;
  const capGap = lastCap ? Math.floor((now - lastCap) / 1000) : null;
  const capLines = r.talkId ? (state.transcripts.get(r.talkId) || []).length : 0;

  const listening = (audio.outCount ? audio.outCount(id) : 0) + (sim ? sim.listening || 0 : 0);

  const slideAt = Number(r.slideAt) || 0;
  const slideN = r.slide && r.slide.n ? r.slide.n : 0;

  const log = phoneLog.get(id);
  if (log) log.reconnects = log.reconnects.filter((t) => now - t < 5 * 60 * 1000);
  const stats = statsFor(id);

  return {
    t: 'room_telemetry',
    room: id,
    talk: talk.status,
    presenter: hub.roleCount ? hub.roleCount(id, 'mic') > 0 || !!sim : !!sim, // a Go live / mic page is open
    mic: { state: micLive ? 'live' : sender.connected ? 'silent' : 'stopped', db },
    captions: { state: !live ? 'stopped' : capGap !== null && capGap <= 20 ? 'live' : 'silent', gapSec: capGap, lines: capLines },
    listen: { state: (sim ? live : sender.connected) ? 'live' : 'stopped', listening },
    slides: { state: !live ? 'stopped' : slideAt && (!talk.startedAt || slideAt >= Date.parse(talk.startedAt)) ? 'live' : 'none', n: slideN, lastAt: slideAt || null },
    phones: { here: stats.here, joined: stats.joined, capacity: stats.capacity, listening, reconnects5m: log ? log.reconnects.length : 0 },
  };
}

module.exports = {
  scan,
  statsFor,
  statsMessage,
  onJoin,
  onLeave,
  capacityOf,
  register(app, c) {
    ctx = c;
    const timer = setInterval(() => {
      for (const r of ctx.state.rooms.values()) {
        const id = r.room;
        const msg = statsMessage(id);
        const json = JSON.stringify(msg);
        if (lastStats.get(id) !== json) { lastStats.set(id, json); ctx.hub.send(id, msg); }
        ctx.hub.send(id, telemetry(id), ['tech', 'org']);
      }
    }, 2000);
    if (timer.unref) timer.unref();
  },
};
