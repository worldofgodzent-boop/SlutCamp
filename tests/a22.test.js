'use strict';
/*
 * A22 (Owner phone report via Ms. Pink, Oct 30 2026) — all eight parts:
 *  1. The heart is LIKE only; Follow is its own button with its own
 *     state. Before A22 the fan-home tile heart WAS the follow (it
 *     posted to /api/follows and her Likes never moved).
 *  2. Her profile (the peek) carries working Like + Follow buttons on
 *     the same endpoints/state as the tiles; counts sync both ways
 *     through the shared [data-like-count] / [data-follow-count]
 *     sweeps. The Message bar stays pinned as-is.
 *  3. A fan's own profile (Wallet settings stack) leads with his
 *     display name, @username under it, @username fallback, and an
 *     edit field riding the existing PATCH /api/me/display-name.
 *  4. Share her profile — the server issues share_url (canonical
 *     /models/<username>) exactly when her public page serves, never
 *     for the house; native share sheet + clipboard fallback, in the
 *     peek and on her public page.
 *  5. Playlist rows: identity band (avatar, full name one line,
 *     online dot inline beside the name, @username + price + status
 *     under) with Message her / Remove as a button row UNDER it.
 *  6. Profile video sound: layer (a) — the peek toggles flipped only
 *     the muted PROPERTY while the markup's muted CONTENT attribute
 *     kept iOS Safari's defaultMuted in charge. Fix mirrors the
 *     house unmute triple (muted=false + removeAttribute('muted') +
 *     play() inside the tap) in both peek toggles.
 *  7. Full-screen media viewer for her pictures + videos (gallery,
 *     hero ⤢, clean feed expand) — Ms. Pink lane's component,
 *     integrated: it receives the exact gate-shaped arrays the
 *     profile rendered and fetches nothing, so locked/held media
 *     never enters it; the peek underneath is never re-rendered.
 *  8. "Message her" audit: the Wicked decorations render OVER the
 *     button (z-9990) but are pointer-events-killed three ways; the
 *     kill now also lives in theme-base.css so it no longer depends
 *     on a theme pack loading. Tap-to-chat traced: peek bar and
 *     Playlist rows both ride openChatWithModel.
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
const cssSrc = fs.readFileSync(path.join(REPO, 'public/css/styles.css'), 'utf8');
const themeBaseSrc = fs.readFileSync(path.join(REPO, 'public/css/themes/theme-base.css'), 'utf8');

const LANG13 = ['en', 'es', 'pt', 'fr', 'de', 'ru', 'ja', 'zh', 'ko', 'it', 'pl', 'nl', 'tr'];

/* Brace-matching extractor (same approach as the playlist suite). */
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

/* ---------------- STR: A22 keys in all 13 languages ---------------- */

test('STR: A22 keys exist in all 13 languages', () => {
  const I18N = evalBlock(appSrc, 'const I18N =', 'I18N');
  const keys = ['follow_btn', 'following_btn', 'share_profile_btn',
    'share_profile_text', 'fan_profile_h', 'name_saved_toast'];
  for (const lang of LANG13) {
    for (const k of keys) {
      assert.equal(typeof I18N[lang][k], 'string', `${lang}:${k} exists`);
      assert.ok(I18N[lang][k].trim().length > 0, `${lang}:${k} non-empty`);
    }
    assert.ok(I18N[lang].share_profile_text.includes('{name}'), `${lang}: share text names her`);
  }
  assert.equal(I18N.en.follow_btn, 'Follow');
  assert.equal(I18N.en.following_btn, '✓ Following');
});

/* ---------------- Part 1: Like ≠ Follow ---------------- */

test('part 1: toggleLike posts to the like endpoint only; toggleFollow never touches likes', () => {
  const like = slice(appSrc, 'async function toggleLike(', 'async function toggleFollow(');
  assert.ok(like.includes('`/models/${modelId}/like`'), 'like posts to the like endpoint');
  assert.ok(!like.includes('/follows'), 'like never touches the follows endpoint');
  assert.ok(like.includes('[data-like-count="${modelId}"]'), 'like sweeps every rendered like count');
  assert.ok(like.includes("t('like_need_fan')"), 'non-fans get the sign-in toast');
  const fol = slice(appSrc, 'async function toggleFollow(', '// Web Push');
  assert.ok(fol.includes('`/follows/${modelId}`'), 'follow posts to the follows endpoint');
  assert.ok(!fol.includes('/like'), 'follow never touches the like endpoint');
  assert.ok(fol.includes("t('following_btn')") && fol.includes("t('follow_btn')"),
    'follow controls wear Follow / Following state text');
});

