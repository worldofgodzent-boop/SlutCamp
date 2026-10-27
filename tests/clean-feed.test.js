'use strict';
/*
 * Clean public feed (Clean Model Feed, Oct 23 2026) — an Instagram-
 * style feed of CLEAN posts (12 slots per model: 10 pictures + 2
 * videos) on SlutCamp's public surfaces: her server-rendered page
 * (/models/:username), the public /feed stream, and her in-app
 * profile peek (GET /api/models/:id/feed). The feed is a DEDICATED
 * media set (clean_feed_items), separate from her in-app profile
 * media, which may be explicit by design and never crosses to
 * public pages. Public reads stack the standing gates: her ID
 * approved (PR #81), co-star media held until each co-star's packet
 * is complete + Manager-approved (PR #83), and the house flag.
 *
 * HOUSE FLAG — decided by Asce, Oct 23 2026 ("House accounts stays
 * private"): HOUSE_IN_PUBLIC_FEED_AND_INDEX = false keeps the house
 * account (asceaaspade) OUT of the feed and OUT of the public index
 * (/models grid, tag hubs, sitemap); its own page still serves.
 *
 * Harness: the tests/seo-pages.test.js pattern — boot the real
 * server from a temp copy, fixtures by real signup + real uploads,
 * then a kill → DB-surgery → reboot step for the fixtures no API
 * creates (an approved ID, a completed co-star packet).
 *
 * Fixtures:
 *   feedstar<sfx> — model who posts a solo photo, a solo video and
 *                   a co-star photo while her ID is UNAPPROVED:
 *                   nothing is public until surgery approves her ID
 *                   and completes the co-star packet.
 *   feedcap<sfx>  — model who fills the feed: the 11th photo and
 *                   the 3rd video are refused (feed_full_*).
 *   asceaaspade   — the house account itself (real signup; the seed
 *                   has none): uploads WITHOUT a declaration (the
 *                   house exemption) and must stay invisible on
 *                   every public surface under the flag.
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
const SERVER = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
const APP = fs.readFileSync(path.join(REPO, 'public/js/app.js'), 'utf8');

let tmpDir = null;
let child = null;
let base = null;
let childLog = '';

const F = {};

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

async function req(method, p, { body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = 'Bearer ' + token;
  const r = await fetch(base + p, {
    method, headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* HTML or empty */ }
  return { status: r.status, headers: r.headers, text, json };
}

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');
const FAKE_MP4 = Buffer.from('AAAAGGZ0eXBpc29tAAAAAmlzb21pc28y', 'base64');

// Feed upload through the real endpoints. appearance: 'solo' |
// 'costar:<id>' | null (no declaration field at all).
async function feedUpload(token, kind, appearance) {
  const fd = new FormData();
  if (kind === 'photo') {
    fd.append('photo', new Blob([PNG_1PX], { type: 'image/png' }), 'pixel.png');
  } else {
    fd.append('video', new Blob([FAKE_MP4], { type: 'video/mp4' }), 'clip.mp4');
  }
  if (appearance === 'solo') fd.append('appearance', 'solo');
  else if (appearance && appearance.startsWith('costar:')) {
    fd.append('appearance', 'costar');
    fd.append('costar_ids', JSON.stringify([Number(appearance.slice('costar:'.length))]));
  }
  const headers = {};
  if (token) headers.authorization = 'Bearer ' + token;
  const r = await fetch(base + `/api/model/feed/${kind}`, { method: 'POST', headers, body: fd });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
  return { status: r.status, text, json };
}

