'use strict';
/*
 * Model Broadcast to favorites (Assignment 13, Ms. Pink, Oct 27 2026).
 *
 * A model writes ONE message; the server fans it out to every fan who
 * follows her (Playlist/favorites adds), banned=0 only, through the
 * EXISTING 1:1 chat rails: the message lands in her existing thread
 * with each fan as a normal message from her (thread created if none
 * exists), with the usual new-message notify/bell behaviour (live
 * push + web-push buzz + conversation unread badge — exactly what a
 * normal model reply produces; no new messaging system, no new
 * thread type). No frequency limit is set by Asce, so none is
 * enforced here. All new client strings live in I18N in all 13
 * languages.
 *
 * Live tests below boot the real server in a temp dir (same pattern
 * as tests/model-top-spenders.test.js): seed boot, stop, fixture
 * rows written straight to the temp DB, reboot, then the real
 * endpoint.
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
const bcrypt = require('bcryptjs');

const REPO = path.join(__dirname, '..');
const SERVER_JS = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
const APP_JS = fs.readFileSync(path.join(REPO, 'public', 'js', 'app.js'), 'utf8');
const LANG13 = ['en', 'es', 'pt', 'fr', 'de', 'ru', 'ja', 'zh', 'ko', 'it', 'pl', 'nl', 'tr'];

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-broadcast-'));
  for (const d of ['server.js', 'package.json', 'lib', 'public', 'data']) {
    fs.cpSync(path.join(REPO, d), path.join(dir, d), { recursive: true });
  }
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  return dir;
}

async function boot(dir) {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), CRYPTO_POLL_MS: '3600000' };
  for (const k of Object.keys(env)) {
    if (/^(CCBILL_|CRYPTO_|OPENAI_|TWILIO_|VAPID_|WEBAUTHN_|AV_)/.test(k)) delete env[k];
  }
  delete env.SEED_DEMO;
  const child = spawn(process.execPath, ['server.js'], { cwd: dir, env });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode})\n${log}`);
    try {
      const r = await fetch(base + '/api/health');
      if (r.ok) break;
    } catch (e) { /* not up yet */ }
    if (Date.now() > deadline) { child.kill('SIGKILL'); throw new Error(`server did not come up\n${log}`); }
    await new Promise((r) => setTimeout(r, 150));
  }
  return { child, base };
}

function stop(handle) {
  if (handle && handle.child && handle.child.exitCode === null) handle.child.kill('SIGKILL');
}

