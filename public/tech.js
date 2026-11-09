// AV technician console /tech?key=TECH_KEY&rooms=151[,255,...]
// Main screen: one block per problem, problems on top, one button each.
// Right side: the selected room's details (mic, captions, switches, broadcast, questions).
import { connectRoom } from '/lib/socket.js';
import { store } from '/lib/store.js';
import { createPlayer } from '/lib/player.js';

// Preview mode for design work: /tech.html?mock=1&rooms=151,255 fakes the server (see public/dev/README.md).
if (new URLSearchParams(location.search).has('mock')) await import('/dev/mock.js');

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const key = params.get('key') || '';
const roomList = (params.get('rooms') || params.get('room') || '151').split(',').map((r) => r.trim()).filter(Boolean);
// Rooms the server knows about (GET /api/rooms) are added on their own, so the tech can jump to any
// room, including the seeded demo room. ?discover=0 keeps only the rooms in the URL.
const DISCOVER = params.get('discover') !== '0';

const TYPE_WORD = { cant_hear: 'SPEAK UP', cant_see: "CAN'T SEE SLIDES", room_full: 'ROOM FULL' };
const ACTIVE = new Set(['open', 'reopened', 'claimed']);
const RED = new Set(['open', 'reopened']);

const rooms = new Map(); // room -> {status, talk, captions[], settings, groups, conn}
const tickets = new Map(); // id -> ticket
const questionState = new Map(); // qid -> {pinned, hidden, answered}
// #room=255 in the URL (kept up to date by select()) reopens the console on that room.
const wanted = decodeURIComponent(location.hash.match(/room=([^&]+)/)?.[1] || '');
if (wanted && !roomList.includes(wanted)) roomList.push(wanted);
let selected = wanted || roomList[0];

function addRoom(r) {
  if (rooms.has(r)) return false;
  rooms.set(r, { status: null, captions: [], settings: { captions: true, listen: true, slides: true }, groups: [], conn: 'connecting', talk: null, simulated: false });
  return true;
}
for (const r of roomList) addRoom(r);

// ---------- name, key ----------
$('techName').value = store.get('pulse.techName', '');
$('techName').addEventListener('change', () => store.set('pulse.techName', $('techName').value.trim()));
const techName = () => $('techName').value.trim() || 'Tech';

function warn(text) { $('warn').textContent = text; $('warn').hidden = !text; }
if (!key && !params.has('mock')) warn('No key in the URL. Open /tech?key=YOUR_TECH_KEY&rooms=151');

async function api(path, body, method = 'POST') {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', 'x-pulse-key': key },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) { warn('The server rejected the tech key.'); throw new Error('401'); }
  if (!res.ok) throw new Error(String(res.status));
  return res.json().catch(() => ({}));
}

