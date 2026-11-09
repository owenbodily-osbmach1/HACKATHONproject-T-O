// Podium mic page /mic/:room?key=SPEAKER_KEY. The only page allowed to use the microphone.
import { connectRoom } from '/lib/socket.js';
import { store } from '/lib/store.js';
import { speechSupported, createCaptioner } from '/lib/captions.js';
import { listMics, openMic, startStreaming } from '/lib/capture.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const room = location.pathname.match(/^\/mic\/([^/?#]+)/)?.[1] || params.get('room') || '151';
const key = params.get('key') || '';
const deck = params.get('deck') || 'pulse';

const state = {
  talkId: null,
  seq: 0,
  words: 0,
  linesSent: 0,
  running: false,
  stream: null,
  captioner: null,
  streamer: null,
  slides: [],
  slideN: 0,
};

$('roomTitle').textContent = `Room ${room}`;
document.title = `Pulse · Podium mic · Room ${room}`;
$('title').value = store.get(`pulse.mic.title.${room}`, '');
$('speaker').value = store.get(`pulse.mic.speaker.${room}`, '');

function warn(text) {
  $('warn').textContent = text;
  $('warn').hidden = !text;
}
if (!key) warn('No key in the URL. Open this page as /mic/' + room + '?key=YOUR_SPEAKER_KEY.');
if (!speechSupported()) warn('This browser has no speech recognition. Use Chrome on this laptop.');
if (!window.isSecureContext) warn('The mic only works over https (or localhost). Open the https team URL.');

const api = (path, opts = {}) => fetch(path, {
  ...opts,
  headers: { 'content-type': 'application/json', 'x-pulse-key': key, ...(opts.headers || {}) },
});

// ---------- QR code for slide 1 ----------
// The QR must point at an address phones can open: ?base= override, then the server's
// PUBLIC_BASE_URL (GET /api/config → publicBaseUrl), then this page's own origin.
const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)$/i;

async function qrBase() {
  const override = params.get('base');
  if (override) return override.replace(/\/+$/, '');
  try {
    const c = await (await fetch('/api/config')).json();
    if (c && c.publicBaseUrl) return String(c.publicBaseUrl).replace(/\/+$/, '');
  } catch { /* fall back to origin */ }
  return location.origin;
}

