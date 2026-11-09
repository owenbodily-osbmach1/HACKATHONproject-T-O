# Dash0: the AV time-to-fix SLO and dashboard

**Goal:** a Dash0 dashboard with an SLO on how fast the AV crew fixes what the audience reports, shown in the video at 1:50.

**The SLO:** **95% of tickets fixed within 5 minutes**, over a rolling hour.

The building blocks already exist. `pulse.ticket.time_to_fix` is a histogram in seconds, measured from a ticket opening (or reopening) to "Mark fixed". Since #45 its buckets are `5, 15, 30, 45, 60, 120, 300, 600`, so "within 5 minutes" is exactly the `le="300"` bucket.

**Needs Owen's Dash0 login.** These steps were prepared without access to the Dash0 workspace, so nothing below has been created in Dash0 yet. Metric names in Dash0's query editor can differ from what's written here: dots may become underscores, and a unit suffix may be added. If a query below shows "no data", pick the metric from the editor's metric list and keep the same expression.

## 1. Send data

The server exports to Dash0 only when these are set. Locally, put them in `.env`:

```
OTEL_EXPORTER_OTLP_ENDPOINT=https://ingress.<region>.aws.dash0.com
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <Dash0 auth token>
```

**Where the values come from:** Dash0 → Settings → Auth Tokens, and Settings → Endpoints (OTLP via HTTP).

**Then generate fresh tickets:** run two or three `alert` takes. Each one opens, claims and fixes a ticket.

```bash
node --env-file=.env scripts/video-scenes.js alert
```

## 2. The dashboard

In Dash0, go to **Dashboards → New dashboard** and name it **Pulse · AV service level**. Add these panels.

### Panel 1: Tickets fixed within 5 min (SLO)

**Type:** Stat, with the threshold red below 0.95.

```promql
sum(increase(pulse_ticket_time_to_fix_seconds_bucket{le="300"}[1h]))
/
sum(increase(pulse_ticket_time_to_fix_seconds_count[1h]))
```

### Panel 2: Time to fix, p50 and p95

**Type:** Time series, unit seconds.

```promql
histogram_quantile(0.5,  sum by (le) (rate(pulse_ticket_time_to_fix_seconds_bucket[15m])))
histogram_quantile(0.95, sum by (le) (rate(pulse_ticket_time_to_fix_seconds_bucket[15m])))
```

### Panel 3: Time to acknowledge (claim), p95

**Type:** Time series.

```promql
histogram_quantile(0.95, sum by (le) (rate(pulse_ticket_time_to_ack_seconds_bucket[15m])))
```

### Panel 4: Tickets opened by type

**Type:** Bar chart.

```promql
sum by (pulse_signal_type) (increase(pulse_tickets_opened_total[1h]))
```

### Panel 5: Phones per room

**Type:** Time series.

```promql
sum by (pulse_room) (pulse_listeners)
```

`pulse_room_here` and `pulse_room_fill` work the same way.

### Panel 6: Rooms alerting

**Type:** Stat.

```promql
pulse_rooms_alerting
```

## 3. The SLO alert (check rule)

In Dash0, go to **Alerting → Check rules → New**. If your workspace has the Dash0 operator, you can instead apply [`deploy/dash0/pulse-slo-rules.yaml`](../deploy/dash0/pulse-slo-rules.yaml).

- **Name:** Pulse AV time-to-fix SLO
- **Expression:** the Panel 1 query, with the condition `< 0.95`.
- **For:** 5m
- **Summary:** fewer than 95% of the last hour's tickets were fixed within 5 minutes.

## 4. For the video (1:50–2:10)

1. Run one `alert` take, so the dashboard has a ticket from the last few minutes.
2. Show the dashboard: the SLO stat (100% after a quick take), then p50 and p95 time to fix.
3. Open **Traces** and filter on `pulse.ticket.open`. Show one ticket's trace: open → claim → fix. All three spans carry `pulse.ticket.id`.
4. Optionally show the check rule, green, as "the AV crew's on-call SLO".
