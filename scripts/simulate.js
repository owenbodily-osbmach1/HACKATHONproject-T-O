#!/usr/bin/env node
// Pulse demo simulator: a fake speaker, fake phones and one incident, driven only through
// the public HTTP + WebSocket contract. Never prints or commits real keys.
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const BASE_URL = (process.env.BASE_URL || 'http://localhost:8080').replace(/\/+$/, '');
const ROOM = String(process.env.ROOM || '151');
const SPEAKER_KEY = process.env.SPEAKER_KEY || '';
const TECH_KEY = process.env.TECH_KEY || '';
const RATE = envPositive('RATE', 0.5);
const PHONES = envNonNegativeInt('PHONES', 25);
const NO_SCENARIO = process.argv.includes('--no-scenario');
const ONCE = process.argv.includes('--once');

const SAMPLE_FILE = path.join(__dirname, 'talk-sample.txt');
const TALK_TITLE = 'Cloud Native at the Edge';
const TALK_SPEAKER = 'Demo Speaker';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (msg) => console.log(`[sim] ${msg}`);

let stopping = false;
let shuttingDown = false;
let statusTimer = null;
let talkId = null;
let seq = 1;
let captionsSent = 0;
let micWs = null;
let techWs = null;
const micWaiters = [];
const phones = [];
const tickets = new Map();
const timers = new Set();

function envPositive(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    log(`${name}=${raw} is invalid; using ${fallback}`);
    return fallback;
  }
  return value;
}

function envNonNegativeInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    log(`${name}=${raw} is invalid; using ${fallback}`);
    return fallback;
  }
  return value;
}