async function waitForServer(deadlineMs = 60000) {
  const start = Date.now();
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early with code ${child.exitCode}\n--- server log ---\n${childLog}`);
    }
    try {
      const r = await fetch(base + '/api/credits/packages');
      if (r.status === 200) return;
    } catch (_) { /* not up yet */ }
    if (Date.now() - start > deadlineMs) {
      throw new Error(`server did not respond within ${deadlineMs}ms\n--- server log ---\n${childLog}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function boot() {
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const port = await freePort();
    const env = { ...process.env, PORT: String(port), CRYPTO_POLL_MS: '3600000', SEED_DEMO: '1' };
    for (const k of Object.keys(env)) {
      if (/^(CCBILL_|CRYPTO_|OPENAI_|TWILIO_|VAPID_)/.test(k)) delete env[k];
    }
    childLog = '';
    child = spawn(process.execPath, ['server.js'], { cwd: tmpDir, env });
    child.stdout.on('data', (d) => { childLog += d; });
    child.stderr.on('data', (d) => { childLog += d; });
    base = `http://127.0.0.1:${port}`;
    try {
      await waitForServer();
      return;
    } catch (e) {
      lastErr = e;
      base = null;
      if (child && child.exitCode === null) child.kill('SIGKILL');
      child = null;
    }
  }
  throw lastErr || new Error('server failed to boot after 3 attempts');
}

async function killServer() {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((r) => child.once('exit', r)),
      new Promise((r) => setTimeout(r, 5000)),
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  child = null;
}

async function mkModel(username, display) {
  const s = await req('POST', '/api/auth/signup', {
    body: { username, password: 'feed-pass-123', role: 'model', publicity_consent: true, display_name: display, dob: '1996-04-12', agree18: true, section: 'female' },
  });
  assert.equal(s.status, 200, `signup ${username} failed: ${s.text}`);
  return { username, id: s.json.user.id, token: s.json.token };
}

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-cleanfeed-'));
  for (const f of ['server.js', 'package.json']) {
    fs.copyFileSync(path.join(REPO, f), path.join(tmpDir, f));
  }
  for (const d of ['lib', 'public', 'data']) {
    fs.cpSync(path.join(REPO, d), path.join(tmpDir, d), { recursive: true });
  }
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(tmpDir, 'node_modules'), 'dir');

  await boot();
  const suffix = Math.random().toString(36).slice(2, 8);

  F.star = await mkModel('feedstar' + suffix, 'Feed Star');
  F.cap = await mkModel('feedcap' + suffix, 'Feed Cap');
  F.house = await mkModel('asceaaspade', 'Asce AA Spade');

  // feedstar posts while her ID is unapproved: a solo photo, a solo
  // video, and a photo declaring her registered co-star.
  const p1 = await feedUpload(F.star.token, 'photo', 'solo');
  assert.equal(p1.status, 200, `feed photo upload: ${p1.text}`);
  F.star.photoUrl = p1.json.item.url;
  assert.ok(F.star.photoUrl.startsWith('/uploads/photo-'), 'feed photos ride the photo pipeline');
  const v1 = await feedUpload(F.star.token, 'video', 'solo');
  assert.equal(v1.status, 200, `feed video upload: ${v1.text}`);
  F.star.videoUrl = v1.json.item.url;
  assert.ok(F.star.videoUrl.startsWith('/uploads/preview-'), 'feed videos ride the preview-video pipeline');

  const cp = await req('POST', '/api/model/co-performers', {
    token: F.star.token,
    body: { display_name: 'Feed Pal', gender: 'female', dob: '1998-03-04', agree18: true },
  });
  assert.equal(cp.status, 200, `co-star register: ${cp.text}`);
  F.star.cpId = cp.json.co_performer.id;
  const p2 = await feedUpload(F.star.token, 'photo', `costar:${F.star.cpId}`);
  assert.equal(p2.status, 200, `co-star feed photo: ${p2.text}`);
  assert.equal(p2.json.costar_held, true, 'a declared co-star photo is held until her packet clears');
  F.star.costarUrl = p2.json.item.url;

  // The house posts WITHOUT any declaration — exempt, as always.
  const hp = await feedUpload(F.house.token, 'photo', null);
  assert.equal(hp.status, 200, `house feed upload (no declaration): ${hp.text}`);
  F.house.photoUrl = hp.json.item.url;
});

test.after(async () => { await killServer(); });

