// Presenter slides for /present/:room. Slide changes are relayed to every phone.
// The title slide carries a QR code to the attendee page, generated locally.
import { connectRoom } from '/lib/socket.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const room = decodeURIComponent((location.pathname.match(/^\/present\/([^/?#]+)/) || [])[1] || '151');
const key = params.get('key') || '';
const deckName = (params.get('deck') || 'demo').toLowerCase().replace(/[^a-z0-9_-]+/g, '') || 'demo';

// The QR must point at an address phones can open: ?base= override, then the server's
// PUBLIC_BASE_URL (GET /api/config → publicBaseUrl), then this page's own origin.
const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)$/i;

async function qrBase() {
  const override = params.get('base');
  if (override) return override.replace(/\/+$/, '');
  try {
    const c = await (await fetch('/api/config')).json();
    if (c && c.publicBaseUrl) return String(c.publicBaseUrl).replace(/\/+$/, '');
  } catch { /* fall back to origin */ }
  return location.origin;
}

const attendeeUrl = `${await qrBase()}/r/${encodeURIComponent(room)}`;

const state = {
  deck: [],       // [{n, url, alt}] sorted by n
  index: 0,
  talkId: null,
  imgToken: 0,
  synced: false,  // this tab settled its slide for the current connection
  pendingN: 0,    // stored slide number that arrived before the deck loaded
};

let socket = null;

document.title = `Pulse · Presenter · Room ${room}`;

const CONN_WORDS = { live: 'Live', connecting: 'Connecting…', reconnecting: 'Reconnecting…', unauthorized: 'Not allowed' };
function setConn(status) {
  const el = $('conn');
  el.dataset.status = status;
  el.querySelector('.conn-word').textContent = CONN_WORDS[status] || status;
}

function setListeners(count) {
  const el = $('listeners');
  const text = `${count} ${count === 1 ? 'listener' : 'listeners'}`;
  if (el.textContent !== text) el.textContent = text;
}

function setTickets(count) {
  const el = $('tickets');
  const text = count === 0 ? 'No open tickets' : `${count} open ticket${count === 1 ? '' : 's'}`;
  if (el.textContent !== text) el.textContent = text;
  el.classList.toggle('has-ticket', count > 0);
  el.classList.toggle('is-clear', count === 0);
}

function setRoomInfo(info) {
  const talkId = info.talkId || null;
  const previousTalk = state.talkId;
  const changed = talkId !== previousTalk;
  state.talkId = talkId;
  const listeners = Number(info.listeners);
  if (Number.isFinite(listeners)) setListeners(listeners);
  const openTickets = Number(info.openTickets);
  if (Number.isFinite(openTickets)) setTickets(openTickets);
  // Only a real talk switch announces: a first reply on reload must not push
  // slide 1 before the join-time slide arrives.
  if (changed && previousTalk && talkId && state.deck.length) announce();
}

// GET /api/rooms is public and is the only source of listener/ticket counts for
// this role: the server sends room_status to tech and org only.
async function refreshRoom() {
  try {
    const res = await fetch('/api/rooms', { cache: 'no-store' });
    if (!res.ok) return;
    const rooms = await res.json();
    if (!Array.isArray(rooms)) return;
    const info = rooms.find((entry) => String(entry.room) === room);
    if (info) setRoomInfo(info);
  } catch {
    /* offline: the socket status already shows the problem */
  }
}

// ---------- deck ----------
function slideSrc(url) {
  return url.startsWith('/') ? url : `/slides/${deckName}/${url.replace(/^\.\//, '')}`;
}

function showSlideMessage(text) {
  const el = $('slideMsg');
  el.textContent = text;
  el.hidden = false;
}

function hideSlideMessage() {
  $('slideMsg').hidden = true;
}

function updateButtons() {
  $('prevBtn').disabled = state.index <= 0;
  $('nextBtn').disabled = state.index >= state.deck.length - 1;
}

