'use strict';
/*
 * Launch-update announcement tests (owner-ordered blast, Oct 27 2026).
 *
 * Asce's own message to the models — launch timing plus the new
 * broadcast-to-favorites and top-spender features — ships as a
 * ONE-TIME announcement stamped on platform_stats
 * (launch_update_announced_at), same pattern as the clean-feed /
 * faceguard broadcasts: localized SRV copy (ann_launchupdate_dm x13),
 * a boot-time loop through announcementThreadFor, a notifyUser bell
 * deep-linking the thread, and the stamp set only after the loop so
 * a mid-boot failure retries on the next start.
 *
 * Pins: (1) static — the DM + bell keys exist in all 13 languages,
 * non-empty and genuinely translated, the EN DM is the owner-approved
 * text verbatim, the stamp column is declared, and the broadcast
 * block wires stamp + banned=0 audience + announcementThreadFor +
 * srv copy + boot-sweep call after the clean-feed call; (2) boot — a
 * seeded boot DMs every seed model exactly once with one bell; (3)
 * surgery — ban one model, switch another to Spanish, clear the
 * stamp + the blast's own rows, reboot: the banned model gets
 * nothing, the Spanish model gets the exact Spanish copy, everyone
 * else gets exactly one; (4) a further boot sends nothing more.
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

const OWNER_DM = `Hey ladies,

I want to go ahead and thank y'all for being patient with me. SlutCamp is in the final stages of compliance before we can go live. We should be done by the end of this week.

I have added new features for the models. Fans that add you to their playlist/favorites will be able to receive a broadcast message made specifically for them from you — so you can let your people know when you're going live.

Your top spenders will be automatically added to your wallet. So whenever a top spender reaches out to you, they get sent straight to the front of the line in your messages.

— Asce`;

/* Extract a top-level const object block from server.js and evaluate
   it in a vm (same brace-matching approach as faceguard-announcement). */
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
const ALL_BODIES = LANG13.map((l) => SRV.ann_launchupdate_dm[l]);

/* ---------------- static pins ---------------- */

test('launch-update blast: DM copy exists in all 13 languages, translated, owner text in EN', () => {
  const row = SRV.ann_launchupdate_dm;
  assert.ok(row, 'ann_launchupdate_dm exists in the SRV table');
  assert.deepEqual(Object.keys(row).sort(), [...LANG13].sort(), 'ann_launchupdate_dm covers exactly the 13 languages');
  assert.equal(row.en, OWNER_DM, 'EN DM is the owner-approved text, verbatim');
  for (const lang of LANG13) {
    assert.equal(typeof row[lang], 'string', `${lang} is a string`);
    assert.ok(row[lang].trim().length > 200, `${lang} carries the full multi-paragraph DM`);
    assert.ok(row[lang].includes('SlutCamp'), `${lang} keeps SlutCamp untranslated`);
    assert.ok(row[lang].includes('Asce'), `${lang} keeps the Asce sign-off`);
    assert.ok((row[lang].match(/\n\n/g) || []).length >= 4, `${lang} keeps the paragraph structure`);
    if (lang !== 'en') assert.notEqual(row[lang], row.en, `${lang} is a real translation, not the EN text`);
  }
});

test('launch-update blast: bell title/body exist in all 13 languages with the approved EN text', () => {
  assert.equal(SRV.ann_launchupdate_bell_title.en, '📣 A message from Asce', 'EN bell title is the approved text');
  assert.equal(SRV.ann_launchupdate_bell_body.en, 'News on the launch + new features for you — tap to read.', 'EN bell body is the approved text');
  for (const key of ['ann_launchupdate_bell_title', 'ann_launchupdate_bell_body']) {
    const row = SRV[key];
    assert.ok(row, `${key} exists in the SRV table`);
    assert.deepEqual(Object.keys(row).sort(), [...LANG13].sort(), `${key} covers exactly the 13 languages`);
    for (const lang of LANG13) {
      assert.ok(row[lang].trim().length > 0, `${key}:${lang} non-empty`);
      if (lang !== 'en') assert.notEqual(row[lang], row.en, `${key}:${lang} is translated`);
    }
  }
});

