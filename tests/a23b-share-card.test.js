'use strict';
/*
 * A23b (Owner via Ms. Pink, Oct 30 2026) — share card = her photo +
 * her editable note + Share on her own profile:
 *  1. The link preview (OG card) for /models/<username>: og:image is
 *     HER public photo — the gate-cleared public_photo_url her public
 *     profile page shows (approved + not co-star-held). Locked /
 *     in-app-only / unapproved / held media NEVER; no public photo
 *     falls back to the brand logo. Her in-app photo_url must never
 *     appear as og:image (Oct 16 rule: it may be explicit).
 *  2. og:description is HER NOTE. Default = the owner's exact words
 *     "Cum have fun with me on SlutCamp". The in-app share-sheet text
 *     leads with the note (shareModelProfile text = her note, the
 *     link rides as the share URL).
 *  3. The note is hers to edit: a "Share note" field in her model
 *     settings riding PUT /api/model/profile — same scans, same
 *     whole-save rejection, same 280 cap as the bio.
 *  4. The Share button renders on her OWN profile view too (the
 *     peek's isMe surface), same shareModelProfile action.
 *
 * Harness: boot-the-real-server pattern (tests/a22.test.js) with a
 * kill → DB-surgery → reboot step (tests/seo-pages.test.js) to create
 * the approved / unapproved / co-star-held fixtures no public API
 * will create.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const REPO = path.join(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(REPO, 'public/js/app.js'), 'utf8');

const DEFAULT_NOTE = 'Cum have fun with me on SlutCamp';
const LOGO_ABS = 'https://slutcamp.app/img/lips-logo.png';
const LANG13 = ['en', 'es', 'pt', 'fr', 'de', 'ru', 'ja', 'zh', 'ko', 'it', 'pl', 'nl', 'tr'];

/* Brace-matching extractor (same approach as the A22 suite). */
function literalSpan(src, marker) {
  const i = src.indexOf(marker);
  assert.ok(i >= 0, 'marker found: ' + marker);
  let j = src.indexOf('{', i), depth = 0, k = j, inStr = null, esc = false, inTpl = false, td = 0;
  for (; k < src.length; k++) {
    const c = src[k];
    if (inTpl) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '$' && src[k + 1] === '{') { td++; k++; continue; }
      if (c === '}' && td > 0) { td--; continue; }
      if (c === '`' && td === 0) inTpl = false;
      continue;
    }
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '`') { inTpl = true; continue; }
    if (c === "'" || c === '"') { inStr = c; continue; }
    if (c === '{') depth++;
    if (c === '}') { depth--; if (depth === 0) return [j, k + 1]; }
  }
  throw new Error('unbalanced: ' + marker);
}
function evalBlock(src, marker, name) {
  const [s, e] = literalSpan(src, marker);
  const sb = {};
  vm.createContext(sb);
  vm.runInContext(marker + ' ' + src.slice(s, e) + `;\nthis.__v = ${name};`, sb);
  return sb.__v;
}
const slice = (src, from, to) => src.slice(src.indexOf(from), src.indexOf(to));

/* ---------------- static: storage + server shaping ---------------- */

test('static: share_note lives on models with the owner default, via the additive-column pattern', () => {
  assert.ok(serverSrc.includes("addColumnIfMissing('models', 'share_note'"),
    'share_note arrives via addColumnIfMissing like every post-launch column');
  assert.ok(serverSrc.includes(`share_note TEXT NOT NULL DEFAULT '${DEFAULT_NOTE}'`),
    'the column default IS the owner\'s exact wording');
  assert.ok(serverSrc.includes('const DEFAULT_SHARE_NOTE = \'Cum have fun with me on SlutCamp\''),
    'one server constant carries the default');
  assert.ok(serverSrc.includes('const shareNoteOf ='), 'one derivation for the effective note');
});

test('static: the public-page derivation reads share_note and the card uses it as og:description', () => {
  const seo = slice(serverSrc, 'function seoPublicModels()', 'const seoTagSlug');
  assert.ok(seo.includes('m.share_note'), 'seoPublicModels selects her note');
  assert.ok(seo.includes('share_note: shareNoteOf(r.share_note)'), 'the shaped row carries the effective note');
  const page = slice(serverSrc, "app.get('/models/:username'", "app.get('/models',");
  assert.ok(page.includes('const desc = m.share_note;'), 'og:description = her note');
  assert.ok(page.includes('image: m.photo_abs'), 'og:image stays the gate-cleared public photo derivation (photo_abs)');
  assert.ok(page.includes('text: ${JSON.stringify(m.share_note)}'),
    'the public page share sheet leads with her note');
});

