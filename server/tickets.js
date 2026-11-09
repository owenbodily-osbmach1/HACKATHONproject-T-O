// Votes -> tickets, feedback, config, room_status ticks (CONTRACT.md).
// Interface: register(app, ctx), openTickets(room) -> number.
const crypto = require('crypto');
const audio = require('./audio');
const otel = require('./otel');
const log = require('./log');

const VOTE_TTL_MS = 10 * 60 * 1000;
const REOPEN_MS = 2 * 60 * 1000;
const ACTIVE = new Set(['open', 'claimed', 'reopened']);
const LIFECYCLE = { claimed: 'claim', fixed: 'fix', dismissed: 'dismiss' };

const votes = new Map(); // room|talkId|type|clientId -> {room, talkId, type, clientId, ts}
const tickets = new Map(); // id -> ticket
const feedback = new Map(); // ticketId -> Map(clientId -> better)

let ctx = null;
let alertThreshold = 3;
let ticker = null;

let mOpened = null;
let mTimeToFix = null;
let mTimeToAck = null;
let mVotes = null;

const ticketAttrs = (ticket) => ({
  'pulse.ticket.id': ticket.id,
  'pulse.room': ticket.room,
  'pulse.signal.type': ticket.type,
  'pulse.ticket.people': ticket.people,
});

// One span per lifecycle change; synchronous so the vote/action path never waits.
function lifecycle(action, ticket, fn) {
  return otel.span(`pulse.ticket.${action}`, ticketAttrs(ticket), fn);
}

function secondsSince(iso, now) {
  const start = Date.parse(iso);
  return Number.isFinite(start) ? Math.max(0, (now - start) / 1000) : null;
}

const windowMs = () => {
  const sec = Number(ctx && ctx.config && ctx.config.ALERT_WINDOW_SEC);
  return (Number.isFinite(sec) ? sec : 60) * 1000;
};

const voteKey = (room, talkId, type, clientId) => [room, talkId, type, clientId].join('|');

// Pure counting helper: distinct clientIds with a vote younger than the TTL,
// optionally limited to a room/talk/type and a shorter window.
function countDistinct(records, now, { room, talkId, type, windowMs: within } = {}) {
  const seen = new Set();
  for (const v of records) {
    const age = now - v.ts;
    if (age >= VOTE_TTL_MS) continue;
    if (within != null && age > within) continue;
    if (room != null && v.room !== room) continue;
    if (talkId != null && v.talkId !== talkId) continue;
    if (type != null && v.type !== type) continue;
    seen.add(v.clientId);
  }
  return seen.size;
}

function countFor(room, talkId, type, now, within) {
  return countDistinct(votes.values(), now, { room, talkId, type, windowMs: within });
}

function pruneVotes(now) {
  for (const [key, vote] of votes) if (now - vote.ts >= VOTE_TTL_MS) votes.delete(key);
}

function openTickets(room) {
  const id = String(room);
  let n = 0;
  for (const ticket of tickets.values()) if (ticket.room === id && ACTIVE.has(ticket.status)) n += 1;
  return n;
}

function activeTicket(room, type) {
  for (const ticket of tickets.values()) {
    if (ticket.room === room && ticket.type === type && ACTIVE.has(ticket.status)) return ticket;
  }
  return null;
}

function recentFixed(room, type, now) {
  let best = null;
  for (const ticket of tickets.values()) {
    if (ticket.room !== room || ticket.type !== type || ticket.status !== 'fixed') continue;
    const at = Date.parse(ticket.fixedAt);
    if (!Number.isFinite(at) || now - at > REOPEN_MS) continue;
    if (!best || at > Date.parse(best.fixedAt)) best = ticket;
  }
  return best;
}

function latestMicDb(room) {
  try {
    let db = audio.micDb(room);
    // The seeded demo room (server/mockroom.js) has no real mic: it writes a fake level on the room.
    const r = ctx && ctx.state && ctx.state.rooms.get(String(room));
    if (!Number.isFinite(db) && r && r.simulated) db = r.micDb;
    return Number.isFinite(db) ? db : null;
  } catch (_) {
    return null;
  }
}

