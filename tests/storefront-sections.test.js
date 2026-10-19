'use strict';
/*
 * Storefront sections — Phase 1 (owner pivot, Oct 18 2026). The
 * females-only refusal build was paused mid-gate and reworked: men
 * are no longer refused a model account — SlutCamp has SECTIONS.
 *
 *  1. DATA: models.section ('female' | 'male' | 'couple', default
 *     'female' — every pre-sections row) and a section attestation on
 *     the user row (section_attested_at / _ip), recorded like the 18+
 *     attestation. The old female attestation is REPLACED (it never
 *     shipped; nothing of it remains).
 *  2. SIGNUP ROUTER: the FIRST step of every model join — front-door
 *     Model card, Manager invite link, affiliate/referral link — is
 *     one neat step: "Joining as" → Female / Male / Couple. Every pick
 *     proceeds into model signup carrying `section`; the server
 *     REQUIRES a valid section for finalRole 'model' (400
 *     must_declare_section, before createUser) and referral/invite
 *     attribution is unchanged for every section. The refusal panel
 *     and its copy are GONE.
 *  3. AGREEMENT v1.5 (revised in place — version stays '1.5', date
 *     stays October 18, 2026): §15 is now "Your Section & Who May
 *     Appear" in all 13 presentations — she performs in her declared
 *     section; only she and her ID-verified co-performers may appear
 *     on camera; breach = termination. The models-only v1.5
 *     announcement copy says the same (her account is in the Female
 *     section). The co-performer FEATURE is Phase 2 — not built here.
 *  4. FAN TABS (owner's final simplification): entry ALWAYS lands on
 *     the Female storefront — every fan and guest, every visit. A slim
 *     tab strip (Female / Male / Couples / All) rides the top of the
 *     home/directory; tab state is per-session client state passed as
 *     ?tab= — NO chooser, NO stored preference, NO Settings control.
 *     Effective sets: female {female,couple} · male {male,couple} ·
 *     couples {couple} · all {female,male,couple} · no tab = Female.
 *     Filtering holds on /api/models, /api/live, /api/live/schedule;
 *     models/admins unfiltered [SUPERSEDED Oct 19 2026 — see the two
 *     pin corrections below: the owner ruled a model's home IS a
 *     front page, so EVERY viewer of these public surfaces is
 *     tab-filtered now; only the Manager's /api/admin/* roster stays
 *     unfiltered]; the official house object travels as before.
 *     HARD INVARIANT (owner: "I don't want males on my store
 *     front"): default/guest payloads, the landing and every public/
 *     SEO surface contain ZERO solo male models — a male-section
 *     model is reachable only behind an explicit Male/All tab tap.
 *     SEO /models index + sitemap list Female + Couple only;
 *     individual model pages unchanged.
 *  5. FAN ANNOUNCEMENT: one-time, stamp-guarded (storefront_
 *     announced_at), fans only, official thread DM + bell, SRV ×13.
 *  6. NEW-MODEL BELL (extended): body names SECTION + route — joined
 *     the {section} section directly / via invite link / via
 *     {recruiter}'s link — SRV ×13, all admins, exactly one per model
 *     signup, fans/affiliates silent.
 *
 * Static source pins (suite convention) + functional boots.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const REPO = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(REPO, 'public/js/app.js'), 'utf8');
const serverSrc = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');

const LANG13 = ['en', 'es', 'pt', 'fr', 'de', 'ru', 'ja', 'zh', 'ko', 'it', 'pl', 'nl', 'tr'];

/* Brace-matching extractor (same approach as the language suites). */
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
function sliceFn(src, startMarker, endMarker) {
  const s = src.indexOf(startMarker);
  const e = src.indexOf(endMarker, s);
  assert.ok(s !== -1 && e > s, `located ${startMarker} … ${endMarker}`);
  return src.slice(s, e);
}

/* --------------------------- static pins: data + attestation --------------------------- */

const signupHandler = sliceFn(serverSrc, '// POST /api/auth/signup', '// POST /api/auth/quick-signup');

test('server: section data — models.section migration default + fan-side has no stored preference', () => {
  assert.ok(serverSrc.includes(`addColumnIfMissing('models', 'section', "TEXT NOT NULL DEFAULT 'female'");`),
    'models.section boot migration, default female (every pre-sections row)');
  // The stored-preference concept was dropped by the owner's final
  // simplification: no browse_pref anywhere, server or client.
  assert.ok(!serverSrc.includes('browse_pref'), 'server carries no browse_pref (tabs are per-session, never stored)');
  assert.ok(!appSrc.includes('browse_pref'), 'client carries no browse_pref');
  assert.ok(!appSrc.includes('wc_browse'), 'no localStorage browse key — the door resets to Female every visit');
});

test('server: section attestation replaces the female attestation, recorded like the 18+ one', () => {
  assert.ok(serverSrc.includes("addColumnIfMissing('users', 'section_attested_at', 'TEXT');"), 'section_attested_at column');
  assert.ok(serverSrc.includes("addColumnIfMissing('users', 'section_attested_ip', 'TEXT');"), 'section_attested_ip column');
  const rec = sliceFn(serverSrc, 'function recordSectionAttestation', '\n}\n');
  assert.ok(rec.includes("section_attested_at = datetime(\\'now\\'), section_attested_ip = ?"), 'recorder stamps time + IP');
  assert.ok(signupHandler.includes('recordAgeAttestation(id, req);'), 'age attestation still recorded');
  assert.ok(signupHandler.includes('recordSectionAttestation(id, req);'), 'section attestation recorded in the signup flow');
  assert.ok(signupHandler.includes("db.prepare('UPDATE models SET section = ? WHERE user_id = ?').run(section, id);"),
    'the declared section lands on her model row');
  // the replaced feature left nothing behind
  for (const gone of ['recordFemaleAttestation', 'female_attested_at', 'female_attested_ip', 'agree_female', 'must_confirm_female']) {
    assert.ok(!serverSrc.includes(gone), `server: ${gone} is gone`);
    assert.ok(!appSrc.includes(gone), `client: ${gone} is gone`);
  }
});

test('server: register refuses a model without a valid section — every model door, one rule', () => {
  assert.ok(signupHandler.includes('section'), 'handler reads section');
  assert.ok(serverSrc.includes("const MODEL_SECTIONS = ['female', 'male', 'couple'];"), 'the three sections, canonical list');
  const guard = "if (finalRole === 'model' && !MODEL_SECTIONS.includes(section))";
  assert.ok(signupHandler.includes(guard), 'guard keys off the FINAL role (invite/referral force model server-side)');
  const gi = signupHandler.indexOf(guard);
  const refusal = signupHandler.slice(gi, gi + 160);
  assert.ok(refusal.includes("res.status(400).json({ error: 'must_declare_section' })"),
    'refusal mirrors the 18+ shape: 400 + error code');
  assert.ok(gi > signupHandler.indexOf("finalRole = 'model';"), 'guard runs after the invite role is forced');
  assert.ok(gi < signupHandler.indexOf('createUser('), 'guard runs before any user is created');
  const quick = sliceFn(serverSrc, '// POST /api/auth/quick-signup', '// Fold a guest');
  assert.ok(!quick.includes('must_declare_section'), 'fan quick-signup untouched by the declaration');
});

/* --------------------------- static pins: agreement --------------------------- */

