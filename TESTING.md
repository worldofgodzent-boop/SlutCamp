# SlutCamp — Testing

Automated tests for SlutCamp, built on Node's built-in test runner
(`node:test` + `node:assert`). **No new dependencies** — if Node can run
the server, it can run the tests.

## The rule

Asce's standing rule (Oct 16, 2026): **run test triple before any code
goes live — no bugs.** Nothing merges to `main` unless the full suite
passes **three times in a row**:

```sh
npm run test:triple   # the gate: 3 full runs, all must pass
npm test              # a single run, for quick checks while developing
```

Prerequisite (once per machine): `npm install` in the repo root, so
`node_modules` is complete. Note the `node_modules` copy committed to
git is **incomplete** (e.g. `micro-packed`, a `@scure/btc-signer`
dependency, is missing) and the server cannot boot from it alone —
`npm install` first, always.

## Where everything lives

| Path | What |
|---|---|
| `tests/geo.test.js` | Unit tests for `lib/geo.js` region-block decisions |
| `tests/ccbill.test.js` | Unit tests for `lib/ccbill.js` checkout signing + webhook crediting (in-memory DB, fake env) |
| `tests/crypto.test.js` | Unit tests for `lib/crypto.js` amount formatting + placeholder-coin safety (no network) |
| `tests/crypto-e2e.test.js` | Crypto end-to-end on throwaway keys (published test vectors) + stub price/chain APIs: per-coin invoice creation (address format/freshness, quote math, 30-min expiry, SOL amount-offset + XRP tag keying, fixed-address mode), watcher crediting for BTC/USDT/SOL/XRP with exactly-once proof (re-poll + admin mark + direct re-credit all no-ops), the fixed-address window-scoping regression (pre-invoice transfers never credit), an HTTP run of the real server (config offers only configured coins, fan invoices + QR, admin mark-credited exactly once), fan-UX source pins (plain-words network name + wrong-network warning on the pay screen, EN/ES/PT), and the per-invoice USDT (xpub) suite: BIP44 derivation against the published Hardhat test vector, family-wide index allocation (concurrent creation + restart survival), per-invoice watcher scoping, xpub-over-fixed precedence, and config-error safety (malformed/private xpub disables the coin, never falls back) |
| `tests/presence.test.js` | Unit tests for `lib/presence.js` counts/sampling (in-memory DB) |
| `tests/smoke.test.js` | Integration smoke test: boots the real `server.js` in a throwaway temp copy and checks key flows over HTTP |
| `tests/passkey.test.js` | Face ID (WebAuthn) for everyone + enforced admin step-up: public enrollment/sign-in round trips with a built-in software authenticator, owner-scoped credential management, rate limiting, bootstrap + `passkey_required` enforcement on `/api/admin/*` and `/api/mod/*`, and the fan→Manager isolation regressions |
| `tests/fake-money-cleanup.test.js` | Pre-launch fake-money cleanup: the `SEED_DEMO` gate in both directions (default fresh boot creates no demo accounts and no test credits; `SEED_DEMO=1` creates them, incl. fandemo's $100) and the one-time demo-seed purge — only the three seed MODELS are targets, keyed on username + role and protected by password-fingerprint, pictures and ID-verification guards; a seeded DB with a real user boots clean, the real balance/ledger, the admin and fandemo (the owner's test account, excluded by owner decision 2026-10-16) survive, real models who re-registered seed names are guard-skipped, and the marker prevents a second run |
| `tests/theme.test.js` | Unit tests for the seasonal theme engine (`public/js/theme.js`): every holiday window boundary, the computed Easter/Thanksgiving dates, override semantics, and THEMES-metadata ↔ CSS-pack sync |
| `tests/popups.test.js` | Unit tests for the Halloween pop-up girls (`public/js/theme.js`): roster ↔ pop-up art sync in both directions, the shuffle-bag picker (full 12-combo rotation before repeats, kiss/twerk never back-to-back), schedule bounds (20s first pop, ~6s on screen, 3.5–5 min gaps), the animated art itself (byte-level VP8X animation-flag check: the 11 video-sourced files must be animated WebPs, purple-twerk — no source video — must stay a still, 2.5 MB per-file ceiling), background preloading of the roster after login, and source assertions for the halloween + login gating and the `pointer-events: none` hard rule in the engine and pack CSS |
| `tests/header.test.js` | Source assertions for the header dead-space fix: compacted base header paddings in styles.css, the `:has()` rule that stops the header paying the safe-area inset twice under the theme banner, and the Halloween-only gating + styling of the theme.js promo strip |
| `tests/sw.test.js` | Source assertions for the service worker: theme freshness (`/js/theme.js` + `/css/themes/` network-first, original shell entries intact) and forced refresh — the cache name carries the `__BUILD__` deploy token that `server.js` stamps per deploy, new workers `skipWaiting()`/`clients.claim()`, and activate deletes every non-current cache |
| `tests/update.test.js` | Source assertions + a stamping logic check for forced refresh: `GET /api/build-id` wiring and boot-guarded build-id resolution in `server.js`; the idle-only auto-reload watcher in `public/js/app.js` (60s poll, controllerchange, live/call/sheet/typing busy signals, 30s defer-retry, boot hookup) |
| `tests/reactions.test.js` | Message reactions, end to end: API tests against the real server (participant fan/model react, same-emoji toggle off, different-emoji replace, non-participant 403, guest 403 `login_required`, off-list emoji 400, reactions in the thread payload) plus source pins for the iMessage-style long-press in `app.js` (~500ms timer on the bubble itself, move/up/cancel/scroll cancels, capture-phase click suppression so a pressed locked PPV tile never unlocks, contextmenu prevention, editing/mini-act/popover guards, once-only delegated binding, 🤍 button untouched) and the scoped `.pressing` CSS |
| `tests/splash-resume.test.js` | Source pins for the welcome splash playing on EVERY open: the `index.html` `<link rel="preload">` for the animated lips + the early `Image()` preload at the top of `boot()`, the badge's one-shot `onerror` fallback to the static lips, and the resume splash — `visibilitychange` / persisted `pageshow` after ≥60s hidden re-show `vWelcomeSplash` in overlay mode (boot-completed + no-stacking + `updateBusy()` guards; removes only its overlay host; never routes) |
| `tests/change-password.test.js` | Change password (`POST /api/me/change-password`) against the real server (`SEED_DEMO=1` temp-copy boot): guest 403 `login_required`, wrong current 401 `wrong_current` (password untouched), seed-default new password 400 `default_password` (case-insensitive, checked before the length floor), too-short 400 `weak_password`, new == current 400 `weak_password`, and the success contract — old password can no longer log in, the new one can, every other session is revoked, the caller's session survives — plus source pins for the Settings cards in `app.js` and the Manager |
| `tests/discovery.test.js` | Discovery 2.0 (directory search/filters/tags/similar): API tests against the real server (guest directory payload carries `tags[]` + `created_at`; tag persistence via `PUT /api/model/profile` with the 5-cap, unknown-tag drop, dedupe, non-array 400 `bad_tags`, fan 403), logic tests running the real extracted `applyDiscovery`/`discPriceBand`/`similarModels` from `app.js` (search, online/live/price/tag filters, all sorts, similar ranking), client↔server tag-catalogue parity, and source pins for the bar in both directory views, tile tag chips, the peek rail and the Settings picker |
| `scripts/run-triple.js` | The triple runner behind `npm run test:triple` |