// ---------- sound: chime on a new red block, every 30 s until claimed ----------
let audioCtx = null;
let soundOn = false;
$('soundBtn').onclick = () => {
  soundOn = !soundOn;
  if (soundOn && !audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  audioCtx?.resume?.();
  $('soundBtn').setAttribute('aria-pressed', String(soundOn));
  $('soundBtn').textContent = soundOn ? 'Sound on' : 'Sound off · turn on';
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
setInterval(() => {
  if ([...tickets.values()].some((t) => {
    const st = rooms.get(String(t.room)) || {};
    return RED.has(t.status) && !st.simulated && talkStatus(st) === 'live';
  })) chime();
}, 30000);

// ---------- alert limit ----------
fetch('/api/config').then((r) => r.json()).then((c) => {
  if (c?.alertThreshold) {
    const sel = $('limitSel');
    if (![...sel.options].some((o) => o.value === String(c.alertThreshold))) sel.add(new Option(`${c.alertThreshold} votes`, c.alertThreshold));
    sel.value = String(c.alertThreshold);
  }
}).catch(() => {});
$('limitSel').onchange = async () => {
  try { await api('/api/config', { alertThreshold: Number($('limitSel').value) }); } catch { /* warned */ }
};

// ---------- tickets → blocks ----------
// The board itself is rebuilt on every ticket change; only this line is announced.
function announce(text) { $('boardStatus').textContent = text; }

function onTicket(m) {
  const prev = tickets.get(m.id);
  const merged = { ...(prev || {}), ...m };
  if (!prev) merged.firstSeen = Date.now();
  tickets.set(m.id, merged);
  const becameRed = RED.has(m.status) && (!prev || !RED.has(prev.status));
  if (!prev) {
    announce(`Room ${merged.room}: ${TYPE_WORD[merged.type] || 'new'} ticket opened.`);
  } else if (prev.status !== merged.status) {
    const word = merged.status === 'fixed' ? 'fixed' : merged.status === 'dismissed' ? 'dismissed' : merged.status;
    announce(`Room ${merged.room}: ticket ${word}.`);
  }
  render();
  if (becameRed) chime();
}

function ageText(iso) {
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

let pointerOnBoard = false;
let renderPending = false;
document.addEventListener('pointerdown', (e) => { pointerOnBoard = !!e.target.closest('#blocks'); });
document.addEventListener('pointerup', () => {
  if (!pointerOnBoard) return;
  pointerOnBoard = false;
  // Let the click land on the element that was pressed, then catch up.
  if (renderPending) setTimeout(() => { renderPending = false; render(); }, 0);
});
function render() {
  if (pointerOnBoard) { renderPending = true; renderTabs(); return; }
  const active = [...tickets.values()].filter((t) => ACTIVE.has(t.status) && rooms.has(String(t.room)));
  active.sort((a, b) => (Date.parse(a.openedAt) - Date.parse(b.openedAt)) || String(a.id).localeCompare(String(b.id)));

  const blocks = $('blocks');
  blocks.replaceChildren(...active.map(blockEl));
  if (!active.length) {
    const p = document.createElement('p');
    p.className = 'all-clear';
    p.textContent = 'All rooms OK. Nothing to fix.';
    blocks.append(p);
  }

  renderFixed();
  const busyRooms = new Set(active.map((t) => String(t.room)));
  const tiles = [...rooms.keys()].filter((r) => !busyRooms.has(r)).map((r) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ok-tile' + (r === selected ? ' sel' : '');
    const st = rooms.get(r);
    b.innerHTML = '';
    b.append(Object.assign(document.createElement('b'), { textContent: r }), ` ${st.conn === 'live' ? 'OK' : 'offline'}`);
    b.onclick = () => select(r);
    return b;
  });
  $('okTiles').replaceChildren(...tiles);

  renderTabs(active);
  $('cRed').textContent = active.filter((t) => RED.has(t.status)).length;
  $('cAmber').textContent = active.filter((t) => t.status === 'claimed').length;
  $('cGreen').textContent = tiles.length;
  document.title = (active.some((t) => RED.has(t.status)) ? '🔴 ' : '') + 'Pulse · AV tech';
}

// Fixed in the last 3 minutes: who fixed it and what the phones answered to "Better now?".
function renderFixed() {
  const recent = [...tickets.values()]
    .filter((t) => t.status === 'fixed' && t.fixedAt && Date.now() - Date.parse(t.fixedAt) < 180000 && rooms.has(String(t.room)))
    .sort((a, b) => Date.parse(b.fixedAt) - Date.parse(a.fixedAt));
  const ul = $('fixedList');
  ul.hidden = !recent.length;
  ul.replaceChildren(...recent.map((t) => {
    const li = document.createElement('li');
    const answers = t.better || t.stillBad ? `Better ${t.better} · Still bad ${t.stillBad}` : 'Waiting for "Better now?" answers';
    li.textContent = `✓ Room ${t.room} ${TYPE_WORD[t.type] || t.type} fixed${t.fixedBy ? ` by ${t.fixedBy}` : ''} · ${answers}`;
    if (t.stillBad > t.better) li.className = 'worse';
    return li;
  }));
}
setInterval(renderFixed, 15000);

// ---------- room switcher ----------
const STATUS_WORD = { live: 'Live', ended: 'Ended', waiting: 'Not started' };
function talkStatus(st) { return st.talk?.status || (st.talk?.talkId ? 'live' : 'waiting'); }

// Tabs are built once per room and then only their text changes: room_status re-renders them
// every 2 s, and replacing the buttons would swallow a click that lands mid-update.
const tabEls = new Map(); // room -> {btn, pill, demo, key, title, status, phones, alert}
function tabFor(r) {
  let t = tabEls.get(r);
  if (t) return t;
  const mk = (tag, cls, text = '') => Object.assign(document.createElement(tag), { className: cls, textContent: text });
  t = {
    btn: mk('button', 'room-tab'), pill: mk('span', 'talk-pill'), name: mk('span', 'rt-name', `Room ${r}`),
    demo: mk('span', 'rt-demo', 'DEMO'), key: mk('span', 'rt-key'), title: mk('span', 'rt-title'),
    status: mk('span', 'rt-status'), phones: mk('span', 'rt-phones'), alert: mk('span', 'rt-alert'),
  };
  t.btn.type = 'button';
  t.btn.setAttribute('role', 'tab');
  const top = mk('span', 'rt-top');
  top.append(t.pill, t.name, t.demo, t.key);
  const meta = mk('span', 'rt-meta');
  meta.append(t.status, t.phones, t.alert);
  t.btn.append(top, t.title, meta);
  t.btn.onclick = () => select(r);
  tabEls.set(r, t);
  return t;
}

const roomIds = () => [...rooms.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
function roomWarning(st) {
  const off = ['captions', 'listen', 'slides'].filter((k) => st.settings && st.settings[k] === false);
  if (off.length) return `${off.map((k) => ({ captions: 'CC', listen: 'Listen', slides: 'Slides' }[k])).join(', ')} off`;
  const t = st.tele;
  if (!t || t.talk !== 'live') return '';
  if (t.captions?.state === 'silent' && (t.captions.gapSec ?? 0) >= 60) return `silent ${Math.round(t.captions.gapSec / 60)} min`;
  if (t.mic?.state === 'silent' || (typeof t.mic?.db === 'number' && t.mic.db < -50)) return 'mic quiet';
  return '';
}
function renderTabs(active = [...tickets.values()].filter((t) => ACTIVE.has(t.status))) {
  const ids = roomIds();
  ids.forEach((r, i) => {
    const st = rooms.get(r);
    const t = tabFor(r);
    const status = st.conn === 'live' ? talkStatus(st) : 'offline';
    const alerts = active.filter((x) => String(x.room) === r && RED.has(x.status)).length;
    t.btn.setAttribute('aria-selected', String(r === selected));
    t.pill.dataset.status = status;
    t.demo.hidden = !st.simulated;
    t.key.textContent = i < 9 ? String(i + 1) : '';
    t.key.hidden = i >= 9;
    t.title.textContent = st.talk?.title || 'No talk yet';
    t.status.textContent = STATUS_WORD[status] || 'Offline';
    const s = st.stats;
    t.phones.textContent = s ? `· ${s.here}/${s.capacity} here (${s.capacity ? Math.min(100, Math.round((s.here / s.capacity) * 100)) : 0}%) · ${s.joined} scanned` : '';
    const warnText = roomWarning(st);
    t.alert.textContent = [alerts ? `● ${alerts} to fix` : '', warnText ? `⚠ ${warnText}` : ''].filter(Boolean).join(' · ');
    t.alert.hidden = !alerts && !warnText;
  });
  const bar = $('roomTabs');
  const wantOrder = ids.map((r) => tabEls.get(r).btn);
  if (bar.children.length !== wantOrder.length || wantOrder.some((b, i) => bar.children[i] !== b)) bar.replaceChildren(...wantOrder);
}

// A link or bookmark to …#room=255 switches rooms without a reload.
window.addEventListener('hashchange', () => {
  const r = decodeURIComponent(location.hash.match(/room=([^&]+)/)?.[1] || '');
  if (!r || r === selected) return;
  if (addRoom(r)) connect(r);
  select(r);
});

// 1–9 jump to a room; [ and ] step through them (not while typing).
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input:not([type=checkbox]), textarea, select') || e.ctrlKey || e.metaKey || e.altKey) return;
  const ids = roomIds();
  if (/^[1-9]$/.test(e.key) && ids[Number(e.key) - 1]) select(ids[Number(e.key) - 1]);
  if (e.key === '[' || e.key === ']') {
    const i = ids.indexOf(selected);
    select(ids[(i + (e.key === ']' ? 1 : ids.length - 1)) % ids.length]);
  }
});

function blockEl(t) {
  const red = RED.has(t.status);
  const el = document.createElement('article');
  el.className = `block ${red ? 'red' : 'amber'}` + (String(t.room) === selected ? ' sel' : '');
  el.dataset.id = t.id;

  const band = document.createElement('div');
  band.className = 'band';
  const label = document.createElement('span');
  label.textContent = `${TYPE_WORD[t.type] || t.type}${t.status === 'reopened' ? ' · REOPENED' : ''}${red ? '' : ` · CLAIMED${t.claimedBy ? ` BY ${t.claimedBy.toUpperCase()}` : ''}`}`;
  const age = document.createElement('span');
  age.className = 'age';
  age.dataset.since = t.reopenedAt || t.openedAt; // a reopened ticket is a new complaint: count from then
  age.textContent = ageText(age.dataset.since);
  band.append(label, age);

  const head = document.createElement('div');
  head.className = 'b-head';
  head.append(
    Object.assign(document.createElement('span'), { className: 'b-room', textContent: `Room ${t.room}` }),
    Object.assign(document.createElement('span'), { className: 'b-votes', textContent: `${t.people} ${t.people === 1 ? 'vote' : 'votes'}` }),
  );

  const cause = Object.assign(document.createElement('p'), { className: 'b-cause', textContent: `Likely: ${t.cause || 'unknown'}` });

  const steps = document.createElement('ul');
  steps.className = 'b-steps';
  for (const s of t.steps || []) steps.append(Object.assign(document.createElement('li'), { textContent: s }));

  const row = document.createElement('div');
  row.className = 'b-actions';
  const main = document.createElement('button');
  main.type = 'button';
  main.className = red ? 'act claim' : 'act fixed';
  main.textContent = red ? 'Claim' : 'Mark fixed';
  main.onclick = (e) => { e.stopPropagation(); act(t, red ? 'claim' : 'fixed', main); };
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'ghost small';
  dismiss.textContent = 'Not AV';
  dismiss.onclick = (e) => { e.stopPropagation(); act(t, 'dismiss', dismiss); };
  row.append(main, dismiss);

  // Keyboard users select a room from the card body. Actions stay outside this
  // button role so they keep their own tab stops.
  const open = document.createElement('div');
  open.className = 'b-open';
  open.tabIndex = 0;
  open.setAttribute('role', 'button');
  open.setAttribute('aria-label', `Show room ${t.room} details`);
  open.onclick = () => select(String(t.room));
  open.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      select(String(t.room));
    }
  };
  open.append(band, head, cause, steps);

  el.append(open, row);
  return el;
}

