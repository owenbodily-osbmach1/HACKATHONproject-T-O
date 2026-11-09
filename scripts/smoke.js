// Smoke test: boots server/index.js on a free port and walks the demo-critical paths.
// Run: npm run smoke. No secrets and no Elasticsearch/Dash0: those integrations stay disabled.
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

// Thin ws wrapper: buffers messages until a waiter asks for them so none are missed
// between "open" and the assertion that expects them.
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

async function main() {
  const port = await freePort();
  const base = `http://${HOST}:${port}`;
  const env = { ...process.env, PORT: String(port), SPEAKER_KEY: 'sk', TECH_KEY: 'tk', SIGNIN: 'off' };
  for (const key of [
    'ELASTIC_URL',
    'ELASTIC_API_KEY',
    'ES_INFERENCE_ID',
    'OTEL_EXPORTER_OTLP_ENDPOINT',
    'OTEL_EXPORTER_OTLP_HEADERS',
    'ALERT_THRESHOLD',
    'ALERT_WINDOW_SEC',
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

    const health = await http(base, 'GET', '/healthz');
    assert.equal(health.status, 200, `/healthz must return 200, got ${health.status}`);

    const lockedTech = await http(base, 'GET', '/tech');
    assert.equal(lockedTech.status, 401, `/tech without a key must return 401, got ${lockedTech.status}`);

    const techHtml = await http(base, 'GET', '/tech.html');
    assert.equal(techHtml.status, 404, `/tech.html must not be served as a static file, got ${techHtml.status}`);

    const rooms = await http(base, 'GET', '/api/rooms');
    assert.equal(rooms.status, 200, `/api/rooms must return 200, got ${rooms.status}`);
    assert.ok(Array.isArray(rooms.json), '/api/rooms must return a JSON array');

    const talk = await http(base, 'POST', '/api/talks', {
      key: 'sk',
      body: { room: '1', title: 'Smoke talk', speaker: 'Smoke' },
    });
    assert.equal(talk.status, 200, `POST /api/talks must return 200, got ${talk.status}`);
    assert.ok(talk.json && typeof talk.json.talkId === 'string' && talk.json.talkId,
      'POST /api/talks must return a talkId');
    const { talkId } = talk.json;

    const attendee = socket(`ws://${HOST}:${port}/ws?room=1&role=attendee&clientId=smoke-attendee`);
    sockets.push(attendee);
    await attendee.opened;

    const mic = socket(`ws://${HOST}:${port}/ws?room=1&role=mic&key=sk&clientId=smoke-mic`);
    sockets.push(mic);
    await mic.opened;

    const captionPromise = attendee.wait((m) => m.t === 'caption' && m.text === 'smoke caption');
    mic.send({ t: 'caption', talkId, seq: 1, text: 'smoke caption', ts: Date.now() });
    const caption = await captionPromise;
    assert.equal(caption.talkId, talkId, 'relayed caption must carry the talkId');

    const statuses = [];
    for (const clientId of ['smoke-a', 'smoke-b', 'smoke-c']) {
      const vote = await http(base, 'PUT', '/api/votes', {
        body: { room: '1', talkId, type: 'cant_hear', clientId, on: true },
      });
      assert.equal(vote.status, 200, `PUT /api/votes must return 200, got ${vote.status}`);
      statuses.push(vote.json && vote.json.ticketStatus);
    }
    assert.ok(statuses.includes('open'),
      `three distinct cant_hear votes must open a ticket, got ${JSON.stringify(statuses)}`);

    const roomsAfter = await http(base, 'GET', '/api/rooms');
    assert.equal(roomsAfter.status, 200, `/api/rooms must return 200 after voting, got ${roomsAfter.status}`);
    const room = (roomsAfter.json || []).find((r) => r.room === '1');
    assert.ok(room, '/api/rooms must include room 1');
    assert.equal(room.openTickets, 1, `room 1 must have exactly one open ticket, got ${room.openTickets}`);

    // An open tech console must drop old-talk groups when the next talk starts.
    const asked = await http(base, 'POST', '/api/questions', {
      body: { room: '1', talkId, clientId: 'smoke-a', text: 'old talk question about uplinks' },
    });
    assert.equal(asked.status, 200, `POST /api/questions must return 200, got ${asked.status}`);
    const tech = socket(`ws://${HOST}:${port}/ws?room=1&role=tech&key=tk&clientId=smoke-tech`);
    sockets.push(tech);
    await tech.opened;
    const oldSnap = await tech.wait((m) => m.t === 'question_groups');
    assert.equal(oldSnap.groups.length, 1,
      `tech must see the current talk's question group, got ${JSON.stringify(oldSnap.groups)}`);

    await http(base, 'POST', `/api/talks/${talkId}/end`, { key: 'sk' });
    const talk2 = await http(base, 'POST', '/api/talks', {
      key: 'sk', body: { room: '1', title: 'Smoke talk 2', speaker: 'Smoke' },
    });
    assert.equal(talk2.status, 200, `second POST /api/talks must return 200, got ${talk2.status}`);
    const refreshed = await tech.wait((m) => m.t === 'question_groups');
    assert.equal(refreshed.groups.length, 0,
      `open tech console must drop question groups from the ended talk, got ${JSON.stringify(refreshed.groups)}`);

    const lateTech = socket(`ws://${HOST}:${port}/ws?room=1&role=tech&key=tk&clientId=smoke-tech-late`);
    sockets.push(lateTech);
    await lateTech.opened;
    const snap = await lateTech.wait((m) => m.t === 'question_groups');
    assert.equal(snap.groups.length, 0,
      `new tech console must not see question groups from an ended talk, got ${JSON.stringify(snap.groups)}`);

    // The question_groups snapshot is capped at the 50 groups with the most recent activity.
    for (let i = 0; i < 51; i++) {
      const q = await http(base, 'POST', '/api/questions', {
        body: { room: '3', text: `zcap${i} zword${i}`, clientId: `smoke-cap-${i}` },
      });
      assert.equal(q.status, 200, `question ${i} for the cap check must return 200, got ${q.status}`);
    }
    const reask = await http(base, 'POST', '/api/questions', {
      body: { room: '3', text: 'zcap0 zword0', clientId: 'smoke-cap-reask' },
    });
    assert.equal(reask.status, 200, `a renewed ask for an older group must return 200, got ${reask.status}`);
    const capTech = socket(`ws://${HOST}:${port}/ws?room=3&role=tech&key=tk`);
    sockets.push(capTech);
    await capTech.opened;
    const snapshot = await capTech.wait((m) => m.t === 'question_groups' && Array.isArray(m.groups));
    assert.equal(snapshot.groups.length, 50, `the snapshot must hold 50 groups, got ${snapshot.groups.length}`);
    const reasked = snapshot.groups.find((g) => g.text === 'zcap0 zword0');
    assert.ok(reasked, 'the snapshot must keep an older group after renewed activity');
    assert.equal(reasked.count, 2, 'the renewed ask must increase the older group count');
    assert.ok(!snapshot.groups.some((g) => g.text === 'zcap1 zword1'), 'the snapshot must drop the least-recently-active group');
    assert.ok(snapshot.groups.some((g) => g.text === 'zcap50 zword50'), 'the snapshot must keep the newest group');

    console.log('smoke: all checks passed');
  } catch (err) {
    console.error(`smoke: FAILED — ${err.message}`);
    if (output.trim()) console.error(`server output:\n${output.trim()}`);
    process.exitCode = 1;
  } finally {
    for (const s of sockets) s.close();
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
        resolve();
      }, 3000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        child.kill('SIGTERM');
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }
}

main().catch((err) => {
  console.error(`smoke: FAILED — ${err.message}`);
  process.exitCode = 1;
});
