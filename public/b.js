// Attendee booth page /b/:booth. Never asks for the microphone (CONTRACT.md: Mic lock).
import { getClientId } from '/lib/store.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
let pathBooth = '';
try {
  pathBooth = decodeURIComponent(location.pathname.match(/^\/b\/([^/?#]+)/)?.[1] || '');
} catch { /* malformed path */ }
const boothId = pathBooth || params.get('booth') || params.get('room') || '';
const clientId = getClientId();

const state = { available: false };

function setConn(word, status) {
  $('conn').dataset.status = status;
  $('conn').querySelector('.conn-word').textContent = word;
}

// The booth API is new: a 404 means the service isn't deployed yet, not a bad QR code.
async function api(path, body, method = 'GET') {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 404) {
    const err = new Error('not-found');
    err.notFound = true;
    throw err;
  }
  if (!res.ok) throw new Error(String(res.status));
  return res.json().catch(() => ({}));
}

function tableText(table) {
  if (!table) return '';
  const text = String(table);
  return /^table\b/i.test(text) ? text : `Table ${text}`;
}

function showService(text) {
  state.available = false;
  $('serviceMsg').textContent = text;
  $('serviceMsg').hidden = false;
  for (const id of ['boothCard', 'passport', 'nextCard', 'nextNone', 'requests']) $(id).hidden = true;
  setConn('Offline', 'offline');
}

function renderInfo(info) {
  const sponsor = info.sponsor || boothId;
  $('sponsor').textContent = sponsor;
  $('tableLine').textContent = tableText(info.table) || 'Expo floor';
  $('pitch').textContent = info.pitch || '';
  $('pitch').hidden = !info.pitch;

  const resources = $('resources');
  if (info.resourcesUrl) {
    resources.href = info.resourcesUrl;
    resources.hidden = false;
  } else {
    resources.removeAttribute('href');
    resources.hidden = true;
  }
  $('demo').href = `/r/${encodeURIComponent(boothId)}`;
  $('boothCard').hidden = false;

  $('boothBadge').textContent = `Booth ${boothId}`;
  document.title = `Pulse · ${sponsor}`;
}

function renderStamps(stamps, total) {
  $('passportCount').textContent = `${stamps} of ${total} booths`;
  const list = $('stamps');
  const frag = document.createDocumentFragment();
  for (let i = 1; i <= total; i++) {
    const stamped = i <= stamps;
    const li = document.createElement('li');
    li.className = stamped ? 'stamp on' : 'stamp';
    li.textContent = stamped ? `${i} ✓` : String(i);
    li.setAttribute('aria-label', `Booth ${i}, ${stamped ? 'stamped' : 'not yet'}`);
    frag.append(li);
  }
  list.replaceChildren(frag);
  $('passport').hidden = false;
}

function renderNext(next) {
  if (next && next.id) {
    $('nextSponsor').textContent = next.sponsor || next.id;
    $('nextTable').textContent = tableText(next.table) || 'Expo floor';
    $('nextLink').href = `/b/${encodeURIComponent(next.id)}`;
    const because = $('nextBecause');
    if (next.because) {
      because.textContent = `Because you heard: “${next.because}”`;
      because.hidden = false;
    } else {
      because.textContent = '';
      because.hidden = true;
    }
    $('nextCard').hidden = false;
    $('nextNone').hidden = true;
  } else {
    $('nextCard').hidden = true;
    $('nextNone').hidden = false;
  }
}

function renderCheckin(checkin) {
  const stamps = Math.max(0, Number(checkin.stamps) || 0);
  const total = Math.max(stamps, Number(checkin.total) || 0);
  renderStamps(stamps, total);
  $('suspect').hidden = !checkin.suspect;
  renderNext(checkin.next);
  $('requests').hidden = false;
}

async function request(kind, btn, statusEl, successText) {
  if (!state.available || btn.disabled) return;
  btn.disabled = true;
  statusEl.textContent = 'Sending…';
  try {
    const r = await api(`/api/booths/${encodeURIComponent(boothId)}/requests`, { clientId, kind }, 'POST');
    const position = Number(r?.position);
    statusEl.textContent = kind === 'talk_to_engineer' && Number.isFinite(position) && position > 0
      ? `You're #${position} in line`
      : successText;
  } catch (e) {
    btn.disabled = false;
    if (e.notFound) {
      showService('Booth service not available. Ask the sponsor to flag down the AV crew.');
      return;
    }
    statusEl.textContent = "Couldn't send that. Try again.";
  }
}

async function load() {
  if (!boothId) {
    $('boothBadge').textContent = 'Booth';
    showService('This QR code is missing a booth id. Ask the sponsor for the right code.');
    return;
  }

  $('boothBadge').textContent = `Booth ${boothId}`;
  document.title = `Pulse · Booth ${boothId}`;
  setConn('Loading…', 'connecting');

  try {
    const [list, checkin] = await Promise.all([
      api('/api/booths'),
      api(`/api/booths/${encodeURIComponent(boothId)}/checkin`, { clientId }, 'POST'),
    ]);
    const fromList = Array.isArray(list) ? list.find((b) => b && String(b.id) === boothId) : null;
    const info = fromList || (checkin.booth && typeof checkin.booth === 'object' ? checkin.booth : { id: boothId });
    renderInfo(info);
    renderCheckin(checkin);
    $('serviceMsg').hidden = true;
    state.available = true;
    setConn('Ready', 'ready');
  } catch (e) {
    if (e.notFound) {
      showService('Booth service not available. Ask the sponsor to flag down the AV crew.');
    } else {
      showService("Booth service didn't answer. Pull down to reload.");
    }
  }
}

$('reqEngineer').addEventListener('click', () => request(
  'talk_to_engineer', $('reqEngineer'), $('reqEngineerStatus'), "You're in line",
));
$('reqResources').addEventListener('click', () => request(
  'send_resources', $('reqResources'), $('reqResourcesStatus'), "We'll send it",
));

load();
