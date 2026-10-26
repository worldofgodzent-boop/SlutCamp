'use strict';
/*
 * Co-Performer Signing Link (Asce's design Oct 24 2026; built Oct 26
 * 2026). The model sends her co-performer ONE single-use 7-day link;
 * he opens it on his phone — no account, no download, no printing —
 * reads the full site-neutral WOGENT release in the page, signs it
 * with the PR #91 clickwrap standard (typed legal name + I agree +
 * timestamp + IP), photographs his ID front/back + a selfie holding
 * it, and the packet fills itself: the signature record (a generated
 * PDF in the private ID storage) lands in the consent_form_path slot
 * and the photos in the ID slots — the exact slots
 * coStarPacketComplete() checks. Manager approval still applies.
 *
 * What this pins:
 *  - Schema: signing links + signature records; 7-day default
 *    expiry; the link lifecycle states.
 *  - coStarPacketComplete's contract is UNCHANGED (the same four
 *    paths on the partner's id_verifications row).
 *  - Model side: generate/resend/revoke are owner-only model calls;
 *    a resend supersedes the old link; an approved partner refuses.
 *  - Public side: the page renders the full release text; state /
 *    sign / photos endpoints enforce the order (sign before photos),
 *    single use (a completed link only ever says "already
 *    submitted"), revocation and expiry.
 *  - Completion: packet_complete flips true through the SAME
 *    co-performer API the Settings card reads; the consent document
 *    the Manager opens is the generated signature-record PDF; the
 *    Manager queue carries the typed legal name + the mismatch flag;
 *    the model gets her bell; every step is audit-logged against the
 *    co-performer record.
 *  - No ID document number is stored anywhere in the new schema.
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
const managerSrc = fs.readFileSync(path.join(REPO, 'public/manager/manager.js'), 'utf8');

function sliceFn(src, startMarker, endMarker) {
  const s = src.indexOf(startMarker);
  const e = src.indexOf(endMarker, s);
  assert.ok(s !== -1 && e > s, `located ${startMarker} … ${endMarker}`);
  return src.slice(s, e);
}

/* --------------------------- static pins --------------------------- */

test('schema: signing links + signature records, 7-day single-use lifecycle', () => {
  assert.ok(serverSrc.includes('CREATE TABLE IF NOT EXISTS co_performer_signing_links'), 'links table');
  assert.ok(serverSrc.includes('CREATE TABLE IF NOT EXISTS co_performer_signatures'), 'signatures table');
  assert.ok(serverSrc.includes("expires_at TEXT NOT NULL DEFAULT (datetime('now', '+7 days'))"),
    'links expire in 7 days by default (moderator-invite pattern)');
  assert.ok(serverSrc.includes("CHECK(status IN ('active','signed','completed','revoked','superseded'))"),
    'link lifecycle states');
  const sigDdl = sliceFn(serverSrc, 'CREATE TABLE IF NOT EXISTS co_performer_signatures',
    'CREATE INDEX IF NOT EXISTS idx_cosign_sigs_cp');
  for (const col of ['legal_name', 'release_version', 'attestations', 'record_path', 'signed_at', 'ip'])
    assert.ok(sigDdl.includes(col), `signature record carries ${col}`);
  assert.ok(!/document_number|id_number|doc_number/.test(sigDdl),
    'no ID document number is ever stored');
});

test('coStarPacketComplete contract is unchanged — the same four slots', () => {
  const fn = sliceFn(serverSrc, 'function coStarPacketComplete', '\n}');
  assert.ok(fn.includes('v.id_front_path && v.id_back_path && v.selfie_path && v.consent_form_path'),
    'still exactly ID front + ID back + selfie + consent form');
});

