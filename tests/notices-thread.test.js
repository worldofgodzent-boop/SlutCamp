'use strict';
/*
 * The SlutCamp NOTICES thread (owner, Oct 18 2026): the owner tapped
 * an announcement bell on his fan account and landed on the generic
 * Chats screen — fan blasts (PR #34) carried no thread to open, and
 * PR #41 filtered house threads out of fan lists entirely. His fix:
 * one official SlutCamp thread per user that collects every app
 * announcement —
 *
 *  - a conversation with the house account flagged is_official;
 *    every announcement write-path (model DMs, fan blasts, the
 *    deploy announcement itself) posts into it, and announcement
 *    bells link '/#chat/<officialThreadId>' so a tap opens it;
 *  - PINNED at the top of Chats: permanently for models, recruiters
 *    and affiliate-capability holders; for fans only while it holds
 *    unread notices (read everything → it steps aside until the next
 *    announcement);
 *  - READ-ONLY for every user role: POST /api/messages into it is
 *    403 cannot_message_official for fan, model, recruiter AND the
 *    house account itself — announcement paths insert directly;
 *  - PR #41's other protections stand: arbitrary house threads stay
 *    hidden from fan lists and unmessageable.
 *
 * Rider (same PR): the FaceTime bells rendered "undefined accepted
 * your FaceTime" — ftGet rows carry no model_name; both bell sites
 * now resolve the name through ftPublic like the rest of the flow.
 *
 * Live tests run the real server over several boots (the deploy
 * announcement and the blasts are stamp-guarded boot sweeps, so
 * stamps are unstamped directly in the DB between boots).
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
const app = read('public/js/app.js');
const css = read('public/css/styles.css');

/* ---------------- static pins ---------------- */

test('pins: server — official thread identity, helpers and deploy sweep exist', () => {
  assert.ok(server.includes("addColumnIfMissing('conversations', 'is_official'"),
    'is_official migration on conversations');
  assert.ok(server.includes("addColumnIfMissing('platform_stats', 'official_inbox_announced_at'"),
    'one-time deploy stamp column');
  assert.ok(server.includes('function officialThreadFor('), 'get-or-create official thread');
  assert.ok(server.includes('function announcementThreadFor('), 'dual-mode announcement routing (house account first)');
  assert.ok(server.includes('function postToOfficialThread('), 'fan blasts persist into the thread');
  assert.ok(server.includes('function announceOfficialInbox()'), 'deploy announcement sweep');
  for (const k of ['ann_inbox_dm', 'ann_inbox_fan_dm', 'ann_inbox_bell_title', 'ann_inbox_bell_body']) {
    assert.ok(server.includes(`${k}: {`), `SRV copy key ${k} (13 languages — count pinned by languages-13)`);
  }
  assert.ok(server.includes('`/#chat/${conv.id}`'), 'announcement bells link the thread');
});

test('pins: server — the official thread is read-only for every role', () => {
  const send = server.slice(server.indexOf("app.post('/api/messages'"),
    server.indexOf("app.post('/api/messages/:id/react'"));
  assert.ok(send.includes('isHouseAccountId(conv.model_id) && (conv.is_official || !isModelSender)'),
    'official thread rejects all sends; legacy house threads stay fan-side-blocked');
});

test('pins: client — pinned first, Official pill, read-only chat, affiliate entry', () => {
  assert.ok(app.includes('.sort((a, b) => (b.is_official ? 1 : 0) - (a.is_official ? 1 : 0))'),
    'chat list pins the official thread first');
  assert.ok(app.includes("c.is_official ? ` <span class=\"official-pill\">${t('official_label')}</span>` : ''"),
    'chat list item carries the Official pill');
  assert.ok(app.includes('if (isOfficial) return;'), 'chat view stops before composer wiring');
  assert.ok(app.includes("ftr.outerHTML = `<div class=\"official-readonly\">${t('official_readonly_hint')}</div>`"),
    'composer is replaced by the read-only bar');
  assert.ok(app.includes('id="aff-notices"'), 'affiliate dashboard has a notices entry slot');
  assert.ok(css.includes('.official-readonly'), 'read-only bar is styled');
});

