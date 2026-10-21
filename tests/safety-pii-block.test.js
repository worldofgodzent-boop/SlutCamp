'use strict';
/*
 * Safety build — PII hard-block + no-off-platform-promotion enforcement
 * (owner-directed 2026-10-20; spec: safety-pii-hardblock-spec.md).
 *
 * Pins the locked design:
 *  - On a chat-path safety match the message is BLOCKED ONLY: no message
 *    row stored, the chat is NOT paused, the other side receives nothing,
 *    the sender is not charged (free-trial count untouched), the incident
 *    is recorded with REDACTED text only, and the strike + the client
 *    explanation payload {blocked:true,...} still happen.
 *  - The edit path behaves identically (original body intact).
 *  - A boot scrub replaces pre-existing is_flagged=1 bodies with the
 *    removal notice and redacts stored incident texts (idempotent).
 *  - Manager warn-a-fan: POST /api/admin/fans/:id/message (+ thread GET)
 *    mirrors the admin→model path.
 *  - Promotion: model bios are scanned on save and REJECTED whole on a
 *    hit; model DMs fall under the same hard-block; fan-side chat scope
 *    stays PII-only (a fan naming another platform is NOT blocked).
 *  - The promotion keyword set is seeded into safety_keywords, and the
 *    model announcement ships as code (ann_safety_* SRV ×13 + stamp).
 *
 * Harness: reactions.test.js / faceguard-announcement.test.js patterns —
 * the real server boots in throwaway temp copies with SEED_DEMO=1.
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
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const serverSrc = read('server.js');
const appSrc = read('public/js/app.js');
const managerSrc = read('public/manager/manager.js');

/* ---------------- SRV eval helpers (faceguard-announcement pattern) --- */

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
const LANGS = ['en', 'es', 'pt', 'fr', 'de', 'ru', 'ja', 'zh', 'ko', 'it', 'pl', 'nl', 'tr'];

/* ---------------- static pins ---------------- */

test('static: promotion machinery exists in server.js (scan, scope, redaction)', () => {
  assert.ok(serverSrc.includes('const PROMOTION_TERMS = ['), 'PROMOTION_TERMS constant present');
  assert.ok(serverSrc.includes("INSERT OR IGNORE INTO safety_keywords (keyword) VALUES (?)"),
    'promotion terms are seeded insert-if-missing');
  assert.ok(serverSrc.includes('function promotionScan(text)'), 'promotionScan present');
  assert.ok(serverSrc.includes('function isPromotionMatch(matched)'), 'isPromotionMatch present');
  assert.ok(serverSrc.includes('function chatScan(text, isModelSender)'), 'chatScan scoping present');
  assert.ok(serverSrc.includes('function redactForIncident(text)'), 'redactForIncident present');
  assert.ok(serverSrc.includes("const SAFETY_REMOVED_BODY = '🚫 Message removed by SlutCamp safety';"),
    'removal placeholder is the spec text');
  // A spread of seeded terms across all four spec groups
  for (const term of ['onlyfans', 'fansly.com', 'manyvids', 'chaturbate', 'sextpanther',
    'linktr.ee', 'beacons.ai', 'allmylinks', 'link in bio',
    'cash app', 'wise.com', 'revolut', 'apple pay me',
    't.me', 'discord.gg', 'snapchat.com', 'x.com']) {
    assert.ok(serverSrc.includes(`'${term}'`), `seeded term present: ${term}`);
  }
});

