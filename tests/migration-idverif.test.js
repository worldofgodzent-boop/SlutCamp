'use strict';
/*
 * Regression: the Phase 2 (co-performers) id_verifications migration
 * must upgrade a LIVED-IN database, not just boot fresh ones.
 *
 * Production crash (Oct 19, 2026, PR #65 deploy): the new build died
 * at startup against the production database with
 *   server.js:1576  Error: no such column: co_performer_id
 * while the full suite (which always boots brand-new databases, where
 * CREATE TABLE lays down the new DDL) passed clean. Two defects:
 *
 *  1. ORDERING — the schema block creates the partial unique index
 *     `... WHERE co_performer_id IS NULL` inline, but on a database
 *     created by pre-Phase-2 code the CREATE TABLE IF NOT EXISTS is
 *     a no-op: the table keeps its shipped shape (model_id UNIQUE,
 *     no co_performer_id) and the index statement kills the boot.
 *     The rebuild migration that adds the column sat AFTER the block
 *     and was never reached. It now runs BEFORE the schema block.
 *
 *  2. FOREIGN KEYS — the rebuild's row-copy INSERT targets a table
 *     whose co_performer_id references co_performers, a table the
 *     schema block creates only afterwards; with the connection's
 *     PRAGMA foreign_keys=ON the INSERT dies with "no such table:
 *     main.co_performers" (even with every copied value NULL). The
 *     rebuild now runs with foreign_keys OFF/ON around it, the same
 *     pattern as the allowRecruiterRole rebuild.
 *
 * The fixture below reproduces the pre-Phase-2 database state the way
 * the brief prescribes: boot once (seeded) so every other table has
 * its real shape, then surgically return id_verifications to the
 * pre-Phase-2 DDL — copied verbatim from server.js at commit
 * f4f4dc71 (PR #64, the last pre-Phase-2 build; the DDL is unchanged
 * since the table was introduced in 9d064da) — holding one approved
 * row that must survive the upgrade byte-for-byte.
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

/* The pre-Phase-2 id_verifications DDL, verbatim from server.js at
 * f4f4dc71 (the CREATE TABLE the production database was built by). */
const OLD_ID_VERIFICATIONS_DDL = `
CREATE TABLE id_verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
  id_front_path TEXT,
  id_back_path TEXT,
  selfie_path TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at TEXT,
  reviewer_note TEXT NOT NULL DEFAULT ''
)`;

const KEEP_ROW = {
  id_front_path: 'private/id_verification/bunny_front.png',
  id_back_path: 'private/id_verification/bunny_back.png',
  selfie_path: 'private/id_verification/bunny_selfie.png',
  status: 'approved',
  submitted_at: '2026-10-10 12:00:00',
  reviewed_at: '2026-10-11 09:30:00',
  reviewer_note: 'UPGRADE-KEEP-ME',
};

/* ------------------------------ harness ------------------------------ */

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
function makeCopy(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `slutcamp-${tag}-`));
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
function openDb(dir, readOnly = true) {
  const __db = new DatabaseSync(path.join(dir, 'wogent-chat.db'), readOnly ? { readOnly: true } : {});
  __db.exec('PRAGMA busy_timeout = 10000');
  return __db;
}

/* Boot the copy once (seeded), then return id_verifications to its
 * pre-Phase-2 shape with one approved row for bunny. When keepCoPerformers
 * is set, the co_performers table + a partner row survive — the partial
 * state a crashed first Phase-2 boot leaves behind. */
