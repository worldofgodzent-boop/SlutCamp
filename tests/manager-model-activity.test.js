'use strict';
/*
 * Manager Models LAST LOGIN (Asce, Oct 24 2026): "a tab with the
 * models that shows the last time they logged in — need to know
 * who's active." The Models tab now shows, on every model card,
 * when she last logged in, and can sort most-recent-login first.
 *
 * THE FEATURE pinned here:
 *  - GET /api/admin/models carries `last_login_at` per model from
 *    the SAME source of truth as the Fans tab (PR #84): the
 *    MAX(created_at) of the model's rows in the `sessions` table,
 *    via ONE grouped LEFT JOIN. NULL when she has never logged in
 *    since tracking began — the card renders "Never", never a
 *    fabricated time. Default order stays display_name; the
 *    ?sort=recent variant orders most recent login first
 *    (never-logged-in last, name breaks ties).
 *  - Each model card renders a "🕐 Last login: <relative>" line
 *    ("3h ago", "2d ago", "Never") with the exact moment beside it.
 *  - HONESTY RULE (same as Fans): it is the LOGIN moment only — a
 *    persistent session does not refresh it — so the line must
 *    never say "last active / seen / activity".
 *  - Fan last-login behavior (PR #84) is pinned unchanged.
 * Manager is English-only — no STR ×13 work.
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

test('pins: /api/admin/models derives last_login_at from sessions, same source as Fans', () => {
  const ep = serverSrc.slice(serverSrc.indexOf("app.get('/api/admin/models'"),
    serverSrc.indexOf("app.get('/api/admin/models/:id/thread'"));
  assert.ok(ep.includes('MAX(created_at) AS last_login_at'),
    'last_login_at = MAX(session created_at)');
  assert.ok(ep.includes('FROM sessions GROUP BY user_id'),
    'sessions grouped per user in a subquery');
  assert.ok(ep.includes('LEFT JOIN'), 'models without sessions still list (NULL last_login_at)');
  assert.ok(ep.includes('s.last_login_at'), 'the joined value is selected onto the model row');
  assert.ok(ep.includes('u.display_name'), 'default display_name ordering is retained');
  assert.ok(ep.includes("req.query.sort") && ep.includes('s.last_login_at DESC'),
    '?sort=recent orders by most recent login first');
});

test('pins: Fans last-login endpoint is unchanged (PR #84 behavior intact)', () => {
  const ep = serverSrc.slice(serverSrc.indexOf("app.get('/api/admin/fans'"),
    serverSrc.indexOf("app.post('/api/admin/fans/:id/ban'"));
  assert.ok(ep.includes('MAX(created_at) AS last_login_at'),
    'fans still derive last_login_at from sessions');
  assert.ok(ep.includes('s.last_login_at'), 'fans still select the joined value');
  assert.ok(managerSrc.includes('function fanLastLoginText('), 'fan helper still exists');
});

test('pins: model card renders the Last login line + recent-login sort control', () => {
  const body = managerSrc.slice(managerSrc.indexOf('async function adminModelsBody()'),
    managerSrc.indexOf('async function adminInvitesBody()'));
  assert.ok(body.includes('data-model-login="${m.id}"'), 'the line lives inside the model card');
  assert.ok(body.includes('modelLastLoginLine(m)'), 'card renders via the line helper');
  assert.ok(body.includes('data-m-sort="recent"') && body.includes('Most recent login'),
    'sort control offers Most recent login');
  assert.ok(body.includes('data-m-sort="name"'), 'sort control offers the A–Z default');
  assert.ok(!/Last (active|seen|activity)/.test(body),
    'never worded as last activity — it is the login moment only');

  const helper = managerSrc.slice(managerSrc.indexOf('function modelLastLoginText('),
    managerSrc.indexOf('/* ---------------- state + API'));
  assert.ok(helper.includes("return 'Never'"), 'no login on record reads "Never"');
});

/* ---------------- behavior: the relative-time helper ---------------- */

function loadHelpers() {
  const src = managerSrc.slice(managerSrc.indexOf('function timeHM('),
    managerSrc.indexOf('/* ---------------- state + API'));
  return new Function(`${src}\nreturn { fmtDT, modelLastLoginText };`)();
}

