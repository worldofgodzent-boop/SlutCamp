'use strict';
/*
 * Passkey (WebAuthn) — Face ID sign-in, an option for EVERYONE, plus the
 * enforced admin step-up for the Slut Manager and the fan→Manager
 * isolation regressions.
 *
 * Scope under test (final, per Asce Oct 16 2026):
 * - PUBLIC (all roles): any signed-in user may enroll a passkey
 *   (register-*) and later sign in with it (login-*). Password sign-in
 *   stays intact. Enrollment/management are owner-scoped.
 * - ADMIN-ONLY: the Manager step-up (stepup-*) + status endpoint, and
 *   the ENFORCEMENT — once the admin has ≥1 passkey, /api/admin/* and
 *   /api/mod/* refuse any admin session that has not passed the step-up
 *   (403 passkey_required). Bootstrap rule: an admin with NO passkey
 *   enrolled is never gated (no lockout).
 *
 * Boots the REAL server.js as a child process in a throwaway temp dir
 * (same isolation pattern as tests/smoke.test.js: the seeded demo data —
 * admin/admin123, fandemo/fan123 — exists only in the temp DB).
 *
 * The ceremonies use a small SOFTWARE AUTHENTICATOR built in this file:
 * a real P-256 keypair (@noble/curves, already an app dependency),
 * hand-encoded CBOR attestation objects (fmt 'none') and DER ECDSA
 * assertions, exactly as a platform authenticator would produce them.
 * Nothing about verification is mocked — the server runs
 * @simplewebauthn/server verification for real, against an RP ID
 * derived from the request Host (127.0.0.1) and the Origin header.
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

let tmpDir = null;
let child = null;
let base = null;
let childLog = '';

/* ---------------- server boot (mirrors smoke.test.js) ---------------- */

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-passkey-'));
  for (const f of ['server.js', 'package.json']) {
    fs.copyFileSync(path.join(REPO, f), path.join(tmpDir, f));
  }
  for (const d of ['lib', 'public', 'data']) {
    fs.cpSync(path.join(REPO, d), path.join(tmpDir, d), { recursive: true });
  }
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(tmpDir, 'node_modules'), 'dir');

  const port = await freePort();
  // SEED_DEMO=1: this suite's fixtures ARE the demo accounts (admin /
  // fandemo). Seeding is opt-in since the pre-launch fake-money cleanup,
  // so the harness opts in explicitly (the demo-seed purge also stays
  // out of the way while the flag is set).
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

async function passwordLogin(username, password) {
  const r = await req('POST', '/api/auth/login', { body: { username, password } });
  assert.equal(r.status, 200, `password login for ${username} should succeed`);
  return r.json.token;
}

async function managerLogin(username, password) {
  const r = await req('POST', '/api/manager/login', { body: { username, password } });
  assert.equal(r.status, 200, `manager login for ${username} should succeed`);
  return r.json.token;
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

/* ------------- shared state across the sequential tests ------------- */

let fanToken = null;     // fan session from PASSWORD login
let fanPkToken = null;   // fan session issued by PASSKEY sign-in
let adminToken = null;   // admin session A: enrolls the admin passkey
let adminToken2 = null;  // admin session B: fresh login AFTER enrollment
const fanAuth = makeAuthenticator();
const adminAuth = makeAuthenticator();
const MGR = { 'x-manager': '1' };

/* ================= PUBLIC scope: optional Face ID for everyone ================= */

test('enrollment requires a session: register-options anonymous → 401', async () => {
  const r = await req('POST', '/api/auth/passkey/register-options', { body: {} });
  assert.equal(r.status, 401);
});

test('login-options before enrollment → 400 no_passkey (known and unknown users)', async () => {
  // NOTE: login-options calls share a per-IP rate budget (5/min) with the
  // rest of this file — the count is budgeted across these tests, and the
  // dedicated rate-limit test runs LAST.
  const known = await req('POST', '/api/auth/passkey/login-options', {
    body: { username: 'fandemo' }, headers: { origin: base },
  });
  assert.equal(known.status, 400);
  assert.equal(known.json.error, 'no_passkey');
  const unknown = await req('POST', '/api/auth/passkey/login-options', {
    body: { username: 'nosuchuser' }, headers: { origin: base },
  });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.json.error, 'no_passkey');
});

