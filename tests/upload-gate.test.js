'use strict';
/*
 * UPLOAD GATE (CCBill Self-Attestation commitment, Oct 21 2026).
 *
 * In the Self-Attestation SlutCamp submitted to CCBill, the platform
 * stated it only permits content uploads from verified content
 * providers. The pre-gate build let a model upload media that went
 * public immediately — before her ID was approved. This suite pins
 * the fix that makes the attestation true:
 *
 *  - A model whose ID is NOT approved (no id_verifications row, or a
 *    pending/rejected one) has ALL of her uploaded media withheld
 *    from every public surface: the GET /api/models roster payload
 *    (photo_url, public_photo_url, gallery_photos,
 *    preview_video_url, preview_video_url_2) — which is also the
 *    Discovery + New Models rail + in-app profile data source — the
 *    server-rendered public/SEO pages (which read ONLY
 *    public_photo_url), and the fan/guest conversation view
 *    (otherParty's photo).
 *  - DESIGN DECISION — media blanked, NOT delisted: she stays in the
 *    roster and on her public page (name, bio, prices, schedule,
 *    rank) so fans can find her, message her (chatting was never
 *    ID-gated), and she can finish setting up. Only the uploaded
 *    media waits. Delisting would 404 her profile, break her
 *    recruiting/onboarding links, and remove her from rank
 *    derivations — breakage the attestation never asked for. The
 *    gate consults isIdVerified(), the SAME single point the
 *    going-live and cash-out gates use, so all three gates can never
 *    disagree about what "approved" means — and the house account
 *    passes by its standing short-circuit, with no ID row.
 *  - Her own logged-in view is NOT gated: GET /api/me keeps returning
 *    her real media (profile setup stays fully open — she can upload
 *    and arrange everything; it simply isn't public yet).
 *  - An approved model is byte-for-byte unaffected on every surface,
 *    and the moment an approval lands her media appears with nothing
 *    to re-upload (pinned by the flip at the end of the live test).
 *  - Existing gates untouched: going live + cashing out still refuse
 *    the unapproved (their own suites pin the details; the static
 *    pins here confirm the call sites survive).
 *
 * House harness pattern (payout-id-gate.test.js): static source pins
 * + one functional boot against a throwaway temp copy, media set by
 * direct DB surgery, approvals flipped by direct id_verifications
 * inserts — the same surgery the Manager performs.
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

function sliceFn(src, startMarker, endMarker) {
  const s = src.indexOf(startMarker);
  const e = src.indexOf(endMarker, s);
  assert.ok(s !== -1 && e > s, `located ${startMarker} … ${endMarker}`);
  return src.slice(s, e);
}

/* --------------------------- static pins --------------------------- */

test('server: the roster shaping gates media on isIdVerified (all five fields)', () => {
  const route = sliceFn(serverSrc, "app.get('/api/models',", '// Fan likes/unlikes a model');
  assert.ok(route.includes('const idVerified = isIdVerified(r.id);'),
    'shapeRow consults the single isIdVerified() point per row');
  assert.ok(route.includes("pub.photo_url = ''; pub.public_photo_url = '';"),
    'storefront + clean public photos blanked');
  assert.ok(route.includes("pub.preview_video_url = ''; pub.preview_video_url_2 = '';"),
    'both preview videos blanked');
  assert.ok(route.includes('gallery_photos: idVerified ? parseGalleryPhotos(rawGallery) : []'),
    'gallery withheld as an empty array, parsed as before when approved');
  assert.ok(route.includes('const official = houseRow'),
    'the official object is still shaped from the same function (house passes via the short-circuit)');
});

test('server: the SEO roster gates the clean public photo on isIdVerified', () => {
  const fn = sliceFn(serverSrc, 'function seoPublicModels()', 'const seoTagSlug');
  assert.ok(fn.includes("const pubPhoto = isIdVerified(r.id) ? (r.public_photo_url || '') : '';"),
    'seoPublicModels withholds the photo until approval');
  assert.ok(fn.includes('public_photo_url: pubPhoto,'),
    'the payload field carries the gated value');
  assert.ok(fn.includes("photo_abs: pubPhoto ? SEO_ORIGIN + pubPhoto : SEO_ORIGIN + '/img/lips-logo.png',"),
    'og image falls back to the logo, exactly like a model with no photo');
});

test('server: the conversation other-party photo is gated too', () => {
  const fn = sliceFn(serverSrc, 'function otherParty(conv, ident)', 'function convWhere(ident)');
  assert.ok(fn.includes("const otherPhoto = m && isIdVerified(otherId) ? (m.photo_url || '') : '';"),
    'fan/guest conversation views withhold her photo until approval');
  assert.ok(fn.includes('photo_url: otherPhoto,'),
    'the gated value is what the payload carries');
});

test('server: her own /api/me payload is NOT media-gated', () => {
  const route = sliceFn(serverSrc, "app.get('/api/me',", '/* --- Display name changes');
  assert.ok(route.includes('out.model = mrow;'),
    'her own payload still carries her full models row');
  assert.ok(!route.includes('idVerified') && !route.includes('isIdVerified'),
    'no verification consult inside /api/me — her own view stays open');
});

