'use strict';
/*
 * Per-fan PPV watermark — when a fan unlocks PPV media, the copy HE sees
 * wears a discreet overlay naming his account ("@username · #A1B2"), so a
 * leaked screenshot or screen recording names its source.
 *
 * Design (and its honest limits): the underlying media file is SHARED —
 * every unlocker is served the same bytes by /api/media/:id/file — so the
 * watermark is a client-side overlay rendered by mediaHTML (the single
 * render path for chat media: initial load, WS updates, and the unlock
 * refresh all flow through bubbleHTML → mediaHTML). Per-fan server-side
 * image burning does not exist in this pipeline and is out of scope. The
 * overlay deters casual reposting and traces leaks; it does NOT stop a
 * determined extractor, and no UI copy claims otherwise.
 *
 * Identity rules pinned here:
 *  - the tag is the VIEWING fan's username + a 4-hex scrambled fragment of
 *    his account id (deterministic: same fan, same tag on every tile)
 *  - NEVER his email, NEVER the full numeric id
 *  - shown ONLY to a fan viewer, ONLY on unlocked ppv_image / ppv_video
 *    he purchased (price > 0) — not on locked tiles, not on $0 free
 *    previews, not on voice notes, not in the model's/sender's own view,
 *    not for staff
 *
 * Layers: (1) logic tests running the REAL ppvWatermarkHTML /
 * fanTagFragment extracted from app.js in a vm (discovery.test.js
 * pattern) against fabricated viewers/messages; (2) source pins for the
 * render wiring, CSS, i18n, and the first-unlock note; (3) pins that the
 * unlock flow itself is untouched.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const REPO = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const app = read('public/js/app.js');
const server = read('server.js');
const css = read('public/css/styles.css');

/* ---------------- client logic (extracted real functions) ---------------- */

function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  let depth = 0;
  let end = -1;
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (!depth) { end = j + 1; break; } }
  }
  assert.ok(end > start, `${name} braces must balance`);
  return src.slice(start, end);
}
function extractEsc(src) {
  const start = src.indexOf('const esc = ');
  assert.ok(start >= 0, 'esc must exist');
  const end = src.indexOf(';\n', start);
  assert.ok(end > start, 'esc statement must terminate');
  return src.slice(start, end + 1);
}

const ctx = { S: { user: null } };
vm.createContext(ctx);
vm.runInContext(
  extractEsc(app) + '\n'
  + extractFn(app, 'fanTagFragment') + '\n'
  + extractFn(app, 'ppvWatermarkHTML')
  + '\n;globalThis.__x = { fanTagFragment, ppvWatermarkHTML };', ctx);
const { fanTagFragment, ppvWatermarkHTML } = ctx.__x;

const FAN = { id: 4242, username: 'hornyfan99', role: 'fan', email: 'secret@example.com' };
const MODEL_ID = 7;
const bought = (kind, over = {}) => ({
  sender_id: MODEL_ID,
  media: { id: 99, kind, price_cents: 999, duration_sec: 0, unlocked: true, ...over },
});
function asUser(user, msg) {
  ctx.S.user = user;
  return ppvWatermarkHTML(msg);
}

