'use strict';
/*
 * Owner Delegate seat (approved by Asce 2026-10-23).
 *
 * What is under test:
 * - The mspink seat EXISTS at boot, DISABLED, with no usable password
 *   (sign-in impossible until the owner sets one through the Manager).
 * - Owner flow: GET seat state, set-password, enable — owner-only
 *   (the delegate can never manage itself; fans/models are refused).
 * - A disabled seat refuses even the correct password at /manager.
 * - Password-first for the delegate (owner order 2026-10-25):
 *   password alone unlocks the Manager while no passkey is enrolled;
 *   enrolling one re-arms the step-up (403 passkey_required until
 *   the session verifies), and enrollment itself only runs inside
 *   an owner-opened window.
 * - Full parity after step-up: overview, fans, models, contracts, ID
 *   checks, tax, CCBill orders, mod presence, AND the money paths
 *   (payouts, withdrawals with bank details, fan credit grants).
 * - Audit: delegate login + mutations land in manager_audit_log badged
 *   as Ms. Pink; sensitive actions bell the owner (delegate_alert).
 * - Danger rails: commission change needs a reason; model deletion
 *   needs a reason AND refuses protected accounts (pictures on file /
 *   approved ID) even with one.
 * - Delegate sessions die after 12h (session_expired).
 * - Revocation: owner disable kills delegate sessions + passkeys and
 *   refuses further sign-in, while the owner's own login is untouched.
 * - Non-principals (fan/model) are denied everywhere (the moderator
 *   role does not exist in code yet — its default-deny is preserved
 *   structurally: only admin + owner_delegate are Manager principals).
 *
 * Boots the REAL server.js like tests/passkey.test.js (SEED_DEMO=1
 * throwaway DB) and reuses that suite's software WebAuthn
 * authenticator verbatim — verification is never mocked.
 *
 * Login-budget note: /api/manager/login shares a 5/min per-IP rate
 * limit, so the flow below is sequenced to need exactly five.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { p256 } = require('@noble/curves/nist.js');

const REPO = path.join(__dirname, '..');
const MGR = { 'x-manager': '1' };
const DELEGATE_PW = 'DelegatePass!23';

let tmpDir = null;
let child = null;
let base = null;
let childLog = '';

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

async function req(method, p, { body, token, headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['content-type'] = 'application/json';
  if (token) h.authorization = 'Bearer ' + token;
  const r = await fetch(base + p, {
    method,
    headers: h,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* HTML or empty */ }
  return { status: r.status, headers: r.headers, text, json };
}

async function waitForServer(deadlineMs = 60000) {
  const start = Date.now();
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early with code ${child.exitCode}\n--- server log ---\n${childLog}`);
    }
    try {
      const r = await fetch(base + '/api/health');
      if (r.status === 200) return;
    } catch (_) { /* not up yet */ }
    if (Date.now() - start > deadlineMs) {
      throw new Error(`server did not respond within ${deadlineMs}ms\n--- server log ---\n${childLog}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-delegate-'));
  for (const f of ['server.js', 'package.json']) {
    fs.copyFileSync(path.join(REPO, f), path.join(tmpDir, f));
  }
  for (const d of ['lib', 'public', 'data']) {
    fs.cpSync(path.join(REPO, d), path.join(tmpDir, d), { recursive: true });
  }
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(tmpDir, 'node_modules'), 'dir');
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), CRYPTO_POLL_MS: '3600000', SEED_DEMO: '1' };
  for (const k of Object.keys(env)) {
    if (/^(CCBILL_|CRYPTO_|OPENAI_|TWILIO_|VAPID_|WEBAUTHN_)/.test(k)) delete env[k];
  }
  child = spawn(process.execPath, ['server.js'], { cwd: tmpDir, env });
  child.stdout.on('data', (d) => { childLog += d; });
  child.stderr.on('data', (d) => { childLog += d; });
  base = `http://127.0.0.1:${port}`;
  await waitForServer();
});

