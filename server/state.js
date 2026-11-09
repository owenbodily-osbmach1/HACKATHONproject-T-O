// In-memory live state shared by every module. replicas: 1, so this is the source of truth for the live path.
const rooms = new Map(); // room -> Room

function room(id) {
  id = String(id);
  if (!rooms.has(id)) {
    rooms.set(id, {
      room: id,
      talkId: null,
      title: '',
      speaker: '',
      settings: { captions: true, listen: true, slides: true },
      captions: [], // last 50 {talkId, seq, text, ts}
      slide: null, // last {talkId, n, total, url}
      micDb: null,
      lastCaptionTs: 0,
      simulated: false,
    });
  }
  return rooms.get(id);
}

const talks = new Map(); // talkId -> {talkId, room, title, speaker, start, end}

module.exports = { rooms, room, talks };