test('routes: model generate/revoke + public state/sign/photos/page', () => {
  for (const m of ["app.post('/api/model/co-performers/:id/signing-link'",
    "app.post('/api/model/co-performers/:id/signing-link/revoke'",
    "app.get('/api/cosign/:code'", "app.post('/api/cosign/:code/sign'",
    "app.post('/api/cosign/:code/photos'", "app.get('/cosign/:code'"]) {
    assert.ok(serverSrc.includes(m), `route exists: ${m}`);
  }
  const sign = sliceFn(serverSrc, "app.post('/api/cosign/:code/sign'", "app.post('/api/cosign/:code/photos'");
  assert.ok(sign.includes('consent_form_path'), 'his signature lands in the packet consent slot');
  assert.ok(sign.includes('co_performer_signatures'), 'the signature record is stored');
  assert.ok(sign.includes("via: 'signing_link'"), 'attestations pin the signing-link method + text version');
  const photos = sliceFn(serverSrc, "app.post('/api/cosign/:code/photos'", "app.get('/cosign/:code'");
  assert.ok(photos.includes('idUpload.fields'), 'photos ride the existing private ID upload pipeline');
  assert.ok(photos.includes("error: 'not_signed'"), 'photos refuse before the signature');
  assert.ok(photos.includes("status = 'completed'"), 'completion consumes the link');
});

test('audit + bell: every link step is logged; completion bells the model', () => {
  for (const a of ['cosign_link_created', 'cosign_link_revoked', 'cosign_signed', 'cosign_completed'])
    assert.ok(serverSrc.includes(`'${a}', 'co_performer'`), `audit action ${a} against the co-performer record`);
  const photos = sliceFn(serverSrc, "app.post('/api/cosign/:code/photos'", "app.get('/cosign/:code'");
  assert.ok(photos.includes("srv('bell_cosign_done_title'"), 'the model is belled in her language');
  assert.ok(photos.includes("notifyUser(model.id, 'cosign_completed'"), 'bell goes to the model');
});

test('client + manager surfaces render the new states', () => {
  for (const attr of ['data-cp-signlink', 'data-cp-revokelink', 'data-cp-copylink'])
    assert.ok(appSrc.includes(attr), `Settings card control ${attr}`);
  assert.ok(appSrc.includes("t('coperf_signlink_send')"), 'send button renders through t()');
  assert.ok(appSrc.includes('p.signing_link'), 'the card reads signing_link from the API');
  assert.ok(managerSrc.includes('signatureLine'), 'Manager renders the signature line');
  assert.ok(managerSrc.includes('signature_name_mismatch'), 'Manager renders the reviewer mismatch flag');
  assert.ok(serverSrc.includes('signature_name_mismatch'), 'queue API computes the mismatch flag');
});

/* --------------------------- boot harness -------------------------- */

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
  try { json = JSON.parse(text); } catch (_) { /* not json */ }
  return { status: r.status, text, json };
}
const PNG = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001080600000'
  + '01f15c4890000000a49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082', 'hex');
async function uploadPhotos(base, p, fields = ['id_front', 'id_back', 'selfie']) {
  const fd = new FormData();
  for (const f of fields) fd.append(f, new Blob([PNG], { type: 'image/png' }), `${f}.png`);
  const r = await fetch(base + p, { method: 'POST', body: fd });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not json */ }
  return { status: r.status, text, json };
}
function openDb(dir, readOnly = true) {
  const d = new DatabaseSync(path.join(dir, 'wogent-chat.db'), readOnly ? { readOnly: true } : {});
  d.exec('PRAGMA busy_timeout = 10000');
  return d;
}

/* ----------------------------- live ------------------------------ */

