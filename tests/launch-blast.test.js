'use strict';
/*
 * Launch-readiness warning blast (Assignment 18, Part 2, Oct 28
 * 2026) — the stamp-guarded boot-sweep blast that warns every
 * model she must be ID-verified and have a profile picture or be
 * hidden on launch day. Same machinery as the launch-update /
 * clean-feed blasts (platform_stats stamp, announcementThreadFor
 * DM + notifyUser bell, SRV copy x13), with the one difference
 * that is the point of the build: the sweep is DORMANT while the
 * Part 1 launch gate is OFF — it returns before any send and
 * before the stamp, so the first boot that observes the flag ON
 * (Asce's launch-day flip) fires it exactly once and stamps.
 *
 * The EN DM is the Ms. Pink-approved text verbatim (approved in
 * the Team channel, Oct 28 3:47 AM). The bell title/body are new
 * short strings in the launch-update bell pattern (there was no
 * separate approved bell text).
 *
 * Harness: the tests/launch-flag.test.js pattern — boot the real
 * server from a temp copy, fixtures by real signup, then kill →
 * DB-surgery → reboot steps. The flag is set by surgery here
 * because the sweep reads it at boot (the Manager flip route and
 * its live read are pinned by tests/launch-flag.test.js).
 *
 * Fixtures:
 *   warnen<sfx>  — model, English: gets the EN blast.
 *   warnes<sfx>  — model, (surgery) language 'es': gets the ES blast.
 *   warnban<sfx> — model, (surgery) banned = 1: gets nothing.
 *   warnfan<sfx> — fan: gets nothing.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const REPO = path.join(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');

const LANG13 = ['en', 'es', 'pt', 'fr', 'de', 'ru', 'ja', 'zh', 'ko', 'it', 'pl', 'nl', 'tr'];

const APPROVED_DM = "Launch day is coming. If you're not ID-verified and you don't have a profile picture up, you will be hidden when we launch — no directory, no feed, no search. Get both done now so you're seen and earning from day one.";
const BELL_TITLE_EN = "🚨 Don't get hidden at launch";
const BELL_BODY_EN = "ID + profile picture — do both now, or you're hidden on launch day.";

/* Extract a top-level const object block from server.js and evaluate
   it in a vm (same brace-matching approach as launch-update-blast). */
function literalSpan(src, marker) {
  const i = src.indexOf(marker);
  assert.ok(i >= 0, 'marker found: ' + marker);
  let j = src.indexOf('{', i), depth = 0, k = j, inStr = null, esc = false, inTpl = false, td = 0;
  for (; k < src.length; k++) {
    const c = src[k];
    if (inTpl) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '$' && src[k + 1] === '{') { td++; k++; continue; }
      if (c === '}' && td > 0) { td--; continue; }
      if (c === '`' && td === 0) inTpl = false;
      continue;
    }
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '`') { inTpl = true; continue; }
    if (c === "'" || c === '"') { inStr = c; continue; }
    if (c === '{') depth++;
    if (c === '}') { depth--; if (depth === 0) return [j, k + 1]; }
  }
  throw new Error('unbalanced: ' + marker);
}
function evalConst(src, marker) {
  const [s, e] = literalSpan(src, marker);
  const name = marker.replace('const ', '').replace(' =', '').trim();
  const sb = {};
  vm.createContext(sb);
  vm.runInContext(marker + ' ' + src.slice(s, e) + `;\nthis.__v = ${name};`, sb);
  return sb.__v;
}
const SRV = evalConst(serverSrc, 'const SRV =');
const ALL_BODIES = LANG13.map((l) => SRV.ann_launchwarn_dm[l]);

/* ---------------- static pins ---------------- */

test('launch warning: DM copy exists in all 13 languages, EN is the approved text verbatim', () => {
  const row = SRV.ann_launchwarn_dm;
  assert.ok(row, 'ann_launchwarn_dm exists in the SRV table');
  assert.deepEqual(Object.keys(row).sort(), [...LANG13].sort(), 'ann_launchwarn_dm covers exactly the 13 languages');
  assert.equal(row.en, APPROVED_DM, 'EN DM is the Ms. Pink-approved text, verbatim');
  for (const lang of LANG13) {
    assert.equal(typeof row[lang], 'string', `${lang} is a string`);
    assert.ok(row[lang].trim().length >= 60, `${lang} carries the full warning, not a stub`);
    if (lang !== 'en') assert.notEqual(row[lang], row.en, `${lang} is a real translation, not the EN text`);
  }
});

test('launch warning: bell title/body exist in all 13 languages', () => {
  assert.equal(SRV.ann_launchwarn_bell_title.en, BELL_TITLE_EN, 'EN bell title pinned');
  assert.equal(SRV.ann_launchwarn_bell_body.en, BELL_BODY_EN, 'EN bell body pinned');
  for (const key of ['ann_launchwarn_bell_title', 'ann_launchwarn_bell_body']) {
    const row = SRV[key];
    assert.ok(row, `${key} exists in the SRV table`);
    assert.deepEqual(Object.keys(row).sort(), [...LANG13].sort(), `${key} covers exactly the 13 languages`);
    for (const lang of LANG13) {
      assert.ok(row[lang].trim().length > 0, `${key}:${lang} non-empty`);
      if (lang !== 'en') assert.notEqual(row[lang], row.en, `${key}:${lang} is translated`);
    }
  }
});

