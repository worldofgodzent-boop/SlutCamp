'use strict';
/*
 * Payout ID gate (owner policy, Oct 18 2026: "profile and chatting
 * stay open, but going live AND cashing out both need your approval
 * of her ID"). Going live was already gated on an approved
 * id_verifications row via isIdVerified(); this suite pins the
 * cash-out half:
 *
 *  - POST /api/model/withdrawals refuses a MODEL whose ID is not
 *    approved with 403 { error: 'id_verification_required' } — the
 *    same shape as POST /api/live/start. The check runs FIRST in the
 *    handler, before the bank/tax completeness refusals (eligibility
 *    precedes setup, mirroring live/start), so an unverified model
 *    with no bank account still gets the ID refusal, not
 *    no_bank_account. That ordering is deliberate and pinned here.
 *  - Models ONLY: the endpoint is shared with affiliates/recruiters
 *    (requireRoleOrAffiliate). ID verification is a model flow — a
 *    pure affiliate has no way to submit one — so their withdrawal
 *    path is unchanged. Pinned with a live affiliate control.
 *  - The house account passes via isIdVerified()'s house
 *    short-circuit: no id_verifications row, and its refusal is the
 *    NEXT check (no_bank_account), never the ID gate.
 *  - An ID-approved model withdraws exactly as before (same success
 *    shape), and nothing about chatting/video calls/bookings changes —
 *    no other endpoint is touched.
 *
 * Rider (same build): the stale "can't chat until approved" copy is
 * gone. The Settings ID Verification card (app.js — the upload card
 * body AND the pending-state line of the same card) and the Manager
 * ID Checks header (manager.js) now state the TRUE rule: approval is
 * required before going live and cashing out; chatting is not gated.
 * The 2257 framing stays.
 *
 * Static source pins (suite convention) + one functional boot.
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
const appSrc = fs.readFileSync(path.join(REPO, 'public/js/app.js'), 'utf8');
const serverSrc = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
const managerSrc = fs.readFileSync(path.join(REPO, 'public/manager/manager.js'), 'utf8');

function sliceFn(src, startMarker, endMarker) {
  const s = src.indexOf(startMarker);
  const e = src.indexOf(endMarker, s);
  assert.ok(s !== -1 && e > s, `located ${startMarker} … ${endMarker}`);
  return src.slice(s, e);
}

/* --------------------------- static pins --------------------------- */

test('server: the withdrawal ID gate — models only, 403 shape, checked first', () => {
  const route = sliceFn(serverSrc, "app.post('/api/model/withdrawals'", '\n});');
  assert.ok(route.includes("req.user.role === 'model' && !isIdVerified(req.user.id)"),
    'gate consults isIdVerified() and applies to models only (affiliate path unchanged)');
  assert.ok(route.includes("res.status(403).json({ error: 'id_verification_required'"),
    'same 403 + error code as /api/live/start');
  assert.ok(route.includes('to cash out.'), 'message tells her what the approval unlocks');
  const gateAt = route.indexOf('id_verification_required');
  const bankAt = route.indexOf('no_bank_account');
  const taxAt = route.indexOf('no_tax_info');
  assert.ok(gateAt > -1 && bankAt > gateAt && taxAt > bankAt,
    'ordering pinned: ID eligibility BEFORE no_bank_account BEFORE no_tax_info');
});

test('client: withdrawal 403 is surfaced with the Settings path in both dashboards', () => {
  const hits = appSrc.split("wd.error === 'id_verification_required'").length - 1;
  assert.ok(hits >= 3, `earnings toast + earnings redirect + affiliate toast (found ${hits})`);
  assert.ok(appSrc.includes('🪪 ID verification required — upload your ID in Settings → ID Verification to cash out.'),
    'toast copy mirrors the live-start surfacing');
  assert.ok(appSrc.includes("show('modelSettings', {})"),
    'the model is routed to Settings, where the ID card lives');
});

test('client: the earnings payouts card carries the ID hint in the hold-note style', () => {
  assert.ok(appSrc.includes('idvData && !idvData.verified'),
    'hint renders only while she is unverified');
  assert.ok(appSrc.includes('🪪 ID verification required to cash out — upload your ID in Settings → ID Verification.'),
    'hint line present in the payouts card');
});