test('fan enrollment IS allowed: garbage verify → 400, real round trip works', async () => {
  fanToken = await passwordLogin('fandemo', 'fan123');

  const garbage = await req('POST', '/api/auth/passkey/register-verify', {
    token: fanToken,
    headers: { origin: base },
    body: { response: { id: 'AAAA', rawId: 'AAAA', type: 'public-key', response: {} } },
  });
  assert.equal(garbage.status, 400);
  const empty = await req('GET', '/api/auth/passkey/list', { token: fanToken });
  assert.deepEqual(empty.json.credentials, []);

  const opts = await req('POST', '/api/auth/passkey/register-options', {
    token: fanToken, headers: { origin: base }, body: {},
  });
  assert.equal(opts.status, 200);
  assert.equal(opts.json.rp.name, 'SlutCamp');
  assert.equal(opts.json.rp.id, '127.0.0.1');
  assert.ok(opts.json.challenge, 'options carry a challenge');

  const response = fanAuth.registrationResponse({
    challenge: opts.json.challenge, origin: base, rpID: opts.json.rp.id, counter: 1,
  });
  const verify = await req('POST', '/api/auth/passkey/register-verify', {
    token: fanToken, headers: { origin: base },
    body: { response, label: 'Fan Phone' },
  });
  assert.equal(verify.status, 200, JSON.stringify(verify.json));
  assert.equal(verify.json.ok, true);

  const list = await req('GET', '/api/auth/passkey/list', { token: fanToken });
  assert.equal(list.status, 200);
  assert.equal(list.json.credentials.length, 1);
  const cred = list.json.credentials[0];
  assert.equal(cred.device_label, 'Fan Phone');
  assert.ok(Number.isInteger(cred.id));
  assert.ok(cred.created_at, 'created_at present');
  assert.equal(cred.last_used_at, null);
  assert.ok(!('public_key' in cred), 'list must never expose public keys');
  assert.ok(!('credential_id' in cred), 'list must never expose credential ids');
});

test('login-verify with a garbage response → 401 and creates NO session', async () => {
  const sessionsBefore = readDb((db) =>
    db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = 'fandemo')").get().n);
  const opts = await req('POST', '/api/auth/passkey/login-options', {
    body: { username: 'fandemo' }, headers: { origin: base },
  });
  assert.equal(opts.status, 200);
  const bad = await req('POST', '/api/auth/passkey/login-verify', {
    headers: { origin: base },
    body: { username: 'fandemo', response: { id: 'AAAA', rawId: 'AAAA', type: 'public-key', response: {} } },
  });
  assert.equal(bad.status, 401);
  assert.equal(bad.json.error, 'verification_failed');
  const sessionsAfter = readDb((db) =>
    db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = 'fandemo')").get().n);
  assert.equal(sessionsAfter, sessionsBefore, 'a failed passkey sign-in must not create a session');
});

test('fan passkey sign-in round trip: real session issued, counter + last_used updated', async () => {
  const opts = await req('POST', '/api/auth/passkey/login-options', {
    body: { username: 'FanDemo' }, headers: { origin: base }, // case-insensitive
  });
  assert.equal(opts.status, 200);
  assert.equal(opts.json.allowCredentials.length, 1);
  assert.equal(opts.json.allowCredentials[0].id, fanAuth.credIdB64);

  const assertion = fanAuth.authenticationResponse({
    challenge: opts.json.challenge, origin: base, rpID: opts.json.rpId, counter: 2,
  });
  const verify = await req('POST', '/api/auth/passkey/login-verify', {
    headers: { origin: base },
    body: { username: 'FanDemo', response: assertion },
  });
  assert.equal(verify.status, 200, JSON.stringify(verify.json));
  assert.ok(verify.json.token, 'a session token is issued');
  assert.equal(verify.json.user.username, 'fandemo');
  assert.equal(verify.json.user.role, 'fan');
  assert.equal(verify.json.manager_account, false);
  fanPkToken = verify.json.token;

  const me = await req('GET', '/api/me', { token: fanPkToken });
  assert.equal(me.status, 200, 'the passkey-issued session works like a password session');
  assert.equal(me.json.user.role, 'fan');

  const row = readDb((db) =>
    db.prepare("SELECT counter, last_used_at FROM webauthn_credentials WHERE user_id = (SELECT id FROM users WHERE username = 'fandemo')").get());
  assert.equal(row.counter, 2, 'authenticator counter updated in DB');
  assert.ok(row.last_used_at, 'last_used_at stamped after sign-in');
});

/* ------- fan → Manager isolation regression tests (hard requirement) ------- */

test('fan cannot log in through the Manager door → 403 not_manager', async () => {
  const r = await req('POST', '/api/manager/login', {
    body: { username: 'fandemo', password: 'fan123' },
  });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'not_manager');
  assert.ok(!r.json.token, 'no token may be issued');
});

