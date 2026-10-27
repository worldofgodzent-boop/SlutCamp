'use strict';
/*
 * Fake-money cleanup tests — the pre-launch demo-seed purge.
 *
 * Covers both directions of the SEED_DEMO gate plus the one-time purge
 * migration (platform_stats.demo_purge_at):
 *   1. A fresh boot WITHOUT the flag creates no demo accounts and no
 *      test credits (production default — demos are opt-in only now).
 *   2. A fresh boot WITH SEED_DEMO=1 creates the demo accounts,
 *      including fandemo with his $100 (10000¢) of test credits — the
 *      gate works in both directions, so local dev keeps its fixtures.
 *   3. A seeded DB that also gained a REAL user (real signup + a real
 *      admin credit grant on the ledger) boots without the flag: the
 *      purge removes ONLY the three seed MODEL accounts and their
 *      dependents (wallets, threads, messages, notifications), stamps
 *      its marker, preserves the real user + his account + his ledger
 *      row, the admin account AND fandemo — the owner's own test
 *      account (owner decision, Oct 16 2026) — and never runs twice.
 *      (Balances read $0 after this boot: the separate platform-wide
 *      demo-money wipe of Oct 21 2026 — owner-directed, "0 right
 *      across" — zeroes EVERY wallet on the same no-flag boot.)
 *   4. The guards: the seed bunny and bella are deleted, then REAL
 *      models register those names with their OWN passwords. Bunny
 *      also earns real money (a fan's paid message, on the ledger)
 *      and has an uploaded picture (media_items row); seed stacey —
 *      otherwise pristine — is marked ID-verified (approved). Every
 *      guard must trip and log: Bunny on pictures + password, Bella
 *      on password alone, stacey on ID verification alone (her
 *      password IS the seed default — the ID row is her only shield).
 *      Nothing is purged; every account and ledger row survives
 *      (balances read $0 — the platform-wide Oct 21 2026 demo-money
 *      wipe fires on the same boot and zeroes every wallet).
 *      (Test 3 proves the purge itself still fires on genuinely
 *      pristine seeds.)
 *
 * Same isolation pattern as tests/smoke.test.js: the real server.js is
 * copied to a fresh temp dir and booted there on free ports — except
 * test 3 deliberately re-boots the SAME temp dir three times, because
 * the purge is a boot-time migration over an existing database.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-cleanup-'));
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
    if (/^(CCBILL_|CRYPTO_|OPENAI_|TWILIO_|VAPID_|WEBAUTHN_)/.test(k)) delete env[k];
  }
  if (!('SEED_DEMO' in extraEnv)) delete env.SEED_DEMO; // default boot: flag truly absent
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

function stop(handle) {
  if (handle && handle.child && handle.child.exitCode === null) handle.child.kill('SIGKILL');
}

async function req(base, method, p, { body, token, headers } = {}) {
  const h = { ...(headers || {}) };
  if (body !== undefined) h['content-type'] = 'application/json';
  if (token) h.authorization = 'Bearer ' + token;
  const r = await fetch(base + p, {
    method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: r.status, json, text };
}

function readDb(dir, fn) {
  const db = new DatabaseSync(path.join(dir, 'wogent-chat.db'), { readOnly: true });
  try { return fn(db); } finally { db.close(); }
}

test('fresh boot without SEED_DEMO: no demo accounts, no test credits', { timeout: 90000 }, async (t) => {
  const dir = makeCopy();
  const h = await boot(dir, {});
  t.after(() => { stop(h); fs.rmSync(dir, { recursive: true, force: true }); });

  const models = await req(h.base, 'GET', '/api/models');
  assert.equal(models.status, 200);
  assert.equal(models.json.models.length, 0, 'no models — nobody was seeded');

  const fan = await req(h.base, 'POST', '/api/auth/login', { body: { username: 'fandemo', password: 'fan123' } });
  assert.equal(fan.status, 401, 'fandemo does not exist');
  const adm = await req(h.base, 'POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' } });
  assert.equal(adm.status, 401, 'not even the admin is seeded by default');

  assert.ok(h.log().includes('Demo seeding OFF'), 'boot log says seeding is off');
  assert.ok(!h.log().includes('Seeded: admin'), 'seed() never ran');
});

test('fresh boot with SEED_DEMO=1: demo accounts appear, incl. the $100 fan', { timeout: 90000 }, async (t) => {
  const dir = makeCopy();
  const h = await boot(dir, { SEED_DEMO: '1' });
  t.after(() => { stop(h); fs.rmSync(dir, { recursive: true, force: true }); });

  const models = await req(h.base, 'GET', '/api/models');
  const names = models.json.models.map((m) => m.username);
  for (const expected of ['bunny', 'stacey', 'bella']) {
    assert.ok(names.includes(expected), `seeded model ${expected} is listed`);
  }
  const login = await req(h.base, 'POST', '/api/auth/login', { body: { username: 'fandemo', password: 'fan123' } });
  assert.equal(login.status, 200, 'fandemo can sign in under the flag');
  const me = await req(h.base, 'GET', '/api/me', { token: login.json.token });
  assert.equal(me.json.wallet.credits_cents, 10000, 'fandemo carries exactly $100 of test credits');
  // The purge must stay out of the way while demos are opted in.
  assert.ok(!h.log().includes('purged seed account'), 'purge skipped under SEED_DEMO=1');
});

test('purge: seeded DB + real user boots clean — only the seed models go, exactly once', { timeout: 180000 }, async (t) => {
  const dir = makeCopy();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  /* ---- Boot 1 (SEED_DEMO=1): seeds + a REAL fan with a REAL balance ---- */
  let h = await boot(dir, { SEED_DEMO: '1' });
  const signup = await req(h.base, 'POST', '/api/auth/signup', {
    body: { username: 'realfan', password: 'real-pass-1', role: 'fan',
            display_name: 'Real Fan', dob: '1994-03-03', agree18: true },
  });
  assert.equal(signup.status, 200, 'real fan signup works');
  const realId = signup.json.user.id;
  assert.ok(Number.isInteger(realId), 'real fan has an id');

  const adminLogin = await req(h.base, 'POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' } });
  assert.equal(adminLogin.status, 200, 'seed admin signs in (fixture)');
  const grant = await req(h.base, 'POST', `/api/admin/fans/${realId}/credits`, {
    token: adminLogin.json.token, headers: { 'x-manager': '1' }, body: { amount_cents: 5000 },
  });
  assert.equal(grant.status, 200, 'admin credit grant to the real fan lands');
  assert.equal(grant.json.balance_cents, 5000);
  stop(h);

  /* ---- Boot 2 (no flag): the one-time purge fires ---- */
  h = await boot(dir, {});
  const log2 = h.log();
  assert.ok(log2.includes('[cleanup] purged seed account bunny (model)'), 'audit line: bunny purged');
  assert.ok(log2.includes('Demo seed purge complete: 3 account(s) removed (bunny, stacey, bella)'),
    'all three seed models purged, in seed order');
  assert.ok(log2.includes('[cleanup] fandemo preserved'), 'audit line: fandemo preserved — the owner\'s test account');
  assert.ok(!log2.includes('purged seed account fandemo'), 'fandemo is never a purge target');
  assert.ok(log2.includes('CRITICAL'), 'seed admin still on the default password — flagged, not deleted');

  const models = await req(h.base, 'GET', '/api/models');
  assert.equal(models.json.models.length, 0, 'public directory is clean of seed models');

  const fanKept = await req(h.base, 'POST', '/api/auth/login', { body: { username: 'fandemo', password: 'fan123' } });
  assert.equal(fanKept.status, 200, 'fandemo survives the purge — he is the owner\'s test account');
  const fanMe = await req(h.base, 'GET', '/api/me', { token: fanKept.json.token });
  assert.equal(fanMe.json.wallet.credits_cents, 0, 'fandemo\'s account is untouched, but his $100 of test credits reads $0 — the Oct 21 platform-wide demo-money wipe zeroes every wallet, his included (owner-directed one-time exception)')
  const bunnyGone = await req(h.base, 'POST', '/api/auth/login', { body: { username: 'bunny', password: 'model123' } });
  assert.equal(bunnyGone.status, 401, 'bunny is gone');

  const realLogin = await req(h.base, 'POST', '/api/auth/login', { body: { username: 'realfan', password: 'real-pass-1' } });
  assert.equal(realLogin.status, 200, 'the real fan still signs in');
  const realMe = await req(h.base, 'GET', '/api/me', { token: realLogin.json.token });
  assert.equal(realMe.json.wallet.credits_cents, 0, 'his account and ledger row are untouched (proven below), but the pre-wipe grant reads $0 — the demo-money wipe zeroes every wallet platform-wide');

  const adminStill = await req(h.base, 'POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' } });
  assert.equal(adminStill.status, 200, 'admin preserved — no owner lockout');

  /* ---- Ledger consistency, read straight from the DB ---- */
  readDb(dir, (db) => {
    const seedRows = db.prepare(
      "SELECT COUNT(*) AS n FROM users WHERE username IN ('bunny','stacey','bella')").get().n;
    assert.equal(seedRows, 0, 'no seed model users remain');
    const fdRow = db.prepare("SELECT id FROM users WHERE username = 'fandemo'").get();
    assert.ok(fdRow, 'fandemo row preserved');
    assert.equal(db.prepare('SELECT credits_cents FROM wallets WHERE user_id = ?').get(fdRow.id).credits_cents,
      0, 'fandemo wallet reads $0 in the DB after the platform-wide wipe');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE username = 'admin'").get().n, 1,
      'admin row preserved');
    assert.ok(db.prepare('SELECT demo_purge_at FROM platform_stats WHERE id = 1').get().demo_purge_at,
      'purge marker is stamped');
    const tx = db.prepare('SELECT fan_id, type, gross_cents FROM transactions').all();
    assert.equal(tx.length, 1, "only the real fan's ledger row survives");
    assert.equal(tx[0].fan_id, realId);
    assert.equal(tx[0].type, 'credit_grant');
    assert.equal(tx[0].gross_cents, 5000);
    const orphanTx = db.prepare(`SELECT COUNT(*) AS n FROM transactions
      WHERE (fan_id IS NOT NULL AND fan_id NOT IN (SELECT id FROM users))
         OR (model_id IS NOT NULL AND model_id NOT IN (SELECT id FROM users))`).get().n;
    assert.equal(orphanTx, 0, 'no orphaned transactions reference deleted users');
    const orphanConv = db.prepare(`SELECT COUNT(*) AS n FROM conversations
      WHERE fan_id NOT IN (SELECT id FROM users) OR model_id NOT IN (SELECT id FROM users)`).get().n;
    assert.equal(orphanConv, 0, 'no orphaned conversations');
    const orphanMsg = db.prepare(`SELECT COUNT(*) AS n FROM messages
      WHERE conversation_id NOT IN (SELECT id FROM conversations)`).get().n;
    assert.equal(orphanMsg, 0, 'no orphaned messages');
    const orphanWallet = db.prepare(`SELECT COUNT(*) AS n FROM wallets
      WHERE user_id NOT IN (SELECT id FROM users)`).get().n;
    assert.equal(orphanWallet, 0, 'no orphaned wallets');
  });
  stop(h);

  /* ---- Boot 3 (no flag): marker holds — the purge never runs twice ---- */
  h = await boot(dir, {});
  t.after(() => stop(h));
  assert.ok(!h.log().includes('purged seed account'), 'no second purge run');
  const again = await req(h.base, 'POST', '/api/auth/login', { body: { username: 'realfan', password: 'real-pass-1' } });
  assert.equal(again.status, 200);
  const me3 = await req(h.base, 'GET', '/api/me', { token: again.json.token });
  assert.equal(me3.json.wallet.credits_cents, 0, 'real account intact after a third boot; balance stays at the wiped $0');
  const fd3 = await req(h.base, 'POST', '/api/auth/login', { body: { username: 'fandemo', password: 'fan123' } });
  assert.equal(fd3.status, 200, 'fandemo still there after a third boot');
  const fdMe3 = await req(h.base, 'GET', '/api/me', { token: fd3.json.token });
  assert.equal(fdMe3.json.wallet.credits_cents, 0, 'fandemo balance stays at the wiped $0 after a third boot');
});

