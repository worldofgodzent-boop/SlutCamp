'use strict';
/*
 * Bandwidth origin fix + media-retention alignment (owner, Oct 19 2026 —
 * ~/workspace/projects/bandwidth-followups-2026-10-19.md §1–2):
 *
 * 1. CACHE HEADERS. The origin used to send 'public, max-age=0' on every
 *    static asset, so Cloudflare cached NOTHING and each app open
 *    re-pulled the whole shell over Render's metered egress. Now the
 *    shells stamp their asset URLs with the deploy build id
 *    ('__BUILD__' → BUILD_STAMP, the /sw.js mechanism), a request
 *    carrying the current stamp is served 'max-age=31536000, immutable',
 *    /img/ + /icons/ are immutable unstamped, /uploads whitelist files
 *    are immutable (crypto-random names = content-addressed), and
 *    HTML / /sw.js / /api/* stay uncached as designed.
 *
 * 2. MEDIA RETENTION. The 7-day chat sweep (PR #48) deleted message
 *    TEXT but left the media rows + files behind until the biweekly
 *    14-day pass. sweepChatRetention now expires media_items + files
 *    in the same pass, under the same two protections (official
 *    notices threads + open-dispute conversations are never swept).
 *
 * Live-request tests (suite convention: chargeback-dispute-link
 * harness) — boot the real server.js in a throwaway copy.
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
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const serverSrc = read('server.js');

/* ---------------- static pins ---------------- */

test('pins: shells carry the __BUILD__ stamp token, stale hand-bumped strings gone', () => {
  const html = read('public/index.html');
  assert.ok(html.includes('/js/app.js?v=__BUILD__'), 'app.js is build-stamped');
  assert.ok(html.includes('/css/styles.css?v=__BUILD__'), 'styles.css is build-stamped');
  assert.ok(!html.includes('20261015recruitlang'), 'stale app.js hand-bump removed');
  assert.ok(!html.includes('20261012lang'), 'stale styles.css hand-bump removed');

  const sw = read('public/sw.js');
  assert.ok(sw.includes("'/js/app.js?v=__BUILD__'"), 'SW SHELL app.js entry is stamped');
  assert.ok(sw.includes("'/css/styles.css?v=__BUILD__'"), 'SW SHELL styles.css entry is stamped');

  const mgr = read('public/manager/index.html');
  assert.ok(mgr.includes('/manager/manager.js?v=__BUILD__'), 'manager.js is build-stamped');
  assert.ok(mgr.includes('/manager/manager.css?v=__BUILD__'), 'manager.css is build-stamped');
});

test('pins: server stamps shells, serves stamped + /img + /icons + uploads immutable', () => {
  assert.ok(serverSrc.includes("const BUILD_STAMP = BUILD_ID || 'v4'"), 'build stamp token defined');
  assert.ok(serverSrc.includes("split('__BUILD__').join(BUILD_STAMP)"), 'shells stamped at serve time');
  assert.ok(serverSrc.includes("'public, max-age=31536000, immutable'"), 'immutable header present');
  assert.ok(serverSrc.includes("rel.startsWith('img/') || rel.startsWith('icons/')"),
    'unstamped /img + /icons path rule present');
  assert.ok(serverSrc.includes('req.query.v === BUILD_STAMP'), 'stamp check gates the immutable pass');
  // HTML stays explicitly uncached on the shell routes.
  assert.ok(serverSrc.includes("res.type('html').set('Cache-Control', 'public, max-age=0').send(indexHtml())"),
    'app shell route serves stamped HTML at max-age=0');
});

test('pins: the retention sweep expires media under the same protections', () => {
  const start = serverSrc.indexOf('function sweepChatRetention(');
  assert.ok(start > 0, 'the sweep exists');
  const sweep = serverSrc.slice(start, serverSrc.indexOf('// Cadence:', start));
  assert.ok(sweep.includes('FROM media_items mi JOIN conversations'), 'media pass joins conversations');
  assert.ok(sweep.includes('isProtected(m)'), 'media pass honors the same protection predicate');
  assert.ok(sweep.includes('mediaStillReferenced'), 'media a surviving message points at is never deleted');
  assert.ok(sweep.includes('fs.unlinkSync(fp)'), 'media files are unlinked, not just rows');
  assert.ok(sweep.includes('media_deleted: mediaDeleted'), 'sweep reports media_deleted');
  // The protections themselves are untouched: 7-day window, official +
  // open-dispute guards still computed from the same sources.
  assert.ok(sweep.includes('const CHAT_RETENTION_DAYS = 7') || serverSrc.includes('const CHAT_RETENTION_DAYS = 7'),
    'retention window unchanged');
  assert.ok(sweep.includes("status = 'open'"), 'open-dispute guard unchanged');
});

