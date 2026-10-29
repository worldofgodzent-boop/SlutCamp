'use strict';
/*
 * Face-count guard announcement tests (Phase 4 follow-up, PR #72).
 *
 * The Phase 4 face-count guard shipped with a ONE-TIME announcement
 * to every model, stamped on platform_stats (faceguard_announced_at)
 * — same pattern as the languages / preview-video / booking-rate
 * broadcasts: localized SRV copy (ann_faceguard_dm x13), a boot-time
 * loop through announcementThreadFor, a notifyUser bell, and the
 * stamp set only after the loop so a mid-boot failure retries on the
 * next start. The owner's standing rule (Oct 17, 2026): every update
 * gets a message to the girls. Asce directed this one Oct 20, 2026:
 * "Update the models once this new update lands."
 *
 * Pins: (1) static — the DM + bell keys exist in all 13 languages,
 * non-empty and genuinely translated, the EN DM is the owner-approved
 * text, the stamp column is declared, and the broadcast block wires
 * stamp + announcementThreadFor + srv copy; (2) boot — a seeded boot
 * DMs every seed model exactly once from the admin, in the
 * announcement thread, with a faceguard bell; the stamp is set; a
 * fan gets nothing; a second boot sends nothing more.
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

/* Extract a top-level const object block from server.js and evaluate
   it in a vm (same brace-matching approach as languages-13). */
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

/* ---------------- static pins ---------------- */

test('faceguard announcement: DM copy exists in all 13 languages, translated, owner text in EN', () => {
  const row = SRV.ann_faceguard_dm;
  assert.ok(row, 'ann_faceguard_dm exists in the SRV table');
  assert.deepEqual(Object.keys(row).sort(), [...LANG13].sort(), 'ann_faceguard_dm covers exactly the 13 languages');
  for (const lang of LANG13) {
    assert.equal(typeof row[lang], 'string', `${lang} is a string`);
    assert.ok(row[lang].trim().length > 100, `${lang} carries the full multi-paragraph DM`);
    assert.ok(row[lang].includes('💋'), `${lang} keeps the sign-off kiss`);
    assert.ok(row[lang].includes('🎥✨'), `${lang} keeps the closing camera sparkle`);
    if (lang !== 'en') assert.notEqual(row[lang], row.en, `${lang} is a real translation, not the EN text`);
  }
  const en = row.en;
  assert.ok(en.startsWith('Hey loves — quick update 💋'), 'EN opens with the owner-approved greeting');
  assert.ok(en.includes('counts faces'), 'EN names the face counting');
  assert.ok(en.includes('declare them before you go live'), 'EN carries the declare-first instruction');
  assert.ok(en.includes('Settings → My Co-Performers'), 'EN carries the Settings path');
  assert.ok(en.includes('Solo lives? Nothing changes at all.'), 'EN reassures solo models');
  assert.ok(en.includes('put your earnings at risk'), 'EN closes on the earnings-protection point');
});

test('faceguard announcement: bell title/body exist in all 13 languages', () => {
  for (const key of ['ann_faceguard_bell_title', 'ann_faceguard_bell_body']) {
    const row = SRV[key];
    assert.ok(row, `${key} exists in the SRV table`);
    assert.deepEqual(Object.keys(row).sort(), [...LANG13].sort(), `${key} covers exactly the 13 languages`);
    for (const lang of LANG13) {
      assert.ok(row[lang].trim().length > 0, `${key}:${lang} non-empty`);
      if (lang !== 'en') assert.notEqual(row[lang], row.en, `${key}:${lang} is translated`);
    }
  }
  assert.ok(SRV.ann_faceguard_bell_title.en.includes('camera protection'), 'EN bell title names the feature');
});

