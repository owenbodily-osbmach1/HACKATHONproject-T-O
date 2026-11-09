# Pulse — API contract

Source of truth for names shared between the UI (Owen) and the backend (Ty).
**After both of us accept this file, nobody renames a route, message, field or index without telling the other person in the PR description.**

Plain HTML + vanilla JS, no build step. Node 20, Express + `ws`. One pod (`replicas: 1`): rooms, sockets and vote windows live in memory.

## Who owns what

| Path | Owner | What lives there |
| --- | --- | --- |
| `public/` | Owen (UI) | Every page and all browser JS: `r.html` (attendee), `tech.html` (technician console), `mic.html` (podium mic page), `present.html`, `t.html` (transcript/report), `org.html`, `captions.js`, `capture.js` (AudioWorklet), `player.js`, `styles.css`, `slides/` |
| `server/` | Ty (backend) | `index.js` (Express, static, `/healthz`), WebSocket hub, `tickets.js`, audio fan-out, `wordfix.js`, `es.js`, `otel.js` |
| `k8s/`, `Dockerfile` | Ty | Deployment with `replicas: 1`, Service, Ingress |
| `scripts/` | Ty | `es-setup.js` (index mappings), `loadtest.js` |
| `CONTRACT.md`, `.gitar/` | Both | Changes need a note in the PR description |

Every change goes in as a pull request. Gitar reviews it; merge only after Gitar approves.

## HTTP routes

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| POST | `/api/talks` | `{room, title, speaker}` | `{talkId}` |
| POST | `/api/talks/:talkId/end` | — | `{reportUrl}` |
| GET | `/api/rooms` | — | `[{room, talkId, title, speaker?, listeners, openTickets, simulated}]` (`talkId: null`, `title: ''` when no talk is live) |
| PUT | `/api/votes` | `{room, talkId, type, clientId, on}` | `{count, ticketStatus}` |
| POST | `/api/questions` | `{room, talkId, text, clientId}` | `{qid, groupId}` |
| POST | `/api/feedback` | `{ticketId, clientId, better}` | `{better, stillBad}` |
| POST | `/api/tickets/:id/claim` · `/fixed` · `/dismiss` | `{by}` | `{status}` |
| GET | `/api/report/:talkId` | — | `{transcript[], signalsByMinute[], questions[]}` |
| GET | `/api/find?q=&from=&limit=` | — | `{sessions:[{id, title, start, location, why}], said:[{talkId, title, seq, text, ts}]}` |
| GET | `/api/find/next?clientId=&limit=` | — | `[{id, title, start, location, because}]` |
| GET / POST | `/api/config` | `{alertThreshold}` | `{alertThreshold, nudgeThreshold, publicBaseUrl}` (`publicBaseUrl` = `PUBLIC_BASE_URL`; the mic page builds the QR code from it) |
| POST | `/api/rooms/:room/slide-frame` | raw `image/jpeg`, `image/png` or `image/webp` (≤ 1.5 MB), `SPEAKER_KEY` | `{n, url}` (slide relay; server then sends `slide` with `total: 0`) |
| GET | `/slides/live/:talkId/:n.jpg` | — | the captured slide image (JPEG, PNG or WebP; response `Content-Type` matches the image format; `Cache-Control: public, max-age=31536000, immutable`) |
| GET | `/qr/:room.gif` | — | QR code image for `<public base>/r/:room` (insert the join code into a deck by URL) |
| GET | `/healthz` | — | `ok` |
| GET | `/rum-config.js` | — | `window.PULSE_RUM = {serviceName, endpoint, token}` for browser RUM, or `null` when `DASH0_RUM_TOKEN` is unset (`Cache-Control: no-store`) |
| GET | `/privacy` | — | privacy page (public): what is stored and every index field |
| GET | `/api/privacy` | — | `{source, elasticsearch, indices:[{index, fields:[{field, type}]}], privacy}` (see "Privacy") |
| GET | `/cards` | — | printable QR cards page (public): one card per room and booth, 2 per page |
| GET | `/metrics` | — | Prometheus text format (see "Metrics") |

