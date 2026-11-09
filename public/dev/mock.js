// Preview mode for design work. Loaded only when the page URL has ?mock=1.
// Fakes the backend inside the browser so /r.html and /tech.html can be designed and
// checked without the server: captions stream in, slides advance, votes get counts,
// tickets open, questions arrive, and the preview page (dev/preview.html) can act as
// the tech. Every open preview tab/frame shares one fake room through a
// BroadcastChannel, so a vote on a phone frame shows up as a block on the tech frame.
// It only ever sends messages and fields defined in CONTRACT.md.

const TALK_ID = 'demo-talk';
const ROOM = '151'; // the room with the scripted talk; 255 is a second room for the tech view
const FRAME = Math.random().toString(36).slice(2, 8); // one fake voter per frame (frames share localStorage)

const LINES = [
  "Raise your hand if you've ever sat at the back of a talk and couldn't hear.",
  'Scan the code on the screen. No app, no login.',
  'You should be reading my words on your phone right now.',
  "If the room is too quiet, tap Speak up. One vote each.",
  'When three different people vote, the AV tech sees one red block.',
  'It shows the room, how many people voted, and the most likely cause.',
  'The tech claims it, fixes it, and your phone asks if it is better.',
  'Questions go to the crew too. They can reply just to you.',
  'Every talk is transcribed and saved, split by slide.',
  'When people in the back cannot hear, the people who can fix it find out in seconds.',
];

const SLIDES = [
  ['PULSE', 'Every seat is the front row.'],
  ['The back row', "can't hear. Nobody who can fix it knows."],
  ['Watch · Listen', 'Tell the crew'],
  ['Tap Speak up', 'now'],
  ['What the tech sees', 'One block. The likely cause. Claim.'],
  ['Every seat is', 'the front row.'],
];

function slideUrl(i) {
  const [a, b] = SLIDES[i];
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
<rect width="1280" height="720" fill="#000"/>
<rect x="80" y="250" width="16" height="200" rx="6" fill="${i === 3 ? '#FFD400' : '#4D9AFF'}"/>
<text x="130" y="330" fill="#fff" font-family="Inter, Arial, sans-serif" font-size="84" font-weight="800">${esc(a)}</text>
<text x="130" y="430" fill="#B8B8B8" font-family="Inter, Arial, sans-serif" font-size="52" font-weight="600">${esc(b)}</text>
<text x="1200" y="680" fill="#8F8F8F" font-family="Inter, Arial, sans-serif" font-size="28" text-anchor="end">${i + 1} / ${SLIDES.length}</text>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

// ---------- fake WebSocket ----------
const jsonSockets = new Set();
const RealWebSocket = window.WebSocket;

class MockSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url) {
    this.url = String(url);
    const q = new URL(this.url, location.href).searchParams;
    this.role = q.get('role') || 'attendee';
    this.room = q.get('room') || ROOM;
    this.readyState = 0;
    this.binaryType = 'blob';
    this.audio = this.url.includes('/ws/audio-out');
    setTimeout(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.onopen?.({});
      if (this.audio) this.startTone();
      else { jsonSockets.add(this); hello(this); }
    }, 300);
  }

  send() { /* the fake server ignores what the page sends */ }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    jsonSockets.delete(this);
    clearInterval(this.toneTimer);
    setTimeout(() => this.onclose?.({ code: 1000 }), 0);
  }

  deliver(msg) {
    if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(msg) });
  }

  // Listen-in: a quiet tone with a slow wobble, so the level bar moves and you can hear audio works.
  startTone() {
    let phase = 0;
    let frame = 0;
    this.toneTimer = setInterval(() => {
      const pcm = new Int16Array(1600);
      const amp = 0.02 + 0.02 * Math.abs(Math.sin(frame / 4));
      for (let i = 0; i < pcm.length; i++) {
        pcm[i] = Math.round(Math.sin(phase) * amp * 32767);
        phase += (2 * Math.PI * 220) / 16000;
      }
      frame++;
      if (this.readyState === 1) this.onmessage?.({ data: pcm.buffer });
    }, 100);
  }
}