function likelyCause(type, room) {
  if (type === 'cant_hear') {
    const db = latestMicDb(room);
    if (db === null || db < -50) {
      return {
        cause: 'Mic is silent or muted',
        steps: ['Check the mic mute switch / battery', 'Check the mixer channel fader'],
      };
    }
    return {
      cause: 'Room level too low',
      steps: ['Raise the room speakers 3 dB', 'Ask the speaker to move closer to the mic'],
    };
  }
  return {
    cause: 'Slides hard to read',
    steps: ['Check projector focus/brightness', 'Ask the speaker to zoom in'],
  };
}

function minuteFor(talkId, ts) {
  const talks = ctx && ctx.state && ctx.state.talks;
  if (!talks || typeof talks.get !== 'function') return 0;
  const talk = talks.get(String(talkId));
  const start = talk && (typeof talk.start === 'number' ? talk.start : Date.parse(talk.start));
  return Number.isFinite(start) ? Math.max(0, Math.floor((ts - start) / 60000)) : 0;
}

function liveTalk(room) {
  if (!ctx || !ctx.state) return null;
  if (typeof ctx.state.liveTalk === 'function') return ctx.state.liveTalk(room);
  const stateRoom = ctx.state.rooms && ctx.state.rooms.get(String(room));
  const talkId = stateRoom && stateRoom.talkId;
  const talk = talkId && ctx.state.talks && ctx.state.talks.get(talkId);
  return talk && !talk.end ? talk : null;
}

// Elasticsearch is fire-and-forget: never awaited and never allowed to throw here.
function index(name, doc) {
  if (!ctx || !ctx.es || typeof ctx.es.index !== 'function') return;
  try {
    const pending = ctx.es.index(name, doc);
    if (pending && typeof pending.catch === 'function') pending.catch(() => {});
  } catch (_) {}
}

// The same anonymous rows kept in memory (capped), so the post-talk report has "signals by minute"
// without Elasticsearch too (it showed 0 signals for a talk with a raised and fixed ticket).
const signalLog = new Map(); // talkId -> [{type, clientId, on, ts, minute}]
function memorySignals(talkId) { return signalLog.get(String(talkId)) || []; }

function indexSignal(vote, on, now) {
  let rows = signalLog.get(vote.talkId);
  if (!rows) signalLog.set(vote.talkId, (rows = []));
  rows.push({ type: vote.type, clientId: vote.clientId, on, ts: now, minute: minuteFor(vote.talkId, now) });
  if (rows.length > 20000) rows.shift();
  index('pulse-signals', {
    talkId: vote.talkId,
    room: vote.room,
    type: vote.type,
    clientId: vote.clientId,
    on,
    ts: new Date(now).toISOString(),
    minute: minuteFor(vote.talkId, now),
  });
}

function ticketDoc(ticket) {
  return {
    id: ticket.id,
    room: ticket.room,
    talkId: ticket.talkId,
    type: ticket.type,
    status: ticket.status,
    people: ticket.people,
    openedAt: ticket.openedAt,
    ackAt: ticket.ackAt || null,
    fixedAt: ticket.fixedAt || null,
    better: ticket.better,
    stillBad: ticket.stillBad,
  };
}

function ticketMessage(ticket) {
  return {
    t: 'ticket',
    id: ticket.id,
    room: ticket.room,
    talkId: ticket.talkId,
    type: ticket.type,
    people: ticket.people,
    status: ticket.status,
    openedAt: ticket.openedAt,
    reopenedAt: ticket.reopenedAt || null,
    cause: ticket.cause,
    steps: ticket.steps,
    // Console only (tech/org sockets). The tech's name never goes to Elasticsearch (ticketDoc).
    claimedBy: ticket.claimedBy || null,
    fixedBy: ticket.fixedBy || null,
    fixedAt: ticket.fixedAt || null,
    better: ticket.better || 0,
    stillBad: ticket.stillBad || 0,
  };
}

// /org has no key: it gets the ticket without the techs' names (aggregate status only).
function orgTicketMessage(ticket) {
  const { claimedBy, fixedBy, ...rest } = ticketMessage(ticket);
  return rest;
}

