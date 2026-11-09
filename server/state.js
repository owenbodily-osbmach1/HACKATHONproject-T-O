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
// Full transcript per talk in memory (capped), so transcripts work live and without Elasticsearch.
const transcripts = new Map(); // talkId -> [{talkId, seq, text, ts}]
const MAX_LINES = 20000;
function addLine(line) {
  if (!line.talkId) return;
  let arr = transcripts.get(line.talkId);
  if (!arr) transcripts.set(line.talkId, (arr = []));
  arr.push(line);
  if (arr.length > MAX_LINES) arr.shift();
}

module.exports = { rooms, room, talks, transcripts, addLine };
