'use strict';
/*
 * Rank-change congrats (owner, Oct 19 2026): "When they hear that
 * they are earning the most, they won't wanna stop."
 *
 * When a model climbs INTO a top-3 spot on HER OWN section's ladder —
 * or up within it — she gets ONE congratulatory announcement (DM in
 * her official Notices thread + a 'rank_congrats' bell, in her stored
 * language) celebrating her new title. Holding never re-fires; drops
 * and downward moves never message; dropping out wipes her state so
 * a re-entry fires again. The house is never congratulated.
 *
 * Scenario — likes are the score (1 like = 1 point), driven entirely
 * through the real API so every transition flows through
 * recomputeModelRank → evaluateRankCongrats. Seeded demo models are
 * hidden in the throwaway DB so the female ladder holds ONLY the
 * fixtures (plus two never-liked filler females, who absorb the
 * #2/#3 spots at score 0 before the scripted climbs begin; their own
 * early congrats are realistic tiny-ladder behavior and unasserted).
 *
 *   s1  f1→A          A #1        → A: Queen (1)
 *   s2  f2→A          A holds #1  → A: still 1 (no re-fire)
 *   s2b f1→B          B #2        → B: Princess (1)
 *   s3  f2,f3→B       B #1, A #2  → B: Queen (2); A silent
 *   s4  f3,f4→A       A #1, B #2  → A: Queen (2); B silent
 *   s5  f4,f5→B       B #1, A #2  → B: Queen (3); A silent
 *   s6  f1..f6→Cf     Cf climbs   → Cf: Duchess→Princess→Queen (3 —
 *                                   EVERY upward crossing fires);
 *                                   A pushed to #3, silent
 *   s7  f1..f7→Df     Df climbs   → Df: Duchess→Princess→Queen (3);
 *                                   A falls to #4 — OUT, still
 *                                   silent (A stays 2)
 *   s8  f5..f8→A      A climbs    → A re-enters at #3 (Duchess),
 *                                   rises #2 (Princess), retakes #1
 *                                   (Queen) — 3 more bells, total 5
 *   s9  f1→Cm (male)  Cm male #1  → Cm: King (1); female counts frozen
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

/* ---------------- server harness (ranking.test.js pattern) ---------------- */

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

/* ---------------- DB readers (official-account.test.js pattern) ---------------- */

function dbAll(sql, params = []) {
  const db = new DatabaseSync(path.join(tmpDir, 'wogent-chat.db'), { readOnly: true });
  try { return db.prepare(sql).all(...params); } finally { db.close(); }
}
function dbExec(sql, params = []) {
  // Same lock hardening as per-section-ranking.test.js: this helper
  // writes to the server's live WAL database from a second
  // connection, and a bare write throws SQLITE_BUSY on any collision
  // with a server write (that race cost gate triple3 run 3 all ten
  // per-section tests). Wait for the lock; retry across collisions.
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
    const until = Date.now() + 250 * attempt; // short sync backoff
    while (Date.now() < until) { /* hooks here are sync by design */ }
  }
  throw lastErr;
}
const congratsBells = (userId) => dbAll(
  "SELECT title, body FROM notifications WHERE user_id = ? AND type = 'rank_congrats' ORDER BY id", [userId]);
const congratsDms = (userId) => dbAll(
  `SELECT m.body FROM messages m JOIN conversations c ON c.id = m.conversation_id
   WHERE c.fan_id = ? AND c.is_official = 1 ORDER BY m.id`, [userId])
  .map((r) => r.body)
  .filter((b) => /Queen|Princess|Duchess|King|Prince|Duke|Royal Couple|Power Couple/.test(b));

/* ---------------- scenario ---------------- */

const U = {}; // key → { id, username, token? }
const FANS = [];
const suffix = Math.random().toString(36).slice(2, 8);