window.WebSocket = MockSocket;
window.__pulseRealWebSocket = RealWebSocket;

// Send to sockets in this frame. roles: list of roles, or null for every role.
function send(msg, { roles = null, room = ROOM } = {}) {
  for (const s of jsonSockets) {
    if (roles && !roles.includes(s.role)) continue;
    if (room && s.room !== room) continue;
    s.deliver(msg);
  }
}
const toPhones = (msg) => send(msg, { roles: ['attendee'] });
const toTech = (msg, room = ROOM) => send(msg, { roles: ['tech', 'org'], room });

// ---------- shared fake room state ----------
const t0 = Date.now();
const others = { cant_hear: 3, cant_see: 1 }; // pretend other people already voted
const voters = { cant_hear: new Set(), cant_see: new Set() }; // preview frames that voted
const CAUSE = {
  cant_hear: ['Podium mic gain too low or muted', ['Check the podium mic is on and unmuted', 'Raise the mic channel 3–6 dB', 'Check the back speakers are powered']],
  cant_see: ['Projector too dim or slides too small', ['Turn off the front lights', 'Check projector brightness', 'Ask the speaker to zoom in']],
};
const tickets = new Map([
  ['t-hear', ticket('t-hear', ROOM, 'cant_hear', 3, 'open', t0 - 42000)],
  ['t-255', ticket('t-255', '255', 'cant_see', 5, 'claimed', t0 - 95000)],
]);
const groups = [
  { qid: 'qa', text: 'Is the transcript saved after the talk?', count: 3, answered: false },
  { qid: 'qb', text: 'Which mic does the room use?', count: 1, answered: false },
];
let lastCaptionAt = Date.now();

function ticket(id, room, type, people, status, openedAt) {
  const [cause, steps] = CAUSE[type];
  return { id, room, type, people, status, openedAt: new Date(openedAt).toISOString(), cause, steps };
}
const count = (type) => others[type] + voters[type].size;
const ticketFor = (type) => [...tickets.values()].find((t) => t.room === ROOM && t.type === type && ['open', 'reopened', 'claimed'].includes(t.status));

// Every change goes through apply(): this frame applies it now and every other preview
// frame applies the same event, so they all stay in step.
const chan = 'BroadcastChannel' in window ? new BroadcastChannel('pulse-mock') : null;
if (chan) chan.onmessage = (e) => apply(e.data, false);
function share(ev) { apply(ev, true); chan?.postMessage(ev); }

function apply(ev, local) {
  switch (ev.kind) {
    case 'vote': {
      if (ev.on) voters[ev.type].add(ev.voter); else voters[ev.type].delete(ev.voter);
      const n = count(ev.type);
      toPhones({ t: 'vote_count', type: ev.type, count: n, windowSec: 60 });
      let t = ticketFor(ev.type);
      if (!t && n >= 3) { t = ticket(`t-${ev.type}-${ev.at}`, ROOM, ev.type, n, 'open', ev.at); tickets.set(t.id, t); }
      if (t) { t.people = n; toTech({ t: 'ticket', ...t }); }
      break;
    }
    case 'ticket': {
      const t = tickets.get(ev.id);
      if (!t) break;
      t.status = ev.status;
      if (ev.status === 'fixed' || ev.status === 'dismissed') { others[t.type] = 0; voters[t.type].clear(); }
      toTech({ t: 'ticket', ...t }, t.room);
      if (t.room === ROOM) toPhones({ t: 'ticket_status', ticketId: t.id, type: t.type, status: t.status });
      break;
    }
    case 'question':
      groups.unshift({ qid: ev.qid, text: ev.text, count: 1, answered: false });
      toTech({ t: 'question_groups', groups });
      break;
    case 'reply': toPhones({ t: 'question_reply', qid: ev.qid, text: ev.text }); break;
    case 'bcast': toPhones({ t: 'broadcast', text: ev.text }); break;
    case 'settings': send({ t: 'room_settings', ...ev.settings }, { room: ev.room }); break;
    case 'slide': nextSlide(ev.step); break;
    case 'drop': if (local || ev.all) for (const s of [...jsonSockets]) s.close(); break;
    default: break;
  }
}

