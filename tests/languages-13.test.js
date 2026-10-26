'use strict';
/*
 * 13-language expansion tests (owner order, Oct 17 2026: "There's
 * more than 3 languages Ms. Pink. We don't wanna miss any money.
 * Fix it."). EN/ES/PT grew to 13 — fr, de, ru, ja, zh, ko, it, pl,
 * nl, tr (Arabic deliberately excluded: RTL layout is separate work).
 *
 * Coverage:
 *  - Client dict parity: every language carries EXACTLY the EN key
 *    set (592 keys), no empty values; the picker lists all 13 with
 *    native names and never offers Arabic.
 *  - Keyed blocks: the previously hardcoded fan/model/affiliate
 *    surfaces (notifications, preview video, promo link, tip menu,
 *    Face ID / password / contact cards, agreement screens, recruiter
 *    dashboard, Fan Terms) render through t().
 *  - Server SRV table: per-language lookup, EN fallback for unknown
 *    languages, {var} substitution.
 *  - PATCH /api/me/language accepts all 13, rejects 'ar' + garbage
 *    with the existing bad_language shape.
 *  - Agreements: /api/model/contract + /api/recruiter/contract serve
 *    the requester's language with the "English version governs"
 *    note; version strings are UNCHANGED (same terms, new languages).
 *  - Broadcasts: the one-time languages announcements reach seeded
 *    users in their STORED language; stamps set; second boot silent
 *    (SEED_DEMO kept on — the no-seed purge rule).
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
const serverSrc = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(REPO, 'public/js/app.js'), 'utf8');

const LANG13 = ['en', 'es', 'pt', 'fr', 'de', 'ru', 'ja', 'zh', 'ko', 'it', 'pl', 'nl', 'tr'];

/* Extract a top-level const object/function block from a source file
   and evaluate it in a vm (same brace-matching approach as the
   notification suites). */
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
function evalConst(src, marker, extra) {
  const [s, e] = literalSpan(src, marker);
  const name = marker.replace('const ', '').replace(' =', '').trim();
  const sb = Object.assign({}, extra || {});
  vm.createContext(sb);
  vm.runInContext(marker + ' ' + src.slice(s, e) + `;\nthis.__v = ${name};`, sb);
  return sb.__v;
}

/* ---------------- client dict parity ---------------- */

test('client i18n: 13 languages, identical key sets, no empty values', () => {
  const I18N = evalConst(appSrc, 'const I18N =');
  assert.deepEqual(Object.keys(I18N).sort(), [...LANG13].sort(), 'exactly the 13 languages');
  const enKeys = Object.keys(I18N.en).sort();
  assert.ok(enKeys.length >= 592, `EN carries the full key set (got ${enKeys.length})`);
  for (const lang of LANG13) {
    assert.deepEqual(Object.keys(I18N[lang]).sort(), enKeys, `${lang} key set matches EN exactly`);
    for (const k of enKeys) {
      assert.equal(typeof I18N[lang][k], 'string', `${lang}:${k} is a string`);
      assert.ok(I18N[lang][k].trim().length > 0, `${lang}:${k} is not empty`);
    }
  }
});

test('client i18n: picker lists all 13 with native names; Arabic absent', () => {
  const LANGS = (() => {
    const i = appSrc.indexOf('const LANGS = [');
    const j = appSrc.indexOf('];', i);
    const sb = {}; vm.createContext(sb);
    vm.runInContext(appSrc.slice(i, j + 2) + '; this.__v = LANGS;', sb);
    return sb.__v;
  })();
  assert.deepEqual(Array.from(LANGS, (l) => l.code), LANG13, 'picker order/codes are the 13');
  const labels = Object.fromEntries(LANGS.map((l) => [l.code, l.label]));
  assert.equal(labels.fr, 'Français');
  assert.equal(labels.de, 'Deutsch');
  assert.equal(labels.ru, 'Русский');
  assert.equal(labels.ja, '日本語');
  assert.equal(labels.zh, '中文 (简体)');
  assert.equal(labels.ko, '한국어');
  assert.equal(labels.it, 'Italiano');
  assert.equal(labels.pl, 'Polski');
  assert.equal(labels.nl, 'Nederlands');
  assert.equal(labels.tr, 'Türkçe');
  assert.ok(!appSrc.includes("{ code: 'ar'"), 'Arabic is not offered');
});

