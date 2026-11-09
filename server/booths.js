// Expo booths: passport stamps, next-booth suggestions, staff requests, privacy-safe report (CONTRACT.md "Booths").
// Booth demos are ordinary talks in a room whose id is the booth id, so captions and reports need no special path.
const crypto = require('crypto');
const booths = require('./booths.json');

const SUSPECT_MS = 30 * 1000;
const MAX_HEARD = 20;
const MAX_BECAUSE = 120;
const MIN_DEVICES = 3;
const KINDS = new Set(['talk_to_engineer', 'send_resources']);

const ordered = booths.slice().sort((a, b) => a.table.localeCompare(b.table));
const byId = new Map(booths.map((b) => [b.id, b]));

const stamps = new Map(); // booth -> Map(clientId -> {ts, suspect, fromTalks, heard})
const requests = new Map(); // booth -> [{requestId, kind, clientId, ts, done, doneAt}]

const STOP = new Set('a an the and or but if of to in on at for with by from is are was were be been do does did you your we our us it its this that these those how what when where why who which can could should would will as so not no than then there their them they i me my also just very really about into over under more most some any all'.split(' '));

function words(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter((w) => w && !STOP.has(w));
}

function wordSet(text) {
  return new Set(words(text));
}

// Highest shared-word count between one caption line and a booth's about text.
function scoreBooth(texts, about) {
  const target = wordSet(about);
  let total = 0;
  let best = 0;
  let line = null;
  for (const text of texts) {
    const got = wordSet(text);
    let shared = 0;
    for (const w of got) if (target.has(w)) shared++;
    total += shared;
    if (shared > best) { best = shared; line = text; }
  }
  return { score: total, shared: best, line: best ? line : null };
}

function truncate(text) {
  if (typeof text !== 'string') return null;
  return text.length > MAX_BECAUSE ? text.slice(0, MAX_BECAUSE) : text;
}

function decorate(booth, because) {
  return { id: booth.id, sponsor: booth.sponsor, table: booth.table, because: truncate(because) };
}

function nearestNext(excluded) {
  const booth = ordered.find((b) => !excluded.has(b.id));
  return booth ? decorate(booth, null) : null;
}

function localNext(heard, excluded) {
  let best = null;
  for (const booth of ordered) {
    if (excluded.has(booth.id)) continue;
    const scored = scoreBooth(heard, booth.about);
    if (scored.score > 0 && (!best || scored.score > best.score)) {
      best = { booth, score: scored.score, line: scored.line };
    }
  }
  return best ? decorate(best.booth, best.line) : nearestNext(excluded);
}

function isSuspect(previous, booth, now) {
  return Boolean(previous && previous.booth !== booth && now - previous.ts < SUSPECT_MS);
}

// Latest stamp at any OTHER booth: a reload of this booth must not reset the 30 s rule.
function latestStamp(clientId, exceptBooth) {
  let latest = null;
  for (const [booth, map] of stamps) {
    if (booth === exceptBooth) continue;
    const stamp = map.get(clientId);
    if (stamp && (!latest || stamp.ts > latest.ts)) latest = { booth, ts: stamp.ts };
  }
  return latest;
}

// A suspect record is a rejected stamp, so it does not count toward passport progress.
function passport(stampsByBooth, clientId) {
  let n = 0;
  for (const map of stampsByBooth.values()) {
    const stamp = map.get(clientId);
    if (stamp && !stamp.suspect) n++;
  }
  return n;
}

function excludedBooths(stampsByBooth, clientId) {
  const out = new Set();
  for (const [booth, map] of stampsByBooth) if (map.has(clientId)) out.add(booth);
  return out;
}

function joinedRooms(ctx, clientId) {
  if (ctx.hub && typeof ctx.hub.roomsJoined === 'function') return ctx.hub.roomsJoined(clientId);
  const map = ctx.state && ctx.state.heardRooms;
  const set = map && map.get(clientId);
  return set ? [...set] : [];
}

// Last 20 caption lines from the rooms this device joined as attendee.
function heardBy(ctx, clientId) {
  const lines = [];
  for (const roomId of joinedRooms(ctx, clientId)) {
    const room = ctx.state.rooms.get(String(roomId));
    if (!room || !Array.isArray(room.captions)) continue;
    for (const c of room.captions) {
      if (typeof c.text === 'string' && c.text.trim()) lines.push({ text: c.text, ts: Number(c.ts) || 0 });
    }
  }
  lines.sort((a, b) => a.ts - b.ts);
  return lines.slice(-MAX_HEARD).map((l) => l.text);
}

