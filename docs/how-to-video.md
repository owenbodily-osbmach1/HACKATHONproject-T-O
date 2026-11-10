# How-to video: director's script and shot list

A walkthrough video that teaches someone to run Pulse themselves: start it, go live, connect slides, use the audience page, use the AV console. Target length **about 3:30**. It is separate from the under-3:00 submission video in [`video-shoot.md`](video-shoot.md).

Record each shot as its own clip. Claude cuts them together from the shot IDs, so the file names matter more than getting a perfect single take.

## Before you record

- **Start Pulse the way a viewer will:** `npm run demo -- --phones` (see [`QUICKSTART.md`](QUICKSTART.md)). Use the real thing, not the scripted scenes, so what the viewer sees matches what they get.
- **Hide the keys.** The Go live and AV tech links contain keys. Press **F11** in Chrome before recording those tabs so the address bar is off screen, and never record the terminal after the links are printed (shot S02 stops before them, or blur that region).
- **Screen:** set the display to 1920×1080 at 100% scale if you can; record the full screen at 30 fps (OBS Display Capture, or Win+Alt+R).
- **Phone:** use the phone's built-in screen recorder for the audience shots. Wired earbuds in, so Listen doesn't feed back.
- **Deck:** `pulse-demo` in Google Slides, with this start's QR code on the first slide. Have a PowerPoint file ready for S10.
- **Two people is easier:** one talks into the mic, one drives the AV console.
- **Sound:** record the narration separately afterwards (one audio file per section is fine). Clips can be silent, except S05 where the speaker's voice matters.

## File names

`S<shot>_<short-name>_t<take>.mp4`, for example `S07_golive-green_t2.mp4`. Phone clips the same: `S12_phone-captions_t1.mp4`.

Put everything in one folder with a `shots.csv`:

```csv
shot,file,best_take,in,out,notes
S07,S07_golive-green_t2.mp4,2,0:03,0:14,Slides line turns green at 0:09
```

`in` / `out` are where the usable part starts and ends. If you skip a shot, leave its row with a note.

## Shot list

Durations are the time on screen in the final cut, not how long to record. Hold every shot 2 seconds before and after the action.

### A. Start it (0:00–0:30)

| Shot | Screen | What to do | Final length |
| --- | --- | --- | --- |
| S01 | Title card (made in the edit) | — "Pulse: run it yourself in two minutes" | 4 s |
| S02 | Terminal, large font | Type `npm ci` (cut the wait), then `npm run demo -- --phones`. Stop the clip at "Pulse is running." **before the links scroll into view**, or blur them. | 10 s |
| S03 | Browser | The two tabs open by themselves: **Pulse · Go live** and **Pulse · AV tech**. Click between them once. | 6 s |
| S04 | Terminal, links blurred | Slow zoom on the three numbered lines: Go live, AV tech console, Audience phone page. | 6 s |

### B. Go live (0:30–1:05)

| Shot | Screen | What to do | Final length |
| --- | --- | --- | --- |
| S05 | Go live tab (F11) | Before the click: the big **▶ Go live** button, the Status list all "Not started", the QR code. | 5 s |
| S06 | Go live tab | Click **▶ Go live**. Chrome's share box opens: pick **Chrome tab** → **pulse-demo – Google Slides** → **Share**. Then **Allow** the microphone. | 10 s |
| S07 | Go live tab | Say a sentence out loud ("Welcome to room one fifty-one…"). Hold on the Status list while **Server, Microphone, Captions, Listen-in** turn green and the Captions line shows your words. | 10 s |
| S08 | Go live tab | Close-up of the **Phones** line counting up as a phone joins, and the QR code. | 5 s |

### C. Connect your slides (1:05–1:40)

| Shot | Screen | What to do | Final length |
| --- | --- | --- | --- |
| S09 | Google Slides tab | Press **Slideshow**. Advance two slides with the arrow key. | 7 s |
| S10 | Go live tab | The **Slides** line: "Waiting for Slideshow" → "1 sent" → "2 sent". Then click **❚❚ Pause slides** and **⟳ Send slide now** once each. | 10 s |
| S11 | PowerPoint + Go live | The other way: click **Share slides**, pick **Entire screen** in Chrome's share box, press F5 in PowerPoint, advance one slide. | 12 s |
| S12 | Phone (screen recording) | The slide changes on the phone about a second after the laptop. Side-by-side with S09 in the edit. | 6 s |

### D. The audience page (1:40–2:30)

All on a real phone, screen-recorded. One camera shot (S13) of the phone scanning the QR on the projected slide.

