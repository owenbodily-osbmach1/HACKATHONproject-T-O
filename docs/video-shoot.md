# Recording the submission video

The video must be **under 3:00**. Plan: about 2:50, recorded scene by scene with OBS, cut in Clipchamp, captions burned in.

Every app scene has **one command**. It starts a **fresh Pulse server** on `http://localhost:8090` (new keys, empty state). It then plays a fake speaker and fake phones on a fixed clock, opens the Chrome windows at fixed sizes and positions, and prints cues in the terminal: `>>> NOW: click Claim`.

- **Ctrl+C** ends the take, closes its windows and stops its server.
- **Run the same command again** for another take. It starts the same way every time.

```bash
node scripts/video-scenes.js alert
```

Run it from the repo folder. Your live server on port 8080 is not touched.

## Before the first take (once)

- **Display:** 1920×1080, scale 100%. The windows are placed for that size.
- **Your desktop:** close everything else and turn on Do Not Disturb so no pop-ups land in the shot.
- **OBS:**
  - Add a source with **Display Capture** and choose the main display.
  - Set **Video** to 1920×1080 at 30 fps.
  - Set **Output** to MP4 recording.
  - Add a **Window Capture** of the terminal only if you want to see the cues while recording. The cues are printed there, but keep the terminal itself out of the recorded display.
- **Terminal:** use a second monitor, or a small terminal window on top of the area that is cropped out later. Cues arrive on a fixed clock, so you can also read them in a dry run and then record.
- **Real phone (optional):**
  - For a camera shot of a real phone scanning the QR, start a tunnel to port 8090:
    ```bash
    cloudflared tunnel --url http://localhost:8090
    ```
  - Then run the scene with `VIDEO_BASE` set to the tunnel URL, so the QR on the projector points at it:
    ```bash
    VIDEO_BASE=https://<name>.trycloudflare.com node scripts/video-scenes.js join
    ```
  - Without the tunnel, the right-hand "phone" window plays the phone.
- **Elasticsearch (optional, scene `end`):** the meaning-based search ("what happens when the network goes down") needs the Elastic keys. Without them the scene searches the word `uplink`, which finds the same line by text. With them, run:
  ```bash
  VIDEO_ELASTIC=1 node --env-file=.env scripts/video-scenes.js end
  ```

## The shot list