test('client: previously hardcoded blocks render through t()', () => {
  for (const key of ['notif_empty_title', 'notif_empty_sub', 'notif_ft_wants', 'notif_accept',
    'pv_blurb', 'pv_change', 'pv_upload', 'promo_link_h', 'tip_menu_note',
    'contact_h', 'pk_h', 'pk_err_generic', 'pw_h', 'pw_mismatch',
    'mc_title', 'mc_read_h', 'aff_gate_h', 'aff_sign_go',
    'rc_earnings_h', 'rc_link_note', 'rc_your_cut']) {
    assert.ok(appSrc.includes(`t('${key}'`), `${key} is used via t()`);
  }
  assert.ok(appSrc.includes("app.innerHTML = t('legal_terms_html');"), 'Fan Terms render from the per-language key');
  assert.ok(appSrc.includes('AFFILIATE_AGREEMENT_I18N'), 'affiliate summary has a per-language table');
  assert.ok(appSrc.includes('affAgreementSections()'), 'affiliate summary resolves per-language');
  // spot-check the raw hardcoded strings are gone from the views
  assert.ok(!appSrc.includes('Nothing yet.<br>'), 'notifications empty state no longer hardcoded');
  assert.ok(!appSrc.includes('Set up Face ID on this device</button>'), 'Face ID card no longer hardcoded');
  assert.ok(!appSrc.includes('>Change password</button>'), 'password card no longer hardcoded');
});

test('client: Fan Terms §14 Your Ideas & Feedback in all 13 languages (Assignment 04)', () => {
  const I18N = evalConst(appSrc, 'const I18N =');
  // EN is verbatim from the spec (English controls); the other 12 follow
  // the same translation pattern as the neighboring sections.
  assert.ok(I18N.en.legal_terms_html.includes('14. Your Ideas'),
    'EN terms carry the §14 heading');
  assert.ok(I18N.en.legal_terms_html.includes(
    'If you suggest an idea, feature, name, design, or any other feedback to SlutCamp'),
    'EN §14 suggestion sentence');
  assert.ok(I18N.en.legal_terms_html.includes(
    'you waive any claim against SlutCamp and World Of Godz Entertainment LLC arising from our use of it'),
    'EN §14 waiver sentence');
  const headings = {
    en: '14. Your Ideas', es: '14. Tus ideas', pt: '14. As suas ideias', fr: '14. Vos idées',
    de: '14. Deine Ideen', ru: '14. Ваши идеи', ja: '14. あなたのアイデア',
    zh: '14. 你的想法', ko: '14. 당신의 아이디어', it: '14. Le tue idee',
    pl: '14. Twoje pomysły', nl: '14. Jouw ideeën', tr: '14. Fikirleriniz',
  };
  const updated = {
    en: 'Last updated October 26, 2026', es: '26 de octubre de 2026',
    pt: '26 de outubro de 2026', fr: '26 octobre 2026', de: '26. Oktober 2026',
    ru: '26 октября 2026', ja: '2026年10月26日', zh: '2026 年 10 月 26 日',
    ko: '2026년 10월 26일', it: '26 ottobre 2026', pl: '26 października 2026',
    nl: '26 oktober 2026', tr: '26 Ekim 2026',
  };
  for (const lang of LANG13) {
    const html = I18N[lang].legal_terms_html;
    assert.ok(html.includes(headings[lang]), `${lang} terms carry the §14 heading`);
    assert.ok(html.indexOf('13.') < html.indexOf('14.'), `${lang} §14 follows §13`);
    assert.ok(html.includes(updated[lang]), `${lang} Last updated bumped to October 26, 2026`);
    // §14 body sits between its heading and the footer, and is substantive.
    const body = html.slice(html.indexOf(headings[lang]), html.indexOf('<p class="muted small"'));
    assert.ok(body.length > 200, `${lang} §14 body present`);
    assert.ok(body.includes('SlutCamp'), `${lang} §14 names SlutCamp`);
  }
});

test('client: every translated Fan Terms carries the governs card', () => {
  const I18N = evalConst(appSrc, 'const I18N =');
  const enCards = I18N.en.legal_terms_html.split('<div class="card">').length - 1;
  for (const lang of LANG13.slice(1)) {
    const cards = I18N[lang].legal_terms_html.split('<div class="card">').length - 1;
    assert.equal(cards, enCards + 1, `${lang} terms = EN cards + the governs card`);
  }
});

