'use strict';
/*
 * Share-card coverage (Owner, Oct 30 2026, "fix this shit"): the
 * census was 2 of 18 roster cards carrying her media, 16 on the lips
 * logo. Two changes close the gap server-side:
 *
 *  1. SERVER-SIDE POSTER GENERATION. A23b's card derivation reads a
 *     stored poster beside her featured preview video, but only the
 *     client-capture route (#144) ever wrote one — so every video-led
 *     card waited on the model opening her app. ensureVideoPoster
 *     extracts the frame on the server (system ffmpeg, fire-and-
 *     forget, deduped, self-disabling when ffmpeg is absent),
 *     triggered by the preview-video uploads, an idempotent boot
 *     sweep over existing videos, and her public page when its card
 *     still bottoms out at the logo. These tests prove the file
 *     lands WITHOUT any page fetch (upload hook + boot sweep are
 *     observed at the uploads directory, not through the card), and
 *     that the card then carries the poster.
 *
 *  2. photo_url IN THE CARD CHAIN (owner rule change, Oct 30 2026):
 *     the Oct 16 storefront bar is lifted for the share card only —
 *     featured poster → public photo → her eligible profile photo →
 *     clean-feed photo → logo. Gates identical to the public photo:
 *     ID-verified only, blanked when co-star-held. photo_abs and the
 *     page hero are unchanged (seo-pages suite).
 *
 * Harness: the a23b boot-the-real-server pattern with DB surgery.
 * The poster tests need ffmpeg (present on the gate box); they skip
 * cleanly where it is not.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const REPO = path.join(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
const LOGO_ABS = 'https://slutcamp.app/img/lips-logo.png';

/* ---------------- static: wiring ---------------- */

test('static: server-side poster generation is wired at upload, boot and the card page', () => {
  assert.ok(serverSrc.includes('function ensureVideoPoster('), 'the generator exists');
  assert.ok(serverSrc.includes('ensureVideoPoster(preview_video_url);'), 'Video 1 upload triggers it');
  assert.ok(serverSrc.includes('ensureVideoPoster(preview_video_url_2);'), 'Video 2 upload triggers it');
  assert.ok(serverSrc.includes("ensureVideoPoster(r.preview_video_url);"), 'the boot sweep triggers it');
  assert.ok(serverSrc.includes('ensureVideoPoster(vidRow.preview_video_url);'), 'her card page triggers it');
});

test('static: the card chain carries her gated profile photo after the public photo', () => {
  const seo = serverSrc.slice(serverSrc.indexOf('function seoPublicModels()'), serverSrc.indexOf('const seoTagSlug'));
  assert.ok(seo.includes("if (r.photo_url && heldMediaUrls(r.id).has(r.photo_url)) r.photo_url = '';"),
    'a co-star-held profile photo is blanked before the derivation reads it');
  assert.ok(seo.includes("const storePhoto = isIdVerified(r.id) ? (r.photo_url || '') : '';"),
    'the profile photo is ID-gated exactly like the public photo');
  assert.ok(seo.includes('|| (storePhoto ? SEO_ORIGIN + storePhoto : \'\')'),
    'the profile photo sits in the chain (poster → public photo → profile photo → logo)');
  assert.ok(seo.includes("photo_abs: pubPhoto ? SEO_ORIGIN + pubPhoto : SEO_ORIGIN + '/img/lips-logo.png',"),
    'photo_abs (hero) is unchanged — the lift is the card only');
});

/* ---------------- live harness ---------------- */

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

let tmpDir = null;
let child = null;
let base = null;
let childLog = '';
let tinyMp4 = null;
let ffmpegOk = false;
const F = {};

