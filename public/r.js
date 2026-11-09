// Attendee page /r/:room. Never asks for the microphone (CONTRACT.md: Mic lock).
import { connectRoom } from '/lib/socket.js';
import { store, getClientId } from '/lib/store.js';
import { createPlayer } from '/lib/player.js';

// Preview mode for design work: /r.html?mock=1 fakes the server (see public/dev/README.md).
// Must load before anything below opens a socket or calls fetch.
if (new URLSearchParams(location.search).has('mock')) await import('/dev/mock.js');

const $ = (id) => document.getElementById(id);
const room = (location.pathname.match(/^\/r\/([^/?#]+)/)?.[1]) || new URLSearchParams(location.search).get('room') || '151';
const clientId = getClientId();

const state = {
  talkId: null,
  talkStatus: null,  // 'waiting' | 'live' | 'ended' (from the server's `talk` message)
  endedAt: null,
  conn: 'connecting', // socket status
  filling: false,    // fetching missed lines after a reconnect; live captions wait in `held`
  held: [],
  settings: { captions: true, listen: true, slides: true },
  slides: [],        // every slide seen this talk, index = n - 1
  liveN: 0,          // slide the presenter is on
  viewN: 0,          // slide this phone is looking at
  followLive: true,
  lastSeq: 0,
  autoScroll: true,
  votes: {},         // type -> time my vote was cast (ms), or false
  voted: {},         // type -> true if I voted at any point this talk
  betterTicket: null,
};

// ---------- header + connection ----------
$('roomBadge').textContent = `Room ${room}`;
document.title = `Pulse · Room ${room}`;

// The pill in the header says what the TALK is doing once the socket is up:
// Live (red dot) only while the talk is live; Ended / Not started otherwise.
// While the socket is down it says Connecting… / Reconnecting… instead.
const CONN_WORDS = { connecting: 'Connecting…', reconnecting: 'Reconnecting…', unauthorized: 'Not allowed' };
const TALK_WORDS = { live: 'Live', ended: 'Ended', waiting: 'Not started' };
function setConn(status) {
  state.conn = status;
  renderPill();
  if (status === 'live') stopPolling(); else startPolling();
}
function renderPill() {
  const el = $('conn');
  const pill = state.conn === 'live' ? (state.talkStatus || 'waiting') : state.conn;
  el.dataset.status = pill;
  el.querySelector('.conn-word').textContent = state.conn === 'live' ? TALK_WORDS[pill] || pill : CONN_WORDS[pill] || pill;
}

const fmtTime = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
};

// ---------- talk status: waiting · live · ended ----------
// The server sends `talk` on join and on every change (CONTRACT.md). Ending the talk on Go live,
// the mic page or the AV console flips every phone to "Ended" right away; a new talk flips it back.
function onTalk(m) {
  const status = m.status || (m.talkId ? 'live' : 'waiting');
  if (m.talkId) setTalk({ talkId: m.talkId, title: m.title, speaker: m.speaker });
  else if (status === 'waiting') {
    $('talkTitle').textContent = 'Waiting for the talk to start';
    $('talkSpeaker').textContent = '';
  }
  const was = state.talkStatus;
  state.talkStatus = status;
  state.endedAt = status === 'ended' ? (m.endedAt || state.endedAt || new Date().toISOString()) : null;
  renderPill();
  renderTalkState();
  renderVotes();
  if (status === 'ended') {
    $('interim').textContent = '';
    markEnded();
    if (was === 'live') {
      hideHint();
      if (navigator.vibrate) navigator.vibrate(60);
    }
  }
  if (status === 'live' && was && was !== 'live') showHint('The talk is live again.', null, null, 4000);
}

function renderTalkState() {
  const box = $('talkState');
  const s = state.talkStatus;
  document.body.dataset.talk = s || 'waiting';
  if (s !== 'ended' || !state.talkId) { box.hidden = true; return; }
  const at = fmtTime(state.endedAt);
  $('tsTitle').textContent = 'This talk has ended';
  $('tsSub').textContent = `Live captions stopped${at ? ` at ${at}` : ''}. The full transcript is saved.`;
  const id = encodeURIComponent(state.talkId);
  $('tsTranscript').href = `/t/${id}`;
  $('tsDownload').href = `/api/talks/${id}/transcript?format=txt`;
  $('tsDownload').setAttribute('download', `pulse-${state.talkId}.txt`);
  box.hidden = false;
}

// One line at the end of the captions so the stop is obvious even while reading them.
function markEnded() {
  if (capEl.querySelector('.end-mark')) return;
  const p = document.createElement('p');
  p.className = 'line end-mark';
  const at = fmtTime(state.endedAt);
  p.textContent = `■ Captions stopped${at ? ` at ${at}` : ''} · talk ended`;
  $('captionEmpty')?.remove();
  capEl.appendChild(p);
  if (state.autoScroll) scrollCaptionsToEnd();
}

function setTalk({ talkId, title, speaker }) {
  if (talkId && talkId !== state.talkId) {
    const hadTalk = state.talkId !== null;
    state.talkId = talkId;
    state.lastSeq = 0; // seq restarts per talk, even if the backlog came from an earlier one
    if (hadTalk) resetForNewTalk();
    loadVotes();
    if (!title) loadRoomInfo(); // a new talk started after this phone joined
  }
  if (title) $('talkTitle').textContent = title;
  if (speaker !== undefined) $('talkSpeaker').textContent = speaker || '';
}

// A new talk in the same room: caption seq restarts at 1 and it has its own deck.
function resetForNewTalk() {
  state.lastSeq = 0;
  state.slides = [];
  state.liveN = 0;
  state.viewN = 0;
  state.followLive = true;
  capEl.replaceChildren();
  state.held = [];
  $('interim').textContent = '';
  $('slideImg').hidden = true;
  $('slideImg').removeAttribute('src');
  $('slideEmpty').hidden = false;
  $('slideLabel').textContent = '—';
  $('slideLive').hidden = true;
  $('zoom').hidden = true;
  for (const t of Object.keys(lastCount)) lastCount[t] = 0;
}

async function loadRoomInfo() {
  try {
    const res = await fetch('/api/rooms');
    if (!res.ok) return;
    const rooms = await res.json();
    const r = rooms.find((x) => String(x.room) === String(room));
    if (!r) return;
    // While the socket is up its `talk` messages are the truth; use the HTTP status only when it's down.
    if (r.status && state.conn !== 'live') onTalk({ talkId: r.talkId, title: r.title, speaker: r.speaker, status: r.status });
    else setTalk({ talkId: r.talkId, title: r.title, speaker: r.speaker });
  } catch { /* offline: the socket will fill this in */ }
}

// ---------- catching up after a dropped connection ----------
// The join backlog is only the last 50 lines. If more were missed, fetch them from the transcript
// route; live captions that arrive meanwhile are held and added after, so nothing comes out of order.
async function fetchMissed() {
  if (!state.talkId || state.filling) return;
  const talkId = state.talkId;
  state.filling = true;
  try {
    const res = await fetch(`/api/talks/${encodeURIComponent(talkId)}/transcript?from=${state.lastSeq + 1}&format=json`);
    if (res.ok && talkId === state.talkId) {
      const rows = await res.json();
      state.filling = false;
      (Array.isArray(rows) ? rows : []).filter((l) => l.talkId === undefined || l.talkId === talkId)
        .sort((a, b) => a.seq - b.seq).forEach(addCaption);
    }
  } catch { /* try again on the next reconnect or poll */ }
  state.filling = false;
  const held = state.held.splice(0).sort((a, b) => (a.seq || 0) - (b.seq || 0));
  held.forEach(addCaption);
  if (state.talkStatus === 'ended') markEnded();
}

function onBacklog(lines) {
  lines = Array.isArray(lines) ? lines : [];
  // The room keeps the last 50 lines across talks: show only the newest talk's lines.
  const talkId = lines.length ? lines[lines.length - 1].talkId : null;
  if (talkId) {
    setTalk({ talkId });
    lines = lines.filter((l) => l.talkId === talkId);
  }
  // A gap between what this phone has and the backlog: fetch the missing lines first.
  if (state.lastSeq > 0 && lines.length && lines[0].seq > state.lastSeq + 1) {
    state.held.push(...lines);
    fetchMissed();
    return;
  }
  lines.forEach(addCaption);
}

// ---------- HTTP fallback while the socket is down ----------
// Some venue networks block WebSockets or a phone's socket keeps dropping: poll the room status and
// the transcript every 10 s until the socket is back, so the page still updates on its own.
let pollTimer = null;
function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    await loadRoomInfo();
    if (state.talkId && state.talkStatus === 'live') fetchMissed();
  }, 10000);
}
function stopPolling() { clearInterval(pollTimer); pollTimer = null; }

