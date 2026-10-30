'use strict';
/*
 * A22 — Ms. Pink's lane, parts 4–8 (WIP handover to Kay Kay, Oct 30 2026).
 *
 * Part 4 (Share her profile): the server issues `share_url` on the
 * GET /api/models payload ONLY for profiles the public page serves
 * (same role/banned/hidden roster) and NEVER for the house; the peek
 * renders her Share button only when share_url is present, and the
 * tap rides the share-sheet / copy-link pattern of shareApp.
 * Part 5 (Playlist rows): name owns its column (pl-name), presence
 * dot inline, @username shown, Message/Remove in their own row
 * (pl-actions) UNDER the identity block — the old right-side button
 * span that overlapped wrapped names is gone.
 * Part 6 (profile video sound): DIAGNOSED layer (a) — the peek
 * toggles flipped .muted but never removed the `muted` content
 * attribute, which iOS Safari requires before unmute takes (the
 * battle/live unmute handlers in the same file already do both).
 * Layer (c) is ALSO true of the owner's test video: ffprobe of the
 * real served file for @Muvaceee shows h264 video and NO audio
 * stream, while @tokyoo's two preview videos carry AAC — so (a) is
 * the code bug and (c) explains that one file. No transcode exists
 * anywhere in the upload path (files are stored as uploaded).
 * Part 7 (full-screen viewer): openMediaViewer is fed ONLY the
 * shaped arrays the profile already rendered (galleryPics, her two
 * main videos, the gate-cleared feed items) and fetches nothing —
 * gating parity by construction. ⤢ chips on heroes + feed videos
 * are ours and wired (previously NO expand control existed in the
 * app at all — the glyph the owner tapped was native-controls
 * furniture, inert in the installed app).
 * Part 8 (Message her button): server half PROVEN live below —
 * POST /api/conversations/start as a fan returns 200 + a full
 * conversation. The seasonal decorations are pointer-events:none
 * (theme-base.css particles + theme.js popup, inline and !important)
 * so they render OVER the button but cannot eat its tap. Remaining
 * client suspects are listed in A22-HANDOVER.md.
 *
 * Static source pins per suite convention + one live boot.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(REPO, 'public/js/app.js'), 'utf8');
const css = fs.readFileSync(path.join(REPO, 'public/css/styles.css'), 'utf8');
const server = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
const themeBase = fs.readFileSync(path.join(REPO, 'public/css/themes/theme-base.css'), 'utf8');

const peekStart = app.indexOf('function openModelPeek(');
const peekEnd = app.indexOf('async function vFanModels()', peekStart);
const peek = app.slice(peekStart, peekEnd);

/* ---------------- part 4: share ---------------- */

test('part 4: server issues share_url on the public roster only, never the house', () => {
  assert.ok(server.includes('share_url: r.id === houseId ? null'),
    'share_url is nulled for the house account id');
  assert.ok(server.includes("SEO_ORIGIN + '/models/' + encodeURIComponent(r.username)"),
    'share_url is the canonical public page URL');
});

test('part 4: peek Share button renders only with share_url and shares via the app pattern', () => {
  assert.ok(peek.includes('data-peek-share="${m.id}"'), 'share button rendered in the peek');
  assert.ok(peek.includes('${m.share_url ?'), 'button is gated on the server-issued share_url');
  assert.ok(peek.includes("t('share_profile')"), 'button label is i18n-keyed');
  assert.ok(peek.includes('shareBtn.onclick = () => shareModelProfile(m)'), 'tap wired');
  const fn = app.slice(app.indexOf('async function shareModelProfile('),
    app.indexOf('async function openChatWithModel('));
  assert.ok(fn.includes('navigator.share'), 'native share sheet first');
  assert.ok(fn.includes('navigator.clipboard.writeText(url)'), 'copy-link fallback');
  assert.ok(fn.includes("toast(t('link_copied'))"), '"Link copied" feedback via toast');
  assert.equal((app.match(/share_profile:/g) || []).length, 13,
    'share_profile label exists in all 13 language blocks');
});

/* ---------------- part 5: playlist rows ---------------- */

test('part 5: playlist card — identity block owns the column, buttons in their own row under it', () => {
  const card = app.slice(app.indexOf('function playlistCardHTML(m)'),
    app.indexOf('async function vPlaylist()'));
  assert.ok(card.includes('class="pl-name"'), 'name has its own full-width line');
  assert.ok(card.includes('pl-dot'), 'presence dot renders inline beside the name');
  assert.ok(card.includes('@${esc(m.username)}'), '@username shows under the name');
  assert.ok(card.includes('class="pl-actions"'), 'buttons live in a dedicated actions row');
  assert.ok(card.indexOf('class="pl-actions"') > card.indexOf('class="pl-name"'),
    'actions row comes AFTER the identity block, never beside it');
  assert.ok(!card.includes('<span class="row" style="gap:6px">'),
    'the old right-side button span (the overlap) is gone');
  assert.ok(card.includes('data-pl-msg="${m.id}"') && card.includes('data-pl-remove="${m.id}"'),
    'Message + Remove preserved');
  assert.ok(css.includes('.pl-actions') && css.includes('.pl-name') && css.includes('.pl-dot'),
    'playlist layout CSS exists');
});

