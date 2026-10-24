'use strict';
/*
 * "ADD TO PLAYLIST" (Asce, Oct 24 2026): "I want the fans when they
 * find who they like they get an option to add to favorites, but we
 * want to call it 'add to playlist'."
 *
 * THE FEATURE pinned here:
 *  - The follows engine is UNCHANGED underneath: same follows table,
 *    same POST /api/follows/:modelId toggle + GET /api/follows
 *    (fan role only), same live-alert notifications.
 *  - Every fan-facing label wears Playlist language in all 13
 *    languages: new STR keys (playlist_add / playlist_added /
 *    playlist_title / playlist_empty / playlist_added_toast /
 *    playlist_removed_toast / tab_playlist); follow_title now reads
 *    "Add to Playlist" and the notifications empty state sells the
 *    Playlist instead of "follow".
 *  - Her page (the peek sheet — the profile a fan lands on) carries an
 *    explicit "➕ Add to Playlist / ✓ In your Playlist" button riding
 *    toggleFollow; the tile heart keeps its spot.
 *  - New fan view vPlaylist ("🎵 My Playlist", tab next to Wallet):
 *    his models LIVE FIRST (most watchers first), then by true
 *    section rank; cards open her page / her live, carry Message and
 *    Remove. Ordering is the pure playlistOrder() — unit-tested here.
 *  - One fan, one Playlist: no named lists, no new endpoints.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const vm = require('node:vm');
const { spawn } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(REPO, 'public/js/app.js'), 'utf8');

const LANG13 = ['en', 'es', 'pt', 'fr', 'de', 'ru', 'ja', 'zh', 'ko', 'it', 'pl', 'nl', 'tr'];

/* Brace-matching const/function extractor (same approach as the
   languages-13 suite). */
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

/* ---------------- STR: Playlist language in all 13 ---------------- */

test('STR: playlist keys exist in all 13 languages; tile + notif copy rebranded', () => {
  const I18N = evalBlock(appSrc, 'const I18N =', 'I18N');
  const keys = ['playlist_add', 'playlist_added', 'playlist_title', 'playlist_empty',
    'playlist_added_toast', 'playlist_removed_toast', 'tab_playlist'];
  for (const lang of LANG13) {
    for (const k of keys) {
      assert.equal(typeof I18N[lang][k], 'string', `${lang}:${k} exists`);
      assert.ok(I18N[lang][k].trim().length > 0, `${lang}:${k} non-empty`);
    }
    assert.ok(/playlist|プレイリスト/i.test(I18N[lang].notif_empty_sub),
      `${lang}: notif empty sub sells the Playlist`);
    assert.ok(!/follow/i.test(I18N[lang].follow_title), `${lang}: follow_title no longer says "follow"`);
  }
  assert.equal(I18N.en.follow_title, 'Add to Playlist', 'the tile heart action reads Add to Playlist');
  assert.equal(I18N.en.playlist_add, '➕ Add to Playlist');
  assert.equal(I18N.en.playlist_added, '✓ In your Playlist');
  assert.equal(I18N.en.playlist_title, '🎵 My Playlist');
  assert.equal(I18N.en.tab_playlist, 'Playlist');
  assert.ok(I18N.en.playlist_added_toast.includes('{name}'), 'added toast names her');
  assert.ok(I18N.en.playlist_empty.includes('live alerts'), 'empty state sells the live alerts too');
});

/* ---------------- static pins: surfaces + engine reuse ---------------- */

