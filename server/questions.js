// Questions, transcript, report and hybrid search (CONTRACT.md).
// Questions are grouped in memory (one pod) and mirrored to pulse-questions fire-and-forget.
const crypto = require('crypto');
const state = require('./state');
const es = require('./es');
const log = require('./log');
const otel = require('./otel');

const MAX_TEXT = 280;

// Span attributes: the talk (when the request names one) and, for Elasticsearch
// calls, the backend. Hit counts are set after the rows are known.
const talkAttrs = (talkId) => (talkId ? { 'pulse.talk.id': talkId } : {});
const esAttrs = (talkId) => Object.assign(talkAttrs(talkId), { 'db.system.name': 'elasticsearch' });
const countHits = (active, n) => {
  try {
    if (active && typeof active.setAttribute === 'function' && Number.isFinite(n)) {
      active.setAttribute('pulse.hits', n);
    }
  } catch (_) {} // telemetry never affects the request
};

const groups = new Map(); // groupId -> {groupId, room, talkId, text, words, count, answered, askers:Set}
const questions = new Map(); // qid -> {qid, groupId, room, talkId, text, clientId, ts, pinned, hidden, answered}

// Lowercase, punctuation to spaces: the word set used for Jaccard grouping.
// Stopwords dropped and a crude stem (drops/dropped -> drop) so rephrasings of one question match.
const STOP = new Set('a an the and or but if of to in on at for with by from is are was were be been do does did you your we our us it its this that these those how what when where why who which can could should would will at as so not no than then there their them they i me my'.split(' '));
// Light stem: dropped/dropping/drops -> drop, nodes -> node. Undo a doubled final consonant (dropp -> drop).
const stem = (w) => {
  if (w.length <= 3) return w;
  let s = w.replace(/(ing|ed)$/, '');
  if (s !== w && s.length > 2) return /([b-df-hj-np-tv-z])\1$/.test(s) ? s.slice(0, -1) : s;
  return w.endsWith('ss') ? w : w.replace(/s$/, '');
};
function words(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .split(' ')
      .filter((w) => w && !STOP.has(w))
      .map(stem)
  );
}

// Overlap coefficient: shared / smaller set. Needs 3+ shared content words so short questions don't collapse.
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  const small = Math.min(a.size, b.size);
  if (small < 3) return a.size === b.size && shared === small ? 1 : 0; // short questions group only if identical in content
  return shared >= 3 ? shared / small : 0;

}

function findGroup(room, talkId, w) {
  for (const g of groups.values()) {
    if (g.room !== room || g.talkId !== talkId) continue;
    if (jaccard(g.words, w) >= 0.5) return g;
  }
  return null;
}

function groupList(room) {
  const out = [];
  for (const g of groups.values()) {
    if (g.room === room) out.push({ groupId: g.groupId, qid: g.qid, text: g.text, count: g.count, answered: g.answered });
  }
  return out;
}

function memoryQuestions(talkId) {
  const out = [];
  for (const q of questions.values()) {
    if (q.talkId !== talkId || q.hidden) continue; // hidden by the tech: not in the public report
    out.push({
      qid: q.qid, talkId: q.talkId, room: q.room, text: q.text,
      ts: q.ts, groupId: q.groupId, answered: q.answered, answeredSeq: q.answeredSeq,
    });
  }
  return out;
}

// transcript rows from the room's rolling buffer while the talk is live.
function memoryCaptions(talkId, from) {
  const lines = state.transcripts.get(talkId);
  if (!lines || !lines.length) return null;
  return lines
    .filter((c) => c.talkId === talkId && (from == null || c.seq >= from))
    .map((c) => ({ talkId: c.talkId, seq: c.seq, text: c.text, ts: c.ts }));
}

function isLive(talkId) {
  const talk = state.talks.get(talkId);
  if (talk) return !talk.end;
  for (const room of state.rooms.values()) if (room.talkId === talkId) return true;
  return false;
}

