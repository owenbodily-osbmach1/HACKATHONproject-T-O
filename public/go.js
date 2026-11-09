// Pulse "Go live" control page /go/:room?key=SPEAKER_KEY.
// One button starts everything on the presenting computer:
//   slides  -> getDisplayMedia (must come first: it needs the click's user activation)
//   mic     -> getUserMedia -> captions (speech recognition) + listen-in (/ws/audio-in)
//   talk    -> resume the room's talk or create one
// The mic page (/mic) and slide relay (/relay) still exist for split setups.
import { connectRoom } from '/lib/socket.js';
import { store } from '/lib/store.js';
import { speechSupported, createCaptioner } from '/lib/captions.js';
import { listMics, openMic, startStreaming } from '/lib/capture.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const room = location.pathname.match(/^\/go\/([^/?#]+)/)?.[1] || params.get('room') || '151';
const key = params.get('key') || '';

const RELAY_CFG = {
  intervalMs: 500,
  changeThreshold: 0.02,
  stableThreshold: 0.006,
  maxMovingGapMs: 10000,
  maxWidth: 1280,
  quality: 0.8,
  uploadUrl: `/api/rooms/${encodeURIComponent(room)}/slide-frame`,
  key,
  requireFullscreen: params.get('all') !== '1',
  // Full screen = the captured frame is exactly the size of a screen in device pixels.
  screens: screenSizes(),
};

// Device-pixel sizes of the screens we know about. Only this screen until the browser
// shares the others (getScreenDetails, asked for after sharing starts).
function screenSizes() {
  const dpr = window.devicePixelRatio || 1;
  return [{ w: Math.round(screen.width * dpr), h: Math.round(screen.height * dpr) }];
}
// If the browser already lets this page see every screen (window-management permission),
// also accept a slideshow that is full screen on another monitor. Never prompts.
async function knownScreens(base) {
  try {
    const p = await navigator.permissions?.query({ name: 'window-management' });
    if (p?.state !== 'granted' || !window.getScreenDetails) return base;
    const d = await window.getScreenDetails();
    return base.concat(d.screens.map((s) => ({ w: Math.round(s.width * s.devicePixelRatio), h: Math.round(s.height * s.devicePixelRatio) })));
  } catch { return base; }
}

const st = {
  talkId: null, seq: 0, words: 0, running: false,
  micStream: null, streamer: null, captioner: null,
  display: null, worker: null, fallbackTimer: null, paused: false, slidesSent: 0, lastSlideUrl: null,
};

$('roomTitle').textContent = `Room ${room}`;
document.title = `Pulse · Go live · Room ${room}`;
$('title').value = store.get(`pulse.go.title.${room}`, '');
$('speaker').value = store.get(`pulse.go.speaker.${room}`, '');

function warn(t) { $('warn').textContent = t || ''; $('warn').hidden = !t; }
function check(id, state, detail) {
  const li = $(id);
  li.dataset.state = state; // ok | wait | bad | (empty)
  if (detail !== undefined) li.querySelector('.ck-detail').textContent = detail;
}
if (!key) warn(`No key in the URL. Open /go/${room}?key=YOUR_SPEAKER_KEY (start-pulse prints it).`);
if (!speechSupported()) warn('This browser has no speech recognition: captions need Chrome.');
if (!window.isSecureContext) warn('The mic and screen sharing need https: open the trycloudflare (or team) link, not http.');

const api = (path, opts = {}) => fetch(path, { ...opts, headers: { 'content-type': 'application/json', 'x-pulse-key': key, ...(opts.headers || {}) } });

// ---------- join link + QR ----------
(async () => {
  let base = location.origin;
  try { const c = await (await fetch('/api/config')).json(); if (c?.publicBaseUrl) base = String(c.publicBaseUrl).replace(/\/+$/, ''); } catch { /* origin */ }
  $('joinUrl').textContent = `${base.replace(/^https?:\/\//, '')}/r/${room}`;
  $('qrImg').src = `/qr/${encodeURIComponent(room)}.gif`;
})();