test('agreement: v1.5 carries the §15 section clause in EN + all 12 presentations', () => {
  assert.ok(serverSrc.includes("const CONTRACT_VERSION = '1.5';"), 'version stays 1.5');
  assert.ok(!serverSrc.includes("const CONTRACT_VERSION = '1.4';"), 'v1.4 gone');
  assert.ok(serverSrc.includes("updated: 'October 18, 2026'"), 'date stays October 18, 2026');
  assert.ok(serverSrc.includes("title: '15. Your Section & Who May Appear'"), '§15 is the section clause');
  const s15 = sliceFn(serverSrc, "title: '15. Your Section & Who May Appear'", "title: '16. Plain-Language Disclaimer'");
  assert.ok(s15.includes('the section you declared when you created your account'), 'clause: she performs in her declared section');
  assert.ok(s15.includes('Only you — the account holder — and your ID-verified co-performers may appear on camera'), 'clause: only she + verified co-performers on camera');
  assert.ok(s15.includes('breaches this Agreement'), 'clause: another section / unverified people = breach');
  assert.ok(s15.includes('the Company may terminate your account immediately'), 'clause: termination remedy');
  assert.ok(!serverSrc.includes('15. Eligibility'), 'the women-only eligibility clause is gone');
  assert.ok(!serverSrc.includes('open to women only'), 'no women-only text remains');
  assert.ok(serverSrc.includes("title: '16. Plain-Language Disclaimer'"), 'disclaimer renumbered to §16');
  assert.ok(!serverSrc.includes('15. Plain-Language Disclaimer'), 'disclaimer no longer numbered 15');
  const I18N = evalConst(serverSrc, 'const MODEL_CONTRACT_I18N =');
  assert.deepEqual(Object.keys(I18N).sort(), LANG13.filter((l) => l !== 'en').sort(), '12 translated presentations');
  for (const [lang, d] of Object.entries(I18N)) {
    assert.equal(d.sections.length, 16, `${lang}: 16 sections`);
    assert.ok(d.sections[14].title.startsWith('15.'), `${lang}: §15 is the section clause`);
    assert.ok(d.sections[14].body.trim().length > 40, `${lang}: §15 body present`);
    assert.ok(d.sections[15].title.startsWith('16.'), `${lang}: disclaimer renumbered §16`);
  }
});

/* --------------------------- static pins: announcements --------------------------- */

test('announcement: v1.5 broadcast is models-only, official-thread, stamp-guarded, localized — copy tells the sections story', () => {
  const fn = sliceFn(serverSrc, 'function announceAgreement15ToModels()', '\n}\n');
  assert.ok(fn.includes('agreement_15_announced_at'), 'stamp-guarded');
  assert.ok(fn.includes('houseAccountId()'), 'house-account discipline (no house → retry next boot)');
  assert.ok(fn.includes("role = 'model'"), 'models only');
  assert.ok(!fn.includes("'fan'"), 'fans are not recipients');
  assert.ok(fn.includes('officialThreadFor(p.id)'), 'lands in the official notices thread');
  assert.ok(fn.includes("srv('ann_agreement_15_dm', p.language)"), 'DM copy in her stored language');
  assert.ok(fn.includes("notifyUser(p.id, 'agreement_15'"), 'bell type agreement_15');
  assert.ok(fn.includes('`/#chat/${conv.id}`'), 'bell opens the thread itself');
  assert.ok(serverSrc.includes('announceAgreement15ToModels();'), 'invoked at boot');
  const SRV = evalConst(serverSrc, 'const SRV =');
  for (const k of ['ann_agreement_15_dm', 'ann_agreement_15_bell_title', 'ann_agreement_15_bell_body']) {
    assert.deepEqual(Object.keys(SRV[k]).sort(), [...LANG13].sort(), `${k} covers 13 languages`);
    for (const lang of LANG13) assert.ok(SRV[k][lang].trim().length > 0, `${k}:${lang} non-empty`);
  }
  assert.ok(SRV.ann_agreement_15_dm.en.includes('Female, Male and Couple sections'), 'EN DM: the app now has the three sections');
  assert.ok(SRV.ann_agreement_15_dm.en.includes('your account is in the Female section'), 'EN DM: her account is in the Female section');
  assert.ok(SRV.ann_agreement_15_dm.en.includes('ID-verified co-performers may appear on camera'), 'EN DM: only verified co-performers may appear with her');
});

test('announcement: storefront broadcast is fans-only, official-thread, stamp-guarded, localized', () => {
  assert.ok(serverSrc.includes("addColumnIfMissing('platform_stats', 'storefront_announced_at', 'TEXT');"), 'stamp column');
  const fn = sliceFn(serverSrc, 'function announceStorefrontToFans()', '\n}\n');
  assert.ok(fn.includes('storefront_announced_at'), 'stamp-guarded');
  assert.ok(fn.includes('houseAccountId()'), 'house-account discipline (no house → retry next boot)');
  assert.ok(fn.includes("role = 'fan'"), 'fans only');
  assert.ok(!fn.includes("role = 'model'"), 'models are not recipients');
  assert.ok(fn.includes('officialThreadFor(p.id)'), 'lands in the official notices thread');
  assert.ok(fn.includes("srv('ann_storefront_dm', p.language)"), 'DM copy in his stored language');
  assert.ok(fn.includes("notifyUser(p.id, 'storefront'"), 'bell type storefront');
  assert.ok(fn.includes('`/#chat/${conv.id}`'), 'bell opens the thread itself');
  assert.ok(serverSrc.includes('announceStorefrontToFans();'), 'invoked at boot');
  const SRV = evalConst(serverSrc, 'const SRV =');
  for (const k of ['ann_storefront_dm', 'ann_storefront_bell_title', 'ann_storefront_bell_body']) {
    assert.deepEqual(Object.keys(SRV[k]).sort(), [...LANG13].sort(), `${k} covers 13 languages`);
    for (const lang of LANG13) assert.ok(SRV[k][lang].trim().length > 0, `${k}:${lang} non-empty`);
  }
  assert.ok(SRV.ann_storefront_dm.en.includes('Female, Male, Couples and All'), 'EN DM names the four tabs');
  assert.ok(SRV.ann_storefront_dm.en.includes('always opens on Female'), 'EN DM: the store always opens on Female');
});

/* --------------------------- static pins: the router --------------------------- */

const gate = sliceFn(appSrc, 'function vSectionGate(resume)', 'function vAuth(params)');

test('router: the gate is one neat "Joining as" step — Female / Male / Couple, every pick proceeds', () => {
  assert.ok(appSrc.includes('let modelSectionPick = null;'), 'the pick is recorded in module state');
  assert.ok(gate.includes("t('sec_title')"), 'box asks "Joining as"');
  assert.ok(gate.includes('id="sec-female"') && gate.includes("t('sec_female')"), 'Female choice');
  assert.ok(gate.includes('id="sec-male"') && gate.includes("t('sec_male')"), 'Male choice');
  assert.ok(gate.includes('id="sec-couple"') && gate.includes("t('sec_couple')"), 'Couple choice');
  assert.ok(gate.includes("modelSectionPick = 'female'; resume();"), 'Female records her section and proceeds');
  assert.ok(gate.includes("modelSectionPick = 'male'; resume();"), 'Male records his section and proceeds — no refusal');
  assert.ok(gate.includes("modelSectionPick = 'couple'; resume();"), 'Couple records its section and proceeds');
  assert.ok(!gate.includes('/auth/signup'), 'the router itself creates nothing');
  // the refusal path is REMOVED, cleanly
  for (const gone of ['vGenderGate', 'vGenderRefusal', 'modelFemalePick', 'mf_title', 'mf_sorry', 'mf_join_fan']) {
    assert.ok(!appSrc.includes(gone), `client: ${gone} is gone`);
  }
});