test('static: roster carries share_note next to share_url', () => {
  const roster = slice(serverSrc, "app.get('/api/models',", "app.post('/api/models/:id/like'");
  assert.ok(roster.includes('m.share_note'), 'roster SELECT reads her note');
  assert.ok(roster.includes('share_note: shareNoteOf(r.share_note)'), 'roster shape carries the effective note');
});

test('static: note saves ride the profile PUT under the bio\'s exact scans and cap', () => {
  const put = slice(serverSrc, "app.put('/api/model/profile'", "app.get('/api/model/profile'");
  assert.ok(put.includes('safetyScan(share_note) || promotionScan(share_note)'),
    'the note is scanned by the SAME two scans as the bio');
  assert.ok(put.includes("error: 'share_note_not_allowed'"), 'a scan hit rejects the save');
  assert.ok(put.includes("updates.push('share_note = ?'); params.push(share_note.slice(0, 280))"),
    'the note is capped at 280, exactly like the bio');
});

/* ---------------- static: client ---------------- */

test('static: shareModelProfile leads its share text with her note, link as the URL', () => {
  const fn = slice(appSrc, 'async function shareModelProfile(', 'async function openChatWithModel(');
  assert.ok(fn.includes('m.share_note'), 'the share text comes from her note');
  assert.ok(fn.includes('text: note,'), 'the share-sheet text IS her note (the sheet composes it ahead of the link)');
  assert.ok(fn.includes(`|| 'Cum have fun with me on SlutCamp'`), 'the owner default stands in when a surface has no note');
  assert.ok(fn.includes('navigator.share'), 'native share sheet first');
  assert.ok(fn.includes('navigator.clipboard.writeText(url)'), 'A22 copy-link fallback pattern unchanged');
});

test('static: Share button renders on her own profile view (peek isMe surface)', () => {
  const peek = slice(appSrc, 'function openModelPeek(', 'async function loadPeekFeed(');
  assert.ok(peek.includes('${isMe && !m.share_url ? `<button class="btn ghost" data-peek-share="${m.id}"'),
    'her own view renders the Share button even when the peek object lacks share fields');
  assert.ok(peek.includes('shareModelProfile(selfShare)'), 'her own button shares through the same action');
  assert.ok(peek.includes("canonOrigin() + '/models/' + encodeURIComponent(S.user.username)"),
    'her own share object is built on the canonical profile URL');
  assert.ok(peek.includes('(S.model && S.model.share_note) || m.share_note'),
    'her own share object carries her note from /api/me');
});

test('static: settings carry the Share note field, saving through the profile PUT', () => {
  const settings = slice(appSrc, 'async function vModelSettings()', 'async function vModelContract()');
  assert.ok(settings.includes('id="s-share-note"'), 'the Share note field renders in her settings');
  assert.ok(settings.includes("t('share_note_h')"), 'the field label is i18n-keyed');
  assert.ok(settings.includes('id="s-share-note-save"'), 'the field has its save button');
  assert.ok(settings.includes("JSON.stringify({ share_note: $('#s-share-note').value })"),
    'saving rides PUT /api/model/profile with share_note');
  assert.ok(settings.includes("data.error === 'share_note_not_allowed'"),
    'a scan rejection is explained on screen');
  assert.ok(settings.includes("toast(t('share_note_not_allowed_info'), 6000)"),
    'the explanation is the note-specific STR string');
});

test('STR: share-note keys exist in all 13 languages', () => {
  const I18N = evalBlock(appSrc, 'const I18N =', 'I18N');
  const keys = ['share_note_h', 'share_note_note', 'save_share_note', 'share_note_saved', 'share_note_not_allowed_info'];
  for (const lang of LANG13) {
    for (const k of keys) {
      assert.equal(typeof I18N[lang][k], 'string', `${lang}:${k} exists`);
      assert.ok(I18N[lang][k].trim().length > 0, `${lang}:${k} non-empty`);
    }
  }
  assert.equal(I18N.en.share_note_h, '📤 Share note');
});