function ticketChanged(ticket, statusChanged = true) {
  index('pulse-tickets', ticketDoc(ticket));
  if (!ctx || !ctx.hub) return;
  ctx.hub.send(ticket.room, ticketMessage(ticket), ['tech']);
  ctx.hub.send(ticket.room, orgTicketMessage(ticket), ['org']);
  if (!statusChanged) return; // 300 phones x every vote was 179,400 messages for one burst
  ctx.hub.send(
    ticket.room,
    { t: 'ticket_status', ticketId: ticket.id, type: ticket.type, status: ticket.status },
    ['attendee']
  );
}

function createTicket(room, talkId, type, people, now) {
  const details = likelyCause(type, room);
  const ticket = {
    id: crypto.randomUUID(),
    room,
    talkId,
    type,
    people,
    status: 'open',
    openedAt: new Date(now).toISOString(),
    ackAt: null,
    fixedAt: null,
    cause: details.cause,
    steps: details.steps,
    better: 0,
    stillBad: 0,
  };
  tickets.set(ticket.id, ticket);
  if (mOpened) mOpened.add(1, { 'pulse.room': ticket.room, 'pulse.signal.type': ticket.type });
  log.info('ticket.opened', {
    room: ticket.room, talkId: ticket.talkId, ticketId: ticket.id, type: ticket.type, people: ticket.people,
  });
  return ticket;
}

// Re-evaluate the open ticket (if any) for this room+type after a vote change.
// Creation/reopening only happens when a vote was added.
function refreshTicket(room, talkId, type, allowCreate) {
  const now = Date.now();
  const people = countFor(room, talkId || null, type, now, VOTE_TTL_MS); // everyone with an active vote in this talk
  const recent = countFor(room, talkId || null, type, now, windowMs()); // threshold uses the alert window
  const active = activeTicket(room, type);
  if (active) {
    if (active.people !== people) {
      active.people = people;
      ticketChanged(active, false);
    }
    return active;
  }
  if (!allowCreate || recent < alertThreshold) return null;

  const prior = recentFixed(room, type, now);
  if (prior) {
    const details = likelyCause(type, room);
    prior.status = 'reopened';
    prior.reopenedAt = new Date(now).toISOString();
    prior.talkId = talkId;
    prior.people = people;
    prior.cause = details.cause;
    prior.steps = details.steps;
    log.info('ticket.reopened', {
      room: prior.room, talkId: prior.talkId, ticketId: prior.id, type: prior.type, people: prior.people,
    });
    lifecycle('reopen', prior, () => ticketChanged(prior));
    return prior;
  }

  const ticket = createTicket(room, talkId, type, people, now);
  lifecycle('open', ticket, () => ticketChanged(ticket));
  return ticket;
}

function clearVotes(room, type) {
  for (const [key, vote] of votes) {
    if (vote.room === room && vote.type === type) votes.delete(key);
  }
}

function configBody() {
  return {
    alertThreshold,
    nudgeThreshold: Math.max(1, alertThreshold - 1),
    publicBaseUrl: require('./config').PUBLIC_BASE_URL,
  };
}

// One vote_count per room+type every 300 ms at most: a burst of votes at 300 phones otherwise
// sends every phone a message per vote and pins the CPU (chaos test: p95 1.5 s, captions 1 s late).
const pendingCounts = new Map(); // room|type -> timer
function sendVoteCount(room, talkId, type) {
  const key = `${room}|${type}`;
  if (pendingCounts.has(key)) return;
  pendingCounts.set(key, setTimeout(() => {
    pendingCounts.delete(key);
    const count = countFor(room, talkId, type, Date.now());
    ctx.hub.send(room, { t: 'vote_count', type, count, windowSec: Math.round(windowMs() / 1000) }, ['attendee']);
  }, 300));
}

