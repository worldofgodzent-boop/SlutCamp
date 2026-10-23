'use strict';
/*
 * Forced refresh on every deploy (2026-10-16) — the client half.
 *
 * Asce's rule: every update must reach every phone automatically, even
 * a logged-in app just sitting open — users are lazy and will not
 * refresh. The server half (per-deploy service-worker cache name +
 * GET /api/build-id) is pinned in tests/sw.test.js; this file pins the
 * app half in public/js/app.js:
 *   - a watcher polls /api/build-id every 60s against the build the
 *     page loaded under,
 *   - a service-worker controllerchange funnels into the same path,
 *   - the reload fires ONLY when the app is idle — never mid-call,
 *     mid-live, mid-purchase/sheet, or mid-typing — and while busy it
 *     is retried every 30s until the first quiet moment,
 *   - the watcher is actually started from boot().
 *
 * Plus one functional check of the stamping mechanism itself: applying
 * the server's exact split/join to the shipped sw.js must produce a
 * per-deploy cache name (and the 'v4' fallback) with no token left.
 *
 * DOM behavior (the actual reload on a real phone) cannot run under
 * node:test — that limit is documented in TESTING.md.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

const app = read('public/js/app.js');
const server = read('server.js');
const sw = read('public/sw.js');

test('server exposes the deployed build at GET /api/build-id', () => {
  assert.match(server, /app\.get\('\/api\/build-id'/);
  assert.match(server, /res\.json\(\{ build: BUILD_ID, cache: SW_CACHE_NAME, time: BUILD_TIME, upload_origin: UPLOAD_ORIGIN \}\)/);
});

test('build id resolution is boot-guarded (a failure can never break boot)', () => {
  assert.match(server, /function resolveBuildId\(\)/);
  // The top-level call is wrapped — resolveBuildId throwing must not
  // take the process down before listen().
  assert.match(server, /try \{ BUILD_ID = resolveBuildId\(\); \} catch \(e\) \{ BUILD_ID = null; \}/);
});

test('app polls /api/build-id every 60s and compares against its load build', () => {
  assert.match(app, /function startUpdateWatcher\(\)/);
  assert.match(app, /fetch\('\/api\/build-id', \{ cache: 'no-store' \}\)/);
  assert.match(app, /setInterval\(check, 60000\)/);
  assert.match(app, /if \(d\.build !== baseline\) \{ _updatePending = true; tryApplyUpdate\(\); \}/);
});

test('service-worker controllerchange funnels into the same update path', () => {
  assert.match(app, /addEventListener\('controllerchange'/);
  assert.match(app, /_updatePending = true;\s*\n\s*tryApplyUpdate\(\);/);
});

test('reload happens only when idle — live, call, sheet/purchase and typing all block it', () => {
  assert.match(app, /function updateBusy\(\)/);
  // Broadcasting / watching a live.
  assert.match(app, /classList\.contains\('in-live'\)/);
  // 1-on-1 call overlays — the same signals the pop-up engine checks.
  assert.match(app, /\['call-overlay', 'active-call', 'call-error'\]/);
  // Purchase/sheet flows (PPV price, tip/gift/video call/booking, paywall).
  assert.match(app, /classList\.contains\('sheet-open'\)/);
  assert.match(app, /#ppv-price-overlay, #voice-ov, #tip-ov, #paywall, \.sheet-backdrop/);
  // Typing must never be eaten.
  assert.match(app, /document\.activeElement/);
  assert.match(app, /a\.tagName === 'TEXTAREA'/);
  // While busy, the reload is deferred and retried every 30s.
  assert.match(app, /function tryApplyUpdate\(\)/);
  assert.match(app, /if \(updateBusy\(\)\) return;/);
  assert.match(app, /setInterval\(tryApplyUpdate, 30000\)/);
  assert.match(app, /location\.reload\(\)/);
});

test('login survives the forced reload (session token lives in localStorage)', () => {
  // The watcher block must say so, so nobody "fixes" it away later:
  // a reload does not clear localStorage, so 'wc_token' (and with it
  // the fan/model session) carries straight through.
  assert.match(app, /localStorage \('wc_token'\), which a page reload does not clear/);
});

test('boot() actually starts the watcher', () => {
  assert.match(app, /startPresenceHeartbeat\(\);\s*\n\s*startUpdateWatcher\(\);/);
});

test('stamping mechanism: server split/join yields a per-deploy cache name', () => {
  // A normal stamped worker (build id known).
  const stamped = sw.split('__BUILD__').join('abcdef123456');
  assert.ok(!stamped.includes('__BUILD__'), 'token left behind after stamping');
  assert.match(stamped, /const CACHE = 'slutcamp-abcdef123456';/);
  // The no-build-id fallback reproduces the old static v4 worker name.
  const fallback = sw.split('__BUILD__').join('v4');
  assert.match(fallback, /const CACHE = 'slutcamp-v4';/);
});
