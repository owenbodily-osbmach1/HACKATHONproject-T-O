# Pulse test log

What has been tested, how, what broke and what is still open. Newest first. Add to it when you test something.

## 2026-11-09 15:30: AV listen-in and the unkeyed /org page (Claude)

Two bugs found by the data-flow review of the staff pages, both confirmed against the server and fixed on `ui/video-scenes`:

| Check | Result |
| --- | --- |
| `/ws/audio-out` with `key=TECH_KEY`: opens and receives the podium frames (5/5) | ✅ |
| `/ws/audio-out` with a wrong key, or with no key and no sign-in | ✅ still closed `4403` |
| AV console "Listen to podium" in headless Chrome | ✅ "Listening · stop" |
| Unkeyed `/org` socket after a question and a claim by "Sam": tickets yes; question text, tech name, sign-in name no | ✅ (the keyed console still gets all of it) |
| `/org` page without a key shows Room 151 and its ticket, no question text or names | ✅ |
| `npm run smoke` and every `scripts/*-check.js` (`tickets-check` now asserts the `/org` copy has no `claimedBy` / `fixedBy`) | ✅ |

## 2026-11-09 14:20–14:45: agent group test, then fixes + sign-in on `ui/live-state-rooms` (Claude)

**Agent group test** (`poc/one-room` build, shared server, 14:19–14:33): a presenter agent (headless Go live with fake mic, screen share and speech), an audience agent (6 headless phones + 40–51 socket phones, offline / locked-screen / blocked-WebSocket phones), an AV agent (3 consoles, real clicks and keys), and a chaos agent on its own servers. Fixed on this branch from their findings:

| Finding | Fix |
| --- | --- |
| Laptop swap / second Go live tab: overlapping `seq`, phones silently dropped new lines; duplicate lines in the transcript | The server owns `seq` per talk (`hub.js`): keeps the mic's number only while it moves forward, drops an exact repeat of the last line |
| Captions accepted for an ended talk; a stale tab's old `talkId` could flip phones between talks | Captions go to the room's live talk only; none when no talk is live |
| AV: End armed in one room ended another room with one tap | Armed per room + talk, disarmed on room switch, a double-click isn't two taps |
| AV: Reply box wiped every 5 s; clicks lost / landing on another ticket while blocks rebuilt and re-sorted | No question rebuild under an open reply; blocks in stable order, no rebuild while the mouse is down, the 5 s poll only updates tabs + drawer |
| Go live: a second click during start-up ended the talk; a denied mic still started a talk; pill said LIVE after End | End ignored for 5 s after going live; mic opens before the talk; pill shows the talk state + "Phones show: …" line |
| Replies never reached real phones (no `clientId` on the socket) | `r.js` passes `clientId` |
| Phones kept LIVE for ~65 s after losing signal | ping every 10 s, dead after 25 s of silence |
| Vote after the end said "check your connection"; question after the end filed under the ended talk; "Better now?" stayed up | 409 → "votes are closed"; question parked for the next talk; card hidden on end |
| AV: old talk's captions under the new title; tabs numbered differently per console; typo'd `/r/152` added a tab; reminder chime for ended talks; silent rooms invisible | captions filtered by talk; tabs sorted by room id; only rooms with a talk (or the demo room) are added; chime only for live talks; ⚠ "silent N min" / "mic quiet" / "CC off" on the tab |
| `/mic` page kept captioning after the AV ended the talk; half-said line stayed on phones after the mic page closed | `/mic` stops like Go live; interim cleared when the last mic socket leaves |

Follow-ups, fixed in a third commit (15:00–15:10), each checked against a running server:

| Follow-up | Fix | Check |
| --- | --- | --- |
| Who claimed / fixed, "Better now?" answers invisible to the AV | `claimedBy`, `fixedBy`, `better`, `stillBad` on `ticket` (console only, not in Elasticsearch); "CLAIMED BY …" on the block; "Just fixed" list for 3 min, also for a console opened after the fix | ✅ "fixed by Sam · Better 2 · Still bad 1" |
| Reopened ticket showed its original age | age counts from `reopenedAt` | code |
| Report "0 signals" without Elasticsearch | signals kept in memory too (same anonymous rows) | ✅ `signalsByMinute` filled; questions carry no `clientId` (already on main) |
| Presenter walked off: talk live forever, next speaker inherits it | auto-end after `AUTO_END_MIN` (10) with no mic socket and no captions; Go live offers "End that talk and start a new one" | ✅ phone flipped to Ended (test with 3 s) |
| Burst of votes at 300 phones | `vote_count` coalesced per room+type (300 ms); `ticket_status` only on status change | ✅ 20 votes → 1 `vote_count`, 1 `ticket_status` per phone |
| No question rate limit on the server | 1 per 20 s per `clientId` and visitor cookie | ✅ second question `429` |
| `/go` on a phone: one word per line, raw `getDisplayMedia` error | narrow layout fixed; clear "can't share slides from this device" | ✅ screenshot at 390 px |
| Bare 401 page | styled, says to use the links start-pulse prints | ✅ |
| Dash0 had no headcounts | gauges `pulse.room.scanned`, `pulse.room.here`, `pulse.room.fill`, `pulse.room.signed_in` (counts only, `pulse.simulated` marks the demo room) | not checked against Dash0 (no `OTEL_*` on this laptop) |