test('pins: Playlist view registered, fan tab added next to Wallet, preview-safe', () => {
  assert.ok(appSrc.includes('playlist: vPlaylist'), 'VIEWS map registers the playlist view');
  assert.ok(appSrc.includes("lk: 'tab_playlist', view: 'playlist'"), 'fan tab bar carries the Playlist tab');
  const tabs = appSrc.slice(appSrc.indexOf('const TABS ='), appSrc.indexOf('function renderTabbar()'));
  assert.ok(tabs.indexOf("view: 'wallet'") < tabs.indexOf("view: 'playlist'"),
    'Playlist tab sits right after Wallet');
  assert.ok(appSrc.includes("['fanChats', 'bookings', 'wallet', 'playlist']"),
    'fan preview treats Playlist like Wallet (own-data surface → placeholder)');
  assert.ok(appSrc.includes('async function vPlaylist()'), 'the view exists');
  assert.ok(appSrc.includes("t('playlist_empty')"), 'empty state renders from STR');
});

test('pins: peek carries the explicit Playlist button, fan-only, riding toggleFollow', () => {
  assert.ok(appSrc.includes('data-peek-playlist="${m.id}"'), 'her page renders the button');
  assert.ok(appSrc.includes("S.user.role === 'fan'"), 'button is gated to true fans');
  assert.ok(appSrc.includes("btn.classList.contains('playlist-toggle')"),
    'toggleFollow swaps the Playlist button label/state');
  assert.ok(appSrc.includes("t('playlist_added_toast'"), 'add toast is localized');
  assert.ok(!appSrc.includes("Following — you'll be notified when she goes live!"),
    'old hardcoded follow toast is gone');
  assert.ok(!appSrc.includes("'🤍 Unfollowed'"), 'old hardcoded unfollow toast is gone');
});

test('pins: Playlist cards open her page / her live, carry Message + Remove', () => {
  const view = appSrc.slice(appSrc.indexOf('function playlistCardHTML(m)'),
    appSrc.indexOf('async function vFanChats()'));
  assert.ok(view.includes('playlistOrder(models, following)'), 'cards come from the pure ordering');
  assert.ok(view.includes('data-pl-open="${m.id}"'), 'card tap target exists');
  assert.ok(view.includes('watchLive(parseInt(m.live_session_id))'), 'a live card goes straight to her stream');
  assert.ok(view.includes('openModelPeek(m, models)'), 'an offline card opens her page');
  assert.ok(view.includes('data-pl-msg="${m.id}"') && view.includes('openChatWithModel'),
    'Message entry on the card');
  assert.ok(view.includes('data-pl-remove="${m.id}"') && view.includes('toggleFollow'),
    'Remove rides the same toggle');
  assert.ok(view.includes("api('/follows')"), 'the view reads the follows engine — no new endpoint');
});

test('pins: server follows engine untouched (same routes, fan role, toggle semantics)', () => {
  const post = serverSrc.slice(serverSrc.indexOf("app.post('/api/follows/:modelId'"),
    serverSrc.indexOf("app.get('/api/follows'"));
  assert.ok(post.includes("requireRole('fan')"), 'toggle stays fan-only');
  assert.ok(post.includes('DELETE FROM follows'), 'toggle off deletes the row');
  assert.ok(post.includes('INSERT INTO follows'), 'toggle on inserts the row');
  const get = serverSrc.slice(serverSrc.indexOf("app.get('/api/follows'"),
    serverSrc.indexOf("app.get('/api/notifications'"));
  assert.ok(get.includes("requireRole('fan')"), 'list stays fan-only');
  assert.ok(get.includes('following: rows.map'), 'list still returns followed model ids');
});

/* ---------------- behavior: playlistOrder ---------------- */