async function req(base, method, p, { body, token } = {}) {
  const h = {};
  if (body !== undefined) h['content-type'] = 'application/json';
  if (token) h.authorization = 'Bearer ' + token;
  const r = await fetch(base + p, {
    method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: r.status, json, text };
}

async function login(base, username, password) {
  const r = await req(base, 'POST', '/api/auth/login', { body: { username, password } });
  assert.equal(r.status, 200, `login works for ${username}: ${r.text.slice(0, 200)}`);
  return r.json.token;
}

/* Fixture: model 'bcastmodel' with followers fanA (existing thread),
 * fanB (no thread yet), fanBan (follower, banned), fanD (follower,
 * thread paused by the safety monitor). fanC follows nobody.
 * fanE follows a DIFFERENT model only. */
function seedFixtures(dir) {
  const db = new DatabaseSync(path.join(dir, 'wogent-chat.db'));
  try {
    const addUser = (username, password, role, displayName) => {
      const info = db.prepare(
        'INSERT INTO users (username, password_hash, role, display_name, dob, language) VALUES (?,?,?,?,?,?)')
        .run(username, bcrypt.hashSync(password, 10), role, displayName, '1994-03-03', 'en');
      const id = Number(info.lastInsertRowid);
      db.prepare('INSERT INTO wallets (user_id) VALUES (?)').run(id);
      if (role === 'model') db.prepare('INSERT INTO models (user_id) VALUES (?)').run(id);
      return id;
    };
    const modelId = addUser('bcastmodel', 'model-pass-1', 'model', 'Bcast Model');
    const otherModelId = addUser('othermodel', 'model-pass-1', 'model', 'Other Model');
    const fanA = addUser('fanA', 'fan-pass-1', 'fan', 'Fan Alpha');
    const fanB = addUser('fanB', 'fan-pass-1', 'fan', 'Fan Beta');
    const fanC = addUser('fanC', 'fan-pass-1', 'fan', 'Fan Charlie');
    const fanBan = addUser('fanBan', 'fan-pass-1', 'fan', 'Fan Banned');
    const fanD = addUser('fanD', 'fan-pass-1', 'fan', 'Fan Paused');
    const fanE = addUser('fanE', 'fan-pass-1', 'fan', 'Fan Elsewhere');
    db.prepare('UPDATE users SET banned = 1 WHERE id = ?').run(fanBan);
    const follow = db.prepare('INSERT INTO follows (fan_id, model_id) VALUES (?,?)');
    follow.run(fanA, modelId);
    follow.run(fanB, modelId);
    follow.run(fanBan, modelId);
    follow.run(fanD, modelId);
    follow.run(fanE, otherModelId);
    const convA = db.prepare(
      `INSERT INTO conversations (fan_id, model_id, updated_at) VALUES (?,?,?)`)
      .run(fanA, modelId, '2026-10-27 10:00:00');
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    db.prepare(
      `INSERT INTO conversations (fan_id, model_id, is_paused, paused_at, updated_at) VALUES (?,?,?,?,?)`)
      .run(fanD, modelId, 1, now, '2026-10-27 10:00:00');
    return { modelId, otherModelId, fanA, fanB, fanC, fanBan, fanD, fanE, convAId: Number(convA.lastInsertRowid) };
  } finally { db.close(); }
}

function messagesFor(dir, fanId, modelId) {
  const db = new DatabaseSync(path.join(dir, 'wogent-chat.db'), { readOnly: true });
  try {
    return db.prepare(
      `SELECT m.* FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE c.fan_id = ? AND c.model_id = ? ORDER BY m.id`).all(fanId, modelId);
  } finally { db.close(); }
}

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

function evalBlock(src, marker, name) {
  const [s, e] = literalSpan(src, marker);
  const sb = {};
  vm.createContext(sb);
  vm.runInContext(marker + ' ' + src.slice(s, e) + `;\nthis.__v = ${name};`, sb);
  return sb.__v;
}

test('broadcast: followers only, banned excluded, thread reuse/creation, exactly one per fan', { timeout: 180000 }, async (t) => {
  const dir = makeCopy();
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* temp cleanup */ } });
  let h = await boot(dir);
  stop(h);
  const fx = seedFixtures(dir);
  h = await boot(dir);
  t.after(() => stop(h));

  const modelToken = await login(h.base, 'bcastmodel', 'model-pass-1');
  const fanToken = await login(h.base, 'fanA', 'fan-pass-1');

  // Role gates: fans cannot broadcast; unauthenticated cannot either.
  const fanTry = await req(h.base, 'POST', '/api/model/broadcast', { token: fanToken, body: { body: 'hi' } });
  assert.equal(fanTry.status, 403, 'fans cannot broadcast');
  const anonTry = await req(h.base, 'POST', '/api/model/broadcast', { body: { body: 'hi' } });
  assert.equal(anonTry.status, 401, 'broadcast requires login');
  const emptyTry = await req(h.base, 'POST', '/api/model/broadcast', { token: modelToken, body: { body: '   ' } });
  assert.equal(emptyTry.status, 400, 'empty broadcast rejected');

  // The broadcast itself.
  const bc = await req(h.base, 'POST', '/api/model/broadcast',
    { token: modelToken, body: { body: 'Going live tonight!' } });
  assert.equal(bc.status, 200, `broadcast answers: ${bc.text}`);
  assert.equal(bc.json.sent, 2, 'exactly the two unbanned, unpaused followers receive it');
  assert.equal(bc.json.skipped_paused, 1, 'the paused thread is skipped and reported');

  // Exactly one message per recipient, in the right threads, free.
  const msgsA = messagesFor(dir, fx.fanA, fx.modelId);
  assert.equal(msgsA.length, 1, 'fanA gets exactly one message');
  assert.equal(msgsA[0].body, 'Going live tonight!');
  assert.equal(msgsA[0].sender_id, fx.modelId, 'message is from the model');
  assert.equal(msgsA[0].cost_cents, 0, 'model sends are free — no price invented');
  assert.equal(msgsA[0].conversation_id, fx.convAId, 'fanA reuses her existing thread');
  const msgsB = messagesFor(dir, fx.fanB, fx.modelId);
  assert.equal(msgsB.length, 1, 'fanB gets exactly one message');
  assert.equal(msgsB[0].body, 'Going live tonight!');
  assert.notEqual(msgsB[0].conversation_id, fx.convAId, 'fanB gets a thread created for her');
  assert.equal(messagesFor(dir, fx.fanC, fx.modelId).length, 0, 'non-follower gets nothing');
  assert.equal(messagesFor(dir, fx.fanBan, fx.modelId).length, 0, 'banned follower never receives');
  assert.equal(messagesFor(dir, fx.fanD, fx.modelId).length, 0, 'paused thread is not forced open');
  assert.equal(messagesFor(dir, fx.fanE, fx.modelId).length, 0, 'follower of another model gets nothing');

  // The fan side sees it as a normal unread chat message.
  const fanAToken = await login(h.base, 'fanA', 'fan-pass-1');
  const convs = await req(h.base, 'GET', '/api/conversations', { token: fanAToken });
  assert.equal(convs.status, 200);
  const mine = (convs.json.conversations || []).find((c) => c.other && c.other.username === 'bcastmodel');
  assert.ok(mine, 'fanA sees the thread');
  assert.ok(mine.unread_count >= 1, 'broadcast counts as an unread chat message');
  const thread = await req(h.base, 'GET', `/api/conversations/${mine.id}/messages`, { token: fanAToken });
  assert.ok((thread.json.messages || []).some((m) => m.body === 'Going live tonight!'),
    'broadcast body is readable in the normal thread');

  // A second broadcast adds exactly one more per recipient — no fan-out duplication.
  const bc2 = await req(h.base, 'POST', '/api/model/broadcast',
    { token: modelToken, body: { body: 'Live in 10 minutes!' } });
  assert.equal(bc2.json.sent, 2);
  assert.equal(messagesFor(dir, fx.fanA, fx.modelId).length, 2, 'second send adds one, not a duplicate batch');
  assert.equal(messagesFor(dir, fx.fanB, fx.modelId).length, 2);
});