async function renderQr() {
  const base = await qrBase();
  const url = `${base}/r/${room}`;
  let host = '';
  try { host = new URL(base).hostname; } catch { /* bad override */ }
  $('qrWarn').hidden = !LOCAL_HOST.test(host);
  try {
    const qr = window.qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    const img = document.createElement('img');
    img.src = qr.createDataURL(10, 4); // GIF: right-click "Copy image" pastes into Slides/Keynote
    img.alt = `QR code for ${url}`;
    $('qr').replaceChildren(img);
    const dl = $('qrDl');
    dl.href = img.src;
    dl.download = `pulse-room-${room}-qr.gif`;
    dl.hidden = false;
  } catch {
    $('qr').textContent = 'QR code failed to load.';
  }
  $('qrUrl').textContent = url.replace(/^https?:\/\//, '');
  $('qrUrl').href = url;
}
renderQr();

// ---------- control socket (captions + slides go up, room_status comes down) ----------
const CONN = { live: 'Live', connecting: 'Connecting…', reconnecting: 'Reconnecting…', unauthorized: 'Wrong key' };
const sock = connectRoom({
  room,
  role: 'mic',
  key,
  onStatus: (s) => {
    if (s === 'live') setTimeout(() => { while (unsent.length && sock.send(unsent[0])) { unsent.shift(); state.linesSent += 1; } }, 0);
    $('conn').dataset.status = s;
    $('conn').querySelector('.conn-word').textContent = CONN[s] || s;
    if (s === 'unauthorized') warn('The server rejected the speaker key. Check ?key= in the URL.');
    updateSaving();
  },
  onMessage: (m) => {
    if (m.t === 'room_status' && typeof m.listeners === 'number') $('statListeners').textContent = String(m.listeners);
    // The AV tech ended this talk from the console: stop captioning so nothing goes to an ended talk.
    if (m.t === 'talk' && state.running && state.talkId && m.talkId === state.talkId && m.status === 'ended') {
      stopDevices();
      state.running = false;
      $('stopBtn').hidden = true;
      $('startBtn').hidden = false;
      updateSaving();
      releaseAwake();
      $('doneLine').replaceChildren('The AV tech ended the talk. Transcript saved: ');
      const a = Object.assign(document.createElement('a'), { href: m.reportUrl || `/t/${state.talkId}`, target: '_blank' });
      a.textContent = a.href;
      $('doneLine').append(a);
      $('doneLine').hidden = false;
      state.talkId = null;
      renderSlidePos();
    }
  },
});

function updateSaving() {
  const live = $('conn').dataset.status === 'live';
  $('statSaving').textContent = !state.running ? 'Not saving'
    : live ? `Saving · ${state.linesSent} lines` : 'Offline · not saving';
}

// ---------- captions ----------
let lastInterimSent = 0;
let pendingInterim = null;

// Lines said while the socket is down are queued and sent when it's back (phones de-duplicate),
// and every line carries the title so a restarted server can re-create the talk (server/hub.js).
const unsent = [];
function sendFinal(text) {
  if (!state.talkId) return;
  state.seq += 1;
  store.set(`pulse.mic.seq.${state.talkId}`, state.seq);
  const msg = { t: 'caption', talkId: state.talkId, seq: state.seq, text, ts: Date.now(), title: $('title').value.trim(), speaker: $('speaker').value.trim() };
  const ok = sock.send(msg);
  if (ok) state.linesSent += 1;
  else { unsent.push(msg); if (unsent.length > 200) unsent.shift(); }
  state.words += text.split(/\s+/).filter(Boolean).length;
  $('statWords').textContent = String(state.words);
  $('lastLine').textContent = text;
  updateSaving();
}

function sendInterim(text) {
  // At most ~7 interim updates a second.
  const now = Date.now();
  clearTimeout(pendingInterim);
  if (now - lastInterimSent > 150) {
    lastInterimSent = now;
    sock.send({ t: 'caption_interim', text });
  } else {
    pendingInterim = setTimeout(() => sendInterim(text), 150);
  }
}

const REC_WORDS = {
  listening: 'Listening', restarting: 'Restarting recognition…', watchdog: 'No speech for 20 s, restarting…',
  stopped: 'Stopped.', blocked: 'Microphone blocked. Allow it in the address bar, then press Start again.',
};

// ---------- talk lifecycle ----------
async function findOrCreateTalk() {
  try {
    const res = await fetch('/api/rooms');
    if (res.ok) {
      // Resume only a talk that is still live. An ended talk stays ended (its transcript is saved):
      // going live again starts a new talk, so every phone flips from "Ended" back to "Live".
      const r = (await res.json()).find((x) => String(x.room) === String(room) && x.talkId && x.status === 'live');
      if (r) return r.talkId;
    }
  } catch { /* create one below */ }
  const title = $('title').value.trim() || 'Untitled talk';
  const speaker = $('speaker').value.trim();
  const res = await api('/api/talks', { method: 'POST', body: JSON.stringify({ room, title, speaker }) });
  if (res.status === 401) throw new Error('The server rejected the speaker key.');
  if (!res.ok) throw new Error(`Could not create the talk (HTTP ${res.status}).`);
  return (await res.json()).talkId;
}

async function serverLastSeq(talkId) {
  try {
    const r = await fetch(`/api/talks/${encodeURIComponent(talkId)}/transcript?format=json`);
    if (!r.ok) return 0;
    const j = await r.json();
    const lines = Array.isArray(j) ? j : (j.lines || []);
    return lines.reduce((m, l) => Math.max(m, Number(l.seq) || 0), 0);
  } catch {
    return 0;
  }
}

async function start() {
  warn('');
  $('startBtn').disabled = true;
  store.set(`pulse.mic.title.${room}`, $('title').value);
  store.set(`pulse.mic.speaker.${room}`, $('speaker').value);
  try {
    state.talkId = await findOrCreateTalk();
    // Resuming on another laptop/browser: continue after the highest seq the server already has,
    // or phones would drop the new lines as duplicates.
    state.seq = Math.max(store.get(`pulse.mic.seq.${state.talkId}`, 0), await serverLastSeq(state.talkId));

    state.stream = await openMic($('micSelect').value);
    refreshMics(); // labels appear once permission is granted
    const track = state.stream.getAudioTracks()[0];

    state.streamer = await startStreaming({
      stream: state.stream,
      room,
      speakerKey: key,
      onLevel: showLevel,
      onSocket: (s) => {
        $('audioState').textContent = { live: 'Listen-in streaming', reconnecting: 'Listen-in reconnecting…', unauthorized: 'Listen-in: wrong key', replaced: 'Listen-in: another source took over' }[s] || s;
        $('takeOverBtn').hidden = s !== 'replaced';
      },
    });

    state.captioner = createCaptioner({
      track,
      onFinal: sendFinal,
      onInterim: sendInterim,
      onState: (s) => {
        const extra = s === 'listening' && state.captioner?.onDevice ? ' (on-device, works without Wi-Fi)' : '';
        $('recState').textContent = (REC_WORDS[s] || s) + extra;
      },
      onError: (e) => { if (e === 'network') $('recState').textContent = 'Speech service unreachable, retrying…'; },
    });
    await state.captioner.start();

    state.running = true;
    renderSlidePos();
    $('startBtn').hidden = true;
    $('stopBtn').hidden = false;
    $('doneLine').hidden = true;
    updateSaving();
    keepAwake();
  } catch (e) {
    stopDevices();
    warn(e?.name === 'NotAllowedError' ? 'Microphone permission was denied. Allow it in the address bar and try again.' : (e?.message || String(e)));
  } finally {
    $('startBtn').disabled = false;
  }
}

function stopDevices() {
  state.captioner?.stop();
  state.streamer?.stop();
  state.stream?.getTracks().forEach((t) => t.stop());
  state.captioner = state.streamer = state.stream = null;
  showLevel({ db: -100, peak: 0 });
  $('audioState').textContent = 'Listen-in off';
}

async function stopAndSave() {
  if (!confirmStop()) return;
  stopDevices();
  state.running = false;
  $('stopBtn').hidden = true;
  $('startBtn').hidden = false;
  updateSaving();
  releaseAwake();
  if (!state.talkId) return;
  try {
    const res = await api(`/api/talks/${encodeURIComponent(state.talkId)}/end`, { method: 'POST' });
    if (!res.ok) throw new Error(res.status === 401 ? 'The server rejected the speaker key.' : `HTTP ${res.status}`);
    const { reportUrl } = await res.json();
    const link = reportUrl || `/t/${state.talkId}`;
    $('doneLine').innerHTML = '';
    $('doneLine').append('Transcript saved: ');
    const a = document.createElement('a');
    a.href = link;
    a.textContent = link;
    a.target = '_blank';
    $('doneLine').append(a);
    $('doneLine').hidden = false;
  } catch (e) {
    // Keep talkId so pressing Start resumes the same talk.
    warn(`Stopped, but ending the talk on the server failed (${e?.message || e}). Lines already sent are saved; the talk is still open.`);
    return;
  }
  state.talkId = null;
  renderSlidePos();
}

// A two-step stop instead of confirm(): browser dialogs can block the page.
let stopArmed = 0;
function confirmStop() {
  if (Date.now() - stopArmed < 3000) return true;
  stopArmed = Date.now();
  $('stopBtn').textContent = '■ Tap again to stop and save';
  setTimeout(() => { $('stopBtn').textContent = '■ Stop and save'; }, 3000);
  return false;
}

$('startBtn').onclick = start;
$('takeOverBtn').onclick = () => { state.streamer?.takeOver(); $('takeOverBtn').hidden = true; };
$('stopBtn').onclick = stopAndSave;

// ---------- mic picker + meter ----------
async function refreshMics() {
  const sel = $('micSelect');
  const current = sel.value;
  const mics = await listMics();
  sel.innerHTML = '<option value="">Default microphone</option>';
  mics.forEach((m, i) => {
    const o = document.createElement('option');
    o.value = m.deviceId;
    o.textContent = m.label || `Microphone ${i + 1}`;
    sel.appendChild(o);
  });
  sel.value = [...sel.options].some((o) => o.value === current) ? current : '';
}
navigator.mediaDevices?.addEventListener?.('devicechange', refreshMics);
refreshMics();

function showLevel({ db, peak }) {
  const pct = Math.max(0, Math.min(100, ((db + 70) / 70) * 100)); // -70..0 dBFS
  const bar = $('meterBar');
  bar.style.width = `${pct}%`;
  bar.dataset.zone = peak > 0.98 ? 'hot' : db < -50 ? 'low' : 'ok';
  $('dbText').textContent = db <= -99 ? '— dBFS' : `${Math.round(db)} dBFS${peak > 0.98 ? ' · clipping' : db < -50 ? ' · very quiet' : ''}`;
}

// ---------- keep the laptop awake while captioning ----------
let wakeLock = null;
async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* not critical */ }
}
function releaseAwake() { try { wakeLock?.release(); } catch { /* ignore */ } wakeLock = null; }
document.addEventListener('visibilitychange', () => { if (state.running && document.visibilityState === 'visible') keepAwake(); });

