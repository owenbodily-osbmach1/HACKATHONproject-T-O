# Seeing exactly what each screen looks like

Three ways, from fastest to most real. Then: how we design phone vs computer views.

## 1. Preview page (no backend needed)

Serve `public/` and open the preview page:

```bash
npx --yes http-server public -p 8080 -c-1
# then open http://localhost:8080/dev/preview.html
```

Four tabs along the top. Every frame is the real page in an iframe at a real device size; big screens are drawn at their true width and scaled down to fit, so the layout you see is the layout that size really gets.

| Tab | What it shows |
| --- | --- |
| **Phones** | `/r.html` at 320×568 (iPhone SE, the smallest we support), 393×852 (iPhone 15), 412×915 (Pixel) and 852×393 (phone sideways) |
| **Computer** | `/r.html` at 820×1180 (iPad), 1366×768 (laptop) and 1920×1080 (desktop / projector) |
| **Tech console** | `/tech.html` at laptop, tablet and phone size, with rooms 151 and 255 |
| **Phone + tech** | one attendee phone next to the tech laptop: the whole loop |

Every frame runs `?mock=1`, which fakes the server inside the browser, and all frames share **one** fake room (a `BroadcastChannel`):

- captions stream in, slides advance every 9 seconds, Listen plays a quiet tone so the level bar moves
- vote on a phone and the vote count goes up on the tech's red block; Claim → Mark fixed on the tech and the phone asks "Better now?"
- ask a question on a phone and it shows up in the tech's Questions list; Reply there and the answer comes back to that phone
- the buttons along the top also act as the tech: **Mark sound fixed**, **Mark slides fixed**, **Reply to questions**, **Broadcast**, captions on/off, change the slide, drop the connection

Everything the fake server sends is a message from `CONTRACT.md`, so what you see here is what the real server will produce. A yellow "PREVIEW · FAKE DATA" tag sits in the corner so nobody confuses it with a live room.

One page only: `http://localhost:8080/r.html?mock=1&room=151` or `http://localhost:8080/tech.html?mock=1&rooms=151,255`.

Use a plain static server for this (the command above). Ty's Node server serves `/r.html?mock=1` fine but deliberately blocks `/tech.html` as a static file (it's only reachable at `/tech?key=…`), so the fake tech console needs the static server.

## 2. Your own phone, fake data

On the same Wi-Fi, open `http://<laptop-ip>:8080/r.html?mock=1` on the phone. To get an HTTPS link you can scan from anywhere, run `cloudflared tunnel --url http://localhost:8080` and open the printed `trycloudflare.com` address with `/r.html?mock=1` added.

## 3. Your own phone, the real thing

Once the server is deployed, scan the QR code from the podium mic page, or open `https://<team>.cnh.radarhq.io/r/151`. In the preview page, **Using fake data** switches all three frames to the live server.

Tip: in desktop Chrome, DevTools → device toolbar (Ctrl/Cmd+Shift+M) gives a quick single-phone view too.

## Designing phone vs computer views

Same HTML everywhere; CSS decides the layout. In `public/styles.css` each page has clearly marked sections: search for **PHONE VIEW** and **COMPUTER VIEW**.

| Page | Main device | Phone view | Computer view |
| --- | --- | --- | --- |
| Attendee `/r/:room` | phone | default rules: one column, WATCH grows to fill the screen, only WATCH shrinks so blocks never overlap | `ATTENDEE · COMPUTER VIEW` (900 px+ wide and 561 px+ tall): WATCH is a big left column, LISTEN / TELL THE CREW / ASK stack on the right |
| AV tech `/tech` | laptop | `TECH · PHONE VIEW` (under 600 px): counters in a 3-up row, blocks full width, details stack below | default: blocks left, room details in a sticky right column (980 px+) |
| Podium mic `/mic/:room` | laptop | stacks to one column | two columns at 820 px+ |

Rules we hold to:
- **Phone first for attendee pages.** If it works at 320×568 it works everywhere. Check the Phones tab first, then Computer.
- **Breakpoints by layout, not by device name.** 600 / 900 / 980 px are where our content stops fitting, not specific products.
- **Never overlap, scroll instead.** Only WATCH may shrink. In Both mode captions keep about 4 lines and the page scrolls.
- **Tap targets ≥ 44 px, vote buttons ≥ 64 px**, text on coloured fills is black, colour is never the only signal (from `.gitar/review/pulse.md`).
- **Fonts are self-hosted** in `public/fonts/` (Latin only, about 136 KB, SIL Open Font License). Nothing on the page waits for a third-party server, so it still renders on filtered venue Wi-Fi.

### Tools we looked at (no framework added)

We stay with plain CSS and no build step. What's worth knowing:
- **Container queries** (`@container`) are Baseline "widely available" (Safari/iOS 16+), so a component can adapt to the space it gets, not just the window. Use them if a block needs to look different in the tech drawer vs the main board.
- **Utopia** (utopia.fyi) generates fluid `clamp()` type and spacing scales between a min and max screen width. It's a calculator: paste the generated CSS variables into `:root`, nothing to install. Good next step if we want text to grow smoothly from phone to projector instead of jumping at breakpoints.
- **modern-normalize** (sindresorhus) and **Open Props** (argyleink) are no-build CSS files. We don't need them: `styles.css` already sets `box-sizing`, resets margins and defines its own tokens, and Open Props' colours would fight the black-and-white palette.
- For real-device checks there is no substitute: open the page on an iPhone and an Android (section 2 above).
