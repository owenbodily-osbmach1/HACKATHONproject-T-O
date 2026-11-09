// Votes -> tickets, feedback, config, room_status ticks (CONTRACT.md).
// Interface: register(app, ctx), openTickets(room) -> number.
const crypto = require('crypto');
const audio = require('./audio');

const VOTE_TTL_MS = 10 * 60 * 1000;
const REOPEN_MS = 2 * 60 * 1000;
const ACTIVE = new Set(['open', 'claimed', 'reopened']);

const votes = new Map(); // room|talkId|type|clientId -> {room, talkId, type, clientId, ts}
const tickets = new Map(); // id -> ticket
const feedback = new Map(); // ticketId -> Map(clientId -> better)

let ctx = null;
let alertThreshold = 3;
let ticker = null;

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
    const db = audio.micDb(room);
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
  const start = talk && Date.parse(talk.start);
  return Number.isFinite(start) ? Math.max(0, Math.floor((ts - start) / 60000)) : 0;
}

// Elasticsearch is fire-and-forget: never awaited and never allowed to throw here.
function index(name, doc) {
  if (!ctx || !ctx.es || typeof ctx.es.index !== 'function') return;
  try {
    const pending = ctx.es.index(name, doc);
    if (pending && typeof pending.catch === 'function') pending.catch(() => {});
  } catch (_) {}
}

function indexSignal(vote, on, now) {
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
    cause: ticket.cause,
    steps: ticket.steps,
  };
}

function ticketChanged(ticket) {
  index('pulse-tickets', ticketDoc(ticket));
  if (!ctx || !ctx.hub) return;
  ctx.hub.send(ticket.room, ticketMessage(ticket), ['tech', 'org']);
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
  return ticket;
}

// Re-evaluate the open ticket (if any) for this room+type after a vote change.
// Creation/reopening only happens when a vote was added.
function refreshTicket(room, talkId, type, allowCreate) {
  const now = Date.now();
  const people = countFor(room, null, type, now, windowMs());
  const active = activeTicket(room, type);
  if (active) {
    if (active.people !== people) {
      active.people = people;
      ticketChanged(active);
    }
    return active;
  }
  if (!allowCreate || people < alertThreshold) return null;

  const prior = recentFixed(room, type, now);
  if (prior) {
    const details = likelyCause(type, room);
    prior.status = 'reopened';
    prior.talkId = talkId;
    prior.people = people;
    prior.cause = details.cause;
    prior.steps = details.steps;
    ticketChanged(prior);
    return prior;
  }

  const ticket = createTicket(room, talkId, type, people, now);
  ticketChanged(ticket);
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

function register(app, context) {
  ctx = context;
  const configured = Number(ctx && ctx.config && ctx.config.ALERT_THRESHOLD);
  if (Number.isFinite(configured) && configured >= 1) alertThreshold = Math.floor(configured);

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

    const now = Date.now();
    pruneVotes(now);
    const key = voteKey(room, talkId, type, clientId);
    const existing = votes.get(key);

    if (body.on === false) {
      if (existing) {
        votes.delete(key);
        indexSignal(existing, false, now);
      }
    } else if (!existing) {
      const vote = { room, talkId, type, clientId, ts: now };
      votes.set(key, vote);
      indexSignal(vote, true, now);
    }

    const count = countFor(room, talkId, type, now);
    ctx.hub.send(
      room,
      { t: 'vote_count', type, count, windowSec: Math.round(windowMs() / 1000) },
      ['attendee']
    );

    const ticket = refreshTicket(room, talkId, type, body.on !== false);
    res.json({ count, ticketStatus: ticket && ACTIVE.has(ticket.status) ? ticket.status : null });
  });

  const tech = ctx.auth.api('TECH_KEY');
  const action = (status) => (req, res) => {
    const ticket = tickets.get(String(req.params.id));
    if (!ticket) return res.status(404).json({ error: 'not found' });
    const now = new Date().toISOString();
    ticket.status = status;
    if (status === 'claimed') ticket.ackAt = now;
    if (status === 'fixed') {
      ticket.fixedAt = now;
      clearVotes(ticket.room, ticket.type);
    }
    ticketChanged(ticket);
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
function activeTicketMessages(room) {
  const id = String(room);
  const out = [];
  for (const ticket of tickets.values()) if (ticket.room === id && ACTIVE.has(ticket.status)) out.push(ticketMessage(ticket));
  return out;
}

module.exports = {
  register,
  openTickets,
  activeTicketMessages,
  _test: { countDistinct, VOTE_TTL_MS, REOPEN_MS },
};
