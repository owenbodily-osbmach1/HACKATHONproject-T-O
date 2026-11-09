// Check for caption cleanup (server/wordfix.js) and its use in the hub. Run: node scripts/wordfix-check.js
// Unit cases first, then a real server on a free port: a keyed mic socket sends captions and an
// attendee socket and the transcript route must show the cleaned text.
const assert = require('assert');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { WebSocket } = require('ws');
const { fix } = require('../server/wordfix');

const CASES = [
  // domain terms
  ['we run cube control apply on it', 'We run kubectl apply on it'],
  ['kube cuddle get pods', 'kubectl get pods'],
  ['cooper netties is a platform', 'Kubernetes is a platform'],
  ['dash zero collects open telemetry data', 'Dash0 collects OpenTelemetry data'],
  ['we send traces to Dash 0', 'We send traces to Dash0'],
  ['elastic search stores the captions', 'Elasticsearch stores the captions'],
  ['argo cd syncs the repo', 'Argo CD syncs the repo'],
  ['prometheus and grafana for metrics', 'Prometheus and Grafana for metrics'],
  ['etcd is a key value store', 'etcd is a key value store'],
  ['e t c d needs three nodes', 'etcd needs three nodes'],
  ['the g r p c service speaks yammel', 'The gRPC service speaks YAML'],
  ['ci cd is part of devops', 'CI/CD is part of DevOps'],
  ['ci slash cd runs on github', 'CI/CD runs on GitHub'],
  ['kelsey high tower said so', 'Kelsey Hightower said so'],
  ['guitar ai reviews the pull request', 'Gitar AI reviews the pull request'],
  ['an open api and many apis', 'An open API and many APIs'],
  ['kube con was fun', 'KubeCon was fun'],
  // tidy, capitalise, stutters
  ['  hello   world  ', 'Hello world'],
  ['hello , world .', 'Hello, world.'],
  ['i think i can and i\'m sure i\'ll try', 'I think I can and I\'m sure I\'ll try'],
  ['so the the plan is the the plan', 'So the plan is the plan'],
  ['it is is is done', 'It is done'],
  ['first. second? third', 'First. Second? Third'],
  ['"quoted" start', '"Quoted" start'],
  // must stay as they are
  ['kubectl apply -f deploy.yaml', 'kubectl apply -f deploy.yaml'],
  ['etcd holds the state. kubectl reads it', 'etcd holds the state. kubectl reads it'],
  ['e.g. a stream, i.e. a channel, etc. and more', 'e.g. a stream, i.e. a channel, etc. and more'],
  ['i/o is slow', 'i/o is slow'],
  ['he played guitar on stage', 'He played guitar on stage'],
  ['that that was had had', 'That that was had had'],
  ['very very good', 'Very very good'],
  ['one two three 3 3', 'One two three 3 3'],
  ['Kubernetes and OpenTelemetry', 'Kubernetes and OpenTelemetry'],
  ['A line that is already fine.', 'A line that is already fine.'],
  ['Les Misérables ça va', 'Les Misérables ça va'],
];

for (const [input, expected] of CASES) {
  const got = fix(input);
  assert.strictEqual(got, expected, `fix(${JSON.stringify(input)})`);
  assert.strictEqual(fix(got), got, `idempotent: ${JSON.stringify(input)}`);
}

// Never throws, never loses a non-string or an unusual value.
for (const odd of [undefined, null, 5, {}, [], '', '   ', '\n', '\u0000', '😀 ok 😀', 'a'.repeat(10000)]) {
  assert.doesNotThrow(() => fix(odd));
  if (typeof odd !== 'string' || !odd.trim() || odd.length > 4000) assert.strictEqual(fix(odd), odd);
}
assert.ok(fix('😀 ok 😀').includes('😀'), 'emoji survive');

// Word count only ever goes down by exact adjacent duplicates; never up.
const sample = 'we need to talk about cube control and dash zero and open telemetry and the the plan';
assert.ok(fix(sample).split(' ').length <= sample.split(' ').length);

