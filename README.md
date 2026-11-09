# Pulse

One QR code per conference room. Attendee phones get live captions, listen-in audio and a way to tell the AV crew what is broken.

## What it does

**Attendees**
- Scan the room QR code. No app, no sign-up.
- Read live captions from the podium microphone.
- Listen to the podium audio through their own earbuds.
- Follow the slides on their phone as the speaker changes them.
- Tap "Can't hear" or "Can't see" when something is wrong.
- Ask a question; similar questions are grouped.

**AV crew**
- `/tech` shows every room and every open signal.
- 3 or more distinct phones within 60 seconds open one ticket, not one per tap.
- The ticket includes a likely cause and steps, for example "Mic is silent or muted" when the podium level is below -50 dBFS.
- The crew claims the ticket, fixes it and marks it fixed. Phones are then asked "Better now?".
- "Still bad" reopens the ticket with the new votes.

**Speaker**
- `/mic/:room` starts the talk, sends captions and audio from the podium laptop.
- `/present/:room` or `/relay/:room` follows the slides.
- `/t/:talkId` is the post-talk report: full transcript, a per-minute signal timeline, grouped questions and semantic search over the transcript.

**Expo booths**
- `/b/:booth` stamps a passport on the attendee's phone.
- "Next booth" is chosen from what that phone actually heard in talks.
- Attendees can join the talk-to-an-engineer queue at a booth.
- `/booth/:booth` gives staff the queue.
- The sponsor report hides any bucket with fewer than 3 devices (k>=3).

Pulse treats every room like a service: SLO-style signals, an on-call crew, quorum alerts from 3 distinct devices, an incident timeline and a postmortem (the report).

## Demo in 3 minutes

- Open the podium page, start captions, show the QR code.
- Join from several phones: captions arrive, audio plays, slides follow.
- Tap "Can't hear" from 3 distinct phones; the tech console turns red with a cause.
- Claim, fix, then answer "Better now?" on a phone.
- End the talk and open the report; search the transcript by meaning.

Full run of show: [`docs/DEMO.md`](docs/DEMO.md). Timings and narration: TBD(DEMO.md).

## How we used the sponsor tools

### Elastic Cloud Serverless

**What:** History and search. Indices: `pulse-captions`, `pulse-signals`, `pulse-questions`, `pulse-tickets`, `pulse-talks`, `pulse-actions`, `pulse-booths`, `pulse-checkins`. `text_sem` is a `semantic_text` field using ELSER (`.elser-2-elastic`). Report search is a hybrid RRF retriever over a text `match` query and a `semantic` query. Next-booth matching uses the same pattern.

**Where:** Mappings in `scripts/es-setup.js`. Client and fire-and-forget writes in `server/es.js`. Hybrid search in `server/questions.js` (`searchCaptions`). Booth matching and writes in `server/booths.js`.

**Evidence:** Searching "what happens when the network goes down" finds "When the uplink drops, the collector keeps a bounded buffer on disk". Writes are fire-and-forget, so Elasticsearch never blocks captions, audio or a vote.

### Dash0

**What:** OpenTelemetry traces and metrics over OTLP/HTTP. Custom metrics: `pulse.tickets.opened`, `pulse.ticket.time_to_ack`, `pulse.ticket.time_to_fix`, `pulse.votes`, `pulse.listeners`, `pulse.rooms.alerting`, `pulse.caption.fanout.duration`, `pulse.audio.frames`, `pulse.audio.dropped_frames`. Lifecycle spans: `pulse.ticket.*` and `pulse.caption.relay`. `service.version` is the git SHA.

**Where:** Setup and exporters in `server/otel.js`. Counters, gauges and spans in `server/tickets.js`, `server/hub.js` and `server/audio.js`.

**Evidence:** A ticket has a trace from open through claim and fix. A caption has one span for relay and fan-out. Dash0 shows the room's listener count and which rooms are alerting while the demo runs.

### Radar (Skyhook)

**What:** Our own kind cluster is connected to Radar Cloud, the starter's bring-your-own path. We used Radar Checks and its AI investigation of the app pod.

**Where:** Manifests in `deploy/`. Cluster overlay in `deploy-byo/`. Argo CD Application in `argocd/application-byo.yaml`. Image build and manifest bump in `.github/workflows/deploy.yaml`.