## What the suite covers

**Geo blocking (`lib/geo.js`)** — country/state/county/city block
matching, name normalization, and the fail-open design: unknown or
unresolvable locations never block anyone.

**CCBill (`lib/ccbill.js`)** — the money-safety core, with fake
credentials and an in-memory DB:
- `formDigest` is exactly MD5(price + period + `840` + salt)
- checkout refuses amounts below the $2.95 floor, above the cap, or
  non-integer cents, and refuses to run at all when unconfigured
- a webhook success credits the wallet **exactly once** (duplicate
  posts are no-ops, exactly one ledger row, one fan notification)
- amount mismatch or a bad response digest parks the order in `review`
  and credits **nothing**
- failures and unknown orders never move money; an admin can release a
  review-held order exactly once

**Crypto (`lib/crypto.js`)** — `fmtUnits()` amount formatting for every
coin's decimals; the coin table; and the placeholder safety rule: with
no real receiving config, every coin is a test coin and invoice
creation is refused before any network call (fans must never be sent
to a test address). Payment-URI shapes for BTC/ETH/SOL/XRP invoices.
End-to-end (stub chains, test-vector keys): per-coin invoice creation,
watcher crediting with exactly-once proof for BTC/USDT/SOL/XRP, admin
mark-credited over HTTP (second call 409s), and the regression pin for
invoice-window receipt scoping on the shared ETH/USDT address —
transfers older than an invoice never count toward it.
Per-invoice mode (setting `CRYPTO_USDT_XPUB`): derivation is pinned
to the published Hardhat test-mnemonic BIP44 vector; USDT and ETH
share ONE persisted derivation-index sequence per key family, so two
open invoices can never share a derived address (per-coin sequences
previously handed both coins index 0); the watcher credits only the
invoice whose own derived address was paid. A valid xpub beats the
fixed address; a set-but-unusable xpub (malformed, or carrying
private key material) disables the coin — hidden from fans, refused
at creation — instead of silently falling back to the fixed address.

