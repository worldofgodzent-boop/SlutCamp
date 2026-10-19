'use strict';
/*
 * Public SEO pages — the app is a single-page shell, so Google used to
 * see exactly ONE page (the homepage; the old static sitemap.xml had a
 * single URL). These pages give every PUBLIC model a real server-
 * rendered page: /models/:username, the /models hub, /tags/:tag hubs,
 * the /join recruiting page, and a DYNAMIC /sitemap.xml that follows
 * the roster.
 *
 * Harness: same boot-the-real-server pattern as tests/discovery.test.js,
 * with a kill → DB-surgery → reboot step (tests/spend-dashboard.test.js
 * pattern) to create the non-public fixtures (a hidden model and a
 * banned model) that no public API will create.
 *
 * Fixtures:
 *   seostar<sfx>  — public model, online, $2.50/msg, tags Tattoos +
 *                   Cosplay, bio carrying an HTML payload that must
 *                   render ESCAPED on her public page.
 *   seohidden<sfx>— model with models.is_hidden = 1 (surgery).
 *   seobanned<sfx>— model with users.banned = 1 (surgery).
 *   seoplain<sfx> — public model who never sets a public photo.
 *   + the SEED_DEMO models (bunny/stacey/bella), public by default.
 *
 * Public-photo fixtures (owner's storefront rule, Oct 16 2026): the
 * star and the plain model both upload a STOREFRONT photo through the
 * real POST /api/model/photo (in-app photo; may be explicit by design);
 * only the star also uploads her separate CLEAN public photo through
 * POST /api/model/public-photo. The public pages must show the public
 * photo (or the logo when unset) and the storefront URL must never
 * appear in any public HTML — while /api/models keeps carrying it.
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

let tmpDir = null;
let child = null;
let base = null;
let childLog = '';

const F = {}; // username fixtures

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
    method,
    headers,
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

async function uploadMultipart(p, token, { field = 'photo', withFile = true } = {}) {
  const fd = new FormData();
  if (withFile) fd.append(field, new Blob([PNG_1PX], { type: 'image/png' }), 'pixel.png');
  const headers = {};
  if (token) headers.authorization = 'Bearer ' + token;
  const r = await fetch(base + p, { method: 'POST', headers, body: fd });
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

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-seo-'));
  for (const f of ['server.js', 'package.json']) {
    fs.copyFileSync(path.join(REPO, f), path.join(tmpDir, f));
  }
  for (const d of ['lib', 'public', 'data']) {
    fs.cpSync(path.join(REPO, d), path.join(tmpDir, d), { recursive: true });
  }
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(tmpDir, 'node_modules'), 'dir');

  await boot();
  const suffix = Math.random().toString(36).slice(2, 8);
  const mkModel = async (name, display, profile) => {
    const username = name + suffix;
    const s = await req('POST', '/api/auth/signup', {
      body: { username, password: 'seo-pass-123', role: 'model', display_name: display, dob: '1996-04-12', agree18: true, section: 'female' },
    });
    assert.equal(s.status, 200, `signup ${username} failed: ${s.text}`);
    if (profile) {
      const put = await req('PUT', '/api/model/profile', { body: profile, token: s.json.token });
      assert.equal(put.status, 200, `profile ${username} failed: ${put.text}`);
    }
    return { username, id: s.json.user.id, token: s.json.token };
  };

  F.star = await mkModel('seostar', 'Seo Star', {
    bio: 'I <script>alert("x")</script> love "quotes" & long chats',
    per_message_cents: 250, is_online: 1, tags: ['Tattoos', 'Cosplay'],
  });
  F.hidden = await mkModel('seohidden', 'Seo Hidden', null);
  F.banned = await mkModel('seobanned', 'Seo Banned', null);
  F.plain = await mkModel('seoplain', 'Seo Plain', null);

  // Photos through the REAL upload APIs, before surgery: both public
  // fixtures get a storefront photo; only the star sets a public photo.
  const upStar = await uploadMultipart('/api/model/photo', F.star.token);
  assert.equal(upStar.status, 200, `storefront upload failed: ${upStar.text}`);
  F.star.storefrontUrl = upStar.json.photo_url;
  assert.ok(F.star.storefrontUrl && F.star.storefrontUrl.startsWith('/uploads/photo-'), 'storefront URL shape');
  const upPlain = await uploadMultipart('/api/model/photo', F.plain.token);
  assert.equal(upPlain.status, 200, `storefront upload (plain) failed: ${upPlain.text}`);
  F.plain.storefrontUrl = upPlain.json.photo_url;
  const upPub = await uploadMultipart('/api/model/public-photo', F.star.token);
  assert.equal(upPub.status, 200, `public photo upload failed: ${upPub.text}`);
  F.star.publicUrl = upPub.json.public_photo_url;
  assert.ok(F.star.publicUrl && F.star.publicUrl.startsWith('/uploads/photo-'), 'public URL shape');
  assert.notEqual(F.star.publicUrl, F.star.storefrontUrl, 'two uploads, two separate files');

  // Surgery: hide one model, ban the other. No public API does either.
  await killServer();
  const db = new DatabaseSync(path.join(tmpDir, 'wogent-chat.db'));
  db.prepare('UPDATE models SET is_hidden = 1 WHERE user_id = ?').run(F.hidden.id);
  db.prepare('UPDATE users SET banned = 1 WHERE id = ?').run(F.banned.id);
  db.close();

  await boot();
});

test.after(async () => {
  await killServer();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

/* ---------------- model page ---------------- */

