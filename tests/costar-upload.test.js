'use strict';
/*
 * CO-STAR UPLOAD PROMPT (Asce's directive, Oct 21 2026; build Oct 22 2026).
 *
 * When a model uploads pictures/video to her profile she must answer
 * a prompt — Solo or Co-Star? This suite pins the whole rule:
 *
 *  - The declaration is REQUIRED on all five profile-media uploads
 *    (photo, public-photo, preview-video, preview-video-2,
 *    gallery-photo). Missing/invalid ⇒ 400 and nothing is stored.
 *    Solo posts exactly as before (still subject to the upload gate).
 *  - A Co-Star declaration names her REGISTERED co-performers — the
 *    declaration links the media to the existing co_performers rows
 *    (media_costars), never a duplicate person, never a parallel
 *    queue. Naming someone else's co-star is refused (bad_costar).
 *  - Media visibility = BOTH gates: her own ID approved (upload
 *    gate, PR #81) AND every declared co-star's 2257 packet complete
 *    + approved. The packet is ID front + ID back + selfie-with-ID +
 *    a signed consent form (ANY standard form — photo or PDF),
 *    stored on the partner's id_verifications row and reviewed in
 *    the SAME Manager ID Checks queue (consent_on_file flag, the
 *    tokened photo endpoint serves it as 'consent', the 2257 packet
 *    lists it). Until the packet clears, the media is held at the
 *    same three derivation surfaces as the upload gate (roster
 *    shapeRow, SEO pages, conversation other-party) — while her own
 *    /api/me keeps everything and profile setup stays open.
 *  - Approval alone does NOT clear media (a packet approved before
 *    the consent form lands stays held until the form arrives);
 *    a complete-but-unapproved packet is held too. The moment the
 *    last piece lands, the media posts with nothing to re-upload.
 *  - The house account is exempt (no declaration required, media
 *    public) by the same short-circuit as every other gate.
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
const appSrc = fs.readFileSync(path.join(REPO, 'public', 'js', 'app.js'), 'utf8');
const mgrSrc = fs.readFileSync(path.join(REPO, 'public', 'manager', 'manager.js'), 'utf8');

function sliceFn(src, startMarker, endMarker) {
  const s = src.indexOf(startMarker);
  const e = src.indexOf(endMarker, s);
  assert.ok(s !== -1 && e > s, `located ${startMarker} … ${endMarker}`);
  return src.slice(s, e);
}

/* --------------------------- static pins --------------------------- */

test('server: schema — media_costars table + consent column, boot-safe migrations', () => {
  assert.ok(serverSrc.includes('CREATE TABLE IF NOT EXISTS media_costars'),
    'declarations table created if missing');
  assert.ok(serverSrc.includes('UNIQUE(model_id, media_url, co_performer_id)'),
    'one row per (model, media, co-star) — re-declaring never duplicates');
  assert.ok(serverSrc.includes("addColumnIfMissing('id_verifications', 'consent_form_path', 'TEXT')"),
    'consent path added to pre-existing databases via the guarded column helper');
});

test('server: the declaration is parsed on all five profile-media uploads', () => {
  assert.equal(serverSrc.split('const decl = parseAppearanceDecl(req);').length - 1, 5,
    'photo, public-photo, preview-video, preview-video-2, gallery-photo');
  assert.equal(serverSrc.split('if (decl.error) return refuseDecl(req, res, decl);').length - 1, 5,
    'every refusal removes the uploaded file and answers 400');
  assert.ok(serverSrc.includes("return { error: 'appearance_required'"), 'missing declaration refused');
  assert.ok(serverSrc.includes("return { error: 'costar_required'"), 'co-star with nobody picked refused');
  assert.ok(serverSrc.includes("return { error: 'bad_costar'"), "someone else's co-star refused");
  assert.ok(serverSrc.includes('if (isHouseAccountId(req.user.id)) return { appearance: \'solo\', costarIds: [] };'),
    'the house short-circuits the prompt like every other gate');
});

