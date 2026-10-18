'use strict';
/*
 * Live self-view mirroring + broadcaster rotation lock (owner,
 * 2026-10-18, from his own broadcast: "The camera is inverted — I
 * raise my left hand, but I see it in the right side of the screen"
 * and "Let them be able to lock screen from rotating").
 *
 * Both fixes are client display/wiring only, so these are source pins
 * in the header.test.js style — they keep the contract from rotting:
 *   - SELF views are mirrored (#local-video in calls, #live-local for
 *     the broadcaster solo + split, #fan-selfview for a fan on stage):
 *     mainstream apps mirror your own camera; the WebRTC track itself
 *     is never transformed, so everyone else sees her naturally.
 *   - OTHER people are NEVER mirrored: #remote-video (call partner),
 *     #live-remote (the model on fans' screens), #stage-video (the
 *     stage guest on the broadcaster's screen) carry no mirror.
 *   - The rotation-lock toggle lives ONLY in the broadcaster's
 *     controls, drives screen.orientation.lock/unlock, releases on
 *     live end, and degrades to an honest toast where the API does
 *     not exist (iOS Safari) — never a dead button.
 *   - The three new labels exist in all 13 client languages.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

const styles = read('public/css/styles.css');
const appSrc = read('public/js/app.js');

const cssRule = (re) => {
  const m = styles.match(re);
  assert.ok(m, `CSS rule not found: ${re}`);
  return m[0];
};

test('call self-view (#local-video) is mirrored; the remote partner is not', () => {
  const local = cssRule(/#local-video\s*\{[^}]*\}/);
  assert.match(local, /transform:\s*scaleX\(-1\)/);
  const remote = cssRule(/#remote-video\s*\{[^}]*\}/);
  assert.doesNotMatch(remote, /transform|scaleX/);
});

test('shared .mirror-self class exists and the live self-views carry it', () => {
  assert.match(styles, /\.mirror-self\s*\{\s*transform:\s*scaleX\(-1\);\s*\}/);
  // Broadcaster's own feed (solo + split pane — one element) in the
  // live broadcast view markup.
  assert.match(appSrc, /<video id="live-local" class="mirror-self" autoplay playsinline muted><\/video>/);
  // A fan on stage sees his own camera in the PiP — a self view too.
  assert.match(appSrc, /<video id="fan-selfview" autoplay playsinline muted class="mirror-self hidden"><\/video>/);
});

test('other people are never mirrored (fan live view + stage guest)', () => {
  // The combined sizing rule must not smuggle a transform onto either.
  const liveRule = cssRule(/#live-local, #live-remote\s*\{[^}]*\}/);
  assert.doesNotMatch(liveRule, /transform|scaleX/);
  // The model on a fan's screen appears natural.
  assert.match(appSrc, /<video id="live-remote" autoplay playsinline muted><\/video>/);
  // The stage guest on the broadcaster's screen appears natural.
  assert.match(appSrc, /<video id="stage-video" autoplay playsinline muted class="hidden"><\/video>/);
  const stageRule = cssRule(/#stage-video\s*\{[^}]*\}/);
  assert.doesNotMatch(stageRule, /transform:\s*scaleX/);
});

test('rotation lock toggle is in the broadcaster controls only', () => {
  assert.match(appSrc, /<button class="btn small ghost" id="live-rotlock-btn" style="flex:1">\$\{t\('lock_rotation'\)\}<\/button>/);
  assert.match(appSrc, /rotBtn\.onclick = toggleRotationLock;/);
  // The fan watch view must not grow a lock button or lock calls of
  // its own (slice: vLiveWatch up to the shared live teardown).
  const fanView = appSrc.slice(appSrc.indexOf('function vLiveWatch()'), appSrc.indexOf('function endLiveView('));
  assert.ok(fanView.length > 0);
  assert.doesNotMatch(fanView, /rotlock|RotationLock/);
});

test('rotation lock drives the Orientation API with honest degradation', () => {
  assert.match(appSrc, /screen\.orientation\.lock\(/);
  assert.match(appSrc, /screen\.orientation\.unlock\(\)/);
  assert.match(appSrc, /requestFullscreen/);
  // Fullscreen is only taken on phone-like viewports (the 480px app
  // column must not be stretched across a desktop monitor).
  assert.match(appSrc, /matchMedia\('\(max-width: 640px\)'\)/);
  // Unsupported (iOS Safari has no orientation.lock) and rejected
  // locks both land on the localized Control-Center toast — the two
  // call sites are the support check and the catch path.
  const toasts = appSrc.match(/toast\(t\('rotation_lock_unsupported'\), 4500\)/g) || [];
  assert.equal(toasts.length, 2);
  assert.match(appSrc, /function rotLockSupported\(\)/);
});

test('rotation lock releases on live end and tracks manual fullscreen exit', () => {
  const end = appSrc.slice(appSrc.indexOf('function endLiveView(msg) {'), appSrc.indexOf('function endLiveView(msg) {') + 400);
  assert.match(end, /releaseRotationLock\(\);/);
  assert.match(appSrc, /addEventListener\('fullscreenchange'/);
});

test('rotation lock labels exist in all 13 languages', () => {
  for (const key of ['lock_rotation', 'rotation_locked', 'rotation_lock_unsupported']) {
    const hits = appSrc.match(new RegExp(`^    ${key}:`, 'gm')) || [];
    assert.equal(hits.length, 13, `${key} must appear once per language (got ${hits.length})`);
  }
});
