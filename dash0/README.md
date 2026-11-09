What: Dash0 as code for service `pulse` — one Perses dashboard (listeners, alerting rooms, votes, p90 ack/fix, p95 caption fan-out) and two OpenSLO SLOs: 99.9% HTTP availability and 90% of AV tickets acknowledged within 60 s.
Apply: `node --env-file=.env scripts/dash0-apply.js` creates or replaces every `dash0/*.json` object in dataset `default`, then GET-verifies it.
Note: Dash0's SLO API only supports rolling 28-day `Occurrences` ratio SLIs, so the literal 24-hour availability target and the 7-day ack target are Dash0 check rules (`dash0/check-*.json`) with the same thresholds.
