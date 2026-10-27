'use strict';
/*
 * Sections Phase 2 — co-performers + couple accounts (owner design,
 * Oct 18 2026; Model Agreement v1.5 §15 states the rule in prose:
 * only the account holder + ID-verified co-performers on camera).
 *
 * What this pins:
 *  - Schema: co_performers table; id_verifications gains
 *    co_performer_id and its one-own-row rule becomes a PARTIAL
 *    unique index (partner rows share model_id = the owner); the
 *    guarded rebuild migration for pre-Phase-2 databases; models
 *    coperf_* attestation columns.
 *  - Couple signup: declaring section=couple WITH partner data
 *    creates exactly ONE pending co_performers row and stamps the
 *    attestation; a couple signup WITHOUT partner data still
 *    succeeds and creates none (signup is never blocked).
 *  - Settings CRUD is owner-only: another model can't see or touch
 *    the rows (404), fans are refused outright; an APPROVED row
 *    refuses PATCH (delete-only) but DELETE works.
 *  - Partner ID verification rides the model's own machinery: the
 *    upload lands in the Manager 🪪 queue labeled as a partner
 *    (is_partner, partner's name, owner's @username); approve/reject
 *    flips BOTH rows atomically.
 *  - A partner's approval never verifies the OWNER (isIdVerified
 *    reads only the co_performer_id IS NULL row) — the live gate
 *    still refuses her until her OWN ID is approved.
 *  - Camera rule at POST /api/live/start: declared participants
 *    must be ⊆ cameraAllowedIds (403 unapproved_participants for a
 *    pending partner / a stranger id), approved partners pass, solo
 *    is unchanged, and the house account is exempt as everywhere
 *    (its allowed set is just itself).
 *  - Client: Settings 👥 card (hidden for the house via the server
 *    flag), the go-live "Who's on camera?" checklist feeding
 *    participants, the couple-signup partner block, the Manager
 *    partner label — all coperf_* strings in all 13 languages.
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
const appSrc = fs.readFileSync(path.join(REPO, 'public/js/app.js'), 'utf8');
const serverSrc = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
const managerSrc = fs.readFileSync(path.join(REPO, 'public/manager/manager.js'), 'utf8');

function sliceFn(src, startMarker, endMarker) {
  const s = src.indexOf(startMarker);
  const e = src.indexOf(endMarker, s);
  assert.ok(s !== -1 && e > s, `located ${startMarker} … ${endMarker}`);
  return src.slice(s, e);
}

/* --------------------------- static pins --------------------------- */

test('schema: co_performers table + id_verifications partner shape', () => {
  assert.ok(serverSrc.includes('CREATE TABLE IF NOT EXISTS co_performers'), 'co_performers table created');
  assert.ok(serverSrc.includes('owner_model_id INTEGER NOT NULL REFERENCES users(id)'), 'partner row owned by the model');
  assert.ok(serverSrc.includes("status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected'))"),
    'partner status lifecycle matches id_verifications');
  assert.ok(serverSrc.includes('co_performer_id INTEGER REFERENCES co_performers(id)'),
    'id_verifications carries the partner link');
  assert.ok(serverSrc.includes('ON id_verifications(model_id) WHERE co_performer_id IS NULL'),
    'one-own-row rule survives as a partial unique index');
  assert.ok(!/model_id INTEGER NOT NULL UNIQUE REFERENCES users\(id\),\n  co_performer_id/.test(serverSrc),
    'the old blanket UNIQUE on model_id is gone');
  assert.ok(serverSrc.includes("addColumnIfMissing('models', 'coperf_attested_at', 'TEXT')"), 'attestation stamp column');
  assert.ok(serverSrc.includes("addColumnIfMissing('models', 'coperf_attested_ip', 'TEXT')"), 'attestation ip column');
});

test('schema: the partner rebuild migration is guarded on the old DDL', () => {
  const mig = sliceFn(serverSrc, 'One-time migration (Sections Phase 2)', 'One-time migration (Oct 15, 2026)');
  assert.ok(mig.includes("model_id\\s+INTEGER\\s+NOT\\s+NULL\\s+UNIQUE"), 'guard reads the stored DDL for the old UNIQUE shape');
  assert.ok(mig.includes('INSERT INTO id_verifications_partner'), 'existing rows copied verbatim');
  assert.ok(mig.includes('RENAME TO id_verifications'), 'rebuilt table takes the name');
});

