'use strict';
/*
 * Manager 👀 Chats monitor upgrade (owner, Oct 18 2026, from his
 * screenshots of the Chats tab): the monitor showed no dates, had no
 * way to find one model's conversations, and chat messages were kept
 * forever. His asks:
 *  - DATES: last-activity date+time on every conversation card in the
 *    monitor list, and a date+time on each message in the peek view.
 *  - SEARCH: a search bar at the top of the Chats tab — typing a model
 *    name brings up all her conversations. Server-side ?q= filter on
 *    GET /api/admin/conversations, case-insensitive substring against
 *    BOTH participants' display name and username.
 *  - AUTO-DUMP: chat messages older than 7 days delete themselves
 *    (sweepChatRetention — 12h timer + shortly after boot + the 🧹
 *    button). NEVER the official SlutCamp notices threads (the
 *    permanent update archive), NEVER a conversation involving a user
 *    with an OPEN dispute (disputes link by user_id, so the exclusion
 *    is by participant). Emptied non-official conversations are
 *    removed; counts/previews are computed live, so nothing ghosts.
 *  - ANNOUNCEMENT: one-time, localized (SRV, 13 languages), official
 *    thread + bell, stamp-guarded (chat_retention_announced_at), to
 *    models AND fans — chats auto-clean after 7 days now.
 * The biweekly disk cleanup's old raw message DELETE now routes
 * through the same protected sweep at its 14-day window, so the
 * archive survives that pass too.
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
const serverSrc = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
const managerSrc = fs.readFileSync(path.join(REPO, 'public/manager/manager.js'), 'utf8');

/* ---------------- static pins ---------------- */

test('pins: server — retention sweep, protections, cadence, manual endpoint', () => {
  assert.ok(serverSrc.includes('const CHAT_RETENTION_DAYS = 7'), '7-day retention window');
  assert.ok(serverSrc.includes('function sweepChatRetention('), 'the sweep exists');
  assert.ok(serverSrc.includes("status = 'open'"), 'open-dispute exclusion reads disputes.status');
  assert.ok(serverSrc.includes('12 * 3600 * 1000'), '12h repeating timer');
  assert.ok(serverSrc.includes("app.post('/api/admin/conversations/cleanup', ...adminOnly"),
    'manual cleanup endpoint is admin-only');
  const sweep = serverSrc.slice(serverSrc.indexOf('function sweepChatRetention('),
    serverSrc.indexOf('// Cadence: once shortly after boot'));
  assert.ok(sweep.includes('is_official'), 'sweep protects official threads');
  assert.ok(sweep.includes('disputed.has(c.fan_id)') && sweep.includes('disputed.has(c.model_id)'),
    'sweep protects conversations on either side of an open dispute');
  const biweekly = serverSrc.slice(serverSrc.indexOf('function runBiweeklyCleanup()'),
    serverSrc.indexOf('function runBiweeklyCleanup()') + 6000);
  assert.ok(!biweekly.includes('DELETE FROM messages'),
    'biweekly cleanup no longer raw-deletes messages');
  assert.ok(biweekly.includes('sweepChatRetention(14)'),
    'biweekly cleanup routes messages through the protected sweep');
});

test('pins: server — search filter + one-time announcement wiring', () => {
  const list = serverSrc.slice(serverSrc.indexOf("app.get('/api/admin/conversations'"),
    serverSrc.indexOf("app.post('/api/admin/conversations/cleanup'"));
  assert.ok(list.includes('req.query.q'), 'list endpoint reads ?q=');
  assert.ok(list.includes('fan_username') && list.includes('model_username'),
    'search covers usernames as well as display names');
  assert.ok(list.includes('last_activity_at'), 'list payload carries last-activity timestamp');
  assert.ok(serverSrc.includes("addColumnIfMissing('platform_stats', 'chat_retention_announced_at'"),
    'announcement stamp column');
  assert.ok(serverSrc.includes('function announceChatRetention()'), 'announcement sweep exists');
  for (const k of ['ann_retention_dm', 'ann_retention_bell_title', 'ann_retention_bell_body']) {
    assert.ok(serverSrc.includes(`${k}: {`), `SRV copy key ${k} (13 languages — parity pinned by languages-13)`);
  }
  const ann = serverSrc.slice(serverSrc.indexOf('function announceChatRetention()'),
    serverSrc.indexOf('function announceChatRetention()') + 2200);
  assert.ok(ann.includes("role IN ('model','fan')"), 'announcement goes to models AND fans');
  assert.ok(ann.includes('officialThreadFor('), 'announcement lands in the official thread');
});

