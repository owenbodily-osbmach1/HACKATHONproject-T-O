// Find the right talk: hybrid search over the KubeCon schedule and what speakers said (CONTRACT.md "Find the right talk").
// Public read-only search. Elasticsearch is best-effort; the in-memory fallback never throws.
const schedule = require('./schedule.json');
const state = require('./state');

const INDEX = 'pulse-schedule';
const CAPTIONS = 'pulse-captions';
const WRITE_TIMEOUT_MS = 15000;
const DEFAULT_LIMIT = 10;
const DEFAULT_NEXT = 3;
const MAX_LIMIT = 50;
const MAX_HEARD = 20;
const MAX_BECAUSE = 120;
const MAX_WHY = 180;

const STOP = new Set('a an the and or but if of to in on at for with by from is are was were be been do does did you your we our us it its this that these those how what when where why who which can could should would will as so not no than then there their them they i me my also just very really about into over under more most some any all'.split(' '));

const byId = new Map(schedule.map((s) => [String(s.id), s]));
const ordered = schedule
  .slice()
  .sort((a, b) => instant(a.start) - instant(b.start) || a.title.localeCompare(b.title));

// Schedule times have no offset in the source file; Elasticsearch reads them as UTC. Do the same
// in memory so filters and ES agree.
function instant(value) {
  if (typeof value === 'number') return value;
  const text = String(value || '');
  return Date.parse(/[zZ]|[+-]\d{2}:\d{2}$/.test(text) ? text : `${text}Z`);
}

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

function truncate(text, max) {
  if (typeof text !== 'string') return null;
  return text.length > max ? text.slice(0, max) : text;
}