async function boot() {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), CRYPTO_POLL_MS: '3600000' };
  for (const k of Object.keys(env)) {
    if (/^(CCBILL_|CRYPTO_|OPENAI_|TWILIO_|VAPID_|WEBAUTHN_|AV_|SEED_DEMO)/.test(k)) delete env[k];
  }
  childLog = '';
  child = spawn(process.execPath, ['server.js'], { cwd: tmpDir, env });
  child.stdout.on('data', (d) => { childLog += d; });
  child.stderr.on('data', (d) => { childLog += d; });
  base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode})\n${childLog}`);
    try {
      const r = await fetch(base + '/api/health');
      if (r.ok) return;
    } catch (e) { /* not up yet */ }
    if (Date.now() > deadline) { child.kill('SIGKILL'); throw new Error(`server did not come up\n${childLog}`); }
    await new Promise((r) => setTimeout(r, 150));
  }
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
  try { json = JSON.parse(text); } catch (_) { /* HTML */ }
  return { status: r.status, headers: r.headers, text, json };
}

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

async function uploadPhoto(p, token) {
  const fd = new FormData();
  fd.append('photo', new Blob([PNG_1PX], { type: 'image/png' }), 'pixel.png');
  fd.append('appearance', 'solo');
  const r = await fetch(base + p, { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: fd });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
  return { status: r.status, text, json };
}

async function uploadVideo(p, token) {
  const fd = new FormData();
  fd.append('video', new Blob([tinyMp4], { type: 'video/mp4' }), 'clip.mp4');
  fd.append('appearance', 'solo');
  const r = await fetch(base + p, { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: fd });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
  return { status: r.status, text, json };
}

const ogImage = (html) => {
  const m = html.match(/<meta property="og:image" content="([^"]*)">/);
  return m ? m[1] : null;
};

async function waitFor(fn, ms, label) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (fn()) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for: ' + label);
    await new Promise((r) => setTimeout(r, 250));
  }
}

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-cardcov-'));
  for (const d of ['server.js', 'package.json', 'lib', 'public', 'data']) {
    fs.cpSync(path.join(REPO, d), path.join(tmpDir, d), { recursive: true });
  }
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(tmpDir, 'node_modules'), 'dir');

  // A real, tiny mp4 for the poster fixtures (lavfi color source).
  try {
    const mp4Path = path.join(tmpDir, 'tiny.mp4');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=0x8833aa:s=64x64:d=1:r=10',
      '-pix_fmt', 'yuv420p', '-y', mp4Path], { timeout: 20000 });
    tinyMp4 = fs.readFileSync(mp4Path);
    ffmpegOk = tinyMp4.length > 0;
  } catch (e) { ffmpegOk = false; }

  await boot();
  const suffix = Math.random().toString(36).slice(2, 8);
  const mkModel = async (name, display) => {
    const username = name + suffix;
    const s = await req('POST', '/api/auth/signup', {
      body: { username, password: 'cardcov-pass-123', role: 'model', publicity_consent: true,
        display_name: display, dob: '1996-04-12', agree18: true, section: 'female' },
    });
    assert.equal(s.status, 200, `signup ${username} failed: ${s.text}`);
    return { username, id: s.json.user.id, token: s.json.token };
  };

  // onlyphoto: approved, profile photo ONLY → card = photo_url.
  F.onlyphoto = await mkModel('covphoto', 'Photo Only');
  const upP = await uploadPhoto('/api/model/photo', F.onlyphoto.token);
  assert.equal(upP.status, 200, `photo upload: ${upP.text}`);
  F.onlyphoto.photoUrl = upP.json.photo_url;

  // unappphoto: profile photo, ID never approved → card stays logo.
  F.unappphoto = await mkModel('covunapp', 'Unapproved Photo');
  const upU = await uploadPhoto('/api/model/photo', F.unappphoto.token);
  assert.equal(upU.status, 200, `unapp upload: ${upU.text}`);
  F.unappphoto.photoUrl = upU.json.photo_url;

  // heldphoto: approved, profile photo co-star-held → card stays logo.
  F.heldphoto = await mkModel('covheld', 'Held Photo');
  const upH = await uploadPhoto('/api/model/photo', F.heldphoto.token);
  assert.equal(upH.status, 200, `held upload: ${upH.text}`);
  F.heldphoto.photoUrl = upH.json.photo_url;

  // posterup: approved; uploads her preview video AFTER the reboot —
  // the upload hook must generate the poster with no page fetch.
  F.posterup = await mkModel('covup', 'Poster Upload');

  // sweep: approved; her preview video is planted by surgery (file +
  // DB row) before the reboot — the boot sweep must generate it.
  F.sweep = await mkModel('covsweep', 'Poster Sweep');
  F.sweep.stem = 'preview-' + 'f'.repeat(32);
  F.sweep.videoUrl = '/uploads/' + F.sweep.stem + '.mp4';
  F.sweep.posterUrl = '/uploads/' + F.sweep.stem + '.jpg';

  await killServer();
  const db = new DatabaseSync(path.join(tmpDir, 'wogent-chat.db'));
  db.exec('PRAGMA busy_timeout = 10000');
  for (const m of [F.onlyphoto, F.heldphoto, F.posterup, F.sweep]) {
    db.prepare("INSERT INTO id_verifications (model_id, status) VALUES (?, 'approved')").run(m.id);
  }
  const cp = db.prepare("INSERT INTO co_performers (owner_model_id, display_name, status) VALUES (?, 'Partner', 'pending')").run(F.heldphoto.id);
  db.prepare('INSERT INTO media_costars (model_id, media_url, co_performer_id) VALUES (?, ?, ?)')
    .run(F.heldphoto.id, F.heldphoto.photoUrl, Number(cp.lastInsertRowid));
  if (ffmpegOk) {
    const upDir = path.join(tmpDir, 'uploads');
    fs.mkdirSync(upDir, { recursive: true });
    fs.writeFileSync(path.join(upDir, F.sweep.stem + '.mp4'), tinyMp4);
    db.prepare('UPDATE models SET preview_video_url = ? WHERE user_id = ?').run(F.sweep.videoUrl, F.sweep.id);
  }
  db.close();

  await boot();
});

test.after(async () => {
  await killServer();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

/* ---------------- live: photo_url in the card chain ---------------- */

test('live: eligible model with ONLY a profile photo gets it on her card', async () => {
  const page = await req('GET', '/models/' + F.onlyphoto.username);
  assert.equal(page.status, 200);
  assert.equal(ogImage(page.text), 'https://slutcamp.app' + F.onlyphoto.photoUrl,
    'og:image = her profile photo (the directory tile photo)');
  assert.ok(page.text.includes('<img class="photo" src="/img/lips-logo.png"'),
    'hero unchanged — the lift is the card only');
});

test('live: unapproved model with a profile photo stays on the logo', async () => {
  const page = await req('GET', '/models/' + F.unappphoto.username);
  assert.equal(page.status, 200);
  assert.equal(ogImage(page.text), LOGO_ABS, 'unapproved profile photo never reaches the card');
});

test('live: co-star-held profile photo stays on the logo', async () => {
  const page = await req('GET', '/models/' + F.heldphoto.username);
  assert.equal(page.status, 200);
  assert.equal(ogImage(page.text), LOGO_ABS, 'a held profile photo is withheld media → logo');
});

/* ---------------- live: server-side poster generation ---------------- */

test('live: boot sweep generates the poster for a pre-existing preview video', async (t) => {
  if (!ffmpegOk) return t.skip('ffmpeg unavailable on this box');
  const posterPath = path.join(tmpDir, 'uploads', F.sweep.stem + '.jpg');
  // Observed at the FILE level, before any page fetch: only the
  // boot sweep can have made this file.
  await waitFor(() => fs.existsSync(posterPath) && fs.statSync(posterPath).size > 0,
    20000, 'boot-sweep poster file');
  const page = await req('GET', '/models/' + F.sweep.username);
  assert.equal(page.status, 200);
  assert.equal(ogImage(page.text), 'https://slutcamp.app' + F.sweep.posterUrl,
    'her card now carries the server-generated poster');
  const poster = await req('GET', F.sweep.posterUrl);
  assert.equal(poster.status, 200, 'the generated poster is actually served');
});

test('live: preview-video upload generates its poster server-side', async (t) => {
  if (!ffmpegOk) return t.skip('ffmpeg unavailable on this box');
  const up = await uploadVideo('/api/model/preview-video', F.posterup.token);
  assert.equal(up.status, 200, `video upload: ${up.text}`);
  const videoUrl = up.json.preview_video_url;
  const stem = videoUrl.replace('/uploads/', '').replace('.mp4', '');
  const posterPath = path.join(tmpDir, 'uploads', stem + '.jpg');
  // File-level again: the upload hook, not a page view, made this.
  await waitFor(() => fs.existsSync(posterPath) && fs.statSync(posterPath).size > 0,
    20000, 'upload-hook poster file');
  const page = await req('GET', '/models/' + F.posterup.username);
  assert.equal(ogImage(page.text), 'https://slutcamp.app/uploads/' + stem + '.jpg',
    'her card carries the generated poster');
});
