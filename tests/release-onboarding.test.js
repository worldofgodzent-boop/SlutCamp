'use strict';
/*
 * RELEASE IN ONBOARDING (Asce approved Oct 22 2026: "Fold it into
 * model onboarding"). The WOGENT house performer release — site-
 * neutral, rights to World Of Godz Entertainment LLC (the Producer),
 * never to a platform — joins the model's ID packet. This suite pins:
 *
 *  - Packet completeness: an own packet is ID front + ID back +
 *    selfie holding ID + the signed release. The Manager's approve
 *    action 409s (release_missing) while no release is on file, so a
 *    new model's packet CANNOT complete — and every gate the packet
 *    drives (live, cash-out, media) stays shut — without it.
 *  - E-sign: attestations (18+ / free will / rights grant) all
 *    required, typed legal name + stage name + DOB stored with the
 *    timestamp AND the exact text version signed (R1.0). A DOB that
 *    reads under 18 is refused. Paper upload satisfies the same slot.
 *  - The record lives in its OWN table (model_releases): contract_
 *    signatures is poison for an 'R%' version (recruiter readers
 *    select LIKE 'R%'), and a static pin keeps it out of there.
 *  - Backfill without chaos: a model approved BEFORE this build
 *    (status written directly, the pre-build state) keeps her
 *    approval and media untouched; she signs when prompted and the
 *    Manager flag flips. Nothing ever rewrites her status.
 *  - Manager ID Checks shows the release per own row (signed record /
 *    paper on file with a tokened view / MISSING) and the 2257 packet
 *    carries the release record. Partner rows keep the PR #83 rule.
 *  - House exempt (it is the producer). Fans/affiliates never reach
 *    the model-only release endpoints.
 *  - Migration: a database with the PREVIOUS schema (no
 *    model_releases table at all) boots clean and gains the table.
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
const serverSrc = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(REPO, 'public/js/app.js'), 'utf8');
const mgrSrc = fs.readFileSync(path.join(REPO, 'public/manager/manager.js'), 'utf8');

function sliceFn(src, startMarker, endMarker) {
  const s = src.indexOf(startMarker);
  const e = src.indexOf(endMarker, s);
  assert.ok(s !== -1 && e > s, `located ${startMarker} … ${endMarker}`);
  return src.slice(s, e);
}

/* --------------------------- static pins --------------------------- */

test('server: schema — model_releases is its own additive table', () => {
  assert.ok(serverSrc.includes('CREATE TABLE IF NOT EXISTS model_releases'),
    'release records table created if missing (boot-safe on lived-in DBs)');
  assert.ok(serverSrc.includes("method TEXT NOT NULL CHECK(method IN ('esign','paper','clickwrap'))"),
    'three record methods: in-app e-sign, paper upload, or the sign-at-the-door click-agree (Release Prompt)');
  assert.ok(serverSrc.includes('model_id INTEGER NOT NULL UNIQUE REFERENCES users(id)'),
    'one current release record per model');
  const sign = sliceFn(serverSrc, "app.post('/api/model/release/sign'", "// Model: upload a signed PAPER copy");
  assert.ok(!sign.includes('contract_signatures'),
    'the release NEVER writes contract_signatures (an R% version would poison the recruiter signature readers)');
});

test('server: release text — site-neutral, Producer-held, versioned R1.0', () => {
  assert.ok(serverSrc.includes("const RELEASE_VERSION = 'R1.0';"), 'the text is versioned');
  const doc = sliceFn(serverSrc, 'const WOGENT_RELEASE = {', '/* Recruiter agreement');
  assert.ok(doc.includes('World Of Godz Entertainment LLC (the "Producer")'),
    'rights run to the LLC as Producer');
  assert.ok(doc.includes('on ANY website, platform, or medium'), 'site-neutral grant');
  assert.ok(!/7890735|7890628|AsceAASpadeWOG|ManyVids/.test(doc),
    'no platform, video ID, or uploader account leaks into the onboarding text');
});

