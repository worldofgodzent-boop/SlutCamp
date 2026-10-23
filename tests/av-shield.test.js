'use strict';
/*
 * Pre-purchase explicit-media shield (owner-approved AV design,
 * Oct 16 2026). Age verification fires at a fan's FIRST CREDIT
 * PURCHASE (the dormant purchase gate), and the statutes gate ACCESS
 * to sexual material — so explicit-capable media reachable before
 * that purchase must be non-explicit for unverified viewers.
 *
 * Layers:
 * 1. Unit tests for lib/shield.js (pure decision layer): dormancy
 *    switch, the 27-state list, location resolution (stored state →
 *    geo → unknown-fails-closed), and the fan/guest shield rules.
 * 2. Real-server tests, TWO boots of the same scenario:
 *    - DORMANT boot (no AV_* env): every assertion pins TODAY'S
 *      behavior — the shield must be invisible.
 *    - ACTIVE boot (AV_PROVIDER + AV_API_KEY set): free media the
 *      model flagged explicit is shield-flagged in the thread payload
 *      and byte-gated (file-token AND direct file route) for an
 *      unverified fan at an unknown location; unflagged free media
 *      stays clear (the classification line); priced media keeps its
 *      ordinary locked tile; a verified fan and a known non-AV-state
 *      fan see everything clear; the model's own view is clear and
 *      her explicit toggle works (and fans can't flip it); the
 *      directory withholds preview loops from shielded viewers only;
 *      live explicit entry is refused (av_required, before any
 *      charge) for the shielded fan and opens once he's verified.
 *    Guests receive no chat-media bytes in either boot (pre-existing
 *    login gate — pinned, not changed).
 * 3. Source pins: shield tile is a non-button with the verified-only
 *    hint in app.js, i18n keys exist in all three dictionaries, the
 *    price sheet carries the explicit checkbox, and styles.css has
 *    the shield variant.
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
const appJs = read('public/js/app.js');
const serverJs = read('server.js');
const css = read('public/css/styles.css');
const shield = require(path.join(REPO, 'lib', 'shield.js'));

/* ---------------- 1. lib/shield.js unit tests ---------------- */

test('shield: AV_STATES is the researched 27-state list', () => {
  assert.equal(shield.AV_STATES.length, 27);
  for (const s of ['TX', 'LA', 'FL', 'TN', 'UT', 'WY', 'AL', 'WV'])
    assert.ok(shield.AV_STATES.includes(s), `${s} must be regulated`);
  for (const s of ['CA', 'NY', 'CO', 'NV', 'OR', 'WA'])
    assert.ok(!shield.AV_STATES.includes(s), `${s} must NOT be regulated`);
});

test('shield: dormant unless BOTH AV env vars are set', () => {
  const savedP = process.env.AV_PROVIDER, savedK = process.env.AV_API_KEY;
  try {
    delete process.env.AV_PROVIDER; delete process.env.AV_API_KEY;
    assert.equal(shield.avConfigured(), false);
    process.env.AV_PROVIDER = 'stub';
    assert.equal(shield.avConfigured(), false, 'provider alone is dormant');
    delete process.env.AV_PROVIDER; process.env.AV_API_KEY = 'k';
    assert.equal(shield.avConfigured(), false, 'key alone is dormant');
    process.env.AV_PROVIDER = 'stub';
    assert.equal(shield.avConfigured(), true);
  } finally {
    if (savedP === undefined) delete process.env.AV_PROVIDER; else process.env.AV_PROVIDER = savedP;
    if (savedK === undefined) delete process.env.AV_API_KEY; else process.env.AV_API_KEY = savedK;
  }
});