// ---------- control socket ----------
const sock = connectRoom({
  room, role: 'mic', key,
  onStatus: (s) => {
    $('conn').dataset.status = s;
    $('conn').querySelector('.conn-word').textContent = { live: 'Live', connecting: 'Connecting…', reconnecting: 'Reconnecting…', unauthorized: 'Wrong key' }[s] || s;
    check('ckServer', s === 'live' ? 'ok' : s === 'unauthorized' ? 'bad' : 'wait', s === 'live' ? 'Connected' : s === 'unauthorized' ? 'Wrong speaker key' : 'Reconnecting…');
  },
  onMessage: (m) => {
    // Only a live talk is resumed; an ended one stays ended and Go live starts a new talk.
    if (m.t === 'talk') { talkKnown = true; liveTalkId = m.status === 'live' ? m.talkId : null; }
    // The AV tech ended this talk from the console: stop here too, so no captions go to an ended talk.
    if (m.t === 'talk' && st.running && st.talkId && m.talkId === st.talkId && m.status === 'ended') endedElsewhere(m);
    if (m.t === 'room_status' && typeof m.listeners === 'number') check('ckPhones', m.listeners > 0 ? 'ok' : '', `${m.listeners} connected`);
  },
});

// ---------- talk ----------
let liveTalkId = null; // from the `talk` socket message
let talkKnown = false;
async function findOrCreateTalk() {
  // The socket sends `talk` on join; wait briefly for it so a live talk isn't replaced.
  for (let i = 0; i < 20 && !talkKnown; i++) await new Promise((r) => setTimeout(r, 100));
  if (liveTalkId) return liveTalkId;
  const res = await api('/api/talks', { method: 'POST', body: JSON.stringify({ room, title: $('title').value.trim() || 'Pulse demo', speaker: $('speaker').value.trim() }) });
  if (res.status === 401) throw new Error('The server rejected the speaker key.');
  if (!res.ok) throw new Error(`Could not start the talk (HTTP ${res.status}).`);
  return (await res.json()).talkId;
}
async function serverLastSeq(talkId) {
  try {
    const r = await fetch(`/api/talks/${encodeURIComponent(talkId)}/transcript?format=json`);
    if (!r.ok) return 0;
    const j = await r.json();
    return (Array.isArray(j) ? j : (j.lines || [])).reduce((m, l) => Math.max(m, Number(l.seq) || 0), 0);
  } catch { return 0; }
}

// ---------- captions ----------
let lastInterim = 0;
let interimTimer = null;
function sendFinal(text) {
  if (!st.talkId) return;
  st.seq += 1;
  store.set(`pulse.mic.seq.${st.talkId}`, st.seq);
  sock.send({ t: 'caption', talkId: st.talkId, seq: st.seq, text, ts: Date.now() });
  st.words += text.split(/\s+/).filter(Boolean).length;
  check('ckCaptions', 'ok', `${st.words} words · "${text.slice(-60)}"`);
}
function sendInterim(text) {
  const now = Date.now();
  clearTimeout(interimTimer);
  if (now - lastInterim > 150) { lastInterim = now; sock.send({ t: 'caption_interim', text }); }
  else interimTimer = setTimeout(() => sendInterim(text), 150);
}

// ---------- slides (relay) ----------
async function startSlides() {
  try {
    st.display = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 5, max: 10 } }, // native size: the full-screen check compares exact pixels
      audio: false,
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
      monitorTypeSurfaces: 'include',
    });
  } catch (e) {
    st.display = null;
    check('ckSlides', 'bad', e?.name === 'NotAllowedError' ? 'Not shared (cancelled)' : `Not shared: ${e?.message || e}`);
    $('shareBtn').hidden = false;
    return false;
  }
  const track = st.display.getVideoTracks()[0];
  try { track.contentHint = 'text'; } catch { /* optional */ }
  track.addEventListener('ended', () => { stopSlides(); check('ckSlides', 'bad', 'Sharing stopped'); $('shareBtn').hidden = false; });
  const surface = track.getSettings?.().displaySurface;
  const cfg = { ...RELAY_CFG, requireFullscreen: RELAY_CFG.requireFullscreen && surface !== 'monitor' };

  st.worker = new Worker('/lib/relay-worker.js');
  st.worker.onmessage = onRelay;
  if (window.MediaStreamTrackProcessor) {
    const processor = new MediaStreamTrackProcessor({ track });
    st.worker.postMessage({ type: 'start', readable: processor.readable, cfg }, [processor.readable]);
  } else {
    const v = document.createElement('video');
    v.muted = true; v.srcObject = st.display; v.play().catch(() => {});
    st.worker.postMessage({ type: 'start', cfg });
    st.fallbackTimer = setInterval(async () => {
      if (st.paused || v.readyState < 2) return;
      try { const bitmap = await createImageBitmap(v); st.worker.postMessage({ type: 'frame', bitmap }, [bitmap]); } catch { /* not ready */ }
    }, cfg.intervalMs);
  }
  if (cfg.requireFullscreen) knownScreens(cfg.screens).then((screens) => st.worker?.postMessage({ type: 'screens', screens }));
  $('shareBtn').hidden = true;
  $('slideCtl').hidden = false;
  check('ckSlides', 'wait', cfg.requireFullscreen ? 'Shared · press Slideshow in your slides' : 'Shared · watching the screen');
  return true;
}

