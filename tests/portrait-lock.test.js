'use strict';
/*
 * Portrait lock — the app NEVER becomes a landscape app (owner,
 * 2026-10-20, from his own phone: the installed app had rotated
 * into a squashed landscape home screen — "We need the app to stay
 * stationary. Just like Instagram. Doesn't matter if you turn the
 * phone or not, it stays vertical all the time").
 *
 * Three layers, one contract:
 *   1. MANIFEST — both apps declare "orientation": "portrait" (the
 *      main app already did; the Manager gains it here). Asserted
 *      on the SERVED responses, not just the source files: the
 *      manifests are static, and a stale or shadowed copy would
 *      silently void the layer.
 *   2. ORIENTATION API — app.js and manager.js ask
 *      screen.orientation.lock('portrait') on the first pointerdown
 *      (the only moment Chrome grants it). Guarded, one-shot, and
 *      silent on refusal by design — source-pinned here.
 *   3. CSS — WebKit/iOS ignores layer 1 and has no API for layer 2,
 *      so styles.css / manager.css counter-rotate the shell into a
 *      portrait box on phone-like landscape viewports (short
 *      screen + coarse pointer). The app stays fully usable in
 *      that state — never a "rotate your phone" veil.
 *
 * PR #53 reconciliation is pinned too: the broadcaster's rotation
 * toggle survives intact (button, fullscreen, unlock, honest iOS
 * toast, self-view mirror) but now holds PORTRAIT instead of
 * freezing whichever orientation she happened to be in — a
 * landscape freeze would fight the app-wide lock.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

const appSrc = read('public/js/app.js');
const managerSrc = read('public/manager/manager.js');
const styles = read('public/css/styles.css');
const managerCss = read('public/manager/manager.css');
const indexHtml = read('public/index.html');
const managerHtml = read('public/manager/index.html');

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-portrait-'));
  for (const d of ['server.js', 'package.json', 'lib', 'public', 'data']) {
    fs.cpSync(path.join(REPO, d), path.join(dir, d), { recursive: true });
  }
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  return dir;
}

async function boot(dir) {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), CRYPTO_POLL_MS: '3600000' };
  for (const k of Object.keys(env)) {
    if (/^(CCBILL_|CRYPTO_|OPENAI_|TWILIO_|VAPID_|WEBAUTHN_|AV_|SEED_DEMO)/.test(k)) delete env[k];
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
  return { child, base };
}

function stop(h) {
  if (h && h.child && h.child.exitCode === null) h.child.kill('SIGKILL');
}

test('served manifests declare portrait for BOTH apps; both shells boot', async (t) => {
  const dir = makeCopy();
  const h = await boot(dir);
  t.after(() => stop(h));
  const { base } = h;

  const main = await fetch(base + '/manifest.json');
  assert.equal(main.status, 200, 'main manifest served');
  const mainJson = JSON.parse(await main.text());
  assert.equal(mainJson.orientation, 'portrait', 'main manifest holds portrait');
  assert.equal(mainJson.display, 'standalone');

  const mgr = await fetch(base + '/manager/manifest.webmanifest');
  assert.equal(mgr.status, 200, 'manager manifest served');
  const mgrJson = JSON.parse(await mgr.text());
  assert.equal(mgrJson.orientation, 'portrait', 'manager manifest holds portrait');
  assert.equal(mgrJson.display, 'standalone');

  // The live shells still boot and render.
  const home = await fetch(base + '/');
  assert.equal(home.status, 200, 'main shell served');
  assert.match(await home.text(), /id="phone"/, 'main shell renders the #phone column');

  const mgrPage = await fetch(base + '/manager');
  assert.equal(mgrPage.status, 200, 'manager shell served');
  assert.match(await mgrPage.text(), /Slut Manager/, 'manager shell renders');
});

test('shells link their manifests', () => {
  assert.match(indexHtml, /<link rel="manifest" href="\/manifest\.json">/);
  assert.match(managerHtml, /<link rel="manifest" href="\/manager\/manifest\.webmanifest">/);
});

test('orientation API layer: both clients ask for portrait on first gesture, guarded + silent', () => {
  for (const [name, src] of [['app.js', appSrc], ['manager.js', managerSrc]]) {
    assert.match(src, /function askPortraitLock\(\)/, `${name}: askPortraitLock exists`);
    assert.match(src, /addEventListener\('pointerdown', askPortraitLock\)/, `${name}: rides the first pointerdown`);
    assert.match(src, /screen\.orientation\.lock\('portrait'\)/, `${name}: locks portrait`);
    // One-shot guard: the flag is declared, checked, and set.
    const flags = src.match(/portraitLockAsked/g) || [];
    assert.ok(flags.length >= 3, `${name}: one-shot guard wired (got ${flags.length})`);
    // Refusals are swallowed, never surfaced: the promise is caught.
    assert.match(src, /p\.catch\(\(\) => \{\}\)/, `${name}: lock promise caught silently`);
  }
});

test('CSS layer: shells counter-rotate into a portrait box on phone landscape', () => {
  const MQ = /@media \(orientation: landscape\) and \(max-height: 540px\) and \(pointer: coarse\)/;
  for (const [name, css] of [['styles.css', styles], ['manager.css', managerCss]]) {
    assert.match(css, MQ, `${name}: phone-landscape media query present`);
    const block = css.slice(css.search(MQ));
    assert.match(block, /width: 100vh/, `${name}: portrait width = landscape short side`);
    assert.match(block, /height: 100vw/, `${name}: portrait height = landscape long side`);
    assert.match(block, /transform-origin: 0 0/, `${name}: rotation origin pinned`);
    assert.match(block, /transform: rotate\(-90deg\) translateX\(-100%\)/, `${name}: counter-rotation applied`);
    assert.match(block, /position: fixed/, `${name}: shell taken out of the rotated flow`);
  }
  // Inside the rotated frame, dvh still measures the landscape
  // viewport — the main app's full-height shells must follow the
  // frame instead.
  const mainBlock = styles.slice(styles.search(MQ));
  assert.match(mainBlock, /#phone \{ height: 100%; \}/, 'styles.css: #phone follows the rotated frame');
  assert.match(mainBlock, /\.live-wrap \{ height: 100%; \}/, 'styles.css: live wrap follows the rotated frame');
});

test('PR #53 reconciliation: broadcaster toggle holds portrait; mirror untouched', () => {
  // The freeze-whatever-she-is-in expression is gone...
  assert.doesNotMatch(appSrc, /'landscape' : 'portrait'/, 'landscape freeze removed');
  // ...and the toggle now locks portrait explicitly.
  assert.match(appSrc, /await screen\.orientation\.lock\('portrait'\)/, 'toggle locks portrait');
  // The toggle itself survives (deep pins live in
  // live-selfview-rotation.test.js; these tie the reconciliation).
  assert.match(appSrc, /id="live-rotlock-btn"/, 'rotlock button still rendered');
  assert.match(appSrc, /rotBtn\.onclick = toggleRotationLock;/, 'rotlock button still wired');
  assert.match(appSrc, /function releaseRotationLock\(\)/, 'release path intact');
  // The self-view mirror is untouched.
  assert.match(styles, /\.mirror-self\s*\{\s*transform:\s*scaleX\(-1\);\s*\}/, 'mirror rule intact');
  assert.match(appSrc, /<video id="live-local" class="mirror-self" autoplay playsinline muted><\/video>/, 'broadcaster self-view still mirrored');
});
