'use strict';
/*
 * Manager "Last active" tracking (Assignment 05, Ms. Pink, Oct 26 2026):
 * Manager Fans/Models rows showed "Last login" = MAX(sessions.created_at).
 * A credential login creates a session row, but a returning user on a
 * still-open session creates NOTHING, so the time never moved — the
 * CCBill review account acted Oct 26 · 2:17 PM while its "Last login"
 * still showed 2:20 AM. Asce: the right time must be reflected
 * whenever someone logs in, even on the same session.
 *
 * THE FEATURE pinned here:
 *  - Migration: addColumnIfMissing('sessions', 'last_seen_at', 'TEXT').
 *  - Touch: in getIdentity(req), when a Bearer token resolves to a
 *    user id, a throttled update sets last_seen_at = datetime('now')
 *    where the row's last_seen_at is NULL or at most now minus
 *    60 seconds, wrapped in try/catch so it can NEVER break auth.
 *    Guests have no session row and are untouched.
 *  - GET /api/admin/fans and GET /api/admin/models extend their
 *    sessions subquery with MAX(COALESCE(last_seen_at, created_at))
 *    AS last_active_at and select it onto the row. The
 *    last_login_at derivation stays EXACTLY as-is.
 *  - Manager UI: the fan card gains a "Last active: <date>" line
 *    directly under its Last login line, same absolute format,
 *    'never' when null. Model rows gain the same line in the
 *    models' existing last-login style. Labels stay exact and
 *    separate: "Last login" = credential login only; "Last active"
 *    = latest presence. The two meanings are never merged.
 * Manager is English-only — no STR x13 work.
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

test('pins: migration adds sessions.last_seen_at', () => {
  assert.ok(serverSrc.includes("addColumnIfMissing('sessions', 'last_seen_at', 'TEXT')"),
    'migration line present with the other addColumnIfMissing calls');
});

test('pins: getIdentity touches last_seen_at, throttled, never breaking auth', () => {
  const fn = serverSrc.slice(serverSrc.indexOf('function getIdentity(req) {'),
    serverSrc.indexOf('const subjectKey'));
  assert.ok(fn.includes('UPDATE sessions SET last_seen_at'),
    'touch updates the session row');
  assert.ok(fn.includes('WHERE token = ?'), 'touch targets the bearer token row');
  assert.ok(fn.includes("-60 seconds"), 'touch is throttled to once a minute');
  assert.ok(fn.includes('last_seen_at IS NULL'), 'a never-touched row is touched');
  assert.ok(/try\s*\{/.test(fn) && /catch/.test(fn),
    'touch is wrapped so it can never break auth');
  assert.ok(!fn.includes('x-guest-token') || fn.indexOf('UPDATE sessions') < fn.indexOf('x-guest-token'),
    'the touch lives in the Bearer branch, not the guest branch');
});

test('pins: /api/admin/fans selects last_active_at, last_login_at untouched', () => {
  const ep = serverSrc.slice(serverSrc.indexOf("app.get('/api/admin/fans'"),
    serverSrc.indexOf("app.post('/api/admin/fans/:id/ban'"));
  assert.ok(ep.includes('MAX(created_at) AS last_login_at'),
    'last_login_at derivation unchanged');
  assert.ok(ep.includes('MAX(COALESCE(last_seen_at, created_at)) AS last_active_at'),
    'last_active_at = MAX(COALESCE(last_seen_at, created_at))');
  assert.ok(ep.includes('s.last_active_at'), 'the joined value is selected onto the fan row');
  assert.ok(ep.includes('s.last_login_at'), 'last_login_at is still selected');
});

test('pins: /api/admin/models selects last_active_at, last_login_at untouched', () => {
  const ep = serverSrc.slice(serverSrc.indexOf("app.get('/api/admin/models'"),
    serverSrc.indexOf("app.get('/api/admin/models/:id/thread'"));
  assert.ok(ep.includes('MAX(created_at) AS last_login_at'),
    'last_login_at derivation unchanged');
  assert.ok(ep.includes('MAX(COALESCE(last_seen_at, created_at)) AS last_active_at'),
    'last_active_at = MAX(COALESCE(last_seen_at, created_at))');
  assert.ok(ep.includes('s.last_active_at'), 'the joined value is selected onto the model row');
  assert.ok(ep.includes('s.last_login_at'), 'last_login_at is still selected');
});

test('pins: Manager renders Last active on Fans and Models cards, separate from Last login', () => {
  const fansBody = managerSrc.slice(managerSrc.indexOf('async function adminFansBody()'),
    managerSrc.indexOf('async function adminContractsBody()'));
  assert.ok(fansBody.includes('Last login: ${esc(fanLastLoginText(f))}'),
    'fan card still renders the Last login line');
  assert.ok(fansBody.includes('Last active: ${esc(fanLastActiveText(f))}'),
    'fan card gains a Last active line directly under Last login');
  assert.ok(fansBody.indexOf('Last active:') > fansBody.indexOf('Last login:'),
    'Last active follows Last login on the fan card');

  const modelsBody = managerSrc.slice(managerSrc.indexOf('async function adminModelsBody()'),
    managerSrc.indexOf('async function adminInvitesBody()'));
  assert.ok(modelsBody.includes('modelLastLoginLine(m)'),
    'model card still renders the Last login line');
  assert.ok(modelsBody.includes('modelLastActiveLine(m)'),
    'model card gains a Last active line');
  assert.ok(modelsBody.indexOf('modelLastActiveLine(m)') > modelsBody.indexOf('modelLastLoginLine(m)'),
    'Last active follows Last login on the model card');
  assert.ok(modelsBody.includes('data-model-active="${m.id}"'),
    'model active line lives inside the model card');

  assert.ok(managerSrc.includes('function fanLastActiveText('), 'fan active helper exists');
  assert.ok(managerSrc.includes('function modelLastActiveLine('), 'model active line helper exists');
});

/* ---------------- behavior: the format helpers ---------------- */