test('part 1: fan-home tiles render a Like heart AND a separate Follow pill', () => {
  const view = slice(appSrc, 'async function vFanModels()', '/* ---------------- FAN: My Playlist');
  assert.ok(view.includes('data-follow-btn="${m.id}"'), 'tile carries its own Follow pill');
  assert.ok(view.includes('data-like="${m.id}"'), 'tile heart is a Like');
  assert.ok(view.includes("t('following_btn')") && view.includes("t('follow_btn')"),
    'pill renders its state from the follow keys');
  assert.ok(!view.includes('data-follow="${m.id}"'), 'the old follow-heart is gone');
  assert.ok(view.includes("querySelectorAll('[data-like]')") && view.includes('toggleLike('),
    'tile hearts wire to toggleLike');
  assert.ok(view.includes("querySelectorAll('[data-follow-btn]')") && view.includes('toggleFollow('),
    'tile pills wire to toggleFollow');
  const land = slice(appSrc, 'async function vLanding()', '/* Share the app');
  assert.ok(land.includes("querySelectorAll('[data-like]')") && land.includes('toggleLike('),
    'landing hearts ride the same toggleLike');
});

/* ---------------- Part 2: her profile ---------------- */

test('part 2: peek carries working Like + Follow; both counts carry the sync attributes', () => {
  const peek = slice(appSrc, 'function openModelPeek(', 'async function loadPeekFeed(');
  assert.ok(peek.includes('data-peek-like="${m.id}"'), 'profile Like button renders');
  assert.ok(peek.includes("t('likes_label')"), 'Like button is labelled');
  assert.ok(peek.includes('data-peek-playlist="${m.id}"'), 'profile Follow button renders (playlist-toggle)');
  assert.ok(peek.includes('>${t(\'follow_btn\')}</button>'), 'Follow button starts from the Follow label');
  assert.ok(peek.includes('<b data-like-count="${m.id}">'), 'Likes row syncs via data-like-count (was display-only)');
  assert.ok(peek.includes('<b data-follow-count="${m.id}">'), 'Followers row keeps data-follow-count');
  assert.ok(peek.includes('toggleLike(m.id, likeBtn)'), 'profile Like rides toggleLike');
  assert.ok(peek.includes("plBtn.textContent = on ? t('following_btn') : t('follow_btn')"),
    'follow state loads as Follow / Following');
  assert.ok(peek.includes('toggleFollow(m.id, plBtn, m.display_name)'), 'profile Follow rides toggleFollow');
  assert.ok(peek.includes("S.user.role === 'fan'"), 'action row stays true-fan gated');
  assert.ok(peek.includes('data-peek-msg="${m.id}"'), 'Message bar still renders pinned');
  assert.ok(peek.includes('openChatWithModel(id)'), 'Message bar still opens the chat');
});

/* ---------------- Part 3: fan profile ---------------- */

test('part 3: fan profile card leads with display name, @username under, fallback + edit field', () => {
  const card = slice(appSrc, 'function renderFanProfileCard()', 'function renderPwSettingsCard()');
  assert.ok(card.includes("S.user.display_name || ('@' + S.user.username)"),
    'lead falls back to the @username when no display name is set');
  assert.ok(card.includes('fan-profile-name'), 'the lead name renders as the header line');
  assert.ok(card.includes('@${esc(S.user.username)}'), '@username renders under the lead');
  assert.ok(card.includes('id="fp-name"'), 'edit field renders');
  assert.ok(card.includes("api('/me/display-name'") && card.includes("method: 'PATCH'"),
    'save rides the existing PATCH endpoint — no new endpoint');
  assert.ok(card.includes("S.user.role !== 'fan'"), 'card is fan-only (the endpoint refuses other roles)');
  assert.ok(card.includes('(data && data.message)'), 'server messages (cooldown) surface verbatim');
  assert.ok(appSrc.includes('id="fan-profile-card"'), 'wallet renders the card host');
  const walletStart = appSrc.indexOf('async function vWallet()');
  assert.ok(walletStart >= 0 && appSrc.indexOf('renderFanProfileCard();', walletStart) > walletStart,
    'wallet calls the renderer');
  const srv = slice(serverSrc, "app.patch('/api/me/display-name'", "app.patch('/api/me/language'");
  assert.ok(srv.includes("error: 'too_soon'") && srv.includes('429'), 'server cooldown contract intact');
});