function sentences(text) {
  return String(text || '')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Sentence with the most query words; null when nothing overlaps.
function bestSentence(text, wanted) {
  let best = null;
  for (const sentence of sentences(text)) {
    const got = wordSet(sentence);
    let score = 0;
    for (const w of wanted) if (got.has(w)) score++;
    if (score > 0 && (!best || score > best.score)) best = { text: sentence, score };
  }
  return best;
}

// A short matched snippet for the result row.
function whyFor(item, q) {
  const wanted = wordSet(q);
  if (!wanted.size) return '';
  const abstract = bestSentence(item.abstract, wanted);
  const title = bestSentence(item.title, wanted);
  if (abstract && (!title || abstract.score >= title.score)) return truncate(abstract.text, MAX_WHY);
  if (title) return truncate(title.text, MAX_WHY);
  return truncate(item.abstract || item.title, MAX_WHY);
}

function sessionHit(item, q) {
  return {
    id: String(item.id || ''),
    title: item.title || '',
    start: item.start || '',
    location: item.location || '',
    why: q ? whyFor(item, q) : '',
  };
}

function upcoming(fromMs, limit) {
  return ordered.filter((s) => fromMs == null || instant(s.start) >= fromMs).slice(0, limit);
}

// In-memory schedule search: weighted word overlap over title and abstract.
function memorySessions(q, fromMs, limit) {
  const wanted = wordSet(q);
  if (!wanted.size) return upcoming(fromMs, limit).map((s) => sessionHit(s, ''));
  const scored = [];
  for (const item of ordered) {
    if (fromMs != null && instant(item.start) < fromMs) continue;
    const title = wordSet(item.title);
    const abstract = wordSet(item.abstract);
    let score = 0;
    for (const w of wanted) {
      if (title.has(w)) score += 3;
      else if (abstract.has(w)) score += 1;
    }
    if (score > 0) scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score || instant(a.item.start) - instant(b.item.start));
  return scored.slice(0, limit).map(({ item }) => sessionHit(item, q));
}

// Same retriever shape as questions.js: RRF over a standard lexical query and a semantic query.
function rrf(retrievers) {
  return { rrf: { rank_constant: 60, rank_window_size: 50, retrievers } };
}

async function esSessions(ctx, q, fromMs, limit) {
  const filter = fromMs == null ? [] : [{ range: { start: { gte: new Date(fromMs).toISOString() } } }];
  try {
    const out = await ctx.es.raw('POST', `/${INDEX}/_search`, {
      size: limit,
      _source: ['id', 'title', 'abstract', 'track', 'location', 'start', 'end', 'sponsor'],
      retriever: rrf([
        {
          standard: {
            query: {
              bool: {
                must: [{ multi_match: { query: q, fields: ['title^3', 'abstract'] } }],
                filter,
              },
            },
          },
        },
        {
          standard: {
            query: {
              bool: {
                must: [{ semantic: { field: 'abstract_sem', query: q } }],
                filter,
              },
            },
          },
        },
      ]),
    });
    return ((out && out.hits && out.hits.hits) || []).map((h) => h._source).filter(Boolean);
  } catch {
    return null;
  }
}

async function searchSessions(ctx, q, fromMs, limit) {
  if (!q) return upcoming(fromMs, limit).map((s) => sessionHit(s, ''));
  if (ctx.es && ctx.es.enabled && typeof ctx.es.raw === 'function') {
    const hits = await esSessions(ctx, q, fromMs, limit);
    if (hits) {
      const out = [];
      for (const source of hits) {
        const item = byId.get(String(source.id || '')) || source;
        if (!item || !item.id) continue;
        out.push(sessionHit(item, q));
      }
      return out;
    }
  }
  return memorySessions(q, fromMs, limit);
}

function talkTitle(talkId) {
  const live = state.talks.get(String(talkId));
  if (live && live.title) return live.title;
  const item = byId.get(String(talkId));
  return item ? item.title : '';
}

function decorateSaid(row) {
  const talkId = String(row.talkId || '');
  return {
    talkId,
    title: talkTitle(talkId),
    seq: row.seq,
    text: row.text,
    ts: row.ts,
  };
}

// Relevance order is kept; at most two lines per talk, then the requested total.
function groupSaid(rows, limit) {
  const out = [];
  const perTalk = new Map();
  for (const row of rows) {
    const talkId = String(row.talkId || '');
    if (!talkId) continue;
    if (out.length >= limit) break;
    const n = perTalk.get(talkId) || 0;
    if (n >= 2) continue;
    perTalk.set(talkId, n + 1);
    out.push(decorateSaid(row));
  }
  return out;
}

async function esSaid(ctx, q, limit) {
  try {
    const out = await ctx.es.raw('POST', `/${CAPTIONS}/_search`, {
      size: Math.min(MAX_LIMIT, limit * 4),
      _source: ['talkId', 'seq', 'text', 'ts'],
      retriever: rrf([
        { standard: { query: { match: { text: q } } } },
        { standard: { query: { semantic: { field: 'text_sem', query: q } } } },
      ]),
    });
    return ((out && out.hits && out.hits.hits) || []).map((h) => h._source).filter(Boolean);
  } catch {
    return null;
  }
}

// In-memory captions: the full transcript per talk held by state.js.
function memorySaid(q, limit) {
  const wanted = wordSet(q);
  if (!wanted.size) return [];
  const scored = [];
  for (const [talkId, lines] of state.transcripts) {
    if (!Array.isArray(lines)) continue;
    for (const line of lines) {
      if (!line || typeof line.text !== 'string') continue;
      const got = wordSet(line.text);
      let score = 0;
      for (const w of wanted) if (got.has(w)) score++;
      if (score > 0) {
        scored.push({ row: { talkId, seq: line.seq, text: line.text, ts: line.ts }, score });
      }
    }
  }
  scored.sort((a, b) => b.score - a.score || Number(b.row.ts || 0) - Number(a.row.ts || 0));
  return groupSaid(scored.map((s) => s.row), limit);
}

async function searchSaid(ctx, q, limit) {
  if (!q) return [];
  if (ctx.es && ctx.es.enabled && typeof ctx.es.raw === 'function') {
    const rows = await esSaid(ctx, q, limit);
    if (rows) return groupSaid(rows, limit);
  }
  return memorySaid(q, limit);
}

// Last 20 caption lines this device received in rooms it joined as attendee.
function heardBy(ctx, clientId) {
  if (!clientId) return [];
  const map = ctx.state && ctx.state.heardRooms;
  const set = map && map.get(String(clientId));
  if (!set) return [];
  const lines = [];
  for (const roomId of set) {
    const room = ctx.state.rooms.get(String(roomId));
    if (!room || !Array.isArray(room.captions)) continue;
    for (const c of room.captions) {
      if (typeof c.text === 'string' && c.text.trim()) lines.push({ text: c.text, ts: Number(c.ts) || 0 });
    }
  }
  lines.sort((a, b) => a.ts - b.ts);
  return lines.slice(-MAX_HEARD).map((l) => l.text);
}

// The caption line with the most shared words with this session.
function bestLine(heard, item) {
  const target = wordSet(`${item.title || ''} ${item.abstract || ''}`);
  let best = null;
  let bestScore = 0;
  for (const line of heard) {
    const got = wordSet(line);
    let score = 0;
    for (const w of got) if (target.has(w)) score++;
    if (score > bestScore) {
      bestScore = score;
      best = line;
    }
  }
  return best ? truncate(best, MAX_BECAUSE) : null;
}

function nextHit(item, because) {
  return {
    id: String(item.id || ''),
    title: item.title || '',
    start: item.start || '',
    location: item.location || '',
    because: because || null,
  };
}

function parseLimit(raw, fallback) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? Math.min(n, MAX_LIMIT) : fallback;
}