test('watermark: a fan who unlocked a PPV photo sees his own tag on it', () => {
  const html = asUser(FAN, bought('ppv_image'));
  assert.ok(html.includes('class="media-wm"'), html);
  assert.ok(html.includes('@hornyfan99'), html);
  assert.match(html, /@hornyfan99 · #[0-9A-F]{4}</, html);
});

test('watermark: a fan who unlocked a PPV video sees the same tag', () => {
  const img = asUser(FAN, bought('ppv_image'));
  const vid = asUser(FAN, bought('ppv_video'));
  assert.ok(vid.includes('class="media-wm"'), vid);
  assert.equal(vid, img, 'same fan, same tag on every unlocked tile');
});

test('watermark: identity never leaks email or the full numeric id', () => {
  const html = asUser(FAN, bought('ppv_image'));
  assert.ok(!html.includes('secret@example.com'), html);
  assert.ok(!html.includes('example.com'), html);
  assert.ok(!html.includes('4242'), html);
  assert.notEqual(fanTagFragment(FAN.id), String(FAN.id));
});

test('watermark: fragment is deterministic, 4-hex, and varies by fan', () => {
  assert.equal(fanTagFragment(4242), fanTagFragment(4242));
  assert.match(fanTagFragment(4242), /^[0-9A-F]{4}$/);
  assert.notEqual(fanTagFragment(4242), fanTagFragment(4243));
});

test('watermark: absent for the model/sender, staff, and guests', () => {
  assert.equal(asUser({ id: MODEL_ID, username: 'bunny', role: 'model' }, bought('ppv_image')), '',
    "the model's own view of her media carries no watermark");
  assert.equal(asUser({ id: 1, username: 'boss', role: 'admin' }, bought('ppv_image')), '');
  assert.equal(asUser(null, bought('ppv_image')), '', 'guests get none');
  // Even in the impossible case of a fan being the sender, his own view is clean.
  assert.equal(asUser(FAN, { sender_id: FAN.id, media: bought('ppv_image').media }), '');
});

test('watermark: absent on locked tiles, free previews, and voice notes', () => {
  assert.equal(asUser(FAN, bought('ppv_image', { unlocked: false })), '', 'locked view: no watermark');
  assert.equal(asUser(FAN, bought('ppv_video', { unlocked: false })), '');
  assert.equal(asUser(FAN, bought('ppv_image', { price_cents: 0 })), '', '$0 free preview was not purchased');
  assert.equal(asUser(FAN, bought('voice', { duration_sec: 12 })), '', 'voice notes have no visual surface');
  assert.equal(asUser(FAN, { sender_id: MODEL_ID, media: null }), '');
});

test('watermark: a hostile username is escaped, never raw HTML', () => {
  const html = asUser({ id: 5150, username: 'a<b>"x', role: 'fan' }, bought('ppv_image'));
  assert.ok(html.includes('@a&lt;b&gt;&quot;x'), html);
  assert.ok(!html.includes('<b>'), html);
});

/* ---------------- source pins: wiring, CSS, copy ---------------- */

test('pins: mediaHTML renders the watermark ONLY in the unlocked image/video tiles', () => {
  assert.ok(app.includes('<img class="ppv-img" data-media-src="${md.id}" alt="photo">${veil}${ppvWatermarkHTML(m)}'),
    'unlocked photo tile wears the watermark');
  assert.ok(app.includes('<video class="ppv-vid" data-media-src="${md.id}" controls playsinline preload="metadata"></video>${veil}${ppvWatermarkHTML(m)}'),
    'unlocked video tile wears the watermark');
  const calls = app.match(/\$\{ppvWatermarkHTML\(m\)\}/g) || [];
  assert.equal(calls.length, 2, 'exactly two render call sites (image + video)');
  const locked = app.slice(app.indexOf('// Locked: pretty blurred tile'));
  assert.ok(!locked.includes('ppvWatermarkHTML') && !locked.includes('media-wm'),
    'the locked-tile branch stays watermark-free');
});

test('pins: overlay CSS never intercepts taps and stays discreet', () => {
  const rule = css.match(/\.media-wm\s*\{([^}]*)\}/);
  assert.ok(rule, '.media-wm rule exists');
  assert.ok(rule[1].includes('pointer-events: none'), 'overlay never blocks media interaction/controls');
  assert.ok(rule[1].includes('position: absolute'), 'overlay rides on the media-wrap');
  assert.ok(rule[1].includes('user-select: none'));
});

test('pins: the watermark note exists in all 13 languages', () => {
  const keys = app.match(/ppv_watermark_note:/g) || [];
  assert.equal(keys.length, 13, 'one ppv_watermark_note per locale');
  assert.ok(app.includes("ppv_watermark_note: 'Unlocked content is watermarked with your username.'"));
  assert.ok(app.includes("ppv_watermark_note: 'El contenido desbloqueado lleva una marca de agua con tu nombre de usuario.'"));
  assert.ok(app.includes('ppv_watermark_note: \'O conteúdo desbloqueado tem marca d’água com o seu nome de usuário.\''));
});

test('pins: the note rides the FIRST unlock of a session, then stays quiet', () => {
  assert.ok(app.includes('let wmNoteShown = false;'), 'session flag exists');
  assert.ok(app.includes("toast(`🔓 Unlocked! ${t('ppv_watermark_note')}`, 4200)"),
    'first successful unlock carries the note');
  assert.ok(app.includes("toast('🔓 Unlocked!')"), 'later unlocks keep the plain toast');
});

test('pins: the unlock flow and media serving are untouched', () => {
  assert.ok(app.includes("api(`/media/${mediaId}/unlock`, { method: 'POST' })"),
    'client still unlocks through the same endpoint');
  assert.ok(server.includes("app.post('/api/media/:id/unlock', identMiddleware, requireUser, requireRole('fan')"),
    'server unlock route unchanged');
  assert.ok(server.includes("app.get('/api/media/:id/file'"),
    'shared media file route unchanged (bytes are per-fan identical by design)');
});