test('launch warning: stamp column + dormant wiring in server source', () => {
  assert.ok(serverSrc.includes("addColumnIfMissing('platform_stats', 'launch_warning_announced_at', 'TEXT')"),
    'one-time stamp column declared');
  assert.ok(serverSrc.includes('function announceLaunchWarningToModels()'), 'broadcast function exists');
  const start = serverSrc.indexOf('function announceLaunchWarningToModels()');
  const end = serverSrc.indexOf('\n}\n', start);
  const block = serverSrc.slice(start, end);
  assert.ok(block.includes('SELECT launch_warning_announced_at FROM platform_stats WHERE id = 1'),
    'block checks the stamp first');
  const gateAt = block.indexOf('launchGateEnabled()');
  const insertAt = block.indexOf('INSERT INTO messages');
  const stampAt = block.indexOf('UPDATE platform_stats SET launch_warning_announced_at');
  assert.ok(gateAt >= 0, 'block consults the launch gate');
  assert.ok(insertAt >= 0 && gateAt < insertAt, 'the flag gate stands before any send — dormant while OFF');
  assert.ok(stampAt > insertAt, 'stamp is set only after the broadcast loop');
  assert.ok(gateAt < stampAt, 'the flag gate stands before the stamp — an OFF boot never stamps');
  assert.ok(block.includes("role = 'model' AND banned = 0"), 'recipients are all unbanned models');
  assert.ok(block.includes("announcementThreadFor(m.id, 'model', admin.id)"),
    'DM lands via announcementThreadFor, like the precedent broadcasts');
  assert.ok(block.includes("srv('ann_launchwarn_dm', m.language)"), 'DM copy is localized per model');
  assert.ok(block.includes("notifyUser(m.id, 'launchwarn', srv('ann_launchwarn_bell_title', m.language)"),
    'bell fires with the localized title');
  assert.ok(block.includes("srv('ann_launchwarn_bell_body', m.language), `/#chat/${conv.id}`"),
    'bell body localized and opens the thread itself');
  const luCall = serverSrc.indexOf('const n = announceLaunchUpdateToModels()');
  const lwCall = serverSrc.indexOf('const n = announceLaunchWarningToModels()');
  assert.ok(luCall >= 0 && lwCall > luCall, 'boot sweep calls the warning blast after the launch-update call');
});

/* ---------------- boot harness (mirrors launch-flag) ---------------- */

let tmpDir = null;
let child = null;
let base = null;
let childLog = '';
const F = {};

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
    method, headers: h,
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
  for (let attempt = 1; attempt <= 3; attempt++) {
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
      return;
    } catch (e) {
      lastErr = e;
      base = null;
      if (child && child.exitCode === null) child.kill('SIGKILL');
      child = null;
    }
  }
  throw lastErr || new Error('server failed to boot after 3 attempts');
}

async function killServer() {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((r) => child.once('exit', r)),
      new Promise((r) => setTimeout(r, 5000)),
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  child = null;
}

function readDb() {
  return new DatabaseSync(path.join(tmpDir, 'wogent-chat.db'), { readOnly: true });
}
function writeDb(fn) {
  const db = new DatabaseSync(path.join(tmpDir, 'wogent-chat.db'));
  db.exec('PRAGMA busy_timeout = 10000');
  fn(db);
  db.close();
}
const stampOf = (db) => db.prepare('SELECT launch_warning_announced_at AS s FROM platform_stats WHERE id = 1').get().s;
function blastMsgs(db, userId) {
  const ph = ALL_BODIES.map(() => '?').join(',');
  return db.prepare(
    `SELECT m.body, m.conversation_id FROM messages m JOIN conversations c ON c.id = m.conversation_id
     WHERE (c.model_id = ? OR c.fan_id = ?) AND m.body IN (${ph})`
  ).all(userId, userId, ...ALL_BODIES);
}
const blastBells = (db, userId) => db.prepare(
  "SELECT title, body, link FROM notifications WHERE user_id = ? AND type = 'launchwarn'"
).all(userId);

async function mkUser(username, role) {
  const body = { username, password: 'warn-pass-123', role, publicity_consent: true, display_name: username, dob: '1996-04-12', agree18: true };
  if (role === 'model') body.section = 'female';
  const s = await req('POST', '/api/auth/signup', { body });
  assert.equal(s.status, 200, `signup ${username} failed: ${s.text}`);
  return { username, id: s.json.user.id, token: s.json.token };
}

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-launchblast-'));
  for (const f of ['server.js', 'package.json']) {
    fs.copyFileSync(path.join(REPO, f), path.join(tmpDir, f));
  }
  for (const d of ['lib', 'public', 'data']) {
    fs.cpSync(path.join(REPO, d), path.join(tmpDir, d), { recursive: true });
  }
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(tmpDir, 'node_modules'), 'dir');

  await boot(); // boot 1: flag OFF (default) — the sweep runs dormant
  const suffix = Math.random().toString(36).slice(2, 8);
  F.en = await mkUser('warnen' + suffix, 'model');
  F.es = await mkUser('warnes' + suffix, 'model');
  F.ban = await mkUser('warnban' + suffix, 'model');
  F.fan = await mkUser('warnfan' + suffix, 'fan');
});