test('server: the pre-existing live + cash-out ID gates survive untouched', () => {
  assert.ok(serverSrc.includes("app.post('/api/live/start'"), 'live/start route present');
  const wd = sliceFn(serverSrc, "app.post('/api/model/withdrawals'", '\n});');
  assert.ok(wd.includes("req.user.role === 'model' && !isIdVerified(req.user.id)"),
    'withdrawal gate still consults isIdVerified for models');
});

test('recount: the announcement thread-tap pin reads exactly 32 after this build (Clean Feed announcement added one)', () => {
  // tests/notification-thread-tap.test.js pins the global count of
  // server-side '/#chat/${conv.id}' bell links. This build edits
  // server.js, so the count is recounted against the actual tree
  // here: the upload gate adds and removes no bell links; the Clean
  // Feed announcement (Oct 23 2026) added one.
  assert.equal(serverSrc.split('/#chat/${conv.id}').length - 1, 32);
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

// Media filenames follow the real photo-pipeline shape
// (/uploads/photo-<hex>.jpg) — parseGalleryPhotos drops anything
// else, so fabricated URLs must be hex-shaped to survive parsing.
const STEM = { una: 'aaaa', pend: 'bbbb', vera: 'cccc', house: 'dddd' };
const MEDIA = (tag) => ({
  photo_url: `/uploads/photo-${STEM[tag]}01.jpg`,
  public_photo_url: `/uploads/photo-${STEM[tag]}02.jpg`,
  gallery: [`/uploads/photo-${STEM[tag]}03.jpg`, `/uploads/photo-${STEM[tag]}04.jpg`],
  preview_video_url: `/uploads/video-${STEM[tag]}05.mp4`,
  preview_video_url_2: `/uploads/video-${STEM[tag]}06.mp4`,
});
function assertMediaBlank(row, label) {
  assert.equal(row.photo_url, '', `${label}: photo_url withheld`);
  assert.equal(row.public_photo_url, '', `${label}: public_photo_url withheld`);
  assert.deepEqual(row.gallery_photos, [], `${label}: gallery withheld`);
  assert.equal(row.preview_video_url, '', `${label}: preview_video_url withheld`);
  assert.equal(row.preview_video_url_2, '', `${label}: preview_video_url_2 withheld`);
}
function assertMediaIntact(row, media, label) {
  assert.equal(row.photo_url, media.photo_url, `${label}: photo_url byte-for-byte`);
  assert.equal(row.public_photo_url, media.public_photo_url, `${label}: public_photo_url byte-for-byte`);
  assert.deepEqual(row.gallery_photos, media.gallery, `${label}: gallery byte-for-byte`);
  assert.equal(row.preview_video_url, media.preview_video_url, `${label}: preview_video_url byte-for-byte`);
  assert.equal(row.preview_video_url_2, media.preview_video_url_2, `${label}: preview_video_url_2 byte-for-byte`);
}

test('live: unapproved media is public nowhere, approved + house untouched, her own view keeps everything', { timeout: 300000 }, async () => {
  const dir = makeCopy('uploadgate');
  let h = null;
  try {
    h = await boot(dir, { SEED_DEMO: '1' });
    const base = h.base;

    const signup = async (username, role) => {
      const s = await req(base, 'POST', '/api/auth/signup', {
        body: { username, password: 'hunter22', role, display_name: username,
          dob: '1995-05-05', agree18: true, ...(role === 'model' ? { section: 'female' } : {}) },
      });
      assert.equal(s.status, 200, `signup ${username}: ${s.text}`);
      return { token: s.json.token, id: s.json.user.id };
    };
    const una = await signup('upguna', 'model');       // no ID row at all
    const pend = await signup('upgpend', 'model');     // ID submitted, pending
    const vera = await signup('upgvera', 'model');     // ID approved
    const house = await signup('asceaaspade', 'model'); // the house — exempt, no ID row ever
    const fan = await signup('upgfan', 'fan');

    // Media by DB surgery (the payloads are what's gated — no files
    // need to exist), approvals by the same inserts the Manager's
    // approve action effectively performs.
    const wdb = openDb(dir, false);
    const setMedia = (id, tag) => {
      const m = MEDIA(tag);
      wdb.prepare(`UPDATE models SET photo_url = ?, public_photo_url = ?, gallery_photos = ?,
                   preview_video_url = ?, preview_video_url_2 = ? WHERE user_id = ?`)
        .run(m.photo_url, m.public_photo_url, JSON.stringify(m.gallery),
             m.preview_video_url, m.preview_video_url_2, id);
    };
    setMedia(una.id, 'una'); setMedia(pend.id, 'pend');
    setMedia(vera.id, 'vera'); setMedia(house.id, 'house');
    wdb.prepare("INSERT INTO id_verifications (model_id, status) VALUES (?, 'pending')").run(pend.id);
    wdb.prepare("INSERT INTO id_verifications (model_id, status) VALUES (?, 'approved')").run(vera.id);
    assert.equal(wdb.prepare('SELECT COUNT(*) AS n FROM id_verifications WHERE model_id = ?').get(house.id).n, 0,
      'precondition: the house has NO id_verifications row');
    wdb.close();

    /* (a) the roster payload — guest view */
    const guest = await req(base, 'GET', '/api/models');
    assert.equal(guest.status, 200, `guest roster: ${guest.text}`);
    const byId = new Map(guest.json.models.map((m) => [m.id, m]));
    const gUna = byId.get(una.id);
    assert.ok(gUna, 'unapproved model is still LISTED (media gated, not delisted)');
    assert.equal(gUna.display_name, 'upguna', 'her name/bio surface stays public');
    assertMediaBlank(gUna, 'guest roster / unapproved');
    assertMediaBlank(byId.get(pend.id), 'guest roster / pending');
    assertMediaIntact(byId.get(vera.id), MEDIA('vera'), 'guest roster / approved');
    assert.ok(!byId.has(house.id), 'the house never appears as a roster tile');
    assert.ok(guest.json.official, 'the official object is present');
    assert.equal(guest.json.official.id, house.id, 'the official object IS the house');
    assertMediaIntact(guest.json.official, MEDIA('house'), 'guest roster / house official');

    /* (a2) the roster payload — fan view is gated identically */
    const asFan = await req(base, 'GET', '/api/models', { token: fan.token });
    const fanById = new Map(asFan.json.models.map((m) => [m.id, m]));
    assertMediaBlank(fanById.get(una.id), 'fan roster / unapproved');
    assertMediaIntact(fanById.get(vera.id), MEDIA('vera'), 'fan roster / approved');

    /* (a3) the public/SEO pages — model page, hub, sitemap */
    const seoUna = await req(base, 'GET', '/models/upguna');
    assert.equal(seoUna.status, 200, `SEO page for unapproved model still renders: ${seoUna.status}`);
    assert.ok(seoUna.text.includes('upguna'), 'her public page still names her');
    assert.ok(!seoUna.text.includes(MEDIA('una').public_photo_url), 'her clean public photo is nowhere in the page HTML');
    const seoVera = await req(base, 'GET', '/models/upgvera');
    assert.ok(seoVera.text.includes(MEDIA('vera').public_photo_url),
      'approved model: her clean public photo renders on her SEO page');
    const hub = await req(base, 'GET', '/models');
    assert.ok(!hub.text.includes(MEDIA('una').public_photo_url), 'hub: unapproved photo absent');
    assert.ok(hub.text.includes(MEDIA('vera').public_photo_url), 'hub: approved photo present');
    const sitemap = await req(base, 'GET', '/sitemap.xml');
    assert.ok(sitemap.text.includes('/models/upguna'), 'sitemap still lists her page (listed, not delisted)');
    assert.ok(sitemap.text.includes('/models/upgvera'), 'sitemap lists the approved model');

    /* (c) her own logged-in view keeps ALL of her media */
    const me = await req(base, 'GET', '/api/me', { token: una.token });
    assert.equal(me.status, 200, `own /api/me: ${me.text}`);
    assert.equal(me.json.model.photo_url, MEDIA('una').photo_url, 'own view: photo_url intact');
    assert.equal(me.json.model.public_photo_url, MEDIA('una').public_photo_url, 'own view: public_photo_url intact');
    assert.equal(me.json.model.preview_video_url, MEDIA('una').preview_video_url, 'own view: preview 1 intact');
    assert.equal(me.json.model.preview_video_url_2, MEDIA('una').preview_video_url_2, 'own view: preview 2 intact');
    assert.deepEqual(JSON.parse(me.json.model.gallery_photos), MEDIA('una').gallery, 'own view: gallery intact');

    /* (a4) the fan conversation view withholds her photo, approved passes */
    const chatUna = await req(base, 'POST', '/api/conversations/start', { token: fan.token, body: { model_id: una.id } });
    assert.equal(chatUna.status, 200, `fan can still open a chat with her (chatting is not gated): ${chatUna.text}`);
    assert.equal(chatUna.json.conversation.other.photo_url, '', 'chat view: unapproved photo withheld');
    const chatVera = await req(base, 'POST', '/api/conversations/start', { token: fan.token, body: { model_id: vera.id } });
    assert.equal(chatVera.json.conversation.other.photo_url, MEDIA('vera').photo_url,
      'chat view: approved photo present');

    /* the flip: approval lands → media appears everywhere, no re-upload */
    const adb = openDb(dir, false);
    adb.prepare("INSERT INTO id_verifications (model_id, status) VALUES (?, 'approved')").run(una.id);
    adb.close();
    const after = await req(base, 'GET', '/api/models');
    const afterById = new Map(after.json.models.map((m) => [m.id, m]));
    assertMediaIntact(afterById.get(una.id), MEDIA('una'), 'after approval / roster');
    const seoAfter = await req(base, 'GET', '/models/upguna');
    assert.ok(seoAfter.text.includes(MEDIA('una').public_photo_url),
      'after approval: her photo renders on her SEO page');
  } finally {
    stop(h);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
