'use strict';
/*
 * Profile media expansion (owner, Oct 17 2026): "I don't want this to
 * be Instagram. We can allow the two main videos on their profiles.
 * They can do whatever in it — twerk, introduce themselves, whatever.
 * But that's it. Pictures, we can allow them 5-10."
 *
 * The profile page (PR #37) grows from 2 pictures + 1 video to:
 *   - up to 10 pictures: her main photo_url first, then her gallery
 *     uploads (models.gallery_photos, a JSON array on the model row,
 *     same storage pattern as tags). Her clean public photo stays on
 *     the Google pages only and never joins this gallery.
 *   - exactly TWO main videos: Video 1 (preview_video_url, the hero)
 *     and Video 2 (preview_video_url_2, in the scroll region) with
 *     the same tap-to-toggle-sound treatment. There is deliberately
 *     NO third slot.
 * The 10-picture cap is enforced server-side: the upload that would
 * make an 11th picture is rejected (gallery_full) and its file is
 * deleted. Settings manages both videos and the gallery (add/remove
 * with a visible count). A one-time localized announcement DM goes
 * to every model at deploy boot (profile_media_announced_at stamp).
 *
 * Static source pins + functional boots (real uploads against the
 * real endpoints, and a seeded boot for the announcement).
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
const app = fs.readFileSync(path.join(REPO, 'public/js/app.js'), 'utf8');
const css = fs.readFileSync(path.join(REPO, 'public/css/styles.css'), 'utf8');
const server = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');

const pStart = app.indexOf('function openModelPeek(');
const pEnd = app.indexOf('async function vFanModels()', pStart);
assert.ok(pStart !== -1 && pEnd > pStart, 'openModelPeek located in app.js');
const peek = app.slice(pStart, pEnd);

/* ------------------------------ static pins ------------------------------ */

test('schema: second video, gallery list and announcement stamp columns migrate in', () => {
  assert.ok(server.includes("addColumnIfMissing('models', 'preview_video_url_2'"), 'preview_video_url_2 column');
  assert.ok(server.includes("addColumnIfMissing('models', 'gallery_photos'"), 'gallery_photos column');
  assert.ok(server.includes("addColumnIfMissing('platform_stats', 'profile_media_announced_at'"), 'announcement stamp column');
});

test('gallery storage: JSON list of photo-pipeline URLs only, composed with the main photo, capped at 10', () => {
  assert.ok(server.includes('const MAX_PROFILE_PICS = 10;'), 'cap constant is 10');
  assert.ok(server.includes('function parseGalleryPhotos(raw)'), 'parser exists');
  assert.ok(server.includes('GALLERY_PHOTO_RE'), 'stored URLs restricted to the photo pipeline shape');
  assert.ok(server.includes('function profilePicsList(modelRow)'), 'composer exists');
  const composer = server.slice(server.indexOf('function profilePicsList(modelRow)'),
    server.indexOf('function profilePicsList(modelRow)') + 400);
  assert.ok(composer.includes('if (modelRow.photo_url) pics.push(modelRow.photo_url);'), 'main photo first');
  assert.ok(composer.includes('pics.slice(0, MAX_PROFILE_PICS)'), 'composer caps at the max');
});

test('video 2 endpoints mirror video 1; there is no third video slot', () => {
  assert.ok(server.includes("app.post('/api/model/preview-video-2'"), 'video 2 upload endpoint');
  assert.ok(server.includes("app.delete('/api/model/preview-video-2'"), 'video 2 remove endpoint');
  assert.ok(server.includes("UPDATE models SET preview_video_url_2 = ? WHERE user_id = ?"), 'writes target the caller\'s own row');
  assert.ok(!server.includes('preview-video-3'), 'no third video endpoint');
  assert.ok(!server.includes('preview_video_url_3'), 'no third video column anywhere');
});

test('gallery endpoints: add enforces the 10-picture cap server-side; remove is gallery-only', () => {
  const addAt = server.indexOf("app.post('/api/model/gallery-photo'");
  assert.ok(addAt !== -1, 'gallery add endpoint');
  const add = server.slice(addAt, addAt + 1800);
  assert.ok(add.includes('gallery_full'), 'cap rejection carries the gallery_full error');
  assert.ok(add.includes('composed >= MAX_PROFILE_PICS'), 'cap counts main photo + gallery');
  assert.ok(add.includes('fs.unlinkSync(req.file.path)'), 'rejected upload file is deleted (no orphan)');
  const delAt = server.indexOf("app.delete('/api/model/gallery-photo'");
  assert.ok(delAt !== -1, 'gallery remove endpoint');
  const del = server.slice(delAt, delAt + 1200);
  assert.ok(del.includes('not_in_gallery'), 'removing a non-gallery URL 404s');
  assert.ok(del.includes('gallery.filter((u) => u !== url)'), 'removal drops exactly that URL');
});

