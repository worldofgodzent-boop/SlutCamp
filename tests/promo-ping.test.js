'use strict';
/*
 * Owner promo ping (Assignment 20, owner-directed 2026-10-28).
 *
 * The ask: promo is the priority for the next few months — when a model
 * goes explicit on SlutCamp, the owner gets a ping so he can jump into
 * her live room and screen-record the moment for X promo. Female and
 * Couple models ONLY (owner ruling). The terms-side promo-use clause is
 * deliberately NOT in this build: it lands after CCBill closes.
 *
 * What is under test:
 * - Server (live, real web-push against a local HTTPS stub — the A19
 *   harness): the 0→1 explicit flip of a PUBLIC live (POST
 *   /api/live/:id/mode) pushes exactly the 'owner' seat — never a
 *   delegate seat — and logs one promo_pings row per flip.
 * - Transition discipline: re-posting is_explicit:true while already
 *   explicit does NOT re-ping; off→on is a fresh flip and pings again.
 * - Section filter: a Male-section flip never pings and never logs.
 * - Privacy wall: a Private Room session (live_sessions.private_event_id
 *   set — the Phase 5 marker) flips explicit WITHOUT any ping or log
 *   row. The session row is inserted directly because driving the full
 *   private-event seat-sale flow is out of scope here; the row shape is
 *   exactly what that flow writes, and the /mode route is the real one.
 * - Dormancy: with VAPID unset the flip still succeeds and the log row
 *   is still written; nothing is sent and nothing breaks.
 * - Client (static pins): the ?live=<id> deep link the push carries —
 *   boot stashes it (URL cleaned), routeInitial lands a signed-in fan
 *   or the house account in watchLive() instead of the directory.
 *
 * NOT tested: a real browser's PushManager delivery or iOS behaviour
 * (no browser in this suite — same caveat as A19). The push payload
 * body is encrypted end-to-end, so the stub asserts delivery counts;
 * title/body/link composition is pinned statically.
 *
 * Manager-login budget per boot stays within the 5/min limit
 * (boot 1: admin + kaykay = 2; boot 2: admin = 1).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const https = require('node:https');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const REPO = path.join(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(REPO, 'public/js/app.js'), 'utf8');
const MGRH = { 'x-manager': '1' };

/* ---------------- Part A: static pins ---------------- */

test('A20 server pins: log table, owner-only push, guarded flip hook', () => {
  assert.ok(serverSrc.includes('CREATE TABLE IF NOT EXISTS promo_pings'),
    'promo_pings table declared');
  const ownerPush = serverSrc.slice(serverSrc.indexOf('async function sendOwnerPush'),
    serverSrc.indexOf('function notifyPromoPing'));
  assert.ok(ownerPush.includes("WHERE seat = 'owner'"),
    'promo push audience is exactly the owner seat');
  const gate = serverSrc.slice(serverSrc.indexOf('function maybePromoPing'),
    serverSrc.indexOf('/* The A20 gate') > -1
      ? serverSrc.indexOf('function maybePromoPing') + 2400
      : serverSrc.indexOf('function maybePromoPing') + 2400);
  assert.ok(gate.includes('sess.private_event_id'), 'private-room wall present');
  assert.ok(gate.includes('isHouseAccountId(sess.model_id)'), 'house never pings about itself');
  assert.ok(gate.includes("m.section !== 'female' && m.section !== 'couple'"),
    'female + couple sections only');
  assert.ok(gate.includes('INSERT INTO promo_pings'), 'flip is logged');
  assert.ok(serverSrc.includes('if (isExplicit && !sess.is_explicit) maybePromoPing(sess);'),
    'hook fires on the 0→1 transition only');
  assert.ok(serverSrc.includes('title: `🔴 ${name} went explicit`'), 'push title names the model');
  assert.ok(serverSrc.includes('link: `/?live=${sessionId}`'), 'push links into her live room');
});

