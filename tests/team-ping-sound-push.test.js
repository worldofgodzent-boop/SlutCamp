'use strict';
/*
 * Team-channel ping — sound + Web Push (Assignment 19, Ms. Pink 2026-10-28).
 * Layers ON TOP of Assignment 09 (badge + tab title via the 15s shell
 * poll); A09's behaviour is the base layer and is NOT re-decided here —
 * tests/manager-team-ping.test.js runs as the neighbour pin for it.
 *
 * What is under test, and what is NOT:
 * - Sound (client, source pins + unit): the pure teamPingSound decision
 *   extracted from the shipped manager.js (foreign-newer fires once,
 *   own/baseline/mark-seen/stale/repeat-poll never fire), the one-time
 *   first-gesture arming listener, AudioContext created ONLY inside the
 *   arm handler (never in the play path), no external audio files, and
 *   the teamPingTick wiring.
 * - Push (live server, real web-push against a local HTTPS stub — zero
 *   external network): seat-keyed subscription storage behind the
 *   Manager auth chain (a fan token cannot subscribe as a seat), the
 *   fan-out on team post reaching every OTHER seat and never the
 *   author, real VAPID-signed encrypted deliveries, 410 dead-sub
 *   pruning, unsubscribe, and dormant behaviour with VAPID unset
 *   (subscribe stores, post succeeds, nothing is sent).
 * - NOT tested: a real browser's PushManager/service-worker behaviour
 *   or iOS delivery (no browser in this suite — same caveat as prior
 *   assignments). The gate is Ms. Pink's.
 *
 * Login budget per boot stays within the 5/min manager-login limit
 * (boot 1: admin + kaykay + mspink = 3; boot 2: admin + kaykay = 2).
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

const REPO = path.join(__dirname, '..');
const MGRJS = path.join(REPO, 'public', 'manager', 'manager.js');
const MGR = { 'x-manager': '1' };

/* ---------------- Part A: static pins + sound-decision unit tests ---------------- */

const mgrSrc = fs.readFileSync(MGRJS, 'utf8');
const serverSrc = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
const a19Start = mgrSrc.indexOf('Team ping — sound + Web Push (Assignment 19');
const a19 = mgrSrc.slice(a19Start, mgrSrc.indexOf('/* TEAM_PING_A19_END */'));

test('A09 base layer intact: teamPingNext markers + tick still present', () => {
  assert.ok(mgrSrc.includes('/* TEAM_PING_NEXT_START */'), 'A09 decision markers');
  assert.ok(mgrSrc.includes('function teamPingTick()'), 'A09 shell poll');
  assert.ok(mgrSrc.includes('teamPingRender();'), 'A09 badge/title render');
});