test('model page: 200 with title, OG, adult rating + RTA meta, price, tags, CTA', async () => {
  const r = await req('GET', '/models/' + F.star.username);
  assert.equal(r.status, 200, r.text.slice(0, 200));
  assert.match(r.headers.get('content-type') || '', /text\/html/);
  assert.ok(r.text.includes(`<title>Seo Star (@${F.star.username}) on SlutCamp</title>`), 'unique title');
  assert.ok(r.text.includes('property="og:title"'), 'og:title');
  assert.ok(r.text.includes(`https://slutcamp.app/models/${F.star.username}`), 'canonical/OG url');
  assert.ok(r.text.includes('name="rating" content="adult"'), 'adult rating meta');
  assert.ok(r.text.includes('RTA-5042-1996-1400-1577-RTA'), 'RTA label meta');
  assert.ok(r.text.includes('name="twitter:card"'), 'twitter card');
  assert.ok(r.text.includes('application/ld+json'), 'JSON-LD');
  assert.ok(r.text.includes('$2.50'), 'per-message price');
  assert.ok(r.text.includes('href="/tags/tattoos"'), 'tag link: tattoos');
  assert.ok(r.text.includes('href="/tags/cosplay"'), 'tag link: cosplay');
  assert.ok(r.text.includes('Chat with her on SlutCamp'), 'CTA into the app');
  assert.ok((r.headers.get('cache-control') || '').includes('max-age=300'), 'anonymous cache header');
});

test('model page: rank badge matches her /api/models rank_position (Top 10)', async () => {
  const dir = await req('GET', '/api/models');
  assert.equal(dir.status, 200);
  const me = dir.json.models.find((m) => m.username === F.star.username);
  assert.ok(me, 'fixture model must be in the public directory');
  assert.ok(me.rank_position >= 1 && me.rank_position <= 10, `fixture roster is small; rank ${me.rank_position} must be Top 10`);
  const r = await req('GET', '/models/' + F.star.username);
  assert.ok(r.text.includes(`Ranked #${me.rank_position} on SlutCamp`), 'page shows her true rank');
});

