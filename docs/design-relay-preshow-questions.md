# Design: slide relay, pre-show, tech question hub

Status: **proposed** (Owen + Claude, 2026-11-09 12:10). The UI parts are being built; the backend parts are for Ty. Names below are added to `CONTRACT.md` in the same PR.

Three features, all "phones only, no extra hardware":

1. **Slide relay:** phones follow the speaker's slides whatever app they present from.
2. **Pre-show and talk lifecycle:** before the talk the AV computer can stream to phones; phones know when the talk starts and ends and update without a reload.
3. **Tech question hub:** the AV tech gets a notification for every new question and a place to work through them.

---

## 1. Slide relay (app-agnostic)

**Goal:** works with PowerPoint, Google Slides, Keynote, Canva, a PDF, anything, with no export, add-in or plugin per app, and without interfering with the presentation.

**How it works:**

```
presenting computer                              server (1 pod)                      phones
┌──────────────────────────┐   POST image/jpeg  ┌──────────────────────┐  ws: slide  ┌────────┐
│ /relay/151?key=SPEAKER   │ ─────────────────▶ │ store frame n in RAM │ ──────────▶ │ /r/151 │
│  getDisplayMedia (once)  │  only on change    │ GET /slides/live/... │ ◀── img ─── │        │
│  worker samples every 2 s│                    └──────────────────────┘             └────────┘
└──────────────────────────┘
```

- The speaker opens `/relay/:room?key=SPEAKER_KEY` on the presenting computer, presses **Share slides with phones**, and picks the slideshow window or the projector screen in the browser's normal share prompt. That's the only interaction.
- A Web Worker samples the newest captured frame every 2 s (`MediaStreamTrackProcessor` feeds frames straight to the worker, so a hidden or minimized relay window keeps working; older browsers fall back to sampling a `<video>`).
- **Change detection:** each sample is shrunk to a 32×18 grayscale thumbnail.
  - **New slide:** mean difference from the last *sent* slide is above 0.02. Upload only once the picture has *settled*: two samples in a row within 0.006 of each other. Transitions, builds and cursor moves don't trigger uploads.
  - **Never settles** (a video playing on a slide): send at most one frame every 10 s.
  - **Blank or black screen** (display asleep, fade to black): never sent.
  - **Pause:** the speaker pauses before showing anything private; phones keep the last slide.
  - Upload: JPEG, max 1280 px wide, quality 0.8, about 20–45 KB per slide in tests.
- **Latency:** a new slide reaches phones about 2–4 s after the click (one sample to see the change, one to confirm it settled).
- **Why it doesn't interfere:** screen capture is read-only. The page sends no clicks or keystrokes and never takes focus; it runs in its own window behind the slideshow. CPU: one 32×18 thumbnail every 2 s, and one JPEG encode per new slide. Chrome shows its "sharing your screen" bar, which can be hidden.
- **Privacy:** pick the slideshow window or projector screen, never the presenter view with notes. Pause stops sending. Frames stay in the pod's memory for the talk only.
- **Alternatives considered:**
  - A PowerPoint add-in plus a Google Slides add-on: two codebases, an install, and it still misses Keynote, Canva and PDF.
  - A native screenshot app on the presenting computer: needs an install on a venue machine.
  - A PDF upload: no install, but the speaker must export, and phones don't follow clicks unless the deck is presented from Pulse.

  Screen capture covers every case with one web page. PDF upload stays a possible later add-on.

**Backend (Ty):**

| Method | Path | Auth | Body | Returns |
| --- | --- | --- | --- | --- |
| POST | `/api/rooms/:room/slide-frame` | `SPEAKER_KEY` (`x-pulse-key`) | raw `image/jpeg`, ≤ 1.5 MB (`express.raw({type:'image/*', limit:'1.5mb'})` on this route only; the global JSON limit stays 64 KB) | `{n, url}` |
| GET | `/slides/live/:talkId/:n.jpg` | none | — | the JPEG (`Cache-Control: public, max-age=31536000, immutable`) |

- On upload: `n` = next number for the room's current talk (or a `preshow` bucket when no talk is live). Keep the frames in memory, the last 150 per talk. Then do what `onSlide` already does: set `room.slide`, `send(room, {t:'slide', talkId, n, total: 0, url})`, and index `pulse-actions` with `action: 'slide'`.
- Rate limit: drop uploads less than 1 s apart per room (the relay already sends at most one per 2 s).
- Page route `/relay/:room` with `auth.page('SPEAKER_KEY')`, and add `relay` to the keyed-pages regex so `relay.html` is never served as a static file.
- Phones already handle `slide`: `total: 0` shows "Slide 7 · Following live" instead of "7 / 0".
- Stretch: run OCR on each new frame and index the text (`pulse-slides`, `semantic_text`). Questions could then be matched to the slide they're about, and the report could say "On the eBPF maps slide…".