function onRelay(e) {
  const m = e.data;
  if (m.type === 'sent') {
    st.slidesSent += 1;
    if (st.lastSlideUrl) URL.revokeObjectURL(st.lastSlideUrl);
    st.lastSlideUrl = URL.createObjectURL(m.blob);
    $('lastSlide').src = st.lastSlideUrl;
    $('lastSlide').hidden = false;
    check('ckSlides', 'ok', `${st.slidesSent} sent · last at ${new Date().toLocaleTimeString()}`);
  } else if (m.type === 'presenting') {
    check('ckSlides', 'ok', st.slidesSent ? `${st.slidesSent} sent · presenting` : 'Presenting');
  } else if (m.type === 'skip' && m.reason === 'not-presenting') {
    check('ckSlides', 'wait', m.long
      ? 'Still not full screen. If the slideshow is on another screen, Stop and share that whole screen instead.'
      : 'Waiting for Slideshow (only full-screen slides go to phones)');
  } else if (m.type === 'error') {
    check('ckSlides', 'bad', m.status === 401 ? 'Wrong speaker key' : `${m.message} · retrying`);
  }
}

function stopSlides() {
  clearInterval(st.fallbackTimer);
  st.worker?.postMessage({ type: 'stop' });
  st.worker?.terminate();
  st.worker = null;
  st.display?.getTracks().forEach((t) => t.stop());
  st.display = null;
  $('slideCtl').hidden = true;
}

$('shareBtn').onclick = () => startSlides();
$('pauseBtn').onclick = () => {
  st.paused = !st.paused;
  st.worker?.postMessage({ type: st.paused ? 'pause' : 'resume' });
  $('pauseBtn').textContent = st.paused ? '▶ Resume slides' : '❚❚ Pause slides';
  check('ckSlides', st.paused ? 'wait' : 'ok', st.paused ? 'Paused · phones keep the last slide' : 'Watching');
};
$('sendNowBtn').onclick = () => st.worker?.postMessage({ type: 'force' });

// ---------- Go live ----------
async function goLive() {
  warn('');
  $('goBtn').disabled = true;
  $('goBtn').textContent = 'Starting…';
  store.set(`pulse.go.title.${room}`, $('title').value);
  store.set(`pulse.go.speaker.${room}`, $('speaker').value);

  // 1. Slides first: Chrome only shows the share picker straight after a click.
  if (!st.display) await startSlides();

  // 2. Talk + mic + captions + listen-in.
  try {
    st.talkId = await findOrCreateTalk();
    st.seq = Math.max(store.get(`pulse.mic.seq.${st.talkId}`, 0), await serverLastSeq(st.talkId));
    st.micStream = await openMic($('micSelect').value);
    refreshMics();
    check('ckMic', 'ok', st.micStream.getAudioTracks()[0]?.label || 'On');
    st.streamer = await startStreaming({
      stream: st.micStream, room, speakerKey: key,
      onLevel: ({ db }) => { $('meterBar').style.width = `${Math.max(0, Math.min(100, ((db + 70) / 70) * 100))}%`; },
      onSocket: (s) => check('ckListen', s === 'live' ? 'ok' : s === 'replaced' || s === 'unauthorized' ? 'bad' : 'wait',
        { live: 'Streaming to phones', reconnecting: 'Reconnecting…', replaced: 'Another mic took over this room', unauthorized: 'Wrong key' }[s] || s),
    });
    st.captioner = createCaptioner({
      track: st.micStream.getAudioTracks()[0],
      onFinal: sendFinal,
      onInterim: sendInterim,
      onState: (s) => {
        if (s === 'listening' && !st.words) check('ckCaptions', 'ok', `Listening${st.captioner?.onDevice ? ' (on-device)' : ''} · start talking`);
        if (s === 'blocked') check('ckCaptions', 'bad', 'Microphone blocked: allow it in the address bar');
        if (s === 'restarting' || s === 'watchdog') check('ckCaptions', 'wait', 'Restarting recognition…');
      },
      onError: (err) => { if (err === 'network') check('ckCaptions', 'wait', 'Speech service unreachable, retrying…'); },
    });
    await st.captioner.start();
    st.running = true;
    $('goBtn').hidden = true;
    $('endBtn').hidden = false;
    $('doneLine').hidden = true;
    try { st.wake = await navigator.wakeLock?.request('screen'); } catch { /* optional */ }
  } catch (e) {
    check('ckMic', 'bad', e?.name === 'NotAllowedError' ? 'Microphone permission denied' : (e?.message || String(e)));
    warn(e?.name === 'NotAllowedError' ? 'Allow the microphone in the address bar, then press Go live again.' : (e?.message || String(e)));
    stopMic();
    $('goBtn').disabled = false;
    $('goBtn').textContent = '▶ Go live';
  }
}

