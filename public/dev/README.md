# Seeing exactly what an attendee sees

Three ways, from fastest to most real.

## 1. Preview page (no backend needed)

Serve `public/` and open the preview page:

```bash
npx --yes http-server public -p 8080 -c-1
# then open http://localhost:8080/dev/preview.html
```

It shows the real attendee page (`/r.html`) in three phone sizes side by side: iPhone SE (320 px, the smallest we support), iPhone 15 and a large Android. Each one runs `?mock=1`, which fakes the server inside the browser:

- captions stream in, slides advance every 9 seconds, Listen plays a quiet tone so the level bar moves
- the vote buttons work, with pretend votes from 3 other people
- the buttons along the top act as the tech: **Mark sound fixed** (shows "Better now?"), **Reply to my question**, **Broadcast**, captions on/off, change the slide, drop the connection

Everything the fake server sends is a message from `CONTRACT.md`, so what you see here is what the real server will produce. A yellow "PREVIEW · FAKE DATA" tag sits in the corner so nobody confuses it with a live room.

One phone only: `http://localhost:8080/r.html?mock=1&room=151`.

## 2. Your own phone, fake data

On the same Wi-Fi, open `http://<laptop-ip>:8080/r.html?mock=1` on the phone. To get an HTTPS link you can scan from anywhere, run `cloudflared tunnel --url http://localhost:8080` and open the printed `trycloudflare.com` address with `/r.html?mock=1` added.

## 3. Your own phone, the real thing

Once the server is deployed, scan the QR code from the podium mic page, or open `https://<team>.cnh.radarhq.io/r/151`. In the preview page, **Using fake data** switches all three frames to the live server.

Tip: in desktop Chrome, DevTools → device toolbar (Ctrl/Cmd+Shift+M) gives a quick single-phone view too.
