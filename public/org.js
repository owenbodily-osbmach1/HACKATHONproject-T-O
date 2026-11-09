// Organizer overview /org. Public page: no key, read-only (CONTRACT.md).
// One role=org socket per room, plus GET /api/rooms every 10 s to discover rooms.
import { connectRoom } from '/lib/socket.js';

const $ = (id) => document.getElementById(id);
const ACTIVE = new Set(['open', 'claimed', 'reopened']);
const ROOM_POLL_MS = 10000;
const STATUS_FRESH_MS = 6000; // room_status ticks every 2 s while a room has listeners
const FEED_MAX = 60;

const TYPE_WORDS = { cant_hear: "Can't hear", cant_see: "Can't see slides" };
const STATUS_WORDS = { open: 'Open', claimed: 'Claimed', fixed: 'Fixed', reopened: 'Reopened', dismissed: 'Dismissed' };
const CONN_WORDS = { live: 'Live', connecting: 'Connecting…', reconnecting: 'Reconnecting…', unauthorized: 'Not allowed' };
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

const roomGrid = $('roomGrid');
const roomsEmpty = $('roomsEmpty');
const feedList = $('feedList');
const feedEmpty = $('feedEmpty');
const updatedEl = $('updated');
const connEl = $('conn');

const rooms = new Map(); // room -> record
const fixes = []; // durations in ms, one per ticket fixed this session
const fixedIds = new Set();
let polling = false;

// ---------- formatting ----------
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

function clock(ts) {
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? '—' : timeFmt.format(date);
}