test('shield: location resolution — stored state wins, geo next, unknown fails closed', () => {
  assert.deepEqual(shield.resolveAvLocation('tx', null), { state: 'TX', known: true });
  assert.deepEqual(shield.resolveAvLocation(null, { country: 'US', state: 'FL' }), { state: 'FL', known: true });
  assert.deepEqual(shield.resolveAvLocation(null, { country: 'FR', state: null }), { state: 'NON-US', known: true });
  assert.deepEqual(shield.resolveAvLocation(null, { country: 'US', state: null }), { state: null, known: false });
  assert.deepEqual(shield.resolveAvLocation(null, null), { state: null, known: false });
  assert.equal(shield.locationShielded({ state: 'TX', known: true }), true);
  assert.equal(shield.locationShielded({ state: 'CA', known: true }), false);
  assert.equal(shield.locationShielded({ state: 'NON-US', known: true }), false);
  assert.equal(shield.locationShielded({ state: null, known: false }), true, 'unknown fails closed');
});

test('shield: fan rule matrix (with AV configured)', () => {
  const savedP = process.env.AV_PROVIDER, savedK = process.env.AV_API_KEY;
  process.env.AV_PROVIDER = 'stub'; process.env.AV_API_KEY = 'k';
  try {
    const tx = { state: 'TX', known: true }, ca = { state: 'CA', known: true },
      unk = { state: null, known: false };
    const fan = { role: 'fan', av_verified_at: null };
    assert.equal(shield.fanShielded(fan, tx), true);
    assert.equal(shield.fanShielded(fan, unk), true);
    assert.equal(shield.fanShielded(fan, ca), false, 'known non-AV state is never shielded');
    assert.equal(shield.fanShielded({ ...fan, av_verified_at: '2026-10-16' }, tx), false, 'verified fan is clear');
    assert.equal(shield.fanShielded({ role: 'model', av_verified_at: null }, tx), false);
    assert.equal(shield.fanShielded({ role: 'admin', av_verified_at: null }, tx), false);
    assert.equal(shield.guestShielded(tx), true);
    assert.equal(shield.guestShielded(ca), false);
  } finally {
    if (savedP === undefined) delete process.env.AV_PROVIDER; else process.env.AV_PROVIDER = savedP;
    if (savedK === undefined) delete process.env.AV_API_KEY; else process.env.AV_API_KEY = savedK;
  }
});

/* ---------------- 2. real-server harness ---------------- */

let tmpDir = null;
let child = null;
let base = null;
let childLog = '';
let currentEnv = {};

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

