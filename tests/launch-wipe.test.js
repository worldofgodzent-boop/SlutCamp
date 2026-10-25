'use strict';
/*
 * Full demo-money wipe tests (Asce, Oct 21 2026) — the one-time boot
 * cleanup guarded by platform_stats.demo_wipe_2026_10_at.
 *
 * Production story this simulates: the DB already carries money (all of
 * it demo — real revenue is $0) and every OLDER one-time stamp is
 * consumed, but the wipe's own stamp is unset. On the deploy boot the
 * wipe must zero "$0 right across", exactly once:
 *   1. Boot 1 (fresh DB): every pre-existing one-time pass consumes its
 *      stamp on an empty DB — the production precondition.
 *   2. Fixtures written straight to the stopped DB: a fandemo holding
 *      credits, a model with earnings + paid_out + a still-HOLDING
 *      earning lot (available_at in the future), a recruiter with
 *      earnings, platform earnings, a pending + a paid + a rejected
 *      withdrawal, 3 likes, an approved ID verification, and a full
 *      is_test=0 ledger. The wipe stamp is then NULLed — money that
 *      predates the wipe build, exactly like production.
 *   3. Boot 2: the wipe fires. Assert via API + DB: every wallet 0/0/0
 *      (fandemo's credits included — the owner's one-time exception),
 *      platform 0, ledger fully is_test=1, pending withdrawal rejected
 *      with the wipe note (decided rows untouched), derived model
 *      total_sales $0, rank_score keeps ONLY its likes (3 + $0), and
 *      accounts / likes / ID verification all intact.
 *   4. Boot 3: the stamp holds — the wipe never runs twice — and NEW
 *      money counts normally: a fresh fan is granted credits and pays
 *      for a message; the new rows land is_test=0, the new model's
 *      earnings and total_sales show them, while every pre-wipe row
 *      stays flagged.
 *
 * Same isolation pattern as tests/fake-money-cleanup.test.js: the real
 * server.js is copied to a fresh temp dir and booted there on free
 * ports, re-booting the SAME dir because the wipe is a boot-time pass
 * over an existing database.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');

const REPO = path.join(__dirname, '..');
const hash = (pw) => bcrypt.hashSync(pw, 10);

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-wipe-'));
  for (const d of ['server.js', 'package.json', 'lib', 'public', 'data']) {
    fs.cpSync(path.join(REPO, d), path.join(dir, d), { recursive: true });
  }
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  return dir;
}

async function boot(dir, extraEnv = {}) {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), CRYPTO_POLL_MS: '3600000', ...extraEnv };
  for (const k of Object.keys(env)) {
    if (/^(CCBILL_|CRYPTO_|OPENAI_|TWILIO_|VAPID_|WEBAUTHN_)/.test(k)) delete env[k];
  }
  if (!('SEED_DEMO' in extraEnv)) delete env.SEED_DEMO; // default boot: flag truly absent (money arrives via fixtures)
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

test('full demo-money wipe: $0 right across, exactly once, then new money counts', { timeout: 240000 }, async (t) => {
  const dir = makeCopy();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  /* ---- Boot 1: fresh DB — all older one-time stamps get consumed ---- */
  let h = await boot(dir);
  stop(h);

  /* ---- Fixtures: a pre-wipe money DB, written to the stopped DB ---- */
  const fx = new DatabaseSync(path.join(dir, 'wogent-chat.db'));
  fx.exec('PRAGMA busy_timeout = 10000');
  let ids;
  try {
    const insUser = fx.prepare(`INSERT INTO users (username, password_hash, role, display_name, dob)
                                VALUES (?, ?, ?, ?, '1990-01-01')`);
    const adminId = insUser.run('wipeadmin', hash('wipe-admin-pass'), 'admin', 'Wipe Admin').lastInsertRowid;
    const fanId = insUser.run('fandemo', hash('wipe-fan-pass'), 'fan', 'Demo Fan').lastInsertRowid;
    const fan2Id = insUser.run('wipefan2', hash('wipe-fan2-pass'), 'fan', 'Wipe Fan Two').lastInsertRowid;
    const fan3Id = insUser.run('wipefan3', hash('wipe-fan3-pass'), 'fan', 'Wipe Fan Three').lastInsertRowid;
    const modelId = insUser.run('wipemodel', hash('wipe-model-pass'), 'model', 'Wipe Model').lastInsertRowid;
    const recUserId = insUser.run('wiperec', hash('wipe-rec-pass'), 'recruiter', 'Wipe Recruiter').lastInsertRowid;
    fx.prepare('INSERT INTO models (user_id) VALUES (?)').run(modelId);
    const recId = fx.prepare(`INSERT INTO recruiters (user_id, name, referral_code)
                              VALUES (?, 'Wipe Recruiter', 'WIPEREC1')`).run(recUserId).lastInsertRowid;
    fx.prepare('UPDATE models SET recruiter_id = ?, rank_score = 45.89 WHERE user_id = ?').run(recId, modelId);
    fx.prepare(`INSERT INTO id_verifications (model_id, status, reviewed_at)
                VALUES (?, 'approved', datetime('now'))`).run(modelId);
    // Likes are NOT money: 3 of them, worth 3 rank points before and after.
    const insLike = fx.prepare('INSERT INTO model_likes (fan_id, model_id) VALUES (?, ?)');
    insLike.run(fanId, modelId); insLike.run(fan2Id, modelId); insLike.run(fan3Id, modelId);
    // Wallets: fandemo 4851 = 10000 loaded − 5149 spent; model earnings
    // 3289 + paid_out 1000 = the 4289 the ledger credits her; recruiter
    // earnings = the 1000 the ledger credits him.
    const insWallet = fx.prepare(`INSERT INTO wallets (user_id, credits_cents, earnings_cents, paid_out_cents)
                                  VALUES (?, ?, ?, ?)`);
    insWallet.run(fanId, 4851, 0, 0);
    insWallet.run(fan2Id, 3000, 0, 0);
    insWallet.run(fan3Id, 500, 0, 0);
    insWallet.run(modelId, 0, 3289, 1000);
    insWallet.run(recUserId, 0, 1000, 0);
    fx.prepare('UPDATE platform_stats SET earnings_cents = 1860 WHERE id = 1').run();
    // Ledger (all is_test=0). Row 2 is still inside its payout-protection
    // HOLD (available_at far future) — the wipe must clear it too.
    const insTx = fx.prepare(`INSERT INTO transactions
      (fan_id, model_id, type, gross_cents, model_cents, platform_cents, recruiter_id, recruiter_cents, available_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    insTx.run(fanId, null, 'credit_grant', 10000, 0, 0, null, 0, null);
    insTx.run(fan2Id, null, 'credit_grant', 5000, 0, 0, null, 0, null);
    insTx.run(fan3Id, null, 'credit_grant', 500, 0, 0, null, 0, null);
    insTx.run(fanId, modelId, 'tip', 5000, 3000, 1000, recId, 1000, '2020-01-01 00:00:00');
    insTx.run(fanId, modelId, 'message', 149, 89, 60, null, 0, '2099-01-01 00:00:00');
    insTx.run(fan2Id, modelId, 'gift', 2000, 1200, 800, null, 0, '2020-01-01 00:00:00');
    // Withdrawals: one pending (must die), one paid + one rejected (history — must not move).
    const insWd = fx.prepare(`INSERT INTO withdrawals (model_id, amount_cents, status, decided_at, note)
                              VALUES (?, ?, ?, ?, ?)`);
    insWd.run(modelId, 2000, 'pending', null, '');
    insWd.run(modelId, 1000, 'paid', '2026-10-15 00:00:00', 'Paid via Novo');
    insWd.run(modelId, 500, 'rejected', '2026-10-10 00:00:00', 'Old rejection');
    // The production precondition: money exists, the wipe has NOT run.
    fx.prepare('UPDATE platform_stats SET demo_wipe_2026_10_at = NULL WHERE id = 1').run();
    ids = { adminId, fanId, fan2Id, fan3Id, modelId, recUserId, recId };
  } finally { fx.close(); }

  /* ---- Boot 2: the wipe fires ---- */
  h = await boot(dir);
  assert.ok(h.log().includes('[cleanup] Full demo-money wipe complete'), 'boot log records the wipe');

  const models = await req(h.base, 'GET', '/api/models');
  assert.equal(models.status, 200);
  const listed = models.json.models.find((m) => m.username === 'wipemodel');
  assert.ok(listed, 'the model account is intact and still listed — accounts are never wiped');
  assert.equal(listed.total_sales, 0, 'derived total_sales reads $0 after the wipe');

  const fanLogin = await req(h.base, 'POST', '/api/auth/login', { body: { username: 'fandemo', password: 'wipe-fan-pass' } });
  assert.equal(fanLogin.status, 200, 'fandemo still signs in — account untouched');
  const fanMe = await req(h.base, 'GET', '/api/me', { token: fanLogin.json.token });
  assert.equal(fanMe.json.wallet.credits_cents, 0, 'fandemo credits zeroed — the owner-directed one-time exception');
  assert.equal(fanMe.json.wallet.earnings_cents, 0);

  const modelLogin = await req(h.base, 'POST', '/api/auth/login', { body: { username: 'wipemodel', password: 'wipe-model-pass' } });
  assert.equal(modelLogin.status, 200, 'the model still signs in');
  const modelMe = await req(h.base, 'GET', '/api/me', { token: modelLogin.json.token });
  assert.equal(modelMe.json.wallet.earnings_cents, 0, 'model earnings zeroed');
  assert.equal(modelMe.json.wallet.paid_out_cents, 0, 'model paid_out zeroed');

  const recLogin = await req(h.base, 'POST', '/api/auth/login', { body: { username: 'wiperec', password: 'wipe-rec-pass' } });
  assert.equal(recLogin.status, 200, 'the recruiter still signs in');
  const recMe = await req(h.base, 'GET', '/api/me', { token: recLogin.json.token });
  assert.equal(recMe.json.wallet.earnings_cents, 0, 'recruiter earnings zeroed');

  let stampAfterWipe;
  readDb(dir, (db) => {
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM wallets
      WHERE credits_cents != 0 OR earnings_cents != 0 OR paid_out_cents != 0`).get().n, 0,
      'EVERY wallet is 0/0/0 — $0 right across');
    assert.equal(db.prepare('SELECT earnings_cents FROM platform_stats WHERE id = 1').get().earnings_cents, 0,
      'platform earnings zeroed');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE is_test = 0').get().n, 0,
      'the whole pre-wipe ledger is flagged is_test=1 (holds included: payout replay reads only is_test=0)');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n, 6,
      'history is flagged, never deleted — all 6 rows remain');
    const wd = db.prepare('SELECT status, decided_at, note FROM withdrawals ORDER BY id').all();
    assert.equal(wd[0].status, 'rejected', 'the pending withdrawal died with the wipe');
    assert.equal(wd[0].note, 'Demo balance cleared 2026-10-21');
    assert.ok(wd[0].decided_at, 'the rejection is timestamped');
    assert.equal(wd[1].status, 'paid', 'an already-paid withdrawal is history — untouched');
    assert.equal(wd[1].note, 'Paid via Novo');
    assert.equal(wd[2].status, 'rejected', 'an already-rejected withdrawal is untouched');
    assert.equal(wd[2].note, 'Old rejection');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 8,
      'no account was deleted (6 fixtures + the mspink AND kaykay delegate seats the server creates at boot — Assignment 01 adds the second seat, so the boot count moves 7 → 8 by design)');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM model_likes WHERE model_id = ?').get(ids.modelId).n, 3,
      'likes are not money — all 3 survive');
    assert.equal(db.prepare('SELECT rank_score FROM models WHERE user_id = ?').get(ids.modelId).rank_score, 3,
      'rank_score keeps exactly its likes (3) and $0 of money (was 45.89)');
    assert.equal(db.prepare('SELECT status FROM id_verifications WHERE model_id = ?').get(ids.modelId).status,
      'approved', 'ID verification untouched');
    stampAfterWipe = db.prepare('SELECT demo_wipe_2026_10_at FROM platform_stats WHERE id = 1').get().demo_wipe_2026_10_at;
    assert.ok(stampAfterWipe, 'the wipe stamp is set');
  });
  stop(h);

  /* ---- Boot 3: idempotence + post-wipe life ---- */
  h = await boot(dir);
  t.after(() => stop(h));
  assert.ok(!h.log().includes('[cleanup] Full demo-money wipe complete'), 'the wipe never runs twice');

  // New money after the wipe counts normally (the first real money must show).
  const adminLogin = await req(h.base, 'POST', '/api/auth/login', { body: { username: 'wipeadmin', password: 'wipe-admin-pass' } });
  assert.equal(adminLogin.status, 200, 'fixture admin signs in');
  const adminAuth = { token: adminLogin.json.token, headers: { 'x-manager': '1' } };

  const newFan = await req(h.base, 'POST', '/api/auth/signup', {
    body: { username: 'newfan', password: 'new-fan-pass', role: 'fan',
            display_name: 'New Fan', dob: '1994-03-03', agree18: true },
  });
  assert.equal(newFan.status, 200, 'post-wipe fan signup works');
  const newModel = await req(h.base, 'POST', '/api/auth/signup', {
    body: { username: 'newmodel', password: 'new-model-pass', role: 'model',
            display_name: 'New Model', dob: '1999-04-04', agree18: true, section: 'female' },
  });
  assert.equal(newModel.status, 200, 'post-wipe model signup works');
  const grant = await req(h.base, 'POST', `/api/admin/fans/${newFan.json.user.id}/credits`, {
    ...adminAuth, body: { amount_cents: 5000 },
  });
  assert.equal(grant.status, 200, 'post-wipe credit grant lands');
  assert.equal(grant.json.balance_cents, 5000, 'new credits are real balance, not wiped retroactively');

  const conv = await req(h.base, 'POST', '/api/conversations/start', {
    token: newFan.json.token, body: { model_id: newModel.json.user.id },
  });
  assert.equal(conv.status, 200, 'post-wipe conversation opens');
  for (const body of ['hi', 'hello', 'hey there', 'nice to meet you']) {
    const sent = await req(h.base, 'POST', '/api/messages', {
      token: newFan.json.token, body: { conversation_id: conv.json.conversation.id, body },
    });
    assert.equal(sent.status, 200, `post-wipe message "${body}" lands`);
  }
  const newModelMe = await req(h.base, 'GET', '/api/me', { token: newModel.json.token });
  assert.equal(newModelMe.json.wallet.earnings_cents, 89,
    'the first post-wipe money shows in her earnings: 60% of the 149¢ paid message');
  const models3 = await req(h.base, 'GET', '/api/models');
  const listedNew = models3.json.models.find((m) => m.username === 'newmodel');
  assert.equal(listedNew.total_sales, 1.49, 'new money counts in derived total_sales');

  stop(h);
  readDb(dir, (db) => {
    assert.equal(db.prepare('SELECT demo_wipe_2026_10_at FROM platform_stats WHERE id = 1').get().demo_wipe_2026_10_at,
      stampAfterWipe, 'the stamp never moved — boot 3 changed nothing about the wipe');
    const live = db.prepare('SELECT type, is_test FROM transactions WHERE is_test = 0 ORDER BY id').all();
    assert.equal(live.length, 2, 'exactly the two post-wipe rows are live money (grant + paid message)');
    assert.deepEqual(live.map((r) => r.type), ['credit_grant', 'message']);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE is_test = 1').get().n, 6,
      'every pre-wipe row stays flagged');
    assert.equal(db.prepare('SELECT rank_score FROM models WHERE user_id = ?').get(newModel.json.user.id).rank_score, 0.89,
      'new model rank = 0 likes + $0.89 of real earnings');
    assert.equal(db.prepare('SELECT rank_score FROM models WHERE user_id = ?').get(ids.modelId).rank_score, 3,
      'wiped model rank still reads likes-only after boot 3');
  });
});

test('wipe skips SEED_DEMO dev fixtures (purge rule): seeded $100 survives, stamp unstamped', { timeout: 90000 }, async (t) => {
  const dir = makeCopy();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const h = await boot(dir, { SEED_DEMO: '1' });
  t.after(() => stop(h));
  assert.ok(!h.log().includes('[cleanup] Full demo-money wipe complete'), 'the wipe does not fire under SEED_DEMO=1');
  const login = await req(h.base, 'POST', '/api/auth/login', { body: { username: 'fandemo', password: 'fan123' } });
  assert.equal(login.status, 200, 'seed fandemo signs in');
  const me = await req(h.base, 'GET', '/api/me', { token: login.json.token });
  assert.equal(me.json.wallet.credits_cents, 10000, 'the dev fixture keeps exactly his $100 — the wipe targets production only');
  stop(h);
  readDb(dir, (db) => {
    assert.equal(db.prepare('SELECT demo_wipe_2026_10_at FROM platform_stats WHERE id = 1').get().demo_wipe_2026_10_at,
      null, 'the marker stays unstamped, so a later non-seed boot of a money DB still gets wiped');
  });
});
