'use strict';
/*
 * Payout Protection tests — earnings maturity (7-day hold), the
 * chargeback clawback engine (strict reversal order, exactly-once),
 * fraud flags, and the Manager gates. Real server over HTTP on a
 * throwaway temp copy, like the crypto e2e suite; CCBill loads go
 * through the REAL checkout + webhook path with FAKE env credentials
 * (dummy values invented for these tests only — no live processor,
 * no real money). Time travel is done by editing the temp DB between
 * boots, never by waiting.
 *
 * Money fixtures (60/40 split throughout):
 *  - fan1 loads $100 (CCBill), tips model A $50 + $10 → A earns $36 held.
 *  - fan3 loads $150, tips A $150 (concentration). fan4 loads $200 and
 *    splits $75/$75 between A and B (control) + $5 more to B later.
 *  - model D: fan6 loads $120, tips D $95; five more fans load $10 and
 *    tip D $5 each → 6 attributed loads for the chargeback-rate flag.
 */
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const REPO = path.join(__dirname, '..');
const FAKE_CCBILL = {
  CCBILL_ACCNUM: '900000001', CCBILL_SUBACC: '0001',
  CCBILL_FLEXFORM_ID: 'fake-flexform-id', CCBILL_SALT: 'fake-salt-for-tests-only',
};
const SOL_ADDR = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // throwaway fixture
const PRICES = { bitcoin: { usd: 50000 }, tether: { usd: 1 }, ethereum: { usd: 2500 }, solana: { usd: 100 }, ripple: { usd: 0.5 } };

let stub = null;
function startStub() {
  if (stub) return;
  stub = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/prices')) return res.end(JSON.stringify(PRICES));
    res.end(JSON.stringify({}));
  });
}

/* ---------------- boot harness (mirrors tests/crypto-e2e.test.js) ---------------- */

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
  Object.assign(env, {
    PORT: String(port), SEED_DEMO: '1', CRYPTO_POLL_MS: '3600000',
    ...FAKE_CCBILL, CCBILL_MAX_CENTS: '100000', // test-only: allow $150/$200 fixture loads
    CRYPTO_SOL_ADDRESS: SOL_ADDR,
    CRYPTO_PRICE_URL: `http://127.0.0.1:${stub.address().port}/prices`,
  });
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

