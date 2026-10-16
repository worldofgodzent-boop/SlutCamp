'use strict';
/*
 * Change password — POST /api/me/change-password, end to end.
 *
 * The feature exists for one reason: the production admin still signs
 * in with the seed-default password printed in the (formerly) public
 * README, and there was NO self-service way to rotate it. These tests
 * boot the real server on a throwaway DB (SEED_DEMO=1 — the fixtures
 * are the demo accounts, like reactions) and pin the whole contract:
 *   - guests are refused (403 login_required — no password to change)
 *   - wrong current password → 401 wrong_current, nothing changes
 *   - a seed-default new password → 400 default_password (checked
 *     BEFORE the length floor on purpose: every seed default is
 *     shorter than 10 chars, so a length-first check would make the
 *     distinct error unreachable; case-insensitive)
 *   - too short → 400 weak_password; new == current → 400 weak_password
 *   - success: old password can no longer log in, the new one can,
 *     every OTHER session is revoked, and the caller's session lives
 * Plus source pins: the Settings cards in app.js (fan wallet + model
 * settings, next to the Face ID card) and the Manager's Settings card
 * both post to the endpoint.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const REPO = path.join(__dirname, '..');
let child = null;
let childLog = '';
let base = null;
let tmpDir = null;

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

async function waitForServer() {
  const deadline = Date.now() + 20000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode})\n${childLog}`);
    try {
      const r = await fetch(base + '/api/health');
      if (r.ok) return;
    } catch (e) { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`server did not come up\n${childLog}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function req(method, p, { body, token, guest } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = 'Bearer ' + token;
  if (guest) headers['x-guest-token'] = guest;
  const r = await fetch(base + p, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: r.status, json, text };
}

const login = (username, password) => req('POST', '/api/auth/login', { body: { username, password } });
const changePw = (token, current_password, new_password) =>
  req('POST', '/api/me/change-password', { body: { current_password, new_password }, token });

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-changepw-'));
  fs.cpSync(path.join(REPO, 'server.js'), path.join(tmpDir, 'server.js'));
  fs.cpSync(path.join(REPO, 'package.json'), path.join(tmpDir, 'package.json'));
  for (const d of ['lib', 'public', 'data']) {
    fs.cpSync(path.join(REPO, d), path.join(tmpDir, d), { recursive: true });
  }
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(tmpDir, 'node_modules'), 'dir');

  let lastErr = null;
  for (let attempt = 1; attempt <= 3 && !base; attempt++) {
    const port = await freePort();
    // SEED_DEMO=1: fixtures are the demo accounts (fandemo). Seeding is
    // opt-in since the fake-money cleanup; the purge stays out of the
    // way while the flag is set.
    const env = { ...process.env, PORT: String(port), CRYPTO_POLL_MS: '3600000', SEED_DEMO: '1' };
    for (const k of Object.keys(env)) {
      if (/^(CCBILL_|CRYPTO_|OPENAI_|TWILIO_|VAPID_|WEBAUTHN_)/.test(k)) delete env[k];
    }
    childLog = '';
    child = spawn(process.execPath, ['server.js'], { cwd: tmpDir, env });
    child.stdout.on('data', (d) => { childLog += d; });
    child.stderr.on('data', (d) => { childLog += d; });
    base = `http://127.0.0.1:${port}`;
    try {
      await waitForServer();
    } catch (e) {
      lastErr = e;
      base = null;
      if (child && child.exitCode === null) child.kill('SIGKILL');
      child = null;
    }
  }
  if (!base) throw lastErr || new Error('server failed to boot after 3 attempts');
});

test.after(() => {
  if (child && child.exitCode === null) child.kill('SIGKILL');
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('guest caller → 403 login_required', async () => {
  const g = await req('POST', '/api/guest/token', { body: {} });
  assert.equal(g.status, 200);
  const r = await req('POST', '/api/me/change-password', {
    body: { current_password: 'whatever123', new_password: 'BrandNewPass1' },
    guest: g.json.guest_token,
  });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'login_required');
});

test('wrong current password → 401 wrong_current and the password is unchanged', async () => {
  const l = await login('fandemo', 'fan123');
  assert.equal(l.status, 200, `fandemo login failed: ${l.text}`);
  const r = await changePw(l.json.token, 'not-the-password', 'BrandNewPass1');
  assert.equal(r.status, 401);
  assert.equal(r.json.error, 'wrong_current');
  const again = await login('fandemo', 'fan123');
  assert.equal(again.status, 200, 'password must be unchanged after a failed attempt');
});

test('seed-default new password → 400 default_password (case-insensitive)', async () => {
  const l = await login('fandemo', 'fan123');
  assert.equal(l.status, 200);
  for (const candidate of ['admin123', 'MODEL123', 'Fan123']) {
    const r = await changePw(l.json.token, 'fan123', candidate);
    assert.equal(r.status, 400, `expected 400 for ${candidate}: ${r.text}`);
    assert.equal(r.json.error, 'default_password', `expected default_password for ${candidate}`);
  }
  const still = await login('fandemo', 'fan123');
  assert.equal(still.status, 200, 'password must be unchanged after rejected attempts');
});

test('too-short new password → 400 weak_password', async () => {
  const l = await login('fandemo', 'fan123');
  assert.equal(l.status, 200);
  const r = await changePw(l.json.token, 'fan123', 'short9x!');
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'weak_password');
});

test('success: old password dies, new password works, other sessions revoked, caller survives', async () => {
  const a = await login('fandemo', 'fan123');
  const b = await login('fandemo', 'fan123');
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.notEqual(a.json.token, b.json.token);

  const NEW = 'Str0ng!Passw0rd';
  const r = await changePw(a.json.token, 'fan123', NEW);
  assert.equal(r.status, 200, `change failed: ${r.text}`);
  assert.equal(r.json.ok, true);

  // The other session is revoked…
  const other = await req('GET', '/api/me', { token: b.json.token });
  assert.equal(other.status, 401, 'the second session must be revoked');
  // …but the caller's own session survives.
  const mine = await req('GET', '/api/me', { token: a.json.token });
  assert.equal(mine.status, 200, 'the caller session must survive its own password change');

  // Old password can no longer log in; the new one can.
  const oldLogin = await login('fandemo', 'fan123');
  assert.equal(oldLogin.status, 401);
  assert.equal(oldLogin.json.error, 'bad_login');
  const newLogin = await login('fandemo', NEW);
  assert.equal(newLogin.status, 200);
});

test('new password equal to the current one → 400 weak_password', async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const s = await req('POST', '/api/auth/signup', {
    body: { username: 'pwfan' + suffix, password: 'First!Pass123', role: 'fan', display_name: 'PW Fan', dob: '1995-06-15', agree18: true },
  });
  assert.equal(s.status, 200, `signup failed: ${s.text}`);
  const r = await changePw(s.json.token, 'First!Pass123', 'First!Pass123');
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'weak_password');
  const still = await login('pwfan' + suffix, 'First!Pass123');
  assert.equal(still.status, 200);
});

test('source pins: Settings cards in app.js and manager.js post to the endpoint', () => {
  const app = fs.readFileSync(path.join(REPO, 'public/js/app.js'), 'utf8');
  assert.ok(app.includes('renderPwSettingsCard'), 'app.js must define renderPwSettingsCard');
  assert.ok(app.includes('id="pw-card"'), 'app.js views must host the pw-card next to the Face ID card');
  assert.ok(app.includes("api('/me/change-password'"), 'app.js card must call POST /api/me/change-password');
  assert.ok(app.includes('Current password is wrong'), 'app.js must surface the 401 as "Current password is wrong"');

  const mgr = fs.readFileSync(path.join(REPO, 'public/manager/manager.js'), 'utf8');
  assert.ok(mgr.includes('id="cpw-open"'), 'manager.js Settings must carry the Change password control');
  assert.ok(mgr.includes("api('/me/change-password'"), 'manager.js must call POST /api/me/change-password');
  assert.ok(mgr.includes("pwField('cpw-cur'"), 'manager.js form must reuse the pwField helper');

  const srv = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
  assert.ok(srv.includes("app.post('/api/me/change-password'"), 'server.js must route POST /api/me/change-password');
  assert.ok(srv.includes('DELETE FROM sessions WHERE user_id = ? AND token <> ?'),
    'password change must revoke every session except the caller\'s');
});
