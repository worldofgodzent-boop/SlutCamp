'use strict';
/*
 * Fan blast + optional contact email tests (owner decisions, Oct 17
 * 2026: "if we have update for the fans, send them…" — and "I don't
 * want to force them. Give them the option to add email or contact…
 * They should be able to skip if they want.").
 *
 * Part A: a ONE-TIME fan blast (bell + Web Push via notifyUser, the
 * only fan channel that exists — no email provider, no SMS) stamped
 * on platform_stats (fan_preview_announced_at): every non-banned fan
 * gets exactly one 'fan_news' bell; models/admin get none; a second
 * boot sends nothing more.
 *
 * Part B: the thread-tap update's message to the girls (PR #33
 * shipped without a broadcast by design; the owner's standing rule
 * folds it in here): one-time admin-thread DM per model, stamped
 * thread_tap_announced_at, and the bell itself carries the new
 * /#chat/<convId> link so tapping it demonstrates the feature.
 *
 * Part C: optional contact email — collection only. users.email is
 * NULL until a fan opts in at sign-up or via PATCH /api/me/contact;
 * invalid provided emails are 400s; empty clears to NULL; /api/me
 * exposes the address on the caller's own payload only.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-fanblast-'));
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

function readDb(dir) {
  return new DatabaseSync(path.join(dir, 'wogent-chat.db'), { readOnly: true });
}

async function req(base, method, p, { body, token } = {}) {
  const h = {};
  let payload;
  if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  if (token) h.authorization = 'Bearer ' + token;
  const r = await fetch(base + p, { method, headers: h, body: payload });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not json */ }
  return { status: r.status, json, text };
}

/* ---------------- Parts A + B: seeded boot broadcasts ---------------- */