test('static: send + edit paths hard-block (no pause, no flagged insert, redacted incident)', () => {
  const sendStart = serverSrc.indexOf("app.post('/api/messages'");
  assert.ok(sendStart >= 0);
  const sendBlock = serverSrc.slice(sendStart, sendStart + 9000);
  assert.ok(sendBlock.includes('const matched = chatScan(text, isModelSender);'), 'send path uses chatScan');
  assert.ok(sendBlock.includes('redactForIncident(text)'), 'send incident text is redacted');
  assert.ok(sendBlock.includes('{ blocked: true, matched, strikes: totalStrikes,'), 'send returns the blocked payload');
  assert.ok(!sendBlock.slice(0, sendBlock.indexOf('--- 2. FREE TRIAL')).includes('is_paused = 1'),
    'send path never pauses on a scan hit');

  const editStart = serverSrc.indexOf("app.post('/api/messages/:id/edit'");
  assert.ok(editStart >= 0);
  const editBlock = serverSrc.slice(editStart, editStart + 5000);
  assert.ok(editBlock.includes('const matched = chatScan(text,'), 'edit path uses chatScan');
  assert.ok(editBlock.includes('redactForIncident(text)'), 'edit incident text is redacted');
  assert.ok(editBlock.includes('{ blocked: true, matched, strikes: totalStrikes,'), 'edit returns the blocked payload');
  assert.ok(!editBlock.includes('is_paused = 1'), 'edit path never pauses on a scan hit');
});

test('static: live detectors extended with the promotion set', () => {
  assert.ok(serverSrc.includes('const matched = safetyScan(body) || promotionScan(body);'),
    'live chat scans promotion');
  assert.ok(serverSrc.includes('const matched = safetyScan(text) || promotionScan(text);'),
    'speech scan includes promotion');
  assert.ok(serverSrc.includes('const matched = safetyScan(message) || promotionScan(message);'),
    'live priority scans promotion');
  assert.ok(serverSrc.includes("promo ? 'promotion_shared' : 'payment_info_shared'"),
    'live chat promotion hit kills at the payment tier');
  assert.ok(serverSrc.includes("promo ? 'promotion_spoken' : 'payment_info_spoken'"),
    'spoken promotion hit kills at the payment tier');
});

test('static: bio save is scanned and rejected whole', () => {
  const start = serverSrc.indexOf("app.put('/api/model/profile'");
  assert.ok(start >= 0);
  const block = serverSrc.slice(start, start + 2500);
  assert.ok(block.includes('const bioHit = safetyScan(bio) || promotionScan(bio);'), 'bio scanned');
  assert.ok(block.includes("{ error: 'bio_not_allowed', matched: bioHit }"), 'bio rejection payload');
  assert.ok(block.indexOf('bioHit') < block.indexOf("updates.push('bio = ?')"),
    'the scan runs before any profile field is applied');
});

test('static: client explains blocks on screen (STR ×13 + branches)', () => {
  assert.equal((appSrc.match(/safety_blocked_info:/g) || []).length, 13,
    'safety_blocked_info defined in all 13 language blocks');
  assert.equal((appSrc.match(/bio_not_allowed_info:/g) || []).length, 13,
    'bio_not_allowed_info defined in all 13 language blocks');
  assert.ok(appSrc.includes("That message wasn\\'t sent 💋 Personal contact info (phone numbers, emails, socials) can\\'t be shared on SlutCamp"),
    'EN explanation is the spec copy');
  assert.ok(appSrc.includes("if (status === 200 && data.blocked)"), 'client handles the blocked payload');
  assert.ok(appSrc.includes("toast(t('safety_blocked_info'), 6000)"), 'sender/blocked-edit explanation toast');
  assert.ok(appSrc.includes("data.error === 'bio_not_allowed'"), 'bio save surfaces the rejection');
  assert.ok(appSrc.includes("toast(t('bio_not_allowed_info'), 6000)"), 'bio explanation toast');
});

test('static: announcement copy exists in all 13 languages (SRV ann_safety_*)', () => {
  for (const key of ['ann_safety_dm', 'ann_safety_bell_title', 'ann_safety_bell_body']) {
    const row = SRV[key];
    assert.ok(row, key + ' exists in SRV');
    assert.deepEqual(Object.keys(row).sort(), [...LANGS].sort(), key + ' covers all 13 languages');
    for (const l of LANGS) assert.ok(row[l] && row[l].length > 10, `${key}.${l} is real copy`);
  }
  assert.ok(SRV.ann_safety_dm.en.includes('BLOCKS messages that contain personal contact info'),
    'EN announcement DM carries the hard-block rule');
  assert.ok(SRV.ann_safety_dm.en.includes('bios can\'t mention other websites'),
    'EN announcement DM carries the no-promotion rule');
  assert.ok(serverSrc.includes("addColumnIfMissing('platform_stats', 'safety_announced_at', 'TEXT')"),
    'one-time stamp column registered');
  assert.ok(serverSrc.includes('function announceSafetyToModels()'), 'announcement function present');
});