| Time | Scene | Command | Windows |
| --- | --- | --- | --- |
| 0:00–0:15 | Problem + QR | `node scripts/video-scenes.js qr` | Projector, full screen |
| 0:15–0:40 | Scan → sign-in → captions, listen-in, slides | `node scripts/video-scenes.js join` | Projector left (1440×1040) · phone right (430×932) |
| 0:40–1:10 | 3 × "Can't hear" → console red → Claim → Fixed → "Better now?" | `node scripts/video-scenes.js alert` | AV console left · phone right |
| 1:10–1:30 | AV jumps between rooms | `node scripts/video-scenes.js rooms` | AV console, full screen |
| 1:30–1:50 | End the talk → phones show it ended → transcript → search | `node scripts/video-scenes.js end` | AV console left · phone right |
| 1:50–2:10 | Dash0 | browser, see [Dash0](#150-dash0) | Dash0 |
| 2:10–2:30 | Radar | browser | Radar Cloud |
| 2:30–2:45 | Gitar | browser | GitHub PR #43 |
| 2:45–2:50 | Close | title card | — |

### 0:00 Problem + QR (`qr`)

**What the app is doing:** room 151 has no talk yet, so the presenter screen shows the title slide with the join QR.

**What you do:**
1. Film the back-row problem with a camera, or use stock footage.
2. Record about 10 s of the projector window with the QR.
3. Press Ctrl+C.

### 0:15 Scan → sign-in → captions, listen-in, slides (`join`)

**What the app is doing:** a talk is live in room 151 with 18 phones already in the room. A caption arrives every 3.5 s.

**Cues and what you do:**
1. **PHONE (at 1 s):** fill the sign-in form with any name, a company and an `@example.com` email, then tap **Join the room**. The phone lands in the room: Live, captions arriving, "19 here now · 19 scanned in".
2. **At 15 s:**
   - PHONE: tap **Both** (slides and captions together).
   - PROJECTOR: click it, then press **→** twice, about 4 s apart. The phone follows to slide 3.
3. **At 26 s, PHONE:** tap **Listen with earbuds**. The level meter moves. Then press Ctrl+C.

The sign-in form appears on every take, because each take opens a new Chrome profile.

**Say while the form is on screen:** "An organizer can ask for a one-time sign-in, like here. It is optional: at this event it is off, so a scan goes straight to the captions." The live demo and the submission text both say no sign-in, so the video must say the form is optional.

### 0:40 The alert loop (`alert`)

**What the app is doing:** a talk is live in room 151 with 41 phones. The alert limit is 3 votes. There is no demo room in this shot, so only room 151's ticket is on the board.

**Cues and what you do:**
1. **PHONE (at 1 s):** tap **Speak up**. Two more phones vote 1.2 s and 2.4 s after your tap. If you don't tap within 10 s, three phones vote on their own.
2. **AV:**
   - The red **SPEAK UP · Room 151 · 3 votes** block appears, with "Likely: Mic is silent or muted".
   - Click **Claim**, wait 2 s, then click **Mark fixed**.
3. **PHONE:** "The crew fixed the sound. Better now?" appears. Tap **Yes, better**.
4. **AV:**
   - The other two phones answer 2.5 s after the fix.
   - The console shows "✓ Room 151 SPEAK UP fixed by … · Better 3 · Still bad 0".
   - Hold on it for 3 s, then press Ctrl+C.

**Tip:** type a name such as `Sam` in the **I'm** box at the top right first. The block then says "CLAIMED BY SAM".

### 1:10 Rooms (`rooms`)

**What the app is doing:**
- **Room 151:** 46 phones, live captions.
- **Room 152:** 12 phones, and the podium mic is silent.
- **Room 255:** the demo room. 160 seats, about 112 here and 138 scanned, with one "can't see the slides" ticket.

The tabs are in room order, so keys 1, 2 and 3 always mean 151, 152 and 255.

**Cues and what you do:**
1. **Before the take, AV:** type a name in the **I'm** box.
   - The ticket then shows that name instead of "CLAIMED BY TECH".
2. **Wait 60 s after the previous rooms take.** Each take signs in 58 phones, and the server allows 120 sign-ins a minute per address. A third take inside the same minute silently drops phones, so the "46 phones" count is short.
3. **At 6 s, AV:** press **2** for room 152.
   - Its tab shows ⚠ mic quiet.
   - The Live status panel shows Microphone "very quiet".
4. **At 13 s:** press **3** for room 255: 70% full, scan count, Live status.
5. **At 20 s:** press **1**, then Ctrl+C.

### 1:30 End the talk (`end`)

**What the app is doing:** a talk is live in room 151 with 24 lines already said, so there is a transcript to search.

**Cues and what you do:**
1. **AV:** click **End talk**, then click it again within 3 s ("Tap again to end Room 151").
2. **PHONE:** the "This talk has ended" card appears and the vote buttons close. Tap **Read the transcript**.
3. **TRANSCRIPT:** search for `uplink`, or for "what happens when the network goes down" when Elasticsearch is on. Then press Ctrl+C.

### 1:50 Dash0

Open the Dash0 dashboard from [`docs/dash0-slo.md`](dash0-slo.md). Show:
1. **Time-to-fix:** the SLO panel, "fixed within 5 min".
2. **Ticket trace:** one ticket's trace (`pulse.ticket.open` → `claim` → `fix`).
3. **Rooms:** listeners per room and rooms alerting.

Run one `alert` take first, so the panels have fresh data. Dash0 only receives data when the server has the `OTEL_*` keys. For example:

```bash
node --env-file=.env scripts/video-scenes.js alert
```

The runner passes your environment through to its server.

### 2:10 Radar and 2:30 Gitar

- **Radar:** Radar Cloud → Checks (before and after hardening) → the AI investigation that found the cold-ELSER timeout.
- **Gitar:** [PR #43](https://github.com/owenbodily-osbmach1/HACKATHONproject-T-O/pull/43).
  1. Show the first finding: "Forged pulse_v cookies can fill sign-in to 50k and lock out every phone".
  2. Show the fix reply.
  3. End on the "✅ Approved · 4 closed / 4 findings" summary.

## Troubleshooting

- **"port 8090 is busy":** a take is still running. Press Ctrl+C in its terminal, or run with `--port 8091`.
- **Windows open at the wrong size:** the layout assumes a 1920×1080 display at 100% scale. Change `LAYOUT` at the top of `scripts/video-scenes.js` for another size.
- **No Chrome windows:** set `CHROME` to the full path of `chrome.exe`, or run with `--no-windows` and open the printed URLs yourself.
- **Rehearse without recording:** add `VIDEO_SECONDS=60` to end a take on its own after 60 s.