/* ---------------- phase 1: the gates hold everything back -------- */

test('owner sees her posts; the public sees nothing before ID approval', async () => {
  const own = await req('GET', '/api/model/feed', { token: F.star.token });
  assert.equal(own.status, 200);
  assert.equal(own.json.items.length, 3, 'owner list carries all three posts');
  assert.equal(own.json.max_photos, 10);
  assert.equal(own.json.max_videos, 2);
  const held = Object.fromEntries(own.json.items.map((i) => [i.url, i.held]));
  assert.equal(held[F.star.photoUrl], false, 'solo photo is not co-star held');
  assert.equal(held[F.star.costarUrl], true, 'co-star photo is flagged held for the owner');

  const pub = await req('GET', `/api/models/${F.star.id}/feed`);
  assert.equal(pub.status, 200);
  assert.deepEqual(pub.json.items, [], 'ID unapproved: the public feed API is empty');

  const page = await req('GET', `/models/${F.star.username}`);
  assert.equal(page.status, 200, 'her public page serves (the PR #81 gate withholds media, not the page)');
  assert.ok(!page.text.includes(F.star.photoUrl), 'but it carries no feed photo before ID approval');
  assert.ok(!page.text.includes('<h2 class="feedh">'), 'and no feed section renders while nothing is cleared');

  const stream = await req('GET', '/feed');
  assert.equal(stream.status, 200);
  assert.ok(!stream.text.includes(F.star.photoUrl), 'the /feed stream carries none of her posts yet');
});

test('a feed upload without the Solo/Co-Star declaration is refused', async () => {
  const noDecl = await feedUpload(F.star.token, 'photo', null);
  assert.equal(noDecl.status, 400);
  assert.equal(noDecl.json.error, 'appearance_required');
  const fan = await req('POST', '/api/auth/signup', {
    body: { username: 'feedfan' + Math.random().toString(36).slice(2, 8), password: 'feed-pass-123', role: 'fan', display_name: 'Feed Fan', dob: '1996-04-12', agree18: true },
  });
  assert.equal(fan.status, 200);
  const fanUp = await feedUpload(fan.json.token, 'photo', 'solo');
  assert.equal(fanUp.status, 403, 'fans cannot post to a feed');
});

test('the 12 slots are enforced: 10 pictures + 2 videos, no more', async () => {
  for (let i = 0; i < 10; i++) {
    const r = await feedUpload(F.cap.token, 'photo', 'solo');
    assert.equal(r.status, 200, `photo ${i + 1}: ${r.text}`);
  }
  const p11 = await feedUpload(F.cap.token, 'photo', 'solo');
  assert.equal(p11.status, 400);
  assert.equal(p11.json.error, 'feed_full_photos');
  for (let i = 0; i < 2; i++) {
    const r = await feedUpload(F.cap.token, 'video', 'solo');
    assert.equal(r.status, 200, `video ${i + 1}: ${r.text}`);
  }
  const v3 = await feedUpload(F.cap.token, 'video', 'solo');
  assert.equal(v3.status, 400);
  assert.equal(v3.json.error, 'feed_full_videos');
  const own = await req('GET', '/api/model/feed', { token: F.cap.token });
  assert.equal(own.json.items.filter((i) => i.kind === 'photo').length, 10);
  assert.equal(own.json.items.filter((i) => i.kind === 'video').length, 2);
});

