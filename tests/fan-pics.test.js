'use strict';
/*
 * Fan Pictures in Chat — model-controlled (owner, 2026-10-22).
 *
 * Pins:
 *  - Per-model fan_pics_allowed defaults OFF; the server refuses a
 *    fan picture while OFF (no attach in the payload either) and the
 *    model sets fan_pic_price (credits) beside the toggle, validated
 *    like her other model-set prices (PPV band: whole credits 0–100).
 *  - Fan side: in a 1-on-1 chat with an opted-in model the fan can
 *    send IMAGES ONLY. The picture passes the shared upload screening
 *    (jpeg/png/webp) BEFORE storage/delivery; a screening refusal
 *    delivers nothing and charges nothing.
 *  - Money: the fan is charged ONLY on delivery — exactly once
 *    (client_request_id idempotency) — 60/40 via the standard
 *    chargeFan funnel (type 'fan_pic'); insufficient balance blocks
 *    with no charge; price 0 delivers free; the HOUSE sender is
 *    comped: no charge, no earnings, no transaction, no stats move.
 *  - Blur: the model receives the picture blurred (unlocked=false,
 *    viewed=false, bytes refused) until HER deliberate tap-to-view
 *    (POST /api/media/:id/view); the fan sees his own picture
 *    normally. She can delete the picture message; nobody else can.
 *  - Fan pictures are chat-only: never on /api/models, never served
 *    by the public /uploads whitelist, never model media.
 *  - Regressions: fan voice notes still send; the chat safety
 *    monitor still hard-blocks PII text and picture captions.
 *  - Migration: a database with the PREVIOUS media_items DDL
 *    (kind CHECK without 'fan_pic') upgrades in place — rows kept,
 *    fan_pic insertable afterwards.
 *
 * Harness: owner-comp pattern — the real server boots in a throwaway
 * temp copy with SEED_DEMO=1.
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
const serverSrc = read('server.js');
const appSrc = read('public/js/app.js');

/* ---------------- static pins ---------------- */

test('static: server carries the toggle, price, screening, charge, view and delete wiring', () => {
  for (const frag of [
    "addColumnIfMissing('models', 'fan_pics_allowed', 'INTEGER NOT NULL DEFAULT 0')",
    "addColumnIfMissing('models', 'fan_pic_price', 'INTEGER NOT NULL DEFAULT 0')",
    "'ppv_image','ppv_video','voice','fan_pic'",
    'function sendFanPicture(req, res, conv)',
    "if (!model || !model.fan_pics_allowed)",
    '/^image\\/(jpeg|png|webp)$/',
    "chargeFan(sender.id, conv.model_id, costCents, 'fan_pic', 'Fan picture', clientIp(req))",
    "app.post('/api/media/:id/view', identMiddleware, requireUser",
    "app.delete('/api/messages/:id', identMiddleware, requireUser",
    'fan_pics_allowed: m ? (m.fan_pics_allowed ? 1 : 0) : 0',
    'fan_pic_price: m ? (m.fan_pic_price || 0) : 0',
    "error: 'bad_fan_pic_price'",
    'fan_pic_viewed_at',
    'client_request_id',
  ]) {
    assert.ok(serverSrc.includes(frag), `server carries: ${frag}`);
  }
  // House comp: the fan-pic charge is skipped for the house sender.
  const fpIdx = serverSrc.indexOf('function sendFanPicture');
  const fpBlock = serverSrc.slice(fpIdx, fpIdx + 9000);
  assert.ok(fpBlock.includes('const house = isHouseAccountId(sender.id);'), 'house detected in fan-pic flow');
  assert.ok(fpBlock.indexOf('if (!house && costCents > 0)') >= 0, 'charge guarded by the house comp check');
  assert.ok(fpBlock.indexOf('if (!house && costCents > 0)') < fpBlock.indexOf('chargeFan('),
    'house guard precedes the charge');
});

