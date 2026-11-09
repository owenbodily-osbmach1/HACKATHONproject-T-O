// End-to-end check for the privacy page/API, printable cards, Prometheus metrics and booth dwell.
// Run: node scripts/extras-check.js. Boots server/index.js on a free port, no Elasticsearch, no Dash0.
const assert = require('assert');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const HOST = '127.0.0.1';
const READY_MS = 15000;

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
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, text, json };
}

// Every object key anywhere in the response. The privacy API must never carry a field
// literally named name, email, phone or ip.
function keysOf(value, out = []) {
  if (Array.isArray(value)) {
    for (const item of value) keysOf(item, out);
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      out.push(key);
      keysOf(child, out);
    }
  }
  return out;
}

async function checkin(base, boothId, clientId) {
  const res = await http(base, 'POST', `/api/booths/${encodeURIComponent(boothId)}/checkin`, {
    body: { clientId },
  });
  assert.equal(res.status, 200, `booth check-in must return 200, got ${res.status}`);
  return res.json;
}

async function report(base, boothId) {
  const res = await http(base, 'GET', `/api/booths/${encodeURIComponent(boothId)}/report`, { key: 'tk' });
  assert.equal(res.status, 200, `booth report must return 200, got ${res.status}`);
  return res.json;
}

async function main() {
  const port = await freePort();
  const base = `http://${HOST}:${port}`;
  let output = '';
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      SPEAKER_KEY: 'sk',
      TECH_KEY: 'tk',
      ELASTIC_URL: '',
      ELASTIC_API_KEY: '',
      OTEL_EXPORTER_OTLP_ENDPOINT: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { output += d.toString(); });
  child.stderr.on('data', (d) => { output += d.toString(); });

  try {
    await waitForHealth(base, child);

    // Privacy page + API.
    const privacyPage = await http(base, 'GET', '/privacy');
    assert.equal(privacyPage.status, 200, `/privacy must return 200, got ${privacyPage.status}`);
    assert.ok(/no names, no email addresses, no phone numbers, no IP addresses/i.test(privacyPage.text),
      '/privacy must state what is never stored');

    const api = await http(base, 'GET', '/api/privacy');
    assert.equal(api.status, 200, `/api/privacy must return 200, got ${api.status}`);
    assert.ok(api.json && Array.isArray(api.json.indices) && api.json.indices.length > 0,
      '/api/privacy must list the indices Pulse writes');
    for (const item of api.json.indices) {
      assert.ok(item.index && Array.isArray(item.fields) && item.fields.length > 0,
        `${item.index} must list its fields`);
    }
    const forbidden = new Set(['name', 'email', 'phone', 'ip']);
    const bad = keysOf(api.json).filter((key) => forbidden.has(key.toLowerCase()));
    assert.deepStrictEqual(bad, [], `/api/privacy must not expose fields named ${[...forbidden].join('/')}`);
    assert.strictEqual(api.json.source, 'static', 'without Elasticsearch the index list comes from es-setup');

    // Printable cards page.
    const cards = await http(base, 'GET', '/cards');
    assert.equal(cards.status, 200, `/cards must return 200, got ${cards.status}`);
    assert.ok(cards.text.includes('/vendor/qrcode.js'), '/cards must load the vendored QR library');

    // Narrow phones: /tech and /mic must not scroll horizontally at 320 px. No browser
    // dependency here, so assert the served CSS carries the guards that prevent it.
    const css = await http(base, 'GET', '/styles.css');
    assert.equal(css.status, 200, `/styles.css must return 200, got ${css.status}`);
    assert.ok(
      /\.podium-top > \*[^{]*\{[^}]*min-width: 0/.test(css.text) &&
        /\.b-room[^{]*\{[^}]*overflow-wrap: anywhere/.test(css.text) &&
        /@media \(max-width: 360px\)[\s\S]*?\.tech-main \{ padding-left: 10px; padding-right: 10px; \}/.test(css.text),
      '/styles.css must keep /tech and /mic cards inside a 320 px viewport'
    );

    // Prometheus metrics.
    const metrics = await http(base, 'GET', '/metrics');
    assert.equal(metrics.status, 200, `/metrics must return 200, got ${metrics.status}`);
    assert.ok(/^pulse_up 1$/m.test(metrics.text), '/metrics must contain pulse_up 1');
    assert.ok(/^process_resident_memory_bytes \d+$/m.test(metrics.text),
      '/metrics must contain process_resident_memory_bytes');

    // Booth dwell: null below 3 devices, a range at 3.
    const list = await http(base, 'GET', '/api/booths');
    assert.equal(list.status, 200, '/api/booths must return 200');
    assert.ok(Array.isArray(list.json) && list.json.length >= 2, 'at least two booths are configured');
    const [first, second] = list.json;

    for (const clientId of ['extras-d1', 'extras-d2']) {
      await checkin(base, first.id, clientId);
      await checkin(base, second.id, clientId);
    }
    const under = await report(base, first.id);
    assert.strictEqual(under.dwell, null, 'dwell must be null with fewer than 3 devices');

    await checkin(base, first.id, 'extras-d3');
    await checkin(base, second.id, 'extras-d3');
    const over = await report(base, first.id);
    assert.ok(over.dwell && typeof over.dwell === 'object', 'dwell must be present with 3 devices');
    assert.strictEqual(over.dwell.n, 3, `dwell.n must be 3, got ${over.dwell.n}`);
    assert.ok(Number.isFinite(over.dwell.medianMin), 'dwell.medianMin must be a number');
    assert.ok(Number.isFinite(over.dwell.p90Min), 'dwell.p90Min must be a number');
    assert.ok(over.dwell.medianMin >= 0 && over.dwell.medianMin <= over.dwell.p90Min,
      'dwell median must not exceed p90');
    assert.ok(over.dwell.p90Min <= 15, 'dwell is capped at 15 minutes');

    console.log('extras-check: ok');
  } catch (err) {
    console.error(`extras-check: FAILED — ${err.message}`);
    if (output.trim()) console.error(`server output:\n${output.trim()}`);
    process.exitCode = 1;
  } finally {
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
      try { child.kill('SIGTERM'); } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }
}

main().catch((err) => {
  console.error(`extras-check: FAILED — ${err.message}`);
  process.exitCode = 1;
});