// ---------- mode switch: Slides · Captions · Both ----------
function setMode(mode) {
  if (mode !== 'captions' && !state.settings.slides) mode = 'captions';
  $('stage').dataset.mode = mode;
  for (const b of document.querySelectorAll('#modes button')) {
    b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
  }
  store.set('pulse.mode', mode);
  if (mode !== 'slides') scrollCaptionsToEnd();
}
$('modes').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-mode]');
  if (b) setMode(b.dataset.mode);
});

// ---------- captions ----------
const SIZES = [20, 28, 36];
let sizeIdx = Math.max(0, SIZES.indexOf(store.get('pulse.fontSize', 20)));
function applySize() {
  document.documentElement.style.setProperty('--cap-size', `${SIZES[sizeIdx]}px`);
  $('fontDown').disabled = sizeIdx === 0;
  $('fontUp').disabled = sizeIdx === SIZES.length - 1;
  store.set('pulse.fontSize', SIZES[sizeIdx]);
}
$('fontDown').onclick = () => { sizeIdx = Math.max(0, sizeIdx - 1); applySize(); };
$('fontUp').onclick = () => { sizeIdx = Math.min(SIZES.length - 1, sizeIdx + 1); applySize(); };
applySize();

// Looking back is temporary: after BACK_TO_LIVE_MS without touching the slide controls,
// the next slide (or caption) brings the phone back to live by itself.
const BACK_TO_LIVE_MS = 10000;
let lastSlideTouch = 0;
let lastCaptionScroll = 0;

