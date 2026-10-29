'use strict';
/*
 * Manager headline counts — ONE ruler (Asce, Oct 26 2026).
 *
 * THE BUG: the Fans tab header counts the rows of GET /api/admin/fans
 * (WHERE role = 'fan' — banned fans included, because the tab must
 * list them to manage/unban them), while the Overview tile, the
 * stats endpoint and the moderator overview counted
 * `role = 'fan' AND banned = 0`. In production that read 65 in the
 * tab vs 64 on Overview — exactly one banned fan. Models carried
 * the same latent mismatch.
 *
 * THE RULE pinned here: the headline fans/models counts on every
 * Manager surface count EVERY account of the role — the same
 * population the Fans and Models lists manage. Banned accounts are
 * accounts of record; their state shows on their rows. The counters
 * moved to the lists' semantics — never the other way (hiding banned
 * accounts from the lists would break ban management). Recipient
 * selection for announcements/blasts keeps its own `banned = 0`
 * filters elsewhere in server.js; those are NOT counts and are not
 * touched by this rule.
 */
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const REPO = path.join(__dirname, '..');
const SERVER_SRC = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');

function blockBetween(startNeedle, endNeedle) {
  const s = SERVER_SRC.indexOf(startNeedle);
  assert.ok(s >= 0, `route exists: ${startNeedle}`);
  const e = SERVER_SRC.indexOf(endNeedle, s);
  assert.ok(e > s, `route block bounded by ${endNeedle}`);
  return SERVER_SRC.slice(s, e);
}

/* ---------------- static pins ---------------- */

test('static: admin overview counts every fan/model account (no banned filter)', () => {
  const block = blockBetween("app.get('/api/admin/overview'", "app.get('/api/admin/stats'");
  assert.ok(block.includes("(SELECT COUNT(*) FROM users WHERE role = 'fan') AS fans"),
    'overview fans = all fan accounts');
  assert.ok(block.includes("(SELECT COUNT(*) FROM users WHERE role = 'model') AS models"),
    'overview models = all model accounts');
  assert.ok(!block.includes("role = 'fan' AND banned = 0"), 'no banned exclusion on fan count');
  assert.ok(!block.includes("role = 'model' AND banned = 0"), 'no banned exclusion on model count');
});

test('static: admin stats counts every fan/model account (no banned filter)', () => {
  const block = blockBetween("app.get('/api/admin/stats'", "app.get('/api/admin/conversations'");
  assert.ok(block.includes("(SELECT COUNT(*) FROM users WHERE role = 'fan') AS fans"),
    'stats fans = all fan accounts');
  assert.ok(block.includes("(SELECT COUNT(*) FROM users WHERE role = 'model') AS models"),
    'stats models = all model accounts');
  assert.ok(!block.includes("role = 'fan' AND banned = 0"), 'no banned exclusion on fan count');
  assert.ok(!block.includes("role = 'model' AND banned = 0"), 'no banned exclusion on model count');
});

test('static: moderator overview counts every fan/model account (no banned filter)', () => {
  const block = blockBetween("app.get('/api/mod/overview'", "app.get('/api/mod/id-verifications'");
  assert.ok(block.includes('one("SELECT COUNT(*) AS c FROM users WHERE role = \'fan\'")'),
    'mod overview fans = all fan accounts');
  assert.ok(block.includes('one("SELECT COUNT(*) AS c FROM users WHERE role = \'model\'")'),
    'mod overview models = all model accounts');
  assert.ok(!block.includes("role = 'fan' AND banned = 0"), 'no banned exclusion on fan count');
  assert.ok(!block.includes("role = 'model' AND banned = 0"), 'no banned exclusion on model count');
});

test('static: the lists themselves are unchanged — banned accounts stay listed', () => {
  const fans = blockBetween("app.get('/api/admin/fans'", "app.post('/api/admin/fans/:id/ban'");
  assert.ok(fans.includes("WHERE u.role = 'fan'"), 'fans list filters on role only');
  const models = blockBetween("app.get('/api/admin/models'", "app.get('/api/admin/models/:id/thread'");
  assert.ok(models.includes("WHERE u.role = 'model'"), 'models list filters on role only');
});