**Presence (`lib/presence.js`)** — online counts for guests/fans/models,
staff roles never counted, re-pings don't double count, stale entries
prune out of the window, sampling persists aggregate rows, and
America/Chicago day conversion.

**Smoke test (real server, real HTTP)** — boots `server.js` from a
temp-dir copy on a free port with a scrubbed env (no payment/OpenAI/
Twilio/VAPID keys — the dormant pre-launch state) and asserts:
- `GET /` → 200 HTML; `GET /manager/` → 200 HTML
- `GET /api/credits/packages` → the four packages ($10/$25/$50/$100),
  `stubbed: true`
- `POST /api/guest/token` → a 32-hex guest token
- `GET /api/models` → public directory, seeded models on a fresh DB
- signup → login round-trip; wrong password → 401; under-18 DOB → 400;
  duplicate username → 409
- `POST /api/credits/buy` → **501 `payment_not_connected`** for a
  logged-in fan, 401 logged out, 400 for a bad package id
- `GET /api/health` → `{ ok: true }`; unknown **API** routes → 404;
  unknown **page** routes → 200 with the app shell (deliberate SPA
  fallback in `server.js`: the client is hash-routed)

The smoke test's temp copy is always deleted afterwards and the child
server always killed, even when a check fails. The repo's real
`wogent-chat.db` is never booted or touched: `server.js` picks its data
dir from its own folder, which is exactly why the test copies the app
to a temp dir instead of running it in place.

**Passkeys / WebAuthn (`tests/passkey.test.js`)** — Face ID sign-in as
an option for EVERYONE, plus the enforced admin step-up (final scope
per Asce, Oct 16 2026). The test boots the real server like the smoke
test, and the ceremonies use a *software authenticator built in the
test file* (real P-256 keypair, hand-encoded CBOR attestation with fmt
`none`, DER ECDSA assertions) — verification on the server is the real
`@simplewebauthn/server` path, nothing is mocked:
- public enrollment (any signed-in user): register-options without a
  session → 401; a FAN enrolls successfully — register-options →
  register-verify → the credential appears in `GET
  /api/auth/passkey/list` with its label, and the list never exposes
  public keys or credential ids; register-verify with a garbage
  response → 400, nothing stored
- public sign-in: login-options before enrollment → 400 `no_passkey`
  (known and unknown users alike); login-verify with a garbage
  response → 401 and provably creates NO session row; the real fan
  sign-in round trip (case-insensitive username) issues a normal
  session that works on `/api/me`, and updates the authenticator
  counter and `last_used_at` in the DB; sign-in endpoints are rate
  limited per IP (429 `too_many_attempts`)