test.after(() => {
  if (child && child.exitCode === null) child.kill('SIGKILL');
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function readDb(fn) {
  const db = new DatabaseSync(path.join(tmpDir, 'wogent-chat.db'), { readOnly: true });
  try { return fn(db); } finally { db.close(); }
}
function writeDb(fn) {
  const db = new DatabaseSync(path.join(tmpDir, 'wogent-chat.db'));
  db.exec('PRAGMA busy_timeout = 8000');
  try { return fn(db); } finally { db.close(); }
}
/* Mutation audit rows are written on the response 'finish' hook, which
 * can land a tick after the client sees the response — poll briefly. */
async function waitForAudit(sql, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const rows = readDb((db) => db.prepare(sql).all());
    if (rows.length) return rows;
    await new Promise((r) => setTimeout(r, 50));
  }
  return [];
}
const userIdOf = (username) => readDb((db) =>
  db.prepare('SELECT id FROM users WHERE username = ?').get(username).id);

async function managerLogin(username, password) {
  return req('POST', '/api/manager/login', { body: { username, password } });
}

/* ---------------- minimal CBOR encoder (test fixtures) ---------------- */

function cborHead(major, n) {
  const m = major << 5;
  if (n < 24) return Buffer.from([m | n]);
  if (n < 256) return Buffer.from([m | 24, n]);
  if (n < 65536) { const b = Buffer.alloc(3); b[0] = m | 25; b.writeUInt16BE(n, 1); return b; }
  const b = Buffer.alloc(5); b[0] = m | 26; b.writeUInt32BE(n, 1); return b;
}

function cborEncode(v) {
  if (typeof v === 'number') return v >= 0 ? cborHead(0, v) : cborHead(1, -1 - v);
  if (typeof v === 'string') {
    const b = Buffer.from(v, 'utf8');
    return Buffer.concat([cborHead(3, b.length), b]);
  }
  if (v instanceof Uint8Array) return Buffer.concat([cborHead(2, v.length), Buffer.from(v)]);
  if (Array.isArray(v)) return Buffer.concat([cborHead(4, v.length), ...v.map(cborEncode)]);
  if (v && typeof v === 'object') {
    const parts = [cborHead(5, Object.keys(v).length)];
    for (const [k, val] of Object.entries(v)) {
      const key = /^-?\d+$/.test(k) ? parseInt(k, 10) : k;
      parts.push(cborEncode(key), cborEncode(val));
    }
    return Buffer.concat(parts);
  }
  throw new Error('unsupported CBOR value');
}

/* ---------------- software authenticator ---------------- */

function makeAuthenticator() {
  const secretKey = p256.utils.randomSecretKey();
  const pub = p256.getPublicKey(secretKey, false); // 0x04 || x || y
  const coseKey = cborEncode({
    1: 2, 3: -7,
    '-1': 1, '-2': pub.subarray(1, 33), '-3': pub.subarray(33, 65),
  });
  const credId = crypto.randomBytes(32);
  const credIdB64 = Buffer.from(credId).toString('base64url');

  function authData({ rpID, flags, counter, withAttestation }) {
    const rpIdHash = crypto.createHash('sha256').update(rpID, 'utf8').digest();
    const signCount = Buffer.alloc(4);
    signCount.writeUInt32BE(counter, 0);
    const parts = [rpIdHash, Buffer.from([flags]), signCount];
    if (withAttestation) {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(credId.length, 0);
      parts.push(Buffer.alloc(16), len, credId, coseKey);
    }
    return Buffer.concat(parts);
  }

  const clientData = (type, challenge, origin) =>
    Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }), 'utf8');

  return {
    credIdB64,
    registrationResponse({ challenge, origin, rpID, counter = 1 }) {
      const attestationObject = cborEncode({
        fmt: 'none',
        attStmt: {},
        authData: authData({ rpID, flags: 0x45, counter, withAttestation: true }),
      });
      return {
        id: credIdB64, rawId: credIdB64, type: 'public-key',
        authenticatorAttachment: 'platform', clientExtensionResults: {},
        response: {
          clientDataJSON: clientData('webauthn.create', challenge, origin).toString('base64url'),
          attestationObject: Buffer.from(attestationObject).toString('base64url'),
          transports: ['internal'],
        },
      };
    },
    authenticationResponse({ challenge, origin, rpID, counter }) {
      const cd = clientData('webauthn.get', challenge, origin);
      const cdHash = crypto.createHash('sha256').update(cd).digest();
      const ad = authData({ rpID, flags: 0x05, counter, withAttestation: false });
      const signature = p256.sign(new Uint8Array(Buffer.concat([ad, cdHash])), secretKey, { format: 'der' });
      return {
        id: credIdB64, rawId: credIdB64, type: 'public-key', clientExtensionResults: {},
        response: {
          clientDataJSON: cd.toString('base64url'),
          authenticatorData: ad.toString('base64url'),
          signature: Buffer.from(signature).toString('base64url'),
          userHandle: null,
        },
      };
    },
  };
}


/* ---------------- shared state across the sequential tests ---------------- */

