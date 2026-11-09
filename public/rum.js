// Dash0 real-user monitoring for /r, /b and /t. Config comes from
// /rum-config.js (window.PULSE_RUM). Best-effort only: no config, a blocked
// script or an SDK error leaves the page exactly as it was.
(async () => {
  const cfg = window.PULSE_RUM;
  if (!cfg || !cfg.token || !cfg.endpoint) return;

  try {
    // The vendored build is an IIFE that consumes window.dash0's command queue.
    if (!window.dash0) {
      const queue = function () { (queue._q = queue._q || []).push(arguments); };
      queue._q = []; // the IIFE requires an existing queue, otherwise it refuses to run
      window.dash0 = queue;
    }
    if (window.dash0._q) {
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = '/vendor/dash0-web.js';
        script.onload = resolve;
        script.onerror = () => reject(new Error('dash0-web failed'));
        document.head.appendChild(script);
      });
    }

    // Same-origin fetch/XHR requests get traceparent automatically, so phone
    // requests join the server trace. The auth token is ingest-only and public.
    window.dash0('init', {
      serviceName: cfg.serviceName || 'pulse-web',
      endpoint: { url: cfg.endpoint, authToken: cfg.token },
    });

    watchCaptions();
  } catch (_) {
    // RUM must never break the page.
  }

  // One custom event per 10 s while captions render. r.js does not expose the
  // caption lag, so the lag attribute is only sent if a page sets it later.
  function watchCaptions() {
    const captions = document.getElementById('captions');
    if (!captions || typeof MutationObserver !== 'function') return;
    let last = 0;
    const observer = new MutationObserver(() => {
      const now = Date.now();
      if (now - last < 10000) return;
      last = now;
      const attributes = {};
      const lag = Number(window.PULSE_CAPTION_LAG_MS);
      if (Number.isFinite(lag)) attributes['pulse.caption.lag_ms'] = lag;
      try { window.dash0('sendEvent', 'caption.rendered', { attributes }); } catch (_) {}
    });
    observer.observe(captions, { childList: true });
  }
})();
