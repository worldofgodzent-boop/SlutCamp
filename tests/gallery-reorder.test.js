'use strict';
/*
 * Gallery hold-and-drag reorder (owner, Oct 17 2026): "Let the model
 * able to organize what picture they want at the top of the profile
 * by holding it and moving it around."
 *
 * Builds on PR #38's profile gallery (main photo + gallery uploads,
 * composed list capped at 10). In Settings → My photo, the COMPOSED
 * list is hold-and-drag reorderable — her main photo included, so
 * any picture can be dragged to position 1 and top her profile. The
 * drag arms only after a ~300ms hold: a plain tap never reorders
 * (the ✕ remove buttons stay plain taps), and a swipe before the
 * hold cancels the arm so scrolling still wins. On drop the order
 * auto-saves via POST /api/model/gallery-reorder.
 *
 * Storage: no new columns. The endpoint takes the full ordered
 * composed list; validation demands EXACTLY her current picture set
 * (same URLs, no duplicates, nothing added or dropped) and rejects
 * anything else with no state change. On save, position 1 becomes
 * photo_url and the remainder becomes gallery_photos in order —
 * "top of the profile" is the first entry everywhere the composed
 * list is read (directory payload, peek, Settings). The gallery
 * tail is re-checked against the photo-pipeline shape, the same
 * rule parseGalleryPhotos applies on read.
 *
 * Static pins + a functional boot against the real endpoints.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(REPO, 'public/js/app.js'), 'utf8');
const css = fs.readFileSync(path.join(REPO, 'public/css/styles.css'), 'utf8');
const server = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');

/* ------------------------------ static pins ------------------------------ */

test('endpoint: gallery-reorder is model-only and set-validated before any write', () => {
  const at = server.indexOf("app.post('/api/model/gallery-reorder'");
  assert.ok(at !== -1, 'reorder endpoint exists');
  const route = server.slice(at, at + 2600);
  assert.ok(route.includes("requireRole('model')"), 'models only');
  assert.ok(route.includes("error: 'bad_order'"), 'non-list payloads rejected');
  assert.ok(route.includes("error: 'duplicate_picture'"), 'duplicates rejected');
  assert.ok(route.includes("error: 'order_mismatch'"), 'foreign/missing pictures rejected');
  assert.ok(route.includes('const current = profilePicsList(row);'), 'validation reads the live composed list');
  assert.ok(route.includes('order.length !== current.length'), 'length must match the current set');
  assert.ok(route.includes('!current.includes(u)'), 'every submitted URL must already be hers');
  assert.ok(route.includes('!GALLERY_PHOTO_RE.test(u)'), 'gallery tail re-checked against the pipeline shape');
  assert.ok(route.includes('UPDATE models SET photo_url = ?, gallery_photos = ?'),
    'position 1 becomes photo_url, the rest become the gallery in order');
  assert.ok(route.indexOf("error: 'order_mismatch'") < route.indexOf('UPDATE models SET photo_url'),
    'validation runs before the write');
});

test('settings manager: every thumbnail (main included) is a drag item', () => {
  assert.ok(app.includes('data-pic="${esc(m.photo_url)}"'), 'main photo carries its URL as a drag item');
  assert.ok(app.includes('data-pic="${esc(u)}"'), 'gallery pictures carry their URLs as drag items');
  assert.ok(app.includes('draggable="false"'), 'native image drag disabled so pointer drag owns the gesture');
  assert.ok(app.includes("t('gallery_drag_hint')"), 'hold-and-drag hint shown with more than one picture');
  assert.ok(app.includes('data-gallery-del="${esc(u)}"'), 'remove control unchanged (PR #38)');
});