test('pins: client — announcement bells resolve to the official thread', () => {
  const open = app.slice(app.indexOf('async function openNotifThread('),
    app.indexOf('// Bell-tap routing'));
  assert.ok(open.includes('convs.find((c) => c.is_official)'),
    'legacy (link-less) announcement taps prefer the official thread');
  assert.ok(open.includes("c.other.role === 'admin'"), 'admin thread stays the fallback');
  const route = app.slice(app.indexOf('function routeNotifTap('),
    app.indexOf("app.querySelectorAll('[data-notif]')"));
  assert.ok(route.includes("const ANNOUNCE_TYPES = ['fan_news', 'fan_languages', 'suggestion_box',"),
    'fan-blast bell types route to the thread');
  assert.ok(route.includes('ANNOUNCE_TYPES.includes(n.type)'), 'announcement types join the legacy branch');
});

test('pins: rider — FaceTime bells resolve the model name through ftPublic', () => {
  assert.ok(!server.includes('{ model: fresh.model_name }'),
    'ftGet rows carry no model_name — the raw field must never feed a bell again');
  assert.equal(server.split('ftPublic(fresh).model_name').length - 1, 2,
    'both FaceTime bell sites (turn + accepted) use ftPublic');
});

/* ---------------- live harness ---------------- */

let tmpDir = null;
let child = null;
let base = null;
let childLog = '';
let house = null, model = null, fan = null, recruiter = null;
let convIds = {}; // userId -> official conversation id

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

async function req(method, p, { body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = 'Bearer ' + token;
  const r = await fetch(base + p, {
    method, headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* HTML or empty */ }
  return { status: r.status, text, json };
}

function dbExec(sql, params = []) {
  const db = new DatabaseSync(path.join(tmpDir, 'wogent-chat.db'));
  try { db.prepare(sql).run(...params); } finally { db.close(); }
}
function dbAll(sql, params = []) {
  const db = new DatabaseSync(path.join(tmpDir, 'wogent-chat.db'), { readOnly: true });
  try { return db.prepare(sql).all(...params); } finally { db.close(); }
}
function dbOne(sql, params = []) { return dbAll(sql, params)[0] || null; }

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
  await waitForServer();
}

async function stop() {
  if (!child) return;
  const c = child;
  child = null;
  if (c.exitCode === null) {
    c.kill('SIGTERM');
    await Promise.race([
      new Promise((r) => c.once('exit', r)),
      new Promise((r) => setTimeout(r, 3000)),
    ]);
    if (c.exitCode === null) c.kill('SIGKILL');
  }
}

const officialConvRow = (userId) => dbOne(
  'SELECT * FROM conversations WHERE fan_id = ? AND model_id = ? AND is_official = 1',
  [userId, house.id]);
const threadBodies = (convId) => dbAll(
  'SELECT body FROM messages WHERE conversation_id = ? ORDER BY id', [convId]).map((m) => m.body);
const bellOf = async (token, type) => {
  const n = await req('GET', '/api/notifications', { token });
  assert.equal(n.status, 200, 'notifications fetch: ' + n.text);
  return (n.json.notifications || []).find((x) => x.type === type) || null;
};
const listHas = async (token, convId) => {
  const r = await req('GET', '/api/conversations', { token });
  assert.equal(r.status, 200, 'conversation list: ' + r.text);
  return (r.json.conversations || []).find((c) => c.id === convId) || null;
};

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-notices-'));
  for (const f of ['server.js', 'package.json']) {
    fs.copyFileSync(path.join(REPO, f), path.join(tmpDir, f));
  }
  for (const d of ['lib', 'public', 'data']) {
    fs.cpSync(path.join(REPO, d), path.join(tmpDir, d), { recursive: true });
  }
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(tmpDir, 'node_modules'), 'dir');
});

