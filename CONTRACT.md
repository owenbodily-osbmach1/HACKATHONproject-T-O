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
| GET | `/api/rooms` | — | `[{room, talkId, title, listeners, openTickets, simulated}]` |
| PUT | `/api/votes` | `{room, talkId, type, clientId, on}` | `{count, ticketStatus}` |
| POST | `/api/questions` | `{room, talkId, text, clientId}` | `{qid, groupId}` |
| POST | `/api/feedback` | `{ticketId, clientId, better}` | `{better, stillBad}` |
| POST | `/api/tickets/:id/claim` · `/fixed` · `/dismiss` | `{by}` | `{status}` |
| GET | `/api/report/:talkId` | — | `{transcript[], signalsByMinute[], questions[]}` |
| GET / POST | `/api/config` | `{alertThreshold}` | `{alertThreshold, nudgeThreshold}` |
| GET | `/healthz` | — | `ok` |

- Vote `type`: `cant_hear` | `cant_see` (`room_full` is a stretch goal).
- Ticket `status`: `open` | `claimed` | `fixed` | `reopened` | `dismissed`.
- One vote per `clientId` per type per talk. `on: false` takes the vote back. Votes expire after 10 min and clear when a ticket is marked fixed.
- Room switches: `POST /api/rooms/:room/settings` `{captions, listen, slides}` (tech only). Server sends `room_settings` to every role in the room.

Transcript and admin routes (admin routes need `TECH_KEY`):

- `GET /api/talks/:talkId/transcript?from=<seq>&format=json|txt`
- `GET /api/rooms/:room/talks`
- `POST /api/questions/:qid/queue` · `/hide` · `/answered`
- `POST /api/questions/:qid/reply` `{text}`
- `POST /api/rooms/:room/broadcast` `{text}`
- `POST /api/clients/:clientId/mute` `{minutes}`

## WebSocket: `/ws?room=151&role=attendee|mic|tech|org`

All messages are JSON with a `t` field. `role=mic` must also pass `&key=SPEAKER_KEY`; `role=tech` must pass `&key=TECH_KEY`.

| `t` | Direction | Fields | Who gets it |
| --- | --- | --- | --- |
| `caption` | mic → server → room | `talkId, seq, text, ts` | attendee, tech |
| `caption_interim` | mic → server → room | `text` | attendee |
| `caption_backlog` | server → (on join) | `lines[]` (last 50) | attendee, tech |
| `vote_count` | server → | `type, count, windowSec` | attendee |
| `ticket` | server → | `id, room, type, people, status, openedAt, cause, steps[]` | tech, org |
| `ticket_status` | server → | `ticketId, type, status` | attendee |
| `room_status` (every 2 s) | server → | `room, listeners, micDb, captionGapSec, openTickets` | tech, org |
| `room_settings` | server → | `captions, listen, slides` | all |
| `question_groups` | server → | `groups[{groupId, text, count, answered}]` | tech |
| `question_update` | server → | `qid, pinned, hidden, answered` | tech |
| `question_reply` | server → | `qid, text` | the askers only |
| `broadcast` | server → | `text` | attendee |
| `feed` | server → | `kind, room, text, ts, refId` | tech |
| `slide` | present/mic → server → room | `talkId, n, total, url` | all (and new phones on join) |
| `ping` / `pong` | both, every 20 s | — | all |

Audio uses its own binary-only sockets:

- `/ws/audio-in?room=151&key=SPEAKER_KEY` — Int16 little-endian, mono, 16 kHz, 1,600 samples per frame (100 ms, 3,200 bytes).
- `/ws/audio-out?room=151` — the same frames out. Send-only: the server ignores anything a phone sends.
- A binary frame on any other socket closes that connection.

## Mic lock (security)

- Every page except `/mic/:room` is served with `Permissions-Policy: microphone=(), camera=()`. Only `/mic/:room` gets `microphone=(self)`.
- Attendee pages never call `getUserMedia`.

## Slides

- `GET /present/:room` (needs `SPEAKER_KEY`), static images in `public/slides/<deck>/` plus `slides.json` = `[{n, url, alt}]`.
- Slide changes are saved in `pulse-actions` with `action: 'slide'`.

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