/* ---------------- Part 4: share her profile ---------------- */

test('part 4: share rides the server-issued canonical URL; peek + public page; house never shareable', () => {
  assert.ok(serverSrc.includes('share_url: r.id === houseId ? null')
      && serverSrc.includes(": SEO_ORIGIN + '/models/' + encodeURIComponent(r.username)"),
    'the server issues share_url exactly when her public page serves — never for the house');
  const share = slice(appSrc, 'async function shareModelProfile(', 'async function openChatWithModel(');
  assert.ok(share.includes('m.share_url'), 'the client shares the server-issued URL, never a built one');
  assert.ok(share.includes('navigator.share'), 'native share sheet first');
  assert.ok(share.includes('navigator.clipboard'), 'clipboard fallback');
  const peek = slice(appSrc, 'function openModelPeek(', 'async function loadPeekFeed(');
  assert.ok(peek.includes('data-peek-share="${m.id}"'), 'peek renders the Share button');
  assert.ok(peek.includes('${m.share_url ? `<button class="btn ghost" data-peek-share='),
    'the button renders only when a share_url exists (public, non-house)');
  assert.ok(peek.includes('shareModelProfile(m)'), 'peek Share wires to the helper');
  assert.ok(peek.includes("t('share_profile')"), 'button label comes from the share_profile STR key');
  assert.ok(serverSrc.includes('id="share-profile"'), 'her public page carries a Share button');
  assert.ok(serverSrc.includes("getElementById('share-profile')"), 'public page wires it');
});

/* ---------------- Part 5: playlist rows ---------------- */

test('part 5: playlist card = identity column over a full-width button row', () => {
  const card = slice(appSrc, 'function playlistCardHTML(m)', 'async function vPlaylist()');
  assert.ok(card.includes('class="grow pl-id"'), 'identity column exists');
  assert.ok(card.includes('class="pl-name"'), 'her name has its own line');
  assert.ok(card.includes('@${esc(m.username)}'), '@username under the name');
  assert.ok(card.includes("t('per_msg_rate'"), 'price under the name');
  assert.ok(card.includes('<span class="pl-dot"></span>'), 'presence dot inline beside the name');
  assert.ok(card.includes('class="pl-actions"'), 'button row exists');
  assert.ok(card.indexOf('data-pl-msg') > card.indexOf('class="pl-actions"'),
    'Message her lives in the button row, not beside the name');
  assert.ok(card.indexOf('data-pl-remove') > card.indexOf('class="pl-actions"'),
    'Remove lives in the button row too');
  assert.ok(card.indexOf('class="pl-actions"') > card.indexOf('class="pl-name"'),
    'the button row sits UNDER the identity block');
  assert.ok(cssSrc.includes('.pl-actions { display: flex;'), 'button row is a flex row');
  assert.ok(cssSrc.includes('.pl-actions .btn { flex: 1; }'), 'buttons share the row evenly');
  assert.ok(cssSrc.includes('.pl-name { font-weight: 700;'), 'name line is styled as its own line');
  const view = slice(appSrc, 'async function vPlaylist()', 'async function vFanChats()');
  assert.ok(view.includes('openChatWithModel') && view.includes('toggleFollow'),
    'behaviors unchanged: Message → chat, Remove → toggle off');
});

/* ---------------- Part 6: sound fix at layer (a) ---------------- */

test('part 6: both peek sound toggles run the full unmute triple', () => {
  const peek = slice(appSrc, 'function openModelPeek(', 'async function loadPeekFeed(');
  const triples = peek.match(/removeAttribute\('muted'\)/g) || [];
  assert.ok(triples.length >= 2, 'hero + second video both remove the muted attribute');
  assert.ok(peek.includes('pv.muted = false') && peek.includes('pv2.muted = false'),
    'both flip the muted property');
  assert.ok(peek.includes('pv.muted = true') && peek.includes('pv2.muted = true'),
    'tap again re-mutes on both');
  const all = appSrc.match(/removeAttribute\('muted'\)/g) || [];
  assert.ok(all.length >= 5,
    'the house unmute pattern (battle stage + live watch) exists and the peek now mirrors it');
});

/* ---------------- Part 7: full-screen viewer ---------------- */

