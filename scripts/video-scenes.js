#!/usr/bin/env node
// Video scenes: one command per shot of the submission video (docs/video-shoot.md).
//
//   node scripts/video-scenes.js <scene> [--no-windows] [--port 8090]
//   scenes: qr | join | alert | rooms | end
//
// Every take starts its OWN fresh server (fresh keys, empty state, demo room 255), so take 2 looks
// exactly like take 1. It then drives a fake speaker, fake phones and the AV-side events on a fixed
// clock, opens the Chrome windows for the shot at fixed sizes and positions, and prints cues
// ("NOW: click Claim"). Ctrl+C ends the take and stops the server. Nothing is written to Elasticsearch
// (no ELASTIC_* in the child's environment unless you set VIDEO_ELASTIC=1).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const scene = (args.find((a) => !a.startsWith('--')) || '').toLowerCase();
const NO_WINDOWS = args.includes('--no-windows');
const PORT = Number((args[args.indexOf('--port') + 1] || '').match(/^\d+$/) ? args[args.indexOf('--port') + 1] : process.env.VIDEO_PORT || 8090);
const BASE = `http://localhost:${PORT}`;
const SPEAKER_KEY = crypto.randomBytes(6).toString('hex');
const TECH_KEY = crypto.randomBytes(6).toString('hex');
const SCENES = {
  qr: 'Problem + QR: the presenter screen with the join QR, before the talk starts',
  join: 'Scan -> sign-in -> captions, listen-in and slides arrive on the phone',
  alert: '3 phones tap "Can\'t hear" -> AV console red -> Claim -> Mark fixed -> "Better now?"',
  rooms: 'AV switches 151 -> 255 -> 152: fill bars, scan counts, Live status, ⚠ on a quiet room',
  end: 'End the talk -> phones show Ended -> transcript -> search',
};

if (!SCENES[scene]) {
  console.log('Usage: node scripts/video-scenes.js <scene> [--no-windows] [--port 8090]\n');
  for (const [k, v] of Object.entries(SCENES)) console.log(`  ${k.padEnd(6)} ${v}`);
  process.exit(scene ? 1 : 0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const stamp = () => `${String(Math.floor((Date.now() - t0) / 1000)).padStart(3, ' ')}s`;
const say = (msg) => console.log(`[${stamp()}] ${msg}`);
const cue = (msg) => console.log(`\n[${stamp()}] >>> NOW: ${msg}\n`);
const lines = fs.readFileSync(path.join(ROOT, 'scripts', 'talk-sample.txt'), 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
const sockets = [];
const timers = [];
const windows = []; // Chrome windows this take opened: closed again by Ctrl+C
let server = null;

// ---------- server ----------
async function startServer({ signin, demoRoom = false }) {
  // A take that is still running (or any server) on this port would answer instead of the fresh one.
  try {
    await fetch(`${BASE}/healthz`);
    throw new Error(`port ${PORT} is busy: stop the previous take (Ctrl+C in its window) or use --port`);
  } catch (e) { if (/busy/.test(e.message)) throw e; }
  const env = {
    ...process.env,
    PORT: String(PORT),
    SPEAKER_KEY,
    TECH_KEY,
    PUBLIC_BASE_URL: process.env.VIDEO_BASE || BASE, // set VIDEO_BASE to a tunnel URL to scan with a real phone
    ALERT_THRESHOLD: '3',
    SIGNIN: signin ? 'on' : 'off',
    MOCK_ROOM: demoRoom ? '255' : 'off', // the demo room only where the shot needs a second room
    AUTO_END_MIN: '0',
  };
  if (process.env.VIDEO_ELASTIC !== '1') { delete env.ELASTIC_URL; delete env.ELASTIC_API_KEY; }
  server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  server.on('exit', (code) => { if (code) console.error(`[server] exited ${code} (is port ${PORT} free?)`); });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) return; } catch { /* starting */ }
    await sleep(250);
  }
  throw new Error(`server did not start on ${BASE}`);
}

