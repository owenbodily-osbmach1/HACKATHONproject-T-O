#!/usr/bin/env node
// Browser check for real-user monitoring (public/rum.js): with RUM on, what the phone sends to Dash0
// must not contain a search term, a ?key=, a talk id from the path or the full user agent.
// A headless Chrome opens the transcript page with ?key= and a search in the URL, runs a search
// request, then leaves the page (flush). A local sink stands in for Dash0 and captures every export.
// Skipped (exit 0) when no Chrome is installed.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const CHROME = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => p && fs.existsSync(p));

const SEARCH = 'zebrasecretterm';
const KEY = 'leakkeyzz9';
const TALK = 'abc123talk';

(async () => {
  if (!CHROME) { console.log('rum-check: skipped (no Chrome found; set CHROME=/path/to/chrome)'); return; }

  const exports = [];
  const sinkPort = await freePort();
  const sink = http.createServer((req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', '*');
    res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { exports.push({ url: req.url, body: Buffer.concat(chunks).toString('latin1') }); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
  }).listen(sinkPort, '127.0.0.1');

  const port = await freePort();
  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), SPEAKER_KEY: 'sk', TECH_KEY: 'tk', SIGNIN: 'off', MOCK_ROOM: 'off',
      ELASTIC_URL: '', ELASTIC_API_KEY: '', OTEL_EXPORTER_OTLP_ENDPOINT: '',
      DASH0_RUM_TOKEN: 'test-ingest-token', DASH0_RUM_ENDPOINT: `http://127.0.0.1:${sinkPort}` },
    stdio: 'ignore',
  });
  const debugPort = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-rum-check-'));
  // CI runners (Ubuntu) block the user namespaces Chrome's sandbox needs; this throwaway test browser
  // only opens our own local page, so it runs without the sandbox there.
  const sandbox = process.platform === 'linux' ? ['--no-sandbox'] : [];
  const chrome = spawn(CHROME, ['--headless=new', ...sandbox, `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });

  try {
    for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break; } catch { /* starting */ } await sleep(200); }
    let target;
    for (let i = 0; i < 60 && !target; i++) {
      try { target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' })).json(); } catch { await sleep(250); }
    }
    const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
    await new Promise((r) => ws.on('open', r));
    let id = 0;
    const pending = new Map();
    ws.on('message', (d) => { const m = JSON.parse(d); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
    const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
    await send('Page.enable');
    const realUa = (await send('Browser.getVersion')).result.userAgent;

    await send('Page.navigate', { url: `http://localhost:${port}/t/${TALK}?key=${KEY}&q=${SEARCH}#frag-${SEARCH}` });
    await sleep(4000);
    const rumOn = await evaluate('typeof window.dash0 === "function" && !!window.PULSE_RUM');
    assert.ok(rumOn, 'RUM loaded on the page (sanity check)');
    await evaluate(`fetch('/api/search?q=${SEARCH}&key=${KEY}').then(r => r.status)`);
    await sleep(6000);
    await send('Page.navigate', { url: 'about:blank' }); // page hide flushes the SDK's queue
    await sleep(3000);

    const all = exports.map((e) => e.body).join('\n');
    assert.ok(exports.length > 0, 'the SDK exported something to the sink (sanity check)');
    const leaks = [['search term', SEARCH], ['key', KEY], ['talk id in the path', TALK], ['full user agent', realUa]].filter(([, v]) => all.includes(v));
    assert.deepStrictEqual(leaks.map(([k]) => k), [], `RUM export must not contain: ${leaks.map(([k, v]) => `${k} (${v})`).join(', ')}`);
    assert.ok(/\/t\/:id/.test(all), 'page URLs are reported as route templates');
    console.log(`rum-check: ok (${exports.length} exports; no search term, key, path id or full user agent)`);
    ws.close();
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    chrome.kill();
    server.kill();
    sink.close();
  }
})();