function countSignals(rows) {
  const buckets = new Map(); // "minute|type" -> Set(clientId)
  for (const s of rows) {
    if (s.on === false) continue;
    const minute = Number.isInteger(s.minute) ? s.minute : Math.floor(Number(s.ts) / 60000);
    const key = `${minute}|${s.type}`;
    if (!buckets.has(key)) buckets.set(key, new Set());
    buckets.get(key).add(s.clientId || '');
  }
  return [...buckets]
    .map(([key, ids]) => {
      const [minute, type] = key.split('|');
      return { minute: Number(minute), type, count: ids.size };
    })
    .sort((a, b) => a.minute - b.minute || a.type.localeCompare(b.type));
}

// Search without ES: the room buffers hold the live tail, which is what a demo needs.
function memorySearch(q, talkId) {
  const needle = q.toLowerCase();
  const out = [];
  const seen = new Set();
  for (const room of state.rooms.values()) {
    for (const c of room.captions) {
      if (talkId && c.talkId !== talkId) continue;
      if (!String(c.text || '').toLowerCase().includes(needle)) continue;
      const key = `${c.talkId}|${c.seq}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ talkId: c.talkId, seq: c.seq, text: c.text, ts: c.ts });
    }
  }
  return out.slice(-20);
}

const SOURCE = ['talkId', 'seq', 'text', 'ts'];

async function searchCaptions(q, talkId) {
  if (!es.enabled) {
    return otel.span('pulse.search.memory', talkAttrs(talkId), (active) => {
      const rows = memorySearch(q, talkId);
      countHits(active, rows.length);
      return rows;
    });
  }
  const filter = talkId ? [{ term: { talkId } }] : [];
  const hybrid = {
    size: 20,
    _source: SOURCE,
    retriever: {
      rrf: {
        rank_constant: 60,
        rank_window_size: 50,
        retrievers: [
          { standard: { query: { bool: { must: [{ match: { text: q } }], filter } } } },
          { standard: { query: { bool: { must: [{ semantic: { field: 'text_sem', query: q } }], filter } } } },
        ],
      },
    },
  };
  return otel.span('pulse.search.es', esAttrs(talkId), async (active) => {
    let res;
    try {
      res = await es.raw('POST', '/pulse-captions/_search', hybrid);
    } catch {
      // No inference endpoint or an older cluster: plain text match.
      return otel.span('pulse.search.es', esAttrs(talkId), async (inner) => {
        const rows = await es.search('pulse-captions', {
          size: 20,
          _source: SOURCE,
          query: { bool: { must: [{ match: { text: q } }], filter } },
        });
        countHits(inner, rows.length);
        return rows;
      });
    }
    const hits = (res && res.hits && Array.isArray(res.hits.hits)) ? res.hits.hits.length : 0;
    countHits(active, hits);
    return ((res && res.hits && res.hits.hits) || []).map((h) => h._source).filter(Boolean);
  });
}

function register(app, ctx) {
  const wrap = (fn) => (req, res) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      log.error('questions.request_failed', { error: err.message || String(err) });
      res.status(500).json({ error: 'internal' });
    });
  };

  const sendTech = (room, msg) => {
    if (ctx.hub && typeof ctx.hub.send === 'function') ctx.hub.send(room, msg, ['tech']);
  };
  const tech = ctx.auth.api('TECH_KEY');

  function updateQuestion(res, qid, patch) {
    const q = questions.get(qid);
    if (!q) return res.status(404).json({ error: 'unknown question' });
    Object.assign(q, patch);
    es.updateByQuery('pulse-questions', { term: { qid: q.qid } }, { hidden: q.hidden });
    const g = groups.get(q.groupId);
    if (g && patch.answered) g.answered = true;
    sendTech(q.room, { t: 'question_update', qid: q.qid, pinned: q.pinned, hidden: q.hidden, answered: q.answered });
    if (patch.answered) sendTech(q.room, { t: 'question_groups', groups: groupList(q.room) });
    res.json({ qid: q.qid, pinned: q.pinned, hidden: q.hidden, answered: q.answered });
  }

  app.post('/api/questions', (req, res) => {
    const body = req.body || {};
    const room = String(body.room || '').trim();
    const text = String(body.text || '').trim().slice(0, MAX_TEXT).trim();
    if (!room || !text) return res.status(400).json({ error: 'room and text are required' });
    const clientId = body.clientId == null ? '' : String(body.clientId);
    const talks = require('./talks');
    if (clientId && talks.isMuted?.(clientId)) return res.status(403).json({ error: 'muted' });

    state.room(room);
    const live = state.liveTalk(room);
    // A question can only attach to a talk in this room (security audit: cross-room injection).
    const asked = body.talkId ? state.talks.get(String(body.talkId)) : null;
    if (body.talkId && (!asked || String(asked.room) !== room)) return res.status(400).json({ error: 'talk is not in this room' });
    const talkId = String(body.talkId || (live && live.talkId) || '');
    const w = words(text);
    let group = findGroup(room, talkId, w);
    if (!group) {
      group = {
        groupId: crypto.randomUUID(), room, talkId, text, words: w,
        count: 0, answered: false, askers: new Set(),
      };
      groups.set(group.groupId, group);
    }
    const qid = crypto.randomUUID();
    if (!group.qid) group.qid = qid; // the group's actions (reply/queue/answered/hide) target its first question
    const ts = Date.now();
    questions.set(qid, {
      qid, groupId: group.groupId, room, talkId, text, clientId, ts,
      pinned: false, hidden: false, answered: false,
    });
    group.count++;
    if (clientId) group.askers.add(clientId);

    es.index('pulse-questions', {
      qid, groupId: group.groupId, talkId, room, text, clientId, ts, answered: false, hidden: false,
    }, qid);
    sendTech(room, { t: 'question_groups', groups: groupList(room) });
    res.json({ qid, groupId: group.groupId });
  });

  app.post('/api/questions/:qid/queue', tech, (req, res) =>
    updateQuestion(res, req.params.qid, { pinned: true, hidden: false })
  );
  app.post('/api/questions/:qid/hide', tech, (req, res) =>
    updateQuestion(res, req.params.qid, { pinned: false, hidden: true })
  );
  app.post('/api/questions/:qid/answered', tech, (req, res) => {
    const q = questions.get(req.params.qid);
    if (!q) return res.status(404).json({ error: 'unknown question' });
    const patch = { answered: true };
    const room = state.rooms.get(q.room);
    if (room) {
      let seq = null;
      for (const c of room.captions) {
        if (c.talkId === q.talkId && Number.isInteger(c.seq) && (seq === null || c.seq > seq)) seq = c.seq;
      }
      if (seq !== null) patch.answeredSeq = seq;
    }
    updateQuestion(res, req.params.qid, patch);
  });

  app.post('/api/questions/:qid/reply', tech, (req, res) => {
    const q = questions.get(req.params.qid);
    if (!q) return res.status(404).json({ error: 'unknown question' });
    const text = String((req.body || {}).text || '').trim();
    if (!text) return res.status(400).json({ error: 'text is required' });
    const group = groups.get(q.groupId);
    const askers = group ? [...group.askers] : q.clientId ? [q.clientId] : [];
    if (ctx.hub && typeof ctx.hub.sendTo === 'function') {
      ctx.hub.sendTo(askers, q.room, { t: 'question_reply', qid: q.qid, text });
    }
    res.json({ qid: q.qid, sent: askers.length });
  });

  app.get('/api/talks/:talkId/transcript', wrap(async (req, res) => {
    const talkId = String(req.params.talkId);
    const raw = req.query.from;
    const parsed = raw === undefined || raw === '' ? null : Number(raw);
    const from = Number.isFinite(parsed) ? parsed : null;

    let rows;
    // full transcript held in memory; ES covers talks from before a restart
    const buffered = otel.span('pulse.transcript.captions', talkAttrs(talkId), (active) => {
      const out = memoryCaptions(talkId, from);
      countHits(active, out ? out.length : 0);
      return out;
    });
    if (buffered) {
      rows = buffered;
    } else {
      rows = await otel.span('pulse.transcript.es', esAttrs(talkId), async (active) => {
        const out = await es.search('pulse-captions', {
          size: 5000,
          sort: [{ seq: 'asc' }],
          _source: SOURCE,
          query: { bool: { filter: [{ term: { talkId } }], must: from == null ? [] : [{ range: { seq: { gte: from } } }] } },
        });
        countHits(active, out.length);
        return out;
      });
    }
    if (req.query.format === 'txt') {
      return res.type('text/plain').send(rows.map((r) => r.text).join('\n'));
    }
    res.json(rows);
  }));

  app.get('/api/report/:talkId', wrap(async (req, res) => {
    const talkId = String(req.params.talkId);
    if (!es.enabled) {
      const buffered = otel.span('pulse.report.captions', talkAttrs(talkId), (active) => {
        const out = memoryCaptions(talkId);
        countHits(active, out ? out.length : 0);
        return out;
      });
      const asked = otel.span('pulse.report.questions', talkAttrs(talkId), (active) => {
        const out = memoryQuestions(talkId);
        countHits(active, out.length);
        return out;
      });
      return res.json({
        transcript: buffered || [],
        signalsByMinute: [],
        questions: asked,
      });
    }
    const [transcript, signals, asked] = await Promise.all([
      otel.span('pulse.report.captions', esAttrs(talkId), async (active) => {
        const rows = await es.search('pulse-captions', {
          size: 5000, sort: [{ seq: 'asc' }], _source: SOURCE,
          query: { term: { talkId } },
        });
        countHits(active, rows.length);
        return rows;
      }),
      otel.span('pulse.report.signals', esAttrs(talkId), async (active) => {
        const rows = await es.search('pulse-signals', {
          size: 5000,
          _source: ['minute', 'type', 'clientId', 'on', 'ts'],
          query: { term: { talkId } },
        });
        countHits(active, rows.length);
        return rows;
      }),
      otel.span('pulse.report.questions', esAttrs(talkId), async (active) => {
        const rows = await es.search('pulse-questions', {
          size: 1000, sort: [{ ts: 'asc' }],
          _source: { excludes: ['clientId', 'hidden'] }, // reports never expose device ids or moderation state
          query: { bool: { filter: [{ term: { talkId } }], must_not: [{ term: { hidden: true } }] } },
        });
        countHits(active, rows.length);
        return rows;
      }),
    ]);
    const signalsByMinute = otel.span('pulse.report.signals_by_minute', talkAttrs(talkId), () => countSignals(signals));
    const merged = otel.span('pulse.report.questions_merge', talkAttrs(talkId), () => asked.filter((q) => !(questions.get(q.qid) || {}).hidden).map((q) => {
      const mem = questions.get(q.qid);
      return mem ? Object.assign({}, q, { answered: mem.answered, answeredSeq: mem.answeredSeq }) : q;
    }));
    res.json({
      transcript,
      signalsByMinute,
      questions: merged,
    });
  }));

  app.get('/api/search', wrap(async (req, res) => {
    const q = String(req.query.q || '').trim();
    const talkId = String(req.query.talkId || '').trim();
    if (!q) return res.json([]);
    res.json(await searchCaptions(q, talkId));
  }));
}

// Questions asked before the talk starts are held under the room and attached when it starts.
function attachPending(room, talkId) {
  const id = String(room);
  for (const g of groups.values()) {
    if (g.room === id && !g.talkId) g.talkId = talkId;
  }
  for (const q of questions.values()) {
    if (q.room === id && !q.talkId) q.talkId = talkId;
  }
}

module.exports = { register, groupList, attachPending };