/* ---------------- live: boot + fixtures ---------------- */

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

async function uploadMultipart(p, token) {
  const fd = new FormData();
  fd.append('photo', new Blob([PNG_1PX], { type: 'image/png' }), 'pixel.png');
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
const ogDesc = (html) => {
  const m = html.match(/<meta property="og:description" content="([^"]*)">/);
  return m ? m[1] : null;
};

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-a23b-'));
  for (const d of ['server.js', 'package.json', 'lib', 'public', 'data']) {
    fs.cpSync(path.join(REPO, d), path.join(tmpDir, d), { recursive: true });
  }
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(tmpDir, 'node_modules'), 'dir');

  await boot();
  const suffix = Math.random().toString(36).slice(2, 8);
  const mkModel = async (name, display) => {
    const username = name + suffix;
    const s = await req('POST', '/api/auth/signup', {
      body: { username, password: 'a23b-pass-123', role: 'model', publicity_consent: true,
        display_name: display, dob: '1996-04-12', agree18: true, section: 'female' },
    });
    assert.equal(s.status, 200, `signup ${username} failed: ${s.text}`);
    return { username, id: s.json.user.id, token: s.json.token };
  };

  // cardstar: approved + a clean public photo (+ a storefront photo
  // that must NEVER be the card image while a public photo exists).
  F.star = await mkModel('a23bstar', 'Card Star');
  const upStore = await uploadMultipart('/api/model/photo', F.star.token);
  assert.equal(upStore.status, 200, `storefront upload: ${upStore.text}`);
  F.star.storefrontUrl = upStore.json.photo_url;
  const upPub = await uploadMultipart('/api/model/public-photo', F.star.token);
  assert.equal(upPub.status, 200, `public upload: ${upPub.text}`);
  F.star.publicUrl = upPub.json.public_photo_url;

  // inapp: approved, storefront (in-app) photo ONLY — no public photo.
  F.inapp = await mkModel('a23binapp', 'Inapp Only');
  const upIn = await uploadMultipart('/api/model/photo', F.inapp.token);
  assert.equal(upIn.status, 200, `inapp upload: ${upIn.text}`);
  F.inapp.storefrontUrl = upIn.json.photo_url;

  // held: approved + public photo, but the photo is co-star-held.
  F.held = await mkModel('a23bheld', 'Held Photo');
  const upHeld = await uploadMultipart('/api/model/public-photo', F.held.token);
  assert.equal(upHeld.status, 200, `held upload: ${upHeld.text}`);
  F.held.publicUrl = upHeld.json.public_photo_url;

  // unapproved: public photo uploaded, ID never approved.
  F.unapp = await mkModel('a23bunapp', 'Unapproved');
  const upUn = await uploadMultipart('/api/model/public-photo', F.unapp.token);
  assert.equal(upUn.status, 200, `unapproved upload: ${upUn.text}`);
  F.unapp.publicUrl = upUn.json.public_photo_url;

  await killServer();
  const db = new DatabaseSync(path.join(tmpDir, 'wogent-chat.db'));
  db.exec('PRAGMA busy_timeout = 10000');
  for (const m of [F.star, F.inapp, F.held]) {
    db.prepare("INSERT INTO id_verifications (model_id, status) VALUES (?, 'approved')").run(m.id);
  }
  const cp = db.prepare("INSERT INTO co_performers (owner_model_id, display_name, status) VALUES (?, 'Partner', 'pending')").run(F.held.id);
  db.prepare('INSERT INTO media_costars (model_id, media_url, co_performer_id) VALUES (?, ?, ?)')
    .run(F.held.id, F.held.publicUrl, Number(cp.lastInsertRowid));
  db.close();

  await boot();
});

