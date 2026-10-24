'use strict';
/*
 * Entry warning on the 18+ age gate (Asce, 2026-10-23 — Pink-style
 * rules warning). Pins:
 *  - index.html carries the warn block + required agreement checkbox
 *    with the English first paint, warn block above the DOB form and
 *    the checkbox inside the form before the submit button;
 *  - all 13 language tables carry the 4 new gate_* keys, non-empty,
 *    and the EN values match the spec wording exactly;
 *  - paintGate() paints warn title/body/agree text per language;
 *  - the submit handler checks #gate-agree before resolving and
 *    surfaces gate_err_agree via #age-error;
 *  - Terms/Privacy render as plain text (no dead pre-gate links);
 *  - the CSS warn/agree classes exist and the card can scroll.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const REPO = path.join(__dirname, '..');
const indexSrc = fs.readFileSync(path.join(REPO, 'public/index.html'), 'utf8');
const appSrc = fs.readFileSync(path.join(REPO, 'public/js/app.js'), 'utf8');
const cssSrc = fs.readFileSync(path.join(REPO, 'public/css/styles.css'), 'utf8');

const LANG13 = ['en', 'es', 'pt', 'fr', 'de', 'ru', 'ja', 'zh', 'ko', 'it', 'pl', 'nl', 'tr'];
const NEW_KEYS = ['gate_warn_h', 'gate_warn_body', 'gate_agree', 'gate_err_agree'];

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
function evalI18N() {
  const [s, e] = literalSpan(appSrc, 'const I18N =');
  const sb = {}; vm.createContext(sb);
  vm.runInContext('const I18N = ' + appSrc.slice(s, e) + ';\nthis.__v = I18N;', sb);
  return sb.__v;
}

test('index.html: warn block above the DOB form, English first paint', () => {
  assert.ok(indexSrc.includes('class="age-gate-warn" id="gate-warn"'), 'warn block present');
  assert.ok(indexSrc.includes('id="gate-warn-h"'), 'warn title element present');
  assert.ok(indexSrc.includes('⚠️ Important — read our rules carefully'), 'warn title first paint is EN spec text');
  assert.ok(indexSrc.includes('id="gate-warn-body"'), 'warn body element present');
  assert.ok(indexSrc.includes('WARNING: THIS SITE HAS A ZERO TOLERANCE POLICY FOR UNDERAGE BROADCASTING.'),
    'warn body first paint carries the zero-tolerance warning');
  assert.ok(indexSrc.includes('INTERNATIONAL LAWS AGAINST CHILD PORNOGRAPHY.'),
    'warn body first paint is complete');
  const warnAt = indexSrc.indexOf('id="gate-warn"');
  const formAt = indexSrc.indexOf('<form id="age-form">');
  assert.ok(warnAt >= 0 && formAt > warnAt, 'warn block sits above the DOB form');
});

test('index.html: agreement checkbox inside the form, unchecked, before submit', () => {
  assert.ok(indexSrc.includes('<input type="checkbox" id="gate-agree">'), 'checkbox #gate-agree present');
  assert.ok(!indexSrc.includes('id="gate-agree" checked'), 'checkbox is not pre-checked');
  assert.ok(indexSrc.includes('id="gate-agree-text"'), 'agree label text element present');
  assert.ok(indexSrc.includes('I confirm I am 18 years old or older, and I have read, understand and agree to the Terms and Conditions and Privacy Policy.'),
    'agree first paint is EN spec text');
  const formAt = indexSrc.indexOf('<form id="age-form">');
  const formEnd = indexSrc.indexOf('</form>', formAt);
  const boxAt = indexSrc.indexOf('id="gate-agree"');
  const btnAt = indexSrc.indexOf('id="gate-btn"');
  assert.ok(boxAt > formAt && boxAt < formEnd, 'checkbox is inside #age-form');
  assert.ok(boxAt < btnAt, 'checkbox comes before the submit button');
  // No dead pre-gate legal links: Terms/Privacy in the gate are plain text.
  const gateSlice = indexSrc.slice(indexSrc.indexOf('id="age-gate"'), indexSrc.indexOf('</form>'));
  assert.ok(!/<a[^>]+href[^>]*>(?:[^<]*)(Terms|Privacy)/.test(gateSlice), 'no Terms/Privacy anchor inside the gate');
  assert.ok(!gateSlice.includes('/#terms') && !gateSlice.includes('/#privacy'),
    'gate does not link to the post-gate hash legal routes');
});

test('i18n: all 13 tables carry the 4 new keys, non-empty; EN matches spec', () => {
  const I18N = evalI18N();
  assert.deepEqual(Object.keys(I18N).sort(), [...LANG13].sort());
  for (const lang of LANG13) {
    for (const k of NEW_KEYS) {
      assert.equal(typeof I18N[lang][k], 'string', `${lang}:${k} is a string`);
      assert.ok(I18N[lang][k].trim().length > 0, `${lang}:${k} is not empty`);
    }
    // translations are real, not copies of EN (except where a language legitimately shares a word)
    if (lang !== 'en') {
      assert.notEqual(I18N[lang].gate_warn_body, I18N.en.gate_warn_body, `${lang} warn body is translated`);
      assert.notEqual(I18N[lang].gate_err_agree, I18N.en.gate_err_agree, `${lang} agree error is translated`);
    }
  }
  assert.equal(I18N.en.gate_warn_h, '⚠️ Important — read our rules carefully');
  assert.equal(I18N.en.gate_warn_body,
    'WARNING: THIS SITE HAS A ZERO TOLERANCE POLICY FOR UNDERAGE BROADCASTING. IF YOU ARE NOT LEGALLY AN ADULT, OR IF YOU BROADCAST ANY TYPE OF PORN, EROTIC PHOTOS OR VIDEO CONTENT INVOLVING ANYONE UNDER 18, YOUR PERSONAL DATA WILL BE TRANSFERRED TO THE RELEVANT AUTHORITIES FOR ENFORCEMENT UNDER INTERNATIONAL LAWS AGAINST CHILD PORNOGRAPHY.');
  assert.equal(I18N.en.gate_agree,
    'I confirm I am 18 years old or older, and I have read, understand and agree to the Terms and Conditions and Privacy Policy.');
  assert.equal(I18N.en.gate_err_agree,
    'Please confirm you are 18+ and agree to the Terms and Privacy Policy to enter.');
  for (const k of NEW_KEYS) {
    // Line-anchored count: a bare substring count would also match
    // release_gate_agree: for gate_agree.
    const n = (appSrc.match(new RegExp(`^\\s+${k}:`, 'gm')) || []).length;
    assert.equal(n, 13, `${k} appears exactly 13 times (once per table)`);
  }
});

test('app.js: paintGate paints the warning + agreement per language', () => {
  const start = appSrc.indexOf('function checkAgeGate()');
  assert.ok(start >= 0, 'checkAgeGate exists');
  const slice = appSrc.slice(start, start + 4000);
  assert.ok(slice.includes("t('gate_warn_h')"), 'paintGate paints gate_warn_h');
  assert.ok(slice.includes("t('gate_warn_body')"), 'paintGate paints gate_warn_body');
  assert.ok(slice.includes("t('gate_agree')"), 'paintGate paints gate_agree');
  assert.ok(slice.includes("$('#gate-warn-h')"), 'paintGate targets #gate-warn-h');
  assert.ok(slice.includes("$('#gate-warn-body')"), 'paintGate targets #gate-warn-body');
  assert.ok(slice.includes("$('#gate-agree-text')"), 'paintGate targets #gate-agree-text');
});

test('app.js: submit handler blocks on the unchecked checkbox before resolving', () => {
  const start = appSrc.indexOf("$('#age-form').onsubmit");
  assert.ok(start >= 0, 'submit handler exists');
  const slice = appSrc.slice(start, start + 3500);
  const checkAt = slice.indexOf("$('#gate-agree')");
  assert.ok(checkAt >= 0, 'handler reads #gate-agree');
  assert.ok(slice.includes('agree.checked'), 'handler tests the checked state');
  assert.ok(slice.includes("t('gate_err_agree')"), 'handler surfaces gate_err_agree');
  assert.ok(slice.includes("$('#age-error')") || slice.includes("const err = $('#age-error')"),
    'handler reuses #age-error');
  const resolveAt = slice.indexOf('resolve()');
  assert.ok(resolveAt > checkAt, 'the checkbox check runs before resolve()');
  // The DOB validation itself is unchanged in shape.
  assert.ok(slice.includes("t('gate_err_empty')"), 'empty-DOB error still wired');
  assert.ok(slice.includes("t('gate_err_invalid')"), 'invalid-DOB error still wired');
  assert.ok(slice.includes("t('gate_denied')"), 'denied screen still wired');
});

test('css: warn + agree classes exist; card scrolls on small phones', () => {
  assert.ok(cssSrc.includes('.age-gate-warn {'), '.age-gate-warn rule exists');
  assert.ok(cssSrc.includes('.age-gate-warn-body'), '.age-gate-warn-body rule exists');
  assert.ok(cssSrc.includes('.age-gate-agree'), '.age-gate-agree rule exists');
  const warnRule = cssSrc.slice(cssSrc.indexOf('.age-gate-warn {'), cssSrc.indexOf('}', cssSrc.indexOf('.age-gate-warn {')));
  assert.ok(/border/.test(warnRule) && /background/.test(warnRule), 'warn block has border + tint');
  const bodyRule = cssSrc.slice(cssSrc.indexOf('.age-gate-warn-body'), cssSrc.indexOf('}', cssSrc.indexOf('.age-gate-warn-body')));
  assert.ok(bodyRule.includes('#ff3b30') || /red/i.test(bodyRule), 'warn body is red');
  assert.ok(/font-weight:\s*700/.test(bodyRule), 'warn body is bold');
  const cardRule = cssSrc.slice(cssSrc.indexOf('.age-gate-card {'), cssSrc.indexOf('}', cssSrc.indexOf('.age-gate-card {')));
  assert.ok(cardRule.includes('max-height'), 'age-gate-card is height-bounded');
  assert.ok(cardRule.includes('overflow-y: auto'), 'age-gate-card scrolls vertically');
});