async function req(method, p, { body, token, guest } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = 'Bearer ' + token;
  if (guest) headers['x-guest-token'] = guest;
  const r = await fetch(base + p, {
    method, headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
  return { status: r.status, headers: r.headers, text, json };
}

async function waitForServer(deadlineMs = 60000) {
  const start = Date.now();
  for (;;) {
    if (child.exitCode !== null)
      throw new Error(`server exited early with code ${child.exitCode}\n--- server log ---\n${childLog}`);
    try {
      const r = await fetch(base + '/api/credits/packages');
      if (r.status === 200) return;
    } catch (_) { /* not up yet */ }
    if (Date.now() - start > deadlineMs)
      throw new Error(`server did not respond within ${deadlineMs}ms\n--- server log ---\n${childLog}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function bootServer(avEnv) {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-shield-'));
  for (const f of ['server.js', 'package.json'])
    fs.copyFileSync(path.join(REPO, f), path.join(tmpDir, f));
  for (const d of ['lib', 'public', 'data'])
    fs.cpSync(path.join(REPO, d), path.join(tmpDir, d), { recursive: true });
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(tmpDir, 'node_modules'), 'dir');

  let lastErr = null;
  for (let attempt = 1; attempt <= 3 && !base; attempt++) {
    const port = await freePort();
    const env = { ...process.env, PORT: String(port), CRYPTO_POLL_MS: '3600000', ...avEnv };
    for (const k of Object.keys(env))
      if (/^(CCBILL_|CRYPTO_|OPENAI_|TWILIO_|VAPID_)/.test(k)) delete env[k];
    if (!avEnv.AV_PROVIDER) { delete env.AV_PROVIDER; delete env.AV_API_KEY; }
    currentEnv = avEnv;
    childLog = '';
    child = spawn(process.execPath, ['server.js'], { cwd: tmpDir, env });
    child.stdout.on('data', (d) => { childLog += d; });
    child.stderr.on('data', (d) => { childLog += d; });
    base = `http://127.0.0.1:${port}`;
    try { await waitForServer(); }
    catch (e) {
      lastErr = e; base = null;
      if (child && child.exitCode === null) child.kill('SIGKILL');
      child = null;
      for (const f of fs.readdirSync(tmpDir))
        if (/^wogent-chat\.db/.test(f)) fs.rmSync(path.join(tmpDir, f), { force: true });
      fs.rmSync(path.join(tmpDir, 'uploads'), { recursive: true, force: true });
      fs.rmSync(path.join(tmpDir, 'private'), { recursive: true, force: true });
    }
  }
  if (!base) throw lastErr || new Error('server failed to boot after 3 attempts');
}

async function stopServer() {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((r) => child.once('exit', r)),
      new Promise((r) => setTimeout(r, 5000)),
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  child = null; base = null;
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
}

/* DB surgery on the throwaway copy (fan_state / av_verified_at are
 * stamped by the purchase-gate build in production; here the tests
 * stamp them exactly as that build will). */
function dbExec(sql, params = []) {
  const db = new DatabaseSync(path.join(tmpDir, 'wogent-chat.db'));
  db.exec('PRAGMA busy_timeout = 10000');
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.prepare(sql).run(...params);
  } finally { db.close(); }
}
function dbAll(sql, params = []) {
  const db = new DatabaseSync(path.join(tmpDir, 'wogent-chat.db'), { readOnly: true });
  try { return db.prepare(sql).all(...params); } finally { db.close(); }
}

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64');

async function sendMedia(token, convId, { price = 0, explicit = false } = {}) {
  const fd = new FormData();
  fd.append('file', new Blob([PNG_1PX], { type: 'image/png' }), 'x.png');
  fd.append('conversation_id', String(convId));
  fd.append('kind', 'ppv_image');
  fd.append('price_cents', String(price));
  if (explicit) fd.append('is_explicit', '1');
  const r = await fetch(base + '/api/media/send', {
    method: 'POST', headers: { authorization: 'Bearer ' + token }, body: fd,
  });
  const json = await r.json().catch(() => null);
  assert.equal(r.status, 200, `media send failed: ${JSON.stringify(json)}`);
  return json.message;
}

async function threadMedia(token, convId) {
  const r = await req('GET', `/api/conversations/${convId}/messages?limit=50`, { token });
  assert.equal(r.status, 200, r.text);
  const byId = {};
  for (const m of r.json.messages) if (m.media) byId[m.media.id] = m.media;
  return byId;
}

/* One shared scenario per boot; `active` says which boot this is. */
async function runScenario(t, active) {
  const suffix = Math.random().toString(36).slice(2, 8);
  const mkUser = async (name, role, display) => {
    const s = await req('POST', '/api/auth/signup', {
      body: { username: name + suffix, password: 'shield-pass-1', role, display_name: display, dob: '1996-04-12', agree18: true, ...(role === 'model' ? { section: 'female' } : {}) },
    });
    assert.equal(s.status, 200, `${role} signup failed: ${s.text}`);
    return { token: s.json.token, id: s.json.user.id, username: name + suffix };
  };
  const model = await mkUser('shieldmodel', 'model', 'Shield Model');
  // Upload gate (Oct 21 2026): directory media now requires an
  // approved ID — this suite's model is a public, verified model, so
  // the directory assertions below isolate the AV shield alone (the
  // gate itself is pinned by tests/upload-gate.test.js).
  dbExec("INSERT INTO id_verifications (model_id, status) VALUES (?, 'approved')", [model.id]);
  // Release Prompt (Oct 22 2026): going live requires the WOGENT
  // release on file — she agrees at the door, like a real model.
  const rel = await req('POST', '/api/model/release/agree', { body: {}, token: model.token });
  assert.equal(rel.status, 200, `release agree: ${rel.text}`);
  const fan = await mkUser('shieldfan', 'fan', 'Shield Fan');

  const convR = await req('POST', '/api/conversations/start', { body: { model_id: model.id }, token: fan.token });
  assert.equal(convR.status, 200, convR.text);
  const convId = convR.json.conversation.id;

  const msgA = await sendMedia(model.token, convId, { price: 0, explicit: true });  // free + flagged
  const msgB = await sendMedia(model.token, convId, { price: 0, explicit: false }); // free + unflagged
  const msgC = await sendMedia(model.token, convId, { price: 500, explicit: true }); // priced + flagged
  const A = msgA.media.id, B = msgB.media.id, C = msgC.media.id;

  await t.test('schema: shield columns exist', () => {
    const cols = dbAll('PRAGMA table_info(media_items)').map((c) => c.name);
    assert.ok(cols.includes('is_explicit'), 'media_items.is_explicit must exist');
    const ucols = dbAll('PRAGMA table_info(users)').map((c) => c.name);
    assert.ok(ucols.includes('av_verified_at'), 'users.av_verified_at must exist');
    assert.ok(ucols.includes('fan_state'), 'users.fan_state must exist');
    // Proof-only: no AV document/DOB columns may ride along.
    for (const bad of ['av_id_front', 'av_document', 'av_dob', 'av_id_image'])
      assert.ok(!ucols.includes(bad), `users must NOT carry ${bad}`);
  });

  await t.test('sender view: model sees her own media clear, flag visible', async () => {
    const byId = await threadMedia(model.token, convId);
    assert.equal(byId[A].unlocked, true);
    assert.equal(byId[A].shielded, false);
    assert.equal(byId[A].is_explicit, true);
    assert.equal(byId[B].is_explicit, false);
  });

  if (!active) {
    await t.test('DORMANT: unverified fan gets free flagged media exactly as today', async () => {
      const byId = await threadMedia(fan.token, convId);
      assert.equal(byId[A].unlocked, true, 'dormant: free media is open');
      assert.equal(byId[A].shielded, false, 'dormant: no shield flag');
      assert.equal(byId[C].unlocked, false, 'priced media stays locked');
      assert.equal(byId[C].shielded, false);
      const tok = await req('POST', `/api/media/${A}/file-token`, { token: fan.token });
      assert.equal(tok.status, 200, 'dormant: file-token issued for free media');
      const file = await req('GET', `/api/media/${A}/file`, { token: fan.token });
      assert.equal(file.status, 200, 'dormant: bytes served');
    });
  } else {
    await t.test('ACTIVE: free flagged media is shielded for the unverified fan (unknown location)', async () => {
      const byId = await threadMedia(fan.token, convId);
      assert.equal(byId[A].shielded, true);
      assert.equal(byId[A].unlocked, false);
      // Classification line: unflagged free media stays open.
      assert.equal(byId[B].unlocked, true, 'unflagged free media stays clear');
      assert.equal(byId[B].shielded, false);
      // Priced media: ordinary locked tile, no shield flag.
      assert.equal(byId[C].unlocked, false);
      assert.equal(byId[C].shielded, false);
    });

    await t.test('ACTIVE: shielded bytes are gated on BOTH file routes', async () => {
      const tok = await req('POST', `/api/media/${A}/file-token`, { token: fan.token });
      assert.equal(tok.status, 403);
      assert.equal(tok.json.error, 'av_required');
      const file = await req('GET', `/api/media/${A}/file`, { token: fan.token });
      assert.equal(file.status, 403);
      assert.equal(file.json.error, 'av_required');
      // Unflagged free media bytes still flow.
      const tokB = await req('POST', `/api/media/${B}/file-token`, { token: fan.token });
      assert.equal(tokB.status, 200);
    });

    await t.test('ACTIVE: the model toggle flips the shield both ways; fans cannot flip it', async () => {
      const fanFlip = await req('POST', `/api/media/${B}/explicit`, { body: { explicit: true }, token: fan.token });
      assert.equal(fanFlip.status, 403, 'fans get no flag control');
      const on = await req('POST', `/api/media/${B}/explicit`, { body: { explicit: true }, token: model.token });
      assert.equal(on.status, 200, on.text);
      let byId = await threadMedia(fan.token, convId);
      assert.equal(byId[B].shielded, true, 'newly flagged free media shields');
      const off = await req('POST', `/api/media/${B}/explicit`, { body: { explicit: false }, token: model.token });
      assert.equal(off.status, 200);
      byId = await threadMedia(fan.token, convId);
      assert.equal(byId[B].shielded, false);
      assert.equal(byId[B].unlocked, true);
    });

    await t.test('ACTIVE: directory withholds preview loops from shielded viewers only', async () => {
      dbExec("UPDATE models SET preview_video_url = '/uploads/preview-test.mp4' WHERE user_id = ?", [model.id]);
      const asGuest = await req('GET', '/api/models');
      const g = asGuest.json.models.find((m) => m.id === model.id);
      assert.equal(g.preview_video_url, '', 'guest at unknown location: preview withheld');
      assert.ok(g.photo_url !== undefined, 'photo field untouched');
      const asFan = await req('GET', '/api/models', { token: fan.token });
      assert.equal(asFan.json.models.find((m) => m.id === model.id).preview_video_url, '',
        'unverified fan: preview withheld');
      dbExec("UPDATE users SET fan_state = 'CA' WHERE id = ?", [fan.id]);
      const asCaFan = await req('GET', '/api/models', { token: fan.token });
      assert.equal(asCaFan.json.models.find((m) => m.id === model.id).preview_video_url,
        '/uploads/preview-test.mp4', 'known non-AV-state fan keeps the preview');
      const byId = await threadMedia(fan.token, convId);
      assert.equal(byId[A].unlocked, true, 'known non-AV-state fan is not shielded in chat either');
      dbExec('UPDATE users SET fan_state = NULL WHERE id = ?', [fan.id]);
    });

    await t.test('ACTIVE: verified fan sees everything clear', async () => {
      dbExec("UPDATE users SET av_verified_at = datetime('now') WHERE id = ?", [fan.id]);
      const byId = await threadMedia(fan.token, convId);
      assert.equal(byId[A].unlocked, true);
      assert.equal(byId[A].shielded, false);
      const tok = await req('POST', `/api/media/${A}/file-token`, { token: fan.token });
      assert.equal(tok.status, 200);
      const asFan = await req('GET', '/api/models', { token: fan.token });
      assert.equal(asFan.json.models.find((m) => m.id === model.id).preview_video_url,
        '/uploads/preview-test.mp4');
      dbExec('UPDATE users SET av_verified_at = NULL WHERE id = ?', [fan.id]);
    });
  }

  await t.test('guests receive no chat media bytes in either configuration', async () => {
    const gt = await req('POST', '/api/guest/token', { body: {} });
    const guestToken = gt.json.guest_token;
    assert.ok(guestToken, 'guest token issued');
    const gc = await req('POST', '/api/conversations/start', { body: { model_id: model.id }, guest: guestToken });
    assert.equal(gc.status, 200, gc.text);
    const gMsgs = await req('GET', `/api/conversations/${gc.json.conversation.id}/messages?limit=50`, { guest: guestToken });
    assert.equal(gMsgs.status, 200, gMsgs.text);
    for (const m of gMsgs.json.messages) {
      if (m.media) assert.equal(m.media.unlocked, false, 'guest media is never unlocked');
    }
    const tok = await req('POST', `/api/media/${A}/file-token`, { guest: guestToken });
    assert.equal(tok.status, 401, 'file-token requires login');
  });

  await t.test(`live explicit entry: ${active ? 'refused while shielded, opens once verified' : 'no AV gate while dormant'}`, async () => {
    // OR IGNORE: since the upload gate (Oct 21 2026) the scenario
    // approves her at setup (above); this insert remains for the
    // record — her approval state here is 'approved' either way.
    dbExec("INSERT OR IGNORE INTO id_verifications (model_id, status) VALUES (?, 'approved')", [model.id]);
    dbExec('UPDATE wallets SET credits_cents = 100000 WHERE user_id = ?', [fan.id]);
    const start = await req('POST', '/api/live/start', { body: {}, token: model.token });
    assert.equal(start.status, 200, start.text);
    const sid = start.json.session_id;
    const join = await req('POST', `/api/live/${sid}/join`, { body: {}, token: fan.token });
    assert.equal(join.status, 200, join.text);
    const mode = await req('POST', `/api/live/${sid}/mode`, { body: { is_explicit: 1 }, token: model.token });
    assert.equal(mode.status, 200, mode.text);
    const entry = await req('POST', `/api/live/${sid}/explicit-entry`, { body: {}, token: fan.token });
    if (!active) {
      assert.equal(entry.status, 200, `dormant: entry proceeds (got ${entry.status}: ${entry.text})`);
    } else {
      assert.equal(entry.status, 403, `active+shielded: refused (got ${entry.status}: ${entry.text})`);
      assert.equal(entry.json.error, 'av_required');
      const pay = await req('POST', `/api/live/${sid}/pay`, { body: {}, token: fan.token });
      assert.equal(pay.status, 403);
      assert.equal(pay.json.error, 'av_required');
      const bal = dbAll('SELECT credits_cents FROM wallets WHERE user_id = ?', [fan.id]);
      assert.equal(bal[0].credits_cents, 100000, 'refusals happen BEFORE any charge');
      dbExec("UPDATE users SET av_verified_at = datetime('now') WHERE id = ?", [fan.id]);
      const entry2 = await req('POST', `/api/live/${sid}/explicit-entry`, { body: {}, token: fan.token });
      assert.equal(entry2.status, 200, `verified: entry opens (got ${entry2.status}: ${entry2.text})`);
      dbExec('UPDATE users SET av_verified_at = NULL WHERE id = ?', [fan.id]);
    }
  });
}

test('shield server — DORMANT boot pins today\u2019s behavior', async (t) => {
  await bootServer({});
  try { await runScenario(t, false); } finally { await stopServer(); }
});

test('shield server — ACTIVE boot enforces the shield', async (t) => {
  await bootServer({ AV_PROVIDER: 'stub', AV_API_KEY: 'test-key' });
  try { await runScenario(t, true); } finally { await stopServer(); }
});

/* ---------------- 3. source pins ---------------- */

test('pins: shield tile is inert (no unlock affordance) with the verified-only hint', () => {
  assert.match(appJs, /md\.shielded/);
  assert.match(appJs, /ppv-shield/);
  assert.match(appJs, /t\('av_shield_hint'\)/);
  const shieldBlock = appJs.slice(appJs.indexOf('md.shielded'), appJs.indexOf('md.shielded') + 900);
  assert.ok(!shieldBlock.includes('data-unlock'), 'shield tile must NOT carry the unlock hook');
  assert.ok(!shieldBlock.includes('<button'), 'shield tile must not be a button');
});

test('pins: i18n keys exist in all three dictionaries', () => {
  for (const key of ['av_shield_hint', 'ppv_explicit_label', 'ppv_explicit_mark', 'ppv_explicit_note']) {
    const n = appJs.split(`${key}:`).length - 1;
    assert.ok(n >= 3, `${key} must exist in EN/ES/PT (found ${n})`);
  }
});

test('pins: price sheet checkbox, upload flag, owner toggle wiring', () => {
  assert.match(appJs, /id="ppv-explicit"/);
  assert.match(appJs, /fd\.append\('is_explicit', '1'\)/);
  assert.match(appJs, /data-explicit-toggle/);
  assert.match(appJs, /toggleMediaExplicit/);
  assert.match(appJs, /`\/media\/\$\{mediaId\}\/explicit`/);
});

test('pins: CSS shield variant + toggle styles', () => {
  assert.match(css, /\.ppv-shield/);
  assert.match(css, /\.media-explicit-toggle/);
});

test('pins: server wires the shield decision layer + byte gates', () => {
  assert.match(serverJs, /require\('\.\/lib\/shield'\)/);
  assert.match(serverJs, /addColumnIfMissing\('media_items', 'is_explicit'/);
  assert.match(serverJs, /addColumnIfMissing\('users', 'av_verified_at'/);
  assert.match(serverJs, /shieldAppliesToIdent/);
  assert.match(serverJs, /error: 'av_required'/);
});
