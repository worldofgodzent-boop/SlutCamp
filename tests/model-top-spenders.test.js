'use strict';
/*
 * Model Top Spenders (Assignment 11, Ms. Pink, Oct 27 2026).
 *
 * ONE shared computation (server.js modelTopSpenders), two surfaces:
 *   1. the model's wallet (Earnings) Top Spenders panel — fan name/@
 *      + total credited spend with her, highest first, fully automatic;
 *   2. her message list — conversations with her top spenders first,
 *      in rank order, after the pinned official thread.
 *
 * What counts: lifetime SUM(transactions.model_cents) per fan — the
 * money actually credited to her. Refunds and chargeback reversals
 * net through negative model_cents; a held package carries 0 until
 * its release row credits her. Excluded: is_test rows, money-in /
 * money-out rows (payout, battle_payout, loads, grants), guest spend
 * (fan_id NULL), non-fan roles, the house account, and the
 * review/test fans (ccbillreview, fandemo, zzpinktest2) — comp
 * creates no earnings rows, and these accounts never rank even
 * where they paid full price.
 *
 * Live tests below boot the real server in a temp dir (same pattern
 * as tests/fake-money-cleanup.test.js): seed boot, stop, fixture
 * rows written straight to the temp DB, reboot, then the real
 * endpoints. Fixture totals are chosen so every exclusion and the
 * refund netting are visible in the asserted numbers, not just in
 * the ordering.
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
const SERVER_JS = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
const APP_JS = fs.readFileSync(path.join(REPO, 'public', 'js', 'app.js'), 'utf8');

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-topspenders-'));
  for (const d of ['server.js', 'package.json', 'lib', 'public', 'data']) {
    fs.cpSync(path.join(REPO, d), path.join(dir, d), { recursive: true });
  }
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  return dir;
}

async function boot(dir) {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), CRYPTO_POLL_MS: '3600000', SEED_DEMO: '1' };
  for (const k of Object.keys(env)) {
    if (/^(CCBILL_|CRYPTO_|OPENAI_|TWILIO_|VAPID_|WEBAUTHN_)/.test(k)) delete env[k];
  }
  env.SEED_DEMO = '1';
  const child = spawn(process.execPath, ['server.js'], { cwd: dir, env });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode})\n${log}`);
    try {
      const r = await fetch(base + '/api/health');
      if (r.ok) break;
    } catch (e) { /* not up yet */ }
    if (Date.now() > deadline) { child.kill('SIGKILL'); throw new Error(`server did not come up\n${log}`); }
    await new Promise((r) => setTimeout(r, 150));
  }
  return { child, base };
}

function stop(handle) {
  if (handle && handle.child && handle.child.exitCode === null) handle.child.kill('SIGKILL');
}