test('static: Manager warn-a-fan surface exists (endpoints + Fans-tab action)', () => {
  assert.ok(serverSrc.includes("app.get('/api/admin/fans/:id/thread', ...adminOnly"), 'fan thread GET is admin-only');
  assert.ok(serverSrc.includes("app.post('/api/admin/fans/:id/message', ...adminOnly"), 'fan message POST is admin-only');
  assert.ok(managerSrc.includes('data-f-msg="${f.id}"'), 'Fans tab has a Message action');
  assert.ok(managerSrc.includes('<div id="fedit-${f.id}"></div>'), 'Fans tab has the thread editor box');
  assert.ok(managerSrc.includes('`/admin/fans/${id}/message`'), 'Manager posts to the fan endpoint');
});

/* ---------------- server harness (reactions pattern) ---------------- */

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

async function req(method, p, { body, token, headers: extraHeaders } = {}) {
  const headers = { ...(extraHeaders || {}) };
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

function readDb() {
  return new DatabaseSync(path.join(tmpDir, 'wogent-chat.db'), { readOnly: true });
}

let fanA = null, fanB = null, model = null, admin = null, convId = null, cleanMsgId = null;

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-safety-'));
  for (const f of ['server.js', 'package.json']) {
    fs.copyFileSync(path.join(REPO, f), path.join(tmpDir, f));
  }
  for (const d of ['lib', 'public', 'data']) {
    fs.cpSync(path.join(REPO, d), path.join(tmpDir, d), { recursive: true });
  }
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(tmpDir, 'node_modules'), 'dir');

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

  const suffix = Math.random().toString(36).slice(2, 8);
  const mkFan = async (name) => {
    const s = await req('POST', '/api/auth/signup', {
      body: { username: name + suffix, password: 'safety-pass-1', role: 'fan', display_name: name, dob: '1995-06-15', agree18: true },
    });
    assert.equal(s.status, 200, `fan signup failed: ${s.text}`);
    return { token: s.json.token, id: s.json.user.id };
  };
  fanA = await mkFan('sfana');
  fanB = await mkFan('sfanb');

  const models = await req('GET', '/api/models');
  assert.equal(models.status, 200);
  const bunny = models.json.models.find((m) => m.username === 'bunny');
  assert.ok(bunny, 'seeded model bunny must exist');
  const ml = await req('POST', '/api/auth/login', { body: { username: 'bunny', password: 'model123' } });
  assert.equal(ml.status, 200, `model login failed: ${ml.text}`);
  model = { token: ml.json.token, id: bunny.id };

  const al = await req('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' } });
  assert.equal(al.status, 200, `admin login failed: ${al.text}`);
  // /api/admin/* rides the Manager channel: admin token + X-Manager header
  admin = { token: al.json.token, id: al.json.user.id, headers: { 'x-manager': '1' } };

  const start = await req('POST', '/api/conversations/start', { body: { model_id: bunny.id }, token: fanA.token });
  assert.equal(start.status, 200, `conversation start failed: ${start.text}`);
  convId = start.json.conversation.id;
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

/* ---------------- API: the hard block ---------------- */