test('fan token — even a PASSKEY-issued one — cannot reach /api/admin/stats', async () => {
  for (const token of [fanToken, fanPkToken]) {
    const withHeader = await req('GET', '/api/admin/stats', { token, headers: MGR });
    assert.equal(withHeader.status, 403);
    const without = await req('GET', '/api/admin/stats', { token });
    assert.equal(without.status, 403);
  }
});

test('admin-only doors refuse a fan session: step-up + status → 403', async () => {
  const so = await req('POST', '/api/manager/passkey/stepup-options', {
    token: fanToken, headers: { origin: base }, body: {},
  });
  assert.equal(so.status, 403);
  const st = await req('GET', '/api/manager/passkey/status', { token: fanToken });
  assert.equal(st.status, 403);
});

/* ================= ADMIN scope: enforced Face ID step-up ================= */

test('bootstrap: admin with NO passkey reaches admin routes (no lockout)', async () => {
  adminToken = await managerLogin('admin', 'admin123');

  const st = await req('GET', '/api/manager/passkey/status', { token: adminToken });
  assert.equal(st.status, 200);
  assert.deepEqual(st.json, { enrolled: false, verified: false });

  const stats = await req('GET', '/api/admin/stats', { token: adminToken, headers: MGR });
  assert.equal(stats.status, 200, `bootstrap admin stats should succeed, got ${stats.status}`);
  const presence = await req('GET', '/api/mod/presence', { token: adminToken, headers: MGR });
  assert.equal(presence.status, 200, `bootstrap mod presence should succeed, got ${presence.status}`);
});

test('admin enrollment round trip (software authenticator)', async () => {
  const garbage = await req('POST', '/api/auth/passkey/register-verify', {
    token: adminToken,
    headers: { origin: base },
    body: { response: { id: 'AAAA', rawId: 'AAAA', type: 'public-key', response: {} } },
  });
  assert.equal(garbage.status, 400);

  const opts = await req('POST', '/api/auth/passkey/register-options', {
    token: adminToken, headers: { origin: base }, body: {},
  });
  assert.equal(opts.status, 200);
  const response = adminAuth.registrationResponse({
    challenge: opts.json.challenge, origin: base, rpID: opts.json.rp.id, counter: 1,
  });
  const verify = await req('POST', '/api/auth/passkey/register-verify', {
    token: adminToken, headers: { origin: base },
    body: { response, label: 'Admin Key' },
  });
  assert.equal(verify.status, 200, JSON.stringify(verify.json));

  const list = await req('GET', '/api/auth/passkey/list', { token: adminToken });
  assert.equal(list.json.credentials.length, 1);
  assert.equal(list.json.credentials[0].device_label, 'Admin Key');

  // Session A enrolled but has NOT stepped up yet.
  const st = await req('GET', '/api/manager/passkey/status', { token: adminToken });
  assert.deepEqual(st.json, { enrolled: true, verified: false });
});

test('enforcement: fresh admin session → 403 passkey_required on admin + mod routes', async () => {
  adminToken2 = await managerLogin('admin', 'admin123');

  const st = await req('GET', '/api/manager/passkey/status', { token: adminToken2 });
  assert.deepEqual(st.json, { enrolled: true, verified: false });

  const stats = await req('GET', '/api/admin/stats', { token: adminToken2, headers: MGR });
  assert.equal(stats.status, 403);
  assert.equal(stats.json.error, 'passkey_required');

  const presence = await req('GET', '/api/mod/presence', { token: adminToken2, headers: MGR });
  assert.equal(presence.status, 403);
  assert.equal(presence.json.error, 'passkey_required');

  // The step-up door itself stays reachable (never gated).
  const stepOpts = await req('POST', '/api/manager/passkey/stepup-options', {
    token: adminToken2, headers: { origin: base }, body: {},
  });
  assert.equal(stepOpts.status, 200);
});