async function act(t, action, btn) {
  btn.disabled = true;
  try {
    const r = await api(`/api/tickets/${encodeURIComponent(t.id)}/${action}`, { by: techName() });
    // The server also broadcasts the new status; apply it now so the button feels instant.
    if (r?.status) onTicket({ ...t, status: r.status });
    // The board was rebuilt and removed the focused button: keep the user's place.
    const card = [...document.querySelectorAll('.block')].find((el) => el.dataset.id === t.id);
    (card?.querySelector('.b-open') || document.querySelector('.block .b-open') || $('dRoom')).focus();
  } catch {
    btn.disabled = false;
  }
}

setInterval(() => {
  for (const el of document.querySelectorAll('.age[data-since]')) el.textContent = ageText(el.dataset.since);
}, 1000);

// ---------- live status panel (room_telemetry every 2 s, for the selected room) ----------
const ago = (ts) => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  return s < 60 ? `${s} s ago` : `${Math.round(s / 60)} min ago`;
};
function teleRow(id, state, text) {
  const li = $(id);
  li.dataset.state = state; // ok | wait | off | bad
  li.querySelector('.v').textContent = text;
}
function renderTele() {
  const st = rooms.get(selected);
  if (!st) return;
  teleRow('tServer', st.conn === 'live' ? 'ok' : 'bad', st.conn === 'live' ? 'Connected' : st.conn === 'unauthorized' ? 'Wrong tech key' : 'Disconnected · reconnecting…');
  const t = st.tele;
  if (!t || st.conn !== 'live') {
    for (const id of ['tMic', 'tCaptions', 'tListen', 'tSlides', 'tPhones']) teleRow(id, 'off', '—');
    renderFill(st);
    return;
  }
  const db = typeof t.mic?.db === 'number' ? ` · ${Math.round(t.mic.db)} dB` : '';
  teleRow('tMic', t.mic.state === 'live' ? (t.mic.db !== null && t.mic.db < -50 ? 'wait' : 'ok') : t.mic.state === 'silent' ? 'wait' : 'off',
    t.mic.state === 'live' ? `Live${db}${t.mic.db !== null && t.mic.db < -50 ? ' · very quiet' : ''}`
      : t.mic.state === 'silent' ? 'Connected, no sound coming in' : t.presenter ? 'Stopped (Go live page open)' : 'Stopped');
  teleRow('tCaptions', t.captions.state === 'live' ? 'ok' : t.captions.state === 'silent' ? 'wait' : 'off',
    t.captions.state === 'live' ? `Live · ${t.captions.lines} lines`
      : t.captions.state === 'silent' ? (t.captions.gapSec === null ? 'Waiting for the first line' : `Silent ${t.captions.gapSec} s`) : 'Stopped');
  teleRow('tListen', t.listen.state === 'live' ? 'ok' : 'off',
    t.listen.state === 'live' ? `Live · ${t.listen.listening} listening` : 'Stopped');
  teleRow('tSlides', t.slides.state === 'live' ? 'ok' : t.slides.state === 'none' ? 'wait' : 'off',
    t.slides.state === 'live' ? `Live · slide ${t.slides.n}${t.slides.lastAt ? ` · changed ${ago(t.slides.lastAt)}` : ''}`
      : t.slides.state === 'none' ? 'No slides shared yet' : 'Stopped');
  const p = t.phones;
  const rc = p.reconnects5m ? ` · ${p.reconnects5m} reconnected (5 min)` : '';
  teleRow('tPhones', p.here > 0 ? 'ok' : 'off', `${p.here} here · ${p.joined} scanned · ${p.listening} listening${rc}`);
  renderFill(st);
}
function renderFill(st) {
  const s = st.stats;
  if (!s) { $('dFill').textContent = '—'; $('dFillBar').style.width = '0%'; return; }
  const pct = s.capacity ? Math.min(100, Math.round((s.here / s.capacity) * 100)) : 0;
  $('dFill').textContent = `${s.here} / ${s.capacity} · ${pct}%`;
  $('dFillBar').style.width = `${pct}%`;
  $('fillRow').dataset.level = pct >= 100 ? 'full' : pct >= 85 ? 'near' : 'ok';
  if (document.activeElement !== $('seatsInput')) $('seatsInput').value = String(s.capacity);
  $('signinRow').hidden = s.signedIn === null || s.signedIn === undefined; // SIGNIN=off
  $('dSignins').textContent = String(s.signedIn ?? '—');
}
// Sign-ins (names, emails) never travel over the socket: the CSV is fetched with the tech key on click.
$('exportSignins').onclick = async () => {
  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(selected)}/signins?format=csv`, { headers: { 'x-pulse-key': key } });
    if (res.status === 401) { warn('The server rejected the tech key.'); return; }
    if (!res.ok) throw new Error(String(res.status));
    const url = URL.createObjectURL(await res.blob());
    const a = Object.assign(document.createElement('a'), { href: url, download: `pulse-room-${selected}-signins.csv` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  } catch { flash($('signinRow'), 'Export failed, try again'); }
};
$('seatsForm').onsubmit = async (e) => {
  e.preventDefault();
  const capacity = Number($('seatsInput').value);
  if (!Number.isInteger(capacity) || capacity < 1) return;
  try {
    await api(`/api/rooms/${encodeURIComponent(selected)}/settings`, { ...rooms.get(selected).settings, capacity });
    $('seatsInput').blur();
    flash($('seatsForm'), `Seats set to ${capacity}`);
  } catch { /* warned */ }
};
setInterval(() => { if (rooms.get(selected)?.tele?.slides?.lastAt) renderTele(); }, 5000); // keep "changed … ago" fresh

// ---------- selected room drawer ----------
function select(room) {
  const wasCardFocus = document.activeElement?.classList.contains('b-open');
  // Listen to podium is bound to one room: stop it rather than play the old room under a new label.
  if (room !== selected && player?.playing) {
    player.stop();
    $('listenPodium').setAttribute('aria-pressed', 'false');
  }
  if (room !== selected) disarmEnd();
  selected = room;
  history.replaceState(null, '', `#room=${encodeURIComponent(room)}`);
  render();
  renderDrawer();
  // render() rebuilt the board; put keyboard users back on the card they selected.
  if (wasCardFocus) {
    const card = [...document.querySelectorAll('.block')].find((el) => String(tickets.get(el.dataset.id)?.room) === room);
    card?.querySelector('.b-open')?.focus({ preventScroll: true });
  }
}