async function signupModel(key, username, section) {
  const s = await req('POST', '/api/auth/signup', {
    body: { username, password: 'congrats-pass-1', role: 'model', display_name: 'CG ' + key, dob: '1996-04-12', agree18: true, section },
  });
  assert.equal(s.status, 200, `model signup (${username}) failed: ${s.text}`);
  U[key] = { id: s.json.user.id, username, token: s.json.token };
}
async function like(fanIdx, key) {
  const r = await req('POST', `/api/models/${U[key].id}/like`, { token: FANS[fanIdx].token });
  assert.equal(r.status, 200, `like f${fanIdx + 1}→${key} failed: ${r.text}`);
  assert.equal(r.json.liked, true, `like f${fanIdx + 1}→${key} must be a fresh like, not a toggle-off`);
}

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-rankcongrats-'));
  for (const f of ['server.js', 'package.json']) {
    fs.copyFileSync(path.join(REPO, f), path.join(tmpDir, f));
  }
  for (const d of ['lib', 'public', 'data']) {
    fs.cpSync(path.join(REPO, d), path.join(tmpDir, d), { recursive: true });
  }
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(tmpDir, 'node_modules'), 'dir');
  await boot();

  // The female ladder in this DB holds ONLY the fixtures: the seeded
  // demo models are hidden (the ladder excludes hidden models).
  dbExec("UPDATE models SET is_hidden = 1 WHERE user_id IN (SELECT id FROM users WHERE username IN ('bunny', 'stacey', 'bella'))");

  await signupModel('house', 'asceaaspade', 'female');
  await signupModel('A', 'cga' + suffix, 'female');
  await signupModel('B', 'cgb' + suffix, 'female');
  await signupModel('F3a', 'cgf3a' + suffix, 'female'); // filler — absorbs a
  await signupModel('F3b', 'cgf3b' + suffix, 'female'); // top-3 spot at 0
  await signupModel('Cm', 'cgcm' + suffix, 'male');

  // DETERMINISM PIN — do not remove. The four female fixtures start
  // tied at score 0, and the ladder orders a tie by created_at DESC
  // (then display_name). users.created_at has ONE-SECOND resolution,
  // so the 0-score seating depends on how the signup round-trips
  // happen to straddle wall-clock second boundaries — under gate load
  // that seating varies run to run, and when B lands in the #3 seat
  // she collects a (spec-correct) Duchess bell at test 1's first
  // evaluation, which then cascades through every later exact-count
  // assertion (gate triple2 run 3: 2≠1, 1≠2, 2≠3, 2≠5; reproduced
  // deterministically by forcing that seating). The scenario script
  // below is written against ONE seating — newest-first: F3b and F3a
  // absorb #2/#3, B starts OUTSIDE the top 3 with no recorded hold —
  // so pin the fixtures' created_at to fixed signup-ordered values
  // and make that seating exact on every run, loaded machine or not.
  // Cf and Df sign up later in wall-clock time, so they stay strictly
  // newest and keep winning their ties exactly as the script expects.
  dbExec("UPDATE users SET created_at = '2026-01-01 00:00:01' WHERE id = ?", [U.A.id]);
  dbExec("UPDATE users SET created_at = '2026-01-01 00:00:02' WHERE id = ?", [U.B.id]);
  dbExec("UPDATE users SET created_at = '2026-01-01 00:00:03' WHERE id = ?", [U.F3a.id]);
  dbExec("UPDATE users SET created_at = '2026-01-01 00:00:04' WHERE id = ?", [U.F3b.id]);

  for (let i = 1; i <= 8; i++) {
    const s = await req('POST', '/api/auth/signup', {
      body: { username: 'cgfan' + i + suffix, password: 'congrats-pass-1', role: 'fan', display_name: 'CG Fan ' + i, dob: '1996-04-12', agree18: true },
    });
    assert.equal(s.status, 200, `fan signup ${i} failed: ${s.text}`);
    FANS.push({ token: s.json.token, id: s.json.user.id });
  }
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

