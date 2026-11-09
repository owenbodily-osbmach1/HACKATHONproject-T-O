# Pulse: submission draft

Paste-ready answers for the WeMakeDevs Cloud Native Hackathon form. Items marked **[CHECK]** need a fact confirmed or filled in before submitting. Numbers come from the README and the PR history; update them if they changed.

---

## Part 1: Project details

### Project title
Pulse: every conference room, run like a production service

(Short form if the field is tight: **Pulse**)

### Repository
https://github.com/owenbodily-osbmach1/HACKATHONproject-T-O

**[CHECK]** The repo must be public. Make sure [#43](https://github.com/owenbodily-osbmach1/HACKATHONproject-T-O/pull/43) is merged so judges see the rooms, telemetry and sign-in work.

### Demo video
**[CHECK]** A YouTube link set to Unlisted, **under 3:00** (the form's limit, not 3-4 minutes).

### Live demo or deployment
Leave this blank unless a stable URL will stay up through judging. The `trycloudflare.com` quick-tunnel URL changes on every restart, so judges would get a dead link. A dead link hurts more than an empty field.

### Tracks
Gitar, Dash0, Radar, Elasticsearch (and Merge Forward, which every project is entered in).

### What conference problem are you patching?
In every conference room, the AV crew finds out about problems last. When the mic dies, the speaker is too quiet or the slides wash out, people in the back don't report it, because there's no one to tell and no way to tell them. They tune out or leave. Attendees who are deaf or hard of hearing, or who aren't native English speakers, have it worst: if they can't hear the room, they lose the talk. Meanwhile the AV crew covers a dozen rooms at once and can't see any of them. They hear about a broken mic from an angry speaker after the session ends.

Pulse gives every room one QR code. Attendees get live captions and the podium audio in their own earbuds. When something breaks, they can say so with one tap. The AV crew gets a single ticket with the likely cause while the talk is still running.

### What did you build and how does it work?
Pulse treats each room like a service, with health signals, an on-call crew, a quorum alert, an incident and a postmortem.

- **Attendee phone (`/r/:room`):** scanning the room QR opens a web page; there's no app to install. It shows live captions from the podium mic, listen-in audio (the podium sound relayed in 100 ms frames to the phone's earbuds), the slides as the speaker advances them, and "Can't hear" / "Can't see" buttons. Attendees can also ask questions, and similar ones are grouped.
- **Podium (`/mic/:room`):** the speaker's laptop runs speech recognition and sends captions and 16 kHz audio over WebSockets. The server measures the mic level (dBFS) as the audio passes through.
- **Quorum alerting:** one tap is noise. Three different phones in 60 seconds open one ticket. The ticket comes with a likely cause from live data, such as "Mic is silent or muted" when the podium level drops below -50 dBFS, plus the steps to fix it.
- **AV console (`/tech`):** shows every room as a tab with how full it is, scan counts and a ⚠ on quiet rooms. A live status panel per room covers Server, Microphone, Captions, Listen-in, Slides and Phones. The crew claims a ticket, fixes it and marks it fixed. The phones that complained are then asked "Better now?", and "Still bad" reopens the ticket.
- **Post-talk report (`/t/:talkId`):** the full transcript, a minute-by-minute timeline of complaints, grouped questions, and search over the transcript by meaning. This is how attendees get the talk afterwards.
- **Expo floor:** booth passports. The next booth to visit is chosen from what that phone actually heard in talks. Sponsor reports hide any group with fewer than 3 devices.

**Stack:** one Node 20 pod running Express and `ws`. Live state is in memory. Elasticsearch stores the history and powers search. OpenTelemetry sends data to Dash0. A GitHub Action builds a multi-arch image to GHCR, and Argo CD deploys it to a kind cluster connected to Radar. In a load test, one pod held 500 phones at about 52m CPU and 41 MiB. Four AI test agents then ran a full mock conference against it: a presenter, about 57 audience phones, 3 AV consoles, and a stress tester with 300 phones, server restarts and dropped signal. Every bug they found that would break the demo was fixed through a PR.

---

## Part 2: Track details

### How did you use Gitar?
Every change landed as a pull request that Gitar reviewed and that the *other* teammate merged. Nothing was merged in one batch at the end. **[CHECK: update the count]** The repo has 32 merged PRs, and Gitar left 53 inline findings by midday. Median time from opening a PR to merging it was 13 minutes.

The repository setup reflects how we actually work:
- `.gitar/review/pulse.md`: review instructions for our API contract (`CONTRACT.md`), the mic lock (only the podium page may use the microphone), vote correctness, reliability of the live path, secrets and accessibility.
- `.gitar/rules/no-pii.md`: no personal data in Elasticsearch, logs or telemetry.
- `.gitar/rules/contract-drift.md`: any change to a route, message or field must update `CONTRACT.md`.
- `.gitar/rules/live-path.md`: nothing may block captions, audio or votes. For example, Elasticsearch writes are never awaited.
- CI runs `npm run check` and `npm run smoke`, so Gitar can diagnose failing builds.

Real catches:
- A malformed WebSocket upgrade URL that crashed the single pod.
- Speaker and AV pages served without a key, through static files and through percent-encoded or `//` paths.
- A deploy change that would have deleted the hackathon HTTPRoute.

PRs: [#32 security hardening](https://github.com/owenbodily-osbmach1/HACKATHONproject-T-O/pull/32), [#37 demo-ready fixes](https://github.com/owenbodily-osbmach1/HACKATHONproject-T-O/pull/37), [#17 Elasticsearch timeout](https://github.com/owenbodily-osbmach1/HACKATHONproject-T-O/pull/17), [#16 Argo CD on our own cluster](https://github.com/owenbodily-osbmach1/HACKATHONproject-T-O/pull/16). [#43 audience view, rooms, telemetry and sign-in](https://github.com/owenbodily-osbmach1/HACKATHONproject-T-O/pull/43) (Gitar's first review found 3 issues, all fixed before merge: forged visitor cookies, rooms created by `/r/<anything>`, and the duplicate-line filter). **[CHECK]** Pick the 3-4 with the best Gitar comments.

**[CHECK]** Did we use auto-apply or CI failure diagnosis on a real failure? Judges ask about both. If yes, add one sentence with the PR link. If no, leave it out rather than claim it.

### How did you use Dash0?
OpenTelemetry instrumentation is part of how the product works, not an add-on. Pulse models each room as a service, so the AV crew's work is measured like on-call work.
- **Traces:** each ticket's lifecycle is one trace: `pulse.ticket.open` → claim → fix → reopen. Each caption gets a `pulse.caption.relay` span covering relay and fan-out.
- **Metrics:**
  - Tickets and votes: `pulse.tickets.opened`, `pulse.ticket.time_to_ack`, `pulse.ticket.time_to_fix`, `pulse.votes`.
  - Rooms: `pulse.listeners`, `pulse.rooms.alerting`.
  - Captions and audio: `pulse.caption.fanout.duration`, `pulse.audio.frames`, `pulse.audio.dropped_frames`.
- **Version:** `service.version` is the git SHA, so a regression points straight to a deploy.
- **Privacy:** keys and personal data are never exported in spans. The no-pii rule enforces this.
- Dash0 shows each room's listener count and which rooms are alerting while a talk runs. Time-to-fix is the number we'd put an SLO on for the AV crew.

**[CHECK]** Judges weight two things we haven't confirmed:
1. **Agent0 or the Dash0 MCP server finding and fixing a real issue.** If you used it, say what it found and link the fix.
2. **A dashboard or SLO (bonus point).** Building a "time to fix < 5 min" SLO on `pulse.ticket.time_to_fix` now and showing it in the video would earn that point.

Real-user monitoring from the phones isn't built yet, so don't claim it.

### How did you use Radar?
We ran our own kind cluster connected to Radar Cloud (the bring-your-own-cluster path). GitOps: a GitHub Action builds the image, bumps `deploy/kustomization.yaml`, and Argo CD syncs it.

- **Checks:** we started at 197/247 passing, with 1 High and 10 Medium findings. We then hardened the pod: no service-account token, read-only root filesystem, no privilege escalation, all capabilities dropped. After that, our namespace `team-pulse` showed 0 Critical, 0 High, 0 security and 0 efficiency findings. We dismissed the single-replica finding as accepted by design, with the reason recorded in Radar's audit log: rooms live in memory, and the next step is cross-pod fan-out.
- **AI investigation on the running pod** found two real issues:
  1. A readiness probe failing at pod start, fixed with a startup probe.
  2. A recurring Elasticsearch write timeout: the cold ELSER model took longer than our 3 s abort. Writes now use a 15 s timeout ([#17](https://github.com/owenbodily-osbmach1/HACKATHONproject-T-O/pull/17)).
- Radar also showed that metrics-server was missing, so we installed it. It showed the pod using about 11m CPU and 35 MiB against requests of 100m and 128 MiB. We load-tested 500 phones on one pod, which peaked around 52m CPU, and right-sized the requests to 50m / 64Mi ([#24](https://github.com/owenbodily-osbmach1/HACKATHONproject-T-O/pull/24)). We also added tunnel readiness probes ([#25](https://github.com/owenbodily-osbmach1/HACKATHONproject-T-O/pull/25)).

Done: the README already describes #24 and #25 as merged (fixed in #41).

### How did you use Elasticsearch?
Elasticsearch (Elastic Cloud Serverless) is the system of record. The live path stays in memory for speed. Everything that outlives the talk lives in Elasticsearch: every caption, vote, ticket, question, talk, crew action, booth visit and check-in, across 8 indices (`pulse-captions`, `pulse-signals`, `pulse-questions`, `pulse-tickets`, `pulse-talks`, `pulse-actions`, `pulse-booths`, `pulse-checkins`).

- **Hybrid search:** a `semantic_text` field (`text_sem`) uses ELSER. The post-talk report searches with an RRF retriever that combines a keyword `match` with a `semantic` query. Searching "what happens when the network goes down" finds the line "When the uplink drops, the collector keeps a bounded buffer on disk", even though no words match.
- **Recommendations:** the same hybrid pattern picks each attendee's next expo booth from what their phone actually heard in talks.
- **Incident history:** the post-talk report's complaint timeline, grouped questions and moderation are read back from Elasticsearch. Hide and answer actions update by document id, so a hidden question stays hidden across restarts.
- **Never blocking:** writes are fire-and-forget with a 15 s timeout, so Elasticsearch can never stall a caption, an audio frame or a vote. If it's down, search falls back to an in-memory text match.

We didn't use it as RAG for an LLM agent. Search is used directly, by the people reading the report and by the booth matcher.

### How does your project make conferences more inclusive and accessible? (Merge Forward)
- **Deaf and hard-of-hearing attendees:** live captions on their own phone, at their own text size, from any seat. They don't have to sit near a caption screen or ask for accommodation in advance.
- **Hearing differences and noisy rooms:** listen-in streams the podium mic straight into the attendee's own earbuds or hearing devices, so the back row hears what the front row hears.
- **Non-native speakers:** captions plus a searchable transcript afterwards. They can reread what they missed and search it by meaning, not exact words.
- **People who won't speak up:** a silent one-tap "Can't hear" / "Can't see". It takes 3 phones, so no one is singled out, and the crew fixes the room without anyone having to interrupt the talk.
- **Low-vision attendees:** slides follow on the phone, which they can hold close and zoom.
- **No barriers to entry:** a web page from a QR code. No app, no account, works on any phone.

**[CHECK]** The last bullet conflicts with the new sign-in form. See the note below.

---

## Part 3: Feedback (write these yourselves, a sentence or two each)

The real opinions should come from you and Ty. Prompts:
- **Gitar:** what it caught that you would have missed; whether the findings ever got noisy.
- **Dash0:** how quickly OTLP data appeared; anything confusing about metric types or the UI.
- **Radar:** the before/after Checks and the investigation finding the ELSER timeout; anything rough in the bring-your-own-cluster setup.
- **Elasticsearch:** `semantic_text` with ELSER worked with almost no setup. The cold-model latency surprised us; a clearer warm-up story would help.

---

## Decide before submitting: the sign-in form vs. the pitch

Several places still promise "no sign-up, no email, no name":
- `docs/DEMO.md`
- the privacy section of `docs/ARCHITECTURE.md` ("No personal data")
- the Gitar `no-pii` rule

The new sign-in form collects first and last name, company and email. Judges read the repo, so pick one story:
- **Option A:** keep "no sign-up" as the headline, and present the sign-in as an organizer option (`SIGNIN=on`) for events that want attendee leads. It stays in memory only and is exportable as CSV. Make every doc say that.
- **Option B:** turn it off for judging (`SIGNIN=off`) and leave it out of the video.

Option A keeps the feature and keeps the accessibility story ("no barriers to entry") honest.
