'use strict';
/*
 * App home social footer (owner, Oct 24 2026: "we need it on footer
 * of home page. This will help us grow"):
 *   - X: @SlutCampApp — https://x.com/SlutCampApp
 *   - Instagram: @slcamp__ — https://instagram.com/slcamp__
 * BRAND accounts only — never the owner's personal accounts.
 *
 * PR #89 put these links in the SERVER-RENDERED pages' footer (and a
 * "Follow SlutCamp:" row on the house page). The APP itself — the SPA
 * home views — had no footer, so fans inside the app never saw the
 * handles. This build closes that gap: ONE helper,
 * appSocialFooterHTML(), rendered at the bottom of BOTH home views
 * (vLanding, the signed-out front door, and vFanModels, the
 * signed-in home), so every home-view visitor, signed in or out,
 * sees the same footer. Presentation only: no routing, feed, or
 * visibility changes.
 *
 * The "Follow SlutCamp:" lead-in is prose, so it goes through STR
 * (follow_slutcamp) in all 13 languages; the link labels are the
 * brand names themselves ("X" / "Instagram"), exactly like the
 * public footer. Plain outbound links: new tab + rel="noopener",
 * no tracking parameters, no embeds, no feeds.
 *
 * Pins are static (source shape) + a render simulation: the real
 * helper is extracted from app.js and executed in a vm with a
 * stubbed t(), asserting on the HTML it emits (the home-controls
 * suite's approach).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const REPO = path.join(__dirname, '..');
const APP_JS = fs.readFileSync(path.join(REPO, 'public/js/app.js'), 'utf8');
const STYLES = fs.readFileSync(path.join(REPO, 'public/css/styles.css'), 'utf8');

const X_URL = 'https://x.com/SlutCampApp';
const IG_URL = 'https://instagram.com/slcamp__';
const X_ANCHOR = `<a href="${X_URL}" target="_blank" rel="noopener">X</a>`;
const IG_ANCHOR = `<a href="${IG_URL}" target="_blank" rel="noopener">Instagram</a>`;
const LANG13 = ['en', 'es', 'pt', 'fr', 'de', 'ru', 'ja', 'zh', 'ko', 'it', 'pl', 'nl', 'tr'];

const count = (hay, needle) => hay.split(needle).length - 1;

/* Extract the helper block: the two URL consts + the function. */
const helperMatch = APP_JS.match(
  /const APP_SOCIAL_X_URL[\s\S]*?^function appSocialFooterHTML\(\) \{[\s\S]*?^\}/m);
assert.ok(helperMatch, 'appSocialFooterHTML block located in app.js');
const HELPER = helperMatch[0];

function sliceFn(src, startMarker, endMarker) {
  const s = src.indexOf(startMarker);
  assert.ok(s >= 0, 'start marker found: ' + startMarker);
  const e = src.indexOf(endMarker, s);
  assert.ok(e > s, 'end marker found: ' + endMarker);
  return src.slice(s, e);
}

/* Brace-matching const extraction (same approach as languages-13). */
function literalSpan(src, marker) {
  const i = src.indexOf(marker);
  assert.ok(i >= 0, 'marker found: ' + marker);
  let j = src.indexOf('{', i), depth = 0, k = j, inStr = null, esc = false, inTpl = false, td = 0;
  for (; k < src.length; k++) {
    const c = src[k];
    if (inTpl) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '$' && src[k + 1] === '{') { td++; k++; continue; }
      if (c === '}' && td > 0) { td--; continue; }
      if (c === '`' && td === 0) inTpl = false;
      continue;
    }
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '`') { inTpl = true; continue; }
    if (c === "'" || c === '"') { inStr = c; continue; }
    if (c === '{') depth++;
    if (c === '}') { depth--; if (depth === 0) return [j, k + 1]; }
  }
  throw new Error('unbalanced: ' + marker);
}
function evalConst(src, marker) {
  const [s, e] = literalSpan(src, marker);
  const name = marker.replace('const ', '').replace(' =', '').trim();
  const sb = {};
  vm.createContext(sb);
  vm.runInContext(marker + ' ' + src.slice(s, e) + `;\nthis.__v = ${name};`, sb);
  return sb.__v;
}

/* ---------------- static pins ---------------- */

test('brand social URLs are hard-coded constants, single-sourced in app.js', () => {
  assert.ok(HELPER.includes(`const APP_SOCIAL_X_URL = '${X_URL}';`), 'X constant');
  assert.ok(HELPER.includes(`const APP_SOCIAL_INSTAGRAM_URL = '${IG_URL}';`), 'Instagram constant');
  // The literals appear exactly once each in the whole client source:
  // the anchors are built from the constants, so a handle change is a
  // one-line edit here just like the server side.
  assert.equal(count(APP_JS, X_URL), 1, 'X URL literal appears once (the constant)');
  assert.equal(count(APP_JS, IG_URL), 1, 'Instagram URL literal appears once (the constant)');
  assert.equal(count(APP_JS, 'https://x.com/'), 1, 'the only x.com URL in the app is the brand constant');
  assert.equal(count(APP_JS, 'https://instagram.com/'), 1, 'the only instagram.com URL in the app is the brand constant');
});