test('behavior: modelLastLoginText renders relative time, "Never" when there is none', () => {
  const { fmtDT, modelLastLoginText } = loadHelpers();
  const now = Date.UTC(2026, 9, 24, 12, 0, 0); // Oct 24 2026, 12:00 UTC

  assert.equal(modelLastLoginText({ last_login_at: null }, now), 'Never');
  assert.equal(modelLastLoginText({ last_login_at: '' }, now), 'Never');
  assert.equal(modelLastLoginText({}, now), 'Never', 'a row missing the field still reads Never');

  assert.equal(modelLastLoginText({ last_login_at: '2026-10-24 11:59:30' }, now), 'just now');
  assert.equal(modelLastLoginText({ last_login_at: '2026-10-24 11:55:00' }, now), '5m ago');
  assert.equal(modelLastLoginText({ last_login_at: '2026-10-24 09:00:00' }, now), '3h ago');
  assert.equal(modelLastLoginText({ last_login_at: '2026-10-22 12:00:00' }, now), '2d ago');
  assert.equal(modelLastLoginText({ last_login_at: '2026-08-20 12:00:00' }, now),
    fmtDT('2026-08-20 12:00:00'), 'a month or older falls back to the exact date');
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-modelactivity-'));
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

test('live: /admin/models reports last login, sorts recent-first on request, admin-only', { timeout: 120000 }, async (t) => {
  const dir = makeCopy();
  const h = await boot(dir, { SEED_DEMO: '1' });
  t.after(() => stop(h));
  const { base } = h;

  // The served Manager asset carries the sort control + line helper.
  const js = await req(base, 'GET', '/manager/manager.js');
  assert.equal(js.status, 200);
  assert.ok(js.text.includes('Most recent login'), 'served manager.js has the sort control');
  assert.ok(js.text.includes('function modelLastLoginText('), 'served manager.js has the helper');
  assert.ok(js.text.includes('Last login:'), 'served manager.js renders Last login');

  const adm = await req(base, 'POST', '/api/manager/login', { body: { username: 'admin', password: 'admin123' } });
  assert.equal(adm.status, 200, `manager login: ${adm.text}`);
  const atok = adm.json.token;

  const mkModel = async (username, display_name) => {
    const r = await req(base, 'POST', '/api/auth/signup', {
      body: { username, password: 'model-activity-pass', role: 'model', publicity_consent: true,
              display_name, dob: '1995-05-05', agree18: true, section: 'female' },
    });
    assert.equal(r.status, 200, `signup ${username}: ${r.text}`);
    return r.json.user.id;
  };
  // Names chosen so A–Z order is the OPPOSITE of recent-login order.
  const zeta = await mkModel('zetalogin', 'Zeta Activity');
  const alpha = await mkModel('alphanever', 'Alpha Activity');

  // Deterministic history: signup sessions wiped; Zeta gets exactly
  // two logins at fixed moments, Alpha gets none.
  withDb(dir, (db) => {
    db.prepare('DELETE FROM sessions WHERE user_id IN (?, ?)').run(zeta, alpha);
    const ins = db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)');
    ins.run('b'.repeat(63) + '1', zeta, '2026-10-01 08:15:00');
    ins.run('b'.repeat(63) + '2', zeta, '2026-10-20 09:41:00');
  });

  const list1 = await req(base, 'GET', '/api/admin/models', { token: atok, mgr: true });
  assert.equal(list1.status, 200, `models list: ${list1.text}`);
  const models1 = list1.json.models || [];
  for (const m of models1) {
    assert.ok(Object.prototype.hasOwnProperty.call(m, 'last_login_at'),
      `every model row carries last_login_at (${m.username})`);
  }
  const z1 = models1.find((m) => m.id === zeta);
  const a1 = models1.find((m) => m.id === alpha);
  assert.ok(z1 && a1, 'both models listed');
  assert.equal(z1.last_login_at, '2026-10-20 09:41:00',
    'the LATER of the two sessions is the last login');
  assert.equal(a1.last_login_at, null, 'no sessions -> null (renders "Never")');
  assert.ok(models1.indexOf(a1) < models1.indexOf(z1),
    'default order stays A–Z by display name (Alpha before Zeta)');

  const recent = await req(base, 'GET', '/api/admin/models?sort=recent', { token: atok, mgr: true });
  assert.equal(recent.status, 200, `recent list: ${recent.text}`);
  const modelsR = recent.json.models || [];
  const zR = modelsR.find((m) => m.id === zeta);
  const aR = modelsR.find((m) => m.id === alpha);
  assert.ok(modelsR.indexOf(zR) < modelsR.indexOf(aR),
    '?sort=recent puts the recent login (Zeta) ahead of never-logged-in (Alpha)');

  // A real password login creates a session and the field follows it.
  const login = await req(base, 'POST', '/api/auth/login',
    { body: { username: 'alphanever', password: 'model-activity-pass' } });
  assert.equal(login.status, 200, `alpha login: ${login.text}`);
  const list2 = await req(base, 'GET', '/api/admin/models', { token: atok, mgr: true });
  const a2 = (list2.json.models || []).find((m) => m.id === alpha);
  assert.match(a2.last_login_at || '', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
    'after a real login, last_login_at is that login timestamp');
  assert.ok(a2.last_login_at > '2026-10-20 09:41:00',
    'the fresh login is now the most recent of the two');

  // Admin-only: a fan session and an anonymous caller are refused.
  await req(base, 'POST', '/api/auth/signup', {
    body: { username: 'activityfan', password: 'model-activity-pass', role: 'fan',
            display_name: 'Activity Fan', dob: '1995-05-05', agree18: true },
  });
  const fanLogin = await req(base, 'POST', '/api/auth/login',
    { body: { username: 'activityfan', password: 'model-activity-pass' } });
  assert.equal(fanLogin.status, 200, `fan login: ${fanLogin.text}`);
  const asFan = await req(base, 'GET', '/api/admin/models', { token: fanLogin.json.token });
  assert.equal(asFan.status, 403, `fan token refused: ${asFan.status}`);
  const anon = await req(base, 'GET', '/api/admin/models', {});
  assert.ok(anon.status === 401 || anon.status === 403,
    `anonymous refused: ${anon.status}`);
});
