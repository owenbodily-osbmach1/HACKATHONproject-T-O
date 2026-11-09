// Transcript + post-talk report for /t/:talkId and room archive for /room/:room.
// Public page: no keys, no microphone (CONTRACT.md auth table and mic lock).
import { connectRoom } from '/lib/socket.js';

const $ = (id) => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';

function decodePart(value) {
  if (!value) return null;
  try { return decodeURIComponent(value); } catch { return value; }
}

const path = location.pathname;
const talkId = decodePart(/^\/t\/([^/?#]+)/.exec(path)?.[1]);
const roomId = decodePart(/^\/room\/([^/?#]+)/.exec(path)?.[1]);

const state = {
  talkId,
  talk: null,
  report: null,
  reportOk: false,
  startMs: null,
  lines: new Map(), // seq -> {seq, text, ts}
  order: [], // sorted rows
  lineEls: new Map(), // seq -> element
  query: '',
  forceSeq: null,
  searchSeq: 0,
  searchTimer: null,
  searchAbort: null,
  conn: null,
};

const rawText = new WeakMap();
const CONN_WORDS = {
  live: 'Live',
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
  unauthorized: 'Not allowed',
};

// ---------- formatting ----------
function parseMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(n) ? n : null;
}

function fmtClock(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n)) return '';
  const d = new Date(n);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function fmtDay(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n)) return '';
  const d = new Date(n);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function setText(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

function showError(text) {
  const el = $('loadError');
  el.textContent = text;
  el.hidden = !text;
}

// ---------- HTTP ----------
async function getJson(url, opts) {
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function attempt(url, opts) {
  try { return { data: await getJson(url, opts) }; }
  catch (error) { return { error }; }
}

// ---------- header + connection state ----------
function setConn(status) {
  const el = $('conn');
  el.hidden = false;
  el.dataset.status = status;
  el.querySelector('.conn-word').textContent = CONN_WORDS[status] || status;
}

function talkIsLive(talk) {
  return Boolean(talk && talk.room != null && talk.end === null);
}

function renderHeader(talk) {
  const title = talk?.title || (state.talkId ? `Talk ${state.talkId}` : 'Talk transcript');
  const room = talk?.room == null ? '' : String(talk.room);
  $('roomBadge').textContent = room ? `Room ${room}` : 'Talk report';
  $('pageTitle').textContent = title;
  $('pageSpeaker').textContent = talk?.speaker || '';
  document.title = `${title} · Pulse transcript`;

  const parts = [];
  if (talkIsLive(talk)) parts.push('Live now');
  else if (talk?.end != null) parts.push('Ended');
  const start = parseMs(talk?.start);
  const end = parseMs(talk?.end);
  if (start) parts.push(`${talkIsLive(talk) ? 'Started' : 'Ran'} ${fmtDay(start)}`);
  if (start && end && end >= start) {
    const mins = Math.max(1, Math.round((end - start) / 60000));
    parts.push(`${mins} min`);
  }
  if (!talk) parts.push(`Talk ${state.talkId}`);
  setText('talkMeta', parts.join(' · '));
}

// Find talk metadata from the public room list; archived talks are in room archives.
async function findTalk(id) {
  const rooms = await getJson('/api/rooms').catch(() => []);
  if (!Array.isArray(rooms)) return null;

  const ids = rooms.map((r) => (r && r.room != null ? String(r.room) : null)).filter(Boolean);
  const current = rooms.find((r) => r && String(r.talkId) === String(id));
  if (current && current.room != null) {
    const list = await getJson(`/api/rooms/${encodeURIComponent(current.room)}/talks`).catch(() => null);
    const hit = Array.isArray(list) ? list.find((t) => t && String(t.talkId) === String(id)) : null;
    if (hit) return hit;
    return {
      talkId: id,
      room: String(current.room),
      title: current.title || '',
      speaker: '',
      start: null,
      end: null,
    };
  }

  const lists = await Promise.all(ids.map((room) => (
    getJson(`/api/rooms/${encodeURIComponent(room)}/talks`).catch(() => null)
  )));
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    const hit = list.find((t) => t && String(t.talkId) === String(id));
    if (hit) return hit;
  }
  return null;
}

// Optional report fields are tolerated; the required report shape is
// { transcript[], signalsByMinute[], questions[] } (CONTRACT.md).
function talkFromReport(report) {
  if (!report || (report.room == null && !report.title)) return null;
  return {
    talkId: state.talkId,
    room: report.room == null ? null : String(report.room),
    title: report.title || '',
    speaker: report.speaker || '',
    start: report.start ?? null,
    end: report.end === undefined ? undefined : report.end,
  };
}

function peakListeners(report) {
  if (!report) return null;
  const candidates = [
    report.peakListeners,
    report.peak_listeners,
    report.summary?.peakListeners,
    report.summary?.peak_listeners,
  ];
  for (const value of candidates) {
    if (value === null || value === undefined || value === '') continue;
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

// ---------- transcript ----------
function normalizeRow(row) {
  if (!row || typeof row.text !== 'string') return null;
  const seq = Number(row.seq);
  if (!Number.isFinite(seq)) return null;
  const ts = Number(row.ts);
  if (row.talkId != null && String(row.talkId) !== String(state.talkId)) return null;
  return {
    seq,
    text: row.text,
    ts: Number.isFinite(ts) ? ts : null,
  };
}

function makeLine(row) {
  const p = document.createElement('p');
  p.className = 'tr-line';
  p.id = `line-${row.seq}`;
  p.tabIndex = -1;
  p.dataset.seq = String(row.seq);

  const ts = document.createElement('span');
  ts.className = 'tr-ts';
  ts.textContent = fmtClock(row.ts);

  const text = document.createElement('span');
  text.className = 'tr-text';
  text.textContent = row.text;
  rawText.set(text, row.text);

  p.append(ts, text);
  state.lineEls.set(row.seq, p);
  return p;
}

function loadTranscript(rows) {
  state.lines.clear();
  state.order = [];
  state.lineEls.clear();
  for (const raw of rows) {
    const row = normalizeRow(raw);
    if (!row || state.lines.has(row.seq)) continue;
    state.lines.set(row.seq, row);
  }
  state.order = [...state.lines.values()].sort((a, b) => a.seq - b.seq);
  const box = $('transcript');
  const frag = document.createDocumentFragment();
  for (const row of state.order) frag.append(makeLine(row));
  box.replaceChildren(frag);
  ensureStart();
  applyFilter();
}

function ensureStart() {
  if (Number.isFinite(state.startMs)) return;
  const first = state.order.find((row) => row.ts != null);
  if (first) state.startMs = first.ts;
}

function minuteOf(ts) {
  const start = state.startMs;
  if (!Number.isFinite(ts) || !Number.isFinite(start)) return null;
  return Math.max(0, Math.floor((ts - start) / 60000));
}

function maxTranscriptMinute() {
  let max = -1;
  for (const row of state.order) {
    const minute = minuteOf(row.ts);
    if (minute != null && minute > max) max = minute;
  }
  return max;
}

function restoreLine(textEl) {
  if (!textEl.dataset.hl) return;
  textEl.textContent = rawText.get(textEl) || '';
  delete textEl.dataset.hl;
}

function paintHighlight(textEl, query) {
  const raw = rawText.get(textEl) || '';
  if (!query) {
    restoreLine(textEl);
    return;
  }
  if (textEl.dataset.hl === query) return;
  const lower = raw.toLowerCase();
  const needle = query.toLowerCase();
  let at = lower.indexOf(needle);
  if (at < 0) {
    restoreLine(textEl);
    return;
  }

  const frag = document.createDocumentFragment();
  let pos = 0;
  while (at >= 0) {
    if (at > pos) frag.append(document.createTextNode(raw.slice(pos, at)));
    const mark = document.createElement('mark');
    mark.textContent = raw.slice(at, at + needle.length);
    frag.append(mark);
    pos = at + needle.length;
    at = lower.indexOf(needle, pos);
  }
  if (pos < raw.length) frag.append(document.createTextNode(raw.slice(pos)));
  textEl.replaceChildren(frag);
  textEl.dataset.hl = query;
}

function updateTranscriptMessage(visible) {
  const total = state.order.length;
  const q = state.query;
  setText('trCount', q ? `${visible} of ${total} caption lines match “${q}”` : `${total} caption lines`);
  const empty = $('trEmpty');
  let message = '';
  if (!total) message = 'No captions were recorded for this talk.';
  else if (q && !visible) message = `No caption lines match “${q}”.`;
  empty.textContent = message;
  empty.hidden = !message;
}

function applyFilter() {
  const q = state.query;
  const lower = q.toLowerCase();
  let visible = 0;

  for (const row of state.order) {
    const el = state.lineEls.get(row.seq);
    if (!el) continue;
    const match = !q || row.text.toLowerCase().includes(lower) || row.seq === state.forceSeq;
    el.hidden = !match;
    if (match) visible++;
    const textEl = el.querySelector('.tr-text');
    if (q && match) paintHighlight(textEl, q);
    else restoreLine(textEl);
  }

  updateTranscriptMessage(visible);
}

function insertSorted(row) {
  let lo = 0;
  let hi = state.order.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (state.order[mid].seq < row.seq) lo = mid + 1;
    else hi = mid;
  }
  state.order.splice(lo, 0, row);
  return lo;
}

function addCaptionRows(rows) {
  let changed = false;
  const box = $('transcript');
  for (const raw of rows) {
    const row = normalizeRow(raw);
    if (!row || state.lines.has(row.seq)) continue;
    state.lines.set(row.seq, row);
    const index = insertSorted(row);
    const next = state.order[index + 1];
    const nextEl = next ? state.lineEls.get(next.seq) : null;
    const el = makeLine(row);
    box.insertBefore(el, nextEl || null);
    const q = state.query;
    const match = !q || row.text.toLowerCase().includes(q.toLowerCase());
    el.hidden = !match;
    if (q && match) paintHighlight(el.querySelector('.tr-text'), q);
    changed = true;
  }
  if (changed) {
    ensureStart();
    if (state.query || state.forceSeq != null) applyFilter();
    else updateTranscriptMessage(state.order.length);
    renderStats();
  }
}

// ---------- search ----------
function clearHits() {
  $('hits').hidden = true;
  $('hitList').replaceChildren();
}

function setSearchNote(text) {
  setText('searchNote', text);
}

function renderHits(hits) {
  const list = $('hitList');
  list.replaceChildren();
  let shown = 0;
  for (const hit of hits) {
    if (!hit || typeof hit.text !== 'string') continue;
    if (hit.talkId != null && String(hit.talkId) !== String(state.talkId)) continue;
    const seq = Number(hit.seq);
    if (!Number.isFinite(seq)) continue;

    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'hit';

    const time = document.createElement('span');
    time.className = 'hit-time';
    time.textContent = fmtClock(hit.ts) || 'Caption';

    const text = document.createElement('span');
    text.className = 'hit-text';
    text.textContent = hit.text;
    if (state.query) paintHighlight(text, state.query);

    btn.append(time, text);
    btn.addEventListener('click', () => jumpToSeq(seq));
    li.append(btn);
    list.append(li);
    shown++;
  }
  $('hits').hidden = shown === 0;
  return shown;
}

async function runServerSearch() {
  const q = state.query;
  if (!q) return;
  state.searchAbort?.abort();
  const ctrl = new AbortController();
  state.searchAbort = ctrl;
  const token = ++state.searchSeq;

  try {
    const data = await getJson(
      `/api/search?q=${encodeURIComponent(q)}&talkId=${encodeURIComponent(state.talkId)}`,
      { signal: ctrl.signal },
    );
    if (token !== state.searchSeq || state.query !== q) return;
    const hits = Array.isArray(data) ? data : [];
    if (hits.length && renderHits(hits)) {
      setSearchNote(`${hits.length} search ${hits.length === 1 ? 'hit' : 'hits'} — select one to jump to its caption.`);
    } else {
      clearHits();
      setSearchNote('No search-service hits. Filtering the transcript instead.');
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    if (token !== state.searchSeq || state.query !== q) return;
    clearHits();
    setSearchNote('Search service unavailable. Filtering the transcript instead.');
  }
}

function applyQuery(raw, { immediate = false } = {}) {
  state.query = raw.trim();
  state.forceSeq = null;
  clearTimeout(state.searchTimer);
  applyFilter();

  if (!state.query) {
    state.searchAbort?.abort();
    clearHits();
    setSearchNote('');
    return;
  }
  if (state.query.length < 2) {
    clearHits();
    setSearchNote('Keep typing for full-text search. The transcript is filtered as you type.');
    return;
  }
  if (immediate) {
    runServerSearch();
    return;
  }
  state.searchTimer = setTimeout(runServerSearch, 300);
}

function jumpToSeq(seq) {
  const target = state.lineEls.get(Number(seq));
  if (!target) {
    setSearchNote('That caption line is not in the loaded transcript.');
    return;
  }
  state.forceSeq = Number(seq);
  applyFilter();
  target.hidden = false;
  target.classList.add('tr-flash');
  target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  try { target.focus({ preventScroll: true }); } catch { target.focus(); }
  setTimeout(() => target.classList.remove('tr-flash'), 4000);
  setSearchNote(`Showing caption ${seq}${target.querySelector('.tr-ts')?.textContent ? ` at ${target.querySelector('.tr-ts').textContent}` : ''}.`);
}

function lineForMinute(minute) {
  let after = null;
  let last = null;
  for (const row of state.order) {
    last = row;
    const m = minuteOf(row.ts);
    if (m === minute) return row;
    if (m != null && m > minute && !after) after = row;
  }
  return after || last;
}

function jumpToMinute(minute) {
  if (state.query) {
    $('q').value = '';
    applyQuery('');
  }
  const row = lineForMinute(minute);
  if (!row) {
    setText('chartNote', `No captions are loaded for minute ${minute}.`);
    return;
  }
  jumpToSeq(row.seq);
  setText('chartNote', `Minute ${minute}: showing its captions in the transcript.`);
}

// ---------- summary + chart ----------
function stat(value, label, sub) {
  const box = document.createElement('div');
  box.className = 'stat';
  const num = document.createElement('span');
  num.className = 'stat-num';
  num.textContent = String(value);
  const word = document.createElement('span');
  word.className = 'stat-label';
  word.textContent = label;
  box.append(num, word);
  if (sub) {
    const detail = document.createElement('span');
    detail.className = 'stat-sub';
    detail.textContent = sub;
    box.append(detail);
  }
  return box;
}

function signalRows() {
  return Array.isArray(state.report?.signalsByMinute) ? state.report.signalsByMinute : [];
}

function signalTotal() {
  return signalRows().reduce((sum, row) => sum + (Number(row?.count) || 0), 0);
}

function renderStats() {
  const box = $('stats');
  box.replaceChildren();
  box.append(stat(state.order.length, 'Captions', 'caption lines'));

  if (state.reportOk) {
    const peak = peakListeners(state.report);
    if (peak != null) box.append(stat(peak, 'Peak listeners', 'attendees'));
    box.append(stat(signalTotal(), 'Signals', "can't hear + can't see"));
    const questions = Array.isArray(state.report?.questions) ? state.report.questions : [];
    box.append(stat(questions.length, 'Questions', 'asked'));
  }
}

function svgNode(name, attrs = {}) {
  const node = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

function renderChart() {
  const box = $('chart');
  box.replaceChildren();
  const note = $('chartNote');
  note.textContent = '';

  const perMinute = new Map();
  for (const row of signalRows()) {
    const minute = Number(row?.minute);
    if (!Number.isFinite(minute) || minute < 0) continue;
    if (row.type !== 'cant_hear' && row.type !== 'cant_see') continue;
    const count = Math.max(0, Number(row.count) || 0);
    const entry = perMinute.get(minute) || { cant_hear: 0, cant_see: 0 };
    entry[row.type] = count;
    perMinute.set(minute, entry);
  }

  const transcriptMax = maxTranscriptMinute();
  const signalMax = perMinute.size ? Math.max(...perMinute.keys()) : -1;
  if (!perMinute.size && transcriptMax < 0) {
    note.textContent = 'No timeline data was recorded for this talk.';
    return;
  }

  const maxMinute = Math.max(0, transcriptMax, signalMax);
  let yMax = 1;
  for (const entry of perMinute.values()) yMax = Math.max(yMax, entry.cant_hear, entry.cant_see);

  const width = Math.max(260, 48 + (maxMinute + 1) * 36);
  const height = 200;
  const pad = { l: 34, r: 14, t: 18, b: 42 };
  const plotW = width - pad.l - pad.r;
  const plotH = height - pad.t - pad.b;
  const step = plotW / (maxMinute + 1);
  const x = (minute) => pad.l + step * (minute + 0.5);
  const y = (value) => pad.t + plotH - (value / yMax) * plotH;

  const svg = svgNode('svg', {
    width,
    height,
    viewBox: `0 0 ${width} ${height}`,
    role: 'group',
    'aria-label': `Signals by minute for ${maxMinute + 1} minutes. Tab through the minutes to jump to their captions.`,
  });

  for (const value of [...new Set([0, yMax])]) {
    const yy = y(value);
    svg.append(svgNode('line', {
      x1: pad.l, y1: yy, x2: pad.l + plotW, y2: yy, class: 'rp-grid',
    }));
    const label = svgNode('text', {
      x: pad.l - 6, y: yy + 4, class: 'rp-axis', 'text-anchor': 'end',
    });
    label.textContent = String(value);
    svg.append(label);
  }

  const labelEvery = Math.max(1, Math.ceil((maxMinute + 1) / 8));
  for (let m = 0; m <= maxMinute; m += labelEvery) {
    const label = svgNode('text', {
      x: x(m), y: height - pad.b + 17, class: 'rp-axis', 'text-anchor': 'middle',
    });
    label.textContent = `${m}m`;
    svg.append(label);
  }

  const values = Array.from({ length: maxMinute + 1 }, (_, minute) => (
    perMinute.get(minute) || { cant_hear: 0, cant_see: 0 }
  ));

  svg.append(svgNode('polyline', {
    points: values.map((value, minute) => `${x(minute)},${y(value.cant_hear)}`).join(' '),
    class: 'rp-series hear',
  }));
  svg.append(svgNode('polyline', {
    points: values.map((value, minute) => `${x(minute)},${y(value.cant_see)}`).join(' '),
    class: 'rp-series see',
  }));

  values.forEach((value, minute) => {
    const cx = x(minute);
    const hearY = y(value.cant_hear);
    svg.append(svgNode('circle', { cx, cy: hearY, r: 3.6, class: 'rp-dot hear' }));
    const seeY = y(value.cant_see);
    svg.append(svgNode('rect', {
      x: cx - 3.4,
      y: seeY - 3.4,
      width: 6.8,
      height: 6.8,
      class: 'rp-dot see',
      transform: `rotate(45 ${cx} ${seeY})`,
    }));
  });

  values.forEach((value, minute) => {
    const band = svgNode('g', {
      class: 'rp-band',
      role: 'button',
      tabindex: '0',
      'aria-label': `Minute ${minute}: ${value.cant_hear} cannot hear, ${value.cant_see} cannot see. Jump to captions.`,
    });
    band.append(svgNode('rect', {
      x: pad.l + step * minute,
      y: pad.t,
      width: step,
      height: plotH,
      class: 'rp-band-hit',
    }));
    band.addEventListener('click', () => jumpToMinute(minute));
    band.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      jumpToMinute(minute);
    });
    svg.append(band);
  });

  box.append(svg);
  if (!perMinute.size) {
    note.textContent = 'No signals are recorded in this report; the timeline shows the talk minutes.';
  }
}

// ---------- question groups ----------
function groupQuestions(questions) {
  const groups = new Map();
  for (const q of questions) {
    if (!q || typeof q.text !== 'string') continue;
    const key = q.groupId != null ? String(q.groupId) : `q-${q.qid ?? q.text}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, text: q.text, count: 0, answered: 0, firstTs: parseMs(q.ts) ?? Infinity };
      groups.set(key, group);
    }
    group.count++;
    if (q.answered) group.answered++;
    if (!group.text && q.text) group.text = q.text;
    const ts = parseMs(q.ts);
    if (ts != null && ts < group.firstTs) group.firstTs = ts;
  }
  return [...groups.values()]
    .sort((a, b) => b.count - a.count || a.firstTs - b.firstTs)
    .slice(0, 10);
}

function renderQuestions() {
  const list = $('qList');
  list.replaceChildren();
  const questions = Array.isArray(state.report?.questions) ? state.report.questions : [];
  const groups = groupQuestions(questions);
  $('qEmpty').hidden = groups.length > 0;

  for (const group of groups) {
    const li = document.createElement('li');
    li.className = 'report-q';

    const count = document.createElement('span');
    count.className = 'q-count';
    count.textContent = `${group.count} ${group.count === 1 ? 'question' : 'questions'}`;

    const stateEl = document.createElement('span');
    stateEl.className = 'q-state';
    if (group.answered >= group.count) {
      stateEl.dataset.state = 'answered';
      stateEl.textContent = 'Answered';
    } else if (group.answered > 0) {
      stateEl.dataset.state = 'partial';
      stateEl.textContent = 'Partly answered';
    } else {
      stateEl.dataset.state = 'open';
      stateEl.textContent = 'Open';
    }

    const text = document.createElement('p');
    text.className = 'q-text';
    text.textContent = group.text;

    li.append(count, stateEl, text);
    list.append(li);
  }
}

// ---------- talk page ----------
async function initTalk() {
  $('talkView').hidden = false;
  const download = $('download');
  download.href = `/api/talks/${encodeURIComponent(state.talkId)}/transcript?format=txt`;
  download.setAttribute('download', `pulse-transcript-${state.talkId}.txt`);

  const [transcript, report, meta] = await Promise.all([
    attempt(`/api/talks/${encodeURIComponent(state.talkId)}/transcript`),
    attempt(`/api/report/${encodeURIComponent(state.talkId)}`),
    findTalk(state.talkId).catch(() => null),
  ]);

  const reportData = report.data && typeof report.data === 'object' ? report.data : null;
  const talk = meta || talkFromReport(reportData);
  state.talk = talk;
  state.report = reportData;
  state.reportOk = Boolean(reportData);
  state.startMs = parseMs(talk?.start);
  renderHeader(talk);

  const rows = Array.isArray(transcript.data)
    ? transcript.data
    : Array.isArray(reportData?.transcript) ? reportData.transcript : [];
  loadTranscript(rows);

  $('chartPanel').hidden = !state.reportOk;
  $('questionsPanel').hidden = !state.reportOk;
  renderStats();
  if (state.reportOk) {
    renderQuestions();
    renderChart();
  }

  if (!Array.isArray(transcript.data) && !Array.isArray(reportData?.transcript)) {
    showError('Could not load this talk. The transcript and report were both unavailable.');
  } else if (!state.reportOk) {
    setText('reportNote', 'Report details are unavailable right now. Showing the transcript only.');
  } else if (transcript.error && Array.isArray(reportData?.transcript)) {
    setText('reportNote', "The live transcript feed was unavailable, so this is the report's copy.");
  }

  const form = $('searchForm');
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    applyQuery($('q').value, { immediate: true });
  });
  $('q').addEventListener('input', () => applyQuery($('q').value));

  if (talkIsLive(talk)) {
    $('conn').hidden = false;
    setConn('connecting');
    state.conn = connectRoom({
      room: String(talk.room),
      role: 'attendee',
      onStatus: setConn,
      onMessage(msg) {
        if (msg.t === 'caption') addCaptionRows([msg]);
        else if (msg.t === 'caption_backlog' && Array.isArray(msg.lines)) addCaptionRows(msg.lines);
      },
    });
  }

  $('loading').hidden = true;
}

// ---------- room archive ----------
function renderArchive(talks) {
  const list = $('talkList');
  list.replaceChildren();
  const sorted = talks
    .filter((talk) => talk && talk.talkId)
    .sort((a, b) => (parseMs(b.start) || 0) - (parseMs(a.start) || 0));

  $('roomEmpty').hidden = sorted.length > 0;

  for (const talk of sorted) {
    const li = document.createElement('li');
    const link = document.createElement('a');
    link.className = 'archive-link';
    link.href = `/t/${encodeURIComponent(talk.talkId)}`;

    const title = document.createElement('span');
    title.className = 'archive-title';
    title.textContent = talk.title || `Talk ${talk.talkId}`;

    const meta = document.createElement('span');
    meta.className = 'archive-meta';

    const status = document.createElement('span');
    const live = talkIsLive(talk);
    status.className = `archive-state${live ? ' live' : ''}`;
    status.textContent = live ? 'Live' : 'Ended';
    meta.append(status);

    if (talk.speaker) {
      const speaker = document.createElement('span');
      speaker.textContent = talk.speaker;
      meta.append(speaker);
    }
    const start = parseMs(talk.start);
    if (start) {
      const when = document.createElement('span');
      when.textContent = fmtDay(start);
      meta.append(when);
    }

    link.append(title, meta);
    li.append(link);
    list.append(li);
  }
}

async function initRoom() {
  $('roomView').hidden = false;
  $('pageTitle').textContent = `Room ${roomId}`;
  $('roomBadge').textContent = 'Room archive';
  document.title = `Room ${roomId} · Pulse talks`;
  $('liveRoomLink').href = `/r/${encodeURIComponent(roomId)}`;
  setText('talkMeta', 'Talks recorded in this room');

  try {
    const talks = await getJson(`/api/rooms/${encodeURIComponent(roomId)}/talks`);
    if (!Array.isArray(talks)) throw new Error('Unexpected response');
    renderArchive(talks);
  } catch {
    const error = $('roomError');
    error.textContent = 'Could not load talks for this room. Reload to try again.';
    error.hidden = false;
  } finally {
    $('loading').hidden = true;
  }
}

// ---------- start ----------
if (talkId) {
  initTalk().catch((err) => {
    showError(`Could not load this talk: ${err.message || 'unknown error'}.`);
    $('loading').hidden = true;
  });
} else if (roomId) {
  initRoom().catch(() => {
    $('loading').hidden = true;
  });
} else {
  showError('This page needs a talk or room link.');
  $('loading').hidden = true;
}