test('server: isIdVerified reads only her OWN verification row', () => {
  const fn = sliceFn(serverSrc, 'function isIdVerified', '\n}');
  assert.ok(fn.includes('AND co_performer_id IS NULL'),
    "a partner's approval can never mark the owner verified");
});

test('server: cameraAllowedIds — house is itself, partners must be approved', () => {
  const fn = sliceFn(serverSrc, 'function cameraAllowedIds', '\n}');
  assert.ok(fn.includes('isHouseAccountId(modelUserId)'), 'house short-circuit');
  assert.ok(fn.includes("status = 'approved'"), 'only APPROVED partners are on camera');
  assert.ok(fn.includes('isIdVerified(modelUserId)'), 'her own id rides on her own approval');
});

test('server: live/start enforces declared participants AFTER her own ID gate', () => {
  const route = sliceFn(serverSrc, "app.post('/api/live/start'", "app.post('/api/live/:id/leave'");
  const own = route.indexOf("error: 'id_verification_required'");
  const parts = route.indexOf("error: 'unapproved_participants'");
  assert.ok(own > -1 && parts > own, 'her own approval is checked first; the subset rule follows');
  assert.ok(route.includes('cameraAllowedIds(req.user.id)'), 'the subset is cameraAllowedIds');
  assert.ok(route.includes('res.status(403)'), 'refusal is a 403');
});

test('server: Settings API is model-only and approval freezes a row', () => {
  for (const m of ["app.get('/api/model/co-performers'", "app.post('/api/model/co-performers'",
    "app.patch('/api/model/co-performers/:id'", "app.delete('/api/model/co-performers/:id'",
    "app.post('/api/model/co-performers/:id/id-verification'"]) {
    assert.ok(serverSrc.includes(m), `route exists: ${m}`);
  }
  const patch = sliceFn(serverSrc, "app.patch('/api/model/co-performers/:id'", '\n});');
  assert.ok(patch.includes("error: 'approved_readonly'"), 'approved rows refuse PATCH (delete-only)');
  const list = sliceFn(serverSrc, "app.get('/api/admin/id-verifications'", '\n});');
  assert.ok(list.includes('LEFT JOIN co_performers'), 'Manager queue joins partner rows in');
  assert.ok(list.includes('is_partner'), 'queue rows are flagged as partner submissions');
  const approve = sliceFn(serverSrc, "app.post('/api/admin/id-verifications/:id/approve'", '\n});');
  assert.ok(approve.includes('txn(() =>'), 'approve flips both rows in one transaction');
  assert.ok(approve.includes("UPDATE co_performers SET status = 'approved'"), 'approve flips the partner row');
  const reject = sliceFn(serverSrc, "app.post('/api/admin/id-verifications/:id/reject'", '\n});');
  assert.ok(reject.includes("UPDATE co_performers SET status = 'rejected'"), 'reject flips the partner row');
});

test('client: Settings card, go-live checklist, signup block, manager label', () => {
  assert.ok(appSrc.includes("id=\"coperf-card\""), 'Settings carries the co-performers card mount');
  assert.ok(appSrc.includes('renderCoPerfCard()'), 'the card is rendered on Settings');
  assert.ok(appSrc.includes('data.house'), 'the house account hides the card off the server flag');
  assert.ok(appSrc.includes("t('coperf_h')"), 'card title renders through t()');
  assert.ok(appSrc.includes('pickLiveParticipants'), 'go-live checklist exists');
  assert.ok(appSrc.includes('participants'), 'the picked set is sent to /live/start');
  assert.ok(appSrc.includes("data.error === 'unapproved_participants'"), 'the 403 is surfaced to her');
  assert.ok(appSrc.includes("t('coperf_signup_h')"), 'couple signup shows the partner block');
  assert.ok(appSrc.includes('partner_name'), 'signup posts the partner fields');
  assert.ok(managerSrc.includes('👥 Co-performer'), 'Manager queue labels partner submissions');
  assert.ok(managerSrc.includes('r.is_partner'), 'the label rides the is_partner flag');
});