test('router: FIRST step of every model join — front door, invite link, referral link', () => {
  const authBody = sliceFn(appSrc, 'function renderAuthBody(', 'function renderSignupFields');
  assert.ok(authBody.includes("if (!modelSectionPick) return vSectionGate(() => show('auth', { mode: 'signup', role: 'model' }));"),
    'Model card tap opens the router before the form');
  assert.ok(authBody.includes("if (r === 'model' && !modelSectionPick)"), 'pre-picked model arrival is routed too');
  assert.ok(!sliceFn(appSrc, 'function renderSignupFields', 'async function doSignup').includes('sec_title'),
    'the form itself carries no router — the step precedes it');
  const inv = sliceFn(appSrc, 'async function vInviteSignup(code)', 'async function vRecruiterSignup(code)');
  assert.ok(inv.includes('if (!modelSectionPick) return vSectionGate(() => vInviteSignup(code));'), 'invite join routed');
  assert.ok(inv.indexOf('vSectionGate') < inv.indexOf('entryRerender = '), 'router runs before the view renders anything');
  const ref = sliceFn(appSrc, 'async function vRecruiterSignup(code)', '/* Recruiter agreement summary');
  assert.ok(ref.includes('if (!modelSectionPick) return vSectionGate(() => vRecruiterSignup(code));'),
    'referral join routed; resume re-enters with the same code');
  assert.ok(ref.indexOf('vSectionGate') < ref.indexOf('entryRerender = '), 'router runs before the view renders anything');
  assert.ok(ref.includes('referral_code: code'), 'attribution still rides the register call');
  assert.ok(ref.includes('section: modelSectionPick'), 'her section rides the same call');
});

test('router: the section reaches every model register call; fan calls stay clean', () => {
  const doSignup = sliceFn(appSrc, 'async function doSignup(role)', '/* ---------------- Face ID');
  assert.ok(doSignup.includes("...(role === 'model' ? { section: modelSectionPick } : {})"),
    'front-door register carries the section for models only');
  assert.ok(doSignup.includes("must_declare_section: t('err_must_declare_section')"), 'server refusal has a friendly toast');
  const inv = sliceFn(appSrc, 'async function vInviteSignup(code)', 'async function vRecruiterSignup(code)');
  assert.ok(inv.includes('section: modelSectionPick'), 'invite register carries the section');
  assert.ok(inv.includes("must_declare_section: t('err_must_declare_section')"), 'invite refusal has a friendly toast');
  const ref = sliceFn(appSrc, 'async function vRecruiterSignup(code)', '/* Recruiter agreement summary');
  assert.ok(ref.includes("must_declare_section: t('err_must_declare_section')"), 'referral refusal has a friendly toast');
});

test('router i18n: every router + tab key exists in all 13 client languages', () => {
  for (const k of ['sec_title', 'sec_female', 'sec_male', 'sec_couple', 'err_must_declare_section',
    'sf_female', 'sf_male', 'sf_couples', 'sf_all']) {
    assert.equal(appSrc.split(`    ${k}: `).length - 1, 13, `${k} present 13×`);
  }
  const I18N = evalConst(appSrc, 'const I18N =');
  assert.equal(I18N.en.sec_title, 'Joining as', 'owner copy: the step says "Joining as"');
  for (const lang of LANG13) {
    assert.ok(I18N[lang].sec_female.trim().length > 0 && I18N[lang].sec_male.trim().length > 0
      && I18N[lang].sec_couple.trim().length > 0, `${lang}: all three sections present`);
    assert.ok(I18N[lang].sf_female.trim().length > 0 && I18N[lang].sf_all.trim().length > 0, `${lang}: tab labels present`);
  }
  for (const gone of ['mf_title', 'mf_female', 'mf_male', 'mf_sorry', 'mf_join_fan', 'err_must_confirm_female']) {
    assert.equal(appSrc.split(`    ${gone}: `).length - 1, 0, `${gone} removed from every dictionary`);
  }
});

/* --------------------------- static pins: fan tabs + filtering --------------------------- */

test('tabs: entry lands on Female — per-session state, four tabs, no chooser, no stored preference', () => {
  assert.ok(appSrc.includes("let browseTab = 'female';"), 'the tab starts at female — every visit, every viewer');
  assert.ok(appSrc.includes("const BROWSE_TABS = ['female', 'male', 'couples', 'all'];"), 'exactly four tabs');
  const tabs = sliceFn(appSrc, 'function sectionTabsHTML()', 'function wireSectionTabs');
  assert.ok(tabs.includes('data-sectab="${tb}"'), 'each tab is a button carrying its tab id');
  assert.ok(tabs.includes("t('sf_' + tb)"), 'tab labels are the sf_ keys');
  assert.ok(tabs.includes("browseTab === tb ? ' on' : ''"), 'the active tab is marked');
  const wire = sliceFn(appSrc, 'function wireSectionTabs', '\n}\n');
  assert.ok(wire.includes('browseTab = b.dataset.sectab;'), 'tapping records the tab in session state');
  assert.ok(wire.includes('rerender();'), 'tapping re-renders in place');
  // the strip rides BOTH browsing surfaces: guest landing + fan home
  const landing = sliceFn(appSrc, 'async function vLanding()', 'async function vFanModels()');
  assert.ok(landing.includes('${sectionTabsHTML()}'), 'guest landing carries the strip');
  assert.ok(landing.includes("wireSectionTabs(() => show('landing', {}))"), 'landing tabs re-render the landing');
  const fanHome = sliceFn(appSrc, 'async function vFanModels()', 'async function vFanLive()');
  assert.ok(fanHome.includes('sectionTabsHTML()'), 'fan home carries the strip');
  assert.ok(fanHome.includes("wireSectionTabs(() => show('fanModels', {}))"), 'fan-home tabs re-render the home');
  // directory reads carry the tab — directory + lives, one mechanism
  const apiFn = sliceFn(appSrc, 'async function api(path, opts)', '\n}\n');
  assert.ok(apiFn.includes("path === '/models' || path === '/live' || path === '/live/schedule'"), 'tab rides the three directory reads');
  assert.ok(apiFn.includes("path += '?tab=' + browseTab;"), 'tab passed as ?tab=');
  // NO chooser, NO settings control (owner's simplification)
  assert.ok(!appSrc.includes('browse_q'), 'no "what are you here to see" chooser');
  assert.ok(!appSrc.includes('storefront-card'), 'no Settings storefront card — the tabs do the job');
});

