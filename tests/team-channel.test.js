'use strict';
/*
 * Team channel + second delegate seat (Assignment 01, 2026-10-25,
 * from Ms. Pink; briefing pack wins on any disagreement).
 *
 * What is under test:
 * - The kaykay seat EXISTS at boot, DISABLED, role owner_delegate,
 *   display name Kay Kay, with no usable password — same boot-time
 *   ensure pattern as mspink, second seat, never shared.
 * - Owner-only per-seat controls: GET /api/admin/delegates lists
 *   both seats; GET/POST /api/admin/delegate/kaykay/* enable,
 *   disable, set-password, enroll-passkey — and a delegate (either
 *   seat) or a fan gets 403 on every seat-management endpoint.
 * - Password sign-in is the proven route for BOTH delegate seats:
 *   with NO passkey enrolled, an enabled delegate seat reaches
 *   /api/admin/* on its password alone (Kay Kay's Assignment 01
 *   rule, extended to mspink by owner order 2026-10-25). Enrolling
 *   a passkey re-arms the step-up — exercised here for mspink with
 *   the same software authenticator as tests/owner-delegate.test.js,
 *   verification never mocked.
 * - Team channel: POST/GET /api/admin/team-messages by owner +
 *   both delegates; author identities owner / delegate:mspink /
 *   delegate:kaykay with labels Owner / Ms. Pink / Kay Kay;
 *   chronological order, latest-N + before-cursor pagination,
 *   persistence across reads, body cap 4000 (empty 400, 4001 400,
 *   exactly 4000 accepted), and a team_message_post audit row for
 *   every poster's post.
 * - Denied: moderator 403, fan 403, anon 401 (with X-Manager) /
 *   403 manager_only (without it). Nothing public: the public
 *   client carries no team-channel code.
 * - Revocation: owner disable kills the kaykay seat's sessions and
 *   its token is refused (delegate_disabled) immediately.
 * - STR x13: the Manager team panel's TEAM_I18N table carries all
 *   13 languages with identical key sets (server SRV kaykay bells
 *   are covered by tests/languages-13.test.js, which asserts every
 *   SRV key covers all 13).
 *
 * Boots the REAL server.js like tests/owner-delegate.test.js
 * (SEED_DEMO=1 throwaway DB).
 *
 * Login-budget note: /api/manager/login shares a 5/min per-IP rate
 * limit, so this flow uses exactly five Manager logins: admin,
 * kaykay-disabled, kaykay-enabled, mspink, moderator. No sixth.
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
const KAYKAY_PW = 'KayKayPass!23';
const MSPINK_PW = 'MsPinkPass!23';
const MOD_PW = 'workerpass1';
const LANG13 = ['en', 'es', 'pt', 'fr', 'de', 'ru', 'ja', 'zh', 'ko', 'it', 'pl', 'nl', 'tr'];
const TEAM_KEYS = ['team_title', 'team_sub', 'team_empty', 'team_placeholder', 'team_send',
  'team_load_more', 'team_posted', 'team_failed', 'team_load_failed'];

let tmpDir = null;
let child = null;
let base = null;
let childLog = '';

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-team-'));
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

/* ---------------- minimal CBOR + software authenticator ----------------
 * (same construction as tests/owner-delegate.test.js, verbatim in
 * shape — verification on the server side is never mocked). */

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
function makeAuthenticator() {
  const secretKey = p256.utils.randomSecretKey();
  const pub = p256.getPublicKey(secretKey, false);
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

/* ---------------- shared state ---------------- */

const msAuth = makeAuthenticator();
let adminToken = null;
let kaykayToken = null;
let mspinkToken = null;
let modToken = null;

const A = (token) => ({ token, headers: MGR });
const AO = (token) => ({ token, headers: { origin: base } });
const AB = (token, body) => ({ token, headers: MGR, body });
const AOB = (token, body) => ({ token, headers: { origin: base }, body });

/* ---------------- seat at boot ---------------- */

test('kaykay seat exists at boot: owner_delegate / Kay Kay / DISABLED, no password works yet', async () => {
  const seat = readDb((db) => db.prepare(
    "SELECT * FROM users WHERE username = 'kaykay'").get());
  assert.ok(seat, 'the kaykay seat is created at boot');
  assert.equal(seat.role, 'owner_delegate');
  assert.equal(seat.display_name, 'Kay Kay');
  assert.equal(Number(seat.delegate_enabled), 0, 'seat ships disabled');
  assert.ok(seat.password_hash && seat.password_hash.startsWith('$2'),
    'a bcrypt hash is stored (of a throwaway secret nobody knows)');
  const guess = await req('POST', '/api/auth/login', {
    body: { username: 'kaykay', password: 'whatever-guess-123' } });
  assert.equal(guess.status, 401);
  assert.equal(guess.json.error, 'bad_login');
  // mspink is untouched by the second seat.
  const ms = readDb((db) => db.prepare(
    "SELECT * FROM users WHERE username = 'mspink'").get());
  assert.ok(ms && ms.role === 'owner_delegate' && Number(ms.delegate_enabled) === 0);
});

test('owner flow: admin reads both seats, sets the kaykay password (owner-only, house rules)', async () => {
  const login = await managerLogin('admin', 'admin123'); // manager-login #1
  assert.equal(login.status, 200, JSON.stringify(login.json));
  adminToken = login.json.token;

  const list = await req('GET', '/api/admin/delegates', A(adminToken));
  assert.equal(list.status, 200, JSON.stringify(list.json));
  const names = (list.json.delegates || []).map((d) => d.username).sort();
  assert.deepEqual(names, ['kaykay', 'mspink'], 'both delegate seats listed');
  assert.ok(list.json.delegates.every((d) => d.role === 'owner_delegate'));

  const state = await req('GET', '/api/admin/delegate/kaykay', A(adminToken));
  assert.equal(state.status, 200);
  assert.equal(state.json.delegate.username, 'kaykay');
  assert.equal(state.json.delegate.display_name, 'Kay Kay');
  assert.equal(state.json.delegate.enabled, false);
  assert.equal(state.json.delegate.has_passkey, false);

  const unknown = await req('GET', '/api/admin/delegate/notaseat', A(adminToken));
  assert.equal(unknown.status, 404);

  const weak = await req('POST', '/api/admin/delegate/kaykay/set-password',
    AB(adminToken, { password: 'short' }));
  assert.equal(weak.status, 400);
  assert.equal(weak.json.error, 'weak_password');
  const dflt = await req('POST', '/api/admin/delegate/kaykay/set-password',
    AB(adminToken, { password: 'admin123' }));
  assert.equal(dflt.status, 400);
  assert.equal(dflt.json.error, 'default_password');

  const set = await req('POST', '/api/admin/delegate/kaykay/set-password',
    AB(adminToken, { password: KAYKAY_PW }));
  assert.equal(set.status, 200, JSON.stringify(set.json));
  assert.ok(!JSON.stringify(set.json).includes(KAYKAY_PW),
    'the password is never echoed back');

  // A fan is refused outright on the per-seat endpoints too.
  const fanLogin = await req('POST', '/api/auth/login', {
    body: { username: 'fandemo', password: 'fan123' } });
  assert.equal(fanLogin.status, 200);
  const fanToken = fanLogin.json.token;
  const fanTry = await req('GET', '/api/admin/delegate/kaykay', A(fanToken));
  assert.equal(fanTry.status, 403);
  const fanSet = await req('POST', '/api/admin/delegate/kaykay/set-password',
    AB(fanToken, { password: 'FanTryPass!234' }));
  assert.equal(fanSet.status, 403);
});

test('disabled kaykay seat refuses even the correct password at the Manager door', async () => {
  const r = await managerLogin('kaykay', KAYKAY_PW); // manager-login #2
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'delegate_disabled');
});