test('fan blast + thread-tap broadcast: fans belled once, models DMd once, stamps set, no re-send', async () => {
  const dir = makeCopy();
  try {
    const h1 = await boot(dir, { SEED_DEMO: '1' });
    stop(h1);
    let db = readDb(dir);
    const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
    assert.ok(admin, 'seeded admin exists');

    // --- Part A: fan blast ---
    const fanStamp = db.prepare('SELECT fan_preview_announced_at FROM platform_stats WHERE id = 1').get();
    assert.ok(fanStamp && fanStamp.fan_preview_announced_at, 'fan blast stamp is set after first boot');
    const fans = db.prepare("SELECT id, username FROM users WHERE role = 'fan'").all();
    assert.ok(fans.length >= 1, 'seed fan exists');
    const fanBellCount = (fanId) => db.prepare(
      "SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND type = 'fan_news'").get(fanId).c;
    for (const f of fans) {
      assert.equal(fanBellCount(f.id), 1, `${f.username} got exactly one fan_news bell`);
      const bell = db.prepare(
        "SELECT title, body FROM notifications WHERE user_id = ? AND type = 'fan_news'").get(f.id);
      assert.equal(bell.title, '🎬 NEW: Her profile video plays now!');
      assert.ok(bell.body.includes('preview video plays right there'), 'blast body present');
    }
    const models = db.prepare("SELECT id, username FROM users WHERE role = 'model'").all();
    assert.ok(models.length >= 3, 'seed models exist');
    for (const m of models) {
      assert.equal(fanBellCount(m.id), 0, `${m.username} (model) got no fan blast`);
    }
    assert.equal(fanBellCount(admin.id), 0, 'admin got no fan blast');

    // --- Part B: thread-tap message to the girls ---
    const ttStamp = db.prepare('SELECT thread_tap_announced_at FROM platform_stats WHERE id = 1').get();
    assert.ok(ttStamp && ttStamp.thread_tap_announced_at, 'thread-tap stamp is set after first boot');
    const dmCountFor = (modelId) => db.prepare(
      `SELECT COUNT(*) AS c FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE c.fan_id = ? AND c.model_id = ? AND m.sender_id = ? AND m.body LIKE '%One tap, straight to the message%'`
    ).get(admin.id, modelId, admin.id).c;
    for (const m of models) {
      assert.equal(dmCountFor(m.id), 1, `${m.username} got exactly one thread-tap DM`);
      const row = db.prepare(
        `SELECT m.body FROM messages m JOIN conversations c ON c.id = m.conversation_id
         WHERE c.fan_id = ? AND c.model_id = ? AND m.body LIKE '%One tap, straight to the message%'`
      ).get(admin.id, m.id);
      assert.ok(row.body.includes('opens the message itself'), 'one-tap behavior explained');
      assert.ok(row.body.includes('Simple and easy'), 'owner wording present');
      // The bell demonstrates the feature: its link IS the thread.
      const bells = db.prepare(
        "SELECT link FROM notifications WHERE user_id = ? AND type = 'thread_tap'").all(m.id);
      assert.equal(bells.length, 1, `${m.username} got exactly one thread_tap bell`);
      const conv = db.prepare('SELECT id FROM conversations WHERE fan_id = ? AND model_id = ?')
        .get(admin.id, m.id);
      assert.equal(bells[0].link, `/#chat/${conv.id}`, 'thread_tap bell links to its own thread');
    }
    for (const f of fans) {
      const fanDm = db.prepare(
        `SELECT COUNT(*) AS c FROM messages m JOIN conversations c ON c.id = m.conversation_id
         WHERE (c.fan_id = ? OR c.model_id = ?) AND m.body LIKE '%One tap, straight to the message%'`
      ).get(f.id, f.id).c;
      assert.equal(fanDm, 0, 'fans receive no thread-tap DM');
      const fanBell = db.prepare(
        "SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND type = 'thread_tap'").get(f.id).c;
      assert.equal(fanBell, 0, 'fans receive no thread_tap bell');
    }
    db.close();

    // Second boot keeps SEED_DEMO=1 (dev mode): without it, the
    // production fake-money purge would delete the pristine seed
    // models — and their threads — before we could count anything.
    const h2 = await boot(dir, { SEED_DEMO: '1' });
    stop(h2);
    db = readDb(dir);
    for (const f of fans) assert.equal(fanBellCount(f.id), 1, `${f.username} not re-blasted on second boot`);
    for (const m of models) assert.equal(dmCountFor(m.id), 1, `${m.username} not re-sent on second boot`);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------- Part C: optional contact email ---------------- */

test('contact email: optional at signup, PATCH set/validate/clear, /api/me exposes it', async () => {
  const dir = makeCopy();
  const h = await boot(dir, {});
  try {
    const signup = (username, extra) => req(h.base, 'POST', '/api/auth/signup', {
      body: { username, password: `${username}-pass-123`, role: 'fan',
        display_name: username, dob: '1995-05-05', agree18: true, ...(extra || {}) },
    });

    // No email → succeeds, nothing stored, /api/me shows ''.
    const s1 = await signup('skipfan');
    assert.equal(s1.status, 200, `signup without email: ${s1.text}`);
    const me1 = await req(h.base, 'GET', '/api/me', { token: s1.json.token });
    assert.equal(me1.status, 200);
    assert.equal(me1.json.user.email, '', 'skipped signup exposes empty email');

    // Valid email at signup → stored and exposed.
    const s2 = await signup('mailfan', { email: 'Fan.Updates@Example.com' });
    assert.equal(s2.status, 200, `signup with email: ${s2.text}`);
    const me2 = await req(h.base, 'GET', '/api/me', { token: s2.json.token });
    assert.equal(me2.json.user.email, 'Fan.Updates@Example.com', 'signup email exposed on /api/me');

    // Invalid email at signup → 400 bad_email, account NOT created.
    const s3 = await signup('badfan', { email: 'not-an-email' });
    assert.equal(s3.status, 400, `invalid-email signup rejected: ${s3.text}`);
    assert.equal(s3.json.error, 'bad_email');
    const s3b = await signup('badfan');
    assert.equal(s3b.status, 200, 'rejected signup left no account behind');

    // PATCH lifecycle on the skipped fan: set → invalid → clear by '' → clear by null.
    const tok = s1.json.token;
    const p1 = await req(h.base, 'PATCH', '/api/me/contact', { token: tok, body: { email: 'later@sample.org' } });
    assert.equal(p1.status, 200, `PATCH set: ${p1.text}`);
    assert.deepEqual(p1.json, { ok: true, email: 'later@sample.org' });
    const meP = await req(h.base, 'GET', '/api/me', { token: tok });
    assert.equal(meP.json.user.email, 'later@sample.org', '/api/me reflects the PATCH');

    const pBad = await req(h.base, 'PATCH', '/api/me/contact', { token: tok, body: { email: 'nope@' } });
    assert.equal(pBad.status, 400, 'PATCH invalid email rejected');
    assert.equal(pBad.json.error, 'bad_email');
    const meBad = await req(h.base, 'GET', '/api/me', { token: tok });
    assert.equal(meBad.json.user.email, 'later@sample.org', 'invalid PATCH changed nothing');

    const p2 = await req(h.base, 'PATCH', '/api/me/contact', { token: tok, body: { email: '' } });
    assert.equal(p2.status, 200);
    assert.deepEqual(p2.json, { ok: true, email: null }, 'empty string clears');
    const meC = await req(h.base, 'GET', '/api/me', { token: tok });
    assert.equal(meC.json.user.email, '', 'cleared email exposes empty');

    const p3 = await req(h.base, 'PATCH', '/api/me/contact', { token: s2.json.token, body: { email: null } });
    assert.equal(p3.status, 200);
    assert.deepEqual(p3.json, { ok: true, email: null }, 'null clears too');

    // Unauthenticated → 401.
    const pAnon = await req(h.base, 'PATCH', '/api/me/contact', { body: { email: 'x@y.zz' } });
    assert.equal(pAnon.status, 401, 'contact PATCH requires login');
  } finally {
    stop(h);
  }
  // Stored truth in the DB: skipped/cleared = NULL, never ''.
  const db = readDb(dir);
  const skip = db.prepare("SELECT email FROM users WHERE username = 'skipfan'").get();
  assert.equal(skip.email, null, 'skipped fan stores NULL');
  const mail = db.prepare("SELECT email FROM users WHERE username = 'mailfan'").get();
  assert.equal(mail.email, null, 'null-cleared fan stores NULL');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ---------------- source pins ---------------- */

test('pins: broadcasts, schema, routes and UI wiring exist with the optional wording', () => {
  // Server: broadcasts + stamps + schema + route.
  assert.ok(serverSrc.includes('function announceFanPreviewToFans()'), 'fan blast function exists');
  assert.ok(serverSrc.includes('function announceThreadTapToModels()'), 'thread-tap broadcast exists');
  assert.ok(serverSrc.includes('fan_preview_announced_at'), 'fan blast stamp wired');
  assert.ok(serverSrc.includes('thread_tap_announced_at'), 'thread-tap stamp wired');
  assert.ok(serverSrc.includes("addColumnIfMissing('users', 'email', 'TEXT')"), 'users.email column added');
  assert.ok(serverSrc.includes("app.patch('/api/me/contact'"), 'contact PATCH route exists');
  assert.ok(serverSrc.includes("notifyUser(f.id, 'fan_news'"), 'blast delivers via notifyUser (bell + push)');
  // The fan blast is bell+push ONLY — no admin DM thread is created for fans.
  const blastBody = serverSrc.slice(serverSrc.indexOf('function announceFanPreviewToFans()'),
    serverSrc.indexOf('function seed()'));
  assert.ok(!blastBody.includes('INSERT INTO messages'), 'fan blast creates no DM');
  assert.ok(!blastBody.includes('INSERT INTO conversations'), 'fan blast creates no conversation');

  // Client: fan settings card with the owner's optional wording.
  assert.ok(appSrc.includes('function renderContactSettingsCard()'), 'contact card renderer exists');
  assert.ok(appSrc.includes('📣 Updates about your favorites (optional)'), 'card heading present');
  assert.ok(appSrc.includes('Totally optional — skip it and nothing changes.'), 'card carries the skip wording');
  assert.ok(appSrc.includes('S.user.email'), 'card prefills from /api/me payload');
  assert.equal(appSrc.split('id="contact-card"').length - 1, 1, 'contact card host exists exactly once (fan wallet)');
  const modelSettings = appSrc.slice(appSrc.indexOf('async function vModelSettings()'),
    appSrc.indexOf('async function vModelSettings()') + 30000);
  assert.ok(!modelSettings.includes('contact-card'), 'model settings does NOT get the fan contact card');

  // Client: signup email input exists for fans and is NOT required.
  const at = appSrc.indexOf('id="a-email"');
  assert.ok(at >= 0, 'signup email input exists');
  const around = appSrc.slice(Math.max(0, at - 260), at + 120);
  assert.ok(around.includes("role === 'fan'"), 'signup email input is fan-only');
  assert.ok(!/required/.test(around), 'signup email input is NOT required (skippable)');
});