test('filtering: the server-side section map is exactly the spec map, default is the Female set', () => {
  const SETS = JSON.parse(JSON.stringify(evalConst(serverSrc, 'const SECTION_SETS =')));
  assert.deepEqual(SETS, {
    female: ['female', 'couple'],
    male: ['male', 'couple'],
    couples: ['couple'],
    all: ['female', 'male', 'couple'],
  }, 'tab → sections map (couples ride BOTH the Female and Male storefronts)');
  assert.ok(serverSrc.includes('const DEFAULT_BROWSE_SET = SECTION_SETS.female;'), 'no tab specified = the Female set');
  const eff = sliceFn(serverSrc, 'function effectiveBrowseSet', '\n}\n');
  // PIN CORRECTION (Oct 19 2026, owner's explicit ruling — supersedes
  // the Phase 1 pin "models/admins browse unfiltered"): after a
  // male-section model leaked onto the house model's home grid, the
  // owner ruled his model home IS a front page ("I don't want males
  // on my store front" / "I don't see sections"). The helper now
  // filters EVERY viewer; the regression suite is
  // tests/model-home-section-filter.test.js.
  assert.ok(!eff.includes('return null'), 'no unfiltered return — every viewer is tab-filtered (owner ruling, Oct 19 2026)');
  assert.ok(!eff.includes('viewerRoleOf'), 'the browse set no longer depends on the viewer role');
  assert.ok(eff.includes('req.query.tab'), 'the tab comes from the request — nothing is stored or remembered');
  const models = sliceFn(serverSrc, "app.get('/api/models',", '// Fan likes/unlikes a model');
  assert.ok(models.includes('m.section,'), 'roster query carries the section');
  assert.ok(models.includes('const bset = effectiveBrowseSet(req);'), 'directory filters by the effective set');
  assert.ok(models.includes("bset.includes(r.section || 'female')"), 'filter keeps only the tab’s sections');
  const live = sliceFn(serverSrc, "app.get('/api/live',", '// Fan joins as a free viewer');
  assert.ok(live.includes('mo.section AS model_section'), 'lives query carries the section');
  assert.ok(live.includes('bset.includes(r.model_section'), 'lives list filters by the same set');
  const sched = sliceFn(serverSrc, "app.get('/api/live/schedule',", "app.get('/api/live/:id'");
  assert.ok(sched.includes('m.section AS model_section'), 'schedule query carries the section');
  assert.ok(sched.includes('bsetS.includes(sectionOf.get(u.model_id)'), 'schedule filters by the same set');
  // SEO scope: public index + sitemap list Female + Couple only
  assert.ok(serverSrc.includes("seoPublicModels().filter((m) => m.section !== 'male')"), 'index + sitemap exclude the male section');
  const seo = sliceFn(serverSrc, 'function seoPublicModels()', 'const seoTagSlug');
  assert.ok(seo.includes("section: r.section || 'female'"), 'SEO rows carry their section');
});

/* --------------------------- static pins: the new-model bell --------------------------- */

test('server: new-model bell — SRV copy ×13 incl. section names, route + section read from the recorded books', () => {
  const SRV = evalConst(serverSrc, 'const SRV =');
  for (const k of ['bell_new_model_title', 'bell_new_model_body_direct', 'bell_new_model_body_invite', 'bell_new_model_body_referral',
    'bell_section_female', 'bell_section_male', 'bell_section_couple']) {
    assert.deepEqual(Object.keys(SRV[k]).sort(), [...LANG13].sort(), `${k} covers 13 languages`);
    for (const lang of LANG13) assert.ok(SRV[k][lang].trim().length > 0, `${k}:${lang} non-empty`);
  }
  assert.equal(SRV.bell_section_female.en, 'Female');
  assert.equal(SRV.bell_section_male.en, 'Male');
  assert.equal(SRV.bell_section_couple.en, 'Couple');
  for (const k of ['bell_new_model_body_direct', 'bell_new_model_body_invite', 'bell_new_model_body_referral']) {
    assert.ok(SRV[k].en.includes('{section}'), `${k}: EN body names the section`);
    assert.ok(SRV[k].en.includes('joined the {section} section'), `${k}: EN shape is "joined the {section} section …"`);
  }
  assert.ok(SRV.bell_new_model_body_referral.en.includes('{recruiter_name}') && SRV.bell_new_model_body_referral.en.includes('{recruiter_username}'),
    'referral body carries the recruiter placeholders');
  const fn = sliceFn(serverSrc, 'function bellAdminsNewModel', '\n}\n');
  assert.ok(fn.includes("SELECT id, language FROM users WHERE role = 'admin'"), 'recipients: every admin in his own language — the suggestion-bell mechanism');
  assert.ok(fn.includes('SELECT recruiter_id, section FROM models WHERE user_id = ?'), 'route AND section read back from the recorded books, never the request');
  assert.ok(fn.includes("srv('bell_section_' + section, a.language)"), 'the section name is spoken in the admin’s language');
  assert.ok(fn.includes("notifyUser(a.id, 'new_model'"), 'one bell per admin, type new_model');
  assert.ok(fn.includes('`/#m/${username}`'), 'bell links at her in-app profile');
  assert.ok(signupHandler.includes('bellAdminsNewModel(id,'), 'signup handler fires the bell');
  const bellIdx = signupHandler.indexOf('bellAdminsNewModel(id,');
  const attrIdx = signupHandler.indexOf('UPDATE models SET recruiter_id = ? WHERE user_id = ?');
  assert.ok(attrIdx !== -1 && bellIdx > attrIdx, 'bell fires after the attribution is recorded');
  const gateIdx = signupHandler.lastIndexOf("if (finalRole === 'model') {", bellIdx);
  assert.ok(gateIdx !== -1 && bellIdx - gateIdx < 80, 'bell gated to finalRole model (fans/affiliates never bell)');
  const router = sliceFn(appSrc, 'function routeNotifTap', "app.querySelectorAll('[data-notif]')");
  assert.ok(router.includes('#m\\/'), 'notif router matches the /#m/<username> profile link');
  assert.ok(router.includes('openModelPeek'), 'tap opens her in-app profile card');
});