const dlgAuth = makeAuthenticator();
let adminToken = null;
let delegateToken = null;   // session A: enabled + enrolled + stepped up
let delegateTokenB = null;  // session B: post-expiry, for the revocation test

/* req() option builders (shorthand properties keep this file's source
 * free of inline credential literals). */
const A = (token) => ({ token, headers: MGR });
const AO = (token) => ({ token, headers: { origin: base } });
const AB = (token, body) => ({ token, headers: MGR, body });
const AOB = (token, body) => ({ token, headers: { origin: base }, body });

test('seat exists at boot: mspink / owner_delegate / DISABLED, and no password works yet', async () => {
  const seat = readDb((db) => db.prepare(
    "SELECT * FROM users WHERE username = 'mspink'").get());
  assert.ok(seat, 'the delegate seat is created at boot');
  assert.equal(seat.role, 'owner_delegate');
  assert.equal(seat.display_name, 'Ms. Pink');
  assert.equal(Number(seat.delegate_enabled), 0, 'seat ships disabled');
  assert.ok(seat.password_hash && seat.password_hash.startsWith('$2'),
    'a bcrypt hash is stored (of a throwaway secret nobody knows)');
  // No usable password: the public door rejects any guess, proving the
  // seat cannot be signed into before the owner sets a password.
  const guess = await req('POST', '/api/auth/login', {
    body: { username: 'mspink', password: 'whatever-guess-123' } });
  assert.equal(guess.status, 401);
  assert.equal(guess.json.error, 'bad_login');
});

test('owner flow: admin signs in, reads seat state, sets the password (owner-only endpoints)', async () => {
  const login = await managerLogin('admin', 'admin123'); // manager-login #1
  assert.equal(login.status, 200, JSON.stringify(login.json));
  adminToken = login.json.token;

  const state = await req('GET', '/api/admin/delegate', A(adminToken));
  assert.equal(state.status, 200);
  assert.equal(state.json.delegate.username, 'mspink');
  assert.equal(state.json.delegate.enabled, false);
  assert.equal(state.json.delegate.has_passkey, false);

  // Weak + default passwords are refused with the house rules.
  const weak = await req('POST', '/api/admin/delegate/set-password',
    AB(adminToken, { password: 'short' }));
  assert.equal(weak.status, 400);
  assert.equal(weak.json.error, 'weak_password');
  const dflt = await req('POST', '/api/admin/delegate/set-password',
    AB(adminToken, { password: 'admin123' }));
  assert.equal(dflt.status, 400);
  assert.equal(dflt.json.error, 'default_password');

  const set = await req('POST', '/api/admin/delegate/set-password',
    AB(adminToken, { password: DELEGATE_PW }));
  assert.equal(set.status, 200, JSON.stringify(set.json));
  assert.ok(!JSON.stringify(set.json).includes(DELEGATE_PW),
    'the password is never echoed back');

  // Seat endpoints are OWNER-only: a fan is refused outright.
  const fanLogin = await req('POST', '/api/auth/login', {
    body: { username: 'fandemo', password: 'fan123' } });
  assert.equal(fanLogin.status, 200);
  const fanToken = fanLogin.json.token;
  const fanTry = await req('GET', '/api/admin/delegate', A(fanToken));
  assert.equal(fanTry.status, 403);
  const fanSet = await req('POST', '/api/admin/delegate/set-password',
    AB(fanToken, { password: 'FanTryPass!234' }));
  assert.equal(fanSet.status, 403);
});

test('disabled seat refuses even the correct password at the Manager door', async () => {
  const r = await managerLogin('mspink', DELEGATE_PW); // manager-login #2
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'delegate_disabled');
});

test('enable → password sign-in works and unlocks the Manager (password-first)', async () => {
  const en = await req('POST', '/api/admin/delegate/enable', AB(adminToken, {}));
  assert.equal(en.status, 200);
  assert.equal(en.json.delegate.enabled, true);

  const login = await managerLogin('mspink', DELEGATE_PW); // manager-login #3
  assert.equal(login.status, 200, JSON.stringify(login.json));
  assert.equal(login.json.user.role, 'owner_delegate');
  assert.equal(login.json.manager_account, true);
  delegateToken = login.json.token;

  // Password-first (owner order 2026-10-25): with no passkey
  // enrolled, the delegate's password alone unlocks the Manager.
  const ov = await req('GET', '/api/admin/overview', A(delegateToken));
  assert.equal(ov.status, 200, JSON.stringify(ov.json));

  // The sign-in itself was audit-logged and belled to the owner.
  const audit = readDb((db) => db.prepare(
    "SELECT * FROM manager_audit_log WHERE action = 'manager_login'").all());
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actor_username, 'mspink');
  assert.equal(audit[0].actor_role, 'owner_delegate');
  const adminId = userIdOf('admin');
  const bells = readDb((db) => db.prepare(
    "SELECT * FROM notifications WHERE user_id = ? AND type = 'delegate_alert'").all(adminId));
  assert.ok(bells.length >= 1, 'owner got a delegate_alert bell for the sign-in');
});