async function req(base, method, p, { body, token, headers, form } = {}) {
  const h = { ...(headers || {}) };
  let payload;
  if (form !== undefined) { h['content-type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(form).toString(); }
  else if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  if (token) h.authorization = 'Bearer ' + token;
  const r = await fetch(base + p, { method, headers: h, body: payload });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not json */ }
  return { status: r.status, json, text };
}

/* ---------------- scenario helpers ---------------- */

async function signup(base, username, role) {
  const s = await req(base, 'POST', '/api/auth/signup', {
    body: { username, password: `${username}-pass-123`, role,
      display_name: username, dob: '1995-05-05', agree18: true },
  });
  assert.equal(s.status, 200, `signup ${username}: ${s.text}`);
  return { token: s.json.token, id: s.json.user.id };
}
const mgrLogin = async (base) => {
  const adm = await req(base, 'POST', '/api/manager/login', { body: { username: 'admin', password: 'admin123' } });
  assert.equal(adm.status, 200, `manager login: ${adm.text}`);
  return { token: adm.json.token, headers: { 'x-manager': '1' } };
};
// Real CCBill load: checkout → FlexForms URL carries the order token →
// success webhook credits the fan exactly once. Returns the order id.
async function ccbillLoad(base, fan, mgr, amountCents) {
  const co = await req(base, 'POST', '/api/ccbill/checkout', { token: fan.token, body: { amount_cents: amountCents } });
  assert.equal(co.status, 200, `checkout: ${co.text}`);
  const token = new URL(co.json.url).searchParams.get('order_id');
  assert.ok(token, 'checkout URL carries the order token');
  const wh = await req(base, 'POST', '/api/ccbill/webhook', { form: { eventType: 'NewSaleSuccess', order_id: token } });
  assert.equal(wh.status, 200, `webhook: ${wh.text}`);
  assert.equal(wh.json.handled, 'credited', `webhook handled: ${wh.text}`);
  const orders = await req(base, 'GET', '/api/admin/ccbill/orders', { ...mgr });
  const order = orders.json.orders.find((o) => o.user_id === fan.id && o.amount_cents === amountCents && o.status === 'credited');
  assert.ok(order, 'credited order visible to admin');
  return order.id;
}
const tip = async (base, fan, modelId, menuIdx) => {
  const r = await req(base, 'POST', `/api/models/${modelId}/tip`,
    { token: fan.token, body: { menu_id: `default-${menuIdx}`, context: 'profile' } });
  assert.equal(r.status, 200, `tip: ${r.text}`);
  return r.json;
};
async function setupPayout(base, model) {
  const pa = await req(base, 'POST', '/api/model/payout-account', { token: model.token,
    body: { holder_name: 'Test Model', routing_number: '021000021', account_number: '123456789' } });
  assert.equal(pa.status, 200, `payout account: ${pa.text}`);
  const tp = await req(base, 'POST', '/api/tax-profile', { token: model.token,
    body: { legal_name: 'Test Model', tax_id_type: 'ssn', tax_id: '123456789',
      address_line1: '1 Main St', city: 'Dallas', state: 'TX', zip: '75001' } });
  assert.equal(tp.status, 200, `tax profile: ${tp.text}`);
}
const modelWithdrawals = (base, model) => req(base, 'GET', '/api/model/withdrawals', { token: model.token });
const adminPayoutRow = async (base, mgr, modelId) => {
  const r = await req(base, 'GET', '/api/admin/payouts', mgr);
  assert.equal(r.status, 200, `admin payouts: ${r.text}`);
  return r.json.payouts.find((p) => p.id === modelId);
};
const fanCredits = async (base, fan) => (await req(base, 'GET', '/api/me', { token: fan.token })).json.wallet.credits_cents;

/* ---------------- Boot A: the main scenario ---------------- */

let A = null;
const S = {}; // shared scenario actors
after(async () => { // never leave a scenario server holding the process open
  if (A) { try { await A.kill(); } catch (_) { /* already gone */ } }
  if (stub) { try { stub.close(); } catch (_) { /* already closed */ } }
});
async function bootA() {
  if (A) return A;
  startStub();
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-payout-a-'));
  A = await boot(dir);
  S.mgr = await mgrLogin(A.base);
  S.modelA = await signup(A.base, 'modela', 'model');
  S.modelB = await signup(A.base, 'modelb', 'model');
  S.modelD = await signup(A.base, 'modeld', 'model');
  S.fan1 = await signup(A.base, 'fanone', 'fan');
  S.fan3 = await signup(A.base, 'fanthree', 'fan');
  S.fan4 = await signup(A.base, 'fanfour', 'fan');
  S.fan6 = await signup(A.base, 'fansix', 'fan');
  return A;
}

test('A1: hold default is pinned at 7 days; flag settings carry their defaults', { timeout: 120000 }, async () => {
  const { base } = await bootA();
  const st = await req(base, 'GET', '/api/admin/stats', S.mgr);
  assert.equal(st.status, 200, `stats: ${st.text}`);
  assert.equal(st.json.earnings_hold_days, 7, 'HOLD_DAYS default must be 7 (owner rule: one week behind)');
  assert.equal(st.json.flag_concentration_pct, 80);
  assert.equal(st.json.flag_concentration_min_cents, 10000);
  assert.equal(st.json.flag_concentration_days, 30);
  assert.equal(st.json.flag_cb_escalate_count, 2);
  assert.equal(st.json.flag_cb_escalate_rate_pct, 20);
});

test('A2: maturity — new earnings are held, not withdrawable, on BOTH the model and Manager paths', { timeout: 120000 }, async () => {
  const { base } = await bootA();
  S.order1 = await ccbillLoad(base, S.fan1, S.mgr, 10000); // $100 card load
  assert.equal(await fanCredits(base, S.fan1), 10000);
  await tip(base, S.fan1, S.modelA.id, 4); // $50
  await tip(base, S.fan1, S.modelA.id, 1); // $10 → A earns 60% of $60 = $36, all held
  const wd = await modelWithdrawals(base, S.modelA);
  assert.equal(wd.json.available_cents, 0, 'nothing withdrawable inside the hold window');
  assert.equal(wd.json.holding_cents, 3600, 'the full $36 is still in its first week');
  assert.equal(wd.json.hold_days, 7);
  assert.equal(wd.json.negative_adjustment_cents, 0);
  await setupPayout(base, S.modelA);
  const ask = await req(base, 'POST', '/api/model/withdrawals', { token: S.modelA.token, body: { amount_cents: 100 } });
  assert.equal(ask.status, 400, 'model cannot request held money');
  assert.equal(ask.json.error, 'insufficient_funds');
  const direct = await req(base, 'POST', `/api/admin/payouts/${S.modelA.id}`, { ...S.mgr, body: { amount_cents: 100 } });
  assert.equal(direct.status, 400, 'Manager direct payout is capped at withdrawable too');
  assert.equal(direct.json.error, 'exceeds_withdrawable');
  assert.equal(direct.json.withdrawable_cents, 0);
});

test('A3: flags — concentration fires for the all-in new fan, not for the split control; shared card fires', { timeout: 120000 }, async () => {
  const { base } = await bootA();
  await ccbillLoad(base, S.fan3, S.mgr, 15000);
  for (let i = 0; i < 3; i++) await tip(base, S.fan3, S.modelA.id, 4); // $150, 100% on A
  await ccbillLoad(base, S.fan4, S.mgr, 20000);
  await tip(base, S.fan4, S.modelA.id, 4); await tip(base, S.fan4, S.modelA.id, 2); // $75 on A
  await tip(base, S.fan4, S.modelB.id, 4); await tip(base, S.fan4, S.modelB.id, 2); // $75 on B
  // Both fans present the same card fingerprint at the (stubbed) buy path.
  for (const f of [S.fan3, S.fan4]) {
    const buy = await req(base, 'POST', '/api/credits/buy', { token: f.token,
      body: { package: 'p10', card_fingerprint: 'fp-shared-test-1' } });
    assert.equal(buy.status, 501, 'legacy buy path stays a stub; the attempt is what gets logged');
  }
  const rowA = await adminPayoutRow(base, S.mgr, S.modelA.id);
  const conc = rowA.flags.filter((f) => f.kind === 'concentration');
  assert.ok(conc.some((f) => f.fan_id === S.fan3.id), `concentration flag for fan3: ${JSON.stringify(rowA.flags)}`);
  assert.ok(!conc.some((f) => f.fan_id === S.fan4.id), 'split-spend control fan must NOT be flagged');
  assert.ok(conc.find((f) => f.fan_id === S.fan3.id).label.includes('concentrated spend'));
  assert.ok(rowA.flags.some((f) => f.kind === 'shared_card'), `shared-card flag: ${JSON.stringify(rowA.flags)}`);
  assert.ok(!rowA.flags.some((f) => f.kind === 'chargeback_rate'), 'no chargebacks yet → no chargeback flag');
});

test('A4: clawback order 1→2→3 with partial coverage, idempotent replay, second chargeback, per-load cap', { timeout: 120000 }, async () => {
  const { base } = await bootA();
  // fan1: $100 load, $60 spent (A holds $36), $40 unspent. CB the full $100.
  const cb1 = await req(base, 'POST', '/api/admin/chargebacks', { ...S.mgr,
    body: { user_id: S.fan1.id, amount_cents: 10000, external_id: 'cb-1', load_ref: String(S.order1), reason: 'test chargeback' } });
  assert.equal(cb1.status, 200, `cb1: ${cb1.text}`);
  assert.deepEqual(cb1.json.reversed, { fan_cents: 4000, model_cents: 3600, negative_cents: 2400, platform_absorbed_cents: 0 },
    'step 1 takes the $40 unspent, step 2 the $36 held earnings, step 3 leaves $24 negative');
  assert.equal(await fanCredits(base, S.fan1), 0, "fan's unspent credits are gone");
  const wdA = await modelWithdrawals(base, S.modelA);
  assert.equal(wdA.json.holding_cents, 13500, "A still holds fan3's $90 + fan4's $45 — only fan1's pair was reversed");
  assert.equal(wdA.json.negative_adjustment_cents, 2400, 'the $24 remainder is a negative adjustment');
  assert.equal(wdA.json.available_cents, 0);
  // Ledger: one chargebacks row with the full allocation trail.
  const list = await req(base, 'GET', '/api/admin/chargebacks', S.mgr);
  const row = list.json.chargebacks.find((c) => c.external_id === 'cb-1');
  assert.ok(row, 'chargeback listed for the Manager');
  assert.equal(row.load_ref, `ccbill_order:${S.order1}`);
  const byStep = {};
  for (const a of row.allocations) byStep[a.step] = (byStep[a.step] || 0) + a.amount_cents;
  assert.deepEqual(byStep, { 1: 4000, 2: 3600, 3: 2400 });
  assert.equal(row.allocations.find((a) => a.step === 2).bucket, 'held', 'held earnings reverse before matured');
  // Replay: exact same (source, external_id) → no-op, nothing moves.
  const replay = await req(base, 'POST', '/api/admin/chargebacks', { ...S.mgr,
    body: { user_id: S.fan1.id, amount_cents: 10000, external_id: 'cb-1', load_ref: String(S.order1) } });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.duplicate, true, 'replay is an idempotent no-op');
  assert.equal(await fanCredits(base, S.fan1), 0);
  assert.equal((await modelWithdrawals(base, S.modelA)).json.negative_adjustment_cents, 2400, 'replay moved nothing');
  // A second, DISTINCT chargeback processes only its own amount: fan1 is
  // broke and the pair is fully reversed, so it lands entirely in step 3.
  const cb2 = await req(base, 'POST', '/api/admin/chargebacks', { ...S.mgr,
    body: { user_id: S.fan1.id, amount_cents: 1000, external_id: 'cb-2' } });
  assert.equal(cb2.status, 200, `cb2: ${cb2.text}`);
  assert.deepEqual(cb2.json.reversed, { fan_cents: 0, model_cents: 0, negative_cents: 1000, platform_absorbed_cents: 0 });
  assert.equal((await modelWithdrawals(base, S.modelA)).json.negative_adjustment_cents, 3400);
  // Per-load cap: the $100 load is already fully reversed — a third
  // chargeback tied to that load reverses nothing more.
  const cb3 = await req(base, 'POST', '/api/admin/chargebacks', { ...S.mgr,
    body: { user_id: S.fan1.id, amount_cents: 5000, external_id: 'cb-3', load_ref: String(S.order1) } });
  assert.equal(cb3.status, 200, `cb3: ${cb3.text}`);
  assert.deepEqual(cb3.json.reversed, { fan_cents: 0, model_cents: 0, negative_cents: 0, platform_absorbed_cents: 0 });
  // Flag (b) on A: 2 attributed chargebacks → escalated.
  const rowA = await adminPayoutRow(base, S.mgr, S.modelA.id);
  const rate = rowA.flags.find((f) => f.kind === 'chargeback_rate');
  assert.ok(rate && rate.level === 'escalated' && rate.label.includes('2 chargebacks'),
    `chargeback-rate flag escalates: ${JSON.stringify(rowA.flags)}`);
});

