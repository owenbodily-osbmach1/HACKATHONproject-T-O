// End-to-end check for the slide relay and talk lifecycle. Run: node scripts/relay-check.js
// Starts server/index.js on a free port with known keys, exercises the HTTP + WebSocket paths, kills it.
const assert = require('assert');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { WebSocket } = require('ws');

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
const ROOM = '1';
let port = 0;
let child = null;
let logs = '';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

function request(method, urlPath, { headers, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = Object.assign({}, headers);
    if (body !== undefined) h['content-length'] = Buffer.byteLength(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () =>
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
      );
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function json(res) {
  return JSON.parse(res.body.toString());
}

function inbox(ws) {
  const queue = [];
  const waiters = [];
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    queue.push(msg);
    for (const waiter of waiters.slice()) {
      const found = queue.find(waiter.pred);
      if (!found) continue;
      queue.splice(queue.indexOf(found), 1);
      waiters.splice(waiters.indexOf(waiter), 1);
      clearTimeout(waiter.timer);
      waiter.resolve(found);
    }
  });
  return {
    wait(pred, ms = 3000) {
      const found = queue.find(pred);
      if (found) {
        queue.splice(queue.indexOf(found), 1);
        return Promise.resolve(found);
      }
      return new Promise((resolve, reject) => {
        const waiter = { pred, resolve };
        waiter.timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(new Error('timed out waiting for a websocket message'));
        }, ms);
        waiters.push(waiter);
      });
    },
  };
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const messages = inbox(ws);
    ws.once('open', () => resolve({ ws, messages }));
    ws.once('error', reject);
  });
}

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await request('GET', '/healthz');
      if (res.status === 200) return;
    } catch {}
    await sleep(100);
  }
  throw new Error(`server did not start${logs ? `\n${logs}` : ''}`);
}

function stopChild() {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      resolve();
    }, 2000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    try { child.kill('SIGTERM'); } catch {}
  });
}

async function run() {
  port = await freePort();
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, {
      PORT: String(port),
      SPEAKER_KEY: 'sk',
      SIGNIN: 'off',
      TECH_KEY: 'tk',
      PUBLIC_BASE_URL: '',
      ELASTIC_URL: '',
      ELASTIC_API_KEY: '',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (data) => { logs += data.toString(); });
  child.stderr.on('data', (data) => { logs += data.toString(); });
  await waitForServer();

  let res = await request('POST', `/api/rooms/${ROOM}/slide-frame`, {
    headers: { 'content-type': 'image/jpeg' },
    body: JPEG,
  });
  assert.equal(res.status, 401, 'slide-frame without SPEAKER_KEY is 401');

  res = await request('POST', `/api/rooms/${ROOM}/slide-frame`, {
    headers: { 'content-type': 'image/jpeg', 'x-pulse-key': 'sk' },
    body: JPEG,
  });
  assert.equal(res.status, 200, 'slide-frame with SPEAKER_KEY is 200');
  const upload = json(res);
  assert.equal(upload.n, 1, 'first frame is n=1');
  assert.ok(typeof upload.url === 'string' && upload.url.startsWith('/slides/live/'), 'returns a slide url');

  res = await request('POST', `/api/rooms/${ROOM}/slide-frame`, {
    headers: { 'content-type': 'image/jpeg', 'x-pulse-key': 'sk' },
    body: JPEG,
  });
  assert.equal(res.status, 429, 'a second upload within 1 s is 429');

  res = await request('GET', upload.url);
  assert.equal(res.status, 200, 'the frame url serves the upload');
  assert.deepEqual(res.body, JPEG, 'the frame bytes come back unchanged');
  assert.match(String(res.headers['cache-control']), /public/, 'Cache-Control is public');
  assert.match(String(res.headers['cache-control']), /max-age=31536000/, 'frame is cached for a year');
  assert.match(String(res.headers['cache-control']), /immutable/, 'frame cache is immutable');

  const { ws, messages } = await connect(`ws://127.0.0.1:${port}/ws?room=${ROOM}&role=attendee`);
  const waiting = await messages.wait((m) => m.t === 'talk');
  assert.equal(waiting.status, 'waiting', 'join reports a waiting talk before POST /api/talks');
  const snapshot = await messages.wait((m) => m.t === 'slide');
  assert.equal(snapshot.total, 0, 'join slides carry total: 0');

  res = await request('PUT', '/api/votes', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ room: ROOM, talkId: 'none', type: 'cant_hear', clientId: 'c1', on: true }),
  });
  assert.equal(res.status, 409, 'votes before any talk are refused');
  assert.deepEqual(json(res), { error: 'no_live_talk' });

  await sleep(1100);
  res = await request('POST', `/api/rooms/${ROOM}/slide-frame`, {
    headers: { 'content-type': 'image/jpeg', 'x-pulse-key': 'sk' },
    body: JPEG,
  });
  assert.equal(res.status, 200, 'uploads resume after 1 s');
  assert.equal(json(res).n, 2, 'n increments in the preshow bucket');
  const broadcast = await messages.wait((m) => m.t === 'slide' && m.n === 2);
  assert.equal(broadcast.total, 0, 'relay slides to attendees with total: 0');

  res = await request('POST', '/api/talks', {
    headers: { 'content-type': 'application/json', 'x-pulse-key': 'sk' },
    body: JSON.stringify({ room: ROOM, title: 'Relay talk', speaker: 'Sam' }),
  });
  assert.equal(res.status, 200, 'POST /api/talks succeeds with SPEAKER_KEY');
  const { talkId } = json(res);
  const live = await messages.wait((m) => m.t === 'talk' && m.status === 'live');
  assert.equal(live.talkId, talkId, 'the talk message identifies the new talk');
  assert.equal(live.title, 'Relay talk', 'the talk message carries the title');
  assert.ok(live.startedAt, 'the talk message carries startedAt');

  res = await request('POST', `/api/talks/${talkId}/end`, {
    headers: { 'x-pulse-key': 'sk' },
  });
  assert.equal(res.status, 200, 'POST /api/talks/:id/end succeeds');
  assert.ok(json(res).reportUrl, 'end returns the report url');
  const ended = await messages.wait((m) => m.t === 'talk' && m.status === 'ended');
  assert.equal(ended.talkId, talkId, 'the ended message identifies the talk');
  assert.ok(ended.reportUrl, 'the ended message carries reportUrl');

  res = await request('GET', `/relay/${ROOM}`);
  assert.equal(res.status, 401, '/relay/:room without the key is 401');
  res = await request('GET', '/relay.html');
  assert.equal(res.status, 404, 'relay.html is not served as a static file');

  ws.close();
}

(async () => {
  try {
    await run();
    console.log('relay-check: ok');
    process.exitCode = 0;
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    if (logs) console.error(logs.slice(-4000));
    process.exitCode = 1;
  } finally {
    await stopChild();
  }
})();