const capEl = $('captions');
const MAX_LINES = 400;

// Split a caption into lines of at most 8 words, breaking after punctuation when it can.
// A short tail (1–2 words) joins the line before it.
function captionChunks(text, max = 8) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  if (words.length <= max + 2) return [words.join(' ')];
  const out = [];
  let cur = [];
  for (const w of words) {
    cur.push(w);
    if (cur.length >= max || (cur.length >= 5 && /[,.;:!?]$/.test(w))) { out.push(cur); cur = []; }
  }
  if (cur.length) {
    if (cur.length <= 2 && out.length) out[out.length - 1].push(...cur);
    else out.push(cur);
  }
  return out.map((c) => c.join(' '));
}

function addCaption(line) {
  const { seq, text } = line;
  if (!text) return;
  if (state.filling) { state.held.push(line); return; }
  if (seq && seq <= state.lastSeq) return; // duplicate after reconnect/backlog
  if (seq) state.lastSeq = seq;
  $('captionEmpty')?.remove();
  capEl.querySelector('.end-mark')?.remove(); // lines still arriving: the talk isn't over
  // A Web Speech final can be a long sentence. Short lines keep the Both crawl box
  // from ever clipping the newest line, and read better as live captions anyway.
  for (const chunk of captionChunks(text)) {
    const p = document.createElement('p');
    p.className = 'line enter'; // .enter = slide-in for the Both crawl
    p.textContent = chunk;
    capEl.appendChild(p);
    setTimeout(() => p.classList.remove('enter'), 500);
  }
  while (capEl.children.length > MAX_LINES) capEl.firstElementChild.remove();
  $('interim').textContent = '';
  if (!state.autoScroll && Date.now() - lastCaptionScroll > BACK_TO_LIVE_MS) state.autoScroll = true;
  if (state.autoScroll) scrollCaptionsToEnd();
  else $('jumpLive').hidden = false;
}

function scrollCaptionsToEnd() {
  capEl.scrollTop = capEl.scrollHeight;
  state.autoScroll = true;
  $('jumpLive').hidden = true;
}

capEl.addEventListener('scroll', () => {
  const atBottom = capEl.scrollHeight - capEl.scrollTop - capEl.clientHeight < 40;
  state.autoScroll = atBottom;
  if (atBottom) $('jumpLive').hidden = true;
  else lastCaptionScroll = Date.now();
});
$('jumpLive').onclick = scrollCaptionsToEnd;

