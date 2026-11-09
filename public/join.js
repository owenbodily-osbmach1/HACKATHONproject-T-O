// Sign-in form served at /r/:room until this phone has signed in (server/signin.js).
// The server decides: after a successful POST /api/signin, reloading /r/:room serves the room.
const $ = (id) => document.getElementById(id);
const room = (location.pathname.match(/^\/r\/([^/?#]+)/)?.[1]) || '151';
const FIELDS = ['first', 'last', 'company', 'email'];
const EMAIL = /^[^\s@"<>,;:]+@[^\s@]+\.[A-Za-z]{2,}$/;

$('roomBadge').textContent = `Room ${decodeURIComponent(room)}`;
document.title = `Pulse · Join Room ${decodeURIComponent(room)}`;

// The talk title, so people know they scanned the right code (public info only).
fetch('/api/rooms').then((r) => r.json()).then((list) => {
  const r = list.find((x) => String(x.room) === decodeURIComponent(room));
  if (r?.title) $('talkTitle').textContent = `· ${r.title}`;
}).catch(() => {});

function setErr(field, text) {
  const input = $(field);
  $(`${field}Err`).textContent = text || '';
  if (text) input.setAttribute('aria-invalid', 'true');
  else input.removeAttribute('aria-invalid');
}

// Same rules as the server, so most mistakes show before sending. The server checks again.
function check() {
  const errs = {};
  const v = Object.fromEntries(FIELDS.map((f) => [f, $(f).value.replace(/\s+/g, ' ').trim()]));
  if (!v.first) errs.first = 'Enter your first name';
  if (!v.last) errs.last = 'Enter your last name';
  if (!v.company) errs.company = 'Enter your company or occupation';
  if (!v.email) errs.email = 'Enter your email address';
  else if (!EMAIL.test(v.email)) errs.email = 'That email address doesn’t look right';
  return { v, errs };
}

for (const f of FIELDS) $(f).addEventListener('input', () => { if ($(`${f}Err`).textContent) setErr(f, ''); });

$('joinForm').onsubmit = async (e) => {
  e.preventDefault();
  const { v, errs } = check();
  FIELDS.forEach((f) => setErr(f, errs[f]));
  const firstBad = FIELDS.find((f) => errs[f]);
  if (firstBad) { $(firstBad).focus(); return; }

  $('joinBtn').disabled = true;
  $('joinMsg').textContent = 'Joining…';
  try {
    const res = await fetch('/api/signin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ room: decodeURIComponent(room), ...v }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      $('joinMsg').textContent = 'You’re in. Opening the room…';
      location.replace(`/r/${room}`); // the server now serves the room
      return;
    }
    if (res.status === 400 && body.fields) {
      FIELDS.forEach((f) => setErr(f, body.fields[f]));
      $(FIELDS.find((f) => body.fields[f]) || 'first').focus();
      $('joinMsg').textContent = '';
    } else {
      $('joinMsg').textContent = body.message || 'Couldn’t join. Check your connection and try again.';
    }
  } catch {
    $('joinMsg').textContent = 'Couldn’t join. Check your connection and try again.';
  }
  $('joinBtn').disabled = false;
};
