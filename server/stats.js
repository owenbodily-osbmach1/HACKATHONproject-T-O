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
// A presenter who walked off without End: the talk ends itself once no Go live / mic page has been
// in the room and no caption has arrived for AUTO_END_MIN minutes (0 turns this off).
const AUTO_END_MS = Math.max(0, Number(process.env.AUTO_END_MIN ?? 10)) * 60 * 1000;
const micGoneAt = new Map(); // room -> when the last mic socket was seen gone
const visitors = new Map(); // room -> Set(visitor id)
const MAX_SCAN_ROOMS = 300; // /r/<anything> can't grow this without bound (Gitar)
// The visitor cookie is `<16 hex id>.<HMAC>`: the server only trusts ids it issued itself, so a script
// can't mint ids to fill sign-in or the scan counts (Gitar). VISITOR_SECRET keeps cookies valid across
// restarts; without it a random secret is used (sign-ins are in memory anyway).
const SECRET = process.env.VISITOR_SECRET || crypto.randomBytes(32).toString('hex');
const sign = (id) => crypto.createHmac('sha256', SECRET).update(id).digest('hex').slice(0, 24);
function verifiedId(value) {
  const m = /^([a-f0-9]{16})\.([a-f0-9]{24})$/.exec(String(value || ''));
  if (!m) return '';
  const want = Buffer.from(sign(m[1]));
  const got = Buffer.from(m[2]);
  return want.length === got.length && crypto.timingSafeEqual(want, got) ? m[1] : '';
}
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
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(String(req.params.room))) return res.status(404).type('text').send('No such room');
  let vid = verifiedId(cookie(req, 'pulse_v'));
  if (!vid) {
    vid = crypto.randomBytes(8).toString('hex');
    const https = req.secure || req.get('x-forwarded-proto') === 'https';
    res.append('Set-Cookie', `pulse_v=${vid}.${sign(vid)}; Path=/; Max-Age=86400; HttpOnly; SameSite=Lax${https ? '; Secure' : ''}`);
  }
  res.locals.vid = vid; // server/signin.js gate
  const room = String(req.params.room);
  let set = visitors.get(room);
  // A scan never creates a room (only a talk or a socket does), and junk room ids stop being counted
  // once MAX_SCAN_ROOMS ids are tracked.
  if (!set && (visitors.size < MAX_SCAN_ROOMS || (ctx && ctx.state.rooms.has(room)))) visitors.set(room, (set = new Set()));
  if (set) set.add(vid);
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
  const signin = require('./signin'); // lazy: signin requires stats
  const signedIn = signin.enabled ? signin.countFor(id) : null;
  return { room: id, joined: Math.max(joined, here), here, capacity, fill: capacity ? Math.min(1, here / capacity) : 0, signedIn };
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

// The visitor id from a raw Cookie header (WebSocket upgrades and API calls).
function visitorFromHeaders(headers) {
  return verifiedId(cookie({ headers: headers || {} }, 'pulse_v'));
}

function autoEnd(r) {
  if (!AUTO_END_MS) return;
  const talk = ctx.state.liveTalk(r.room);
  if (!talk || talk.simulated) { micGoneAt.delete(r.room); return; }
  const now = Date.now();
  if (ctx.hub.roleCount && ctx.hub.roleCount(r.room, 'mic') > 0) { micGoneAt.delete(r.room); return; }
  if (!micGoneAt.has(r.room)) micGoneAt.set(r.room, now);
  const start = typeof talk.start === 'number' ? talk.start : Date.parse(talk.start) || now;
  const quietSince = Math.max(micGoneAt.get(r.room), Number(r.lastCaptionTs) || 0, start);
  if (now - quietSince < AUTO_END_MS) return;
  talk.end = now;
  talk.autoEnded = true;
  micGoneAt.delete(r.room);
  try { require('./log').info('talk.auto_ended', { room: r.room, talkId: talk.talkId }); } catch {}
  ctx.hub.send(r.room, { t: 'caption_interim', text: '' }, ['attendee', 'viewer']);
  ctx.hub.send(r.room, ctx.state.talkMessage(r.room));
}

module.exports = {
  scan,
  visitorFromHeaders,
  statsFor,
  statsMessage,
  onJoin,
  onLeave,
  capacityOf,
  register(app, c) {
    ctx = c;
    // Dash0: headcounts per room (counts only, never who). pulse.simulated marks the demo room.
    const perRoom = (pick) => () => [...ctx.state.rooms.values()].map((r) => {
      const st = statsFor(r.room);
      return { value: pick(st), attributes: { 'pulse.room': r.room, 'pulse.simulated': !!r.simulated } };
    }).filter((p) => typeof p.value === 'number');
    try {
      const otel = require('./otel');
      otel.observableGauge('pulse.room.scanned', 'Unique phones that opened the room link', perRoom((st) => st.joined));
      otel.observableGauge('pulse.room.here', 'Phones in the room right now', perRoom((st) => st.here));
      otel.observableGauge('pulse.room.fill', 'Phones here / seats (0-1)', perRoom((st) => st.fill));
      otel.observableGauge('pulse.room.signed_in', 'Phones signed in to the room', perRoom((st) => st.signedIn));
    } catch { /* telemetry never breaks the app */ }
    const timer = setInterval(() => {
      for (const r of ctx.state.rooms.values()) {
        const id = r.room;
        autoEnd(r);
        const msg = statsMessage(id);
        const json = JSON.stringify(msg);
        if (lastStats.get(id) !== json) { lastStats.set(id, json); ctx.hub.send(id, msg); }
        ctx.hub.send(id, telemetry(id), ['tech', 'org']);
      }
    }, 2000);
    if (timer.unref) timer.unref();
  },
};
