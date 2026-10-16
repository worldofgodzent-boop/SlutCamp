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
| `tests/presence.test.js` | Unit tests for `lib/presence.js` counts/sampling (in-memory DB) |
| `tests/smoke.test.js` | Integration smoke test: boots the real `server.js` in a throwaway temp copy and checks key flows over HTTP |
| `tests/passkey.test.js` | Face ID (WebAuthn) for everyone + enforced admin step-up: public enrollment/sign-in round trips with a built-in software authenticator, owner-scoped credential management, rate limiting, bootstrap + `passkey_required` enforcement on `/api/admin/*` and `/api/mod/*`, and the fan→Manager isolation regressions |
| `tests/theme.test.js` | Unit tests for the seasonal theme engine (`public/js/theme.js`): every holiday window boundary, the computed Easter/Thanksgiving dates, override semantics, and THEMES-metadata ↔ CSS-pack sync |
| `tests/popups.test.js` | Unit tests for the Halloween pop-up girls (`public/js/theme.js`): roster ↔ pop-up art sync in both directions, the shuffle-bag picker (full 12-combo rotation before repeats, kiss/twerk never back-to-back), schedule bounds (60s first pop, ~6s on screen, 3.5–5 min gaps), and source assertions for the halloween + login gating and the `pointer-events: none` hard rule in the engine and pack CSS |
| `tests/header.test.js` | Source assertions for the header dead-space fix: compacted base header paddings in styles.css, the `:has()` rule that stops the header paying the safe-area inset twice under the theme banner, and the Halloween-only gating + styling of the theme.js promo strip |
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