test('A5: chargeback-rate flag — informational at 1 chargeback, escalates at 2', { timeout: 120000 }, async () => {
  const { base } = await bootA();
  await ccbillLoad(base, S.fan6, S.mgr, 12000);
  await tip(base, S.fan6, S.modelD.id, 4); await tip(base, S.fan6, S.modelD.id, 2);
  await tip(base, S.fan6, S.modelD.id, 1); await tip(base, S.fan6, S.modelD.id, 1); // $95 on D, $25 left
  for (let i = 0; i < 5; i++) { // five more attributed loads for D
    const f = await signup(base, `fan6x${i}`, 'fan');
    await ccbillLoad(base, f, S.mgr, 1000);
    await tip(base, f, S.modelD.id, 0); // $5
  }
  const cbD1 = await req(base, 'POST', '/api/admin/chargebacks', { ...S.mgr,
    body: { user_id: S.fan6.id, amount_cents: 6000, external_id: 'cb-d1' } });
  assert.equal(cbD1.status, 200, `cb-d1: ${cbD1.text}`);
  assert.deepEqual(cbD1.json.reversed, { fan_cents: 2500, model_cents: 3500, negative_cents: 0, platform_absorbed_cents: 0 });
  let rowD = await adminPayoutRow(base, S.mgr, S.modelD.id);
  let rate = rowD.flags.find((f) => f.kind === 'chargeback_rate');
  assert.ok(rate && rate.level === 'info' && rate.label.includes('1 chargeback') && rate.label.includes('6 attributed loads'),
    `1 CB across 6 loads is informational: ${JSON.stringify(rowD.flags)}`);
  const cbD2 = await req(base, 'POST', '/api/admin/chargebacks', { ...S.mgr,
    body: { user_id: S.fan6.id, amount_cents: 1000, external_id: 'cb-d2' } });
  assert.equal(cbD2.status, 200, `cb-d2: ${cbD2.text}`);
  rowD = await adminPayoutRow(base, S.mgr, S.modelD.id);
  rate = rowD.flags.find((f) => f.kind === 'chargeback_rate');
  assert.ok(rate && rate.level === 'escalated' && rate.label.includes('2 chargebacks'),
    `2 CBs escalate: ${JSON.stringify(rowD.flags)}`);
});