test('climb into #1 fires once (Queen); holding the spot does NOT re-fire', async () => {
  await like(0, 'A'); // s1: A = 1 like → female #1
  let bells = congratsBells(U.A.id);
  assert.equal(bells.length, 1, 'entering #1 fires exactly one congrats');
  assert.equal(bells[0].title, '👸 Queen of SlutCamp!');
  assert.ok(bells[0].body.includes('#1 spot'), 'bell body celebrates the #1 spot');
  const dms = congratsDms(U.A.id);
  assert.equal(dms.length, 1, 'one congrats DM in her Notices thread');
  assert.ok(dms[0].includes('Queen of SlutCamp') && dms[0].includes('most earnings and likes'),
    'the DM is the owner-voiced Queen message');
  await like(1, 'A'); // s2: A = 2 likes, still #1
  bells = congratsBells(U.A.id);
  assert.equal(bells.length, 1, 'holding #1 across further likes does NOT re-fire');
  assert.equal(congratsDms(U.A.id).length, 1);
});

test('entering at #2 fires the Princess message; a #2→#1 climb fires the Queen message', async () => {
  await like(0, 'B'); // s2b: B = 1 → #2 (A holds 2)
  let bells = congratsBells(U.B.id);
  assert.equal(bells.length, 1, 'entering the top 3 at #2 fires once');
  assert.equal(bells[0].title, '👸 Princess of SlutCamp!');
  const dm = congratsDms(U.B.id)[0];
  assert.ok(dm.includes('Princess') && dm.includes('second-most earnings and likes'),
    'the #2 DM is the Princess copy');
  await like(1, 'B'); await like(2, 'B'); // s3: B = 3 > A = 2 → B #1, A #2
  bells = congratsBells(U.B.id);
  assert.equal(bells.length, 2, 'the #2→#1 promotion fires the #1 message');
  assert.equal(bells[1].title, '👸 Queen of SlutCamp!');
  assert.equal(congratsBells(U.A.id).length, 1, 'A slid #1→#2: downward — NO message (never punish)');
});

test('lead changes inside the top 3: only the climber is congratulated', async () => {
  await like(2, 'A'); await like(3, 'A'); // s4: A = 4 > B = 3 → A #1, B #2
  assert.equal(congratsBells(U.A.id).length, 2, 'A re-takes #1 and is congratulated');
  assert.equal(congratsBells(U.B.id).length, 2, 'B slid to #2 silently');
  await like(3, 'B'); await like(4, 'B'); // s5: B = 5 > A = 4 → B #1, A #2
  const bells = congratsBells(U.B.id);
  assert.equal(bells.length, 3, 'B takes #1 again — a fresh climb, a fresh congrats');
  assert.deepEqual(bells.map((b) => b.title),
    ['👸 Princess of SlutCamp!', '👸 Queen of SlutCamp!', '👸 Queen of SlutCamp!']);
  assert.equal(congratsBells(U.A.id).length, 2, 'A slid silently again');
});

test('rising pack: every upward crossing fires; the pushed-down hold their silence; falling OUT fires nothing', async () => {
  await signupModel('Cf', 'cgcf' + suffix, 'female');
  for (let i = 0; i < 6; i++) await like(i, 'Cf'); // s6: Cf climbs 1→6 likes, ending #1; B #2, A #3
  const cfBells = congratsBells(U.Cf.id);
  assert.equal(cfBells.length, 3, 'Cf crossed #3, then #2, then #1 — each upward crossing fired once');
  assert.deepEqual(cfBells.map((b) => b.title),
    ['🫅 Duchess of SlutCamp!', '👸 Princess of SlutCamp!', '👸 Queen of SlutCamp!']);
  assert.equal(congratsBells(U.B.id).length, 3, 'B pushed to #2 — silent');
  assert.equal(congratsBells(U.A.id).length, 2, 'A pushed to #3 — silent');
  await signupModel('Df', 'cgdf' + suffix, 'female');
  for (let i = 0; i < 7; i++) await like(i, 'Df'); // s7: Df climbs to #1; Cf #2, B #3, A #4 OUT
  const dfBells = congratsBells(U.Df.id);
  assert.equal(dfBells.length, 3, 'Df crossed #3, then #2, then #1 — each upward crossing fired once');
  assert.deepEqual(dfBells.map((b) => b.title),
    ['🫅 Duchess of SlutCamp!', '👸 Princess of SlutCamp!', '👸 Queen of SlutCamp!']);
  assert.equal(congratsBells(U.A.id).length, 2, 'A fell OUT of the top 3 — dropping never messages');
  const aState = dbAll('SELECT rank_notice_pos FROM models WHERE user_id = ?', [U.A.id])[0];
  assert.equal(aState.rank_notice_pos, null, 'falling out wiped A\u2019s recorded hold — re-entry can fire');
});