// Talks whose room this device had joined before checking in.
function talksBy(ctx, clientId) {
  const ids = new Set();
  for (const roomId of joinedRooms(ctx, clientId)) {
    const room = ctx.state.rooms.get(String(roomId));
    if (room && room.talkId) ids.add(String(room.talkId));
  }
  return [...ids];
}

async function suggestNext(ctx, excluded, heard) {
  if (!heard.length) return nearestNext(excluded);
  if (ctx.es && ctx.es.enabled && typeof ctx.es.raw === 'function') {
    try {
      const q = heard.join('\n');
      const out = await ctx.es.raw('POST', '/pulse-booths/_search', {
        size: 20,
        _source: ['id'],
        retriever: {
          rrf: {
            rank_constant: 60,
            rank_window_size: 50,
            retrievers: [
              { standard: { query: { match: { about: q } } } },
              { standard: { query: { semantic: { field: 'about_sem', query: q } } } },
            ],
          },
        },
      });
      const hits = (out && out.hits && out.hits.hits) || [];
      for (const hit of hits) {
        const id = String((hit._source && hit._source.id) || hit._id || '');
        const booth = byId.get(id);
        if (!booth || excluded.has(booth.id)) continue;
        return decorate(booth, scoreBooth(heard, booth.about).line);
      }
    } catch {
      // No semantic field or no inference endpoint: use the in-memory overlap below.
    }
  }
  return localNext(heard, excluded);
}

function bigrams(text) {
  const list = String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter(Boolean);
  const out = new Set();
  for (let i = 1; i < list.length; i++) {
    if (STOP.has(list[i - 1]) || STOP.has(list[i])) continue;
    out.add(`${list[i - 1]} ${list[i]}`);
  }
  return out;
}

// rows: [{clientId, heard, fromTalks}]. Buckets smaller than MIN_DEVICES are dropped.
function topicList(rows) {
  const buckets = new Map(); // bigram -> Set(clientId)
  for (const row of rows) {
    for (const text of row.heard || []) {
      for (const bg of bigrams(text)) {
        if (!buckets.has(bg)) buckets.set(bg, new Set());
        buckets.get(bg).add(row.clientId);
      }
    }
  }
  return [...buckets]
    .filter(([, ids]) => ids.size >= MIN_DEVICES)
    .map(([text, ids]) => ({ text, devices: ids.size }))
    .sort((a, b) => b.devices - a.devices || a.text.localeCompare(b.text))
    .slice(0, 5);
}

function talkList(rows) {
  const buckets = new Map(); // talkId -> Set(clientId)
  for (const row of rows) {
    for (const talkId of row.fromTalks || []) {
      if (!buckets.has(talkId)) buckets.set(talkId, new Set());
      buckets.get(talkId).add(row.clientId);
    }
  }
  return [...buckets]
    .filter(([, ids]) => ids.size >= MIN_DEVICES)
    .map(([talkId, ids]) => ({ talkId, devices: ids.size }))
    .sort((a, b) => b.devices - a.devices || a.talkId.localeCompare(b.talkId));
}

