'use strict';
/*
 * Sections Phase 4 — live face-count guard + HOUSE LINEUP
 * (owner design Oct 20 2026: house lives declare a lineup of
 * roster models already ID-verified on their own accounts; the
 * broadcaster's client counts faces on-device and enforces the
 * session's face cap = 1 + validated declared participants).
 *
 * What this pins:
 *  - Server: GET /api/live/lineup is house-only (403 house_only for
 *    models) and lists exactly the lineup-eligible roster: role
 *    'model', not banned, own primary ID approved, never the house.
 *  - Server: POST /api/live/start house branch — a verified roster
 *    model is accepted as a house-live participant; an unverified
 *    model, a fan id, and a banned model are refused with the same
 *    403 unapproved_participants shape as the co-performer rule;
 *    the house id itself never counts as a lineup member (it is
 *    filtered out of the lineup and never inflates the cap — a
 *    house live declaring only itself stays the Phase-3 solo live).
 *  - Server: non-house behavior is unchanged — cameraAllowedIds is
 *    untouched, a model declaring a verified roster model who is
 *    NOT her approved co-performer is still refused.
 *  - Server: face_cap rides the live/start response (solo model 1;
 *    model + 2 approved co-performers 3; house + 2 lineup 3) and is
 *    readable back via GET /api/live/:id (the rejoin path).
 *  - Client: the guard's decision function (sliced verbatim from
 *    app.js, executed in a vm) — at/under cap ok; ONE over-cap
 *    sample warns but never cuts; a SECOND consecutive over-cap
 *    sample cuts; an at-cap sample clears the warning.
 *  - Client: vendored pico detector ships in public/vendor/, the
 *    embedded cascade decodes to the real facefinder bytes and the
 *    shipped pair runs (blank frame → zero detections); the guard
 *    is armed only from the model's live start/rejoin, is stopped
 *    by endLiveView, fails open on an unknown cap, and the lineup
 *    picker + all new strings exist in all 13 languages.
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
const appSrc = fs.readFileSync(path.join(REPO, 'public/js/app.js'), 'utf8');
const serverSrc = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');

function sliceFn(src, startMarker, endMarker) {
  const s = src.indexOf(startMarker);
  const e = src.indexOf(endMarker, s);
  assert.ok(s !== -1 && e > s, `located ${startMarker} … ${endMarker}`);
  return src.slice(s, e);
}

/* --------------------------- static pins --------------------------- */

test('server: lineup endpoint is house-only and eligibility is own-ID approval', () => {
  const route = sliceFn(serverSrc, "app.get('/api/live/lineup'", "app.post('/api/live/start'");
  assert.ok(route.includes("error: 'house_only'"), 'non-house callers are refused 403 house_only');
  assert.ok(route.includes('isHouseAccountId(req.user.id)'), 'gated on the house account');
  assert.ok(route.includes("v.co_performer_id IS NULL AND v.status = 'approved'"),
    'eligibility = her OWN primary verification row approved (the isIdVerified rule)');
  assert.ok(route.includes("u.role = 'model' AND u.banned = 0"), 'models only, banned excluded');
  assert.ok(route.includes('u.id != ?'), 'the house itself is never in its own lineup roster');
});

test('server: live/start house branch validates the lineup; cameraAllowedIds untouched', () => {
  const route = sliceFn(serverSrc, "app.post('/api/live/start'", "app.post('/api/live/:id/leave'");
  assert.ok(route.includes('isHouseAccountId(req.user.id)'), 'house branch keyed on the house account');
  assert.ok(route.includes("u.role !== 'model' || u.banned || isHouseAccountId(pid) || !isIdVerified(pid)"),
    'lineup entries must be unbanned verified roster models, never the house');
  assert.ok(route.includes("error: 'unapproved_participants'"), 'same 403 shape as the co-performer rule');
  assert.ok(route.includes('cameraAllowedIds(req.user.id)'), 'non-house subset rule still cameraAllowedIds');
  const cam = sliceFn(serverSrc, 'function cameraAllowedIds', '\n}');
  assert.ok(cam.includes("status = 'approved'"), 'cameraAllowedIds semantics unchanged');
  assert.ok(!cam.includes('lineup'), 'cameraAllowedIds was NOT widened with the lineup');
});

