// Printable QR cards (/cards). Names come from /api/rooms and /api/booths; the QR is drawn
// with the vendored UMD library (window.qrcode), so no network call and no build step.
const cardsEl = document.getElementById('cards');
const statusEl = document.getElementById('cardsStatus');
const seen = new Set();
const VALID_ID = /^[A-Za-z0-9_-]{1,32}$/;

function setStatus(text, error) {
  statusEl.textContent = text;
  if (error) statusEl.dataset.error = 'true';
  else delete statusEl.dataset.error;
}

function cardUrl(kind, id) {
  return `${location.origin}/${kind === 'booth' ? 'b' : 'r'}/${encodeURIComponent(id)}`;
}

function renderQr(container, url, label) {
  if (!window.qrcode) {
    container.textContent = 'QR library did not load.';
    return;
  }
  const qr = window.qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  container.innerHTML = qr.createSvgTag({ cellSize: 8, margin: 4, scalable: true, alt: label });
}

function addCard(kind, id, name, sub) {
  if (!VALID_ID.test(String(id || ''))) return false;
  const key = `${kind}:${id}`;
  if (seen.has(key)) return false;
  seen.add(key);

  const url = cardUrl(kind, id);
  const card = document.createElement('article');
  card.className = 'card';

  const qr = document.createElement('div');
  qr.className = 'card-qr';
  renderQr(qr, url, `QR code for ${url}`);

  const kindLine = document.createElement('p');
  kindLine.className = 'card-kind';
  kindLine.textContent = kind === 'booth' ? 'Booth' : 'Room';

  const title = document.createElement('h2');
  title.className = 'card-name';
  title.textContent = name || id;

  const subLine = document.createElement('p');
  subLine.className = 'card-sub';
  subLine.textContent = sub || '';

  const urlLine = document.createElement('p');
  urlLine.className = 'card-url';
  urlLine.textContent = url.replace(/^https?:\/\//, '');

  const promise = document.createElement('p');
  promise.className = 'card-promise';
  promise.textContent = 'No app to install. Votes and questions are anonymous.';

  card.append(qr, kindLine, title, subLine, urlLine, promise);
  cardsEl.append(card);
  return true;
}

function updateCount() {
  const n = cardsEl.children.length;
  setStatus(`${n} card${n === 1 ? '' : 's'} ready. Print A4 or Letter: 2 cards per page.`);
}

async function load() {
  const results = await Promise.allSettled([
    fetch('/api/rooms').then((r) => (r.ok ? r.json() : [])),
    fetch('/api/booths').then((r) => (r.ok ? r.json() : [])),
  ]);

  const rooms = results[0].status === 'fulfilled' && Array.isArray(results[0].value) ? results[0].value : [];
  const booths = results[1].status === 'fulfilled' && Array.isArray(results[1].value) ? results[1].value : [];

  for (const room of rooms) {
    const id = String(room && room.room != null ? room.room : '');
    const title = typeof room.title === 'string' ? room.title : '';
    const speaker = typeof room.speaker === 'string' ? room.speaker : '';
    addCard('room', id, `Room ${id}`, speaker ? `${title} · ${speaker}` : title);
  }
  for (const booth of booths) {
    const id = String(booth && booth.id ? booth.id : '');
    const table = typeof booth.table === 'string' && booth.table ? `Table ${booth.table}` : '';
    addCard('booth', id, booth.sponsor || id, table);
  }

  updateCount();
  if (!cardsEl.children.length) setStatus('No rooms or booths are configured yet. Add a room id above.', true);
  else if (results.some((r) => r.status === 'rejected')) setStatus('Some cards loaded; the room or booth list could not be read.');
}

document.getElementById('addRoom').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = document.getElementById('roomId');
  const id = input.value.trim();
  if (!VALID_ID.test(id)) {
    setStatus('Room id must be 1–32 letters, numbers, - or _.', true);
    return;
  }
  if (!addCard('room', id, `Room ${id}`, '')) {
    setStatus(`Room ${id} is already on the sheet.`, true);
    return;
  }
  input.value = '';
  updateCount();
});

document.getElementById('printBtn').addEventListener('click', () => window.print());

load().catch(() => {
  setStatus('Could not load the room or booth list.', true);
});