test('directory payload: second video + parsed gallery ship; the shield withholds both videos', () => {
  const at = server.indexOf("app.get('/api/models'");
  const route = server.slice(at, at + 1600);
  assert.ok(route.includes('m.preview_video_url_2'), 'SELECT includes preview_video_url_2');
  assert.ok(route.includes('m.gallery_photos'), 'SELECT includes gallery_photos');
  assert.ok(server.includes("pub.preview_video_url_2 = '';"), 'shield blanks video 2 like video 1');
  assert.ok(server.includes('gallery_photos: idVerified ? parseGalleryPhotos(rawGallery) : []'), 'payload gallery is a parsed array once her ID is approved, withheld until then (upload gate, Oct 21 2026)');
});

test('orphan sweep counts gallery pictures as current (never deleted as orphans)', () => {
  const at = server.indexOf('const currentPhotos = new Set([');
  const block = server.slice(at, at + 700);
  assert.ok(block.includes('gallery_photos'), 'sweep reads gallery lists');
  assert.ok(block.includes('parseGalleryPhotos(r.gallery_photos)'), 'sweep parses them into the current set');
});

test('announcement: one-time localized broadcast wired at boot', () => {
  assert.ok(server.includes('function announceProfileMediaToModels()'), 'announcement function exists');
  assert.ok(server.includes("srv('ann_profile_media_dm', m.language)"), 'DM copy localized per model');
  assert.ok(server.includes("srv('ann_profile_media_bell_title', m.language)"), 'bell title localized');
  assert.ok(server.includes('announceProfileMediaToModels();'), 'invoked at boot');
  for (const k of ['ann_profile_media_dm', 'ann_profile_media_bell_title', 'ann_profile_media_bell_body']) {
    const line = server.split('\n').find((l) => l.includes(`${k}: {`));
    assert.ok(line, `SRV ${k} row exists`);
    assert.ok(line.includes('en:') && line.includes('tr:'), `SRV ${k} spans the language table`);
  }
});

test('peek: second video renders in the scroll region with the hero sound treatment', () => {
  assert.ok(peek.includes('${m.preview_video_url_2 ?'), 'video 2 block conditional on the field');
  assert.ok(peek.includes('data-peek-video2'), 'video 2 element marked');
  assert.ok(peek.includes('src="${esc(m.preview_video_url_2)}"'), 'video 2 src is escaped');
  assert.ok(peek.includes('data-peek-sound2'), 'video 2 sound pill rendered');
  const galleryAt = peek.indexOf('class="peek-gallery"');
  const video2At = peek.indexOf('data-peek-video2');
  const barAt = peek.indexOf('class="peek-msgbar"');
  assert.ok(video2At > galleryAt, 'video 2 sits below the gallery');
  assert.ok(video2At < barAt, 'video 2 is inside the scroll region (before the pinned bar)');
  assert.ok(peek.includes("sheet.querySelector('[data-peek-video2]')"), 'handler finds video 2');
  assert.ok(peek.includes('pv2.currentTime = 0'), 'unmute restarts video 2 from 0');
  assert.ok(peek.includes('pv2.onclick = togglePeekSound2'), 'video 2 tap wired');
  assert.ok(css.includes('.peek-hero-second'), 'video 2 frame styled');
});

test('settings: video 2 + gallery managers wired to the new endpoints', () => {
  assert.ok(app.includes('id="s-preview-video2"'), 'video 2 upload button');
  assert.ok(app.includes('id="s-preview-remove2"'), 'video 2 remove button');
  assert.ok(app.includes("fetch('/api/model/preview-video-2', { method: 'POST', headers, body: fd })"), 'video 2 upload posts to its endpoint');
  assert.ok(app.includes("fetch('/api/model/preview-video-2', { method: 'DELETE', headers })"), 'video 2 remove deletes via its endpoint');
  assert.ok(app.includes('id="s-gallery-add"'), 'gallery add button');
  assert.ok(app.includes("apiUpload('/model/gallery-photo', cropped, 'photo', declFields(decl))"), 'gallery add uploads via the photo pipeline (with the Solo/Co-Star declaration)');
  assert.ok(app.includes('data-gallery-del="${esc(u)}"'), 'each gallery picture carries a remove control');
  assert.ok(app.includes("method: 'DELETE', headers, body: JSON.stringify({ url: b.dataset.galleryDel })"), 'gallery remove sends the URL');
  assert.ok(app.includes("t('gallery_count', { n: profilePicCount, max: 10 })"), 'visible count of the cap');
  assert.ok(app.includes("t('gallery_main')"), 'main photo badged in the manager');
  assert.ok(css.includes('.set-gallery-grid') && css.includes('.set-gallery-del'), 'gallery manager styled');
});

