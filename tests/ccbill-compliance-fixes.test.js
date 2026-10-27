'use strict';
/*
 * CCBill compliance fix package (2026-10-27) — pins the seven items
 * from Compliance's initial review of merchant account 955730:
 *   1. Model Agreement §3/§6/§7 amended (depicted-person verification,
 *      written-consent duty, illegal/Standards prohibition) in EN +
 *      all 12 presentations; CONTRACT_VERSION bumped so the sign door
 *      re-arms. NOTE: the spec assumed 1.4 -> 1.5, but production was
 *      already at 1.5, so the bump is 1.5 -> 1.6 (a bump to the SAME
 *      version would not force a re-sign).
 *   2. Signup publicity consent: distinct required checkbox on the
 *      model join flow; the register door refuses without it and
 *      stamps users.publicity_consent_at + IP; legacy models meet a
 *      one-time consent door before their next media upload.
 *   3+4. Complaints & Content Removal policy: its own legal page in
 *      all 13 languages, linked from the server-rendered public
 *      footer and the in-app Terms link row, carrying the CCBill
 *      complaint-form link (rel="nofollow", exact URL + anchor) and
 *      the depicted-person appeals promise (removal ASAP; disputes
 *      resolved by a neutral body at the merchant's expense).
 *   5+6+7. Fan Terms §14 (the true next number — §13 is the
 *      anti-trafficking section): pre-screening, livestream
 *      monitoring, and the prohibited-content sentence naming rape,
 *      incest, bestiality and minors. Terms redated October 27, 2026.
 *
 * Static pins read the shipped files; live checks boot the real
 * server (same harness as tests/storefront-sections.test.js).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const REPO = path.join(__dirname, '..');
const SERVER_JS = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
const APP_JS = fs.readFileSync(path.join(REPO, 'public', 'js', 'app.js'), 'utf8');
const LANGS12 = ['es', 'pt', 'fr', 'de', 'ru', 'ja', 'zh', 'ko', 'it', 'pl', 'nl', 'tr'];
const CCBILL_URL = 'https://www.ccbillcomplaintform.com/ccbill/form/CCBillContentRemovalRequest1/formperma/sBK2jfIoZWAFw2hRRt5Rv2PQncscFzpvOH6bPcwopas';

/* The verbatim English masters from the compliance spec. */
const MASTER_A = "The same verification applies to every person who appears in your content: before any content featuring another person is uploaded or performed, you must verify that person's identity and age from their government-issued photo ID, confirm they are at least 18, and keep the supporting documents on record. You must provide those documents to the Company on request. No person may appear in your content until this verification is complete.";
const MASTER_B = "For every person depicted in content you upload or perform, you must first obtain their written consent and keep that consent on record, covering: (a) consent to be depicted in the content; (b) consent to the public distribution of the content and to its upload to SlutCamp; and (c) where content is offered for download, consent to the content being downloaded by other users. The Company's standard performer release is the approved way to record this consent, and a completed release (with ID verification) must be on file for every co-performer before they appear.";
const MASTER_C = 'You must not engage in any activity on the platform that is illegal or that otherwise violates the Standards — the acceptable-use standards of the Company and its payment processors.';
const MASTER_D = 'I acknowledge and agree that my content, images, and likeness will be used and displayed publicly on the website.';
const MASTER_F_TITLE = '14. Content Screening, Monitoring & Prohibited Content';
const MASTER_F_BODY = "Every upload is screened before it is published. Uploads pass automated file and consent checks, and a model's media does not appear publicly until her ID verification is approved; media featuring co-performers stays unpublished until each depicted person's consent and ID packet is complete. Content that fails screening is not published. Livestreams are monitored, and prohibited or illegal content is taken down. Prohibited content includes any content containing rape, incest, bestiality, or minors — such content is prohibited and will be removed immediately.";

/* ---------------- extraction helpers ---------------- */

