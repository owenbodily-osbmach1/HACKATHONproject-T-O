// Slide relay /relay/:room?key=SPEAKER_KEY — runs on the presenting computer.
// Captures the slideshow screen/window (read-only), samples it every 2 s in a worker,
// and uploads a JPEG to the server only when the slide changes. The server turns each
// upload into a normal `slide` message for phones. See docs/slide-relay.md.

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const room = location.pathname.match(/^\/relay\/([^/?#]+)/)?.[1] || params.get('room') || '151';
const key = params.get('key') || '';

const CFG = {
  intervalMs: Math.round(Number(params.get('every') || 0.5) * 1000),
  changeThreshold: 0.02,  // mean pixel difference vs last sent slide that counts as "new slide"
  stableThreshold: 0.006, // difference between two samples below which the picture is "still"
  maxMovingGapMs: 10000,  // a slide that never stops moving (video) is sent at most every 10 s
  maxWidth: 1280,
  quality: 0.8,
  uploadUrl: `/api/rooms/${encodeURIComponent(room)}/slide-frame`,
  key,
  // Only send while the shared tab/window is full screen (Slideshow / Present mode), so the
  // editor, thumbnails and speaker notes never reach phones. Set per share in start().
  requireFullscreen: params.get('all') !== '1',
  screenAspect: screen.width / screen.height,
};

let stream = null;
let worker = null;
let fallbackTimer = null;
let paused = false;
let sent = 0;
let lastSentUrl = null;

$('roomTitle').textContent = `Room ${room}`;
$('statEvery').textContent = `${CFG.intervalMs / 1000} s`;
document.title = `Pulse · Slide relay · Room ${room}`;

function warn(t) { $('warn').textContent = t; $('warn').hidden = !t; }
function setState(word, status) {
  $('state').dataset.status = status;
  $('state').querySelector('.conn-word').textContent = word;
}
function status(t) { $('status').textContent = t; }

if (!key) warn(`No key in the URL. Open /relay/${room}?key=YOUR_SPEAKER_KEY.`);
if (!navigator.mediaDevices?.getDisplayMedia) warn('This browser cannot share a screen. Use Chrome or Edge on the presenting computer.');

async function start() {
  warn('');
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 2, max: 5 }, width: { ideal: 1920 } },
      audio: false,
      selfBrowserSurface: 'exclude',  // don't offer this relay tab itself
      surfaceSwitching: 'include',    // let the speaker switch to another window later
      monitorTypeSurfaces: 'include',
    });
  } catch (e) {
    status(e?.name === 'NotAllowedError' ? 'Sharing was cancelled.' : `Could not share: ${e?.message || e}`);
    return;
  }

  const track = stream.getVideoTracks()[0];
  try { track.contentHint = 'text'; } catch { /* optional */ }
  track.addEventListener('ended', () => stop('You stopped sharing.'));

  const surface = track.getSettings?.().displaySurface;
  // A whole screen (projector display) is always "presenting"; a tab or window only when full screen.
  const cfg = { ...CFG, requireFullscreen: CFG.requireFullscreen && surface !== 'monitor' };

  $('live').srcObject = stream;
  $('live').play().catch(() => {});

  worker = new Worker('/lib/relay-worker.js');
  worker.onmessage = onWorker;

  if (window.MediaStreamTrackProcessor) {
    // Frames flow straight into the worker, so a hidden window keeps sampling.
    const processor = new MediaStreamTrackProcessor({ track });
    worker.postMessage({ type: 'start', readable: processor.readable, cfg }, [processor.readable]);
  } else {
    // Fallback: grab a frame from the <video> on each tick and hand it to the worker.
    worker.postMessage({ type: 'start', cfg });
    fallbackTimer = setInterval(async () => {
      const v = $('live');
      if (paused || v.readyState < 2) return;
      try {
        const bitmap = await createImageBitmap(v);
        worker.postMessage({ type: 'frame', bitmap }, [bitmap]);
      } catch { /* not ready */ }
    }, CFG.intervalMs);
  }

  paused = false;
  $('shareBtn').hidden = true;
  $('ctl').hidden = false;
  $('pauseBtn').textContent = '❚❚ Pause';
  setState('Watching slides', 'live');
  status(cfg.requireFullscreen
    ? 'Watching. Press Slideshow (full screen) in your slides: only slides shown full screen go to phones.'
    : 'Watching the whole screen. A new slide reaches phones about a second after you click.');
}

function onWorker(e) {
  const m = e.data;
  if (m.type === 'sent') {
    sent += 1;
    $('statSent').textContent = String(sent);
    $('statBytes').textContent = `${Math.round(m.bytes / 1024)} KB`;
    if (lastSentUrl) URL.revokeObjectURL(lastSentUrl);
    lastSentUrl = URL.createObjectURL(m.blob);
    $('sentImg').src = lastSentUrl;
    $('sentImg').hidden = false;
    $('sentCap').textContent = `Last slide sent to phones${m.n ? ` (#${m.n})` : ''} · ${new Date().toLocaleTimeString()}`;
    status('Slide sent to phones.');
  } else if (m.type === 'skip' && m.reason === 'moving') {
    status('Slide is still changing (animation or video)…');
  } else if (m.type === 'skip' && m.reason === 'not-presenting') {
    setState('Waiting for slideshow', 'reconnecting');
    status('Not in Slideshow / full screen, so nothing is sent. Phones keep the last presented slide.');
  } else if (m.type === 'presenting') {
    setState('Watching slides', 'live');
  } else if (m.type === 'skip' && m.reason === 'blank') {
    status('Screen looks blank. Waiting for a slide…');
  } else if (m.type === 'error') {
    warn(m.status === 401 ? 'The server rejected the speaker key. Check ?key= in the URL.' : `${m.message}. Retrying on the next check.`);
    if (m.status === 401) stop('Stopped: wrong key.');
  }
}

function stop(msg) {
  clearInterval(fallbackTimer);
  worker?.postMessage({ type: 'stop' });
  worker?.terminate();
  worker = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  $('live').srcObject = null;
  $('shareBtn').hidden = false;
  $('ctl').hidden = true;
  setState('Not sharing', 'connecting');
  status(msg || 'Stopped. Phones keep the last slide.');
}

$('shareBtn').onclick = start;
$('stopBtn').onclick = () => stop();
$('forceBtn').onclick = () => { worker?.postMessage({ type: 'force' }); status('Sending the current screen now…'); };
$('pauseBtn').onclick = () => {
  paused = !paused;
  worker?.postMessage({ type: paused ? 'pause' : 'resume' });
  $('pauseBtn').textContent = paused ? '▶ Resume' : '❚❚ Pause';
  setState(paused ? 'Paused' : 'Watching slides', paused ? 'reconnecting' : 'live');
  status(paused ? 'Paused: phones keep the last slide. Use this before showing anything private.' : 'Watching again.');
};

window.addEventListener('beforeunload', (e) => { if (stream) { e.preventDefault(); e.returnValue = ''; } });