test('server: the co-star gate holds media at the same three surfaces as the upload gate', () => {
  const route = sliceFn(serverSrc, "app.get('/api/models',", '// Fan likes/unlikes a model');
  assert.ok(route.includes('const held = heldMediaUrls(r.id);'), 'roster shapeRow consults the held set');
  assert.ok(route.includes('if (held.has(shaped.photo_url)) shaped.photo_url = \'\';'), 'main photo held per-item');
  assert.ok(route.includes('shaped.gallery_photos = shaped.gallery_photos.filter((u) => !held.has(u));'),
    'gallery filtered per-item');
  const seo = sliceFn(serverSrc, 'function seoPublicModels()', 'const seoTagSlug');
  assert.ok(seo.includes('heldMediaUrls(r.id).has(r.public_photo_url)'), 'SEO pages hold a declared clean photo');
  const other = sliceFn(serverSrc, 'function otherParty(conv, ident)', 'function convWhere(ident)');
  assert.ok(other.includes('heldMediaUrls(otherId).has(m.photo_url)'), 'conversation view holds a declared photo');
  const me = sliceFn(serverSrc, "app.get('/api/me',", '/* --- Display name changes');
  assert.ok(!me.includes('heldMediaUrls'), 'her own /api/me is never co-star gated');
});

test('server: consent form rides the existing packet — endpoint, queue flag, photo kind, 2257', () => {
  assert.ok(serverSrc.includes("app.post('/api/model/co-performers/:id/consent-form'"),
    'consent upload endpoint on the co-performer record');
  assert.ok(serverSrc.includes("'application/pdf': '.pdf'"), 'a PDF consent form is accepted (any standard form)');
  assert.ok(serverSrc.includes("app.get('/api/model/media-costars'"), 'her declarations read-back endpoint');
  const queue = sliceFn(serverSrc, "app.get('/api/admin/id-verifications',", '\n});');
  assert.ok(queue.includes('AS consent_on_file'), 'the Manager queue exposes the consent flag (never the path)');
  const photo = sliceFn(serverSrc, "app.get('/api/admin/id-verifications/:id/photo/:which',", '\n});');
  assert.ok(photo.includes("'front', 'back', 'selfie', 'consent'"), 'the tokened photo endpoint serves the form');
  const packet = sliceFn(serverSrc, "app.get('/api/admin/id-verifications/:id/2257',", '\n});');
  assert.ok(packet.includes('consent_form: base(v.consent_form_path)'), 'the 2257 packet lists the consent form');
  assert.ok(serverSrc.includes('packet_complete: coStarPacketComplete(row.id)'),
    'packet completeness = ID front + back + selfie + consent');
  assert.ok(serverSrc.includes("return !!(cp && cp.status === 'approved') && coStarPacketComplete(coPerformerId);"),
    'media clears only on approved AND complete — approval alone is not enough');
});

test('client: the prompt is wired into all five Settings upload flows', () => {
  assert.ok(appSrc.includes('async function pickUploadAppearance()'), 'the Solo/Co-Star prompt exists');
  assert.ok(appSrc.includes("apiUpload('/model/photo', cropped, 'photo', declFields(decl))"), 'main photo declares');
  assert.ok(appSrc.includes("apiUpload('/model/public-photo', cropped, 'photo', declFields(decl))"), 'public photo declares');
  assert.ok(appSrc.includes("apiUpload('/model/gallery-photo', cropped, 'photo', declFields(decl))"), 'gallery declares');
  assert.equal(appSrc.split("fd.append('appearance', df.appearance);").length - 1, 2,
    'both preview videos append the declaration to their FormData');
  assert.ok(appSrc.includes('data-cp-consent='), 'consent upload lives in the co-performer card');
  assert.ok(appSrc.includes('/consent-form'), 'consent posts to the packet endpoint');
  assert.ok(appSrc.includes('markHeldMediaBadges'), 'held items are badged in her own Settings');
  for (const k of ['costar_prompt_title', 'costar_prompt_solo', 'costar_prompt_costar',
                   'costar_consent', 'costar_held_badge', 'costar_attach_one',
                   'costar_media_ready', 'costar_media_waiting']) {
    const hits = appSrc.match(new RegExp(`${k}: '`, 'g')) || [];
    assert.equal(hits.length, 13, `${k} present once per language`);
    const vals = appSrc.match(new RegExp(`${k}: '([^']*)'`, 'g')) || [];
    for (const v of vals) assert.ok(!v.includes('FaceTime'), `${k} carries no forbidden string`);
  }
});

