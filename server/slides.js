// Slide relay (docs/design-relay-preshow-questions.md, CONTRACT.md "HTTP routes").
//   POST /api/rooms/:room/slide-frame   raw image/jpeg (≤ 1.5 MB), SPEAKER_KEY -> {n, url}
//   GET  /slides/live/:talkId/:n.jpg    the captured slide (immutable)
// The relay page on the presenting computer uploads a frame only when the slide changes.
// Each upload becomes a normal `slide` message for the room (total: 0 = unknown).
// Frames live in memory only (replicas: 1), last MAX_FRAMES per talk.
const express = require('express');

const MAX_FRAMES = 150;
const MIN_GAP_MS = 400;
const frames = new Map(); // talkId -> { next, items: Map<n, {buf, type, ts}> }
const lastUpload = new Map(); // room -> epoch ms

function esIndex(ctx, index, doc) {
  try {
    const p = ctx.es.index(index, doc);
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch {}
}

// Only accept real images: JPEG, PNG or WebP magic bytes.
function imageType(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function store(talkId, buf, type) {
  let bucket = frames.get(talkId);
  if (!bucket) { bucket = { next: 1, items: new Map() }; frames.set(talkId, bucket); }
  const n = bucket.next++;
  bucket.items.set(n, { buf, type, ts: Date.now() });
  while (bucket.items.size > MAX_FRAMES) bucket.items.delete(bucket.items.keys().next().value);
  return n;
}

module.exports = {
  register(app, ctx) {
    app.post(
      '/api/rooms/:room/slide-frame',
      ctx.auth.api('SPEAKER_KEY'),
      express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '1.5mb' }),
      (req, res) => {
        const roomId = String(req.params.room);
        const buf = req.body;
        if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ error: 'expected an image body' });
        const type = imageType(buf);
        if (!type) return res.status(415).json({ error: 'not a JPEG, PNG or WebP image' });

        const now = Date.now();
        if (now - (lastUpload.get(roomId) || 0) < MIN_GAP_MS) return res.status(429).json({ error: 'too fast' });
        lastUpload.set(roomId, now);

        const room = ctx.state.room(roomId);
        // No live talk yet: keep pre-show frames under their own bucket.
        const talkId = room.talkId || `preshow-${roomId}`;
        const n = store(talkId, buf, type);
        const url = `/slides/live/${encodeURIComponent(talkId)}/${n}.jpg`;

        const slide = { talkId, n, total: 0, url };
        room.slide = slide; // new phones get it on join (hub.js)
        ctx.hub.send(roomId, { t: 'slide', ...slide });
        esIndex(ctx, 'pulse-actions', {
          room: roomId, talkId, actor: 'relay', action: 'slide', detail: JSON.stringify(slide), ts: now,
        });
        res.json({ n, url });
      },
    );

    app.get('/slides/live/:talkId/:file', (req, res) => {
      const m = /^(\d+)\.jpg$/.exec(req.params.file);
      const item = m && frames.get(String(req.params.talkId))?.items.get(Number(m[1]));
      if (!item) return res.status(404).end();
      res.set('Content-Type', item.type);
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
      res.send(item.buf);
    });
  },
  _test: { imageType, frames },
};
