// In-process check for votes -> tickets. Run: node scripts/tickets-check.js
const assert = require('assert');
const tickets = require('../server/tickets');

const { countDistinct, VOTE_TTL_MS } = tickets._test;

const talks = new Map([
  ['talk-1', { talkId: 'talk-1', room: '151', start: Date.now() - 60000, end: null }],
]);
const rooms = new Map([['151', { room: '151', talkId: 'talk-1', lastCaptionTs: Date.now() - 5000 }]]);
const sent = [];
const docs = [];
const routes = [];
const app = {};
for (const method of ['get', 'post', 'put']) {
  app[method] = (path, ...handlers) => routes.push({ method, path, handlers });
}

const ctx = {
  config: { ALERT_THRESHOLD: 3, ALERT_WINDOW_SEC: 60 },
  state: { rooms, talks },
  auth: {
    api: () => (req, res, next) =>
      req.get('x-pulse-key') === 'tech' ? next() : res.status(401).json({ error: 'unauthorized' }),
  },
  hub: {
    send(room, msg, roles) {
      sent.push({ room, msg, roles });
    },
    listeners: (room) => (room === '151' ? 2 : 0),
  },
  es: {
    index(index, doc) {
      docs.push({ index, doc });
    },
  },
};

tickets.register(app, ctx);

async function call(method, path, { body, key } = {}) {
  method = method.toLowerCase();
  for (const route of routes) {
    if (route.method !== method) continue;
    const names = [];
    const pattern = route.path.replace(/:([^/]+)/g, (_, name) => {
      names.push(name);
      return '([^/]+)';
    });
    const match = path.match(new RegExp(`^${pattern}$`));
    if (!match) continue;
    const params = {};
    names.forEach((name, i) => {
      params[name] = decodeURIComponent(match[i + 1]);
    });
    const req = {
      body,
      params,
      query: {},
      get: (name) => (name === 'x-pulse-key' ? key : undefined),
    };
    const res = {
      statusCode: 200,
      body: undefined,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(value) {
        this.body = value;
        return this;
      },
      send(value) {
        this.body = value;
        return this;
      },
      type() {
        return this;
      },
    };
    let i = 0;
    const next = async () => {
      const handler = route.handlers[i++];
      if (!handler) return;
      await handler(req, res, next);
    };
    await next();
    return res;
  }
  throw new Error(`no route ${method} ${path}`);
}

const vote = (clientId, type, on = true) =>
  call('PUT', '/api/votes', {
    body: { room: '151', talkId: 'talk-1', type, clientId, on },
  });