test('client i18n: every coperf_* key exists in all 13 dictionaries', () => {
  for (const key of ['coperf_h', 'coperf_note', 'coperf_consent', 'coperf_cam_h',
    'coperf_cam_go', 'coperf_signup_note', 'coperf_st_approved', 'coperf_id_note']) {
    const hits = appSrc.split(`    ${key}:`).length - 1;
    assert.equal(hits, 13, `${key} present in all 13 languages (found ${hits})`);
  }
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

test('live: couple signup, owner-only CRUD, partner ID queue, camera rule, house exemption', { timeout: 300000 }, async () => {
  const dir = makeCopy('coperf');
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
          dob: '1995-05-05', agree18: true,
          ...(role === 'model' ? { publicity_consent: true } : {}), ...extra },
      });
      assert.equal(s.status, 200, `signup ${username}: ${s.text}`);
      return { token: s.json.token, id: s.json.user.id };
    };

    // --- couple signup WITH partner data → exactly one pending row ---
    const duo = await signup('coperfduo', 'model', { section: 'couple',
      partner_name: 'Pat Partner', partner_gender: 'male', partner_dob: '1993-03-04', partner_agree18: true });
    const duoList = await req(base, 'GET', '/api/model/co-performers', { token: duo.token });
    assert.equal(duoList.status, 200);
    assert.equal(duoList.json.house, false);
    assert.equal(duoList.json.co_performers.length, 1, 'exactly one partner row from the couple signup');
    const pat = duoList.json.co_performers[0];
    assert.equal(pat.display_name, 'Pat Partner');
    assert.equal(pat.gender, 'male');
    assert.equal(pat.dob, '1993-03-04');
    assert.equal(pat.status, 'pending');
    assert.equal(pat.verification_status, null, 'no ID submitted yet');
    {
      const db = openDb(dir);
      const m = db.prepare('SELECT coperf_attested_at FROM models WHERE user_id = ?').get(duo.id);
      assert.ok(m.coperf_attested_at, 'her partner 18+ attestation is stamped on the models row');
      db.close();
    }

    // --- couple signup WITHOUT partner data → succeeds, no row ---
    const solo2 = await signup('coperfsolo', 'model', { section: 'couple' });
    const solo2List = await req(base, 'GET', '/api/model/co-performers', { token: solo2.token });
    assert.equal(solo2List.json.co_performers.length, 0, 'no partner data → no row, signup unblocked');

    // --- Settings POST: consent + adulthood enforced ---
    const noConsent = await req(base, 'POST', '/api/model/co-performers', { token: solo2.token,
      body: { display_name: 'No Consent' } });
    assert.equal(noConsent.status, 400);
    assert.equal(noConsent.json.error, 'partner_must_be_18');
    const kid = await req(base, 'POST', '/api/model/co-performers', { token: solo2.token,
      body: { display_name: 'Too Young', dob: '2015-01-01', agree18: true } });
    assert.equal(kid.status, 400, `underage partner refused: ${kid.text}`);
    assert.equal(kid.json.error, 'partner_must_be_18');
    const added = await req(base, 'POST', '/api/model/co-performers', { token: solo2.token,
      body: { display_name: 'Second Partner', gender: 'female', dob: '1990-06-07', agree18: true } });
    assert.equal(added.status, 200, `add partner: ${added.text}`);
    const second = added.json.co_performer;
    assert.equal(second.status, 'pending');

    // --- owner-only: the other model sees nothing, touches nothing ---
    const duoSees = await req(base, 'GET', '/api/model/co-performers', { token: duo.token });
    assert.ok(!duoSees.json.co_performers.some((p) => p.id === second.id), "duo's list excludes solo's partner");
    const crossPatch = await req(base, 'PATCH', `/api/model/co-performers/${second.id}`,
      { token: duo.token, body: { display_name: 'Hijacked' } });
    assert.equal(crossPatch.status, 404, 'PATCH on another model’s partner → 404');
    const crossDel = await req(base, 'DELETE', `/api/model/co-performers/${second.id}`, { token: duo.token });
    assert.equal(crossDel.status, 404, 'DELETE on another model’s partner → 404');
    const crossUpload = await upload(base, `/api/model/co-performers/${second.id}/id-verification`, duo.token);
    assert.equal(crossUpload.status, 404, 'ID upload on another model’s partner → 404');
    const fan = await signup('coperffan', 'fan');
    const fanList = await req(base, 'GET', '/api/model/co-performers', { token: fan.token });
    assert.equal(fanList.status, 403, 'fans are refused the model API outright');

    // --- PATCH her own pending row ---
    const patched = await req(base, 'PATCH', `/api/model/co-performers/${second.id}`,
      { token: solo2.token, body: { display_name: 'Renamed Partner' } });
    assert.equal(patched.status, 200, `patch own: ${patched.text}`);
    assert.equal(patched.json.co_performer.display_name, 'Renamed Partner');

    // --- partner ID upload → Manager queue, labeled as a partner ---
    const upBad = await upload(base, `/api/model/co-performers/${pat.id}/id-verification`, duo.token, ['id_front']);
    assert.equal(upBad.status, 400, 'missing photos refused');
    assert.equal(upBad.json.error, 'missing_files');
    const up = await upload(base, `/api/model/co-performers/${pat.id}/id-verification`, duo.token);
    assert.equal(up.status, 200, `partner ID upload: ${up.text}`);
    const queue = await req(base, 'GET', '/api/admin/id-verifications', { ...MGR });
    assert.equal(queue.status, 200, `admin queue: ${queue.text}`);
    const prow = queue.json.verifications.find((v) => v.co_performer_id === pat.id);
    assert.ok(prow, 'the partner submission is in the Manager queue');
    assert.equal(prow.is_partner, 1);
    assert.equal(prow.display_name, 'Pat Partner', 'queue shows the PARTNER’s name');
    assert.equal(prow.username, 'coperfduo', 'queue shows the OWNER’s @username');
    assert.equal(prow.status, 'pending');

    // --- approving the PARTNER does not verify the OWNER ---
    const apPartner = await req(base, 'POST', `/api/admin/id-verifications/${prow.id}/approve`, { ...MGR });
    assert.equal(apPartner.status, 200, `approve partner: ${apPartner.text}`);
    {
      const db = openDb(dir);
      const cp = db.prepare('SELECT status FROM co_performers WHERE id = ?').get(pat.id);
      const vv = db.prepare('SELECT status FROM id_verifications WHERE id = ?').get(prow.id);
      assert.equal(cp.status, 'approved', 'co_performers row flipped with the verification');
      assert.equal(vv.status, 'approved', 'verification row flipped');
      db.close();
    }
    const duoLiveEarly = await req(base, 'POST', '/api/live/start', { token: duo.token, body: { title: 'x' } });
    assert.equal(duoLiveEarly.status, 403, 'owner still gated by her OWN unverified ID');
    assert.equal(duoLiveEarly.json.error, 'id_verification_required');

    // --- approved row: PATCH refuses, the camera rule still applies ---
    const frozen = await req(base, 'PATCH', `/api/model/co-performers/${pat.id}`,
      { token: duo.token, body: { display_name: 'New Name' } });
    assert.equal(frozen.status, 403);
    assert.equal(frozen.json.error, 'approved_readonly');

    // --- reject path flips both rows too (second partner) ---
    const up2 = await upload(base, `/api/model/co-performers/${second.id}/id-verification`, solo2.token);
    assert.equal(up2.status, 200, `second partner upload: ${up2.text}`);
    const queue2 = await req(base, 'GET', '/api/admin/id-verifications', { ...MGR });
    const prow2 = queue2.json.verifications.find((v) => v.co_performer_id === second.id);
    assert.ok(prow2, 'second partner submission queued');
    const rej = await req(base, 'POST', `/api/admin/id-verifications/${prow2.id}/reject`,
      { ...MGR, body: { note: 'Blurry ID — resubmit.' } });
    assert.equal(rej.status, 200);
    {
      const db = openDb(dir);
      assert.equal(db.prepare('SELECT status FROM co_performers WHERE id = ?').get(second.id).status, 'rejected',
        'reject flips the partner row');
      assert.equal(db.prepare('SELECT status FROM id_verifications WHERE id = ?').get(prow2.id).status, 'rejected',
        'reject flips the verification row');
      db.close();
    }
    // a rejected partner corrected in Settings goes back to pending
    const rePatch = await req(base, 'PATCH', `/api/model/co-performers/${second.id}`,
      { token: solo2.token, body: { display_name: 'Renamed Again' } });
    assert.equal(rePatch.status, 200);
    assert.equal(rePatch.json.co_performer.status, 'pending', 'editing a rejected partner re-queues the row');

    // --- owner verifies her OWN ID; camera rule at live/start ---
    const ownUp = await upload(base, '/api/model/id-verification', duo.token);
    assert.equal(ownUp.status, 200, `owner ID upload: ${ownUp.text}`);
    const queue3 = await req(base, 'GET', '/api/admin/id-verifications', { ...MGR });
    const ownRow = queue3.json.verifications.find((v) => v.model_id === duo.id && !v.co_performer_id);
    assert.ok(ownRow, 'her own submission is a separate, non-partner queue row');
    assert.equal(ownRow.is_partner, 0);
    // PR #86: her own packet cannot be approved until her WOGENT
    // release is on file — she signs it first, like a real model.
    const sign = await req(base, 'POST', '/api/model/release/sign', { token: duo.token, body: {
      legal_name: 'Test Signer', stage_name: 'coperfduo', dob: '1995-05-05',
      attestations: { adult: true, freewill: true, rights: true } } });
    assert.equal(sign.status, 200, `release sign: ${sign.text}`);
    const apOwn = await req(base, 'POST', `/api/admin/id-verifications/${ownRow.id}/approve`, { ...MGR });
    assert.equal(apOwn.status, 200);

    const badParts = await req(base, 'POST', '/api/live/start', { token: duo.token,
      body: { title: 'x', participants: [second.id] } });
    assert.equal(badParts.status, 403, 'a non-approved partner id is refused');
    assert.equal(badParts.json.error, 'unapproved_participants');
    const stranger = await req(base, 'POST', '/api/live/start', { token: duo.token,
      body: { title: 'x', participants: [999999] } });
    assert.equal(stranger.status, 403);
    assert.equal(stranger.json.error, 'unapproved_participants');

    const goodParts = await req(base, 'POST', '/api/live/start', { token: duo.token,
      body: { title: 'Duo night', participants: [duo.id, pat.id] } });
    assert.equal(goodParts.status, 200, `approved set goes live: ${goodParts.text}`);
    const endLive = await req(base, 'POST', `/api/live/${goodParts.json.session_id}/end`, { token: duo.token });
    assert.equal(endLive.status, 200, `end live: ${endLive.text}`);
    const soloLive = await req(base, 'POST', '/api/live/start', { token: duo.token, body: { title: 'Solo' } });
    assert.equal(soloLive.status, 200, 'no declared list = solo, unchanged');
    await req(base, 'POST', `/api/live/${soloLive.json.session_id}/end`, { token: duo.token });

    // --- DELETE works on the approved row (delete-only ≠ undeletable) ---
    const del = await req(base, 'DELETE', `/api/model/co-performers/${pat.id}`, { token: duo.token });
    assert.equal(del.status, 200, `delete approved partner: ${del.text}`);
    const after = await req(base, 'GET', '/api/model/co-performers', { token: duo.token });
    assert.equal(after.json.co_performers.length, 0, 'the row is gone');
    {
      const db = openDb(dir);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM id_verifications WHERE co_performer_id = ?').get(pat.id).n, 0,
        'her verification row went with her');
      db.close();
    }

    // --- house exemption: flag hides the card, allowed set is itself ---
    const house = await signup('asceaaspade', 'model', { section: 'female' });
    const houseList = await req(base, 'GET', '/api/model/co-performers', { token: house.token });
    assert.equal(houseList.json.house, true, 'house flag set — Settings hides the card');
    assert.deepEqual(houseList.json.camera_allowed_ids, [house.id], 'house camera set is just itself');
    const houseLive = await req(base, 'POST', '/api/live/start', { token: house.token,
      body: { title: 'House live', participants: [house.id] } });
    assert.equal(houseLive.status, 200, `house goes live with no ID row at all: ${houseLive.text}`);
    await req(base, 'POST', `/api/live/${houseLive.json.session_id}/end`, { token: house.token });
  } finally {
    stop(h);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