test('block: fan phone message — no row, no pause, no charge, redacted incident, strike lands', async () => {
  const db0 = readDb();
  const bellsBefore = db0.prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ?').get(model.id).c;
  const creditsBefore = db0.prepare('SELECT credits_cents FROM wallets WHERE user_id = ?').get(fanA.id).credits_cents;
  db0.close();

  const r = await req('POST', '/api/messages', {
    body: { conversation_id: convId, body: 'my digits are 484 687 5677' }, token: fanA.token,
  });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.blocked, true);
  assert.equal(r.json.matched, 'phone_number');
  assert.equal(r.json.strikes, 1);
  assert.equal(r.json.auto_flagged, false);
  assert.equal(r.json.message, undefined, 'no message payload on a block');

  const db = readDb();
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ?').get(convId).c, 0,
    'no message row is stored');
  assert.equal(db.prepare('SELECT is_paused FROM conversations WHERE id = ?').get(convId).is_paused, 0,
    'the chat is NOT paused');
  const trial = db.prepare('SELECT free_used FROM free_trials WHERE subject_key = ? AND model_id = ?')
    .get(`u:${fanA.id}`, model.id);
  assert.ok(!trial || trial.free_used === 0, 'free-trial count untouched');
  assert.equal(db.prepare('SELECT credits_cents FROM wallets WHERE user_id = ?').get(fanA.id).credits_cents,
    creditsBefore, 'sender not charged');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ?').get(model.id).c,
    bellsBefore, 'the other side receives nothing');
  const inc = db.prepare('SELECT * FROM safety_incidents WHERE conversation_id = ?').all(convId);
  assert.equal(inc.length, 1, 'exactly one incident recorded');
  assert.equal(inc[0].matched, 'phone_number');
  assert.ok(!inc[0].flagged_text.includes('484 687 5677') && !inc[0].flagged_text.includes('4846875677'),
    'raw number never reaches storage');
  assert.ok(inc[0].flagged_text.includes('•••77'), 'incident keeps only the redacted tail');
  assert.equal(db.prepare('SELECT strikes FROM strikes WHERE subject_key = ?').get(`u:${fanA.id}`).strikes, 1,
    'strike recorded');
  db.close();
});

test('block: a clean message right after a blocked one delivers normally', async () => {
  const r = await req('POST', '/api/messages', {
    body: { conversation_id: convId, body: 'hey bunny 💋' }, token: fanA.token,
  });
  assert.equal(r.status, 200, r.text);
  assert.ok(r.json.message && Number.isInteger(r.json.message.id), 'clean message lands');
  cleanMsgId = r.json.message.id;
  const db = readDb();
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ?').get(convId).c, 1);
  assert.equal(db.prepare('SELECT is_paused FROM conversations WHERE id = ?').get(convId).is_paused, 0);
  assert.equal(db.prepare('SELECT free_used FROM free_trials WHERE subject_key = ? AND model_id = ?')
    .get(`u:${fanA.id}`, model.id).free_used, 1, 'exactly one free slot used — by the clean message');
  db.close();
});

test('block: email message — redacted local part, still no pause', async () => {
  const r = await req('POST', '/api/messages', {
    body: { conversation_id: convId, body: 'reach me at jayfan99@example.com instead' }, token: fanA.token,
  });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.blocked, true);
  assert.equal(r.json.matched, 'email_address');
  assert.equal(r.json.strikes, 2);
  const db = readDb();
  const inc = db.prepare("SELECT * FROM safety_incidents WHERE conversation_id = ? AND matched = 'email_address'")
    .get(convId);
  assert.ok(inc, 'email incident recorded');
  assert.ok(!inc.flagged_text.includes('jayfan99'), 'email local part never reaches storage');
  assert.ok(inc.flagged_text.includes('j•••@example.com'), 'redacted email shape kept');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ?').get(convId).c, 1,
    'still only the one clean message in the thread');
  assert.equal(db.prepare('SELECT is_paused FROM conversations WHERE id = ?').get(convId).is_paused, 0);
  db.close();
});

test('block: edit into a phone number — original intact, no pause, no edit row', async () => {
  const start = await req('POST', '/api/conversations/start', { body: { model_id: model.id }, token: fanB.token });
  assert.equal(start.status, 200, start.text);
  const convB = start.json.conversation.id;
  const sent = await req('POST', '/api/messages', {
    body: { conversation_id: convB, body: 'hello from fan b' }, token: fanB.token,
  });
  assert.equal(sent.status, 200, sent.text);
  const msgId = sent.json.message.id;

  const r = await req('POST', `/api/messages/${msgId}/edit`, {
    body: { body: 'actually text me at 2125550147' }, token: fanB.token,
  });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.blocked, true);

  const db = readDb();
  assert.equal(db.prepare('SELECT body FROM messages WHERE id = ?').get(msgId).body, 'hello from fan b',
    'original body untouched');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM message_edits WHERE message_id = ?').get(msgId).c, 0,
    'a rejected edit writes no audit row');
  assert.equal(db.prepare('SELECT is_paused FROM conversations WHERE id = ?').get(convB).is_paused, 0,
    'edit block does not pause either');
  const inc = db.prepare('SELECT * FROM safety_incidents WHERE conversation_id = ?').get(convB);
  assert.ok(inc, 'edit incident recorded');
  assert.ok(!inc.flagged_text.includes('2125550147'), 'edit incident text is redacted');
  db.close();
});

