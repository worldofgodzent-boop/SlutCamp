'use strict';
/*
 * Notification-fix announcement tests.
 *
 * The notification-tap fix (bells now route to their screen instead of
 * re-rendering the list) ships with a ONE-TIME admin-thread DM per
 * model, stamped on platform_stats (notif_fix_announced_at) — same
 * pattern as the Game Category and public-photo announcements. The
 * owner's standing rule (Oct 17, 2026): every update gets a message
 * to the girls.
 *
 * Pins: (1) a seeded boot DMs every seed model exactly once, from the
 * admin, in the admin<->model thread, explaining the fix; (2) the
 * stamp is set; (3) a fan gets nothing; (4) a second boot sends
 * nothing more.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-notifann-'));
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

test('notification-fix announcement: every model DMd exactly once, fans never, stamp set, no re-send', async () => {
  const dir = makeCopy();
  try {
    const h1 = await boot(dir, { SEED_DEMO: '1' });
    stop(h1);
    let db = readDb(dir);
    const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
    assert.ok(admin, 'seeded admin exists');
    const stamp = db.prepare('SELECT notif_fix_announced_at FROM platform_stats WHERE id = 1').get();
    assert.ok(stamp && stamp.notif_fix_announced_at, 'announcement stamp is set after first boot');
    const models = db.prepare("SELECT id, username FROM users WHERE role = 'model'").all();
    assert.ok(models.length >= 3, 'seed models exist');
    const countFor = (modelId) => db.prepare(
      `SELECT COUNT(*) AS c FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE c.fan_id = ? AND c.model_id = ? AND m.sender_id = ? AND m.body LIKE '%notifications open now%'`
    ).get(admin.id, modelId, admin.id).c;
    for (const m of models) {
      assert.equal(countFor(m.id), 1, `${m.username} got exactly one announcement`);
      const row = db.prepare(
        `SELECT m.body FROM messages m JOIN conversations c ON c.id = m.conversation_id
         WHERE c.fan_id = ? AND c.model_id = ? AND m.body LIKE '%notifications open now%'`
      ).get(admin.id, m.id);
      assert.ok(row.body.includes('takes you straight there'), 'routing behaviour explained');
      assert.ok(row.body.includes('Video call requests open the request'), 'per-type routing explained');
    }
    const fan = db.prepare("SELECT id FROM users WHERE role = 'fan' LIMIT 1").get();
    const fanHit = db.prepare(
      `SELECT COUNT(*) AS c FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE (c.fan_id = ? OR c.model_id = ?) AND m.body LIKE '%notifications open now%'`
    ).get(fan.id, fan.id).c;
    assert.equal(fanHit, 0, 'fans receive no announcement');
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
