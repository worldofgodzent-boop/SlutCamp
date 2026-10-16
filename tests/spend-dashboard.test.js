'use strict';
/*
 * Fan spend dashboard + optional monthly spend cap (owner-authorized
 * quick win, Oct 16 2026) — end to end against the real server.
 *
 * Pins:
 *  - GET /api/me/spending aggregates the transactions ledger exactly the
 *    way chargeFan/refundFan write it: charges by category, refunds
 *    netting via their signed rows, top models, month vs lifetime.
 *    Loads, admin credit grants, chargeback rows, positive admin
 *    'refund' credit-returns and is_test rows NEVER count as spend.
 *  - Month = current UTC calendar month (the ledger's own basis:
 *    created_at is SQLite datetime('now')). A row at 00:00:00 on the
 *    1st counts; one at 23:59:59 on the previous month's last day
 *    does not. Boot B proves this with DB surgery between boots.
 *  - PUT /api/me/spending-cap validation: null clears; whole cents
 *    $10–$100,000 only; everything else 400 bad_cap.
 *  - Enforcement lives in chargeFan: spending UP TO the cap is allowed,
 *    a charge that would CROSS it is refused whole (402
 *    spend_cap_reached with cap_cents + month_spent_cents, no money
 *    moves), across tip_menu + tip + message (three spend types), and
 *    a refund restores headroom. A fan with no cap is untouched, and
 *    the classic insufficient_credits path still answers first-class.
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

/* ---------------- boot harness (mirrors tests/payout-protection.test.js) ---------------- */

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

/* ---------------- scenario helpers ---------------- */

async function signup(base, username, role, displayName) {
  const s = await req(base, 'POST', '/api/auth/signup', {
    body: { username, password: `${username}-pass-123`, role,
      display_name: displayName || username, dob: '1995-05-05', agree18: true },
  });
  assert.equal(s.status, 200, `signup ${username}: ${s.text}`);
  return { token: s.json.token, id: s.json.user.id };
}
const mgrLogin = async (base) => {
  const adm = await req(base, 'POST', '/api/manager/login', { body: { username: 'admin', password: 'admin123' } });
  assert.equal(adm.status, 200, `manager login: ${adm.text}`);
  return { token: adm.json.token, headers: { 'x-manager': '1' } };
};
const grant = async (base, mgr, fanId, cents) => {
  const r = await req(base, 'POST', `/api/admin/fans/${fanId}/credits`, { ...mgr, body: { amount_cents: cents } });
  assert.equal(r.status, 200, `grant: ${r.text}`);
};
const tipMenu = (base, fan, modelId, idx) =>
  req(base, 'POST', `/api/models/${modelId}/tip`, { token: fan.token, body: { menu_id: `default-${idx}`, context: 'profile' } });
const spending = (base, fan) => req(base, 'GET', '/api/me/spending', { token: fan.token });
const setCap = (base, fan, cap_cents) =>
  req(base, 'PUT', '/api/me/spending-cap', { token: fan.token, body: { cap_cents } });
const catOf = (data, cat) => data.by_category.find((c) => c.category === cat);
async function startConv(base, fan, modelId) {
  const r = await req(base, 'POST', '/api/conversations/start', { token: fan.token, body: { model_id: modelId } });
  assert.equal(r.status, 200, `conv start: ${r.text}`);
  return r.json.conversation.id;
}
const sendMsg = (base, fan, convId, text) =>
  req(base, 'POST', '/api/messages', { token: fan.token, body: { conversation_id: convId, body: text } });

/* ---------------- Boot A: API-driven scenario ---------------- */