test('pins: manager — search bar, dates, cleanup button, helper text', () => {
  assert.ok(managerSrc.includes('id="chat-search"'), 'search input at the top of the Chats tab');
  assert.ok(managerSrc.includes('id="chat-search-clear"'), 'clear button');
  assert.ok(managerSrc.includes('id="chat-cleanup"'), '🧹 Clean up now button');
  assert.ok(managerSrc.includes('Messages auto-delete after 7 days'),
    'helper text states the retention');
  assert.ok(managerSrc.includes('/admin/conversations/cleanup'), 'button calls the sweep endpoint');
  assert.ok(managerSrc.includes('confirm('), 'button asks first (native confirm)');
  assert.ok(managerSrc.includes('function fmtDT('), 'date+time formatter exists');
  assert.ok(managerSrc.includes('fmtDT(c.last_activity_at || c.updated_at)'),
    'conversation cards show the last-activity date');
  const peek = managerSrc.slice(managerSrc.indexOf('async function peekBody()'),
    managerSrc.indexOf('async function peekBody()') + 1200);
  assert.ok(peek.includes('fmtDT(m.created_at)'), 'peek messages show date+time');
  assert.ok(managerSrc.includes("'/admin/conversations' + (M.chatQuery"),
    'search re-queries the server with ?q=');
});

/* ---------------- live harness (manager-affiliates-delete pattern) ---------------- */

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-chatmon-'));
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

const ago = (days, hours = 0) =>
  new Date(Date.now() - days * 864e5 - hours * 3600e3).toISOString().slice(0, 19).replace('T', ' ');
const NOW = new Date().toISOString().slice(0, 19).replace('T', ' ');

/* Seed: Rita (model, ES) + Olivia + Shell (models), Frank + Danny
   (open dispute) + Wendy (closed dispute) (fans), the house account,
   and a spread of conversations: mixed-age, all-old, official,
   dispute-protected, closed-dispute, an old empty shell, a fresh
   empty shell. Announcement stamps are cleared so the seeded boot
   delivers the retention announcement to these users. */
function seedChats(dir) {
  const db = new DatabaseSync(path.join(dir, 'wogent-chat.db'));
  db.exec('PRAGMA busy_timeout = 10000');
  try {
    db.prepare(`UPDATE platform_stats SET official_inbox_announced_at = NULL,
                chat_retention_announced_at = NULL WHERE id = 1`).run();
    const insUser = db.prepare(
      'INSERT INTO users (username, password_hash, role, display_name, dob, banned, email, language, created_at) VALUES (?,?,?,?,?,?,?,?,?)');
    const mk = (u, role, name, lang) => Number(insUser.run(
      u, bcrypt.hashSync(`${u}-pass-123`, 10), role, name, '1995-05-05', 0, null, lang || 'en', '2026-02-01 10:00:00').lastInsertRowid);
    const house = mk('asceaaspade', 'model', 'SlutCamp');
    const rita = mk('retmodel', 'model', 'Rita Retention', 'es');
    const olivia = mk('othermodel', 'model', 'Olivia Other');
    const shell = mk('shellmodel', 'model', 'Shell Model');
    const frank = mk('retfan', 'fan', 'Frank RetentionFan');
    const danny = mk('dispfan', 'fan', 'Danny Dispute');
    const wendy = mk('closedfan', 'fan', 'Wendy Won');
    for (const id of [house, rita, olivia, shell]) {
      db.prepare('INSERT INTO models (user_id) VALUES (?)').run(id);
    }
    const insConv = db.prepare(
      'INSERT INTO conversations (fan_id, model_id, is_official, updated_at) VALUES (?,?,?,?)');
    const insMsg = db.prepare(
      'INSERT INTO messages (conversation_id, sender_id, body, created_at) VALUES (?,?,?,?)');
    // A: mixed ages — the sweep takes the old one, keeps the fresh one.
    const convA = Number(insConv.run(frank, rita, 0, NOW).lastInsertRowid);
    insMsg.run(convA, frank, 'aged A', ago(10));
    const freshA = ago(0, 1);
    insMsg.run(convA, rita, 'fresh A', freshA);
    // B: all old — messages AND the conversation go.
    const convB = Number(insConv.run(frank, olivia, 0, ago(9)).lastInsertRowid);
    insMsg.run(convB, frank, 'aged B1', ago(9));
    insMsg.run(convB, olivia, 'aged B2', ago(8));
    // Official notices thread: an ancient message must survive.
    const convOff = Number(insConv.run(frank, house, 1, NOW).lastInsertRowid);
    insMsg.run(convOff, house, 'ancient official notice', ago(30));
    // Dispute: Danny has an OPEN case — his whole chat is evidence.
    const convD = Number(insConv.run(danny, rita, 0, ago(12)).lastInsertRowid);
    insMsg.run(convD, danny, 'dispute evidence 1', ago(12));
    insMsg.run(convD, rita, 'dispute evidence 2', ago(11));
    db.prepare(`INSERT INTO disputes (user_id, transaction_ref, amount_cents, reason, status)
                VALUES (?,?,?,?, 'open')`).run(danny, 'txn-open-1', 500, 'chargeback');
    // Closed dispute: Wendy's case is won — no protection.
    const convC = Number(insConv.run(wendy, olivia, 0, ago(12)).lastInsertRowid);
    insMsg.run(convC, wendy, 'closed case 1', ago(12));
    insMsg.run(convC, olivia, 'closed case 2', ago(12));
    db.prepare(`INSERT INTO disputes (user_id, transaction_ref, amount_cents, reason, status)
                VALUES (?,?,?,?, 'won')`).run(wendy, 'txn-won-1', 700, 'chargeback');
    // Shells: old + empty goes, fresh + empty stays.
    const convShell = Number(insConv.run(frank, shell, 0, ago(10)).lastInsertRowid);
    const convFreshShell = Number(insConv.run(wendy, shell, 0, NOW).lastInsertRowid);
    return { house, rita, olivia, shell, frank, danny, wendy,
             convA, convB, convOff, convD, convC, convShell, convFreshShell, freshA };
  } finally {
    db.close();
  }
}

