# A22 — HANDOVER TO KAY KAY (from Ms. Pink's lane, Oct 30 2026)

**Status: WIP.** The owner moved all of A22 (parts 1–8) to Kay Kay's lane.
This branch (`feat/a22-share-playlist-sound`, based on origin/main `0f53d66`)
carries my finished parts **4, 5, 6, 7** plus the **diagnosis for part 8**
(server half proven; client half narrowed, not closed). Parts 1–3 are yours
already. Integrate what's useful; Ms. Pink gates the combined tree
(two consecutive clean full runs) before anything ships.

**Files this lane touched** (expect overlap with your parts 1–3 here):
- `server.js` — ONE hunk: `share_url` in the GET /api/models shapeRow.
- `public/js/app.js` — STR keys (13 blocks), `shareModelProfile`, the
  media viewer block, several small hunks inside `openModelPeek` and
  `loadPeekFeed`, and `playlistCardHTML`. **openModelPeek is the collision
  zone**: your Like/Follow buttons land in the same function. My hunks are
  small and anchored on distinct lines (see per-part below) — merge, don't
  rewrite the function.
- `public/css/styles.css` — `.peek-expand`, `.peek-vidwrap`, `.media-viewer`
  set (after `.peek-sound-pill`), `.pl-*` set (after `.playlist-card`).
- `tests/a22-share-playlist-viewer.test.js` — NEW. 7 tests, all passing,
  plus 93/93 across the neighbor files (playlist, preview-video-profile,
  profile-gallery-sticky-msg, profile-media-gallery, seo-pages,
  frontpage-complaints-link, theme, sw). Focused runs only — no full
  suite was run from this lane (gate discipline).

**Worktree trap already handled here:** `node_modules` in this worktree is
a SYMLINK to the main checkout's (the baked partial directory was removed,
per the standing trap). Do not commit node_modules; the symlink shows in
git status as noise — stage files explicitly, never `git add -A`.

---

## Part 4 — Share her profile · IMPLEMENTED

- **Server** (`server.js`, GET /api/models → `shapeRow`): adds
  `share_url: r.id === houseId ? null : SEO_ORIGIN + '/models/' + encodeURIComponent(r.username)`.
  The /api/models SQL roster is `role='model' AND banned=0 AND is_hidden=0` —
  the same visibility `seoPublicModels()` enforces for the public page — so
  a share_url exists exactly when her public page serves, and never for
  the house. Client renders the button only when `share_url` is non-empty;
  the guard cannot drift from the server.