async function api(method, p, body, key) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'content-type': 'application/json', ...(key ? { 'x-pulse-key': key } : {}), ...(body && body.cookie ? { cookie: body.cookie } : {}) },
    body: body ? JSON.stringify(body.json || body) : undefined,
  });
  return res.json().catch(() => ({}));
}

function socket(q, extraHeaders) {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws?${new URLSearchParams(q)}`, { headers: extraHeaders || {} });
  ws.on('error', () => {});
  sockets.push(ws);
  return new Promise((resolve) => ws.on('open', () => resolve(ws)));
}
const send = (ws, msg) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };

// ---------- the speaker: a talk, captions on a fixed clock, a podium level ----------
async function startTalk(room, title, speaker, { lineMs = 3500, firstLines = 0, audioDb = -22 } = {}) {
  const { talkId } = await api('POST', '/api/talks', { room, title, speaker }, SPEAKER_KEY);
  const mic = await socket({ room, role: 'mic', key: SPEAKER_KEY });
  let seq = 0;
  let i = 0;
  const next = () => lines[i++ % lines.length];
  for (let k = 0; k < firstLines; k++) send(mic, { t: 'caption', talkId, seq: ++seq, text: next(), ts: Date.now() - (firstLines - k) * 7000, title, speaker });
  const speak = () => {
    const text = next();
    send(mic, { t: 'caption_interim', text: text.split(' ').slice(0, 5).join(' ') });
    timers.push(setTimeout(() => send(mic, { t: 'caption', talkId, seq: ++seq, text, ts: Date.now(), title, speaker }), 900));
  };
  if (lineMs) timers.push(setInterval(speak, lineMs));
  if (audioDb !== null) await podiumAudio(room, audioDb);
  return { talkId, mic };
}

// 100 ms frames of quiet noise at about `db` dBFS: the AV panel shows a real mic level, and phones can
// press Listen. -100 = a silent mic (the AV tab shows "⚠ mic quiet").
async function podiumAudio(room, db) {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws/audio-in?room=${room}&key=${SPEAKER_KEY}`);
  ws.on('error', () => {});
  sockets.push(ws);
  await new Promise((r) => ws.on('open', r));
  const amp = db <= -100 ? 0 : 32767 * Math.pow(10, db / 20) * Math.SQRT2;
  timers.push(setInterval(() => {
    const frame = Buffer.alloc(3200);
    for (let k = 0; k < 1600; k++) frame.writeInt16LE(Math.round((Math.random() * 2 - 1) * amp * (0.7 + 0.3 * Math.sin(Date.now() / 300))), k * 2);
    if (ws.readyState === WebSocket.OPEN) ws.send(frame, { binary: true });
  }, 100));
}

// ---------- background phones ----------
let phoneN = 0;
async function phone(room, signin) {
  const n = ++phoneN;
  const clientId = `video-phone-${n}`;
  // The scan: GET /r/:room issues the visitor cookie the server counts (and needs for sign-in).
  const res = await fetch(`${BASE}/r/${room}`);
  const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  if (signin) {
    await api('POST', '/api/signin', { cookie, json: { room, first: `Guest${n}`, last: 'Demo', company: 'Video extra', email: `guest${n}@example.com` } });
  }
  const ws = await socket({ room, role: 'attendee', clientId }, cookie ? { cookie } : {});
  return { n, clientId, cookie, ws };
}
async function crowd(room, count, signin) {
  const out = [];
  for (let k = 0; k < count; k++) { out.push(await phone(room, signin)); await sleep(15); }
  return out;
}
const vote = (p, room, talkId, type = 'cant_hear') => api('PUT', '/api/votes', { cookie: p.cookie, json: { room, talkId, type, clientId: p.clientId, on: true } });