function stopMic() {
  st.captioner?.stop();
  st.streamer?.stop();
  st.micStream?.getTracks().forEach((t) => t.stop());
  st.captioner = st.streamer = st.micStream = null;
  $('meterBar').style.width = '0%';
}

// Two taps to end, so a stray click doesn't end the talk (no browser dialogs).
let endArmed = 0;
async function endTalk() {
  if (Date.now() - endArmed > 3000) {
    endArmed = Date.now();
    $('endBtn').innerHTML = '■ Tap again to end the talk';
    setTimeout(() => { $('endBtn').innerHTML = '■ End talk <small>(saves the transcript)</small>'; }, 3000);
    return;
  }
  stopMic();
  stopSlides();
  st.running = false;
  try { st.wake?.release(); } catch { /* ignore */ }
  ['ckMic', 'ckCaptions', 'ckListen', 'ckSlides'].forEach((id) => check(id, '', 'Stopped'));
  if (!st.talkId) { showGoBtn(); return; }
  try {
    const res = await api(`/api/talks/${encodeURIComponent(st.talkId)}/end`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { reportUrl } = await res.json();
    const a = document.createElement('a');
    a.href = reportUrl || `/t/${st.talkId}`; a.target = '_blank'; a.textContent = a.href;
    $('doneLine').replaceChildren('Transcript saved: ', a);
    $('doneLine').hidden = false;
    st.talkId = null;
    liveTalkId = null;
    showGoBtn();
  } catch (e) {
    // Keep End on screen so the warning can be acted on.
    $('endBtn').innerHTML = '■ End talk <small>(saves the transcript)</small>';
    warn(`Stopped, but ending the talk failed (${e.message}). Lines already sent are saved; press End again.`);
  }
}
function endedElsewhere(m) {
  stopMic();
  stopSlides();
  st.running = false;
  try { st.wake?.release(); } catch { /* ignore */ }
  ['ckMic', 'ckCaptions', 'ckListen', 'ckSlides'].forEach((id) => check(id, '', 'Stopped'));
  const a = document.createElement('a');
  a.href = m.reportUrl || `/t/${st.talkId}`; a.target = '_blank'; a.textContent = a.href;
  $('doneLine').replaceChildren('The AV tech ended the talk. Transcript saved: ', a);
  $('doneLine').hidden = false;
  st.talkId = null;
  liveTalkId = null;
  showGoBtn();
}

function showGoBtn() {
  $('endBtn').hidden = true;
  $('goBtn').hidden = false;
  $('goBtn').disabled = false;
  $('goBtn').textContent = '▶ Go live';
}

$('goBtn').onclick = goLive;
$('endBtn').onclick = endTalk;

async function refreshMics() {
  const sel = $('micSelect');
  const cur = sel.value;
  const mics = await listMics();
  sel.innerHTML = '<option value="">Default microphone</option>';
  mics.forEach((m, i) => sel.add(new Option(m.label || `Microphone ${i + 1}`, m.deviceId)));
  sel.value = [...sel.options].some((o) => o.value === cur) ? cur : '';
}
refreshMics();

window.addEventListener('beforeunload', (e) => { if (st.running) { e.preventDefault(); e.returnValue = ''; } });
