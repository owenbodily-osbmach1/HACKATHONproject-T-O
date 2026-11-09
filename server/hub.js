// WebSocket hub for /ws?room=&role=&key=&clientId= (CONTRACT.md "WebSocket").
// Interface other modules rely on:
//   attach(server, ctx)                 called once at startup
//   handleUpgrade(req, socket, head)    called by index.js for path /ws
//   send(room, msg, roles?)             JSON-send msg to every socket in room (optionally only these roles)
//   sendTo(clientIds, room, msg)        JSON-send to sockets whose clientId is in the array (question_reply)
//   listeners(room)                     number of open attendee sockets in room
//   on(t, fn)                           subscribe to inbound messages: fn(msg, {room, role, clientId})
const { WebSocketServer } = require('ws');
const otel = require('./otel');

const ROLES = new Set(['attendee', 'viewer', 'mic', 'present', 'tech', 'org']);
const wss = new WebSocketServer({ noServer: true });
const rooms = new Map(); // room -> Set<{ws, role, clientId, alive}>
const handlers = new Map(); // t -> Set<fn>
const heardRooms = new Map(); // attendee clientId -> Set(room) joined while connected

let ctx = null;
let pingTimer = null;
let captionFanout = null;

function closeQuietly(ws, code, reason) {
  try { ws.close(code, reason); } catch {}
}

function authorized(role, key) {
  if (role === 'mic' || role === 'present') return ctx.auth.ok('SPEAKER_KEY', key);
  if (role === 'tech') return ctx.auth.ok('TECH_KEY', key);
  return true;
}

function sendJson(ws, msg) {
  if (ws.readyState !== ws.OPEN) return;
  try { ws.send(JSON.stringify(msg)); } catch {}
}

function deliver(rec, data) {
  if (rec.ws.readyState !== rec.ws.OPEN) return;
  try { rec.ws.send(data); } catch {}
}

function send(roomId, msg, roles) {
  const set = rooms.get(String(roomId));
  if (!set) return;
  const allow = roles ? new Set(roles) : null;
  const data = JSON.stringify(msg);
  for (const rec of set) {
    if (!allow || allow.has(rec.role)) deliver(rec, data);
  }
}

function remove(rec) {
  const set = rooms.get(rec.room);
  if (!set) return;
  set.delete(rec);
  if (!set.size) rooms.delete(rec.room);
}

function talkMinute(talkId, ts) {
  if (!ctx) return 0;
  const talk = talkId ? ctx.state.talks.get(talkId) : null;
  if (!talk || !talk.start) return 0;
  const start = typeof talk.start === 'number' ? talk.start : Date.parse(talk.start);
  if (!Number.isFinite(start) || !Number.isFinite(ts)) return 0;
  return Math.max(0, Math.floor((ts - start) / 60000));
}