function render() {
  const slide = state.deck[state.index];
  if (!slide) return;

  const token = ++state.imgToken;
  const img = $('slideImg');
  img.alt = slide.alt || `Slide ${state.index + 1} of ${state.deck.length}`;
  img.onload = () => { if (token === state.imgToken) hideSlideMessage(); };
  img.onerror = () => {
    if (token === state.imgToken) showSlideMessage('Slide image failed to load. Check the deck folder.');
  };
  img.src = slide.url;

  const isTitle = slide.n === 1;
  $('slideLayout').dataset.qr = isTitle ? '1' : '0';
  $('qrCard').hidden = !isTitle;
  $('slideLabel').textContent = `Slide ${state.index + 1} / ${state.deck.length} · Room ${room}`;
  updateButtons();
}

function preloadDeck() {
  for (const slide of state.deck) {
    const img = new Image();
    img.src = slide.url;
  }
}

async function loadDeck() {
  try {
    const res = await fetch(`/slides/${encodeURIComponent(deckName)}/slides.json`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    if (!Array.isArray(raw)) throw new Error('slides.json is not an array');
    const deck = raw
      .filter((slide) => slide && Number.isInteger(Number(slide.n)) && Number(slide.n) > 0 && typeof slide.url === 'string' && slide.url)
      .map((slide) => ({
        n: Number(slide.n),
        url: slideSrc(slide.url),
        alt: typeof slide.alt === 'string' ? slide.alt : '',
      }))
      .sort((a, b) => a.n - b.n);
    if (!deck.length) throw new Error('empty deck');

    state.deck = deck;
    state.index = 0;
    preloadDeck();
    if (state.pendingN) {
      const restored = deck.findIndex((slide) => slide.n === state.pendingN);
      if (restored >= 0) state.index = restored;
      state.pendingN = 0;
    }
    render();
    scheduleAnnounce();
  } catch {
    state.deck = [];
    state.index = 0;
    $('slideLabel').textContent = 'No deck';
    $('deckError').textContent = `Could not load the ${deckName} deck.`;
    showSlideMessage(`Could not load deck “${deckName}”.`);
    updateButtons();
  }
}

// ---------- slide relay ----------
let syncTimer = null;
let firstJoin = true; // only the first page-load join adopts the stored slide

// The server sends the stored slide immediately after the socket joins. Hold
// the first announce briefly so a reload adopts that slide instead of slide 1.
function scheduleAnnounce() {
  if (state.synced) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    if (!state.synced) announce();
  }, 250);
}

function announce() {
  const slide = state.deck[state.index];
  if (!slide || !socket) return;
  const msg = {
    t: 'slide',
    n: slide.n,
    total: state.deck.length,
    url: slide.url,
  };
  if (state.talkId) msg.talkId = state.talkId;
  if (!socket.send(msg)) return;
  state.synced = true; // this tab owns the slide now; ignore its own echo
  clearTimeout(syncTimer);
}

function go(delta) {
  const next = state.index + delta;
  if (next < 0 || next >= state.deck.length) return;
  state.index = next;
  render();
  announce();
}

function goTo(index) {
  if (!state.deck.length) return;
  const next = Math.min(Math.max(index, 0), state.deck.length - 1);
  if (next === state.index) return;
  state.index = next;
  render();
  announce();
}

const NEXT_KEYS = new Set(['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Spacebar', 'n', 'N']);
const PREV_KEYS = new Set(['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace', 'p', 'P']);

window.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
  const target = event.target;
  if (!target) return;
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
  // Space activates a focused button itself; arrows still move slides.
  if ((event.key === ' ' || event.key === 'Spacebar') && target.tagName === 'BUTTON') return;
  if (NEXT_KEYS.has(event.key)) {
    event.preventDefault();
    go(1);
  } else if (PREV_KEYS.has(event.key)) {
    event.preventDefault();
    go(-1);
  } else if (event.key === 'Home') {
    event.preventDefault();
    goTo(0);
  } else if (event.key === 'End') {
    event.preventDefault();
    goTo(state.deck.length - 1);
  }
});