function loadHelpers() {
  const src = managerSrc.slice(managerSrc.indexOf('function timeHM('),
    managerSrc.indexOf('/* ---------------- state + API'));
  return new Function(`${src}\nreturn { fmtDT, fanLastActiveText, modelLastActiveText };`)();
}

test('behavior: fanLastActiveText formats presence, "never" when there is none', () => {
  const { fmtDT, fanLastActiveText } = loadHelpers();
  const at = '2026-10-26 14:17:00';
  assert.equal(fanLastActiveText({ last_active_at: at }), fmtDT(at),
    'a real timestamp renders through the shared Manager formatter');
  assert.equal(fanLastActiveText({ last_active_at: null }), 'never');
  assert.equal(fanLastActiveText({ last_active_at: '' }), 'never');
  assert.equal(fanLastActiveText({}), 'never', 'a row missing the field still reads never');
});

test('behavior: modelLastActiveText mirrors the model relative style, "Never" when none', () => {
  const { fmtDT, modelLastActiveText } = loadHelpers();
  const now = Date.UTC(2026, 9, 26, 15, 0, 0); // Oct 26 2026, 15:00 UTC
  assert.equal(modelLastActiveText({ last_active_at: null }, now), 'Never');
  assert.equal(modelLastActiveText({ last_active_at: '' }, now), 'Never');
  assert.equal(modelLastActiveText({}, now), 'Never');
  assert.equal(modelLastActiveText({ last_active_at: '2026-10-26 14:55:00' }, now), '5m ago');
  assert.equal(modelLastActiveText({ last_active_at: '2026-10-26 12:00:00' }, now), '3h ago');
  assert.equal(modelLastActiveText({ last_active_at: '2026-08-20 12:00:00' }, now),
    fmtDT('2026-08-20 12:00:00'), 'a month or older falls back to the exact date');
});

/* ---------------- live: end to end ---------------- */

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-lastactive-'));
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
  const deadline = Date.now() + 20000;
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

