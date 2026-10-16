# SlutCamp 💬

Fan-to-model paid chat platform for **World of Godz Entertainment LLC**.
Mobile-first Progressive Web App (PWA) — installs to the home screen like a native app.

## How it works

- **Fans** browse models free, get **3 FREE messages per model**, then buy credits to keep chatting. Video calls billed per minute.
- **Models** see only their own chats, toggle online/offline, set their own rates, watch earnings grow.
- **Admin (Corry)** sees everything: all chats, safety incidents, live sessions, models, payouts, fans, commission settings.
- **AI Safety Monitor** scans every message for off-platform contact attempts (Snapchat, IG, phone numbers, CashApp…). On a hit: message blocked, chat paused, incident logged, strike counted. 3 strikes → auto-flagged for review.
- **PPV media**: models attach photos/videos with any unlock price they want. Fans pay to unlock.
- **Voice notes**: models record voice notes; fans pay the model's per-note price to listen.
- **Tipping**: fans tip any amount from the chat screen.
- **🔴 Live cam ("pay to play")**: model broadcasts free; fans watch the SFW preview free. On-device AI (NSFWJS) watches the stream and blurs the moment it turns explicit — fan pays the model's per-minute explicit rate to unblur, or gets kicked back after 30 seconds.

## Run it

```bash
cd ~/workspace/wogent-chat
npm install
npm start
```

Then open **http://localhost:3000** (use your phone on the same Wi-Fi via `http://<your-computer-ip>:3000`).

### Demo logins (seeded)

| Who | Username | Password | Notes |
|---|---|---|---|
| Admin | `admin` | `admin123` | Full moderator dashboard |
| Model | `bunny` | `model123` | Online, $1.49/msg, $3.99/min |
| Model | `stacey` | `model123` | Online, $1.49/msg, $3.99/min |
| Model | `bella` | `model123` | Offline, $1.49/msg, $3.99/min |
| Fan | `fandemo` | `fan123` | $100 credits |

Or skip login entirely — guests browse models and get 3 free messages each.

## Default pricing

- Text message: **$1.49** (models can change their own)
- Video call: **$3.99/minute**
- Voice note: **$2.99** to listen (models can change their own)
- Live explicit: **$4.99/minute** (models can change their own)
- PPV photo/video: **model sets any price**
- Tips: **any amount $1+**
- Platform commission: **40%** (admin can change 0–90%)

Money math: fan pays $1.49 → model gets $0.89, platform keeps $0.60 (at 40%). Same 60/40 split applies to PPV unlocks, voice notes, tips, and live explicit minutes.

## Project layout

```
wogent-chat/
├── server.js            # Express + WebSocket + SQLite — all backend logic
├── package.json
├── wogent-chat.db       # SQLite database (created on first run)
├── uploads/             # PPV media + voice notes (served only via authed API)
├── public/
│   ├── index.html       # App shell
│   ├── manifest.json    # PWA manifest
│   ├── sw.js            # Service worker (offline app shell)
│   ├── css/styles.css   # WhatsApp-style dark purple theme
│   ├── js/app.js        # Entire frontend SPA
│   └── icons/           # PWA icons (generated)
├── scripts/make-icons.js
├── PAYMENT-PROCESSOR-GUIDE.md   # How Corry connects CCBill/Segpay
└── AGE-VERIFICATION-GUIDE.md    # Jumio/Veriff + 2257 compliance
```

## 🎉 Seasonal themes ("facelifts")

The public app re-skins itself for the holidays — automatically, and
only for the season. A small engine (`public/js/theme.js`, loaded from
`index.html`) resolves today's theme from a calendar; when a theme is
active it sets `data-theme` on the page, injects that holiday's CSS
pack, shows a slim greeting banner, and floats a few themed emoji
particles over the app. When the window ends, nothing resolves and the
app is exactly back to normal. No server changes, no app-logic changes —
the engine only ever adds decoration, and any failure inside it removes
the decorations and leaves the app untouched.

**Calendar windows** (local date, inclusive; the windows never overlap,
and the computed feasts — Easter, Thanksgiving — win if one ever did):

| Theme | Window |
|---|---|
| 🎃 Halloween | Oct 1 – Oct 31 |
| 🦃 Thanksgiving | Nov 20 – 4th Thursday of November |
| 🎄 Christmas | Dec 1 – Dec 25 |
| 🥂 New Year | Dec 28 – Jan 2 |
| 💘 Valentine's | Feb 7 – Feb 14 |
| 🍀 St. Patrick's | Mar 10 – Mar 17 |
| 🐣 Easter | Good Friday – Easter Sunday (computed) |
| 🎆 July 4th | Jun 27 – Jul 4 |

**Preview / override** — visit the app with a query flag:

- `?theme=halloween` (or any pack name) forces that facelift and
  remembers the choice in `localStorage` (`sc_theme_override`)
- `?theme=off` forces the normal look, also remembered
- `?theme=auto` clears the override and hands control back to the calendar

**Files**

- `public/js/theme.js` — the engine + pack metadata (`THEMES`:
  greeting, particle emojis, `theme-color`). Pure resolver
  `resolveTheme(date, override)` is unit-tested in `tests/theme.test.js`.
- `public/css/themes/theme-base.css` — shared banner/particle structure.
- `public/css/themes/<name>.css` — one pack per holiday: `:root`
  variable overrides under `:root[data-theme='<name>']` plus accents
  (button/logo gradients, card hairlines, selection, scrollbar, banner).

**Halloween pop-up girls** — while the Halloween pack is active,
logged-in fans and models also get a little company: an anime witch
(art in `public/img/popups/<model>-<pose>.webp` — six models with
different hair colors × a kiss-blowing pose and a twerk pose) rises
into a bottom corner ~20 seconds after login and then every 3.5–5
minutes, stays ~6 seconds, and sinks away. The rotation is a
shuffle-bag — every model/pose appears before anyone repeats, and
kiss/twerk alternate. She is pure decoration: `pointer-events: none`
(never clickable, never in the way), skipped while the tab is hidden,
during 1:1 calls and live rooms, and under `prefers-reduced-motion`.
The module lives in `theme.js` with the engine, and the animations in
the Halloween pack — so she vanishes with the season on Nov 1.

**Adding a new pack** — tests enforce that metadata and CSS stay in
sync, in both directions:

1. Create `public/css/themes/<name>.css` with the variable overrides
   scoped to `:root[data-theme='<name>']` (copy an existing pack).
2. Add a `<name>` entry to `THEMES` in `public/js/theme.js`.
3. Add the date window in `calendarTheme()` in the same file.
4. Add resolver cases to `tests/theme.test.js` and run
   `npm run test:triple`.

**Planned follow-up:** a Manager-side global override (force a theme
site-wide, or kill one early, from Slut Manager) is not built yet — for
now the calendar and the `?theme=` flags are the only switches.

## What's stubbed for later (not fake — clearly marked)

1. **Payments** — "Buy Credits" shows *"Payment processor coming soon."* Plug CCBill/Segpay API keys into `POST /api/credits/buy` + webhook. See `PAYMENT-PROCESSOR-GUIDE.md`.
2. **Fan ID verification** — signup uses 18+ checkbox + DOB (fine for testing). Production needs Jumio/Veriff. See `AGE-VERIFICATION-GUIDE.md`.
3. **Model 2257 records** — admin adds models directly (Corry verifies ID in person, as he already does). Keep encrypted ID files per the guide.
4. **Video calls** — WebRTC peer-to-peer works via free Google STUN. For reliability at scale, add a TURN server (e.g. Twilio STUN/TURN or self-hosted coturn).
5. **Push notifications** — not yet; the app uses in-app realtime via WebSocket.

## API quick reference

- `POST /api/guest/token` — anonymous guest identity
- `GET /api/models` — public model directory (now includes `is_live`, voice rate)
- `POST /api/auth/signup|login` — fans & models (18+ gate enforced)
- `POST /api/conversations/start` — open a chat with a model
- `POST /api/messages` — send (trial → billing → safety scan → realtime push)
- `POST /api/calls` → WebSocket signaling → `POST /api/calls/:id/accept|end`
- `POST /api/media/send` (multipart) — model sends PPV photo/video (with price) or voice note; fan sends voice note
- `POST /api/media/:id/unlock` — fan pays to unlock
- `GET /api/media/:id/file` / `POST /api/media/:id/file-token` — authed file serving (token for `<img>`/`<video>`/`<audio>` tags)
- `POST /api/tips` — fan tips a model from a chat
- `POST /api/live/start|/:id/end` — model broadcast control (accepts `title`)
- `GET /api/live` — who's live now (public; includes stream `title`, `viewers`, `gift_cents`)
- `POST /api/live/:id/join|leave|pay|stop-pay` — fan live flow
- `POST /api/live/:id/mode` — model toggles explicit manually (NSFWJS fallback)
- `POST /api/live/:id/blur-event` — client reports AI blur/paywall events for the admin log
- `GET /api/live/:id/chat` — recent group stream chat (free)
- `POST /api/live/:id/chat` — send group chat message (FREE, safety-scanned)
- `GET /api/gifts` — virtual gift catalog (public, enabled only)
- `POST /api/live/:id/gift` — fan sends a virtual gift (60/40 split, realtime animation)
- `GET /api/live/:id/leaderboard` — top-3 gifters + gift totals for a stream
- `GET /api/admin/gifts` / `POST /api/admin/gifts` / `PUT /api/admin/gifts/:id` / `DELETE /api/admin/gifts/:id` — gift catalog management
- `GET /api/admin/safety/stream-flags` — safety hits on group stream chat
- `GET /api/model/earnings` (now with `by_type` breakdown), `PUT /api/model/profile` (voice + explicit rates)
- `GET /api/admin/stats|conversations|models|fans|payouts|safety/*|live` — moderator

