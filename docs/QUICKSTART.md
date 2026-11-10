# Quick start: run Pulse on your own computer

Works on Windows, macOS and Linux. No accounts, no keys to make, no Elasticsearch or Dash0 needed.

## You need

- **Node.js 22** from [nodejs.org](https://nodejs.org) (newer versions work too; npm prints an "engine" warning you can ignore).
- **Google Chrome or Microsoft Edge** for the speaker's page. Live captions use the browser's speech recognition, which Safari and Firefox don't offer.

## Start it

```sh
git clone https://github.com/owenbodily-osbmach1/HACKATHONproject-T-O.git
cd HACKATHONproject-T-O
npm ci
npm run demo
```

The window prints every link and opens two browser tabs: **Go live** (the speaker) and **AV tech** (the crew). Leave the window open. Press **Ctrl+C** in it to stop Pulse.

| Link printed | Who uses it |
| --- | --- |
| 1. Go live (speaker) | The computer with the microphone and the slides |
| 2. AV tech console | The AV crew |
| 3. Audience phone page | Everyone in the room (it is also the QR code on Go live) |
| Demo room (always live) | A simulated talk, so every page has something to show right away |

## Try it in two minutes, alone

1. On **Go live**, press **▶ Go live**.
   - Chrome asks what to share: pick your slides (see below) and press **Share**.
   - Chrome asks for the microphone: press **Allow**.
2. Talk. The **Captions** line on Go live shows your words.
3. Open the **Audience phone page** link in another tab (or scan the QR code with a phone on the same Wi-Fi). You see the captions; press **Slides** or **Both** to see the slides.
4. On the audience page press **Speak up**. The **AV tech** tab turns red with a ticket.
5. On AV tech press **Claim**, then **Mark fixed**. The audience page asks **Better now?**
6. On Go live press **■ End talk** twice. The audience page shows the talk has ended, and the transcript is saved.

`npm run demo` raises a ticket from one phone so you can try it alone. A real event needs 3 different phones within a minute (`ALERT_THRESHOLD=3`).

## Connect your slides

Go live shares your slides with phones by watching the screen. Nothing is installed in your slides app.

| Your slides are in | In Chrome's share box pick | Then |
| --- | --- | --- |
| **Google Slides** (or any slides in a browser tab) | **Chrome tab** → the deck's tab | Press **Slideshow** in the deck. Slides are sent only while the slideshow fills the screen, so phones never see the editor. |
| **PowerPoint, Keynote, a PDF** | **Entire screen** | Start the slideshow straight away. Phones see whatever is on that screen, so use **❚❚ Pause slides** on Go live before showing anything else. |

- The **Slides** line on Go live says `1 sent`, `2 sent`, … as slides reach phones.
- **⟳ Send slide now** pushes the current slide again.
- If the Slides line stays on "Waiting for Slideshow", press **Share slides** again and pick **Entire screen**.

## Phones

- **Same Wi-Fi as your computer:** scan the QR code on Go live. Nothing else to do.
- **Phones on mobile data (a real room):** install [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/), then start with:
  ```sh
  npm run demo -- --phones
  ```
  Pulse gets a public `https://…trycloudflare.com` link and the QR code uses it. The link is new on every start.
- Listening needs **wired earbuds or headphones**. A phone speaker near the microphone feeds back.

## Options

| Command | What changes |
| --- | --- |
| `npm run demo -- --room 204` | Use room 204 instead of 151 |
| `npm run demo -- --signin` | Phones fill in a one-time sign-in form before they join |
| `npm run demo -- --no-open` | Don't open browser tabs |
| `npm run demo -- --port 9000` | Start on another port (it also moves up by itself if the port is taken) |

Keys you set yourself (`SPEAKER_KEY`, `TECH_KEY` in the environment or in `.env`) are kept. Otherwise new ones are made on every start.

## If something goes wrong

| What you see | What to do |
| --- | --- |
| "Packages are not installed yet" | Run `npm ci`, then `npm run demo` again. |
| "Key needed" page | Use the exact link from the window. Keys change on every start. |
| Captions line says "Microphone blocked" | Click the icon at the left of Chrome's address bar and allow the microphone, then reload. |
| No captions in Safari or Firefox | Open Go live in Chrome or Edge. |
| A phone can't open the QR link | The phone is not on the same Wi-Fi. Use `npm run demo -- --phones`. |
| Windows asks about the firewall | Allow Node.js on private networks so phones can reach your computer. |

On Windows, `tools\start-pulse.bat` does the same with the public tunnel and installs cloudflared for you.