// ---------- slides ----------
function showSlide(n) {
  const s = state.slides[n - 1];
  state.viewN = n;
  const img = $('slideImg');
  if (!s) return;
  if (img.getAttribute('src') !== s.url) img.src = s.url;
  img.alt = s.alt || (s.total ? `Slide ${s.n} of ${s.total}` : `Slide ${s.n}`);
  img.hidden = false;
  $('slideEmpty').hidden = true;
  const live = n === state.liveN;
  $('slideLabel').textContent = `Slide ${s.n}${s.total ? ` / ${s.total}` : ''}` + (live ? ' · Following live' : '');
  $('slideLive').hidden = live;
  $('slidePrev').disabled = !state.slides[n - 2];
  $('slideNext').disabled = !state.slides[n] || n >= state.liveN;
  if (!$('zoom').hidden) openZoom();
}

function onSlide({ n, total, url, alt, talkId }) {
  if (talkId) setTalk({ talkId });
  if (!n || !url) return;
  state.slides[n - 1] = { n, total, url, alt };
  state.liveN = n;
  // Not while the full-screen viewer is open: that would swap the slide being read and drop its zoom.
  if (!state.followLive && $('zoom').hidden && Date.now() - lastSlideTouch > BACK_TO_LIVE_MS) state.followLive = true;
  if (state.followLive) showSlide(n);
  else showSlide(state.viewN); // refresh "Back to live" and the arrows for the new live slide
  // First slide arrives while on captions-only: offer Both once.
  if (!store.get('pulse.slidesOffered') && $('stage').dataset.mode === 'captions' && state.settings.slides) {
    store.set('pulse.slidesOffered', true);
    showHint('Slides are live on your phone.', 'Show slides', () => setMode('both'));
  }
}

function step(dir) {
  const target = state.viewN + dir;
  if (!state.slides[target - 1]) return;
  lastSlideTouch = Date.now();
  state.followLive = target === state.liveN;
  showSlide(target);
}
$('slidePrev').onclick = () => step(-1);
$('slideNext').onclick = () => step(1);
$('slideLive').onclick = () => { state.followLive = true; showSlide(state.liveN); };

// Swipe left/right on the slide to step through slides seen so far. Only a quick, clearly
// sideways swipe counts: scrolling the page up/down over the slide must never leave live.
let touch = null;
$('slideFrame').addEventListener('touchstart', (e) => {
  touch = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() } : null;
}, { passive: true });
$('slideFrame').addEventListener('touchmove', (e) => { if (e.touches.length > 1) touch = null; }, { passive: true });
$('slideFrame').addEventListener('touchend', (e) => {
  if (!touch) return;
  const dx = e.changedTouches[0].clientX - touch.x;
  const dy = e.changedTouches[0].clientY - touch.y;
  const quick = Date.now() - touch.t < 700;
  touch = null;
  if (quick && Math.abs(dx) > 70 && Math.abs(dx) > 2.5 * Math.abs(dy)) step(dx < 0 ? 1 : -1);
});

// Tap the slide: full screen, pinch to zoom.
function openZoom() {
  const s = state.slides[state.viewN - 1];
  if (!s) return;
  $('zoomImg').src = s.url;
  $('zoomImg').alt = s.alt || (s.total ? `Slide ${s.n} of ${s.total}` : `Slide ${s.n}`);
  $('zoom').hidden = false;
}
$('slideImg').onclick = openZoom;
$('zoomClose').onclick = () => { $('zoom').hidden = true; };

// ---------- one-line hint under the buttons ----------
let hintTimer = null;
function showHint(text, actionLabel, action, ms = 8000) {
  $('hintText').textContent = text;
  const btn = $('hintAction');
  if (actionLabel) {
    btn.textContent = actionLabel;
    btn.hidden = false;
    btn.onclick = () => { action(); hideHint(); };
  } else {
    btn.hidden = true;
  }
  $('hint').hidden = false;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(hideHint, ms);
}
function hideHint() { $('hint').hidden = true; }

// ---------- votes: one per phone per type, tap again to take it back ----------
const VOTE_TTL = 10 * 60 * 1000; // server drops votes after 10 min (CONTRACT.md)
const lastCount = {};
const voteKey = () => `pulse.votes.${state.talkId || room}`;
const isOn = (type) => typeof state.votes[type] === 'number' && Date.now() - state.votes[type] < VOTE_TTL;

function loadVotes() {
  const saved = store.get(voteKey(), {});
  state.votes = {};
  for (const [t, ts] of Object.entries(saved.votes || {})) if (typeof ts === 'number') state.votes[t] = ts;
  state.voted = saved.voted || {};
  expireVotes();
  renderVotes();
}