test('manager: the ID Checks queue surfaces the consent form', () => {
  assert.ok(mgrSrc.includes('/photo/consent?t='), 'reviewer can open the form through the tokened endpoint');
  assert.ok(mgrSrc.includes('consent_on_file'), 'the queue renders the on-file / missing state');
});

test('recount: the announcement thread-tap pin still reads exactly 30 after this build', () => {
  assert.equal(serverSrc.split('/#chat/${conv.id}').length - 1, 30);
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
const FAKE_MP4 = Buffer.from('AAAAGGZ0eXBpc29tAAAAAmlzb21pc28y', 'base64');
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
// A profile-media upload: one file field + optional declaration fields.
function mediaUpload(base, p, token, field, blob, type, name, decl) {
  const fd = new FormData();
  fd.append(field, blob, name);
  if (decl) for (const [k, v] of Object.entries(decl)) fd.append(k, v);
  return uploadRaw(base, p, token, fd);
}
const SOLO = { appearance: 'solo' };
const costar = (...ids) => ({ appearance: 'costar', costar_ids: JSON.stringify(ids) });
function idDocsUpload(base, p, token) {
  const fd = new FormData();
  for (const f of ['id_front', 'id_back', 'selfie'])
    fd.append(f, new Blob([PNG], { type: 'image/png' }), `${f}.png`);
  return uploadRaw(base, p, token, fd);
}
function consentUpload(base, cpId, token, pdf) {
  const fd = new FormData();
  if (pdf) fd.append('consent', new Blob([FAKE_PDF], { type: 'application/pdf' }), 'release.pdf');
  else fd.append('consent', new Blob([PNG], { type: 'image/png' }), 'release.png');
  return uploadRaw(base, `/api/model/co-performers/${cpId}/consent-form`, token, fd);
}

test('live: prompt required, solo unchanged, co-star media held until the packet clears, house exempt', { timeout: 300000 }, async () => {
  const dir = makeCopy('costar');
  let h = null;
  try {
    h = await boot(dir, { SEED_DEMO: '1' });
    const base = h.base;

    const mgrLogin = await req(base, 'POST', '/api/manager/login', { body: { username: 'admin', password: 'admin123' } });
    assert.equal(mgrLogin.status, 200, `manager login: ${mgrLogin.text}`);
    const MGR = { token: mgrLogin.json.token, headers: { 'x-manager': '1' } };

    const signup = async (username, role) => {
      const s = await req(base, 'POST', '/api/auth/signup', {
        body: { username, password: 'hunter22', role, display_name: username,
          dob: '1995-05-05', agree18: true, ...(role === 'model' ? { section: 'female' } : {}) },
      });
      assert.equal(s.status, 200, `signup ${username}: ${s.text}`);
      return { token: s.json.token, id: s.json.user.id };
    };
    const model = await signup('csmodel', 'model');
    const other = await signup('csother', 'model');
    const fan = await signup('csfan', 'fan');
    const house = await signup('asceaaspade', 'model');

    const addPartner = async (who, name) => {
      const r = await req(base, 'POST', '/api/model/co-performers', { token: who.token,
        body: { display_name: name, gender: 'female', dob: '1992-02-02', agree18: true } });
      assert.equal(r.status, 200, `add partner ${name}: ${r.text}`);
      return r.json.co_performer;
    };
    const queueRow = async (cpId) => {
      const q = await req(base, 'GET', '/api/admin/id-verifications', { ...MGR });
      assert.equal(q.status, 200, `manager queue: ${q.text}`);
      return q.json.verifications.find((v) => v.co_performer_id === cpId);
    };
    const approveVerif = async (verifId) => {
      const r = await req(base, 'POST', `/api/admin/id-verifications/${verifId}/approve`, { ...MGR });
      assert.equal(r.status, 200, `approve ${verifId}: ${r.text}`);
    };
    const completePacket = async (who, cpId, pdf) => {
      const docs = await idDocsUpload(base, `/api/model/co-performers/${cpId}/id-verification`, who.token);
      assert.equal(docs.status, 200, `partner ID docs: ${docs.text}`);
      const form = await consentUpload(base, cpId, who.token, pdf);
      assert.equal(form.status, 200, `consent form: ${form.text}`);
      assert.equal(form.json.packet_complete, true, 'packet complete once the form lands');
      const row = await queueRow(cpId);
      assert.ok(row, 'the packet is in the Manager queue');
      assert.equal(row.consent_on_file, 1, 'the queue flags the consent form on file');
      await approveVerif(row.id);
      return row;
    };
    const rosterRow = async (id) => {
      const r = await req(base, 'GET', '/api/models');
      assert.equal(r.status, 200);
      return r.json.models.find((m) => m.id === id);
    };

    /* ---- the prompt is required; refusals store nothing ---- */
    const noDecl = await mediaUpload(base, '/api/model/photo', model.token, 'photo',
      new Blob([PNG], { type: 'image/png' }), 'image/png', 'a.png', null);
    assert.equal(noDecl.status, 400, `no declaration refused: ${noDecl.text}`);
    assert.equal(noDecl.json.error, 'appearance_required');
    const badDecl = await mediaUpload(base, '/api/model/photo', model.token, 'photo',
      new Blob([PNG], { type: 'image/png' }), 'image/png', 'a.png', { appearance: 'group' });
    assert.equal(badDecl.status, 400);
    assert.equal(badDecl.json.error, 'appearance_required');
    const emptyCostar = await mediaUpload(base, '/api/model/photo', model.token, 'photo',
      new Blob([PNG], { type: 'image/png' }), 'image/png', 'a.png', costar());
    assert.equal(emptyCostar.status, 400);
    assert.equal(emptyCostar.json.error, 'costar_required');
    const meAfterRefusals = await req(base, 'GET', '/api/me', { token: model.token });
    assert.equal(meAfterRefusals.json.model.photo_url, '', 'a refused upload stored nothing');
    const fanTry = await mediaUpload(base, '/api/model/photo', fan.token, 'photo',
      new Blob([PNG], { type: 'image/png' }), 'image/png', 'a.png', SOLO);
    assert.equal(fanTry.status, 403, 'fans cannot upload profile media at all');

    /* ---- someone else's co-star cannot be declared ---- */
    const foreign = await addPartner(other, 'Not Hers');
    const badCostar = await mediaUpload(base, '/api/model/photo', model.token, 'photo',
      new Blob([PNG], { type: 'image/png' }), 'image/png', 'a.png', costar(foreign.id));
    assert.equal(badCostar.status, 400, `foreign co-star refused: ${badCostar.text}`);
    assert.equal(badCostar.json.error, 'bad_costar');

    /* ---- solo path, end to end, through the upload gate ---- */
    const soloUp = await mediaUpload(base, '/api/model/photo', model.token, 'photo',
      new Blob([PNG], { type: 'image/png' }), 'image/png', 'solo.png', SOLO);
    assert.equal(soloUp.status, 200, `solo upload: ${soloUp.text}`);
    assert.equal(soloUp.json.costar_held, false, 'solo media is never co-star held');
    const soloUrl = soloUp.json.photo_url;
    assert.equal((await rosterRow(model.id)).photo_url, '',
      'her own ID still pending: the upload gate holds the solo photo');
    const ownDocs = await idDocsUpload(base, '/api/model/id-verification', model.token);
    assert.equal(ownDocs.status, 200, `her ID docs: ${ownDocs.text}`);
    {
      const q = await req(base, 'GET', '/api/admin/id-verifications', { ...MGR });
      const ownRow = q.json.verifications.find((v) => v.model_id === model.id && !v.is_partner);
      assert.ok(ownRow, 'her own packet is in the queue');
      await approveVerif(ownRow.id);
    }
    assert.equal((await rosterRow(model.id)).photo_url, soloUrl,
      'ID approved: the solo photo posts with nothing to re-upload');

    /* ---- co-star gallery photo: held through every packet stage ---- */
    const cpA = await addPartner(model, 'Alpha Star');
    const galUp = await mediaUpload(base, '/api/model/gallery-photo', model.token, 'photo',
      new Blob([PNG], { type: 'image/png' }), 'image/png', 'duo.png', costar(cpA.id));
    assert.equal(galUp.status, 200, `co-star gallery upload: ${galUp.text}`);
    assert.equal(galUp.json.costar_held, true, 'the response flags the hold');
    const galUrl = galUp.json.gallery_photos[galUp.json.gallery_photos.length - 1];
    assert.ok(!(await rosterRow(model.id)).gallery_photos.includes(galUrl),
      'no packet at all: the gallery photo is off the roster');
    const meHeld = await req(base, 'GET', '/api/me', { token: model.token });
    assert.ok(JSON.parse(meHeld.json.model.gallery_photos).includes(galUrl),
      'her own view keeps the held photo (setup stays open)');
    const decls1 = await req(base, 'GET', '/api/model/media-costars', { token: model.token });
    assert.deepEqual(decls1.json.held_urls, [galUrl], 'her declarations endpoint reports the hold');
    assert.equal(decls1.json.declarations[0].co_performer_id, cpA.id,
      'the declaration links the EXISTING co-performer record');

    const docsOnly = await idDocsUpload(base, `/api/model/co-performers/${cpA.id}/id-verification`, model.token);
    assert.equal(docsOnly.status, 200, `partner ID docs: ${docsOnly.text}`);
    assert.ok(!(await rosterRow(model.id)).gallery_photos.includes(galUrl),
      'ID docs alone (no consent, unapproved): still held');
    const rowA = await queueRow(cpA.id);
    assert.ok(rowA && rowA.is_partner === 1, 'the partner packet rides the same Manager queue');
    assert.equal(rowA.consent_on_file, 0, 'the queue shows the consent form missing');

    const formA = await consentUpload(base, cpA.id, model.token, true);
    assert.equal(formA.status, 200, `consent PDF: ${formA.text}`);
    assert.equal(formA.json.consent_on_file, true);
    assert.equal(formA.json.packet_complete, true, 'ID docs + consent = complete packet');
    assert.equal(formA.json.media_cleared, false, 'complete but UNAPPROVED: not cleared');
    assert.ok(!(await rosterRow(model.id)).gallery_photos.includes(galUrl),
      'complete but unapproved: still held');
    assert.equal((await queueRow(cpA.id)).consent_on_file, 1, 'the queue now flags the form on file');

    // The reviewer can open the form through the tokened photo endpoint.
    const tok = await req(base, 'POST', `/api/admin/id-verifications/${rowA.id}/photo-token`, { ...MGR });
    assert.equal(tok.status, 200, `photo token: ${tok.text}`);
    const formFetch = await fetch(`${base}/api/admin/id-verifications/${rowA.id}/photo/consent?t=${tok.json.token}`);
    assert.equal(formFetch.status, 200, 'the consent form is viewable in review');
    assert.ok((formFetch.headers.get('content-type') || '').includes('application/pdf'),
      'a PDF form is served as a PDF');
    await formFetch.arrayBuffer();

    // The 2257 packet lists the consent form.
    const packet = await req(base, 'GET', `/api/admin/id-verifications/${rowA.id}/2257`, { ...MGR });
    assert.equal(packet.status, 200, `2257 packet: ${packet.text}`);
    assert.ok(packet.json.id_verification.documents_on_file.consent_form.endsWith('.pdf'),
      'the 2257 record names the consent form on file');

    await approveVerif(rowA.id);
    assert.ok((await rosterRow(model.id)).gallery_photos.includes(galUrl),
      'packet approved: the gallery photo posts with nothing to re-upload');
    const decls2 = await req(base, 'GET', '/api/model/media-costars', { token: model.token });
    assert.deepEqual(decls2.json.held_urls, [], 'nothing held once the packet clears');
    const cpList = await req(base, 'GET', '/api/model/co-performers', { token: model.token });
    const cpArow = cpList.json.co_performers.find((p) => p.id === cpA.id);
    assert.equal(cpArow.packet_complete, true);
    assert.equal(cpArow.media_cleared, true, 'her card shows the co-star cleared for media');

    /* ---- approval BEFORE consent: approval alone does not clear ---- */
    const cpB = await addPartner(model, 'Beta Star');
    const vidUp = await mediaUpload(base, '/api/model/preview-video-2', model.token, 'video',
      new Blob([FAKE_MP4], { type: 'video/mp4' }), 'video/mp4', 'clip.mp4', costar(cpB.id));
    assert.equal(vidUp.status, 200, `co-star video upload: ${vidUp.text}`);
    assert.equal(vidUp.json.costar_held, true);
    const vidUrl = vidUp.json.preview_video_url_2;
    const docsB = await idDocsUpload(base, `/api/model/co-performers/${cpB.id}/id-verification`, model.token);
    assert.equal(docsB.status, 200);
    const rowB = await queueRow(cpB.id);
    await approveVerif(rowB.id);
    assert.equal((await rosterRow(model.id)).preview_video_url_2, '',
      'approved but NO consent form on file: the video stays held');
    const formB = await consentUpload(base, cpB.id, model.token, false);
    assert.equal(formB.status, 200, `consent photo: ${formB.text}`);
    assert.equal(formB.json.media_cleared, true, 'the form landing on an approved packet clears it');
    assert.equal((await rosterRow(model.id)).preview_video_url_2, vidUrl,
      'the video posts the moment the packet completes');

    /* ---- mixed declaration: held until EVERY named co-star clears ---- */
    const cpC = await addPartner(model, 'Gamma Star');
    const mixUp = await mediaUpload(base, '/api/model/photo', model.token, 'photo',
      new Blob([PNG], { type: 'image/png' }), 'image/png', 'mix.png', costar(cpA.id, cpC.id));
    assert.equal(mixUp.status, 200, `mixed upload: ${mixUp.text}`);
    assert.equal(mixUp.json.costar_held, true, 'one uncleared co-star holds the whole item');
    const mixUrl = mixUp.json.photo_url;
    assert.equal((await rosterRow(model.id)).photo_url, '',
      'roster: held even though the other declared co-star is cleared');
    const chat = await req(base, 'POST', '/api/conversations/start', { token: fan.token, body: { model_id: model.id } });
    assert.equal(chat.status, 200, `fan chat opens: ${chat.text}`);
    assert.equal(chat.json.conversation.other.photo_url, '',
      'conversation view: the held photo is withheld there too');
    await completePacket(model, cpC.id, true);
    assert.equal((await rosterRow(model.id)).photo_url, mixUrl,
      'the last packet clearing posts the photo');
    const chat2 = await req(base, 'POST', '/api/conversations/start', { token: fan.token, body: { model_id: model.id } });
    assert.equal(chat2.json.conversation.other.photo_url, mixUrl,
      'conversation view: the photo appears once cleared');

    /* ---- the clean public photo: held on the SEO surfaces too ---- */
    const cpD = await addPartner(model, 'Delta Star');
    const pubUp = await mediaUpload(base, '/api/model/public-photo', model.token, 'photo',
      new Blob([PNG], { type: 'image/png' }), 'image/png', 'clean.png', costar(cpD.id));
    assert.equal(pubUp.status, 200, `co-star public photo: ${pubUp.text}`);
    const pubUrl = pubUp.json.public_photo_url;
    const seoHeld = await req(base, 'GET', '/models/csmodel');
    assert.equal(seoHeld.status, 200);
    assert.ok(!seoHeld.text.includes(pubUrl), 'SEO page: the declared clean photo is held');
    await completePacket(model, cpD.id, false);
    const seoFree = await req(base, 'GET', '/models/csmodel');
    assert.ok(seoFree.text.includes(pubUrl), 'SEO page: the photo renders once the packet clears');

    /* ---- consent endpoint guards ---- */
    const fanConsent = await consentUpload(base, cpA.id, fan.token, true);
    assert.equal(fanConsent.status, 403, 'fans cannot attach consent forms');
    const crossConsent = await consentUpload(base, cpA.id, other.token, true);
    assert.equal(crossConsent.status, 404, "another model's co-star is not found, not leaked");
    {
      const fd = new FormData();
      fd.append('consent', new Blob(['plain text'], { type: 'text/plain' }), 'form.txt');
      const badType = await uploadRaw(base, `/api/model/co-performers/${cpA.id}/consent-form`, model.token, fd);
      assert.equal(badType.status, 400, 'a non-photo/non-PDF form is refused');
      assert.equal(badType.json.error, 'bad_file');
    }

    /* ---- solo still posts instantly for a cleared model ---- */
    const soloGal = await mediaUpload(base, '/api/model/gallery-photo', model.token, 'photo',
      new Blob([PNG], { type: 'image/png' }), 'image/png', 'solo2.png', SOLO);
    assert.equal(soloGal.status, 200, `solo gallery upload: ${soloGal.text}`);
    const soloGalUrl = soloGal.json.gallery_photos[soloGal.json.gallery_photos.length - 1];
    assert.ok((await rosterRow(model.id)).gallery_photos.includes(soloGalUrl),
      'solo media on a cleared model is public immediately, exactly as before');

    /* ---- no duplicate people, declarations reference her partners ---- */
    {
      const db = openDb(dir);
      const cps = db.prepare('SELECT COUNT(*) AS n FROM co_performers WHERE owner_model_id = ?').get(model.id);
      assert.equal(cps.n, 4, 'uploads created NO extra co-performer rows — declarations reuse the records');
      const decls = db.prepare('SELECT media_url, co_performer_id FROM media_costars WHERE model_id = ? ORDER BY id').all(model.id);
      assert.equal(decls.length, 5, 'gallery(1) + video(1) + mixed photo(2) + public photo(1) declaration rows');
      assert.deepEqual(decls.map((d) => d.co_performer_id).sort((a, b) => a - b),
        [cpA.id, cpA.id, cpB.id, cpC.id, cpD.id].sort((a, b) => a - b));
      const cols = db.prepare('PRAGMA table_info(id_verifications)').all().map((c) => c.name);
      assert.ok(cols.includes('consent_form_path'), 'the consent column exists after boot (migration applied)');
      db.close();
    }

    /* ---- the house: no prompt, no packet, media public ---- */
    const houseUp = await mediaUpload(base, '/api/model/photo', house.token, 'photo',
      new Blob([PNG], { type: 'image/png' }), 'image/png', 'house.png', null);
    assert.equal(houseUp.status, 200, `house uploads with NO declaration: ${houseUp.text}`);
    const roster = await req(base, 'GET', '/api/models');
    assert.equal(roster.json.official.photo_url, houseUp.json.photo_url,
      'house media is public immediately — exempt from the prompt and both gates');
  } finally {
    stop(h);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
