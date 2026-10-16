'use strict';
/*
 * Header dead-space fix (2026-10-16) — source-assertion tests.
 *
 * The fix is CSS + one theme-engine injection, so there is no runtime
 * behavior to boot here; these tests pin the wiring so the fix can't
 * silently rot:
 *   - styles.css must keep the compacted header paddings and the
 *     :has() rule that stops the sticky header from paying the
 *     safe-area inset twice while the seasonal banner is up.
 *   - theme.js must keep the promo strip gated to Halloween ONLY.
 *   - theme-base.css must carry the promo strip's structural styles and
 *     halloween.css its skin, so the injected element never renders
 *     unstyled (or leaks into other seasons).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

const styles = read('public/css/styles.css');
const themeBase = read('public/css/themes/theme-base.css');
const halloween = read('public/css/themes/halloween.css');
const themeJs = read('public/js/theme.js');
const { THEMES } = require('../public/js/theme.js');

test('base header is compacted (10px pads, tighter pill + logout row)', () => {
  assert.match(styles, /\.header\s*\{[^}]*padding:\s*calc\(10px \+ env\(safe-area-inset-top\)\) 16px 10px/);
  assert.match(styles, /\.balance-pill\s*\{[^}]*padding:\s*7px 14px;[^}]*margin-top:\s*6px/);
  assert.match(styles, /\.home-logout-btn\s*\{\s*min-height:\s*36px/);
});

test('header does not pay the safe-area inset twice under the theme banner', () => {
  assert.match(styles, /#phone:has\(> \.sc-theme-banner\) \.header\s*\{\s*padding-top:\s*10px;/);
});

test('promo injection exists and is gated to halloween only', () => {
  assert.match(themeJs, /function renderPromo\(name, meta\)/);
  assert.match(themeJs, /if \(name !== 'halloween' \|\| !meta\.promo\) return;/);
  assert.match(themeJs, /renderPromo\(name, meta\);/);
  // Only the halloween pack carries a promo line.
  assert.equal(typeof THEMES.halloween.promo, 'string');
  assert.ok(THEMES.halloween.promo.length > 0);
  for (const [name, meta] of Object.entries(THEMES)) {
    if (name !== 'halloween') assert.equal(meta.promo, undefined, `${name} must not define a promo`);
  }
  // Error teardown removes the strip along with the other decorations.
  assert.match(themeJs, /\.sc-theme-banner, \.sc-theme-promo, \.sc-theme-particles/);
});

test('promo strip is styled: structure in theme-base, skin in halloween pack', () => {
  assert.match(themeBase, /\.sc-theme-promo\s*\{/);
  assert.match(halloween, /\[data-theme='halloween'\] \.sc-theme-promo\s*\{/);
  assert.match(halloween, /\[data-theme='halloween'\] \.header\s*\{[^}]*radial-gradient/);
});
