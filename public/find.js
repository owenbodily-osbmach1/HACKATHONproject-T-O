// Find the right talk (/find): schedule search + what speakers said + next talks from what you heard.
// Public page: no keys, no microphone.
import { getClientId } from '/lib/store.js';

const $ = (id) => document.getElementById(id);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const clientId = getClientId();
let searchSeq = 0;

// The schedule is printed in venue wall-clock time, so show its own components.
function fmtStart(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(value || ''));
  if (!m) return String(value || '');
  const month = MONTHS[Number(m[2]) - 1] || m[2];
  return `${month} ${Number(m[3])}, ${m[4]}:${m[5]}`;
}

function fmtLocation(value) {
  const text = String(value || '');
  return /^\d+$/.test(text) ? `Booth ${text}` : text;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function clear(node) {
  node.replaceChildren();
}

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function renderNext(rows) {
  const list = $('nextList');
  clear(list);
  if (!Array.isArray(rows) || !rows.length) {
    $('nextNote').textContent = 'No upcoming sessions found.';
    return;
  }
  const withBecause = rows.filter((row) => row && row.because).length;
  $('nextNote').textContent = withBecause
    ? 'Based on the captions this device heard.'
    : 'You have not heard a talk yet, so these start soon.';

  for (const row of rows) {
    if (!row || !row.id) continue;
    const item = el('li', 'find-next-item');
    const title = el('h3', 'find-title', row.title || `Talk ${row.id}`);
    const when = el('p', 'find-when');
    when.append(el('span', null, fmtStart(row.start)), el('span', 'find-loc', fmtLocation(row.location)));
    item.append(title, when);
    if (row.because) {
      item.append(el('p', 'find-because', `Because you heard: “${row.because}”`));
    }
    list.append(item);
  }
}

async function loadNext() {
  try {
    const rows = await getJson(`/api/find/next?clientId=${encodeURIComponent(clientId)}&limit=3`);
    renderNext(rows);
  } catch {
    $('nextNote').textContent = 'Could not load suggestions right now.';
  }
}

function sessionItem(hit) {
  const item = el('li', 'find-item');
  const when = el('p', 'find-when');
  when.append(el('span', null, fmtStart(hit.start)), el('span', 'find-loc', fmtLocation(hit.location)));
  const title = el('h3', 'find-title', hit.title || `Session ${hit.id}`);
  item.append(when, title);
  if (hit.why) item.append(el('p', 'find-why', hit.why));
  return item;
}

function saidItem(hit) {
  const item = el('li', 'find-item');
  const href = `/t/${encodeURIComponent(hit.talkId)}` +
    (Number.isInteger(hit.seq) ? `#seq-${hit.seq}` : '');
  item.append(el('h3', 'find-title', hit.title || `Talk ${hit.talkId}`));
  const link = el('a', 'find-quote', `“${hit.text || ''}”`);
  link.href = href;
  item.append(link);
  return item;
}

function showSections() {
  $('sessionSection').hidden = false;
  $('saidSection').hidden = false;
}

function renderResults(data) {
  const sessions = Array.isArray(data && data.sessions) ? data.sessions : [];
  const said = Array.isArray(data && data.said) ? data.said : [];

  const sessionList = $('sessionList');
  clear(sessionList);
  for (const hit of sessions) if (hit && hit.id) sessionList.append(sessionItem(hit));
  $('sessionEmpty').hidden = sessions.length > 0;

  const saidList = $('saidList');
  clear(saidList);
  for (const hit of said) if (hit && hit.talkId) saidList.append(saidItem(hit));
  $('saidEmpty').hidden = said.length > 0;

  showSections();
  $('formNote').textContent = `${sessions.length} upcoming session${sessions.length === 1 ? '' : 's'} · ` +
    `${said.length} caption hit${said.length === 1 ? '' : 's'}`;
}

async function search(q) {
  const seq = ++searchSeq;
  $('findBtn').disabled = true;
  $('formNote').textContent = 'Searching…';
  try {
    const data = await getJson(`/api/find?q=${encodeURIComponent(q)}&limit=10`);
    if (seq !== searchSeq) return;
    renderResults(data);
  } catch {
    if (seq !== searchSeq) return;
    $('formNote').textContent = 'Search failed. Try again.';
  } finally {
    if (seq === searchSeq) $('findBtn').disabled = false;
  }
}

$('findForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const q = $('q').value.trim();
  if (!q) {
    $('formNote').textContent = 'Type a topic first.';
    return;
  }
  search(q);
});

loadNext();
