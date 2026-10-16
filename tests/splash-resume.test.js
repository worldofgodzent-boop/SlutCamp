'use strict';
/*
 * Welcome splash on EVERY open (2026-10-16) — source pins.
 *
 * The boot splash (vWelcomeSplash in boot mode) already renders on
 * every fresh page load; the owner still opened the app once and saw
 * NO lips. Two root causes, both pinned here:
 *
 * (a) iOS installed-PWA resume: reopening restores the frozen WebView
 *     WITHOUT a page load, so boot() never re-runs. Fix: after >= 60s
 *     hidden, a visibility/pageshow return re-shows the splash as an
 *     OVERLAY (vWelcomeSplash overlay mode) that removes ONLY itself —
 *     no routing, no app wipe — and only when the boot splash already
 *     completed, no splash is up, and the user is not busy (the exact
 *     updateBusy() idle test: live / call / sheets / typing / voice).
 *
 * (b) The 916KB animated WebP might not be downloaded when the splash
 *     renders. Fix: <link rel="preload"> in index.html + an early
 *     Image() preload at the very top of boot(), and a one-shot
 *     onerror fallback on the badge to the static lips (never an
 *     empty circle).
 *
 * The welcome-VOICE pins live in tests/logo-anim.test.js and are not
 * weakened by any of this: the resume path reuses vWelcomeSplash, so
 * the greeting, the Enter replay and the 6s auto-enter are the same
 * code — these tests additionally pin that the resume path adds no
 * second Audio construction and no extra playGreeting() call sites.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

const app = read('public/js/app.js');
const html = read('public/index.html');

function sliceFn(name, nextMarker) {
  const start = app.indexOf(`function ${name}`);
  assert.ok(start !== -1, `${name} not found in app.js`);
  const end = app.indexOf(nextMarker, start);
  assert.ok(end !== -1, `end of ${name} not found`);
  return app.slice(start, end);
}

test('preload: index.html preloads the animated lips in <head>', () => {
  assert.match(html, /<link rel="preload" as="image" type="image\/webp" href="\/img\/logo-lips-anim\.webp">/);
  const head = html.slice(0, html.indexOf('</head>'));
  assert.ok(head.includes('logo-lips-anim.webp'), 'preload link must be inside <head>');
});

test('preload: boot() kicks off an early Image preload before any await', () => {
  const bootStart = app.indexOf('(async function boot()');
  assert.ok(bootStart !== -1, 'boot() not found');
  const boot = app.slice(bootStart, app.indexOf('async function routeInitial', bootStart));
  assert.match(boot, /const pre = new Image\(\); pre\.src = '\/img\/logo-lips-anim\.webp';/);
  assert.ok(
    boot.indexOf('new Image()') < boot.indexOf('await checkAgeGate()'),
    'the preload must be kicked off before the age-gate await, not after');
});

test('badge fallback: one-shot onerror swaps to the static lips, never loops', () => {
  assert.match(app, /onerror="this\.onerror=null;this\.src='\/img\/lips-logo\.png'"/,
    'onerror=null first makes the fallback exactly-once');
  const splash = sliceFn('vWelcomeSplash', 'TERMS OF SERVICE');
  const badge = splash.split('\n').find((l) => l.includes('logo-lips-anim.webp'));
  assert.ok(badge && badge.includes('onerror='), 'the fallback is on the badge img itself');
});

test('resume splash: threshold, state flags and setup exist', () => {
  assert.match(app, /const RESUME_SPLASH_HIDDEN_MS = 60000;/, 're-show only after >= 60s hidden');
  assert.match(app, /let bootSplashDone = false;/);
  assert.match(app, /let resumeSplashOpen = false;/);
  assert.match(app, /function setupResumeSplash\(\)/);
  assert.match(app, /setupResumeSplash\(\);/, 'boot wires the resume listeners');
  assert.match(app, /vWelcomeSplash\(\(\) => \{ bootSplashDone = true; routeInitial\(\); \}\);/,
    'the boot-completed flag is set exactly when the boot splash hands off');
});

test('resume splash: visibilitychange and persisted pageshow both feed the same gate', () => {
  const setup = sliceFn('setupResumeSplash', 'function maybeShowResumeSplash');
  assert.match(setup, /document\.addEventListener\('visibilitychange', \(\) => \{/);
  assert.match(setup, /if \(document\.hidden\) \{ appHiddenAt = Date\.now\(\); return; \}/);
  assert.match(setup, /window\.addEventListener\('pageshow', \(e\) => \{/);
  assert.match(setup, /if \(!e\.persisted\) return;/, 'only bfcache restores count as a resume');
  assert.match(setup, /window\.addEventListener\('pagehide', \(\) => \{ appHiddenAt = Date\.now\(\); \}\);/);
  const shows = setup.match(/if \(awayMs >= RESUME_SPLASH_HIDDEN_MS\) maybeShowResumeSplash\(\);/g) || [];
  assert.equal(shows.length, 2, 'both resume paths apply the >= 60s threshold, then the shared gate');
});

test('resume splash: guards — boot done, no stacking, and the updateBusy idle test', () => {
  const gate = sliceFn('maybeShowResumeSplash', '/* Welcome splash');
  assert.match(gate, /if \(!bootSplashDone \|\| resumeSplashOpen\) return;/,
    'never before the boot splash completed, never stacked');
  assert.match(gate, /if \(document\.getElementById\('splash-enter'\)\) return;/,
    'never while any splash is already visible');
  assert.match(gate, /if \(updateBusy\(\)\) return;/,
    'busy (live/call/sheet/typing/voice) = skip entirely, reusing the update watcher idle test');
  assert.match(gate, /resumeSplashOpen = true;/);
  assert.match(gate, /vWelcomeSplash\(\(\) => \{ resumeSplashOpen = false; \}, \{ overlay: true \}\);/,
    'the overlay callback only clears the flag — it shows nothing else');
});

test('resume splash: the resume path never routes or wipes the app', () => {
  const gate = sliceFn('maybeShowResumeSplash', '/* Welcome splash');
  assert.doesNotMatch(gate, /routeInitial/, 'resume must NOT re-route the user');
  assert.doesNotMatch(gate, /innerHTML/, 'resume must NOT touch the app DOM');
  const setup = sliceFn('setupResumeSplash', 'function maybeShowResumeSplash');
  assert.doesNotMatch(setup, /routeInitial|location\.reload/);
});

test('overlay mode: host element on body, removed by enter(); boot-only pieces stay boot-only', () => {
  const splash = sliceFn('vWelcomeSplash', 'TERMS OF SERVICE');
  assert.match(splash, /function vWelcomeSplash\(onDone, opts\)/);
  assert.match(splash, /const overlayMode = !!\(opts && opts\.overlay\);/);
  assert.match(splash, /host = document\.createElement\('div'\);/);
  assert.match(splash, /document\.body\.appendChild\(host\);/);
  assert.match(splash, /if \(host\) \{ host\.remove\(\); host = null; \}/,
    'Enter / auto-enter removes ONLY the overlay host');
  assert.match(splash, /if \(overlayMode\) \{\n    host = document\.createElement\('div'\);/,
    'the host branch is the overlay branch');
  // Language hook + tabbar wipe happen only in boot mode.
  assert.match(splash, /if \(!overlayMode\) \{\n    splashLangRefresh = \(\) => \{/);
  assert.match(splash, /app\.innerHTML = splashMarkup;/, 'boot mode still renders into #app');
});

test('voice: the resume path adds no second greeting machinery', () => {
  const audios = app.match(/new Audio\('\/audio\/welcome\.mp3'\)/g) || [];
  assert.equal(audios.length, 1, 'exactly one welcome Audio construction in the whole app');
  const calls = app.match(/playGreeting\(\);/g) || [];
  assert.equal(calls.length, 2, 'still exactly render + Enter-tap playGreeting() call sites');
  assert.match(app, /setTimeout\(\(\) => \{ if \(document\.getElementById\('splash-enter'\)\) enter\(\); \}, 6000\);/,
    'the unconditional 6s auto-enter still drives the overlay too');
});
