'use strict';
/*
 * Promo signup-bonus links (owner, Oct 24 2026 — revised design).
 *
 * Campaigns are created IN-APP by the HOUSE account only (🎁 Promo
 * links section; /api/promo-campaigns is house-gated, 403 for fans,
 * ordinary models, recruiters and admin sessions alike). Grants are
 * paid out of the HOUSE ACCOUNT'S OWN WALLET inside ONE transaction:
 * house wallet -= amount, fan wallet += amount, a 'promo_grant'
 * ledger row, a promo_grants row, and the campaign drawdown — the
 * grant fires only when the campaign is active, its budget cap still
 * covers the amount, and the house balance covers it too. There is
 * no Manager create/fund endpoint (oversight = list + pause), and
 * 'promo_grant' must NEVER enter the fan-paid money-in totals.
 * The house tops its wallet up through the standard load rails
 * (CCBill checkout + crypto invoices accept the house alongside fans).
 *
 * Pins:
 *  - static: schema (budget_cents — no pool; UNIQUE(campaign_id,
 *    user_id)), house-funded grant transaction, fan-only signup hook,
 *    money-in aggregators never mention promo_grant, Manager create/
 *    fund routes absent, load endpoints house-widened, client route/
 *    banner/toast + house view, STR keys ×13, Manager oversight body.
 *  - live: house-only creation (403 matrix), unfunded house grants
 *    nothing but signup succeeds, paused campaign grants nothing,
 *    funded grants deduct the house + credit the fan atomically,
 *    budget-cap exhaustion stops grants, budget raise re-opens the
 *    cap but a thin house wallet still blocks, budget can't drop
 *    below granted, model-role signup gets nothing, invalid code is
 *    ignored, money-in totals are byte-identical before/after grants,
 *    and spending granted credits pays the model her real 60%.
 */
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const REPO = path.join(__dirname, '..');
const SERVER_SRC = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
const APP_SRC = fs.readFileSync(path.join(REPO, 'public', 'js', 'app.js'), 'utf8');
const MANAGER_SRC = fs.readFileSync(path.join(REPO, 'public', 'manager', 'manager.js'), 'utf8');

/* ---------------- static pins ---------------- */

test('static: schema — budget cap (no pool), one grant per fan per campaign', () => {
  const t = SERVER_SRC.indexOf('CREATE TABLE IF NOT EXISTS promo_campaigns');
  assert.ok(t >= 0, 'promo_campaigns table exists');
  const block = SERVER_SRC.slice(t, t + 1600);
  assert.ok(block.includes('budget_cents'), 'campaign carries a budget cap');
  assert.ok(!block.includes('pool_cents'), 'no pool deposit mechanic');
  assert.ok(block.includes('granted_cents'), 'campaign tracks granted total');
  const g = SERVER_SRC.indexOf('CREATE TABLE IF NOT EXISTS promo_grants');
  assert.ok(g >= 0, 'promo_grants table exists');
  assert.ok(SERVER_SRC.slice(g, g + 700).includes('UNIQUE(campaign_id, user_id)'),
    'one grant per (campaign, fan), ever');
});

test('static: grant is house-funded inside one transaction', () => {
  const start = SERVER_SRC.indexOf('function grantPromoSignup');
  assert.ok(start >= 0, 'grant helper exists');
  const block = SERVER_SRC.slice(start, SERVER_SRC.indexOf('app.get(\'/api/promo/:code\'', start));
  assert.ok(block.includes('txn(() =>'), 'grant runs in ONE db transaction');
  assert.ok(block.includes('houseAccountId()'), 'grant resolves the house account');
  assert.ok(block.includes('credits_cents = credits_cents - ?'), 'house wallet is debited');
  assert.ok(block.includes('credits_cents = credits_cents + ?'), 'fan wallet is credited');
  assert.ok(block.includes('houseWallet.credits_cents < camp.amount_cents'),
    'house balance is checked before granting');
  assert.ok(block.includes('camp.budget_cents - camp.granted_cents < camp.amount_cents'),
    'budget cap is checked before granting');
  assert.ok(block.includes("'promo_grant'"), 'grant books a promo_grant ledger row');
});

