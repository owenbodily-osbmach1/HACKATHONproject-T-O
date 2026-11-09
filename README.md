# Pulse

Cloud Native Hackathon with Kelsey Hightower, Salt Lake City, Nov 9, 2026. Team: Owen (UI) and Ty (backend).

**When people in the back can't hear, the people who can fix it find out in seconds.**

Attendees scan one QR code (no app, no login) and get live captions, listen-in audio through their earbuds, and two buttons: *Speak up* and *Can't see the slides*. When enough different people vote, the AV technician's console goes red with the likely cause and what to do. Every talk is transcribed and saved.

- API contract: [`CONTRACT.md`](CONTRACT.md)
- Gitar review instructions: [`.gitar/review/`](.gitar/review/)

## Sponsor tools
- **Gitar**: every change ships as a pull request reviewed by Gitar.
- **Elasticsearch**: stores captions, votes, questions; semantic grouping of questions.
- **Dash0**: OpenTelemetry traces and metrics, "audible" SLO per room.
- **Radar**: runs on Kubernetes, load-test investigation.

## Workflow
1. Branch from `main` (`ui/...` or `api/...`).
2. Open a PR; Gitar reviews it (comment `Gitar review` to re-trigger).
3. Fix or answer Gitar's findings; the other teammate merges.

## AI assistance (disclosure)
We used AI coding assistants (Claude) to help draft the contract, review instructions and code. Each PR's "AI assistance" section says what was AI-assisted. We reviewed and tested all code and can explain the architecture.
