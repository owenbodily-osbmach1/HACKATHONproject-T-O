# Pulse — API contract

Source of truth for names shared between the UI (Owen) and the backend (Ty).
**After both of us accept this file, nobody renames a route, message, field or index without telling the other person in the PR description.**

Plain HTML + vanilla JS, no build step. Node 22, Express + `ws`. One pod (`replicas: 1`): rooms, sockets and vote windows live in memory.

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
| POST | `/api/talks/:talkId/end` | — (`SPEAKER_KEY` or `TECH_KEY`) | `{reportUrl}` |
| GET | `/api/rooms` | — | `[{room, talkId, title, speaker, status, startedAt, listeners, joined, here, capacity, openTickets, simulated}]` (`talkId: null`, `title: ''` when no talk is live; `status` = `waiting` \| `live` \| `ended`, same as the `talk` message) |
| POST | `/api/rooms/:room/demo/restart` | — (`TECH_KEY`) | `{talkId}`: restarts the seeded demo room's talk (only the `MOCK_ROOM` room) |
| PUT | `/api/votes` | `{room, talkId, type, clientId, on}` | `{count, ticketStatus}` |
| POST | `/api/questions` | `{room, talkId, text, clientId}` | `{qid, groupId}` |
| POST | `/api/feedback` | `{ticketId, clientId, better}` | `{better, stillBad}` |
| POST | `/api/tickets/:id/claim` · `/fixed` · `/dismiss` | `{by}` | `{status}` |
| GET | `/api/report/:talkId` | — | `{transcript[], signalsByMinute[], questions[]}` |
| GET | `/api/find?q=&from=&limit=` | — | `{sessions:[{id, title, start, location, why}], said:[{talkId, title, seq, text, ts}]}` |
| GET | `/api/find/next?clientId=&limit=` | — | `[{id, title, start, location, because}]` |
| GET / POST | `/api/config` | `{alertThreshold}` | `{alertThreshold, nudgeThreshold, publicBaseUrl}` (`publicBaseUrl` = `PUBLIC_BASE_URL`; the mic page builds the QR code from it) |
| POST | `/api/rooms/:room/slide-frame` | raw `image/jpeg`, `image/png` or `image/webp` (≤ 1.5 MB), `SPEAKER_KEY` | `{n, url}` (slide relay; server then sends `slide` with `total: 0`) |
| GET | `/slides/live/:bucket/:n-:token.jpg` | — (signed in to the slide's room, or `x-pulse-key` / `?key=` SPEAKER_KEY or TECH_KEY) | the captured slide image (JPEG, PNG or WebP; `Content-Type` matches the image format; `Cache-Control: private, no-store`). `token` is 16 random hex per frame; a wrong or missing token is `404`; a phone not signed in to that room is `403` (with `SIGNIN=off` any phone may view). |
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
- A live talk ends by itself when no keyed `mic` socket has been in the room and no caption has arrived for `AUTO_END_MIN` minutes (default 10, `0` = never): a presenter who walked off doesn't leave it live for the next speaker. A caption with an unknown `talkId` (the server restarted mid-talk) re-creates that talk from the caption's `title`/`speaker`.
- `POST /api/questions`: one question per phone every 20 s (`429 {error:'too_fast'}`), keyed on `clientId` and the visitor cookie. `ticket_status` reaches phones only when a ticket's status changes. `GET /api/report/:talkId` fills `signalsByMinute` from memory when Elasticsearch is off.
- Going live again after a talk ended starts a **new** talk (Go live and the mic page resume only a talk whose `status` is `live`), so phones flip from Ended back to Live.
- Demo room: on start the server seeds room `MOCK_ROOM` (default `255`, `off` disables) with a live talk, a transcript that keeps growing, a fake mic level, 3 questions and a "can't see" ticket. It is `simulated: true` in `/api/rooms`. Its captions are never written to Elasticsearch; its seeded votes and questions go through the public routes, so they are indexed like any other (anonymous) vote or question.
- Room switches: `POST /api/rooms/:room/settings` `{captions, listen, slides, capacity?}` (tech only; `capacity` = seats, for the room-fill bar). Server sends `room_settings` to every role in the room.
- Scans: `GET /r/:room` sets a server-issued cookie `pulse_v` = `<random id>.<HMAC>` (httpOnly, 1 day; the server only accepts ids it signed, secret `VISITOR_SECRET` or random per start) and counts each visitor once per room (`joined`). The phone never reports a count; a scan never creates a room. `here` = open attendee sockets. Default capacity `ROOM_CAPACITY` (120).

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
| `TECH_KEY` | `POST /api/talks/:talkId/end` (also `SPEAKER_KEY`) · `POST /api/rooms/:room/demo/restart` · `POST /api/tickets/:id/claim` · `/fixed` · `/dismiss` · `POST /api/config` · `POST /api/rooms/:room/settings` · `POST /api/questions/:qid/*` · `POST /api/rooms/:room/broadcast` · `POST /api/clients/:clientId/mute` · page `/tech` |
| `BOOTH_KEY` | page `/booth/:booth` · `POST /api/booths/:booth/requests/:id/done` · `GET /api/booths/:booth/report` · socket `role=booth`. Nothing else: the booth key gets `403` on every tech or speaker route (including the sign-in export). Unset = booth pages and routes locked. |
| `SPEAKER_KEY` | `POST /api/talks` · `POST /api/talks/:talkId/end` · `POST /api/rooms/:room/slide-frame` · pages `/mic/:room`, `/present/:room`, `/relay/:room` and `/go/:room` |
| none | `GET /api/rooms`, `PUT /api/votes`, `POST /api/questions`, `POST /api/feedback`, `GET /api/report/:talkId`, `GET /api/config`, transcript routes, `/healthz`, `/privacy`, `/api/privacy`, `/cards`, `/metrics`, pages `/r/:room`, `/t/:talkId`, `/room/:room`, `/org`, `/find` |

## WebSocket: `/ws?room=151&role=attendee|viewer|mic|present|tech|org[&clientId=]`

Attendee sockets also send `&clientId=<anonymous per-phone id>` (from `public/lib/store.js`). The server uses it to deliver `question_reply` to the asker and to attribute heard captions for booths and `/api/find/next`.

`viewer` (no key) is for transcript/report pages: it receives `caption`, `caption_interim` and `caption_backlog` like `attendee` but is not counted in `listeners`.

All messages are JSON with a `t` field. `role=mic` and `role=present` must also pass `&key=SPEAKER_KEY`; `role=tech` must pass `&key=TECH_KEY`; `role=booth` (booth staff screen) must pass `&key=BOOTH_KEY`. A key that is valid but for another route gets HTTP `403` (a missing or wrong key: `401`).

**Sender check:** the server relays `caption` and `caption_interim` only from a keyed `mic` socket, and `slide` only from a keyed `mic` or `present` socket. The same messages from any other role are dropped (not relayed, not stored).

| `t` | Direction | Fields | Who gets it |
| --- | --- | --- | --- |
| `caption` | mic → server → room | `talkId, seq, text, ts` | attendee, tech |
| `caption_interim` | mic → server → room | `text` | attendee |
| `caption_backlog` | server → (on join) | `lines[]` (last 50) | attendee, tech |
| `ticket` (snapshot) | server → (on join) | one `ticket` message per open / claimed / reopened ticket in the room, plus the current `question_groups` (tech only) | tech, org (`/org` has no key: its tickets carry no `claimedBy` / `fixedBy`, and it never gets `question_groups`) |
| `vote_count` | server → (at most every 300 ms per room+type) | `type, count, windowSec` | attendee |
| `ticket` | server → | `id, room, type, people, status, openedAt, reopenedAt, cause, steps[], claimedBy, fixedBy, fixedAt, better, stillBad` (`claimedBy`/`fixedBy` = the tech's "I'm" name from `{by}`; keyed console only, never indexed) | tech; org without `claimedBy`/`fixedBy` (`better`/`stillBad` updates and the 3-min "just fixed" snapshot: tech only) |
| `ticket_status` | server → | `ticketId, type, status` | attendee |
| `room_status` (every 2 s) | server → | `room, listeners, micDb, captionGapSec, openTickets` | tech, org, mic |
| `room_settings` | server → | `captions, listen, slides` | all |
| `question_groups` | server → | `groups[{groupId, qid, text, count, answered}]` (`qid` = first question in the group; tech actions use it). Current talk only, at most the 50 most recently active groups | tech |
| `question_update` | server → | `qid, pinned, hidden, answered` | tech |
| `question_reply` | server → | `qid, text` | the askers only |
| `broadcast` | server → | `text` | attendee |
| `feed` | server → | `kind, room, text, ts, refId` | tech |
| `slide` | present/mic → server → room (or server, after a relay upload) | `talkId, n, total, url, alt?` (`total: 0` = unknown, captured deck) | all (and new phones on join) |
| `talk` | server → (on join and on every change) | `talkId, title, speaker, status: 'waiting'\|'live'\|'ended', startedAt, endedAt?, reportUrl?, next?: {title, start}` | all (the attendee pill shows Live / Ended / Not started from this, not from the socket state) |
| `room_stats` | server → (on join and when it changes, checked every 2 s) | `room, joined, here, capacity, fill, signedIn` | all |
| `room_telemetry` | server → (every 2 s) | `room, talk, presenter, mic{state: live\|silent\|stopped, db}, captions{state: live\|silent\|stopped, gapSec, lines}, listen{state, listening}, slides{state: live\|none\|stopped, n, lastAt}, phones{here, joined, capacity, listening, reconnects5m}` | tech, org |
| `ping` / `pong` | both, every 20 s | — | all (`lib/socket.js` pings every 10 s and replaces a socket that has received nothing, not even a `pong`, for 25 s) |

Audio uses its own binary-only sockets:

- `/ws/audio-in?room=151&key=SPEAKER_KEY` — Int16 little-endian, mono, 16 kHz, 1,600 samples per frame (100 ms, 3,200 bytes).
- `/ws/audio-out?room=151[&key=TECH_KEY]` — the same frames out. Send-only: the server ignores anything a phone sends. A phone needs a sign-in (see Sign-in); the AV console's "Listen to podium" passes `key=TECH_KEY` instead.
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

- Device ids: the `clientId` field of `pulse-signals` and `pulse-questions` holds a salted hash per talk, and of `pulse-checkins` a salted hash per booth (`server/device-id.js`, secret `DEVICE_HASH_SECRET`, else `VISITOR_SECRET`, else random per start). Distinct counts within a talk or booth stay exact; the phone's own id is never written to Elasticsearch.
- Retention: documents in `pulse-signals`, `pulse-questions` and `pulse-checkins` are deleted once older than `RETENTION_DAYS` (default 30, `0` keeps them) by `_delete_by_query` on `ts` (`server/es-retention.js`: an hour after start, then every 6 h; `node scripts/es-setup.js --retention` runs it once). Serverless has no classic ILM for plain indices, so this is a job, not a policy.

## Sign-in (before joining)

`SIGNIN=on` (default) | `off`. While on, a phone signs in once before it gets the room:

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| GET | `/r/:room` | — | the sign-in form (`public/join.html`) until this phone's `pulse_v` cookie has signed in, then the audience page. `Cache-Control: no-store`. |
| POST | `/api/signin` | `{room, first, last, company, email}` | `{ok}` · `400 {error:'invalid', fields:{first?, last?, company?, email?}}` · `400 no_visitor` (no cookie: open the room link first) · `429` (10 tries / min per phone, 120 / min per network address: the socket peer, or the proxy-set `cf-connecting-ip` / last `x-forwarded-for` entry only when the peer is a local proxy) · `503 full` only when all 50,000 sign-ins were active in the last 30 min (otherwise the longest-idle one is dropped) |
| GET | `/api/rooms/:room/signins` (`TECH_KEY`) | — | `{room, count, enabled}`; `?format=csv` → `first_name, last_name, company_or_occupation, email, signed_in_at, source` (`source: demo` for the demo room's fictional crowd) |

- Server checks: every field required, trimmed, control characters removed; names ≤ 60, company ≤ 100, email ≤ 254 and a basic `name@domain.tld` check. The phone never says it signed in: the server looks up its own record for the `pulse_v` cookie (httpOnly, 24 h).
- Gated while signed out: the attendee WebSocket (closed with `4403`; `lib/socket.js` reports `signin` and `r.js` goes to `/r/:room`), `/ws/audio-out` (`4403`), `PUT /api/votes`, `POST /api/questions`, `POST /api/feedback` (`403 {error:'signin_required'}`). `viewer` sockets (transcript pages) are not gated.
- Sign-ins are kept in memory only: never in Elasticsearch, logs, OpenTelemetry, URLs or any attendee page, never linked to `clientId`. `room_stats.signedIn` is a count only (`null` when `SIGNIN=off`).

## Privacy

Public page `/privacy` (`public/privacy.html`, no key) and `GET /api/privacy`. The page states: Elasticsearch, logs, dashboards and sponsor reports hold no names, email addresses, phone numbers, IP addresses or accounts; with sign-in on, a phone gives name, company or occupation and email once, kept in server memory only and exportable only with `TECH_KEY`; the sign-in rate limiter keeps recent network addresses in memory; `clientId` is a random id generated on the phone; booth reports hide any group under 3 devices; browser monitoring (if on) and Chrome's speech recognition are disclosed; the keys are never logged or traced.

`GET /api/privacy` returns:

```json
{
  "source": "elasticsearch | mixed | static",
  "elasticsearch": true,
  "indices": [{ "index": "pulse-captions", "fields": [{ "field": "talkId", "type": "keyword" }] }],
  "privacy": {
    "personalData": true,
    "signIn": { "enabled": true, "collects": ["first name", "last name", "company or occupation", "email address"], "storage": "server memory only, cleared on restart", "inElasticsearch": false, "linkedToClientId": false, "export": "event team, staff key" },
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
- Browser monitoring (`public/rum.js`, only when `DASH0_RUM_TOKEN` is set): on the phone, before export, every URL is reduced to scheme + host + a path template (ids become `:id`; no query string, fragment or `?key=`), the SDK sees a coarse browser name instead of the user agent, and no headers are captured. `scripts/rum-check.js` asserts this in a real browser.
- `personalData` is `true` while `SIGNIN` is on (the default) and `false` with `SIGNIN=off`.
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

`PORT` · `BOOTH_KEY` · `RETENTION_DAYS=30` · `DEVICE_HASH_SECRET` · `MOCK_ROOM=255` · `ROOM_CAPACITY=120` · `SIGNIN=on` · `AUTO_END_MIN=10` · `VISITOR_SECRET` · `PUBLIC_BASE_URL` · `SPEAKER_KEY` · `TECH_KEY` · `ALERT_THRESHOLD=3` · `ALERT_WINDOW_SEC=60` · `CAPTIONS_DEFAULT=on` · `ELASTIC_URL` · `ELASTIC_API_KEY` · `ES_INFERENCE_ID` · `OTEL_SERVICE_NAME=pulse` · `OTEL_EXPORTER_OTLP_ENDPOINT` · `OTEL_EXPORTER_OTLP_HEADERS` · `DASH0_RUM_TOKEN` (public, ingest-only) · `DASH0_RUM_ENDPOINT=https://ingress.us-west-2.aws.dash0.com`

## Booths (expo floor)

A booth is a place like a room, keyed by a short id (`gitar`, `dash0`, …). Booth demos are just talks in a room whose id is the booth id, so captions, questions and reports work unchanged. Booth config lives in `server/booths.json`: `[{id, sponsor, table, pitch, about, resourcesUrl}]` (`about` is 2–4 sentences used for matching).

### Pages
| Page | Key | What |
| --- | --- | --- |
| `/b/:booth` | none | Attendee booth page (QR on the table): sponsor, pitch, passport progress, next-booth card, "Talk to an engineer" / "Send me resources" |
| `/booth/:booth?key=BOOTH_KEY` | `BOOTH_KEY` | Booth staff screen: live request queue, visits, "talks that sent people here" |

### HTTP
| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| GET | `/api/booths` | — | `[{id, sponsor, table, pitch, resourcesUrl}]` |
| POST | `/api/booths/:booth/checkin` | `{clientId}` | `{booth, stamps, total, suspect, next: {id, sponsor, table, because} \| null}` |
| POST | `/api/booths/:booth/requests` | `{clientId, kind}` (`talk_to_engineer` \| `send_resources`) | `{requestId, position}` |
| POST | `/api/booths/:booth/requests/:id/done` (BOOTH_KEY) | `{by}` | `{status}` |
| GET | `/api/booths/:booth/report` (BOOTH_KEY) | — | `{visits, uniqueDevices, dwell: {medianMin, p90Min, n} \| null, open: [requests], fromTalks: [{talkId, title, devices}], topics: [{text, devices}]}` |

- **Passport:** one stamp per `clientId` per booth. `suspect: true` if the same device stamped another booth less than 30 s earlier (not counted toward `stamps`).
- **Next booth:** from the captions this device actually received in rooms it joined as `attendee` (last 20 lines across rooms). Elastic semantic search of those lines against booth `about` (`pulse-booths.about_sem`, RRF with a match query); fallback is word overlap in memory. Never suggest a booth already stamped. `because` is the caption line (≤ 120 chars) that matched best.
- **Privacy:** the report never names a device. Any `fromTalks`, `topics` or dwell group with fewer than 3 devices is dropped or null (k ≥ 3). Booths never receive sign-in details.
- **Dwell:** for each device's consecutive stamps (booth A at t1, next booth at t2), `dwell_upper(A) = min(t2 - t1, 15 min)`. The report field `dwell` is `{medianMin, p90Min, n}` computed from those upper bounds, only when n ≥ 3, else `null`: time to next stop, an upper bound; shown as a range with n. Consecutive stamps include rejected (suspect) stamps — they still mark a stop — and a device's last stop has no next stamp, so it contributes no sample.
- WebSocket: booth staff connect `/ws?room=<booth>&role=booth&key=BOOTH_KEY` (the `booth` role gets booth requests, never room or AV data) and get `{t:'booth_request', requestId, kind, position, ts}` and `{t:'booth_request_done', requestId}`.
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