$('prevBtn').onclick = () => go(-1);
$('nextBtn').onclick = () => go(1);

const fsBtn = $('fsBtn');
if (document.documentElement.requestFullscreen) {
  fsBtn.hidden = false;
  fsBtn.onclick = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      document.documentElement.requestFullscreen().catch(() => {});
    }
  };
  document.addEventListener('fullscreenchange', () => {
    const on = Boolean(document.fullscreenElement);
    fsBtn.setAttribute('aria-pressed', String(on));
    fsBtn.setAttribute('aria-label', on ? 'Exit full screen' : 'Enter full screen');
  });
}

// ---------- QR encoder: byte mode, ECC level M, versions 1-6 ----------
const QR_VERSIONS = {
  1: { size: 21, data: 16, ec: 10, blocks: 1, align: [] },
  2: { size: 25, data: 28, ec: 16, blocks: 1, align: [6, 18] },
  3: { size: 29, data: 44, ec: 26, blocks: 1, align: [6, 22] },
  4: { size: 33, data: 64, ec: 18, blocks: 2, align: [6, 26] },
  5: { size: 37, data: 86, ec: 24, blocks: 2, align: [6, 30] },
  6: { size: 41, data: 108, ec: 16, blocks: 4, align: [6, 34] },
};

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let value = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = value;
    GF_LOG[value] = i;
    value <<= 1;
    if (value & 0x100) value ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
}

function gfMul(a, b) {
  return a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGenerator(degree) {
  let poly = [1];
  let root = 1;
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], root);
    }
    poly = next;
    root = gfMul(root, 2);
  }
  return poly;
}

function rsRemainder(data, degree) {
  const generator = rsGenerator(degree);
  const buffer = new Uint8Array(data.length + degree);
  buffer.set(data);
  for (let i = 0; i < data.length; i++) {
    const factor = buffer[i];
    if (!factor) continue;
    for (let j = 0; j < generator.length; j++) buffer[i + j] ^= gfMul(generator[j], factor);
  }
  return buffer.slice(data.length);
}

function dataCodewords(bytes, spec) {
  const bits = [];
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(4, 4); // byte mode
  push(bytes.length, 8); // character count, versions 1-9
  for (const byte of bytes) push(byte, 8);

  const capacity = spec.data * 8;
  if (bits.length > capacity) throw new Error('QR payload too long');
  const terminator = Math.min(4, capacity - bits.length);
  for (let i = 0; i < terminator; i++) bits.push(0);
  while (bits.length % 8) bits.push(0);

  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    codewords.push(byte);
  }
  for (let i = 0; codewords.length < spec.data; i++) codewords.push(i % 2 ? 0x11 : 0xec);
  return codewords;
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) === 0,
  (r, c) => ((((r * c) % 2) + ((r * c) % 3)) % 2) === 0,
  (r, c) => ((((r + c) % 2) + ((r * c) % 3)) % 2) === 0,
];

function formatBits(mask) {
  const data = mask; // ECC level M is 00 in the top two bits
  let remainder = data;
  for (let i = 0; i < 10; i++) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  return ((data << 10) | remainder) ^ 0x5412;
}

function formatModules(size, modules, mask) {
  const bits = formatBits(mask);
  const bit = (i) => (bits >>> i) & 1;
  for (let i = 0; i <= 5; i++) modules[i][8] = bit(i);
  modules[7][8] = bit(6);
  modules[8][8] = bit(7);
  modules[8][7] = bit(8);
  for (let i = 9; i < 15; i++) modules[8][14 - i] = bit(i);
  for (let i = 0; i < 8; i++) modules[8][size - 1 - i] = bit(i);
  for (let i = 8; i < 15; i++) modules[size - 15 + i][8] = bit(i);
  modules[size - 8][8] = 1;
}

