'use strict';
/*
 * ONE ACCOUNT FOR BOTH (owner-approved 2026-10-17): affiliate as a
 * capability on a fan/model account — one username, one password.
 *
 * The capability IS the recruiters row pointed at her account, so
 * attribution, splitPayment and the dashboard pay her exactly like a
 * standalone recruiter with zero money-code changes. Pins:
 *  (1) ATTACH — a signed-in model/fan accepts the SAME Recruiter
 *      Agreement moment as the standalone signup; the capability +
 *      her link are live immediately; validations + protected
 *      accounts refused; exactly one recruiters row.
 *  (2) MERGE scenario A — a rowless survivor folds her standalone
 *      affiliate account in: code/attribution/earnings move, counts
 *      sum, the old login dies, the link keeps paying HER. The
 *      email-matched offer shows on /api/me in BOTH directions and
 *      a wrong password changes NOTHING.
 *  (3) MERGE scenario B — both sides already affiliates: the target's
 *      code becomes primary, the survivor's old code keeps resolving
 *      as an alias and attributes new signups, earnings sum, the
 *      affiliate start keeps the earlier date.
 *  (4) Refusals — fan target 400, admin target 403, protected
 *      survivor (fandemo) 403 for attach AND merge.
 *  (5) Duplicate prevention — affiliate signup with an existing
 *      fan/model username (or a matching email) → 409
 *      already_have_account and NO new row; a recruiter username
 *      still → 409 username_taken.
 *  (6) Announcement — one-time DM + bell to MODELS only (type
 *      'one_account', SRV copy), stamp-guarded, no re-send.
 *  (7) Source pins — the top two-label switch renders only for dual
 *      holders (guard on /api/me's is_affiliate), the Settings card,
 *      the PR #44 landing tie-in, i18n parity ×13 for all new keys.
 *
 * Manager Affiliates roster/reset extension: the Manager PR had NOT
 * landed on main when this shipped (main = 2ed1cf8), so there is no
 * roster endpoint on this tree to extend or test — see the PR report.
 *
 * Temp-copy boot harness, same pattern as the other suites.
 * Money math: tip 1000¢ gross @ 60/40 → model 600, platform 400,
 * recruiter 200 (20% of gross = half the platform slice).
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
const cssSrc = fs.readFileSync(path.join(REPO, 'public/css/styles.css'), 'utf8');
const serverSrc = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');

const LANG13 = ['en', 'es', 'pt', 'fr', 'de', 'ru', 'ja', 'zh', 'ko', 'it', 'pl', 'nl', 'tr'];
const NEW_KEYS = ['side_model', 'side_fan', 'side_affiliate', 'rc_quota_line',
  'aff_already_account', 'aff_card_h', 'aff_card_none_sub', 'aff_become_btn',
  'aff_have_btn', 'aff_on_sub', 'aff_open_dash', 'aff_merge_prompt',
  'aff_merge_btn', 'aff_dismiss', 'aff_merge_h', 'aff_merge_sub',
  'aff_merge_go', 'aff_merge_bad', 'aff_merge_not_aff', 'aff_merge_done',
  'aff_attach_done', 'aff_attach_h', 'aff_switch_note'];

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

/* --------------------------- harness --------------------------- */

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

function makeCopy(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `slutcamp-${label}-`));
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
  const deadline = Date.now() + 20000;
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