test('block: model DM promotion is hard-blocked like PII', async () => {
  const r = await req('POST', '/api/messages', {
    body: { conversation_id: convId, body: 'find more of me on fansly 💋' }, token: model.token,
  });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.blocked, true, 'model promotion DM blocked');
  assert.ok(r.json.matched === 'fansly' || String(r.json.matched).startsWith('promotion_'),
    `promotion-class match, got: ${r.json.matched}`);
  const db = readDb();
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ?').get(convId).c, 1,
    'no promotion row stored');
  const inc = db.prepare("SELECT * FROM safety_incidents WHERE conversation_id = ? AND sender_role = 'model'")
    .get(convId);
  assert.ok(inc, 'model incident recorded');
  db.close();
});

test('scope: the same platform name from a FAN delivers (fan scope stays PII-only)', async () => {
  const r = await req('POST', '/api/messages', {
    body: { conversation_id: convId, body: 'do you ever post on fansly?' }, token: fanA.token,
  });
  assert.equal(r.status, 200, r.text);
  assert.ok(r.json.message && Number.isInteger(r.json.message.id),
    `fan message naming a platform must deliver, got: ${r.text}`);
});

/* ---------------- API: bio enforcement ---------------- */

test('bio: promotion bio rejected whole; clean bio saves', async () => {
  const db0 = readDb();
  const before = db0.prepare('SELECT bio FROM models WHERE user_id = ?').get(model.id).bio;
  db0.close();

  const bad = await req('PUT', '/api/model/profile', {
    body: { bio: '💋 all my links are on my linktr.ee page' }, token: model.token,
  });
  assert.equal(bad.status, 400, bad.text);
  assert.equal(bad.json.error, 'bio_not_allowed');
  assert.ok(bad.json.matched, 'rejection names the match');

  const db1 = readDb();
  assert.equal(db1.prepare('SELECT bio FROM models WHERE user_id = ?').get(model.id).bio, before,
    'rejected save changes nothing');
  db1.close();

  const good = await req('PUT', '/api/model/profile', {
    body: { bio: '💋 Texas girl — texts, voice, video and lives, right here' }, token: model.token,
  });
  assert.equal(good.status, 200, good.text);
  const db2 = readDb();
  assert.equal(db2.prepare('SELECT bio FROM models WHERE user_id = ?').get(model.id).bio,
    '💋 Texas girl — texts, voice, video and lives, right here', 'clean bio saved');
  db2.close();
});

/* ---------------- API: warn-a-fan ---------------- */

