---
title: Contract drift
description: Block names that are not in CONTRACT.md unless CONTRACT.md changes in the same PR.
when: PR adds or renames an HTTP route, a WebSocket t type, a message field, a vote type, a ticket status, or an Elasticsearch index or field name
actions: Block the PR with a comment naming the drifted name and require the matching CONTRACT.md change in the same PR
type: check
---
`CONTRACT.md` is the source of truth shared by the UI and the backend. The browser pages, the server, the simulation script and any dashboard all agree on it, so an undocumented or renamed name is a break even when both sides happen to change together in one branch.

Compare every route, WebSocket `t` value, message field, vote `type`, ticket `status` and Elasticsearch index/field name in the diff against CONTRACT.md. A deliberate change is allowed only when CONTRACT.md is updated in the same PR, and the PR description notes the rename for the other owner. An addition is still drift until the contract lists it.

Violations:

- Route `PUT /api/vote` instead of `PUT /api/votes`, or `POST /api/talk` instead of `POST /api/talks`.
- WebSocket message `{ t: 'captions' }` instead of `caption`, or a relayed field `content` instead of `text`.
- Vote `type: 'cant-hear'` instead of `cant_hear`, or ticket status `'done'` instead of `fixed`.
- Index `pulse-votes` instead of `pulse-signals`, or an unmapped document field such as `listenerIp`.
- A new route or message implemented without adding a row to CONTRACT.md.

Fine:

- Renaming `listeners` to `listenerCount` while the same PR edits the CONTRACT.md rooms row and says so in the description.
- Adding a documented field that already appears in the contract, for example the viewer role's `caption_backlog` behaviour.

When a name is missing from the contract, ask for the contract row rather than approving based on code alone.