let A = null;
const S = {};
after(async () => {
  if (A) {
    const dir = A.dir;
    try { await A.kill(); } catch (_) { /* already gone */ }
    // Each boot copies ~46MB into /tmp (a 512MB tmpfs): remove our dirs
    // or repeated full-suite runs fill the disk and later boots die with
    // ENOSPC mid-copy (this exact flake failed a triple-gate run 3 once).
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});
async function bootA() {
  if (A) return A;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-spend-a-'));
  A = await boot(dir);
  S.mgr = await mgrLogin(A.base);
  S.modelA = await signup(A.base, 'spendmodela', 'model', 'Spend Model A');
  S.modelB = await signup(A.base, 'spendmodelb', 'model', 'Spend Model B');
  S.fan1 = await signup(A.base, 'spendfan1', 'fan');
  S.fan2 = await signup(A.base, 'spendfan2', 'fan');
  S.fan3 = await signup(A.base, 'spendfan3', 'fan');
  S.fan4 = await signup(A.base, 'spendfan4', 'fan');
  return A;
}

test('A1: auth gates — guests refused, models forbidden (fans only)', { timeout: 120000 }, async () => {
  const { base } = await bootA();
  const anon = await req(base, 'GET', '/api/me/spending');
  assert.ok([401, 403].includes(anon.status), `anon spending → ${anon.status}`);
  const asModel = await spending(base, S.modelA);
  assert.equal(asModel.status, 403, `model spending: ${asModel.text}`);
  const capAsModel = await setCap(base, S.modelA, 10000);
  assert.equal(capAsModel.status, 403, `model cap write: ${capAsModel.text}`);
});

test('A2: empty state — a fresh fan has zeros, all 11 categories, no cap', { timeout: 120000 }, async () => {
  const { base } = await bootA();
  const r = await spending(base, S.fan3);
  assert.equal(r.status, 200, `spending: ${r.text}`);
  assert.equal(r.json.month_cents, 0);
  assert.equal(r.json.lifetime_cents, 0);
  assert.equal(r.json.cap_cents, null);
  assert.equal(r.json.by_category.length, 11);
  assert.ok(r.json.by_category.every((c) => c.month_cents === 0 && c.lifetime_cents === 0));
  assert.deepEqual(r.json.top_models, []);
});

test('A3: aggregation — real charges land in the right categories and top models', { timeout: 120000 }, async () => {
  const { base } = await bootA();
  await grant(base, S.mgr, S.fan1.id, 50000);
  // tip_menu: $50 + $10 to model A
  assert.equal((await tipMenu(base, S.fan1, S.modelA.id, 4)).status, 200);
  assert.equal((await tipMenu(base, S.fan1, S.modelA.id, 1)).status, 200);
  // plain tip: $25 to model A inside a conversation
  const convA = await startConv(base, S.fan1, S.modelA.id);
  const tip = await req(base, 'POST', '/api/tips', { token: S.fan1.token,
    body: { conversation_id: convA, amount_cents: 2500 } });
  assert.equal(tip.status, 200, `tip: ${tip.text}`);
  // paid message to model B: 3 free, the 4th costs her per-message rate ($1.49)
  const convB = await startConv(base, S.fan1, S.modelB.id);
  for (let i = 0; i < 3; i++)
    assert.equal((await sendMsg(base, S.fan1, convB, `hello ${i}`)).status, 200);
  assert.equal((await sendMsg(base, S.fan1, convB, 'the paid one')).status, 200);

  const r = await spending(base, S.fan1);
  assert.equal(r.status, 200);
  assert.equal(r.json.lifetime_cents, 8649, `lifetime: ${JSON.stringify(r.json)}`);
  assert.equal(r.json.month_cents, 8649, 'everything happened this month');
  assert.equal(catOf(r.json, 'tips').lifetime_cents, 8500, 'tip 2500 + tip_menu 5000 + 1000');
  assert.equal(catOf(r.json, 'messages').lifetime_cents, 149);
  assert.equal(catOf(r.json, 'gifts').lifetime_cents, 0);
  assert.deepEqual(r.json.top_models.map((m) => [m.model_id, m.cents]),
    [[S.modelA.id, 8500], [S.modelB.id, 149]]);
  assert.equal(r.json.top_models[0].display_name, 'Spend Model A');
  assert.equal(r.json.cap_cents, null, 'no cap was ever set');
});

test('A4: cap CRUD validation — null clears, $10–$100,000 whole cents only', { timeout: 120000 }, async () => {
  const { base } = await bootA();
  for (const bad of [500, 999, 10000001, 1050.5, '10000', true, {}]) {
    const r = await setCap(base, S.fan2, bad);
    assert.equal(r.status, 400, `cap ${JSON.stringify(bad)} → ${r.status}`);
    assert.equal(r.json.error, 'bad_cap');
  }
  const noBody = await req(base, 'PUT', '/api/me/spending-cap', { token: S.fan2.token, body: {} });
  assert.equal(noBody.status, 400);
  assert.equal(noBody.json.error, 'bad_cap');

  const ok = await setCap(base, S.fan2, 10000);
  assert.equal(ok.status, 200, `set cap: ${ok.text}`);
  assert.equal(ok.json.cap_cents, 10000);
  assert.equal((await spending(base, S.fan2)).json.cap_cents, 10000, 'GET reflects the stored cap');

  const cleared = await setCap(base, S.fan2, null);
  assert.equal(cleared.status, 200);
  assert.equal(cleared.json.cap_cents, null);
  assert.equal((await spending(base, S.fan2)).json.cap_cents, null, 'cleared cap reads back as null');
});

test('A5: enforcement — up to the cap allowed, the crossing charge refused whole, across types', { timeout: 120000 }, async () => {
  const { base } = await bootA();
  await grant(base, S.mgr, S.fan2.id, 50000);
  await setCap(base, S.fan2, 10000); // $100/month
  const earnBefore = (await req(base, 'GET', '/api/me', { token: S.modelA.token })).json.wallet.earnings_cents;

  assert.equal((await tipMenu(base, S.fan2, S.modelA.id, 4)).status, 200); // $50 → 5000
  assert.equal((await tipMenu(base, S.fan2, S.modelA.id, 4)).status, 200); // $50 → exactly 10000 = the cap

  const cross = await tipMenu(base, S.fan2, S.modelA.id, 1); // $10 would cross
  assert.equal(cross.status, 402, `crossing tip_menu: ${cross.text}`);
  assert.equal(cross.json.error, 'spend_cap_reached');
  assert.equal(cross.json.cap_cents, 10000);
  assert.equal(cross.json.month_spent_cents, 10000);
  assert.equal(cross.json.needed_cents, 1000);

  // No money moved on the refused charge: fan balance and model earnings intact.
  const me = await req(base, 'GET', '/api/me', { token: S.fan2.token });
  assert.equal(me.json.wallet.credits_cents, 40000, 'fan keeps every cent on a refused charge');
  const modelMe = await req(base, 'GET', '/api/me', { token: S.modelA.token });
  assert.equal(modelMe.json.wallet.earnings_cents, earnBefore + 6000,
    'model earned exactly 60% of the $100 that went through — and nothing from the refused charge');

  // A second spend TYPE (paid message to another model) is refused too.
  const convB = await startConv(base, S.fan2, S.modelB.id);
  for (let i = 0; i < 3; i++)
    assert.equal((await sendMsg(base, S.fan2, convB, `free ${i}`)).status, 200, 'free messages are never capped');
  const paidMsg = await sendMsg(base, S.fan2, convB, 'this one costs');
  assert.equal(paidMsg.status, 402, `paid message at cap: ${paidMsg.text}`);
  assert.equal(paidMsg.json.error, 'spend_cap_reached');
  assert.equal(paidMsg.json.cap_cents, 10000);

  // A third spend TYPE (plain tip) is refused too.
  const convA = await startConv(base, S.fan2, S.modelA.id);
  const tip = await req(base, 'POST', '/api/tips', { token: S.fan2.token,
    body: { conversation_id: convA, amount_cents: 500 } });
  assert.equal(tip.status, 402, `plain tip at cap: ${tip.text}`);
  assert.equal(tip.json.error, 'spend_cap_reached');

  const s = await spending(base, S.fan2);
  assert.equal(s.json.month_cents, 10000, 'refusals never touch the ledger totals');
});

test('A6: a refund restores headroom — the fan can spend again up to the cap', { timeout: 120000 }, async () => {
  const { base } = await bootA();
  const refund = await req(base, 'POST', '/api/admin/refunds', { ...S.mgr,
    body: { user_id: S.fan2.id, amount_cents: 5000, reason: 'test refund', model_id: S.modelA.id } });
  assert.equal(refund.status, 200, `refund: ${refund.text}`);

  const s = await spending(base, S.fan2);
  assert.equal(s.json.month_cents, 5000, 'the refund nets against this month');
  assert.equal(s.json.lifetime_cents, 5000);
  assert.equal(catOf(s.json, 'tips').lifetime_cents, 10000, 'charges still read gross in their category');
  assert.equal(catOf(s.json, 'refunds').lifetime_cents, -5000, 'refundFan rows land in the refunds bucket');

  assert.equal((await tipMenu(base, S.fan2, S.modelA.id, 4)).status, 200, '$50 fits again under the cap');
  assert.equal((await spending(base, S.fan2)).json.month_cents, 10000);
  const cross = await tipMenu(base, S.fan2, S.modelA.id, 1);
  assert.equal(cross.status, 402);
  assert.equal(cross.json.error, 'spend_cap_reached', 'and the cap bites again at exactly $100');
});

test('A7: no-cap fan is untouched; insufficient_credits still answers as before', { timeout: 120000 }, async () => {
  const { base } = await bootA();
  await grant(base, S.mgr, S.fan3.id, 50000);
  for (let i = 0; i < 3; i++)
    assert.equal((await tipMenu(base, S.fan3, S.modelA.id, 4)).status, 200, 'no cap → no refusals');
  const s3 = await spending(base, S.fan3);
  assert.equal(s3.json.month_cents, 15000);
  assert.equal(s3.json.cap_cents, null);

  await grant(base, S.mgr, S.fan4.id, 500); // $5 only, no cap
  const broke = await tipMenu(base, S.fan4, S.modelA.id, 1); // $10 item
  assert.equal(broke.status, 402, `broke tip: ${broke.text}`);
  assert.equal(broke.json.error, 'insufficient_credits', 'classic path unchanged by the cap guard');
});

/* ---------------- Boot B: month boundaries + exclusions (DB surgery) ---------------- */

let B = null;
let B_DIR = null;
after(async () => {
  if (B) { try { await B.kill(); } catch (_) { /* already gone */ } }
  if (B_DIR) fs.rmSync(B_DIR, { recursive: true, force: true });
});

const dt = (d) => d.toISOString().slice(0, 19).replace('T', ' ');

test('B1: month aggregation across every type, with exclusions, via ledger surgery', { timeout: 180000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-spend-b-'));
  B_DIR = dir;
  B = await boot(dir);
  const fan9 = await signup(B.base, 'spendfan9', 'fan');
  const modelX = await signup(B.base, 'spendmodelx', 'model', 'Model X');
  const modelY = await signup(B.base, 'spendmodely', 'model', 'Model Y');
  await B.kill();

  const now = new Date();
  const prevMid = dt(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1, 12)));
  const prevEnd = dt(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0, 23, 59, 59)));
  const curStart = dt(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0)));
  const nowStr = dt(now);

  const db = new DatabaseSync(path.join(dir, 'wogent-chat.db'));
  const ins = db.prepare(`INSERT INTO transactions
    (fan_id, model_id, type, gross_cents, model_cents, platform_cents, note, created_at, is_test)
    VALUES (?,?,?,?,?,0,'surgery',?,?)`);
  const row = (model, type, gross, at, isTest = 0) =>
    ins.run(fan9.id, model, type, gross, Math.round(gross * 0.6), at, isTest);
  // Previous month: one of everything, plus the rows that must NOT count.
  row(modelX.id, 'message', 500, prevMid);
  row(modelX.id, 'ppv', 1200, prevMid);
  row(modelX.id, 'voice', 200, prevMid);
  row(modelX.id, 'tip', 1000, prevMid);
  row(modelY.id, 'gift', 2500, prevMid);
  row(modelX.id, 'call', 3000, prevMid);
  row(modelX.id, 'live_explicit', 800, prevMid);
  row(modelX.id, 'booking', 4000, prevMid);
  row(modelX.id, 'game', 700, prevMid);
  row(modelX.id, 'priority', 300, prevMid);
  row(modelY.id, 'tip_menu', 1500, prevMid);
  row(modelX.id, 'call_refund', -1000, prevMid);
  row(modelX.id, 'refund', -2000, prevMid);          // refundFan-style: counts (refunds bucket)
  row(modelX.id, 'message', 99999, prevMid, 1);      // is_test: excluded
  row(null, 'ccbill_load', 50000, prevMid);          // money in: excluded
  row(null, 'credit_grant', 50000, prevMid);         // money in: excluded
  row(null, 'chargeback', -4000, prevMid);           // clawback row: excluded
  row(modelX.id, 'game', 50, prevEnd);               // last second of last month: NOT this month
  // This month.
  row(modelX.id, 'message', 100, curStart);          // first second of the month: counts
  row(modelX.id, 'tip', 5000, nowStr);
  row(modelX.id, 'booking_refund', -4000, nowStr);
  row(null, 'refund', 2000, nowStr);                 // POSITIVE admin credit-return: excluded
  db.close();

  B = await boot(dir);
  const login = await req(B.base, 'POST', '/api/auth/login',
    { body: { username: 'spendfan9', password: 'spendfan9-pass-123' } });
  assert.equal(login.status, 200, `relogin: ${login.text}`);
  const r = await spending(B.base, { token: login.json.token });
  assert.equal(r.status, 200, `spending: ${r.text}`);

  assert.equal(r.json.month_cents, 1100, `month = 100 (boundary) + 5000 tip − 4000 booking_refund: ${JSON.stringify(r.json)}`);
  assert.equal(r.json.lifetime_cents, 13850, 'lifetime nets every counted row, excludes loads/grants/chargeback/is_test/positive refund');
  const expectCat = {
    messages: [100, 600], ppv: [0, 1200], voice: [0, 200], tips: [5000, 7500],
    gifts: [0, 2500], calls: [0, 2000], lives: [0, 800], bookings: [-4000, 0],
    games: [0, 750], tts: [0, 300], refunds: [0, -2000],
  };
  for (const [cat, [m, l]] of Object.entries(expectCat)) {
    const c = catOf(r.json, cat);
    assert.ok(c, `category ${cat} present`);
    assert.equal(c.month_cents, m, `${cat} month`);
    assert.equal(c.lifetime_cents, l, `${cat} lifetime`);
  }
  assert.deepEqual(r.json.top_models.map((m) => [m.display_name, m.cents]),
    [['Model X', 9850], ['Model Y', 4000]]);
  assert.equal(r.json.cap_cents, null, 'surgery fan never set a cap');
});