test('re-entering the top 3 after falling out fires again — every crossing on the way back up', async () => {
  await like(4, 'A'); await like(5, 'A'); await like(6, 'A'); await like(7, 'A'); // s8: A climbs 4→8 likes
  const bells = congratsBells(U.A.id);
  assert.equal(bells.length, 5,
    'A re-entered at #3, rose to #2, retook #1 — three fresh crossings after her two earlier Queen bells');
  assert.deepEqual(bells.map((b) => b.title), [
    '👸 Queen of SlutCamp!', '👸 Queen of SlutCamp!',
    '🫅 Duchess of SlutCamp!', '👸 Princess of SlutCamp!', '👸 Queen of SlutCamp!',
  ]);
  assert.equal(congratsDms(U.A.id).length, 5, 'one DM per bell, every time');
});

test('per-section isolation: a male climbing the MALE ladder gets the King message; females untouched', async () => {
  const aBefore = congratsBells(U.A.id).length;
  const bBefore = congratsBells(U.B.id).length;
  await like(0, 'Cm'); // s9: Cm = 1 → male #1 (the only male)
  const bells = congratsBells(U.Cm.id);
  assert.equal(bells.length, 1, 'the male climber is congratulated on HIS ladder');
  assert.equal(bells[0].title, '🤴 King of SlutCamp!');
  const dm = congratsDms(U.Cm.id)[0];
  assert.ok(dm.includes('King of SlutCamp') && dm.includes('running the show'),
    'the male #1 DM is the King copy, not the Queen copy');
  assert.equal(congratsBells(U.A.id).length, aBefore, 'female ladder counts frozen by a male event');
  assert.equal(congratsBells(U.B.id).length, bBefore);
});

test('the house account is never congratulated', async () => {
  assert.equal(congratsBells(U.house.id).length, 0, 'no rank_congrats bell for the house, ever');
  assert.equal(congratsDms(U.house.id).length, 0, 'no congrats DM for the house');
  const st = dbAll('SELECT rank_notice_pos FROM models WHERE user_id = ?', [U.house.id])[0];
  assert.equal(st.rank_notice_pos, null, 'the house holds no recorded rank state');
});

/* ---------------- source pins ---------------- */

test('pins: state column, one evaluation funnel, boot arming, SRV copy ×13', () => {
  assert.ok(server.includes("addColumnIfMissing('models', 'rank_notice_pos', 'INTEGER');"),
    'the notified-position state is an additive models column');
  assert.ok(server.includes('function evaluateRankCongrats('), 'the evaluation exists');
  assert.ok(server.includes('function sendRankCongrats('), 'the sender exists');
  assert.ok(server.includes('evaluateRankCongrats(mr.section || \'female\')'),
    'the recompute hook evaluates the recomputed model\u2019s section');
  assert.ok(server.includes('armRankCongrats()'),
    'boot arms the feature only after the silent state sync');
  assert.ok(server.includes("type = 'rank_congrats'") || server.includes("'rank_congrats'"),
    'the bell carries its own notification type');
  for (const sec of ['female', 'male', 'couple']) {
    for (const pos of [1, 2, 3]) {
      assert.ok(server.includes(`rank_congrats_dm_${sec}_${pos}: {`),
        `DM copy exists for ${sec} #${pos}`);
      const row = server.slice(server.indexOf(`rank_congrats_dm_${sec}_${pos}: {`));
      const line = row.slice(0, row.indexOf('\n'));
      for (const lang of ['en', 'es', 'pt', 'fr', 'de', 'ru', 'ja', 'zh', 'ko', 'it', 'pl', 'nl', 'tr']) {
        assert.ok(line.includes(`${lang}: '`), `${sec} #${pos} DM covers ${lang}`);
      }
    }
  }
});
