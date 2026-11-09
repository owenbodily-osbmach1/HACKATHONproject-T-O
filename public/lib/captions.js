// Live captions with Chrome's built-in speech recognition (podium mic page only).
// Chrome stops listening on its own (silence, random 30 s - 2 min cut-offs), so:
//  - restart in onend after 250 ms (never a tight loop)
//  - watchdog: if running and nothing arrives for 20 s, stop() and let onend restart it.

const RESTART_DELAY = 250;
const WATCHDOG_MS = 20000;

export function speechSupported() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

export async function onDeviceAvailable() {
  const SR = window.SpeechRecognition;
  if (!SR || typeof SR.available !== 'function') return false;
  try {
    return (await SR.available({ langs: ['en-US'], processLocally: true })) === 'available';
  } catch {
    return false;
  }
}

export function createCaptioner({ track, onFinal, onInterim, onState, onError }) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null;
  let wanted = false;
  let lastHeard = 0;
  let watchdog = null;
  let restartTimer = null;
  let local = false;
  let usedTrack = false;

  async function build() {
    rec = new SR();
    rec.lang = 'en-US';
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    if (await onDeviceAvailable()) {
      try { rec.processLocally = true; local = true; } catch { local = false; }
    }

    rec.onresult = (ev) => {
      lastHeard = Date.now();
      let interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        const text = r[0].transcript.trim();
        if (!text) continue;
        if (r.isFinal) onFinal?.(text);
        else interim += (interim ? ' ' : '') + text;
      }
      onInterim?.(interim);
    };
    rec.onstart = () => { lastHeard = Date.now(); onState?.('listening'); };
    rec.onerror = (ev) => {
      // 'no-speech' and 'aborted' are normal; let onend restart.
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
        wanted = false;
        onState?.('blocked');
      }
      if (ev.error !== 'no-speech' && ev.error !== 'aborted') onError?.(ev.error);
    };
    rec.onend = () => {
      onInterim?.('');
      if (!wanted) { onState?.('stopped'); return; }
      onState?.('restarting');
      clearTimeout(restartTimer);
      restartTimer = setTimeout(startRec, RESTART_DELAY);
    };
  }

  function startRec() {
    if (!wanted || !rec) return;
    try {
      // Share the one mic track with listen-in when the browser supports it;
      // older Chrome ignores the argument and opens the default mic itself.
      if (track && !usedTrack) {
        try { rec.start(track); usedTrack = true; return; } catch { /* fall through */ }
      }
      rec.start(usedTrack ? track : undefined);
    } catch (e) {
      // InvalidStateError: already started. Anything else: try again shortly.
      if (e && e.name !== 'InvalidStateError') {
        clearTimeout(restartTimer);
        restartTimer = setTimeout(startRec, 1000);
      }
    }
  }

  return {
    async start() {
      if (!SR) throw new Error('Speech recognition needs Chrome or Edge');
      wanted = true;
      if (!rec) await build();
      startRec();
      clearInterval(watchdog);
      watchdog = setInterval(() => {
        if (wanted && Date.now() - lastHeard > WATCHDOG_MS) {
          lastHeard = Date.now();
          onState?.('watchdog');
          try { rec.stop(); } catch { /* onend restarts */ }
        }
      }, 2000);
    },
    stop() {
      wanted = false;
      clearInterval(watchdog);
      clearTimeout(restartTimer);
      try { rec?.stop(); } catch { /* ignore */ }
    },
    get onDevice() { return local; },
  };
}
