# Pulse architecture

Pulse is one Node 20 process in one pod. Express serves the pages and the HTTP API; `ws` carries captions, slides, tickets, questions and audio. Live state is in memory. Elasticsearch keeps history. Dash0 receives OpenTelemetry. Argo CD deploys the pod.

## Diagram

```text
 podium laptop                         Kubernetes pod (replicas: 1)                    attendee phone
+------------------+                  +---------------------------------------+          +----------------+
| /mic/:room       |  wss captions    | Express                            |  wss      | /r/:room       |
| speech recog.    |----------------->|  static pages + HTTP API           |--------->| captions       |
| /ws/audio-in     |  wss audio       |  ws hub: rooms, roles, clients     |  audio   | listen-in      |
| 16 kHz Int16     |----------------->|  tickets, votes, questions          |--------->| two signals    |
| /present/:room   |  wss slides      |  audio relay, dBFS meter           |  wss      | questions      |
+------------------+----------------->|  Elasticsearch client (async)      |--------->| slides         |
                                      |  OTel exporters                    |          +----------------+
 tech console                         +----------------+----------------------+
+------------------+      wss tickets                  |  HTTPS
| /tech            |<------------------------------------+----------------------> Elastic Cloud Serverless
| claim / fix      |                                     |                        captions, signals,
+------------------+                                     |                        questions, tickets,
                                                         |                        talks, actions, booths
 slides relay                                            |  OTLP/HTTP
+------------------+      wss slides                     +----------------------> Dash0
| /relay/:room     |------------------------------------->                           traces, metrics
+------------------+                                     |
                                                         |
 GitHub push -> Action builds image -> bumps manifest -> Argo CD -> pod
                                                         ^
                                                         |
                                              Radar Cloud (cluster checks)
```

One pod means one WebSocket fan-out point, one vote counter and one ticket table. That is the design, not a deployment accident.

## Flow: one caption

1. The podium page `/mic/:room` runs the browser's speech recognition and sends `{t:"caption", talkId, seq, text, ts}` on `/ws?room=...&role=mic&key=...`.
2. The hub checks that the socket is a keyed `mic` socket. The same message from any other role is dropped.
3. The server keeps the last 50 lines for the room, appends the line to the in-memory transcript, and writes a document to `pulse-captions` without awaiting it.
4. The hub sends `caption` to attendee and tech sockets and the final text to viewers. Interim text goes to attendees as `caption_interim`.
5. A phone that joins later receives `caption_backlog` with the last 50 lines.
6. The phone keeps the last captions on screen while its socket reconnects.

Audio is a separate path: the mic page sends 100 ms frames (1,600 Int16 samples, 3,200 bytes) to `/ws/audio-in?key=SPEAKER_KEY`; the server measures RMS dBFS and relays the same bytes to every `/ws/audio-out` socket in the room. A phone cannot send audio. Frames are dropped for a phone whose send buffer exceeds 64 KiB.

## Flow: one "Can't hear" tap, then a ticket

1. The phone sends `PUT /api/votes` with `{room, talkId, type:"cant_hear", clientId, on:true}`. `clientId` is a random id stored on the phone.
2. The server counts distinct `clientId` values with an active vote in the last 60 seconds. Tapping again sends `on:false` and removes that vote. Votes expire after 10 minutes.
3. At 3 distinct phones, the server opens one ticket for that room and type, or updates the existing one. The cause comes from the latest podium level: below -50 dBFS or no audio gives "Mic is silent or muted"; otherwise "Room level too low".
4. The hub sends the ticket to `/tech` and `/org`, and `ticket_status` to attendee phones. The tech block shows people, cause and steps.
5. The crew marks the ticket claimed. That starts the acknowledgement span and time-to-ack metric. They fix it and mark it fixed.
6. Fixed clears the votes for that room and type, and phones show "Better now?".
7. A phone that answers "still bad" sends `POST /api/feedback {better:false}` and then `PUT /api/votes {on:true}`. The ticket reopens with the new votes.
8. Every vote, ticket state change and action is written to Elasticsearch for the incident timeline and the report.