async function api(method, pathName, body, key) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (key) headers['x-pulse-key'] = key;
  const res = await fetch(`${BASE_URL}${pathName}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  if (!res.ok) {
    const detail = typeof data === 'string' ? data : JSON.stringify(data);
    throw new Error(`${method} ${pathName} -> ${res.status}${detail ? ` ${detail.slice(0, 200)}` : ''}`);
  }
  return data;
}

function socketUrl(pathName, params) {
  const url = new URL(BASE_URL);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = pathName;
  url.search = new URLSearchParams(params).toString();
  return url.toString();
}

function trackSocket(ws, label, quiet = false) {
  ws.on('error', (err) => {
    if (!quiet && !stopping) log(`${label} socket error: ${err.message}`);
  });
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(String(data)); } catch { return; }
    if (msg && msg.t === 'ping' && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ t: 'pong' }));
    }
  });
  return ws;
}

function waitForMic() {
  if (stopping) return Promise.resolve(null);
  if (micWs && micWs.readyState === WebSocket.OPEN) return Promise.resolve(micWs);
  return new Promise((resolve) => micWaiters.push(resolve));
}

function releaseMic() {
  const ws = micWs && micWs.readyState === WebSocket.OPEN ? micWs : null;
  while (micWaiters.length) micWaiters.shift()(ws);
}

function send(ws, msg) {
  return new Promise((resolve) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return resolve(false);
    try {
      ws.send(JSON.stringify(msg), (err) => resolve(!err));
    } catch {
      resolve(false);
    }
  });
}

function partial(text) {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 4) return text.slice(0, Math.max(1, Math.floor(text.length / 2)));
  const take = Math.min(words.length - 1, Math.max(2, Math.ceil(words.length * 0.45)));
  return words.slice(0, take).join(' ');
}

async function runMic() {
  const url = socketUrl('/ws', { room: ROOM, role: 'mic', key: SPEAKER_KEY });
  const backoff = [1, 2, 4, 8, 10];
  let failures = 0;
  while (!stopping) {
    const ws = trackSocket(new WebSocket(url), 'mic');
    micWs = ws;
    const closed = new Promise((resolve) => ws.once('close', (code) => resolve(code)));
    const opened = await Promise.race([
      new Promise((resolve) => ws.once('open', () => resolve(true))),
      closed.then(() => false),
    ]);

    if (opened) {
      failures = 0;
      log('mic connected');
      releaseMic();
      const code = await closed;
      if (micWs === ws) micWs = null;
      if (stopping) break;
      log(`mic closed (${code}); reconnecting`);
    } else {
      if (micWs === ws) micWs = null;
      if (stopping) break;
      log('mic connect failed');
    }

    const wait = backoff[Math.min(failures, backoff.length - 1)];
    failures += 1;
    log(`mic reconnect in ${wait}s`);
    await sleep(wait * 1000);
  }
}

async function runCaptions() {
  const lines = fs.readFileSync(SAMPLE_FILE, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) throw new Error(`${SAMPLE_FILE} has no caption lines`);
  log(`loaded ${lines.length} caption lines`);

  const period = 1000 / RATE;
  const interimDelay = Math.min(400, period / 3);
  let index = 0;

  while (!stopping) {
    const first = await waitForMic();
    if (!first) break;
    const text = lines[index];
    await send(first, { t: 'caption_interim', text: partial(text) });
    await sleep(interimDelay);

    const second = await waitForMic();
    if (!second) break;
    const ok = await send(second, { t: 'caption', talkId, seq, text, ts: Date.now() });
    if (!ok) continue;

    seq += 1;
    captionsSent += 1;
    index += 1;
    if (ONCE && index >= lines.length) {
      log(`sample finished after ${captionsSent} captions`);
      return true;
    }
    if (index >= lines.length) index = 0;
    await sleep(Math.max(0, period - interimDelay));
  }
  return false;
}

async function connectPhones() {
  if (PHONES === 0) {
    log('no attendee sockets configured');
    return;
  }
  log(`opening ${PHONES} attendee sockets`);
  for (let n = 1; n <= PHONES && !stopping; n += 1) {
    const ws = trackSocket(
      new WebSocket(socketUrl('/ws', { room: ROOM, role: 'attendee', clientId: `sim-${n}` })),
      'attendee',
      true,
    );
    phones.push(ws);
    if (n < PHONES) await sleep(50);
  }
}

function connectTech() {
  if (!TECH_KEY || NO_SCENARIO) return;
  techWs = trackSocket(new WebSocket(socketUrl('/ws', { room: ROOM, role: 'tech', key: TECH_KEY })), 'tech');
  techWs.on('open', () => log('tech socket connected'));
  techWs.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(String(data)); } catch { return; }
    if (msg && msg.t === 'ticket' && msg.id) {
      if (!tickets.has(msg.id)) {
        log(`ticket seen: ${msg.id} type=${msg.type} status=${msg.status} people=${msg.people}`);
      }
      tickets.set(msg.id, msg);
    }
  });
}

function later(ms, label, fn) {
  const timer = setTimeout(() => {
    timers.delete(timer);
    log(label);
    Promise.resolve().then(fn).catch((err) => log(`${label} failed: ${err.message}`));
  }, ms);
  timers.add(timer);
}

async function findTicketId(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!stopping && Date.now() < deadline) {
    if (tickets.size) return [...tickets.keys()][0];
    await sleep(250);
  }
  return tickets.size ? [...tickets.keys()][0] : null;
}

function startScenario() {
  if (NO_SCENARIO) {
    log('scenario disabled');
    return;
  }
  log('scenario armed: votes at 20s, questions at 35s, fix at 60s, feedback at 70s');

  later(20000, '20s: four attendees report cant_hear', async () => {
    const voters = ['sim-1', 'sim-2', 'sim-3', 'sim-4'];
    const results = await Promise.all(voters.map((clientId) => api('PUT', '/api/votes', {
      room: ROOM,
      talkId,
      type: 'cant_hear',
      clientId,
      on: true,
    })));
    const count = Math.max(0, ...results.map((r) => Number(r && r.count) || 0));
    const status = (results.find((r) => r && r.ticketStatus) || {}).ticketStatus || 'unknown';
    log(`votes sent: count=${count} ticket=${status}`);
  });

  later(35000, '35s: questions from four attendees', async () => {
    const questions = [
      ['sim-5', 'When the uplink drops at an edge site, do the nodes buffer telemetry locally or do we lose those spans?'],
      ['sim-6', 'If the uplink goes down, do edge nodes buffer telemetry or drop the spans?'],
      ['sim-7', 'When connectivity drops, are telemetry spans buffered at the edge or lost?'],
      ['sim-8', 'How do you keep Kubernetes upgrade windows from interrupting live captions?'],
    ];
    const results = await Promise.all(questions.map(([clientId, text]) => api('POST', '/api/questions', {
      room: ROOM,
      talkId,
      text,
      clientId,
    })));
    const groups = [...new Set(results.map((r) => r && r.groupId).filter(Boolean))];
    log(`questions sent: 3 near-duplicates + 1 distinct; groups=${groups.join(',') || 'n/a'}`);
  });

  later(60000, '60s: claim and fix the ticket', async () => {
    if (!TECH_KEY) {
      log('TECH_KEY not set; skipping claim/fixed');
      return;
    }
    const id = await findTicketId(5000);
    if (!id) {
      log('no ticket seen; skipping claim/fixed');
      return;
    }
    const claim = await api('POST', `/api/tickets/${encodeURIComponent(id)}/claim`, { by: 'sim-tech' }, TECH_KEY);
    log(`ticket ${id} claimed (${claim && claim.status})`);
    const fixed = await api('POST', `/api/tickets/${encodeURIComponent(id)}/fixed`, { by: 'sim-tech' }, TECH_KEY);
    log(`ticket ${id} fixed (${fixed && fixed.status})`);
  });

  later(70000, '70s: two attendees say it is better', async () => {
    const id = [...tickets.keys()][0];
    if (!id) {
      log('no ticket id seen; skipping feedback');
      return;
    }
    await Promise.all(['sim-9', 'sim-10'].map((clientId) => api('POST', '/api/feedback', {
      ticketId: id,
      clientId,
      better: true,
    })));
    log('feedback better:true sent by 2 clients');
  });
}

function attendeesConnected() {
  return phones.filter((ws) => ws.readyState === WebSocket.OPEN).length;
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  stopping = true;
  clearInterval(statusTimer);
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
  while (micWaiters.length) micWaiters.shift()(null);
  log(`final captions=${captionsSent} attendees=${attendeesConnected()} ticketsSeen=${tickets.size}`);
  for (const ws of [...phones, micWs, techWs]) {
    if (!ws) continue;
    try { ws.close(1000); } catch { /* already closed */ }
  }
  setTimeout(() => process.exit(code), 50);
}

async function main() {
  if (!SPEAKER_KEY) {
    console.error('[sim] SPEAKER_KEY is required');
    process.exit(2);
  }

  log(`room=${ROOM} url=${BASE_URL} rate=${RATE}/s phones=${PHONES} scenario=${NO_SCENARIO ? 'off' : 'on'} mode=${ONCE ? 'once' : 'loop'}`);
  const talk = await api('POST', '/api/talks', {
    room: ROOM,
    title: TALK_TITLE,
    speaker: TALK_SPEAKER,
  }, SPEAKER_KEY);
  if (!talk || !talk.talkId) throw new Error('POST /api/talks did not return talkId');
  talkId = talk.talkId;
  log(`talk created: ${talkId}`);

  connectTech();
  connectPhones().catch((err) => log(`attendee sockets failed: ${err.message}`));
  runMic().catch((err) => log(`mic loop failed: ${err.message}`));
  statusTimer = setInterval(() => {
    log(`status captions=${captionsSent} attendees=${attendeesConnected()} ticketsSeen=${tickets.size}`);
  }, 10000);
  startScenario();

  const finished = await runCaptions();
  if (ONCE && finished) {
    log('ending talk');
    const report = await api('POST', `/api/talks/${encodeURIComponent(talkId)}/end`, undefined, SPEAKER_KEY);
    if (report && report.reportUrl) console.log(`report: ${report.reportUrl}`);
    else log('end did not return reportUrl');
    shutdown(0);
  }
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

main().catch((err) => {
  console.error(`[sim] fatal: ${err.message}`);
  shutdown(1);
});