test.after(async () => {
  await killServer();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

/* ---------------- live: the card ---------------- */

test('live: og:image is her public photo when she has an approved, unheld one', async () => {
  const page = await req('GET', '/models/' + F.star.username);
  assert.equal(page.status, 200, page.text.slice(0, 200));
  assert.equal(ogImage(page.text), 'https://slutcamp.app' + F.star.publicUrl,
    'og:image = her gate-cleared public photo');
  assert.ok(!ogImage(page.text).includes(F.star.storefrontUrl),
    'og:image is never her in-app storefront photo');
  assert.ok(page.text.includes(`<meta name="twitter:image" content="https://slutcamp.app${F.star.publicUrl}">`),
    'twitter:image matches');
});

test('live: og:image falls back to the logo — in-app photo only', async () => {
  const page = await req('GET', '/models/' + F.inapp.username);
  assert.equal(page.status, 200);
  assert.equal(ogImage(page.text), LOGO_ABS, 'no public photo → brand logo');
  assert.ok(!page.text.includes('og:image" content=https://slutcamp.app' + F.inapp.storefrontUrl),
    'her in-app photo never becomes the card image');
});

test('live: og:image falls back to the logo — co-star-held public photo', async () => {
  const page = await req('GET', '/models/' + F.held.username);
  assert.equal(page.status, 200);
  assert.equal(ogImage(page.text), LOGO_ABS, 'a held photo is withheld media → logo');
});

test('live: og:image falls back to the logo — unapproved model', async () => {
  const page = await req('GET', '/models/' + F.unapp.username);
  assert.equal(page.status, 200);
  assert.equal(ogImage(page.text), LOGO_ABS, 'unapproved media never reaches the card');
});

test('live: og:description is the default note before she edits it', async () => {
  const page = await req('GET', '/models/' + F.star.username);
  assert.equal(ogDesc(page.text), DEFAULT_NOTE, 'og:description = the owner default note');
  const me = await req('GET', '/api/me', { token: F.star.token });
  assert.equal(me.json.model.share_note, DEFAULT_NOTE, '/api/me carries the default note');
  const roster = await req('GET', '/api/models', { token: F.star.token });
  const row = (roster.json.models || []).find((x) => x.id === F.star.id);
  assert.ok(row, 'she is on the roster');
  assert.equal(row.share_note, DEFAULT_NOTE, 'roster carries the default note for the share text');
});

/* ---------------- live: her note, edited ---------------- */

test('live: note edit persists and changes og:description + roster share text', async () => {
  const note = 'Come chat with me tonight, I am live and taking calls';
  const put = await req('PUT', '/api/model/profile', { body: { share_note: note }, token: F.star.token });
  assert.equal(put.status, 200, `note save: ${put.text}`);
  const me = await req('GET', '/api/me', { token: F.star.token });
  assert.equal(me.json.model.share_note, note, 'the edit persisted on her row');
  const page = await req('GET', '/models/' + F.star.username);
  assert.equal(ogDesc(page.text), note, 'og:description follows her edit');
  const roster = await req('GET', '/api/models', { token: F.star.token });
  const row = (roster.json.models || []).find((x) => x.id === F.star.id);
  assert.equal(row.share_note, note, 'the share text source (roster) follows her edit');
});

test('live: note validation rejects exactly what bio validation rejects', async () => {
  const bad = 'DM me on instagram for more';
  const bioTry = await req('PUT', '/api/model/profile', { body: { bio: bad }, token: F.star.token });
  assert.equal(bioTry.status, 400, `bio rejected: ${bioTry.text}`);
  assert.equal(bioTry.json.error, 'bio_not_allowed');
  const noteTry = await req('PUT', '/api/model/profile', { body: { share_note: bad }, token: F.star.token });
  assert.equal(noteTry.status, 400, `note rejected: ${noteTry.text}`);
  assert.equal(noteTry.json.error, 'share_note_not_allowed');
  assert.equal(noteTry.json.matched, bioTry.json.matched, 'same scan, same match');
  const me = await req('GET', '/api/me', { token: F.star.token });
  assert.notEqual(me.json.model.share_note, bad, 'the rejected note was not stored');
});

test('live: note is capped at 280 like the bio; clearing it restores the default on the card', async () => {
  const long = 'x'.repeat(300);
  const put = await req('PUT', '/api/model/profile', { body: { share_note: long }, token: F.star.token });
  assert.equal(put.status, 200, `long note save: ${put.text}`);
  const me = await req('GET', '/api/me', { token: F.star.token });
  assert.equal(me.json.model.share_note.length, 280, 'stored note capped at 280');
  const clear = await req('PUT', '/api/model/profile', { body: { share_note: '' }, token: F.star.token });
  assert.equal(clear.status, 200, `clear: ${clear.text}`);
  const page = await req('GET', '/models/' + F.star.username);
  assert.equal(ogDesc(page.text), DEFAULT_NOTE, 'a blank note falls back to the owner default on the card');
});