function penalty(modules) {
  const size = modules.length;
  let score = 0;

  for (let r = 0; r < size; r++) {
    let run = 1;
    for (let c = 1; c <= size; c++) {
      if (c < size && modules[r][c] === modules[r][c - 1]) {
        run++;
      } else {
        if (run >= 5) score += 3 + run - 5;
        run = 1;
      }
    }
  }
  for (let c = 0; c < size; c++) {
    let run = 1;
    for (let r = 1; r <= size; r++) {
      if (r < size && modules[r][c] === modules[r - 1][c]) {
        run++;
      } else {
        if (run >= 5) score += 3 + run - 5;
        run = 1;
      }
    }
  }

  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const value = modules[r][c];
      if (value === modules[r][c + 1] && value === modules[r + 1][c] && value === modules[r + 1][c + 1]) score += 3;
    }
  }

  const patternA = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const patternB = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const scan = (get) => {
    for (let i = 0; i + 11 <= size; i++) {
      let a = true;
      let b = true;
      for (let j = 0; j < 11; j++) {
        const value = get(i + j);
        if (value !== patternA[j]) a = false;
        if (value !== patternB[j]) b = false;
        if (!a && !b) break;
      }
      if (a || b) score += 40;
    }
  };
  for (let r = 0; r < size; r++) scan((i) => modules[r][i]);
  for (let c = 0; c < size; c++) scan((i) => modules[i][c]);

  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += modules[r][c];
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return score;
}

function buildQr(version, bytes) {
  const spec = QR_VERSIONS[version];
  const size = spec.size;
  const modules = Array.from({ length: size }, () => new Uint8Array(size));
  const isFunction = Array.from({ length: size }, () => new Uint8Array(size));

  const set = (r, c, dark) => {
    modules[r][c] = dark ? 1 : 0;
    isFunction[r][c] = 1;
  };
  const finder = (row, col) => {
    for (let dy = -1; dy <= 7; dy++) {
      for (let dx = -1; dx <= 7; dx++) {
        const r = row + dy;
        const c = col + dx;
        if (r < 0 || r >= size || c < 0 || c >= size) continue;
        const distance = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
        set(r, c, distance !== 2 && distance !== 4);
      }
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);

  for (let i = 8; i < size - 8; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }

  const positions = spec.align;
  const last = positions.length - 1;
  for (let a = 0; a < positions.length; a++) {
    for (let b = 0; b < positions.length; b++) {
      if ((a === 0 && (b === 0 || b === last)) || (a === last && b === 0)) continue;
      const centerRow = positions[a];
      const centerCol = positions[b];
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          set(centerRow + dy, centerCol + dx, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }

  const reserve = (r, c) => {
    modules[r][c] = 0;
    isFunction[r][c] = 1;
  };
  for (let i = 0; i <= 5; i++) reserve(i, 8);
  reserve(7, 8);
  reserve(8, 8);
  reserve(8, 7);
  for (let i = 9; i < 15; i++) reserve(8, 14 - i);
  for (let i = 0; i < 8; i++) reserve(8, size - 1 - i);
  for (let i = 8; i < 15; i++) reserve(size - 15 + i, 8);
  reserve(size - 8, 8);

  const data = dataCodewords(bytes, spec);
  const perBlock = spec.data / spec.blocks;
  const dataBlocks = [];
  const ecBlocks = [];
  for (let b = 0; b < spec.blocks; b++) {
    const block = data.slice(b * perBlock, (b + 1) * perBlock);
    dataBlocks.push(block);
    ecBlocks.push(rsRemainder(block, spec.ec));
  }
  const codewords = [];
  for (let i = 0; i < perBlock; i++) for (const block of dataBlocks) codewords.push(block[i]);
  for (let i = 0; i < spec.ec; i++) for (const block of ecBlocks) codewords.push(block[i]);

  const bits = [];
  for (const byte of codewords) for (let i = 7; i >= 0; i--) bits.push((byte >>> i) & 1);

  let bitIndex = 0;
  let col = size - 1;
  let upward = true;
  while (col > 0) {
    if (col === 6) col--;
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (let k = 0; k < 2; k++) {
        const c = col - k;
        if (!isFunction[row][c]) {
          modules[row][c] = bitIndex < bits.length ? bits[bitIndex] : 0;
          bitIndex++;
        }
      }
    }
    upward = !upward;
    col -= 2;
  }

  let best = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = modules.map((row) => row.slice());
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (!isFunction[r][c] && MASKS[mask](r, c)) candidate[r][c] ^= 1;
      }
    }
    formatModules(size, candidate, mask);
    const score = penalty(candidate);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return { size, modules: best };
}

