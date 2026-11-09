// Sign-in before joining a room (CONTRACT.md "Sign-in").
//
// SIGNIN=on (default) | off. While on, a phone must sign in once (first name, last name,
// company / occupation, email) before it gets the room:
//   - GET /r/:room serves the form (public/join.html) until this phone's visitor cookie is signed in,
//     then the normal audience page. The server decides from its own records; the phone never says
//     "I'm signed in".
//   - The attendee WebSocket, listen-in audio, votes, questions and feedback are refused (403 /
//     close 4403) for a phone that hasn't signed in, so opening /r.html directly gets nothing.
// The visitor cookie is the one server/stats.js issues for scan counts (`pulse_v`), so a phone that
// signed in once is remembered (24 h) in every room, and scan / "here" counts stay unique.
//
// Privacy: sign-ins live in this process's memory only. They are never written to Elasticsearch,
// logs, OpenTelemetry or any attendee page, never put in a URL, and never linked to the anonymous
// `clientId` used for votes. The AV console (TECH_KEY) sees a count and can export a CSV.
// A restart clears them: export before stopping the server.
const crypto = require('crypto');
const stats = require('./stats');

const ENABLED = String(process.env.SIGNIN || 'on').toLowerCase() !== 'off';
const people = new Map(); // visitor id -> {first, last, company, email, at, rooms: Set}
const tries = new Map(); // visitor id -> [ts] of recent submissions (rate limit)
const MAX_PEOPLE = 50000;
const EMAIL = /^[^\s@"<>,;:]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,24}$/;

let ctx = null;
// The demo room seeds votes and questions through the HTTP routes from inside this process.
const INTERNAL = crypto.randomBytes(16).toString('hex');

// Trim, collapse spaces, drop control characters.
function clean(v, max) {
  const s = String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > max ? null : s;
}

function validate(body) {
  const b = body || {};
  const errors = {};
  const out = {};
  const fields = [
    ['first', 60, 'Enter your first name'],
    ['last', 60, 'Enter your last name'],
    ['company', 100, 'Enter your company or occupation'],
    ['email', 254, 'Enter your email address'],
  ];
  for (const [k, max, msg] of fields) {
    const v = clean(b[k], max);
    if (v === null) errors[k] = `Keep it under ${max} characters`;
    else if (!v) errors[k] = msg;
    else out[k] = v;
  }
  if (out.email && !EMAIL.test(out.email)) errors.email = 'That email address doesn’t look right';
  if (out.email) out.email = out.email.toLowerCase();
  return { ok: !Object.keys(errors).length, errors, value: out };
}

const signedIn = (vid) => !!vid && people.has(vid);

// For WebSocket upgrades (no Express req): read the visitor cookie from the raw request.
function allowSocket(req) {
  if (!ENABLED) return true;
  return signedIn(stats.visitorFromHeaders(req.headers));
}

// Sign-ins in a room: real ones plus the demo room's seeded audience.
function countFor(room) {
  let n = 0;
  for (const p of people.values()) if (p.rooms.has(room)) n++;
  const r = ctx && ctx.state.rooms.get(room);
  if (r && r.simulated && r.sim) n += r.sim.joined || 0;
  return n;
}

// Fictional people for the demo room's seeded crowd (example.com addresses, marked "demo").
const FIRST = ['Ava', 'Ben', 'Chloe', 'Diego', 'Emma', 'Farah', 'Gabe', 'Hana', 'Ivan', 'Jade', 'Kofi', 'Lena', 'Marco', 'Nina', 'Omar', 'Priya', 'Quinn', 'Rosa', 'Sam', 'Tara', 'Umar', 'Vera', 'Wes', 'Yuki', 'Zoe'];
const LAST = ['Adams', 'Brooks', 'Chen', 'Diaz', 'Evans', 'Fischer', 'Garcia', 'Hughes', 'Ito', 'Jensen', 'Khan', 'Lopez', 'Murphy', 'Nakamura', 'Okafor', 'Patel', 'Reyes', 'Silva', 'Tanaka', 'Vargas', 'Walsh', 'Young'];
const WORK = ['Platform engineer', 'SRE', 'DevOps lead', 'Software engineer', 'Engineering manager', 'Cloud architect', 'Developer advocate', 'Security engineer', 'Student', 'CTO'];
function demoRow(i) {
  const first = FIRST[(i * 7) % FIRST.length];
  const last = LAST[(i * 11 + 3) % LAST.length];
  return { first, last, company: WORK[(i * 5) % WORK.length], email: `${first}.${last}${i}@example.com`.toLowerCase(), at: null, source: 'demo' };
}

function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // spreadsheet formula injection
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function rowsFor(room) {
  const rows = [];
  for (const p of people.values()) {
    if (p.rooms.has(room)) rows.push({ first: p.first, last: p.last, company: p.company, email: p.email, at: new Date(p.at).toISOString(), source: 'phone' });
  }
  const r = ctx.state.rooms.get(room);
  if (r && r.simulated && r.sim) for (let i = 0; i < (r.sim.joined || 0); i++) rows.push(demoRow(i));
  return rows;
}

module.exports = {
  enabled: ENABLED,
  INTERNAL,
  allowSocket,
  countFor,

  // GET /r/:room, after stats.scan: the form until this visitor has signed in.
  gate(req, res, next) {
    res.setHeader('Cache-Control', 'no-store'); // the same URL serves the form, then the room
    if (!ENABLED) return next();
    const vid = res.locals.vid;
    const p = vid && people.get(vid);
    if (p) { p.rooms.add(String(req.params.room)); return next(); }
    res.sendFile(require('path').join(__dirname, '..', 'public', 'join.html'));
  },

  register(app, c) {
    ctx = c;
    // Votes, questions and feedback need a signed-in phone. Before the routes that handle them.
    const guard = (req, res, next) => {
      if (!ENABLED || signedIn(stats.visitorFromHeaders(req.headers)) || req.get('x-pulse-internal') === INTERNAL) return next();
      res.status(403).json({ error: 'signin_required' });
    };
    app.put('/api/votes', guard);
    app.post('/api/questions', guard);
    app.post('/api/feedback', guard);

    app.post('/api/signin', (req, res) => {
      if (!ENABLED) return res.json({ ok: true });
      const vid = stats.visitorFromHeaders(req.headers);
      if (!vid) return res.status(400).json({ error: 'no_visitor', message: 'Open the room link (scan the QR code) first.' });
      const now = Date.now();
      const recent = (tries.get(vid) || []).filter((t) => now - t < 60000);
      if (recent.length >= 10) return res.status(429).json({ error: 'too_many', message: 'Too many tries. Wait a minute and try again.' });
      recent.push(now);
      tries.set(vid, recent);
      const room = clean(req.body && req.body.room, 64) || '';
      const { ok, errors, value } = validate(req.body);
      if (!ok) return res.status(400).json({ error: 'invalid', fields: errors });
      const prev = people.get(vid);
      if (!prev && people.size >= MAX_PEOPLE) return res.status(503).json({ error: 'full', message: 'Sign-in is full right now.' });
      const p = { ...value, at: prev ? prev.at : now, rooms: prev ? prev.rooms : new Set() };
      if (room) p.rooms.add(room);
      people.set(vid, p);
      if (room) ctx.hub.send(room, stats.statsMessage(room)); // counts move right away
      res.json({ ok: true });
    });

    // AV / host only. JSON count, or the full list as CSV for the organizers.
    app.get('/api/rooms/:room/signins', ctx.auth.api('TECH_KEY'), (req, res) => {
      const room = String(req.params.room);
      if (req.query.format !== 'csv') return res.json({ room, count: countFor(room), enabled: ENABLED });
      const head = ['first_name', 'last_name', 'company_or_occupation', 'email', 'signed_in_at', 'source'];
      const lines = [head.join(',')].concat(rowsFor(room).map((r) => [r.first, r.last, r.company, r.email, r.at || '', r.source].map(csvCell).join(',')));
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Disposition', `attachment; filename="pulse-room-${room.replace(/[^A-Za-z0-9_-]/g, '')}-signins.csv"`);
      res.type('text/csv').send(lines.join('\r\n') + '\r\n');
    });
  },

  _test: { validate, csvCell },
};