function typeWords(type) {
  if (TYPE_WORDS[type]) return TYPE_WORDS[type];
  const words = String(type || 'ticket').replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function statusWords(status) {
  if (STATUS_WORDS[status]) return STATUS_WORDS[status];
  const words = String(status || 'unknown');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function finiteOrNull(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function gapWords(sec) {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return s % 60 ? `${m} m ${s % 60} s` : `${m} m`;
}

function durationWords(ms) {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec} s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return sec % 60 ? `${min} m ${sec % 60} s` : `${min} m`;
  return min % 60 ? `${Math.floor(min / 60)} h ${min % 60} m` : `${Math.floor(min / 60)} h`;
}

function minutesOpen(openedAt) {
  const ts = Date.parse(openedAt);
  if (!Number.isFinite(ts)) return null;
  return Math.max(0, Math.floor((Date.now() - ts) / 60000));
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ---------- per-room state + card ----------
function newRoom(room) {
  return {
    room,
    talkId: null,
    title: '',
    simulated: false,
    apiListeners: 0,
    statusListeners: null,
    statusAt: 0,
    micDb: null,
    captionGapSec: null,
    settings: null, // { captions, listen, slides } from room_settings
    openCount: 0,
    tickets: new Map(), // id -> latest ticket message fields
    wsStatus: 'connecting',
    els: null,
  };
}

function listenersOf(r) {
  if (r.statusListeners !== null && Date.now() - r.statusAt < STATUS_FRESH_MS) return r.statusListeners;
  return r.apiListeners;
}

function activeTickets(r) {
  return [...r.tickets.values()].filter((ticket) => ACTIVE.has(ticket.status));
}

function countActive(r) {
  return activeTickets(r).length;
}

function createCard(r) {
  const card = el('article', 'room-card');
  card.dataset.room = r.room;

  const head = el('header', 'room-card-head');
  const heading = el('h3', 'room-heading');
  heading.id = `room-${r.room.replace(/[^\w-]/g, '_')}-heading`;
  const num = el('span', 'room-num', `Room ${r.room}`);
  const sim = el('span', 'sim-badge', 'Simulated');
  sim.hidden = true;
  heading.append(num, sim);
  head.append(heading);
  card.setAttribute('aria-labelledby', heading.id);

  const title = el('p', 'room-title');

  const alertBadge = el('p', 'alert-badge');
  alertBadge.hidden = true;

  const facts = el('dl', 'room-facts');
  const fact = (label) => {
    const wrap = el('div', 'room-fact');
    const dd = el('dd');
    wrap.append(el('dt', null, label), dd);
    facts.append(wrap);
    return dd;
  };
  const listenersDd = fact('Listeners');
  const captionsDd = fact('Captions');
  const micDd = fact('Mic level');
  micDd.classList.add('db-row');
  const micText = el('span', 'mic-text', 'No signal');
  const meter = el('span', 'db-meter');
  meter.setAttribute('aria-hidden', 'true');
  const meterBar = el('span');
  meter.append(meterBar);
  micDd.append(micText, meter);
  const ticketsDd = fact('Tickets');

  const ticketsList = el('ul', 'card-tickets');
  ticketsList.setAttribute('aria-label', 'Open tickets for this room');
  ticketsList.hidden = true;

  const link = el('a', 'card-link', 'Open talk report →');
  link.hidden = true;

  card.append(head, title, alertBadge, facts, ticketsList, link);
  roomGrid.append(card);

  r.els = { card, num, sim, title, alertBadge, listenersDd, captionsDd, micText, meterBar, ticketsDd, ticketsList, link };
  updateCard(r);
}

function updateCard(r) {
  const ui = r.els;
  if (!ui) return;

  ui.num.textContent = `Room ${r.room}`;
  ui.sim.hidden = !r.simulated;

  const title = r.title && r.title.trim() ? r.title : 'No talk yet';
  setText(ui.title, title);
  ui.title.classList.toggle('muted', !(r.title && r.title.trim()));

  setText(ui.listenersDd, String(listenersOf(r)));
  setText(ui.captionsDd, captionsText(r));
  ui.captionsDd.classList.toggle('warn', isCaptionStale(r));

  const db = Number.isFinite(r.micDb) ? r.micDb : null;
  setText(ui.micText, db === null ? 'No signal' : `${Math.round(db)} dB`);
  ui.micText.classList.toggle('muted', db === null);
  const pct = db === null ? 0 : Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  ui.meterBar.style.width = `${pct}%`;

  const active = activeTickets(r);
  const open = Math.max(r.openCount, active.length);
  setText(ui.ticketsDd, open === 0 ? 'None open' : `${open} open`);

  // Text badge + border change: colour is never the only signal.
  const unknown = r.openCount > active.length;
  const anyUnclaimed = unknown || active.some((ticket) => ticket.status !== 'claimed');
  const word = anyUnclaimed ? 'open' : 'claimed';
  ui.alertBadge.hidden = open === 0;
  ui.alertBadge.textContent = open > 1 ? `${open} tickets ${word}` : `Ticket ${word}`;
  ui.card.classList.toggle('has-ticket', open > 0);
}

function captionsText(r) {
  if (!r.settings) return 'Connecting…';
  if (!r.settings.captions) return 'Off';
  if (!Number.isFinite(r.captionGapSec)) return 'On · no captions yet';
  const sec = Math.max(0, r.captionGapSec);
  return `On · gap ${gapWords(sec)}${sec > 15 ? ' · stale' : ''}`;
}

function isCaptionStale(r) {
  return Boolean(r.settings && r.settings.captions && Number.isFinite(r.captionGapSec) && r.captionGapSec > 15);
}

function updateLink(r) {
  const link = r.els && r.els.link;
  if (!link) return;
  if (r.talkId) {
    link.hidden = false;
    link.href = `/t/${encodeURIComponent(r.talkId)}`;
  } else {
    link.hidden = true;
    link.removeAttribute('href');
  }
}

function ticketNode(ticket) {
  const li = el('li', 'ticket');
  li.dataset.status = ticket.status;

  const top = el('p', 'ticket-top');
  top.append(
    el('span', 'ticket-badge', statusWords(ticket.status)),
    el('span', 'ticket-type', typeWords(ticket.type))
  );
  if (ticket.people !== null) {
    top.append(el('span', 'ticket-people', `${ticket.people} ${ticket.people === 1 ? 'person' : 'people'}`));
  }

  const mins = minutesOpen(ticket.openedAt);
  const age = mins === null ? 'open time unknown' : mins < 1 ? 'open under 1 min' : `open ${mins} min`;
  const meta = el('p', 'ticket-meta', `${age} · likely cause: ${ticket.cause || 'not reported'}`);
  li.append(top, meta);
  return li;
}

function pendingNode(count) {
  const li = el('li', 'ticket ticket-pending');
  li.dataset.status = 'open';
  const top = el('p', 'ticket-top');
  top.append(
    el('span', 'ticket-badge', 'Open'),
    el('span', 'ticket-type', `${count} ${count === 1 ? 'ticket' : 'tickets'} open`)
  );
  li.append(top, el('p', 'ticket-meta', 'Details arrive with the next ticket update.'));
  return li;
}

function renderTickets(r) {
  const list = r.els && r.els.ticketsList;
  if (!list) return;

  const active = activeTickets(r).sort((a, b) => {
    const at = Date.parse(a.openedAt);
    const bt = Date.parse(b.openedAt);
    if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return at - bt;
    return String(a.id).localeCompare(String(b.id));
  });
  const pending = Math.max(0, r.openCount - active.length);
  const frag = document.createDocumentFragment();
  for (const ticket of active) frag.append(ticketNode(ticket));
  if (pending > 0) frag.append(pendingNode(pending));

  list.replaceChildren(frag);
  list.hidden = active.length === 0 && pending === 0;
}

// ---------- stats + activity feed ----------
function updateStats() {
  let listeners = 0;
  let openTickets = 0;
  for (const r of rooms.values()) {
    listeners += listenersOf(r);
    openTickets += Math.max(0, r.openCount, countActive(r));
  }

  setText($('statRooms'), String(rooms.size));
  setText($('statListeners'), String(listeners));
  setText($('statTickets'), String(openTickets));
  $('statOpen').dataset.alert = String(openTickets > 0);
  setText($('statMedian'), fixes.length ? durationWords(median(fixes)) : '—');
}

function addFeed(r, ticket) {
  const verb = {
    open: 'opened',
    claimed: 'claimed',
    fixed: 'fixed',
    reopened: 'reopened',
    dismissed: 'dismissed',
  }[ticket.status] || String(ticket.status || 'updated');

  const opened = ticket.status === 'open' ? Date.parse(ticket.openedAt) : NaN;
  const ts = Number.isFinite(opened) ? opened : Date.now();

  const li = el('li', 'feed-item');
  li.dataset.status = ticket.status;
  const time = el('time', 'feed-time', clock(ts));
  time.dateTime = new Date(ts).toISOString();
  const people = ticket.people === null ? '' : ` · ${ticket.people} ${ticket.people === 1 ? 'person' : 'people'}`;
  const text = el('span', 'feed-text', `Room ${r.room} · ${typeWords(ticket.type)}${people} — ticket ${verb}`);
  li.append(time, text);

  feedList.prepend(li);
  while (feedList.children.length > FEED_MAX) feedList.lastElementChild.remove();
  feedList.hidden = false;
  feedEmpty.hidden = true;
}

function noteFix(ticket) {
  if (ticket.status !== 'fixed' || fixedIds.has(ticket.id)) return;
  const opened = Date.parse(ticket.openedAt);
  if (!Number.isFinite(opened)) return;
  fixedIds.add(ticket.id);
  fixes.push(Math.max(0, Date.now() - opened));
}

// Server truth: a room_status/poll count of zero means no tracked ticket can still be open.
// Keeps cards from showing a ticket fixed while this page's socket was reconnecting.
function setOpenCount(r, count) {
  if (!Number.isFinite(count)) return false;
  const next = Math.max(0, Math.round(count));
  const changed = r.openCount !== next;
  r.openCount = next;
  let removed = false;
  if (next === 0) {
    for (const [id, ticket] of r.tickets) {
      if (ACTIVE.has(ticket.status)) {
        r.tickets.delete(id);
        removed = true;
      }
    }
  }
  return changed || removed;
}

// ---------- WebSocket messages ----------
function onTicket(r, msg) {
  const id = String(msg.id || '');
  if (!id) return;

  const prev = r.tickets.get(id);
  const status = typeof msg.status === 'string' && msg.status ? msg.status : 'open';
  const wasActive = prev ? ACTIVE.has(prev.status) : false;
  const nowActive = ACTIVE.has(status);
  const peopleNumber = Number(msg.people);

  const ticket = {
    id,
    type: msg.type,
    status,
    people: Number.isFinite(peopleNumber) ? Math.max(0, Math.round(peopleNumber)) : null,
    openedAt: msg.openedAt,
    cause: typeof msg.cause === 'string' ? msg.cause : '',
  };
  r.tickets.set(id, ticket);

  if (!prev) {
    const known = countActive(r);
    if (nowActive && r.openCount < known) r.openCount = known;
    if (!nowActive && r.openCount > known) r.openCount = Math.max(0, r.openCount - 1);
  } else if (!wasActive && nowActive) {
    r.openCount += 1;
  } else if (wasActive && !nowActive) {
    r.openCount = Math.max(0, r.openCount - 1);
  }

  const changedStatus = !prev || prev.status !== status;
  if (changedStatus) {
    addFeed(r, ticket);
    noteFix(ticket);
    updateStats();
  }

  updateCard(r);
  renderTickets(r);
}

function onMessage(r, msg) {
  if (msg.t === 'room_status') {
    const listeners = finiteOrNull(msg.listeners);
    if (listeners !== null) {
      r.statusListeners = listeners;
      r.statusAt = Date.now();
    }
    r.micDb = finiteOrNull(msg.micDb);
    r.captionGapSec = finiteOrNull(msg.captionGapSec);
    const count = finiteOrNull(msg.openTickets);
    const changed = count !== null ? setOpenCount(r, count) : false;
    updateCard(r);
    if (changed) renderTickets(r);
    updateStats();
    return;
  }

  if (msg.t === 'room_settings') {
    r.settings = {
      captions: msg.captions !== false,
      listen: msg.listen !== false,
      slides: msg.slides !== false,
    };
    updateCard(r);
    return;
  }

  if (msg.t === 'ticket') onTicket(r, msg);
}

function updateConn() {
  const all = [...rooms.values()];
  let status = 'live';
  const unauthorized = all.filter((r) => r.wsStatus === 'unauthorized').length;
  const reconnecting = all.filter((r) => r.wsStatus === 'reconnecting').length;
  const connecting = all.filter((r) => r.wsStatus === 'connecting').length;

  if (unauthorized) status = 'unauthorized';
  else if (reconnecting) status = 'reconnecting';
  else if (connecting || all.length === 0) status = 'connecting';
  else if (all.every((r) => r.wsStatus === 'live')) status = 'live';

  let words = CONN_WORDS[status] || status;
  if (status === 'reconnecting' && reconnecting > 1) words = `Reconnecting ${reconnecting} rooms…`;
  else if (status === 'live' && all.length > 1) words = `Live · ${all.length} rooms`;
  if (connEl.dataset.status === status && connEl.querySelector('.conn-word').textContent === words) return;
  connEl.dataset.status = status;
  connEl.querySelector('.conn-word').textContent = words;
}

function openSocket(r) {
  connectRoom({
    room: r.room,
    role: 'org',
    onMessage: (msg) => onMessage(r, msg),
    onStatus: (wsStatus) => {
      r.wsStatus = wsStatus;
      updateConn();
    },
  });
}

// ---------- room discovery ----------
function applyRooms(list) {
  for (const item of list) {
    if (!item || item.room === undefined || item.room === null) continue;
    const id = String(item.room);
    let r = rooms.get(id);
    if (!r) {
      r = newRoom(id);
      rooms.set(id, r);
      createCard(r);
      openSocket(r);
    }

    const nextTalkId = item.talkId ? String(item.talkId) : null;
    const talkChanged = nextTalkId !== r.talkId;
    r.talkId = nextTalkId;
    r.title = typeof item.title === 'string' ? item.title : '';
    r.simulated = Boolean(item.simulated);
    r.apiListeners = Math.max(0, Math.round(finiteOrNull(item.listeners) ?? 0));

    const count = finiteOrNull(item.openTickets);
    if (count !== null) setOpenCount(r, count);

    updateCard(r);
    if (talkChanged) updateLink(r);
    renderTickets(r);
  }

  roomsEmpty.hidden = rooms.size > 0;
  updateConn();
  updateStats();
}

async function loadRooms() {
  if (polling) return;
  polling = true;
  try {
    const opts = { cache: 'no-store' };
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      opts.signal = AbortSignal.timeout(8000);
    }
    const res = await fetch('/api/rooms', opts);
    if (!res.ok) throw new Error(String(res.status));
    const list = await res.json();
    if (!Array.isArray(list)) throw new Error('bad room list');
    applyRooms(list);
    setText(updatedEl, `Room list updated ${clock(Date.now())}`);
  } catch {
    setText(updatedEl, 'Room list unavailable — retrying every 10 s');
  } finally {
    polling = false;
  }
}

loadRooms();
setInterval(loadRooms, ROOM_POLL_MS);
// Ticket age labels ("open 3 min") stay current without waiting for an event.
setInterval(() => {
  for (const r of rooms.values()) renderTickets(r);
}, 30000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') loadRooms();
});