test('the house is out of the feed and the public index under the flag', async () => {
  const own = await req('GET', '/api/model/feed', { token: F.house.token });
  assert.equal(own.json.items.length, 1, 'the house manages its own posts normally');

  const pub = await req('GET', `/api/models/${F.house.id}/feed`);
  assert.equal(pub.status, 200);
  assert.deepEqual(pub.json.items, [], 'house feed API answers empty under the flag');

  const index = await req('GET', '/models');
  assert.equal(index.status, 200);
  assert.ok(!index.text.includes('asceaaspade'), 'the house is off the /models index');

  const sm = await req('GET', '/sitemap.xml');
  assert.equal(sm.status, 200);
  assert.ok(!sm.text.includes('/models/asceaaspade'), 'the house is out of the sitemap');
  assert.ok(sm.text.includes('/feed'), 'the /feed stream itself is in the sitemap');

  const page = await req('GET', '/models/asceaaspade');
  assert.equal(page.status, 200, 'index exclusion never unpublishes the house page');
  assert.ok(!page.text.includes(F.house.photoUrl), 'the house page renders no feed posts');
  assert.ok(!page.text.includes('<h2 class="feedh">'), 'no feed section on the house page');

  const stream = await req('GET', '/feed');
  assert.ok(!stream.text.includes(F.house.photoUrl), 'the house is out of the /feed stream');
});

/* ---------------- surgery: approve + complete the packet --------- */

test('surgery: ID approval + completed co-star packet (and the migration + announcement landed)', async () => {
  await killServer();
  const db = new DatabaseSync(path.join(tmpDir, 'wogent-chat.db'));
  db.exec('PRAGMA busy_timeout = 10000');
  // Previous-schema migration: a database booted by the OLD code
  // has no clean_feed_items table and no announcement stamp column;
  // the new boot created both (the boot in test.before ran against
  // exactly such a fresh DB).
  const tbl = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='clean_feed_items'").get();
  assert.ok(tbl, 'clean_feed_items was created at boot (CREATE TABLE IF NOT EXISTS)');
  const st = db.prepare('SELECT clean_feed_announced_at FROM platform_stats WHERE id = 1').get();
  assert.ok(st && st.clean_feed_announced_at, 'the one-time announcement stamp is set');
  // The blast fired at first boot (before these fixtures signed up —
  // the battles precedent: seed models got it). {username} must have
  // been substituted with each model's own page link.
  const dm = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE body LIKE '%CLEAN FEED%' AND body LIKE '%https://slutcamp.app/models/%'").get();
  assert.ok(dm.n >= 1, 'seed models got the announcement DM with a real page link');
  const raw = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE body LIKE '%{username}%'").get();
  assert.equal(raw.n, 0, 'no DM carries the raw {username} placeholder');
  db.prepare("INSERT INTO id_verifications (model_id, status) VALUES (?, 'approved')").run(F.star.id);
  db.prepare('UPDATE co_performers SET status = ? WHERE id = ?').run('approved', F.star.cpId);
  db.prepare(`INSERT INTO id_verifications (model_id, co_performer_id, status, id_front_path, id_back_path, selfie_path, consent_form_path)
              VALUES (?, ?, 'approved', 'front.jpg', 'back.jpg', 'selfie.jpg', 'consent.pdf')`)
    .run(F.star.id, F.star.cpId);
  db.close();
  await boot();
});

/* ---------------- phase 2: cleared media posts everywhere -------- */

test('after approval her cleared posts render on every public surface', async () => {
  const pub = await req('GET', `/api/models/${F.star.id}/feed`);
  assert.equal(pub.json.items.length, 3, 'photo + video + cleared co-star photo are public');
  const urls = pub.json.items.map((i) => i.url);
  assert.ok(urls.includes(F.star.photoUrl) && urls.includes(F.star.videoUrl) && urls.includes(F.star.costarUrl));

  const page = await req('GET', `/models/${F.star.username}`);
  assert.ok(page.text.includes('<h2 class="feedh">'), 'her public page renders the feed section');
  assert.ok(page.text.includes(F.star.photoUrl), 'page: solo photo');
  assert.ok(page.text.includes(F.star.videoUrl), 'page: solo video');
  assert.ok(page.text.includes(F.star.costarUrl), 'page: co-star photo posts once her packet clears');

  const stream = await req('GET', '/feed');
  assert.ok(stream.text.includes(F.star.photoUrl), 'stream: her photo is in the Female feed');
  assert.ok(stream.text.includes(`/models/${F.star.username}`), 'stream cards lead to her page');
  const male = await req('GET', '/feed?section=male');
  assert.ok(!male.text.includes(F.star.photoUrl), 'sections hold: she is not in the Male feed');
  assert.ok(!stream.text.includes(F.house.photoUrl), 'the house stays out of the stream');
});

