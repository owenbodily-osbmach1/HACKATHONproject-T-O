#!/usr/bin/env node
// Privacy checks without a browser:
// 1. Device ids: votes, questions and booth check-ins reach Elasticsearch only as salted hashes, never
//    the phone's clientId (a fake Elasticsearch captures every write), and the retention job sends a
//    delete-by-age request for exactly the device-id indices.
// 2. Captured slides: private + no-store, a random token in the URL (a guessed URL is 404), and the
//    same access as the room: signed in to that room or a speaker/tech key; signed out or another
//    room's phone is 403.
const assert = require('assert');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
// 1x1 JPEG
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');

(async () => {
  // Fake Elasticsearch: every request body is captured; answers like ES would.
  const esBodies = [];
  const esPort = await freePort();
  const fakeEs = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      esBodies.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(req.url.includes('_delete_by_query') ? '{"deleted":4}' : req.url.includes('_search') ? '{"hits":{"hits":[]}}' : '{"result":"created"}');
    });
  }).listen(esPort, '127.0.0.1');

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      SPEAKER_KEY: 'sk',
      TECH_KEY: 'tk',
      SIGNIN: 'on',
      MOCK_ROOM: 'off',
      ALERT_THRESHOLD: '1',
      ELASTIC_URL: `http://127.0.0.1:${esPort}`,
      ELASTIC_API_KEY: 'test',
      OTEL_EXPORTER_OTLP_ENDPOINT: '',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const call = async (method, p, { body, headers = {}, cookie } = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: { ...(body && !Buffer.isBuffer(body) ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: body ? (Buffer.isBuffer(body) ? body : JSON.stringify(body)) : undefined,
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
  };
  // A phone that scanned `room` and signed in.
  const phone = async (room) => {
    const r = await fetch(`${base}/r/${room}`);
    const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
    await call('POST', '/api/signin', { cookie, body: { room, first: 'Test', last: 'Phone', company: 'QA', email: 'qa@example.com' } });
    return cookie;
  };

  try {
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* starting */ }
      await sleep(200);
    }

    // ---------- 1. device ids ----------
    const RAW = 'rawphoneid12345';
    const inRoom = await phone('151');
    const { talkId } = (await call('POST', '/api/talks', { headers: { 'x-pulse-key': 'sk' }, body: { room: '151', title: 'T' } })).json;
    assert.equal((await call('PUT', '/api/votes', { cookie: inRoom, body: { room: '151', talkId, type: 'cant_hear', clientId: RAW, on: true } })).status, 200, 'vote accepted');
    assert.equal((await call('POST', '/api/questions', { cookie: inRoom, body: { room: '151', talkId, text: 'privacy check question', clientId: RAW } })).status, 200, 'question accepted');
    const booth = (await call('GET', '/api/booths')).json[0].id;
    await call('POST', `/api/booths/${booth}/checkin`, { body: { clientId: RAW } });
    await sleep(800);
    const writes = esBodies.filter((b) => /pulse-(signals|questions|checkins)/.test(b.url) && b.method !== 'HEAD');
    assert.ok(writes.some((w) => w.url.includes('pulse-signals')), 'the vote was written to pulse-signals');
    assert.ok(writes.some((w) => w.url.includes('pulse-questions')), 'the question was written to pulse-questions');
    assert.ok(writes.some((w) => w.url.includes('pulse-checkins')), 'the check-in was written to pulse-checkins');
    assert.ok(!esBodies.some((b) => b.body.includes(RAW)), 'no raw clientId in any Elasticsearch request');
    const signal = JSON.parse(writes.find((w) => w.url.includes('pulse-signals')).body);
    assert.match(String(signal.clientId), /^[a-f0-9]{24}$/, 'pulse-signals holds a salted hash');

    const retention = require('../server/es-retention');
    const es = { enabled: true, raw: (method, p, body) => { esBodies.push({ method, url: p, body: JSON.stringify(body) }); return Promise.resolve({ deleted: 4 }); } };
    const { deleted } = await retention.runRetention(es, 30);
    const del = esBodies[esBodies.length - 1];
    assert.equal(deleted, 4);
    assert.ok(del.url.startsWith('/pulse-signals,pulse-questions,pulse-checkins/_delete_by_query'), 'retention deletes from the device-id indices');
    assert.deepStrictEqual(JSON.parse(del.body), { query: { range: { ts: { lt: 'now-30d' } } } }, 'retention deletes documents older than 30 days');

    // ---------- 2. captured slides ----------
    const up = await call('POST', '/api/rooms/151/slide-frame', { headers: { 'x-pulse-key': 'sk', 'content-type': 'image/jpeg' }, body: JPEG });
    assert.equal(up.status, 200, 'frame uploaded');
    const url = up.json.url;
    assert.match(url, /^\/slides\/live\/[^/]+\/1-[a-f0-9]{16}\.jpg$/, 'frame url carries a random token');
    let r = await call('GET', url, { cookie: inRoom });
    assert.equal(r.status, 200, 'a phone signed in to the room gets the frame');
    assert.equal(r.headers.get('cache-control'), 'private, no-store', 'frames are never cached');
    r = await call('GET', url);
    assert.equal(r.status, 403, 'a signed-out request is refused');
    assert.equal(r.headers.get('cache-control'), 'private, no-store');
    const otherRoom = await phone('152');
    assert.equal((await call('GET', url, { cookie: otherRoom })).status, 403, 'a phone signed in to another room is refused');
    assert.equal((await call('GET', url, { headers: { 'x-pulse-key': 'tk' } })).status, 200, 'the tech key can view it');
    assert.equal((await call('GET', url.replace(/-[a-f0-9]{16}\.jpg$/, '.jpg'), { cookie: inRoom })).status, 404, 'a guessed url is 404');
    assert.equal((await call('GET', url.replace(/-[a-f0-9]{16}\.jpg$/, '-0000000000000000.jpg'), { cookie: inRoom })).status, 404, 'a wrong token is 404');

    console.log('privacy-check: ok (hashed device ids in Elasticsearch, 30-day retention, private slide captures)');
  } catch (err) {
    console.error(err.message);
    if (stderr) console.error(stderr.slice(-1500));
    process.exitCode = 1;
  } finally {
    child.kill();
    fakeEs.close();
  }
})();
