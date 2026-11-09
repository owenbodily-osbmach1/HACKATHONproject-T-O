// Seeded demo room: a fake live talk with a transcript that keeps growing, a fake mic level,
// a few audience questions and one "can't see the slides" ticket. It lets the demo show the AV
// tech jumping between the real room and a second room without a second speaker.
//
// MOCK_ROOM=255 (default) picks the room id; MOCK_ROOM=off turns it off.
// The room is flagged `simulated: true` in GET /api/rooms. Nothing here is written to Elasticsearch.
// Votes and questions go through the public HTTP routes (like scripts/simulate.js), so tickets and
// question groups behave exactly as they do for a real room.
const crypto = require('crypto');
const http = require('http');

const ROOM = String(process.env.MOCK_ROOM || '255');
const ENABLED = ROOM.toLowerCase() !== 'off' && ROOM !== '0';
const TITLE = 'Scaling Argo CD to 500 clusters';
const SPEAKER = 'Priya Raman (demo room)';
const LINE_MS = 5000; // one caption line every ~5 s while live

const SCRIPT = [
  'Thanks everyone for coming, this one is about running Argo CD at a scale it was not really built for.',
  'Two years ago we had twelve clusters and one Argo CD instance, and life was simple.',
  'Today we have just over five hundred clusters across three clouds and the edge.',
  'The first thing that broke was not Kubernetes, it was the application controller.',
  'Every cluster you add means more watches, more cache, and more memory in one process.',
  'At around one hundred and twenty clusters the controller was using forty gigabytes of memory.',
  'So the first lesson is shard the controller early, before you need to.',
  'We run eight controller replicas and assign clusters to shards with a simple hash.',
  'The round robin sharding in newer versions works well, but watch for hot clusters.',
  'One cluster with three thousand applications can still pin a whole shard.',
  'The second thing that broke was the repo server and our Git provider rate limits.',
  'Five hundred clusters refreshing every three minutes is a lot of git fetches.',
  'We moved to webhooks for refresh and turned the polling interval way up.',
  'We also put a caching proxy in front of Git, which cut fetches by about ninety percent.',
  'Manifest generation is the next bottleneck, especially with Helm and big values files.',
  'We pre-render Helm charts in CI and commit plain manifests to an environment repo.',
  'That one change made syncs about four times faster for our largest apps.',
  'Now let us talk about application sets, because nobody writes five hundred apps by hand.',
  'We use the cluster generator with labels, so a new cluster gets its apps automatically.',
  'Adding a cluster is now one pull request that adds a secret with the right labels.',
  'Progressive rollout matters a lot at this scale, you do not want to break every cluster at once.',
  'We roll changes out in waves, canary clusters first, then ten percent, then everyone.',
  'Each wave waits on health checks and a small set of service level objectives.',
  'If error rates go up, the rollout stops and the wave is rolled back automatically.',
  'Observability was the part we underestimated the most.',
  'We export controller metrics with OpenTelemetry and alert on reconcile queue depth.',
  'Sync duration per shard is the single most useful graph we have.',
  'For security every cluster pulls with its own scoped credentials, nothing shares a token.',
  'And the Argo CD API is behind single sign on with role based access per team.',
  'A few numbers to finish: five hundred and twelve clusters, about forty thousand applications.',
  'Median sync time is under thirty seconds, and the controllers use less memory than before.',
  'If you remember one thing, shard early, render in CI, and roll out in waves.',
  'I will take questions now, and the slides are linked from the Pulse page on your phone.',
];

const QUESTIONS = [
  'How do you decide which clusters are canaries?',
  'Did you look at running one Argo CD per region instead of sharding?',
  'Which canary clusters go first in a rollout?',
];

let ctx = null;
let timer = null;
let idx = 0;
let seq = 0;

function room() { return ctx.state.room(ROOM); }

function newTalkId() {
  let id;
  do { id = 'demo' + crypto.randomBytes(3).toString('hex'); } while (ctx.state.talks.has(id));
  return id;
}

// Same path as a caption from a keyed mic socket (server/hub.js onCaption), minus Elasticsearch.
function emit(talkId, text, ts) {
  const r = room();
  seq += 1;
  const line = { talkId, seq, text, ts };
  r.captions.push(line);
  if (r.captions.length > 50) r.captions.splice(0, r.captions.length - 50);
  ctx.state.addLine(line);
  r.lastCaptionTs = Date.now();
  ctx.hub.send(ROOM, { t: 'caption', ...line }, ['attendee', 'viewer', 'tech']);
}