test('stale copy: the Settings ID card no longer claims chat is gated', () => {
  assert.ok(!appSrc.includes('before you can chat with fans or go live'),
    'upload-card body: the false chat claim is gone');
  assert.ok(!appSrc.includes("can't chat or go live"),
    'pending-state line: the false chat claim is gone');
  assert.ok(appSrc.includes('before you can go live or cash out'),
    'upload-card body now names the true gates: live + cash out');
  assert.ok(appSrc.includes("can't go live or cash out until it's approved"),
    'pending-state line now names the true gates: live + cash out');
  assert.ok(appSrc.includes('18 U.S.C. §2257'), 'the 2257 framing stays');
});

test('stale copy: the Manager ID Checks header no longer claims chat is gated', () => {
  assert.ok(!managerSrc.includes('cannot chat with fans or go live'),
    'the false chat claim is gone');
  assert.ok(managerSrc.includes('cannot go live or cash out until you approve their ID'),
    'header now names the true gates: live + cash out');
});

/* --------------------------- functional boot --------------------------- */

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
async function req(base, method, p, { body, token, headers } = {}) {
  const hdrs = { ...(headers || {}) };
  if (body !== undefined) hdrs['content-type'] = 'application/json';
  if (token) hdrs.authorization = 'Bearer ' + token;
  const r = await fetch(base + p, {
    method, headers: hdrs, body: body !== undefined ? JSON.stringify(body) : undefined,
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

test('live: unverified models are refused, approved models withdraw as before, house + affiliate pass the ID check', { timeout: 300000 }, async () => {
  const dir = makeCopy('payoutgate');
  let h = null;
  try {
    h = await boot(dir, { SEED_DEMO: '1' });
    const base = h.base;
    const mgrLogin = await req(base, 'POST', '/api/manager/login', { body: { username: 'admin', password: 'admin123' } });
    assert.equal(mgrLogin.status, 200, `manager login: ${mgrLogin.text}`);
    const MGR = { token: mgrLogin.json.token, headers: { 'x-manager': '1' } };

    const signup = async (username, role) => {
      const s = await req(base, 'POST', '/api/auth/signup', {
        body: { username, password: 'hunter22', role, display_name: username,
          dob: '1995-05-05', agree18: true, ...(role === 'model' ? { section: 'female' } : {}) },
      });
      assert.equal(s.status, 200, `signup ${username}: ${s.text}`);
      return { token: s.json.token, id: s.json.user.id };
    };
    const setupPayout = async (who) => {
      const pa = await req(base, 'POST', '/api/model/payout-account', { token: who.token,
        body: { holder_name: 'Test Holder', routing_number: '021000021', account_number: '123456789' } });
      assert.equal(pa.status, 200, `payout account: ${pa.text}`);
      const tp = await req(base, 'POST', '/api/tax-profile', { token: who.token,
        body: { legal_name: 'Test Holder', tax_id_type: 'ssn', tax_id: '123456789',
          address_line1: '1 Main St', city: 'Dallas', state: 'TX', zip: '75001' } });
      assert.equal(tp.status, 200, `tax profile: ${tp.text}`);
    };
    const withdraw = (who, amount_cents) =>
      req(base, 'POST', '/api/model/withdrawals', { token: who.token, body: { amount_cents } });

    const jane = await signup('gatejane', 'model');   // (a) unverified, bank+tax set
    const vera = await signup('gatevera', 'model');   // (b) approved mid-test, with earnings
    const una = await signup('gateuna', 'model');     // (c) unverified, NO bank account
    const house = await signup('asceaaspade', 'model'); // (d) the house account
    const fan = await signup('gatefan', 'fan');
    const affSignup = await req(base, 'POST', '/api/affiliate/signup', {
      body: { username: 'gateaff', password: 'hunter22', display_name: 'Gate Aff', agreed: true } });
    assert.equal(affSignup.status, 200, `affiliate signup: ${affSignup.text}`);
    const aff = { token: affSignup.json.token, id: affSignup.json.user.id };

    // (a) unverified WITH bank+tax → 403 id_verification_required, and
    // no withdrawal row is recorded.
    await setupPayout(jane);
    const aTry = await withdraw(jane, 100);
    assert.equal(aTry.status, 403, `unverified model refused: ${aTry.text}`);
    assert.equal(aTry.json.error, 'id_verification_required');
    assert.ok(aTry.json.message.includes('ID Verification'), 'message points at Settings → ID Verification');
    const janeList = await req(base, 'GET', '/api/model/withdrawals', { token: jane.token });
    assert.equal(janeList.json.withdrawals.length, 0, 'the refusal recorded no withdrawal');

    // (c) unverified WITHOUT a bank account → still the ID refusal.
    // Ordering is deliberate (eligibility precedes setup): she is NOT
    // walked to no_bank_account first. Pinned here on purpose.
    const cTry = await withdraw(una, 100);
    assert.equal(cTry.status, 403, `unverified + no bank → ID refusal first: ${cTry.text}`);
    assert.equal(cTry.json.error, 'id_verification_required');

    // (d) the house account: NO id_verifications row, yet the ID check
    // passes (isIdVerified house short-circuit) and the refusal she
    // gets is the NEXT one — no_bank_account.
    const rdb = openDb(dir);
    assert.equal(rdb.prepare('SELECT COUNT(*) AS n FROM id_verifications WHERE model_id = ?').get(house.id).n, 0,
      'precondition: the house has NO id_verifications row');
    rdb.close();
    const dTry = await withdraw(house, 100);
    assert.equal(dTry.status, 400, `house passes the ID check and hits the bank check: ${dTry.text}`);
    assert.equal(dTry.json.error, 'no_bank_account');

    // (b) vera: bank+tax + real earnings, but unverified → refused.
    // Approve her ID + mature her earnings directly in the DB (the
    // same surgery other suites perform), and the SAME request then
    // succeeds with the exact pre-gate response shape.
    await setupPayout(vera);
    const grant = await req(base, 'POST', `/api/admin/fans/${fan.id}/credits`,
      { ...MGR, body: { amount_cents: 5000 } });
    assert.equal(grant.status, 200, `fan credit grant: ${grant.text}`);
    const tip = await req(base, 'POST', `/api/models/${vera.id}/tip`,
      { token: fan.token, body: { menu_id: 'default-1', context: 'profile' } });
    assert.equal(tip.status, 200, `tip: ${tip.text}`); // $10 tip → vera earns $6, held
    const bBlocked = await withdraw(vera, 100);
    assert.equal(bBlocked.status, 403, `funded but unverified → still refused: ${bBlocked.text}`);
    assert.equal(bBlocked.json.error, 'id_verification_required');

    const wdb = openDb(dir, false);
    wdb.prepare("UPDATE transactions SET available_at = '2020-01-01 00:00:00' WHERE model_id = ?").run(vera.id);
    wdb.prepare("INSERT INTO id_verifications (model_id, status) VALUES (?, 'approved')").run(vera.id);
    wdb.close();

    const bList = await req(base, 'GET', '/api/model/withdrawals', { token: vera.token });
    assert.equal(bList.json.available_cents, 600, 'her $6 of matured earnings is withdrawable');
    const bOk = await withdraw(vera, 500);
    assert.equal(bOk.status, 200, `approved model withdraws as before: ${bOk.text}`);
    assert.equal(bOk.json.ok, true);
    assert.equal(bOk.json.withdrawal.amount_cents, 500);
    assert.equal(bOk.json.withdrawal.status, 'pending');
    assert.ok(Number.isInteger(bOk.json.withdrawal.id), 'withdrawal id issued');
    assert.equal(bOk.json.available_cents, 100, 'available drops by the requested amount');

    // Affiliate control: a pure recruiter on the SAME endpoint is not
    // ID-gated (she has no way to submit an ID) — with bank+tax set
    // and no earnings she reaches the funds check, unchanged.
    await setupPayout(aff);
    const affTry = await withdraw(aff, 100);
    assert.equal(affTry.status, 400, `affiliate reaches the money checks, not the ID gate: ${affTry.text}`);
    assert.equal(affTry.json.error, 'insufficient_funds');
  } finally {
    stop(h);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