- Slide relay uploads are kept in memory (last 150 frames per talk or per room while no talk is live); a second upload less than 1 s after the previous one for the same room returns `429`.
- Vote `type`: `cant_hear` | `cant_see` (`room_full` is a stretch goal). With no live talk in the room, `PUT /api/votes` returns `409 {error:'no_live_talk'}`; a `talkId` other than the room's live talk returns `409 {error:'stale_talk', talkId: <live talkId>}`.
- Public room ids match `[A-Za-z0-9_-]{1,32}`; `clientId` is limited to 64 characters. Invalid room ids or overlong client ids are rejected with `400`.
- Questions sent before a talk starts are kept under the room and attached to the next talk when it starts.
- Ticket `status`: `open` | `claimed` | `fixed` | `reopened` | `dismissed`.
- One vote per `clientId` per type per talk. `on: false` takes the vote back. Votes expire after 10 min and clear when a ticket is marked fixed.
- "Still bad": the phone sends `POST /api/feedback` with `better: false` **and then** `PUT /api/votes` with `on: true`. The feedback route only records the answer; it does not re-add the vote itself.
- Room switches: `POST /api/rooms/:room/settings` `{captions, listen, slides}` (tech only). Server sends `room_settings` to every role in the room.

Search: `GET /api/search?q=&talkId=` → `[{talkId, seq, text, ts}]`, hybrid (RRF of a match query and a semantic query on `text_sem`), falling back to a plain match.

Transcript and admin routes:

- `GET /api/talks/:talkId/transcript?from=<seq>&format=json|txt` (public)
- `GET /api/rooms/:room/talks` (public, feeds the room archive `/room/:room`)
- `POST /api/questions/:qid/queue` · `/hide` · `/answered`
- `POST /api/questions/:qid/reply` `{text}`
- `POST /api/rooms/:room/broadcast` `{text}`
- `POST /api/clients/:clientId/mute` `{minutes}`

## Auth (keys)

One mechanism everywhere. Keyed **pages** are opened with `?key=...` in the URL (e.g. `/tech?key=...`); the page reads it from `location.search` and sends it on every API call in the **`x-pulse-key`** header and on its WebSocket as `&key=`. Wrong or missing key: HTTP `401`, WebSocket closed with code `4401`.

| Key | HTTP routes and pages that require it |
| --- | --- |
| `TECH_KEY` | `POST /api/tickets/:id/claim` · `/fixed` · `/dismiss` · `POST /api/config` · `POST /api/rooms/:room/settings` · `POST /api/questions/:qid/*` · `POST /api/rooms/:room/broadcast` · `POST /api/clients/:clientId/mute` · page `/tech` |
| `SPEAKER_KEY` | `POST /api/talks` · `POST /api/talks/:talkId/end` · `POST /api/rooms/:room/slide-frame` · pages `/mic/:room`, `/present/:room`, `/relay/:room` and `/go/:room` |
| none | `GET /api/rooms`, `PUT /api/votes`, `POST /api/questions`, `POST /api/feedback`, `GET /api/report/:talkId`, `GET /api/config`, transcript routes, `/healthz`, `/privacy`, `/api/privacy`, `/cards`, `/metrics`, pages `/r/:room`, `/t/:talkId`, `/room/:room`, `/org`, `/find` |

## WebSocket: `/ws?room=151&role=attendee|viewer|mic|present|tech|org`

Attendee sockets also send `&clientId=<anonymous per-phone id>` (from `public/lib/store.js`). The server uses it to deliver `question_reply` to the asker and to attribute heard captions for booths and `/api/find/next`.

`viewer` (no key) is for transcript/report pages: it receives `caption`, `caption_interim` and `caption_backlog` like `attendee` but is not counted in `listeners`.

All messages are JSON with a `t` field. `role=mic` and `role=present` must also pass `&key=SPEAKER_KEY`; `role=tech` must pass `&key=TECH_KEY`.

**Sender check:** the server relays `caption` and `caption_interim` only from a keyed `mic` socket, and `slide` only from a keyed `mic` or `present` socket. The same messages from any other role are dropped (not relayed, not stored).

