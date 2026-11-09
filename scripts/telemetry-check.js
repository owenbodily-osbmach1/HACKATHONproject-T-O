#!/usr/bin/env node
// Privacy check for telemetry: what would reach Dash0 must not contain the caller's IP address,
// user agent, query strings or raw ids, or this machine's host name / OS user.
// Starts a local OTLP sink (stands in for Dash0), points a real server at it, makes requests that
// carry a test IP, user agent, search term and clientId, and greps every exported span, metric
// and log record for them. The OTLP exporters send strings as-is (JSON or protobuf), so a plain
// text search of the raw request bodies is enough.
const assert = require('assert');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

const LEAKS = {
  ip: '203.0.113.77',
  userAgent: 'PulseLeakTestAgent/9.9',
  search: 'zebrasecretterm',
  query: 'zebrarefvalue',
  clientId: 'leakclient42',
  hostName: os.hostname(),
  osUser: (() => { try { return os.userInfo().username; } catch { return ''; } })(),
};

(async () => {
  const bodies = { traces: [], metrics: [], logs: [] };
  const sinkPort = await freePort();
  const sink = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const kind = req.url.includes('traces') ? 'traces' : req.url.includes('metrics') ? 'metrics' : 'logs';
      bodies[kind].push(Buffer.concat(chunks).toString('latin1'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  }).listen(sinkPort, '127.0.0.1');

  const port = await freePort();
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      SPEAKER_KEY: 'sk',
      TECH_KEY: 'tk',
      SIGNIN: 'off',
      MOCK_ROOM: 'off',
      ELASTIC_URL: '',
      ELASTIC_API_KEY: '',
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${sinkPort}`,
      OTEL_EXPORTER_OTLP_HEADERS: '',
      OTEL_BSP_SCHEDULE_DELAY: '300',
      OTEL_BLRP_SCHEDULE_DELAY: '300',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });

  try {
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break; } catch { /* starting */ }
      await sleep(200);
    }
    const headers = { 'user-agent': LEAKS.userAgent, 'x-forwarded-for': LEAKS.ip, host: 'localhost' };
    const get = (p, extra = {}) => new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, path: p, method: extra.method || 'GET', headers: { ...headers, ...(extra.headers || {}) } }, (res) => { res.resume(); res.on('end', resolve); });
      req.on('error', resolve);
      req.end(extra.body || undefined);
    });
    await get(`/api/search?q=${LEAKS.search}`);
    await get(`/r/151?ref=${LEAKS.query}`);
    await get(`/api/find/next?clientId=${LEAKS.clientId}`);
    await get(`/api/clients/${LEAKS.clientId}/mute`, { method: 'POST', headers: { 'x-pulse-key': 'tk', 'content-type': 'application/json' }, body: '{"minutes":1}' });
    await get('/api/rooms');
    // Spans and logs flush within ~0.3 s; metrics export every 10 s.
    await sleep(12000);

    const traces = bodies.traces.join('\n');
    const all = [traces, bodies.metrics.join('\n'), bodies.logs.join('\n')].join('\n');
    assert.ok(bodies.traces.length > 0 && /\/api\/search/.test(traces), 'HTTP spans were exported (sanity check)');
    assert.ok(/\/api\/clients\/:clientId\/mute/.test(traces) || !/\/api\/clients\//.test(traces), 'paths with ids use the route template');
    const found = Object.entries(LEAKS).filter(([, v]) => v && v.length >= 4 && all.includes(v)).map(([k, v]) => `${k} (${v})`);
    assert.deepStrictEqual(found, [], `telemetry must not contain: ${found.join(', ')}`);
    console.log(`telemetry-check: ok (${bodies.traces.length} trace, ${bodies.metrics.length} metric, ${bodies.logs.length} log exports; no IP, user agent, query, clientId, host or OS user)`);
  } catch (err) {
    console.error(err.message);
    if (stderr) console.error(stderr.slice(-2000));
    process.exitCode = 1;
  } finally {
    child.kill();
    sink.close();
  }
})();