test('enable → kaykay password sign-in works with NO passkey (Assignment 01 exception)', async () => {
  const en = await req('POST', '/api/admin/delegate/kaykay/enable', AB(adminToken, {}));
  assert.equal(en.status, 200);
  assert.equal(en.json.delegate.enabled, true);
  assert.equal(en.json.delegate.username, 'kaykay');

  const login = await managerLogin('kaykay', KAYKAY_PW); // manager-login #3
  assert.equal(login.status, 200, JSON.stringify(login.json));
  assert.equal(login.json.user.role, 'owner_delegate');
  kaykayToken = login.json.token;

  // No passkey enrolled, yet the Manager surface opens on her
  // password alone — the delegate password-first rule.
  const ov = await req('GET', '/api/admin/overview', A(kaykayToken));
  assert.equal(ov.status, 200, JSON.stringify(ov.json));
});

/* ---------------- team channel: owner + kaykay first ---------------- */

test('team channel: empty at first, owner + kaykay post and read chronologically', async () => {
  const empty = await req('GET', '/api/admin/team-messages', A(adminToken));
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.json.messages, []);
  assert.equal(empty.json.has_more, false);
  assert.equal(empty.json.before, null);

  const p1 = await req('POST', '/api/admin/team-messages',
    AB(adminToken, { body: 'Owner: build the channel.' }));
  assert.equal(p1.status, 200, JSON.stringify(p1.json));
  assert.equal(p1.json.message.author, 'owner');
  assert.equal(p1.json.message.author_label, 'Owner');

  const p2 = await req('POST', '/api/admin/team-messages',
    AB(kaykayToken, { body: 'Kay Kay: channel built, reporting back.' }));
  assert.equal(p2.status, 200, JSON.stringify(p2.json));
  assert.equal(p2.json.message.author, 'delegate:kaykay');
  assert.equal(p2.json.message.author_label, 'Kay Kay');

  const all = await req('GET', '/api/admin/team-messages', A(kaykayToken));
  assert.equal(all.status, 200);
  assert.deepEqual(all.json.messages.map((m) => m.author),
    ['owner', 'delegate:kaykay']);
  assert.deepEqual(all.json.messages.map((m) => m.author_label),
    ['Owner', 'Kay Kay']);
  assert.deepEqual(all.json.messages.map((m) => m.body),
    ['Owner: build the channel.', 'Kay Kay: channel built, reporting back.']);
  // ids strictly increase in chronological order (persistence).
  assert.ok(all.json.messages[0].id < all.json.messages[1].id);
});