**Sign-in, scan counts, telemetry** (PR folder, `node server/index.js` on 8099, desktop app browser at 375×812 and headless Chrome at 390 / 320 / 1440):

| Check | Result |
| --- | --- |
| `/r/151` on a new phone → form; submit with a missing name, missing company and `not-an-email` → an error under each field | ✅ |
| Bad data sent straight to `POST /api/signin` (blank, 70-char name, `a@b`) → `400` with per-field errors; no cookie → `400 no_visitor` | ✅ |
| Without signing in: attendee socket closed `4403`, `PUT /api/votes` → `403` | ✅ |
| Valid submit → live room at once (Live, 4 captions, "1 here now · 1 scanned in · 1% full"); reload → room again, no form, counts unchanged; `/r/255` → no form | ✅ |
| CSV export: `401` without the tech key; with it, the real row plus 143 `demo` rows for room 255; a `=HYPERLINK(...)` name is written as text | ✅ |
| Names / emails in the server log | ✅ none |
| AV console: Live status rows (Server, Microphone, Captions, Listen-in, Slides, Phones), room fill, Signed in + Export CSV, ⚠ "silent 1 min" on a quiet room's tab | ✅ |
| `npm run smoke` and every `scripts/*-check.js` (run with `SIGNIN=off`) | ✅ |
| Real phones | not checked |

## 2026-11-09 14:00–14:20: talk stopped/live on phones, reconnect, rooms + demo room (Claude)

