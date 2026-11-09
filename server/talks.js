// Talks + rooms + room settings + broadcast + mute routes (CONTRACT.md "HTTP routes").
const crypto = require('crypto');
const express = require('express');
const tickets = require('./tickets');
const log = require('./log');

const muted = new Map(); // clientId -> mute-until epoch ms

// Elasticsearch writes never block or fail a request.
function esIndex(ctx, index, doc) {
  try {
    const p = ctx.es.index(index, doc);
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch {}
}

function newTalkId(state) {
  let id;
  do { id = crypto.randomBytes(4).toString('hex'); } while (state.talks.has(id));
  return id;
}

function startOf(talk) {
  const n = typeof talk.start === 'number' ? talk.start : Date.parse(talk.start);
  return Number.isFinite(n) ? n : 0;
}

// Only accept real images (JPEG, PNG or WebP magic bytes); serve each with its own type (from Owen's #19).
function imageType(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

// Frames live in pod memory: cap the total so a long day of full-screen captures can't OOM the pod.
const BOOT_ID = Date.now().toString(36);
const MAX_FRAME_BYTES = 128 * 1024 * 1024;
function evictFrames(state, keepBucket, cap = MAX_FRAME_BYTES) {
  let total = 0;
  for (const list of state.frames.values()) for (const f of list) total += f.buf.length;
  if (total <= cap) return;
  // Least recently written buckets first; the live bucket keeps at least its newest frame.
  const buckets = [...state.frames.entries()].sort((a, b) => (a[1].touched || 0) - (b[1].touched || 0));
  for (const [key, list] of buckets) {
    while (list.length > (key === keepBucket ? 1 : 0) && total > cap) total -= list.shift().buf.length;
    if (!list.length) state.frames.delete(key);
    if (total <= cap) return;
  }
}

module.exports = {
  _test: { evictFrames },
  register(app, ctx) {
    const { state, hub } = ctx;

    app.post('/api/talks', ctx.auth.api('SPEAKER_KEY'), (req, res) => {
      const body = req.body || {};
      const roomId = body.room === undefined || body.room === null ? '' : String(body.room);
      if (!roomId) return res.status(400).json({ error: 'room required' });

      const title = typeof body.title === 'string' ? body.title.trim() : '';
      const speaker = typeof body.speaker === 'string' ? body.speaker.trim() : '';
      const talkId = newTalkId(state);
      const start = Date.now();

      const room = state.room(roomId);
      room.talkId = talkId;
      room.title = title;
      room.speaker = speaker;
      state.talks.set(talkId, { talkId, room: roomId, title, speaker, start, end: null });
      log.info('talk.started', { room: roomId, talkId });
      const questions = require('./questions');
      questions.attachPending(roomId, talkId);
      hub.send(roomId, state.talkMessage(roomId));
      hub.send(roomId, { t: 'question_groups', groups: questions.groupList(roomId) }, ['tech']);

      esIndex(ctx, 'pulse-talks', {
        talkId,
        title,
        abstract: '',
        track: '',
        room: roomId,
        start: new Date(start).toISOString(),
        speakers: speaker ? [speaker] : [],
      });
      res.json({ talkId });
    });

    // The speaker (Go live / mic page) or the AV tech can end a talk.
    const speakerOrTech = (req, res, next) => {
      const k = req.get('x-pulse-key');
      if (ctx.auth.ok('SPEAKER_KEY', k) || ctx.auth.ok('TECH_KEY', k)) return next();
      return ctx.auth.ok('BOOTH_KEY', k) ? res.status(403).json({ error: 'forbidden' }) : res.status(401).json({ error: 'unauthorized' });
    };
    app.post('/api/talks/:talkId/end', speakerOrTech, (req, res) => {
      const talk = state.talks.get(req.params.talkId);
      if (!talk) return res.status(404).json({ error: 'not found' });
      if (!talk.end) talk.end = Date.now();
      log.info('talk.ended', { room: talk.room, talkId: talk.talkId });
      hub.send(talk.room, { t: 'caption_interim', text: '' }, ['attendee', 'viewer']); // clear a half-spoken line
      hub.send(talk.room, state.talkMessage(talk.room));
      res.json({ reportUrl: `${ctx.config.PUBLIC_BASE_URL}/t/${talk.talkId}` });
    });

    // Slide relay: the presenting computer posts a JPEG only when the slide changes.
    // express.raw is scoped to this route; the global JSON parser ignores image bodies.
    app.post(
      '/api/rooms/:room/slide-frame',
      ctx.auth.api('SPEAKER_KEY'),
      express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '1.5mb' }),
      (req, res) => {
        const roomId = String(req.params.room);
        const buf = req.body;
        if (!Buffer.isBuffer(buf) || !buf.length) {
          return res.status(400).json({ error: 'image body required' });
        }
        const type = imageType(buf);
        if (!type) return res.status(415).json({ error: 'not a JPEG, PNG or WebP image' });

        const now = Date.now();
        const last = state.frameUploadAt.get(roomId) || 0;
        if (now - last < 1000) return res.status(429).json({ error: 'too_fast' });
        state.frameUploadAt.set(roomId, now);

        const talk = state.liveTalk(roomId);
        const talkId = talk ? talk.talkId : null;
        // BOOT_ID makes pre-show URLs unique per process: they are cached immutable, so a restart must never reuse one.
        const bucket = talk ? talk.talkId : `preshow-${roomId}-${BOOT_ID}`;
        let list = state.frames.get(bucket);
        if (!list) state.frames.set(bucket, (list = []));
        const n = list.length ? list[list.length - 1].n + 1 : 1;
        // Random per frame: the URL can't be guessed from the talk id and a frame number.
        const token = crypto.randomBytes(8).toString('hex');
        list.push({ n, token, room: roomId, buf, ts: now, type });
        if (list.length > state.MAX_FRAMES) list.splice(0, list.length - state.MAX_FRAMES);
        list.touched = now;
        evictFrames(state, bucket);

        const url = `/slides/live/${encodeURIComponent(bucket)}/${n}-${token}.jpg`;
        const slide = { talkId, n, total: 0, url };
        state.room(roomId).slide = slide;
        state.room(roomId).slideAt = now;
        hub.send(roomId, { t: 'slide', ...slide });
        esIndex(ctx, 'pulse-actions', {
          room: roomId,
          talkId: talkId || '',
          actor: 'relay',
          action: 'slide',
          detail: JSON.stringify(slide), // mapped as text in pulse-actions
          ts: now,
        });
        res.json({ n, url });
      }
    );

    // A captured screen can show anything that was on it, so it gets the same access as its room:
    // a phone signed in to that room (or any phone while SIGNIN=off), or a speaker / tech key.
    // Never cached by browsers or proxies.
    app.get('/slides/live/:bucket/:file', (req, res) => {
      res.setHeader('Cache-Control', 'private, no-store');
      const m = /^(\d+)-([a-f0-9]{16})\.jpg$/.exec(String(req.params.file));
      const list = state.frames.get(String(req.params.bucket));
      const frame = m && list && list.find((f) => f.n === Number(m[1]) && f.token === m[2]);
      if (!frame) return res.status(404).end();
      const key = req.get('x-pulse-key') || req.query.key;
      const keyed = ctx.auth.ok('SPEAKER_KEY', key) || ctx.auth.ok('TECH_KEY', key);
      if (!keyed && !require('./signin').inRoom(req, frame.room)) return res.status(403).end();
      res.type(frame.type || 'image/jpeg').send(frame.buf);
    });

    app.get('/api/rooms', (req, res) => {
      const list = [...state.rooms.values()]
        .sort((a, b) => a.room.localeCompare(b.room))
        .map((room) => {
          const talk = state.talkMessage(room.room); // status: waiting | live | ended
          const s = require('./stats').statsFor(room.room); // joined (unique scans), here, capacity
          return {
          room: room.room,
          // Only a live talk: an ended talk must not be resumed by the mic page (demo audit: votes 409).
          talkId: (state.liveTalk(room.room) || {}).talkId || null,
          title: state.liveTalk(room.room) ? room.title : '',
          speaker: state.liveTalk(room.room) ? room.speaker || '' : '',
          status: talk.status, // waiting | live | ended (an ended talk's id comes in the `talk` message)
          startedAt: state.liveTalk(room.room) ? talk.startedAt : null,
          listeners: hub.listeners(room.room),
          joined: s.joined,
          here: s.here,
          capacity: s.capacity,
          openTickets: tickets.openTickets(room.room),
          simulated: room.simulated,
          };
        });
      res.json(list);
    });

    app.get('/api/rooms/:room/talks', (req, res) => {
      const roomId = String(req.params.room);
      const list = [...state.talks.values()]
        .filter((talk) => talk.room === roomId)
        .sort((a, b) => startOf(b) - startOf(a));
      res.json(list);
    });

    app.post('/api/rooms/:room/settings', ctx.auth.api('TECH_KEY'), (req, res) => {
      const room = state.room(String(req.params.room));
      const body = req.body || {};
      for (const field of ['captions', 'listen', 'slides']) {
        if (typeof body[field] === 'boolean') room.settings[field] = body[field];
      }
      // Seats in the room, for the "how full" bar (not a room switch, so not in room_settings).
      const cap = Number(body.capacity);
      if (Number.isInteger(cap) && cap > 0 && cap <= 100000) {
        room.capacity = cap;
        hub.send(room.room, require('./stats').statsMessage(room.room));
      }
      hub.send(room.room, { t: 'room_settings', ...room.settings });
      res.json({ ...room.settings, capacity: require('./stats').capacityOf(room) });
    });

    app.post('/api/rooms/:room/broadcast', ctx.auth.api('TECH_KEY'), (req, res) => {
      const text = req.body && typeof req.body.text === 'string' ? req.body.text : '';
      if (!text.trim()) return res.status(400).json({ error: 'text required' });
      hub.send(String(req.params.room), { t: 'broadcast', text }, ['attendee']);
      res.json({ ok: true });
    });

    app.post('/api/clients/:clientId/mute', ctx.auth.api('TECH_KEY'), (req, res) => {
      const clientId = String(req.params.clientId);
      const minutes = Number(req.body && req.body.minutes);
      if (!Number.isFinite(minutes) || minutes < 0) {
        return res.status(400).json({ error: 'minutes required' });
      }
      if (minutes === 0) {
        muted.delete(clientId);
      } else {
        muted.set(clientId, Date.now() + minutes * 60000);
      }
      res.json({ mutedUntil: muted.get(clientId) || 0 });
    });
  },

  isMuted(clientId) {
    const id = String(clientId);
    const until = muted.get(id);
    if (!until) return false;
    if (until <= Date.now()) { muted.delete(id); return false; }
    return true;
  },
};