test('A6: crypto loads are refused cleanly; bad references are clear errors', { timeout: 120000 }, async () => {
  const { base } = await bootA();
  const src = await req(base, 'POST', '/api/admin/chargebacks', { ...S.mgr,
    body: { user_id: S.fan1.id, amount_cents: 100, external_id: 'cb-crypto-src', source: 'crypto' } });
  assert.equal(src.status, 400);
  assert.equal(src.json.error, 'crypto_not_chargebackable');
  const inv = await req(base, 'POST', '/api/crypto/invoices', { token: S.fan1.token, body: { package_id: 'p25', coin: 'SOL' } });
  assert.equal(inv.status, 201, `sol invoice: ${inv.text}`);
  const byRef = await req(base, 'POST', '/api/admin/chargebacks', { ...S.mgr,
    body: { user_id: S.fan1.id, amount_cents: 100, external_id: 'cb-crypto-ref', load_ref: `crypto_invoice:${inv.json.invoice.id}` } });
  assert.equal(byRef.status, 400);
  assert.equal(byRef.json.error, 'crypto_not_chargebackable');
  const unknown = await req(base, 'POST', '/api/admin/chargebacks', { ...S.mgr,
    body: { user_id: S.fan1.id, amount_cents: 100, external_id: 'cb-unknown', load_ref: '999999' } });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.json.error, 'load_not_found');
  const noRef = await req(base, 'POST', '/api/admin/chargebacks', { ...S.mgr,
    body: { user_id: S.fan1.id, amount_cents: 100 } });
  assert.equal(noRef.status, 400);
  assert.equal(noRef.json.error, 'missing_external_id');
});