// ---------- scripted talk ----------
let seq = 0;
let lineIdx = 0;
let slideIdx = 0;
let captionTimer = null;
let slideTimer = null;
let statusTimer = null;

function hello(sock) {
  sock.deliver({ t: 'room_settings', captions: true, listen: true, slides: true });
  if (sock.role === 'tech' || sock.role === 'org') {
    // join snapshot: one ticket message per active ticket, then the question groups
    for (const t of tickets.values()) if (t.room === sock.room && ['open', 'reopened', 'claimed'].includes(t.status)) sock.deliver({ t: 'ticket', ...t });
    if (sock.room === ROOM) {
      sock.deliver({ t: 'question_groups', groups });
      sock.deliver({ t: 'caption_backlog', lines: LINES.slice(0, 3).map((text, i) => ({ seq: i + 1, text, talkId: TALK_ID })) });
    }
    if (!statusTimer) statusTimer = setInterval(roomStatus, 2000);
    roomStatus();
  } else {
    const backlog = [];
    for (let i = 0; i < 2 && lineIdx < LINES.length; i++) backlog.push({ seq: ++seq, text: LINES[lineIdx++], talkId: TALK_ID });
    sock.deliver({ t: 'caption_backlog', lines: backlog });
    sock.deliver({ t: 'slide', talkId: TALK_ID, n: slideIdx + 1, total: SLIDES.length, url: slideUrl(slideIdx), alt: SLIDES[slideIdx].join(' ') });
    if (!slideTimer) slideTimer = setInterval(() => nextSlide(), 9000);
  }
  if (!captionTimer) captionTimer = setInterval(nextCaption, 2600);
}

function roomStatus() {
  for (const room of [ROOM, '255']) {
    const open = [...tickets.values()].filter((t) => t.room === room && ['open', 'reopened', 'claimed'].includes(t.status)).length;
    toTech({
      t: 'room_status', room,
      listeners: room === ROOM ? 14 : 31,
      micDb: room === ROOM ? Math.round(-30 + Math.random() * 8) : -18,
      captionGapSec: room === ROOM ? Math.floor((Date.now() - lastCaptionAt) / 1000) : 1,
      openTickets: open,
    }, room);
  }
}

function nextCaption() {
  const text = LINES[lineIdx % LINES.length];
  lineIdx++;
  const words = text.split(' ');
  toPhones({ t: 'caption_interim', text: words.slice(0, Math.ceil(words.length / 2)).join(' ') });
  setTimeout(() => {
    lastCaptionAt = Date.now();
    send({ t: 'caption', talkId: TALK_ID, seq: ++seq, text, ts: Date.now() });
  }, 900);
}

function nextSlide(step = 1) {
  slideIdx = (slideIdx + step + SLIDES.length) % SLIDES.length;
  toPhones({ t: 'slide', talkId: TALK_ID, n: slideIdx + 1, total: SLIDES.length, url: slideUrl(slideIdx), alt: SLIDES[slideIdx].join(' ') });
}

// ---------- fake HTTP API ----------
let lastQid = null;
const realFetch = window.fetch.bind(window);

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