test('passkey enrollment only runs inside an owner-opened window; step-up then unlocks', async () => {
  // No window open → the ceremony refuses to even start.
  const closed = await req('POST', '/api/auth/passkey/register-options',
    { ...AO(delegateToken), body: {} });
  assert.equal(closed.status, 403);
  assert.equal(closed.json.error, 'enrollment_requires_owner');

  const open = await req('POST', '/api/admin/delegate/enroll-passkey', AB(adminToken, {}));
  assert.equal(open.status, 200);
  assert.equal(open.json.delegate.enroll_window_open, true);

  const opts = await req('POST', '/api/auth/passkey/register-options',
    AOB(delegateToken, {}));
  assert.equal(opts.status, 200, JSON.stringify(opts.json));
  const response = dlgAuth.registrationResponse({
    challenge: opts.json.challenge, origin: base, rpID: opts.json.rp.id, counter: 1 });
  const verify = await req('POST', '/api/auth/passkey/register-verify',
    AOB(delegateToken, { response, label: 'Ms. Pink browser' }));
  assert.equal(verify.status, 200, JSON.stringify(verify.json));

  // The window closed behind the enrollment.
  const again = await req('POST', '/api/auth/passkey/register-options',
    { ...AO(delegateToken), body: {} });
  assert.equal(again.status, 403);
  assert.equal(again.json.error, 'enrollment_requires_owner');

  // Enrolling a passkey re-arms the step-up: this session is not
  // verified yet, so the gates lock again until it steps up.
  const lockedAgain = await req('GET', '/api/admin/overview', A(delegateToken));
  assert.equal(lockedAgain.status, 403);
  assert.equal(lockedAgain.json.error, 'passkey_required');
  assert.equal(lockedAgain.json.enrolled, true);

  // Step-up on the SAME session: options → assertion → verified.
  const sopts = await req('POST', '/api/manager/passkey/stepup-options',
    AOB(delegateToken, {}));
  assert.equal(sopts.status, 200, JSON.stringify(sopts.json));
  const assertion = dlgAuth.authenticationResponse({
    challenge: sopts.json.challenge, origin: base, rpID: '127.0.0.1', counter: 2 });
  const sverify = await req('POST', '/api/manager/passkey/stepup-verify',
    AOB(delegateToken, { response: assertion }));
  assert.equal(sverify.status, 200, JSON.stringify(sverify.json));

  const status = await req('GET', '/api/manager/passkey/status', A(delegateToken));
  assert.deepEqual(status.json, { enrolled: true, verified: true });
});

test('full parity: the stepped-up delegate reaches every Manager surface, money included', async () => {
  const gets = [
    '/api/admin/overview',
    '/api/admin/fans',
    '/api/admin/models',
    '/api/admin/payouts',
    '/api/admin/withdrawals',
    '/api/admin/contracts',
    '/api/admin/id-verifications',
    '/api/admin/tax',
    '/api/admin/ccbill/orders',
    '/api/admin/audit?limit=5',
    '/api/mod/presence',
  ];
  for (const p of gets) {
    const r = await req('GET', p, A(delegateToken));
    assert.equal(r.status, 200, `${p} → ${r.status} ${JSON.stringify(r.json).slice(0, 120)}`);
  }
  // Withdrawals serialize bank details to Manager principals — parity
  // means the delegate sees the same payload shape as the owner.
  const wd = await req('GET', '/api/admin/withdrawals', A(delegateToken));
  assert.ok(Array.isArray(wd.json.withdrawals));

  // Money mutation: grant a fan credits — lands, is audited, bells.
  const fanId = userIdOf('fandemo');
  const before = readDb((db) => db.prepare(
    'SELECT credits_cents FROM wallets WHERE user_id = ?').get(fanId).credits_cents);
  const grant = await req('POST', `/api/admin/fans/${fanId}/credits`,
    AB(delegateToken, { amount_cents: 500 }));
  assert.equal(grant.status, 200, JSON.stringify(grant.json));
  const after = readDb((db) => db.prepare(
    'SELECT credits_cents FROM wallets WHERE user_id = ?').get(fanId).credits_cents);
  assert.equal(after - before, 500);
  const rows = await waitForAudit(
    "SELECT * FROM manager_audit_log WHERE actor_username = 'mspink' AND action = 'POST /api/admin/fans/:id/credits'");
  assert.equal(rows.length, 1);
  assert.equal(String(rows[0].target_id), String(fanId));

  // The audit view badges delegate rows as Ms. Pink.
  const audit = await req('GET', '/api/admin/audit?limit=50', A(delegateToken));
  assert.equal(audit.status, 200);
  const creditRow = audit.json.audit.find((r) => r.action === 'POST /api/admin/fans/:id/credits');
  assert.ok(creditRow, 'audit view carries the credit grant');
  assert.equal(creditRow.actor_badge, 'Ms. Pink');

  // Sensitive action → owner bell (credits are in the sensitive set).
  const adminId = userIdOf('admin');
  const bells = readDb((db) => db.prepare(
    "SELECT * FROM notifications WHERE user_id = ? AND type = 'delegate_alert'").all(adminId));
  assert.ok(bells.length >= 2, 'sign-in bell + credit-grant bell');
});