- admin-only doors: step-up and `GET /api/manager/passkey/status`
  refuse FAN sessions (403)
- bootstrap rule: an admin with NO passkey enrolled reaches
  `/api/admin/stats` and `/api/mod/presence` (200) — no lockout;
  status reports `{enrolled: false, verified: false}`
- enforcement: after the admin enrolls, a FRESH admin session (new
  password login, no step-up) gets 403 `passkey_required` from both
  `/api/admin/stats` and `/api/mod/presence`; status reports
  `{enrolled: true, verified: false}`; the step-up/status doors
  themselves stay reachable
- step-up: garbage assertion → 401 and the session is NOT stamped;
  a real assertion stamps `sessions.passkey_verified_at` for the
  current session, updates the counter and `last_used_at`, status
  flips to `verified: true`, and the admin routes unlock (200)
- removal is owner-scoped for everyone: a fan deleting the ADMIN's
  passkey → 404 and the row survives; each owner can delete their own;
  once the admin has no passkeys left, enforcement lifts (an
  unenrolled admin session reaches admin routes again)

**Fan → Manager isolation (regression, same file)** — Asce's hard
requirement, pinned so it can never silently break:
- `POST /api/manager/login` with valid FAN credentials → 403
  `not_manager`, no token issued
- a fan token cannot reach `GET /api/admin/stats` — 403 with the
  `X-Manager: 1` header and 403 without it — and that holds for a
  PASSKEY-issued fan session too, not just a password one
- positive control: the seeded admin logs in through the Manager door
  and reaches `/api/admin/stats` with the header (200, bootstrap —
  before any passkey exists)

**Fake-money cleanup (`tests/fake-money-cleanup.test.js`)** — the
pre-launch purge of the demo seed accounts. Boots the real server in
temp copies like the smoke test, but test 3 re-boots the SAME copy
three times because the purge is a boot-time migration:
- default fresh boot (no `SEED_DEMO`): the public model directory is
  empty and neither fandemo nor admin can sign in — demos are opt-in
  only now, and a production boot can never (re)create them
- `SEED_DEMO=1` fresh boot: bunny/stacey/bella are listed, fandemo
  signs in holding exactly 10000¢, and the purge stays out of the way.
  (The smoke and passkey harnesses opt in with `SEED_DEMO=1` for the
  same reason — their fixtures ARE the demo accounts.)
- purge run: a seeded DB that also gained a real signup plus a real
  admin credit grant (5000¢ on the ledger) boots without the flag —
  the boot log carries the per-account `[cleanup] purged seed account`
  audit lines for the three seed models, the seed models can no
  longer sign in, the real fan's balance survives to the cent, the
  admin account is preserved, and DB-level checks show the marker
  stamped, the real `credit_grant` row as the only surviving
  transaction, and zero orphaned transactions / conversations /
  messages / wallets. fandemo is NOT a purge target: he is the
  owner's own test account (owner decision, Oct 16 2026), so he
  survives with his $100 (10000¢) untouched and the boot log carries
  the `[cleanup] fandemo preserved` audit line