async function req(base, method, p, { body, token, headers } = {}) {
  const h = { 'content-type': 'application/json', ...(headers || {}) };
  if (token) h.authorization = 'Bearer ' + token;
  const r = await fetch(base + p, {
    method, headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await r.json(); } catch (e) { /* non-JSON */ }
  return { status: r.status, data };
}

function readDb(dir, readOnly = true) {
  return new DatabaseSync(path.join(dir, 'wogent-chat.db'), { readOnly });
}

async function signup(base, username, role, extra = {}) {
  const r = await req(base, 'POST', '/api/auth/signup', {
    body: { username, password: 'hunter22', role, display_name: username,
            dob: '1995-04-01', agree18: true, ...(role === 'model' ? { section: 'female', publicity_consent: true } : {}), ...extra },
  });
  assert.equal(r.status, 200, `signup ${username}: ${JSON.stringify(r.data)}`);
  return { token: r.data.token, id: r.data.user.id, username };
}
async function affiliateSignup(base, username) {
  const r = await req(base, 'POST', '/api/affiliate/signup', {
    body: { username, password: 'hunter22', display_name: username, agreed: true } });
  assert.equal(r.status, 200, `affiliate signup ${username}: ${JSON.stringify(r.data)}`);
  return { token: r.data.token, id: r.data.user.id, username };
}
const mgrLogin = async (base) => {
  const adm = await req(base, 'POST', '/api/manager/login', { body: { username: 'admin', password: 'admin123' } });
  assert.equal(adm.status, 200, `manager login: ${JSON.stringify(adm.data)}`);
  return { token: adm.data.token, headers: { 'x-manager': '1' } };
};
async function richFan(base, mgr, username) {
  const fan = await signup(base, username, 'fan');
  const g = await req(base, 'POST', `/api/admin/fans/${fan.id}/credits`,
    { ...mgr, body: { amount_cents: 100000 } });
  assert.equal(g.status, 200, `grant credits: ${JSON.stringify(g.data)}`);
  return fan;
}
async function tip(base, fanToken, modelUserId, amountCents) {
  const start = await req(base, 'POST', '/api/conversations/start',
    { token: fanToken, body: { model_id: modelUserId } });
  assert.equal(start.status, 200, `conversation start: ${JSON.stringify(start.data)}`);
  const t = await req(base, 'POST', '/api/tips', {
    token: fanToken,
    body: { conversation_id: start.data.conversation.id, amount_cents: amountCents },
  });
  assert.equal(t.status, 200, `tip: ${JSON.stringify(t.data)}`);
  return t;
}
const dashboard = (base, token) => req(base, 'GET', '/api/recruiter/dashboard', { token });
const me = (base, token) => req(base, 'GET', '/api/me', { token });

/* --------------------------- static pins --------------------------- */

test('source pins: switch renders ONLY for dual holders; Settings card + views wired', () => {
  const sw = sliceFn(appSrc, 'function sideSwitchHTML(', 'function wireSideSwitch(');
  assert.ok(sw.includes('!S.user.is_affiliate'), 'switch hidden without the capability');
  assert.ok(sw.includes("S.user.role !== 'fan' && S.user.role !== 'model'"), 'switch is for fan/model accounts only');
  assert.ok(sw.includes("t('side_model')") && sw.includes("t('side_fan')") && sw.includes("t('side_affiliate')"),
    'two labels: her side + Affiliate');
  assert.ok(appSrc.includes("show(S.user.role === 'model' ? 'modelChats' : 'fanModels', {})"), 'main side goes home');
  assert.ok(appSrc.includes("show('recruiter', {})"), 'affiliate side opens the dashboard');
  const fanHome = sliceFn(appSrc, 'async function vFanModels()', 'async function vFanLive');
  assert.ok(fanHome.includes("${sideSwitchHTML('main')}"), 'switch at the top of fan home');
  const chats = sliceFn(appSrc, 'async function vChatList(', 'async function vChat(');
  assert.ok(chats.includes("${sideSwitchHTML('main')}"), 'switch at the top of model home (chats)');
  const rec = sliceFn(appSrc, 'async function vRecruiter()', '/* ---------------- BOOKINGS');
  assert.ok(rec.includes("${sideSwitchHTML('aff')}"), 'switch at the top of the affiliate dashboard');
  assert.ok(rec.includes("t('rc_quota_line'"), 'quota line under the dashboard stats');
  const settings = sliceFn(appSrc, 'async function vModelSettings(', '/* ----------------');
  assert.ok(settings.includes('${affiliateCardHTML()}'), 'affiliate card in model Settings');
  assert.ok(settings.includes('${affiliateMergePromptHTML()}'), 'merge prompt at top of model Settings');
  const wallet = sliceFn(appSrc, 'async function vWallet()', '/* ---------------- CRYPTO');
  assert.ok(wallet.includes('id="affiliate-card"') && wallet.includes('renderAffiliateCard()'),
    'affiliate card + prompt in the fan wallet (fan Settings)');
  assert.ok(appSrc.includes("api('/affiliate/attach'"), 'attach posts to the server');
  assert.ok(appSrc.includes("api('/affiliate/merge'"), 'merge posts to the server');
  assert.ok(appSrc.includes('function vAffiliateAttach') && appSrc.includes('function vAffiliateMerge'),
    'attach + merge views exist');
  assert.ok(appSrc.includes('affiliateAttach: vAffiliateAttach, affiliateMerge: vAffiliateMerge'),
    'views registered in show()');
  assert.ok(appSrc.includes('affAgreementSections()'), 'attach shows the SAME agreement copy as signup');
  assert.ok((appSrc.match(/data\.error === 'already_have_account'/g) || []).length >= 2,
    'both affiliate signup flows route already_have_account to sign-in');
  assert.ok(cssSrc.includes('.side-switch'), 'switch styles shipped');
});

test('source pins: every helper the affiliate attach/merge views call is defined (called-but-undefined helpers render dead buttons)', () => {
  // Regression pin for the PR #45 defect: vAffiliateAttach and
  // vAffiliateMerge called hdrPublic() in their templates and
  // renderHeader() after the paint — neither was defined anywhere, so
  // the views threw and the affiliate card's buttons looked dead.
  for (const name of ['hdrPublic', 'renderHeader']) {
    const calls = (appSrc.match(new RegExp(name + '\\(', 'g')) || []).length;
    const defined = appSrc.includes(`function ${name}(`);
    assert.ok(calls === 0 || defined,
      `${name}: ${calls} call(s) in app.js but no \`function ${name}(\` definition`);
  }
  assert.ok(appSrc.includes("hdrPublic('SlutCamp 🤝')"),
    'affiliate attach/merge views still render their public header via hdrPublic');
});

test('source pins: PR #44 landing tie-in — "Sign in as an affiliate" lands capability holders on the affiliate side', () => {
  const after = sliceFn(appSrc, 'async function afterLogin(data', '/* Contract gate');
  assert.ok(after.includes("opts.roleHint) === 'affiliate' && !!S.user.is_affiliate"), 'tie-in gated on hint + capability');
  assert.ok(after.includes("else if (wantAff) show('recruiter', {});"), 'lands on the affiliate view');
  assert.ok(after.includes('&& !wantAff)'), 'no wrong-role toast for that landing');
});

test('i18n parity: every new client key exists in all 13 languages; announcement copy in all 13 SRV languages', () => {
  for (const key of NEW_KEYS) {
    const n = appSrc.split(`\n    ${key}:`).length - 1 + appSrc.split(`\n      ${key}:`).length - 1;
    assert.ok(n >= 13, `${key} defined in all 13 client languages (found ${n})`);
  }
  const SRV = evalConst(serverSrc, 'const SRV =');
  for (const key of ['ann_one_account_dm', 'ann_one_account_bell_title', 'ann_one_account_bell_body']) {
    assert.ok(SRV[key], `${key} exists server-side`);
    for (const lang of LANG13) assert.ok(SRV[key][lang], `${key}.${lang} present`);
  }
  assert.ok(SRV.ann_one_account_dm.en.includes('Settings'), 'EN announcement points at Settings');
});

/* --------------------------- attach --------------------------- */

test('attach: validations, capability live immediately, dashboard + contract work for a model account', async () => {
  const dir = makeCopy('oneaccount-attach');
  try {
    const h = await boot(dir);
    try {
      const model = await signup(h.base, 'attachgal', 'model');
      let r = await me(h.base, model.token);
      assert.equal(r.data.user.is_affiliate, false, 'no capability before attach');
      assert.equal(r.data.user.affiliate_merge_offer, null);

      r = await req(h.base, 'POST', '/api/affiliate/attach',
        { token: model.token, body: { display_name: 'Attach Gal', agreed: false } });
      assert.equal(r.status, 400); assert.equal(r.data.error, 'must_agree');
      r = await req(h.base, 'POST', '/api/affiliate/attach',
        { token: model.token, body: { display_name: 'A', agreed: true } });
      assert.equal(r.status, 400); assert.equal(r.data.error, 'bad_name');

      r = await req(h.base, 'POST', '/api/affiliate/attach',
        { token: model.token, body: { display_name: 'Attach Gal', agreed: true } });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      assert.equal(r.data.ok, true);
      assert.match(r.data.referral_code, /^[a-f0-9]{8}$/);
      assert.equal(r.data.is_affiliate, true);
      const code = r.data.referral_code;

      // /api/me carries the capability — the client's ONLY switch trigger
      r = await me(h.base, model.token);
      assert.equal(r.data.user.is_affiliate, true);
      assert.equal(r.data.user.affiliate_code, code);
      assert.equal(r.data.user.role, 'model', 'she is still a model — affiliate is a capability, not a re-role');

      // agreement signed by the attach itself; dashboard renders
      r = await req(h.base, 'GET', '/api/recruiter/contract', { token: model.token });
      assert.equal(r.status, 200);
      assert.equal(r.data.signed, true);
      assert.equal(r.data.signed_version, 'R1.3');
      r = await dashboard(h.base, model.token);
      assert.equal(r.status, 200);
      assert.equal(r.data.recruiter.referral_code, code);
      assert.equal(r.data.model_count, 0);
      assert.equal(r.data.quota_target, 10);
      assert.ok(r.data.quota_year_end, 'quota year-end present');
      assert.ok(r.data.affiliate_since, 'affiliate start present');

      // her link attributes a model signup to her — and pays her
      r = await req(h.base, 'GET', `/api/referral/${code}`);
      assert.equal(r.data.valid, true);

      // second attach refused; still exactly one capability row
      r = await req(h.base, 'POST', '/api/affiliate/attach',
        { token: model.token, body: { display_name: 'Attach Gal', agreed: true } });
      assert.equal(r.status, 409); assert.equal(r.data.error, 'already_affiliate');

      // a fan can attach too
      const fan = await signup(h.base, 'attachfan', 'fan');
      r = await req(h.base, 'POST', '/api/affiliate/attach',
        { token: fan.token, body: { display_name: 'Attach Fan', agreed: true } });
      assert.equal(r.status, 200);
      r = await dashboard(h.base, fan.token);
      assert.equal(r.status, 200, 'fan+affiliate dashboard renders');

      // a standalone recruiter cannot "attach" (she IS the affiliate side)
      const rec = await affiliateSignup(h.base, 'attachrec');
      r = await req(h.base, 'POST', '/api/affiliate/attach',
        { token: rec.token, body: { display_name: 'Rec Gal', agreed: true } });
      assert.equal(r.status, 403);
    } finally { stop(h); }

    const db = readDb(dir);
    const rows = db.prepare('SELECT * FROM recruiters WHERE user_id = ?')
      .all(db.prepare("SELECT id FROM users WHERE username = 'attachgal'").get().id);
    assert.equal(rows.length, 1, 'exactly one recruiters row for the attached model');
    const sig = db.prepare(`SELECT * FROM contract_signatures WHERE user_id = ?
      AND contract_version = 'R1.3'`).get(rows[0].user_id);
    assert.ok(sig, 'agreement signature recorded at R1.3');
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* --------------------------- merge A --------------------------- */

test('merge A: rowless survivor — offer both directions, wrong password no-op, fold-in moves code/models/earnings, old login dead, link keeps paying', async () => {
  const dir = makeCopy('oneaccount-mergea');
  try {
    const h = await boot(dir, { SEED_DEMO: '1' });
    try {
      const mgr = await mgrLogin(h.base);
      const fan = await richFan(h.base, mgr, 'tipfan');
      const rec = await affiliateSignup(h.base, 'recgal');
      let r = await dashboard(h.base, rec.token);
      const codeA = r.data.recruiter.referral_code;
      const sinceA = r.data.affiliate_since;

      // a model onboarded through her link, and she has earnings
      const mg1 = await signup(h.base, 'mgone', 'model', { referral_code: codeA });
      r = await dashboard(h.base, rec.token);
      assert.equal(r.data.model_count, 1);
      await tip(h.base, fan.token, mg1.id, 1000);
      r = await dashboard(h.base, rec.token);
      assert.equal(r.data.earnings_cents, 200, 'recruiter cut = 20% of the $10 gross');

      const survivor = await signup(h.base, 'survivorgal', 'model');

      // same email on both accounts → the offer appears BOTH ways
      for (const tk of [survivor.token, rec.token]) {
        r = await req(h.base, 'PATCH', '/api/me/contact', { token: tk, body: { email: 'pair@example.com' } });
        assert.equal(r.status, 200, JSON.stringify(r.data));
      }
      r = await me(h.base, survivor.token);
      assert.equal(r.data.user.affiliate_merge_offer.direction, 'bring_in');
      assert.equal(r.data.user.affiliate_merge_offer.other_username, 'recgal');
      r = await me(h.base, rec.token);
      assert.equal(r.data.user.affiliate_merge_offer.direction, 'switch_account');
      assert.equal(r.data.user.affiliate_merge_offer.other_username, 'survivorgal');
      assert.equal(r.data.user.affiliate_merge_offer.other_role, 'model');

      // wrong password → 401 and NOTHING changes
      r = await req(h.base, 'POST', '/api/affiliate/merge',
        { token: survivor.token, body: { username: 'recgal', password: 'wrong-pass' } });
      assert.equal(r.status, 401); assert.equal(r.data.error, 'bad_credentials');
      r = await req(h.base, 'POST', '/api/auth/login', { body: { username: 'recgal', password: 'hunter22' } });
      assert.equal(r.status, 200, 'standalone login untouched after a failed merge');
      r = await me(h.base, survivor.token);
      assert.equal(r.data.user.is_affiliate, false, 'survivor gained nothing from a failed merge');

      // the real merge
      r = await req(h.base, 'POST', '/api/affiliate/merge',
        { token: survivor.token, body: { username: 'recgal', password: 'hunter22' } });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      assert.equal(r.data.referral_code, codeA, 'her link code survives as the primary code');
      assert.equal(r.data.models_onboarded, 1);
      assert.equal(r.data.earnings_cents, 200, 'earnings moved to the survivor');
      assert.equal(r.data.is_affiliate, true);

      // dashboard on the survivor: same code, same count, same start date
      r = await dashboard(h.base, survivor.token);
      assert.equal(r.data.recruiter.referral_code, codeA);
      assert.equal(r.data.model_count, 1);
      assert.equal(r.data.models[0].username, 'mgone');
      assert.equal(r.data.earnings_cents, 200);
      assert.equal(r.data.affiliate_since, sinceA, 'affiliate start rides along with the row');

      // the retired login is dead: password login AND its old session
      r = await req(h.base, 'POST', '/api/auth/login', { body: { username: 'recgal', password: 'hunter22' } });
      assert.notEqual(r.status, 200, 'retired account cannot sign in');
      r = await me(h.base, rec.token);
      assert.equal(r.status, 401, 'retired account sessions were killed');

      // her link keeps paying HER (now the survivor) after the merge
      await tip(h.base, fan.token, mg1.id, 1000);
      r = await dashboard(h.base, survivor.token);
      assert.equal(r.data.earnings_cents, 400, 'post-merge spend still pays the survivor');

      // idempotency: merging the retired account again is a no-op 401
      r = await req(h.base, 'POST', '/api/affiliate/merge',
        { token: survivor.token, body: { username: 'recgal', password: 'hunter22' } });
      assert.equal(r.status, 401);
      r = await dashboard(h.base, survivor.token);
      assert.equal(r.data.earnings_cents, 400, 'nothing double-counted');
    } finally { stop(h); }

    const db = readDb(dir);
    const surv = db.prepare("SELECT id FROM users WHERE username = 'survivorgal'").get();
    const old = db.prepare("SELECT * FROM users WHERE username = 'recgal'").get();
    assert.equal(old.merged_into, surv.id, 'merged_into recorded');
    assert.equal(old.banned, 1, 'retired account banned');
    assert.equal(old.status, 'merged');
    const row = db.prepare('SELECT * FROM recruiters WHERE user_id = ?').get(surv.id);
    assert.ok(row, 'the recruiters row now points at the survivor');
    const mg = db.prepare("SELECT recruiter_id FROM models WHERE user_id = (SELECT id FROM users WHERE username = 'mgone')").get();
    assert.equal(mg.recruiter_id, row.id, 'model attribution rides on the moved row');
    const tx = db.prepare('SELECT COUNT(*) AS c FROM transactions WHERE recruiter_id = ? AND recruiter_cents > 0').get(row.id);
    assert.equal(tx.c, 2, 'both tip splits are on her row');
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* --------------------------- merge B --------------------------- */

test('merge B: both sides affiliates — target code wins, survivor code becomes a working alias, earnings + counts sum', async () => {
  const dir = makeCopy('oneaccount-mergeb');
  try {
    const h = await boot(dir, { SEED_DEMO: '1' });
    try {
      const mgr = await mgrLogin(h.base);
      const fan = await richFan(h.base, mgr, 'tipfanb');

      // survivor: a model who attached (code C1) with one model + earnings
      const survivor = await signup(h.base, 'bothgal', 'model');
      let r = await req(h.base, 'POST', '/api/affiliate/attach',
        { token: survivor.token, body: { display_name: 'Both Gal', agreed: true } });
      assert.equal(r.status, 200);
      const codeC1 = r.data.referral_code;
      const mg3 = await signup(h.base, 'mgthree', 'model', { referral_code: codeC1 });
      await tip(h.base, fan.token, mg3.id, 1000);

      // target: standalone affiliate (code C2) with one model + earnings
      const rec = await affiliateSignup(h.base, 'oldrec');
      r = await dashboard(h.base, rec.token);
      const codeC2 = r.data.recruiter.referral_code;
      const mg2 = await signup(h.base, 'mgtwo', 'model', { referral_code: codeC2 });
      await tip(h.base, fan.token, mg2.id, 1000);

      r = await dashboard(h.base, survivor.token);
      assert.equal(r.data.model_count, 1);
      assert.equal(r.data.earnings_cents, 200);

      r = await req(h.base, 'POST', '/api/affiliate/merge',
        { token: survivor.token, body: { username: 'oldrec', password: 'hunter22' } });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      assert.equal(r.data.referral_code, codeC2, "the shared link (target's code) becomes primary");
      assert.equal(r.data.models_onboarded, 2, 'counts sum');
      assert.equal(r.data.earnings_cents, 400, 'earnings sum — not a cent lost');

      r = await dashboard(h.base, survivor.token);
      assert.equal(r.data.recruiter.referral_code, codeC2);
      assert.equal(r.data.model_count, 2);
      assert.equal(r.data.earnings_cents, 400);

      // the survivor's old code still resolves — as an alias — and a
      // model joining through it is attributed (and pays) the survivor
      r = await req(h.base, 'GET', `/api/referral/${codeC1}`);
      assert.equal(r.data.valid, true, 'old code still resolves');
      const mg4 = await signup(h.base, 'mgfour', 'model', { referral_code: codeC1 });
      r = await dashboard(h.base, survivor.token);
      assert.equal(r.data.model_count, 3, 'alias signup attributed to the survivor');
      await tip(h.base, fan.token, mg4.id, 1000);
      r = await dashboard(h.base, survivor.token);
      assert.equal(r.data.earnings_cents, 600, 'alias-attributed model pays the survivor');
    } finally { stop(h); }

    const db = readDb(dir);
    const surv = db.prepare("SELECT id FROM users WHERE username = 'bothgal'").get();
    const rows = db.prepare('SELECT * FROM recruiters WHERE user_id = ?').all(surv.id);
    assert.equal(rows.length, 1, 'exactly one recruiters row survives');
    const alias = db.prepare('SELECT * FROM recruiter_code_aliases WHERE recruiter_id = ?').all(rows[0].id);
    assert.equal(alias.length, 1, 'her old code is an alias on the surviving row');
    const gone = db.prepare("SELECT COUNT(*) AS c FROM recruiters r JOIN users u ON u.id = r.user_id WHERE u.username = 'oldrec'").get();
    assert.equal(gone.c, 0, "the target's row is gone (folded)");
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* --------------------------- refusals + duplicate prevention --------------------------- */

test('refusals: fan target 400, admin target 403, protected survivor 403; duplicate signup prevention', async () => {
  const dir = makeCopy('oneaccount-refusals');
  try {
    const h = await boot(dir, { SEED_DEMO: '1' });
    try {
      const survivor = await signup(h.base, 'refgal', 'model');
      const fanTarget = await signup(h.base, 'fantarget', 'fan');

      // target is not an affiliate account
      let r = await req(h.base, 'POST', '/api/affiliate/merge',
        { token: survivor.token, body: { username: 'fantarget', password: 'hunter22' } });
      assert.equal(r.status, 400); assert.equal(r.data.error, 'not_affiliate_account');

      // target is the protected admin (seed) — refused even with the
      // right password, and the admin is untouched afterwards
      r = await req(h.base, 'POST', '/api/affiliate/merge',
        { token: survivor.token, body: { username: 'admin', password: 'admin123' } });
      assert.equal(r.status, 403); assert.equal(r.data.error, 'protected_account');
      const mgr = await mgrLogin(h.base);
      assert.ok(mgr.token, 'admin still signs in after the refused merge');

      // a protected account can never be the survivor either (the
      // seeded fandemo, password fan123, is protected by username)
      const demoLogin = await req(h.base, 'POST', '/api/auth/login',
        { body: { username: 'fandemo', password: 'fan123' } });
      assert.equal(demoLogin.status, 200, 'seeded fandemo signs in');
      const demo = { token: demoLogin.data.token };
      r = await req(h.base, 'POST', '/api/affiliate/attach',
        { token: demo.token, body: { display_name: 'Fan Demo', agreed: true } });
      assert.equal(r.status, 403); assert.equal(r.data.error, 'protected_account');
      r = await req(h.base, 'POST', '/api/affiliate/merge',
        { token: demo.token, body: { username: 'fantarget', password: 'hunter22' } });
      assert.equal(r.status, 403); assert.equal(r.data.error, 'protected_account');

      // --- duplicate prevention at the logged-out affiliate signup ---
      r = await req(h.base, 'POST', '/api/affiliate/signup', {
        body: { username: 'refgal', password: 'hunter22', display_name: 'Copy Cat', agreed: true } });
      assert.equal(r.status, 409); assert.equal(r.data.error, 'already_have_account');
      // an email match stops it too, even under a fresh username
      r = await req(h.base, 'PATCH', '/api/me/contact', { token: survivor.token, body: { email: 'dup@example.com' } });
      assert.equal(r.status, 200);
      r = await req(h.base, 'POST', '/api/affiliate/signup', {
        body: { username: 'brandnewname', password: 'hunter22', display_name: 'Copy Cat', agreed: true, email: 'dup@example.com' } });
      assert.equal(r.status, 409); assert.equal(r.data.error, 'already_have_account');
      // a recruiter username keeps the legacy refusal
      const rec = await affiliateSignup(h.base, 'realrec');
      r = await req(h.base, 'POST', '/api/affiliate/signup', {
        body: { username: 'realrec', password: 'hunter22', display_name: 'Copy Cat', agreed: true } });
      assert.equal(r.status, 409); assert.equal(r.data.error, 'username_taken');
    } finally { stop(h); }

    const db = readDb(dir);
    const n = db.prepare("SELECT COUNT(*) AS c FROM users WHERE username = 'refgal'").get();
    assert.equal(n.c, 1, 'no duplicate account row was created');
    const recRow = db.prepare(`SELECT COUNT(*) AS c FROM recruiters r JOIN users u ON u.id = r.user_id
      WHERE u.username = 'refgal'`).get();
    assert.equal(recRow.c, 0, 'no capability snuck in via the duplicate signup');
    const noNew = db.prepare("SELECT COUNT(*) AS c FROM users WHERE username = 'brandnewname'").get();
    assert.equal(noNew.c, 0, 'email-matched signup created nothing');
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* --------------------------- announcement --------------------------- */

test('announcement: every model DMd + belled exactly once (type one_account); fans none; no re-send on reboot', async () => {
  const SRV = evalConst(serverSrc, 'const SRV =');
  const dir = makeCopy('oneaccount-ann');
  try {
    const h1 = await boot(dir, { SEED_DEMO: '1' });
    stop(h1);
    let db = readDb(dir);
    const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
    assert.ok(admin, 'seeded admin exists');
    const stamp = db.prepare('SELECT one_account_announced_at FROM platform_stats WHERE id = 1').get();
    assert.ok(stamp && stamp.one_account_announced_at, 'announcement stamp is set after first boot');
    const models = db.prepare("SELECT id, username FROM users WHERE role = 'model'").all();
    assert.ok(models.length >= 3, 'seed models exist');
    const dmCount = (modelId) => db.prepare(
      `SELECT COUNT(*) AS c FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE c.fan_id = ? AND c.model_id = ? AND m.sender_id = ? AND m.body = ?`
    ).get(admin.id, modelId, admin.id, SRV.ann_one_account_dm.en).c;
    for (const m of models) {
      assert.equal(dmCount(m.id), 1, `${m.username} got exactly one announcement DM`);
      const bell = db.prepare("SELECT title, body FROM notifications WHERE user_id = ? AND type = 'one_account'").get(m.id);
      assert.ok(bell, `${m.username} got the bell`);
      assert.equal(bell.title, SRV.ann_one_account_bell_title.en);
      assert.equal(bell.body, SRV.ann_one_account_bell_body.en);
    }
    const fan = db.prepare("SELECT id FROM users WHERE role = 'fan' LIMIT 1").get();
    const fanBells = db.prepare("SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND type = 'one_account'").get(fan.id).c;
    assert.equal(fanBells, 0, 'fans receive no model announcement');
    db.close();

    const h2 = await boot(dir, { SEED_DEMO: '1' });
    stop(h2);
    db = readDb(dir);
    for (const m of models) assert.equal(dmCount(m.id), 1, `${m.username}: still exactly one DM after reboot`);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
