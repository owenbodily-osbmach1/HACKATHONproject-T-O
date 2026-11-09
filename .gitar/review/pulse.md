# Pulse review instructions

Pulse is a one-day hackathon app: attendees scan a QR code and get live captions, listen-in audio and two vote buttons ("Speak up", "Can't see the slides"); an AV technician console turns votes into tickets. One Node.js pod, plain HTML + vanilla JS, no build step. `CONTRACT.md` is the source of truth for every route, WebSocket message, field and index name.

In addition to standard code review, check the following and flag any violation as **Important**:

## Contract
- Any route, WebSocket `t` value, message field, vote `type`, ticket `status` or Elasticsearch index/field name that differs from `CONTRACT.md`. If the PR intentionally changes the contract, `CONTRACT.md` must change in the same PR.
- `public/` (UI) code calling an endpoint or reading a message field that the contract does not define.

## Mic lock (attendees must never be able to send audio)
- `getUserMedia` called anywhere outside `public/mic.html` / its scripts (`captions.js`, `capture.js`).
- Any page other than `/mic/:room` served without `Permissions-Policy: microphone=(), camera=()`.
- The server accepting binary audio on any socket other than `/ws/audio-in` with a valid `SPEAKER_KEY`, or reading anything a client sends on `/ws/audio-out`.
- `/mic`, `/present` or admin routes reachable without the right key (`SPEAKER_KEY` / `TECH_KEY`).

## Voting correctness
- Counts must be the number of distinct `clientId`s with an active vote, never the number of taps.
- Tapping again (`on: false`) must remove the vote; votes expire after 10 minutes and clear when a ticket is marked fixed.
- One ticket per room and type at a time; extra votes update the same ticket.

## Reliability
- Elasticsearch and Dash0 calls must never block or delay the live caption/audio path (fire-and-forget with error handling).
- WebSocket clients must reconnect with backoff (1, 2, 4 s, up to 10 s) and keep the last captions on screen.
- Server must ping every 20 s. Kubernetes Deployment must stay `replicas: 1`.
- iPhone listen-in: the AudioContext must be created inside the user's tap, with `navigator.audioSession.type = 'playback'` set when supported.
- Speech recognition restart in `onend` must be delayed (about 250 ms), never a tight loop.

## Secrets
- No API keys, tokens, `.env` contents or real `SPEAKER_KEY`/`TECH_KEY` values in code, tests, logs or PR text.

## Accessibility (attendee page)
- Works at 320 px wide; vote buttons at least 64 px tall; captions container uses `aria-live="polite"`; colour is never the only signal (always paired with a word).

Do not flag: missing tests, missing TypeScript, lack of a bundler/framework, or style nits. This is a 5-hour build; focus on bugs that would break the live demo.
