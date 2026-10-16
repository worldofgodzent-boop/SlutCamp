'use strict';
/*
 * Unit tests for the Halloween pop-up girls (public/js/theme.js).
 *
 * The picker's pure logic (shuffle-bag + pose alternation) and the
 * schedule constants are exported for Node, so they are testable with
 * a seeded RNG — no DOM. The file-level tests pin the wiring both
 * ways: every roster combo must have its WebP on disk, and every WebP
 * in public/img/popups must be in the roster, so art can never ship
 * half-added. The browser glue (timers, DOM) is covered by source
 * assertions, consistent with the theme tests: the halloween + login
 * gating and the pointer-events hard rule must be present in the
 * engine, and the non-interactive CSS must be in the pack.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const theme = require('../public/js/theme.js');
const {
  POPUP_MODELS, POPUP_POSES, POPUP_SCHEDULE,
  popupCombos, popupImagePath, nextPopupInterval, createPopupPicker,
} = theme;

const REPO = path.join(__dirname, '..');
const POPUP_DIR = path.join(REPO, 'public', 'img', 'popups');

/* Small deterministic RNG (mulberry32) for picker tests. */
function seeded(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('roster is the six hair colors × kiss/twerk', () => {
  assert.deepEqual(POPUP_MODELS, ['pink', 'purple', 'blonde', 'red', 'black', 'silver']);
  assert.deepEqual(POPUP_POSES, ['kiss', 'twerk']);
  assert.equal(popupCombos().length, 12);
});

test('every roster combo has a WebP on disk, and vice versa', () => {
  const expected = popupCombos()
    .map((c) => path.basename(popupImagePath(c)))
    .sort();
  const onDisk = fs.readdirSync(POPUP_DIR).filter((f) => f.endsWith('.webp')).sort();
  assert.deepEqual(onDisk, expected);
  for (const name of expected) {
    const file = path.join(POPUP_DIR, name);
    assert.ok(fs.statSync(file).size > 0, `${name} must not be empty`);
  }
});

test('image paths follow /img/popups/<model>-<pose>.webp', () => {
  assert.equal(popupImagePath({ model: 'pink', pose: 'kiss' }), '/img/popups/pink-kiss.webp');
  assert.equal(popupImagePath({ model: 'silver', pose: 'twerk' }), '/img/popups/silver-twerk.webp');
});

test('schedule: first pop at 20s, ~6s on screen, 3.5–5 min apart', () => {
  assert.equal(POPUP_SCHEDULE.firstDelayMs, 20000);
  assert.equal(POPUP_SCHEDULE.showMs, 6000);
  assert.equal(POPUP_SCHEDULE.intervalMinMs, 3.5 * 60 * 1000);
  assert.equal(POPUP_SCHEDULE.intervalMaxMs, 5 * 60 * 1000);
});

test('nextPopupInterval stays inside the 3.5–5 minute bounds', () => {
  assert.equal(nextPopupInterval(() => 0), POPUP_SCHEDULE.intervalMinMs);
  const nearTop = nextPopupInterval(() => 0.999999);
  assert.ok(nearTop >= POPUP_SCHEDULE.intervalMinMs && nearTop <= POPUP_SCHEDULE.intervalMaxMs);
  const rand = seeded(42);
  for (let i = 0; i < 1000; i++) {
    const v = nextPopupInterval(rand);
    assert.ok(v >= POPUP_SCHEDULE.intervalMinMs && v <= POPUP_SCHEDULE.intervalMaxMs,
      `interval ${v} out of bounds`);
  }
});

test('picker deals every combo once before the bag refills', () => {
  const picker = createPopupPicker(seeded(7));
  const key = (c) => `${c.model}-${c.pose}`;
  const all = new Set(popupCombos().map(key));
  for (let round = 0; round < 3; round++) {
    const seen = new Set();
    for (let i = 0; i < 12; i++) seen.add(key(picker.next()));
    assert.deepEqual(seen, all, `round ${round} must deal all 12 combos exactly once`);
  }
});

test('picker never plays the same pose twice in a row', () => {
  const picker = createPopupPicker(seeded(1234));
  let prev = null;
  for (let i = 0; i < 500; i++) {
    const c = picker.next();
    assert.notEqual(c.pose, prev, `pose ${c.pose} repeated at draw ${i}`);
    prev = c.pose;
  }
});

test('engine gates pop-ups on halloween + wc_token and never intercepts clicks', () => {
  const src = fs.readFileSync(path.join(REPO, 'public', 'js', 'theme.js'), 'utf8');
  assert.ok(src.includes("themeName !== 'halloween'"),
    'pop-ups must only start when the resolved theme is halloween');
  assert.ok(src.includes("'wc_token'"), 'pop-ups must check the login token');
  assert.ok(src.includes("pointerEvents = 'none'"),
    'the pop-up container must get inline pointer-events:none');
  assert.ok(src.includes('in-live') && src.includes('call-overlay'),
    'pop-ups must skip while the user is in a call or live room');
  assert.ok(src.includes('prefers-reduced-motion'),
    'pop-ups must respect prefers-reduced-motion');
});

test('halloween pack CSS makes pop-ups strictly non-interactive', () => {
  const css = fs.readFileSync(path.join(REPO, 'public', 'css', 'themes', 'halloween.css'), 'utf8');
  assert.ok(css.includes('.sc-popup'), 'pack must style .sc-popup');
  assert.ok(css.includes('pointer-events: none !important'),
    'pack must enforce pointer-events: none !important');
  for (const kf of ['sc-pop-in', 'sc-pop-out', 'sc-popup-twerk', 'sc-popup-jiggle', 'sc-popup-float']) {
    assert.ok(css.includes(`@keyframes ${kf}`), `pack must define @keyframes ${kf}`);
  }
});
