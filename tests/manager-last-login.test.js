'use strict';
/*
 * Manager Fans LAST LOGIN (owner, Oct 21 2026): Asce wants to see,
 * right on the Manager Fans tab, when a fan account last logged in —
 * above all the CCBill review account, so he can tell whether the
 * reviewers have been inside the app yet.
 *
 * THE FEATURE pinned here:
 *  - GET /api/admin/fans carries `last_login_at` per fan: the
 *    MAX(created_at) of the fan's rows in the `sessions` table, via
 *    ONE grouped LEFT JOIN (no per-fan queries). A session row is
 *    created at login — password or passkey (createSession) — and
 *    nothing else creates one. NULL when the fan has never logged in.
 *  - Each Fans card renders a "Last login: <date · time>" line, or
 *    "Last login: never" for a NULL.
 *  - HONESTY RULE: the label is exactly "Last login". A session row
 *    marks the LOGIN moment only — a persistent session does not
 *    refresh it — so the card must never say "last active / seen /
 *    activity" or anything that implies otherwise.
 * Manager is English-only — no STR ×13 work. No announcement ships
 * with this build (notification-thread-tap pin untouched). The PR #76
 * search bar and the per-fan actions are untouched by this change.
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
const serverSrc = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
const managerSrc = fs.readFileSync(path.join(REPO, 'public/manager/manager.js'), 'utf8');

/* ---------------- static pins ---------------- */

test('pins: /api/admin/fans derives last_login_at from sessions in one grouped join', () => {
  const ep = serverSrc.slice(serverSrc.indexOf("app.get('/api/admin/fans'"),
    serverSrc.indexOf("app.post('/api/admin/fans/:id/ban'"));
  assert.ok(ep.includes('MAX(created_at) AS last_login_at'),
    'last_login_at = MAX(session created_at)');
  assert.ok(ep.includes('FROM sessions GROUP BY user_id'),
    'sessions grouped per user in a subquery');
  assert.ok(ep.includes('LEFT JOIN'), 'fans without sessions still list (NULL last_login_at)');
  assert.ok(ep.includes('s.last_login_at'), 'the joined value is selected onto the fan row');
});

test('pins: Fans card renders the Last login line; label never implies activity', () => {
  const body = managerSrc.slice(managerSrc.indexOf('async function adminFansBody()'),
    managerSrc.indexOf('async function adminContractsBody()'));
  assert.ok(body.includes('Last login: ${esc(fanLastLoginText(f))}'),
    'card renders the Last login line from the row field');
  assert.ok(body.includes('data-fan-card="${f.id}"'), 'line lives inside the fan card');
  assert.ok(!/Last (active|seen|activity)/.test(body),
    'never worded as last activity — it is the login moment only');

  const helper = managerSrc.slice(managerSrc.indexOf('function fanLastLoginText('),
    managerSrc.indexOf('/* ---------------- state + API'));
  assert.ok(helper.includes("f.last_login_at ? fmtDT(f.last_login_at) : 'never'"),
    'helper formats the timestamp, falls back to "never"');
});

/* ---------------- behavior: the format helper ---------------- */

function loadHelpers() {
  const src = managerSrc.slice(managerSrc.indexOf('function timeHM('),
    managerSrc.indexOf('/* ---------------- state + API'));
  return new Function(`${src}\nreturn { fmtDT, fanLastLoginText };`)();
}

test('behavior: fanLastLoginText formats a login moment, "never" when there is none', () => {
  const { fmtDT, fanLastLoginText } = loadHelpers();

  const at = '2026-10-20 09:41:00';
  const out = fanLastLoginText({ last_login_at: at });
  assert.equal(out, fmtDT(at), 'a real timestamp renders through the shared Manager formatter');
  assert.match(out, /^[A-Z][a-z]{2} \d{1,2} · \d{1,2}:\d{2} [AP]M$/,
    'shape is "Mon D · H:MM AM" (e.g. Oct 21 · 9:41 AM)');

  assert.equal(fanLastLoginText({ last_login_at: null }), 'never');
  assert.equal(fanLastLoginText({ last_login_at: '' }), 'never');
  assert.equal(fanLastLoginText({}), 'never', 'a row missing the field still reads never');
});