// Fire-and-forget: the live caption path never waits for Elasticsearch.
function esIndex(index, doc) {
  try {
    const p = ctx.es.index(index, doc);
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch {}
}

function onCaption(rec, msg) {
  const room = ctx.state.room(rec.room);
  const text = typeof msg.text === 'string' ? msg.text : '';
  if (!text.trim()) return;

  const talkId = typeof msg.talkId === 'string' && msg.talkId ? msg.talkId : room.talkId;
  const last = room.captions[room.captions.length - 1];
  let seq = Number(msg.seq);
  if (!Number.isInteger(seq) || seq < 0) seq = last ? Number(last.seq) + 1 : 1;

  let ts = Number(msg.ts);
  if (!Number.isFinite(ts)) {
    const parsed = typeof msg.ts === 'string' ? Date.parse(msg.ts) : NaN;
    ts = Number.isFinite(parsed) ? parsed : Date.now();
  }

  const line = { talkId, seq, text, ts };
  room.captions.push(line);
  ctx.state.addLine(line);
  if (room.captions.length > 50) room.captions.splice(0, room.captions.length - 50);
  room.lastCaptionTs = Date.now();

  let roomListeners = 0;
  const roomSet = rooms.get(rec.room);
  if (roomSet) for (const other of roomSet) if (other.role === 'attendee') roomListeners += 1;
  const started = captionFanout ? performance.now() : 0;
  otel.span(
    'pulse.caption.relay',
    { 'pulse.room': rec.room, 'pulse.listeners': roomListeners },
    () => send(rec.room, { t: 'caption', talkId, seq, text, ts }, ['attendee', 'viewer', 'tech'])
  );
  if (captionFanout) {
    captionFanout.record(performance.now() - started, { 'pulse.room': rec.room });
  }
  esIndex('pulse-captions', {
    talkId, room: rec.room, seq, text, ts, minute: talkMinute(talkId, ts),
  });
}

function onSlide(rec, msg) {
  const url = typeof msg.url === 'string' ? msg.url : '';
  if (!url) return;
  const room = ctx.state.room(rec.room);
  const talkId = typeof msg.talkId === 'string' && msg.talkId ? msg.talkId : room.talkId;
  const n = Number.isInteger(Number(msg.n)) ? Number(msg.n) : 0;
  const total = Number.isInteger(Number(msg.total)) ? Number(msg.total) : 0;
  const slide = { talkId, n, total, url };
  room.slide = slide;

  send(rec.room, { t: 'slide', ...slide });
  esIndex('pulse-actions', {
    room: rec.room,
    talkId,
    actor: rec.clientId || rec.role,
    action: 'slide',
    detail: JSON.stringify(slide), // mapped as text in pulse-actions
    ts: Date.now(),
  });
}

function dispatch(rec, msg) {
  const list = handlers.get(msg.t);
  if (!list) return;
  const info = { room: rec.room, role: rec.role, clientId: rec.clientId };
  for (const fn of list) {
    try { fn(msg, info); } catch (err) {
      console.error('pulse: ws handler failed:', err && err.message);
    }
  }
}

function inbound(rec, msg) {
  if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
  if (msg.t === 'ping') { sendJson(rec.ws, { t: 'pong' }); return; }
  if (msg.t === 'pong') return;

  if (msg.t === 'caption' || msg.t === 'caption_interim') {
    if (rec.role !== 'mic') return;
    if (msg.t === 'caption') return onCaption(rec, msg);
    const text = typeof msg.text === 'string' ? msg.text : '';
    if (text.trim()) send(rec.room, { t: 'caption_interim', text }, ['attendee', 'viewer']);
    return;
  }

  if (msg.t === 'slide') {
    if (rec.role !== 'mic' && rec.role !== 'present') return;
    return onSlide(rec, msg);
  }

  dispatch(rec, msg);
}

function join(ws, room, role, clientId) {
  const rec = { ws, room, role, clientId, alive: true };
  let set = rooms.get(room);
  if (!set) rooms.set(room, (set = new Set()));
  set.add(rec);

  if (role === 'attendee' && clientId) {
    let heard = heardRooms.get(clientId);
    if (!heard) heardRooms.set(clientId, (heard = new Set()));
    heard.add(room);
  }

  const state = ctx.state.room(room);
  if (role === 'attendee' || role === 'viewer' || role === 'tech') {
    sendJson(ws, { t: 'caption_backlog', lines: state.captions.slice(-50) });
  }
  sendJson(ws, { t: 'room_settings', ...state.settings });
  if (state.slide) sendJson(ws, { t: 'slide', ...state.slide });
  if (role === 'tech' || role === 'org') {
    // Lazy require: tickets/questions require the hub too.
    for (const m of require('./tickets').activeTicketMessages(room)) sendJson(ws, m);
    sendJson(ws, { t: 'question_groups', groups: require('./questions').groupList(room) });
  }

  ws.on('pong', () => { rec.alive = true; });
  ws.on('message', (data, isBinary) => {
    if (isBinary) { closeQuietly(ws, 1003, 'binary not supported'); return; }
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    inbound(rec, msg);
  });
  ws.on('close', () => remove(rec));
  ws.on('error', () => {});
}

module.exports = {
  attach(server, c) {
    ctx = c;
    ctx.state.heardRooms = heardRooms;
    captionFanout = otel.histogram(
      'pulse.caption.fanout.duration',
      'Milliseconds to send one caption to every socket in the room',
      'ms'
    );
    wss.on('error', () => {});
    if (pingTimer) return;
    pingTimer = setInterval(() => {
      for (const set of rooms.values()) {
        for (const rec of set) {
          if (!rec.alive) { try { rec.ws.terminate(); } catch {} continue; }
          rec.alive = false;
          try { rec.ws.ping(); } catch {}
        }
      }
    }, 20000);
    if (pingTimer.unref) pingTimer.unref();
  },

  handleUpgrade(req, socket, head) {
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { socket.destroy(); return; }
    const room = url.searchParams.get('room');
    const role = url.searchParams.get('role');
    const key = url.searchParams.get('key');
    const clientId = url.searchParams.get('clientId') || '';

    if (!ctx) { socket.destroy(); return; }
    if (!room || !ROLES.has(role)) {
      wss.handleUpgrade(req, socket, head, (ws) => closeQuietly(ws, 1008, 'bad request'));
      return;
    }
    if (!authorized(role, key)) {
      wss.handleUpgrade(req, socket, head, (ws) => closeQuietly(ws, 4401, 'unauthorized'));
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => join(ws, room, role, clientId));
  },

  send,

  sendTo(clientIds, room, msg) {
    const set = rooms.get(String(room));
    if (!set || !clientIds || !clientIds.length) return;
    const ids = new Set(clientIds.map(String));
    const data = JSON.stringify(msg);
    for (const rec of set) {
      if (rec.clientId && ids.has(rec.clientId)) deliver(rec, data);
    }
  },

  listeners(room) {
    const set = rooms.get(String(room));
    if (!set) return 0;
    let n = 0;
    for (const rec of set) if (rec.role === 'attendee') n++;
    return n;
  },

  roomsJoined(clientId) {
    const set = heardRooms.get(String(clientId));
    return set ? [...set] : [];
  },

  on(t, fn) {
    if (typeof t !== 'string' || typeof fn !== 'function') return;
    let set = handlers.get(t);
    if (!set) handlers.set(t, (set = new Set()));
    set.add(fn);
  },
};