- **Client** (`app.js`): peek renders
  `<button class="btn ghost" data-peek-share>` (keyed on `m.share_url`,
  label `t('share_profile')` — the key was added to all 13 STR blocks,
  right after each block's `share_app` line). Wiring sits right after the
  playlist-button block inside openModelPeek. Handler is
  `shareModelProfile(m)` (placed immediately after `shareApp`):
  `navigator.share` → clipboard + `link_copied` toast → prompt fallback.
- **Landing verified live** (test boots SEED_DEMO): GET /models/bunny
  returns 200 with her page signed-out; every seeded model row carries
  `share_url = https://slutcamp.app/models/<username>`. The route already
  landed visitors on her page (CTA into the app) — no fix needed there.

## Part 5 — Playlist rows neat · IMPLEMENTED

- `playlistCardHTML` (`app.js`) rebuilt: avatar left; one grow column
  (`.pl-id`, flex column) holding `.pl-name` (full name on its own line,
  `.pl-dot` presence dot inline before it when online/live, LIVE badge),
  status line, `@username · $x/msg` line, then `.pl-actions` — Message her
  + Remove in their own flex row UNDER the identity block, each `flex: 1`.
  The old `<span class="row">` button span beside the name (the overlap
  from the owner's screenshot) is deleted.
- CSS in `styles.css` after `.playlist-card { cursor: pointer; }`.
- Behaviors untouched and pinned by the existing playlist tests:
  card tap → live or peek; Message → `openChatWithModel`; Remove →
  `toggleFollow` (no confirm existed; none added). `playlistCardHTML`
  has exactly one consumer (`vPlaylist`, the follows list), so no
  sibling list needed the same treatment.

## Part 6 — Profile video sound · DIAGNOSED + FIXED

**Diagnosis — TWO layers, both proven:**
- **(a) THE CODE BUG (proven by internal inconsistency):** the peek
  markup renders her videos with the `muted` CONTENT attribute
  (`<video ... autoplay muted loop playsinline>`), and the tap toggles
  in `openModelPeek` only set `pv.muted = false`. On iOS Safari an
  attribute-muted element stays silent until the attribute is ALSO
  removed inside the gesture. Proof this is the house-known trap: the
  battle unmute (`app.js`, battle stage) and live unmute handlers do
  `v.muted = false; v.removeAttribute('muted');` — the peek toggles
  were the only ones missing the second half.
- **(c) ALSO TRUE of the owner's exact test case (proven by ffprobe of
  the live files):** @Muvaceee's served preview video
  (`/uploads/preview-b3d51a35c35be5a211a6021c199d1b17.mp4`) has an h264
  video stream and **NO audio stream at all** — nothing exists to hear.
  @tokyoo's two preview videos carry h264 + AAC, so for her the (a) fix
  is the whole story. There is NO transcode in the upload path
  (server stores the uploaded file as-is; no ffmpeg anywhere in
  server.js/lib) — the pipeline cannot strip audio; a silent file was
  uploaded silent. If the owner re-tests with Muvaceee's current video
  it will STILL be silent after this fix, correctly — she needs a
  video with sound. Worth telling him before he tests.
- (b) was already satisfied: the handlers call `play()` inside the tap.

**Fix:** added `pv.removeAttribute('muted')` / `pv2.removeAttribute('muted')`
in the two existing toggles (kept the `pv.*` shape — `tests/preview-video-
profile.test.js` pins those exact strings; do not refactor the toggles
into a helper without updating that test). The media viewer's video
toggle (part 7) uses the same pattern.

## Part 7 — Full-screen viewer · IMPLEMENTED (incl. addendum)

- **Component** (`app.js`, block immediately before `openModelPeek`):
  `openMediaViewer(items, index)` / `renderMediaViewer` /
  `mediaViewerGo` / `closeMediaViewer`. Fixed overlay (`.media-viewer`,
  z-index 9990), dark backdrop, media fit-to-viewport
  (`object-fit: contain`, portrait-consistent), **Back button top-left
  always visible** (`t('back')`), ✕ top-right, ‹ › arrows + swipe
  (touch delta > 42px), position indicator `n / N`.
- **Close paths:** Back, ✕, backdrop/stage tap, and hardware/browser
  Back — opening pushes ONE `history.pushState({ scMediaViewer: 1 })`
  and a single global `popstate` listener closes the viewer instead of
  leaving her profile (the app's only history use; contained). UI-close
  consumes the pushed state via `history.back()`; the resulting
  popstate no-ops on the closed viewer. The peek underneath is never
  re-rendered, so her scroll position is exactly where he left it.
- **GATING PARITY BY CONSTRUCTION:** the viewer receives the exact
  shaped arrays the profile rendered and **fetches nothing** (a test
  asserts the viewer block contains no `api(`): gallery =
  `galleryPics` (post upload-gate/co-star/shield payload data), main
  videos = `[preview_video_url, preview_video_url_2].filter(Boolean)`,
  feed = the gate-cleared items from `loadPeekFeed`. Anything blanked
  on the profile simply isn't in the list.
- **Entry points wired:** gallery pictures (`data-peek-photo` index on
  each img → viewer over the 10 pics); clean-feed photos
  (`data-feed-photo`); clean-feed videos — **new ⤢ chip**
  (`.peek-expand` inside a `.peek-vidwrap` wrapper, `data-feed-expand`);
  her two main videos — **⤢ chip top-left of each hero**
  (`data-peek-expand="0|1"`; hero tap itself keeps the part-6 sound
  toggle).
- **ADDENDUM DIAGNOSIS — why the owner's ⤢ "did nothing" (proven):**
  before this build there was **no expand control or handler anywhere
  in the app** — `grep ⤢` and `grep expand` across app.js / styles.css /
  server.js / theme files return nothing media-related. The glyph he
  tapped was the platform's native video-controls furniture on the
  `controls` feed videos, which is inert inside the installed app.
  Now the chip is ours and wired.
- **Viewer videos:** native `controls` (play/pause/seek) + the sound
  pill with the part-6 pattern, pill label kept honest via a
  `volumechange` listener.
- **Scope note:** I covered the in-app profile (the peek IS the profile
  surface for fan/model/guest/preview — there is no second in-app
  profile page). The server-rendered public page (/models/:username)
  was left as-is: its media is one hero photo + a feed grid with
  native controls. If the owner wants the viewer there too, it's a
  small separate addition to the SEO page template.

## Part 8 — "Message her" button · DIAGNOSED, NOT FULLY CLOSED

**Proven:**
1. **Decorations do NOT eat the tap.** The falling-emoji layer
   (`.sc-theme-particles`, theme-base.css) is `pointer-events: none`;
   the Halloween popup girl is `pointer-events: none` inline in
   theme.js AND `!important` in halloween.css. They render OVER the
   sheet (fixed layer, z-60) — which is why pumpkins/spiders sit ON
   the button in his screenshots — but taps pass straight through.
   No overlay fix was needed; a static test pins this.
2. **The server flow is healthy, end to end.** Live probe + the test
   suite: fandemo login → `POST /api/conversations/start {model_id}`
   → **200 with a full conversation object**. The endpoint has NO
   balance gate (a $0 fan gets the thread; billing applies per sent
   message, with free_remaining), fans-only + region + official-model
   guards only. Owner-comp (house) is allowed fan-side by design.
3. The client chain reads correctly on paper: peek
   `[data-peek-msg]` → `sheet.remove()` → `openChatWithModel(id)` →
   `ensureGuest()` (no-op-ish for a signed-in fan) → POST start →
   `show('chat', { conv })`.

**Suspected, NOT proven (no DOM harness exists in this suite, and I
had no live-browser access from this lane):**
- **Admin fan-preview block:** if Asce was browsing in admin
  fan-preview, the tap is intentionally stubbed — toast
  "👁 Preview mode — messaging is fan-only", sheet stays open. His
  screenshots show a $0.00 balance pill (preview shows a "Previewing
  as fan" pill instead), which argues he was in a real fan session —
  but I could not confirm his session type.
- **Stale service-worker app.js on his phone** (the sw.test.js area
  has bitten before: the LIKE BUTTONS saga ended in a cache bump).
  If his installed app runs an older app.js, the current-source flow
  can't be judged from his device. Worth a close/reopen or cache-bump
  check before deeper surgery.
- **A vChat render throw after the sheet closes** (sheet is removed
  BEFORE `openChatWithModel` resolves, so any throw in
  `show('chat')` would present as "tap → nothing"). I read the entry
  path and found no obvious throw for a fresh conversation, but this
  is unverified without a browser.

**Recommended next step for Kay Kay:** reproduce in a real browser as
a fan (not preview), watch whether the toast "Could not open chat."
appears (→ API/session issue on his device) or nothing at all
(→ handler never fires / stale bundle), and check which account type
he was in. Every "Message her" entry point rides the same
`openChatWithModel`: profile peek (msgbar), playlist rows
(`data-pl-msg`), directory — I audited the wiring of all three; they
are identical by construction.

---

*Ms. Pink's lane, A22 parts 4–8 — handed over Oct 30 2026. Questions →
team channel; Ms. Pink runs the integrated gate.*