test('A20 client pins: ?live= deep link stashes and lands in watchLive', () => {
  assert.ok(appSrc.includes("const lv = qs.get('live');"), 'boot reads the live param');
  assert.ok(appSrc.includes('window.__promoLive = parseInt(lv, 10);'), 'boot stashes the session id');
  const route = appSrc.slice(appSrc.indexOf('window.__promoLive &&'),
    appSrc.indexOf('window.__promoLive &&') + 260);
  assert.ok(route.includes("S.user.role === 'fan' || S.user.is_house"),
    'fan + house accounts ride the link');
  assert.ok(route.includes('return watchLive(liveId);'), 'routeInitial opens the live room');
});

/* ---------------- harness (A19/battles pattern) ---------------- */

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
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
  const env = { ...process.env, PORT: String(port), CRYPTO_POLL_MS: '3600000', ...extraEnv };
  for (const k of Object.keys(env)) {
    if (/^(CCBILL_|CRYPTO_|OPENAI_|TWILIO_|VAPID_|WEBAUTHN_|AV_)/.test(k) && !(k in extraEnv)) delete env[k];
  }
  env.SEED_DEMO = 'SEED_DEMO' in extraEnv ? extraEnv.SEED_DEMO : '1';
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
  const hdrs = { ...(headers || {}) };
  if (body !== undefined) hdrs['content-type'] = 'application/json';
  if (token) hdrs.authorization = 'Bearer ' + token;
  const r = await fetch(base + p, {
    method, headers: hdrs, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
  return { status: r.status, text, json };
}
const PNG = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001080600000'
  + '01f15c4890000000a49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082', 'hex');
async function upload(base, p, token, fields = ['id_front', 'id_back', 'selfie']) {
  const fd = new FormData();
  for (const f of fields) fd.append(f, new Blob([PNG], { type: 'image/png' }), `${f}.png`);
  const r = await fetch(base + p, { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: fd });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
  return { status: r.status, text, json };
}
function openDb(dir, readOnly = true) {
  const db = new DatabaseSync(path.join(dir, 'wogent-chat.db'), readOnly ? { readOnly: true } : {});
  db.exec('PRAGMA busy_timeout = 10000');
  return db;
}
async function waitFor(cond, ms = 9000) {
  const start = Date.now();
  for (;;) {
    if (cond()) return true;
    if (Date.now() - start > ms) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

async function mgrLogin(base) {
  const mgr = await req(base, 'POST', '/api/manager/login', { body: { username: 'admin', password: 'admin123' } });
  assert.equal(mgr.status, 200, `manager login: ${mgr.text}`);
  return { token: mgr.json.token, headers: MGRH };
}

/* A model the way the app makes one: signup (with CCBill publicity
 * consent) → ID packet → WOGENT release → Manager approval → live. */
async function makeLiveModel(base, MGR, username, section) {
  const s = await req(base, 'POST', '/api/auth/signup', {
    body: { username, password: 'hunter22', role: 'model', display_name: username,
      dob: '1995-05-05', agree18: true, section, publicity_consent: true },
  });
  assert.equal(s.status, 200, `signup ${username}: ${s.text}`);
  const acct = { token: s.json.token, id: s.json.user.id, username };
  const up = await upload(base, '/api/model/id-verification', acct.token);
  assert.equal(up.status, 200, `ID upload ${username}: ${up.text}`);
  const sign = await req(base, 'POST', '/api/model/release/sign', { token: acct.token, body: {
    legal_name: 'Test Signer', stage_name: username, dob: '1995-05-05',
    attestations: { adult: true, freewill: true, rights: true } } });
  assert.equal(sign.status, 200, `release sign ${username}: ${sign.text}`);
  const q = await req(base, 'GET', '/api/admin/id-verifications', { ...MGR });
  const row = q.json.verifications.find((v) => v.model_id === acct.id && !v.co_performer_id);
  assert.ok(row, `ID submission queued for ${username}`);
  const ap = await req(base, 'POST', `/api/admin/id-verifications/${row.id}/approve`, { ...MGR });
  assert.equal(ap.status, 200, `approve ${username}: ${ap.text}`);
  const live = await req(base, 'POST', '/api/live/start', { token: acct.token, body: { title: `${username} live` } });
  assert.equal(live.status, 200, `live start ${username}: ${live.text}`);
  return { ...acct, sessionId: live.json.session_id };
}
const flip = (base, acct, sessionId, on) =>
  req(base, 'POST', `/api/live/${sessionId}/mode`, { token: acct.token, body: { is_explicit: on } });
function pingRows(dir, modelId) {
  const db = openDb(dir);
  try {
    return db.prepare('SELECT * FROM promo_pings WHERE model_id = ? ORDER BY id').all(modelId);
  } finally { db.close(); }
}
function makeSubKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    p256dh: ecdh.getPublicKey(null, 'uncompressed').toString('base64url'),
    auth: crypto.randomBytes(16).toString('base64url'),
  };
}