test('broadcast strings: all new keys exist in all 13 languages', () => {
  const I18N = evalBlock(APP_JS, 'const I18N =', 'I18N');
  const keys = ['broadcast_h', 'broadcast_sub', 'broadcast_ph', 'broadcast_send',
    'broadcast_sent', 'broadcast_empty', 'broadcast_blocked'];
  for (const lang of LANG13) {
    for (const k of keys) {
      assert.equal(typeof I18N[lang][k], 'string', `${lang}:${k} exists`);
      assert.ok(I18N[lang][k].trim().length > 0, `${lang}:${k} non-empty`);
    }
    assert.ok(I18N[lang].broadcast_sent.includes('{n}'), `${lang}: sent message names the count`);
  }
  assert.equal(I18N.en.broadcast_h, '📣 Message all your favorites');
  assert.equal(I18N.en.broadcast_send, 'Send to all favorites');
});

test('pins: broadcast endpoint + model message-list compose box, existing rails only', () => {
  assert.ok(SERVER_JS.includes("app.post('/api/model/broadcast'"), 'broadcast endpoint exists');
  assert.ok(SERVER_JS.includes("FROM follows f JOIN users u"), 'audience is the follows table, banned=0');
  assert.ok(SERVER_JS.includes("INSERT INTO conversations (fan_id, model_id)"), 'threads are created on the existing rails');
  assert.ok(SERVER_JS.includes("pushToSubject(`u:${d.fan_id}`"), 'live push goes to each fan like a normal reply');
  assert.ok(SERVER_JS.includes('buzzChatRecipient(d.fan_id'), 'web-push buzz goes to each fan like a normal reply');
  assert.ok(!SERVER_JS.includes('CREATE TABLE IF NOT EXISTS broadcasts'), 'no new messaging system / broadcast table');
  assert.ok(APP_JS.includes('id="broadcast-box"'), 'model message list carries the broadcast box');
  assert.ok(APP_JS.includes("t('broadcast_send')"), 'compose box send uses the ×13 string');
  assert.ok(APP_JS.includes("api('/model/broadcast'"), 'compose box posts to the broadcast endpoint');
  assert.ok(APP_JS.includes("role === 'model' ? `"), 'broadcast box is model-surface only');
});