/* ---------------- part 6: sound fix ---------------- */

test('part 6: peek unmute removes the muted attribute (the iOS trap), both videos', () => {
  assert.ok(peek.includes("pv.removeAttribute('muted')"), 'hero toggle removes the attribute');
  assert.ok(peek.includes("pv2.removeAttribute('muted')"), 'second-video toggle removes it too');
  // The working precedent this matches (battle + live unmute):
  assert.ok(app.includes("v.removeAttribute('muted')"), 'battle/live precedent present in file');
});

/* ---------------- part 7: full-screen viewer ---------------- */

test('part 7: viewer exists, is fetch-free (gating parity), and every entry point is wired', () => {
  assert.ok(app.includes('function openMediaViewer('), 'viewer component exists');
  const viewer = app.slice(app.indexOf('function openMediaViewer('),
    app.indexOf('/* Model browsing the home screen'));
  assert.ok(!viewer.includes('api('), 'viewer fetches NOTHING — it serves only what the profile served');
  assert.ok(viewer.includes('history.pushState'), 'open pushes a history state');
  assert.ok(viewer.includes("addEventListener('popstate'"), 'hardware/browser back closes the viewer');
  assert.ok(viewer.includes("vid.removeAttribute('muted')"), 'viewer video carries the part-6 sound fix');
  assert.ok(viewer.includes('${index + 1} / ${items.length}'), 'position indicator (n / N)');
  assert.ok(peek.includes('data-peek-photo="${gi}"'), 'gallery pictures carry viewer indices');
  assert.ok(peek.includes('galleryPics.map((u) => ({ kind: \'photo\', url: u }))'),
    'gallery viewer is fed the SAME shaped galleryPics array');
  assert.ok(peek.includes('data-peek-expand="0"') && peek.includes('data-peek-expand="1"'),
    'both main videos carry an expand chip');
  assert.ok(app.includes('data-feed-expand="${fi}"'), 'clean-feed videos carry an expand chip');
  assert.ok(app.includes('data-feed-photo="${fi}"'), 'clean-feed photos open the viewer');
  assert.ok(css.includes('.media-viewer') && css.includes('.mv-back'),
    'viewer CSS exists with an always-visible back button');
});

/* ---------------- part 8: message-button diagnosis pins ---------------- */

test('part 8: seasonal decorations can never intercept taps (static proof)', () => {
  const particles = themeBase.slice(themeBase.indexOf('.sc-theme-particles {'),
    themeBase.indexOf('.sc-theme-particles span'));
  assert.ok(particles.includes('pointer-events: none'),
    'the falling-emoji particle layer is pointer-events:none');
  const theme = fs.readFileSync(path.join(REPO, 'public/js/theme.js'), 'utf8');
  assert.ok(theme.includes("box.style.pointerEvents = 'none'"),
    'the Halloween popup girl is pointer-events:none inline');
});

/* ---------------- live: share_url + landing + message flow ---------------- */

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
  return { child, base };
}

test('live: share_url shape, public-page landing, and the fan Message flow (part 8 server half)',
  { timeout: 120000 }, async (t) => {
    const h = await boot(makeCopy(), { SEED_DEMO: '1' });
    t.after(() => { if (h.child.exitCode === null) h.child.kill('SIGKILL'); });
    const { base } = h;

    const modelsRes = await fetch(base + '/api/models');
    const modelsJson = await modelsRes.json();
    assert.ok(modelsJson.models.length > 0, 'seeded models present');
    for (const m of modelsJson.models) {
      assert.equal(m.share_url, 'https://slutcamp.app/models/' + encodeURIComponent(m.username),
        `public model ${m.username} carries her canonical share_url`);
    }
    // The demo seed creates no house account, so `official` is null
    // here; the house guard itself is pinned statically above
    // (share_url is nulled for houseId in shapeRow, unconditionally).
    if (modelsJson.official) {
      assert.ok(!modelsJson.official.share_url, 'the house NEVER carries a share_url');
    }

    // A signed-out visitor opening the shared link lands on HER page.
    const page = await fetch(base + '/models/bunny');
    assert.equal(page.status, 200, 'public profile page serves signed-out');
    const html = await page.text();
    assert.ok(html.includes('Bunny'), 'the page is hers, not the homepage');

    // Part 8, server half: a fan tapping "Message her" gets a thread.
    const login = await fetch(base + '/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'fandemo', password: 'fan123' }),
    });
    const { token } = await login.json();
    assert.ok(token, 'demo fan logs in');
    const start = await fetch(base + '/api/conversations/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify({ model_id: modelsJson.models[0].id }),
    });
    assert.equal(start.status, 200, 'conversations/start succeeds for a fan');
    const started = await start.json();
    assert.ok(started.conversation && started.conversation.id,
      'a conversation is created/returned — the Message flow server half is healthy');
  });
