'use strict';
/*
 * Join warning modal (Entry-warning build, Part 2 — Asce, 2026-10-23):
 * the first tap that starts joining as a fan, model, or affiliate /
 * recruiter pops the Part 1 warning BEFORE the signup form. Pins:
 *  - a module flag (page-load memory only, nothing persisted) and one
 *    shared joinWarningGate() helper built on ftSheet + Part 1's
 *    warn CSS and STR keys (no forked strings or styles);
 *  - Continue is blocked until the agreement box is ticked, surfacing
 *    gate_err_agree; acceptance is set before proceed() runs;
 *  - Cancel closes the sheet and never calls proceed;
 *  - every join door routes through the helper first: the auth view's
 *    signup mode (fan / model / affiliate role cards + arrival), the
 *    Manager invite door, the recruiter-link door, the affiliate
 *    invite door, and the fan quick-signup door;
 *  - the login branch and the forms' own DOB + agree18 fields are
 *    untouched (the modal is a layer in front, not a replacement);
 *  - gate_warn_continue exists in all 13 tables, and the Part 1 keys
 *    were reused, not duplicated.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const REPO = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(REPO, 'public/js/app.js'), 'utf8');

const LANG13 = ['en', 'es', 'pt', 'fr', 'de', 'ru', 'ja', 'zh', 'ko', 'it', 'pl', 'nl', 'tr'];

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
function sliceFrom(marker, len) {
  const i = appSrc.indexOf(marker);
  assert.ok(i >= 0, 'marker found: ' + marker);
  return appSrc.slice(i, i + len);
}

test('helper: per-load module flag, shared modal, no persistence', () => {
  const decls = appSrc.match(/^let joinWarnAccepted = false;$/gm) || [];
  assert.equal(decls.length, 1, 'joinWarnAccepted flag declared once, starting unset');
  const helper = sliceFrom('function joinWarningGate(proceed)', 2200);
  assert.ok(helper.includes('if (joinWarnAccepted) { proceed(); return; }'),
    'accepted flag short-circuits straight to the form');
  assert.ok(helper.includes('ftSheet('), 'modal uses the app sheet pattern');
  assert.ok(helper.includes('age-gate-warn'), 'modal reuses the Part 1 warn block CSS');
  assert.ok(helper.includes('age-gate-agree'), 'modal reuses the Part 1 agree-row CSS');
  // Acceptance lives in the module flag only — never written to storage.
  for (const line of appSrc.split('\n')) {
    if (line.includes('joinWarn')) {
      assert.ok(!line.includes('localStorage') && !line.includes('sessionStorage'),
        'flag is never persisted: ' + line.trim());
    }
  }
});

test('helper: modal shows the Part 1 warning strings, not forked copies', () => {
  const helper = sliceFrom('function joinWarningGate(proceed)', 2200);
  for (const k of ['gate_warn_h', 'gate_warn_body', 'gate_agree', 'gate_err_agree']) {
    assert.ok(helper.includes(`t('${k}')`), 'modal paints t(' + k + ')');
  }
  assert.ok(helper.includes("t('gate_warn_continue')"), 'Continue button uses gate_warn_continue');
  assert.ok(helper.includes("t('cancel')"), 'Cancel button reuses the cancel key');
  assert.ok(helper.includes('id="jw-agree"'), 'agreement checkbox present, id jw-agree');
  assert.ok(!helper.includes('id="jw-agree" checked'), 'checkbox starts unticked');
});

test('helper: Continue blocked until ticked; Cancel opens nothing', () => {
  const helper = sliceFrom('function joinWarningGate(proceed)', 2200);
  const checkAt = helper.indexOf("querySelector('#jw-agree')");
  assert.ok(checkAt >= 0, 'Continue handler reads the checkbox');
  const errAt = helper.indexOf("t('gate_err_agree')", checkAt);
  const setAt = helper.indexOf('joinWarnAccepted = true;');
  const proceedAt = helper.indexOf('proceed();', setAt);
  assert.ok(errAt > checkAt, 'unticked Continue surfaces gate_err_agree');
  assert.ok(setAt > errAt, 'acceptance is recorded only after the tick check passes');
  assert.ok(proceedAt > setAt, 'proceed() runs only after acceptance is recorded');
  const cancelLine = helper.split('\n').find((l) => l.includes("'#jw-cancel'"));
  assert.ok(cancelLine && cancelLine.includes('ftCloseSheet()'), 'Cancel closes the sheet');
  assert.ok(!cancelLine.includes('proceed'), 'Cancel never proceeds to a form');
});

test('auth view: fan / model / affiliate starts all route through the warning', () => {
  const body = sliceFrom('function renderAuthBody', 7000);
  assert.ok(body.includes("joinWarningGate(() => { r = 'fan'; paint(); })"), 'fan card tap is gated');
  assert.ok(body.includes("joinWarningGate(() => { r = 'affiliate'; paint(); })"), 'affiliate card tap is gated');
  assert.ok(body.includes('joinWarningGate(startModel)'), 'model start is gated');
  assert.ok(body.includes('joinWarningGate(() => paint())'), 'initial arrival is gated');
  const calls = body.match(/joinWarningGate\(/g) || [];
  assert.equal(calls.length, 5, 'exactly 5 gate calls in the signup branch (3 cards + model arrival + arrival paint)');
  // The model start still runs the section router after the warning.
  const sm = body.indexOf('const startModel');
  assert.ok(body.slice(sm, sm + 600).includes('vSectionGate('), 'section router preserved inside startModel');
});

test('auth view: login branch untouched by the warning', () => {
  const rb = appSrc.indexOf('function renderAuthBody');
  const loginSlice = appSrc.slice(rb, appSrc.indexOf("$('#a-go').onclick = doLogin", rb));
  assert.ok(loginSlice.includes('data-si-role'), 'slice covers the login branch');
  assert.ok(!loginSlice.includes('joinWarningGate'), 'login never pops the join warning');
});

test('link doors + quick signup: warning wrapper precedes each flow', () => {
  const doors = [
    ['async function vInviteSignup(code)', 'joinWarningGate(() => vInviteSignup(code))',
      'if (!modelSectionPick) return vSectionGate(() => vInviteSignup(code));'],
    ['async function vRecruiterSignup(code)', 'joinWarningGate(() => vRecruiterSignup(code))',
      'if (!modelSectionPick) return vSectionGate(() => vRecruiterSignup(code));'],
    ['async function vAffiliateSignup(code)', 'joinWarningGate(() => vAffiliateSignup(code))',
      'entryRerender = () => vAffiliateSignup(code);'],
    ['function vQuickSignup()', 'joinWarningGate(() => vQuickSignup())', 'app.innerHTML'],
  ];
  for (const [sig, wrap, flow] of doors) {
    const slice = sliceFrom(sig, 1200);
    const wAt = slice.indexOf(wrap);
    const fAt = slice.indexOf(flow);
    assert.ok(wAt >= 0, sig + ' routes through joinWarningGate');
    assert.ok(fAt > wAt, sig + ': the warning wrapper runs before the door flow (' + flow + ')');
    assert.ok(slice.slice(0, wAt + wrap.length).includes('if (!joinWarnAccepted)'),
      sig + ': wrapper only fires while unaccepted');
  }
});

test('forms keep their own fields; STR reuse verified (no duplicated Part 1 keys)', () => {
  const fields = sliceFrom('function renderSignupFields', 6000);
  assert.ok(fields.includes('id="a-18"'), 'fan/model form keeps its own 18+ checkbox');
  assert.ok(fields.includes('id="a-dob"'), 'fan/model form keeps its own DOB field');
  assert.ok(fields.includes('id="af-agree"'), 'affiliate form keeps its own agreement checkbox');
  const I18N = evalI18N();
  assert.deepEqual(Object.keys(I18N).sort(), [...LANG13].sort());
  for (const lang of LANG13) {
    assert.equal(typeof I18N[lang].gate_warn_continue, 'string', `${lang}:gate_warn_continue is a string`);
    assert.ok(I18N[lang].gate_warn_continue.trim().length > 0, `${lang}:gate_warn_continue is not empty`);
    if (lang !== 'en') assert.notEqual(I18N[lang].gate_warn_continue, I18N.en.gate_warn_continue,
      `${lang} Continue label is translated`);
  }
  assert.equal(I18N.en.gate_warn_continue, 'Continue');
  for (const k of ['gate_warn_continue', 'gate_warn_h', 'gate_warn_body', 'gate_agree', 'gate_err_agree']) {
    // Line-anchored count (a bare count would also match release_gate_agree:).
    const n = (appSrc.match(new RegExp(`^\\s+${k}:`, 'gm')) || []).length;
    assert.equal(n, 13, `${k} appears exactly 13 times (reused, not forked)`);
  }
});
