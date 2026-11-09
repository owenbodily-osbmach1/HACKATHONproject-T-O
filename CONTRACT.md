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

Every change goes in as a pull request. Gitar reviews it; the *other* person merges.

## HTTP routes

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| POST | `/api/talks` | `{room, title, speaker}` | `{talkId}` |
| POST | `/api/talks/:talkId/end` | — | `{reportUrl}` |
| GET | `/api/rooms` | — | `[{room, talkId, title, speaker?, listeners, openTickets, simulated}]` |
| PUT | `/api/votes` | `{room, talkId, type, clientId, on}` | `{count, ticketStatus}` |
| POST | `/api/questions` | `{room, talkId, text, clientId}` | `{qid, groupId}` |
| POST | `/api/feedback` | `{ticketId, clientId, better}` | `{better, stillBad}` |
| POST | `/api/tickets/:id/claim` · `/fixed` · `/dismiss` | `{by}` | `{status}` |
| GET | `/api/report/:talkId` | — | `{transcript[], signalsByMinute[], questions[]}` |
| GET / POST | `/api/config` | `{alertThreshold}` | `{alertThreshold, nudgeThreshold, publicBaseUrl}` (`publicBaseUrl` = `PUBLIC_BASE_URL`; the mic page builds the QR code from it) |
| POST | `/api/rooms/:room/slide-frame` | raw `image/jpeg` (≤ 1.5 MB), `SPEAKER_KEY` | `{n, url}` (slide relay; server then sends `slide` with `total: 0`) |
| GET | `/slides/live/:talkId/:n.jpg` | — | the captured slide JPEG (`Cache-Control: public, max-age=31536000, immutable`) |
| GET | `/qr/:room.gif` | — | QR code image for `<public base>/r/:room` (insert the join code into a deck by URL) |
| GET | `/healthz` | — | `ok` |

- Slide relay uploads are kept in memory (last 150 frames per talk or per room while no talk is live); a second upload less than 1 s after the previous one for the same room returns `429`.
- Vote `type`: `cant_hear` | `cant_see` (`room_full` is a stretch goal). With no live talk in the room, `PUT /api/votes` returns `409 {error:'no_live_talk'}`.
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
| `SPEAKER_KEY` | `POST /api/talks` · `POST /api/talks/:talkId/end` · `POST /api/rooms/:room/slide-frame` · pages `/mic/:room`, `/present/:room` and `/relay/:room` |
| none | `GET /api/rooms`, `PUT /api/votes`, `POST /api/questions`, `POST /api/feedback`, `GET /api/report/:talkId`, `GET /api/config`, transcript routes, `/healthz`, pages `/r/:room`, `/t/:talkId`, `/room/:room`, `/org` |

## WebSocket: `/ws?room=151&role=attendee|viewer|mic|present|tech|org`

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

- Every page except `/mic/:room` is served with `Permissions-Policy: microphone=(), camera=()`. Only `/mic/:room` gets `microphone=(self)`.
- Attendee pages never call `getUserMedia`.

## Slides

- `GET /present/:room?key=SPEAKER_KEY` (connects as `role=present`), static images in `public/slides/<deck>/` plus `slides.json` = `[{n, url, alt}]`.
- Slide changes are saved in `pulse-actions` with `action: 'slide'`.
- Slide relay: `GET /relay/:room?key=SPEAKER_KEY` captures the slideshow screen and posts changed frames to `POST /api/rooms/:room/slide-frame`; the server stores the last 150 frames per talk (or under a room `preshow` bucket while no talk is live), serves them at `/slides/live/:talkId/:n.jpg`, and sends the normal `slide` message with `total: 0`. A frame upload less than 1 s after the previous one for the room returns `429`.

## Elasticsearch indices

| Index | Fields |
| --- | --- |
| `pulse-captions` | `talkId` keyword · `room` keyword · `seq` integer · `text` text (copied to `text_sem`) · `text_sem` semantic_text · `ts` date · `minute` integer |
| `pulse-signals` | `talkId` · `room` · `type` keyword · `clientId` keyword · `on` boolean · `ts` date · `minute` integer |
| `pulse-questions` | `qid` · `talkId` · `room` · `text` (copied to `text_sem`) · `text_sem` semantic_text · `clientId` · `ts` · `groupId` keyword · `answered` boolean · `answeredSeq` integer |
| `pulse-tickets` | `id` · `room` · `talkId` · `type` · `status` · `people` · `openedAt` · `ackAt` · `fixedAt` · `better` · `stillBad` |
| `pulse-talks` | `talkId` · `title` (copied to `title_sem`) · `abstract` · `track` keyword · `room` keyword · `start` date · `end` date · `speakers` |
| `pulse-actions` | `room` · `talkId` · `actor` · `action` keyword · `detail` · `ts` |

Set `inference_id` explicitly from `ES_INFERENCE_ID`. If inference isn't available, fall back to a plain `match` query.

## Environment variables

Kubernetes Secret (entered in the Radar UI) or local `.env`. **Never committed.** See `.env.example`.

`PORT` · `PUBLIC_BASE_URL` · `SPEAKER_KEY` · `TECH_KEY` · `ALERT_THRESHOLD=3` · `ALERT_WINDOW_SEC=60` · `CAPTIONS_DEFAULT=on` · `ELASTIC_URL` · `ELASTIC_API_KEY` · `ES_INFERENCE_ID` · `OTEL_SERVICE_NAME=pulse` · `OTEL_EXPORTER_OTLP_ENDPOINT` · `OTEL_EXPORTER_OTLP_HEADERS`

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
| GET | `/api/booths/:booth/report` (TECH_KEY) | — | `{visits, uniqueDevices, open: [requests], fromTalks: [{talkId, title, devices}], topics: [{text, devices}]}` |

- **Passport:** one stamp per `clientId` per booth. `suspect: true` if the same device stamped another booth less than 30 s earlier (not counted toward `stamps`).
- **Next booth:** from the captions this device actually received in rooms it joined as `attendee` (last 20 lines across rooms). Elastic semantic search of those lines against booth `about` (`pulse-booths.about_sem`, RRF with a match query); fallback is word overlap in memory. Never suggest a booth already stamped. `because` is the caption line (≤ 120 chars) that matched best.
- **Privacy:** the report never names a device. Any `fromTalks` or `topics` bucket with fewer than 3 devices is dropped (k ≥ 3). No identity is collected.
- WebSocket: booth staff connect `/ws?room=<booth>&role=tech&key=TECH_KEY` and get `{t:'booth_request', requestId, kind, position, ts}` and `{t:'booth_request_done', requestId}`.
- Elastic: `pulse-booths` (`id`, `sponsor`, `about` → `about_sem` semantic_text), `pulse-checkins` (`booth`, `clientId`, `ts`, `suspect`, `fromTalks` keyword[]).