/* ---------------- server SRV table ---------------- */

test('server SRV: per-language lookup, EN fallback, placeholder substitution', () => {
  const SRV = evalConst(serverSrc, 'const SRV =');
  const start = serverSrc.indexOf('function srv(key, lang, vars)');
  const end = serverSrc.indexOf('\n}', start);
  const sb = { SRV }; vm.createContext(sb);
  vm.runInContext(serverSrc.slice(start, end + 2) + '; this.__v = srv;', sb);
  const srvFn = sb.__v;
  // every SRV key exists in all 13 languages, nothing empty
  for (const [key, row] of Object.entries(SRV)) {
    assert.deepEqual(Object.keys(row).sort(), [...LANG13].sort(), `SRV ${key} covers 13 languages`);
    for (const lang of LANG13) assert.ok(row[lang].trim().length > 0, `SRV ${key}:${lang} non-empty`);
  }
  const de = srvFn('bell_tip_title', 'de', { fan: 'Max', emoji: '🔥', label: 'Rose' });
  assert.ok(de.includes('Max') && de.includes('🔥') && de.includes('Rose'), 'vars substituted');
  assert.notEqual(de, srvFn('bell_tip_title', 'en', { fan: 'Max', emoji: '🔥', label: 'Rose' }), 'de differs from en');
  assert.equal(srvFn('bell_tip_title', 'ar', { fan: 'Max', emoji: '🔥', label: 'Rose' }),
    srvFn('bell_tip_title', 'en', { fan: 'Max', emoji: '🔥', label: 'Rose' }), 'unknown language falls back to EN');
  assert.equal(srvFn('no_such_key', 'fr'), 'no_such_key', 'unknown key returns the key');
});

test('server: welcome family maps cover all 13 languages', () => {
  const W = evalConst(serverSrc, 'const MODEL_WELCOME =');
  assert.deepEqual(Object.keys(W).sort(), [...LANG13].sort());
  assert.ok(W.ja('テスト').includes('テスト'), 'welcome name placeholder works in ja');
  for (const marker of ['const MODEL_GUIDE =', 'const MODEL_ID_VERIFY =', 'const MODEL_AFFILIATE =']) {
    const M = evalConst(serverSrc, marker, { ID_VERIFY_IMG_URL: 'https://x/y.png', AFFILIATE_IMG_URL: 'https://x/z.png' });
    assert.deepEqual(Object.keys(M).sort(), [...LANG13].sort(), marker + ' covers 13');
  }
});

test('server: language validation wired to the 13 everywhere', () => {
  assert.ok(serverSrc.includes("const SUPPORTED_LANGS = ['en', 'es', 'pt', 'fr', 'de', 'ru', 'ja', 'zh', 'ko', 'it', 'pl', 'nl', 'tr'];"));
  assert.ok(!serverSrc.includes("['en', 'es', 'pt'].includes"), 'no stale 3-language validation lists remain');
});

/* ---------------- boot harness ---------------- */

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
function makeCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-lang13-'));
  for (const d of ['server.js', 'package.json', 'lib', 'public', 'data']) {
    fs.cpSync(path.join(REPO, d), path.join(dir, d), { recursive: true });
  }
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  return dir;
}
async function boot(dir, extraEnv) {
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
    try { const r = await fetch(base + '/api/health'); if (r.ok) break; } catch (e) { /* not up */ }
    if (Date.now() > deadline) { child.kill('SIGKILL'); throw new Error(`server did not come up\n${log}`); }
    await new Promise((r) => setTimeout(r, 150));
  }
  return { child, base, log: () => log };
}
function stop(h) { if (h && h.child && h.child.exitCode === null) h.child.kill('SIGKILL'); }
function readDb(dir) { return new DatabaseSync(path.join(dir, 'wogent-chat.db'), { readOnly: true }); }
async function req(base, method, p, { body, token } = {}) {
  const h = {};
  let payload;
  if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  if (token) h.authorization = 'Bearer ' + token;
  const r = await fetch(base + p, { method, headers: h, body: payload });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not json */ }
  return { status: r.status, json, text };
}

/* ---------------- PATCH /api/me/language ---------------- */