function indexCheckin(ctx, doc) {
  try {
    const p = ctx.es.index('pulse-checkins', doc);
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch {}
}

async function indexBooth(ctx, booth) {
  const doc = { id: booth.id, sponsor: booth.sponsor, about: booth.about };
  try {
    if (typeof ctx.es.raw === 'function') {
      await ctx.es.raw('PUT', `/pulse-booths/_doc/${encodeURIComponent(booth.id)}`, doc);
      return;
    }
    ctx.es.index('pulse-booths', doc);
  } catch {
    ctx.es.index('pulse-booths', doc);
  }
}

function register(app, ctx) {
  if (ctx.es && ctx.es.enabled) {
    for (const booth of booths) indexBooth(ctx, booth).catch(() => {});
  }

  const tech = ctx.auth.api('TECH_KEY');
  const boothOf = (req, res) => {
    const booth = byId.get(String(req.params.booth));
    if (!booth) res.status(404).json({ error: 'unknown booth' });
    return booth;
  };
  const clientOf = (body) => String((body && body.clientId) || '').trim();

  app.get('/api/booths', (req, res) => {
    res.json(ordered.map((b) => ({
      id: b.id, sponsor: b.sponsor, table: b.table, pitch: b.pitch, resourcesUrl: b.resourcesUrl,
    })));
  });

  app.post('/api/booths/:booth/checkin', async (req, res) => {
    const booth = boothOf(req, res);
    if (!booth) return;
    const clientId = clientOf(req.body);
    if (!clientId) return res.status(400).json({ error: 'clientId is required' });

    const now = Date.now();
    const fromTalks = talksBy(ctx, clientId);
    const heard = heardBy(ctx, clientId);
    const suspect = isSuspect(latestStamp(clientId, booth.id), booth.id, now);

    let map = stamps.get(booth.id);
    if (!map) stamps.set(booth.id, (map = new Map()));
    let stamp = map.get(clientId);

    if (!stamp) {
      stamp = { ts: now, suspect, fromTalks, heard };
      map.set(clientId, stamp);
      indexCheckin(ctx, { booth: booth.id, clientId, ts: now, suspect, fromTalks });
    } else if (stamp.suspect && !suspect) {
      // A rejected stamp becomes real once the device has slowed down.
      Object.assign(stamp, { ts: now, suspect: false, fromTalks, heard });
      indexCheckin(ctx, { booth: booth.id, clientId, ts: now, suspect: false, fromTalks });
    }

    const excluded = excludedBooths(stamps, clientId);
    const next = await suggestNext(ctx, excluded, heard);
    res.json({
      booth: booth.id,
      stamps: passport(stamps, clientId),
      total: ordered.length,
      suspect: Boolean(stamp.suspect),
      next,
    });
  });

  app.post('/api/booths/:booth/requests', (req, res) => {
    const booth = boothOf(req, res);
    if (!booth) return;
    const clientId = clientOf(req.body);
    const kind = String((req.body && req.body.kind) || '');
    if (!clientId) return res.status(400).json({ error: 'clientId is required' });
    if (!KINDS.has(kind)) return res.status(400).json({ error: 'unknown kind' });

    let queue = requests.get(booth.id);
    if (!queue) requests.set(booth.id, (queue = []));
    const requestId = crypto.randomUUID();
    const ts = Date.now();
    queue.push({ requestId, kind, clientId, ts, done: false, doneAt: null });
    const position = queue.filter((r) => !r.done).length;

    ctx.hub.send(booth.id, { t: 'booth_request', requestId, kind, position, ts }, ['tech']);
    res.json({ requestId, position });
  });

  app.post('/api/booths/:booth/requests/:id/done', tech, (req, res) => {
    const booth = boothOf(req, res);
    if (!booth) return;
    const queue = requests.get(booth.id) || [];
    const request = queue.find((r) => r.requestId === String(req.params.id));
    if (!request) return res.status(404).json({ error: 'unknown request' });
    if (!request.done) {
      request.done = true;
      request.doneAt = Date.now();
      ctx.hub.send(booth.id, { t: 'booth_request_done', requestId: request.requestId }, ['tech']);
    }
    res.json({ status: 'done' });
  });

  app.get('/api/booths/:booth/report', tech, (req, res) => {
    const booth = boothOf(req, res);
    if (!booth) return;

    const rows = [];
    for (const [clientId, stamp] of stamps.get(booth.id) || []) {
      if (!stamp.suspect) rows.push({ clientId, heard: stamp.heard, fromTalks: stamp.fromTalks });
    }
    const open = (requests.get(booth.id) || [])
      .filter((r) => !r.done)
      .map((r, i) => ({ requestId: r.requestId, kind: r.kind, position: i + 1, ts: r.ts }));

    res.json({
      visits: rows.length,
      uniqueDevices: new Set(rows.map((r) => r.clientId)).size,
      open,
      fromTalks: talkList(rows).map((t) => {
        const talk = ctx.state.talks.get(t.talkId);
        return { talkId: t.talkId, title: talk ? talk.title : '', devices: t.devices };
      }),
      topics: topicList(rows),
    });
  });
}

module.exports = {
  register,
  _test: {
    SUSPECT_MS,
    MIN_DEVICES,
    isSuspect,
    passport,
    excludedBooths,
    localNext,
    nearestNext,
    scoreBooth,
    topicList,
    talkList,
  },
};