function expireVotes() {
  let changed = false;
  for (const t of Object.keys(state.votes)) {
    if (state.votes[t] !== false && !isOn(t)) { state.votes[t] = false; changed = true; }
  }
  if (changed) { saveVotes(); renderVotes(); }
}
setInterval(expireVotes, 30000);
function saveVotes() { store.set(voteKey(), { votes: state.votes, voted: state.voted }); }

// Colour is never the only signal: the sub-label always says whether my vote counts.
// Votes only count during a live talk (the server answers 409 otherwise), so the buttons say so.
const votesOpen = () => state.talkStatus === null || state.talkStatus === 'live';
function renderVotes() {
  for (const b of document.querySelectorAll('.vote')) {
    const t = b.dataset.type;
    const on = isOn(t);
    b.setAttribute('aria-pressed', String(on));
    b.classList.toggle('on', on);
    b.disabled = !votesOpen();
    setVoteCount(t, lastCount[t] ?? 0);
  }
}

function setVoteCount(type, count) {
  lastCount[type] = count;
  const b = document.querySelector(`.vote[data-type="${type}"]`);
  if (!b) return;
  if (!votesOpen()) { b.querySelector('.vote-sub').textContent = state.talkStatus === 'ended' ? 'Talk ended' : 'Not live yet'; return; }
  const base = type === 'cant_hear' ? "I can't hear" : 'the slides';
  const voted = count > 1 ? `Voted · ${count} people · tap to undo` : 'Voted · tap to undo';
  b.querySelector('.vote-sub').textContent = isOn(type) ? voted : base;
}

async function sendVote(type, on) {
  const res = await fetch('/api/votes', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ room, talkId: state.talkId, type, clientId, on }),
  });
  if (!res.ok) throw new Error(`vote ${res.status}`);
  return res.json();
}

async function toggleVote(type) {
  const prev = state.votes[type];
  const on = !isOn(type);
  state.votes[type] = on ? Date.now() : false;
  if (on) state.voted[type] = true;
  saveVotes();
  renderVotes();
  if (navigator.vibrate) navigator.vibrate(on ? 30 : 10);

  if (on && type === 'cant_hear' && state.settings.listen && !player.playing) {
    showHint('Counted. Want to listen with earbuds?', 'Listen', () => $('listenBtn').click());
  } else if (on && type === 'cant_see' && state.settings.slides && state.slides.length) {
    showHint('Counted. Open the slides on your phone?', 'Open slides', () => { setMode('slides'); openZoom(); });
  } else if (on) {
    showHint('Counted. The room crew can see it.');
  } else {
    showHint('Vote taken back.', null, null, 2500);
  }

  try {
    const r = await sendVote(type, on);
    if (typeof r?.count === 'number') setVoteCount(type, r.count);
  } catch {
    // Undo so the button never lies about what the server has.
    state.votes[type] = prev ?? false;
    saveVotes();
    renderVotes();
    showHint("Couldn't send that. Check your connection and tap again.");
  }
}
document.querySelectorAll('.vote').forEach((b) => { b.onclick = () => toggleVote(b.dataset.type); });

// ---------- "Better now?" after the tech presses Fixed ----------
function onTicketStatus({ ticketId, type, status }) {
  if (status === 'fixed' || status === 'dismissed') {
    // The server cleared everyone's votes for this problem.
    const hadVote = state.voted[type];
    state.votes[type] = false;
    saveVotes();
    renderVotes();
    if (status === 'fixed' && hadVote) {
      state.betterTicket = { ticketId, type };
      $('betterQ').textContent = type === 'cant_hear'
        ? 'The crew fixed the sound. Better now?'
        : 'The crew fixed the slides. Better now?';
      $('better').hidden = false;
      hideHint();
      $('better').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }
}

async function answerBetter(better) {
  const t = state.betterTicket;
  $('better').hidden = true;
  state.betterTicket = null;
  if (!t) return;
  try {
    await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticketId: t.ticketId, clientId, better }),
    });
  } catch { /* best effort */ }
  if (better) {
    showHint('Thanks! Glad it helped.', null, null, 3000);
  } else {
    // "Still bad" puts my vote straight back (the server does not re-add it).
    state.votes[t.type] = false;
    toggleVote(t.type);
  }
}
$('betterYes').onclick = () => answerBetter(true);
$('betterNo').onclick = () => answerBetter(false);