| `t` | Direction | Fields | Who gets it |
| --- | --- | --- | --- |
| `caption` | mic → server → room | `talkId, seq, text, ts` | attendee, tech |
| `caption_interim` | mic → server → room | `text` | attendee |
| `caption_backlog` | server → (on join) | `lines[]` (last 50) | attendee, tech |
| `ticket` (snapshot) | server → (on join) | one `ticket` message per open / claimed / reopened ticket in the room, plus the current `question_groups` | tech, org |
| `vote_count` | server → | `type, count, windowSec` | attendee |
| `ticket` | server → | `id, room, type, people, status, openedAt, cause, steps[]` | tech, org |
| `ticket_status` | server → | `ticketId, type, status` | attendee |
| `room_status` (every 2 s) | server → | `room, listeners, micDb, captionGapSec, openTickets` | tech, org, mic |
| `room_settings` | server → | `captions, listen, slides` | all |
| `question_groups` | server → | `groups[{groupId, qid, text, count, answered}]` (`qid` = first question in the group; tech actions use it) | tech |
| `question_update` | server → | `qid, pinned, hidden, answered` | tech |
| `question_reply` | server → | `qid, text` | the askers only |
| `broadcast` | server → | `text` | attendee |
| `feed` | server → | `kind, room, text, ts, refId` | tech |
| `slide` | present/mic → server → room (or server, after a relay upload) | `talkId, n, total, url, alt?` (`total: 0` = unknown, captured deck) | all (and new phones on join) |
| `talk` | server → (on join and on every change) | `talkId, title, speaker, status: 'waiting'\|'live'\|'ended', startedAt, reportUrl?, next?: {title, start}` | all |
| `ping` / `pong` | both, every 20 s | — | all |

Audio uses its own binary-only sockets:

- `/ws/audio-in?room=151&key=SPEAKER_KEY` — Int16 little-endian, mono, 16 kHz, 1,600 samples per frame (100 ms, 3,200 bytes).
- `/ws/audio-out?room=151` — the same frames out. Send-only: the server ignores anything a phone sends.
- A binary frame on any other socket closes that connection.

## Mic lock (security)

- Every page except `/mic/:room` and `/go/:room` is served with `Permissions-Policy: microphone=(), camera=()`. Only `/mic/:room` and `/go/:room` (the one-button control page) get `microphone=(self)`.
- Attendee pages never call `getUserMedia`.

## Slides

- `GET /present/:room?key=SPEAKER_KEY` (connects as `role=present`), static images in `public/slides/<deck>/` plus `slides.json` = `[{n, url, alt}]`.
- Slide changes are saved in `pulse-actions` with `action: 'slide'`.
- One-button control: `GET /go/:room?key=SPEAKER_KEY` combines the podium mic (`role=mic` socket, captions, `/ws/audio-in`) and the slide relay in one page with a single Go live button.
- Slide relay: `GET /relay/:room?key=SPEAKER_KEY` captures the slideshow screen and posts changed frames to `POST /api/rooms/:room/slide-frame`; the server stores the last 150 frames per talk (or under a room `preshow` bucket while no talk is live), serves them at `/slides/live/:talkId/:n.jpg`, and sends the normal `slide` message with `total: 0`. A frame upload less than 1 s after the previous one for the room returns `429`.

## Elasticsearch indices

| Index | Fields |
| --- | --- |
| `pulse-captions` | `talkId` keyword · `room` keyword · `seq` integer · `text` text (copied to `text_sem`) · `text_sem` semantic_text · `ts` date · `minute` integer |
| `pulse-signals` | `talkId` · `room` · `type` keyword · `clientId` keyword · `on` boolean · `ts` date · `minute` integer |
| `pulse-questions` | `qid` · `talkId` · `room` · `text` (copied to `text_sem`) · `text_sem` semantic_text · `clientId` · `ts` · `groupId` keyword · `answered` boolean · `answeredSeq` integer · `hidden` boolean |
| `pulse-tickets` | `id` · `room` · `talkId` · `type` · `status` · `people` · `openedAt` · `ackAt` · `fixedAt` · `better` · `stillBad` |
| `pulse-talks` | `talkId` · `title` (copied to `title_sem`) · `abstract` · `track` keyword · `room` keyword · `start` date · `end` date · `speakers` |
| `pulse-actions` | `room` · `talkId` · `actor` · `action` keyword · `detail` · `ts` |
| `pulse-schedule` | `id` keyword · `title` text (copied to `title_sem`) · `abstract` text (copied to `abstract_sem`) · `title_sem` semantic_text · `abstract_sem` semantic_text · `track` keyword · `location` keyword · `start` date · `end` date · `sponsor` keyword |