// Default is now; from=all lifts the upcoming filter.
function parseFrom(raw) {
  if (raw === 'all') return null;
  if (raw) {
    const n = Date.parse(String(raw));
    if (Number.isFinite(n)) return n;
  }
  return Date.now();
}

// Every schedule entry goes in with its own id so re-indexing updates instead of duplicating.
function indexSchedule(ctx) {
  if (!ctx.es || !ctx.es.enabled || typeof ctx.es.raw !== 'function') return;
  for (const item of schedule) {
    try {
      ctx.es.raw('PUT', `/${INDEX}/_doc/${encodeURIComponent(item.id)}`, item, WRITE_TIMEOUT_MS).catch(() => {});
    } catch {}
  }
}

function register(app, ctx) {
  indexSchedule(ctx);

  app.get('/api/find', async (req, res) => {
    const q = String(req.query.q || '').trim();
    const from = parseFrom(req.query.from);
    const limit = parseLimit(req.query.limit, DEFAULT_LIMIT);
    try {
      const [sessions, said] = await Promise.all([
        searchSessions(ctx, q, from, limit),
        searchSaid(ctx, q, limit),
      ]);
      res.json({ sessions, said });
    } catch {
      res.json({ sessions: [], said: [] });
    }
  });

  app.get('/api/find/next', async (req, res) => {
    const clientId = String(req.query.clientId || '').trim();
    const limit = parseLimit(req.query.limit, DEFAULT_NEXT);
    const now = Date.now();
    try {
      const heard = heardBy(ctx, clientId);
      if (!heard.length) return res.json(upcoming(now, limit).map((s) => nextHit(s, null)));
      const hits = await searchSessions(ctx, heard.join(' '), now, limit);
      if (!hits.length) return res.json(upcoming(now, limit).map((s) => nextHit(s, null)));
      res.json(hits.map((hit) => nextHit(byId.get(hit.id) || hit, bestLine(heard, byId.get(hit.id) || hit))));
    } catch {
      res.json([]);
    }
  });
}

module.exports = {
  register,
  _test: {
    instant,
    words,
    whyFor,
    memorySessions,
    memorySaid,
    bestLine,
    groupSaid,
    parseFrom,
  },
};