function braceSpan(s, marker) {
  const i = s.indexOf(marker);
  assert.ok(i >= 0, `marker present: ${marker}`);
  let j = s.indexOf('{', i), depth = 0, k = j, inStr = null, esc = false;
  for (; k < s.length; k++) {
    const c = s[k];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === inStr) inStr = null; continue; }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === '{') depth++;
    if (c === '}') { depth--; if (depth === 0) return [j, k + 1]; }
  }
  throw new Error('unbalanced: ' + marker);
}
function evalConst(s, marker, prelude = '') {
  const [a, b] = braceSpan(s, marker);
  return eval(`${prelude}(${s.slice(a, b)})`);
}
function stringLiterals(s, marker) {
  const out = [];
  let from = 0;
  for (;;) {
    const ki = s.indexOf(marker, from);
    if (ki < 0) break;
    let j = ki + marker.length;
    while (s[j] !== "'") j++;
    let k = j + 1, esc = false;
    for (; k < s.length; k++) {
      const c = s[k];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === "'") break;
    }
    out.push(eval(s.slice(j, k + 1)));
    from = k + 1;
  }
  return out;
}

/* ---------------- item 1: model agreement ---------------- */

test('contract: version is 1.6 and redated — the bump re-arms the sign door', () => {
  // The spec assumed 1.4 -> 1.5; production was ALREADY at 1.5, so
  // only a bump to 1.6 actually forces the re-sign the item requires.
  assert.ok(SERVER_JS.includes("const CONTRACT_VERSION = '1.6';"), 'model contract version is 1.6');
  assert.ok(!SERVER_JS.includes("const CONTRACT_VERSION = '1.5';"), 'old model version 1.5 is gone');
  assert.ok(SERVER_JS.includes("updated: 'October 27, 2026'"), 'model agreement redated October 27, 2026');
});

test('contract EN: §3 gains master A, §6 gains master B, §7 opens with master C — verbatim', () => {
  const MC = evalConst(SERVER_JS, 'const MODEL_CONTRACT =', "const CONTRACT_VERSION = '1.6';");
  assert.equal(MC.sections.length, 16, 'EN contract still has 16 sections');
  assert.ok(MC.sections[2].body.endsWith(MASTER_A), '§3 (Age & Identity Verification) ends with master A verbatim');
  assert.ok(MC.sections[5].body.endsWith(MASTER_B), '§6 (Content Rights) ends with master B verbatim');
  assert.ok(MC.sections[6].body.startsWith(MASTER_C), '§7 (Conduct Rules) opens with master C verbatim');
  assert.ok(MC.sections[6].body.includes('On the platform you must NOT:'), '§7 keeps its original prohibitions after the new first sentence');
});

test('contract translations: all 12 presentations carry the three amendments, structure unchanged', () => {
  const I18N = evalConst(SERVER_JS, 'const MODEL_CONTRACT_I18N =');
  assert.deepEqual(Object.keys(I18N).sort(), [...LANGS12].sort(), '12 translated presentations');
  const s7marker = { es: 'Estándares', pt: 'Padrões', fr: 'Normes', de: 'Standards', ru: 'Стандарты', ja: '基準', zh: '标准', ko: '기준', it: 'Standard', pl: 'Standardy', nl: 'Standaarden', tr: 'Standartları' };
  for (const lang of LANGS12) {
    const d = I18N[lang];
    assert.equal(d.sections.length, 16, `${lang}: 16 sections`);
    assert.ok(d.sections[2].body.includes('18'), `${lang}: §3 carries the verification amendment (age 18 named)`);
    assert.ok(d.sections[2].body.length > 200, `${lang}: §3 body substantially extended`);
    const s6 = d.sections[5].body.replace(/（/g, '(').replace(/）/g, ')'); // ja uses full-width parens
    for (const part of ['(a)', '(b)', '(c)']) {
      assert.ok(s6.includes(part), `${lang}: §6 consent amendment keeps clause ${part}`);
    }
    assert.ok(d.sections[6].body.includes(s7marker[lang]), `${lang}: §7 opens with the Standards prohibition`);
  }
});

/* ---------------- item 2: signup publicity consent ---------------- */