async function req(base, method, p, { body, token } = {}) {
  const h = {};
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

async function login(base, username, password) {
  const r = await req(base, 'POST', '/api/auth/login', { body: { username, password } });
  assert.equal(r.status, 200, `login works for ${username}: ${r.text.slice(0, 200)}`);
  return r.json.token;
}

/* Fixture ledger for model 'topmodel'. Expected ranking:
 *   fanA: tip 6000 + gift 3000 + package_release 1200 - call_refund 600 = 9600
 *   fanB: message 3000 + booking 1800 = 4800
 * Everything else must NOT appear, however large: fanC's is_test tip
 * (99900), fandemo's real tip (50000), zzpinktest2's tip (40000),
 * the house account's tip (80000), a guest tip (70000), and two
 * fanA rows that must not inflate her: a 'payout' row (5000) and a
 * 'ccbill_load' row (9999). */
function seedFixtures(dir) {
  const db = new DatabaseSync(path.join(dir, 'wogent-chat.db'));
  try {
    const addUser = (username, password, role, displayName) => {
      const info = db.prepare(
        'INSERT INTO users (username, password_hash, role, display_name, dob, language) VALUES (?,?,?,?,?,?)')
        .run(username, bcrypt.hashSync(password, 10), role, displayName, '1994-03-03', 'en');
      const id = Number(info.lastInsertRowid);
      db.prepare('INSERT INTO wallets (user_id) VALUES (?)').run(id);
      if (role === 'model') db.prepare('INSERT INTO models (user_id) VALUES (?)').run(id);
      return id;
    };
    const modelId = addUser('topmodel', 'top-pass-1', 'model', 'Top Model');
    const fanA = addUser('fanA', 'fan-pass-1', 'fan', 'Fan Alpha');
    const fanB = addUser('fanB', 'fan-pass-1', 'fan', 'Fan Beta');
    const fanC = addUser('fanC', 'fan-pass-1', 'fan', 'Fan Charlie');
    const zz = addUser('zzpinktest2', 'fan-pass-1', 'fan', 'Zed Test');
    const house = addUser('asceaaspade', 'fan-pass-1', 'model', 'House');
    const fandemo = db.prepare("SELECT id FROM users WHERE username = 'fandemo'").get();
    assert.ok(fandemo, 'seed fandemo exists under SEED_DEMO=1');
    const tx = db.prepare(
      `INSERT INTO transactions (fan_id, model_id, type, gross_cents, model_cents, platform_cents, note)
       VALUES (?,?,?,?,?,?,?)`);
    const spend = (fan, type, gross, model, isTest = 0) => {
      const info = tx.run(fan, modelId, type, gross, model, 0, 'top-spenders fixture');
      if (isTest) db.prepare('UPDATE transactions SET is_test = 1 WHERE id = ?').run(Number(info.lastInsertRowid));
    };
    spend(fanA, 'tip', 10000, 6000);
    spend(fanA, 'gift', 5000, 3000);
    spend(fanA, 'package_release', 0, 1200);
    spend(fanA, 'call_refund', -1000, -600);
    spend(fanB, 'message', 5000, 3000);
    spend(fanB, 'booking', 3000, 1800);
    spend(fanC, 'tip', 166500, 99900, 1);
    spend(fandemo.id, 'tip', 83333, 50000);
    spend(zz, 'tip', 66666, 40000);
    spend(house, 'tip', 133333, 80000);
    spend(null, 'tip', 116666, 70000);
    spend(fanA, 'payout', 0, 5000);
    spend(fanA, 'ccbill_load', 0, 9999);
    // Conversations: recency order alone would put fandemo, then
    // fanC, then fanB, then fanA last. Top-spender ordering must
    // lift fanA, then fanB, above the rest.
    const conv = db.prepare(
      `INSERT INTO conversations (fan_id, model_id, updated_at) VALUES (?,?,?)`);
    conv.run(fanC, modelId, '2026-10-27 12:00:00');
    conv.run(fanB, modelId, '2026-10-27 11:00:00');
    conv.run(fanA, modelId, '2026-10-27 10:00:00');
    conv.run(fandemo.id, modelId, '2026-10-27 13:00:00');
    return { modelId, fanA, fanB, fanC };
  } finally { db.close(); }
}

test('top spenders: ranking, totals, exclusions, and both surfaces', { timeout: 180000 }, async (t) => {
  const dir = makeCopy();
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* temp cleanup */ } });
  let h = await boot(dir);
  stop(h);
  seedFixtures(dir);
  h = await boot(dir);
  t.after(() => stop(h));

  const modelToken = await login(h.base, 'topmodel', 'top-pass-1');
  const fanToken = await login(h.base, 'fanA', 'fan-pass-1');

  const top = await req(h.base, 'GET', '/api/model/top-spenders', { token: modelToken });
  assert.equal(top.status, 200, 'top-spenders endpoint answers for a model');
  assert.equal(top.json.top_spenders.length, 2, 'exactly the two real fans rank');
  const [first, second] = top.json.top_spenders;
  assert.equal(first.username, 'fanA');
  assert.equal(first.display_name, 'Fan Alpha');
  assert.equal(first.spent_cents, 9600, 'fanA net of the refund, payout/load rows excluded');
  assert.equal(first.rank, 1);
  assert.equal(second.username, 'fanB');
  assert.equal(second.spent_cents, 4800);
  assert.equal(second.rank, 2);
  for (const banned of ['fanC', 'fandemo', 'zzpinktest2', 'asceaaspade']) {
    assert.ok(!top.json.top_spenders.some((s) => s.username === banned),
      `${banned} never ranks, however large the fixture spend`);
  }

  const limited = await req(h.base, 'GET', '/api/model/top-spenders?limit=1', { token: modelToken });
  assert.equal(limited.json.top_spenders.length, 1, 'limit=1 returns only the top fan');
  assert.equal(limited.json.top_spenders[0].username, 'fanA');

  const forbidden = await req(h.base, 'GET', '/api/model/top-spenders', { token: fanToken });
  assert.equal(forbidden.status, 403, 'fans cannot read a model\'s top spenders');

  const earn = await req(h.base, 'GET', '/api/model/earnings', { token: modelToken });
  assert.equal(earn.status, 200, 'earnings endpoint still answers');
  assert.deepEqual(
    (earn.json.top_spenders || []).map((s) => s.username),
    ['fanA', 'fanB'],
    'wallet panel uses the SAME ranking as the endpoint (one computation)',
  );

  const convs = await req(h.base, 'GET', '/api/conversations', { token: modelToken });
  assert.equal(convs.status, 200, 'model conversation list answers');
  const mine = (convs.json.conversations || []).filter((c) => c.other && ['fanA', 'fanB', 'fanC', 'fandemo'].includes(c.other.username));
  assert.deepEqual(
    mine.map((c) => c.other.username),
    ['fanA', 'fanB', 'fandemo', 'fanC'],
    'top spenders first in rank order, the rest keep recency order',
  );
  assert.equal(mine[0].is_top_spender, true, 'top conversation is flagged');
  assert.equal(mine[0].top_spender_rank, 1);
  assert.equal(mine[1].top_spender_rank, 2);
  assert.equal(mine[2].is_top_spender, false, 'excluded fan is not flagged');
  assert.equal(mine[3].is_top_spender, false, 'test-money fan is not flagged');
});

/* ---------------- source pins: both client surfaces exist ---------------- */

test('client: wallet panel renders from data.top_spenders, message list marks top spenders', () => {
  assert.ok(APP_JS.includes('Top Spenders'), 'Earnings screen carries a Top Spenders panel');
  assert.ok(APP_JS.includes('data.top_spenders'), 'panel reads the shared ranking from /model/earnings');
  assert.ok(APP_JS.includes('fmt(s.spent_cents)'), 'panel shows the credited total per fan');
  assert.ok(APP_JS.includes('c.is_top_spender'), 'chat list marks top-spender rows');
  assert.ok(APP_JS.includes('Top spender'), 'chat list pill label present');
});

test('server: one shared ranking feeds the endpoint, earnings, and conversation order', () => {
  assert.ok(SERVER_JS.includes('function modelTopSpenders('), 'shared ranking function exists');
  assert.ok(SERVER_JS.includes("app.get('/api/model/top-spenders'"), 'standalone endpoint exists');
  assert.ok(SERVER_JS.includes('top_spenders: modelTopSpenders('), 'earnings response carries the ranking');
  assert.ok(SERVER_JS.includes('topSpenderRankByFan'), 'conversation route reorders by the ranking');
  assert.ok(SERVER_JS.includes('is_top_spender'), 'conversation rows flag top spenders for the model viewer');
});