/* ---------------- live harness (chargeback-dispute-link pattern) ---------------- */

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

function makeCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-bandwidth-'));
  for (const d of ['server.js', 'package.json', 'lib', 'public', 'data']) {
    fs.cpSync(path.join(REPO, d), path.join(dir, d), { recursive: true });
  }
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  return dir;
}

async function boot(dir) {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), SEED_DEMO: '1', CRYPTO_POLL_MS: '3600000' };
  for (const k of Object.keys(env)) {
    if (/^(CCBILL_|CRYPTO_|OPENAI_|TWILIO_|VAPID_|WEBAUTHN_|AV_)/.test(k)) delete env[k];
  }
  const child = spawn(process.execPath, ['server.js'], { cwd: dir, env });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20000;
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
  const h = { ...(headers || {}) };
  let payload;
  if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  if (token) h.authorization = 'Bearer ' + token;
  const r = await fetch(base + p, { method, headers: h, body: payload });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not json */ }
  return { status: r.status, json, text, headers: r.headers };
}

const mgrLogin = async (base) => {
  const adm = await req(base, 'POST', '/api/manager/login', { body: { username: 'admin', password: 'admin123' } });
  assert.equal(adm.status, 200, `manager login: ${adm.text}`);
  return { token: adm.json.token, headers: { 'x-manager': '1' } };
};

async function signup(base, username, role) {
  const s = await req(base, 'POST', '/api/auth/signup', {
    body: { username, password: `${username}-pass-123`, role,
      display_name: username, dob: '1995-05-05', agree18: true, ...(role === 'model' ? { section: 'female', publicity_consent: true } : {}) },
  });
  assert.equal(s.status, 200, `signup ${username}: ${s.text}`);
  return { token: s.json.token, id: s.json.user.id };
}

const ago = (days) =>
  new Date(Date.now() - days * 864e5).toISOString().slice(0, 19).replace('T', ' ');

function withDb(dir, fn) {
  const db = new DatabaseSync(path.join(dir, 'wogent-chat.db'));
  db.exec('PRAGMA busy_timeout = 10000');
  try { return fn(db); } finally { db.close(); }
}

const IMMUTABLE = 'public, max-age=31536000, immutable';
const HEX = '0123456789abcdef0123456789abcdef';

/* ---------------- live: cache headers ---------------- */