/* ------------- mspink: password-first, then channel ------------- */

test('mspink: owner sets password + enables; password alone unlocks, enrolling a passkey re-arms the step-up, then she posts', async () => {
  const set = await req('POST', '/api/admin/delegate/set-password',
    AB(adminToken, { password: MSPINK_PW }));
  assert.equal(set.status, 200);
  const en = await req('POST', '/api/admin/delegate/enable', AB(adminToken, {}));
  assert.equal(en.status, 200);

  const login = await managerLogin('mspink', MSPINK_PW); // manager-login #4
  assert.equal(login.status, 200, JSON.stringify(login.json));
  mspinkToken = login.json.token;

  // Password-first (owner order 2026-10-25): no passkey enrolled →
  // her password alone opens the channel.
  const openRead = await req('GET', '/api/admin/team-messages', A(mspinkToken));
  assert.equal(openRead.status, 200, JSON.stringify(openRead.json));

  const open = await req('POST', '/api/admin/delegate/enroll-passkey', AB(adminToken, {}));
  assert.equal(open.status, 200);
  const opts = await req('POST', '/api/auth/passkey/register-options',
    AOB(mspinkToken, {}));
  assert.equal(opts.status, 200, JSON.stringify(opts.json));
  const response = msAuth.registrationResponse({
    challenge: opts.json.challenge, origin: base, rpID: '127.0.0.1' });
  const verify = await req('POST', '/api/auth/passkey/register-verify',
    AOB(mspinkToken, { response, label: 'Ms. Pink browser' }));
  assert.equal(verify.status, 200, JSON.stringify(verify.json));

  // The fresh passkey re-arms the step-up on her seat too: this
  // session has not verified yet, so the channel locks again.
  const relocked = await req('GET', '/api/admin/team-messages', A(mspinkToken));
  assert.equal(relocked.status, 403);
  assert.equal(relocked.json.error, 'passkey_required');

  const sopts = await req('POST', '/api/manager/passkey/stepup-options',
    AOB(mspinkToken, {}));
  assert.equal(sopts.status, 200, JSON.stringify(sopts.json));
  const assertion = msAuth.authenticationResponse({
    challenge: sopts.json.challenge, origin: base, rpID: '127.0.0.1', counter: 2 });
  const sverify = await req('POST', '/api/manager/passkey/stepup-verify',
    AOB(mspinkToken, { response: assertion }));
  assert.equal(sverify.status, 200, JSON.stringify(sverify.json));

  const p3 = await req('POST', '/api/admin/team-messages',
    AB(mspinkToken, { body: 'Ms. Pink: received, gate is mine.' }));
  assert.equal(p3.status, 200, JSON.stringify(p3.json));
  assert.equal(p3.json.message.author, 'delegate:mspink');
  assert.equal(p3.json.message.author_label, 'Ms. Pink');

  const all = await req('GET', '/api/admin/team-messages', A(adminToken));
  assert.deepEqual(all.json.messages.map((m) => m.author),
    ['owner', 'delegate:kaykay', 'delegate:mspink']);
  assert.deepEqual(all.json.messages.map((m) => m.body),
    ['Owner: build the channel.', 'Kay Kay: channel built, reporting back.',
     'Ms. Pink: received, gate is mine.']);
});

/* ---------------- pagination + body cap ---------------- */