test('server: face_cap is computed at start, returned, and readable on rejoin', () => {
  const route = sliceFn(serverSrc, "app.post('/api/live/start'", "app.post('/api/live/:id/leave'");
  assert.ok(route.includes('let faceCap = 1'), 'solo cap is 1');
  assert.ok(route.includes('face_cap: faceCap'), 'start response carries face_cap');
  assert.ok(serverSrc.includes('liveFaceCaps.set('), 'cap recorded for the rejoin read');
  const get = sliceFn(serverSrc, "app.get('/api/live/:id'", "app.post('/api/admin/live/:id/watch'");
  assert.ok(get.includes('face_cap: liveFaceCaps.has(sess.id)'), 'GET /live/:id returns the cap (null when unknown)');
  assert.ok(serverSrc.includes('liveFaceCaps.delete(sess.id)'), 'cap dropped when the session ends');
});

test('client: guard arms only on model live paths, stops on end, lineup picker wired', () => {
  assert.ok(appSrc.includes('/* ==== FACE-COUNT GUARD (Sections Phase 4) — BEGIN ==== */'), 'guard block present');
  assert.ok(appSrc.includes("await api('/live/lineup')"), 'house go-live fetches the lineup roster');
  assert.ok(appSrc.includes('cpRes.data.house'), 'house branch rides the existing house flag');
  assert.ok(appSrc.includes('cam_label'), 'picker shows lineup labels');
  assert.ok(appSrc.includes("t('lineup_note')") && appSrc.includes("t('lineup_empty')"), 'lineup strings render through t()');
  const start = sliceFn(appSrc, 'async function startLiveBroadcast()', '/* --- Speech safety bot');
  assert.ok(start.includes('startFaceGuard(data.session_id)'), 'guard armed at live start');
  assert.ok(start.includes('data.face_cap'), 'cap taken from the start response');
  const rejoin = sliceFn(appSrc, 'async function rejoinLiveBroadcast(sessionId)', '/* "Who\'s on camera?"');
  assert.ok(rejoin.includes('startFaceGuard(sessionId)'), 'guard re-armed on rejoin');
  assert.ok(rejoin.includes('data.face_cap'), 'cap taken from the rejoin fetch');
  const end = sliceFn(appSrc, 'function endLiveView(msg)', '/* ---------------- PWA install');
  assert.ok(end.includes('stopFaceGuard()'), 'guard stops whenever the live view ends');
  const guard = sliceFn(appSrc, 'FACE-COUNT GUARD (Sections Phase 4) — BEGIN', 'FACE-COUNT GUARD (Sections Phase 4) — END');
  assert.ok(guard.includes("'/vendor/pico.js'") && guard.includes("'/vendor/facefinder-cascade.js'"),
    'detector loads lazily from /vendor at live start — never on page load');
  const outside = appSrc.replace(guard, '');
  assert.equal((outside.match(/startFaceGuard\(/g) || []).length, 2,
    'exactly two call sites arm the guard — live start + rejoin (viewers and 1:1 calls never run it)');
});

test('client i18n: every Phase 4 key exists in all 13 dictionaries', () => {
  for (const key of ['lineup_note', 'lineup_empty', 'faceguard_warn', 'faceguard_cut']) {
    const hits = appSrc.split(`    ${key}:`).length - 1;
    assert.equal(hits, 13, `${key} present in all 13 languages (found ${hits})`);
  }
});

test('vendor: pico detector ships and the embedded cascade decodes + runs', () => {
  const picoSrc = fs.readFileSync(path.join(REPO, 'public/vendor/pico.js'), 'utf8');
  assert.ok(picoSrc.includes('MIT license'), 'pico.js keeps its MIT license header');
  assert.ok(picoSrc.includes('pico.unpack_cascade'), 'detector runtime shipped');
  const cascSrc = fs.readFileSync(path.join(REPO, 'public/vendor/facefinder-cascade.js'), 'utf8');
  const sb = { window: {} };
  vm.createContext(sb);
  vm.runInContext(cascSrc, sb);
  const b64 = sb.window.FACEFINDER_CASCADE_B64;
  assert.equal(typeof b64, 'string', 'cascade embedded as base64 text');
  const bytes = Buffer.from(b64, 'base64');
  assert.equal(bytes.length, 239632, 'decodes to the exact facefinder cascade bytes');
  const sb2 = {};
  vm.createContext(sb2);
  vm.runInContext(picoSrc, sb2);
  const classify = sb2.pico.unpack_cascade(new Int8Array(bytes));
  const W = 320, H = 240;
  const dets = sb2.pico.run_cascade(
    { pixels: new Uint8Array(W * H).fill(128), nrows: H, ncols: W, ldim: W }, classify,
    { shiftfactor: 0.1, minsize: 36, maxsize: H, scalefactor: 1.1 });
  const faces = sb2.pico.cluster_detections(dets, 0.2).filter((d) => d[3] > 20.0);
  assert.equal(faces.length, 0, 'blank frame → zero faces (detector runs, no phantom count)');
});

/* ------------------- guard decision (vm, shipped code) ------------------- */

function loadGuard() {
  const code = sliceFn(appSrc,
    '/* ==== FACE-COUNT GUARD (Sections Phase 4) — BEGIN ==== */',
    '/* ==== FACE-COUNT GUARD (Sections Phase 4) — END ==== */');
  const el = () => ({ style: {}, remove() {}, textContent: '' });
  const sb = {
    console, setInterval, clearInterval,
    window: {},
    document: {
      getElementById: () => null,
      createElement: el,
      head: { appendChild() {} },
      body: { appendChild() {} },
    },
    S: { live: null },
    t: (k) => k,
    endLiveView() {},
  };
  vm.createContext(sb);
  vm.runInContext(code, sb);
  return sb;
}

test('guard state machine: ok → warn → cut only on CONSECUTIVE over-cap samples', () => {
  const { faceGuardStep } = loadGuard();
  const run = (counts, cap) => {
    let st = { over: false };
    return counts.map((c) => {
      const r = faceGuardStep(st, c, cap);
      st = { over: r.over };
      return r.action;
    });
  };
  assert.deepEqual(run([1, 1, 1], 1), ['none', 'none', 'none'], 'at cap the whole way: nothing happens');
  assert.deepEqual(run([0, 1], 1), ['none', 'none'], 'under/at cap is fine');
  assert.deepEqual(run([2], 1), ['warn'], 'a single over-cap sample warns — it must NOT cut');
  assert.deepEqual(run([2, 2], 1), ['warn', 'cut'], 'still over on the next consecutive sample: cut');
  assert.deepEqual(run([2, 1, 2], 1), ['warn', 'clear', 'warn'],
    'an at-cap sample clears the warning, so the next over-cap sample only warns again');
  assert.deepEqual(run([2, 1, 2, 2], 1), ['warn', 'clear', 'warn', 'cut'],
    'after a clear, two fresh consecutive over-cap samples are needed to cut');
  assert.deepEqual(run([3, 3], 3), ['none', 'none'], 'three faces are fine when the cap is 3');
  assert.deepEqual(run([4, 4], 3), ['warn', 'cut'], 'one face over a cap of 3 warns, then cuts');
  assert.deepEqual(run([2, 3, 1], 1), ['warn', 'cut', 'clear'],
    'the decision is per consecutive sample, not per magnitude');
});

test('guard: start is a no-op without a known cap (fails open)', () => {
  const sb = loadGuard();
  const armed = () => vm.runInContext('fgSessionId', sb);
  sb.S.live = { role: 'model', sessionId: 7, faceCap: null };
  sb.startFaceGuard(7); // unknown cap (e.g. server restart) — must not throw or arm
  assert.equal(armed(), null, 'no session armed without a cap');
  sb.S.live = { role: 'fan', sessionId: 7, faceCap: 1 };
  sb.startFaceGuard(7);
  assert.equal(armed(), null, 'the guard never arms for a fan/viewer state');
});

/* --------------------------- functional boot --------------------------- */

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
  const __db = new DatabaseSync(path.join(dir, 'wogent-chat.db'), readOnly ? { readOnly: true } : {});
  __db.exec('PRAGMA busy_timeout = 10000');
  return __db;
}