(async () => {
  let res = await vote('a', 'room_full');
  assert.equal(res.statusCode, 400, 'bad vote type is rejected');

  res = await vote('a', 'cant_hear');
  assert.deepEqual(res.body, { count: 1, ticketStatus: null });
  res = await vote('b', 'cant_hear');
  assert.equal(res.body.count, 2);
  res = await vote('c', 'cant_hear');
  assert.deepEqual(res.body, { count: 3, ticketStatus: 'open' });
  assert.equal(tickets.openTickets('151'), 1, 'one ticket per room+type');

  // The keyed console gets the full ticket; the unkeyed /org page a copy without the techs' names.
  const opened = sent.filter((x) => x.msg.t === 'ticket' && x.msg.type === 'cant_hear' && x.roles.includes('tech'));
  assert.equal(opened.length, 1);
  const ticket = opened[0].msg;
  assert.deepEqual(opened[0].roles, ['tech']);
  const forOrg = sent.filter((x) => x.msg.t === 'ticket' && x.msg.type === 'cant_hear' && x.roles.includes('org'));
  assert.equal(forOrg.length, 1);
  assert.deepEqual(forOrg[0].roles, ['org']);
  assert.ok(!('claimedBy' in forOrg[0].msg) && !('fixedBy' in forOrg[0].msg), '/org never gets tech names');
  assert.equal(ticket.status, 'open');
  assert.equal(ticket.people, 3);
  assert.equal(ticket.cause, 'Mic is silent or muted');
  assert.deepEqual(ticket.steps, [
    'Check the mic mute switch / battery',
    'Check the mixer channel fader',
  ]);

  res = await vote('a', 'cant_hear');
  assert.equal(res.body.count, 3, 'repeat tap does not inflate distinct count');
  assert.equal(
    sent.filter((x) => x.roles.includes('tech') && x.msg.t === 'ticket' && x.msg.type === 'cant_hear').length,
    1,
    'repeat tap does not duplicate ticket'
  );

  res = await vote('b', 'cant_hear', false);
  assert.deepEqual(res.body, { count: 2, ticketStatus: 'open' });
  const updates = sent.filter((x) => x.roles.includes('tech') && x.msg.t === 'ticket' && x.msg.type === 'cant_hear');
  assert.equal(updates[updates.length - 1].msg.people, 2, 'ticket people follows active votes');

  res = await call('POST', `/api/tickets/${ticket.id}/claim`, {
    body: { by: 'tech' },
  });
  assert.equal(res.statusCode, 401, 'ticket actions require TECH_KEY');
  res = await call('POST', `/api/tickets/${ticket.id}/claim`, {
    body: { by: 'tech' },
    key: 'tech',
  });
  assert.deepEqual(res.body, { status: 'claimed' });

  res = await call('POST', '/api/feedback', {
    body: { ticketId: ticket.id, clientId: 'x', better: true },
  });
  assert.deepEqual(res.body, { better: 1, stillBad: 0 });
  res = await call('POST', '/api/feedback', {
    body: { ticketId: ticket.id, clientId: 'x', better: true },
  });
  assert.deepEqual(res.body, { better: 1, stillBad: 0 }, 'one feedback per clientId');
  res = await call('POST', '/api/feedback', {
    body: { ticketId: ticket.id, clientId: 'y', better: false },
  });
  assert.deepEqual(res.body, { better: 1, stillBad: 1 });

  res = await call('POST', `/api/tickets/${ticket.id}/fixed`, {
    body: { by: 'tech' },
    key: 'tech',
  });
  assert.deepEqual(res.body, { status: 'fixed' });
  assert.equal(tickets.openTickets('151'), 0, 'fixed closes the ticket');
  assert.equal(docs.filter((d) => d.index === 'pulse-tickets' && d.doc.fixedAt).length > 0, true);

  res = await vote('a', 'cant_hear');
  assert.deepEqual(res.body, { count: 1, ticketStatus: null }, 'fixed clears votes');
  res = await vote('b', 'cant_hear');
  res = await vote('c', 'cant_hear');
  assert.deepEqual(
    res.body,
    { count: 3, ticketStatus: 'reopened' },
    'threshold again within 2 min reopens'
  );
  const reopened = sent.filter((x) => x.roles.includes('tech') && x.msg.t === 'ticket' && x.msg.type === 'cant_hear');
  assert.equal(reopened[reopened.length - 1].msg.id, ticket.id, 'reopen keeps ticket id');
  assert.equal(tickets.openTickets('151'), 1);

  res = await call('GET', '/api/config');
  assert.deepEqual(res.body, { alertThreshold: 3, nudgeThreshold: 2, publicBaseUrl: '' });
  res = await call('POST', '/api/config', { body: { alertThreshold: 5 } });
  assert.equal(res.statusCode, 401);
  res = await call('POST', '/api/config', { body: { alertThreshold: 5 }, key: 'tech' });
  assert.deepEqual(res.body, { alertThreshold: 5, nudgeThreshold: 4, publicBaseUrl: '' });

  const now = 1000000;
  const records = [
    { room: '151', talkId: 't', type: 'cant_hear', clientId: 'old', ts: now - VOTE_TTL_MS },
    { room: '151', talkId: 't', type: 'cant_hear', clientId: 'new', ts: now - 1000 },
  ];
  assert.equal(countDistinct(records, now), 1, 'votes expire after 10 minutes');
  assert.equal(countDistinct(records, now, { windowMs: 60_000 }), 1);
  assert.equal(
    countDistinct([{ room: '151', talkId: 't', type: 'cant_hear', clientId: 'x', ts: now }], now, {
      talkId: 'other',
    }),
    0
  );

  await new Promise((resolve) => setTimeout(resolve, 2200));
  const status = sent.filter((x) => x.msg.t === 'room_status').pop();
  assert.ok(status, 'room_status is sent on the 2 s tick');
  assert.equal(status.msg.room, '151');
  assert.equal(status.msg.listeners, 2);
  assert.equal(status.msg.micDb, null);
  assert.equal(typeof status.msg.captionGapSec, 'number');
  assert.equal(status.msg.openTickets, 1);
  assert.deepEqual(status.roles, ['tech', 'org', 'mic']);

  console.log('tickets-check: ok');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