function liveTalkId() {
  const t = ctx.state.liveTalk(ROOM);
  return t ? t.talkId : null;
}

// A believable crowd for the demo room: ~140 scanned the code, ~115 still here, a few listening.
function driftCrowd() {
  const r = room();
  if (!r.sim) r.sim = { joined: 138, here: 112, listening: 9 };
  const live = !!liveTalkId();
  const s = r.sim;
  if (live) {
    if (Math.random() < 0.35) s.joined += 1;
    s.here = Math.max(80, Math.min(s.joined, s.here + Math.round((Math.random() - 0.4) * 3)));
    s.listening = Math.max(4, Math.min(16, s.listening + Math.round((Math.random() - 0.5) * 2)));
  } else {
    s.here = Math.max(0, s.here - 6); // people drift out after the talk
    s.listening = 0;
  }
}

function tick() {
  const r = room();
  driftCrowd();
  const talkId = liveTalkId();
  if (!talkId) { r.micDb = null; return; }
  r.micDb = -26 + Math.random() * 12; // a speaker at a normal level
  const text = SCRIPT[idx % SCRIPT.length];
  idx += 1;
  // A half-said line first, like real speech recognition.
  const half = text.split(' ').slice(0, Math.ceil(text.split(' ').length / 2)).join(' ');
  ctx.hub.send(ROOM, { t: 'caption_interim', text: half }, ['attendee', 'viewer']);
  setTimeout(() => { if (liveTalkId() === talkId) emit(talkId, text, Date.now()); }, 1200);
}

function local(method, path, body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: ctx.config.PORT, method, path,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
    }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', () => resolve(0));
    req.end(data);
  });
}

// Votes and questions through the public routes, so tickets and question groups are real.
async function seedSignals(talkId) {
  for (const text of QUESTIONS) {
    await local('POST', '/api/questions', { room: ROOM, talkId, text, clientId: `demo-q-${crypto.randomBytes(3).toString('hex')}` });
  }
  // One ticket is enough: a restart doesn't pile more votes onto a ticket that is still open.
  if (require('./tickets').openTickets(ROOM) > 0) return;
  for (let i = 1; i <= 3; i++) {
    await local('PUT', '/api/votes', { room: ROOM, talkId, type: 'cant_see', clientId: `demo-phone-${i}-${talkId}`, on: true });
  }
}

// Start (or restart) the demo talk: a fresh talk that started ~14 min ago with lines already said.
function startTalk({ signals = true } = {}) {
  const prev = liveTalkId();
  if (prev) ctx.state.talks.get(prev).end = Date.now();
  const talkId = newTalkId();
  const now = Date.now();
  const start = now - 14 * 60 * 1000;
  const r = room();
  r.simulated = true;
  r.capacity = r.capacity || 160;
  r.sim = { joined: (r.sim && r.sim.joined) || 138, here: 112, listening: 9 };
  r.talkId = talkId;
  r.title = TITLE;
  r.speaker = SPEAKER;
  r.captions = [];
  r.slide = null;
  ctx.state.talks.set(talkId, { talkId, room: ROOM, title: TITLE, speaker: SPEAKER, start, end: null, simulated: true });
  seq = 0;
  idx = 0;
  const already = 18;
  for (let i = 0; i < already; i++) {
    emit(talkId, SCRIPT[i], now - (already - i) * 40 * 1000);
    idx += 1;
  }
  r.lastCaptionTs = now;
  r.micDb = -20;
  ctx.hub.send(ROOM, ctx.state.talkMessage(ROOM));
  if (signals) setTimeout(() => seedSignals(talkId), 300);
  return talkId;
}

module.exports = {
  room: ROOM,
  enabled: ENABLED,
  register(app, c) {
    ctx = c;
    if (!ENABLED) return;
    // Restart the demo talk (TECH_KEY). Only works on the simulated room.
    app.post('/api/rooms/:room/demo/restart', ctx.auth.api('TECH_KEY'), (req, res) => {
      if (String(req.params.room) !== ROOM) return res.status(404).json({ error: 'not a demo room' });
      res.json({ talkId: startTalk() });
    });
    // After the server is listening, so the seeded votes and questions can use the HTTP routes.
    setTimeout(() => startTalk(), 1500).unref?.();
    clearInterval(timer);
    timer = setInterval(tick, LINE_MS);
    if (timer.unref) timer.unref();
  },
};