test('purge guards: pictures, ID-verification and password fingerprint each save a real account', { timeout: 180000 }, async (t) => {
  const dir = makeCopy();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  /* ---- Boot 1 (SEED_DEMO=1): the seed bunny and bella are removed,
         then REAL models register the freed names with their OWN
         passwords. Bunny also earns real money from a real fan's paid
         message. Seed stacey stays pristine — for now. ---- */
  let h = await boot(dir, { SEED_DEMO: '1' });
  const adminLogin = await req(h.base, 'POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' } });
  assert.equal(adminLogin.status, 200, 'seed admin signs in (fixture)');
  const adminAuth = { token: adminLogin.json.token, headers: { 'x-manager': '1' } };

  const listed = await req(h.base, 'GET', '/api/models');
  const seedBunny = listed.json.models.find((m) => m.username === 'bunny');
  const seedBella = listed.json.models.find((m) => m.username === 'bella');
  assert.ok(seedBunny && seedBella, 'seed bunny and bella are listed before removal');
  const delBunny = await req(h.base, 'DELETE', `/api/admin/models/${seedBunny.id}`, adminAuth);
  assert.equal(delBunny.status, 200, 'seed bunny removed through the Manager delete (the live-DB history)');
  const delBella = await req(h.base, 'DELETE', `/api/admin/models/${seedBella.id}`, adminAuth);
  assert.equal(delBella.status, 200, 'seed bella removed through the Manager delete');
  const afterDel = await req(h.base, 'GET', '/api/models');
  assert.ok(!afterDel.json.models.some((m) => ['bunny', 'bella'].includes(m.username.toLowerCase())),
    'the names Bunny and Bella are free again');

  const bunnySignup = await req(h.base, 'POST', '/api/auth/signup', {
    body: { username: 'Bunny', password: 'real-bunny-pass', role: 'model', publicity_consent: true,
            display_name: 'Bunny', dob: '1999-04-04', agree18: true, section: 'female' },
  });
  assert.equal(bunnySignup.status, 200, 'a real model registers the name Bunny');
  const bunnyId = bunnySignup.json.user.id;
  assert.ok(Number.isInteger(bunnyId) && bunnyId !== seedBunny.id, 'she is a brand-new account, not the seed');

  const bellaSignup = await req(h.base, 'POST', '/api/auth/signup', {
    body: { username: 'Bella', password: 'real-bella-pass', role: 'model', publicity_consent: true,
            display_name: 'Bella', dob: '1998-08-08', agree18: true, section: 'female' },
  });
  assert.equal(bellaSignup.status, 200, 'a real model registers the name Bella');
  const bellaId = bellaSignup.json.user.id;
  assert.ok(Number.isInteger(bellaId) && bellaId !== seedBella.id, 'she is a brand-new account too');

  const fanSignup = await req(h.base, 'POST', '/api/auth/signup', {
    body: { username: 'bunnyfan', password: 'bunny-fan-pass', role: 'fan',
            display_name: 'Bunny Fan', dob: '1993-06-06', agree18: true },
  });
  assert.equal(fanSignup.status, 200, 'real fan signup works');
  const fanId = fanSignup.json.user.id;
  const grant = await req(h.base, 'POST', `/api/admin/fans/${fanId}/credits`, {
    ...adminAuth, body: { amount_cents: 5000 },
  });
  assert.equal(grant.status, 200, 'admin credit grant to the fan lands');

  const conv = await req(h.base, 'POST', '/api/conversations/start', {
    token: fanSignup.json.token, body: { model_id: bunnyId },
  });
  assert.equal(conv.status, 200, 'fan opens a chat with the real Bunny');
  const convId = conv.json.conversation.id;
  // First 3 messages are the free trial; the 4th is a paid message at her
  // default 149¢ rate — 60% (89¢) lands in her earnings, on the ledger.
  for (const body of ['hi', 'hello', 'hey there', 'nice to meet you']) {
    const sent = await req(h.base, 'POST', '/api/messages', {
      token: fanSignup.json.token, body: { conversation_id: convId, body },
    });
    assert.equal(sent.status, 200, `fan message "${body}" lands`);
  }
  const bunnyMe = await req(h.base, 'GET', '/api/me', { token: bunnySignup.json.token });
  const earningsBefore = bunnyMe.json.wallet.earnings_cents;
  assert.equal(earningsBefore, 89, 'her real earnings before the purge: 60% of the 149¢ paid message');
  stop(h);

  /* ---- Fixtures written straight to the stopped DB ----
     Bunny uploaded a picture into her fan thread: a media_items row
     with sender_id = her (the pictures guard reads media_items; the
     row stands in for her real upload). And seed stacey — otherwise a
     pristine seed on the default password — completed ID
     verification: an APPROVED id_verifications row (the ID guard
     reads status only). Between them, every guard gets exercised. */
  const fix = new DatabaseSync(path.join(dir, 'wogent-chat.db'));
  fix.exec('PRAGMA busy_timeout = 10000');
  try {
    fix.prepare(`INSERT INTO media_items (conversation_id, sender_id, kind, mime, file_path, price_cents)
                 VALUES (?,?, 'ppv_image', 'image/jpeg', '/uploads/bunny-fixture.jpg', 500)`)
      .run(convId, bunnyId);
    const staceyRow = fix.prepare("SELECT id FROM users WHERE username = 'stacey'").get();
    assert.ok(staceyRow, 'seed stacey exists for the ID-verification fixture');
    fix.prepare(`INSERT INTO id_verifications (model_id, status, reviewed_at)
                 VALUES (?, 'approved', datetime('now'))`).run(staceyRow.id);
  } finally { fix.close(); }

  /* ---- Boot 2 (no flag): EVERY candidate trips a guard, so nothing
         is purged — Bunny on pictures (+ password), Bella on password
         alone, stacey on ID verification alone (her password IS still
         the seed default — the ID row is the only thing saving her) -- */
  h = await boot(dir, {});
  t.after(() => stop(h));
  const log2 = h.log();
  assert.ok(log2.includes('[cleanup] SKIPPED Bunny: account has uploaded pictures — real account, left untouched.'),
    'loud skip line: Bunny protected by the pictures guard');
  assert.ok(log2.includes('[cleanup] SKIPPED Bunny: password is not the seed default — looks like a real account, left untouched.'),
    'all guards log: Bunny also trips the password fingerprint');
  assert.ok(log2.includes('[cleanup] SKIPPED Bella: password is not the seed default — looks like a real account, left untouched.'),
    'loud skip line: Bella protected by the password fingerprint alone');
  assert.ok(!log2.includes('SKIPPED Bella: account has uploaded pictures'),
    'Bella has no pictures — the password guard did the work by itself');
  assert.ok(log2.includes('[cleanup] SKIPPED stacey: ID-verified model — real account, left untouched.'),
    'loud skip line: stacey protected by ID verification alone');
  assert.ok(!log2.includes('purged seed account'), 'NOTHING was purged — every candidate tripped a guard');
  assert.ok(log2.includes('[cleanup] fandemo preserved'), 'fandemo preserved here too');

  const bunnyLogin = await req(h.base, 'POST', '/api/auth/login', { body: { username: 'Bunny', password: 'real-bunny-pass' } });
  assert.equal(bunnyLogin.status, 200, 'the real Bunny still signs in with HER password');
  const bunnyMe2 = await req(h.base, 'GET', '/api/me', { token: bunnyLogin.json.token });
  assert.equal(bunnyMe2.json.wallet.earnings_cents, 0,
    'her account is untouched, but her 89¢ of pre-wipe earnings reads $0 — the Oct 21 platform-wide demo-money wipe zeroes every wallet');
  const bellaLogin = await req(h.base, 'POST', '/api/auth/login', { body: { username: 'Bella', password: 'real-bella-pass' } });
  assert.equal(bellaLogin.status, 200, 'the real Bella still signs in with HER password');
  const staceyLogin = await req(h.base, 'POST', '/api/auth/login', { body: { username: 'stacey', password: 'model123' } });
  assert.equal(staceyLogin.status, 200, 'seed stacey survives too — saved by her approved ID verification');

  const models2 = await req(h.base, 'GET', '/api/models');
  const names2 = models2.json.models.map((m) => m.username);
  for (const n of ['Bunny', 'Bella', 'stacey']) {
    assert.ok(names2.includes(n), `${n} is still in the public directory`);
  }

  readDb(dir, (db) => {
    const bunnies = db.prepare("SELECT id, role FROM users WHERE username = 'bunny'").all();
    assert.equal(bunnies.length, 1, 'exactly one account holds the name bunny');
    assert.equal(bunnies[0].id, bunnyId, 'and it is the REAL Bunny');
    assert.equal(bunnies[0].role, 'model');
    const bellas = db.prepare("SELECT id FROM users WHERE username = 'bella'").all();
    assert.equal(bellas.length, 1, 'exactly one account holds the name bella');
    assert.equal(bellas[0].id, bellaId, 'and it is the REAL Bella');
    const w = db.prepare('SELECT credits_cents, earnings_cents FROM wallets WHERE user_id = ?').get(bunnyId);
    assert.equal(w.earnings_cents, 0, 'her wallet earnings read $0 in the DB after the platform-wide wipe (ledger row below keeps the history)');
    const tx = db.prepare("SELECT type, gross_cents, model_cents FROM transactions WHERE model_id = ?").all(bunnyId);
    assert.equal(tx.length, 1, 'her ledger row survived');
    assert.equal(tx[0].type, 'message');
    assert.equal(tx[0].gross_cents, 149);
    assert.equal(tx[0].model_cents, 89);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE fan_id = ? AND model_id = ?')
      .get(fanId, bunnyId).n, 1, 'her fan thread survived');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM media_items WHERE sender_id = ?').get(bunnyId).n, 1,
      'her uploaded picture row survived');
    const stacey = db.prepare("SELECT id FROM users WHERE username = 'stacey'").get();
    assert.ok(stacey, 'seed stacey row survived on ID verification alone');
    assert.equal(db.prepare("SELECT status FROM id_verifications WHERE model_id = ?").get(stacey.id).status,
      'approved', 'her approved ID-verification row is intact');
    const fdRow = db.prepare("SELECT id FROM users WHERE username = 'fandemo'").get();
    assert.ok(fdRow, 'fandemo preserved');
    assert.equal(db.prepare('SELECT credits_cents FROM wallets WHERE user_id = ?').get(fdRow.id).credits_cents,
      0, 'fandemo preserved as an account; his $100 reads $0 after the platform-wide wipe');
    assert.ok(db.prepare('SELECT demo_purge_at FROM platform_stats WHERE id = 1').get().demo_purge_at,
      'purge marker is stamped');
  });
});