async function makeOldDatabase(tag, { keepCoPerformers = false } = {}) {
  const dir = makeCopy(tag);
  let h = await boot(dir, { SEED_DEMO: '1' });
  stop(h); h = null;
  const db = openDb(dir, false);
  const bunny = db.prepare("SELECT id FROM users WHERE username = 'bunny'").get();
  assert.ok(bunny, 'seeded model bunny exists');
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('ALTER TABLE id_verifications RENAME TO id_verifications_newshape');
  db.exec(OLD_ID_VERIFICATIONS_DDL);
  db.prepare(`INSERT INTO id_verifications
      (model_id, id_front_path, id_back_path, selfie_path, status, submitted_at, reviewed_at, reviewer_note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(bunny.id, KEEP_ROW.id_front_path, KEEP_ROW.id_back_path, KEEP_ROW.selfie_path,
      KEEP_ROW.status, KEEP_ROW.submitted_at, KEEP_ROW.reviewed_at, KEEP_ROW.reviewer_note);
  db.exec('DROP TABLE id_verifications_newshape');
  db.exec('CREATE INDEX idx_id_verifications_status ON id_verifications(status)');
  let partnerId = null;
  if (keepCoPerformers) {
    partnerId = Number(db.prepare(
      "INSERT INTO co_performers (owner_model_id, display_name, gender, dob, status) VALUES (?, 'Pre-existing Partner', 'female', '1996-03-04', 'pending')"
    ).run(bunny.id).lastInsertRowid);
  } else {
    db.exec('DROP TABLE IF EXISTS co_performers');
  }
  const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='id_verifications'").get().sql;
  assert.match(ddl, /model_id\s+INTEGER\s+NOT\s+NULL\s+UNIQUE/i, 'fixture really carries the old shape');
  assert.ok(!/co_performer_id/i.test(ddl), 'fixture has no co_performer_id');
  db.close();
  return { dir, bunnyId: bunny.id, partnerId };
}

function assertUpgradedShape(dir, bunnyId) {
  const db = openDb(dir);
  const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='id_verifications'").get().sql;
  assert.match(ddl, /co_performer_id/, 'upgraded DDL carries co_performer_id');
  assert.ok(!/model_id\s+INTEGER\s+NOT\s+NULL\s+UNIQUE/i.test(ddl), 'blanket UNIQUE on model_id is gone');
  const row = db.prepare('SELECT * FROM id_verifications WHERE model_id = ? AND co_performer_id IS NULL').get(bunnyId);
  assert.ok(row, 'the pre-existing own row survived');
  for (const [k, v] of Object.entries(KEEP_ROW)) assert.equal(row[k], v, `row field ${k} preserved verbatim`);
  const ownIdx = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_id_verifications_own'").get();
  assert.ok(ownIdx && /UNIQUE/i.test(ownIdx.sql) && /WHERE\s+co_performer_id IS NULL/i.test(ownIdx.sql),
    'partial unique index exists with its WHERE clause');
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_id_verifications_status'").get(),
    'status index exists');
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='co_performers'").get(),
    'co_performers table exists after upgrade');
  db.close();
}

function assertPartnerRowWorks(dir, bunnyId, partnerId) {
  const db = openDb(dir, false);
  let pid = partnerId;
  if (!pid) {
    pid = Number(db.prepare(
      "INSERT INTO co_performers (owner_model_id, display_name, gender, dob, status) VALUES (?, 'Upgrade Partner', 'female', '1996-03-04', 'approved')"
    ).run(bunnyId).lastInsertRowid);
  }
  db.prepare("INSERT INTO id_verifications (model_id, co_performer_id, status) VALUES (?, ?, 'approved')").run(bunnyId, pid);
  const prow = db.prepare('SELECT * FROM id_verifications WHERE co_performer_id = ?').get(pid);
  assert.ok(prow && prow.model_id === bunnyId, 'a partner verification row can be inserted after upgrade');
  assert.throws(
    () => db.prepare("INSERT INTO id_verifications (model_id, status) VALUES (?, 'pending')").run(bunnyId),
    /UNIQUE/i, 'a second OWN row for the same model is still refused');
  db.close();
}

/* ------------------------------- tests ------------------------------- */

test('source: the partner rebuild migration runs BEFORE the schema block, FK-wrapped', () => {
  const migAt = serverSrc.indexOf('One-time migration (Sections Phase 2)');
  const schemaAt = serverSrc.indexOf('CREATE TABLE IF NOT EXISTS id_verifications');
  assert.ok(migAt !== -1 && schemaAt !== -1, 'migration and schema block both present');
  assert.ok(migAt < schemaAt,
    'migration precedes the schema block whose partial index references co_performer_id');
  const mig = serverSrc.slice(migAt, serverSrc.indexOf('// Model contract signatures', migAt));
  assert.ok(mig.indexOf('PRAGMA foreign_keys=OFF') !== -1
    && mig.indexOf('PRAGMA foreign_keys=OFF') < mig.indexOf('CREATE TABLE id_verifications_partner'),
  'foreign_keys is OFF before the rebuild (co_performers does not exist yet at copy time)');
  assert.ok(mig.indexOf('PRAGMA foreign_keys=ON') > mig.indexOf('CREATE TABLE id_verifications_partner'),
    'foreign_keys is restored after the rebuild');
});

test('upgrade: a pre-Phase-2 database boots, keeps its rows, gains the partner shape — twice', { timeout: 300000 }, async () => {
  const { dir, bunnyId } = await makeOldDatabase('migup');
  let h = null;
  try {
    h = await boot(dir);
    const health = await fetch(h.base + '/api/health');
    assert.equal(health.status, 200, '/api/health answers after the upgrade boot');
    stop(h); h = null;
    assertUpgradedShape(dir, bunnyId);
    assertPartnerRowWorks(dir, bunnyId, null);
    h = await boot(dir);
    const health2 = await fetch(h.base + '/api/health');
    assert.equal(health2.status, 200, 'second boot of the upgraded database also succeeds (idempotent)');
    stop(h); h = null;
    assertUpgradedShape(dir, bunnyId);
  } finally { stop(h); }
});

test('upgrade: the partial state (co_performers present, id_verifications still old) also boots clean', { timeout: 300000 }, async () => {
  const { dir, bunnyId, partnerId } = await makeOldDatabase('migpartial', { keepCoPerformers: true });
  let h = null;
  try {
    h = await boot(dir);
    const health = await fetch(h.base + '/api/health');
    assert.equal(health.status, 200, '/api/health answers after the partial-state upgrade boot');
    stop(h); h = null;
    assertUpgradedShape(dir, bunnyId);
    assertPartnerRowWorks(dir, bunnyId, partnerId);
  } finally { stop(h); }
});
