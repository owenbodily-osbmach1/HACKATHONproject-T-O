# Pulse demo runbook: every click, from a blank Windows screen

For the live demo with the deck in Google Slides. Each person does only their section. Times are rough.

| Who | Device | Section |
| --- | --- | --- |
| **Host** (Owen) | Windows PC with the `pulse` folder | A: start Pulse |
| **Presenter** | The computer that shows the slides (can be the host PC) | B: slides and relay |
| **Speaker** (Tyler) | The laptop with the microphone (can be the host PC) | C: podium mic |
| **AV tech** | Any laptop or tablet | D: tech screen |
| **Audience and judges** | Their phones | E: join |

> **One PC is fine.** For the first demo the host PC does A, B and C. Laptops for C or D only need Chrome and a link from the host.

> **Links change every start.** Until the app runs on the team cluster at a fixed address, each start of `start-pulse.bat` gives a new `…trycloudflare.com` link. After every start, ask Claude to **update the QR codes in the deck** (section A, step 9).

---

## Before you start (once)

- [ ] The PC is on Wi-Fi, or on a phone hotspot as backup. Charger plugged in.
- [ ] Google Chrome is installed and signed in. The deck **pulse-demo** is in your Google Drive.
- [ ] The `pulse` folder is at `C:\Users\<you>\pulse`, a clone of the repo on branch `poc/one-room`.
- [ ] A phone with mobile data, plus **wired earbuds** for listen-in. Never use a phone speaker near the mic, or it will feed back.
- [ ] Optional: a lapel or USB mic plugged into the speaker's laptop.

---

## A. Host: start Pulse (about 1 minute)

1. Click the **folder icon** (File Explorer) on the taskbar.
2. Click the address bar at the top of the window, type `%USERPROFILE%\pulse` and press **Enter**.
3. **Double-click `start-pulse.bat`.** A black PowerShell window opens.
4. If it asks *"cloudflared … is not installed. Install it now with winget? (Y/N)"*, type **Y** and press **Enter**. If it then says *"Close this window and double-click start-pulse.bat again"*, do that.
5. Wait for the green text **`Pulse is running.`** It prints 4 links (phone, mic, tech, slide relay) and two keys. Typical wait: 20–40 s.
   - If you see `Port 8080 is already in use … Using 8081`, an older Pulse is still running. That's fine; the script moved to the next port.
6. **Don't close this window.** Leaving it open keeps Pulse online. Pressing **Enter** in it stops Pulse.
7. Chrome opens a **new window** with 3 tabs: **Pulse · Podium mic**, **Pulse · AV tech**, **Pulse · Slide relay · Room 151**.
   - Not visible? Hover over the **Chrome icon** on the taskbar and click the preview called **"Pulse · …"**.
8. Laptops for C or D: send each one its link from the PowerShell window (`Podium mic page:` → speaker, `Tech screen:` → AV tech) in a private message. The links contain keys, so never show them on the projector.
9. **Tell Claude: "update the QR codes in the deck".** Claude replaces the QR on the join slide, the title slide and the "Try it now" slide with this start's link. Reload the deck tab afterwards.

## B. Presenter: slides and relay (about 1 minute)

1. In Chrome, open **pulse-demo** in Google Slides: Google Drive → double-click **pulse-demo**. Stay in the editor for now.
2. Switch to the **Pulse** Chrome window (taskbar Chrome icon → **"Pulse · …"** preview) and click the tab **Pulse · Slide relay · Room 151**.
3. Click the green **▶ Share slides with phones**.
4. In Chrome's pop-up:
   - Click the **Chrome tab** option at the top.
   - Click **pulse-demo – Google Slides** in the list.
   - Leave "Also share tab audio" off.
   - Click **Share**.
5. A blue bar appears: *"Sharing this tab to …trycloudflare.com"*. Click **Hide** on it if it's in the way. The relay page shows **Waiting for slideshow**: nothing is sent while you're in the editor.
6. Go back to the **pulse-demo** tab and click **Slideshow** (top right). The first slide, *Scan to join Room 151*, fills the screen.
7. Check the relay page: it shows **Watching slides**, and **Slides sent** goes to 1. You don't need to look again; it works in the background.
8. During the talk:
   - **→ / click** goes to the next slide; phones update about 1 second later.
   - **Esc** leaves the slideshow. Nothing is sent while you're out of it, and phones keep the last slide shown.
   - Before showing anything private, click **❚❚ Pause** on the relay page, then **▶ Resume** afterwards.
   - If a phone ever misses a slide, click **⟳ Send now**.
   - Don't use **Presenter view** on the shared tab. Use plain **Slideshow**.

## C. Speaker: podium mic (about 30 seconds)