test('server: packet completeness + house exemption live next to isIdVerified', () => {
  assert.ok(serverSrc.includes('function releaseOnFile(modelUserId)'), 'the slot check exists');
  const rof = sliceFn(serverSrc, 'function releaseOnFile(modelUserId)', '// Her whole own packet');
  assert.ok(rof.includes('if (isHouseAccountId(modelUserId)) return true;'),
    'house exempt — it is the producer the rights are granted TO');
  const opc = sliceFn(serverSrc, 'function ownPacketComplete(modelUserId)', '// The client/Manager-safe shape');
  assert.ok(opc.includes('id_front_path && v.id_back_path && v.selfie_path') && opc.includes('releaseOnFile(modelUserId)'),
    'packet = 3 ID documents AND the release');
});

test('server: the approve action refuses an own packet with no release on file', () => {
  const approve = sliceFn(serverSrc, "app.post('/api/admin/id-verifications/:id/approve'", "// Admin: reject an ID verification");
  assert.ok(approve.includes("if (!v.co_performer_id && !releaseOnFile(v.model_id))"),
    'own rows only — partner packets keep the PR #83 consent rule');
  assert.ok(approve.includes("error: 'release_missing'"), 'the refusal is a named 409');
  assert.ok(approve.indexOf("error: 'release_missing'") < approve.indexOf('txn(() =>'),
    'the refusal fires BEFORE any status write');
});

test('server: e-sign validates attestations, legal name, and an adult DOB', () => {
  const sign = sliceFn(serverSrc, "app.post('/api/model/release/sign'", "// Model: upload a signed PAPER copy");
  assert.ok(sign.includes("error: 'attestations_required'"), 'all three attestations required');
  assert.ok(sign.includes('!at.adult || !at.freewill || !at.rights'), '18+ / free will / rights grant');
  assert.ok(sign.includes("error: 'underage'"), 'a DOB that reads under 18 is refused');
  assert.ok(sign.includes('WOGENT_RELEASE.version'), 'the record pins the exact text version signed');
  assert.ok(sign.includes("method = 'esign'") || sign.includes("'esign'"), 'stored as an e-sign record');
  const paper = sliceFn(serverSrc, "app.post('/api/model/release/paper'", '// Admin: list all ID verifications');
  assert.ok(paper.includes("releaseUpload.single('release')"), 'paper copy rides the private-storage upload');
  assert.ok(paper.includes("'paper'"), 'stored as a paper record in the same slot');
});

test('server: Manager surfaces carry the release (queue, photo endpoint, 2257 packet)', () => {
  const list = sliceFn(serverSrc, "app.get('/api/admin/id-verifications',", '// Short-lived photo tokens');
  assert.ok(list.includes('LEFT JOIN model_releases mr'), 'the queue joins the release record');
  assert.ok(list.includes('release_on_file'), 'the queue flags release on file per own row');
  const photo = sliceFn(serverSrc, "app.get('/api/admin/id-verifications/:id/photo/:which'", '// Admin: approve an ID verification');
  assert.ok(photo.includes("'front', 'back', 'selfie', 'consent', 'release'"), 'the tokened endpoint serves the paper release');
  const packet = sliceFn(serverSrc, "app.get('/api/admin/id-verifications/:id/2257',", 'if (v.co_performer_id)');
  assert.ok(packet.includes('release: rel ? {'), 'the 2257 packet carries the release record');
});

