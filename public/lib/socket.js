// Reconnecting JSON WebSocket client shared by every page.
// Backoff 1, 2, 4, 8 s, capped at 10 s (CONTRACT.md). Answers server pings.
// Heartbeat: sends {t:'ping'} every 20 s; if nothing at all (not even the pong) has arrived for
// 45 s the socket is treated as dead and replaced. A phone that slept or changed networks often
// keeps a socket that looks open but never delivers anything, and never fires onclose.

export function connectRoom({ room, role, key, onMessage, onStatus }) {
  const delays = [1000, 2000, 4000, 8000, 10000];
  let attempt = 0;
  let ws = null;
  let closedByUs = false;
  let retryTimer = null;
  let lastSeen = Date.now();
  const PING_MS = 20000;
  const DEAD_MS = 45000;

  function url() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const q = new URLSearchParams({ room, role });
    if (key) q.set('key', key);
    return `${proto}//${location.host}/ws?${q}`;
  }

  function open() {
    onStatus?.(attempt === 0 ? 'connecting' : 'reconnecting');
    let sock;
    try {
      sock = new WebSocket(url());
    } catch {
      return schedule();
    }
    ws = sock;
    // Ignore events from a socket that has been replaced by a newer one.
    sock.onopen = () => {
      if (ws !== sock) return;
      attempt = 0;
      lastSeen = Date.now();
      onStatus?.('live');
    };
    sock.onmessage = (ev) => {
      if (ws !== sock || typeof ev.data !== 'string') return; // JSON socket only
      lastSeen = Date.now();
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.t === 'ping') { send({ t: 'pong' }); return; }
      if (msg.t === 'pong') return;
      onMessage?.(msg);
    };
    sock.onclose = (ev) => {
      if (closedByUs || ws !== sock) return;
      if (ev.code === 4401) { onStatus?.('unauthorized'); return; }
      schedule();
    };
    sock.onerror = () => { /* onclose follows */ };
  }

  // Replace a dead or dying socket right away (phone back online, tab woken up).
  function reopenNow(force = false) {
    if (closedByUs || (!force && ws && ws.readyState <= WebSocket.OPEN)) return;
    attempt = 0;
    clearTimeout(retryTimer);
    const old = ws;
    ws = null; // the old socket's late onclose is now ignored
    try { old?.close(); } catch { /* ignore */ }
    open();
  }

  function schedule() {
    onStatus?.('reconnecting');
    const delay = delays[Math.min(attempt, delays.length - 1)];
    attempt++;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(open, delay);
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  window.addEventListener('online', () => reopenNow());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    // Woken up after a long sleep: the old socket is probably dead even if it says OPEN.
    reopenNow(ws?.readyState === WebSocket.OPEN && Date.now() - lastSeen > DEAD_MS);
  });
  const heartbeat = setInterval(() => {
    if (closedByUs || !ws || ws.readyState !== WebSocket.OPEN) return;
    if (Date.now() - lastSeen > DEAD_MS) { reopenNow(true); return; }
    send({ t: 'ping' });
  }, PING_MS);

  open();
  return {
    send,
    close() { closedByUs = true; clearTimeout(retryTimer); clearInterval(heartbeat); ws?.close(); },
  };
}