test('static: signup hook is fan-only and can never fail a signup', () => {
  const start = SERVER_SRC.indexOf("app.post('/api/auth/signup'");
  const end = SERVER_SRC.indexOf("app.post('/api/auth/quick-signup'", start);
  const block = SERVER_SRC.slice(start, end);
  assert.ok(block.includes("finalRole === 'fan' && promo_code"), 'promo hook is fan-role only');
  assert.ok(block.includes('try { promoGrantedCents = grantPromoSignup'), 'grant is failure-wrapped');
  assert.ok(block.includes('promo_granted_cents: promoGrantedCents'), 'response reports the grant');
});

test('static: money-in aggregators never count promo_grant', () => {
  for (const fn of ['function loadTotalsBySource', 'function fanLoadsBySource']) {
    const start = SERVER_SRC.indexOf(fn);
    assert.ok(start >= 0, fn + ' exists');
    const block = SERVER_SRC.slice(start, start + 3200);
    assert.ok(!block.includes('promo_grant'), fn + ' must not mention promo_grant');
    assert.ok(block.includes("type = 'credit_grant'"), fn + ' counts only the admin-grant rail');
  }
});

test('static: campaign creation is house-only in-app; Manager is oversight-only', () => {
  assert.ok(SERVER_SRC.includes("app.get('/api/promo-campaigns', identMiddleware, requireUser, requireHouseUser"),
    'house campaign list endpoint');
  assert.ok(SERVER_SRC.includes("app.post('/api/promo-campaigns', identMiddleware, requireUser, requireHouseUser"),
    'house campaign create endpoint');
  assert.ok(SERVER_SRC.includes("app.post('/api/promo-campaigns/:id/budget', identMiddleware, requireUser, requireHouseUser"),
    'house budget endpoint');
  assert.ok(SERVER_SRC.includes("app.post('/api/promo-campaigns/:id/active', identMiddleware, requireUser, requireHouseUser"),
    'house pause endpoint');
  assert.ok(SERVER_SRC.includes("app.get('/api/admin/promos', ...adminOnly"), 'Manager oversight list');
  assert.ok(SERVER_SRC.includes("app.post('/api/admin/promos/:id/active', ...adminOnly"), 'Manager pause');
  assert.ok(!SERVER_SRC.includes("app.post('/api/admin/promos', ...adminOnly"),
    'Manager must NOT create campaigns');
  assert.ok(!SERVER_SRC.includes('/api/admin/promos/:id/fund'), 'Manager must NOT fund campaigns');
});

test('static: house can load its wallet on the standard rails', () => {
  assert.ok(SERVER_SRC.includes("app.post('/api/ccbill/checkout', identMiddleware, requireUser, requireFanOrHouse"),
    'CCBill checkout accepts the house');
  assert.ok(SERVER_SRC.includes("app.post('/api/crypto/invoices', identMiddleware, requireUser, requireFanOrHouse"),
    'crypto invoices accept the house');
});

test('static: client — #promo route, banner, grant toast, house view', () => {
  assert.ok(APP_SRC.includes('#promo\\/'), 'hash route for promo links');
  assert.ok(APP_SRC.includes("sessionStorage.setItem('sc_promo_code'"), 'code stashed per tab session');
  assert.ok(APP_SRC.includes("promo_granted_cents"), 'client reads the granted amount');
  assert.ok(APP_SRC.includes("t('promo_granted'"), 'grant confirmation toast is localized');
  assert.ok(APP_SRC.includes("t('promo_bonus_banner'"), 'signup bonus banner is localized');
  assert.ok(APP_SRC.includes('id="promo-banner-slot"'), 'banner slot on the fan signup door');
  assert.ok(APP_SRC.includes('async function vHousePromos('), 'house campaign view exists');
  assert.ok(APP_SRC.includes('housePromos: vHousePromos'), 'house view registered');
  assert.ok(APP_SRC.includes("show('wallet', {})"), 'house view links to the Add-money door');
  assert.equal((APP_SRC.match(/promo_bonus_banner:/g) || []).length, 13, 'banner string ×13');
  assert.equal((APP_SRC.match(/promo_granted:/g) || []).length, 13, 'granted string ×13');
});