test('playlistOrder: live first (most watchers first), then section rank; unfollowed excluded', () => {
  const order = evalBlock(appSrc, 'function playlistOrder(models, followingIds)', 'playlistOrder');
  const M = (id, extra) => ({ id, display_name: 'M' + id, ...extra });
  const models = [
    M(1, { is_live: false, is_online: true, rank_position: 1 }),   // top rank, offline
    M(2, { is_live: true, live_viewers: 3, rank_position: 9 }),    // live, few watching
    M(3, { is_live: true, live_viewers: 40, rank_position: 2 }),   // live, busy
    M(4, { is_live: false, is_online: false, rank_position: 5 }),  // offline mid rank
    M(5, { is_live: false, is_online: false, rank_position: null }),// unranked
    M(6, { is_live: true, live_viewers: 99, rank_position: 1 }),   // live but NOT followed
  ];
  const out = order(models, [1, 2, 3, 4, 5]);
  assert.deepEqual(out.map((m) => m.id), [3, 2, 1, 4, 5],
    'live (busy first) → rank order → unranked last; not-followed never appears');
  assert.deepEqual(order(models, []), [], 'empty follows → empty playlist');
  assert.deepEqual(order([], [1, 2]), [], 'no models → empty playlist');
});

/* ---------------- live: the engine under its new name ---------------- */

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-playlist-'));
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

async function req(base, method, p, { body, token } = {}) {
  const h = {};
  let payload;
  if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  if (token) h.authorization = 'Bearer ' + token;
  const r = await fetch(base + p, { method, headers: h, body: payload });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not json */ }
  return { status: r.status, json, text };
}

test('live: fan adds/removes via the follows toggle; non-fans refused; served app carries Playlist', { timeout: 120000 }, async (t) => {
  const dir = makeCopy();
  const h = await boot(dir, { SEED_DEMO: '1' });
  t.after(() => stop(h));
  const { base } = h;

  // The served client carries the Playlist surface + copy.
  const js = await req(base, 'GET', '/js/app.js');
  assert.equal(js.status, 200);
  for (const needle of ['playlist_add', 'vPlaylist', 'data-peek-playlist', 'Add to Playlist', '🎵 My Playlist']) {
    assert.ok(js.text.includes(needle), `served app.js carries ${needle}`);
  }

  const signup = (body) => req(base, 'POST', '/api/auth/signup', {
    body: { password: 'playlist-pass-1', display_name: 'Playlist Tester', dob: '1995-05-05', agree18: true, ...body },
  });
  const fan = await signup({ username: 'playlistfan', role: 'fan' });
  assert.equal(fan.status, 200, `fan signup: ${fan.text}`);
  const model = await signup({ username: 'playlistmodel', role: 'model', section: 'female', display_name: 'Playlist Model' });
  assert.equal(model.status, 200, `model signup: ${model.text}`);
  const fanTok = fan.json.token, modelTok = model.json.token, modelId = model.json.user.id;

  // Anonymous: refused on both routes.
  assert.equal((await req(base, 'GET', '/api/follows')).status, 401, 'anon list refused');
  assert.equal((await req(base, 'POST', `/api/follows/${modelId}`, { body: {} })).status, 401, 'anon toggle refused');
  // A model is not a fan: the Playlist is a fan surface.
  assert.equal((await req(base, 'POST', `/api/follows/${modelId}`, { body: {}, token: modelTok })).status, 403,
    'model token cannot toggle');
  assert.equal((await req(base, 'GET', '/api/follows', { token: modelTok })).status, 403,
    'model token cannot list');

  // Add → listed → remove → gone. Unknown model 404s.
  const add = await req(base, 'POST', `/api/follows/${modelId}`, { body: {}, token: fanTok });
  assert.equal(add.status, 200, `add: ${add.text}`);
  assert.equal(add.json.following, true);
  const list1 = await req(base, 'GET', '/api/follows', { token: fanTok });
  assert.deepEqual(list1.json.following, [modelId], 'his Playlist holds exactly her');
  const missing = await req(base, 'POST', '/api/follows/99999999', { body: {}, token: fanTok });
  assert.equal(missing.status, 404, 'unknown model 404s');
  const remove = await req(base, 'POST', `/api/follows/${modelId}`, { body: {}, token: fanTok });
  assert.equal(remove.json.following, false);
  const list2 = await req(base, 'GET', '/api/follows', { token: fanTok });
  assert.deepEqual(list2.json.following, [], 'removed means gone');
});