// ---------- windows ----------
// Fixed layout for a 1920x1080 display: console/projector on the left, a phone-sized window on the right.
const LAYOUT = {
  left: { x: 0, y: 0, w: 1440, h: 1040 },
  phone: { x: 1460, y: 0, w: 430, h: 932 },
  full: { x: 0, y: 0, w: 1920, h: 1040 },
};
function chromePath() {
  const c = [
    process.env.CHROME,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
  ].filter(Boolean);
  return c.find((p) => fs.existsSync(p));
}
function openWindow(url, where, label) {
  if (NO_WINDOWS) { say(`(window ${label}: ${url})`); return; }
  const chrome = chromePath();
  if (!chrome) { say(`Chrome not found: open ${url} yourself (${label})`); return; }
  // A fresh profile per window and per take: no old cookies (the phone sees the sign-in form every time).
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), `pulse-video-${label}-`));
  const g = LAYOUT[where];
  windows.push(spawn(chrome, [`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-features=Translate',
    `--app=${url}`, `--window-position=${g.x},${g.y}`, `--window-size=${g.w},${g.h}`], { stdio: 'ignore' }));
  say(`opened ${label}: ${url.replace(/key=[a-f0-9]+/, 'key=…')}`);
}

// ---------- scenes ----------
async function sceneQr() {
  await startServer({ signin: true });
  openWindow(`${BASE}/present/151?key=${SPEAKER_KEY}&deck=demo`, 'full', 'projector');
  say('Room 151 has no talk yet: the title slide shows the join QR.');
  cue('record the projector (title slide + QR) for ~10 s; then Ctrl+C');
}

async function sceneJoin() {
  await startServer({ signin: true });
  await crowd('151', 18, true);
  const { talkId } = await startTalk('151', 'Cloud Native at the Edge', 'Tyler & Owen', { lineMs: 3500 });
  openWindow(`${BASE}/present/151?key=${SPEAKER_KEY}&deck=demo`, 'left', 'projector');
  openWindow(`${BASE}/r/151`, 'phone', 'phone');
  say(`talk ${talkId} live, 18 phones in the room, a caption every 3.5 s`);
  cue('PHONE: fill the sign-in form (any name, an @example.com email) and tap Join the room');
  timers.push(setTimeout(() => cue('PHONE: tap "Both" (slides + captions); PROJECTOR: press → twice, ~4 s apart'), 15000));
  timers.push(setTimeout(() => cue('PHONE: tap "Listen with earbuds" (meter moves); then Ctrl+C'), 26000));
}

async function sceneAlert() {
  await startServer({ signin: false });
  const phones = await crowd('151', 41, false);
  const { talkId } = await startTalk('151', 'Cloud Native at the Edge', 'Tyler & Owen', { lineMs: 3500, firstLines: 6 });
  const tech = await socket({ room: '151', role: 'tech', key: TECH_KEY });
  openWindow(`${BASE}/tech?key=${TECH_KEY}&rooms=151#room=151`, 'left', 'AV console');
  openWindow(`${BASE}/r/151`, 'phone', 'phone');
  say(`talk ${talkId} live, 41 phones in the room`);
  cue('PHONE: tap "Speak up" (the first of 3 votes)');
  let fired = false;
  const twoMore = async () => {
    if (fired) return;
    fired = true;
    await sleep(1200); await vote(phones[0], '151', talkId); say('2nd phone voted');
    await sleep(1200); await vote(phones[1], '151', talkId); say('3rd phone voted: the ticket opens');
    cue('AV: click Claim, wait 2 s, click Mark fixed');
  };
  // The visible phone's tap shows up as the first vote_count; if nobody taps in 10 s, three extras vote.
  phones[2].ws.on('message', (d) => { const m = JSON.parse(d); if (m.t === 'vote_count' && m.count >= 1) twoMore(); });
  timers.push(setTimeout(async () => { if (!fired) { await vote(phones[3], '151', talkId); twoMore(); } }, 10000));
  tech.on('message', async (d) => {
    const m = JSON.parse(d);
    if (m.t === 'ticket' && m.status === 'fixed' && !m.better && !m.stillBad) {
      cue('PHONE: "Better now?" appears: tap "Yes, better"');
      await sleep(2500);
      for (const p of phones.slice(0, 2)) await api('POST', '/api/feedback', { ticketId: m.id, clientId: p.clientId, better: true });
      say('the other two phones answered "better": the console shows the tally');
      cue('hold on the console ~3 s; then Ctrl+C');
    }
  });
}

async function sceneRooms() {
  await startServer({ signin: true, demoRoom: true });
  await crowd('151', 46, true);
  await startTalk('151', 'Cloud Native at the Edge', 'Tyler & Owen', { lineMs: 3500, firstLines: 8 });
  await crowd('152', 12, true);
  await startTalk('152', 'Platform engineering at scale', 'Guest speaker', { lineMs: 0, firstLines: 4, audioDb: -100 }); // quiet mic
  openWindow(`${BASE}/tech?key=${TECH_KEY}&rooms=151#room=151`, 'full', 'AV console');
  say('151: 46 phones, live captions · 152: 12 phones, mic silent (⚠ mic quiet) · 255: the demo room');
  timers.push(setTimeout(() => cue('AV: press 2 (room 152: ⚠ mic quiet, Microphone "very quiet")'), 6000));
  timers.push(setTimeout(() => cue('AV: press 3 (room 255 demo: 70% full, scanned, Live status all green)'), 13000));
  timers.push(setTimeout(() => cue('AV: press 1 (back to 151); then Ctrl+C'), 20000));
}

async function sceneEnd() {
  await startServer({ signin: false });
  await crowd('151', 30, false);
  const { talkId } = await startTalk('151', 'Cloud Native at the Edge', 'Tyler & Owen', { lineMs: 3500, firstLines: 24 });
  openWindow(`${BASE}/tech?key=${TECH_KEY}&rooms=151#room=151`, 'left', 'AV console');
  openWindow(`${BASE}/r/151`, 'phone', 'phone');
  say(`talk ${talkId} live with 24 lines already said (enough transcript to search)`);
  cue('AV: click "End talk", then click it again ("Tap again to end")');
  const viewer = await socket({ room: '151', role: 'viewer' });
  viewer.on('message', (d) => {
    const m = JSON.parse(d);
    if (m.t === 'talk' && m.status === 'ended') {
      for (const t of timers) { clearInterval(t); clearTimeout(t); } // the speaker stops too
      cue('PHONE: the Ended card shows: tap "Read the transcript"');
      setTimeout(() => cue(`TRANSCRIPT: search "${process.env.VIDEO_ELASTIC === '1' ? 'what happens when the network goes down' : 'uplink'}"; then Ctrl+C`), 6000);
    }
  });
}

function stop() {
  for (const t of timers) { clearInterval(t); clearTimeout(t); }
  for (const ws of sockets) { try { ws.close(); } catch { /* closing */ } }
  for (const w of windows) { try { w.kill(); } catch { /* already closed */ } }
  if (server) server.kill();
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

(async () => {
  console.log(`Pulse video scene "${scene}": ${SCENES[scene]}`);
  console.log(`Server: ${BASE} (fresh state). Ctrl+C ends the take.\n`);
  try {
    await { qr: sceneQr, join: sceneJoin, alert: sceneAlert, rooms: sceneRooms, end: sceneEnd }[scene]();
    if (process.env.VIDEO_PRINT_KEYS === '1') say(`speaker key ${SPEAKER_KEY} · tech key ${TECH_KEY}`);
    if (process.env.VIDEO_SECONDS) setTimeout(stop, Number(process.env.VIDEO_SECONDS) * 1000);
  } catch (e) {
    console.error(e.message);
    stop();
  }
})();
