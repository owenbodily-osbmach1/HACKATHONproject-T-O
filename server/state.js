// In-memory live state shared by every module. replicas: 1, so this is the source of truth for the live path.
const config = require('./config');

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

// Captured slide frames: talkId or 'preshow:<room>' -> last 150 [{n, buf, ts}].
const frames = new Map();
const frameUploadAt = new Map(); // room -> epoch ms of the last accepted upload (1 s rate limit)
const MAX_FRAMES = 150;

// Only a talk without an end is live; an ended talk still sits on room.talkId.
function liveTalk(id) {
  const r = rooms.get(String(id));
  const talk = r && r.talkId ? talks.get(r.talkId) : null;
  return talk && !talk.end ? talk : null;
}

// WebSocket `talk` message (CONTRACT.md): waiting when the room has no talk.
function talkMessage(id) {
  const r = rooms.get(String(id));
  const talk = r && r.talkId ? talks.get(r.talkId) : null;
  if (!talk) {
    return { t: 'talk', talkId: null, title: '', speaker: '', status: 'waiting', startedAt: null };
  }
  const start = typeof talk.start === 'number' ? talk.start : Date.parse(talk.start);
  const msg = {
    t: 'talk',
    talkId: talk.talkId,
    title: talk.title || '',
    speaker: talk.speaker || '',
    status: talk.end ? 'ended' : 'live',
    startedAt: Number.isFinite(start) ? new Date(start).toISOString() : null,
  };
  if (talk.end) {
    msg.reportUrl = `${config.PUBLIC_BASE_URL}/t/${talk.talkId}`;
    msg.endedAt = new Date(talk.end).toISOString();
  }
  return msg;
}

module.exports = {
  rooms,
  room,
  talks,
  transcripts,
  addLine,
  frames,
  frameUploadAt,
  MAX_FRAMES,
  liveTalk,
  talkMessage,
};