test('static pins: sound arming, gesture-only AudioContext, no audio files', () => {
  assert.ok(a19Start > 0, 'A19 section present');
  assert.ok(a19.includes("window.addEventListener('pointerdown', teamPingFirstGesture)"),
    'arming rides the first pointerdown');
  assert.ok(a19.includes("window.addEventListener('click', teamPingFirstGesture)"),
    'arming rides the first click');
  const arm = a19.slice(a19.indexOf('function armTeamPingAudio()'),
    a19.indexOf('function playTeamPingSound()'));
  assert.ok(arm.includes('new AC()'), 'AudioContext created inside the gesture arm handler');
  assert.ok(arm.includes('teamPingAudioArmed = true'), 'one-time arm latch');
  const play = a19.slice(a19.indexOf('function playTeamPingSound()'),
    a19.indexOf('let teamPushAsked'));
  assert.ok(!play.includes('AudioContext') && !play.includes('new AC('),
    'play path never creates an AudioContext (no autoplay path)');
  assert.ok(play.includes('if (!teamPingAudioArmed || !teamPingAudioCtx) return;'),
    'unarmed = silent skip');
  assert.ok(play.includes('createOscillator'), 'tone is WebAudio-generated');
  assert.ok(!/\.mp3|\.wav|\.ogg|new Audio\(/.test(a19), 'no external audio files');
  assert.ok(mgrSrc.includes(
    'if (teamPingSound(prevUnread, next.unread, newest, ownAuthor)) playTeamPingSound();'),
    'tick consults the decision after the A09 transition');
});

test('static pins: push client + server wiring', () => {
  assert.ok(a19.includes("navigator.serviceWorker.register('/sw.js')"),
    'Manager registers the root-scope site worker');
  assert.ok(a19.includes("api('/push/vapid-key')"), 'VAPID key from the existing endpoint');
  assert.ok(a19.includes('Notification.requestPermission()'), 'permission requested');
  assert.ok(a19.includes("api('/admin/team-push/subscribe'"), 'seat subscribe endpoint called');
  assert.ok(a19.includes("api('/admin/team-push/unsubscribe'"), 'seat unsubscribe on logout');
  assert.ok(serverSrc.includes('CREATE TABLE IF NOT EXISTS team_push_subscriptions'),
    'seat-keyed subscription table');
  assert.ok(serverSrc.includes("app.post('/api/admin/team-push/subscribe', ...adminOnly"),
    'subscribe behind the Manager auth chain');
  assert.ok(serverSrc.includes("app.post('/api/admin/team-push/unsubscribe', ...adminOnly"),
    'unsubscribe behind the Manager auth chain');
  assert.ok(serverSrc.includes('notifyTeamPush(author, row);'),
    'fan-out fires from the team post handler');
  assert.ok(serverSrc.includes('WHERE seat != ?'), 'fan-out excludes the author seat');
});

function loadTeamPingSound() {
  const start = mgrSrc.indexOf('/* TEAM_PING_SOUND_START */');
  const end = mgrSrc.indexOf('/* TEAM_PING_SOUND_END */');
  assert.ok(start >= 0 && end > start, 'teamPingSound markers present');
  const fnText = mgrSrc.slice(start, end)
    .replace('/* TEAM_PING_SOUND_START */', '').trim();
  return new Function(`return (${fnText.replace(/^function teamPingSound/, 'function')})`)();
}
const teamPingSound = loadTeamPingSound();
const KK = 'delegate:kaykay';

test('teamPingSound: foreign-newer fires once; own/baseline/seen/stale never', () => {
  // Foreign message lands while the channel is closed: unread 0 -> 2. FIRE.
  assert.equal(teamPingSound(0, 2, { id: 12, author: 'owner' }, KK), true);
  // Same message re-polled 15s later: count recomputed identically. NO repeat.
  assert.equal(teamPingSound(2, 2, { id: 12, author: 'owner' }, KK), false);
  // A second foreign message lands: count grows again. FIRE (once for it too).
  assert.equal(teamPingSound(2, 4, { id: 14, author: 'delegate:mspink' }, KK), true);
  // First sign-in baseline: newest foreign, unread stays 0. No fire.
  assert.equal(teamPingSound(0, 0, { id: 5, author: 'owner' }, KK), false);
  // Channel open / mark-seen: unread clears to 0. No fire.
  assert.equal(teamPingSound(3, 0, { id: 15, author: 'owner' }, KK), false);
  // Own newest: state untouched, pending preserved. No fire.
  assert.equal(teamPingSound(1, 1, { id: 12, author: KK }, KK), false);
  assert.equal(teamPingSound(0, 5, { id: 12, author: KK }, KK), false,
    'own author never fires even if counts move');
  // Stale newest / no newest: no fire.
  assert.equal(teamPingSound(1, 1, { id: 10, author: 'owner' }, KK), false);
  assert.equal(teamPingSound(0, 2, null, KK), false);
  assert.equal(teamPingSound(0, 2, { id: NaN, author: 'owner' }, KK), false);
});

/* ---------------- Part B: live server boots ---------------- */

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function bootServer(extraEnv) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-a19-'));
  for (const f of ['server.js', 'package.json']) fs.copyFileSync(path.join(REPO, f), path.join(dir, f));
  for (const d of ['lib', 'public', 'data']) fs.cpSync(path.join(REPO, d), path.join(dir, d), { recursive: true });
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), SEED_DEMO: '1' };
  for (const k of Object.keys(env)) {
    if (/^(CCBILL_|CRYPTO_|OPENAI_|TWILIO_|VAPID_|WEBAUTHN_)/.test(k)) delete env[k];
  }
  Object.assign(env, extraEnv);
  const child = spawn(process.execPath, ['server.js'], { cwd: dir, env });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode})\n${log}`);
    try { const r = await fetch(base + '/api/health'); if (r.ok) break; } catch (e) { /* not up */ }
    if (Date.now() > deadline) throw new Error(`server did not come up\n${log}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  return { base, dir, child };
}