test('drag wiring: hold-to-arm, live DOM reorder, auto-save on drop, taps protected', () => {
  assert.ok(app.includes("item.addEventListener('pointerdown'"), 'drag starts from pointerdown on the item');
  assert.ok(app.includes('}, 300);'), 'the hold-to-arm delay is 300ms');
  assert.ok(app.includes("if (e.target.closest('[data-gallery-del]')) return;"),
    'a press starting on the ✕ never arms a drag');
  assert.ok(app.includes('try { item.setPointerCapture(e.pointerId); }'), 'pointer captured once the drag arms');
  assert.ok(app.includes('document.elementFromPoint(e.clientX, e.clientY)'), 'drop target resolved from the pointer');
  assert.ok(app.includes('galGrid.insertBefore(dragEl'), 'DOM order follows the drag live');
  assert.ok(app.includes("item.addEventListener('pointerup'"), 'drop handled on pointerup');
  assert.ok(app.includes("item.addEventListener('pointercancel'"), 'cancelled gestures clean up without saving');
  assert.ok(app.includes("api('/model/gallery-reorder', {"), 'drop auto-saves through the endpoint');
  assert.ok(app.includes("if (order.join('|') === originalOrder.join('|')) return;"),
    'an unchanged order is a no-op (plain hold + release saves nothing)');
  assert.ok(app.includes('if (Date.now() < galDragSuppressUntil) return;'),
    'the click ending a drag cannot land on a remove button');
  assert.ok(app.includes("toast(t('gallery_reordered'))"), 'subtle success toast on save');
});

test('drag styling: armed item lifts, thumbs never steal the gesture back', () => {
  assert.ok(css.includes('.set-gallery-item.dragging'), 'dragging state styled');
  const itemRule = css.slice(css.indexOf('.set-gallery-item {'), css.indexOf('.set-gallery-item {') + 300);
  assert.ok(itemRule.includes('touch-action: none'), 'page scroll cannot steal an armed drag');
});

test('new client strings exist in all 13 language tables', () => {
  for (const k of ['gallery_reordered', 'gallery_drag_hint']) {
    const hits = app.match(new RegExp(`${k}: '`, 'g')) || [];
    assert.equal(hits.length, 13, `${k} present once per language`);
  }
});

/* --------------------------- functional boot ----------------------------- */

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
  const headers = {};
  if (token) headers.authorization = 'Bearer ' + token;
  const r = await fetch(base + p, { method: 'POST', headers, body: fd });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
  return { status: r.status, text, json };
}

