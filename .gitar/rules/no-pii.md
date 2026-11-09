---
title: No personal data in Elasticsearch
description: Block any mapping or indexed document field that stores personal data.
when: PR changes scripts/es-setup.js, server/es.js, any es.index call, or any Elasticsearch index mapping or indexed document field
actions: Block the PR with a comment naming the offending field and the privacy promise it breaks
type: check
---
Pulse tells sponsors how many people could not hear or see a talk, never who they were. Elasticsearch documents are the data that dashboards, the org report and the sponsor export read, so any personal data written there escapes the privacy promise even if the UI never shows it.

With sign-in on (the default), a phone gives first and last name, company or occupation, and email before joining. That data lives only in `server/signin.js` memory (gone on restart) and leaves only through the tech-key CSV export. It must never reach an index, a log line, a span or a metric, and must never be joined to a `clientId`. Speaker names in `pulse-talks` are public talk metadata from the schedule, not attendee data.

Personal data means anything that identifies a person or a device: name, email, phone number, IP address, user agent, postal address, company or employer. That includes fields that only hold a hash or a masked value of those things - a hash of an email is still that person's email. Do not add such fields to an index mapping and do not pass them in an `_doc` body.

`clientId` is the one identifier allowed, and only as the salted hash from `server/device-id.js` (per talk for votes and questions, per booth for check-ins): never the phone's raw id. It is a random id created in the browser, never linked to a name or an account (or to a sign-in), so it can count distinct voters without identifying anyone. Do not add anything that links a `clientId` back to a person, and keep every device-id index under the retention job (`server/es-retention.js`).

Flag only fields a PR adds or changes. Existing fields listed in CONTRACT.md are not re-flagged unless the PR touches them.

Violations:

```js
// Mapping
clientIp: { type: 'ip' },
userAgent: { type: 'keyword' },
attendeeName: { type: 'text' },
```

```js
// Indexed document
es.index('pulse-signals', { talkId, room, type, clientId, on, ts, ip: req.ip });
es.index('pulse-tickets', { ...ticket, reportedBy: email });
```

Fine:

```js
// Anonymous counting only
es.index('pulse-signals', { talkId, room, type, clientId, on: true, ts, minute });
```

If a PR genuinely needs an identifier for debugging, it belongs in logs or metrics with no person attached, not in an Elasticsearch document. Ask for the field to be dropped or replaced with a count.