test('warn-a-fan: auth, validation, delivery, thread read-back', async () => {
  const asFan = await req('POST', `/api/admin/fans/${fanA.id}/message`, {
    body: { body: 'hi' }, token: fanA.token,
  });
  assert.equal(asFan.status, 403, 'non-admin is refused');

  const empty = await req('POST', `/api/admin/fans/${fanA.id}/message`, {
    body: { body: '   ' }, token: admin.token, headers: admin.headers,
  });
  assert.equal(empty.status, 400, 'empty body rejected');
  assert.equal(empty.json.error, 'empty');

  const wrongRole = await req('POST', `/api/admin/fans/${model.id}/message`, {
    body: { body: 'hi' }, token: admin.token, headers: admin.headers,
  });
  assert.equal(wrongRole.status, 404, 'a model id is not a fan');

  const warn = 'Hi — this is SlutCamp. Please keep personal contact info off the app. 💋';
  const ok = await req('POST', `/api/admin/fans/${fanA.id}/message`, {
    body: { body: warn }, token: admin.token, headers: admin.headers,
  });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.ok, true);
  const convIdAdmin = ok.json.conversation_id;
  assert.ok(Number.isInteger(convIdAdmin) && Number.isInteger(ok.json.message_id));

  const db = readDb();
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(convIdAdmin);
  assert.equal(conv.fan_id, fanA.id);
  assert.equal(conv.model_id, admin.id, 'admin sits on the model side of the fan thread');
  assert.equal(db.prepare('SELECT body FROM messages WHERE id = ?').get(ok.json.message_id).body, warn,
    'the warning lands in the fan thread');
  const bell = db.prepare("SELECT * FROM notifications WHERE user_id = ? AND type = 'message' ORDER BY id DESC")
    .get(fanA.id);
  assert.ok(bell, 'the fan gets a bell');
  assert.equal(bell.link, `/#chat/${convIdAdmin}`, 'the bell opens the fan thread');
  db.close();

  const thread = await req('GET', `/api/admin/fans/${fanA.id}/thread`, { token: admin.token, headers: admin.headers });
  assert.equal(thread.status, 200, thread.text);
  assert.equal(thread.json.conversation_id, convIdAdmin);
  const mine = thread.json.messages.find((x) => x.id === ok.json.message_id);
  assert.ok(mine && mine.sender_name === 'You (Admin)', 'thread reads back as the admin');

  const threadAsFan = await req('GET', `/api/admin/fans/${fanA.id}/thread`, { token: fanA.token });
  assert.equal(threadAsFan.status, 403, 'thread read is admin-only too');
});

/* ---------------- boot scenario: seeds, announcement, scrub --------- */

function makeCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-safety-boot-'));
  for (const d of ['server.js', 'package.json', 'lib', 'public', 'data']) {
    fs.cpSync(path.join(REPO, d), path.join(dir, d), { recursive: true });
  }
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  return dir;
}

async function bootDir(dir) {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), CRYPTO_POLL_MS: '3600000', SEED_DEMO: '1' };
  for (const k of Object.keys(env)) {
    if (/^(CCBILL_|CRYPTO_|OPENAI_|TWILIO_|VAPID_)/.test(k)) delete env[k];
  }
  const c = spawn(process.execPath, ['server.js'], { cwd: dir, env });
  let log = '';
  c.stdout.on('data', (d) => { log += d; });
  c.stderr.on('data', (d) => { log += d; });
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30000;
  for (;;) {
    if (c.exitCode !== null) throw new Error(`server exited early (${c.exitCode})\n${log}`);
    try {
      const r = await fetch(baseUrl + '/api/health');
      if (r.ok) break;
    } catch (e) { /* not up yet */ }
    if (Date.now() > deadline) { c.kill('SIGKILL'); throw new Error(`server did not come up\n${log}`); }
    await new Promise((r) => setTimeout(r, 150));
  }
  return c;
}

function stopDir(c) {
  if (c && c.exitCode === null) c.kill('SIGKILL');
}