test('signup consent: register door refuses models without it and stamps it (server pins)', () => {
  assert.ok(SERVER_JS.includes("addColumnIfMissing('users', 'publicity_consent_at', 'TEXT');"), 'consent timestamp column');
  assert.ok(SERVER_JS.includes("addColumnIfMissing('users', 'publicity_consent_ip', 'TEXT');"), 'consent IP column');
  assert.ok(SERVER_JS.includes('function recordPublicityConsent(userId, req)'), 'stamp helper exists');
  const su = SERVER_JS.slice(SERVER_JS.indexOf("app.post('/api/auth/signup'"));
  const door = su.slice(0, su.indexOf('createUser('));
  assert.ok(door.includes("finalRole === 'model'"), 'the refusal is model-only');
  assert.ok(door.includes("error: 'publicity_consent_required'"), 'the register door refuses with publicity_consent_required');
  assert.ok(su.slice(0, 6000).includes('recordPublicityConsent(id, req);'), 'a successful model signup stamps the consent');
  assert.ok(SERVER_JS.includes("app.post('/api/me/publicity-consent'"), 'the one-time door endpoint exists');
  assert.ok(SERVER_JS.includes('publicity_consent_at: u.publicity_consent_at || null'), '/api/me user payload carries the stamp');
});

test('signup consent: every content-upload route sits behind the gate (server pins)', () => {
  for (const route of ['/api/model/photo', '/api/model/public-photo', '/api/model/preview-video',
    '/api/model/preview-video-2', '/api/model/gallery-photo', '/api/model/feed/photo',
    '/api/model/feed/video', '/api/model/packages/:id/photo']) {
    const line = SERVER_JS.split('\n').find((l) => l.includes(`app.post('${route}'`));
    assert.ok(line && line.includes("requireRole('model'), requirePublicityConsent"), `${route} gated before multer`);
  }
  const send = SERVER_JS.slice(SERVER_JS.indexOf("app.post('/api/media/send'"));
  assert.ok(send.slice(0, 1600).includes("error: 'publicity_consent_required'"), 'chat media send refuses unstamped models');
  assert.ok(SERVER_JS.includes('const requirePublicityConsent = (req, res, next) => {'), 'gate middleware defined');
});

test('signup consent: client shows the distinct card on every model join surface + the upload door', () => {
  assert.ok(APP_JS.includes('function pubConsentCardHTML(prefix)'), 'shared consent-card builder exists');
  assert.ok(APP_JS.includes("pubConsentCardHTML('a')"), 'generic auth form renders the card for models');
  assert.equal(APP_JS.split("pubConsentCardHTML('i')").length - 1, 2, 'invite + recruiter forms render the card');
  const en = APP_JS.slice(APP_JS.indexOf('pub_consent_body:'), APP_JS.indexOf('pub_consent_body:') + 220);
  assert.ok(en.includes(MASTER_D), 'the card carries master D verbatim (EN)');
  assert.ok(APP_JS.includes("publicity_consent: publicityConsent"), 'signup handlers send the consent flag');
  assert.ok(APP_JS.includes("api('/me/publicity-consent'"), 'the door Accept stamps via the endpoint');
  assert.ok(APP_JS.includes('function openPublicityConsentDoor()'), 'one-time door exists');
  assert.ok(APP_JS.includes('function apiUpload(path, file, field, extra)'), 'apiUpload wrapper present');
  assert.ok(APP_JS.includes("data.error === 'publicity_consent_required'"), 'uploads retry through the door on the server refusal');
});

/* ---------------- items 3+4: complaints policy ---------------- */