test('functional: reorder swaps the main photo, validation rejects anything but her exact set', async () => {
  const dir = makeCopy('galleryreorder');
  let h = null;
  try {
    h = await boot(dir, {});
    const sfx = Math.random().toString(36).slice(2, 8);
    const mk = async (name, role) => {
      const s = await req(h.base, 'POST', '/api/auth/signup', {
        body: { username: name + sfx, password: 'reorder-pass-123', role, display_name: name, dob: '1996-04-12', agree18: true },
      });
      assert.equal(s.status, 200, `signup ${name} failed: ${s.text}`);
      return { id: s.json.user.id, token: s.json.token };
    };
    const model = await mk('reordermodel', 'model');
    const fan = await mk('reorderfan', 'fan');
    const png = new Blob([PNG_1PX], { type: 'image/png' });
    const reorder = (token, body) => req(h.base, 'POST', '/api/model/gallery-reorder', { token, body });
    const directory = async () => {
      const d = await req(h.base, 'GET', '/api/models');
      return d.json.models.find((x) => x.id === model.id);
    };

    // Fans cannot reorder anything.
    const fanTry = await reorder(fan.token, { order: [] });
    assert.equal(fanTry.status, 403, 'fan blocked from the reorder endpoint');

    // Empty profile: an empty order is a no-op; anything else mismatches.
    const noop = await reorder(model.token, { order: [] });
    assert.equal(noop.status, 200, `empty reorder is a no-op: ${noop.text}`);
    const ghost = await reorder(model.token, { order: ['/uploads/photo-abcdef0123456789abcdef0123456789.jpg'] });
    assert.equal(ghost.status, 400, 'a picture she does not have is rejected');
    assert.equal(ghost.json.error, 'order_mismatch', 'rejection shape');

    // Main photo + three gallery pictures: composed [main, g1, g2, g3].
    const main = await upload(h.base, '/api/model/photo', model.token, 'photo', png, 'pixel.png');
    assert.equal(main.status, 200, `main photo failed: ${main.text}`);
    const gal = [];
    for (let i = 0; i < 3; i++) {
      const g = await upload(h.base, '/api/model/gallery-photo', model.token, 'photo', png, 'pixel.png');
      assert.equal(g.status, 200, `gallery upload ${i + 1} failed: ${g.text}`);
      gal.push(g.json.gallery_photos[i]);
    }
    const [g1, g2, g3] = gal;
    let me = await directory();
    assert.equal(me.photo_url, main.json.photo_url, 'main photo leads before reorder');
    assert.deepEqual(me.gallery_photos, [g1, g2, g3], 'gallery in upload order before reorder');

    // Drag g2 to the top: it becomes her main photo; the old main
    // takes its place at the head of the gallery; order preserved.
    const swapped = await reorder(model.token, { order: [g2, main.json.photo_url, g3, g1] });
    assert.equal(swapped.status, 200, `reorder failed: ${swapped.text}`);
    assert.deepEqual(swapped.json.profile_pics, [g2, main.json.photo_url, g3, g1],
      'composed list is exactly the submitted order');
    assert.deepEqual(swapped.json.gallery_photos, [main.json.photo_url, g3, g1],
      'old main swapped into the gallery head');
    me = await directory();
    assert.equal(me.photo_url, g2, 'directory: dragged picture is now the main photo');
    assert.deepEqual(me.gallery_photos, [main.json.photo_url, g3, g1], 'directory: gallery follows the new order');

    // Re-submitting the current order is a harmless no-op.
    const again = await reorder(model.token, { order: [g2, main.json.photo_url, g3, g1] });
    assert.equal(again.status, 200, 'unchanged order accepted');

    // Foreign URL: rejected, and the stored order is untouched.
    const foreign = '/uploads/photo-0000000000000000000000000000beef.jpg';
    const badForeign = await reorder(model.token, { order: [g2, main.json.photo_url, g3, foreign] });
    assert.equal(badForeign.status, 400, 'foreign URL rejected');
    assert.equal(badForeign.json.error, 'order_mismatch', 'foreign rejection shape');
    me = await directory();
    assert.equal(me.photo_url, g2, 'state unchanged after foreign attempt');
    assert.deepEqual(me.gallery_photos, [main.json.photo_url, g3, g1], 'gallery unchanged after foreign attempt');

    // A duplicate stands in for a real picture: rejected by name.
    const dup = await reorder(model.token, { order: [g2, g2, main.json.photo_url, g3] });
    assert.equal(dup.status, 400, 'duplicate rejected');
    assert.equal(dup.json.error, 'duplicate_picture', 'duplicate rejection shape');

    // A missing picture (subset): rejected.
    const missing = await reorder(model.token, { order: [g2, main.json.photo_url, g3] });
    assert.equal(missing.status, 400, 'subset rejected');
    assert.equal(missing.json.error, 'order_mismatch', 'subset rejection shape');

    // Malformed payloads: rejected as bad_order.
    const badShape = await reorder(model.token, { order: 'not-a-list' });
    assert.equal(badShape.status, 400, 'string payload rejected');
    assert.equal(badShape.json.error, 'bad_order', 'bad shape rejection');
    const noBody = await reorder(model.token, {});
    assert.equal(noBody.status, 400, 'missing order rejected');
    assert.equal(noBody.json.error, 'bad_order', 'missing order rejection shape');

    // Validation reads LIVE state: after removing g1, the old
    // four-picture order no longer matches and is rejected.
    const del = await req(h.base, 'DELETE', '/api/model/gallery-photo', { token: model.token, body: { url: g1 } });
    assert.equal(del.status, 200, `gallery remove failed: ${del.text}`);
    const stale = await reorder(model.token, { order: [g2, main.json.photo_url, g3, g1] });
    assert.equal(stale.status, 400, 'stale set (includes a removed picture) rejected');
    const fresh = await reorder(model.token, { order: [g3, g2, main.json.photo_url] });
    assert.equal(fresh.status, 200, `live set reorders fine: ${fresh.text}`);
    me = await directory();
    assert.equal(me.photo_url, g3, 'directory: latest top picture is the main photo');
    assert.deepEqual(me.gallery_photos, [g2, main.json.photo_url], 'directory: final gallery order');
  } finally {
    stop(h);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