test.after(async () => {
  await killServer();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

/* ---------------- OFF: dormant, and an OFF boot never stamps ------ */

test('flag OFF: the boot-1 sweep sent nothing and did not stamp', async () => {
  await killServer();
  const db = readDb();
  assert.equal(stampOf(db), null, 'no stamp after a boot with the flag OFF');
  db.close();
});

test('flag OFF with models present: a second OFF boot still sends nothing and does not stamp', async () => {
  await boot(); // boot 2: fixtures now exist, flag still OFF
  await killServer();
  const db = readDb();
  assert.equal(stampOf(db), null, 'an OFF boot with models present must not stamp — the launch-day flip still has to fire it');
  for (const u of [F.en, F.es, F.ban, F.fan]) {
    assert.equal(blastMsgs(db, u.id).length, 0, `${u.username} got no warning DM while OFF`);
    assert.equal(blastBells(db, u.id).length, 0, `${u.username} got no warning bell while OFF`);
  }
  db.close();
});

/* ---------------- surgery: language, ban, flag ON ----------------- */

test('surgery: Spanish language for one model, a ban for another, the flag ON', async () => {
  writeDb((db) => {
    const col = db.prepare("SELECT name FROM pragma_table_info('platform_stats') WHERE name = 'launch_warning_announced_at'").get();
    assert.ok(col, 'the launch_warning_announced_at column was migrated in at boot');
    db.prepare("UPDATE users SET language = 'es' WHERE id = ?").run(F.es.id);
    db.prepare('UPDATE users SET banned = 1 WHERE id = ?').run(F.ban.id);
    db.prepare('UPDATE platform_stats SET launch_gate_enabled = 1 WHERE id = 1').run();
  });
});

/* ---------------- ON: fires once, in her language ----------------- */

test('flag ON at boot: exactly one blast per eligible model, in her language; banned and fans get nothing', async () => {
  await boot(); // boot 3: the first boot to observe the flag ON
  await killServer();
  const db = readDb();
  assert.ok(stampOf(db), 'the stamp is set after the firing boot');

  const enMsgs = blastMsgs(db, F.en.id);
  assert.equal(enMsgs.length, 1, 'EN model got exactly one warning DM');
  assert.equal(enMsgs[0].body, APPROVED_DM, 'EN model got the approved text verbatim');
  const enBells = blastBells(db, F.en.id);
  assert.equal(enBells.length, 1, 'EN model got exactly one warning bell');
  assert.equal(enBells[0].title, SRV.ann_launchwarn_bell_title.en, 'EN bell title');
  assert.equal(enBells[0].body, SRV.ann_launchwarn_bell_body.en, 'EN bell body');
  assert.equal(enBells[0].link, `/#chat/${enMsgs[0].conversation_id}`, 'bell deep-links the warning thread');

  const esMsgs = blastMsgs(db, F.es.id);
  assert.equal(esMsgs.length, 1, 'ES model got exactly one warning DM');
  assert.equal(esMsgs[0].body, SRV.ann_launchwarn_dm.es, 'ES model got the Spanish copy');
  const esBells = blastBells(db, F.es.id);
  assert.equal(esBells.length, 1, 'ES model got exactly one warning bell');
  assert.equal(esBells[0].title, SRV.ann_launchwarn_bell_title.es, 'ES bell title is Spanish');
  assert.equal(esBells[0].body, SRV.ann_launchwarn_bell_body.es, 'ES bell body is Spanish');

  assert.equal(blastMsgs(db, F.ban.id).length, 0, 'banned model got no DM');
  assert.equal(blastBells(db, F.ban.id).length, 0, 'banned model got no bell');
  assert.equal(blastMsgs(db, F.fan.id).length, 0, 'fan got no DM');
  assert.equal(blastBells(db, F.fan.id).length, 0, 'fan got no bell');
  db.close();
});

/* ---------------- ON again: the stamp guard holds ----------------- */

test('second boot with the flag still ON: the stamp guard sends nothing more', async () => {
  await boot(); // boot 4
  await killServer();
  const db = readDb();
  assert.ok(stampOf(db), 'stamp still set');
  assert.equal(blastMsgs(db, F.en.id).length, 1, 'EN model not re-sent');
  assert.equal(blastBells(db, F.en.id).length, 1, 'EN model not re-belled');
  assert.equal(blastMsgs(db, F.es.id).length, 1, 'ES model not re-sent');
  assert.equal(blastBells(db, F.es.id).length, 1, 'ES model not re-belled');
  assert.equal(blastMsgs(db, F.ban.id).length, 0, 'banned model still has nothing');
  assert.equal(blastMsgs(db, F.fan.id).length, 0, 'fan still has nothing');
  db.close();
});
