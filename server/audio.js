// Binary audio relay: /ws/audio-in?room=&key=SPEAKER_KEY -> /ws/audio-out?room= (CONTRACT.md "Audio").
// Interface: attach(server, ctx), handleUpgrade(req, socket, head), micDb(room) -> latest dBFS or null.
const { WebSocketServer } = require('ws');
const otel = require('./otel');
const log = require('./log');

const wss = new WebSocketServer({ noServer: true });
const senders = new Map(); // room -> sender ws (one active)
const outs = new Map(); // room -> Set<ws>
const dbByRoom = new Map(); // room -> latest RMS dBFS

let ctx = null;
let frames = null;
let droppedFrames = null;

function closeQuietly(ws, code, reason) {
  try { ws.close(code, reason); } catch {}
}

function dbfs(frame) {
  if (!frame || frame.length < 2) return null;
  let sum = 0;
  let n = 0;
  for (let i = 0; i + 1 < frame.length; i += 2) {
    const s = frame.readInt16LE(i);
    sum += s * s;
    n++;
  }
  if (!n) return null;
  const rms = Math.sqrt(sum / n) / 32768;
  if (!rms) return -100;
  return Math.max(-100, Math.min(0, 20 * Math.log10(rms)));
}

// Dead phones on audio-out (screen lock, network change) are found by ping and dropped.
const live = new WeakMap();
setInterval(() => {
  for (const set of outs.values()) for (const ws of set) {
    if (live.get(ws) === false) { try { ws.terminate(); } catch {} continue; }
    live.set(ws, false);
    try { ws.ping(); } catch {}
  }
}, 20000).unref();

function addOut(room, ws) {
  live.set(ws, true);
  ws.on('pong', () => live.set(ws, true));
  let set = outs.get(room);
  if (!set) outs.set(room, (set = new Set()));
  set.add(ws);
  ws.on('message', () => {}); // send-only: anything a phone sends is dropped
  ws.on('close', () => {
    set.delete(ws);
    if (!set.size) outs.delete(room);
  });
  ws.on('error', () => {});
}

function relay(room, frame) {
  if (frames) frames.add(1, { 'pulse.room': room });
  const db = dbfs(frame);
  if (db !== null) {
    dbByRoom.set(room, db);
    if (ctx) ctx.state.room(room).micDb = db;
  }
  const set = outs.get(room);
  if (!set) return;
  for (const ws of set) {
    if (ws.readyState !== ws.OPEN) continue;
    if (ws.bufferedAmount > 64 * 1024) { // slow phone: drop instead of queueing
      if (droppedFrames) droppedFrames.add(1, { 'pulse.room': room });
      continue;
    }
    try { ws.send(frame, { binary: true }); } catch {}
  }
}

function addSender(ws, room) {
  const old = senders.get(room);
  if (old && old !== ws) {
    closeQuietly(old, 4409, 'replaced');
    log.info('mic.replaced', { room });
  }
  senders.set(room, ws);
  log.info('mic.connected', { room });
  ws.on('message', (data, isBinary) => {
    if (!isBinary || senders.get(room) !== ws) return;
    relay(room, Buffer.isBuffer(data) ? data : Buffer.from(data));
  });
  ws.on('close', () => {
    if (senders.get(room) === ws) senders.delete(room);
  });
  ws.on('error', () => {});
}

module.exports = {
  attach(server, c) {
    ctx = c;
    frames = otel.counter('pulse.audio.frames', 'Audio frames relayed', '{frame}');
    droppedFrames = otel.counter('pulse.audio.dropped_frames', 'Audio frames dropped for slow phones', '{frame}');
    wss.on('error', () => {});
  },

  handleUpgrade(req, socket, head) {
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { socket.destroy(); return; }
    if (!ctx) { socket.destroy(); return; }

    const room = url.searchParams.get('room');
    const isIn = url.pathname === '/ws/audio-in';
    const isOut = url.pathname === '/ws/audio-out';
    if (!room || (!isIn && !isOut)) { socket.destroy(); return; }

    if (isIn && !ctx.auth.ok('SPEAKER_KEY', url.searchParams.get('key'))) {
      wss.handleUpgrade(req, socket, head, (ws) => closeQuietly(ws, 4401, 'unauthorized'));
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (isIn) addSender(ws, room); else addOut(room, ws);
    });
  },

  micDb(room) {
    const db = dbByRoom.get(String(room));
    return db === undefined ? null : db;
  },
};