test('the delegate can never manage its own seat', async () => {
  const state = await req('GET', '/api/admin/delegate', A(delegateToken));
  assert.equal(state.status, 403);
  const dis = await req('POST', '/api/admin/delegate/disable', AB(delegateToken, {}));
  assert.equal(dis.status, 403);
  const pw = await req('POST', '/api/admin/delegate/set-password',
    AB(delegateToken, { password: 'SelfServe!2345' }));
  assert.equal(pw.status, 403);
});

test('non-principals stay denied: fan and model cannot pass the Manager gates', async () => {
  // "Moderator" does not exist as a role yet; its default-deny is the
  // structural fact that ONLY admin + owner_delegate are principals.
  // Fan and model stand in for every non-principal role.
  const fanLogin = await req('POST', '/api/auth/login', {
    body: { username: 'fandemo', password: 'fan123' } });
  const modelLogin = await req('POST', '/api/auth/login', {
    body: { username: 'bunny', password: 'model123' } });
  for (const t of [fanLogin.json.token, modelLogin.json.token]) {
    const ov = await req('GET', '/api/admin/overview', A(t));
    assert.equal(ov.status, 403);
    const pay = await req('GET', '/api/admin/payouts', A(t));
    assert.equal(pay.status, 403);
    const fanId = userIdOf('fandemo');
    const grant = await req('POST', `/api/admin/fans/${fanId}/credits`,
      AB(t, { amount_cents: 100 }));
    assert.equal(grant.status, 403);
  }
});

test('danger rails: commission needs a reason; protected models cannot be deleted', async () => {
  // Commission without a reason → refused; with one → lands + audited.
  const noReason = await req('PUT', '/api/admin/settings',
    AB(delegateToken, { commission_pct: 41 }));
  assert.equal(noReason.status, 400);
  assert.equal(noReason.json.error, 'reason_required');
  const withReason = await req('PUT', '/api/admin/settings',
    AB(delegateToken, { commission_pct: 41, reason: 'parity test — restoring after' }));
  assert.equal(withReason.status, 200, JSON.stringify(withReason.json));
  const auditRows = await waitForAudit(
    "SELECT * FROM manager_audit_log WHERE action = 'PUT /api/admin/settings'");
  const auditRow = auditRows[auditRows.length - 1];
  assert.ok(auditRow, 'settings change was audit-logged');
  assert.equal(auditRow.reason, 'parity test — restoring after');
  // Restore the default so sibling suites see the standard split.
  const back = await req('PUT', '/api/admin/settings',
    AB(delegateToken, { commission_pct: 40, reason: 'restore default 40' }));
  assert.equal(back.status, 200);

  // A throwaway model (no pictures, no ID, no money) CAN be deleted
  // by the delegate — with a reason, not without.
  const signup = await req('POST', '/api/auth/signup', {
    body: { username: 'throwmodel', password: 'throwpass123', role: 'model',
      display_name: 'Throw Model', dob: '1999-01-01', agree18: true, section: 'female' } });
  assert.equal(signup.status, 200, JSON.stringify(signup.json));
  const throwId = signup.json.user.id;
  const delNoReason = await req('DELETE', `/api/admin/models/${throwId}`,
    AB(delegateToken, {}));
  assert.equal(delNoReason.status, 400);
  assert.equal(delNoReason.json.error, 'reason_required');
  const delOk = await req('DELETE', `/api/admin/models/${throwId}`,
    AB(delegateToken, { reason: 'test fixture cleanup' }));
  assert.equal(delOk.status, 200, JSON.stringify(delOk.json));

  // Pictures on file → protected, even WITH a reason.
  const bunnyId = userIdOf('bunny');
  writeDb((db) => db.prepare(
    "UPDATE models SET photo_url = '/uploads/photo-fixture.jpg' WHERE user_id = ?").run(bunnyId));
  try {
    const delProtected = await req('DELETE', `/api/admin/models/${bunnyId}`,
      AB(delegateToken, { reason: 'should still refuse' }));
    assert.equal(delProtected.status, 403);
    assert.equal(delProtected.json.error, 'protected_account');
    const stillThere = readDb((db) => db.prepare(
      'SELECT id FROM users WHERE id = ?').get(bunnyId));
    assert.ok(stillThere, 'protected model is untouched');
  } finally {
    writeDb((db) => db.prepare(
      "UPDATE models SET photo_url = '' WHERE user_id = ?").run(bunnyId));
  }

  // Approved ID on file → protected too.
  const staceyId = userIdOf('stacey');
  writeDb((db) => db.prepare(
    "INSERT INTO id_verifications (model_id, status) VALUES (?, 'approved')").run(staceyId));
  const delIdApproved = await req('DELETE', `/api/admin/models/${staceyId}`,
    AB(delegateToken, { reason: 'should still refuse' }));
  assert.equal(delIdApproved.status, 403);
  assert.equal(delIdApproved.json.error, 'protected_account');
});

