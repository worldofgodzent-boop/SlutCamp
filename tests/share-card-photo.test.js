'use strict';
/*
 * Share-card photo chain (Owner rule change, Oct 30 2026): the
 * Oct 16 storefront-photo bar is LIFTED for the share card only.
 * The share_image_abs chain is now: her featured preview video's
 * stored poster → her eligible public photo → her eligible PROFILE
 * photo (photo_url — the image her directory tile renders) → her
 * first clean-feed photo (page route) → the lips logo.
 *
 * Eligibility for photo_url is IDENTICAL to public_photo_url:
 * ID-verified only (isIdVerified), blanked when co-star-held
 * (heldMediaUrls). photo_abs is unchanged; the public page hero
 * now renders share_image_abs too (owner hero follow-up, Oct 30
 * 2026, late — pinned by seo-pages and the live tests below).
 *
 * These three live tests pin the new step of the chain: an eligible
 * photo-only model gets her photo on the card; an unapproved one
 * stays on the logo; a co-star-held one stays on the logo.
 * Harness: the a23b boot-the-real-server pattern with DB surgery.
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
const LOGO_ABS = 'https://slutcamp.app/img/lips-logo.png';

test('static: the card chain carries her gated profile photo after the public photo', () => {
  const seo = serverSrc.slice(serverSrc.indexOf('function seoPublicModels()'), serverSrc.indexOf('const seoTagSlug'));
  assert.ok(seo.includes('m.photo_url'), 'seoPublicModels selects her profile photo');
  assert.ok(seo.includes("if (r.photo_url && heldMediaUrls(r.id).has(r.photo_url)) r.photo_url = '';"),
    'a co-star-held profile photo is blanked before the derivation reads it');
  assert.ok(seo.includes("const storePhoto = isIdVerified(r.id) ? (r.photo_url || '') : '';"),
    'the profile photo is ID-gated exactly like the public photo');
  assert.ok(seo.includes('|| (storePhoto ? SEO_ORIGIN + storePhoto : \'\')'),
    'the profile photo sits in the chain (poster → public photo → profile photo → logo)');
  assert.ok(seo.includes("photo_abs: pubPhoto ? SEO_ORIGIN + pubPhoto : SEO_ORIGIN + '/img/lips-logo.png',"),
    'photo_abs derivation is unchanged — the hero reads share_image_abs; photo_abs itself is untouched');
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

async function uploadPhoto(token) {
  const fd = new FormData();
  fd.append('photo', new Blob([PNG_1PX], { type: 'image/png' }), 'pixel.png');
  fd.append('appearance', 'solo');
  const r = await fetch(base + '/api/model/photo', { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: fd });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
  return { status: r.status, text, json };
}

const ogImage = (html) => {
  const m = html.match(/<meta property="og:image" content="([^"]*)">/);
  return m ? m[1] : null;
};

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-cardphoto-'));
  for (const d of ['server.js', 'package.json', 'lib', 'public', 'data']) {
    fs.cpSync(path.join(REPO, d), path.join(tmpDir, d), { recursive: true });
  }
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(tmpDir, 'node_modules'), 'dir');

  await boot();
  const suffix = Math.random().toString(36).slice(2, 8);
  const mkModel = async (name, display) => {
    const username = name + suffix;
    const s = await req('POST', '/api/auth/signup', {
      body: { username, password: 'cardphoto-pass-123', role: 'model', publicity_consent: true,
        display_name: display, dob: '1996-04-12', agree18: true, section: 'female' },
    });
    assert.equal(s.status, 200, `signup ${username} failed: ${s.text}`);
    return { username, id: s.json.user.id, token: s.json.token };
  };

  F.onlyphoto = await mkModel('cardphoto', 'Photo Only');
  const upP = await uploadPhoto(F.onlyphoto.token);
  assert.equal(upP.status, 200, `photo upload: ${upP.text}`);
  F.onlyphoto.photoUrl = upP.json.photo_url;

  F.unappphoto = await mkModel('cardunapp', 'Unapproved Photo');
  const upU = await uploadPhoto(F.unappphoto.token);
  assert.equal(upU.status, 200, `unapp upload: ${upU.text}`);
  F.unappphoto.photoUrl = upU.json.photo_url;

  F.heldphoto = await mkModel('cardheld', 'Held Photo');
  const upH = await uploadPhoto(F.heldphoto.token);
  assert.equal(upH.status, 200, `held upload: ${upH.text}`);
  F.heldphoto.photoUrl = upH.json.photo_url;

  await killServer();
  const db = new DatabaseSync(path.join(tmpDir, 'wogent-chat.db'));
  db.exec('PRAGMA busy_timeout = 10000');
  for (const m of [F.onlyphoto, F.heldphoto]) {
    db.prepare("INSERT INTO id_verifications (model_id, status) VALUES (?, 'approved')").run(m.id);
  }
  const cp = db.prepare("INSERT INTO co_performers (owner_model_id, display_name, status) VALUES (?, 'Partner', 'pending')").run(F.heldphoto.id);
  db.prepare('INSERT INTO media_costars (model_id, media_url, co_performer_id) VALUES (?, ?, ?)')
    .run(F.heldphoto.id, F.heldphoto.photoUrl, Number(cp.lastInsertRowid));
  db.close();

  await boot();
});

test.after(async () => {
  await killServer();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

/* ---------------- live: the three gates on the new chain step ---------------- */

test('live: eligible model with ONLY a profile photo gets it on her card', async () => {
  const page = await req('GET', '/models/' + F.onlyphoto.username);
  assert.equal(page.status, 200);
  assert.equal(ogImage(page.text), 'https://slutcamp.app' + F.onlyphoto.photoUrl,
    'og:image = her profile photo (the directory tile photo)');
  assert.ok(page.text.includes(`<meta name="twitter:image" content="https://slutcamp.app${F.onlyphoto.photoUrl}">`),
    'twitter:image matches');
  assert.ok(page.text.includes(`<img class="photo" src="https://slutcamp.app${F.onlyphoto.photoUrl}"`),
    'hero carries the same gated profile photo — not the logo (owner hero follow-up, Oct 30 2026)');
});

test('live: unapproved model with a profile photo stays on the logo', async () => {
  const page = await req('GET', '/models/' + F.unappphoto.username);
  assert.equal(page.status, 200);
  assert.equal(ogImage(page.text), LOGO_ABS, 'unapproved profile photo never reaches the card');
  assert.ok(page.text.includes(`<img class="photo" src="${LOGO_ABS}"`),
    'hero stays on the logo too — unapproved media never leads her page');
});

test('live: co-star-held profile photo stays on the logo', async () => {
  const page = await req('GET', '/models/' + F.heldphoto.username);
  assert.equal(page.status, 200);
  assert.equal(ogImage(page.text), LOGO_ABS, 'a held profile photo is withheld media → logo');
  assert.ok(page.text.includes(`<img class="photo" src="${LOGO_ABS}"`),
    'hero stays on the logo too — held media never leads her page');
});
