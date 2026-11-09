// Preview mode for design work. Loaded only when the page URL has ?mock=1.
// Fakes the backend inside the browser so /r.html can be designed and checked
// without the server: captions stream in, slides advance, votes get counts,
// and the preview page (dev/preview.html) can trigger tech actions.
// It only ever sends messages and fields defined in CONTRACT.md.

const TALK_ID = 'demo-talk';
const ROOM = new URLSearchParams(location.search).get('room') || '151';

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

function broadcast(msg) { for (const s of jsonSockets) s.deliver(msg); }

// ---------- scripted talk ----------
let seq = 0;
let lineIdx = 0;
let slideIdx = 0;
let captionTimer = null;
let slideTimer = null;

function hello(sock) {
  sock.deliver({ t: 'room_settings', captions: true, listen: true, slides: true });
  const backlog = [];
  for (let i = 0; i < 2 && lineIdx < LINES.length; i++) backlog.push({ seq: ++seq, text: LINES[lineIdx++], talkId: TALK_ID });
  sock.deliver({ t: 'caption_backlog', lines: backlog });
  sock.deliver({ t: 'slide', talkId: TALK_ID, n: slideIdx + 1, total: SLIDES.length, url: slideUrl(slideIdx), alt: SLIDES[slideIdx].join(' ') });
  if (!captionTimer) captionTimer = setInterval(nextCaption, 2600);
  if (!slideTimer) slideTimer = setInterval(() => nextSlide(), 9000);
}

function nextCaption() {
  const text = LINES[lineIdx % LINES.length];
  lineIdx++;
  const words = text.split(' ');
  broadcast({ t: 'caption_interim', text: words.slice(0, Math.ceil(words.length / 2)).join(' ') });
  setTimeout(() => broadcast({ t: 'caption', talkId: TALK_ID, seq: ++seq, text, ts: Date.now() }), 900);
}

function nextSlide(step = 1) {
  slideIdx = (slideIdx + step + SLIDES.length) % SLIDES.length;
  broadcast({ t: 'slide', talkId: TALK_ID, n: slideIdx + 1, total: SLIDES.length, url: slideUrl(slideIdx), alt: SLIDES[slideIdx].join(' ') });
}

// ---------- fake HTTP API ----------
const others = { cant_hear: 3, cant_see: 1 }; // pretend other people already voted
const mine = { cant_hear: false, cant_see: false };
let lastQid = null;
let qCounter = 0;
const realFetch = window.fetch.bind(window);

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

window.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href);
  const method = (init.method || 'GET').toUpperCase();
  const body = init.body ? JSON.parse(init.body) : {};
  await new Promise((r) => setTimeout(r, 150)); // feel like a network

  if (url.pathname === '/api/rooms' && method === 'GET') {
    return json([{ room: ROOM, talkId: TALK_ID, title: 'Room Pulse demo', speaker: 'Tyler & Owen', listeners: 14, openTickets: 0, simulated: false }]);
  }
  if (url.pathname === '/api/votes' && method === 'PUT') {
    mine[body.type] = !!body.on;
    const count = others[body.type] + (mine[body.type] ? 1 : 0);
    broadcast({ t: 'vote_count', type: body.type, count, windowSec: 60 });
    return json({ count, ticketStatus: count >= 3 ? 'open' : null });
  }
  if (url.pathname === '/api/questions' && method === 'POST') {
    lastQid = `q${++qCounter}`;
    return json({ qid: lastQid, groupId: 'g1' });
  }
  if (url.pathname === '/api/feedback' && method === 'POST') {
    return json({ better: body.better ? 1 : 0, stillBad: body.better ? 0 : 1 });
  }
  return realFetch(input, init);
};

// ---------- controls from dev/preview.html (postMessage) ----------
const COMMANDS = {
  fixed_hear: () => { mine.cant_hear = false; others.cant_hear = 0; broadcast({ t: 'ticket_status', ticketId: 't-hear', type: 'cant_hear', status: 'fixed' }); },
  fixed_see: () => { mine.cant_see = false; others.cant_see = 0; broadcast({ t: 'ticket_status', ticketId: 't-see', type: 'cant_see', status: 'fixed' }); },
  reply: () => { if (lastQid) broadcast({ t: 'question_reply', qid: lastQid, text: 'Room 255 has about 40 free seats.' }); },
  broadcast: () => broadcast({ t: 'broadcast', text: 'Audio fixed. Tell us if it is better.' }),
  captions_off: () => broadcast({ t: 'room_settings', captions: false, listen: true, slides: true }),
  captions_on: () => broadcast({ t: 'room_settings', captions: true, listen: true, slides: true }),
  next_slide: () => nextSlide(1),
  prev_slide: () => nextSlide(-1),
  drop: () => { for (const s of [...jsonSockets]) s.close(); },
};

window.addEventListener('message', (e) => {
  if (e.origin !== location.origin) return;
  const cmd = e.data && e.data.pulseMock;
  if (cmd && COMMANDS[cmd]) COMMANDS[cmd]();
});

// A small tag so nobody mistakes fake data for the live room.
const tag = document.createElement('div');
tag.textContent = 'PREVIEW · FAKE DATA';
tag.setAttribute('aria-hidden', 'true');
tag.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99;padding:3px 8px;border-radius:6px;background:#FFD400;color:#000;font:800 10px/1.4 system-ui,sans-serif;letter-spacing:.06em;pointer-events:none';
document.addEventListener('DOMContentLoaded', () => document.body.appendChild(tag));
if (document.readyState !== 'loading') document.body.appendChild(tag);