**Bug (Owen's run):** ending the talk on Go live left phones saying **Live**. Two causes: the attendee page never handled the server's `talk` message (its red "Live" pill only meant "socket connected"), and Go live / the mic page resumed the room's talk even after it had ended, so going live again never flipped back.

**Setup:** tested on `poc/one-room`, then replayed onto `main` for the PR; `node server/index.js` on port 8091 with test keys, no Elasticsearch. A script playing Go live's role (start or resume a live talk, captions over a `role=mic` socket, `/end`). Desktop app browser pane: `/r/151` and `/r/255` at 375×812, `/tech` at 1440×900.

| Check | Result |
| --- | --- |
| Phone open, talk live → captions, pill **Live** | ✅ |
| End talk → same open phone: pill **Ended**, "This talk has ended" card with Read the transcript / Download .txt, "Captions stopped at …" line, vote buttons disabled ("Talk ended"), header "Ended: <title>" | ✅ within a second, no reload |
| Go live again → new talk, phone back to **Live**, "The talk is live again" hint, captions reset | ✅ |
| Server restart with the phone open → **Reconnecting…**, then back on its own with the new state | ✅ |
| Phone socket made silently dead (messages swallowed, no close), 60 lines sent meanwhile | ✅ heartbeat replaced the socket after ~45–65 s; all 63 lines present and in order (13 more than the 50-line backlog, filled from `/api/talks/:id/transcript?from=`) |
| `/tech?rooms=151` finds room 255 (demo) by itself; tabs show Live/Ended, phones, "to fix"; keys 1/2 switch; `#room=255` reopens on that room | ✅ |
| AV **End talk** (two taps) on 151 and on 255 → that room's phones show Ended; drawer shows Ended and "Stopped (talk ended)" | ✅ |
| AV **Restart demo talk** → `/r/255` back to Live with the seeded transcript; the open ticket isn't doubled | ✅ |
| `/t/<demo talk>` transcript page, `/go/151` page load | ✅ no page errors |
| `npm run check` scripts (syntax, booths, relay, tickets) | ✅ |
| Real **Go live** button (screen share + real mic) and real phones | not checked: the logic it runs (resume only a `live` talk) was exercised by the script |

## 2026-11-09: Elasticsearch search network-failure fallback, automated (Gitar)

**Setup:** `mise x node@22.23.4 -- npm ci`, `mise x node@22.23.4 -- npm run check`, `mise x node@22.23.4 -- npm run smoke`, and a focused mocked-Elasticsearch search handler check.

| Check | Result |
| --- | --- |
| Repository syntax checks, `booths-check`, `extras-check`, `find-check`, `relay-check`, `tickets-check`, and smoke checks | passed |
| Network failure skips the plain-text Elasticsearch retry and returns matching room-buffer rows; HTTP errors retain the plain-text retry before memory fallback | passed |

## 2026-11-09: question-group lifecycle, automated live smoke (Gitar)

**Setup:** `mise x node@22.23.4 -- npm ci`, then `mise x node@22.23.4 -- npm run check` and `mise x node@22.23.4 -- npm run smoke`.

| Check | Result |
| --- | --- |
| Repository JavaScript syntax checks and `booths-check`, `extras-check`, `find-check`, `relay-check`, `tickets-check` | passed |
| Local live-server smoke: the open tech socket sees the old talk's group, receives an empty group list after the next talk starts, and a late-joining tech socket gets an empty snapshot | passed |

This was automated local-server QA; browser and real-device QA were not rerun.
## 2026-11-09: tracked dependency symlink cleanup, automated (Gitar)

**Setup:** Removed the committed `node_modules` symlink to a sibling checkout, changed the ignore pattern to cover both directories and symlinks, then ran `mise x node@22.23.4 -- npm ci` and `mise x node@22.23.4 -- npm run check`.

| Check | Result |
| --- | --- |
| Repository syntax and focused checks | passed |
| `node_modules` is ignored and the sibling-checkout symlink is no longer tracked | passed |
## 2026-11-09: search dedupe, memory fallback and cold-model timeout, automated

- `/api/search` and `/api/find` now drop repeated captions by normalized text (case, whitespace, punctuation), keeping the highest-ranked copy; "because you heard" lines use the same deduped input.
- `/api/search` returns the in-memory transcript when Elasticsearch errors or times out instead of `[]`; all search `es.raw` calls use the 8000 ms search deadline.
- `npm run check` (including the new dedupe assert in `find-check`) and `node scripts/smoke.js` passed. A server run against an unreachable `ELASTIC_URL` returned unique memory rows from `/api/search`.

## 2026-11-09: answeredSeq persistence, automated (Gitar)

**Setup:** `mise x node@22.23.4 -- npm ci`, then `mise x node@22.23.4 -- npm run check` and `mise x node@22.23.4 -- npm run smoke`.

| Check | Result |
| --- | --- |
| Repository syntax checks and `booths-check`, `find-check`, `relay-check`, `tickets-check` | passed |
| Smoke checks | passed |
| Focused mock-Elasticsearch question-answer check: update persists `answeredSeq` alongside `hidden` and `answered` | passed |
## 2026-11-09: attendee focus and listen-in lifecycle fixes, automated (Gitar)

**Setup:** `mise x node@22.23.4 -- npm ci`, `mise x node@22.23.4 -- npm run check`, plus a mocked AudioContext check for a stale `onstatechange` callback after stop/restart.

| Check | Result |
| --- | --- |
| JavaScript syntax checks and `booths-check`, `find-check`, `relay-check`, `tickets-check` | passed |
| Player stale-context callback after stop/restart does not throw or resume the stale/current context | passed |

The attendee prompt's focus behavior was not exercised in a browser or on a real device.

## 2026-11-09: venue-local schedule times and past-event find check, automated (Gitar)

**Setup:** `mise x node@22.23.4 -- npm ci`, then `mise x node@22.23.4 -- npm run check`.

| Check | Result |
| --- | --- |
| Offset-less Salt Lake schedule time parses as venue wall-clock time; explicit offsets are preserved | passed |
| `find-check`: searches all schedule entries and accepts no upcoming suggestions when the schedule is past | passed |
| Repository syntax checks and `booths-check`, `find-check`, `relay-check`, `tickets-check` | passed |

Elasticsearch schedule indexing was not integration-tested.

## 2026-11-09: accessibility fixes, automated (headless Chromium)

**Setup:** `npm run check`; server on port 8180 (`PORT=8180 SPEAKER_KEY=sk TECH_KEY=tk node server/index.js`); managed headless Chromium at 320×800 plus `?mock=1` pages.

| Check | Result |
| --- | --- |
| `npm run check` and the three `*-check.js` scripts | ✅ |
| `/r/151`, `/tech?key=…`, `/mic/151?key=…`, `/present/151?key=…` | ✅ 200 |
| Document scroll width at 320 px on `/r`, `/tech`, `/mic` | ✅ 320 px |
| Tech ticket card: Enter selects the room; focus stays after Claim/Fixed | ✅ |
| "Better now?" prompt: polite live region, focus on Yes, focus returns to the vote button | ✅ |
| Listen-in after the audio socket closes + visibilitychange | ✅ context resumes, socket reopens |
| A−/A+ and tech controls | ✅ 44×44 px minimum |
| `prefers-reduced-motion: reduce` | ✅ transitions and smooth scroll disabled |

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

## 2026-11-09: contract and hidden-question persistence checks

- `npm run check`: passed (`booths-check`, `find-check`, `relay-check`, `tickets-check`, plus JavaScript syntax checks).
- `npm run smoke`: passed.
- Focused mock-Elasticsearch check: verified stable-id question indexing, `hidden` updates, and hidden-question exclusion from the report after re-registering the question routes to simulate a restart. No live Elasticsearch cluster was used.

## 2026-11-09 1:55 PM: Gitar fixes for relay, Go live and the phone (Owen + Claude, headless)

**Setup:** branch `ui/demo-ready` (main + #29, #31, #34, #35 + fixes), local server on :8098, Playwright Chromium with a fake mic, fake speech recognition and a canvas "screen" (screen 1920×1080).

- **Full-screen gate is now exact size:** a 1920×1080 frame is sent; a 1600×900 frame (same 16:9 shape, like a maximized window) is **not** sent: "Waiting for Slideshow". Before, the aspect-only check would have sent it.
- **Go live after End talk starts a new talk:** talk `9ce0f0af` ended, Go live again created `d3fd738a`. Phones show live again.
- **Caption crawl with a 30-word caption:** split into lines of up to 8 words. Newest line fully inside the box and on screen at 320×568, 360×640 and 390×844, at default, 28 px and 36 px text. The box is capped at 32vh.
- `npm run check`: all checks ok.
## 2026-11-09: demo fixes (UI)

- `public/lib/socket.js` now sends the attendee `clientId`. A `/tmp` `ws` client connected as `role=attendee&clientId=...` received `question_reply` after `POST /api/questions` + tech reply (`sent: 1`).
- `/r/wscheck` while waiting: both vote buttons `aria-disabled="true"` and sub-label "Voting opens when the talk starts". Live talk message enabled them and showed title/speaker. A rapid triple tap produced one `PUT /api/votes`. End showed "Talk ended · transcript saved" → `/t/373d9c39`.
- Injected 409s: `stale_talk` was retried once and the retry returned 200; `no_live_talk` showed the gate with no network request.
- `/present/wscheck` opened on `127.0.0.1`: warning visible and QR URL `http://127.0.0.1:8181/r/wscheck`; with `?base=https://pulse.example.test` the warning was hidden and the URL used the base.
- `/tech?key=tk` without `rooms`: discovered `demo2` and `wscheck`; `&rooms=151` stayed on 151 only. The drawer showed "Discovery talk · Grace" from the `talk` message.
- `npm run check` passes.

## 2:45 PM: listen-in relay latency (public URL)

100 frames of 3200 bytes (100 ms of 16 kHz PCM) sent on `/ws/audio-in` in room `lat1`, received on `/ws/audio-out` through the Cloudflare tunnel: 100/100 delivered, median 56 ms, p95 100 ms, max 338 ms. This is relay time only; add the 100 ms frame and the phone's playback buffer for mic-to-ear.
## 2026-11-09: submission audit fixes

- License: `LICENSE` is the standard Apache-2.0 text (copyright 2026 the Pulse team); `package.json` says `"license": "Apache-2.0"`.
- 320 px: headless Chrome (Playwright, system Chrome) at 320×640 measured `document.documentElement.scrollWidth` 320 for `/tech?key=tk` and `/mic/<room>?key=sk`, including a 32-character room id, unbroken title/speaker tokens and a long `base=` URL. `/mic` measured 606 before the CSS guard.
- Docs: README and `docs/DEMO.md` now say each ticket lifecycle step is its own span tagged with the ticket id, not one trace.
- `.env.example` now lists `DASH0_RUM_TOKEN` and `DASH0_RUM_ENDPOINT`.

## 3:25 PM: question snapshot cap and Dash0 telemetry fixes

`question_groups` holds at most the 50 most recently active groups (a new ask moves its group to the newest end). `pulse.ticket.time_to_ack` and `time_to_fix` use seconds buckets [5, 15, 30, 45, 60, 120, 300, 600]; spans from `otel.span()` set ERROR status when the work throws or rejects. Question rate limiting is the 20 s per phone limit from #43. `npm run check` and `node scripts/smoke.js` pass (smoke asserts the 50-group cap).