Set `inference_id` explicitly from `ES_INFERENCE_ID`. If inference isn't available, fall back to a plain `match` query.

## Privacy

Public page `/privacy` (`public/privacy.html`, no key) and `GET /api/privacy`. The page states plainly: no names, email addresses, phone numbers, IP addresses or accounts are stored; `clientId` is a random id generated on the phone; booth reports hide any group under 3 devices; the technician and speaker keys are never logged or traced.

`GET /api/privacy` returns:

```json
{
  "source": "elasticsearch | mixed | static",
  "elasticsearch": true,
  "indices": [{ "index": "pulse-captions", "fields": [{ "field": "talkId", "type": "keyword" }] }],
  "privacy": {
    "personalData": false,
    "identifier": "clientId",
    "clientIdRandom": true,
    "clientIdGeneratedOnDevice": true,
    "boothMinDevices": 3,
    "keysLogged": false,
    "keysTraced": false
  }
}
```

- Every index Pulse writes is listed. Fields are read live from `GET /<index>/_mapping` when Elasticsearch is enabled. When it is disabled, or a mapping cannot be read, fields come from `scripts/es-setup.js` (`mappings`), so the list cannot drift.
- `source`: `elasticsearch` when every mapping was read live, `mixed` when only some were, `static` when none were (including Elasticsearch disabled).
- The response must not contain a field named `name`, `email`, `phone` or `ip`; `scripts/extras-check.js` asserts this.

## Metrics

`GET /metrics` (no key) returns Prometheus text format, hand-written with no extra dependency:

| Metric | Type | Labels |
| --- | --- | --- |
| `pulse_up` | gauge, always `1` | — |
| `pulse_listeners` | gauge | `room` |
| `pulse_rooms_alerting` | gauge | — |
| `pulse_open_tickets` | gauge | `room` |
| `pulse_booth_open_requests` | gauge | `booth` |
| `process_resident_memory_bytes` | gauge | — |

The deployment template carries `prometheus.io/scrape: "true"`, `prometheus.io/port: "8080"` and `prometheus.io/path: "/metrics"`.

OTLP (Dash0): marking a booth request done records histogram `pulse.booth.request_ack` (seconds, attribute `pulse.booth`); creating a request counts `pulse.booth.requests` (attribute `pulse.kind`). Both are fire-and-forget and never delay the request response.

## Environment variables

Kubernetes Secret (entered in the Radar UI) or local `.env`. **Never committed.** See `.env.example`.

`PORT` · `PUBLIC_BASE_URL` · `SPEAKER_KEY` · `TECH_KEY` · `ALERT_THRESHOLD=3` · `ALERT_WINDOW_SEC=60` · `CAPTIONS_DEFAULT=on` · `ELASTIC_URL` · `ELASTIC_API_KEY` · `ES_INFERENCE_ID` · `OTEL_SERVICE_NAME=pulse` · `OTEL_EXPORTER_OTLP_ENDPOINT` · `OTEL_EXPORTER_OTLP_HEADERS` · `DASH0_RUM_TOKEN` (public, ingest-only) · `DASH0_RUM_ENDPOINT=https://ingress.us-west-2.aws.dash0.com`

## Booths (expo floor)

A booth is a place like a room, keyed by a short id (`gitar`, `dash0`, …). Booth demos are just talks in a room whose id is the booth id, so captions, questions and reports work unchanged. Booth config lives in `server/booths.json`: `[{id, sponsor, table, pitch, about, resourcesUrl}]` (`about` is 2–4 sentences used for matching).

### Pages
| Page | Key | What |
| --- | --- | --- |
| `/b/:booth` | none | Attendee booth page (QR on the table): sponsor, pitch, passport progress, next-booth card, "Talk to an engineer" / "Send me resources" |
| `/booth/:booth?key=TECH_KEY` | `TECH_KEY` | Booth staff screen: live request queue, visits, "talks that sent people here" |