function makeReq(base) {
  return async (method, p, { body, token, headers = {} } = {}) => {
    const h = { ...headers };
    if (body !== undefined) h['content-type'] = 'application/json';
    if (token) h.authorization = 'Bearer ' + token;
    const r = await fetch(base + p, {
      method, headers: h,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* not json */ }
    return { status: r.status, json, text };
  };
}
const A = (token) => ({ token, headers: MGR });
const AB = (token, body) => ({ token, headers: MGR, body });

async function seatLogin(req, adminToken, username, password) {
  const set = await req('POST', `/api/admin/delegate/${username}/set-password`,
    AB(adminToken, { password }));
  assert.equal(set.status, 200, `set-password ${username}: ${JSON.stringify(set.json)}`);
  const en = await req('POST', `/api/admin/delegate/${username}/enable`, AB(adminToken, {}));
  assert.equal(en.status, 200, `enable ${username}: ${JSON.stringify(en.json)}`);
  const login = await req('POST', '/api/manager/login', { body: { username, password } });
  assert.equal(login.status, 200, `login ${username}: ${JSON.stringify(login.json)}`);
  return login.json.token;
}

// Real ECDH subscription keys, the shape a browser PushManager produces.
function makeSubKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    p256dh: ecdh.getPublicKey(null, 'uncompressed').toString('base64url'),
    auth: crypto.randomBytes(16).toString('base64url'),
  };
}

async function waitFor(cond, ms = 9000) {
  const start = Date.now();
  for (;;) {
    if (cond()) return true;
    if (Date.now() - start > ms) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

test('B1: VAPID on — seat slots, fan-out to other seats only, 410 pruning, unsubscribe',
  { timeout: 180000 }, async (t) => {
    // Local HTTPS push-service stub (web-push speaks https only). Paths
    // stand in for each seat's device endpoint; mspink's answers 410
    // Gone, like a dead subscription at a real push service.
    const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-a19-cert-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048',
      '-keyout', path.join(certDir, 'key.pem'), '-out', path.join(certDir, 'cert.pem'),
      '-days', '2', '-nodes', '-subj', '/CN=localhost'],
      { stdio: 'pipe' });
    const hits = { owner: 0, kaykay: 0, mspink: 0 };
    const lastHeaders = {};
    const stub = https.createServer(
      { key: fs.readFileSync(path.join(certDir, 'key.pem')),
        cert: fs.readFileSync(path.join(certDir, 'cert.pem')) },
      (req, res) => {
        let n = 0;
        req.on('data', (c) => { n += c.length; });
        req.on('end', () => {
          const seat = req.url.split('/').pop();
          if (seat in hits) { hits[seat]++; lastHeaders[seat] = req.headers; }
          res.statusCode = seat === 'mspink' ? 410 : 201;
          res.end();
        });
      });
    await new Promise((r) => stub.listen(0, '127.0.0.1', r));
    const stubBase = `https://127.0.0.1:${stub.address().port}/push`;

    const webpush = require(path.join(REPO, 'node_modules', 'web-push'));
    const vapid = webpush.generateVAPIDKeys();
    const { base, dir, child } = await bootServer({
      VAPID_PUBLIC_KEY: vapid.publicKey,
      VAPID_PRIVATE_KEY: vapid.privateKey,
      VAPID_SUBJECT: 'mailto:a19-test@example.com',
      NODE_TLS_REJECT_UNAUTHORIZED: '0', // accept the stub's self-signed cert
    });
    t.after(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(certDir, { recursive: true, force: true });
      stub.close();
    });
    const req = makeReq(base);

    const adminLogin = await req('POST', '/api/manager/login',
      { body: { username: 'admin', password: 'admin123' } }); // login #1
    assert.equal(adminLogin.status, 200, JSON.stringify(adminLogin.json));
    const adminToken = adminLogin.json.token;
    const kaykayToken = await seatLogin(req, adminToken, 'kaykay', 'KayKayPass!23'); // login #2
    const mspinkToken = await seatLogin(req, adminToken, 'mspink', 'MsPinkPass!23'); // login #3

    // A fan token can NEVER subscribe as a seat; no token is refused too.
    const fan = await req('POST', '/api/auth/signup', { body: {
      username: 'a19fan', password: 'fan-pass-123', role: 'fan',
      display_name: 'A19 Fan', dob: '1995-05-05', agree18: true } });
    assert.equal(fan.status, 200, JSON.stringify(fan.json));
    const fanSub = await req('POST', '/api/admin/team-push/subscribe',
      { token: fan.json.token, headers: MGR, body: { endpoint: `${stubBase}/owner`, ...makeSubKeys() } });
    assert.equal(fanSub.status, 403, `fan token refused: ${fanSub.status}`);
    const anonSub = await req('POST', '/api/admin/team-push/subscribe',
      { headers: MGR, body: { endpoint: `${stubBase}/owner`, ...makeSubKeys() } });
    assert.ok(anonSub.status === 401 || anonSub.status === 403,
      `anonymous refused: ${anonSub.status}`);

    // Each seat subscribes its own device endpoint into its own slot.
    const sub = async (token, seat) => req('POST', '/api/admin/team-push/subscribe',
      AB(token, { endpoint: `${stubBase}/${seat}`, ...makeSubKeys() }));
    const sOwner = await sub(adminToken, 'owner');
    assert.equal(sOwner.status, 200, JSON.stringify(sOwner.json));
    assert.equal(sOwner.json.seat, 'owner');
    assert.equal(sOwner.json.web_push_ready, true);
    const sKay = await sub(kaykayToken, 'kaykay');
    assert.equal(sKay.json.seat, 'delegate:kaykay');
    const sPink = await sub(mspinkToken, 'mspink');
    assert.equal(sPink.json.seat, 'delegate:mspink');
    const bad = await req('POST', '/api/admin/team-push/subscribe', AB(adminToken, {}));
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, 'bad_subscription');

    // Kay Kay posts: owner + mspink devices are pushed, hers is NOT.
    const p1 = await req('POST', '/api/admin/team-messages', AB(kaykayToken, { body: 'Kay Kay: ping one' }));
    assert.equal(p1.status, 200, JSON.stringify(p1.json));
    assert.ok(await waitFor(() => hits.owner === 1 && hits.mspink === 1),
      `fan-out landed: ${JSON.stringify(hits)}`);
    assert.equal(hits.kaykay, 0, 'author never pushed');
    // The delivery is a real VAPID-signed, encrypted web-push request.
    assert.equal(lastHeaders.owner['content-encoding'], 'aes128gcm');
    assert.match(String(lastHeaders.owner.authorization || ''), /^vapid/i);

    // Kay Kay posts again: mspink's sub was pruned on the 410 — no retry.
    const p2 = await req('POST', '/api/admin/team-messages', AB(kaykayToken, { body: 'Kay Kay: ping two' }));
    assert.equal(p2.status, 200);
    assert.ok(await waitFor(() => hits.owner === 2), `second fan-out: ${JSON.stringify(hits)}`);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(hits.mspink, 1, 'dead subscription pruned, not retried');
    assert.equal(hits.kaykay, 0);

    // Owner posts: Kay Kay's device is pushed, the owner's is NOT.
    const p3 = await req('POST', '/api/admin/team-messages', AB(adminToken, { body: 'Owner: reply' }));
    assert.equal(p3.status, 200);
    assert.ok(await waitFor(() => hits.kaykay === 1), `owner fan-out: ${JSON.stringify(hits)}`);
    assert.equal(hits.owner, 2, 'author never pushed');

    // Unsubscribe removes the seat's slot: no further deliveries.
    const un = await req('POST', '/api/admin/team-push/unsubscribe',
      AB(kaykayToken, { endpoint: `${stubBase}/kaykay` }));
    assert.equal(un.status, 200);
    const p4 = await req('POST', '/api/admin/team-messages', AB(adminToken, { body: 'Owner: after unsub' }));
    assert.equal(p4.status, 200);
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(hits.kaykay, 1, 'unsubscribed device receives nothing more');
  });