1. In the **Pulse** Chrome window, click the tab **Pulse · Podium mic · Room 151**. On a separate laptop, paste the `Podium mic page:` link from the host into Chrome.
2. Type a **Title** (for example *Pulse demo*) and your name under **Speaker**.
3. Under **Microphone**, pick the lapel or USB mic if you have one; otherwise leave **Default microphone**.
4. Click the green **● Start captions**.
5. When Chrome asks to use the microphone, click **Allow**.
6. Check that it works:
   - The line under the button says **Listening**.
   - The **Mic level** bar moves when you talk.
   - **Words captioned** goes up.
   - **Transcript** says **Saving · N lines**.
7. Leave the tab open and don't read it during the talk. It's never projected.
8. Use earbuds on any phone that's listening, and keep listening phones at least 2 m from this laptop.

## D. AV tech: tech screen (about 30 seconds)

1. Click the tab **Pulse · AV tech**. On a separate laptop, paste the `Tech screen:` link from the host into Chrome.
2. Type your name in the **I'm** box. It's recorded when you claim a ticket.
3. Click **🔕 Turn on sound**. It changes to **🔔 Sound on**, and new problems now chime.
4. **Alert at:** keep **1 vote** for the demo (the script's default); use **3 votes** for a real room.
5. Keep this screen in view. When a red block appears:
   1. Click **Claim**. The block turns amber.
   2. Fix the problem, using the steps listed in the block.
   3. Click **Mark fixed**. Every phone that voted gets **Better now?**
6. The right-hand panel shows the room: mic level, recent captions, **🎧 Listen to podium**, and the switches.
   - Type a message under **Message every phone in the room** and click **Send**, or click one of the ready-made messages.
   - Questions from phones appear at the bottom.

## E. Audience and judges: join (about 20 seconds)

1. Open the **camera** and point it at the QR code on the screen.
2. Tap the link that pops up. The **Room 151** page opens; no app or login is needed.
3. Check the dot at the top right says **Live**.
4. At the top, tap **Both** to see the slide and the captions, or **Slides** or **Captions**.
5. Optional: plug in earbuds and tap **🎧 Listen with earbuds** to hear the speaker.
6. If you can't hear, tap **Speak up**. If you can't read the slides, tap **Can't see the slides**. Tap again to take your vote back.
7. When the crew fixes it, answer **Better now?** with **Yes** or **Still bad**.
8. **Ask a question** at the bottom sends a question to the crew.

---

## The demo moment (about 4 minutes)

1. **Join slide on screen:** "Scan this. No app, no login." Judges scan the QR code (E).
2. **Speaker talks:** captions appear on their phones; the presenter clicks to the next slide and it appears on their phones about 1 s later.
3. **Hand one judge the listen phone** with earbuds: they hear the podium mic.
4. **"Pinch the slide on your phone"**: it zooms on their phone while the projector stays the same.
5. **"Now tap Speak up"**: the tech screen chimes and shows a red block with the likely cause. The tech does **Claim**, then **Mark fixed**, and the phones show **Better now?**
6. **A judge types a question**: it appears in the tech screen's Questions panel.
7. **End:**
   - The speaker taps **■ Stop and save** twice, and phones get the transcript link.
   - Then show the sponsor tabs: Dash0, Elasticsearch, Radar, Gitar pull requests.

## Shutting down

1. Mic tab: **■ Stop and save** (tap twice within 3 seconds).
2. Relay tab: **■ Stop**. Then press **Esc** in the slideshow.
3. PowerShell window: press **Enter**. This stops Pulse and the public link; the link stops working.

## If something goes wrong

| What you see | Do this |
| --- | --- |
| A page says **unauthorized** | An old server is answering, or the link is from an earlier start. Use the links printed by **this** start. If an old PowerShell window is still running Pulse, press Enter in it. |
| The Pulse Chrome window isn't visible | Hover over the taskbar Chrome icon and click the **"Pulse · …"** preview. |
| The relay says **Waiting for slideshow** while you're presenting | The slideshow isn't full screen, or it's on a screen of a different shape. Press **Slideshow** again, or click **■ Stop**, then **▶ Share slides with phones**, then pick **Entire screen** and the projector screen. |
| Phones show the old slide | Click **⟳ Send now** on the relay page. Check that the phone's dot says **Live**; if not, pull down to refresh. |
| No captions on phones | Mic tab: is it **Listening**, and is **Words captioned** going up? If it's stuck, click **■ Stop and save** twice, then **● Start captions** again. The phone's view must be **Captions** or **Both**. |
| A phone stops updating after its screen was locked | Unlock it; it reconnects by itself (the dot goes **Reconnecting… → Live**). If not, pull down to refresh. |
| The QR code opens a dead page | The link changed because Pulse was restarted. Ask Claude to update the QR codes in the deck (A9), then reload the deck. |
| A whine from the speakers | A phone speaker is near the mic. Use earbuds only. |
| Nothing works | Play the backup video, then restart from A3. |