test('live: stamped assets immutable, HTML / sw.js / api never cached', { timeout: 120000 }, async () => {
  const dir = makeCopy();
  const h = await boot(dir);
  try {
    // Plant a public upload in the copy's uploads dir.
    const upDir = path.join(dir, 'uploads');
    fs.mkdirSync(upDir, { recursive: true });
    fs.writeFileSync(path.join(upDir, `photo-${HEX}.jpg`), 'fake-jpeg-bytes');

    /* the app shell: stamped refs, HTML itself uncached */
    const home = await req(h.base, 'GET', '/');
    assert.equal(home.status, 200);
    assert.ok((home.headers.get('cache-control') || '').includes('max-age=0'), 'HTML keeps max-age=0');
    assert.ok(!(home.headers.get('cache-control') || '').includes('immutable'), 'HTML is never immutable');
    assert.ok(!home.text.includes('__BUILD__'), 'no unstamped token reaches the browser');
    const m = home.text.match(/\/js\/app\.js\?v=([A-Za-z0-9]+)/);
    assert.ok(m, 'served shell references a stamped app.js URL');
    const stamp = m[1];
    assert.ok(home.text.includes(`/css/styles.css?v=${stamp}`), 'styles.css carries the same stamp');

    const idx = await req(h.base, 'GET', '/index.html');
    assert.equal(idx.status, 200);
    assert.ok(idx.text.includes(`/js/app.js?v=${stamp}`), '/index.html serves the stamped shell too');

    const fallback = await req(h.base, 'GET', '/no-such-page-xyz');
    assert.equal(fallback.status, 200);
    assert.ok(fallback.text.includes(`/js/app.js?v=${stamp}`), 'SPA fallback serves the stamped shell');

    /* stamped asset URLs: immutable for a year */
    const appJs = await req(h.base, 'GET', `/js/app.js?v=${stamp}`);
    assert.equal(appJs.status, 200);
    assert.equal(appJs.headers.get('cache-control'), IMMUTABLE, 'stamped app.js is immutable');
    const css = await req(h.base, 'GET', `/css/styles.css?v=${stamp}`);
    assert.equal(css.headers.get('cache-control'), IMMUTABLE, 'stamped styles.css is immutable');

    /* unstamped asset URLs: today's behavior (revalidate) */
    const plain = await req(h.base, 'GET', '/js/app.js');
    assert.equal(plain.status, 200);
    assert.ok((plain.headers.get('cache-control') || '').includes('max-age=0'), 'unstamped app.js keeps max-age=0');
    assert.ok(!(plain.headers.get('cache-control') || '').includes('immutable'), 'unstamped app.js is not immutable');

    /* /img + /icons: immutable even unstamped (spec §1 path rule) */
    const logo = await req(h.base, 'GET', '/img/lips-logo.png');
    assert.equal(logo.status, 200);
    assert.equal(logo.headers.get('cache-control'), IMMUTABLE, 'logo under /img is immutable');
    const icon = await req(h.base, 'GET', '/icons/icon-192.png');
    assert.equal(icon.status, 200);
    assert.equal(icon.headers.get('cache-control'), IMMUTABLE, 'icon under /icons is immutable');

    /* uploads whitelist: immutable; the guard still 404s everything else */
    const photo = await req(h.base, 'GET', `/uploads/photo-${HEX}.jpg`);
    assert.equal(photo.status, 200);
    assert.equal(photo.headers.get('cache-control'), IMMUTABLE, 'public upload is immutable');
    const secret = await req(h.base, 'GET', '/uploads/not-a-public-name.jpg');
    assert.equal(secret.status, 404, 'uploads guard still refuses non-whitelisted names');

    /* /sw.js + /api/*: never cached, as designed */
    const sw = await req(h.base, 'GET', '/sw.js');
    assert.equal(sw.status, 200);
    assert.ok((sw.headers.get('cache-control') || '').includes('no-cache'), 'sw.js stays no-cache');
    assert.ok(!sw.text.includes('__BUILD__'), 'served sw.js carries no unstamped token');
    assert.ok(sw.text.includes(`/js/app.js?v=${stamp}`), 'SW SHELL entries stamped consistently with the shell');
    const api = await req(h.base, 'GET', '/api/build-id');
    assert.equal(api.status, 200);
    assert.ok(!(api.headers.get('cache-control') || '').includes('immutable'), 'API responses are never immutable');

    /* manager shell parity (spec §2) */
    const mgr = await req(h.base, 'GET', '/manager');
    assert.equal(mgr.status, 200);
    assert.ok((mgr.headers.get('cache-control') || '').includes('max-age=0'), 'manager HTML keeps max-age=0');
    assert.ok(!mgr.text.includes('__BUILD__'), 'manager shell is stamped at serve time');
    assert.ok(mgr.text.includes(`/manager/manager.js?v=${stamp}`), 'manager.js reference is stamped');
    const mgrJs = await req(h.base, 'GET', `/manager/manager.js?v=${stamp}`);
    assert.equal(mgrJs.status, 200);
    assert.equal(mgrJs.headers.get('cache-control'), IMMUTABLE, 'stamped manager.js is immutable');
  } finally {
    stop(h);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------- live: media retention ---------------- */

test('live: sweep expires aged media (rows + files); official/dispute/young survive', { timeout: 120000 }, async () => {
  const dir = makeCopy();
  let h = await boot(dir);
  let model, model2, fan, fan2;
  try {
    model = await signup(h.base, 'bwmodel', 'model');
    model2 = await signup(h.base, 'bwmodel2', 'model');
    fan = await signup(h.base, 'bwfan', 'fan');
    fan2 = await signup(h.base, 'bwfan2', 'fan');
  } finally {
    stop(h);
  }

  // Seed conversations + media directly (server stopped): an aged media
  // message and a young one in a normal thread, aged media in an
  // official thread, and aged media in a thread whose fan has an OPEN
  // dispute. Files are planted in the copy's uploads dir; media_items
  // file_path is the absolute path, exactly as the send endpoint stores.
  const upDir = path.join(dir, 'uploads');
  fs.mkdirSync(upDir, { recursive: true });
  const plant = (name) => {
    const fp = path.join(upDir, name);
    fs.writeFileSync(fp, `bytes-of-${name}`);
    return fp;
  };
  const S = withDb(dir, (db) => {
    const insConv = db.prepare(
      'INSERT INTO conversations (fan_id, model_id, is_official, updated_at) VALUES (?,?,?,?)');
    const insMedia = db.prepare(
      `INSERT INTO media_items (conversation_id, sender_id, kind, mime, file_path, price_cents, duration_sec, created_at)
       VALUES (?,?, 'ppv_image', 'image/jpeg', ?, 0, 0, ?)`);
    const insMsg = db.prepare(
      'INSERT INTO messages (conversation_id, sender_id, body, media_id, created_at) VALUES (?,?,?,?,?)');

    const conv = Number(insConv.run(fan.id, model.id, 0, ago(8)).lastInsertRowid);
    const oldMedia = Number(insMedia.run(conv, model.id, plant('bw-old.jpg'), ago(8)).lastInsertRowid);
    insMsg.run(conv, model.id, 'old ppv', oldMedia, ago(8));
    insMsg.run(conv, fan.id, 'old plain text', null, ago(8));
    const youngMedia = Number(insMedia.run(conv, model.id, plant('bw-young.jpg'), ago(1)).lastInsertRowid);
    insMsg.run(conv, model.id, 'young ppv', youngMedia, ago(1));

    // The sweep's protection reads the is_official flag itself, so the
    // official case is a flagged thread on its own (fan, model) pair
    // (UNIQUE(fan_id, model_id) allows one thread per pair).
    const convOfficial = Number(insConv.run(fan.id, model2.id, 1, ago(8)).lastInsertRowid);
    const offMedia = Number(insMedia.run(convOfficial, model2.id, plant('bw-official.jpg'), ago(8)).lastInsertRowid);
    insMsg.run(convOfficial, model2.id, 'official ppv', offMedia, ago(8));

    const convDispute = Number(insConv.run(fan2.id, model.id, 0, ago(8)).lastInsertRowid);
    const disMedia = Number(insMedia.run(convDispute, model.id, plant('bw-dispute.jpg'), ago(8)).lastInsertRowid);
    insMsg.run(convDispute, model.id, 'evidence ppv', disMedia, ago(8));
    db.prepare("INSERT INTO disputes (user_id, amount_cents, reason, status) VALUES (?, 100, 'test dispute', 'open')")
      .run(fan2.id);

    return { conv, convOfficial, convDispute, oldMedia, youngMedia, offMedia, disMedia };
  });

  h = await boot(dir);
  try {
    const mgr = await mgrLogin(h.base);
    const run = await req(h.base, 'POST', '/api/admin/conversations/cleanup', { ...mgr });
    assert.equal(run.status, 200, `cleanup: ${run.text}`);
    assert.equal(typeof run.json.media_deleted, 'number', 'cleanup reports media_deleted');

    const mediaRow = (id) => withDb(dir, (db) =>
      !!db.prepare('SELECT id FROM media_items WHERE id = ?').get(id));
    const msgCount = (convId) => withDb(dir, (db) =>
      db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(convId).n);
    const fileThere = (name) => fs.existsSync(path.join(upDir, name));

    /* normal thread: aged media row + file + messages all gone */
    assert.ok(!mediaRow(S.oldMedia), 'aged media row deleted');
    assert.ok(!fileThere('bw-old.jpg'), 'aged media file deleted');
    assert.equal(msgCount(S.conv), 1, 'only the young message remains in the normal thread');

    /* normal thread: young media untouched */
    assert.ok(mediaRow(S.youngMedia), 'young media row preserved');
    assert.ok(fileThere('bw-young.jpg'), 'young media file preserved');

    /* official thread: aged media fully preserved */
    assert.ok(mediaRow(S.offMedia), 'official-thread media row preserved');
    assert.ok(fileThere('bw-official.jpg'), 'official-thread media file preserved');
    assert.equal(msgCount(S.convOfficial), 1, 'official-thread message preserved');

    /* open-dispute thread: aged media fully preserved as evidence */
    assert.ok(mediaRow(S.disMedia), 'dispute-thread media row preserved');
    assert.ok(fileThere('bw-dispute.jpg'), 'dispute-thread media file preserved');
    assert.equal(msgCount(S.convDispute), 1, 'dispute-thread message preserved');
  } finally {
    stop(h);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