test('part 7: viewer renders handed-in media only; locked media never enters it', () => {
  const viewer = slice(appSrc, 'function openMediaViewer(', 'function closeMediaViewer(');
  assert.ok(appSrc.includes('function renderMediaViewer()'), 'viewer renderer exists');
  assert.ok(appSrc.includes('function mediaViewerGo('), 'viewer pager exists');
  assert.ok(viewer.includes('history.pushState'), 'opening pushes one history state so hardware Back closes the viewer');
  assert.ok(!viewer.includes('api('), 'the viewer fetches nothing — gating parity by construction, no bypass path');
  const peek = slice(appSrc, 'function openModelPeek(', 'async function loadPeekFeed(');
  assert.ok(peek.includes('data-peek-photo="${gi}"'), 'gallery pictures open the viewer');
  assert.ok(peek.includes('data-peek-expand="0"') && peek.includes('data-peek-expand="1"'),
    'both hero videos carry the expand chip');
  assert.ok(peek.includes('openMediaViewer('), 'peek wires the viewer');
  assert.ok(peek.includes('galleryPics.map((u) => ({ kind: \'photo\', url: u }))'),
    'the viewer receives the exact shaped gallery array the profile rendered');
  const feed = slice(appSrc, 'async function loadPeekFeed(', 'async function loadPeekPackages(');
  assert.ok(feed.includes('data-feed-expand="'), 'clean feed video tiles carry the expand chip');
  assert.ok(feed.includes('openMediaViewer(feedItems'), 'feed expand opens the viewer on the gate-cleared items');
  assert.ok(cssSrc.includes('.media-viewer {'), 'viewer styles exist');
  assert.ok(cssSrc.includes('z-index: 9990'), 'viewer rides above the app surfaces');
});

/* ---------------- Part 8: Message her audit ---------------- */

test('part 8: decorations can never eat a tap; every Message her routes to the chat', () => {
  assert.ok(themeBaseSrc.includes(".sc-popup, .sc-popup * { pointer-events: none !important; }"),
    'the pointer-events kill lives in theme-base.css, independent of any theme pack');
  const peek = slice(appSrc, 'function openModelPeek(', 'async function loadPeekFeed(');
  assert.ok(peek.includes("sheet.remove();") && peek.includes('openChatWithModel(id)'),
    'peek Message bar: sheet closes, chat opens');
  const pl = slice(appSrc, 'async function vPlaylist()', 'async function vFanChats()');
  assert.ok(pl.includes('openChatWithModel(parseInt(b.dataset.plMsg))'),
    'playlist Message her opens the chat');
  const chatAt = appSrc.indexOf('async function openChatWithModel(');
  assert.ok(chatAt >= 0 && appSrc.slice(chatAt, chatAt + 900).includes("api('/conversations/start'"),
    'chat open rides the start endpoint');
});

/* ---------------- live: the engines stay separate ---------------- */

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-a22-'));
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

test('live: like and follow move independently; counts agree from every surface', { timeout: 120000 }, async (t) => {
  const dir = makeCopy();
  const h = await boot(dir, { SEED_DEMO: '1' });
  t.after(() => stop(h));
  const { base } = h;

  const js = await req(base, 'GET', '/js/app.js');
  assert.equal(js.status, 200);
  for (const needle of ['toggleLike', 'data-follow-btn', 'data-peek-like', 'openMediaViewer', 'shareModelProfile', 'renderFanProfileCard']) {
    assert.ok(js.text.includes(needle), `served app.js carries ${needle}`);
  }

  const signup = (body) => req(base, 'POST', '/api/auth/signup', {
    body: { password: 'a22-pass-1234', display_name: 'A22 Tester', dob: '1995-05-05', agree18: true, publicity_consent: true, ...body },
  });
  const fan = await signup({ username: 'a22fan', role: 'fan' });
  assert.equal(fan.status, 200, `fan signup: ${fan.text}`);
  const model = await signup({ username: 'a22model', role: 'model', section: 'female', display_name: 'A22 Model' });
  assert.equal(model.status, 200, `model signup: ${model.text}`);
  const fanTok = fan.json.token, modelTok = model.json.token, modelId = model.json.user.id;

  const roster = async (tok) => {
    const r = await req(base, 'GET', '/api/models', { token: tok });
    return (r.json.models || []).find((x) => x.id === modelId);
  };

  // LIKE: moves Likes only — she does NOT become a follower.
  const like = await req(base, 'POST', `/api/models/${modelId}/like`, { body: {}, token: fanTok });
  assert.equal(like.status, 200, `like: ${like.text}`);
  assert.equal(like.json.liked, true);
  assert.equal(like.json.like_count, 1);
  let row = await roster(fanTok);
  assert.equal(row.liked, true, 'roster shows his like');
  assert.equal(row.like_count, 1, 'roster Likes = 1');
  assert.equal(row.follower_count, 0, 'liking did NOT make him a follower');
  assert.deepEqual((await req(base, 'GET', '/api/follows', { token: fanTok })).json.following, [],
    'his Playlist/follows stay empty after a like');

  // FOLLOW: moves Followers only — Likes untouched.
  const fol = await req(base, 'POST', `/api/follows/${modelId}`, { body: {}, token: fanTok });
  assert.equal(fol.json.following, true);
  assert.equal(fol.json.follower_count, 1);
  row = await roster(fanTok);
  assert.equal(row.follower_count, 1, 'roster Followers = 1');
  assert.equal(row.like_count, 1, 'following did NOT move Likes');

  // UNLIKE: Likes back to 0, Followers stay.
  const unlike = await req(base, 'POST', `/api/models/${modelId}/like`, { body: {}, token: fanTok });
  assert.equal(unlike.json.liked, false);
  assert.equal(unlike.json.like_count, 0);
  row = await roster(fanTok);
  assert.equal(row.like_count, 0, 'unlike zeroes Likes');
  assert.equal(row.follower_count, 1, 'unliking keeps the follow');

  // Roles: models cannot like, anon cannot like or follow.
  assert.equal((await req(base, 'POST', `/api/models/${modelId}/like`, { body: {}, token: modelTok })).status, 403,
    'model token cannot like');
  assert.equal((await req(base, 'POST', `/api/models/${modelId}/like`, { body: {} })).status, 401,
    'anon cannot like');
});

