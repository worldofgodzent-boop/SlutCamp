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
| `tests/payout-protection.test.js` | Payout Protection (earnings hold + clawback engine + fraud flags) against the real server, with CCBill loads driven through the real checkout + webhook path under fake env credentials: the 7-day hold default is pinned (plus all five flag-setting defaults), new earnings are held and un-withdrawable on BOTH the model request path and the Manager direct-pay path, the clawback order 1→2→3 with partial coverage at each step (fan's unspent credits → held model earnings → negative adjustment), the already-withdrawn variant (a chargeback landing after the model cashed out in full reverses $0 at step 2 — payouts are netted out of the pair's lots FIFO — and books the full remainder as debt her future earnings repay automatically: withdrawable stays 0 until the debt is repaid, then rises, with no admin action and no step-2 allocation row), allocation rows per step, idempotent replay on `(source, external_id)`, a second distinct chargeback processing only its own amount, the per-load reversal cap, concentration + shared-card + chargeback-rate flags at their thresholds (info → escalated), crypto-load refusal (`crypto_not_chargebackable`), Manager auth gates (fan token 403, missing X-Manager header blocked), hold-window settings validation + a 0-day hold freeing new earnings while older ones keep their window, time-travel via DB surgery between boots (matured earnings pay out; a clawback that eats the balance makes the Manager pay route refuse with `exceeds_withdrawable`), the grandfathering IIFE (pre-feature rows mature at their own earn date; the marker runs exactly once), per-earning `available_at` stamp precision after a settings change (7d → 3d), and source pins for the Terms additions (Model Agreement §13, Recruiter §4, fan Terms §10) and the exact earnings-view disclosure sentence (the version/numbering pins track later document bumps) |
| `tests/governing-law.test.js` | Texas governing law + venue (owner directive Oct 16 2026 — the LLC is Texas, so Texas law governs the contracts): source pins that all three legal documents carry the clause — fan Terms §11 (Changes renumbered to §12), Model Agreement §14 (disclaimer renumbered to §15), Recruiter Agreement §9 (disclaimer renumbered to §10 by this build, since renumbered to §11 by the affiliate first-year quota at §10) — each stating Texas governing law without regard to conflict-of-laws rules, the state or federal courts located in Texas as venue with both parties consenting to personal jurisdiction, and the carve-out preserving rights a user's home state grants that cannot legally be waived; pins the exact-version bumps that force re-signing of the new text (Model 1.3 → 1.4; the Recruiter version pin tracks the current version — R1.2 for this build, since R1.3 for the quota), the clause's placement after the payout-protection sections, exactly one clause per document, and the unchanged October 16, 2026 document dates |
| `tests/ppv-watermark.test.js` | Per-fan PPV watermark (owner-authorized quick win, Oct 16 2026): logic tests running the REAL `ppvWatermarkHTML` / `fanTagFragment` extracted from `app.js` in a vm — a fan who unlocked a priced PPV photo/video gets his own tag (`@username · #XXXX`, deterministic, varies by fan), and the tag never carries his email or full numeric id; absence is pinned for the model's/sender's own view, staff, guests, locked tiles, $0 free previews, and voice notes; a hostile username is escaped. Source pins: the watermark renders ONLY in the two unlocked tiles of `mediaHTML` (the single chat-media render path), the locked branch stays clean, `.media-wm` CSS is `pointer-events: none`, the note string exists in EN/ES/PT and rides only the FIRST unlock toast of a session, and the unlock route/flow + shared `/api/media/:id/file` serving are untouched (overlay, not burned-in — the design's stated limit) |
| `tests/spend-dashboard.test.js` | Fan spend dashboard + optional monthly spend cap (owner-authorized quick win, Oct 16 2026): API tests against the real server — auth gates (guests refused, models 403), the empty state (11 categories, no cap), aggregation from REAL charges (tip_menu + plain tip + paid message land in the right categories/top models), cap CRUD validation (null clears; whole cents $10–$100,000; else 400 `bad_cap`), enforcement inside chargeFan (spending up to the cap allowed, the crossing charge refused whole as 402 `spend_cap_reached` with cap + month-spent, no money moves, across three spend types; free messages never capped), a refund restoring headroom, the no-cap control fan, and the unchanged `insufficient_credits` path — plus a DB-surgery boot pinning the UTC calendar-month boundary (00:00:00 on the 1st counts, 23:59:59 on the last prior day doesn't), every ledger type's category, and the exclusions (loads, credit grants, chargeback rows, positive admin `refund` credit-returns, `is_test` rows) and source pins (routes, funnel guard, additive `users.spend_cap_cents`, the wallet panel + shared cap toast + EN/ES/PT strings in `app.js`) |
| `tests/av-shield.test.js` | Pre-purchase explicit-media shield (AV design, Oct 16 2026): unit tests for `lib/shield.js` (dormancy = BOTH `AV_PROVIDER`+`AV_API_KEY` set, the 27-state list, location resolution — stored fan_state → IP geo → unknown fails closed, fan/guest rule matrix), plus a two-boot real-server scenario (dormant boot pins today's behavior byte-for-byte: free flagged media open, file routes serve, live explicit entry ungated; active boot: free explicit-flagged chat media is shield-flagged in the payload and byte-gated with `av_required` on BOTH file routes for an unverified fan at an unknown location, unflagged free media stays clear, priced media keeps its locked tile, the model's at-upload checkbox + in-thread toggle flip the shield both ways and fans get 403 on the toggle, the directory withholds preview loops from shielded viewers only — verified fans and known non-AV-state fans keep them — live explicit entry/pay refuse before any charge and open once verified), the guest invariant (no chat-media bytes in either configuration), proof-only schema pins (no AV document/DOB columns), and source pins (inert shield tile with the EN/ES/PT verified-only hint, price-sheet checkbox, CSS variant) |
| `tests/seo-pages.test.js` | Public SEO pages (owner-approved Oct 16 2026 — the SPA gave Google exactly one page): API tests against the real server (temp-copy boot + DB surgery between boots for the non-public fixtures) — a public model's page returns 200 with her unique `<title>`, OG/Twitter tags, canonical, `rating: adult` + RTA label meta, JSON-LD, price, tag links and the app CTA, and her rank badge matches `rank_position` from `GET /api/models`; a bio carrying an HTML payload renders escaped, never raw; unknown usernames and hidden/banned models return a real 404; the `/models` index lists public models only; `/join` carries the 60% recruiting pitch; `/tags/:tag` renders for live tags and 404s for unknown AND catalogue-but-empty tags; the dynamic `/sitemap.xml` includes homepage/`/join`/`/models`/public model pages/live tag pages and excludes hidden + banned models; SPA root and `/api/models` are unaffected. Plus the owner's storefront rule (Oct 16 2026): public pages show ONLY her separate clean `models.public_photo_url` (logo fallback when unset — the possibly-explicit in-app storefront `photo_url` never appears in any public HTML, asserted with real uploaded URLs on the model page, index and tag pages), the settings round-trip through the real upload/clear API (set → read back via `/api/me` → public page picks it up → clear → gone, storefront untouched), owner-only writes (fan 403, guest 401, no-file 400, another model's write lands only on her own row), the in-app `/api/models` payload still carrying the storefront photo unchanged, and source pins (additive column, routes, settings control, EN/ES/PT label) |
| `tests/av-gate.test.js` | Dormant age-verification gate (owner's design, Oct 16 2026 — verify at the money moment, not the door): unit tests for `lib/av.js` pin the exact 27-state AV list, the CCBill-style dormancy switch (`AV_PROVIDER` + `AV_API_KEY` both required), the pure gate-decision matrix (non-fans never gated, verified-once passes forever, verifiably non-US fans never gated, fresh geo beats stored state both directions, and UNKNOWN state gates on purpose — the purchase is the choke point), the stub provider's deterministic pass/fail (an 'avfail' username fails and is stamped with nothing), exactly-once proof stamping across replays and repeat sessions, the webhook finalize path (duplicate/ignored handling, dormant rejection), and the proof-only schema guarantee (users gains exactly `fan_state`, `av_verified_at`, `av_method`, `av_provider_ref`, `av_last_attested_at`; `av_sessions` holds refs/outcomes only — no document/image/DOB evidence columns exist). HTTP boots (temp-copy, stub provider + fake CCBill creds + fixed-address USDT) pin the enabled behavior end to end: a TX fan gets 403 `av_required` at BOTH purchase initiations (card = `transactional`, crypto = `id`) with no invoice created, verifies via `/api/av/start` + `/api/av/complete`, then buys on both rails; an NY fan is never gated; an unknown-state fan is gated until a purchase-time geo refresh places her (and the fresh state persists); a stored TX loses to a fresh NY geo; a model gets `forbidden`, never `av_required`; a re-login stamps the Tennessee re-attestation (`av_last_attested_at`). The dormant boot pins today's behavior exactly: no `AV_*` env → the same TX fan buys on both rails untouched and `/api/av/*` refuses (`av_not_configured`, webhook 401). Source pins: both purchase routes call the gate with their methods, and all four client purchase call sites handle `av_required` with the gate copy present in en/es/pt |
| `tests/payout-promise.test.js` | Published payout promise (owner quick win, Oct 16 2026): API tests against the real server (temp-copy boot) for `GET /payouts` — the public, plain-language summary of the shipped payout mechanics a recruit can read BEFORE signup. Pins the standard SEO-page head treatment (title/description/canonical, `rating: adult` + RTA meta, cache header); the 60/40 split (§4); the 7-day / one-week hold with its honest chargeback-fraud why and the available-vs-in-window balance (§13); human-reviewed manual payouts with §5's several-business-days / no-guaranteed-date honesty; the chargeback recovery ORDER asserted positionally (fan's unspent credits → model's unpaid earnings from that fan → automatic recovery from future earnings until repaid); the never-out-of-pocket sentence verbatim; fraud as the stated exception with forfeiture; the Agreement-governs line with the version rendered live from `MODEL_CONTRACT.version` (source-pinned, never hardcoded). Forbidden-copy pins are load-bearing: NO "Shield" claim and NO platform-absorbs-chargebacks promise may ever appear on the page. Wiring: dynamic sitemap lists `/payouts`, `/join` links "Read our payout promise", SPA root + `/api/models` unaffected |
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
ordering. (Ranking change, Oct 16 2026: the default sort is now the
composite "👑 Top ranked" and a pure "⭐ Most liked" sort is kept —
the discovery sorts test pins both deliberately.)

**Composite ranking + rank labels (`tests/ranking.test.js`)** — the
owner's rule: rank = 1 point per fan like + 1 point per $1.00 of
credited model earnings (lifetime, float, net of refunds). The suite
proves the formula against the real server with real tips from the
seeded fandemo (60/40 split): an earnings-only model ($6.00) outranks
a likes-only model (5 likes), a mixed model ties the likes-only one
at 5.00 and loses the directory tiebreak on like count, and an 89¢
earning moves the score by exactly 0.89 — no floor. Like → unlike
returns the score to the cent; an admin refund reverses the earnings
and the score with them; setting a model featured floats her to the
top of the payload while her `rank_position` stays her true composite
position (4th), so labels never follow array index. The backfill
case stops the server, seeds likes + ledger rows directly in SQLite
(a real tip, a `payout` row and an `is_test` row, plus a stale
rank_score of 999), reboots, and asserts the boot recompute heals it
to exactly 3 likes + $6.00 = 9.00 — payouts and test money excluded.
Client-side, extracted-function tests pin the default `Top ranked`
sort preserving composite order, `Most liked` ordering by like count
alone, `rankBadgeFor` labeling positions 1 and 10 but not 11, and
`discActive` (the badge/crown suppression gate) being false only in
the pure default view; source pins cover the badge markup, the
suppression wiring at both directory call sites, and the localized
peek rank line (EN/ES/PT).

**"New models you may like" rail (`tests/new-models.test.js`)** —
the owner's front-page spotlight: every model gets her first two
weeks in a rail at the top of both directory views. The windowing is
client-side over the payload's `created_at`, so the suite extracts
the real `modelCreatedMs` / `newModelsRail` from `app.js` and pins
the window edges against a fixed clock (13d23h in, exactly 14d out,
14d01h out; future-dated and undated accounts never count), the
top-10 cap with veteran models interleaved in rank (they never
consume slots), rank order beating recency, and the empty cases that
leave the section unrendered. Against the real server, the guest and
fan payloads feed the selection identically, a model who signs up
today appears, and at +15 days she is gone with no admin action.
Source pins cover the rail in both views, the hide-while-Discovery-
is-active rule (checked before selection, mirroring the 👑 crown),
silence when nobody qualifies, the shared `modelTileHTML` tiles with
their localized NEW badge, and the rail CSS.

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
| `tests/public-photo-announce.test.js` | One-time public-photo announcement (Oct 16 2026): a seeded boot DMs every seed model exactly once from the admin thread with her personal slutcamp.app/models/<username> URL + the Settings → My Photo → Public photo path + the logo-fallback warning, sets platform_stats.public_photo_announced_at, sends nothing to fans, and a second boot re-sends nothing. |
| `tests/affiliate-signup.test.js` | Self-serve affiliate signup (owner request, Oct 16 2026 — the entry screen's third role card): POST /api/affiliate/signup creates a recruiter with NO invite code through the same createRecruiterAccount helper as the Manager invite signup — agreement auto-signed at the current version (R1.3), 18+ attestation recorded with dob NULL (never a fake DOB), recruiters row with an 8-hex partner code; a model signing up with that referral_code is attributed to her (dashboard model_count + models.recruiter_id); unified login reaches the recruiter-only endpoints while a fan gets 403; validations mirror the invite flow (duplicate username 409 username_taken, missing agreement 400 must_agree, short password/missing fields 400 missing_fields); regression: an invite_links row (role 'recruiter') still validates, signs up, provisions a code and is marked used. Source pins: #r-aff role card + renderSignupFields/doAffiliateSignup in app.js, honest affiliate pitch keys in en/es/pt, both server routes calling the shared helper |
| `tests/affiliate-terms.test.js` | Affiliate terms amendment — first-year quota (owner directive, Oct 16 2026, restated twice): source pins that the Recruiter Agreement carries a new §10 "First-Year Quota — 10 Models in Your First Year" (ONE YEAR from signup/acceptance to onboard a minimum of 10 models, counted only when a model joins through the affiliate's link and holds a model account; at the one-year mark the Company reviews and may revoke if deemed necessary; if her models made the Company a significant amount of money the status is extended until the quota is met; the mark alone never auto-ends status; §5 is expressly preserved) placed after §9 Governing Law with the disclaimer renumbered to §11 (exactly 11 sections), §5's at-will revocation language pinned verbatim and unweakened, and the version bump R1.2 → R1.3 that forces re-sign; the plain-language signup notice `aff_quota_notice` defined in en/es/pt and rendered at the acceptance point of BOTH affiliate signup forms, with the quota entry added to the shared AFFILIATE_AGREEMENT_SECTIONS summary; plus a temp-copy boot asserting the served contract is R1.3, auto-signed at R1.3 for a new self-serve affiliate, with the quota section served at position 10. TEXT ONLY by design — no automated quota enforcement exists to test |
| `tests/notif-fix-announce.test.js` | One-time notification-fix announcement (Oct 17 2026; owner's standing rule — every update gets a message to the girls): a seeded boot DMs every seed model exactly once from the admin thread explaining that bells now open their screen (messages/bookings/tips/FaceTime routing), sets platform_stats.notif_fix_announced_at, sends nothing to fans, and a second boot re-sends nothing. |
| `tests/preview-video-profile.test.js` | Preview video on her profile (owner request, Oct 17 2026): static source pins on `openModelPeek` — the app's one shared profile peek — that `preview_video_url` renders a hero `<video autoplay muted loop playsinline>` with an i18n sound pill (`tap_for_sound`/`tap_to_mute` in en/es/pt), the hero is a ternary that renders nothing when unset (peek unchanged without a video), the tap toggle unmutes + restarts from 0 and re-mutes on second tap (video and pill both wired), hero CSS (`.peek-hero-video` cover + `.peek-sound-pill`) exists, the Settings preview block no longer says "Keep it SFW" and states the app-only explicit-allowed guidance (tile + profile, never on Google/public page, everything after stays paid, under 15MB) with upload/remove buttons untouched, and the home tile muted loop is unchanged. |
| `tests/preview-video-announce.test.js` | One-time preview-video announcement (Oct 17 2026; owner's standing rule — every update gets a message to the girls): a seeded boot DMs every seed model exactly once from the admin thread announcing that her preview video now plays on her profile (tap = sound, as-wild-as-you-like hook, Settings → Preview video path), sets platform_stats.preview_video_announced_at, sends nothing to fans, and a second boot re-sends nothing. |
| `tests/notification-routing.test.js` | Notification tap routing (owner bug report, Oct 17 2026 — tapping a bell "glitched" and opened nothing): logic tests running the REAL `routeNotifTap` extracted from `app.js` in a vm (FaceTime bells with a still-live request open `showFtRequestCard`, stale ones fall to chats; `/#bookings` → bookings; `/#live` → fan `fanLive` / model `lives`; `/live/<id>` stage requests rejoin the model's own broadcast via `rejoinLiveBroadcast`, degrading to `modelChats` when it is unavailable; `tip` bells (link null) → model `modelEarnings` / fan chats; `''`/`/#chat`/announcement/unknown links → the role's chats list, other roles → `fanChats`) plus source pins: the `[data-notif]` tap handler contains NO `show('notifications')` fallthrough (the old re-render glitch), routes via the `notifs.find(...)` lookup + `routeNotifTap(n, ftById)`, the no-navigation fallback settles the row in place (`.unread` class + `.unread-dot` removal, no re-render), markRead is unchanged (POST ids + badge refresh), and the protected neighbours (Mark-all-read, FaceTime Accept/Decline/open) keep exactly their three list re-renders |
| `tests/notification-thread-tap.test.js` | One-tap straight to the message (owner ruling, Oct 17 2026 — refinement of the tap fix above): logic tests running the REAL `routeNotifTap` + `openNotifThread` extracted from `app.js` in a vm against a stubbed `/conversations` fetch (`/#chat/<id>` opens exactly that conversation; unknown id or failed fetch falls back to the role's chats list; legacy `''` bells of the admin-DM family — message/welcome/guide/guide_video/home_screen_video/id_verify/affiliate_program/game_category/agreement_12/public_photo/notif_fix/preview_video — open the admin thread found by `other.role === 'admin`, never by list position; no admin thread or failed fetch → chats list; `''` + unknown type and bare `/#chat` never fetch and stay on the chats list) plus source pins: all 13 server admin-DM `notifyUser` sites (5 broadcasts, 6 welcome-flow senders, apology DM, Manager admin→model route) carry `` `/#chat/${conv.id}` `` — exact global count 13, non-DM bells untouched — and the client's `/#chat/` rule is the first link rule, before the generic chats-list fallback, delegating through the typeof-guarded helper so the PR #31 suite keeps passing |