## 2. Pre-show and talk lifecycle

**Goal:** a phone that scans the QR code before the talk sees something useful, isn't confused by buttons that do nothing yet, and switches to the live talk by itself.

**Phone states** (`/r/:room`):

| State | When | Phone shows |
| --- | --- | --- |
| `waiting` | no live talk in the room | Room name, "Talk hasn't started yet", the next talk's title and time if known. **Listen** works if the AV computer is streaming ("Room audio · pre-show"). Vote buttons are greyed out with the reason "Available when the talk starts". **Ask a question** works: questions are saved for the talk. Broadcast banners from the tech work. |
| `live` | talk started | Everything on. A short banner: "The talk has started: captions are live". Captions, slides and votes switch on with no reload. |
| `ended` | talk ended | "Talk ended · Transcript saved" with the transcript link. Votes off. Listen follows the AV pre-show feed if there is one. |

**Backend (Ty):** a new WebSocket message, sent to every role in the room on join and on every change:

`talk {talkId, title, speaker, status: 'waiting'|'live'|'ended', startedAt, reportUrl?, next?: {title, start}}`

- `POST /api/talks` → status `live`; `POST /api/talks/:talkId/end` → status `ended` (then `waiting` for the next talk).
- **Votes before a talk:** `PUT /api/votes` answers `409 {error: 'no_live_talk'}` and the phone explains it. Questions with no live talk are kept under the room and attached to the next talk when it starts.
- Until `talk` exists, phones fall back to polling `GET /api/rooms` every 10 s while waiting. That's built into the UI now, so it works with today's backend.

**Pre-show audio from the AV computer:**
- The AV computer opens the mic page in pre-show mode: `/mic/:room?key=SPEAKER_KEY&mode=preshow`. It streams its audio input (mixer feed, announcements, music) to `/ws/audio-in`. It creates **no talk** and sends **no captions**.
- **Hand-over rule** (already how `audio.js` works: newest sender wins, old one closed with `4409`): when the podium mic presses Start, it takes over and the AV page is told "Podium took over". A page closed with `4409` must **not** reconnect by itself, or two senders would fight. The AV page waits until no talk is live and then offers "Resume pre-show". The podium mic page shows "Another source took over" with a **Take over** button.
- Phones' Listen just keeps playing; the source changes underneath. The listen button says "Room audio · pre-show" while waiting and "Podium mic" when the talk is live.
- Slides pre-show: the AV computer can run `/relay/:room` on a holding slide (sponsor or schedule screen); the speaker's relay takes over the same way.

## 3. Tech question hub

**Goal:** the AV tech notices every new question without watching the list, and has one place to handle them.

**UI (Owen), using messages that already exist** (`question_groups`, `question_update`):
- **Notifications:** when a new question group appears, or a group's count goes up, the tech gets:
  - a toast at the top of `/tech` with Reply, Add to Q&A and Hide;
  - a short chime, different from the ticket chime;
  - an unread badge on the Questions tab;
  - a browser notification if the tech allowed it and the tab is hidden.
- **Questions hub:** a Questions tab on `/tech`, also available full screen at `/tech?view=questions`. Filters: New · Q&A queue · Answered · Hidden. Each item shows its room, "N similar", its age, and one-tap actions. With several rooms (`?rooms=151,255`), the questions from all rooms are in one list with a room tag.
- The "new" state is worked out on the tech page by comparing each `question_groups` message with the previous one, so the backend needs no change. Optional later: a `question_new {qid, groupId, room, text, count}` message, so a tech page opened late can still show what's unread.

---

## Contract changes in this PR

- `POST /api/rooms/:room/slide-frame`, `GET /slides/live/:talkId/:n.jpg`, page `/relay/:room` (`SPEAKER_KEY`, socket role `present` if it ever needs one).
- `slide.total` may be `0` (captured deck: total unknown).
- New `talk` message (above); `PUT /api/votes` returns 409 when no talk is live.
- Mic page `?mode=preshow`; audio senders closed with `4409` must not reconnect automatically.