- exactly once: a third boot shows no purge activity and the real
  balance (and fandemo's $100) is still intact
- guards (purge fires only when NO guard trips; every trip logs):
  password fingerprint — the stored hash must still verify against
  the seed default (`model123`, via `bcrypt.compareSync`); pictures —
  any `media_items` row uploaded by the candidate or a
  `models.photo_url` set means a real model joined; ID verification —
  an `id_verifications` row with status `approved` is conclusive
  proof of a real person (seeds were never verified). The guard test
  deletes seed bunny + bella, registers REAL models under those
  names with different passwords, gives Bunny real earnings (a fan's
  paid message: 149¢ gross / 89¢ hers, on the ledger) plus an
  uploaded-picture row, and marks otherwise-pristine seed stacey
  ID-verified: Bunny trips pictures + password, Bella password
  alone, stacey ID verification alone (her password IS the seed
  default) — nothing is purged and every account, balance and
  ledger row survives. (This mirrors the live DB, where a real
  model now holds the name "Bunny".)

**Seasonal themes (`public/js/theme.js`)** — pure-function unit tests
for the theme engine's `resolveTheme(date, override)`: every holiday
window boundary (Halloween Oct 1–31, Thanksgiving Nov 20 → 4th
Thursday, Christmas Dec 1–25, New Year Dec 28–Jan 2, Valentine's
Feb 7–14, St. Patrick's Mar 10–17, Easter Good Friday → Easter
Sunday, July 4th Jun 27–Jul 4), the computed Thanksgiving (2025–2027)
and Easter (2025–2027, incl. Good Fridays) dates, override semantics
(`?theme=` flag, stored override, `off`/`auto`, unknown names falling
back to the calendar), the `index.html` wiring for `/js/theme.js`, and
THEMES-metadata ↔ CSS-pack sync in both directions.

**Message reactions (`tests/reactions.test.js`)** — the reaction
contract, tested against the real server (temp-copy boot like the
smoke test): a participant fan reacts ❤️ and gets the updated
reactions payload; the same emoji again toggles it off; a different
emoji replaces (one reaction per person, never two); the model in the
conversation can react too, and both reactions ride along in the
`GET /api/conversations/:id/messages` payload with correct `mine`
flags; a fan outside the conversation gets 403 `forbidden`, a guest
gets 403 `login_required`, and an emoji outside the six gets 400
`bad_emoji`. The client half is source pins for the iMessage-style
long-press: delegation on `#messages` guarded by a dataset flag so
`bindMessageActions` re-runs never double-bind, the 500ms timer
opening the EXISTING popover anchored on the pressed bubble, cancel on
>10px move / pointerup / pointercancel / scroll, capture-phase click
suppression for 400ms after a fired press (so pressing a locked PPV
tile can never trigger its unlock click), `contextmenu` prevention,
the guards (message being edited, presses inside the inline editor,
the 🤍/✏️ mini-act buttons, presses inside the open popover), the
untouched 🤍 button, and the CSS split — `-webkit-touch-callout: none`
on bubbles, selection suppressed ONLY under `.msg.pressing` so normal
text copy keeps working.

**Welcome splash on every open (`tests/splash-resume.test.js`)** —
source pins for the two root causes of "I opened the app and the logo
didn't pop up": (a) bfcache/WebView resume without a page load — after
≥60s hidden, `visibilitychange` (visible) or a persisted `pageshow`
re-shows the splash via `vWelcomeSplash(..., { overlay: true })`, but
only once the boot splash has completed, never stacked, and never
while `updateBusy()` says the user is busy (the same idle test as the
forced-refresh watcher; busy means skip, never queue); Enter or the
same unconditional 6s auto-enter removes ONLY the overlay host — the
resume path contains no `routeInitial` and no app-DOM writes; (b) the
916KB badge animation not being downloaded in time — `index.html`
carries a `<link rel="preload" as="image" type="image/webp">` for it,
`boot()` kicks off an `Image()` preload before its first await, and
the badge `<img>` carries a one-shot `onerror` fallback
(`this.onerror=null` first, so it can never loop) to the static lips.
The welcome-voice pins in `tests/logo-anim.test.js` still hold in full
(the resume path reuses the same splash code — exactly one
`Audio('/audio/welcome.mp3')` construction and two `playGreeting()`
call sites app-wide, pinned in both files).

**Change password (`tests/change-password.test.js`)** — the
self-service rotation the owner needs to retire the seed-default
admin password, tested against the real server (`SEED_DEMO=1`
temp-copy boot, fixtures are the demo accounts): guests get 403
`login_required`; a wrong current password gets 401 `wrong_current`
and changes nothing; a seed-default candidate (`admin123` and case
variants) gets 400 `default_password` — the defaults are checked
before the 10-char floor on purpose, since every default is shorter
than the floor and a length-first check would make the distinct error
unreachable; too-short and same-as-current candidates get 400
`weak_password`. The success case logs fandemo in twice, changes via
the first session, and proves the second session is revoked (401 on
`/api/me`), the caller's session still works, the old password can no
longer log in (`bad_login`), and the new one can. Source pins cover
the clients: `renderPwSettingsCard` + `pw-card` hosts + the endpoint
call in `app.js` (fan wallet + model settings, beside the Face ID
card), and the `cpw-*` card + `pwField` form + endpoint call in the
Manager's Settings screen.

**Discovery 2.0 (`tests/discovery.test.js`)** — the directory
search/filters/tags build. The API layer is tested against the real
server (seeded + signup-created models on a throwaway DB):
`GET /api/models` returns a clean `tags` array and `created_at` for
every model to guests and fans alike (existing models default to no
tags), and `PUT /api/model/profile` enforces the tag rules
server-side — catalogue-only (unknown tags dropped), duplicates
collapse, the list caps at 5, a non-array value is 400 `bad_tags`,
and fans get 403. Because the endpoint returns the full roster in one
call, filtering itself is client-side: the suite extracts the real
`applyDiscovery` / `discPriceBand` / `similarModels` functions out of
`app.js` and runs them against fabricated rosters (search by
name/username, online/live/price-band/tag filters alone and combined,
all five sorts with the default preserving server rank order, similar
ranking by shared tags then rank, self-exclusion, the 6-cap, and the
no-tags rank fallback). A parity test pins the client's
`DISCOVERY_TAGS` equal to the server's `MODEL_TAGS`, and source pins
cover the wiring: discovery bar in both directory views, tag chips on
tiles, tappable tags + the "More like her" rail in the peek, the
Settings tag picker, and the 👑 crown appearing only in the default
ordering.

## What the suite deliberately does NOT cover

- **Live payments.** No real CCBill FlexForms checkout, no real webhook
  from CCBill, no real credentials. The webhook *handler* is fully
  unit-tested with synthetic posts; the live round-trip needs CCBill
  onboarding finished and test credentials in a staging env.
- **Real crypto chains/prices.** No chain APIs, no price feeds, no real
  invoices — watcher/crediting from real receipts is untested by design
  (it must never run against mainnet in CI).
- **WebRTC media** (1-on-1 calls, live video) — needs two real browsers
  and media devices; out of scope for `node --test`.
- **Live speech transcription** (`lib/transcribe.js`) — needs the
  OpenAI API or a local whisper install.
- **Web Push delivery** — needs VAPID keys and a real push service.
- **The browser client** (`public/js/app.js`, Manager UI) — no DOM
  tests yet; the smoke test covers the server contract the client
  depends on.
- **Real platform authenticators** — the passkey tests use a software
  authenticator producing genuine WebAuthn messages, but the Face ID /
  fingerprint prompts themselves and cross-device (QR/hybrid) flows
  are not exercised here. The browser UIs — the public app's Face ID
  login button + Settings card (`public/js/app.js`) and the Manager's
  Face ID gate/setup/Settings UI (`public/manager/manager.js`), both
  hand-rolled WebAuthn clients with no new dependencies — are browser
  code and, like the rest of the client, have no DOM tests yet.
  Production RP configuration (`WEBAUTHN_RP_ID` / `WEBAUTHN_ORIGIN`
  for slutcamp.app) is likewise untested until a staging deploy
  exists.
- **Forced-refresh behavior on real devices** — the service-worker
  takeover (per-deploy cache name, skipWaiting, activate flush) and
  the in-app idle auto-reload are pinned by source assertions and a
  stamping logic check, but an open PWA on an actual phone noticing a
  deploy and refreshing itself can only be verified against a real
  deploy on a real device.
- **Load/performance** and multi-instance behavior (the app is a
  single-process, single-SQLite design).

## Conventions for new tests

- Unit tests must not touch the network, the real DB, or real env
  secrets — fake credentials only, in-memory SQLite (`:memory:`).
- Anything that boots the server goes through the smoke test's
  temp-copy pattern. Never boot `server.js` inside the repo folder.
- A test that fails because it found a real app bug is a *good* test:
  keep the app behavior visible, report the bug, don't weaken the
  assertion to make it pass.