test('live: search + dates + protected 7-day sweep + announcement', async () => {
  const dir = makeCopy();
  const h1 = await boot(dir, { SEED_DEMO: '1' });
  stop(h1);
  const S = seedChats(dir);
  const h = await boot(dir, { SEED_DEMO: '1' });
  try {
    const mgr = await mgrLogin(h.base);
    const list = (q) => req(h.base, 'GET',
      '/api/admin/conversations' + (q ? `?q=${encodeURIComponent(q)}` : ''), { ...mgr });
    const byId = (arr, id) => arr.find((c) => c.id === id);

    /* --- announcement: delivered once, localized, stamp set --- */
    const db = new DatabaseSync(path.join(dir, 'wogent-chat.db'));
    db.exec('PRAGMA busy_timeout = 10000');
    const stamp = db.prepare('SELECT chat_retention_announced_at AS s FROM platform_stats WHERE id = 1').get().s;
    assert.ok(stamp, 'retention announcement stamp set at boot');
    const frankDm = db.prepare(`SELECT body FROM messages WHERE conversation_id = ?
      AND body LIKE '%clean themselves%'`).get(S.convOff);
    assert.ok(frankDm, 'fan got the EN retention DM in his official thread');
    const ritaOff = db.prepare(`SELECT c.id FROM conversations c
      WHERE c.fan_id = ? AND c.is_official = 1`).get(S.rita);
    assert.ok(ritaOff, 'model has an official thread');
    const ritaDm = db.prepare(`SELECT body FROM messages WHERE conversation_id = ?
      AND body LIKE '%se limpian solos%'`).get(ritaOff.id);
    assert.ok(ritaDm, 'model got the ES retention DM (localized per recipient)');
    db.close();

    /* --- search: model display name, username (any case), fan name --- */
    const all = (await list()).json.conversations;
    for (const id of [S.convA, S.convB, S.convOff, S.convD, S.convC]) {
      assert.ok(byId(all, id), `unfiltered list contains conv ${id}`);
    }
    const byDisplay = (await list('rita')).json.conversations;
    assert.ok(byId(byDisplay, S.convA) && byId(byDisplay, S.convD), 'q=rita finds her chats');
    assert.ok(!byId(byDisplay, S.convB) && !byId(byDisplay, S.convC), 'q=rita excludes Olivia’s chats');
    const byUsername = (await list('RETMODEL')).json.conversations;
    assert.ok(byId(byUsername, S.convA) && byId(byUsername, S.convD),
      'q=RETMODEL matches her username, case-insensitive');
    const byFan = (await list('frank')).json.conversations;
    assert.ok(byId(byFan, S.convA) && byId(byFan, S.convB) && byId(byFan, S.convOff),
      'q=frank matches the fan side too');
    const none = (await list('no-such-person-zzz')).json.conversations;
    assert.equal(none.length, 0, 'no match → empty list');

    /* --- dates: list last-activity + per-message created_at --- */
    const aRow = byId(all, S.convA);
    assert.equal(aRow.last_activity_at, S.freshA, 'last_activity_at is the newest message time');
    assert.equal(aRow.last_message.body, 'fresh A');
    const fanLogin = await req(h.base, 'POST', '/api/auth/login',
      { body: { username: 'retfan', password: 'retfan-pass-123' } });
    assert.equal(fanLogin.status, 200, `fan login: ${fanLogin.text}`);
    const thread = await req(h.base, 'GET', `/api/conversations/${S.convA}/messages`,
      { token: fanLogin.json.token });
    assert.equal(thread.status, 200, `thread fetch: ${thread.text}`);
    assert.equal(thread.json.messages.length, 2);
    for (const m of thread.json.messages) {
      assert.ok(typeof m.created_at === 'string' && m.created_at.length >= 19,
        'every thread message carries created_at');
    }

    /* --- cleanup endpoint: admin-only gates --- */
    const anon = await req(h.base, 'POST', '/api/admin/conversations/cleanup',
      { headers: { 'x-manager': '1' } });
    assert.equal(anon.status, 401, 'anonymous cleanup rejected');
    const fanTry = await req(h.base, 'POST', '/api/admin/conversations/cleanup',
      { token: fanLogin.json.token, headers: { 'x-manager': '1' } });
    assert.equal(fanTry.status, 403, 'fan cannot run the cleanup');
    const noHeader = await req(h.base, 'POST', '/api/admin/conversations/cleanup', { token: mgr.token });
    assert.equal(noHeader.status, 403, 'missing X-Manager header rejected');
    assert.equal(noHeader.json.error, 'manager_only');

    /* --- the sweep itself --- */
    const run = await req(h.base, 'POST', '/api/admin/conversations/cleanup', { ...mgr });
    assert.equal(run.status, 200, `cleanup: ${run.text}`);
    assert.equal(run.json.messages_deleted, 5,
      'aged messages deleted: A×1 + B×2 + closed-case×2 (official + open-dispute kept)');
    assert.equal(run.json.conversations_deleted, 3,
      'emptied conversations removed: B + closed-case + old empty shell');

    const after = (await list()).json.conversations;
    assert.ok(!byId(after, S.convB), 'conv B gone from the monitor');
    assert.ok(!byId(after, S.convC), 'closed-dispute conv gone');
    assert.ok(!byId(after, S.convShell), 'old empty shell gone');
    assert.ok(byId(after, S.convFreshShell), 'fresh empty shell kept');
    const aAfter = byId(after, S.convA);
    assert.equal(aAfter.message_count, 1, 'conv A keeps only the fresh message — no ghost counts');
    assert.equal(aAfter.last_message.body, 'fresh A', 'no ghost preview');
    const offAfter = byId(after, S.convOff);
    assert.ok(offAfter, 'official thread still listed');
    const dAfter = byId(after, S.convD);
    assert.equal(dAfter.message_count, 2, 'open-dispute conversation untouched');

    const db2 = new DatabaseSync(path.join(dir, 'wogent-chat.db'));
    db2.exec('PRAGMA busy_timeout = 10000');
    const ancient = db2.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND body = ?')
      .get(S.convOff, 'ancient official notice').n;
    assert.equal(ancient, 1, '30-day-old official notice survived the sweep');
    const evidence = db2.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?')
      .get(S.convD).n;
    assert.equal(evidence, 2, 'open-dispute messages survived in the DB');
    db2.close();

    /* --- idempotent: a second run removes nothing --- */
    const again = await req(h.base, 'POST', '/api/admin/conversations/cleanup', { ...mgr });
    assert.equal(again.json.messages_deleted, 0, 'second cleanup is a no-op');
    assert.equal(again.json.conversations_deleted, 0, 'second cleanup removes no conversations');
  } finally {
    stop(h);
  }
});
