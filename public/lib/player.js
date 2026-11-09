// Listen-in player. Receives Int16 LE mono 16 kHz frames (100 ms) on /ws/audio-out
// and plays them with a ~250 ms jitter buffer. Receive-only: never sends anything.
//
// MUST be started from inside a user tap: the AudioContext and iOS audioSession
// are only allowed to start from a user gesture.

const SAMPLE_RATE = 16000;
const LEAD = 0.25;      // schedule this far ahead (jitter buffer)
const MAX_BEHIND = 1.0; // drop frames more than this far behind

export function createPlayer({ room, onLevel, onState }) {
  let ctx = null;
  let ws = null;
  let playHead = 0;
  let stopped = true;
  let retry = 0;
  let retryTimer = null;

  function start() {
    clearTimeout(retryTimer);
    // iPhone: without this, Web Audio is silent when the ringer switch is off (iOS 17+).
    try {
      if (navigator.audioSession) navigator.audioSession.type = 'playback';
    } catch { /* not supported */ }

    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
    // Unlock on iOS: play one silent sample inside the tap.
    const silent = ctx.createBuffer(1, 1, 22050);
    const src = ctx.createBufferSource();
    src.buffer = silent;
    src.connect(ctx.destination);
    src.start(0);
    ctx.resume?.();

    // Safari reports 'interrupted' after the phone locks or another app takes the audio.
    const ac = ctx;
    ac.onstatechange = () => {
      if (ac !== ctx) return;
      if (ac.state === 'interrupted' || ac.state === 'suspended') resumeAudio();
    };
    document.addEventListener('visibilitychange', onVisible);

    stopped = false;
    playHead = 0;
    openSocket();
  }

  // Never creates an AudioContext: only resumes the one the user's tap created.
  function resumeAudio() {
    if (stopped) return;
    try { ctx?.resume?.(); } catch { /* ignore */ }
    if (ws && ws.readyState > WebSocket.OPEN) {
      clearTimeout(retryTimer);
      openSocket();
    }
  }

  function onVisible() {
    if (document.visibilityState === 'visible') resumeAudio();
  }

  function openSocket() {
    if (stopped) return;
    onState?.('connecting');
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const sock = new WebSocket(`${proto}//${location.host}/ws/audio-out?room=${encodeURIComponent(room)}`);
    ws = sock;
    sock.binaryType = 'arraybuffer';
    // Every handler ignores events from a socket that has been replaced (stop → start quickly).
    sock.onopen = () => { if (ws !== sock) return; retry = 0; onState?.('playing'); };
    sock.onmessage = (ev) => { if (ws === sock && ev.data instanceof ArrayBuffer) playFrame(ev.data); };
    sock.onclose = () => {
      if (stopped || ws !== sock) return;
      onState?.('reconnecting');
      const delay = [1000, 2000, 4000, 8000, 10000][Math.min(retry++, 4)];
      retryTimer = setTimeout(openSocket, delay);
    };
  }

  function playFrame(buf) {
    if (!ctx || stopped) return;
    const pcm = new Int16Array(buf);
    if (!pcm.length) return;
    const audioBuf = ctx.createBuffer(1, pcm.length, SAMPLE_RATE);
    const out = audioBuf.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < pcm.length; i++) {
      const s = pcm[i] / 32768;
      out[i] = s;
      sum += s * s;
    }
    onLevel?.(Math.sqrt(sum / pcm.length));

    const now = ctx.currentTime;
    if (playHead < now) {
      // Fell behind (or first frame): restart the buffer LEAD seconds ahead.
      playHead = now + LEAD;
    } else if (playHead - now > LEAD + MAX_BEHIND) {
      // Queue grew too long (network burst): drop this frame to catch up.
      return;
    }
    const node = ctx.createBufferSource();
    node.buffer = audioBuf;
    node.connect(ctx.destination);
    node.start(playHead);
    playHead += audioBuf.duration;
  }

  function stop() {
    stopped = true;
    document.removeEventListener('visibilitychange', onVisible);
    clearTimeout(retryTimer);
    try { ws?.close(); } catch { /* ignore */ }
    try { ctx?.close(); } catch { /* ignore */ }
    ws = null;
    ctx = null;
    onLevel?.(0);
    onState?.('stopped');
  }

  return { start, stop, get playing() { return !stopped; } };
}