test('static: client carries the settings card, fan attach, blur tile and view/delete actions', () => {
  for (const frag of [
    'id="fanpics-toggle"',
    'id="s-fanpic"',
    "t('fan_pics_h')",
    "t('fan_pics_note')",
    'other.fan_pics_allowed',
    'id="fanpic-file"',
    'kind\', \'fan_pic\'',
    "fd.append('kind', 'fan_pic')",
    "fd.append('client_request_id', reqId)",
    "t('fan_pic_cost_confirm', { price: fmt(price * 100) })",
    'data-fanpic-view',
    'data-fanpic-delete',
    "`/media/${mediaId}/view`",
    "method: 'DELETE'",
  ]) {
    assert.ok(appSrc.includes(frag), `client carries: ${frag}`);
  }
  for (const key of ['fan_pics_h', 'fan_pics_note', 'fan_pics_allowed_l', 'fan_pic_price_l',
    'fan_pic_tap', 'fan_pic_cost_confirm', 'fan_pic_sent', 'fan_pic_delete']) {
    assert.ok(appSrc.includes(`${key}:`), `i18n key present: ${key}`);
  }
});

/* ---------------- harness ---------------- */

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
function makeCopy(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `slutcamp-${tag}-`));
  for (const d of ['server.js', 'package.json', 'lib', 'public', 'data']) {
    fs.cpSync(path.join(REPO, d), path.join(dir, d), { recursive: true });
  }
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  return dir;
}
async function boot(dir, extraEnv = {}) {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), CRYPTO_POLL_MS: '3600000', SEED_DEMO: '1', ...extraEnv };
  for (const k of Object.keys(env)) {
    if (/^(CCBILL_|CRYPTO_|OPENAI_|TWILIO_|VAPID_|WEBAUTHN_|AV_)/.test(k)) delete env[k];
  }
  const c = spawn(process.execPath, ['server.js'], { cwd: dir, env });
  let log = '';
  c.stdout.on('data', (d) => { log += d; });
  c.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 45000;
  for (;;) {
    if (c.exitCode !== null) throw new Error(`server exited early (${c.exitCode})\n${log}`);
    try {
      const r = await fetch(base + '/api/health');
      if (r.ok) break;
    } catch (e) { /* not up yet */ }
    if (Date.now() > deadline) { c.kill('SIGKILL'); throw new Error(`server did not come up\n${log}`); }
    await new Promise((r) => setTimeout(r, 150));
  }
  return { child: c, base };
}
async function stop(h) {
  if (h && h.child && h.child.exitCode === null) {
    h.child.kill('SIGTERM');
    await Promise.race([
      new Promise((r) => h.child.once('exit', r)),
      new Promise((r) => setTimeout(r, 5000)),
    ]);
    if (h.child.exitCode === null) h.child.kill('SIGKILL');
  }
}
async function req(base, method, p, { body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = 'Bearer ' + token;
  const r = await fetch(base + p, { method, headers,
    body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
  return { status: r.status, text, json };
}
const PNG = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001080600000' +
  '01f15c4890000000a49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082', 'hex');
async function sendMedia(base, token, { convId, kind, blobType, name, extra = {} }) {
  const fd = new FormData();
  fd.append('file', new Blob([PNG], { type: blobType }), name);
  fd.append('conversation_id', String(convId));
  fd.append('kind', kind);
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  const headers = {};
  if (token) headers.authorization = 'Bearer ' + token;
  const r = await fetch(base + '/api/media/send', { method: 'POST', headers, body: fd });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
  return { status: r.status, text, json };
}
function openDb(dir, readOnly = true) {
  const d = new DatabaseSync(path.join(dir, 'wogent-chat.db'), readOnly ? { readOnly: true } : {});
  d.exec('PRAGMA busy_timeout = 10000');
  return d;
}
function setCredits(dir, userId, cents) {
  const db = openDb(dir, false);
  db.prepare(`INSERT INTO wallets (user_id, credits_cents) VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET credits_cents = excluded.credits_cents`).run(userId, cents);
  db.close();
}
function walletOf(dir, userId) {
  const db = openDb(dir);
  const w = db.prepare('SELECT credits_cents, earnings_cents FROM wallets WHERE user_id = ?').get(userId);
  db.close();
  return w;
}
async function signup(base, username, role, extra = {}) {
  const s = await req(base, 'POST', '/api/auth/signup', {
    body: { username, password: 'hunter22x', role, display_name: username,
      dob: '1995-05-05', agree18: true, ...(role === 'model' ? { publicity_consent: true } : {}), ...extra },
  });
  assert.equal(s.status, 200, `signup ${username}: ${s.text}`);
  return { token: s.json.token, id: s.json.user.id, username };
}

/* ---------------- runtime ---------------- */

test('runtime: toggle, price, screening, charge-once, blur/view, house comp, regressions', { timeout: 300000 }, async () => {
  const dir = makeCopy('fanpics');
  let h = null;
  try {
    h = await boot(dir);
    const base = h.base;
    const suffix = Math.random().toString(36).slice(2, 8);
    const model = await signup(base, 'fpmodel' + suffix, 'model', { section: 'female' });
    const model2 = await signup(base, 'fpmodel2' + suffix, 'model', { section: 'female' });
    const fan = await signup(base, 'fpfan' + suffix, 'fan');
    const house = await signup(base, 'asceaaspade', 'model', { section: 'female' });
    setCredits(dir, fan.id, 100000);

    // Defaults: OFF + price 0 on the model row itself.
    {
      const db = openDb(dir);
      const m = db.prepare('SELECT fan_pics_allowed, fan_pic_price FROM models WHERE user_id = ?').get(model.id);
      db.close();
      assert.equal(m.fan_pics_allowed, 0, 'fan_pics_allowed defaults OFF');
      assert.equal(m.fan_pic_price, 0, 'fan_pic_price defaults 0');
    }

    const start = await req(base, 'POST', '/api/conversations/start', { token: fan.token, body: { model_id: model.id } });
    assert.equal(start.status, 200, `start conv: ${start.text}`);
    const convId = start.json.conversation.id;
    assert.equal(start.json.conversation.other.fan_pics_allowed, 0, 'chat payload: toggle off');
    assert.equal(start.json.conversation.other.fan_pic_price, 0, 'chat payload: price 0');

    // OFF: the server refuses, nothing is stored, nothing charged.
    const off = await sendMedia(base, fan.token, { convId, kind: 'fan_pic', blobType: 'image/png', name: 'pic.png', extra: { client_request_id: 'fp-off-1' } });
    assert.equal(off.status, 403, `off send: ${off.text}`);
    assert.equal(off.json.error, 'fan_pics_off');
    {
      const db = openDb(dir);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM media_items WHERE conversation_id = ?').get(convId).n, 0, 'nothing stored while off');
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(convId).n, 0, 'nothing delivered while off');
      db.close();
      assert.equal(walletOf(dir, fan.id).credits_cents, 100000, 'no charge while off');
    }

    // Price validation follows the PPV band (whole credits, 0–100).
    const badPrice = await req(base, 'PUT', '/api/model/profile', { token: model.token, body: { fan_pic_price: 101 } });
    assert.equal(badPrice.status, 400, `price 101: ${badPrice.text}`);
    assert.equal(badPrice.json.error, 'bad_fan_pic_price');
    const fracPrice = await req(base, 'PUT', '/api/model/profile', { token: model.token, body: { fan_pic_price: 2.5 } });
    assert.equal(fracPrice.status, 400, 'fractional price refused');

    // She opts in at 5 credits.
    const on = await req(base, 'PUT', '/api/model/profile', { token: model.token, body: { fan_pics_allowed: 1, fan_pic_price: 5 } });
    assert.equal(on.status, 200, `opt in: ${on.text}`);
    assert.equal(on.json.model.fan_pics_allowed, 1);
    assert.equal(on.json.model.fan_pic_price, 5);
    const convs = await req(base, 'GET', '/api/conversations', { token: fan.token });
    const mine = (convs.json.conversations || []).find((c) => c.id === convId);
    assert.equal(mine.other.fan_pics_allowed, 1, 'chat payload: toggle on');
    assert.equal(mine.other.fan_pic_price, 5, 'chat payload: price 5 credits');

    // SCREENING: a video (and a non-media file) are refused before
    // delivery — nothing stored, nothing charged.
    const vid = await sendMedia(base, fan.token, { convId, kind: 'fan_pic', blobType: 'video/mp4', name: 'clip.mp4', extra: { client_request_id: 'fp-vid-1' } });
    assert.equal(vid.status, 400, `video send: ${vid.text}`);
    assert.equal(vid.json.error, 'fan_pic_screening_failed');
    const txt = await sendMedia(base, fan.token, { convId, kind: 'fan_pic', blobType: 'text/plain', name: 'note.txt', extra: { client_request_id: 'fp-txt-1' } });
    assert.equal(txt.status, 400, `text send: ${txt.text}`);
    {
      const db = openDb(dir);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM media_items WHERE conversation_id = ?').get(convId).n, 0, 'screening stored nothing');
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE fan_id = ?').get(fan.id).n, 0, 'screening charged nothing');
      db.close();
    }

    // Insufficient balance blocks: no charge, nothing delivered.
    setCredits(dir, fan.id, 300);
    const poor = await sendMedia(base, fan.token, { convId, kind: 'fan_pic', blobType: 'image/png', name: 'pic.png', extra: { client_request_id: 'fp-poor-1' } });
    assert.equal(poor.status, 402, `poor send: ${poor.text}`);
    assert.equal(poor.json.error, 'insufficient_credits');
    assert.equal(poor.json.needed_cents, 500);
    assert.equal(walletOf(dir, fan.id).credits_cents, 300, 'balance untouched on insufficient');
    {
      const db = openDb(dir);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM media_items WHERE conversation_id = ?').get(convId).n, 0, 'insufficient delivered nothing');
      db.close();
    }

    // Delivered picture: charged exactly the price, split 60/40.
    setCredits(dir, fan.id, 10000);
    const sent = await sendMedia(base, fan.token, { convId, kind: 'fan_pic', blobType: 'image/png', name: 'pic.png', extra: { client_request_id: 'fp-good-1' } });
    assert.equal(sent.status, 200, `good send: ${sent.text}`);
    assert.equal(sent.json.cost_cents, 500, 'charged 5 credits');
    assert.equal(sent.json.message.media.kind, 'fan_pic');
    assert.equal(sent.json.message.media.unlocked, true, 'sender sees his own picture');
    const mediaId = sent.json.message.media.id;
    const msgId = sent.json.message.id;
    assert.equal(walletOf(dir, fan.id).credits_cents, 9500, 'fan debited once');
    assert.equal(walletOf(dir, model.id).earnings_cents, 300, 'model credited 60%');
    {
      const db = openDb(dir);
      const tx = db.prepare("SELECT * FROM transactions WHERE fan_id = ? AND type = 'fan_pic'").all(fan.id);
      assert.equal(tx.length, 1, 'one fan_pic transaction');
      assert.equal(tx[0].gross_cents, 500);
      assert.equal(tx[0].model_cents, 300);
      assert.equal(tx[0].platform_cents, 200);
      const media = db.prepare('SELECT * FROM media_items WHERE id = ?').get(mediaId);
      assert.equal(media.kind, 'fan_pic');
      assert.equal(media.fan_pic_viewed_at, null, 'unviewed at delivery');
      db.close();
    }

    // Retry with the same client_request_id: same picture back, NO
    // second charge, NO duplicate message.
    const retry = await sendMedia(base, fan.token, { convId, kind: 'fan_pic', blobType: 'image/png', name: 'pic.png', extra: { client_request_id: 'fp-good-1' } });
    assert.equal(retry.status, 200, `retry: ${retry.text}`);
    assert.equal(retry.json.duplicate, true, 'retry flagged duplicate');
    assert.equal(retry.json.message.id, msgId, 'retry returns the same message');
    assert.equal(walletOf(dir, fan.id).credits_cents, 9500, 'retry charged nothing');
    {
      const db = openDb(dir);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE fan_id = ? AND type = 'fan_pic'").get(fan.id).n, 1, 'still one transaction');
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND media_id IS NOT NULL').get(convId).n, 1, 'still one picture message');
      db.close();
    }

    // BLUR: her history payload is locked + unviewed, and her file
    // bytes are refused until she opens it.
    const herView = await req(base, 'GET', `/api/conversations/${convId}/messages`, { token: model.token });
    const herMsg = (herView.json.messages || []).find((m) => m.id === msgId);
    assert.ok(herMsg && herMsg.media, 'model sees the picture message');
    assert.equal(herMsg.media.unlocked, false, 'model copy is blurred (locked)');
    assert.equal(herMsg.media.viewed, false, 'model copy is unviewed');
    const earlyToken = await req(base, 'POST', `/api/media/${mediaId}/file-token`, { token: model.token });
    assert.equal(earlyToken.status, 403, `early file token: ${earlyToken.text}`);
    assert.equal(earlyToken.json.error, 'fan_pic_unviewed');
    const earlyFile = await fetch(base + `/api/media/${mediaId}/file`, { headers: { authorization: 'Bearer ' + model.token } });
    assert.equal(earlyFile.status, 403, 'early file bytes refused');

    // The FAN's own payload + bytes are normal from the start.
    const hisView = await req(base, 'GET', `/api/conversations/${convId}/messages`, { token: fan.token });
    const hisMsg = (hisView.json.messages || []).find((m) => m.id === msgId);
    assert.equal(hisMsg.media.unlocked, true, 'fan sees his own picture unlocked');

    // Only SHE can stamp the view.
    const fanViewTry = await req(base, 'POST', `/api/media/${mediaId}/view`, { token: fan.token });
    assert.equal(fanViewTry.status, 403, 'fan cannot mark her copy viewed');
    const viewed = await req(base, 'POST', `/api/media/${mediaId}/view`, { token: model.token });
    assert.equal(viewed.status, 200, `view: ${viewed.text}`);
    assert.equal(viewed.json.viewed, true);
    const herView2 = await req(base, 'GET', `/api/conversations/${convId}/messages`, { token: model.token });
    const herMsg2 = (herView2.json.messages || []).find((m) => m.id === msgId);
    assert.equal(herMsg2.media.unlocked, true, 'unblurred after her tap');
    assert.equal(herMsg2.media.viewed, true, 'viewed after her tap');
    const lateToken = await req(base, 'POST', `/api/media/${mediaId}/file-token`, { token: model.token });
    assert.equal(lateToken.status, 200, 'file token after view');
    const bytes = await fetch(base + lateToken.json.url);
    assert.equal(bytes.status, 200, 'file bytes after view');

    // Chat-only: the picture never reaches public surfaces.
    const models = await req(base, 'GET', '/api/models');
    const row = (models.json.models || []).find((r) => r.id === model.id);
    assert.ok(row, 'model still listed');
    assert.ok(!('fan_pics_allowed' in row) && !('fan_pic_price' in row), 'settings stay off the public listing');
    {
      const db = openDb(dir);
      const media = db.prepare('SELECT file_path FROM media_items WHERE id = ?').get(mediaId);
      db.close();
      const up = await fetch(base + '/uploads/' + path.basename(media.file_path));
      assert.equal(up.status, 404, 'fan picture is not served by the public uploads route');
    }

    // Caption passes the safety monitor: PII caption hard-blocks the
    // whole send — nothing delivered, nothing charged.
    const balBeforeCaption = walletOf(dir, fan.id).credits_cents;
    const cap = await sendMedia(base, fan.token, { convId, kind: 'fan_pic', blobType: 'image/png', name: 'pic.png',
      extra: { client_request_id: 'fp-cap-1', caption: 'call me at 210-555-1234' } });
    assert.equal(cap.status, 200, `caption send: ${cap.text}`);
    assert.equal(cap.json.blocked, true, 'caption hard-blocked by the safety monitor');
    assert.equal(walletOf(dir, fan.id).credits_cents, balBeforeCaption, 'blocked caption charged nothing');
    {
      const db = openDb(dir);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM media_items WHERE conversation_id = ?').get(convId).n, 1, 'blocked caption delivered nothing');
      db.close();
    }

    // Price 0 delivers free.
    const free = await req(base, 'PUT', '/api/model/profile', { token: model.token, body: { fan_pic_price: 0 } });
    assert.equal(free.status, 200);
    const freeSent = await sendMedia(base, fan.token, { convId, kind: 'fan_pic', blobType: 'image/png', name: 'pic.png', extra: { client_request_id: 'fp-free-1' } });
    assert.equal(freeSent.status, 200, `free send: ${freeSent.text}`);
    assert.equal(freeSent.json.cost_cents, 0, 'free picture costs nothing');
    assert.equal(walletOf(dir, fan.id).credits_cents, balBeforeCaption, 'free picture charged nothing');

    // HOUSE COMP: model2 charges 7 — the house sends free and NO
    // money rows exist afterwards.
    const on2 = await req(base, 'PUT', '/api/model/profile', { token: model2.token, body: { fan_pics_allowed: 1, fan_pic_price: 7 } });
    assert.equal(on2.status, 200, `model2 opt in: ${on2.text}`);
    const hStart = await req(base, 'POST', '/api/conversations/start', { token: house.token, body: { model_id: model2.id } });
    assert.equal(hStart.status, 200, `house start: ${hStart.text}`);
    const hConvId = hStart.json.conversation.id;
    const statsBefore = (() => { const db = openDb(dir); const s = db.prepare('SELECT earnings_cents FROM platform_stats WHERE id = 1').get(); db.close(); return s.earnings_cents; })();
    const houseWalletBefore = walletOf(dir, house.id);
    const hSent = await sendMedia(base, house.token, { convId: hConvId, kind: 'fan_pic', blobType: 'image/png', name: 'pic.png', extra: { client_request_id: 'fp-house-1' } });
    assert.equal(hSent.status, 200, `house send: ${hSent.text}`);
    assert.equal(hSent.json.cost_cents, 0, 'house pays nothing');
    {
      const db = openDb(dir);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE fan_id = ?').get(house.id).n, 0, 'house created no transaction');
      assert.equal(db.prepare('SELECT earnings_cents FROM platform_stats WHERE id = 1').get().earnings_cents, statsBefore, 'platform stats unmoved by house send');
      db.close();
      assert.deepEqual(walletOf(dir, house.id), houseWalletBefore, 'house wallet untouched');
      assert.equal(walletOf(dir, model2.id).earnings_cents, 0, 'model2 earned nothing from the house');
    }

    // DELETE: only the receiving model can delete a fan picture.
    const fanDelete = await req(base, 'DELETE', `/api/messages/${msgId}`, { token: fan.token });
    assert.equal(fanDelete.status, 403, 'fan cannot delete the picture');
    const del = await req(base, 'DELETE', `/api/messages/${msgId}`, { token: model.token });
    assert.equal(del.status, 200, `model delete: ${del.text}`);
    const after = await req(base, 'GET', `/api/conversations/${convId}/messages`, { token: model.token });
    assert.ok(!(after.json.messages || []).some((m) => m.id === msgId), 'picture gone from her thread');
    const goneFile = await fetch(base + `/api/media/${mediaId}/file`, { headers: { authorization: 'Bearer ' + model.token } });
    assert.equal(goneFile.status, 404, 'deleted picture bytes are gone');

    // Regressions: fan voice notes still send; PII text still blocks.
    const voice = await sendMedia(base, fan.token, { convId, kind: 'voice', blobType: 'audio/webm', name: 'note.webm', extra: { duration_sec: '2' } });
    assert.equal(voice.status, 200, `voice note: ${voice.text}`);
    assert.equal(voice.json.message.media.kind, 'voice');
    const pii = await req(base, 'POST', '/api/messages', { token: fan.token, body: { conversation_id: convId, body: 'text me at 210-555-1234' } });
    assert.equal(pii.status, 200, `pii text: ${pii.text}`);
    assert.equal(pii.json.blocked, true, 'safety monitor still hard-blocks PII text');
    // And the long-standing fan rule still refuses fan PPV uploads.
    const ppvTry = await sendMedia(base, fan.token, { convId, kind: 'ppv_image', blobType: 'image/png', name: 'pic.png', extra: { price_cents: '500' } });
    assert.equal(ppvTry.status, 403, 'fans still cannot send PPV media');
    assert.equal(ppvTry.json.error, 'fans_cannot_upload_media');
  } finally {
    await stop(h);
  }
});

/* ---------------- migration: previous media_items schema ---------------- */

const OLD_MEDIA_ITEMS_PREV_DDL = `
CREATE TABLE media_items_prev (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       INTEGER REFERENCES users(id),
  guest_token     TEXT,
  kind            TEXT NOT NULL CHECK(kind IN ('ppv_image','ppv_video','voice')),
  mime            TEXT NOT NULL,
  file_path       TEXT NOT NULL,
  price_cents     INTEGER NOT NULL DEFAULT 0,
  duration_sec    INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  is_explicit     INTEGER NOT NULL DEFAULT 0
)`;

test('migration: previous-schema media_items upgrades in place, rows kept', { timeout: 300000 }, async () => {
  const dir = makeCopy('fanpics-mig');
  let h = null;
  try {
    h = await boot(dir);
    const base = h.base;
    const suffix = Math.random().toString(36).slice(2, 8);
    const model = await signup(base, 'fpmigmodel' + suffix, 'model', { section: 'female' });
    const fan = await signup(base, 'fpmigfan' + suffix, 'fan');
    const start = await req(base, 'POST', '/api/conversations/start', { token: fan.token, body: { model_id: model.id } });
    const convId = start.json.conversation.id;
    // A lived-in media row + message, as the previous build wrote them.
    {
      const db = openDb(dir, false);
      const mid = db.prepare(`INSERT INTO media_items (conversation_id, sender_id, kind, mime, file_path, price_cents)
        VALUES (?, ?, 'ppv_image', 'image/png', '/tmp/keep-me.png', 500)`).run(convId, model.id).lastInsertRowid;
      db.prepare('INSERT INTO messages (conversation_id, sender_id, body, media_id) VALUES (?, ?, ?, ?)')
        .run(convId, model.id, '📸 Photo · unlock $5.00', mid);
      db.close();
    }
    await stop(h); h = null;

    // Surgically return media_items to the PREVIOUS DDL and drop the
    // new model columns — the exact state of a production DB today.
    {
      const db = openDb(dir, false);
      db.exec('PRAGMA foreign_keys=OFF');
      db.exec('BEGIN IMMEDIATE');
      db.exec(OLD_MEDIA_ITEMS_PREV_DDL);
      db.exec(`INSERT INTO media_items_prev (id, conversation_id, sender_id, guest_token, kind, mime, file_path, price_cents, duration_sec, created_at, is_explicit)
        SELECT id, conversation_id, sender_id, guest_token, kind, mime, file_path, price_cents, duration_sec, created_at, is_explicit FROM media_items`);
      db.exec('DROP TABLE media_items');
      db.exec('ALTER TABLE media_items_prev RENAME TO media_items');
      db.exec('CREATE INDEX IF NOT EXISTS idx_media_conv ON media_items(conversation_id, id)');
      db.exec('COMMIT');
      db.exec('PRAGMA foreign_keys=ON');
      db.exec('ALTER TABLE models DROP COLUMN fan_pics_allowed');
      db.exec('ALTER TABLE models DROP COLUMN fan_pic_price');
      db.close();
    }

    h = await boot(dir);
    {
      const db = openDb(dir);
      const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='media_items'").get();
      assert.ok(ddl.sql.includes("'fan_pic'"), 'media_items DDL upgraded to include fan_pic');
      const kept = db.prepare("SELECT * FROM media_items WHERE kind = 'ppv_image'").get();
      assert.ok(kept, 'previous media row survived the rebuild');
      assert.equal(kept.file_path, '/tmp/keep-me.png');
      assert.equal(kept.price_cents, 500);
      const m = db.prepare('SELECT fan_pics_allowed, fan_pic_price FROM models WHERE user_id = ?').get(model.id);
      assert.equal(m.fan_pics_allowed, 0, 'fan_pics_allowed re-added with default OFF');
      assert.equal(m.fan_pic_price, 0, 'fan_pic_price re-added with default 0');
      // fan_pic is insertable on the upgraded table.
      db.close();
      const dbw = openDb(dir, false);
      const nid = dbw.prepare(`INSERT INTO media_items (conversation_id, sender_id, kind, mime, file_path)
        VALUES (?, ?, 'fan_pic', 'image/png', '/tmp/new-pic.png')`).run(convId, fan.id).lastInsertRowid;
      assert.ok(nid > 0, 'fan_pic insert works after migration');
      dbw.close();
    }
    // And the upgraded server serves the kept message history.
    const hist = await req(h.base, 'GET', `/api/conversations/${convId}/messages`, { token: model.token });
    assert.equal(hist.status, 200, `history after migration: ${hist.text}`);
    assert.ok((hist.json.messages || []).some((m) => m.media && m.media.kind === 'ppv_image'), 'kept PPV message renders');
  } finally {
    await stop(h);
  }
});