test('helper is defined exactly once and goes through STR for its label', () => {
  assert.equal(count(APP_JS, 'function appSocialFooterHTML()'), 1, 'exactly one helper definition');
  assert.ok(HELPER.includes("${t('follow_slutcamp')}"), 'the lead-in label renders through t()');
  assert.ok(HELPER.includes('class="app-social-footer"'), 'footer wrapper class');
  assert.doesNotThrow(() => new vm.Script(HELPER), 'helper block parses');
});

test('social anchors open in a new tab with rel="noopener", plain — no tracking params', () => {
  assert.ok(HELPER.includes(`<a href="\${APP_SOCIAL_X_URL}" target="_blank" rel="noopener">X</a>`), 'X anchor shape');
  assert.ok(HELPER.includes(`<a href="\${APP_SOCIAL_INSTAGRAM_URL}" target="_blank" rel="noopener">Instagram</a>`), 'Instagram anchor shape');
  assert.ok(!APP_JS.includes('utm_'), 'no tracking parameters anywhere in the client source');
});

test('no personal handles anywhere in the app source — brand accounts only', () => {
  assert.ok(!APP_JS.includes('ASCEAASPADE'), "the owner's personal X handle must not ship in the app");
  assert.ok(!HELPER.includes('ASCEAASPADE'), 'no personal handle in the footer code');
  // Every social URL in the client source is one of the two brand
  // constants (the occurrence-count pins above), so no personal
  // profile URL can hide anywhere in the feature either.
});

/* ---------------- STR: the label in all 13 languages ---------------- */

test('follow_slutcamp carries in all 13 languages, non-empty, EN pinned', () => {
  const I18N = evalConst(APP_JS, 'const I18N =');
  assert.equal(I18N.en.follow_slutcamp, 'Follow SlutCamp:', 'EN label');
  for (const lang of LANG13) {
    assert.equal(typeof I18N[lang].follow_slutcamp, 'string', `${lang} carries follow_slutcamp`);
    assert.ok(I18N[lang].follow_slutcamp.trim().length > 0, `${lang} label is not empty`);
    assert.ok(I18N[lang].follow_slutcamp.includes('SlutCamp'), `${lang} label names the brand`);
  }
  assert.equal(I18N.es.follow_slutcamp, 'Sigue a SlutCamp:', 'ES label');
  assert.equal(I18N.tr.follow_slutcamp, "SlutCamp'i takip et:", 'TR label');
});

/* ---------------- placement: both home views, at the bottom ---------------- */

test('both home views render the footer exactly once, at the bottom of the screen', () => {
  assert.equal(count(APP_JS, '${appSocialFooterHTML()}'), 2, 'two render sites: landing + fan home');
  const landing = sliceFn(APP_JS, 'async function vLanding()', 'async function vFanModels()');
  const fanHome = sliceFn(APP_JS, 'async function vFanModels()', 'async function vFanLive()');
  assert.equal(count(landing, '${appSocialFooterHTML()}'), 1, 'landing renders the footer once');
  assert.equal(count(fanHome, '${appSocialFooterHTML()}'), 1, 'fan home renders the footer once');
  // Bottom of the landing screen: below the legal-links line.
  assert.ok(landing.indexOf('go-dmca') < landing.indexOf('${appSocialFooterHTML()}'),
    'landing footer sits below the terms/privacy line');
  // Bottom of the fan home screen: below the model grid.
  assert.ok(fanHome.indexOf("t('no_matches')") < fanHome.indexOf('${appSocialFooterHTML()}'),
    'fan-home footer sits below the model tiles');
});

/* ---------------- styling ---------------- */

test('styles.css carries the Pink footer styling', () => {
  const i = STYLES.indexOf('.app-social-footer {');
  assert.ok(i >= 0, '.app-social-footer rule exists');
  const rule = STYLES.slice(i, STYLES.indexOf('}', i));
  assert.ok(rule.includes('text-align: center'), 'footer is centered like the public footer');
  assert.ok(STYLES.includes('.app-social-footer a { color: var(--pink);'), 'links are Pink');
});

/* ---------------- render simulation ---------------- */

test('render: the helper emits the label + both brand anchors', () => {
  const sandbox = { t: (k) => (k === 'follow_slutcamp' ? 'Follow SlutCamp:' : k) };
  vm.createContext(sandbox);
  const html = vm.runInContext(HELPER + '\nappSocialFooterHTML();', sandbox);
  assert.ok(html.includes('class="app-social-footer"'), 'wrapper renders');
  assert.ok(html.includes('Follow SlutCamp:'), 'STR label renders');
  assert.ok(html.includes(X_ANCHOR), 'X anchor renders with the brand URL');
  assert.ok(html.includes(IG_ANCHOR), 'Instagram anchor renders with the brand URL');
  assert.ok(!html.includes('ASCEAASPADE'), 'no personal handle in the rendered footer');
});