test('launch-update blast: stamp column + broadcast wiring in server source', () => {
  assert.ok(serverSrc.includes("addColumnIfMissing('platform_stats', 'launch_update_announced_at', 'TEXT')"),
    'one-time stamp column declared');
  assert.ok(serverSrc.includes('function announceLaunchUpdateToModels()'), 'broadcast function exists');
  const start = serverSrc.indexOf('function announceLaunchUpdateToModels()');
  const end = serverSrc.indexOf('\n}\n', start);
  const block = serverSrc.slice(start, end);
  assert.ok(block.includes("SELECT launch_update_announced_at FROM platform_stats WHERE id = 1"),
    'block checks the stamp first');
  assert.ok(block.includes("role = 'model' AND banned = 0"), 'recipients are all unbanned models');
  assert.ok(block.includes("announcementThreadFor(m.id, 'model', admin.id)"),
    'DM lands via announcementThreadFor, like the precedent broadcasts');
  assert.ok(block.includes("srv('ann_launchupdate_dm', m.language)"), 'DM copy is localized per model');
  assert.ok(block.includes("notifyUser(m.id, 'launchupdate', srv('ann_launchupdate_bell_title', m.language)"),
    'bell fires with the localized title');
  assert.ok(block.includes("srv('ann_launchupdate_bell_body', m.language), `/#chat/${conv.id}`"),
    'bell body localized and opens the thread itself');
  const insertAt = block.indexOf('INSERT INTO messages');
  const stampAt = block.indexOf("UPDATE platform_stats SET launch_update_announced_at");
  assert.ok(insertAt >= 0 && stampAt > insertAt, 'stamp is set only after the broadcast loop');
  const cfCall = serverSrc.indexOf('const n = announceCleanFeedToModels()');
  const luCall = serverSrc.indexOf('const n = announceLaunchUpdateToModels()');
  assert.ok(cfCall >= 0 && luCall > cfCall, 'boot sweep calls the blast after the clean-feed call');
});

/* ---------------- boot harness (mirrors faceguard-announcement) ---------------- */

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-launchupdate-'));
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