// ---------- manual slide fallback ----------
async function loadDeck() {
  try {
    const res = await fetch(`/slides/${encodeURIComponent(deck)}/slides.json`);
    if (!res.ok) return;
    state.slides = await res.json();
    state.slideN = 0;
    renderSlidePos();
  } catch { /* no deck yet */ }
}
function renderSlidePos() {
  const total = state.slides.length;
  $('slidePos').textContent = total ? (state.slideN ? `Slide ${state.slideN} / ${total}` : `${total} slides ready`) : 'No deck loaded';
  $('prevSlide').disabled = !total || !state.talkId || state.slideN <= 1;
  $('nextSlide').disabled = !total || !state.talkId || state.slideN >= total;
}
function goSlide(n) {
  const s = state.slides[n - 1];
  if (!s || !state.talkId) return; // slides belong to a talk: press Start first
  state.slideN = n;
  sock.send({ t: 'slide', talkId: state.talkId, n, total: state.slides.length, url: s.url, alt: s.alt });
  renderSlidePos();
}
$('prevSlide').onclick = () => goSlide(state.slideN - 1);
$('nextSlide').onclick = () => goSlide(state.slideN + 1);
renderSlidePos();
loadDeck();

window.addEventListener('beforeunload', (e) => {
  if (state.running) { e.preventDefault(); e.returnValue = ''; }
});