test.after(async () => {
  await stop();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('live: deploy announcement creates one official thread per user, bell opens it, exactly once', { timeout: 240000 }, async () => {
  await boot();
  const suffix = Math.random().toString(36).slice(2, 8);
  const signup = async (username, role, display) => {
    const s = await req('POST', '/api/auth/signup', {
      body: { username, password: 'notices-pass-1', role, display_name: display, dob: '1997-05-20', agree18: true },
    });
    assert.equal(s.status, 200, `${role} signup (${username}) failed: ${s.text}`);
    return { token: s.json.token, id: s.json.user.id, username };
  };
  house = await signup('asceaaspade', 'model', 'SlutCamp');
  model = await signup('noticesmodel' + suffix, 'model', 'Notices Model');
  fan = await signup('noticesfan' + suffix, 'fan', 'Notices Fan');
  const rr = await req('POST', '/api/affiliate/signup', {
    body: { username: 'noticesrec' + suffix, password: 'notices-pass-1', display_name: 'Notices Rec', agreed: true },
  });
  assert.equal(rr.status, 200, 'recruiter signup: ' + rr.text);
  recruiter = { token: rr.json.token, id: rr.json.user.id, username: 'noticesrec' + suffix };

  // The first boot had no house account when the sweeps ran, so the
  // launch sweep must not have stamped itself away — unstamp
  // defensively and reboot: everyone who exists NOW gets it. (The
  // model already HAS an official thread from her signup: the
  // welcome DM at signup routes into it now that the house account
  // exists. That is the design working, not a leak.)
  dbExec('UPDATE platform_stats SET official_inbox_announced_at = NULL WHERE id = 1');
  // The chat-retention announcement is a SEPARATE one-time broadcast
  // into the same official threads — stamp it as already sent so this
  // scenario measures the launch announcement alone.
  dbExec("UPDATE platform_stats SET chat_retention_announced_at = datetime('now') WHERE id = 1");
  await stop();
  await boot();

  for (const u of [model, fan, recruiter]) {
    const rows = dbAll(
      'SELECT * FROM conversations WHERE fan_id = ? AND model_id = ? AND is_official = 1',
      [u.id, house.id]);
    assert.equal(rows.length, 1, `${u.username}: exactly ONE official thread`);
    const conv = rows[0];
    convIds[u.id] = conv.id;
    const bodies = threadBodies(conv.id);
    const launch = bodies.filter((b) => b.includes('SlutCamp notices have a home'));
    assert.equal(launch.length, 1, `${u.username}: launch copy present exactly once`);
    if (u !== model) {
      assert.equal(bodies.length, 1, `${u.username}: the launch message is the only entry`);
    }
    const bell = await bellOf(u.token, 'official_inbox');
    assert.ok(bell, `${u.username}: launch bell exists`);
    assert.equal(bell.link, `/#chat/${conv.id}`, `${u.username}: bell opens the official thread`);
  }
  const stamp = dbOne('SELECT official_inbox_announced_at AS s FROM platform_stats WHERE id = 1');
  assert.ok(stamp && stamp.s, 'deploy stamp is set after the sweep');

  // Lists: model + recruiter hold it (flagged), fan holds it while unread.
  const mEntry = await listHas(model.token, convIds[model.id]);
  assert.ok(mEntry && mEntry.is_official === true, 'model list carries the flagged official thread');
  assert.ok(await listHas(recruiter.token, convIds[recruiter.id]), 'recruiter list carries the thread');
  assert.ok(await listHas(fan.token, convIds[fan.id]), 'fan list carries it while unread');

  // Recruiter reads everything — the thread STAYS (affiliate tab is permanent).
  const rr2 = await req('POST', `/api/conversations/${convIds[recruiter.id]}/read`, { token: recruiter.token });
  assert.equal(rr2.status, 200, 'recruiter read-all: ' + rr2.text);
  assert.ok(await listHas(recruiter.token, convIds[recruiter.id]),
    'recruiter keeps the thread after read-all');

  // Fan reads everything — the thread steps aside.
  const fr = await req('POST', `/api/conversations/${convIds[fan.id]}/read`, { token: fan.token });
  assert.equal(fr.status, 200, 'fan read-all: ' + fr.text);
  assert.equal(await listHas(fan.token, convIds[fan.id]), null,
    'fan list drops the thread once everything is read');
});

test('live: the official thread rejects sends from fan, model, recruiter and the house account', { timeout: 120000 }, async () => {
  const countsBefore = {};
  for (const u of [model, fan, recruiter]) countsBefore[u.id] = threadBodies(convIds[u.id]).length;
  const send = (token, convId) => req('POST', '/api/messages', {
    token, body: { conversation_id: convId, body: 'let me reply to the app' },
  });
  for (const [who, u] of [['fan', fan], ['model', model], ['recruiter', recruiter]]) {
    const r = await send(u.token, convIds[u.id]);
    assert.equal(r.status, 403, `${who} send must be rejected: ${r.text}`);
    assert.equal(r.json.error, 'cannot_message_official', `${who} gets the official error code`);
  }
  const hr = await send(house.token, convIds[model.id]);
  assert.equal(hr.status, 403, 'even the house account cannot post through the endpoint: ' + hr.text);
  assert.equal(hr.json.error, 'cannot_message_official');
  // And nothing landed anywhere.
  for (const u of [model, fan, recruiter]) {
    assert.equal(threadBodies(convIds[u.id]).length, countsBefore[u.id],
      `${u.username}: no reply persisted`);
  }
});

test('live: a model announcement lands in the SAME official thread; the launch never repeats', { timeout: 240000 }, async () => {
  const modelBefore = threadBodies(convIds[model.id]).length;
  const fanBefore = threadBodies(convIds[fan.id]).length;
  dbExec('UPDATE platform_stats SET thread_tap_announced_at = NULL WHERE id = 1');
  await stop();
  await boot();
  const bodies = threadBodies(convIds[model.id]);
  assert.equal(bodies.length, modelBefore + 1, 'model thread gains the announcement in the same thread');
  assert.ok(bodies.some((b) => b.includes('tap a notification')),
    'thread-tap announcement copy is in the official thread');
  const msg = dbOne('SELECT sender_id FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1',
    [convIds[model.id]]);
  assert.equal(msg.sender_id, house.id, 'announcement sender is the house account');
  const bell = await bellOf(model.token, 'thread_tap');
  assert.ok(bell, 'thread-tap bell exists');
  assert.equal(bell.link, `/#chat/${convIds[model.id]}`, 'model announcement bell opens the official thread');
  // The fan got no model announcement.
  assert.equal(threadBodies(convIds[fan.id]).length, fanBefore, 'fan thread untouched by the model broadcast');
  // The deploy announcement did not repeat on this boot.
  const inboxBells = dbAll("SELECT id FROM notifications WHERE user_id = ? AND type = 'official_inbox'", [model.id]);
  assert.equal(inboxBells.length, 1, 'launch bell sent exactly once across boots');
});

test('live: a fan blast persists into the fan thread, its bell opens it, and it re-pins the fan list', { timeout: 240000 }, async () => {
  dbExec('UPDATE platform_stats SET fan_preview_announced_at = NULL WHERE id = 1');
  await stop();
  await boot();
  const bodies = threadBodies(convIds[fan.id]);
  assert.ok(bodies.some((b) => b.includes('Her profile video plays now')),
    'fan blast message persisted into the official thread');
  const bell = await bellOf(fan.token, 'fan_news');
  assert.ok(bell, 'fan blast bell exists');
  assert.equal(bell.link, `/#chat/${convIds[fan.id]}`, 'fan blast bell opens the official thread');
  // It reappears in the fan list while unread…
  assert.ok(await listHas(fan.token, convIds[fan.id]), 'fan sees the thread again with a new unread');
  // …and the model thread never receives fan blasts.
  assert.ok(!threadBodies(convIds[model.id]).some((b) => b.includes('Her profile video plays now')),
    'model thread has no fan blast');
});

test('live: a fan holding the affiliate capability keeps the thread permanently', { timeout: 120000 }, async () => {
  const fr = await req('POST', `/api/conversations/${convIds[fan.id]}/read`, { token: fan.token });
  assert.equal(fr.status, 200, 'fan read-all: ' + fr.text);
  assert.equal(await listHas(fan.token, convIds[fan.id]), null, 'plain fan: thread gone after read-all');
  dbExec('INSERT INTO recruiters (user_id, name, referral_code) VALUES (?, ?, ?)',
    [fan.id, 'Notices Fan', 'noticescap' + fan.id]);
  assert.ok(await listHas(fan.token, convIds[fan.id]),
    'capability holder: thread stays even with everything read');
});