function encodeQr(text) {
  const bytes = new TextEncoder().encode(text);
  for (let version = 1; version <= 6; version++) {
    if (4 + 8 + bytes.length * 8 <= QR_VERSIONS[version].data * 8) return buildQr(version, bytes);
  }
  throw new Error('QR payload too long');
}

function drawQr(text) {
  const qr = encodeQr(text);
  const quiet = 4;
  const scale = 12;
  const dimension = (qr.size + quiet * 2) * scale;
  const canvas = $('qrCanvas');
  canvas.width = dimension;
  canvas.height = dimension;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, dimension, dimension);
  ctx.fillStyle = '#000000';
  for (let r = 0; r < qr.size; r++) {
    for (let c = 0; c < qr.size; c++) {
      if (qr.modules[r][c]) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
    }
  }
  canvas.setAttribute('aria-label', `QR code for ${text}`);
}

// ---------- boot ----------
try {
  drawQr(attendeeUrl);
  $('qrUrl').textContent = attendeeUrl;
} catch {
  $('qrCanvas').hidden = true;
  $('qrUrl').textContent = attendeeUrl;
  document.querySelector('.qr-hint').textContent = 'QR code unavailable';
  $('deckError').textContent = 'The attendee URL is too long for the local QR generator.';
}
let qrHost = '';
try { qrHost = new URL(attendeeUrl).hostname; } catch { /* bad base override */ }
$('qrWarn').hidden = !LOCAL_HOST.test(qrHost);

showSlideMessage('Loading deck…');
updateButtons();
loadDeck();

socket = connectRoom({
  room,
  role: 'present',
  key,
  onStatus: (status) => {
    setConn(status);
    if (status === 'connecting' || status === 'reconnecting') {
      state.synced = false; // wait for the stored slide this join may carry
      state.pendingN = 0;
    }
    if (status === 'live') {
      refreshRoom();
      if (firstJoin) {
        firstJoin = false;
        scheduleAnnounce(); // first page load: adopt the stored slide if any
      } else {
        // Reconnect: this tab keeps its slide and pushes it, instead of
        // adopting the server's stale one.
        announce();
      }
    }
  },
  onMessage: (msg) => {
    if (msg.t === 'slide') {
      // Only the first page-load join adopts the stored slide: every relaying
      // tab ignores relayed changes, including the echo of its own announce.
      if (state.synced) return;
      if (msg.talkId && state.talkId && msg.talkId !== state.talkId) return;
      const n = Number(msg.n);
      if (!Number.isInteger(n)) return;
      state.synced = true;
      clearTimeout(syncTimer);
      if (state.deck.length) {
        const index = state.deck.findIndex((slide) => slide.n === n);
        if (index >= 0) {
          state.index = index;
          render();
        }
      } else {
        state.pendingN = n; // the deck is still loading; apply it there
      }
      return;
    }
    if (msg.t === 'room_status') {
      if (msg.room !== undefined && String(msg.room) !== room) return;
      if (Number.isFinite(msg.listeners)) setListeners(msg.listeners);
      if (Number.isFinite(msg.openTickets)) setTickets(msg.openTickets);
    }
  },
});

refreshRoom();
setInterval(refreshRoom, 5000);