test('B2: VAPID unset — dormant: subscribes store, posts succeed, nothing sent',
  { timeout: 180000 }, async (t) => {
    const { base, dir, child } = await bootServer({}); // no VAPID_* at all
    t.after(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const req = makeReq(base);
    const adminLogin = await req('POST', '/api/manager/login',
      { body: { username: 'admin', password: 'admin123' } }); // login #1
    assert.equal(adminLogin.status, 200, JSON.stringify(adminLogin.json));
    const adminToken = adminLogin.json.token;
    const kaykayToken = await seatLogin(req, adminToken, 'kaykay', 'KayKayPass!23'); // login #2

    const s1 = await req('POST', '/api/admin/team-push/subscribe',
      AB(adminToken, { endpoint: 'https://push.example.invalid/owner', ...makeSubKeys() }));
    assert.equal(s1.status, 200, JSON.stringify(s1.json));
    assert.equal(s1.json.web_push_ready, false, 'dormancy reported honestly to the client');
    const s2 = await req('POST', '/api/admin/team-push/subscribe',
      AB(kaykayToken, { endpoint: 'https://push.example.invalid/kaykay', ...makeSubKeys() }));
    assert.equal(s2.status, 200);

    const p = await req('POST', '/api/admin/team-messages', AB(kaykayToken, { body: 'Kay Kay: dormant post' }));
    assert.equal(p.status, 200, 'post succeeds with push dormant');
    assert.equal(p.json.ok, true);
    await new Promise((r) => setTimeout(r, 400));
    const all = await req('GET', '/api/admin/team-messages?limit=5', A(adminToken));
    assert.equal(all.status, 200, 'server healthy after the dormant fan-out');
    assert.equal(all.json.messages.length, 1);
    assert.equal(all.json.messages[0].body, 'Kay Kay: dormant post');
  });