test('faceguard announcement: stamp column + broadcast wiring in server source', () => {
  assert.ok(serverSrc.includes("addColumnIfMissing('platform_stats', 'faceguard_announced_at', 'TEXT')"),
    'one-time stamp column declared');
  assert.ok(serverSrc.includes('function announceFaceguardToModels()'), 'broadcast function exists');
  const start = serverSrc.indexOf('function announceFaceguardToModels()');
  const end = serverSrc.indexOf('\n}\n', start);
  const block = serverSrc.slice(start, end);
  assert.ok(block.includes("SELECT faceguard_announced_at FROM platform_stats WHERE id = 1"),
    'block checks the stamp first');
  assert.ok(block.includes("role = 'model' AND banned = 0"), 'recipients are all unbanned models');
  assert.ok(block.includes("announcementThreadFor(m.id, 'model', admin.id)"),
    'DM lands via announcementThreadFor, like the precedent broadcasts');
  assert.ok(block.includes("srv('ann_faceguard_dm', m.language)"), 'DM copy is localized per model');
  assert.ok(block.includes("notifyUser(m.id, 'faceguard', srv('ann_faceguard_bell_title', m.language)"),
    'bell fires with the localized title');
  assert.ok(block.includes("srv('ann_faceguard_bell_body', m.language), `/#chat/${conv.id}`"),
    'bell body localized and opens the thread itself');
  const insertAt = block.indexOf('INSERT INTO messages');
  const stampAt = block.indexOf("UPDATE platform_stats SET faceguard_announced_at");
  assert.ok(insertAt >= 0 && stampAt > insertAt, 'stamp is set only after the broadcast loop');
  assert.ok(serverSrc.includes('announceFaceguardToModels();'),
    'boot sweep calls the broadcast');
});

/* ---------------- boot harness (mirrors preview-video-announce) ---------------- */

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-faceguardann-'));
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

function readDb(dir) {
  return new DatabaseSync(path.join(dir, 'wogent-chat.db'), { readOnly: true });
}

test('faceguard announcement: every model DMd exactly once, fans never, stamp set, no re-send', async () => {
  const dir = makeCopy();
  try {
    const h1 = await boot(dir, { SEED_DEMO: '1' });
    stop(h1);
    let db = readDb(dir);
    const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
    assert.ok(admin, 'seeded admin exists');
    const stamp = db.prepare('SELECT faceguard_announced_at FROM platform_stats WHERE id = 1').get();
    assert.ok(stamp && stamp.faceguard_announced_at, 'announcement stamp is set after first boot');
    const models = db.prepare("SELECT id, username FROM users WHERE role = 'model'").all();
    assert.ok(models.length >= 3, 'seed models exist');
    const countFor = (modelId) => db.prepare(
      `SELECT COUNT(*) AS c FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE c.fan_id = ? AND c.model_id = ? AND m.sender_id = ? AND m.body LIKE '%quietly counts faces%'`
    ).get(admin.id, modelId, admin.id).c;
    for (const m of models) {
      assert.equal(countFor(m.id), 1, `${m.username} got exactly one announcement`);
      const row = db.prepare(
        `SELECT m.body FROM messages m JOIN conversations c ON c.id = m.conversation_id
         WHERE c.fan_id = ? AND c.model_id = ? AND m.body LIKE '%quietly counts faces%'`
      ).get(admin.id, m.id);
      assert.equal(row.body, SRV.ann_faceguard_dm.en, `${m.username} received the exact owner-approved EN text`);
      const bell = db.prepare("SELECT title, body FROM notifications WHERE user_id = ? AND type = 'faceguard'")
        .get(m.id);
      assert.ok(bell, `${m.username} got the faceguard bell`);
      assert.equal(bell.title, SRV.ann_faceguard_bell_title.en, 'bell title is the localized EN title');
      assert.equal(bell.body, SRV.ann_faceguard_bell_body.en, 'bell body is the localized EN body');
    }
    const fan = db.prepare("SELECT id FROM users WHERE role = 'fan' LIMIT 1").get();
    const fanHit = db.prepare(
      `SELECT COUNT(*) AS c FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE (c.fan_id = ? OR c.model_id = ?) AND m.body LIKE '%quietly counts faces%'`
    ).get(fan.id, fan.id).c;
    assert.equal(fanHit, 0, 'fans receive no announcement');
    const fanBell = db.prepare("SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND type = 'faceguard'")
      .get(fan.id).c;
    assert.equal(fanBell, 0, 'fans receive no faceguard bell');
    db.close();

    // Second boot keeps SEED_DEMO=1 (dev mode): without it, the
    // production fake-money purge would delete the pristine seed
    // models — and their threads — before we could count anything.
    const h2 = await boot(dir, { SEED_DEMO: '1' });
    stop(h2);
    db = readDb(dir);
    for (const m of models) assert.equal(countFor(m.id), 1, `${m.username} not re-sent on second boot`);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
