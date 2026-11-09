// Slide relay worker. Runs off the main thread so a hidden or minimized relay window
// keeps sampling. Every `intervalMs` it looks at the latest captured frame, and uploads
// a JPEG only when the picture changed AND then held still for one more sample
// (so transitions, builds and cursor wiggles don't spam uploads).
//
// Input:  {type:'start', readable?, cfg}  readable = MediaStreamTrackProcessor stream (Chrome)
//         {type:'frame', bitmap}          fallback: main thread posts an ImageBitmap each tick
//         {type:'pause'|'resume'|'stop'|'force'}
// Output: {type:'sent', n, url, bytes, blob} | {type:'skip', reason} | {type:'error', status, message}

const THUMB_W = 32;
const THUMB_H = 18;

let cfg = null;
let latestFrame = null;   // VideoFrame (processor path)
let latestBitmap = null;  // ImageBitmap (fallback path)
let sentThumb = null;     // thumbnail of the last uploaded slide
let prevThumb = null;     // thumbnail from the previous sample
let changingSince = 0;
let lastSendAt = 0;
let paused = false;
let forceNext = false;
let timer = null;
let busy = false;
let stopped = false;

const thumbCanvas = new OffscreenCanvas(THUMB_W, THUMB_H);
const thumbCtx = thumbCanvas.getContext('2d', { willReadFrequently: true });

self.onmessage = (e) => {
  const m = e.data;
  switch (m.type) {
    case 'start':
      cfg = m.cfg;
      if (m.readable) readFrames(m.readable);
      clearInterval(timer);
      timer = setInterval(tick, cfg.intervalMs);
      break;
    case 'frame':
      latestBitmap?.close();
      latestBitmap = m.bitmap;
      break;
    case 'pause': paused = true; break;
    case 'resume': paused = false; prevThumb = null; break;
    case 'force': forceNext = true; break;
    case 'stop':
      stopped = true;
      clearInterval(timer);
      latestFrame?.close();
      latestBitmap?.close();
      latestFrame = latestBitmap = null;
      break;
    default: break;
  }
};

async function readFrames(readable) {
  const reader = readable.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done || stopped) { value?.close(); break; }
      // Keep only the newest frame; close the rest right away or capture stalls.
      latestFrame?.close();
      latestFrame = value;
    }
  } catch { /* track ended */ }
}

function thumbOf(source) {
  thumbCtx.drawImage(source, 0, 0, THUMB_W, THUMB_H);
  const px = thumbCtx.getImageData(0, 0, THUMB_W, THUMB_H).data;
  const g = new Float32Array(THUMB_W * THUMB_H);
  for (let i = 0, j = 0; i < px.length; i += 4, j++) g[j] = (0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]) / 255;
  return g;
}

// Mean absolute difference, 0..1.
function diff(a, b) {
  if (!a || !b) return 1;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

// A near-uniform frame is a blank/black screen (sleeping display, fade to black).
function isBlank(t) {
  let mean = 0;
  for (const v of t) mean += v;
  mean /= t.length;
  let varSum = 0;
  for (const v of t) varSum += (v - mean) ** 2;
  return Math.sqrt(varSum / t.length) < 0.015;
}

async function tick() {
  if (paused || busy || stopped || !cfg) return;
  let source = null;
  let toClose = null;
  if (latestFrame) {
    try { source = latestFrame.clone(); toClose = source; } catch { return; }
  } else if (latestBitmap) {
    source = latestBitmap;
  }
  if (!source) return;

  busy = true;
  try {
    const width = source.displayWidth || source.width;
    const height = source.displayHeight || source.height;
    const t = thumbOf(source);
    const now = Date.now();
    const dPrev = diff(t, prevThumb);
    const dSent = diff(t, sentThumb);
    prevThumb = t;

    const force = forceNext;
    forceNext = false;

    if (!force) {
      if (isBlank(t)) { post({ type: 'skip', reason: 'blank' }); return; }
      if (dSent < cfg.changeThreshold) { changingSince = 0; return; } // same slide
      if (dPrev > cfg.stableThreshold) {
        // Still moving (transition, animation, video). Wait for it to settle, but if it
        // never settles (a video slide), send at most one frame per `maxMovingGapMs`.
        if (!changingSince) changingSince = now;
        const longMotion = now - changingSince > cfg.maxMovingGapMs && now - lastSendAt > cfg.maxMovingGapMs;
        if (!longMotion) { post({ type: 'skip', reason: 'moving' }); return; }
      }
    }

    // Encode at most `maxWidth` wide; slides stay readable at 1280 px.
    const scale = Math.min(1, cfg.maxWidth / width);
    const w = Math.round(width * scale);
    const h = Math.round(height * scale);
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext('2d').drawImage(source, 0, 0, w, h);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: cfg.quality });

    const res = await fetch(cfg.uploadUrl, {
      method: 'POST',
      headers: { 'content-type': 'image/jpeg', 'x-pulse-key': cfg.key },
      body: blob,
    });
    if (!res.ok) {
      post({ type: 'error', status: res.status, message: res.status === 401 ? 'Wrong speaker key' : `Upload failed (${res.status})` });
      if (res.status === 401) { stopped = true; clearInterval(timer); }
      return;
    }
    const body = await res.json().catch(() => ({}));
    sentThumb = t;
    lastSendAt = now;
    changingSince = 0;
    post({ type: 'sent', n: body.n, url: body.url, bytes: blob.size, blob });
  } catch (err) {
    post({ type: 'error', status: 0, message: String(err && err.message || err) });
  } finally {
    toClose?.close();
    busy = false;
  }
}

function post(m) { self.postMessage(m); }
