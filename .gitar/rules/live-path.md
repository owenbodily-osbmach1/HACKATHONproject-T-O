---
title: Live path stays fire-and-forget
description: Block awaited Elasticsearch/Dash0 calls on the live path and any Deployment replica count above one.
when: PR changes server/hub.js, server/audio.js, server/tickets.js, server/talks.js, server/questions.js, or any handler that relays captions, audio frames or votes, or changes k8s Deployment replicas
actions: Block the PR with a comment pointing at the awaited call or the replica change
type: check
---
The live path is the caption relay, the audio fan-out and the vote request. It has to answer in milliseconds while the talk is running. Elasticsearch and Dash0 are observability and storage: they may fail, hang or be slow, so they are fire-and-forget. An `await` on them puts their latency - or a network timeout - in front of attendees, and in a demo that reads as captions freezing or a vote button doing nothing.

Look for any `await` of an Elasticsearch call (`es.index`, `es.search`, `es.raw`, or anything returned by them) or of an OpenTelemetry/Dash0 call (`otel.span`, exporter flush, tracer start) inside a caption, audio or vote handler, or in any function that handler calls before it relays or responds. A `try/catch` around the `await` does not make it acceptable: it still blocks. Wrapping in a helper that returns without awaiting is fine.

The Deployment must stay at `replicas: 1`. Rooms, WebSocket sockets, votes and open tickets live in one process's memory, so a second replica splits attendees from mics and silently loses votes and tickets. Do not add or raise a replica count, and do not add a HorizontalPodAutoscaler that can scale above one.

Violations:

```js
// Blocks the caption relay on storage
await es.index('pulse-captions', doc);
hub.send(room, { t: 'caption', text });

// Blocks the vote response on tracing
await otel.span('vote', () => { ... });
res.json({ count });
```

```yaml
# k8s/deployment.yaml
spec:
  replicas: 2
```

Fine:

```js
// Fire-and-forget: the live caption path never waits for Elasticsearch
es.index('pulse-captions', doc).catch(() => {});
hub.send(room, { t: 'caption', text });
```

```yaml
spec:
  replicas: 1
```

Also flag any new synchronous network call on the live path, even outside Elasticsearch/Dash0, that can delay the relay or the vote response.
