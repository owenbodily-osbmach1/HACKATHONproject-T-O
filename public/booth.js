// Booth staff screen /booth/:booth?key=TECH_KEY
// Live request queue over WebSocket, totals and privacy-filtered report over HTTP.
import { connectRoom } from '/lib/socket.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
let pathBooth = '';
try {
  pathBooth = decodeURIComponent(location.pathname.match(/^\/booth\/([^/?#]+)/)?.[1] || '');
} catch { /* malformed path */ }
const boothId = pathBooth || params.get('booth') || params.get('room') || '';
const key = params.get('key') || '';
const byName = 'Booth staff';

const KIND_WORD = { talk_to_engineer: 'Talk to an engineer', send_resources: 'Send resources' };
const CONN_WORD = { live: 'Live', connecting: 'Connecting…', reconnecting: 'Reconnecting…', unauthorized: 'Wrong key' };

let queue = new Map(); // requestId -> {id, kind, position, ts, receivedAt}
const knownIds = new Set(); // requests already seen, so a report refresh never re-chimes
const doneIds = new Set(); // local Done wins over a report that was already in flight
let report = { visits: null, uniqueDevices: null, fromTalks: [], topics: [] };
let reportLoaded = false;
let reportBusy = false;
let unavailable = false;
let lastQueueSig = '';
let warnKind = '';

function setConn(status, word) {
  $('conn').dataset.status = status;
  $('conn').querySelector('.conn-word').textContent = word || CONN_WORD[status] || status;
}

function warn(text, kind = 'transient') {
  $('warn').textContent = text;
  $('warn').hidden = false;
  warnKind = kind;
}

function clearTransientWarn() {
  if (warnKind === 'transient' || warnKind === 'unavailable') {
    $('warn').hidden = true;
    warnKind = '';
  }
}

function toMs(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? Math.round(v * 1000) : v;
  const parsed = Date.parse(v);
  if (!Number.isNaN(parsed)) return parsed;
  const n = Number(v);
  return Number.isFinite(n) ? (n < 1e12 ? Math.round(n * 1000) : n) : null;
}

function normRequest(item, fallbackPosition) {
  const rawId = item?.requestId ?? item?.id;
  if (rawId === undefined || rawId === null || rawId === '') return null;
  const position = Number(item?.position);
  return {
    id: String(rawId),
    kind: String(item?.kind || ''),
    position: Number.isFinite(position) && position > 0 ? position : fallbackPosition,
    ts: toMs(item?.ts ?? item?.openedAt ?? item?.at),
    receivedAt: Date.now(),
  };
}

async function api(path, body, method = 'GET') {
  const res = await fetch(path, {
    method,
    headers: { 'x-pulse-key': key, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    warn('The server rejected the staff key. Open /booth/' + boothId + '?key=YOUR_TECH_KEY', 'unauthorized');
    const err = new Error('401');
    err.unauthorized = true;
    throw err;
  }
  if (res.status === 404) {
    const err = new Error('not-found');
    err.notFound = true;
    throw err;
  }
  if (!res.ok) throw new Error(String(res.status));
  return res.json().catch(() => ({}));
}

// ---------- sound: chime when a request arrives; AudioContext starts on a tap ----------
let audioCtx = null;
let soundOn = false;
$('soundBtn').onclick = () => {
  soundOn = !soundOn;
  if (soundOn && !audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  audioCtx?.resume?.();
  $('soundBtn').setAttribute('aria-pressed', String(soundOn));
  $('soundBtn').textContent = soundOn ? '🔔 Sound on' : '🔕 Turn on sound';
  if (soundOn) chime();
};

function chime() {
  if (!soundOn || !audioCtx) return;
  const t0 = audioCtx.currentTime;
  [880, 1320].forEach((f, i) => {
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = f;
    o.type = 'sine';
    g.gain.setValueAtTime(0.0001, t0 + i * 0.18);
    g.gain.exponentialRampToValueAtTime(0.3, t0 + i * 0.18 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.18 + 0.5);
    o.connect(g).connect(audioCtx.destination);
    o.start(t0 + i * 0.18);
    o.stop(t0 + i * 0.18 + 0.55);
  });
}

// ---------- report ----------
function waitText(ts) {
  if (ts === null) return 'Waiting';
  const mins = Math.floor(Math.max(0, Date.now() - ts) / 60000);
  return mins < 1 ? 'Waiting under 1 min' : `Waiting ${mins} min`;
}

function deviceText(n) {
  const count = Number(n) || 0;
  return `${count} ${count === 1 ? 'device' : 'devices'}`;
}

async function loadReport() {
  if (!boothId || !key || reportBusy) return;
  reportBusy = true;
  const started = Date.now();
  try {
    const r = await api(`/api/booths/${encodeURIComponent(boothId)}/report`);
    const next = new Map();
    const open = Array.isArray(r.open) ? r.open : [];
    open.forEach((item, i) => {
      const q = normRequest(item, i + 1);
      if (q && !doneIds.has(q.id)) next.set(q.id, q);
    });
    // A request can arrive over the socket while this report was in flight.
    for (const q of queue.values()) {
      if (!next.has(q.id) && !doneIds.has(q.id) && q.receivedAt >= started) next.set(q.id, q);
    }
    queue = next;

    report = {
      visits: Number.isFinite(Number(r.visits)) ? Number(r.visits) : null,
      uniqueDevices: Number.isFinite(Number(r.uniqueDevices)) ? Number(r.uniqueDevices) : null,
      fromTalks: Array.isArray(r.fromTalks) ? r.fromTalks : [],
      topics: Array.isArray(r.topics) ? r.topics : [],
    };
    unavailable = false;
    clearTransientWarn();

    if (!reportLoaded) {
      for (const q of queue.values()) knownIds.add(q.id);
      reportLoaded = true;
    } else {
      for (const q of queue.values()) {
        if (!knownIds.has(q.id)) { knownIds.add(q.id); chime(); }
      }
    }
    renderAll();
  } catch (e) {
    if (e.notFound) {
      unavailable = true;
      warn('Booth service not available.', 'unavailable');
      renderAll();
    } else if (!e.unauthorized) {
      warn('Booth service did not answer. Retrying…');
    }
  } finally {
    reportBusy = false;
  }
}

// ---------- render ----------
function renderQueue() {
  const list = [...queue.values()].sort((a, b) => {
    if (a.ts === null && b.ts !== null) return 1;
    if (b.ts === null && a.ts !== null) return -1;
    return (a.ts ?? 0) - (b.ts ?? 0) || a.position - b.position;
  });
  const sig = `${unavailable ? 1 : 0}|${boothId ? 1 : 0}|${key ? 1 : 0}|` + list.map((q) => q.id).join('|');
  if (sig === lastQueueSig) return;
  lastQueueSig = sig;

  const box = $('queue');
  if (!list.length) {
    const text = !boothId ? 'No booth id in this address.'
      : !key ? 'Staff key needed. Add ?key=YOUR_TECH_KEY.'
      : unavailable ? 'Booth service not available.'
      : 'No one waiting.';
    box.replaceChildren(Object.assign(document.createElement('p'), { className: 'booth-empty', textContent: text }));
    $('cOpen').textContent = '0';
    $('qCount').textContent = '';
    return;
  }

  box.replaceChildren(...list.map((q, i) => {
    const el = document.createElement('article');
    el.className = 'request';
    el.dataset.id = q.id;

    const head = document.createElement('div');
    head.className = 'req-head';
    head.append(
      Object.assign(document.createElement('span'), {
        className: 'req-kind',
        textContent: KIND_WORD[q.kind] || q.kind.replace(/_/g, ' ') || 'Request',
      }),
      Object.assign(document.createElement('span'), {
        className: 'req-pos',
        textContent: `#${i + 1} in line`,
      }),
    );

    const wait = Object.assign(document.createElement('p'), {
      className: 'req-wait',
      textContent: waitText(q.ts),
    });
    if (q.ts !== null) wait.dataset.since = String(q.ts);

    const done = Object.assign(document.createElement('button'), {
      type: 'button',
      className: 'act done',
      textContent: 'Done',
    });
    done.onclick = () => finish(q, done);

    el.append(head, wait, done);
    return el;
  }));
  $('cOpen').textContent = String(list.length);
  $('qCount').textContent = `${list.length} open`;
}

function renderRanked(el, rows, field, emptyText) {
  const items = rows
    .filter((row) => row && (row[field] || row.talkId))
    .slice()
    .sort((a, b) => (Number(b.devices) || 0) - (Number(a.devices) || 0));
  if (!items.length) {
    el.replaceChildren(Object.assign(document.createElement('li'), { className: 'muted', textContent: emptyText }));
    return;
  }
  el.replaceChildren(...items.map((row) => {
    const li = document.createElement('li');
    const text = Object.assign(document.createElement('span'), {
      className: 'rank-text',
      textContent: String(row[field] || row.talkId),
    });
    const count = Object.assign(document.createElement('span'), {
      className: 'rank-count',
      textContent: deviceText(row.devices),
    });
    li.append(text, count);
    return li;
  }));
}

function renderAll() {
  $('cVisits').textContent = report.visits === null ? '—' : String(report.visits);
  $('cDevices').textContent = report.uniqueDevices === null ? '—' : String(report.uniqueDevices);
  renderQueue();
  renderRanked($('fromTalks'), report.fromTalks, 'title', 'No talks yet.');
  renderRanked($('topics'), report.topics, 'text', 'Nothing heard yet.');
}

// ---------- Done ----------
async function finish(q, btn) {
  btn.disabled = true;
  try {
    await api(`/api/booths/${encodeURIComponent(boothId)}/requests/${encodeURIComponent(q.id)}/done`, { by: byName }, 'POST');
    queue.delete(q.id);
    doneIds.add(q.id);
    renderAll();
  } catch (e) {
    btn.disabled = false;
    if (e.notFound) {
      unavailable = true;
      warn('Booth service not available.', 'unavailable');
      renderAll();
    }
  }
}

// ---------- live socket ----------
function start() {
  $('boothName').textContent = boothId || 'Booth';
  document.title = boothId ? `Pulse · ${boothId} booth staff` : 'Pulse · Booth staff';

  if (!boothId) {
    warn('This page needs a booth id. Open /booth/gitar?key=YOUR_TECH_KEY', 'missing');
    setConn('unauthorized', 'No booth id');
    renderAll();
    return;
  }
  if (!key) {
    warn('No staff key in the URL. Open /booth/' + boothId + '?key=YOUR_TECH_KEY', 'missing');
    setConn('unauthorized', 'No key');
    renderAll();
    return;
  }

  connectRoom({
    room: boothId,
    role: 'tech',
    key,
    onStatus: (s) => {
      setConn(s);
      if (s === 'unauthorized') warn('The server rejected the staff key.', 'unauthorized');
      if (s === 'live') loadReport();
    },
    onMessage: (m) => {
      switch (m.t) {
        case 'booth_request': {
          const q = normRequest(m, queue.size + 1);
          if (!q) return;
          if (!knownIds.has(q.id)) { knownIds.add(q.id); chime(); }
          doneIds.delete(q.id);
          queue.set(q.id, q);
          renderAll();
          break;
        }
        case 'booth_request_done': {
          if (m.requestId === undefined || m.requestId === null) return;
          const id = String(m.requestId);
          queue.delete(id);
          doneIds.add(id);
          renderAll();
          break;
        }
        default:
          break;
      }
    },
  });

  setInterval(loadReport, 10000);
  setInterval(() => {
    for (const el of document.querySelectorAll('.req-wait[data-since]')) {
      el.textContent = waitText(Number(el.dataset.since));
    }
  }, 10000);
  loadReport();
}

renderAll();
start();
