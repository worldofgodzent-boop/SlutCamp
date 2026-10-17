'use strict';
/*
 * Fan Suggestion Box (owner request, Oct 17 2026: "we should have a
 * suggestion box for the fans, just in case they want something on
 * the app that we haven't added").
 *
 *  - Announcement: ONE-TIME bell + Web Push to every fan, stamped
 *    suggestion_box_announced_at (set BEFORE sending), copy via the
 *    SRV table in each fan's stored language. No DM (fan channel rule).
 *  - POST /api/suggestions: any logged-in user; non-empty after trim,
 *    ≤1000 chars, max 5 per user per rolling 24h; username snapshot
 *    stored; every admin gets a 'suggestion_admin' bell whose body is
 *    the suggestion truncated to ~120 chars.
 *  - Manager: GET /api/admin/suggestions (newest first, limit 100) +
 *    POST /api/admin/suggestions/:id/status with validation.
 *  - Digest: GET /api/internal/suggestions-digest — x-digest-token
 *    header ONLY, against SUGGEST_DIGEST_TOKEN; 503 when unset, 401
 *    on a bad token; returns status='new' rows, read-only.
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
const appSrc = fs.readFileSync(path.join(REPO, 'public/js/app.js'), 'utf8');
const managerSrc = fs.readFileSync(path.join(REPO, 'public/manager/manager.js'), 'utf8');

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-suggest-'));
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
  if (!('SUGGEST_DIGEST_TOKEN' in extraEnv)) delete env.SUGGEST_DIGEST_TOKEN;
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

function readDb(dir) {
  return new DatabaseSync(path.join(dir, 'wogent-chat.db'), { readOnly: true });
}

async function req(base, method, p, { body, token, headers } = {}) {
  const h = { ...(headers || {}) };
  let payload;
  if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  if (token) h.authorization = 'Bearer ' + token;
  const r = await fetch(base + p, { method, headers: h, body: payload });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not json */ }
  return { status: r.status, json, text };
}