test('team channel: latest-N + before-cursor pagination, body cap enforced', async () => {
  const page = await req('GET', '/api/admin/team-messages?limit=2', A(adminToken));
  assert.equal(page.status, 200);
  assert.deepEqual(page.json.messages.map((m) => m.author),
    ['delegate:kaykay', 'delegate:mspink'], 'latest 2, chronological within the page');
  assert.equal(page.json.has_more, true);
  assert.ok(page.json.before, 'a before-cursor is returned');
  const older = await req('GET', `/api/admin/team-messages?limit=2&before=${page.json.before}`, A(adminToken));
  assert.equal(older.status, 200);
  assert.deepEqual(older.json.messages.map((m) => m.author), ['owner']);
  assert.equal(older.json.has_more, false);
  assert.equal(older.json.before, null);

  const emptyPost = await req('POST', '/api/admin/team-messages',
    AB(adminToken, { body: '   ' }));
  assert.equal(emptyPost.status, 400);
  assert.equal(emptyPost.json.error, 'body_required');
  const tooLong = await req('POST', '/api/admin/team-messages',
    AB(adminToken, { body: 'x'.repeat(4001) }));
  assert.equal(tooLong.status, 400);
  assert.equal(tooLong.json.error, 'body_too_long');
  const exact = await req('POST', '/api/admin/team-messages',
    AB(adminToken, { body: 'y'.repeat(4000) }));
  assert.equal(exact.status, 200, 'exactly 4000 chars is accepted');
  assert.equal(exact.json.message.body.length, 4000);
});

/* ---------------- audit + denied ---------------- */

test('team channel: every post wrote a team_message_post audit row', async () => {
  const rows = await waitForAudit(
    "SELECT * FROM manager_audit_log WHERE action = 'team_message_post' ORDER BY id");
  assert.ok(rows.length >= 4, `expected >=4 team posts audited, got ${rows.length}`);
  const byActor = {};
  for (const r of rows) byActor[r.actor_username] = (byActor[r.actor_username] || 0) + 1;
  assert.ok(byActor.admin >= 2, 'owner posts audited');
  assert.ok(byActor.kaykay >= 1, 'kaykay post audited as kaykay');
  assert.ok(byActor.mspink >= 1, 'mspink post audited as mspink');
  assert.ok(rows.every((r) => r.target_type === 'team_message'));
});

test('team channel: moderator 403, fan 403, anon 401/403 — nothing public', async () => {
  // Moderator account via the owner invite flow.
  const inv = await req('POST', '/api/admin/moderator-invites',
    AB(adminToken, { label: 'Team Mod' }));
  assert.equal(inv.status, 200, JSON.stringify(inv.json));
  const code = inv.json.invite.url.split('/moderator-invite/')[1];
  const signup = await req('POST', `/api/moderator-invite/${code}/signup`, {
    body: { display_name: 'Team Mod', email: 'teammod@example.com', password: MOD_PW } });
  assert.equal(signup.status, 200, JSON.stringify(signup.json));
  const mlogin = await managerLogin('teammod@example.com', MOD_PW); // manager-login #5
  assert.equal(mlogin.status, 200, JSON.stringify(mlogin.json));
  modToken = mlogin.json.token;
  assert.equal(mlogin.json.user.role, 'moderator');

  const modGet = await req('GET', '/api/admin/team-messages', A(modToken));
  assert.equal(modGet.status, 403, 'moderator is refused the agent channel');
  const modPost = await req('POST', '/api/admin/team-messages',
    AB(modToken, { body: 'Mod: hello?' }));
  assert.equal(modPost.status, 403);

  const fanLogin = await req('POST', '/api/auth/login', {
    body: { username: 'fandemo', password: 'fan123' } });
  const fanGet = await req('GET', '/api/admin/team-messages', A(fanLogin.json.token));
  assert.equal(fanGet.status, 403);
  const anon = await req('GET', '/api/admin/team-messages', { headers: MGR });
  assert.equal(anon.status, 401, 'no token, Manager header present');
  const noHeader = await req('GET', '/api/admin/team-messages', {});
  assert.equal(noHeader.status, 403);
  assert.equal(noHeader.json.error, 'manager_only');
});