test('step-up: garbage assertion → 401 and no stamp; real assertion unlocks', async () => {
  const o1 = await req('POST', '/api/manager/passkey/stepup-options', {
    token: adminToken2, headers: { origin: base }, body: {},
  });
  assert.equal(o1.status, 200);
  const bad = await req('POST', '/api/manager/passkey/stepup-verify', {
    token: adminToken2, headers: { origin: base },
    body: { response: { id: 'AAAA', rawId: 'AAAA', type: 'public-key', response: {} } },
  });
  assert.equal(bad.status, 401);
  const stampedAfterBad = readDb((db) =>
    db.prepare('SELECT passkey_verified_at FROM sessions WHERE token = ?').get(adminToken2).passkey_verified_at);
  assert.equal(stampedAfterBad, null);
  const stillLocked = await req('GET', '/api/admin/stats', { token: adminToken2, headers: MGR });
  assert.equal(stillLocked.status, 403);
  assert.equal(stillLocked.json.error, 'passkey_required');

  const o2 = await req('POST', '/api/manager/passkey/stepup-options', {
    token: adminToken2, headers: { origin: base }, body: {},
  });
  assert.equal(o2.status, 200);
  assert.equal(o2.json.allowCredentials.length, 1);
  assert.equal(o2.json.allowCredentials[0].id, adminAuth.credIdB64);
  const assertion = adminAuth.authenticationResponse({
    challenge: o2.json.challenge, origin: base, rpID: o2.json.rpId, counter: 2,
  });
  const good = await req('POST', '/api/manager/passkey/stepup-verify', {
    token: adminToken2, headers: { origin: base }, body: { response: assertion },
  });
  assert.equal(good.status, 200, JSON.stringify(good.json));
  assert.equal(good.json.ok, true);

  const stamped = readDb((db) =>
    db.prepare('SELECT passkey_verified_at FROM sessions WHERE token = ?').get(adminToken2).passkey_verified_at);
  assert.ok(stamped, 'current admin session stamped passkey_verified_at');
  const counter = readDb((db) =>
    db.prepare("SELECT counter FROM webauthn_credentials WHERE user_id = (SELECT id FROM users WHERE username = 'admin')").get().counter);
  assert.equal(counter, 2, 'authenticator counter updated in DB');

  const st = await req('GET', '/api/manager/passkey/status', { token: adminToken2 });
  assert.deepEqual(st.json, { enrolled: true, verified: true });

  const stats = await req('GET', '/api/admin/stats', { token: adminToken2, headers: MGR });
  assert.equal(stats.status, 200, 'verified session reaches admin routes');
  const presence = await req('GET', '/api/mod/presence', { token: adminToken2, headers: MGR });
  assert.equal(presence.status, 200, 'verified session reaches mod routes');

  const list = await req('GET', '/api/auth/passkey/list', { token: adminToken2 });
  assert.ok(list.json.credentials[0].last_used_at, 'last_used_at stamped after step-up');
});

/* ---------------- removal: owner-scoped for everyone ---------------- */

test('removal: cross-user delete → 404 and the row survives; owners can remove', async () => {
  const adminList = await req('GET', '/api/auth/passkey/list', { token: adminToken2 });
  const adminCredId = adminList.json.credentials[0].id;
  const fanList = await req('GET', '/api/auth/passkey/list', { token: fanToken });
  const fanCredId = fanList.json.credentials[0].id;

  const fanTry = await req('DELETE', `/api/auth/passkey/${adminCredId}`, { token: fanToken });
  assert.equal(fanTry.status, 404, "a fan cannot delete the admin's passkey");
  const stillThere = await req('GET', '/api/auth/passkey/list', { token: adminToken2 });
  assert.equal(stillThere.json.credentials.length, 1, 'admin passkey survived the fan delete attempt');

  const fanOwn = await req('DELETE', `/api/auth/passkey/${fanCredId}`, { token: fanToken });
  assert.equal(fanOwn.status, 200);
  const fanAfter = await req('GET', '/api/auth/passkey/list', { token: fanToken });
  assert.deepEqual(fanAfter.json.credentials, []);

  const adminOwn = await req('DELETE', `/api/auth/passkey/${adminCredId}`, { token: adminToken2 });
  assert.equal(adminOwn.status, 200);
  const st = await req('GET', '/api/manager/passkey/status', { token: adminToken2 });
  assert.deepEqual(st.json, { enrolled: false, verified: true });

  // No admin credentials remain → enforcement lifts for everyone.
  const stats = await req('GET', '/api/admin/stats', { token: adminToken, headers: MGR });
  assert.equal(stats.status, 200, 'unenrolled admin session passes again (bootstrap)');
});

/* ------------- rate limiting (LAST: it exhausts the shared budget) ------------- */

test('passkey sign-in is rate limited per IP (login-options)', async () => {
  // Prior login-options calls in this file already used part of the
  // 5/min budget; hammering must trip 429 well within these attempts.
  let saw429 = false;
  let last = null;
  for (let i = 0; i < 6; i++) {
    last = await req('POST', '/api/auth/passkey/login-options', {
      body: { username: 'fandemo' }, headers: { origin: base },
    });
    if (last.status === 429) saw429 = true;
  }
  assert.ok(saw429, 'expected at least one 429 while hammering login-options');
  assert.equal(last.status, 429);
  assert.equal(last.json.error, 'too_many_attempts');
});