test('deleting a post removes it everywhere', async () => {
  const own = await req('GET', '/api/model/feed', { token: F.star.token });
  const solo = own.json.items.find((i) => i.url === F.star.photoUrl);
  const del = await req('DELETE', `/api/model/feed/${solo.id}`, { token: F.star.token });
  assert.equal(del.status, 200);
  const pub = await req('GET', `/api/models/${F.star.id}/feed`);
  assert.equal(pub.json.items.length, 2);
  assert.ok(!pub.json.items.some((i) => i.url === F.star.photoUrl), 'deleted post leaves the public feed');
  const ownAfter = await req('GET', '/api/model/feed', { token: F.star.token });
  assert.equal(ownAfter.json.items.length, 2);
  const cross = await req('DELETE', `/api/model/feed/${ownAfter.json.items[0].id}`, { token: F.cap.token });
  assert.equal(cross.status, 404, "another model cannot delete her posts");
  const missing = await req('GET', '/api/models/999999/feed');
  assert.equal(missing.status, 404, 'an unknown model has no feed');
});

/* ---------------- static pins ------------------------------------ */

test('static pins: the flag, the shaping, the surfaces, STR ×13', () => {
  assert.ok(SERVER.includes('const HOUSE_IN_PUBLIC_FEED_AND_INDEX = false'),
    'the house flag exists and defaults to house EXCLUDED');
  assert.ok(SERVER.includes('function cleanFeedItemsFor('), 'one shaping function for every surface');
  assert.ok(SERVER.includes('function cleanFeedStream('), 'the stream builder exists');
  assert.ok(SERVER.includes("app.get('/feed'"), 'the public /feed route exists');
  assert.ok(SERVER.includes("app.get('/api/models/:id/feed'"), 'the public feed API exists');
  assert.ok(SERVER.includes("app.post('/api/model/feed/photo'"), 'the photo upload route exists');
  assert.ok(SERVER.includes("app.post('/api/model/feed/video'"), 'the video upload route exists');
  assert.ok(SERVER.includes("app.delete('/api/model/feed/:itemId'"), 'the delete route exists');
  assert.ok(SERVER.includes('CREATE TABLE IF NOT EXISTS clean_feed_items'),
    'the table migrates previous-schema databases at boot');
  assert.ok(SERVER.includes('clean_feed_announced_at'), 'the announcement stamp exists');
  assert.ok(SERVER.includes('ann_cleanfeed_dm'), 'the announcement copy exists');
  // seoPublicModels itself is untouched — the index consumers filter
  // AFTER it (the storefront-sections pin on its body stays valid).
  const body = SERVER.slice(SERVER.indexOf('function seoPublicModels()'), SERVER.indexOf('const seoTagSlug'));
  assert.ok(!body.includes('seoIndexVisible'), 'seoPublicModels body is unmodified');
  assert.ok(!body.includes('cleanFeed'), 'seoPublicModels knows nothing of the feed');
  assert.ok(APP.includes('id="peek-feed"'), 'the peek renders the feed');
  assert.ok(APP.includes('loadPeekFeed'), 'the peek loader exists');
  assert.ok(APP.includes('id="cleanfeed-box"'), 'Settings carries the feed manager');
  assert.ok(APP.includes('loadCleanFeedSettings'), 'the Settings loader exists');
  for (const k of ['feed_h', 'feed_note', 'feed_add_photo', 'feed_add_video', 'feed_count',
    'feed_full', 'feed_removed', 'feed_empty', 'feed_posted']) {
    assert.equal((APP.match(new RegExp(`${k}:`, 'g')) || []).length, 13, `STR ${k} exists in all 13 languages`);
  }
});
