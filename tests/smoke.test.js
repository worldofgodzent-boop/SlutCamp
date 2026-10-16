'use strict';
/*
 * Integration smoke test — boots the REAL server.js as a child process
 * and checks the key public flows over HTTP.
 *
 * Isolation (important): server.js chooses its data dir itself
 * (/data if it exists, else its own folder) and opens wogent-chat.db
 * there. So the server is never booted in the repo. Instead this test:
 *   1. copies server.js, package.json, lib/, public/ and data/ into a
 *      fresh OS temp dir,
 *   2. symlinks the repo's node_modules into the copy,
 *   3. boots the copy on a free local port with a scrubbed env (no
 *      CCBILL_*, no OPENAI_API_KEY, no CRYPTO_* — the dormant,
 *      pre-launch configuration),
 *   4. runs the HTTP checks against http://127.0.0.1:<port>,
 *   5. kills the child and deletes the temp dir, even on failure.
 * The seeded demo data (admin / models / fandemo) therefore exists only
 * inside the throwaway copy's DB. The repo's real DB is never touched.
 *
 * Prerequisite: `npm install` must have been run in the repo so
 * node_modules is complete (the copy symlinks it).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const REPO = path.join(__dirname, '..');

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

async function req(method, p, { body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = 'Bearer ' + token;
  const r = await fetch(base + p, {
    method,
    headers,
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
      const r = await fetch(base + '/api/credits/packages');
      if (r.status === 200) return;
    } catch (_) { /* not up yet */ }
    if (Date.now() - start > deadlineMs) {
      throw new Error(`server did not respond within ${deadlineMs}ms\n--- server log ---\n${childLog}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-smoke-'));
  for (const f of ['server.js', 'package.json']) {
    fs.copyFileSync(path.join(REPO, f), path.join(tmpDir, f));
  }
  for (const d of ['lib', 'public', 'data']) {
    fs.cpSync(path.join(REPO, d), path.join(tmpDir, d), { recursive: true });
  }
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(tmpDir, 'node_modules'), 'dir');

  // Scrubbed env: inherit the shell, then remove every integration key
  // so the child boots in the dormant pre-launch state.
  // Boot with up to 3 attempts, each on a FRESH port: freePort() closes
  // its probe socket before the child binds, so on a busy machine
  // another process can claim the port in between (EADDRINUSE). A retry
  // on a new port makes that race a non-event instead of a flaky file.
  let lastErr = null;
  for (let attempt = 1; attempt <= 3 && !base; attempt++) {
    const port = await freePort();
    // SEED_DEMO=1: this suite's fixtures ARE the demo accounts (bunny /
    // fandemo / admin). Seeding is opt-in since the pre-launch fake-money
    // cleanup, so the harness opts in explicitly — and the demo-seed purge
    // stays out of the way while the flag is set.
    const env = { ...process.env, PORT: String(port), CRYPTO_POLL_MS: '3600000', SEED_DEMO: '1' };
    for (const k of Object.keys(env)) {
      if (/^(CCBILL_|CRYPTO_|OPENAI_|TWILIO_|VAPID_)/.test(k)) delete env[k];
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
      // A failed boot may have created a partial DB in the temp copy;
      // wipe the data files so the retry seeds cleanly.
      for (const f of fs.readdirSync(tmpDir)) {
        if (/^wogent-chat\.db/.test(f)) fs.rmSync(path.join(tmpDir, f), { force: true });
      }
      fs.rmSync(path.join(tmpDir, 'uploads'), { recursive: true, force: true });
      fs.rmSync(path.join(tmpDir, 'private'), { recursive: true, force: true });
    }
  }
  if (!base) throw lastErr || new Error('server failed to boot after 3 attempts');
});

test.after(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((r) => child.once('exit', r)),
      new Promise((r) => setTimeout(r, 5000)),
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('homepage returns 200 HTML', async () => {
  const r = await req('GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') || '', /text\/html/);
  assert.match(r.text, /SlutCamp/);
});

test('/manager page loads', async () => {
  const r = await req('GET', '/manager/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') || '', /text\/html/);
  assert.match(r.text, /Slut Manager/);
});

test('GET /api/credits/packages returns the four stubbed packages', async () => {
  const r = await req('GET', '/api/credits/packages');
  assert.equal(r.status, 200);
  assert.equal(r.json.stubbed, true);
  assert.deepEqual(r.json.packages.map((p) => p.id), ['p10', 'p25', 'p50', 'p100']);
  assert.deepEqual(r.json.packages.map((p) => p.price_cents), [1000, 2500, 5000, 10000]);
  assert.deepEqual(r.json.packages.map((p) => p.credits_cents), [1000, 2500, 5000, 10000]);
});

test('guest token endpoint issues a 32-hex token', async () => {
  const r = await req('POST', '/api/guest/token', { body: {} });
  assert.equal(r.status, 200);
  assert.match(r.json.guest_token, /^[a-f0-9]{32}$/);
});

test('model directory is public and lists the seeded models on a fresh DB', async () => {
  const r = await req('GET', '/api/models');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.models));
  const names = r.json.models.map((m) => m.username);
  for (const expected of ['bunny', 'stacey', 'bella']) {
    assert.ok(names.includes(expected), `seeded model ${expected} should be listed`);
  }
});

test('signup -> login round-trip, and a wrong password is rejected', async () => {
  const username = 'smokefan' + Math.random().toString(36).slice(2, 8);
  const s = await req('POST', '/api/auth/signup', {
    body: { username, password: 'smoke-pass-1', role: 'fan', display_name: 'Smoke Fan', dob: '1995-06-15', agree18: true },
  });
  assert.equal(s.status, 200, `signup failed: ${s.text}`);
  assert.ok(typeof s.json.token === 'string' && s.json.token.length >= 16);
  assert.equal(s.json.user.username, username);
  assert.equal(s.json.user.role, 'fan');

  const l = await req('POST', '/api/auth/login', { body: { username, password: 'smoke-pass-1' } });
  assert.equal(l.status, 200);
  assert.ok(typeof l.json.token === 'string' && l.json.token.length >= 16);
  assert.equal(l.json.user.username, username);

  const bad = await req('POST', '/api/auth/login', { body: { username, password: 'smoke-pass-WRONG' } });
  assert.equal(bad.status, 401);
  assert.equal(bad.json.error, 'bad_login');
});

test('signup validation: under-18 DOB and duplicate username are refused', async () => {
  const kid = await req('POST', '/api/auth/signup', {
    body: { username: 'smokekid1', password: 'smoke-pass-1', role: 'fan', display_name: 'Kid', dob: '2020-01-01', agree18: true },
  });
  assert.equal(kid.status, 400);
  assert.equal(kid.json.error, 'must_be_18');

  // 'fandemo' is a seeded account on a fresh DB.
  const dupe = await req('POST', '/api/auth/signup', {
    body: { username: 'fandemo', password: 'smoke-pass-1', role: 'fan', display_name: 'Dupe', dob: '1995-06-15', agree18: true },
  });
  assert.equal(dupe.status, 409);
  assert.equal(dupe.json.error, 'username_taken');
});

test('POST /api/credits/buy: 501 payment_not_connected for a logged-in fan; 401 when logged out', async () => {
  const l = await req('POST', '/api/auth/login', { body: { username: 'fandemo', password: 'fan123' } });
  assert.equal(l.status, 200, `seeded fan login failed: ${l.text}`);

  const buy = await req('POST', '/api/credits/buy', { body: { package: 'p25' }, token: l.json.token });
  assert.equal(buy.status, 501);
  assert.equal(buy.json.error, 'payment_not_connected');

  const anon = await req('POST', '/api/credits/buy', { body: { package: 'p25' } });
  assert.equal(anon.status, 401);

  const badPkg = await req('POST', '/api/credits/buy', { body: { package: 'p999' }, token: l.json.token });
  assert.equal(badPkg.status, 400);
  assert.equal(badPkg.json.error, 'bad_package');
});

test('health endpoint reports ok', async () => {
  const r = await req('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
});

test('unknown API routes return 404', async () => {
  const api = await req('GET', '/api/definitely-not-a-route');
  assert.equal(api.status, 404);
});

test('unknown page routes serve the app shell (SPA fallback, server.js catch-all)', async () => {
  // Deliberate behavior: the client is hash-routed, so every non-API GET
  // returns public/index.html with 200 (app.get(/^\/(?!api\/).*/) in
  // server.js). Only /api/* unknowns 404.
  const page = await req('GET', '/no-such-page-xyz');
  assert.equal(page.status, 200);
  assert.match(page.text, /SlutCamp/);
});