### HTTP
| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| GET | `/api/booths` | — | `[{id, sponsor, table, pitch, resourcesUrl}]` |
| POST | `/api/booths/:booth/checkin` | `{clientId}` | `{booth, stamps, total, suspect, next: {id, sponsor, table, because} \| null}` |
| POST | `/api/booths/:booth/requests` | `{clientId, kind}` (`talk_to_engineer` \| `send_resources`) | `{requestId, position}` |
| POST | `/api/booths/:booth/requests/:id/done` (TECH_KEY) | `{by}` | `{status}` |
| GET | `/api/booths/:booth/report` (TECH_KEY) | — | `{visits, uniqueDevices, dwell: {medianMin, p90Min, n} \| null, open: [requests], fromTalks: [{talkId, title, devices}], topics: [{text, devices}]}` |

- **Passport:** one stamp per `clientId` per booth. `suspect: true` if the same device stamped another booth less than 30 s earlier (not counted toward `stamps`).
- **Next booth:** from the captions this device actually received in rooms it joined as `attendee` (last 20 lines across rooms). Elastic semantic search of those lines against booth `about` (`pulse-booths.about_sem`, RRF with a match query); fallback is word overlap in memory. Never suggest a booth already stamped. `because` is the caption line (≤ 120 chars) that matched best.
- **Privacy:** the report never names a device. Any `fromTalks`, `topics` or dwell group with fewer than 3 devices is dropped or null (k ≥ 3). No identity is collected.
- **Dwell:** for each device's consecutive stamps (booth A at t1, next booth at t2), `dwell_upper(A) = min(t2 - t1, 15 min)`. The report field `dwell` is `{medianMin, p90Min, n}` computed from those upper bounds, only when n ≥ 3, else `null`: time to next stop, an upper bound; shown as a range with n. Consecutive stamps include rejected (suspect) stamps — they still mark a stop — and a device's last stop has no next stamp, so it contributes no sample.
- WebSocket: booth staff connect `/ws?room=<booth>&role=tech&key=TECH_KEY` and get `{t:'booth_request', requestId, kind, position, ts}` and `{t:'booth_request_done', requestId}`.
- Elastic: `pulse-booths` (`id`, `sponsor`, `about` → `about_sem` semantic_text), `pulse-checkins` (`booth`, `clientId`, `ts`, `suspect`, `fromTalks` keyword[]).

## Find the right talk

Public page `/find` (no key, `public/find.html` + `find.js` + `find.css`): "What do you want to learn about?" searches the conference schedule and the captions already relayed in rooms. Results are two lists, "Upcoming sessions" and "Already said in a talk"; a caption hit links to `/t/<talkId>#seq-<seq>`. On load the page also asks for "Next talks for you" using the browser's `clientId` from `public/lib/store.js`.

`server/schedule.json` is the schedule source: 38 Demo Theater sessions and 14 in-booth demos from the public KubeCon NA 2026 listing. Each entry is `{id, title, abstract, track, start, end, location, sponsor?}`. `id` is a slug of the title, `track` is `Demo Theater` or `In-Booth Demo`, `location` is the booth number or `Demo Theater`, and `sponsor` is present only for in-booth demos.

- `GET /api/find?q=&from=&limit=` returns `{sessions:[{id, title, start, location, why}], said:[{talkId, title, seq, text, ts}]}`.
  - `sessions`: RRF over a `multi_match` on `title^3` + `abstract` and a `semantic` query on `abstract_sem` in `pulse-schedule`. `start >= from`; `from` defaults to now and `from=all` removes the filter. `why` is a short matched snippet. With an empty `q` the list is the next sessions by start and `why` is `''`.
  - `said`: the same RRF shape over `text` and `text_sem` in `pulse-captions`, grouped by `talkId` (at most 2 lines per talk) and capped by `limit`.
  - `limit` defaults to 10, caps at 50.
- `GET /api/find/next?clientId=&limit=` returns `[{id, title, start, location, because}]`. It searches the schedule with the last 20 caption lines this device received (rooms it joined as `attendee`, the same `state.heardRooms` as the booth next-card), `from=now`. `because` is the best-matching caption line (≤ 120 chars). No heard lines: the next sessions by start, each with `because: null`. `limit` defaults to 3.
- Fallback when Elasticsearch is disabled or errors: in-memory word overlap over `schedule.json` and `state.transcripts`. Neither route throws.
- Indexing: when Elasticsearch is enabled, server start PUTs every entry to `/pulse-schedule/_doc/<id>` fire-and-forget (15 s write timeout). Mapping is in `scripts/es-setup.js`.