test('model page: bio HTML payload renders escaped, never raw', async () => {
  const r = await req('GET', '/models/' + F.star.username);
  assert.equal(r.status, 200);
  assert.ok(!r.text.includes('<script>alert("x")</script>'), 'raw script payload must NOT appear');
  assert.ok(r.text.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'), 'payload appears escaped');
  assert.ok(r.text.includes('&amp; long chats'), 'ampersand escaped');
});

test('model page: unknown username is a real 404', async () => {
  const r = await req('GET', '/models/definitely-not-a-model-xyz');
  assert.equal(r.status, 404);
});

test('model page: hidden and banned models are 404, exactly like the directory hides them', async () => {
  const h = await req('GET', '/models/' + F.hidden.username);
  assert.equal(h.status, 404, 'hidden model must not have a public page');
  const b = await req('GET', '/models/' + F.banned.username);
  assert.equal(b.status, 404, 'banned model must not have a public page');
  const dir = await req('GET', '/api/models');
  const names = dir.json.models.map((m) => m.username);
  assert.ok(!names.includes(F.hidden.username) && !names.includes(F.banned.username),
    'fixtures really are non-public in /api/models too');
});

/* ---------------- index + join + tags ---------------- */

test('models index: lists public models only, with links to their pages', async () => {
  const r = await req('GET', '/models');
  assert.equal(r.status, 200);
  assert.ok(r.text.includes(`href="/models/${F.star.username}"`), 'links the public fixture');
  assert.ok(r.text.includes('href="/models/bunny"'), 'links a seeded public model');
  assert.ok(!r.text.includes(F.hidden.username), 'hidden model absent');
  assert.ok(!r.text.includes(F.banned.username), 'banned model absent');
});

test('join page: server-rendered recruiting pitch with the honest 60% split', async () => {
  const r = await req('GET', '/join');
  assert.equal(r.status, 200);
  assert.ok(r.text.includes('Become a SlutCamp model'), 'headline');
  assert.ok(r.text.includes('Keep 60% of everything you earn'), 'the 60% pitch');
  assert.ok(r.text.includes('Face ID'), 'Face ID point');
});

test('tag page: renders the models carrying the tag; unknown and empty tags 404', async () => {
  const t = await req('GET', '/tags/tattoos');
  assert.equal(t.status, 200, t.text.slice(0, 200));
  assert.ok(t.text.includes(`href="/models/${F.star.username}"`), 'tagged model listed');
  const unknown = await req('GET', '/tags/no-such-tag');
  assert.equal(unknown.status, 404, 'unknown tag 404s');
  const empty = await req('GET', '/tags/milf'); // catalogue tag, no fixture carries it
  assert.equal(empty.status, 404, 'catalogue tag with zero public models 404s');
});

/* ---------------- sitemap ---------------- */

test('sitemap: dynamic — homepage, join, index, public models, live tags; non-public excluded', async () => {
  const r = await req('GET', '/sitemap.xml');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') || '', /xml/);
  assert.ok(r.text.includes('<loc>https://slutcamp.app/</loc>'), 'homepage');
  assert.ok(r.text.includes('<loc>https://slutcamp.app/join</loc>'), 'join');
  assert.ok(r.text.includes('<loc>https://slutcamp.app/models</loc>'), 'index');
  assert.ok(r.text.includes(`<loc>https://slutcamp.app/models/${F.star.username}</loc>`), 'public model page');
  assert.ok(r.text.includes('<loc>https://slutcamp.app/tags/tattoos</loc>'), 'live tag page');
  assert.ok(!r.text.includes(F.hidden.username), 'hidden model excluded');
  assert.ok(!r.text.includes(F.banned.username), 'banned model excluded');
  const count = (r.text.match(/<url>/g) || []).length;
  assert.ok(count >= 6, `expected a roster-sized sitemap, got ${count} urls`);
});

/* ---------------- the app itself is untouched ---------------- */

test('SPA root and /api/models are unaffected by the SEO routes', async () => {
  const root = await req('GET', '/');
  assert.equal(root.status, 200);
  assert.ok(root.text.includes('/js/app.js'), 'SPA shell still served at /');
  assert.ok(!root.text.includes('Models on SlutCamp</h1>'), 'root is not the SEO index');
  const dir = await req('GET', '/api/models');
  assert.equal(dir.status, 200);
  assert.ok(Array.isArray(dir.json.models), 'directory JSON intact');
});

/* ---------------- public (clean) photo — owner's storefront rule ---------------- */

test('public photo: set → hero, OG/Twitter, JSON-LD and cards use it; storefront URL appears NOWHERE public', async () => {
  const page = await req('GET', '/models/' + F.star.username);
  assert.equal(page.status, 200);
  assert.ok(page.text.includes(`<img class="photo" src="${F.star.publicUrl}"`), 'hero uses the public photo');
  assert.ok(page.text.includes(`https://slutcamp.app${F.star.publicUrl}`), 'OG/Twitter/JSON-LD image is the public photo, absolute');
  assert.ok(!page.text.includes(F.star.storefrontUrl), 'storefront URL must NOT appear on her public page');
  const idx = await req('GET', '/models');
  assert.ok(idx.text.includes(F.star.publicUrl), 'index card uses the public photo');
  assert.ok(!idx.text.includes(F.star.storefrontUrl), 'storefront URL must NOT appear on the index');
  const tag = await req('GET', '/tags/tattoos');
  assert.equal(tag.status, 200);
  assert.ok(tag.text.includes(F.star.publicUrl), 'tag card uses the public photo');
  assert.ok(!tag.text.includes(F.star.storefrontUrl), 'storefront URL must NOT appear on tag pages');
});

test('public photo: unset → no model photo on public pages (logo fallback), storefront URL still absent', async () => {
  const page = await req('GET', '/models/' + F.plain.username);
  assert.equal(page.status, 200);
  assert.ok(!page.text.includes(F.plain.storefrontUrl), 'storefront URL must NOT appear even with no public photo set');
  assert.ok(page.text.includes('<img class="photo" src="/img/lips-logo.png"'), 'hero falls back to the branded logo');
  assert.ok(page.text.includes('content="https://slutcamp.app/img/lips-logo.png"'), 'OG image falls back to the logo');
  const idx = await req('GET', '/models');
  assert.ok(!idx.text.includes(F.plain.storefrontUrl), 'storefront URL must NOT appear on the index');
});

test('public photo: in-app /api/models payload is UNCHANGED — still carries the storefront photo', async () => {
  const dir = await req('GET', '/api/models');
  assert.equal(dir.status, 200);
  const star = dir.json.models.find((m) => m.username === F.star.username);
  const plain = dir.json.models.find((m) => m.username === F.plain.username);
  assert.ok(star && plain, 'both fixtures are in the directory');
  assert.equal(star.photo_url, F.star.storefrontUrl, 'directory keeps her storefront photo in-app');
  assert.equal(plain.photo_url, F.plain.storefrontUrl, 'directory keeps her storefront photo in-app');
});

test('public photo: settings round-trip via the real API — set, read back, clear, read back', async () => {
  const me0 = await req('GET', '/api/me', { token: F.plain.token });
  assert.equal(me0.json.model.public_photo_url, '', 'starts unset');
  const up = await uploadMultipart('/api/model/public-photo', F.plain.token);
  assert.equal(up.status, 200, up.text);
  const url = up.json.public_photo_url;
  assert.ok(url && url.startsWith('/uploads/photo-'), 'stored value is the resulting upload URL');
  const me1 = await req('GET', '/api/me', { token: F.plain.token });
  assert.equal(me1.json.model.public_photo_url, url, 'settings read-back shows it');
  assert.equal(me1.json.model.photo_url, F.plain.storefrontUrl, 'storefront photo untouched by the public-photo write');
  const page = await req('GET', '/models/' + F.plain.username);
  assert.ok(page.text.includes(url), 'public page now uses it');
  assert.ok(!page.text.includes(F.plain.storefrontUrl), 'storefront URL still absent');
  const del = await req('DELETE', '/api/model/public-photo', { token: F.plain.token });
  assert.equal(del.status, 200, del.text);
  assert.equal(del.json.public_photo_url, '');
  const me2 = await req('GET', '/api/me', { token: F.plain.token });
  assert.equal(me2.json.model.public_photo_url, '', 'cleared');
  const page2 = await req('GET', '/models/' + F.plain.username);
  assert.ok(!page2.text.includes(url), 'cleared photo no longer appears on the public page');
});

test('public photo: writes are owner-only — fans and guests refused, another model changes only her own', async () => {
  const sfx = Math.random().toString(36).slice(2, 8);
  const fan = await req('POST', '/api/auth/signup', {
    body: { username: 'seofan' + sfx, password: 'seo-pass-123', role: 'fan', display_name: 'Seo Fan', dob: '1996-04-12', agree18: true },
  });
  assert.equal(fan.status, 200, fan.text);
  const asFan = await uploadMultipart('/api/model/public-photo', fan.json.token);
  assert.equal(asFan.status, 403, 'fan token refused (role gate)');
  const fanDel = await req('DELETE', '/api/model/public-photo', { token: fan.json.token });
  assert.equal(fanDel.status, 403, 'fan cannot clear either');
  const anon = await uploadMultipart('/api/model/public-photo', null);
  assert.equal(anon.status, 401, 'no token refused');
  const noFile = await uploadMultipart('/api/model/public-photo', F.plain.token, { withFile: false });
  assert.equal(noFile.status, 400, 'missing file refused');
  assert.equal(noFile.json.error, 'no_photo');
  // Another model writing HER public photo must land on her own row only.
  const other = await req('POST', '/api/auth/signup', {
    body: { username: 'seoother' + sfx, password: 'seo-pass-123', role: 'model', display_name: 'Seo Other', dob: '1996-04-12', agree18: true, section: 'female' },
  });
  assert.equal(other.status, 200, other.text);
  const otherUp = await uploadMultipart('/api/model/public-photo', other.json.token);
  assert.equal(otherUp.status, 200, otherUp.text);
  const otherMe = await req('GET', '/api/me', { token: other.json.token });
  assert.equal(otherMe.json.model.public_photo_url, otherUp.json.public_photo_url, 'the write landed on her own row');
  const starMe = await req('GET', '/api/me', { token: F.star.token });
  assert.equal(starMe.json.model.public_photo_url, F.star.publicUrl, "star's public photo untouched by another model's write");
  const starPage = await req('GET', '/models/' + F.star.username);
  assert.ok(starPage.text.includes(F.star.publicUrl), "star's public page still shows her own public photo");
});

test('public photo: source pins — column, routes, settings control, EN/ES/PT label', async () => {
  const server = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
  assert.ok(server.includes("addColumnIfMissing('models', 'public_photo_url'"), 'additive column on models (the photo home)');
  assert.ok(server.includes("app.post('/api/model/public-photo'"), 'upload route');
  assert.ok(server.includes("app.delete('/api/model/public-photo'"), 'clear route');
  const app = fs.readFileSync(path.join(REPO, 'public/js/app.js'), 'utf8');
  assert.ok(app.includes("apiUpload('/model/public-photo'"), 'settings upload wired to the route');
  assert.ok(app.includes("'/api/model/public-photo', { method: 'DELETE'"), 'settings clear wired to the route');
  assert.ok(app.includes('Public photo (clean — the one Google shows)'), 'EN label');
  assert.ok(app.includes('Foto pública (limpia — la que muestra Google)'), 'ES label');
  assert.ok(app.includes('Foto pública (limpa — a que o Google mostra)'), 'PT label');
});