/* ---------------- source pins ---------------- */

test('pins: routes, funnel guard, migration, client panel + i18n', () => {
  const srv = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
  assert.ok(srv.includes("app.get('/api/me/spending'"), 'GET /api/me/spending route');
  assert.ok(srv.includes("app.put('/api/me/spending-cap'"), 'PUT /api/me/spending-cap route');
  assert.ok(srv.includes("addColumnIfMissing('users', 'spend_cap_cents', 'INTEGER')"), 'additive cap column');
  assert.ok(srv.includes("new Error('spend_cap_reached')"), 'chargeFan throws the cap error');
  assert.ok(srv.includes('function chargeErrorBody'), 'shared charge-error body builder');
  assert.ok(srv.includes("type IN (${SPEND_TYPES_SQL})"), 'aggregation is pinned to the spend type list');
  assert.ok(srv.includes("strftime('%Y-%m-01', 'now')"), 'UTC calendar-month boundary');

  const app = fs.readFileSync(path.join(REPO, 'public/js/app.js'), 'utf8');
  assert.ok(app.includes('async function renderSpendCard()'), 'app.js defines the spending panel');
  assert.ok(app.includes('id="spend-card"'), 'wallet view hosts the panel');
  assert.ok(app.includes("api('/me/spending')"), 'panel reads GET /api/me/spending');
  assert.ok(app.includes("api('/me/spending-cap'"), 'panel writes the cap');
  assert.ok(app.includes('function spendCapToast(data)'), 'shared cap-refusal toast');
  assert.equal((app.match(/spend_cap_reached:/g) || []).length, 3,
    'spend_cap_reached message exists in EN + ES + PT');
  assert.equal((app.match(/spend_h:/g) || []).length, 3, 'spend_h exists in EN + ES + PT');
  assert.equal((app.match(/spend_cat_tts:/g) || []).length, 3, 'category labels exist in EN + ES + PT');
});
