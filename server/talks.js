// Talks + rooms + room settings + broadcast + mute routes (CONTRACT.md "HTTP routes").
const crypto = require('crypto');
const tickets = require('./tickets');

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

module.exports = {
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

    app.post('/api/talks/:talkId/end', ctx.auth.api('SPEAKER_KEY'), (req, res) => {
      const talk = state.talks.get(req.params.talkId);
      if (!talk) return res.status(404).json({ error: 'not found' });
      talk.end = Date.now();
      res.json({ reportUrl: `${ctx.config.PUBLIC_BASE_URL}/t/${talk.talkId}` });
    });

    app.get('/api/rooms', (req, res) => {
      const list = [...state.rooms.values()]
        .sort((a, b) => a.room.localeCompare(b.room))
        .map((room) => ({
          room: room.room,
          talkId: room.talkId,
          title: room.title,
          listeners: hub.listeners(room.room),
          openTickets: tickets.openTickets(room.room),
          simulated: room.simulated,
        }));
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
      hub.send(room.room, { t: 'room_settings', ...room.settings });
      res.json(room.settings);
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