// ---------- listen-in ----------
const player = createPlayer({
  room,
  onLevel: (rms) => {
    const pct = Math.min(100, Math.round(Math.sqrt(rms) * 160));
    $('levelBar').style.width = `${pct}%`;
  },
  onState: (s) => {
    const words = { connecting: 'Connecting audio…', playing: 'Listening · tap to stop', reconnecting: 'Reconnecting audio…', stopped: 'Listen with earbuds' };
    $('listenWord').textContent = words[s] || s;
  },
});
$('listenBtn').onclick = () => {
  if (player.playing) {
    player.stop();
    $('listenBtn').setAttribute('aria-pressed', 'false');
  } else {
    player.start(); // inside the tap: required for iPhone audio
    $('listenBtn').setAttribute('aria-pressed', 'true');
    showHint('Use earbuds so the sound doesn\'t feed back into the room.', null, null, 5000);
  }
};

// ---------- questions ----------
const askText = $('askText');
askText.addEventListener('input', () => { $('askCount').textContent = `${askText.value.length} / 200`; });
const myQuestions = new Map(); // qid -> li

$('askForm').onsubmit = async (e) => {
  e.preventDefault();
  const text = askText.value.trim();
  if (!text) return;
  $('askSend').disabled = true;
  $('askMsg').textContent = 'Sending…';
  try {
    const res = await fetch('/api/questions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ room, talkId: state.talkId, text, clientId }),
    });
    if (res.status === 429) {
      $('askMsg').textContent = 'One question every 20 seconds. Try again in a moment.';
      return;
    }
    if (!res.ok) throw new Error(String(res.status));
    const { qid } = await res.json();
    const li = document.createElement('li');
    const q = document.createElement('p');
    q.className = 'q';
    q.textContent = text;
    const a = document.createElement('p');
    a.className = 'a';
    a.textContent = 'Sent to the room crew.';
    li.append(q, a);
    $('myQuestions').prepend(li);
    if (qid) myQuestions.set(String(qid), li);
    askText.value = '';
    $('askCount').textContent = '0 / 200';
    $('askMsg').textContent = 'Sent!';
  } catch {
    $('askMsg').textContent = "Couldn't send. Check your connection and try again.";
  } finally {
    $('askSend').disabled = false;
  }
};

function onQuestionReply({ qid, text }) {
  const li = myQuestions.get(String(qid));
  if (li) li.querySelector('.a').textContent = `Reply: ${text}`;
  showHint(`Reply to your question: ${text}`, null, null, 10000);
}

// ---------- broadcast banner ----------
function showBanner(text) {
  $('bannerText').textContent = text;
  $('banner').hidden = false;
  if (navigator.vibrate) navigator.vibrate([40, 60, 40]);
}
$('bannerClose').onclick = () => { $('banner').hidden = true; };

// ---------- room switches from the tech ----------
function applySettings(s) {
  state.settings = { ...state.settings, ...s };
  const { captions, listen, slides } = state.settings;
  $('captionsOff').hidden = !!captions;
  $('captions').hidden = !captions;
  $('interim').hidden = !captions;
  $('listenBtn').hidden = !listen;
  if (!listen && player.playing) { player.stop(); $('listenBtn').setAttribute('aria-pressed', 'false'); }
  $('modes').hidden = !slides;
  if (!slides) setMode('captions');
}

// ---------- socket ----------
connectRoom({
  room,
  role: 'attendee',
  onStatus: (s) => {
    setConn(s);
    if (s === 'live') loadRoomInfo();
  },
  onMessage: (m) => {
    switch (m.t) {
      case 'caption': if (m.talkId) setTalk({ talkId: m.talkId }); addCaption(m); break;
      case 'caption_interim': $('interim').textContent = m.text || ''; if (state.autoScroll) scrollCaptionsToEnd(); break;
      case 'caption_backlog': onBacklog(m.lines); break;
      case 'talk': onTalk(m); if (state.lastSeq > 0 && m.talkId === state.talkId) fetchMissed(); break;
      case 'slide': onSlide(m); break;
      case 'vote_count': setVoteCount(m.type, m.count); break;
      case 'ticket_status': onTicketStatus(m); break;
      case 'room_settings': applySettings(m); break;
      case 'broadcast': showBanner(m.text); break;
      case 'question_reply': onQuestionReply(m); break;
      default: break;
    }
  },
});

setMode(store.get('pulse.mode', 'captions'));
loadVotes();
loadRoomInfo();