test('live: last_active follows presence while last_login stays a login moment', { timeout: 120000 }, async (t) => {
  const dir = makeCopy();
  const h = await boot(dir, { SEED_DEMO: '1' });
  t.after(() => stop(h));
  const { base } = h;

  // The served Manager asset carries both lines.
  const js = await req(base, 'GET', '/manager/manager.js');
  assert.equal(js.status, 200);
  assert.ok(js.text.includes('Last login:'), 'served manager.js renders Last login');
  assert.ok(js.text.includes('Last active:'), 'served manager.js renders Last active');

  const adm = await req(base, 'POST', '/api/manager/login', { body: { username: 'admin', password: 'admin123' } });
  assert.equal(adm.status, 200, `manager login: ${adm.text}`);
  const atok = adm.json.token;

  const signup = await req(base, 'POST', '/api/auth/signup', {
    body: { username: 'activefan', password: 'last-active-pass', role: 'fan',
            display_name: 'Active Fan', dob: '1995-05-05', agree18: true },
  });
  assert.equal(signup.status, 200, `signup: ${signup.text}`);
  const fanId = signup.json.user.id;

  // A real login: last_login and last_active start together.
  const login1 = await req(base, 'POST', '/api/auth/login',
    { body: { username: 'activefan', password: 'last-active-pass' } });
  assert.equal(login1.status, 200, `fan login: ${login1.text}`);
  const ftok = login1.json.token;
  const list0 = await req(base, 'GET', '/api/admin/fans', { token: atok, mgr: true });
  const row0 = (list0.json.fans || []).find((f) => f.id === fanId);
  assert.ok(row0, 'fan listed');
  assert.ok(row0.last_login_at, 'login moment recorded');
  assert.equal(row0.last_active_at, row0.last_login_at,
    'right after login, last_active equals last_login (no touch yet beyond login)');

  // Age the session in the DB: created_at old, last_seen_at NULL.
  // The COALESCE fallback must then report the old moment for both.
  // The signup session is wiped first, or its ~now created_at would
  // still be the MAX and hide the aged row (same pattern as the
  // Last login live test).
  withDb(dir, (db) => {
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?').run(fanId, ftok);
    db.prepare("UPDATE sessions SET created_at = '2026-01-05 08:00:00', last_seen_at = NULL WHERE token = ?").run(ftok);
  });
  const list1 = await req(base, 'GET', '/api/admin/fans', { token: atok, mgr: true });
  const row1 = (list1.json.fans || []).find((f) => f.id === fanId);
  assert.equal(row1.last_login_at, '2026-01-05 08:00:00', 'aged session is the last login');
  assert.equal(row1.last_active_at, '2026-01-05 08:00:00',
    'with last_seen_at NULL, last_active falls back to created_at');

  // One authenticated request on the still-open session: presence
  // jumps to ~now, the login moment does not move.
  const me = await req(base, 'GET', '/api/me', { token: ftok });
  assert.equal(me.status, 200, `authenticated request: ${me.text}`);
  const list2 = await req(base, 'GET', '/api/admin/fans', { token: atok, mgr: true });
  const row2 = (list2.json.fans || []).find((f) => f.id === fanId);
  assert.equal(row2.last_login_at, '2026-01-05 08:00:00',
    'presence does not rewrite the login moment');
  assert.ok(row2.last_active_at && row2.last_active_at > '2026-01-05 08:00:00',
    'last_active jumps to ~now after an authenticated request');
  assert.match(row2.last_active_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
    'last_active is a full timestamp');

  // A second immediate authenticated request is throttled: the
  // stored last_seen_at must not move again within the minute.
  const me2 = await req(base, 'GET', '/api/me', { token: ftok });
  assert.equal(me2.status, 200);
  const list3 = await req(base, 'GET', '/api/admin/fans', { token: atok, mgr: true });
  const row3 = (list3.json.fans || []).find((f) => f.id === fanId);
  assert.equal(row3.last_active_at, row2.last_active_at,
    'a second request inside the throttle window does not re-touch');

  // Logging in again creates a fresh session and moves last_login.
  const login2 = await req(base, 'POST', '/api/auth/login',
    { body: { username: 'activefan', password: 'last-active-pass' } });
  assert.equal(login2.status, 200, `second login: ${login2.text}`);
  const list4 = await req(base, 'GET', '/api/admin/fans', { token: atok, mgr: true });
  const row4 = (list4.json.fans || []).find((f) => f.id === fanId);
  assert.ok(row4.last_login_at > '2026-01-05 08:00:00',
    'a new login updates last_login');
  assert.ok(row4.last_active_at, 'last_active still present after a new login');

  // Models endpoint carries the same field on every row it returns.
  const models = await req(base, 'GET', '/api/admin/models', { token: atok, mgr: true });
  assert.equal(models.status, 200, `models list: ${models.text}`);
  for (const m of (models.json.models || [])) {
    assert.ok(Object.prototype.hasOwnProperty.call(m, 'last_active_at'),
      `every model row carries last_active_at (${m.username})`);
    assert.ok(Object.prototype.hasOwnProperty.call(m, 'last_login_at'),
      `every model row still carries last_login_at (${m.username})`);
  }
});