test('complaints policy: page exists in all 13 languages with the CCBill form link (nofollow, exact URL + anchor)', () => {
  const pages = stringLiterals(APP_JS, 'legal_complaints_html:');
  assert.equal(pages.length, 13, 'legal_complaints_html in all 13 languages');
  for (const [i, p] of pages.entries()) {
    assert.ok(p.includes(`<a rel="nofollow" href="${CCBILL_URL}">complaints/take down request</a>`), `lang ${i}: CCBill form link with rel=nofollow, exact URL and anchor text`);
    assert.ok(p.includes('support@slutcamp.app'), `lang ${i}: support contact present`);
    assert.ok(p.includes('id="cp-back"'), `lang ${i}: back button wired for vComplaints`);
  }
  const en = pages[0];
  assert.ok(en.includes('World Of Godz Entertainment LLC ("SlutCamp") takes complaints about content seriously.'), 'EN intro verbatim');
  assert.ok(en.includes('Anyone may report content that may be illegal or that otherwise violates the Standards.'), 'EN reporting sentence verbatim');
  assert.ok(en.includes('complaints are resolved within five (5) business days of receipt'), 'EN five-business-day promise verbatim');
  assert.ok(en.includes('we remove the content as soon as possible'), 'EN depicted-person removal ASAP verbatim');
  assert.ok(en.includes("the disagreement will be resolved by a neutral body at the merchant's expense"), 'EN neutral-body appeals promise verbatim');
  assert.ok(en.includes('Copyright complaints follow the DMCA policy.'), 'EN DMCA closing verbatim');
});

test('complaints policy: reachable — public footer, Terms link row, hash route, view', () => {
  assert.ok(SERVER_JS.includes('<a href="/#complaints">Complaints &amp; Content Removal</a>'), 'server-rendered public footer links the policy');
  const terms = stringLiterals(APP_JS, 'legal_terms_html:');
  assert.equal(terms.length, 13);
  for (const [i, tv] of terms.entries()) {
    assert.ok(tv.includes('id="t-complaints"'), `lang ${i}: Terms link row links the policy`);
  }
  assert.ok(APP_JS.includes("if (legalMatch[1] === 'complaints') return show('complaints', {});"), 'routeInitial routes /#complaints');
  assert.ok(APP_JS.includes("legalViews = { terms: 'terms', privacy: 'privacy', billing: 'billing', '2257': 'statement2257', dmca: 'dmca' }"), 'the pinned legalViews literal is untouched');
  assert.ok(APP_JS.includes('complaints: vComplaints'), 'view registered');
  assert.ok(APP_JS.includes("$('#t-complaints').onclick = () => show('complaints', {});"), 'Terms screen wires the link');
});

test('complaints policy: a DIRECT row in the Settings legal area opens it (amendment)', () => {
  // Owner amendment (Oct 27 2026): item 3's "every page where content
  // exists" also means Settings — one direct row, both Settings
  // surfaces (fan wallet + model settings), all 13 languages.
  assert.ok(APP_JS.includes('function renderLegalSettingsCard()'), 'shared legal settings card renderer exists');
  const card = APP_JS.slice(APP_JS.indexOf('function renderLegalSettingsCard()'), APP_JS.indexOf('function renderLegalSettingsCard()') + 700);
  assert.ok(card.includes("t('complaints_label')"), 'the row label is the localized policy title');
  assert.ok(card.includes("$('#set-complaints').onclick = () => show('complaints', {});"), 'the row opens the complaints policy view');
  assert.equal(APP_JS.split('<div id="legal-card"></div>').length - 1, 2, 'both Settings surfaces host the legal card');
  assert.equal(APP_JS.split('renderLegalSettingsCard();').length - 1, 2, 'both Settings surfaces render the legal card');
  for (const key of ['legal_h', 'complaints_label']) {
    const lines = APP_JS.split('\n').filter((l) => l.includes(`    ${key}: '`));
    assert.equal(lines.length, 13, `${key} present in all 13 languages`);
    for (const l of lines) assert.ok(!l.includes(`${key}: ''`), `${key} is never empty`);
  }
  const enLabel = APP_JS.split('\n').find((l) => l.includes("    complaints_label: '"));
  assert.ok(enLabel.includes('Complaints & Content Removal'), 'EN row label is the policy title');
});

test('conflict scan: no page still promises a slower complaints clock than the policy', () => {
  assert.ok(!APP_JS.includes('within 7 business days'), 'the 2257 page no longer says 7 business days');
  assert.ok(APP_JS.includes('Content complaints are reviewed and resolved within 5 business days.'), 'the 2257 page matches the five-business-day policy');
});