test('live: the whole signing-link flow, end to end', { timeout: 300000 }, async () => {
  const dir = makeCopy('cosign');
  let h = null;
  try {
    h = await boot(dir, { SEED_DEMO: '1' });
    const base = h.base;

    const login = async (username, password) => {
      const r = await req(base, 'POST', '/api/auth/login', { body: { username, password } });
      assert.equal(r.status, 200, `login ${username}: ${r.text}`);
      return r.json.token;
    };
    const bunny = await login('bunny', 'model123');
    const stacey = await login('stacey', 'model123');
    const fan = await login('fandemo', 'fan123');
    const mgrLogin = await req(base, 'POST', '/api/manager/login', { body: { username: 'admin', password: 'admin123' } });
    assert.equal(mgrLogin.status, 200, `manager login: ${mgrLogin.text}`);
    const MGR = { token: mgrLogin.json.token, headers: { 'x-manager': '1' } };

    const addPartner = async (token, display_name) => {
      const r = await req(base, 'POST', '/api/model/co-performers', {
        token, body: { display_name, gender: 'male', agree18: true } });
      assert.equal(r.status, 200, `add partner: ${r.text}`);
      return r.json.co_performer;
    };
    const myPartners = async (token) => {
      const r = await req(base, 'GET', '/api/model/co-performers', { token });
      assert.equal(r.status, 200);
      return r.json.co_performers;
    };
    const genLink = (token, id) => req(base, 'POST', `/api/model/co-performers/${id}/signing-link`, { token, body: {} });
    const codeOf = (url) => url.split('/cosign/')[1];

    /* --- partner 1: the full happy path --- */
    const p1 = await addPartner(bunny, 'Link Partner');
    assert.equal(p1.signing_link, null, 'no link before she sends one');

    // owner-only: another model and a fan are refused
    assert.equal((await genLink(stacey, p1.id)).status, 404, "another model's partner is not hers");
    assert.equal((await genLink(fan, p1.id)).status, 403, 'fans cannot send signing links');

    const g1 = await genLink(bunny, p1.id);
    assert.equal(g1.status, 200, `generate: ${g1.text}`);
    assert.equal(g1.json.signing_link.state, 'active');
    const code1 = codeOf(g1.json.signing_link.url);
    assert.match(code1, /^[a-f0-9]{18}$/, 'the code is the invite-token shape');

    // the page carries the full release text, in the page
    const page1 = await req(base, 'GET', `/cosign/${code1}`);
    assert.equal(page1.status, 200);
    assert.ok(page1.text.includes('Performer Release and Consent'), 'page shows the release');
    assert.ok(page1.text.includes('Grant of Rights'), 'page shows the full text, not a teaser');
    assert.ok(page1.text.includes('Sign your release'), 'page shows the signing flow');

    // state endpoint: valid + the release sections ride along
    const st1 = await req(base, 'GET', `/api/cosign/${code1}`);
    assert.equal(st1.json.valid, true);
    assert.equal(st1.json.state, 'active');
    assert.equal(st1.json.release.sections.length, 8, 'all 8 release sections served');
    const stBad = await req(base, 'GET', '/api/cosign/000000000000000000');
    assert.equal(stBad.json.valid, false);
    assert.equal(stBad.json.state, 'not_found');

    // order is enforced: photos before signing refuse
    const early = await uploadPhotos(base, `/api/cosign/${code1}/photos`);
    assert.equal(early.status, 409);
    assert.equal(early.json.error, 'not_signed');

    // signing validation: no agreement, no name
    const noAgree = await req(base, 'POST', `/api/cosign/${code1}/sign`, { body: { legal_name: 'Link Partner' } });
    assert.equal(noAgree.status, 400);
    assert.equal(noAgree.json.error, 'agreement_required');
    const noName = await req(base, 'POST', `/api/cosign/${code1}/sign`, { body: { legal_name: '', agree: true } });
    assert.equal(noName.status, 400);
    assert.equal(noName.json.error, 'bad_name');

    // he signs — typed legal name matches the registered name
    const s1 = await req(base, 'POST', `/api/cosign/${code1}/sign`, { body: { legal_name: 'Link Partner', agree: true } });
    assert.equal(s1.status, 200, `sign: ${s1.text}`);
    assert.equal(s1.json.state, 'signed');
    const s1b = await req(base, 'POST', `/api/cosign/${code1}/sign`, { body: { legal_name: 'Link Partner', agree: true } });
    assert.equal(s1b.status, 409);
    assert.equal(s1b.json.error, 'already_signed');

    // the consent slot filled itself; the packet is not complete yet
    let mine = await myPartners(bunny);
    let row1 = mine.find((p) => p.id === p1.id);
    assert.equal(row1.consent_on_file, true, 'his signature record is the packet consent');
    assert.equal(row1.packet_complete, false, 'ID photos still missing');
    assert.equal(row1.signing_link.state, 'signed');

    // photos: all three required, through the private pipeline
    const partial = await uploadPhotos(base, `/api/cosign/${code1}/photos`, ['id_front', 'id_back']);
    assert.equal(partial.status, 400);
    assert.equal(partial.json.error, 'missing_files');
    const done = await uploadPhotos(base, `/api/cosign/${code1}/photos`);
    assert.equal(done.status, 200, `photos: ${done.text}`);
    assert.equal(done.json.packet_complete, true, 'coStarPacketComplete now passes');

    mine = await myPartners(bunny);
    row1 = mine.find((p) => p.id === p1.id);
    assert.equal(row1.packet_complete, true);
    assert.equal(row1.signing_link.state, 'completed');

    // single use: a completed link only ever says "already submitted"
    const stDone = await req(base, 'GET', `/api/cosign/${code1}`);
    assert.equal(stDone.json.state, 'completed');
    assert.equal(stDone.json.valid, false);
    const pageDone = await req(base, 'GET', `/cosign/${code1}`);
    assert.ok(pageDone.text.includes('Already submitted'), 'forwarded link shows already submitted');
    assert.equal((await req(base, 'POST', `/api/cosign/${code1}/sign`,
      { body: { legal_name: 'Link Partner', agree: true } })).status, 409);
    assert.equal((await uploadPhotos(base, `/api/cosign/${code1}/photos`)).status, 409);

    // her bell landed, in the spec's words
    const bells = await req(base, 'GET', '/api/notifications', { token: bunny });
    const bell = (bells.json.notifications || []).find((n) => n.type === 'cosign_completed');
    assert.ok(bell, 'the model got the completion bell');
    assert.ok(bell.title.includes('Link Partner') && bell.title.includes('signed and submitted his ID'),
      `bell title: ${bell.title}`);

    // the Manager queue: packet labeled partner, signature named, no mismatch
    const queue = await req(base, 'GET', '/api/admin/id-verifications', { ...MGR });
    assert.equal(queue.status, 200, `queue: ${queue.text}`);
    const qrow = queue.json.verifications.find((v) => v.co_performer_id === p1.id);
    assert.ok(qrow, 'packet is in the ID Checks queue');
    assert.equal(qrow.is_partner, 1);
    assert.equal(qrow.consent_on_file, 1);
    assert.equal(qrow.signature_legal_name, 'Link Partner');
    assert.equal(qrow.signature_name_mismatch, 0, 'matching names raise no flag');

    // the consent document the reviewer opens IS the signature record PDF
    const tok = await req(base, 'POST', `/api/admin/id-verifications/${qrow.id}/photo-token`, { ...MGR });
    assert.equal(tok.status, 200, `photo token: ${tok.text}`);
    const docRes = await fetch(`${base}/api/admin/id-verifications/${qrow.id}/photo/consent?t=${tok.json.token}`);
    assert.equal(docRes.status, 200);
    assert.match(docRes.headers.get('content-type') || '', /application\/pdf/);
    const docBuf = Buffer.from(await docRes.arrayBuffer());
    assert.ok(docBuf.subarray(0, 5).toString('latin1') === '%PDF-', 'consent document is a real PDF');
    assert.ok(docBuf.toString('latin1').includes('Link Partner'), 'the record names the signer');

    // the 2257 packet carries the signature record for the partner
    const rec = await req(base, 'GET', `/api/admin/id-verifications/${qrow.id}/2257`, { ...MGR });
    assert.equal(rec.status, 200, `2257: ${rec.text}`);
    assert.equal(rec.json.co_performer_release.legal_name, 'Link Partner');
    assert.equal(rec.json.co_performer_release.method, 'esign_link');

    /* --- partner 2: the name-mismatch reviewer flag --- */
    const p2 = await addPartner(bunny, 'Stage Name');
    const g2 = await genLink(bunny, p2.id);
    const code2 = codeOf(g2.json.signing_link.url);
    await req(base, 'POST', `/api/cosign/${code2}/sign`, { body: { legal_name: 'Completely Different', agree: true } });
    await uploadPhotos(base, `/api/cosign/${code2}/photos`);
    const queue2 = await req(base, 'GET', '/api/admin/id-verifications', { ...MGR });
    const qrow2 = queue2.json.verifications.find((v) => v.co_performer_id === p2.id);
    assert.equal(qrow2.signature_legal_name, 'Completely Different');
    assert.equal(qrow2.signature_name_mismatch, 1,
      'a typed name sharing nothing with the registered name is flagged for the reviewer');

    /* --- partner 3: resend supersedes; revoke kills --- */
    const p3 = await addPartner(bunny, 'Third Partner');
    const gA = await genLink(bunny, p3.id);
    const codeA = codeOf(gA.json.signing_link.url);
    const gB = await genLink(bunny, p3.id);
    const codeB = codeOf(gB.json.signing_link.url);
    assert.notEqual(codeA, codeB, 'a resend mints a fresh code');
    const stA = await req(base, 'GET', `/api/cosign/${codeA}`);
    assert.equal(stA.json.state, 'superseded', 'the old link died at the resend');
    assert.equal(stA.json.valid, false);
    const pageA = await req(base, 'GET', `/cosign/${codeA}`);
    assert.ok(pageA.text.includes('was replaced'), 'old link page says it was replaced');
    const rv = await req(base, 'POST', `/api/model/co-performers/${p3.id}/signing-link/revoke`, { token: bunny, body: {} });
    assert.equal(rv.status, 200, `revoke: ${rv.text}`);
    assert.equal(rv.json.signing_link.state, 'revoked');
    const signRevoked = await req(base, 'POST', `/api/cosign/${codeB}/sign`,
      { body: { legal_name: 'Third Partner', agree: true } });
    assert.equal(signRevoked.status, 410, 'a revoked link cannot sign');
    const rv2 = await req(base, 'POST', `/api/model/co-performers/${p3.id}/signing-link/revoke`, { token: bunny, body: {} });
    assert.equal(rv2.status, 404, 'no open link left to revoke');

    /* --- partner 4: expiry (set in the DB, read after a reboot) --- */
    const p4 = await addPartner(bunny, 'Fourth Partner');
    const g4 = await genLink(bunny, p4.id);
    const code4 = codeOf(g4.json.signing_link.url);
    stop(h); h = null;
    const wdb = openDb(dir, false);
    wdb.prepare("UPDATE co_performer_signing_links SET expires_at = '2000-01-01 00:00:00' WHERE code = ?").run(code4);
    // the audit trail so far, against the co-performer records
    const actions = wdb.prepare(`SELECT action, target_id FROM moderator_actions
      WHERE target_type = 'co_performer' ORDER BY id`).all();
    const actsFor = (id) => actions.filter((a) => a.target_id === id).map((a) => a.action);
    assert.deepEqual(actsFor(p1.id), ['cosign_link_created', 'cosign_signed', 'cosign_completed'],
      'partner 1: generation, signing, completion all audit-logged');
    assert.ok(actsFor(p3.id).includes('cosign_link_revoked'), 'partner 3: revoke audit-logged');
    wdb.close();

    h = await boot(dir, { SEED_DEMO: '1' });
    const stExp = await req(h.base, 'GET', `/api/cosign/${code4}`);
    assert.equal(stExp.json.state, 'expired', 'a past-expiry link reads expired');
    assert.equal(stExp.json.valid, false);
    const signExpired = await req(h.base, 'POST', `/api/cosign/${code4}/sign`,
      { body: { legal_name: 'Fourth Partner', agree: true } });
    assert.equal(signExpired.status, 410, 'an expired link cannot sign');
    const pageExp = await req(h.base, 'GET', `/cosign/${code4}`);
    assert.ok(pageExp.text.includes('expired'), 'expired page says so');
  } finally {
    stop(h);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