// Speed: a long burst of lines costs well under a second.
const started = process.hrtime.bigint();
for (let i = 0; i < 5000; i++) fix(`line ${i} we use cube control with open telemetry and dash zero on kubernetes`);
const ms = Number(process.hrtime.bigint() - started) / 1e6;
assert.ok(ms < 1500, `5000 lines took ${ms.toFixed(0)} ms`);

// ---------- hub integration ----------
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
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const got = [];
    ws.on('message', (data) => {
      try { got.push(JSON.parse(data.toString())); } catch {}
    });
    ws.once('open', () => resolve({ ws, got }));
    ws.once('error', reject);
  });
}

async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await sleep(25);
  }
  throw new Error('timed out');
}

async function hubCheck() {
  port = await freePort();
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, {
      PORT: String(port), SPEAKER_KEY: 'sk', TECH_KEY: 'tk', MOCK_ROOM: 'off', SIGNIN: 'off',
      PUBLIC_BASE_URL: '', ELASTIC_URL: '', ELASTIC_API_KEY: '',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { logs += d.toString(); });
  child.stderr.on('data', (d) => { logs += d.toString(); });
  for (let i = 0; i < 100; i++) {
    try { if ((await request('GET', '/healthz')).status === 200) break; } catch {}
    await sleep(100);
  }

  const room = '77';
  const made = await request('POST', '/api/talks', {
    headers: { 'content-type': 'application/json', 'x-pulse-key': 'sk' },
    body: JSON.stringify({ room, title: 'Wordfix talk', speaker: 'Sam' }),
  });
  assert.equal(made.status, 200, 'talk created');
  const { talkId } = JSON.parse(made.body);

  const mic = await connect(`ws://127.0.0.1:${port}/ws?room=${room}&role=mic&key=sk&clientId=m`);
  const phone = await connect(`ws://127.0.0.1:${port}/ws?room=${room}&role=attendee&clientId=p`);
  await sleep(150);

  mic.ws.send(JSON.stringify({ t: 'caption_interim', text: 'dash zero and open telemetry' }));
  mic.ws.send(JSON.stringify({ t: 'caption', talkId, seq: 1, text: 'cube control the the apply', ts: Date.now() }));
  mic.ws.send(JSON.stringify({ t: 'caption', talkId, seq: 2, text: '   ', ts: Date.now() }));
  mic.ws.send(JSON.stringify({ t: 'caption', talkId, seq: 3, text: 'we love cooper netties', ts: Date.now() }));

  const interim = await until(() => phone.got.find((m) => m.t === 'caption_interim'));
  assert.equal(interim.text, 'Dash0 and OpenTelemetry', 'interim text gets the term fixes');
  const first = await until(() => phone.got.find((m) => m.t === 'caption' && m.seq === 1));
  assert.equal(first.text, 'kubectl the apply', 'relayed caption is cleaned');
  const third = await until(() => phone.got.find((m) => m.t === 'caption' && m.seq === 3));
  assert.equal(third.text, 'We love Kubernetes');
  assert.ok(!phone.got.some((m) => m.t === 'caption' && m.seq === 2), 'blank caption is dropped');

  const tr = JSON.parse((await request('GET', `/api/talks/${talkId}/transcript`)).body);
  assert.deepEqual(tr.map((r) => r.text), ['kubectl the apply', 'We love Kubernetes'], 'stored transcript is cleaned');
  const txt = (await request('GET', `/api/talks/${talkId}/transcript?format=txt`)).body;
  assert.ok(txt.includes('We love Kubernetes'), 'txt export is cleaned');

  mic.ws.close();
  phone.ws.close();
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

(async () => {
  try {
    await hubCheck();
    console.log('wordfix-check: ok');
    process.exitCode = 0;
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    if (logs) console.error(logs.slice(-3000));
    process.exitCode = 1;
  } finally {
    await stopChild();
  }
})();