The report `/t/:talkId` reads the transcript, signals by minute and questions. Search is hybrid: an RRF retriever over a text `match` query and a `semantic` query on `text_sem`. Without Elasticsearch the server falls back to the in-memory transcript and a plain text match.

## Why one replica

`replicas: 1` is required by the current state model:

- Room membership, sockets and the caption backlog are in process memory. A second pod would hold a different subset of phones, so a caption relayed by one pod would not reach phones on the other.
- Votes, tickets and question groups are maps in the same process. Two pods would count the same 3 phones separately and could open two tickets.
- The ticket table, reopen window and mute list are also local.

The Deployment uses `strategy: Recreate` so two pods never overlap during a rollout. Elasticsearch holds the durable history; it is not the live path. Scaling out needs a shared bus and shared state, not a higher replica count.

## Failure modes

| Failure | What happens |
| --- | --- |
| Elasticsearch is down or not configured | Writes are dropped after a logged warning; the live path is unaffected. Search falls back to the in-memory transcript and a plain match. Reports lose history that was never written. |
| Dash0 is down | OTLP exports fail in the background. Captions, audio, votes and tickets continue. Traces and metrics for that window are lost. |
| Phone sleeps or changes network | The socket closes. The phone reconnects with backoff (1, 2, 4 s, up to 10 s), keeps the last captions, and receives the backlog on join. Dead audio-out sockets are found by ping every 20 s. |
| Podium laptop loses the network or reloads | Captions and audio stop. `room_status` shows the caption gap and a null or stale mic level. The tech console sees the room degrade. The audio sender is replaced when the mic page reconnects. |
| Pod restarts | Rooms, tickets, votes, question groups and talks in memory are lost. Phones reconnect but the backlog is empty. Elasticsearch keeps previously written captions and signals. The talk must be started again. |
| Elasticsearch write is slow | Writes use a 15 s timeout and are never awaited. A cold ELSER model no longer aborts the write at 3 s. |
| Slow phone on audio | Frames are dropped once its buffer passes 64 KiB instead of growing memory without bound. |
| Malformed WebSocket upgrade | The upgrade handler parses the URL defensively and rejects the connection, so it cannot crash the pod. |

## Security

- **Keys.** `SPEAKER_KEY` protects `/mic/:room`, `/present/:room`, `POST /api/talks` and `/api/talks/:talkId/end`. `TECH_KEY` protects `/tech` and every crew action. Pages take `?key=`, API calls send `x-pulse-key`, and WebSockets send `&key=`. Comparison is constant time. An unset key locks the route instead of opening it.
- **Mic lock.** Every page except `/mic/:room` is served with `Permissions-Policy: microphone=(), camera=()`. Only the podium page gets `microphone=(self)`. Attendee pages never call `getUserMedia`.
- **Sender check.** The server relays `caption` and `caption_interim` only from a keyed `mic` socket, and `slide` only from a keyed `mic` or `present` socket. Other roles are dropped.
- **Audio isolation.** `/ws/audio-in` requires `SPEAKER_KEY`. `/ws/audio-out` is send-only and ignores anything a phone sends. A binary frame on any other socket closes that connection.
- **Container.** No service-account token, read-only root filesystem, no privilege escalation, all capabilities dropped, non-root user.
- **Secrets.** Keys and credentials come from `.env` locally or the Kubernetes Secret in the cluster. Nothing secret is committed.
- **Privacy.** No personal data. `clientId` is an anonymous random id. Booth sponsor reports suppress buckets under 3 devices.

## What we would do next

1. **Multi-pod fan-out via NATS.** Publish captions, slides and tickets on subjects; each pod keeps its own sockets and subscribes to the room. Move votes, tickets and question groups to a shared store so counting stays global. That removes the one-replica limit.
2. **Named tunnel or real ingress.** The quick tunnel URL changes on restart. A named Cloudflare tunnel or the hackathon gateway with a stable hostname removes that step.
3. **Real user monitoring.** Browser-side latency for caption display, audio start and vote submission, sent as OTLP from the phone, would show the experience the server cannot see.