test('new client strings exist in all 13 language tables', () => {
  for (const k of ['pv2_blurb', 'gallery_h', 'gallery_note', 'gallery_add',
    'gallery_count', 'gallery_main', 'gallery_full', 'gallery_removed']) {
    const hits = app.match(new RegExp(`${k}: '`, 'g')) || [];
    assert.equal(hits.length, 13, `${k} present once per language`);
  }
});

/* --------------------------- functional boots ---------------------------- */

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

async function boot(dir, extraEnv) {
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

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');
const FAKE_MP4 = Buffer.from('AAAAGGZ0eXBpc29tAAAAAmlzb21pc28y', 'base64'); // ftyp box stub; the endpoint checks mimetype only

async function req(base, method, p, { body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = 'Bearer ' + token;
  const r = await fetch(base + p, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
  return { status: r.status, text, json };
}

async function upload(base, p, token, field, blob, filename) {
  const fd = new FormData();
  fd.append(field, blob, filename);
  // Co-Star Upload Prompt (Oct 22 2026): profile-media uploads carry
  // the Solo/Co-Star declaration — these fixtures are all solo shots.
  fd.append('appearance', 'solo');
  const headers = {};
  if (token) headers.authorization = 'Bearer ' + token;
  const r = await fetch(base + p, { method: 'POST', headers, body: fd });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
  return { status: r.status, text, json };
}

test('functional: 10-picture cap (11th rejected), gallery add/remove, video 2 lifecycle', async () => {
  const dir = makeCopy('profilemedia');
  let h = null;
  try {
    h = await boot(dir, {});
    const sfx = Math.random().toString(36).slice(2, 8);
    const mk = async (name, role) => {
      const s = await req(h.base, 'POST', '/api/auth/signup', {
        body: { username: name + sfx, password: 'media-pass-123', role, display_name: name, dob: '1996-04-12', agree18: true, ...(role === 'model' ? { section: 'female' } : {}) },
      });
      assert.equal(s.status, 200, `signup ${name} failed: ${s.text}`);
      return { id: s.json.user.id, token: s.json.token };
    };
    const model = await mk('mediamodel', 'model');
    // Upload gate (Oct 21 2026): directory media requires an approved
    // ID — approve her here so the directory assertions below test
    // the gallery mechanics, not the gate (pinned separately by
    // tests/upload-gate.test.js).
    const gdb = new DatabaseSync(path.join(dir, 'wogent-chat.db'));
    gdb.exec('PRAGMA busy_timeout = 10000');
    gdb.prepare("INSERT INTO id_verifications (model_id, status) VALUES (?, 'approved')").run(model.id);
    gdb.close();
    const fan = await mk('mediafan', 'fan');
    const png = new Blob([PNG_1PX], { type: 'image/png' });
    const mp4 = new Blob([FAKE_MP4], { type: 'video/mp4' });

    // Fans cannot touch the model media endpoints.
    const fanTry = await upload(h.base, '/api/model/gallery-photo', fan.token, 'photo', png, 'pixel.png');
    assert.equal(fanTry.status, 403, 'fan blocked from gallery upload');

    // Main photo first — she counts as picture #1.
    const main = await upload(h.base, '/api/model/photo', model.token, 'photo', png, 'pixel.png');
    assert.equal(main.status, 200, `main photo failed: ${main.text}`);

    // Nine gallery uploads fill her to exactly 10.
    let last = null;
    for (let i = 0; i < 9; i++) {
      last = await upload(h.base, '/api/model/gallery-photo', model.token, 'photo', png, 'pixel.png');
      assert.equal(last.status, 200, `gallery upload ${i + 1} failed: ${last.text}`);
      assert.equal(last.json.count, i + 2, `count after gallery upload ${i + 1}`);
    }
    assert.equal(last.json.gallery_photos.length, 9, 'nine gallery URLs stored');
    assert.equal(last.json.profile_pics.length, 10, 'composed list is 10');
    assert.equal(last.json.profile_pics[0], main.json.photo_url, 'main photo leads the composed list');

    // The 11th picture is rejected, and nothing is stored for it.
    const over = await upload(h.base, '/api/model/gallery-photo', model.token, 'photo', png, 'pixel.png');
    assert.equal(over.status, 400, `11th picture must be rejected: ${over.text}`);
    assert.equal(over.json.error, 'gallery_full', 'rejection is the gallery_full error');

    // Directory payload: gallery array + empty video 2 to start.
    let dir1 = await req(h.base, 'GET', '/api/models');
    let me = dir1.json.models.find((x) => x.id === model.id);
    assert.ok(me, 'model in directory');
    assert.equal(me.gallery_photos.length, 9, 'directory carries the 9 gallery pictures');
    assert.equal(me.preview_video_url_2, '', 'video 2 starts empty');

    // Video 2: upload, replace, remove — one slot throughout.
    const v1 = await upload(h.base, '/api/model/preview-video-2', model.token, 'video', mp4, 'clip.mp4');
    assert.equal(v1.status, 200, `video 2 upload failed: ${v1.text}`);
    assert.ok(v1.json.preview_video_url_2.startsWith('/uploads/preview-'), 'video 2 URL shape');
    const v2 = await upload(h.base, '/api/model/preview-video-2', model.token, 'video', mp4, 'clip.mp4');
    assert.equal(v2.status, 200, 'video 2 replace works');
    assert.notEqual(v2.json.preview_video_url_2, v1.json.preview_video_url_2, 'replace stores a new file');
    dir1 = await req(h.base, 'GET', '/api/models');
    me = dir1.json.models.find((x) => x.id === model.id);
    assert.equal(me.preview_video_url_2, v2.json.preview_video_url_2, 'directory carries video 2');

    // No third slot exists.
    const v3 = await upload(h.base, '/api/model/preview-video-3', model.token, 'video', mp4, 'clip.mp4');
    assert.equal(v3.status, 404, 'a third profile video is impossible');

    // Removing a gallery picture frees a slot; unknown URLs 404.
    const victim = last.json.gallery_photos[0];
    const del = await req(h.base, 'DELETE', '/api/model/gallery-photo', { token: model.token, body: { url: victim } });
    assert.equal(del.status, 200, `gallery remove failed: ${del.text}`);
    assert.equal(del.json.count, 9, 'count drops to 9 after removal');
    const delAgain = await req(h.base, 'DELETE', '/api/model/gallery-photo', { token: model.token, body: { url: victim } });
    assert.equal(delAgain.status, 404, 'removing the same picture twice 404s');
    assert.equal(delAgain.json.error, 'not_in_gallery', 'remove error shape');
    const refill = await upload(h.base, '/api/model/gallery-photo', model.token, 'photo', png, 'pixel.png');
    assert.equal(refill.status, 200, 'freed slot accepts a new picture');
    assert.equal(refill.json.count, 10, 'back to the cap');

    // Video 2 removal clears the slot.
    const vDel = await req(h.base, 'DELETE', '/api/model/preview-video-2', { token: model.token });
    assert.equal(vDel.status, 200, 'video 2 remove works');
    dir1 = await req(h.base, 'GET', '/api/models');
    me = dir1.json.models.find((x) => x.id === model.id);
    assert.equal(me.preview_video_url_2, '', 'video 2 cleared from the directory');
  } finally {
    stop(h);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('announcement: every model DMd exactly once about 10 pictures + two videos, stamp set, no re-send', async () => {
  const dir = makeCopy('profilemediaann');
  try {
    const h1 = await boot(dir, { SEED_DEMO: '1' });
    stop(h1);
    let db = new DatabaseSync(path.join(dir, 'wogent-chat.db'), { readOnly: true });
    const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
    assert.ok(admin, 'seeded admin exists');
    const stamp = db.prepare('SELECT profile_media_announced_at FROM platform_stats WHERE id = 1').get();
    assert.ok(stamp && stamp.profile_media_announced_at, 'announcement stamp is set after first boot');
    const models = db.prepare("SELECT id, username FROM users WHERE role = 'model'").all();
    assert.ok(models.length >= 3, 'seed models exist');
    const countFor = (modelId) => db.prepare(
      `SELECT COUNT(*) AS c FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE c.fan_id = ? AND c.model_id = ? AND m.sender_id = ? AND m.body LIKE '%two profile videos%'`
    ).get(admin.id, modelId, admin.id).c;
    for (const m of models) {
      assert.equal(countFor(m.id), 1, `${m.username} got exactly one announcement`);
      const row = db.prepare(
        `SELECT m.body FROM messages m JOIN conversations c ON c.id = m.conversation_id
         WHERE c.fan_id = ? AND c.model_id = ? AND m.body LIKE '%two profile videos%'`
      ).get(admin.id, m.id);
      assert.ok(row.body.includes('up to 10 of your pictures'), 'picture cap explained');
      assert.ok(row.body.includes('Settings → My photo'), 'settings path present');
    }
    const fan = db.prepare("SELECT id FROM users WHERE role = 'fan' LIMIT 1").get();
    const fanHit = db.prepare(
      `SELECT COUNT(*) AS c FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE (c.fan_id = ? OR c.model_id = ?) AND m.body LIKE '%two profile videos%'`
    ).get(fan.id, fan.id).c;
    assert.equal(fanHit, 0, 'fans receive no announcement');
    db.close();

    const h2 = await boot(dir, { SEED_DEMO: '1' });
    stop(h2);
    db = new DatabaseSync(path.join(dir, 'wogent-chat.db'), { readOnly: true });
    for (const m of models) assert.equal(countFor(m.id), 1, `${m.username} not re-sent on second boot`);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