**Evidence:** Checks before: 197/247 passing, 1 High, 10 Medium. After pod hardening (no service-account token, read-only root FS, no privilege escalation): TBD(radar check). The AI investigation found (1) a readiness-probe failure at pod start, fixed with a startup probe, and (2) a recurring Elasticsearch write timeout: ELSER inference on a cold model exceeded our 3 s abort, so writes now use a 15 s timeout. Radar also showed metrics-server was missing; we installed it. The pod uses about 11m CPU and 35 MiB against requests of 100m and 128 MiB; right-sizing is TBD(decision).

GitOps: a GitHub Action builds a multi-arch image to GHCR, bumps `deploy/kustomization.yaml`, and Argo CD syncs `deploy-byo`.

### Gitar (Sonar)

**What:** Every pull request is reviewed against `.gitar/review/pulse.md` (contract, mic lock, vote correctness, reliability, secrets, accessibility) and `.gitar/rules/` (no-pii, contract-drift, live-path). CI runs `npm run check` and `npm run smoke`, so Gitar can diagnose failures.

**Where:** Review instructions in `.gitar/review/pulse.md`; rules in `.gitar/rules/`. Every change lands as a PR.

**Evidence:** Real catches today include a malformed WebSocket upgrade URL that crashed the single pod; keyed pages served without a key through static files and through percent-encoded or `//` paths; and a deploy change that would have deleted the hackathon HTTPRoute. PR count, Gitar findings and median time to merge: TBD(gh api: PRs, Gitar findings, median time to merge).

## Architecture

One Node 20 pod runs Express and `ws`. Phones connect by WebSocket; the podium laptop sends captions and 100 ms audio frames; the tech console receives tickets. Elasticsearch stores history, Dash0 receives telemetry, and Argo CD deploys the pod. Rooms, sockets and vote windows live in memory, so `replicas: 1`.

Details, message flows, failure modes and security: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Privacy

- No personal data is collected. `clientId` is an anonymous random id created by the phone.
- No sign-up, no email, no name.
- Sponsor reports hide any bucket with fewer than 3 devices (k>=3).
- Microphone access is limited to the podium page by `Permissions-Policy`; attendee pages never call `getUserMedia`.
- Keys live in `.env` locally and in the Kubernetes Secret in the cluster; never in git.

## Run it

```sh
npm ci
cp .env.example .env          # set SPEAKER_KEY and TECH_KEY; Elastic and Dash0 are optional
npm run dev
```

- Podium: `http://localhost:8080/mic/151?key=<SPEAKER_KEY>`
- Phone: `http://localhost:8080/r/151`
- Tech console: `http://localhost:8080/tech?key=<TECH_KEY>`
- Fake talk with phones and an incident: `node scripts/simulate.js`
- Create Elasticsearch indices: `node --env-file=.env scripts/es-setup.js`
- Checks: `npm run check && npm run smoke`

Cluster: create a kind cluster, install the Radar Cloud Helm chart, install Argo CD, then `kubectl apply -f argocd/application-byo.yaml`.

The full route, message, field and index list is in [`CONTRACT.md`](CONTRACT.md).

## Repos and libraries we used

- [`skyhook-io/cnh-starter`](https://github.com/skyhook-io/cnh-starter): `deploy/`, `argocd/` and `.github/workflows/deploy.yaml` are adapted from the template.
- npm: `express`, `ws`, `@opentelemetry/*`.
- Cloudflare quick tunnel (`cloudflared`) for public HTTPS from the laptop cluster.
- Argo CD for GitOps.
- metrics-server for cluster metrics.

## AI use (disclosure)

Most code was written by AI coding agents and reviewed by us through pull requests. We used open-weight DeepSeek V4.1 Flash in the omp agent harness, one agent per card, each in its own git worktree with one PR, and Claude (Anthropic) for planning, integration and testing. Owen also used Claude. Every change went through a PR reviewed by Gitar and merged by the other human. We designed the architecture and the contract (`CONTRACT.md`), and we can explain every part of it.

## Team

- Tyler Jerman: backend, infrastructure, deploy.
- Owen Bodily: UI, design, testing.

## License

Apache-2.0.
