// Reconnecting JSON WebSocket client shared by every page.
// Backoff 1, 2, 4, 8 s, capped at 10 s (CONTRACT.md). Answers server pings.

export function connectRoom({ room, role, key, onMessage, onStatus }) {
  const delays = [1000, 2000, 4000, 8000, 10000];
  let attempt = 0;
  let ws = null;
  let closedByUs = false;
  let retryTimer = null;

  function url() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const q = new URLSearchParams({ room, role });
    if (key) q.set('key', key);
    return `${proto}//${location.host}/ws?${q}`;
  }

  function open() {
    onStatus?.(attempt === 0 ? 'connecting' : 'reconnecting');
    try {
      ws = new WebSocket(url());
    } catch {
      return schedule();
    }
    ws.onopen = () => {
      attempt = 0;
      onStatus?.('live');
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return; // JSON socket only
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.t === 'ping') { send({ t: 'pong' }); return; }
      if (msg.t === 'pong') return;
      onMessage?.(msg);
    };
    ws.onclose = (ev) => {
      if (closedByUs) return;
      if (ev.code === 4401) { onStatus?.('unauthorized'); return; }
      schedule();
    };
    ws.onerror = () => { /* onclose follows */ };
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

  // Reconnect immediately when the phone comes back online or the tab wakes up.
  window.addEventListener('online', () => {
    if (!ws || ws.readyState > WebSocket.OPEN) { attempt = 0; clearTimeout(retryTimer); open(); }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (!ws || ws.readyState > WebSocket.OPEN)) {
      attempt = 0; clearTimeout(retryTimer); open();
    }
  });

  open();
  return {
    send,
    close() { closedByUs = true; clearTimeout(retryTimer); ws?.close(); },
  };
}