WebSocket `/ws?token=…` (or `?guest_token=…`): `chat:new`, `chat:read`, `chat:paused`, `chat:resumed`, `typing`, `signal`, `call:tick`, `call:ended`, `safety:incident`, `media:unlocked`, `live-signal`, `live:viewer-joined`, `live:viewer-left`, `live:explicit`, `live:ended`, `live:tick`, `live:pay_stopped`, `live:chat`, `live:gift`, `live:chat_blocked`, `safety:stream_flag`.

## 🎁 Group live streams — virtual gifts

Group streams are the existing one-to-many broadcast (`live_sessions`) plus:

1. **Stream titles** — model sets a title when going live ("Late night hangout 😈"); shown on the fan Live tab and in-stream.
2. **Free group chat** — fans and model chat free during the stream (the funnel). Every message runs through the AI safety monitor; hits are blocked + strike-counted without pausing everyone else's chat.
3. **Virtual gifts** — fan taps 🎁 → gift panel (🌹 $1 → 🚀 $100, admin-editable catalog) → credits deducted → animated emoji burst shows for EVERYONE watching + "John sent 🚀 Rocket!" in chat. Same 60/40 split.
4. **Top gifters leaderboard** — top 3 fans by gift spending shown live on stream (drives competition).
5. **Per-viewer explicit blur** — when the model goes explicit (AI or manual), EACH fan's screen blurs individually and each pays their own per-minute rate to unblur. 50 viewers × $4.99/min = the money mechanic. Non-paying fans still hear audio + see chat (stays hooked).
6. **Admin** sees gift revenue per stream and manages the gift catalog (add/remove/reprice/enable-disable) from the 🔴 Live tab.

## 🔴 Live cam — how the "pay to play" blur works

1. Model taps **🔴 Go Live** — her camera broadcasts to all joined fans (WebRTC mesh, free Google STUN).
2. Fans see a **🔴 LIVE** badge on her card and watch the SFW preview **free**.
3. On the fan's phone, **NSFWJS** (TensorFlow.js, loaded lazily from `esm.sh`) samples a video frame every 2 seconds. If it classifies the frame as **Porn/Hentai with >0.7 confidence** → heavy CSS blur + paywall overlay: *"🔞 Pay $X/min to keep watching"*.
4. Fan pays → blur removed, per-minute billing starts (same 60/40 split). 30-second countdown otherwise → kicked back to chat.
5. **Model's own preview is never blurred.** She also has a manual **"Go Explicit"** button — if NSFWJS fails to load (offline, blocked CDN), the manual toggle is the fallback and fans get the same paywall via server push.
6. Every blur/pay/timeout event is logged to `blur_events` and visible in the admin **🔴 Live** tab.

### AI detection limitations (be honest about these)

- **NSFWJS is a general nudity classifier**, not a SlutCamp-specific model. It can miss unusual angles/lighting and can false-positive on non-explicit skin (e.g. close-up faces, swimwear is usually fine but not guaranteed).
- **~5MB model download** on first live view (cached after). On slow connections the AI starts late — the manual "Go Explicit" button covers the gap.
- **2-second sampling** means brief flashes may slip through; lowering the interval costs phone battery/CPU.
- **Client-side = bypassable**: a tech-savvy fan could disable the blur in dev tools. This is a paywall nudge, not DRM. The billing is server-side and enforced (pay endpoint checks credits), but the blur itself is cosmetic.
- **No server-side video analysis** — the server never sees the stream (true P2P), which is good for privacy/scale but means detection only happens on the fan's device.
- **iOS Safari**: WebRTC + `import()` from esm.sh both work on modern iOS (15+), but background tabs freeze the monitor — acceptable since the fan is actively watching.

## Safety monitor details

- Keyword list seeded with 20 terms (snapchat, ig, whatsapp, telegram, cashapp, "meet up", …) + automatic phone-number detection.
- Word-boundary matching avoids false positives (`ig` won't flag `big`).
- Blocked messages are **never billed** and **never delivered** — but saved as evidence.
- Admin Safety tab: review incidents, resume/dismiss chats, edit keywords, see strike counts, ban guests.

## Notes

- Database is SQLite (`wogent-chat.db`) — zero-config. Delete it to reset demo data.
- Change the seeded passwords before any real use.
- This is an 18+ adult platform: age gate is in-app, but real ID verification + 2257 + payment processor are required before launch (guides included).
