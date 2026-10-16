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

test('bell keeps its fixed band (the invariant the stack geometry derives from)', () => {
  // Bell: top = inset+56, 44px tall → bottom edge at inset+100, right: 12.
  // If this rule ever moves, the logout stack offsets below must be
  // re-derived — this test failing is the reminder.
  assert.match(styles, /\.notif-bell\s*\{[^}]*top:\s*calc\(env\(safe-area-inset-top, 0px\) \+ 56px\);[^}]*right:\s*12px/);
  assert.match(styles, /\.notif-bell\s*\{[^}]*width:\s*44px;\s*height:\s*44px/);
});

test('log out stacks below the bell while the theme banner is up', () => {
  // Banner up → header content top ≈ inset+62, inside the bell's band
  // (inset+56 → inset+100). The pill is pushed one bell-height down its
  // row (≈inset+106 → inset+142, fully below the bell, ~6px spare) and
  // the wordmark stays at the top of the row.
  assert.match(styles, /#phone:has\(> \.sc-theme-banner\) \.home-head-row\s*\{\s*align-items:\s*flex-start;\s*\}/);
  assert.match(styles, /#phone:has\(> \.sc-theme-banner\) \.home-logout-btn\s*\{\s*margin-top:\s*44px;\s*\}/);
  // Orphan state: banner dismissed but the promo strip still in the
  // column → header starts ≈inset+39, so the push is deeper (66px →
  // pill ≈inset+105 → inset+141). The :not() guard keeps it from ever
  // stacking on top of the banner-state rule.
  assert.match(styles, /#phone:has\(> \.sc-theme-promo\):not\(:has\(> \.sc-theme-banner\)\) \.home-logout-btn\s*\{\s*margin-top:\s*66px;\s*\}/);
});

test('promo strip is styled: structure in theme-base, skin in halloween pack', () => {
  assert.match(themeBase, /\.sc-theme-promo\s*\{/);
  assert.match(halloween, /\[data-theme='halloween'\] \.sc-theme-promo\s*\{/);
  assert.match(halloween, /\[data-theme='halloween'\] \.header\s*\{[^}]*radial-gradient/);
});