test('live: fan display name — set, read back, cooldown, role gate', { timeout: 120000 }, async (t) => {
  const dir = makeCopy();
  const h = await boot(dir, { SEED_DEMO: '1' });
  t.after(() => stop(h));
  const { base } = h;

  const signup = (body) => req(base, 'POST', '/api/auth/signup', {
    body: { password: 'a22-pass-1234', dob: '1995-05-05', agree18: true, publicity_consent: true, ...body },
  });
  const fan = await signup({ username: 'a22namefan', role: 'fan', display_name: 'Original Name' });
  assert.equal(fan.status, 200, `fan signup: ${fan.text}`);
  const model = await signup({ username: 'a22namemodel', role: 'model', section: 'female', display_name: 'Name Model' });
  assert.equal(model.status, 200, `model signup: ${model.text}`);
  const fanTok = fan.json.token, modelTok = model.json.token;

  const set = await req(base, 'PATCH', '/api/me/display-name', { body: { display_name: 'New Fan Name' }, token: fanTok });
  assert.equal(set.status, 200, `set name: ${set.text}`);
  assert.equal(set.json.display_name, 'New Fan Name');
  const me = await req(base, 'GET', '/api/me', { token: fanTok });
  assert.equal(me.json.user.display_name, 'New Fan Name', '/api/me carries the new lead name');

  const again = await req(base, 'PATCH', '/api/me/display-name', { body: { display_name: 'Third Name' }, token: fanTok });
  assert.equal(again.status, 429, 'cooldown refuses an immediate second change');
  assert.equal(again.json.error, 'too_soon');

  assert.equal((await req(base, 'PATCH', '/api/me/display-name', { body: { display_name: 'Model Try' }, token: modelTok })).status, 403,
    'models are refused (fans_only)');
  assert.equal((await req(base, 'PATCH', '/api/me/display-name', { body: { display_name: 'X' }, token: fanTok })).status, 400,
    'one-character names refused');
});

test('live: her public page carries the Share button on the canonical URL', { timeout: 120000 }, async (t) => {
  const dir = makeCopy();
  const h = await boot(dir, { SEED_DEMO: '1' });
  t.after(() => stop(h));
  const { base } = h;

  const model = await req(base, 'POST', '/api/auth/signup', {
    body: { username: 'a22sharemodel', role: 'model', section: 'female', display_name: 'Share Model', password: 'a22-pass-1234', dob: '1995-05-05', agree18: true, publicity_consent: true },
  });
  assert.equal(model.status, 200, `model signup: ${model.text}`);
  const page = await req(base, 'GET', '/models/a22sharemodel');
  assert.equal(page.status, 200, `public page: ${page.status}`);
  assert.ok(page.text.includes('id="share-profile"'), 'share button renders on her public page');
  assert.ok(page.text.includes('rel="canonical"'), 'page canonicalizes to her profile URL');
});
