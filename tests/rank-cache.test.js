'use strict';
/*
 * F1 rank-position cache (traffic prep, Oct 23 2026).
 *
 * computeSectionRankPositions() used to run its full-roster pass on
 * EVERY read — GET /api/models, every public page render, every
 * rank-congrats evaluation (production Pro load test: /api/models p50
 * 4.4s / 7.8s / 12.4s at 100 / 300 / 600 concurrent). The derivation
 * now caches its Map and serves it only while provably fresh:
 *   1. no audited server-side writer of a rank input has run,
 *   2. PRAGMA data_version is unchanged (no OTHER connection has
 *      committed a write since the compute), and
 *   3. the Map is younger than the 60s TTL backstop.
 *
 * These tests pin the contract that makes the cache SAFE, not the
 * cache itself: positions must reflect a mutation on the very next
 * read, through every invalidation channel —
 *   - a fan like (recomputeModelRank funnel),
 *   - a write committed by a SECOND connection straight into the DB
 *     file (the official-account.test.js direct-SQL pattern),
 *   - an admin section move (she changes ladders).
 * Ordering semantics are pinned by per-section-ranking.test.js and
 * ranking.test.js; nothing here re-litigates them.
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
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const server = read('server.js');

/* ---------------- server harness (per-section-ranking pattern) ---------------- */

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