window.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href);
  const method = (init.method || 'GET').toUpperCase();
  const body = init.body ? JSON.parse(init.body) : {};
  const path = url.pathname;
  let m;
  await new Promise((r) => setTimeout(r, 150)); // feel like a network

  if (path === '/api/rooms' && method === 'GET') {
    return json([
      { room: ROOM, talkId: TALK_ID, title: 'Room Pulse demo', speaker: 'Tyler & Owen', listeners: 14, openTickets: 1, simulated: false },
      { room: '255', talkId: 'other-talk', title: 'Scaling Argo CD to 500 clusters', speaker: 'Guest speaker', listeners: 31, openTickets: 1, simulated: true },
    ]);
  }
  if (path === '/api/config') return json({ alertThreshold: 3 });
  if (path === '/api/votes' && method === 'PUT') {
    share({ kind: 'vote', type: body.type, on: !!body.on, voter: FRAME, at: Date.now() });
    const n = count(body.type);
    return json({ count: n, ticketStatus: ticketFor(body.type)?.status || null });
  }
  if (path === '/api/questions' && method === 'POST') {
    lastQid = `q-${FRAME}-${Date.now()}`;
    share({ kind: 'question', qid: lastQid, text: String(body.text || '') });
    return json({ qid: lastQid, groupId: lastQid });
  }
  if (path === '/api/feedback' && method === 'POST') {
    return json({ better: body.better ? 1 : 0, stillBad: body.better ? 0 : 1 });
  }
  if ((m = path.match(/^\/api\/tickets\/([^/]+)\/(claim|fixed|dismiss)$/))) {
    const status = { claim: 'claimed', fixed: 'fixed', dismiss: 'dismissed' }[m[2]];
    share({ kind: 'ticket', id: decodeURIComponent(m[1]), status });
    return json({ status });
  }
  if ((m = path.match(/^\/api\/rooms\/([^/]+)\/settings$/))) {
    share({ kind: 'settings', room: decodeURIComponent(m[1]), settings: body });
    return json({ ok: true });
  }
  if ((m = path.match(/^\/api\/rooms\/([^/]+)\/broadcast$/))) {
    share({ kind: 'bcast', text: String(body.text || '') });
    return json({ ok: true });
  }
  if ((m = path.match(/^\/api\/questions\/([^/]+)\/reply$/))) {
    share({ kind: 'reply', qid: decodeURIComponent(m[1]), text: String(body.text || '') });
    return json({ ok: true });
  }
  if (path.startsWith('/api/questions/')) return json({ ok: true }); // queue / answered / hide
  return realFetch(input, init);
};

// ---------- controls from dev/preview.html (postMessage) ----------
// The preview page posts each command to every frame; only the frame that receives
// it with lead: true shares it, so a button press happens once, not once per frame.
const COMMANDS = {
  fixed_hear: () => { const t = ticketFor('cant_hear'); if (t) share({ kind: 'ticket', id: t.id, status: 'fixed' }); },
  fixed_see: () => { const t = ticketFor('cant_see'); if (t) share({ kind: 'ticket', id: t.id, status: 'fixed' }); },
  reply: () => share({ kind: 'reply', qid: lastQid || 'none', text: 'Room 255 has about 40 free seats.' }),
  broadcast: () => share({ kind: 'bcast', text: 'Audio fixed. Tell us if it is better.' }),
  captions_off: () => share({ kind: 'settings', room: ROOM, settings: { captions: false, listen: true, slides: true } }),
  captions_on: () => share({ kind: 'settings', room: ROOM, settings: { captions: true, listen: true, slides: true } }),
  next_slide: () => share({ kind: 'slide', step: 1 }),
  prev_slide: () => share({ kind: 'slide', step: -1 }),
  drop: () => share({ kind: 'drop', all: true }),
};

window.addEventListener('message', (e) => {
  if (e.origin !== location.origin) return;
  const cmd = e.data && e.data.pulseMock;
  if (!cmd || !COMMANDS[cmd]) return;
  // "reply" is per phone (it answers that phone's own question); everything else is room-wide.
  if (cmd === 'reply') { if (lastQid) toPhones({ t: 'question_reply', qid: lastQid, text: 'Room 255 has about 40 free seats.' }); return; }
  if (e.data.lead || !chan) COMMANDS[cmd]();
});

// A small tag so nobody mistakes fake data for the live room.
const tag = document.createElement('div');
tag.textContent = 'PREVIEW · FAKE DATA';
tag.setAttribute('aria-hidden', 'true');
tag.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99;padding:3px 8px;border-radius:6px;background:#FFD400;color:#000;font:800 10px/1.4 system-ui,sans-serif;letter-spacing:.06em;pointer-events:none';
document.addEventListener('DOMContentLoaded', () => document.body.appendChild(tag));
if (document.readyState !== 'loading') document.body.appendChild(tag);
