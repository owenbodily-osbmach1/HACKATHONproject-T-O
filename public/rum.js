// Dash0 real-user monitoring for /r, /b and /t. Config comes from
// /rum-config.js (window.PULSE_RUM). Best-effort only: no config, a blocked
// script or an SDK error leaves the page exactly as it was.
// Privacy (phone side, before anything is exported):
// - every URL the SDK records (page, fetch/XHR, resource, referrer) is reduced to scheme + host +
//   a path template: ids become ":id", and the query string (search words, ?key=, clientIds) and
//   the fragment are dropped;
// - the SDK sees a coarse browser name ("Chrome (mobile)") instead of the full user agent;
// - no request headers are captured, and page views never include the search or hash part.
export function templatePath(path) {
  return String(path || '/').split('?')[0].split('#')[0].split('/')
    .map((seg, i) => (i < 2 || (/^[a-z][a-z-]*$/i.test(seg) && seg.length <= 24 && !/\d/.test(seg)) ? seg : ':id'))
    .join('/') || '/';
}

export function scrubUrlAttributes(attrs) {
  const out = { ...attrs };
  const path = templatePath(attrs['url.path'] || '/');
  const scheme = attrs['url.scheme'] || 'https';
  const domain = attrs['url.domain'] || '';
  out['url.path'] = path;
  out['url.query'] = undefined;
  out['url.fragment'] = undefined;
  out['url.full'] = domain ? `${scheme}://${domain}${path}` : path;
  return out;
}

export function coarseUserAgent(ua) {
  const s = String(ua || '');
  const name = /Edg\//.test(s) ? 'Edge' : /OPR\//.test(s) ? 'Opera' : /Firefox\//.test(s) ? 'Firefox'
    : /Chrome\//.test(s) || /CriOS\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : 'Other';
  return `${name}${/Mobi|Android|iPhone|iPad/.test(s) ? ' (mobile)' : ''}`;
}

(async () => {
  const cfg = window.PULSE_RUM;
  if (!cfg || !cfg.token || !cfg.endpoint) return;

  try {
    // The SDK copies navigator.userAgent into every signal at init; it only ever sees the coarse form.
    try {
      const coarse = coarseUserAgent(navigator.userAgent);
      Object.defineProperty(navigator, 'userAgent', { get: () => coarse, configurable: true });
    } catch (_) { /* older browsers: the SDK just won't load below if this fails badly */ }

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
      urlAttributeScrubber: scrubUrlAttributes,
      headersToCapture: [],
      pageViewInstrumentation: { trackVirtualPageViews: true, includeParts: [] },
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
