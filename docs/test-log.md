# Pulse test log

What has been tested, how, what broke and what is still open. Newest first. Add to it when you test something.

## 2026-11-09: venue-local schedule times and past-event find check, automated (Gitar)

**Setup:** `mise x node@22.23.4 -- npm ci`, then `mise x node@22.23.4 -- npm run check`.

| Check | Result |
| --- | --- |
| Offset-less Salt Lake schedule time parses as venue wall-clock time; explicit offsets are preserved | passed |
| `find-check`: searches all schedule entries and accepts no upcoming suggestions when the schedule is past | passed |
| Repository syntax checks and `booths-check`, `find-check`, `relay-check`, `tickets-check` | passed |

Elasticsearch schedule indexing was not integration-tested.

## 2026-11-09: attendee relay restoration and image-format contract, automated (Gitar)

**Setup:** `mise x node@20 -- npm ci`, then `mise x node@20 -- npm run check`.

| Check | Result |
| --- | --- |
| JavaScript syntax checks and `booths-check`, `relay-check`, `tickets-check` | ✅ |
| Existing relay check: authenticated JPEG upload, retrieval/cache headers and upload throttle | ✅ |

Builds tested: `poc/one-room` @ `4593204` = `ty/backend` @ `19c5573` (#7) + `ui/tech-console` (#8). Not tested yet: Ty's later backend commits (`4af33f5` demo simulator, `b5910df` question grouping), and the B&W redesign (#10) on real phones (headless checks are below).

## 2026-11-09: `/find` + schedule search, automated (`scripts/find-check.js`)

**Setup:** `node scripts/find-check.js` starts `server/index.js` as a child on a free port with `SPEAKER_KEY=sk TECH_KEY=tk` and every `ELASTIC_*` / `OTEL_EXPORTER_OTLP_*` variable deleted, so only the in-memory fallback runs.

All passed:
- `GET /find` → 200, rendered search box.
- `POST /api/talks` (`room 1`) then three `caption` messages from a keyed mic socket → attendee received them.
- `GET /api/find?q=kubernetes` → 200, `sessions[]` non-empty with `id`, `title`, `start`, `location`; `said[]` contains the relaying talk's "Kubernetes agents" line.
- `GET /api/find/next?clientId=c1` → 200, non-empty, every row has a `because` line ≤ 120 chars.
- Not covered: the Elasticsearch path (RRF over `pulse-schedule` / `pulse-captions`, schedule indexing on start). Needs a run against the Radar cluster.

## 2026-11-09: Agent0 fixes — child spans, 401 page, favicon, one Node version

**Setup:** `node --check` on the changed server files, `node scripts/smoke.js`, `node scripts/tickets-check.js`, then `PORT=18099 node server/index.js` with no Elasticsearch and no Dash0 exporter.

- `/tech` without a key → 401 `text/html; charset=utf-8`, title "Key needed", no key echoed.
- `/favicon.ico` → 301 with `Location: /favicon.svg`; `/favicon.svg` → 200 `image/svg+xml`.
- Smoke and tickets-check passed. With Elasticsearch disabled the memory paths still answer; with telemetry disabled the new spans are a no-op.
- Node pinned to 22.23.4: Docker base `node:22.23.4-alpine`, `engines.node` `>=22.23 <23`, `.nvmrc` `22.23.4`.

## 2026-11-09 12:10–12:40: design pass across screen sizes, fake data (Claude)

**Setup:** branch `ui/bw-design-preview` (#10) merged with `main` @ `6635fa0`, `python3 -m http.server` in `public/`, headless Chrome (Playwright), `?mock=1` on every page.

| Check | Result |
| --- | --- |
| Attendee page at 320×568, 393×852, 852×393 (phone sideways) | ✅ no overlap; blocks stack; page scrolls |
| Attendee "Both" mode at 393×852 | ✅ slide + about 4 caption lines (was a sliver before this fix) |
| Attendee computer view at 820×1180, 1366×768, 1920×1080 | ✅ WATCH left, controls right at 900 px+; iPad portrait stays one column |
| `/tech` at 1366×768, 820×1180, 393×852 with rooms 151 + 255 | ✅ red open block, yellow claimed block, drawer, questions |
| Loop across frames: phone Speak up → tech block 3 → 4 votes → Claim → Mark fixed → phone "Better now?" | ✅ |
| Phone question → tech Questions list → tech Reply → phone shows the reply | ✅ |
| `/mic.html` with the new palette | ✅ no undefined CSS variables, no page errors |
| Page errors / 4xx responses on all of the above | ✅ none |
| Real phones on the new design | not checked yet |

## 2026-11-09: slide relay + talk lifecycle, automated (`scripts/relay-check.js`)

**Setup:** `node scripts/relay-check.js` starts `server/index.js` as a child on a free port with `SPEAKER_KEY=sk TECH_KEY=tk`, no Elasticsearch. `node scripts/tickets-check.js` re-run with the live-talk fixture.

All passed:
- `POST /api/rooms/1/slide-frame`: 401 without the key, 200 `{n: 1, url}` with a JPEG body, 429 for a second upload within 1 s.
- `GET /slides/live/:talkId/:n.jpg` returns the uploaded bytes with `Cache-Control: public, max-age=31536000, immutable`; an unknown frame is 404.
- An attendee socket gets `talk {status: 'waiting'}` on join and the stored `slide {total: 0}`; after `POST /api/talks` the same socket gets `talk {status: 'live'}`, and after `/end`, `talk {status: 'ended', reportUrl}`.
- `PUT /api/votes` before any talk returns `409 {error: 'no_live_talk'}`.
- `/relay/1` without the key is 401; `/relay.html` is 404.

## 2026-11-09 11:45–11:56: real devices, one room (Owen)

**Setup:** Owen's Windows PC runs the server (`tools/start-pulse.bat`) behind a Cloudflare quick tunnel (`https://<random>.trycloudflare.com`). Podium mic page in Chrome on the same PC (real mic, real Chrome speech recognition). Owen's phone scanned the QR code from the mic page.

| Check | Result |
| --- | --- |
| QR code on `/mic/151` → phone opens `/r/151` over the public https URL | ✅ |
| Chrome speech recognition on the mic page (real speech) | ✅ lines and word count kept increasing while Owen talked |
| Captions on the phone | ✅ after a short gap: the first lines didn't show on the phone, then they arrived. At that moment the server reported only 1 attendee socket. Likely the phone's socket dropped (screen lock or Safari in the background) and reconnected. See "Open" below. |
| Listen with earbuds on the phone (laptop mic → phone) | ✅ Owen could hear the speaker |
| A second viewer (Claude desktop app's browser) on `/r/151` | ✅ Live, all 6 caption lines, talk title shown |
| Speak up from the real phone → `/tech` goes red | not checked yet |
| iPhone with the ringer switch off, delay measurement | not checked yet |

## 2026-11-09 11:20–11:40: Ty's real backend + all UI pages, headless (Claude)

**Setup:** `ty/backend` merged locally with the UI branches, `node server/index.js` with `SPEAKER_KEY` / `TECH_KEY`, no Elasticsearch or Dash0. Headless Chromium with a fake mic (`--use-fake-device-for-media-stream`) and a stubbed `SpeechRecognition` that emits interim + final results. Three phone-sized pages, one mic page, one `/tech` page.

All passed:
- Mic page starts a talk (`POST /api/talks`) and captions reach 3 phones and a late joiner (`caption_backlog`); the phones show the talk title.
- About 10 audio frames per second reach `/ws/audio-in`; a phone's Listen plays them; `/tech` "Listen to podium" plays them.
- 3 distinct phones tap Speak up → one ticket (`people: 3`, cause "Mic is silent or muted") → red block and chime on `/tech`.
- Claim → Mark fixed (`TECH_KEY` required; without it 401) → all 3 phones show "Better now?" → "Still bad" + 2 votes → ticket comes back as REOPENED → Not AV clears it.
- Broadcast banner, captions on/off switch, alert limit (`/api/config` → 1), question grouping on the tech page.
- Mic page resumed on a second browser continues captions without phones dropping them (server's last `seq` is used).
- `/mic` and `/tech` without the key → 401; `/mic.html` as a static file → 404; attendee pages carry `Permissions-Policy: microphone=()`.
- QR images decoded with OpenCV contain exactly the URL shown under the code.
- Attendee page at 320×568 and 390×844: no horizontal scroll, buttons reachable, "Both" mode keeps captions visible.

## Bugs found and fixed (UI)

| Found by | Bug | Fixed in |
| --- | --- | --- |
| Gitar #2 | Admin routes had no defined key mechanism; any phone could dismiss tickets or push captions | `CONTRACT.md` Auth table, `x-pulse-key`, sender check |
| Gitar #4 | Captions silently dropped when a second talk starts in the same room (`seq` dedup not reset) | `r.js` `resetForNewTalk` |
| Gitar #4 | Saved votes never expired; a quick Listen off/on could open two audio sockets | `r.js`, `player.js`, `socket.js` |
| Gitar #6 | Resuming a talk on another laptop restarted `seq` at 1, so phones dropped new lines | `mic.js` reads the server's last `seq` |
| Gitar #6 | A failed `/end` still said "Transcript saved" | `mic.js` |
| Testing | QR code pointed at `localhost` when the mic page was opened locally | `mic.js` uses `?base=`, then `publicBaseUrl`, then the page origin, and warns on localhost |
| Testing | Layout overlap at 320×568 in "Both" mode | `styles.css` |
| Gitar #8 | Tickets closed during a disconnect stayed red; question actions reset other flags; Listen to podium kept the old room | `tech.js` |

## Open: backend (asked on #7)

1. **Snapshot on join for `tech` / `org`:** send each open, claimed or reopened ticket as a `ticket` message, plus `question_groups`. Without it, a tech page opened mid-talk shows "All rooms OK". `tech.js` now clears a room's tickets on reconnect and relies on this snapshot.
2. **`qid` in each `question_groups` entry:** the tech page's Reply, Queue, Answered and Hide buttons stay disabled until it's there.
3. **`room_status` to the `mic` role:** the mic page's "Phones connected" stays blank without it.
4. **`publicBaseUrl` in `GET /api/config`** (from `PUBLIC_BASE_URL`): the mic page builds the QR code from it.

## Open: to test next

- Speak up from a real phone → `/tech` red → Claim / Fixed → "Better now?" on the phone.
- Phone socket drop: lock the phone for 30 s, unlock, and check that the dot goes Reconnecting → Live and the missed captions appear.
- iPhone with the ringer switch off: Listen must still play (`navigator.audioSession.type = 'playback'`).
- Measure the listen-in delay (needed for the demo script).
- The same flow on the Radar team cluster (`https://pulse.cnh.radarhq.io`) once #3, #5, #7 and #8 are merged.

## Gotchas found while testing

- **A server left over from an earlier run holds port 8080.** The tunnel then reaches the old server, which rejects the new keys ("unauthorized"). `tools/start-pulse.ps1` now picks the next free port and says which process holds 8080.
- **Windows PowerShell 5.1 treats a native command's stderr as an error** when `$ErrorActionPreference = 'Stop'` (`git pull` progress killed the first run). The script uses `Continue`, a `trap`, and a transcript in `start-pulse.log` (git-ignored by `*.log`).
- **A new trycloudflare hostname can take 30 s or more to resolve.** The script waits for cloudflared's "Registered tunnel connection" line instead of polling DNS.
- **The mic only works over https or localhost**, so open the mic page through the tunnel URL, not `http://<LAN IP>`.
- **The Claude cloud workspace can't host a tunnel** (its network blocks Cloudflare's tunnel endpoints), so real-phone tests run on a laptop.
- **Chrome speech recognition needs the network** unless the on-device English pack is installed (`SpeechRecognition.install({langs:['en-US'], processLocally:true})`).

## How to run the real-device test (Windows)

1. Check out the branch to test, then `npm ci`.
2. Double-click `tools\start-pulse.bat`. It asks before installing `cloudflared`, starts the tunnel and the server with fresh keys, and opens the mic page and `/tech` in Chrome. It also prints the links and keys and saves them to `%TEMP%\pulse-test-urls.txt`; the transcript in `start-pulse.log` contains the keys too. The alert limit is 1 vote for testing.
3. On the mic page press **Start captions**, then scan the QR code with a phone on mobile data.
4. Press Enter in the script window to stop the server and the tunnel. Anyone with the link can reach the server until you do.

## 2026-11-09 12:30–12:40 PM: load test + right-sizing (Ty)

**Setup:** app pod on our kind cluster (image from `main`), `scripts/simulate.js --no-scenario` streaming captions at 2 lines/s into room 151, `scripts/loadtest.js` opening N attendee sockets for 30 s.

- **Direct to the pod** (kubectl port-forward, no Cloudflare): **500 / 500 sockets connected**, about **51 captions per socket** in 30 s. `kubectl top` during the run: **~52m CPU / 41 MiB** at peak (30m / 41 MiB mid-run).
- **Through the Cloudflare quick tunnel:** about **230 sockets** connected before Cloudflare answered **429** for further new WebSockets from the same client IP. That is the tunnel's per-client limit, not the pod; a real ingress or named tunnel removes it.
- **Idle, per Radar (after installing metrics-server):** ~11m CPU / 35 MiB against 100m / 128 MiB requested.
- **Decision (#24):** requests 50m CPU / 192Mi memory (the memory request covers the 128 MB slide-frame cache from #23), limits 500m / 256Mi.