test('client: the release card + one-time banner are wired in model Settings', () => {
  assert.ok(appSrc.includes('async function wireReleaseCard()'), 'the card wiring exists');
  assert.ok(appSrc.includes("api('/model/release')"), 'the document loads from the server (single source of text)');
  assert.ok(appSrc.includes("api('/model/release/sign'"), 'the e-sign posts to the sign endpoint');
  assert.ok(appSrc.includes("fetch('/api/model/release/paper'"), 'the paper copy posts to the paper endpoint');
  assert.ok(appSrc.includes("localStorage.getItem('release_prompt_dismissed_'"), 'the approved-model prompt is one-time/dismissible');
  assert.ok(appSrc.includes('releaseBannerHTML'), 'the banner renders for approved-but-unsigned models');
  for (const k of ['release_h', 'release_summary', 'release_intro', 'release_attest_age',
                   'release_attest_freewill', 'release_attest_rights', 'release_legal_name',
                   'release_sign_btn', 'release_signed_h', 'release_signed_sub',
                   'release_paper_h', 'release_paper_btn', 'release_missing',
                   'release_banner', 'release_dismiss']) {
    const hits = appSrc.match(new RegExp(`${k}: '`, 'g')) || [];
    assert.equal(hits.length, 13, `${k} present once per language`);
  }
});

test('manager: ID Checks renders the release state for own rows', () => {
  assert.ok(mgrSrc.includes('releaseLine'), 'the queue renders a release line');
  assert.ok(mgrSrc.includes('/photo/release?t='), 'the signed paper copy opens through the tokened endpoint');
  assert.ok(mgrSrc.includes('Signed record'), 'the reviewer can open the signed record');
  assert.ok(mgrSrc.includes('release_on_file'), 'decided rows flag release on file yes/no');
  assert.ok(mgrSrc.includes('data.message'), 'an approve refusal surfaces the server message (release_missing)');
});