test('delegate sessions expire after 12h', async () => {
  writeDb((db) => db.prepare(
    "UPDATE sessions SET created_at = datetime('now', '-13 hours') WHERE token = ?")
    .run(delegateToken));
  const r = await req('GET', '/api/admin/overview', A(delegateToken));
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'session_expired');
  const gone = readDb((db) => db.prepare(
    'SELECT token FROM sessions WHERE token = ?').get(delegateToken));
  assert.equal(gone, undefined, 'the expired session row is deleted');
});

test('revocation: owner disable kills sessions + passkeys; the owner is untouched', async () => {
  // Fresh delegate session, stepped up (assertion counter advances).
  const login = await managerLogin('mspink', DELEGATE_PW); // manager-login #4
  assert.equal(login.status, 200);
  delegateTokenB = login.json.token;
  const sopts = await req('POST', '/api/manager/passkey/stepup-options',
    AOB(delegateTokenB, {}));
  assert.equal(sopts.status, 200);
  const assertion = dlgAuth.authenticationResponse({
    challenge: sopts.json.challenge, origin: base, rpID: '127.0.0.1', counter: 3 });
  const sverify = await req('POST', '/api/manager/passkey/stepup-verify',
    AOB(delegateTokenB, { response: assertion }));
  assert.equal(sverify.status, 200);
  const okBefore = await req('GET', '/api/admin/overview', A(delegateTokenB));
  assert.equal(okBefore.status, 200);

  // Owner revokes.
  const dis = await req('POST', '/api/admin/delegate/disable', AB(adminToken, {}));
  assert.equal(dis.status, 200);
  assert.equal(dis.json.delegate.enabled, false);
  assert.equal(dis.json.delegate.has_passkey, false);
  assert.equal(dis.json.delegate.active_sessions, 0);

  // The delegate's live session is dead and its passkeys are gone.
  const after = await req('GET', '/api/admin/overview', A(delegateTokenB));
  assert.equal(after.status, 401, 'killed session no longer authenticates');
  const dlgId = userIdOf('mspink');
  const creds = readDb((db) => db.prepare(
    'SELECT COUNT(*) AS n FROM webauthn_credentials WHERE user_id = ?').get(dlgId).n);
  assert.equal(creds, 0);

  // Sign-in is refused while disabled.
  const relogin = await managerLogin('mspink', DELEGATE_PW); // manager-login #5
  assert.equal(relogin.status, 403);
  assert.equal(relogin.json.error, 'delegate_disabled');

  // The owner's own session and powers are exactly as before.
  const ownerOk = await req('GET', '/api/admin/overview', A(adminToken));
  assert.equal(ownerOk.status, 200);
  const ownerSeat = await req('GET', '/api/admin/delegate', A(adminToken));
  assert.equal(ownerSeat.status, 200);
});
