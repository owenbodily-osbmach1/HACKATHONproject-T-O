// WebSocket load test: N attendee sockets for 30 s, counting relayed captions.
// Usage: BASE_URL=http://localhost:8080 N=200 ROOM=151 node scripts/loadtest.js
const WebSocket = require('ws');

const BASE_URL = process.env.BASE_URL || 'http://localhost:8080';
const N = Number(process.env.N || 200);
const ROOM = process.env.ROOM || '151';
const DURATION_MS = Number(process.env.DURATION_MS || 30000);

const base = new URL(BASE_URL);
const wsUrl = new URL('/ws', base);
wsUrl.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
wsUrl.searchParams.set('room', ROOM);
wsUrl.searchParams.set('role', 'attendee');

const sockets = [];
let connected = 0;
let failed = 0;
let messages = 0;

for (let i = 0; i < N; i++) {
  const state = { id: i, open: false, failed: false, captions: 0 };
  const socket = new WebSocket(wsUrl, { perMessageDeflate: false });
  sockets.push({ state, socket });

  socket.on('open', () => {
    state.open = true;
    connected++;
  });

  socket.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.t === 'caption') {
      state.captions++;
      messages++;
    }
  });

  socket.on('error', (err) => {
    state.error = err.message;
    if (!state.open && !state.failed) {
      state.failed = true;
      failed++;
    }
  });

  socket.on('close', () => {
    if (!state.open && !state.failed) {
      state.failed = true;
      failed++;
    }
  });
}

setTimeout(() => {
  for (const { state } of sockets) {
    if (!state.open && !state.failed) {
      state.failed = true;
      failed++;
    }
  }
  console.log(`sockets ${N} room ${ROOM} connected ${connected} failed ${failed}`);
  console.log(`caption messages ${messages} over ${DURATION_MS / 1000}s`);
  for (const { state, socket } of sockets) {
    if (state.failed) console.log(`#${state.id} failed ${state.error || 'closed before open'}`);
    else console.log(`#${state.id} connected captions ${state.captions}`);
    socket.terminate();
  }
  console.log(
    messages ? `msgs/socket avg ${(messages / connected).toFixed(1)}` : 'msgs/socket avg 0'
  );
  process.exit(failed === N ? 1 : 0);
}, DURATION_MS);