| Shot | Screen | What to do | Final length |
| --- | --- | --- | --- |
| S13 | Camera, over the shoulder | Phone camera pointed at the QR on the first slide; tap the link. No app, no login. | 5 s |
| S14 | Phone | The room opens: **Live** pill, room and talk title, captions arriving while the speaker talks. | 8 s |
| S15 | Phone | **Watch**: tap **Slides**, then **Both**. Tap **A+** twice to make the captions bigger. | 8 s |
| S16 | Phone | Tap **Listen with earbuds** (earbuds in). Hold on the level meter moving. | 6 s |
| S17 | Phone | **Tell the crew**: tap **Speak up**. The button changes to show the vote was sent. | 6 s |
| S18 | Phone | **Ask a question**: type "Will the slides be shared?" and tap **Send**. | 7 s |
| S19 | Phone | After the crew marks it fixed (S23): the **Better now?** card. Tap **Yes, better**. | 6 s |

### E. The AV console (2:30–3:20)

| Shot | Screen | What to do | Final length |
| --- | --- | --- | --- |
| S20 | AV tech tab (F11) | Calm state: "All rooms OK. Nothing to fix.", the room tabs, click **Sound off · turn on**. | 6 s |
| S21 | AV tech tab | The moment the Speak up vote lands (S17): the block turns red with the room, the vote count, the likely cause and the steps. Record this in the same take as S17 so they can be shown side by side. | 8 s |
| S22 | AV tech tab | Type a name in **I'm**, click **Claim**. The block changes to claimed. | 5 s |
| S23 | AV tech tab | Click **Mark fixed**. (Cut to S19 on the phone.) | 4 s |
| S24 | AV tech tab, room drawer | Scroll the drawer slowly: **Live status** (Server, Microphone, Captions, Listen-in, Slides, Phones), **Dash0 metrics**, **Last captions**. | 10 s |
| S25 | AV tech tab, room drawer | **Listen to podium** on and off. Untick and re-tick **Captions on phones** under **Room switches**. | 7 s |
| S26 | AV tech tab + phone | **Message every phone**: click the "Audio fixed. Tell us if it's better" chip, **Send**. The banner appears on the phone. | 7 s |
| S27 | AV tech tab | **Questions**: the question from S18 appears in the list. | 4 s |

### F. Wrap up (3:20–3:35)

| Shot | Screen | What to do | Final length |
| --- | --- | --- | --- |
| S28 | Go live tab | Click **■ End talk** twice. | 4 s |
| S29 | Browser | Open the transcript link: the saved transcript and the search box; type one word from the talk. | 7 s |
| S30 | End card (made in the edit) | Repo URL and `npm run demo`. | 4 s |

## Narration

Read at a steady pace; each block matches a section above.

- **A.** "Pulse runs on your own computer. Clone the repo, run npm ci, then npm run demo. It makes its own keys, starts a demo room, and opens two tabs: Go live for the speaker, and the AV console for the crew."
- **B.** "On Go live, press the one button. Chrome asks what to share, so pick your slides, and allow the microphone. Each line turns green as it starts: the microphone, live captions, listen-in audio. The QR code on this page is the room."
- **C.** "Slides need nothing installed. With Google Slides, share the deck's tab and press Slideshow. Pulse sends a slide only when it changes and only while the slideshow fills the screen. With PowerPoint or Keynote, share the entire screen instead. You can pause slides or resend one at any time."
- **D.** "The audience scans the code. No app, no login. They read live captions, switch to the slides or both, make the text bigger, and listen through their own earbuds. If they can't hear or can't see, one tap tells the crew. They can ask a question too."
- **E.** "The AV console shows every room. When people report a problem, the room turns red with a likely cause and what to check. The crew claims it, fixes it, and marks it fixed, and those phones are asked if it's better now. The drawer shows the room's live status and metrics, lets the crew listen to the podium, switch captions or slides off, message every phone, and see the questions."
- **F.** "End the talk, and the full transcript is saved and searchable. That's Pulse: clone, npm run demo, go live."

## Cut list for the edit

1. Assemble in shot order S01–S30 using `in` / `out` from `shots.csv`.
2. Split-screen pairs: **S09 + S12** (laptop slide, phone slide), **S17 + S21** (phone tap, console turns red), **S23 + S19** (Mark fixed, Better now?), **S26** already has both.
3. Lower-third label at the start of each section: "Start it", "Go live", "Connect your slides", "The audience page", "The AV console".
4. Zoom to 150% on small UI when the narration names it: the Status list (S07), the Slides line (S10), the ticket's cause line (S21).
5. Burn in captions from the narration.
6. Check every frame of S02–S04 and any shot with a visible address bar for keys before exporting.

## If a shot fails

| Problem | Fix |
| --- | --- |
| Slides line stays on "Waiting for Slideshow" | Share again and pick **Entire screen**; that skips the full-screen check. |
| The ticket doesn't open in S21 | `npm run demo` opens a ticket from one phone. If you started Pulse another way, 3 different phones must tap within a minute. |
| The phone can't open the QR | Start with `-- --phones`, or put the phone on the same Wi-Fi. |
| No captions | Use Chrome or Edge for Go live and check the microphone is allowed. |