test('recount: the announcement thread-tap pin reads exactly 31 after the Release Prompt build (its announcement added one)', () => {
  assert.equal(serverSrc.split('/#chat/${conv.id}').length - 1, 31);
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
function openDb(dir, readOnly = true) {
  const __db = new DatabaseSync(path.join(dir, 'wogent-chat.db'), readOnly ? { readOnly: true } : {});
  __db.exec('PRAGMA busy_timeout = 10000');
  return __db;
}

const PNG = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001080600000'
  + '01bc2f5d0000000d49444154789c6360000000020001e221bc330000000049454e44ae426082', 'hex');
const FAKE_PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');

async function uploadRaw(base, p, token, fd) {
  const headers = {};
  if (token) headers.authorization = 'Bearer ' + token;
  const r = await fetch(base + p, { method: 'POST', headers, body: fd });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
  return { status: r.status, text, json };
}
function idDocsUpload(base, token) {
  const fd = new FormData();
  for (const f of ['id_front', 'id_back', 'selfie'])
    fd.append(f, new Blob([PNG], { type: 'image/png' }), `${f}.png`);
  return uploadRaw(base, '/api/model/id-verification', token, fd);
}

test('live: packet cannot complete without the release; e-sign + paper both satisfy it', { timeout: 300000 }, async () => {
  const dir = makeCopy('release');
  let h = null;
  try {
    h = await boot(dir, { SEED_DEMO: '1' });
    const base = h.base;

    const mgrLogin = await req(base, 'POST', '/api/manager/login', { body: { username: 'admin', password: 'admin123' } });
    assert.equal(mgrLogin.status, 200, `manager login: ${mgrLogin.text}`);
    const MGR = { token: mgrLogin.json.token, headers: { 'x-manager': '1' } };
    const adminApi = (method, p, opts = {}) => req(base, method, p, { ...opts, token: MGR.token, headers: MGR.headers });

    const signup = async (username, role) => {
      const s = await req(base, 'POST', '/api/auth/signup', {
        body: { username, password: 'hunter22', role, display_name: username,
          dob: '1995-05-05', agree18: true, ...(role === 'model' ? { section: 'female' } : {}) },
      });
      assert.equal(s.status, 200, `signup ${username}: ${s.text}`);
      return { token: s.json.token, id: s.json.user.id };
    };
    const modelA = await signup('relmodel', 'model');
    const modelB = await signup('relpaper', 'model');
    const fan = await signup('relfan', 'fan');

    /* Fans never reach the release flow (model-only endpoints). */
    const fanPeek = await req(base, 'GET', '/api/model/release', { token: fan.token });
    assert.equal(fanPeek.status, 403, `fan release read refused: ${fanPeek.text}`);
    const fanSign = await req(base, 'POST', '/api/model/release/sign', { token: fan.token, body: {} });
    assert.equal(fanSign.status, 403, 'fan sign refused');

    /* The document: versioned, English, unsigned state. */
    const doc = await req(base, 'GET', '/api/model/release', { token: modelA.token });
    assert.equal(doc.status, 200, `release doc: ${doc.text}`);
    assert.equal(doc.json.version, 'R1.0');
    assert.ok(doc.json.sections.length >= 7, 'the full document is served');
    assert.equal(doc.json.signed, false);
    assert.equal(doc.json.release, null);

    /* Her packet starts incomplete. */
    const st0 = await req(base, 'GET', '/api/model/id-verification', { token: modelA.token });
    assert.equal(st0.json.packet_complete, false);
    assert.equal(st0.json.release, null);

    /* ID docs alone do NOT complete the packet… */
    const up = await idDocsUpload(base, modelA.token);
    assert.equal(up.status, 200, `ID upload: ${up.text}`);
    const st1 = await req(base, 'GET', '/api/model/id-verification', { token: modelA.token });
    assert.equal(st1.json.verification.status, 'pending');
    assert.equal(st1.json.packet_complete, false, 'docs without the release = incomplete packet');

    /* …and the Manager CANNOT approve it — the gates stay shut. */
    const list1 = await adminApi('GET', '/api/admin/id-verifications');
    const rowA = list1.json.verifications.find((r) => r.model_id === modelA.id && !r.is_partner);
    assert.ok(rowA, 'her row is in the queue');
    assert.equal(rowA.release_on_file, 0, 'queue flags the missing release');
    const blocked = await adminApi('POST', `/api/admin/id-verifications/${rowA.id}/approve`);
    assert.equal(blocked.status, 409, `approve without release refused: ${blocked.text}`);
    assert.equal(blocked.json.error, 'release_missing');
    const stBlocked = await req(base, 'GET', '/api/model/id-verification', { token: modelA.token });
    assert.equal(stBlocked.json.verified, false, 'still unverified — live/cash-out gates stay shut');

    /* E-sign validation: missing attestation, bad DOB, underage DOB. */
    const noAtt = await req(base, 'POST', '/api/model/release/sign', { token: modelA.token, body: {
      legal_name: 'Rita Legal', stage_name: 'relmodel', dob: '1996-04-02',
      attestations: { adult: true, freewill: true } } });
    assert.equal(noAtt.status, 400);
    assert.equal(noAtt.json.error, 'attestations_required');
    const badDob = await req(base, 'POST', '/api/model/release/sign', { token: modelA.token, body: {
      legal_name: 'Rita Legal', stage_name: 'relmodel', dob: 'April 2',
      attestations: { adult: true, freewill: true, rights: true } } });
    assert.equal(badDob.status, 400);
    assert.equal(badDob.json.error, 'bad_dob');
    const young = await req(base, 'POST', '/api/model/release/sign', { token: modelA.token, body: {
      legal_name: 'Rita Legal', stage_name: 'relmodel', dob: '2015-01-01',
      attestations: { adult: true, freewill: true, rights: true } } });
    assert.equal(young.status, 400);
    assert.equal(young.json.error, 'underage');

    /* A proper e-sign stores the FULL record, version included. */
    const signed = await req(base, 'POST', '/api/model/release/sign', { token: modelA.token, body: {
      legal_name: 'Rita Legal', stage_name: 'relmodel', dob: '1996-04-02',
      attestations: { adult: true, freewill: true, rights: true } } });
    assert.equal(signed.status, 200, `sign: ${signed.text}`);
    assert.equal(signed.json.packet_complete, true, 'docs + release = complete packet');
    {
      const db = openDb(dir);
      const r = db.prepare('SELECT * FROM model_releases WHERE model_id = ?').get(modelA.id);
      db.close();
      assert.ok(r, 'the record is stored');
      assert.equal(r.method, 'esign');
      assert.equal(r.legal_name, 'Rita Legal');
      assert.equal(r.stage_name, 'relmodel');
      assert.equal(r.dob, '1996-04-02');
      assert.equal(r.release_version, 'R1.0', 'the exact text version signed is pinned');
      assert.ok(r.signed_at, 'a signing timestamp is stored');
      const att = JSON.parse(r.attestations);
      assert.deepEqual(att, { adult: true, freewill: true, rights: true });
      const cs = openDb(dir);
      const poison = cs.prepare("SELECT COUNT(*) AS n FROM contract_signatures WHERE user_id = ? AND contract_version LIKE 'R%'").get(modelA.id);
      cs.close();
      assert.equal(poison.n, 0, 'no release row ever lands in contract_signatures');
    }

    /* Now the packet approves — and the queue shows the signed record. */
    const list2 = await adminApi('GET', '/api/admin/id-verifications');
    const rowA2 = list2.json.verifications.find((r) => r.model_id === modelA.id && !r.is_partner);
    assert.equal(rowA2.release_on_file, 1);
    assert.equal(rowA2.release_method, 'esign');
    assert.equal(rowA2.release_legal_name, 'Rita Legal');
    assert.equal(rowA2.release_version, 'R1.0');
    assert.deepEqual(rowA2.release_attestations, { adult: true, freewill: true, rights: true });
    const okApprove = await adminApi('POST', `/api/admin/id-verifications/${rowA.id}/approve`);
    assert.equal(okApprove.status, 200, `approve with release: ${okApprove.text}`);
    const st2 = await req(base, 'GET', '/api/model/id-verification', { token: modelA.token });
    assert.equal(st2.json.verified, true);

    /* The 2257 packet carries the release record. */
    const packet = await adminApi('GET', `/api/admin/id-verifications/${rowA.id}/2257`);
    assert.equal(packet.status, 200, `2257: ${packet.text}`);
    assert.equal(packet.json.release.method, 'esign');
    assert.equal(packet.json.release.legal_name, 'Rita Legal');
    assert.equal(packet.json.release.release_version, 'R1.0');

    /* PAPER path (model B): a signed paper copy satisfies the slot. */
    const upB = await idDocsUpload(base, modelB.token);
    assert.equal(upB.status, 200, `B ID upload: ${upB.text}`);
    const fd = new FormData();
    fd.append('release', new Blob([FAKE_PDF], { type: 'application/pdf' }), 'release.pdf');
    fd.append('legal_name', 'Pam Paper');
    const paper = await uploadRaw(base, '/api/model/release/paper', modelB.token, fd);
    assert.equal(paper.status, 200, `paper upload: ${paper.text}`);
    assert.equal(paper.json.release.method, 'paper');
    assert.equal(paper.json.release.paper_on_file, true);
    assert.equal(paper.json.packet_complete, true);
    const listB = await adminApi('GET', '/api/admin/id-verifications');
    const rowB = listB.json.verifications.find((r) => r.model_id === modelB.id && !r.is_partner);
    assert.equal(rowB.release_on_file, 1);
    assert.equal(rowB.release_method, 'paper');
    /* The reviewer can open the signed paper copy (tokened endpoint). */
    const tok = await adminApi('POST', `/api/admin/id-verifications/${rowB.id}/photo-token`);
    assert.equal(tok.status, 200, `photo token: ${tok.text}`);
    const view = await fetch(`${base}/api/admin/id-verifications/${rowB.id}/photo/release?t=${tok.json.token}`);
    assert.equal(view.status, 200, 'the paper release serves to the reviewer');
    assert.match(view.headers.get('content-type') || '', /pdf/);
    const okB = await adminApi('POST', `/api/admin/id-verifications/${rowB.id}/approve`);
    assert.equal(okB.status, 200, `B approve with paper release: ${okB.text}`);

    /* EXISTING approved model (model C): her approval predates the
       release (status written directly — the pre-build state). The
       new build must NOT blank it; signing flips only the flag. */
    const modelC = await signup('relold', 'model');
    const upC = await idDocsUpload(base, modelC.token);
    assert.equal(upC.status, 200, `C ID upload: ${upC.text}`);
    {
      const db = openDb(dir, false);
      db.prepare("UPDATE id_verifications SET status = 'approved', reviewed_at = datetime('now') WHERE model_id = ? AND co_performer_id IS NULL")
        .run(modelC.id);
      db.close();
    }
    const stC = await req(base, 'GET', '/api/model/id-verification', { token: modelC.token });
    assert.equal(stC.json.verified, true, 'pre-existing approval survives this build untouched');
    assert.equal(stC.json.release, null, 'she has no release yet — and stays approved');
    const signC = await req(base, 'POST', '/api/model/release/sign', { token: modelC.token, body: {
      legal_name: 'Olga Existing', stage_name: 'relold', dob: '1990-11-30',
      attestations: { adult: true, freewill: true, rights: true } } });
    assert.equal(signC.status, 200, `C sign: ${signC.text}`);
    const stC2 = await req(base, 'GET', '/api/model/id-verification', { token: modelC.token });
    assert.equal(stC2.json.verified, true, 'signing never disturbs her approval');
    const listC = await adminApi('GET', '/api/admin/id-verifications');
    const rowC = listC.json.verifications.find((r) => r.model_id === modelC.id && !r.is_partner);
    assert.equal(rowC.status, 'approved');
    assert.equal(rowC.release_on_file, 1, 'her Manager flag flips to on-file');

    /* HOUSE: exempt — flagged house, no card server-side, sign is a no-op. */
    const house = await signup('asceaaspade', 'model');
    const stH = await req(base, 'GET', '/api/model/id-verification', { token: house.token });
    assert.equal(stH.json.house, true);
    const signH = await req(base, 'POST', '/api/model/release/sign', { token: house.token, body: {} });
    assert.equal(signH.status, 200, `house sign no-op: ${signH.text}`);
    assert.equal(signH.json.house, true);
  } finally {
    stop(h);
  }
});

test('migration: a previous-schema database (no model_releases) boots clean and gains the table', { timeout: 300000 }, async () => {
  const dir = makeCopy('release-mig');
  let h = null;
  try {
    h = await boot(dir, { SEED_DEMO: '1' });
    stop(h); h = null;
    /* Roll the schema back to the previous build's: the release
       table simply did not exist. */
    {
      const db = openDb(dir, false);
      db.exec('DROP TABLE IF EXISTS model_releases');
      db.exec('DROP INDEX IF EXISTS idx_model_releases_model');
      db.close();
    }
    h = await boot(dir, { SEED_DEMO: '1' });
    const s = await req(h.base, 'POST', '/api/auth/signup', {
      body: { username: 'migm', password: 'hunter22', role: 'model', display_name: 'migm',
        dob: '1995-05-05', agree18: true, section: 'female' },
    });
    assert.equal(s.status, 200, `signup on migrated DB: ${s.text}`);
    const doc = await req(h.base, 'GET', '/api/model/release', { token: s.json.token });
    assert.equal(doc.status, 200, 'release flow works on the migrated database');
    const db = openDb(dir);
    const t = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'model_releases'").get();
    db.close();
    assert.ok(t, 'the table was created by the boot migration');
  } finally {
    stop(h);
  }
});