test('live: house lineup validation, roster endpoint, face_cap values', { timeout: 300000 }, async () => {
  const dir = makeCopy('faceguard');
  let h = null;
  try {
    h = await boot(dir, { SEED_DEMO: '1' });
    const base = h.base;
    const mgrLogin = await req(base, 'POST', '/api/manager/login', { body: { username: 'admin', password: 'admin123' } });
    assert.equal(mgrLogin.status, 200, `manager login: ${mgrLogin.text}`);
    const MGR = { token: mgrLogin.json.token, headers: { 'x-manager': '1' } };

    const signup = async (username, role, extra = {}) => {
      const s = await req(base, 'POST', '/api/auth/signup', {
        body: { username, password: 'hunter22', role, display_name: username,
          dob: '1995-05-05', agree18: true, ...extra },
      });
      assert.equal(s.status, 200, `signup ${username}: ${s.text}`);
      return { token: s.json.token, id: s.json.user.id };
    };
    const verifyOwnId = async (acct) => {
      const up = await upload(base, '/api/model/id-verification', acct.token);
      assert.equal(up.status, 200, `ID upload for verification: ${up.text}`);
      const q = await req(base, 'GET', '/api/admin/id-verifications', { ...MGR });
      const row = q.json.verifications.find((v) => v.model_id === acct.id && !v.co_performer_id);
      assert.ok(row, 'own submission queued');
      const ap = await req(base, 'POST', `/api/admin/id-verifications/${row.id}/approve`, { ...MGR });
      assert.equal(ap.status, 200, `approve: ${ap.text}`);
    };
    const endLive = async (acct, startRes) => {
      const e = await req(base, 'POST', `/api/live/${startRes.json.session_id}/end`, { token: acct.token });
      assert.equal(e.status, 200, `end live: ${e.text}`);
    };

    const house = await signup('asceaaspade', 'model', { section: 'female' });
    const modelA = await signup('fgmodela', 'model', { section: 'female' });
    await verifyOwnId(modelA);
    const modelB = await signup('fgmodelb', 'model', { section: 'female' }); // never verified
    const modelC = await signup('fgmodelc', 'model', { section: 'female' });
    await verifyOwnId(modelC);
    { // ban C after verification — a banned model must drop out of the lineup entirely
      const db = openDb(dir, false);
      db.prepare('UPDATE users SET banned = 1 WHERE id = ?').run(modelC.id);
      db.close();
    }
    const fan = await signup('fgfan', 'fan');

    // --- roster endpoint: house sees exactly the eligible models ---
    const roster = await req(base, 'GET', '/api/live/lineup', { token: house.token });
    assert.equal(roster.status, 200, `house roster: ${roster.text}`);
    const rosterIds = roster.json.models.map((m) => m.id);
    assert.ok(rosterIds.includes(modelA.id), 'verified model is lineup-eligible');
    assert.ok(!rosterIds.includes(modelB.id), 'unverified model is NOT eligible');
    assert.ok(!rosterIds.includes(modelC.id), 'banned model is NOT eligible');
    assert.ok(!rosterIds.includes(house.id), 'the house is never in its own roster');
    assert.ok(!rosterIds.includes(fan.id), 'fans are never in the roster');
    const aRow = roster.json.models.find((m) => m.id === modelA.id);
    assert.equal(aRow.username, 'fgmodela');
    assert.ok('display_name' in aRow && 'photo_url' in aRow, 'picker fields ride along');
    const modelRoster = await req(base, 'GET', '/api/live/lineup', { token: modelA.token });
    assert.equal(modelRoster.status, 403, 'models are refused the lineup endpoint');
    assert.equal(modelRoster.json.error, 'house_only');
    const fanRoster = await req(base, 'GET', '/api/live/lineup', { token: fan.token });
    assert.equal(fanRoster.status, 403, 'fans are refused the lineup endpoint');

    // --- house live/start: the lineup rule ---
    const badUnverified = await req(base, 'POST', '/api/live/start', { token: house.token,
      body: { title: 'House', participants: [house.id, modelB.id] } });
    assert.equal(badUnverified.status, 403, 'unverified roster model refused');
    assert.equal(badUnverified.json.error, 'unapproved_participants');
    const badFan = await req(base, 'POST', '/api/live/start', { token: house.token,
      body: { title: 'House', participants: [house.id, fan.id] } });
    assert.equal(badFan.status, 403, 'a fan id refused');
    assert.equal(badFan.json.error, 'unapproved_participants');
    const badBanned = await req(base, 'POST', '/api/live/start', { token: house.token,
      body: { title: 'House', participants: [house.id, modelC.id] } });
    assert.equal(badBanned.status, 403, 'a banned model refused');
    assert.equal(badBanned.json.error, 'unapproved_participants');
    const badGhost = await req(base, 'POST', '/api/live/start', { token: house.token,
      body: { title: 'House', participants: [house.id, 999999] } });
    assert.equal(badGhost.status, 403, 'a nonexistent id refused');

    // the house declaring ITSELF as lineup: filtered, never counted twice
    const selfLineup = await req(base, 'POST', '/api/live/start', { token: house.token,
      body: { title: 'House', participants: [house.id, house.id, modelA.id] } });
    assert.equal(selfLineup.status, 200, `self in the declared list is harmless: ${selfLineup.text}`);
    assert.equal(selfLineup.json.face_cap, 2, 'cap = house + A only — the house never counts itself twice');
    await endLive(house, selfLineup);

    // house + 2 lineup → cap 3 (a second verified model joins the roster)
    const modelD = await signup('fgmodeld', 'model', { section: 'female' });
    await verifyOwnId(modelD);
    const houseTrio = await req(base, 'POST', '/api/live/start', { token: house.token,
      body: { title: 'SlutCamp Live', participants: [house.id, modelA.id, modelD.id] } });
    assert.equal(houseTrio.status, 200, `house + 2 lineup goes live: ${houseTrio.text}`);
    assert.equal(houseTrio.json.face_cap, 3, 'house + 2 lineup = face cap 3');
    const rejoinRead = await req(base, 'GET', `/api/live/${houseTrio.json.session_id}`, { token: house.token });
    assert.equal(rejoinRead.status, 200);
    assert.equal(rejoinRead.json.face_cap, 3, 'rejoin fetch reads the same cap back');
    await endLive(house, houseTrio);

    // solo house live (Phase 3 shape) still works, cap 1
    const houseSolo = await req(base, 'POST', '/api/live/start', { token: house.token,
      body: { title: 'House solo', participants: [house.id] } });
    assert.equal(houseSolo.status, 200);
    assert.equal(houseSolo.json.face_cap, 1, 'solo house live = cap 1');
    await endLive(house, houseSolo);

    // --- non-house caps + the model path is unchanged ---
    const modelSolo = await req(base, 'POST', '/api/live/start', { token: modelA.token, body: { title: 'A solo' } });
    assert.equal(modelSolo.status, 200, `verified model solo live: ${modelSolo.text}`);
    assert.equal(modelSolo.json.face_cap, 1, 'solo model = face cap 1');
    await endLive(modelA, modelSolo);

    // a model may NOT borrow the lineup: a verified roster model who
    // is not her approved co-performer is still refused (Phase 2 rule)
    const borrow = await req(base, 'POST', '/api/live/start', { token: modelA.token,
      body: { title: 'A + D?', participants: [modelA.id, modelD.id] } });
    assert.equal(borrow.status, 403, 'models cannot declare roster models — co-performers only');
    assert.equal(borrow.json.error, 'unapproved_participants');

    // model + 2 approved co-performers → cap 3
    const addPartner = async (owner, name) => {
      const added = await req(base, 'POST', '/api/model/co-performers', { token: owner.token,
        body: { display_name: name, gender: 'female', dob: '1992-02-02', agree18: true } });
      assert.equal(added.status, 200, `add partner: ${added.text}`);
      const pid = added.json.co_performer.id;
      const up = await upload(base, `/api/model/co-performers/${pid}/id-verification`, owner.token);
      assert.equal(up.status, 200, `partner ID upload: ${up.text}`);
      const q = await req(base, 'GET', '/api/admin/id-verifications', { ...MGR });
      const row = q.json.verifications.find((v) => v.co_performer_id === pid);
      assert.ok(row, 'partner submission queued');
      const ap = await req(base, 'POST', `/api/admin/id-verifications/${row.id}/approve`, { ...MGR });
      assert.equal(ap.status, 200, `approve partner: ${ap.text}`);
      return pid;
    };
    const p1 = await addPartner(modelD, 'Partner One');
    const p2 = await addPartner(modelD, 'Partner Two');
    const trio = await req(base, 'POST', '/api/live/start', { token: modelD.token,
      body: { title: 'D trio', participants: [modelD.id, p1, p2] } });
    assert.equal(trio.status, 200, `model + 2 approved partners goes live: ${trio.text}`);
    assert.equal(trio.json.face_cap, 3, 'model + 2 approved co-performers = face cap 3');
    await endLive(modelD, trio);
  } finally {
    stop(h);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
