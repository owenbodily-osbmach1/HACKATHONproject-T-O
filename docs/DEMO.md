# Pulse demo: 3 minutes

**Setup before we start:** Tyler's laptop runs the mic page (`/mic/demo?key=...`) with the slides deck (`/present/demo?key=...`) on the projector; the QR code is on the title slide. Owen's laptop has `/tech?key=...` and `/org` open. One browser tab each on Radar Cloud (Checks + the investigation), Dash0 (Services + the `pulse` metrics) and GitHub (the PR list). Fallback: `node scripts/simulate.js` against the same room if live speech recognition fails.

| Time | Who | What happens on screen | What we say |
| --- | --- | --- | --- |
| 0:00 | Tyler | Title slide with the QR code | "Every conference room fails the same way: the mic dies or the slides wash out, and the back of the room quietly leaves. Pulse runs each room like a production service. Scan the code." |
| 0:15 | Tyler | Judges' phones: live captions of this sentence; tap Listen | "No app, no sign-up. Captions come from the podium laptop, audio is a 100 ms WebSocket relay from the same mic." |
| 0:35 | Owen | Judges tap **Can't hear**. `/tech` turns red: "Can't hear, 3 people, likely cause: room level too low, steps" | "One tap is noise. Three different phones in a minute is an incident. The crew gets one ticket with a likely cause, not twenty taps." |
| 0:55 | Owen | Claim, then Fixed. Judges' phones ask "Better now?" | "The people who complained are the ones asked to confirm the fix. Still bad reopens it." |
| 1:10 | Owen | Dash0: the `pulse` service, `pulse.ticket.time_to_fix`, the ticket span | "Dash0: every ticket is a span and a time-to-fix metric, so we can put an SLO on the AV crew like any on-call team." |
| 1:30 | Tyler | `/t/<talk>`: transcript, signal timeline with the spike, grouped questions; search "what happens when the network goes down" | "Elastic: the speaker's report. Hybrid search, keyword plus ELSER semantic with RRF, finds 'when the uplink drops' even though no word matches." |
| 1:50 | Tyler | A phone on `/b/elastic`: passport stamp, "Next booth because you heard: '…'" | "On the expo floor the next booth is picked from what you actually heard. Sponsors see counts, never who: anything under 3 devices is hidden." |
| 2:10 | Owen | Radar: Checks before/after, the AI investigation, the right-sizing PR | "Radar: we ran it all day. Its investigation found a startup probe race and an Elastic timeout we didn't know about; both are merged fixes. It also showed we reserved twice the CPU we use, so we right-sized after a 500-phone load test." |
| 2:30 | Owen | GitHub PR list with Gitar comments | "Gitar reviewed every PR: 53 findings, including a request that could crash the pod and a way to open the speaker page without a key. Median 13 minutes to merge." |
| 2:45 | Tyler | `/org` overview | "One QR code per room and a public schedule. A conference could run this tomorrow." |

## Questions we expect

- **One replica is a single point of failure.** Deliberate: live rooms are in memory, history is in Elastic, phones reconnect, a restart takes seconds. Recorded in Radar as an accepted risk. Next step: cross-pod fan-out over NATS.
- **Trolls tapping the button.** A vote counts once per device per signal, expires in 10 minutes, and it takes 3 distinct devices to page anyone. The crew confirms with Fixed.
- **Privacy.** No accounts, no names, no emails. The device id is random. The Gitar rule `no-pii` blocks personal fields in Elastic.
- **How much did AI write?** Most of it, through reviewed PRs (see the README's disclosure). We designed the contract and the architecture and can walk through any part.
- **Are the numbers real?** Yes: the 500-phone load test, the Radar usage, the Dash0 metrics and the PR stats are all from today.