/* ---------------- items 5+6+7: fan Terms §14 ---------------- */

test('fan Terms: §14 carries master F in all 13 languages; date is October 27, 2026', () => {
  const terms = stringLiterals(APP_JS, 'legal_terms_html:');
  assert.equal(terms.length, 13, 'terms in all 13 languages');
  for (const [i, tv] of terms.entries()) {
    const titles = [...tv.matchAll(/font-weight:800;margin-bottom:8px">([^<]+)</g)].map((m) => m[1]);
    assert.equal(titles.length, 14, `lang ${i}: exactly 14 sections (nothing renumbered)`);
    assert.ok(titles[12].startsWith('13.'), `lang ${i}: §13 is still the anti-trafficking section`);
    assert.ok(titles[13].startsWith('14.'), `lang ${i}: the new section is §14`);
  }
  const en = terms[0];
  assert.ok(en.includes(MASTER_F_TITLE), 'EN §14 title verbatim');
  assert.ok(en.includes(MASTER_F_BODY), 'EN §14 body verbatim (screening + monitoring + prohibited content)');
  assert.ok(en.includes('Last updated October 27, 2026'), 'EN Terms redated October 27, 2026');
  assert.ok(!en.includes('Last updated October 16, 2026'), 'old Terms date is gone');
});

/* ---------------- live harness ---------------- */

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
  return { child, base };
}
function stop(h) {
  if (h && h.child && h.child.exitCode === null) h.child.kill('SIGKILL');
}
async function req(base, method, p, { body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = 'Bearer ' + token;
  const r = await fetch(base + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
  return { status: r.status, text, json };
}
function openDb(dir, readOnly = true) {
  const db = new DatabaseSync(path.join(dir, 'wogent-chat.db'), readOnly ? { readOnly: true } : {});
  db.exec('PRAGMA busy_timeout = 10000');
  return db;
}
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
async function uploadPhoto(base, token, fields = {}) {
  const fd = new FormData();
  fd.append('photo', new Blob([PNG], { type: 'image/png' }), 'a.png');
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const r = await fetch(base + '/api/model/photo', { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: fd });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
  return { status: r.status, text, json };
}
const signupModel = (base, username, extra = {}) => req(base, 'POST', '/api/auth/signup', {
  body: { username, password: 'hunter22', role: 'model', display_name: username, dob: '1996-03-03', agree18: true, section: 'female', ...extra },
});

test('live: contract endpoint serves v1.6 with the amended §3/§6/§7', { timeout: 240000 }, async () => {
  const dir = makeCopy('ccbillcontract');
  let h = null;
  try {
    h = await boot(dir, { SEED_DEMO: '1' });
    const login = await req(h.base, 'POST', '/api/auth/login', { body: { username: 'bunny', password: 'model123' } });
    assert.equal(login.status, 200);
    const c = await req(h.base, 'GET', '/api/model/contract', { token: login.json.token });
    assert.equal(c.json.version, '1.6', 'served version is 1.6');
    assert.equal(c.json.updated, 'October 27, 2026');
    assert.equal(c.json.sections.length, 16);
    assert.ok(c.json.sections[2].body.endsWith(MASTER_A), 'served §3 ends with master A');
    assert.ok(c.json.sections[5].body.endsWith(MASTER_B), 'served §6 ends with master B');
    assert.ok(c.json.sections[6].body.startsWith(MASTER_C), 'served §7 opens with master C');
  } finally {
    stop(h);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('live: signup refuses a model without the consent, creates nothing; with it, the stamp + IP land', { timeout: 240000 }, async () => {
  const dir = makeCopy('ccbillsignup');
  let h = null;
  try {
    h = await boot(dir, { SEED_DEMO: '1' });
    const refused = await signupModel(h.base, 'ccbillnodoor');
    assert.equal(refused.status, 400, `refused without consent: ${refused.text}`);
    assert.equal(refused.json.error, 'publicity_consent_required');
    const ghost = await req(h.base, 'POST', '/api/auth/login', { body: { username: 'ccbillnodoor', password: 'hunter22' } });
    assert.notEqual(ghost.status, 200, 'the refused signup created no account');
    const ok = await signupModel(h.base, 'ccbillnodoor', { publicity_consent: true });
    assert.equal(ok.status, 200, `the same username succeeds WITH the consent: ${ok.text}`);
    assert.ok(ok.json.user.publicity_consent_at, 'the signup response carries the stamp');
    const me = await req(h.base, 'GET', '/api/me', { token: ok.json.token });
    assert.ok(me.json.user.publicity_consent_at, '/api/me carries the stamp');
    const fan = await req(h.base, 'POST', '/api/auth/signup', {
      body: { username: 'ccbillfan', password: 'hunter22', role: 'fan', display_name: 'Fan', dob: '1996-03-03', agree18: true },
    });
    assert.equal(fan.status, 200, 'fan signup never needs the model consent');
    stop(h); h = null;
    const db = openDb(dir);
    const row = db.prepare("SELECT publicity_consent_at, publicity_consent_ip FROM users WHERE username = 'ccbillnodoor'").get();
    db.close();
    assert.ok(row.publicity_consent_at, 'DB row carries the consent timestamp');
    assert.ok(row.publicity_consent_ip && row.publicity_consent_ip.length > 0, 'DB row carries the consent IP');
  } finally {
    stop(h);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('live: a legacy model (no stamp) is stopped at the upload door until she accepts', { timeout: 240000 }, async () => {
  const dir = makeCopy('ccbilldoor');
  let h = null;
  try {
    h = await boot(dir, { SEED_DEMO: '1' });
    const su = await signupModel(h.base, 'ccbilllegacy', { publicity_consent: true });
    assert.equal(su.status, 200);
    stop(h); h = null;
    // Rewind her to a pre-consent-box account: no stamp on file.
    const wdb = openDb(dir, false);
    wdb.prepare("UPDATE users SET publicity_consent_at = NULL, publicity_consent_ip = NULL WHERE username = 'ccbilllegacy'").run();
    wdb.close();
    h = await boot(dir, { SEED_DEMO: '1' });
    const login = await req(h.base, 'POST', '/api/auth/login', { body: { username: 'ccbilllegacy', password: 'hunter22' } });
    assert.equal(login.status, 200);
    const tok = login.json.token;
    const me = await req(h.base, 'GET', '/api/me', { token: tok });
    assert.equal(me.json.user.publicity_consent_at, null, 'the client sees no stamp — the door applies');
    const blocked = await uploadPhoto(h.base, tok, { appearance: 'solo' });
    assert.equal(blocked.status, 403, `upload refused before consent: ${blocked.text}`);
    assert.equal(blocked.json.error, 'publicity_consent_required');
    const accept = await req(h.base, 'POST', '/api/me/publicity-consent', { token: tok, body: {} });
    assert.equal(accept.status, 200, `door Accept stamps: ${accept.text}`);
    assert.ok(accept.json.publicity_consent_at, 'the stamp is returned');
    const through = await uploadPhoto(h.base, tok, { appearance: 'solo' });
    assert.equal(through.status, 200, `the same upload succeeds after consent: ${through.text}`);
    assert.ok(through.json.photo_url, 'the photo landed');
  } finally {
    stop(h);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('live: public pages carry the complaints footer link', { timeout: 240000 }, async () => {
  const dir = makeCopy('ccbillfooter');
  let h = null;
  try {
    h = await boot(dir, { SEED_DEMO: '1' });
    for (const p of ['/models', '/join']) {
      const r = await fetch(h.base + p);
      assert.equal(r.status, 200);
      const html = await r.text();
      assert.ok(html.includes('href="/#complaints"'), `${p} footer links the complaints policy`);
      assert.ok(html.includes('Complaints &amp; Content Removal'), `${p} footer names the policy`);
    }
  } finally {
    stop(h);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
