// Podium mic capture: one getUserMedia track feeds the level meter and the
// listen-in stream (/ws/audio-in). Only the /mic/:room page may import this.

export async function listMics() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'audioinput');
  } catch {
    return [];
  }
}

export async function openMic(deviceId) {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  });
}

// Streams 100 ms Int16 frames to the server and reports the level in dBFS.
export async function startStreaming({ stream, room, speakerKey, onLevel, onFrameSent, onSocket }) {
  const AC = window.AudioContext || window.webkitAudioContext;
  let ctx;
  try {
    ctx = new AC({ sampleRate: 16000 }); // Chrome resamples the mic for us
  } catch {
    ctx = new AC(); // worklet downsamples instead
  }
  await ctx.audioWorklet.addModule('/lib/pcm-worklet.js');
  const src = ctx.createMediaStreamSource(stream);
  const framer = new AudioWorkletNode(ctx, 'pcm-framer');
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  src.connect(framer);
  src.connect(analyser);
  // The worklet must be pulled by the graph; route it to a muted gain so nothing plays locally.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  framer.connect(mute).connect(ctx.destination);

  let ws = null;
  let stopped = false;
  let retry = 0;
  let retryTimer = null;

  function open() {
    if (stopped) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const q = new URLSearchParams({ room, key: speakerKey });
    const sock = new WebSocket(`${proto}//${location.host}/ws/audio-in?${q}`);
    ws = sock;
    sock.binaryType = 'arraybuffer';
    // Events from a socket we've already replaced (takeOver) are ignored.
    sock.onopen = () => { if (ws !== sock) return; retry = 0; onSocket?.('live'); };
    sock.onclose = (ev) => {
      if (stopped || ws !== sock) return;
      if (ev.code === 4401) { onSocket?.('unauthorized'); return; }
      // 4409: another sender (podium mic or AV pre-show feed) took over this room.
      // Don't reconnect on our own, or the two would keep knocking each other off.
      if (ev.code === 4409) { onSocket?.('replaced'); return; }
      onSocket?.('reconnecting');
      retryTimer = setTimeout(open, [1000, 2000, 4000, 8000, 10000][Math.min(retry++, 4)]);
    };
  }
  open();

  framer.port.onmessage = (ev) => {
    if (ws && ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 64000) {
      ws.send(ev.data);
      onFrameSent?.();
    }
  };

  const buf = new Float32Array(analyser.fftSize);
  const meter = setInterval(() => {
    analyser.getFloatTimeDomainData(buf);
    let sum = 0, peak = 0;
    for (let i = 0; i < buf.length; i++) { sum += buf[i] * buf[i]; peak = Math.max(peak, Math.abs(buf[i])); }
    const rms = Math.sqrt(sum / buf.length);
    onLevel?.({ db: rms > 0 ? 20 * Math.log10(rms) : -100, peak });
  }, 100);

  if (ctx.state === 'suspended') await ctx.resume();

  return {
    // Take the room's audio back after being replaced (closes the other sender with 4409).
    takeOver() {
      retry = 0;
      clearTimeout(retryTimer);
      const old = ws;
      ws = null; // its close event is now ignored
      try { old?.close(); } catch { /* ignore */ }
      open();
    },
    stop() {
      stopped = true;
      clearInterval(meter);
      clearTimeout(retryTimer);
      try { ws?.close(); } catch { /* ignore */ }
      try { ctx.close(); } catch { /* ignore */ }
    },
  };
}
