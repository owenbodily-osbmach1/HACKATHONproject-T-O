#!/usr/bin/env node
// End-to-end check for /api/find, /api/find/next and /find without Elasticsearch.
// Run: node scripts/find-check.js
const assert = require('assert');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const HOST = '127.0.0.1';
const READY_MS = 15000;
const WS_MS = 5000;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, HOST, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForHealth(base, child) {
  const deadline = Date.now() + READY_MS;
  let last = 'no response';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited before /healthz (code ${child.exitCode})`);
    try {
      const res = await fetch(base + '/healthz');
      if (res.status === 200) return;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err.message;
    }
    await delay(100);
  }
  throw new Error(`/healthz not ready after ${READY_MS}ms (${last})`);
}

async function http(base, method, pathname, { body, key } = {}) {
  const headers = {};
  if (key) headers['x-pulse-key'] = key;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(base + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, text, json };
}

// Same buffering wrapper as scripts/smoke.js so no message is missed.
function socket(url) {
  const ws = new WebSocket(url);
  const queue = [];
  const waiters = [];
  let closeCode;

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    const i = waiters.findIndex((w) => w.match(msg));
    if (i === -1) {
      queue.push(msg);
      return;
    }
    const [w] = waiters.splice(i, 1);
    clearTimeout(w.timer);
    w.resolve(msg);
  });
  const rejectAll = (err) => {
    for (const w of waiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(err);
    }
  };
  ws.on('close', (code) => {
    closeCode = code;
    rejectAll(new Error(`websocket closed with code ${code}`));
  });
  ws.on('error', () => {});

  return {
    ws,
    opened: new Promise((resolve, reject) => {
      if (ws.readyState === WebSocket.OPEN) return resolve();
      ws.once('open', resolve);
      ws.once('error', reject);
    }),
    send(msg) {
      ws.send(JSON.stringify(msg));
    },
    wait(match, timeout = WS_MS) {
      const i = queue.findIndex(match);
      if (i !== -1) return Promise.resolve(queue.splice(i, 1)[0]);
      if (closeCode !== undefined) {
        return Promise.reject(new Error(`websocket already closed with code ${closeCode}`));
      }
      return new Promise((resolve, reject) => {
        const waiter = {
          match,
          resolve,
          reject,
          timer: setTimeout(() => {
            const at = waiters.indexOf(waiter);
            if (at !== -1) waiters.splice(at, 1);
            reject(new Error(`timed out after ${timeout}ms waiting for websocket message`));
          }, timeout),
        };
        waiters.push(waiter);
      });
    },
    close() {
      try {
        ws.close();
      } catch {}
    },
  };
}

const CAPTIONS = [
  'Kubernetes agents need sandboxed runtimes',
  'OpenTelemetry traces make agent behavior visible',
  'GPU autoscaling with Karpenter keeps nodes right-sized',
];

async function main() {
  const port = await freePort();
  const base = `http://${HOST}:${port}`;
  const env = { ...process.env, PORT: String(port), SPEAKER_KEY: 'sk', TECH_KEY: 'tk' };
  for (const key of [
    'ELASTIC_URL',
    'ELASTIC_API_KEY',
    'ES_INFERENCE_ID',
    'OTEL_EXPORTER_OTLP_ENDPOINT',
    'OTEL_EXPORTER_OTLP_HEADERS',
  ]) {
    delete env[key];
  }

  let output = '';
  const child = spawn(process.execPath, [path.join('server', 'index.js')], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });

  const sockets = [];
  try {
    await waitForHealth(base, child);

    const page = await http(base, 'GET', '/find');
    assert.equal(page.status, 200, `/find must return 200, got ${page.status}`);
    assert.ok(page.text.includes('What do you want to learn about?'), '/find must render the search box');

    const talk = await http(base, 'POST', '/api/talks', {
      key: 'sk',
      body: { room: '1', title: 'Kubernetes agents in production', speaker: 'Find check' },
    });
    assert.equal(talk.status, 200, `POST /api/talks must return 200, got ${talk.status}`);
    const talkId = talk.json && talk.json.talkId;
    assert.ok(talkId, 'POST /api/talks must return a talkId');

    const attendee = socket(`ws://${HOST}:${port}/ws?room=1&role=attendee&clientId=c1`);
    sockets.push(attendee);
    await attendee.opened;

    const mic = socket(`ws://${HOST}:${port}/ws?room=1&role=mic&key=sk`);
    sockets.push(mic);
    await mic.opened;

    const lastCaption = attendee.wait((m) => m.t === 'caption' && m.text === CAPTIONS[CAPTIONS.length - 1]);
    CAPTIONS.forEach((text, i) => {
      mic.send({ t: 'caption', talkId, seq: i + 1, text, ts: Date.now() + i });
    });
    await lastCaption;

    const find = await http(base, 'GET', '/api/find?q=kubernetes&limit=10');
    assert.equal(find.status, 200, `/api/find must return 200, got ${find.status}`);
    assert.ok(find.json && Array.isArray(find.json.sessions), '/api/find must return sessions[]');
    assert.ok(find.json.sessions.length > 0, 'fallback search must return schedule sessions');
    const session = find.json.sessions[0];
    assert.ok(session.id && session.title && session.start && session.location, 'session fields are required');
    assert.ok(find.json.said.some((hit) => hit.talkId === talkId && /kubernetes/i.test(hit.text)),
      'fallback search must return the caption that said "Kubernetes"');

    const next = await http(base, 'GET', '/api/find/next?clientId=c1&limit=3');
    assert.equal(next.status, 200, `/api/find/next must return 200, got ${next.status}`);
    assert.ok(Array.isArray(next.json) && next.json.length > 0, '/api/find/next must return suggestions');
    assert.ok(next.json.every((row) => typeof row.because === 'string' && row.because.length <= 120),
      'every suggestion for c1 must carry a because line of at most 120 chars');

    console.log('find-check: ok');
  } catch (err) {
    process.exitCode = 1;
    console.error(`find-check: ${err.message}`);
    if (output.trim()) console.error(output.trim());
  } finally {
    for (const s of sockets) s.close();
    if (child.exitCode === null) child.kill('SIGTERM');
  }
}

main();