test('PATCH /api/me/language: accepts all 13, rejects ar and garbage', async () => {
  const dir = makeCopy();
  const h = await boot(dir, { SEED_DEMO: '1' });
  try {
    const login = await req(h.base, 'POST', '/api/auth/login', { body: { username: 'fandemo', password: 'fan123' } });
    assert.equal(login.status, 200);
    const token = login.json.token;
    assert.ok(token, 'fan token issued');
    for (const lang of LANG13) {
      const r = await req(h.base, 'PATCH', '/api/me/language', { body: { language: lang }, token });
      assert.equal(r.status, 200, `${lang} accepted`);
      assert.equal(r.json.language, lang);
    }
    for (const bad of ['ar', 'xx', '', 'english', 'pt-BR-x']) {
      const r = await req(h.base, 'PATCH', '/api/me/language', { body: { language: bad }, token });
      assert.equal(r.status, 400, `${JSON.stringify(bad)} rejected`);
      assert.equal(r.json.error, 'bad_language');
    }
    // the stored value drives /api/me
    await req(h.base, 'PATCH', '/api/me/language', { body: { language: 'ko' }, token });
    const me = await req(h.base, 'GET', '/api/me', { token });
    assert.equal(me.json.user.language, 'ko');
  } finally {
    stop(h);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------- agreements over the API ---------------- */

test('agreements: model + recruiter contracts served per-language, versions unchanged', async () => {
  const SRVt = evalConst(serverSrc, 'const SRV =');
  const dir = makeCopy();
  const h = await boot(dir, { SEED_DEMO: '1' });
  try {
    // model in French
    const mlogin = await req(h.base, 'POST', '/api/auth/login', { body: { username: 'bunny', password: 'model123' } });
    assert.equal(mlogin.status, 200);
    const mTok = mlogin.json.token;
    await req(h.base, 'PATCH', '/api/me/language', { body: { language: 'fr' }, token: mTok });
    const mc = await req(h.base, 'GET', '/api/model/contract', { token: mTok });
    assert.equal(mc.status, 200);
    assert.equal(mc.json.version, '1.6', 'model agreement serves the current version (v1.5 added the section clause; v1.6 adds the CCBill depicted-person verification/consent duties + the Standards prohibition)');
    assert.equal(mc.json.sections.length, 16, 'all 16 sections served');
    assert.ok(mc.json.governs_note && mc.json.governs_note.length > 10, 'governs note present for fr');
    assert.ok(mc.json.sections[1].body.includes('CONTRAT') || mc.json.sections[1].body.length > 50, 'fr body served');
    assert.notEqual(mc.json.sections[1].body, 'You are an INDEPENDENT CONTRACTOR, not an employee of the Company. Nothing in this Agreement creates an employment, partnership, or agency relationship. You are responsible for your own taxes, insurance, and business expenses. The Company will not withhold taxes from your payouts, and you agree to report all income as required by law.', 'fr body is not the EN text');
    // an EN model gets canonical sections and NO governs note
    const slogin = await req(h.base, 'POST', '/api/auth/login', { body: { username: 'stacey', password: 'model123' } });
    const sTok = slogin.json.token;
    const mcEn = await req(h.base, 'GET', '/api/model/contract', { token: sTok });
    assert.equal(mcEn.json.governs_note, null, 'EN readers get no governs note');
    assert.equal(mcEn.json.sections[0].title, '1. Parties');

    // recruiter in Japanese (created via the self-serve affiliate signup)
    const aff = await req(h.base, 'POST', '/api/affiliate/signup', {
      body: { username: 'afflang', password: 'hunter22', display_name: 'Lang Gal', agreed: true } });
    assert.equal(aff.status, 200, JSON.stringify(aff.json));
    const aTok = aff.json.token;
    await req(h.base, 'PATCH', '/api/me/language', { body: { language: 'ja' }, token: aTok });
    const rc = await req(h.base, 'GET', '/api/recruiter/contract', { token: aTok });
    assert.equal(rc.status, 200);
    assert.equal(rc.json.version, 'R1.3', 'recruiter agreement version unchanged');
    assert.equal(rc.json.sections.length, 11, 'all 11 sections served');
    assert.ok(rc.json.governs_note && rc.json.governs_note.length > 5, 'governs note present for ja');
    assert.ok(/[぀-ヿ]/.test(rc.json.sections[0].body) || rc.json.sections[0].body !== 'This Recruiter Agreement ("Agreement") is between you ("Recruiter") and World of Godz Entertainment LLC ("Company"), doing business as SlutCamp ("SlutCamp"). By signing, you agree to everything below.', 'ja body served');
  } finally {
    stop(h);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------- broadcasts in stored language ---------------- */

test('broadcasts: languages announcement lands in each user\u2019s stored language, once', async () => {
  const SRVt = evalConst(serverSrc, 'const SRV =');
  const dir = makeCopy();
  try {
    const h1 = await boot(dir, { SEED_DEMO: '1' });
    stop(h1);
    // Surgery: give seed users other languages, reset the lang stamps,
    // and clear boot-1 language announcements so boot 2 re-fires them.
    const wdb = new DatabaseSync(path.join(dir, 'wogent-chat.db'));
    wdb.exec('PRAGMA busy_timeout = 10000');
    wdb.prepare("UPDATE users SET language = 'fr' WHERE username = 'bunny'").run();
    wdb.prepare("UPDATE users SET language = 'ja' WHERE username = 'stacey'").run();
    wdb.prepare("UPDATE users SET language = 'de' WHERE username = 'fandemo'").run();
    wdb.prepare('UPDATE platform_stats SET languages_announced_at = NULL, fan_languages_announced_at = NULL WHERE id = 1').run();
    wdb.prepare("DELETE FROM notifications WHERE type IN ('languages', 'fan_languages')").run();
    wdb.prepare(`DELETE FROM messages WHERE conversation_id IN
      (SELECT c.id FROM conversations c JOIN users a ON a.id = c.fan_id WHERE a.role = 'admin')`).run();
    wdb.close();

    const h2 = await boot(dir, { SEED_DEMO: '1' });
    stop(h2);
    const db = readDb(dir);
    const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
    const dmCount = (modelId, body) => db.prepare(
      `SELECT COUNT(*) AS c FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE c.fan_id = ? AND c.model_id = ? AND m.body = ?`).get(admin.id, modelId, body).c;
    const byName = (u) => db.prepare('SELECT id FROM users WHERE username = ?').get(u).id;
    const ids = { bunny: byName('bunny'), stacey: byName('stacey'), bella: byName('bella'), fandemo: byName('fandemo') };
    assert.equal(dmCount(ids.bunny, SRVt.ann_lang_dm.fr), 1, 'bunny got the FR announcement DM');
    assert.equal(dmCount(ids.stacey, SRVt.ann_lang_dm.ja), 1, 'stacey got the JA announcement DM');
    assert.equal(dmCount(ids.bella, SRVt.ann_lang_dm.en), 1, 'bella got the EN announcement DM');
    const fanBell = db.prepare("SELECT title, body FROM notifications WHERE user_id = ? AND type = 'fan_languages'")
      .get(ids.fandemo);
    assert.ok(fanBell, 'fan got the languages blast bell');
    assert.equal(fanBell.title, SRVt.ann_lang_fan_title.de, 'fan bell is in DE');
    assert.equal(fanBell.body, SRVt.ann_lang_fan_body.de);
    const modelBell = db.prepare("SELECT title FROM notifications WHERE user_id = ? AND type = 'languages'")
      .get(ids.bunny);
    assert.equal(modelBell.title, SRVt.ann_lang_bell_title.fr, 'model bell is in FR');
    const st = db.prepare('SELECT languages_announced_at, fan_languages_announced_at FROM platform_stats WHERE id = 1').get();
    assert.ok(st.languages_announced_at && st.fan_languages_announced_at, 'both stamps set');
    db.close();

    // Third boot: nothing re-sends.
    const h3 = await boot(dir, { SEED_DEMO: '1' });
    stop(h3);
    const db3 = readDb(dir);
    assert.equal(db3.prepare(
      `SELECT COUNT(*) AS c FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE c.fan_id = ? AND c.model_id = ? AND m.body = ?`).get(admin.id, ids.bunny, SRVt.ann_lang_dm.fr).c, 1,
      'no re-send on third boot');
    assert.equal(db3.prepare("SELECT COUNT(*) AS c FROM notifications WHERE type = 'fan_languages'").get().c, 1,
      'fan blast not repeated');
    db3.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