test('static: Manager — oversight screen with pause, no create/fund', () => {
  assert.ok(MANAGER_SRC.includes('adminPromosBody'), 'Manager promos screen exists');
  assert.ok(MANAGER_SRC.includes("'/admin/promos'"), 'Manager lists campaigns');
  assert.ok(MANAGER_SRC.includes('data-promo-toggle'), 'Manager can pause/resume');
  assert.ok(!MANAGER_SRC.includes('/fund'), 'Manager has no funding action');
});

/* ---------------- boot harness (mirrors tests/moneyin-total.test.js) ---------------- */

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function boot(dir) {
  for (const d of ['server.js', 'package.json', 'lib', 'public', 'data']) {
    fs.cpSync(path.join(REPO, d), path.join(dir, d), { recursive: true });
  }
  if (!fs.existsSync(path.join(dir, 'node_modules'))) {
    fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  }
  const port = await freePort();
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(CCBILL_|CRYPTO_|OPENAI_|TWILIO_|VAPID_|WEBAUTHN_)/.test(k)) delete env[k];
  }
  Object.assign(env, { PORT: String(port), SEED_DEMO: '1', CRYPTO_POLL_MS: '3600000' });
  const child = spawn(process.execPath, ['server.js'], { cwd: dir, env });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode})\n${log}`);
    try { const r = await fetch(base + '/api/health'); if (r.ok) break; } catch (e) { /* not up */ }
    if (Date.now() > deadline) throw new Error(`server did not come up\n${log}`);
    await new Promise((r) => setTimeout(r, 150));
  }
  return { dir, base, child, log: () => log,
    async kill() { if (child.exitCode === null) child.kill('SIGKILL'); await new Promise((r) => setTimeout(r, 300)); } };
}

async function req(base, method, p, { body, token, headers } = {}) {
  const h = { ...(headers || {}) };
  let payload;
  if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  if (token) h.authorization = 'Bearer ' + token;
  const r = await fetch(base + p, { method, headers: h, body: payload });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not json */ }
  return { status: r.status, json, text };
}

const mgrLogin = async (base) => {
  const adm = await req(base, 'POST', '/api/manager/login', { body: { username: 'admin', password: 'admin123' } });
  assert.equal(adm.status, 200, `manager login: ${adm.text}`);
  return { token: adm.json.token, headers: { 'x-manager': '1' } };
};

const signup = (base, body) => req(base, 'POST', '/api/auth/signup', { body: {
  password: 'promo-pass-123', display_name: 'Promo Tester', dob: '1995-05-05', agree18: true, ...body } });

/* ---------------- live scenario ---------------- */

let B = null;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-promo-'));
after(async () => {
  if (B) { try { await B.kill(); } catch (_) { /* already gone */ } }
  fs.rmSync(dir, { recursive: true, force: true });
});

const S = {}; // ids/tokens carried across boots

test('live boot 1: house-only creation, unfunded house grants nothing, load rails widened',
  { timeout: 180000 }, async () => {
    const b1 = await boot(dir);
    const mgr = await mgrLogin(b1.base);

    // Money-in baseline (must be byte-identical after promo grants).
    const loads0 = await req(b1.base, 'GET', '/api/admin/loads?limit=100', { ...mgr });
    assert.equal(loads0.status, 200, `loads baseline: ${loads0.text}`);
    S.baselineTotal = loads0.json.totals.all_time.total_cents;
    S.baselineAdmin = loads0.json.totals.all_time.admin_cents;
    const ov0 = await req(b1.base, 'GET', '/api/admin/overview', { ...mgr });
    S.baselineOverview = ov0.json.money_in_all_time_cents;

    // The house account: a model-role signup under the house username.
    const hs = await signup(b1.base, { username: 'asceaaspade', role: 'model',
      display_name: '🔴 SlutCamp Live', dob: '1990-01-01', section: 'female' });
    assert.equal(hs.status, 200, `house signup: ${hs.text}`);
    assert.equal(hs.json.promo_granted_cents, 0, 'house signup itself gets no promo');
    S.houseId = hs.json.user.id;
    S.houseToken = hs.json.token;
    const me = await req(b1.base, 'GET', '/api/me', { token: S.houseToken });
    assert.equal(me.json.user.is_house, true, 'house flag rides /api/me');

    // House creates a campaign in-app: $5 per signup, $10 budget cap.
    const cc = await req(b1.base, 'POST', '/api/promo-campaigns', { token: S.houseToken,
      body: { label: 'Launch week', amount_cents: 500, budget_cents: 1000 } });
    assert.equal(cc.status, 200, `campaign create: ${cc.text}`);
    S.campId = cc.json.campaign.id;
    S.code = cc.json.campaign.code;
    assert.match(S.code, /^[a-f0-9]{12}$/, 'campaign code shape');
    assert.equal(cc.json.url, '/#promo/' + S.code, 'shareable link');

    // Creation is HOUSE-ONLY: fan, ordinary model, admin session, anon.
    const fan0 = await signup(b1.base, { username: 'promofan0', role: 'fan' });
    assert.equal(fan0.status, 200, `fan signup: ${fan0.text}`);
    const mod0 = await signup(b1.base, { username: 'promomodel0', role: 'model', section: 'female' });
    assert.equal(mod0.status, 200, `model signup: ${mod0.text}`);
    for (const [who, tok] of [['fan', fan0.json.token], ['model', mod0.json.token], ['admin', mgr.token]]) {
      const r = await req(b1.base, 'POST', '/api/promo-campaigns', { token: tok,
        body: { label: 'Nope', amount_cents: 100, budget_cents: 100 } });
      assert.equal(r.status, 403, `${who} must not create campaigns: ${r.text}`);
    }
    const anon = await req(b1.base, 'POST', '/api/promo-campaigns',
      { body: { label: 'Nope', amount_cents: 100, budget_cents: 100 } });
    assert.equal(anon.status, 401, `anon create is 401: ${anon.text}`);

    // House wallet is empty → the link grants nothing (and says so),
    // but a signup through it still succeeds with NO bonus promised.
    const pub = await req(b1.base, 'GET', '/api/promo/' + S.code);
    assert.equal(pub.status, 200);
    assert.deepEqual(Object.keys(pub.json).sort(), ['amount_cents', 'available'],
      'public check exposes nothing internal');
    assert.equal(pub.json.available, false, 'unfunded house → unavailable');
    const fan1 = await signup(b1.base, { username: 'promofan1', role: 'fan', promo_code: S.code });
    assert.equal(fan1.status, 200, `fan1 signup: ${fan1.text}`);
    assert.equal(fan1.json.promo_granted_cents, 0, 'no grant while the house wallet is empty');
    S.fan1Id = fan1.json.user.id;
    const camps = await req(b1.base, 'GET', '/api/promo-campaigns', { token: S.houseToken });
    assert.equal(camps.json.house_balance_cents, 0, 'house balance untouched by the skipped grant');
    assert.equal(camps.json.campaigns[0].granted_cents, 0, 'campaign granted nothing');

    // Load rails: house passes the door (503 = rail not configured in
    // the test env, i.e. it reached the service); a plain model 403s.
    const inv = await req(b1.base, 'POST', '/api/crypto/invoices', { token: S.houseToken,
      body: { package_id: 'p10', coin: 'USDT' } });
    assert.notEqual(inv.status, 403, `house crypto invoice must pass the role door: ${inv.text}`);
    assert.notEqual(inv.status, 401, 'house crypto invoice is authenticated');
    const invM = await req(b1.base, 'POST', '/api/crypto/invoices', { token: mod0.json.token,
      body: { package_id: 'p10', coin: 'USDT' } });
    assert.equal(invM.status, 403, `ordinary model stays out of loads: ${invM.text}`);
    const co = await req(b1.base, 'POST', '/api/ccbill/checkout', { token: S.houseToken,
      body: { package_id: 'p10' } });
    assert.equal(co.status, 503, `house CCBill checkout reaches the (unconfigured) rail: ${co.text}`);
    assert.equal(co.json.error, 'payment_not_connected');
    const coM = await req(b1.base, 'POST', '/api/ccbill/checkout', { token: mod0.json.token,
      body: { package_id: 'p10' } });
    assert.equal(coM.status, 403, `ordinary model stays out of CCBill loads: ${coM.text}`);
    const coF = await req(b1.base, 'POST', '/api/ccbill/checkout', { token: fan0.json.token,
      body: { package_id: 'p10' } });
    assert.equal(coF.status, 503, 'fan CCBill path unchanged');

    await b1.kill();

    // Fund the house wallet directly (the test stand-in for a load).
    const db = new DatabaseSync(path.join(dir, 'wogent-chat.db'));
    db.prepare('UPDATE wallets SET credits_cents = 1200 WHERE user_id = ?').run(S.houseId);
    db.close();
  });

test('live boot 2: pause blocks, funded grants move house money, budget + balance caps bite',
  { timeout: 180000 }, async () => {
    const b2 = await boot(dir);
    B = b2;
    const mgr = await mgrLogin(b2.base);

    // Paused via the Manager → signup succeeds, NO grant.
    const pause = await req(b2.base, 'POST', `/api/admin/promos/${S.campId}/active`,
      { ...mgr, body: { active: false } });
    assert.equal(pause.status, 200, `manager pause: ${pause.text}`);
    assert.equal(pause.json.campaign.active, false);
    const fan2 = await signup(b2.base, { username: 'promofan2', role: 'fan', promo_code: S.code });
    assert.equal(fan2.status, 200, `fan2 signup: ${fan2.text}`);
    assert.equal(fan2.json.promo_granted_cents, 0, 'paused campaign grants nothing');
    const resume = await req(b2.base, 'POST', `/api/admin/promos/${S.campId}/active`,
      { ...mgr, body: { active: true } });
    assert.equal(resume.status, 200, `manager resume: ${resume.text}`);

    const pub = await req(b2.base, 'GET', '/api/promo/' + S.code);
    assert.equal(pub.json.available, true, 'funded + active → available');
    assert.equal(pub.json.amount_cents, 500, 'banner amount is the per-signup bonus');

    // Two funded grants: house 1200 → 200, campaign granted hits budget.
    const hlogin = await req(b2.base, 'POST', '/api/auth/login',
      { body: { username: 'asceaaspade', password: 'promo-pass-123' } });
    assert.equal(hlogin.status, 200, `house login: ${hlogin.text}`);
    S.houseToken = hlogin.json.token;
    const fan3 = await signup(b2.base, { username: 'promofan3', role: 'fan', promo_code: S.code });
    assert.equal(fan3.status, 200, `fan3 signup: ${fan3.text}`);
    assert.equal(fan3.json.promo_granted_cents, 500, 'first funded grant lands');
    S.fan3Id = fan3.json.user.id;
    S.fan3Token = fan3.json.token;
    let camps = await req(b2.base, 'GET', '/api/promo-campaigns', { token: S.houseToken });
    assert.equal(camps.json.house_balance_cents, 700, 'house wallet debited by the grant');
    assert.equal(camps.json.campaigns[0].granted_cents, 500, 'campaign drew down');
    assert.equal(camps.json.campaigns[0].signups, 1, 'one granted signup');
    const fan4 = await signup(b2.base, { username: 'promofan4', role: 'fan', promo_code: S.code });
    assert.equal(fan4.json.promo_granted_cents, 500, 'second funded grant lands');
    S.fan4Id = fan4.json.user.id;

    // Budget cap reached (granted 1000 = budget) → no more grants.
    const pub2 = await req(b2.base, 'GET', '/api/promo/' + S.code);
    assert.equal(pub2.json.available, false, 'budget used up → unavailable');
    const fan5 = await signup(b2.base, { username: 'promofan5', role: 'fan', promo_code: S.code });
    assert.equal(fan5.status, 200, `fan5 signup: ${fan5.text}`);
    assert.equal(fan5.json.promo_granted_cents, 0, 'budget-cap reached → no grant');

    // Raise the budget in-app → now the HOUSE BALANCE (200 < 500) blocks.
    const raise = await req(b2.base, 'POST', `/api/promo-campaigns/${S.campId}/budget`,
      { token: S.houseToken, body: { budget_cents: 1500 } });
    assert.equal(raise.status, 200, `budget raise: ${raise.text}`);
    assert.equal(raise.json.campaign.budget_cents, 1500);
    const pub3 = await req(b2.base, 'GET', '/api/promo/' + S.code);
    assert.equal(pub3.json.available, false, 'thin house wallet → still unavailable');
    const fan6 = await signup(b2.base, { username: 'promofan6', role: 'fan', promo_code: S.code });
    assert.equal(fan6.status, 200, `fan6 signup: ${fan6.text}`);
    assert.equal(fan6.json.promo_granted_cents, 0, 'house-insufficient → no grant, signup fine');
    camps = await req(b2.base, 'GET', '/api/promo-campaigns', { token: S.houseToken });
    assert.equal(camps.json.house_balance_cents, 200, 'house wallet untouched by skipped grants');

    // Budget can never drop below what is already granted.
    const low = await req(b2.base, 'POST', `/api/promo-campaigns/${S.campId}/budget`,
      { token: S.houseToken, body: { budget_cents: 500 } });
    assert.equal(low.status, 400, `budget below granted refused: ${low.text}`);

    // Model-role signup carrying the code gets NOTHING.
    const mod2 = await signup(b2.base, { username: 'promomodel2', role: 'model',
      section: 'female', promo_code: S.code });
    assert.equal(mod2.status, 200, `model2 signup: ${mod2.text}`);
    assert.equal(mod2.json.promo_granted_cents, 0, 'models never receive promo grants');
    S.model2Id = mod2.json.user.id;

    // Invalid code is ignored; the signup still succeeds.
    const fan7 = await signup(b2.base, { username: 'promofan7', role: 'fan', promo_code: 'deadbeefdead' });
    assert.equal(fan7.status, 200, `fan7 signup: ${fan7.text}`);
    assert.equal(fan7.json.promo_granted_cents, 0, 'invalid code grants nothing');

    // Money-in truth: grants moved HOUSE money — the fan-paid totals
    // are byte-identical to the pre-grant baseline.
    const loads1 = await req(b2.base, 'GET', '/api/admin/loads?limit=100', { ...mgr });
    assert.equal(loads1.json.totals.all_time.total_cents, S.baselineTotal,
      'money-in total unchanged by promo grants');
    assert.equal(loads1.json.totals.all_time.admin_cents, S.baselineAdmin,
      'admin rail unchanged by promo grants');
    const ov1 = await req(b2.base, 'GET', '/api/admin/overview', { ...mgr });
    assert.equal(ov1.json.money_in_all_time_cents, S.baselineOverview,
      'overview money-in unchanged by promo grants');

    // Manager oversight: list + no create/fund doors at all.
    const list = await req(b2.base, 'GET', '/api/admin/promos', { ...mgr });
    assert.equal(list.status, 200, `oversight list: ${list.text}`);
    assert.equal(list.json.promos.length, 1);
    assert.equal(list.json.promos[0].granted_cents, 1000, 'oversight sees granted total');
    assert.equal(list.json.promos[0].signups, 2, 'oversight sees granted signup count');
    assert.equal(list.json.house_balance_cents, 200, 'oversight sees the backing house balance');
    const mCreate = await req(b2.base, 'POST', '/api/admin/promos',
      { ...mgr, body: { label: 'Nope', amount_cents: 100, budget_cents: 100 } });
    assert.equal(mCreate.status, 404, `Manager cannot create campaigns: ${mCreate.text}`);
    const mFund = await req(b2.base, 'POST', `/api/admin/promos/${S.campId}/fund`,
      { ...mgr, body: { amount_cents: 100 } });
    assert.equal(mFund.status, 404, `Manager cannot fund campaigns: ${mFund.text}`);
    const fanList = await req(b2.base, 'GET', '/api/admin/promos',
      { token: S.fan3Token, headers: { 'x-manager': '1' } });
    assert.equal(fanList.status, 403, `fans stay out of the oversight list: ${fanList.text}`);

    await b2.kill();
    B = null;

    // A chat thread for the spend test (fan3 ↔ model2).
    const db = new DatabaseSync(path.join(dir, 'wogent-chat.db'));
    const conv = db.prepare('INSERT INTO conversations (fan_id, model_id) VALUES (?, ?)')
      .run(S.fan3Id, S.model2Id);
    S.convId = Number(conv.lastInsertRowid);
    db.close();
  });

test('live boot 3: spending granted credits pays the model her real 60%; ledger is exact',
  { timeout: 180000 }, async () => {
    const b3 = await boot(dir);
    B = b3;
    const flogin = await req(b3.base, 'POST', '/api/auth/login',
      { body: { username: 'promofan3', password: 'promo-pass-123' } });
    assert.equal(flogin.status, 200, `fan3 login: ${flogin.text}`);
    const tip = await req(b3.base, 'POST', '/api/tips', { token: flogin.json.token,
      body: { conversation_id: S.convId, amount_cents: 200 } });
    assert.equal(tip.status, 200, `tip from granted credits: ${tip.text}`);
    await b3.kill();
    B = null;

    const db = new DatabaseSync(path.join(dir, 'wogent-chat.db'), { readOnly: true });
    const wallet = (uid) => db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(uid);
    assert.equal(wallet(S.houseId).credits_cents, 200, 'house paid exactly two grants');
    assert.equal(wallet(S.fan3Id).credits_cents, 300, 'fan3 kept 500 grant − 200 tip');
    assert.equal(wallet(S.fan4Id).credits_cents, 500, 'fan4 kept the full grant');
    assert.equal(wallet(S.model2Id).earnings_cents, 120, 'model earned her real 60% of the tip');

    const grants = db.prepare("SELECT * FROM transactions WHERE type = 'promo_grant' ORDER BY id").all();
    assert.equal(grants.length, 2, 'exactly two promo_grant ledger rows');
    assert.deepEqual(grants.map((g) => g.fan_id).sort(), [S.fan3Id, S.fan4Id].sort(),
      'grants went to the two funded fans only');
    for (const g of grants) assert.equal(g.gross_cents, 500, 'grant row carries the bonus');
    const tipRow = db.prepare("SELECT * FROM transactions WHERE type = 'tip'").get();
    assert.equal(tipRow.gross_cents, 200);
    assert.equal(tipRow.model_cents, 120, 'tip split: model 60%');
    assert.equal(tipRow.platform_cents, 80, 'tip split: platform 40%');

    const pgrants = db.prepare('SELECT * FROM promo_grants ORDER BY id').all();
    assert.equal(pgrants.length, 2, 'exactly two grant rows');
    const dupes = db.prepare(`SELECT campaign_id, user_id, COUNT(*) AS n FROM promo_grants
      GROUP BY campaign_id, user_id HAVING n > 1`).all();
    assert.equal(dupes.length, 0, 'no fan ever granted twice on one campaign');
    const camp = db.prepare('SELECT * FROM promo_campaigns WHERE id = ?').get(S.campId);
    assert.equal(camp.granted_cents, 1000, 'campaign drawdown is exact');
    assert.equal(camp.budget_cents, 1500, 'raised budget persisted');
    db.close();
  });
