# Notes for coding agents (and Gitar)

Pulse: attendees scan a QR code to get live captions, listen-in audio and two vote buttons; an AV tech console turns votes into tickets. One Node.js pod, plain HTML + vanilla JS, no build step.

Read these first:
- `CONTRACT.md`: every route, WebSocket message, field, index and env var shared by UI and backend. Don't rename anything without changing it in the same PR.
- `docs/test-log.md`: what has been tested on real devices and headless, bugs already fixed, and open backend asks. Check it before re-testing or re-fixing something.
- `.gitar/review/pulse.md`: what Gitar flags as Important.

Rules:
- Every change goes through a pull request reviewed by Gitar; the other teammate merges. No pushes to `main`.
- Ownership: `public/` = Owen (UI); `server/`, `scripts/`, `deploy/`, `k8s/`, `Dockerfile` = Ty (backend). `CONTRACT.md`, `.gitar/`, `docs/`, `tools/`, `AGENTS.md` = both.
- Keep `replicas: 1`: rooms, sockets and vote windows live in memory.
- Attendee pages must never call `getUserMedia`; only `/mic/:room` may use the microphone.
- No secrets in git: keys go in `.env` (ignored) or the Kubernetes Secret.
- Hackathon rule: disclose AI assistance in each PR's "AI assistance" section.
- After testing something, add a dated entry to `docs/test-log.md`.