test('A7: Manager gates — fan token and missing X-Manager header are both refused', { timeout: 120000 }, async () => {
  const { base } = await bootA();
  const body = { user_id: S.fan1.id, amount_cents: 100, external_id: 'cb-gate' };
  const asFan = await req(base, 'POST', '/api/admin/chargebacks',
    { token: S.fan1.token, headers: { 'x-manager': '1' }, body });
  assert.equal(asFan.status, 403, 'a fan token fails the admin role gate even with the header');
  const noHeader = await req(base, 'POST', '/api/admin/chargebacks', { token: S.mgr.token, body });
  assert.ok([401, 403].includes(noHeader.status), `admin token without X-Manager is blocked (${noHeader.status})`);
  const noToken = await req(base, 'POST', '/api/admin/chargebacks', { headers: { 'x-manager': '1' }, body });
  assert.ok([401, 403].includes(noToken.status), `no token is blocked (${noToken.status})`);
});

test('A8: settings — hold window is validated, editable, and a 0-day hold frees new earnings at once', { timeout: 120000 }, async () => {
  const { base } = await bootA();
  const bad = await req(base, 'PUT', '/api/admin/settings', { ...S.mgr, body: { earnings_hold_days: 61 } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'bad_hold_days');
  const zero = await req(base, 'PUT', '/api/admin/settings', { ...S.mgr, body: { earnings_hold_days: 0 } });
  assert.equal(zero.status, 200, `set hold 0: ${zero.text}`);
  const before = await modelWithdrawals(base, S.modelB);
  await tip(base, S.fan4, S.modelB.id, 0); // $5 → B earns $3
  const after = await modelWithdrawals(base, S.modelB);
  assert.equal(after.json.available_cents, before.json.available_cents + 300,
    'with a 0-day hold the new earning is withdrawable immediately');
  assert.equal(after.json.holding_cents, before.json.holding_cents, 'older earnings keep their original window');
  const back = await req(base, 'PUT', '/api/admin/settings', { ...S.mgr, body: { earnings_hold_days: 7 } });
  assert.equal(back.status, 200);
});

/* ---------------- Boot A2: same DB, time has passed ---------------- */

test('A9: matured earnings become withdrawable; a clawback that eats the balance blocks the Manager pay', { timeout: 120000 }, async (t) => {
  const a = await bootA();
  const dir = a.dir;
  await a.kill();
  // Time travel + a pre-feature-style row: B's earnings all mature, and a
  // legacy row with available_at NULL (pre-feature shape) must count as
  // matured too — grandfathering can never trap an existing balance.
  const db = new DatabaseSync(path.join(dir, 'wogent-chat.db'));
  db.prepare("UPDATE transactions SET available_at = '2020-01-01 00:00:00' WHERE model_id = ?").run(S.modelB.id);
  db.prepare(`INSERT INTO transactions (fan_id, model_id, type, gross_cents, model_cents, platform_cents, available_at)
              VALUES (?, ?, 'tip', 2000, 1200, 800, NULL)`).run(S.fan4.id, S.modelB.id);
  db.prepare('UPDATE wallets SET earnings_cents = earnings_cents + 1200 WHERE user_id = ?').run(S.modelB.id);
  db.close();
  const a2 = await boot(dir);
  t.after(async () => { await a2.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

  const wd = await modelWithdrawals(a2.base, S.modelB);
  assert.equal(wd.json.holding_cents, 0, 'everything B earned has matured');
  assert.equal(wd.json.available_cents, 6000, '$48 of tips + $12 legacy row are all withdrawable');
  await setupPayout(a2.base, S.modelB);
  const ask = await req(a2.base, 'POST', '/api/model/withdrawals', { token: S.modelB.token, body: { amount_cents: 1000 } });
  assert.equal(ask.status, 200, `matured money can be requested: ${ask.text}`);
  const wdId = ask.json.withdrawal.id;
  // A $160 chargeback against fan4 drains fan4's $45 balance, claws B's
  // $60 pair and A's $45 pair, and leaves $10 as a negative adjustment
  // on B (largest lifetime pair). B's pending $10 request is now
  // unpayable — the Manager pay route must refuse it server-side.
  const cb = await req(a2.base, 'POST', '/api/admin/chargebacks', { ...S.mgr,
    body: { user_id: S.fan4.id, amount_cents: 16000, external_id: 'cb-b1' } });
  assert.equal(cb.status, 200, `cb-b1: ${cb.text}`);
  assert.deepEqual(cb.json.reversed, { fan_cents: 4500, model_cents: 10500, negative_cents: 1000, platform_absorbed_cents: 0 });
  const wdB = await modelWithdrawals(a2.base, S.modelB);
  assert.equal(wdB.json.negative_adjustment_cents, 1000);
  assert.equal(wdB.json.available_cents, 0);
  const pay = await req(a2.base, 'POST', `/api/admin/withdrawals/${wdId}/pay`, S.mgr);
  assert.equal(pay.status, 400, 'paying an unpayable withdrawal is refused');
  assert.equal(pay.json.error, 'exceeds_withdrawable');
  assert.equal(pay.json.withdrawable_cents, 0);
});

/* ---------------- Boot C: grandfathering + stamp precision ---------------- */

test('C: grandfathering IIFE matures pre-feature rows; stamps honor the setting (default 7, then 3)', { timeout: 120000 }, async (t) => {
  startStub();
  if (!stub.listening) await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-payout-c-'));
  let c = await boot(dir);
  t.after(async () => { await c.kill(); fs.rmSync(dir, { recursive: true, force: true }); });
  const mgr = await mgrLogin(c.base);
  const M = await signup(c.base, 'modelc', 'model');
  const F = await signup(c.base, 'fanc', 'fan');
  const st = await req(c.base, 'GET', '/api/admin/stats', mgr);
  assert.equal(st.json.earnings_hold_days, 7, 'fresh DB default is 7');
  const grant = await req(c.base, 'POST', `/api/admin/fans/${F.id}/credits`, { ...mgr, body: { amount_cents: 5000 } });
  assert.equal(grant.status, 200, `grant: ${grant.text}`);
  await tip(c.base, F, M.id, 1); // $10 at the default 7-day hold → stamp ≈ +7d
  const set3 = await req(c.base, 'PUT', '/api/admin/settings', { ...mgr, body: { earnings_hold_days: 3 } });
  assert.equal(set3.status, 200);
  await tip(c.base, F, M.id, 1); // $10 at a 3-day hold → stamp ≈ +3d
  await c.kill();

  const dbPath = path.join(dir, 'wogent-chat.db');
  const days = (r) => (new Date(String(r.available_at).replace(' ', 'T') + 'Z') - new Date(String(r.created_at).replace(' ', 'T') + 'Z')) / 86400000;
  let db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = db.prepare("SELECT id, created_at, available_at FROM transactions WHERE model_id = ? AND type = 'tip_menu' ORDER BY id").all(M.id);
  assert.equal(rows.length, 2);
  assert.ok(days(rows[0]) > 6.9 && days(rows[0]) < 7.1, `first stamp ≈ +7d (got ${days(rows[0])})`);
  assert.ok(days(rows[1]) > 2.9 && days(rows[1]) < 3.1, `second stamp ≈ +3d after the setting change (got ${days(rows[1])})`);
  const marker = db.prepare('SELECT payout_protection_at FROM platform_stats WHERE id = 1').get();
  assert.ok(marker.payout_protection_at, 'grandfathering marker stamped on first boot');
  db.close();

  // Simulate a pre-feature database: row 1 loses its stamp and the
  // marker is cleared, as if the feature had never run on this DB.
  db = new DatabaseSync(dbPath);
  db.prepare('UPDATE transactions SET available_at = NULL WHERE id = ?').run(rows[0].id);
  db.prepare('UPDATE platform_stats SET payout_protection_at = NULL WHERE id = 1').run();
  db.close();

  c = await boot(dir);
  const wd = await modelWithdrawals(c.base, M);
  assert.equal(wd.json.available_cents, 600, 'the pre-feature earning is withdrawable immediately — grandfathered, not trapped');
  assert.equal(wd.json.holding_cents, 600, 'the post-feature earning is still inside its 3-day window');
  await c.kill();
  db = new DatabaseSync(dbPath, { readOnly: true });
  const r1 = db.prepare('SELECT created_at, available_at FROM transactions WHERE id = ?').get(rows[0].id);
  assert.equal(r1.available_at, r1.created_at, 'grandfathering stamps available_at = the original earn date');
  assert.ok(db.prepare('SELECT payout_protection_at FROM platform_stats WHERE id = 1').get().payout_protection_at,
    'marker re-stamped by the one-time migration');
  db.close();
});

/* ------------- Boot B: the chargeback lands AFTER she cashed out ------------- */

test('B: already-withdrawn earnings — the shortfall becomes debt and future earnings repay it automatically', { timeout: 240000 }, async (t) => {
  startStub();
  if (!stub.listening) await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-payout-b-'));
  let b = await boot(dir);
  t.after(async () => { try { await b.kill(); } catch (_) { /* gone */ } fs.rmSync(dir, { recursive: true, force: true }); });
  const mgr = await mgrLogin(b.base);
  const E = await signup(b.base, 'modele', 'model');
  const F1 = await signup(b.base, 'fanb1', 'fan');
  const F2 = await signup(b.base, 'fanb2', 'fan');
  const order = await ccbillLoad(b.base, F1, mgr, 10000); // $100 card load
  await tip(b.base, F1, E.id, 4); // $50
  await tip(b.base, F1, E.id, 1); // $10 → E earns $36, all inside the hold
  let wd = await modelWithdrawals(b.base, E);
  assert.equal(wd.json.holding_cents, 3600);
  assert.equal(wd.json.available_cents, 0);
  await b.kill();

  // Time travel: her $36 matures, then she withdraws EVERYTHING she can
  // through the real request → Manager-pay path. The cash is gone.
  const dbPath = path.join(dir, 'wogent-chat.db');
  const matureE = () => {
    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE transactions SET available_at = '2020-01-01 00:00:00' WHERE model_id = ? AND type = 'tip_menu'").run(E.id);
    db.close();
  };
  matureE();
  b = await boot(dir);
  await setupPayout(b.base, E);
  const ask = await req(b.base, 'POST', '/api/model/withdrawals', { token: E.token, body: { amount_cents: 3600 } });
  assert.equal(ask.status, 200, `withdraw everything: ${ask.text}`);
  const pay = await req(b.base, 'POST', `/api/admin/withdrawals/${ask.json.withdrawal.id}/pay`, mgr);
  assert.equal(pay.status, 200, `manager pays it out: ${pay.text}`);
  wd = await modelWithdrawals(b.base, E);
  assert.equal(wd.json.available_cents, 0, 'she cashed out in full');
  assert.equal(wd.json.holding_cents, 0);
  assert.equal(wd.json.negative_adjustment_cents, 0);

  // NOW the $100 chargeback lands on that load. Step 1 takes fan's
  // unspent $40; step 2 must find $0 unpaid (it was already withdrawn —
  // money that left the platform is NOT reversible from a balance);
  // step 3 books the FULL $60 remainder as a negative adjustment.
  const cb = await req(b.base, 'POST', '/api/admin/chargebacks', { ...mgr,
    body: { user_id: F1.id, amount_cents: 10000, external_id: 'cb-withdrawn-1', load_ref: String(order), reason: 'chargeback after payout' } });
  assert.equal(cb.status, 200, `cb: ${cb.text}`);
  assert.deepEqual(cb.json.reversed, { fan_cents: 4000, model_cents: 0, negative_cents: 6000, platform_absorbed_cents: 0 },
    'step 1 takes the $40 unspent, step 2 finds $0 unpaid, step 3 books the full $60 as debt');
  const list = await req(b.base, 'GET', '/api/admin/chargebacks', mgr);
  const row = list.json.chargebacks.find((c) => c.external_id === 'cb-withdrawn-1');
  assert.ok(row, 'chargeback recorded');
  const byStep = {};
  for (const a of row.allocations) byStep[a.step] = (byStep[a.step] || 0) + a.amount_cents;
  assert.deepEqual(byStep, { 1: 4000, 3: 6000 }, 'allocation trail shows NO step-2 reversal — nothing unpaid existed');
  assert.equal(await fanCredits(b.base, F1), 0);
  wd = await modelWithdrawals(b.base, E);
  assert.equal(wd.json.available_cents, 0);
  assert.equal(wd.json.negative_adjustment_cents, 6000, "her earnings view shows the $60 she owes");

  // AUTOMATIC recovery, part 1: a different fan pays her $50 (she earns
  // $30). Nobody in the Manager touches anything. When the new earning
  // matures it services the debt FIRST — $60 owed becomes $30 owed and
  // her withdrawable stays 0.
  await ccbillLoad(b.base, F2, mgr, 20000);
  await tip(b.base, F2, E.id, 4); // $50 → +$30
  await b.kill();
  matureE();
  b = await boot(dir);
  wd = await modelWithdrawals(b.base, E);
  assert.equal(wd.json.negative_adjustment_cents, 3000, 'the matured $30 offset the debt automatically — no admin action');
  assert.equal(wd.json.available_cents, 0, 'withdrawable stays 0 until the debt is fully repaid');

  // AUTOMATIC recovery, part 2: another $60 of tips (she earns $36).
  // $30 finishes the debt; only the $6 above it becomes withdrawable.
  await tip(b.base, F2, E.id, 4); await tip(b.base, F2, E.id, 1); // $60 → +$36
  await b.kill();
  matureE();
  b = await boot(dir);
  wd = await modelWithdrawals(b.base, E);
  assert.equal(wd.json.negative_adjustment_cents, 0, 'debt fully repaid from future earnings alone');
  assert.equal(wd.json.available_cents, 600, 'the $6 earned above the repaid debt is withdrawable');
  assert.equal(wd.json.holding_cents, 0);
});

/* ---------------- Terms + disclosure pins (source level) ---------------- */

test('Terms pins: the contracts and fan Terms carry the payout-protection clauses', () => {
  const server = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
  assert.ok(server.includes("const CONTRACT_VERSION = '1.4';"), 'model contract at 1.4 (1.3 added payout protection; 1.4 adds governing law — each text bump forces re-sign)');
  assert.ok(server.includes('13. Payout Holds, Chargeback Reversals & Fraud'), 'model contract §13 present');
  assert.ok(server.includes('become eligible for withdrawal 7 days after they are earned'), 'model contract states the 7-day hold');
  assert.ok(!server.includes('Earnings you have already properly withdrawn are NOT clawed back'),
    'the old withdrawn-earnings sentence is gone — it contradicted automatic recovery');
  assert.ok(server.includes('Earnings you have already properly withdrawn are never collected back from you out of pocket'),
    'withdrawn earnings are never collected out of pocket');
  assert.ok(server.includes('including because you already withdrew the earnings it relates to'),
    '§13 names the already-withdrawn chargeback case explicitly');
  assert.ok(server.includes('the difference becomes a balance you owe the Company'),
    'a chargeback shortfall becomes a balance owed');
  assert.ok(server.includes('That balance is recovered automatically: the system deducts it from your future earnings before anything new becomes withdrawable, until it is repaid in full'),
    '§13 promises AUTOMATIC recovery from future earnings — the system triggers it, no manual step');
  assert.ok(server.includes('You are never required to make a manual or out-of-pocket payment for a chargeback shortfall'),
    'no manual or out-of-pocket repayment is ever demanded for a chargeback shortfall');
  assert.ok(server.includes('15. Plain-Language Disclaimer'), 'disclaimer renumbered to 15 (governing law took 14)');
  assert.ok(server.includes("const RECRUITER_CONTRACT_VERSION = 'R1.3';"), 'recruiter contract at R1.3 (R1.1 added the payout window; R1.2 adds governing law; R1.3 adds the first-year quota)');
  const app = fs.readFileSync(path.join(REPO, 'public/js/app.js'), 'utf8');
  assert.ok(app.includes('10. Chargebacks & Fraud'), 'fan Terms gained §10 Chargebacks & Fraud');
  // Fan Terms live in the EN legal_terms_html i18n entry since the 13-language build.
  const tvStart = app.indexOf('legal_terms_html:');
  const termsView = app.slice(tvStart, app.indexOf('legal_terms_html:', tvStart + 1));
  assert.ok(termsView.includes('12. Changes'), 'fan Terms Changes renumbered to 12 (governing law took 11)');
  assert.ok(app.includes('Model earnings become eligible for withdrawal one week (7 days) after they are earned.'),
    'fan Terms §4 carries the 7-day eligibility sentence');
  assert.ok(app.includes('Last updated October 16, 2026'), 'fan Terms date updated');
  assert.ok(app.includes("New earnings become withdrawable one week (7 days) after they\\'re earned."),
    'the exact model-facing disclosure sentence ships in the earnings views');
  const mgr = fs.readFileSync(path.join(REPO, 'public/manager/manager.js'), 'utf8');
  assert.ok(mgr.includes('Record chargeback (payout protection)'), 'Manager has the Record chargeback action');
  assert.ok(mgr.includes("id=\"set-hold\""), 'Manager settings expose the hold window');
});