function renderDrawer() {
  const st = rooms.get(selected);
  $('dRoom').textContent = `Room ${selected}`;
  $('dConn').dataset.status = st.conn;
  $('dConn').querySelector('.conn-word').textContent = { live: 'Connected', reconnecting: 'Reconnecting…', connecting: 'Connecting…', unauthorized: 'Wrong key' }[st.conn] || st.conn;
  $('dTalk').textContent = st.talk?.talkId ? `${st.talk.title || 'Untitled talk'}${st.talk.speaker ? ' · ' + st.talk.speaker : ''}` : 'No talk yet';
  const status = talkStatus(st);
  $('dTalkPill').dataset.status = status;
  $('dTalkPill').textContent = STATUS_WORD[status];
  const started = st.talk?.startedAt ? new Date(st.talk.startedAt) : null;
  $('dTalkTime').textContent = started && !Number.isNaN(started.getTime())
    ? `${status === 'live' ? 'since' : 'started'} ${started.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : '';
  $('endTalkBtn').hidden = status !== 'live';
  $('demoRestartBtn').hidden = !st.simulated;
  $('dAudience').href = `/r/${encodeURIComponent(selected)}`;
  $('dTranscript').hidden = !st.talk?.talkId;
  if (st.talk?.talkId) $('dTranscript').href = `/t/${encodeURIComponent(st.talk.talkId)}`;
  $('swCaptions').checked = !!st.settings.captions;
  $('swListen').checked = !!st.settings.listen;
  $('swSlides').checked = !!st.settings.slides;
  renderStatus();
  renderTele();
  renderCaptions();
  renderQuestions();
}

function renderStatus() {
  const s = rooms.get(selected).status;
  const db = s?.micDb;
  const hasDb = typeof db === 'number' && Number.isFinite(db);
  const pct = hasDb ? Math.max(0, Math.min(100, ((db + 70) / 70) * 100)) : 0;
  $('dMeter').style.width = `${pct}%`;
  $('dMeter').dataset.zone = !hasDb || db < -50 ? 'low' : db > -3 ? 'hot' : 'ok';
}


function renderCaptions() {
  const st = rooms.get(selected);
  const lines = st.captions.filter((l) => !st.talk?.talkId || !l.talkId || l.talkId === st.talk.talkId).slice(-5);
  const ol = $('dCaptions');
  if (!lines.length) { ol.replaceChildren(Object.assign(document.createElement('li'), { className: 'muted', textContent: 'Nothing yet.' })); return; }
  ol.replaceChildren(...lines.map((l) => Object.assign(document.createElement('li'), { textContent: l.text })));
}

// Switches
for (const [id, field] of [['swCaptions', 'captions'], ['swListen', 'listen'], ['swSlides', 'slides']]) {
  $(id).onchange = async () => {
    const st = rooms.get(selected);
    const next = { ...st.settings, [field]: $(id).checked };
    try { await api(`/api/rooms/${encodeURIComponent(selected)}/settings`, next); st.settings = next; } catch { $(id).checked = !$(id).checked; }
  };
}

// Broadcast
async function broadcast(text) {
  if (!text) return;
  try {
    await api(`/api/rooms/${encodeURIComponent(selected)}/broadcast`, { text });
    $('bcastText').value = '';
    flash($('bcastForm'), 'Sent to every phone');
  } catch { /* warned */ }
}
$('bcastForm').onsubmit = (e) => { e.preventDefault(); broadcast($('bcastText').value.trim()); };
$('quick').onclick = (e) => { const b = e.target.closest('.chip'); if (b) broadcast(b.textContent); };

function flash(el, text) {
  let n = el.nextElementSibling;
  if (!n || !n.classList.contains('flash')) { n = document.createElement('p'); n.className = 'flash'; el.after(n); }
  n.textContent = text;
  clearTimeout(n._t);
  n._t = setTimeout(() => n.remove(), 2500);
}

// ---------- questions ----------
function renderQuestions() {
  if ($('questions').querySelector('form')) { questionsPending = true; return; }
  questionsPending = false;
  const groups = rooms.get(selected).groups
    .filter((g) => !(g.qid && questionState.get(g.qid)?.hidden))
    .sort((a, b) => (questionState.get(b.qid)?.pinned ? 1 : 0) - (questionState.get(a.qid)?.pinned ? 1 : 0) || (a.answered - b.answered) || (b.count - a.count));
  $('qCount').textContent = groups.length ? `(${groups.length})` : '';
  const ul = $('questions');
  if (!groups.length) { ul.replaceChildren(Object.assign(document.createElement('li'), { className: 'muted', textContent: 'No questions yet.' })); return; }
  ul.replaceChildren(...groups.map(questionEl));
}

function questionEl(g) {
  const qs = (g.qid && questionState.get(g.qid)) || {};
  const li = document.createElement('li');
  li.className = 'q-item' + (g.answered || qs.answered ? ' answered' : '') + (qs.pinned ? ' pinned' : '');
  const text = document.createElement('p');
  text.className = 'q-text';
  text.textContent = g.text;
  const meta = document.createElement('p');
  meta.className = 'q-meta';
  meta.textContent = [qs.replied ? `Replied: ${qs.replied}` : null, g.count > 1 ? `${g.count} similar` : null, qs.pinned ? 'In Q&A queue' : null, g.answered || qs.answered ? 'Answered' : null].filter(Boolean).join(' · ') || 'New';
  li.append(text, meta);

  const row = document.createElement('div');
  row.className = 'q-actions';
  const mk = (label, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ghost small';
    b.textContent = label;
    b.disabled = !g.qid; // backend must send a qid per group
    b.onclick = fn;
    return b;
  };
  row.append(
    mk('Reply', () => openReply(li, g)),
    mk(qs.pinned ? 'Queued' : 'Add to Q&A', () => qAction(g, 'queue')),
    mk('Answered', () => qAction(g, 'answered')),
    mk('Hide', () => qAction(g, 'hide')),
  );
  li.append(row);
  if (!g.qid) li.title = 'Waiting for the server to send a question id for this group';
  return li;
}

async function qAction(g, action) {
  try {
    await api(`/api/questions/${encodeURIComponent(g.qid)}/${action}`, {});
    // Apply only this action's flag; the server's question_update broadcast carries the full state.
    const cur = questionState.get(g.qid) || {};
    const patch = action === 'queue' ? { pinned: true, hidden: false }
      : action === 'hide' ? { pinned: false, hidden: true }
      : { answered: true };
    onQuestionUpdate({ ...cur, ...patch, qid: g.qid });
  } catch { /* warned */ }
}

let questionsPending = false;
function openReply(li, g) {
  if (li.querySelector('form')) return;
  const f = document.createElement('form');
  f.className = 'bcast';
  const input = Object.assign(document.createElement('input'), { maxLength: 200, placeholder: 'Reply goes only to the people who asked' });
  const send = Object.assign(document.createElement('button'), { type: 'submit', textContent: 'Send' });
  f.append(input, send);
  f.onsubmit = async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    try {
      await api(`/api/questions/${encodeURIComponent(g.qid)}/reply`, { text });
      questionState.set(g.qid, { ...(questionState.get(g.qid) || {}), replied: text });
      f.remove();
      renderQuestions();
    } catch { /* warned */ }
  };
  // Esc closes the box; the list catches up with anything that arrived meanwhile.
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { f.remove(); if (questionsPending) renderQuestions(); } });
  li.append(f);
  input.focus();
}

function onQuestionUpdate(m) {
  if (!m.qid) return;
  questionState.set(m.qid, { ...(questionState.get(m.qid) || {}), pinned: !!m.pinned, hidden: !!m.hidden, answered: !!m.answered });
  if (rooms.get(selected)) renderQuestions();
}

// ---------- listen to podium ----------
let player = null;
$('listenPodium').onclick = () => {
  if (player?.playing) { player.stop(); $('listenPodium').setAttribute('aria-pressed', 'false'); return; }
  player = createPlayer({
    room: selected,
    key,
    onLevel: (rms) => { $('dLevel').style.width = `${Math.min(100, Math.round(Math.sqrt(rms) * 160))}%`; },
    onState: (s) => { $('listenPodium').textContent = s === 'playing' ? 'Listening · stop' : s === 'stopped' ? 'Listen to podium' : 'Connecting…'; },
  });
  player.start();
  $('listenPodium').setAttribute('aria-pressed', 'true');
};

// ---------- talk info ----------
async function loadRooms() {
  try {
    const list = await (await fetch('/api/rooms')).json();
    for (const r of list) {
      const id = String(r.room);
      if (DISCOVER && (r.status !== 'waiting' || r.simulated) && addRoom(id)) { connect(id); }
      const st = rooms.get(id);
      if (!st) continue;
      st.simulated = !!r.simulated;
      if (typeof r.here === 'number' && !st.stats) st.stats = { room: id, joined: r.joined, here: r.here, capacity: r.capacity };
      // The socket's `talk` message is the truth (it also names an ended talk, which /api/rooms
      // leaves out); the poll only fills in rooms whose socket hasn't spoken yet.
      if (!st.talkFromSocket) {
        st.talk = r.talkId ? { talkId: r.talkId, title: r.title, speaker: r.speaker, status: r.status, startedAt: r.startedAt } : null;
      }
    }
    // Tabs and drawer only: rebuilding the ticket blocks every 5 s lost clicks.
    renderTabs();
    renderDrawer();
  } catch { /* retry on next poll */ }
}
setInterval(loadRooms, 5000);

// ---------- talk controls ----------
let endArmed = null; // {room, talkId, at}
let endTimer = null;
function disarmEnd() {
  endArmed = null;
  clearTimeout(endTimer);
  $('endTalkBtn').textContent = '■ End talk';
}
$('endTalkBtn').onclick = async () => {
  const st = rooms.get(selected);
  if (!st.talk?.talkId) return;
  const armed = endArmed && endArmed.room === selected && endArmed.talkId === st.talk.talkId && Date.now() - endArmed.at <= 3000;
  if (!armed || Date.now() - endArmed.at < 400) {
    if (armed) return; // a double-click is not two taps
    endArmed = { room: selected, talkId: st.talk.talkId, at: Date.now() };
    $('endTalkBtn').textContent = `■ Tap again to end Room ${selected}`;
    clearTimeout(endTimer);
    endTimer = setTimeout(disarmEnd, 3000);
    return;
  }
  disarmEnd();
  try { await api(`/api/talks/${encodeURIComponent(st.talk.talkId)}/end`, {}); } catch { /* warned */ }
};
$('demoRestartBtn').onclick = async () => {
  try {
    await api(`/api/rooms/${encodeURIComponent(selected)}/demo/restart`, {});
    flash($('demoRestartBtn').closest('.d-session'), 'Demo talk restarted');
  } catch { /* warned */ }
};

// ---------- one socket per room ----------
for (const room of roomList) connect(room);

function connect(room) {
  const st = rooms.get(room);
  connectRoom({
    room,
    role: 'tech',
    key,
    onStatus: (s) => {
      st.conn = s;
      if (s === 'unauthorized') warn('The server rejected the tech key.');
      if (s === 'live') {
        // The join snapshot is the full truth for this room: drop what we had, so a ticket
        // fixed or dismissed while we were disconnected doesn't stay red forever.
        for (const [id, t] of tickets) if (String(t.room) === room) tickets.delete(id);
        loadRooms();
      }
      render();
      if (room === selected) renderDrawer();
    },
    onMessage: (m) => {
      switch (m.t) {
        case 'ticket': onTicket(m); break;
        case 'room_status': st.status = { ...m, at: Date.now() }; if (room === selected) renderStatus(); break;
        case 'room_stats': st.stats = m; renderTabs(); if (room === selected) renderFill(st); break;
        case 'room_telemetry': st.tele = m; renderTabs(); if (room === selected) renderTele(); break;
        case 'caption':
          if (!st.talk || (m.talkId && st.talk.talkId !== m.talkId)) loadRooms();
          st.captions.push(m); st.captions = st.captions.slice(-50);
          if (room === selected) renderCaptions();
          break;
        case 'caption_backlog': {
          const lines = m.lines || [];
          const last = lines.length ? lines[lines.length - 1].talkId : null; // the room keeps lines across talks
          st.captions = lines.filter((l) => !last || l.talkId === last).slice(-50);
          if (room === selected) renderCaptions();
          break;
        }
        case 'room_settings': st.settings = { ...st.settings, ...m }; renderTabs(); if (room === selected) renderDrawer(); break;
        case 'question_groups': st.groups = m.groups || []; if (room === selected) renderQuestions(); break;
        case 'question_update': onQuestionUpdate(m); break;
        case 'talk':
          if (m.talkId && st.talk?.talkId && m.talkId !== st.talk.talkId) st.captions = [];
          st.talkFromSocket = true;
          st.talk = m.talkId ? { talkId: m.talkId, title: m.title, speaker: m.speaker, status: m.status, startedAt: m.startedAt } : null;
          render();
          if (room === selected) renderDrawer();
          break;
        default: break;
      }
    },
  });
}


render();
renderDrawer();