/* --------------------------- functional harness --------------------------- */

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}
function makeCopy(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `slutcamp-${tag}-`));
  for (const d of ['server.js', 'package.json', 'lib', 'public', 'data']) {
    fs.cpSync(path.join(REPO, d), path.join(dir, d), { recursive: true });
  }
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  return dir;
}
async function boot(dir, extraEnv = {}) {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), CRYPTO_POLL_MS: '3600000', ...extraEnv };
  for (const k of Object.keys(env)) {
    if (/^(CCBILL_|CRYPTO_|OPENAI_|TWILIO_|VAPID_|WEBAUTHN_|AV_)/.test(k)) delete env[k];
  }
  if (!('SEED_DEMO' in extraEnv)) delete env.SEED_DEMO;
  const child = spawn(process.execPath, ['server.js'], { cwd: dir, env });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode})\n${log}`);
    try {
      const r = await fetch(base + '/api/health');
      if (r.ok) break;
    } catch (e) { /* not up yet */ }
    if (Date.now() > deadline) { child.kill('SIGKILL'); throw new Error(`server did not come up\n${log}`); }
    await new Promise((r) => setTimeout(r, 150));
  }
  return { child, base, log: () => log };
}
function stop(h) {
  if (h && h.child && h.child.exitCode === null) h.child.kill('SIGKILL');
}
async function req(base, method, p, { body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = 'Bearer ' + token;
  const r = await fetch(base + p, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
  return { status: r.status, text, json };
}
function openDb(dir, readOnly = true) {
  const __db = new DatabaseSync(path.join(dir, 'wogent-chat.db'), readOnly ? { readOnly: true } : {});
  __db.exec('PRAGMA busy_timeout = 10000');
  return __db;
}
const signupModel = (base, username, display, extra = {}) => req(base, 'POST', '/api/auth/signup', {
  body: { username, password: 'hunter22', role: 'model', display_name: display, dob: '1996-03-03', agree18: true, ...extra },
});

/* --------------------------- live: register enforcement --------------------------- */

test('live: model register refused without a valid section on every door; attestation + section recorded; attribution intact for male + couple', { timeout: 300000 }, async () => {
  const dir = makeCopy('secreg');
  let h = null;
  try {
    h = await boot(dir, { SEED_DEMO: '1' });
    // 1) No section at all — the router bypass attempt — refused, and
    //    the same username succeeds the moment a section is declared.
    const noPick = await signupModel(h.base, 'secgal', 'Sec Gal');
    assert.equal(noPick.status, 400, `model without section refused: ${noPick.text}`);
    assert.equal(noPick.json.error, 'must_declare_section');
    // The dead field from the refused build buys nothing.
    const deadField = await signupModel(h.base, 'secgal', 'Sec Gal', { agree_female: true });
    assert.equal(deadField.status, 400, 'agree_female no longer exists as a key — still refused');
    assert.equal(deadField.json.error, 'must_declare_section');
    // A bogus section is refused too.
    const bogus = await signupModel(h.base, 'secgal', 'Sec Gal', { section: 'bogus' });
    assert.equal(bogus.status, 400, 'invalid section refused');
    const withPick = await signupModel(h.base, 'secgal', 'Sec Gal', { section: 'female' });
    assert.equal(withPick.status, 200, `same username registers once she declares: ${withPick.text}`);
    // 2) A male model registers through his own door now.
    const guy = await signupModel(h.base, 'secguy', 'Sec Guy', { section: 'male' });
    assert.equal(guy.status, 200, `male model signup succeeds: ${guy.text}`);
    // 3) Fan + affiliate signups carry no section anywhere — unchanged.
    const fan = await req(h.base, 'POST', '/api/auth/signup', {
      body: { username: 'secfan', password: 'hunter22', role: 'fan', display_name: 'Sec Fan', dob: '1996-03-03', agree18: true },
    });
    assert.equal(fan.status, 200, `fan signup needs no section: ${fan.text}`);
    const aff = await req(h.base, 'POST', '/api/affiliate/signup', {
      body: { username: 'secaff', password: 'hunter22', display_name: 'Sec Aff', agreed: true },
    });
    assert.equal(aff.status, 200, `affiliate signup untouched: ${aff.text}`);
    const affId = aff.json.user.id;
    stop(h); h = null;

    let db = openDb(dir);
    const secOf = (u) => db.prepare('SELECT section FROM models WHERE user_id = (SELECT id FROM users WHERE username = ?)').get(u).section;
    assert.equal(secOf('secgal'), 'female', 'her declared section landed on her model row');
    assert.equal(secOf('secguy'), 'male', 'his declared section landed on his model row');
    const gal = db.prepare("SELECT section_attested_at, section_attested_ip, age_attested_at FROM users WHERE username = 'secgal'").get();
    assert.ok(gal.section_attested_at, 'model: section_attested_at recorded');
    assert.ok(gal.section_attested_ip && gal.section_attested_ip.length > 0, 'model: attesting IP recorded');
    assert.ok(gal.age_attested_at, 'model: 18+ attestation recorded alongside');
    const fanRow = db.prepare("SELECT section_attested_at FROM users WHERE username = 'secfan'").get();
    assert.equal(fanRow.section_attested_at, null, 'fan: no section attestation (field does not apply)');
    // Migration default: a pre-sections seed model is 'female' and was
    // never asked to attest anything.
    assert.equal(secOf('bunny'), 'female', 'pre-sections rows default to the female section');
    const bunnyAtt = db.prepare("SELECT section_attested_at FROM users WHERE username = 'bunny'").get();
    assert.equal(bunnyAtt.section_attested_at, null, 'seed models carry no attestation');
    const recRow = db.prepare('SELECT id, referral_code FROM recruiters WHERE user_id = ?').get(affId);
    const adminId = db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
    db.close();
    const wdb = openDb(dir, false);
    wdb.prepare("INSERT INTO invite_links (code, label, role, created_by, expires_at) VALUES ('secinvite1', 'Sec test', 'model', ?, datetime('now', '+6 hours'))").run(adminId);
    wdb.close();

    h = await boot(dir, { SEED_DEMO: '1' });
    // 4) The invite door: even a valid Manager invite cannot register
    //    a model without the declaration; with it, her section lands.
    const invNoPick = await req(h.base, 'POST', '/api/auth/signup', {
      body: { username: 'secinvcpl', password: 'hunter22', display_name: 'Sec Inv Couple', dob: '1997-07-07', agree18: true, invite_code: 'secinvite1' },
    });
    assert.equal(invNoPick.status, 400, 'invite door refuses without a section');
    assert.equal(invNoPick.json.error, 'must_declare_section');
    const invPick = await req(h.base, 'POST', '/api/auth/signup', {
      body: { username: 'secinvcpl', password: 'hunter22', display_name: 'Sec Inv Couple', dob: '1997-07-07', agree18: true, section: 'couple', invite_code: 'secinvite1' },
    });
    assert.equal(invPick.status, 200, `invite join with a section registers: ${invPick.text}`);
    // 5) The referral door: a MALE signup via an affiliate link is
    //    attributed to the recruiter exactly as a female one is.
    const linkGuy = await signupModel(h.base, 'seclinkguy', 'Sec Link Guy', { section: 'male', referral_code: recRow.referral_code });
    assert.equal(linkGuy.status, 200, `male referral-link signup: ${linkGuy.text}`);
    const linkGuyId = linkGuy.json.user.id;
    //    …and a COUPLE signup via the same link.
    const linkCpl = await signupModel(h.base, 'seclinkcpl', 'Sec Link Couple', { section: 'couple', referral_code: recRow.referral_code });
    assert.equal(linkCpl.status, 200, `couple referral-link signup: ${linkCpl.text}`);
    const linkCplId = linkCpl.json.user.id;
    stop(h); h = null;

    db = openDb(dir);
    assert.equal(secOf('secinvcpl'), 'couple', 'invite-door couple: section landed');
    const attrGuy = db.prepare('SELECT recruiter_id FROM models WHERE user_id = ?').get(linkGuyId);
    assert.equal(attrGuy.recruiter_id, recRow.id, 'male referral signup: recruiter attribution intact');
    const attrCpl = db.prepare('SELECT recruiter_id FROM models WHERE user_id = ?').get(linkCplId);
    assert.equal(attrCpl.recruiter_id, recRow.id, 'couple referral signup: recruiter attribution intact');
    const guyAtt = db.prepare('SELECT section_attested_at FROM users WHERE id = ?').get(linkGuyId);
    assert.ok(guyAtt.section_attested_at, 'referral-door male signup recorded the attestation too');
    db.close();
  } finally {
    stop(h);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* --------------------------- live: filtering matrix + lives + schedule + SEO --------------------------- */

test('live: filtering matrix — tabs, roles, the storefront invariant, lives, schedule, SEO', { timeout: 300000 }, async () => {
  const dir = makeCopy('secfilter');
  let h = null;
  try {
    h = await boot(dir, { SEED_DEMO: '1' });
    assert.equal((await signupModel(h.base, 'secgalf', 'Sec Gal F', { section: 'female' })).status, 200);
    assert.equal((await signupModel(h.base, 'secguym', 'Sec Guy M', { section: 'male' })).status, 200);
    assert.equal((await signupModel(h.base, 'seccpl', 'Sec Couple', { section: 'couple' })).status, 200);
    assert.equal((await signupModel(h.base, 'asceaaspade', 'SlutCamp', { section: 'female' })).status, 200, 'house account up');
    const fanTok = (await req(h.base, 'POST', '/api/auth/login', { body: { username: 'fandemo', password: 'fan123' } })).json.token;
    const adminTok = (await req(h.base, 'POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' } })).json.token;
    const galTok = (await req(h.base, 'POST', '/api/auth/login', { body: { username: 'secgalf', password: 'hunter22' } })).json.token;
    assert.ok(fanTok && adminTok && galTok, 'logins for fan/admin/model viewers');

    const roster = async (p, token) => {
      const r = await req(h.base, 'GET', p, token ? { token } : {});
      assert.equal(r.status, 200, `GET ${p}: ${r.text.slice(0, 120)}`);
      return r.json;
    };
    const names = (j) => j.models.map((m) => m.username);
    const sectionsOf = (j) => [...new Set(j.models.map((m) => m.section))].sort();

    // --- the directory matrix (guest view unless noted) ---
    let j = await roster('/api/models');
    assert.ok(names(j).includes('secgalf') && names(j).includes('seccpl'), 'default: female + couple visible');
    assert.ok(!names(j).includes('secguym'), 'STOREFRONT INVARIANT: no tab specified → zero solo males for a guest');
    assert.deepEqual(sectionsOf(j), ['couple', 'female'], 'default payload sections are exactly {female, couple}');
    assert.ok(j.official && j.official.username === 'asceaaspade', 'the official house object travels as today');
    j = await roster('/api/models?tab=female');
    assert.ok(!names(j).includes('secguym'), 'Female tab: no solo males');
    assert.ok(names(j).includes('seccpl'), 'Female tab: couples ride the Female storefront');
    j = await roster('/api/models?tab=male');
    assert.ok(names(j).includes('secguym') && names(j).includes('seccpl'), 'Male tab: male + couple (couples ride BOTH storefronts)');
    assert.ok(!names(j).includes('secgalf'), 'Male tab: no solo females');
    assert.deepEqual(sectionsOf(j), ['couple', 'male'], 'Male tab sections are exactly {male, couple}');
    assert.ok(j.official, 'official still travels behind the Male tab');
    j = await roster('/api/models?tab=couples');
    assert.deepEqual(sectionsOf(j), ['couple'], 'Couples tab: couples only');
    j = await roster('/api/models?tab=all');
    assert.deepEqual(sectionsOf(j), ['couple', 'female', 'male'], 'All tab: everything');
    j = await roster('/api/models?tab=bogus');
    assert.ok(!names(j).includes('secguym'), 'a bogus tab falls back to the Female set — never males by accident');
    // --- logged-in fan: entry is the Female set too; his taps rule ---
    j = await roster('/api/models', fanTok);
    assert.ok(!names(j).includes('secguym'), 'fan entry view: zero solo males (lands on Female)');
    j = await roster('/api/models?tab=male', fanTok);
    assert.ok(names(j).includes('secguym'), 'fan behind an explicit Male tap sees the male section');
    // --- models + app-side admins: SAME tab filter as fans ---
    // PIN CORRECTION (Oct 19 2026, owner's explicit ruling —
    // supersedes the Phase 1 "models + admins browse unfiltered"
    // assertions that stood here): a male-section model leaked onto
    // the house model's home grid + New Models rail, and the owner
    // ruled his model home IS a front page ("I don't want males on
    // my store front"). Every viewer of /api/models is tab-filtered;
    // the only unfiltered roster left is the Manager's /api/admin/*
    // (X-Manager) surface. Guest/fan/SEO invariants above are
    // unchanged and unweakened.
    j = await roster('/api/models', galTok);
    assert.deepEqual(sectionsOf(j), ['couple', 'female'], 'model viewer, no tab: the Female set — zero solo males on her home');
    assert.ok(!names(j).includes('secguym'), 'model viewer default: the male model is NOT in her payload');
    j = await roster('/api/models?tab=male', galTok);
    assert.deepEqual(sectionsOf(j), ['couple', 'male'], 'model viewer behind an explicit Male tap: male + couple');
    j = await roster('/api/models?tab=all', galTok);
    assert.deepEqual(sectionsOf(j), ['couple', 'female', 'male'], 'model viewer behind an explicit All tap: everything');
    j = await roster('/api/models', adminTok);
    assert.deepEqual(sectionsOf(j), ['couple', 'female'], 'app-side admin token, no tab: the Female set on the public directory');
    j = await roster('/api/models?tab=all', adminTok);
    assert.deepEqual(sectionsOf(j), ['couple', 'female', 'male'], 'app-side admin token behind All: everything');

    // --- lives follow the same sets ---
    // Going live requires an approved ID verification (the platform's
    // hard checkpoint) — approve both models directly in the DB, the
    // same surgery other suites perform.
    const vdb = openDb(dir, false);
    for (const u of ['secgalf', 'secguym']) {
      const uid = vdb.prepare('SELECT id FROM users WHERE username = ?').get(u).id;
      vdb.prepare("INSERT INTO id_verifications (model_id, status) VALUES (?, 'approved')").run(uid);
    }
    vdb.close();
    const guyTok = (await req(h.base, 'POST', '/api/auth/login', { body: { username: 'secguym', password: 'hunter22' } })).json.token;
    assert.equal((await req(h.base, 'POST', '/api/live/start', { body: { title: 'Guy live' }, token: guyTok })).status, 200, 'male model goes live');
    assert.equal((await req(h.base, 'POST', '/api/live/start', { body: { title: 'Gal live' }, token: galTok })).status, 200, 'female model goes live');
    const liveNames = async (p) => (await roster(p)).live.map((l) => l.model_name).sort();
    assert.deepEqual(await liveNames('/api/live'), ['Sec Gal F'], 'lives, no tab: only her show — his is not on the storefront');
    assert.deepEqual(await liveNames('/api/live?tab=male'), ['Sec Guy M'], 'lives behind the Male tab: his show');
    assert.deepEqual(await liveNames('/api/live?tab=couples'), [], 'lives behind the Couples tab: no couple is live');
    assert.deepEqual(await liveNames('/api/live?tab=all'), ['Sec Gal F', 'Sec Guy M'], 'lives behind All: both shows');
    stop(h); h = null;

    // --- schedule: seed weekly slots for the male + couple models ---
    const wdb = openDb(dir, false);
    const idOf = (u) => wdb.prepare('SELECT id FROM users WHERE username = ?').get(u).id;
    for (const u of ['secguym', 'seccpl']) {
      for (let d = 0; d < 7; d++) {
        wdb.prepare('INSERT INTO live_schedule (model_id, day_of_week, start_time, title) VALUES (?,?,?,?)').run(idOf(u), d, '23:59', 'Late show');
        wdb.prepare('INSERT INTO live_schedule (model_id, day_of_week, start_time, title) VALUES (?,?,?,?)').run(idOf(u), d, '00:01', 'Early show');
      }
    }
    wdb.close();
    h = await boot(dir, { SEED_DEMO: '1' });
    const schedNames = async (p) => [...new Set((await roster(p)).upcoming.map((u) => u.model_name))].sort();
    assert.deepEqual(await schedNames('/api/live/schedule'), ['Sec Couple'], 'schedule, no tab: the couple’s slots, never the male’s');
    assert.deepEqual(await schedNames('/api/live/schedule?tab=male'), ['Sec Couple', 'Sec Guy M'], 'schedule behind Male: both');
    assert.deepEqual(await schedNames('/api/live/schedule?tab=couples'), ['Sec Couple'], 'schedule behind Couples: couples only');

    // --- SEO surfaces: the public index never lists a solo male ---
    const page = async (p) => {
      const r = await fetch(h.base + p);
      return { status: r.status, text: await r.text() };
    };
    const idx = await page('/models');
    assert.equal(idx.status, 200);
    assert.ok(idx.text.includes('Sec Gal F') && idx.text.includes('Sec Couple'), 'SEO index lists female + couple');
    assert.ok(!idx.text.includes('Sec Guy M') && !idx.text.includes('secguym'), 'STOREFRONT INVARIANT: SEO index has zero solo males');
    const sm = await page('/sitemap.xml');
    assert.ok(sm.text.includes('/models/secgalf') && sm.text.includes('/models/seccpl'), 'sitemap lists female + couple pages');
    assert.ok(!sm.text.includes('/models/secguym'), 'STOREFRONT INVARIANT: sitemap has no male-section page');
    const his = await page('/models/secguym');
    assert.equal(his.status, 200, 'his individual page still serves (unchanged)');
    assert.ok(his.text.includes('Sec Guy M'), 'individual male page renders his profile');
    stop(h); h = null;
  } finally {
    stop(h);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* --------------------------- live: contract v1.5 + re-sign --------------------------- */

test('live: contract serves v1.5 with the §15 section clause; a v1.4 signature reads unsigned until re-sign', { timeout: 240000 }, async () => {
  const dir = makeCopy('seccontract');
  let h = null;
  try {
    h = await boot(dir, { SEED_DEMO: '1' });
    const login = await req(h.base, 'POST', '/api/auth/login', { body: { username: 'bunny', password: 'model123' } });
    assert.equal(login.status, 200);
    const tok = login.json.token;
    let c = await req(h.base, 'GET', '/api/model/contract', { token: tok });
    assert.equal(c.json.version, '1.5', 'current version is 1.5');
    assert.equal(c.json.sections.length, 16, '16 sections served');
    assert.equal(c.json.sections[14].title, '15. Your Section & Who May Appear', '§15 is the section clause');
    assert.ok(c.json.sections[14].body.includes('ID-verified co-performers'), 'clause served in the text');
    assert.ok(!c.json.sections[14].body.includes('women only'), 'no women-only text served');
    assert.equal(c.json.signed, false, 'bunny has not signed v1.5 yet');
    const sign = await req(h.base, 'POST', '/api/model/contract/sign', { token: tok, body: { display_name: 'Bunny' } });
    assert.equal(sign.status, 200, `sign works: ${sign.text}`);
    assert.equal(sign.json.version, '1.5');
    c = await req(h.base, 'GET', '/api/model/contract', { token: tok });
    assert.equal(c.json.signed, true, 'signed at the current version');
    stop(h); h = null;
    const wdb = openDb(dir, false);
    wdb.prepare("UPDATE contract_signatures SET contract_version = '1.4' WHERE user_id = (SELECT id FROM users WHERE username = 'bunny')").run();
    wdb.close();
    h = await boot(dir, { SEED_DEMO: '1' });
    const login2 = await req(h.base, 'POST', '/api/auth/login', { body: { username: 'bunny', password: 'model123' } });
    const tok2 = login2.json.token;
    c = await req(h.base, 'GET', '/api/model/contract', { token: tok2 });
    assert.equal(c.json.signed, false, 'a v1.4 signer reads signed:false under v1.5');
    assert.equal(c.json.signed_version, '1.4', 'her old signature is still on record');
    const resign = await req(h.base, 'POST', '/api/model/contract/sign', { token: tok2, body: { display_name: 'Bunny' } });
    assert.equal(resign.status, 200);
    c = await req(h.base, 'GET', '/api/model/contract', { token: tok2 });
    assert.equal(c.json.signed, true, 're-sign at v1.5 restores signed status');
    stop(h); h = null;
  } finally {
    stop(h);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* --------------------------- live: both announcements --------------------------- */

test('live: v1.5 announcement reaches models only; storefront announcement reaches fans only; each exactly once, localized', { timeout: 300000 }, async () => {
  const SRV = evalConst(serverSrc, 'const SRV =');
  const dir = makeCopy('secann');
  let h = null;
  try {
    // Boot 1: seeds exist but there is NO house account — both
    // announcements must hold (stamps unset) until the official
    // thread can exist.
    h = await boot(dir, { SEED_DEMO: '1' });
    stop(h); h = null;
    let db = openDb(dir);
    let stamps = db.prepare('SELECT agreement_15_announced_at, storefront_announced_at FROM platform_stats WHERE id = 1').get();
    assert.ok(!stamps.agreement_15_announced_at, 'no house account → agreement announcement held');
    assert.ok(!stamps.storefront_announced_at, 'no house account → storefront announcement held');
    db.close();
    // Create the house account through the (now routed) model signup.
    h = await boot(dir, { SEED_DEMO: '1' });
    const house = await signupModel(h.base, 'asceaaspade', 'SlutCamp', { section: 'female' });
    assert.equal(house.status, 200, `house account created: ${house.text}`);
    const houseId = house.json.user.id;
    stop(h); h = null;
    // Boot 3: both announcements fire.
    h = await boot(dir, { SEED_DEMO: '1' });
    stop(h); h = null;
    db = openDb(dir);
    stamps = db.prepare('SELECT agreement_15_announced_at, storefront_announced_at FROM platform_stats WHERE id = 1').get();
    assert.ok(stamps.agreement_15_announced_at, 'agreement stamp set');
    assert.ok(stamps.storefront_announced_at, 'storefront stamp set');
    const dmCount = (userId, body) => db.prepare(
      `SELECT COUNT(*) AS c FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE c.fan_id = ? AND c.model_id = ? AND c.is_official = 1 AND m.sender_id = ? AND m.body = ?`
    ).get(userId, houseId, houseId, body).c;
    const bellCount = (userId, type) => db.prepare(
      'SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND type = ?').get(userId, type).c;
    const models = db.prepare("SELECT id, username FROM users WHERE role = 'model' AND id != ?").all(houseId);
    assert.ok(models.length >= 3, 'seed models are agreement recipients');
    for (const m of models) {
      assert.equal(dmCount(m.id, SRV.ann_agreement_15_dm.en), 1, `${m.username} got exactly one EN agreement DM in her official thread`);
      assert.equal(bellCount(m.id, 'agreement_15'), 1, `${m.username} got the agreement_15 bell`);
      assert.equal(bellCount(m.id, 'storefront'), 0, `${m.username} (a model) got NO storefront bell — fans only`);
      assert.equal(dmCount(m.id, SRV.ann_storefront_dm.en), 0, `${m.username} got no storefront DM`);
    }
    const fan = db.prepare("SELECT id, username FROM users WHERE role = 'fan' LIMIT 1").get();
    assert.equal(dmCount(fan.id, SRV.ann_storefront_dm.en), 1, `${fan.username} got exactly one EN storefront DM in his official thread`);
    const fanBell = db.prepare("SELECT title, body, link FROM notifications WHERE user_id = ? AND type = 'storefront'").get(fan.id);
    assert.ok(fanBell, 'the fan got the storefront bell');
    assert.equal(fanBell.title, SRV.ann_storefront_bell_title.en, 'fan bell title is the EN SRV copy');
    assert.equal(fanBell.body, SRV.ann_storefront_bell_body.en, 'fan bell body is the EN SRV copy');
    const fanConv = db.prepare('SELECT id FROM conversations WHERE fan_id = ? AND model_id = ? AND is_official = 1').get(fan.id, houseId);
    assert.equal(fanBell.link, `/#chat/${fanConv.id}`, 'fan bell opens his official thread itself');
    assert.equal(bellCount(fan.id, 'agreement_15'), 0, 'fans receive no agreement announcement');
    assert.equal(dmCount(houseId, SRV.ann_storefront_dm.en), 0, 'the house account itself gets nothing');
    db.close();
    // Boot 4: no re-send of either.
    h = await boot(dir, { SEED_DEMO: '1' });
    stop(h); h = null;
    db = openDb(dir);
    const bunny = db.prepare("SELECT id FROM users WHERE username = 'bunny'").get();
    assert.equal(dmCount(bunny.id, SRV.ann_agreement_15_dm.en), 1, 'agreement: no re-send on the next boot');
    assert.equal(dmCount(fan.id, SRV.ann_storefront_dm.en), 1, 'storefront: no re-send on the next boot');
    db.close();
    // Localization: bunny + the fan switch to Spanish, both stamps and
    // the first round are cleared — each gets the Spanish copy of
    // THEIR announcement next boot, and not the other's.
    const wdb = openDb(dir, false);
    wdb.prepare("UPDATE users SET language = 'es' WHERE username = 'bunny' OR id = ?").run(fan.id);
    wdb.prepare('UPDATE platform_stats SET agreement_15_announced_at = NULL, storefront_announced_at = NULL WHERE id = 1').run();
    wdb.prepare("DELETE FROM notifications WHERE type IN ('agreement_15', 'storefront')").run();
    wdb.prepare('DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE is_official = 1)').run();
    wdb.close();
    h = await boot(dir, { SEED_DEMO: '1' });
    stop(h); h = null;
    db = openDb(dir);
    assert.equal(dmCount(bunny.id, SRV.ann_agreement_15_dm.es), 1, 'bunny got the agreement announcement in her stored Spanish');
    assert.equal(dmCount(fan.id, SRV.ann_storefront_dm.es), 1, 'the fan got the storefront announcement in his stored Spanish');
    assert.equal(dmCount(fan.id, SRV.ann_agreement_15_dm.es), 0, 'the fan still gets no agreement DM');
    assert.equal(dmCount(bunny.id, SRV.ann_storefront_dm.es), 0, 'bunny still gets no storefront DM');
    db.close();
  } finally {
    stop(h);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* --------------------- the new-model admin bell --------------------- */

test('live: new-model bell — exactly one per model signup, section × route named, fans/affiliates silent', { timeout: 300000 }, async () => {
  const SRV = evalConst(serverSrc, 'const SRV =');
  const fill = (tpl, vars) => Object.entries(vars).reduce((s, [k, v]) => s.split(`{${k}}`).join(v), tpl);
  const dir = makeCopy('secbell');
  let h = null;
  try {
    h = await boot(dir, { SEED_DEMO: '1' });
    // 1) Direct FEMALE signup → one bell naming the Female section.
    const direct = await signupModel(h.base, 'bellgal', 'Bell Gal', { section: 'female' });
    assert.equal(direct.status, 200, `direct female signup: ${direct.text}`);
    // 2) A fan signup → no bell (asserted by the final count).
    const fan = await req(h.base, 'POST', '/api/auth/signup', {
      body: { username: 'bellfan', password: 'hunter22', role: 'fan', display_name: 'Bell Fan', dob: '1996-03-03', agree18: true },
    });
    assert.equal(fan.status, 200, `fan signup: ${fan.text}`);
    // 3) Affiliate signup (no bell either) — her link brings a MALE.
    const aff = await req(h.base, 'POST', '/api/affiliate/signup', {
      body: { username: 'bellaff', password: 'hunter22', display_name: 'Bell Aff', agreed: true },
    });
    assert.equal(aff.status, 200, `affiliate signup: ${aff.text}`);
    stop(h); h = null;

    let db = openDb(dir);
    const adminId = db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
    const affRow = db.prepare('SELECT id, referral_code FROM recruiters WHERE user_id = ?').get(aff.json.user.id);
    assert.ok(affRow && affRow.referral_code, 'affiliate carries a referral code');
    db.close();
    const wdb = openDb(dir, false);
    wdb.prepare("INSERT INTO invite_links (code, label, role, created_by, expires_at) VALUES ('bellinvite1', 'Bell test', 'model', ?, datetime('now', '+6 hours'))").run(adminId);
    wdb.close();

    h = await boot(dir, { SEED_DEMO: '1' });
    const linkGuy = await signupModel(h.base, 'bellguy', 'Bell Guy', { section: 'male', referral_code: affRow.referral_code });
    assert.equal(linkGuy.status, 200, `referral-link MALE signup: ${linkGuy.text}`);
    // 4) Invite-link COUPLE signup → the bell says Couple + invite.
    const invCpl = await req(h.base, 'POST', '/api/auth/signup', {
      body: { username: 'bellcpl', password: 'hunter22', display_name: 'Bell Couple', dob: '1998-08-08', agree18: true, section: 'couple', invite_code: 'bellinvite1' },
    });
    assert.equal(invCpl.status, 200, `invite-link COUPLE signup: ${invCpl.text}`);
    stop(h); h = null;

    db = openDb(dir);
    const bells = db.prepare("SELECT title, body, link FROM notifications WHERE user_id = ? AND type = 'new_model' ORDER BY id").all(adminId);
    assert.equal(bells.length, 3, 'exactly one bell per model signup — 3 model signups, and the fan + affiliate signups added none');
    assert.equal(bells[0].title, SRV.bell_new_model_title.en, 'bell title is the SRV copy');
    assert.equal(bells[0].body, fill(SRV.bell_new_model_body_direct.en, { username: 'bellgal', name: 'Bell Gal', section: 'Female' }),
      'direct signup: body names her AND the Female section');
    assert.equal(bells[0].link, '/#m/bellgal', 'bell links at her profile');
    assert.equal(bells[1].body, fill(SRV.bell_new_model_body_referral.en, { username: 'bellguy', name: 'Bell Guy', section: 'Male', recruiter_name: 'Bell Aff', recruiter_username: 'bellaff' }),
      'affiliate-link signup: body names the Male section AND the recruiter whose link he used');
    assert.equal(bells[1].link, '/#m/bellguy');
    assert.equal(bells[2].body, fill(SRV.bell_new_model_body_invite.en, { username: 'bellcpl', name: 'Bell Couple', section: 'Couple' }),
      'invite-link signup: body names the Couple section and the invite route');
    assert.equal(bells[2].link, '/#m/bellcpl');
    const others = db.prepare("SELECT COUNT(*) AS c FROM notifications WHERE type = 'new_model' AND user_id != ?").get(adminId).c;
    assert.equal(others, 0, 'new_model bells go to admins only — the new models themselves get none');
    db.close();
  } finally {
    stop(h);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
