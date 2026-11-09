# Pulse demo: 3 minutes (planned 2:24)

**Setup before we start:** Everything runs in room `demo`; press **Start captions** on the mic page before showing the QR (votes open only while a talk is live). Tyler's laptop runs the mic page (`/mic/demo?key=...`) with the slides deck (`/present/demo?key=...`) on the projector; the QR code is on the title slide. Owen's laptop has `/tech?key=...&rooms=demo` and `/org` open. One browser tab each on Radar Cloud (Checks + the investigation), Dash0 (Services + the `pulse` metrics) and GitHub (the PR list). Fallback: `node scripts/simulate.js` against the same room if live speech recognition fails.

**Before you start (mandatory):**
- **Pre-join two attendee tabs you control** (Tyler's phone and Owen's browser) before the demo starts. One judge tap then completes the 3-device quorum, so the ticket cannot fail because a judge was still reading the projector.
- **Brief three judges in one sentence before you start**: "When I say tap, tap the red CAN'T HEAR button once." The 60 s window (`server/tickets.js:44`) means all three taps must be inside half a minute — do not talk for 20 s between the ask and the taps.

| Time | Who | Screen | Say (words → seconds @150 wpm) |
| --- | --- | --- | --- |
| 0:00 | Tyler | Title slide, QR visible | "Every room fails silently: the mic dies, the back row leaves, nobody tells the AV crew. Scan the code." (20 w → 8 s) |
| 0:10 | Tyler | Judges' phones: captions; tap Listen | "No app, no account. Live captions of what I'm saying — for deaf and hard-of-hearing attendees, and anyone reading in a second language. Tap Listen for the mic audio, or watch my slides as I change them." (36 w → 14 s) + phone load |
| 0:26 | Owen | `/tech` turns red with cause | "One tap is noise. Three different phones inside a minute is an incident: one ticket, a likely cause, and the fix steps." (24 w → 10 s) + tap time |
| 0:46 | Owen | Claim, Fixed; phones ask "Better now?" | "We fixed it. The phones that complained get asked 'Better now?' — and 'Still bad' reopens it." (16 w → 6 s) + 8 s wait |
| 1:00 | Owen | Click **Dash0 trace** on the fixed ticket line → Dash0 opens on that ticket's spans; then time-to-fix | "Dash0: every step of the ticket, open, claim, fixed, is a span tagged with the ticket, and time-to-fix is the metric an AV service level would run on." (27 w → 11 s) + nav |
| 1:16 | Tyler | `/t/<talk>`: timeline, questions, search | "Elasticsearch: the talk report. I ask 'what happens when the network goes down' — it finds 'when the uplink drops'. Meaning, not keywords, fused with keyword search. The same index picks your next booth from what you actually heard." (38 w → 15 s) + typing |
| 1:38 | Owen | Radar: Checks delta, investigation | "Radar watched our cluster all day. Its investigation found a startup race and an Elastic timeout we'd missed — both fixed. Security scans: one High and ten Medium before, zero after." (31 w → 12 s) + nav |
| 2:02 | Tyler | GitHub PR list with Gitar comments | "Gitar reviewed every pull request, about 40 of them. It caught a socket request that crashed our only pod, and three ways to open the speaker page without a key." (26 w → 10 s) + nav |
| 2:18 | Tyler | Room page / title slide | "Captions, audio, slides, and a crew that hears the room. One QR code per room." (14 w → 6 s) |

Planned end 2:24; the 21 s buffer is for slow taps. Never skip the ticket loop or Elasticsearch.

## Questions we expect

- **Audio latency, mic to earbud?** Measured over the public URL at 2:45 PM: the relay adds a median 56 ms (p95 100 ms, 100 of 100 frames) on top of the 100 ms frame, so well under a quarter second before the phone's own playback buffer.
- **One replica is a single point of failure.** Deliberate: live rooms are in memory, history is in Elastic, phones reconnect, a restart takes seconds. Recorded in Radar as an accepted risk. Next step: cross-pod fan-out over NATS.
- **Trolls tapping the button.** A vote counts once per device per signal, expires in 10 minutes, and it takes 3 distinct devices to page anyone. The crew confirms with Fixed.
- **Privacy.** No accounts, no names, no emails. The device id is random. The Gitar rule `no-pii` blocks personal fields in Elastic.
- **How much did AI write?** Most of it, through reviewed PRs (see the README's disclosure). We designed the contract and the architecture and can walk through any part.
- **Are the numbers real?** Yes: the 500-phone load test, the Radar usage, the Dash0 metrics and the PR stats are all from today.
