# Demo split: Ty runs AV, Owen runs the presentation

For the live demo on Nov 9. Two laptops, one room (`151`), one Pulse server.

| Who | Laptop | Tabs |
| --- | --- | --- |
| **Owen** (presenter) | Windows PC with the `pulse` folder. Runs the server and tunnel (`start-pulse.bat`). | Google Slides (Slideshow) and **Slide relay** `/relay/151` |
| **Ty** (AV) | Any laptop with Chrome | **Podium mic** `/mic/151`, **AV tech** `/tech`, plus a phone on `/r/151` as a monitor |

Only **one** audio sender per room. When a second mic page connects, the first one is closed (code 4409). So in this split, Owen does **not** use **Go live** (`/go/151`), because Go live opens the mic too. Owen uses **Slide relay** only.

## Links and keys

`start-pulse.bat` on Owen's PC prints the links, keys included. The `…trycloudflare.com` address changes every time it starts.

- Owen sends Ty two links **privately** (a DM, not a group chat and not the repo): the **Podium mic** link (`/mic/151?key=…`) and the **AV tech** link (`/tech?key=…`).
- The audience link `/r/151` and the QR code have no key.
- After every restart, the QR codes in the deck must be updated (ask Claude: "update the QR codes in the deck").

## Ty: AV side, click by click

1. Open Chrome. Captions use Chrome's speech recognition, so it has to be Chrome, online.
2. **Podium mic tab:** open the `/mic/151?key=…` link.
   1. Pick the input that carries the speaker's voice: the podium mic or AV board feed through a USB interface, or the laptop mic if the laptop sits at the podium. The page uses the mic of the computer it runs on.
   2. Type the talk title and speaker name, then click **● Start captions** and **Allow** the microphone.
   3. Watch the mic level move when the speaker talks. Captions appear on the page within a second.
   4. Keep this tab in its own window, in front, and don't let the laptop sleep. A hidden or sleeping tab stops captions.
   5. If the page says another mic took over, click **Take over room audio** only if this laptop should be the mic.
3. **AV tech tab:** open the `/tech?key=…` link and click **Sound off · turn on** so ticket chimes play.
   - A red block = people can't hear or see. Click **Claim**, fix it, then click **Fixed**.
   - Questions from the audience show in the questions list.
4. **Monitor:** scan the QR on slide 1 with a phone and choose **Both**. You should see the slide, the 4-line caption crawl, and **Listen** audio about a second behind.
5. **End:** when Owen finishes, click **■ Stop and save** on the Podium mic tab. Phones show the talk as ended, and the transcript is saved at `/t/<talkId>`.

## Owen: presentation side

1. Run `start-pulse.bat`, then update the deck QR codes. DM Ty the two keyed links.
2. Open `/relay/151?key=SPEAKER_KEY` → **▶ Share slides with phones** → pick the **Google Slides tab** → **Share**.
3. In Google Slides, click **Slideshow**. Only frames that fill the whole screen are sent. That keeps the normal editor off phones, but it is a best-effort check, so share only the slideshow tab, and press **❚❚ Pause** before showing anything private.
4. If the slideshow is on a different monitor than the relay tab and it stays on "Waiting for slideshow", click **Stop** and share **that whole screen** instead.

## For Ty's agent: repo to-dos

Everything above works on `main` once PR "Demo-ready: Gitar fixes for relay, Go live and phone, plus AV/presenter split" is merged. Nothing server-side is required for this split. Open items:

- [ ] Merge Ty's open PRs **#32** (hardening) and **#36** (accessibility) on top of the new `main`. #32 changes `/api/rooms` for ended talks. `public/go.js` no longer reads `/api/rooms` to find the talk: it follows the `talk` WebSocket message (`status: 'live'` only), so #32 is safe for it.
- [ ] Keep sending `talk` on join to every role (CONTRACT.md). `go.js` waits up to 2 s for it before it creates a talk.
- [ ] `/api/rooms/:room/slide-frame` still has the 1 s per-room limit (429). The relay retries on its own, including a **Send now** that hit the limit.
- [ ] Owen's PC still runs branch `poc/one-room`. After the demo, switch it to `main` (`git switch main`) so `start-pulse` pulls fixes from `main`.
- [ ] If the app moves to the team cluster at a fixed address, set `PUBLIC_BASE_URL` and update the deck QR codes one last time.
