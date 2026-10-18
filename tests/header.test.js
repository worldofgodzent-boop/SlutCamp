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
 *   - the 2026-10-18 owner stack (Log out rides the wordmark row,
 *     bell stacked BELOW the pill on the home view only) — the old
 *     44px/66px margin pushes stay gone and the home-scoped bell
 *     drop rules (banner+promo 133 / banner 104 / promo 81) stay
 *     pinned to show()'s body.in-home mark in app.js.
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

test('bell keeps its fixed base band (the invariant the stack geometry derives from)', () => {
  // Base bell: top = inset+56, 44px tall → bottom edge at inset+100,
  // right: 12. This is the band everywhere except the home-view drop
  // pinned below. If this rule ever moves, the stack offsets must be
  // re-derived — this test failing is the reminder.
  assert.match(styles, /\.notif-bell\s*\{[^}]*top:\s*calc\(env\(safe-area-inset-top, 0px\) \+ 56px\);[^}]*right:\s*12px/);
  assert.match(styles, /\.notif-bell\s*\{[^}]*width:\s*44px;\s*height:\s*44px/);
});

test('owner stack: log out rides the wordmark row — the old margin pushes stay gone', () => {
  // The 2026-10-16 stack pushed the pill UNDER the bell with 44px /
  // 66px margins (and stretched the header by the same). The
  // 2026-10-18 stack reverses it — pill on top, bell below — so those
  // rules must not exist; if either creeps back, both the sprawl and
  // the reversed order return.
  assert.doesNotMatch(styles, /#phone:has\(> \.sc-theme-banner\) \.home-logout-btn\s*\{\s*margin-top:/);
  assert.doesNotMatch(styles, /#phone:has\(> \.sc-theme-promo\):not\(:has\(> \.sc-theme-banner\)\) \.home-logout-btn\s*\{\s*margin-top:/);
  assert.doesNotMatch(styles, /#phone:has\(> \.sc-theme-(banner|promo)\)[^{]*\.home-head-row\s*\{\s*align-items:\s*flex-start/);
});

test('bell drops below the log out pill on the home view only', () => {
  // show() must mark the home view — the drop is scoped to it so the
  // chat header's 📹 / Book buttons (full-inset band, ~one inset
  // lower than the home row under the strips) never end up covered.
  const appJs = read('public/js/app.js');
  assert.match(appJs, /document\.body\.classList\.toggle\('in-home', view === 'fanModels'\)/);
  // Tops = the pill's bottom edge in each strip state + 6px (see the
  // derivation at .home-head-row in styles.css): banner+promo 133,
  // banner only 104, promo only 81.
  assert.match(styles, /body\.in-home:has\(> #phone > \.sc-theme-banner\):has\(> #phone > \.sc-theme-promo\) \.notif-bell\s*\{\s*top:\s*calc\(env\(safe-area-inset-top, 0px\) \+ 133px\);/);
  assert.match(styles, /body\.in-home:has\(> #phone > \.sc-theme-banner\):not\(:has\(> #phone > \.sc-theme-promo\)\) \.notif-bell\s*\{\s*top:\s*calc\(env\(safe-area-inset-top, 0px\) \+ 104px\);/);
  assert.match(styles, /body\.in-home:has\(> #phone > \.sc-theme-promo\):not\(:has\(> #phone > \.sc-theme-banner\)\) \.notif-bell\s*\{\s*top:\s*calc\(env\(safe-area-inset-top, 0px\) \+ 81px\);/);
});

test('fan-home header carries the lips backdrop (static mark, behind content)', () => {
  // The backdrop is a ::before layer on the home view's header only:
  // static lips-logo.png, half strength, taps pass through. The
  // animated welcome asset (logo-lips-anim.webp) is welcome-screen-
  // only by product rule and must never be referenced here.
  assert.match(styles, /body\.in-home \.header::before\s*\{[^}]*background-image:\s*url\(\/img\/lips-logo\.png\)/);
  assert.match(styles, /body\.in-home \.header::before\s*\{[^}]*opacity:\s*\.5/);
  assert.match(styles, /body\.in-home \.header::before\s*\{[^}]*pointer-events:\s*none/);
  assert.doesNotMatch(styles, /body\.in-home \.header::before\s*\{[^}]*logo-lips-anim/);
});

test('promo strip is styled: structure in theme-base, skin in halloween pack', () => {
  assert.match(themeBase, /\.sc-theme-promo\s*\{/);
  assert.match(halloween, /\[data-theme='halloween'\] \.sc-theme-promo\s*\{/);
  assert.match(halloween, /\[data-theme='halloween'\] \.header\s*\{[^}]*radial-gradient/);
});