/* ---------------- boot harness (mirrors tests/moneyin-total.test.js) ---------------- */

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function boot(dir) {
  for (const d of ['server.js', 'package.json', 'lib', 'public', 'data']) {
    fs.cpSync(path.join(REPO, d), path.join(dir, d), { recursive: true });
  }
  if (!fs.existsSync(path.join(dir, 'node_modules'))) {
    fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  }
  const port = await freePort();
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(CCBILL_|CRYPTO_|OPENAI_|TWILIO_|VAPID_|WEBAUTHN_)/.test(k)) delete env[k];
  }
  Object.assign(env, { PORT: String(port), SEED_DEMO: '1', CRYPTO_POLL_MS: '3600000' });
  const child = spawn(process.execPath, ['server.js'], { cwd: dir, env });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode})\n${log}`);
    try { const r = await fetch(base + '/api/health'); if (r.ok) break; } catch (e) { /* not up */ }
    if (Date.now() > deadline) throw new Error(`server did not come up\n${log}`);
    await new Promise((r) => setTimeout(r, 150));
  }
  return { dir, base, child, log: () => log,
    async kill() { if (child.exitCode === null) child.kill('SIGKILL'); await new Promise((r) => setTimeout(r, 300)); } };
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

const mgrLogin = async (base) => {
  const adm = await req(base, 'POST', '/api/manager/login', { body: { username: 'admin', password: 'admin123' } });
  assert.equal(adm.status, 200, `manager login: ${adm.text}`);
  return { token: adm.json.token, headers: { 'x-manager': '1' } };
};

function dbCounts(dir) {
  const db = new DatabaseSync(path.join(dir, 'wogent-chat.db'), { readOnly: true });
  const one = (sql) => db.prepare(sql).get().c;
  const out = {
    allFans: one("SELECT COUNT(*) AS c FROM users WHERE role = 'fan'"),
    listedFans: one("SELECT COUNT(*) AS c FROM users u JOIN wallets w ON w.user_id = u.id WHERE u.role = 'fan'"),
    allModels: one("SELECT COUNT(*) AS c FROM users WHERE role = 'model'"),
    listedModels: one(`SELECT COUNT(*) AS c FROM users u JOIN models m ON m.user_id = u.id
                       JOIN wallets w ON w.user_id = u.id WHERE u.role = 'model'`),
  };
  db.close();
  return out;
}

/* ---------------- live scenario ---------------- */

let B = null;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-counts-'));
after(async () => {
  if (B) { try { await B.kill(); } catch (_) { /* already gone */ } }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('live: headline counts equal the account totals and move WITH banned fixtures', { timeout: 180000 }, async () => {
  B = await boot(dir);
  const mgr = await mgrLogin(B.base);

  const readAll = async () => {
    const fans = await req(B.base, 'GET', '/api/admin/fans', { ...mgr });
    const models = await req(B.base, 'GET', '/api/admin/models', { ...mgr });
    const ov = await req(B.base, 'GET', '/api/admin/overview', { ...mgr });
    const stats = await req(B.base, 'GET', '/api/admin/stats', { ...mgr });
    assert.equal(fans.status, 200, `fans: ${fans.text}`);
    assert.equal(models.status, 200, `models: ${models.text}`);
    assert.equal(ov.status, 200, `overview: ${ov.text}`);
    assert.equal(stats.status, 200, `stats: ${stats.text}`);
    return { fans: fans.json.fans, models: models.json.models, ov: ov.json, stats: stats.json };
  };

  const before = await readAll();
  const dbBefore = dbCounts(dir);
  // The rule, at baseline: headlines count every account of the role;
  // the lists return every account their joins cover.
  assert.equal(before.ov.fans, dbBefore.allFans, 'overview fans = ALL fan accounts');
  assert.equal(before.stats.fans, dbBefore.allFans, 'stats fans = ALL fan accounts');
  assert.equal(before.ov.models, dbBefore.allModels, 'overview models = ALL model accounts');
  assert.equal(before.stats.models, dbBefore.allModels, 'stats models = ALL model accounts');
  assert.equal(before.fans.length, dbBefore.listedFans, 'fans list = listed fan accounts');
  assert.equal(before.models.length, dbBefore.listedModels, 'models list = listed model accounts');
  assert.equal(before.ov.fans, before.fans.length,
    'headline and tab agree (every account carries its wallet row)');
  assert.equal(before.ov.models, before.models.length,
    'headline and tab agree for models too');

  // Fixtures: one active + one to-be-banned fan; one active + one
  // to-be-banned model — all through the real signup API.
  const mkFan = async (username) => {
    const r = await req(B.base, 'POST', '/api/auth/signup', {
      body: { username, password: 'count-consistency-pass', role: 'fan',
        display_name: username, dob: '1995-05-05', agree18: true },
    });
    assert.equal(r.status, 200, `fan signup ${username}: ${r.text}`);
    return r.json.user.id;
  };
  const mkModel = async (username) => {
    const r = await req(B.base, 'POST', '/api/auth/signup', {
      body: { username, password: 'count-consistency-pass', role: 'model', publicity_consent: true,
        display_name: username, dob: '1995-05-05', agree18: true, section: 'female' },
    });
    assert.equal(r.status, 200, `model signup ${username}: ${r.text}`);
    return r.json.user.id;
  };
  await mkFan('countfanactive');
  const fanBanned = await mkFan('countfanbanned');
  await mkModel('countmodelactive');
  const modelBanned = await mkModel('countmodelbanned');

  const ban = await req(B.base, 'POST', `/api/admin/fans/${fanBanned}/ban`, { ...mgr, body: {} });
  assert.equal(ban.status, 200, `ban fan: ${ban.text}`);
  const db = new DatabaseSync(path.join(dir, 'wogent-chat.db'));
  db.prepare('UPDATE users SET banned = 1 WHERE id = ?').run(modelBanned);
  db.close();

  const afterFix = await readAll();
  const dbAfter = dbCounts(dir);
  assert.equal(dbAfter.allFans, dbBefore.allFans + 2, 'two fan accounts were added');
  assert.equal(dbAfter.allModels, dbBefore.allModels + 2, 'two model accounts were added');

  // THE regression assertions: with one of the two new accounts of
  // each role BANNED, the old `banned = 0` counters would have risen
  // by only 1. The one-ruler counters rise by the full 2 and still
  // equal both the DB totals and the list lengths.
  assert.equal(afterFix.ov.fans, before.ov.fans + 2, 'overview fans counts the banned fan too');
  assert.equal(afterFix.stats.fans, before.stats.fans + 2, 'stats fans counts the banned fan too');
  assert.equal(afterFix.ov.models, before.ov.models + 2, 'overview models counts the banned model too');
  assert.equal(afterFix.stats.models, before.stats.models + 2, 'stats models counts the banned model too');
  assert.equal(afterFix.ov.fans, dbAfter.allFans, 'overview fans = DB total after fixtures');
  assert.equal(afterFix.ov.models, dbAfter.allModels, 'overview models = DB total after fixtures');
  assert.equal(afterFix.ov.fans, afterFix.fans.length, 'Fans tab and Overview agree');
  assert.equal(afterFix.ov.models, afterFix.models.length, 'Models tab and Overview agree');

  // And the banned accounts remain visible/manageable in the lists.
  const bannedFanRow = afterFix.fans.find((f) => f.id === fanBanned);
  assert.ok(bannedFanRow, 'banned fan still listed in the Fans tab');
  assert.equal(bannedFanRow.banned, 1, 'banned fan row carries its banned state');
  const bannedModelRow = afterFix.models.find((m) => m.id === modelBanned);
  assert.ok(bannedModelRow, 'banned model still listed in the Models tab');
  assert.equal(bannedModelRow.banned, 1, 'banned model row carries its banned state');
});