/* ---------------- live: endpoint values end to end ---------------- */

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

function makeCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-lastlogin-'));
  for (const d of ['server.js', 'package.json', 'lib', 'public', 'data']) {
    fs.cpSync(path.join(REPO, d), path.join(dir, d), { recursive: true });
  }
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  return dir;
}

async function boot(dir, extraEnv) {
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

async function req(base, method, p, { body, token, mgr } = {}) {
  const h = {};
  let payload;
  if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  if (token) h.authorization = 'Bearer ' + token;
  if (mgr) h['x-manager'] = '1';
  const r = await fetch(base + p, { method, headers: h, body: payload });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not json */ }
  return { status: r.status, json, text };
}

function withDb(dir, fn) {
  const db = new DatabaseSync(path.join(dir, 'wogent-chat.db'));
  db.exec('PRAGMA busy_timeout = 10000');
  try { return fn(db); } finally { db.close(); }
}

test('live: /admin/fans reports the later session as last_login_at, null for never-logged-in', { timeout: 120000 }, async (t) => {
  const dir = makeCopy();
  const h = await boot(dir, { SEED_DEMO: '1' });
  t.after(() => stop(h));
  const { base } = h;

  // The served Manager asset carries the Last login line.
  const js = await req(base, 'GET', '/manager/manager.js');
  assert.equal(js.status, 200);
  assert.ok(js.text.includes('Last login:'), 'served manager.js renders Last login');
  assert.ok(js.text.includes('function fanLastLoginText('), 'served manager.js has the helper');

  const adm = await req(base, 'POST', '/api/manager/login', { body: { username: 'admin', password: 'admin123' } });
  assert.equal(adm.status, 200, `manager login: ${adm.text}`);
  const atok = adm.json.token;

  const mkFan = async (username, display_name) => {
    const r = await req(base, 'POST', '/api/auth/signup', {
      body: { username, password: 'last-login-pass', role: 'fan',
              display_name, dob: '1995-05-05', agree18: true },
    });
    assert.equal(r.status, 200, `signup ${username}: ${r.text}`);
    return r.json.user.id;
  };
  const fanA = await mkFan('loginfan', 'Login Fan');
  const fanB = await mkFan('neverfan', 'Never Fan');

  // Deterministic session history: signup's own session rows are
  // wiped, then fan A gets exactly two logins at fixed moments and
  // fan B gets none.
  withDb(dir, (db) => {
    db.prepare('DELETE FROM sessions WHERE user_id IN (?, ?)').run(fanA, fanB);
    const ins = db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)');
    ins.run('a'.repeat(63) + '1', fanA, '2026-10-01 08:15:00');
    ins.run('a'.repeat(63) + '2', fanA, '2026-10-20 09:41:00');
  });

  const list1 = await req(base, 'GET', '/api/admin/fans', { token: atok, mgr: true });
  assert.equal(list1.status, 200, `fans list: ${list1.text}`);
  const fans1 = list1.json.fans || [];
  for (const f of fans1) {
    assert.ok(Object.prototype.hasOwnProperty.call(f, 'last_login_at'),
      `every fan row carries last_login_at (${f.username})`);
  }
  const a1 = fans1.find((f) => f.id === fanA);
  const b1 = fans1.find((f) => f.id === fanB);
  assert.ok(a1 && b1, 'both fans listed');
  assert.equal(a1.last_login_at, '2026-10-20 09:41:00',
    'the LATER of the two sessions is the last login');
  assert.equal(b1.last_login_at, null, 'no sessions -> null (renders "never")');

  // A real password login creates a session and the field follows it.
  const login = await req(base, 'POST', '/api/auth/login',
    { body: { username: 'neverfan', password: 'last-login-pass' } });
  assert.equal(login.status, 200, `fan B login: ${login.text}`);
  const list2 = await req(base, 'GET', '/api/admin/fans', { token: atok, mgr: true });
  const b2 = (list2.json.fans || []).find((f) => f.id === fanB);
  assert.match(b2.last_login_at || '', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
    'after a real login, last_login_at is that login timestamp');
});