async function req(method, p, { body, token, headers } = {}) {
  const h = { ...(headers || {}) };
  if (body !== undefined) h['content-type'] = 'application/json';
  if (token) h.authorization = 'Bearer ' + token;
  const r = await fetch(base + p, {
    method,
    headers: h,
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

async function boot() {
  let lastErr = null;
  for (let attempt = 1; attempt <= 3 && !base; attempt++) {
    const port = await freePort();
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
    }
  }
  if (!base) throw lastErr || new Error('server failed to boot after 3 attempts');
}

function dbExec(sql, params = []) {
  // Second-connection write with lock tolerance (same harness pattern
  // as per-section-ranking.test.js).
  let lastErr = null;
  for (let attempt = 1; attempt <= 6; attempt++) {
    const db = new DatabaseSync(path.join(tmpDir, 'wogent-chat.db'));
    try {
      db.exec('PRAGMA busy_timeout = 10000');
      db.prepare(sql).run(...params);
      return;
    } catch (e) {
      lastErr = e;
      if (!/locked|busy/i.test(String(e && e.message))) throw e;
    } finally { db.close(); }
    const until = Date.now() + 250 * attempt;
    while (Date.now() < until) { /* sync backoff by design */ }
  }
  throw lastErr;
}

/* ---------------- scenario ---------------- */

const M = {}; // key → { id, username }
let fan = null;

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-rankcache-'));
  for (const f of ['server.js', 'package.json']) {
    fs.copyFileSync(path.join(REPO, f), path.join(tmpDir, f));
  }
  for (const d of ['lib', 'public', 'data']) {
    fs.cpSync(path.join(REPO, d), path.join(tmpDir, d), { recursive: true });
  }
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(tmpDir, 'node_modules'), 'dir');
  await boot();

  const suffix = Math.random().toString(36).slice(2, 8);
  const signupModel = async (key, username, display) => {
    const s = await req('POST', '/api/auth/signup', {
      body: { username, password: 'rankcache-pass-1', role: 'model', publicity_consent: true, display_name: display, dob: '1996-04-12', agree18: true, section: 'female' },
    });
    assert.equal(s.status, 200, `model signup (${username}) failed: ${s.text}`);
    M[key] = { id: s.json.user.id, username };
  };
  // A signs up first, B second: at 0 score / 0 likes / both offline,
  // the ordering chain's created_at-DESC tiebreak puts B (newer) above
  // A. The seeded demo models share the 0/0 state and sit on the same
  // ladder — every assertion below is about A vs B (and B vs the top),
  // never about absolute mid-pack numbers.
  await signupModel('a', 'rca' + suffix, 'RC A');
  await signupModel('b', 'rcb' + suffix, 'RC B');
  // Determinism pin (gate run 2 flake, 2026-10-23): users.created_at
  // defaults to datetime('now') — SECOND resolution — so two signups
  // inside one wall-clock second tie exactly, and the ladder's final
  // display_name-ASC tiebreak then puts A ("RC A") above B, breaking
  // the 0/0 precondition below. Pin explicit created_at values (B one
  // day newer) through the second-connection channel so the intended
  // tiebreak scenario holds regardless of the clock.
  dbExec('UPDATE users SET created_at = ? WHERE id = ?', ['2026-01-01 00:00:00', M.a.id]);
  dbExec('UPDATE users SET created_at = ? WHERE id = ?', ['2026-01-02 00:00:00', M.b.id]);

  const f = await req('POST', '/api/auth/signup', {
    body: { username: 'rcfan' + suffix, password: 'rankcache-pass-1', role: 'fan', display_name: 'RC Fan', dob: '1995-01-01', agree18: true },
  });
  assert.equal(f.status, 200, `fan signup failed: ${f.text}`);
  fan = { id: f.json.user.id, token: f.json.token };
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

async function positions() {
  const r = await req('GET', '/api/models?tab=all');
  assert.equal(r.status, 200, r.text);
  const byId = new Map(r.json.models.map((m) => [m.id, m.rank_position]));
  return { a: byId.get(M.a.id), b: byId.get(M.b.id), raw: r.json };
}

/* ---------------- the cache contract ---------------- */

test('baseline: repeated reads serve identical positions', async () => {
  const first = await positions();
  assert.ok(Number.isInteger(first.a) && Number.isInteger(first.b), 'both models carry positions');
  assert.ok(first.b < first.a, 'tie at 0/0: the newer signup (B) outranks A on the created_at tiebreak');
  const second = await positions();
  assert.equal(second.a, first.a, 'second read serves the same position for A');
  assert.equal(second.b, first.b, 'second read serves the same position for B');
});

test('a fan like is reflected on the very next read (dirty-flag invalidation)', async () => {
  const before = await positions();
  assert.ok(before.b < before.a, 'precondition: B above A');
  const like = await req('POST', `/api/models/${M.a.id}/like`, { token: fan.token, body: {} });
  assert.equal(like.status, 200, like.text);
  const after = await positions();
  assert.ok(after.a < after.b,
    'one like (score 1) lifts A above B immediately — a stale cache would still show B on top');
});

test('a write from a SECOND connection is reflected on the next read (data_version)', async () => {
  // Direct SQL into the DB file while the server runs — the server
  // process never sees a function call for this write; only the
  // data_version fingerprint can catch it.
  dbExec('UPDATE models SET rank_score = 500 WHERE user_id = ?', [M.b.id]);
  const topped = await positions();
  assert.equal(topped.b, 1, 'B at score 500 tops the female ladder on the next read');
  assert.ok(topped.a > topped.b, 'A sits below B');
  dbExec('UPDATE models SET rank_score = 0 WHERE user_id = ?', [M.b.id]);
  const restored = await positions();
  assert.ok(restored.a < restored.b,
    'restoring B to 0 is picked up too — A (1 like) is back above B');
});

test('an admin section move is reflected on the next read', async () => {
  const login = await req('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' } });
  assert.equal(login.status, 200, login.text);
  const move = await req('PATCH', `/api/admin/models/${M.b.id}/section`, {
    token: login.json.token, body: { section: 'male' }, headers: { 'x-manager': '1' },
  });
  assert.equal(move.status, 200, move.text);
  const after = await positions();
  assert.equal(after.b, 1, 'B is now the lone model on the male ladder — position 1 there, not her old female spot');
  assert.ok(Number.isInteger(after.a), 'A still carries her female-ladder position');
});

test('static: the cache machinery is present in server.js', () => {
  assert.ok(server.includes('function computeSectionRankPositions()'),
    'the shared derivation still exists under its pinned name');
  assert.ok(server.includes('function invalidateRankPositions()'),
    'the invalidator exists');
  assert.ok(server.includes('RANK_POSITIONS_TTL_MS'),
    'the TTL backstop constant exists');
  const sites = server.split('invalidateRankPositions();').length - 1;
  assert.ok(sites >= 10, `invalidation is wired at the audited writer set (found ${sites} call sites)`);
});
