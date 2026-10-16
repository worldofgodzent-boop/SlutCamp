'use strict';
/*
 * Animated lips logo IN the welcome splash badge (2026-10-16, revised) —
 * source-assertion tests. The owner's clarified spec, with screenshot:
 * on the welcome splash (vWelcomeSplash), the STATIC lips logo that sits
 * in the ~108px circular badge above the SLUTCAMP wordmark is REPLACED
 * by the animated lips (lick, bite, kiss, pop/vanish, then loop) — same
 * badge, same position/size/glow, nothing else on the splash changes.
 * (The first build shipped a center-screen overlay instead; that whole
 * implementation — showLogoAnimOnce / #logoAnimOverlay — is REMOVED and
 * these tests pin that it stays removed.)
 *
 * The animated asset is a WebP: it carries NO audio, so the only sound
 * at the welcome moment remains the welcome voice — and the voice path
 * is pinned byte-for-byte below, per the owner's rule (2026-10-16):
 * "don't remove the voice in the background of the app, the whole
 * welcome thing that you hear".
 *
 * Scope note on lips-logo.png: the static file is still legitimately
 * used elsewhere (a blurred full-screen watermark INSIDE the splash —
 * unchanged, it is backdrop, not the badge — plus small lips marks on
 * other screens). These tests pin only the splash BADGE usage; they do
 * not demand the file vanish from the app.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

const app = read('public/js/app.js');
const css = read('public/css/styles.css');
const manager = read('public/manager/manager.js');

// Slice out the vWelcomeSplash function for splash-scoped assertions.
function splashBody() {
  const start = app.indexOf('function vWelcomeSplash');
  assert.ok(start !== -1, 'vWelcomeSplash not found in app.js');
  const end = app.indexOf('TERMS OF SERVICE', start);
  assert.ok(end !== -1, 'end of vWelcomeSplash not found');
  return app.slice(start, end);
}

test('splash badge: the circular 108px logo IS the animated lips', () => {
  const splash = splashBody();
  // The badge <img> (alt="SlutCamp", 108px, round, glow) now points at
  // the animated WebP, keeping its exact inline styling from before.
  assert.match(splash, /<img src="\/img\/logo-lips-anim\.webp" alt="SlutCamp" style="display:block;margin:0 auto 14px;width:108px;height:108px;border-radius:50%;object-fit:cover;border:2px solid rgba\(255,92,158,\.65\);box-shadow:0 0 28px rgba\(255,45,120,\.55\),0 0 64px rgba\(184,41,221,\.35\)">/);
});

test('splash badge: static lips-logo.png is gone from the badge', () => {
  const splash = splashBody();
  assert.doesNotMatch(splash, /<img src="\/img\/lips-logo\.png" alt="SlutCamp"/);
  // Inside the splash, lips-logo.png survives ONLY as the blurred,
  // aria-hidden full-screen watermark backdrop (unchanged by design).
  const refs = splash.match(/lips-logo\.png/g) || [];
  assert.equal(refs.length, 1, 'only the watermark may still reference lips-logo.png in the splash');
  const wm = splash.split('\n').find((l) => l.includes('lips-logo.png'));
  assert.match(wm, /aria-hidden="true"/);
  assert.match(wm, /blur\(3px\)/);
});

test('overlay fully removed: no remnants in app.js or styles.css', () => {
  assert.doesNotMatch(app, /showLogoAnimOnce|logoAnimOverlay|logoAnimShown/);
  assert.doesNotMatch(css, /logo-anim-overlay|logoAnimOverlay/);
  assert.doesNotMatch(app, /logoAnimOverlay/);
});

test('WELCOME VOICE UNTOUCHED: audio construction + volume pinned', () => {
  const audioLines = app.match(/new Audio\('\/audio\/welcome\.mp3'\)/g) || [];
  assert.equal(audioLines.length, 1, 'exactly one welcome Audio construction');
  assert.match(app, /if \(!audio\) \{ audio = new Audio\('\/audio\/welcome\.mp3'\); audio\.volume = 0\.9; \}/);
});

test('WELCOME VOICE UNTOUCHED: both playGreeting call sites + definition pinned', () => {
  const defs = app.match(/const playGreeting = \(\) =>/g) || [];
  assert.equal(defs.length, 1);
  const calls = app.match(/playGreeting\(\);/g) || [];
  assert.equal(calls.length, 2, 'greeting plays on splash render AND retries on the Enter tap');
});

test('WELCOME VOICE UNTOUCHED: unconditional 6s auto-enter pinned', () => {
  assert.match(app, /setTimeout\(\(\) => \{ if \(document\.getElementById\('splash-enter'\)\) enter\(\); \}, 6000\);/);
});

test('asset ships in-repo as a real animated WebP, looping forever, within budget', () => {
  const p = path.join(REPO, 'public/img/logo-lips-anim.webp');
  assert.ok(fs.existsSync(p), 'public/img/logo-lips-anim.webp missing');
  const buf = fs.readFileSync(p);
  assert.ok(buf.length > 100 * 1024, 'asset suspiciously small — is it the real animation?');
  assert.ok(buf.length <= 1600 * 1024, `asset over budget: ${buf.length} bytes`);
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buf.toString('ascii', 8, 12), 'WEBP');
  const animAt = buf.indexOf(Buffer.from('ANIM'));
  assert.ok(animAt !== -1, 'ANIM chunk missing — not an animated WebP');
  // ANIM payload: 4B background color + 2B loop count. 0 = loop forever:
  // the splash sits until Enter, so after the vanish she pops back in.
  const loopCount = buf.readUInt16LE(animAt + 4 + 4 + 4);
  assert.equal(loopCount, 0, 'splash asset must loop infinitely (ANIM loop count 0)');
});

test('public app only: Manager does not reference the logo animation', () => {
  assert.doesNotMatch(manager, /logo-lips-anim/);
});