test('launch-update blast: every model DMd + belled exactly once, banned none, stamp stops re-send', async () => {
  const dir = makeCopy();
  try {
    /* ---- boot 1: the blast fires to every seed model ---- */
    const h1 = await boot(dir, { SEED_DEMO: '1' });
    stop(h1);
    let db = readDb(dir);
    const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
    assert.ok(admin, 'seeded admin exists');
    const stamp1 = db.prepare('SELECT launch_update_announced_at FROM platform_stats WHERE id = 1').get();
    assert.ok(stamp1 && stamp1.launch_update_announced_at, 'announcement stamp is set after first boot');
    const models = db.prepare("SELECT id, username, banned FROM users WHERE role = 'model'").all();
    assert.ok(models.length >= 3, 'seed models exist');
    assert.ok(models.every((m) => !m.banned), 'seed models start unbanned');
    const dmCount = (modelId, body) => db.prepare(
      `SELECT COUNT(*) AS c FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE c.fan_id = ? AND c.model_id = ? AND m.sender_id = ? AND m.body = ?`
    ).get(admin.id, modelId, admin.id, body).c;
    const anyDmCount = (modelId) => {
      const ph = ALL_BODIES.map(() => '?').join(',');
      return db.prepare(
        `SELECT COUNT(*) AS c FROM messages m JOIN conversations c ON c.id = m.conversation_id
         WHERE c.fan_id = ? AND c.model_id = ? AND m.sender_id = ? AND m.body IN (${ph})`
      ).get(admin.id, modelId, admin.id, ...ALL_BODIES).c;
    };
    const bellCount = (userId) => db.prepare(
      "SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND type = 'launchupdate'"
    ).get(userId).c;
    for (const m of models) {
      assert.equal(dmCount(m.id, OWNER_DM), 1, `${m.username} got exactly one DM with the exact owner text`);
      assert.equal(bellCount(m.id), 1, `${m.username} got exactly one launchupdate bell`);
      const msg = db.prepare(
        `SELECT m.conversation_id FROM messages m JOIN conversations c ON c.id = m.conversation_id
         WHERE c.fan_id = ? AND c.model_id = ? AND m.body = ?`
      ).get(admin.id, m.id, OWNER_DM);
      const bell = db.prepare(
        "SELECT title, body, link FROM notifications WHERE user_id = ? AND type = 'launchupdate'"
      ).get(m.id);
      assert.equal(bell.title, SRV.ann_launchupdate_bell_title.en, 'bell title is the approved EN title');
      assert.equal(bell.body, SRV.ann_launchupdate_bell_body.en, 'bell body is the approved EN body');
      assert.equal(bell.link, `/#chat/${msg.conversation_id}`, 'bell deep-links the announcement thread');
    }
    const fan = db.prepare("SELECT id FROM users WHERE role = 'fan' LIMIT 1").get();
    assert.equal(bellCount(fan.id), 0, 'fans receive no launchupdate bell');
    db.close();

    /* ---- surgery: ban one model, switch one to Spanish, re-arm the blast ---- */
    const bannedModel = models[0];
    const spanishModel = models[1];
    const wdb = new DatabaseSync(path.join(dir, 'wogent-chat.db'));
    wdb.exec('PRAGMA busy_timeout = 10000');
    wdb.prepare('UPDATE users SET banned = 1 WHERE id = ?').run(bannedModel.id);
    wdb.prepare("UPDATE users SET language = 'es' WHERE id = ?").run(spanishModel.id);
    const ph = ALL_BODIES.map(() => '?').join(',');
    wdb.prepare(`DELETE FROM messages WHERE body IN (${ph})`).run(...ALL_BODIES);
    wdb.prepare("DELETE FROM notifications WHERE type = 'launchupdate'").run();
    wdb.prepare('UPDATE platform_stats SET launch_update_announced_at = NULL WHERE id = 1').run();
    wdb.close();

    /* ---- boot 2: banned gets nothing, Spanish gets Spanish, the rest exactly one ---- */
    const h2 = await boot(dir, { SEED_DEMO: '1' });
    stop(h2);
    db = readDb(dir);
    const stamp2 = db.prepare('SELECT launch_update_announced_at FROM platform_stats WHERE id = 1').get();
    assert.ok(stamp2 && stamp2.launch_update_announced_at, 'stamp is set again after the re-armed boot');
    assert.equal(anyDmCount(bannedModel.id), 0, 'banned model receives no DM');
    assert.equal(bellCount(bannedModel.id), 0, 'banned model receives no bell');
    for (const m of models) {
      if (m.id === bannedModel.id) continue;
      const expected = m.id === spanishModel.id ? SRV.ann_launchupdate_dm.es : OWNER_DM;
      assert.equal(dmCount(m.id, expected), 1, `${m.username} got exactly one DM in her language`);
      assert.equal(anyDmCount(m.id), 1, `${m.username} got no duplicate in any language`);
      assert.equal(bellCount(m.id), 1, `${m.username} got exactly one bell on the re-run`);
    }
    const esBell = db.prepare(
      "SELECT title, body FROM notifications WHERE user_id = ? AND type = 'launchupdate'"
    ).get(spanishModel.id);
    assert.equal(esBell.title, SRV.ann_launchupdate_bell_title.es, 'Spanish model bell title is Spanish');
    assert.equal(esBell.body, SRV.ann_launchupdate_bell_body.es, 'Spanish model bell body is Spanish');
    db.close();

    /* ---- boot 3: the stamp holds — nothing is sent again ---- */
    const h3 = await boot(dir, { SEED_DEMO: '1' });
    stop(h3);
    db = readDb(dir);
    assert.equal(anyDmCount(bannedModel.id), 0, 'banned model still has nothing after another boot');
    for (const m of models) {
      if (m.id === bannedModel.id) continue;
      assert.equal(anyDmCount(m.id), 1, `${m.username} not re-sent on the next boot`);
      assert.equal(bellCount(m.id), 1, `${m.username} not re-belled on the next boot`);
    }
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