test('boot: seeds land, announcement fires once, scrub cleans pre-existing PII (idempotent)', async () => {
  const dir = makeCopy();
  try {
    /* --- boot 1: fresh DB --- */
    stopDir(await bootDir(dir));
    let db = new DatabaseSync(path.join(dir, 'wogent-chat.db'), { readOnly: true });
    for (const kw of ['fansly', 'linktr.ee', 'beacons.ai', 't.me', 'wise.com', 'sextpanther', 'onlyfans']) {
      const row = db.prepare('SELECT enabled FROM safety_keywords WHERE keyword = ?').get(kw);
      assert.ok(row, `promotion seed present after boot: ${kw}`);
      assert.equal(row.enabled, 1, `seed enabled: ${kw}`);
    }
    const stamp = db.prepare('SELECT safety_announced_at FROM platform_stats WHERE id = 1').get();
    assert.ok(stamp && stamp.safety_announced_at, 'announcement stamp set on first boot');
    const bunny = db.prepare("SELECT id FROM users WHERE username = 'bunny'").get();
    const fandemo = db.prepare("SELECT id FROM users WHERE username = 'fandemo'").get();
    assert.ok(bunny && fandemo, 'demo seeds present');
    const bell = db.prepare("SELECT * FROM notifications WHERE user_id = ? AND type = 'safety'").get(bunny.id);
    assert.ok(bell, 'announcement bell delivered');
    assert.ok(/^\/\#chat\/\d+$/.test(bell.link), 'bell links to her thread');
    const annConvId = Number(bell.link.split('/').pop());
    const dmCount = () => db.prepare(
      'SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ? AND body = ?')
      .get(annConvId, SRV.ann_safety_dm.en).c;
    assert.equal(dmCount(), 1, 'safety announcement DM delivered to bunny exactly once');
    db.close();

    /* --- plant pre-hard-block dirt: a flagged row + a raw incident --- */
    db = new DatabaseSync(path.join(dir, 'wogent-chat.db'));
    let conv = db.prepare('SELECT id FROM conversations WHERE fan_id = ? AND model_id = ?')
      .get(fandemo.id, bunny.id);
    if (!conv) {
      const info = db.prepare('INSERT INTO conversations (fan_id, model_id) VALUES (?,?)')
        .run(fandemo.id, bunny.id);
      conv = { id: Number(info.lastInsertRowid) };
    }
    const dirtyMsg = db.prepare(
      'INSERT INTO messages (conversation_id, sender_id, body, is_flagged) VALUES (?,?,?,1)')
      .run(conv.id, fandemo.id, 'Call me 4846875677');
    const dirtyMsgId = Number(dirtyMsg.lastInsertRowid);
    db.prepare(`INSERT INTO safety_incidents
      (conversation_id, sender_id, sender_role, sender_name, flagged_text, matched)
      VALUES (?,?,?,?,?,?)`)
      .run(conv.id, fandemo.id, 'fan', 'Fan Demo', 'Call me 4846875677 or mail jayfan99@example.com', 'phone_number');
    db.prepare(`INSERT INTO safety_incidents
      (conversation_id, sender_id, sender_role, sender_name, flagged_text, matched)
      VALUES (?,?,?,?,?,?)`)
      .run(conv.id, fandemo.id, 'fan', 'Fan Demo', 'just a hello with no secrets', 'social_media');
    db.close();

    /* --- boot 2: the scrub runs --- */
    stopDir(await bootDir(dir));
    db = new DatabaseSync(path.join(dir, 'wogent-chat.db'), { readOnly: true });
    assert.equal(db.prepare('SELECT body FROM messages WHERE id = ?').get(dirtyMsgId).body,
      '🚫 Message removed by SlutCamp safety', 'flagged body replaced by the removal notice');
    const incs = db.prepare('SELECT flagged_text FROM safety_incidents ORDER BY id').all();
    const phoneInc = incs.find((x) => x.flagged_text.includes('mail'));
    assert.ok(phoneInc, 'phone incident still recorded');
    assert.ok(!phoneInc.flagged_text.includes('4846875677'), 'stored number deleted by the scrub');
    assert.ok(!phoneInc.flagged_text.includes('jayfan99'), 'stored email local part deleted by the scrub');
    assert.ok(phoneInc.flagged_text.includes('•••77'), 'redacted tail kept');
    assert.ok(phoneInc.flagged_text.includes('j•••@example.com'), 'redacted email kept');
    const cleanInc = incs.find((x) => x.flagged_text.startsWith('just a hello'));
    assert.equal(cleanInc.flagged_text, 'just a hello with no secrets', 'clean incident text untouched');
    assert.equal(dmCount(), 1, 'announcement does not re-send on the second boot');
    db.close();

    /* --- boot 3: idempotent — nothing changes --- */
    stopDir(await bootDir(dir));
    db = new DatabaseSync(path.join(dir, 'wogent-chat.db'), { readOnly: true });
    assert.equal(db.prepare('SELECT body FROM messages WHERE id = ?').get(dirtyMsgId).body,
      '🚫 Message removed by SlutCamp safety', 'scrub is stable across boots');
    const incs3 = db.prepare('SELECT flagged_text FROM safety_incidents ORDER BY id').all();
    assert.ok(!incs3.some((x) => x.flagged_text.includes('4846875677')), 'still no raw PII after boot 3');
    assert.equal(dmCount(), 1, 'announcement still exactly once after boot 3');
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