test('seat management stays owner-only: neither delegate can manage any seat', async () => {
  const kkTry = await req('POST', '/api/admin/delegate/mspink/disable',
    AB(kaykayToken, {}));
  assert.equal(kkTry.status, 403, 'kaykay cannot disable mspink');
  const msTry = await req('POST', '/api/admin/delegate/kaykay/set-password',
    AB(mspinkToken, { password: 'SelfServe!2345' }));
  assert.equal(msTry.status, 403, 'mspink cannot re-password kaykay');
  const msSelf = await req('GET', '/api/admin/delegate/mspink', A(mspinkToken));
  assert.equal(msSelf.status, 403, 'mspink cannot even read seat state');
  // Owner still can (sanity: the owner-only chain is intact).
  const ownerRead = await req('GET', '/api/admin/delegate/kaykay', A(adminToken));
  assert.equal(ownerRead.status, 200);
  assert.equal(ownerRead.json.delegate.enabled, true);
});

test('revocation: owner disable kills kaykay sessions; her token is refused at once', async () => {
  const dis = await req('POST', '/api/admin/delegate/kaykay/disable', AB(adminToken, {}));
  assert.equal(dis.status, 200);
  assert.equal(dis.json.delegate.enabled, false);
  assert.equal(dis.json.delegate.active_sessions, 0);
  // The session was deleted with the seat, so the dead token no
  // longer authenticates at all (401) — the same precedent as the
  // mspink revocation test; delegate_disabled is what a live
  // session on a disabled seat gets, and sign-in is refused too.
  const after = await req('GET', '/api/admin/team-messages', A(kaykayToken));
  assert.equal(after.status, 401);
  assert.equal(after.json.error, 'not_logged_in');
  readDb((db) => {
    const seat = db.prepare("SELECT * FROM users WHERE username = 'kaykay'").get();
    assert.equal(Number(seat.delegate_enabled), 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?')
      .get(seat.id).n, 0, 'all kaykay sessions deleted on disable');
  });
});

/* ---------------- source pins: guards, STR x13, zero public delta ---------------- */

test('source pins: principal guard unchanged, team wiring present, STR x13, no public surface', () => {
  const serverSrc = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
  const managerSrc = fs.readFileSync(path.join(REPO, 'public/manager/manager.js'), 'utf8');
  const appSrc = fs.readFileSync(path.join(REPO, 'public/js/app.js'), 'utf8');
  assert.match(serverSrc, /const isManagerPrincipal = \(user\) =>\s*!!user && \(user\.role === 'admin' \|\| user\.role === 'owner_delegate'\)/,
    'isManagerPrincipal is still exactly admin + owner_delegate');
  assert.ok(serverSrc.includes("CREATE TABLE IF NOT EXISTS team_messages"),
    'team_messages table exists');
  assert.ok(serverSrc.includes("app.get('/api/admin/team-messages'"),
    'team GET route exists');
  assert.ok(serverSrc.includes("app.post('/api/admin/team-messages'"),
    'team POST route exists');
  assert.ok(serverSrc.includes("app.get('/api/admin/delegates'"),
    'delegates list route exists');
  assert.ok(serverSrc.includes("app.post('/api/admin/delegate/:username/enable'"),
    'per-seat enable route exists');
  assert.ok(serverSrc.includes('bell_delegate_kaykay_title: { en:'),
    'SRV kaykay bell title exists');
  assert.ok(serverSrc.includes('bell_delegate_kaykay_body: { en:'),
    'SRV kaykay bell body exists');
  // Manager team screen + second delegate card.
  assert.ok(managerSrc.includes('adminTeamBody'), 'team screen body exists');
  assert.ok(managerSrc.includes("['team', '💬 Team channel']"), 'team nav entry exists');
  assert.ok(managerSrc.includes('/admin/team-messages'), 'team API wired in Manager');
  assert.ok(managerSrc.includes('/admin/delegate/kaykay'), 'kaykay seat controls wired');
  assert.ok(managerSrc.includes('Delegate seat — Kay Kay'), 'kaykay card exists');
  // TEAM_I18N: every key in all 13 languages, non-empty by construction
  // (each language row is a literal object; count key occurrences).
  for (const k of TEAM_KEYS) {
    assert.equal((managerSrc.match(new RegExp(`${k}:`, 'g')) || []).length, 13,
      `TEAM_I18N ${k} exists in all 13 languages`);
  }
  for (const lang of LANG13) {
    assert.ok(managerSrc.includes(`  ${lang}: { team_title:`),
      `TEAM_I18N carries ${lang}`);
  }
  // Zero public delta: the public client never mentions the channel.
  assert.ok(!appSrc.includes('team-messages'), 'public app has no team-channel code');
  assert.ok(!appSrc.includes('adminTeamBody'), 'public app has no team screen');
  assert.ok(!serverSrc.includes("app.get('/api/team-messages'"),
    'no public team route exists');
});