async function signup(base, username) {
  const s = await req(base, 'POST', '/api/auth/signup', {
    body: { username, password: `${username}-pass-123`, role: 'fan',
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

/* ---------------- announcement ---------------- */

test('announcement: fans belled once in their language, stamp set, no re-send, no DM', async () => {
  const dir = makeCopy();
  try {
    const h1 = await boot(dir, { SEED_DEMO: '1' });
    stop(h1);
    let db = readDb(dir);
    const stamp = db.prepare('SELECT suggestion_box_announced_at FROM platform_stats WHERE id = 1').get();
    assert.ok(stamp && stamp.suggestion_box_announced_at, 'suggestion box stamp set after first boot');
    const fans = db.prepare("SELECT id, username FROM users WHERE role = 'fan'").all();
    assert.ok(fans.length >= 1, 'seed fan exists');
    const bellCount = (uid) => db.prepare(
      "SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND type = 'suggestion_box'").get(uid).c;
    for (const f of fans) {
      assert.equal(bellCount(f.id), 1, `${f.username} got exactly one suggestion_box bell`);
      const bell = db.prepare(
        "SELECT title, body, link FROM notifications WHERE user_id = ? AND type = 'suggestion_box'").get(f.id);
      assert.equal(bell.title, '💡 NEW: The Suggestion Box is open!');
      assert.ok(bell.body.includes('Suggestion Box'), 'announcement body present');
      assert.ok(!bell.link, 'announcement bell carries no thread link (no fan DM)');
    }
    for (const role of ['model', 'admin']) {
      const rows = db.prepare('SELECT id FROM users WHERE role = ?').all(role);
      for (const u of rows) assert.equal(bellCount(u.id), 0, `${role} got no fan announcement`);
    }
    db.close();

    const h2 = await boot(dir, { SEED_DEMO: '1' });
    stop(h2);
    db = readDb(dir);
    for (const f of fans) assert.equal(bellCount(f.id), 1, `${f.username} not re-belled on second boot`);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------- submissions ---------------- */

test('submissions: auth, validation, storage with username snapshot, admin bell, rate limit', async () => {
  const dir = makeCopy();
  const h = await boot(dir, { SEED_DEMO: '1' });
  try {
    const fanA = await signup(h.base, 'sugfan_a');
    const post = (token, body) => req(h.base, 'POST', '/api/suggestions', { token, body });

    // Unauthenticated → 401.
    const anon = await req(h.base, 'POST', '/api/suggestions', { body: { text: 'hello' } });
    assert.equal(anon.status, 401, 'anonymous submission rejected');

    // Empty / whitespace-only → 400 suggest_empty.
    for (const bad of [{ text: '' }, { text: '   \n  ' }, {}, { text: null }]) {
      const r = await post(fanA.token, bad);
      assert.equal(r.status, 400, `empty rejected: ${JSON.stringify(bad)}`);
      assert.equal(r.json.error, 'suggest_empty');
    }

    // Overlong → 400 suggest_too_long; exactly 1000 chars is fine.
    const tooLong = await post(fanA.token, { text: 'x'.repeat(1001) });
    assert.equal(tooLong.status, 400);
    assert.equal(tooLong.json.error, 'suggest_too_long');
    const maxOk = await post(fanA.token, { text: 'y'.repeat(1000) });
    assert.equal(maxOk.status, 200, `1000-char suggestion accepted: ${maxOk.text}`);
    assert.deepEqual(maxOk.json, { ok: true });

    // A normal suggestion.
    const good = await post(fanA.token, { text: '  Please add a dark mode for night owls 🦉  ' });
    assert.equal(good.status, 200);

    // Rate limit: a fresh fan gets 5 through, the 6th inside 24h is a 429.
    const fanB = await signup(h.base, 'sugfan_b');
    for (let i = 1; i <= 5; i++) {
      const r = await post(fanB.token, { text: `idea number ${i}` });
      assert.equal(r.status, 200, `submission ${i} accepted: ${r.text}`);
    }
    const sixth = await post(fanB.token, { text: 'one too many' });
    assert.equal(sixth.status, 429, '6th submission within 24h is rate limited');
    assert.equal(sixth.json.error, 'suggest_rate');

    stop(h);
    // Stored truth: verbatim (trimmed) body, username snapshot, default status.
    const db = readDb(dir);
    const rows = db.prepare('SELECT * FROM suggestions WHERE user_id = ? ORDER BY id').all(fanA.id);
    assert.equal(rows.length, 2, 'both accepted suggestions stored');
    assert.equal(rows[1].body, 'Please add a dark mode for night owls 🦉', 'body stored trimmed');
    assert.equal(rows[1].username, 'sugfan_a', 'username snapshot stored');
    assert.equal(rows[1].status, 'new', "status defaults to 'new'");
    assert.ok(rows[1].created_at, 'created_at stamped');
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM suggestions WHERE user_id = ?').get(fanB.id).c, 5,
      'rate-limited submission was not stored');

    // Admin bell: one per accepted submission, body truncated to ~120 chars.
    const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
    const bells = db.prepare(
      "SELECT title, body FROM notifications WHERE user_id = ? AND type = 'suggestion_admin' ORDER BY id").all(admin.id);
    assert.equal(bells.length, 7, 'admin belled once per accepted submission (2 + 5)');
    assert.equal(bells[0].title, '💡 New suggestion from sugfan_a');
    assert.equal(bells[0].body.length, 121, 'long suggestion bell body truncated to 120 chars + ellipsis');
    assert.ok(bells[0].body.endsWith('…'), 'truncated bell body ends with ellipsis');
    assert.equal(bells[1].body, 'Please add a dark mode for night owls 🦉', 'short suggestion bell body verbatim');
    db.close();
  } finally {
    stop(h);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------- manager endpoints ---------------- */

test('manager endpoints: header + admin required, newest-first list, status validation', async () => {
  const dir = makeCopy();
  const h = await boot(dir, { SEED_DEMO: '1' });
  try {
    const fan = await signup(h.base, 'sugfan_c');
    await req(h.base, 'POST', '/api/suggestions', { token: fan.token, body: { text: 'first idea' } });
    await req(h.base, 'POST', '/api/suggestions', { token: fan.token, body: { text: 'second idea' } });
    const mgr = await mgrLogin(h.base);

    // Admin token WITHOUT the X-Manager header → 403 (public-app sessions can't reach it).
    const noHeader = await req(h.base, 'GET', '/api/admin/suggestions', { token: mgr.token });
    assert.equal(noHeader.status, 403, 'missing X-Manager header rejected');
    assert.equal(noHeader.json.error, 'manager_only');

    // Fan token WITH the header → 403 (not an admin).
    const fanTry = await req(h.base, 'GET', '/api/admin/suggestions',
      { token: fan.token, headers: { 'x-manager': '1' } });
    assert.equal(fanTry.status, 403, 'fan cannot list suggestions');

    // Proper manager call → newest first.
    const list = await req(h.base, 'GET', '/api/admin/suggestions', { ...mgr });
    assert.equal(list.status, 200, `manager list: ${list.text}`);
    assert.equal(list.json.suggestions.length, 2);
    assert.equal(list.json.suggestions[0].body, 'second idea', 'newest first');
    assert.equal(list.json.suggestions[1].body, 'first idea');
    assert.equal(list.json.suggestions[0].username, 'sugfan_c');
    const target = list.json.suggestions[1];

    // Status validation.
    const bad = await req(h.base, 'POST', `/api/admin/suggestions/${target.id}/status`,
      { ...mgr, body: { status: 'bogus' } });
    assert.equal(bad.status, 400, 'invalid status rejected');
    assert.equal(bad.json.error, 'bad_status');
    const missing = await req(h.base, 'POST', '/api/admin/suggestions/999999/status',
      { ...mgr, body: { status: 'read' } });
    assert.equal(missing.status, 404, 'unknown id 404s');

    const read = await req(h.base, 'POST', `/api/admin/suggestions/${target.id}/status`,
      { ...mgr, body: { status: 'read' } });
    assert.equal(read.status, 200);
    assert.deepEqual(read.json, { ok: true, status: 'read' });
    const done = await req(h.base, 'POST', `/api/admin/suggestions/${target.id}/status`,
      { ...mgr, body: { status: 'done' } });
    assert.equal(done.status, 200);
    stop(h);
    const db = readDb(dir);
    assert.equal(db.prepare('SELECT status FROM suggestions WHERE id = ?').get(target.id).status, 'done',
      'status persisted');
    db.close();
  } finally {
    stop(h);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------- digest endpoint ---------------- */

test('digest: 503 when SUGGEST_DIGEST_TOKEN is unset', async () => {
  const dir = makeCopy();
  const h = await boot(dir, {});
  try {
    const r = await req(h.base, 'GET', '/api/internal/suggestions-digest',
      { headers: { 'x-digest-token': 'anything' } });
    assert.equal(r.status, 503, 'unset env → 503');
    assert.equal(r.json.error, 'digest_unavailable');
  } finally {
    stop(h);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('digest: token-only auth, payload shape, follows the new→done lifecycle', async () => {
  const dir = makeCopy();
  const h = await boot(dir, { SEED_DEMO: '1', SUGGEST_DIGEST_TOKEN: 'test-digest-secret' });
  try {
    const digest = (headers) => req(h.base, 'GET', '/api/internal/suggestions-digest', { headers });

    // No header, wrong header → 401. A valid session token is NOT an alternative path.
    assert.equal((await digest({})).status, 401, 'missing token → 401');
    assert.equal((await digest({ 'x-digest-token': 'wrong' })).status, 401, 'bad token → 401');
    const mgr = await mgrLogin(h.base);
    const sessionOnly = await req(h.base, 'GET', '/api/internal/suggestions-digest', { token: mgr.token });
    assert.equal(sessionOnly.status, 401, 'admin session alone does not unlock the digest');

    // Good token → 200 with the documented shape, empty at first.
    const empty = await digest({ 'x-digest-token': 'test-digest-secret' });
    assert.equal(empty.status, 200, `digest ok: ${empty.text}`);
    assert.equal(empty.json.ok, true);
    assert.deepEqual(empty.json.suggestions, []);

    // A submitted suggestion appears, with every documented field.
    const fan = await signup(h.base, 'sugfan_d');
    await req(h.base, 'POST', '/api/suggestions', { token: fan.token, body: { text: 'digest me please' } });
    const one = await digest({ 'x-digest-token': 'test-digest-secret' });
    assert.equal(one.json.suggestions.length, 1, 'submitted suggestion appears in the digest');
    const s = one.json.suggestions[0];
    assert.equal(s.username, 'sugfan_d');
    assert.equal(s.body, 'digest me please');
    assert.equal(s.status, 'new');
    assert.ok(Number.isInteger(s.id) && s.created_at, 'id + created_at present');

    // Once triaged out of 'new', it leaves the digest.
    const upd = await req(h.base, 'POST', `/api/admin/suggestions/${s.id}/status`,
      { ...mgr, body: { status: 'done' } });
    assert.equal(upd.status, 200);
    const after = await digest({ 'x-digest-token': 'test-digest-secret' });
    assert.deepEqual(after.json.suggestions, [], "only status='new' rows are digested");
  } finally {
    stop(h);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------- source pins ---------------- */

test('pins: schema, routes, announcement, digest and UI wiring exist', () => {
  // Server.
  assert.ok(serverSrc.includes('CREATE TABLE IF NOT EXISTS suggestions'), 'suggestions table created');
  assert.ok(serverSrc.includes('function announceSuggestionBoxToFans()'), 'announcement function exists');
  assert.ok(serverSrc.includes('suggestion_box_announced_at'), 'announcement stamp wired');
  assert.ok(serverSrc.includes('[suggest] Suggestion box announcement sent to ${n} fans.'),
    'announcement log line matches the required format');
  assert.ok(serverSrc.includes("app.post('/api/suggestions'"), 'submission route exists');
  assert.ok(serverSrc.includes("app.get('/api/admin/suggestions'"), 'manager list route exists');
  assert.ok(serverSrc.includes("app.post('/api/admin/suggestions/:id/status'"), 'manager status route exists');
  assert.ok(serverSrc.includes("app.get('/api/internal/suggestions-digest'"), 'digest route exists');
  assert.ok(serverSrc.includes('SUGGEST_DIGEST_TOKEN'), 'digest reads its env token');
  assert.ok(serverSrc.includes('timingSafeEqual'), 'digest compare is timing-safe');
  assert.ok(serverSrc.includes("notifyUser(f.id, 'suggestion_box'"), 'announcement delivers via notifyUser');
  const annBody = serverSrc.slice(serverSrc.indexOf('function announceSuggestionBoxToFans()'),
    serverSrc.indexOf('function seed()'));
  assert.ok(!annBody.includes('INSERT INTO messages'), 'announcement creates no DM');
  assert.ok(annBody.indexOf('suggestion_box_announced_at = datetime') <
    annBody.indexOf('notifyUser('), 'stamp is set BEFORE the send loop');

  // Client: fan wallet card.
  assert.ok(appSrc.includes('function renderSuggestionCard()'), 'suggestion card renderer exists');
  assert.equal(appSrc.split('id="suggest-card"').length - 1, 1, 'suggest card host exists exactly once');
  for (const k of ['suggest_title', 'suggest_hint', 'suggest_placeholder', 'suggest_send',
    'suggest_thanks', 'suggest_err_empty', 'suggest_err_long', 'suggest_err_rate']) {
    assert.ok(appSrc.includes(`${k}:`), `client key ${k} present`);
  }
  assert.ok(appSrc.includes("S.user.role !== 'fan'"), 'card renderer is fan-only');

  // Manager: nav + screen + body.
  assert.ok(managerSrc.includes("['suggestions', '💡 Suggestions']"), 'manager nav entry exists');
  assert.ok(managerSrc.includes('suggestions: adminSuggestionsBody'), 'manager screen registered');
  assert.ok(managerSrc.includes('async function adminSuggestionsBody()'), 'manager body exists');
  assert.ok(managerSrc.includes("api('/admin/suggestions')"), 'manager body reads the admin list');
});