/* ---------------- Part B: live behaviour ---------------- */

test('B1: VAPID on — owner seat pushed on Female/Couple flips only; private room silent',
  { timeout: 300000 }, async (t) => {
    const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-a20-cert-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048',
      '-keyout', path.join(certDir, 'key.pem'), '-out', path.join(certDir, 'cert.pem'),
      '-days', '2', '-nodes', '-subj', '/CN=localhost'], { stdio: 'pipe' });
    const hits = { owner: 0, kaykay: 0 };
    const stub = https.createServer(
      { key: fs.readFileSync(path.join(certDir, 'key.pem')),
        cert: fs.readFileSync(path.join(certDir, 'cert.pem')) },
      (rq, rs) => {
        rq.on('data', () => {});
        rq.on('end', () => {
          const seat = rq.url.split('/').pop();
          if (seat in hits) hits[seat]++;
          rs.statusCode = 201;
          rs.end();
        });
      });
    await new Promise((r) => stub.listen(0, '127.0.0.1', r));
    const stubBase = `https://127.0.0.1:${stub.address().port}/push`;
    const webpush = require(path.join(REPO, 'node_modules', 'web-push'));
    const vapid = webpush.generateVAPIDKeys();
    const dir = makeCopy('a20push');
    const h = await boot(dir, {
      VAPID_PUBLIC_KEY: vapid.publicKey,
      VAPID_PRIVATE_KEY: vapid.privateKey,
      VAPID_SUBJECT: 'mailto:a20-test@example.com',
      NODE_TLS_REJECT_UNAUTHORIZED: '0', // accept the stub's self-signed cert
    });
    t.after(() => {
      stop(h);
      stub.close();
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(certDir, { recursive: true, force: true });
    });

    const MGR = await mgrLogin(h.base); // manager login #1 — the owner seat
    const subO = await req(h.base, 'POST', '/api/admin/team-push/subscribe',
      { token: MGR.token, headers: MGRH, body: { endpoint: `${stubBase}/owner`, ...makeSubKeys() } });
    assert.equal(subO.status, 200, `owner subscribe: ${subO.text}`);
    assert.equal(subO.json.seat, 'owner');

    // Kay Kay's delegate seat subscribes too — she must NEVER get a promo ping.
    const set = await req(h.base, 'POST', '/api/admin/delegate/kaykay/set-password',
      { token: MGR.token, headers: MGRH, body: { password: 'KayKayPass!23' } });
    assert.equal(set.status, 200, `kaykay set-password: ${set.text}`);
    const en = await req(h.base, 'POST', '/api/admin/delegate/kaykay/enable',
      { token: MGR.token, headers: MGRH, body: {} });
    assert.equal(en.status, 200, `kaykay enable: ${en.text}`);
    const kLogin = await req(h.base, 'POST', '/api/manager/login',
      { body: { username: 'kaykay', password: 'KayKayPass!23' } }); // manager login #2
    assert.equal(kLogin.status, 200, `kaykay login: ${kLogin.text}`);
    const subK = await req(h.base, 'POST', '/api/admin/team-push/subscribe',
      { token: kLogin.json.token, headers: MGRH, body: { endpoint: `${stubBase}/kaykay`, ...makeSubKeys() } });
    assert.equal(subK.status, 200, `kaykay subscribe: ${subK.text}`);
    assert.equal(subK.json.seat, 'delegate:kaykay');

    // Female model flips explicit → owner pushed once, row logged.
    const fem = await makeLiveModel(h.base, MGR, 'a20fem', 'female');
    const f1 = await flip(h.base, fem, fem.sessionId, true);
    assert.equal(f1.status, 200, `female flip: ${f1.text}`);
    assert.equal(f1.json.is_explicit, true);
    assert.ok(await waitFor(() => hits.owner === 1), `owner pushed once: ${JSON.stringify(hits)}`);
    assert.equal(hits.kaykay, 0, 'delegate seat NOT pushed');
    let rows = pingRows(dir, fem.id);
    assert.equal(rows.length, 1, 'one promo_pings row');
    assert.equal(rows[0].session_id, fem.sessionId, 'row names the session');

    // Re-posting ON while already explicit is NOT a transition → silent.
    await flip(h.base, fem, fem.sessionId, true);
    await settle(800);
    assert.equal(hits.owner, 1, 'repeat ON does not re-ping');
    assert.equal(pingRows(dir, fem.id).length, 1, 'repeat ON does not re-log');

    // Off → on is a fresh flip → pings and logs again.
    await flip(h.base, fem, fem.sessionId, false);
    await flip(h.base, fem, fem.sessionId, true);
    assert.ok(await waitFor(() => hits.owner === 2), 'off→on pings again');
    assert.equal(pingRows(dir, fem.id).length, 2, 'second flip logged');

    // Male model flips → never pings, never logs.
    const male = await makeLiveModel(h.base, MGR, 'a20male', 'male');
    const mf = await flip(h.base, male, male.sessionId, true);
    assert.equal(mf.status, 200, `male flip: ${mf.text}`);
    assert.equal(mf.json.is_explicit, true, 'his flip itself still works');
    await settle(900);
    assert.equal(hits.owner, 2, 'male flip never pings');
    assert.equal(pingRows(dir, male.id).length, 0, 'male flip never logs');

    // Couple model flips → pings.
    const cpl = await makeLiveModel(h.base, MGR, 'a20couple', 'couple');
    await flip(h.base, cpl, cpl.sessionId, true);
    assert.ok(await waitFor(() => hits.owner === 3), 'couple flip pings the owner');
    assert.equal(pingRows(dir, cpl.id).length, 1, 'couple flip logged');
    assert.equal(hits.kaykay, 0, 'delegate seat never pushed in the whole run');

    // Private Room session (Phase 5 marker row, written directly — see
    // header note): the flip itself works, but NO ping and NO log row.
    const wdb = openDb(dir, false);
    const info = wdb.prepare(
      "INSERT INTO live_sessions (model_id, status, private_event_id) VALUES (?, 'live', 999001)")
      .run(fem.id);
    wdb.close();
    const privId = Number(info.lastInsertRowid);
    const pf = await flip(h.base, fem, privId, true);
    assert.equal(pf.status, 200, `private flip: ${pf.text}`);
    const chk = openDb(dir);
    const prow = chk.prepare('SELECT is_explicit FROM live_sessions WHERE id = ?').get(privId);
    chk.close();
    assert.equal(prow.is_explicit, 1, 'the private session really did flip explicit');
    await settle(900);
    assert.equal(hits.owner, 3, 'private room flip NEVER pings');
    assert.equal(pingRows(dir, fem.id).filter((r) => r.session_id === privId).length, 0,
      'private flip never logged');
  });

test('B2: VAPID unset — dormant push, flip + log still work',
  { timeout: 180000 }, async (t) => {
    const dir = makeCopy('a20dormant');
    const h = await boot(dir, {});
    t.after(() => {
      stop(h);
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const MGR = await mgrLogin(h.base);
    const fem = await makeLiveModel(h.base, MGR, 'a20dorm', 'female');
    const f = await flip(h.base, fem, fem.sessionId, true);
    assert.equal(f.status, 200, `dormant flip: ${f.text}`);
    assert.equal(f.json.is_explicit, true);
    await settle(500);
    assert.equal(pingRows(dir, fem.id).length, 1, 'log row written even with push dormant');
  });