function register(app, context) {
  ctx = context;
  const configured = Number(ctx && ctx.config && ctx.config.ALERT_THRESHOLD);
  if (Number.isFinite(configured) && configured >= 1) alertThreshold = Math.floor(configured);

  mOpened = otel.counter('pulse.tickets.opened', 'Tickets opened', '{ticket}');
  mVotes = otel.counter('pulse.votes', 'Votes added or retracted', '{vote}');
  // Seconds, so the ms-sized default bounds would swallow every real ack/fix interval.
  const avBuckets = { explicitBucketBoundaries: [5, 15, 30, 45, 60, 120, 300, 600] };
  mTimeToFix = otel.histogram('pulse.ticket.time_to_fix', 'Seconds from open (or reopen) to fixed', 's', avBuckets);
  mTimeToAck = otel.histogram('pulse.ticket.time_to_ack', 'Seconds from open to claimed', 's', avBuckets);

  otel.observableGauge('pulse.listeners', 'Open attendee sockets per room', () => {
    if (!ctx || !ctx.state || !ctx.state.rooms || !ctx.hub) return [];
    const points = [];
    for (const room of ctx.state.rooms.values()) {
      const id = room && room.room != null ? String(room.room) : String(room);
      points.push({ value: ctx.hub.listeners(id), attributes: { 'pulse.room': id } });
    }
    return points;
  });

  otel.observableGauge('pulse.rooms.alerting', 'Rooms with an active ticket', () => {
    const activeRooms = new Set();
    for (const ticket of tickets.values()) if (ACTIVE.has(ticket.status)) activeRooms.add(ticket.room);
    return activeRooms.size;
  });

  app.put('/api/votes', (req, res) => {
    const body = req.body || {};
    const room = String(body.room || '');
    const talkId = String(body.talkId || '');
    const clientId = String(body.clientId || '');
    const type = body.type;
    if (type !== 'cant_hear' && type !== 'cant_see') {
      return res.status(400).json({ error: 'type must be cant_hear or cant_see' });
    }
    if (!room || !talkId || !clientId) {
      return res.status(400).json({ error: 'room, talkId and clientId are required' });
    }
    const live = liveTalk(room);
    if (!live) return res.status(409).json({ error: 'no_live_talk' });
    // Votes belong to the live talk only (contract audit): a stale page gets told to refresh.
    if (talkId !== live.talkId) return res.status(409).json({ error: 'stale_talk', talkId: live.talkId });

    const now = Date.now();
    pruneVotes(now);
    const key = voteKey(room, talkId, type, clientId);
    const existing = votes.get(key);

    if (body.on === false) {
      if (existing) {
        votes.delete(key);
        if (mVotes) mVotes.add(1, { 'pulse.signal.type': type, 'pulse.vote.on': false });
        indexSignal(existing, false, now);
      }
    } else if (!existing) {
      const vote = { room, talkId, type, clientId, ts: now };
      votes.set(key, vote);
      if (mVotes) mVotes.add(1, { 'pulse.signal.type': type, 'pulse.vote.on': true });
      indexSignal(vote, true, now);
    }

    const count = countFor(room, talkId, type, now);
    sendVoteCount(room, talkId, type);

    const ticket = refreshTicket(room, talkId, type, body.on !== false);
    res.json({ count, ticketStatus: ticket && ACTIVE.has(ticket.status) ? ticket.status : null });
  });

  const tech = ctx.auth.api('TECH_KEY');
  const techName = (v) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40) || null;
  const action = (status) => (req, res) => {
    const ticket = tickets.get(String(req.params.id));
    if (!ticket) return res.status(404).json({ error: 'not found' });
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    // A repeated claim/fixed (double-click, retry) changes nothing and records no second latency sample.
    if (ticket.status === status) return res.json({ status: ticket.status });
    ticket.status = status;
    const attrs = { 'pulse.room': ticket.room, 'pulse.signal.type': ticket.type };
    if (status === 'claimed') {
      ticket.claimedBy = techName(req.body && req.body.by);
      ticket.ackAt = now;
      const sec = secondsSince(ticket.reopenedAt || ticket.openedAt, nowMs); // same base as time_to_fix
      if (mTimeToAck && sec !== null) mTimeToAck.record(sec, attrs);
      log.info('ticket.claimed', {
        room: ticket.room, talkId: ticket.talkId, ticketId: ticket.id, type: ticket.type, people: ticket.people,
      });
    }
    if (status === 'fixed') {
      ticket.fixedBy = techName(req.body && req.body.by) || ticket.claimedBy || null;
      ticket.better = 0;
      ticket.stillBad = 0;
      feedback.delete(ticket.id); // a new round of "Better now?" for this fix
      ticket.fixedAt = now;
      const sec = secondsSince(ticket.reopenedAt || ticket.openedAt, nowMs);
      if (mTimeToFix && sec !== null) mTimeToFix.record(sec, attrs);
      clearVotes(ticket.room, ticket.type);
      log.info('ticket.fixed', {
        room: ticket.room, talkId: ticket.talkId, ticketId: ticket.id, type: ticket.type, people: ticket.people,
      });
    }
    lifecycle(LIFECYCLE[status] || status, ticket, () => ticketChanged(ticket));
    res.json({ status: ticket.status });
  };

  app.post('/api/tickets/:id/claim', tech, action('claimed'));
  app.post('/api/tickets/:id/fixed', tech, action('fixed'));
  app.post('/api/tickets/:id/dismiss', tech, action('dismissed'));

  app.post('/api/feedback', (req, res) => {
    const body = req.body || {};
    const ticket = tickets.get(String(body.ticketId || ''));
    if (!ticket) return res.status(404).json({ error: 'not found' });
    if (!body.clientId || typeof body.better !== 'boolean') {
      return res.status(400).json({ error: 'clientId and better are required' });
    }
    let tally = feedback.get(ticket.id);
    if (!tally) {
      tally = new Map();
      feedback.set(ticket.id, tally);
    }
    tally.set(String(body.clientId), body.better);
    let better = 0;
    let stillBad = 0;
    for (const value of tally.values()) value ? better++ : stillBad++;
    ticket.better = better;
    ticket.stillBad = stillBad;
    index('pulse-tickets', ticketDoc(ticket));
    if (ctx.hub) ctx.hub.send(ticket.room, ticketMessage(ticket), ['tech']); // the AV console shows the answers live
    res.json({ better, stillBad });
  });

  app.get('/api/config', (req, res) => res.json(configBody()));

  app.post('/api/config', tech, (req, res) => {
    const value = Number(req.body && req.body.alertThreshold);
    if (!Number.isInteger(value) || value < 1) {
      return res.status(400).json({ error: 'alertThreshold must be a positive integer' });
    }
    alertThreshold = value;
    res.json(configBody());
  });

  clearInterval(ticker);
  ticker = setInterval(() => {
    if (!ctx || !ctx.state || !ctx.state.rooms || !ctx.hub) return;
    const now = Date.now();
    pruneVotes(now);
    for (const room of ctx.state.rooms.values()) {
      const id = room && room.room != null ? String(room.room) : String(room);
      const listeners = ctx.hub.listeners(id); // sent even at 0 so the mic page can show "0 phones"
      const last = room && Number(room.lastCaptionTs);
      const gap = Number.isFinite(last) && last > 0 ? Math.max(0, Math.floor((now - last) / 1000)) : null;
      ctx.hub.send(
        id,
        {
          t: 'room_status',
          room: id,
          listeners,
          micDb: latestMicDb(id),
          captionGapSec: gap,
          openTickets: openTickets(id),
        },
        ['tech', 'org', 'mic']
      );
    }
  }, 2000);
  if (ticker.unref) ticker.unref();
}

// Snapshot for a tech/org socket that joins mid-talk.
// justFixed: AV consoles only (org's dashboard would count the same fix again).
// org: the unkeyed /org page gets tickets without the techs' names.
function activeTicketMessages(room, { justFixed: withFixed = false, org = false } = {}) {
  const id = String(room);
  const out = [];
  const now = Date.now();
  for (const ticket of tickets.values()) {
    if (ticket.room !== id) continue;
    // Also tickets fixed in the last 3 min: a console opened after the fix still shows "Better now?" results.
    const justFixed = withFixed && ticket.status === 'fixed' && now - Date.parse(ticket.fixedAt || 0) < 180000;
    if (ACTIVE.has(ticket.status) || justFixed) out.push(org ? orgTicketMessage(ticket) : ticketMessage(ticket));
  }
  return out;
}

module.exports = {
  register,
  openTickets,
  activeTicketMessages,
  memorySignals,
  _test: { countDistinct, VOTE_TTL_MS, REOPEN_MS },
};
