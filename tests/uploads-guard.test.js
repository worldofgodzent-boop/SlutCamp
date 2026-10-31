'use strict';
/*
 * /uploads public-file guard (bug fix, Oct 18 2026): profile preview
 * videos 404'd for everyone since the feature shipped (PR #32). The
 * static route's guard only whitelisted "photo-*" images, but preview
 * videos are stored in the same uploads dir as "preview-<32hex>.mp4"
 * and are PUBLIC profile content by design — they autoplay on home
 * tiles and on her profile, for guests too. The files were on disk the
 * whole time; only the guard blocked them.
 *
 * The fix admits exactly two strict, anchored patterns:
 *   photo-<hex>.(jpg|png|webp)   — profile photos (public)
 *   preview-<hex>.mp4            — profile preview videos (public)
 * A23b REVISED (Oct 30 2026) adds ONE class to the preview pattern:
 *   preview-<hex>.(jpg|png|webp) — a preview video's poster frame,
 *   stored beside the video under its own stem; the still of an
 *   already-public video, admitted so her share card can point at
 *   it. Nothing else widens: PPV / voice / generic names stay 404.
 * Everything else under /uploads stays 404 here: PPV media and voice
 * notes are served ONLY via the authed /api/media/:id/file route.
 *
 * Live-request tests (suite convention: smoke.test.js harness) — boot
 * the real server.js in a throwaway copy, plant files of each class in
 * its uploads dir, and assert the served status of each.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');

let tmpDir = null;
let child = null;
let base = null;
let childLog = '';

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

const HEX = '0123456789abcdef0123456789abcdef';
// One planted file per class: [filename, expected status]
const PLANTED = [
  [`photo-${HEX}.jpg`, 200],        // public profile photo
  [`photo-${HEX}.png`, 200],
  [`photo-${HEX}.webp`, 200],
  [`preview-${HEX}.mp4`, 200],      // public profile preview video (the fix)
  [`preview-${HEX}.jpg`, 200],      // preview video poster frame (A23b revised)
  [`preview-${HEX}.png`, 200],      // preview video poster frame (A23b revised)
  [`preview-${HEX}.webp`, 200],     // preview video poster frame (A23b revised)
  [`ppv-${HEX}.mp4`, 404],          // PPV media — authed route only
  [`voice-${HEX}.ogg`, 404],        // voice notes — authed route only
  [`${HEX}.mp4`, 404],              // generic media name (no public prefix)
  [`photo-${HEX}.gif`, 404],        // photo prefix, non-whitelisted extension
  [`preview-${HEX}.webm`, 404],     // preview prefix, non-whitelisted extension
  [`Preview-${HEX}.mp4`, 404],      // prefix is case-sensitive
  [`preview-${HEX.toUpperCase()}.mp4`, 404], // hex is lowercase-only
];

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-uploads-'));
  for (const f of ['server.js', 'package.json']) {
    fs.copyFileSync(path.join(REPO, f), path.join(tmpDir, f));
  }
  for (const d of ['lib', 'public', 'data']) {
    fs.cpSync(path.join(REPO, d), path.join(tmpDir, d), { recursive: true });
  }
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(tmpDir, 'node_modules'), 'dir');

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
  await waitForServer();

  // Plant one file per class into the booted copy's uploads dir.
  const upDir = path.join(tmpDir, 'uploads');
  fs.mkdirSync(upDir, { recursive: true });
  for (const [name] of PLANTED) {
    fs.writeFileSync(path.join(upDir, name), `planted:${name}`);
  }
});

test.after(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((r) => child.once('exit', r)),
      new Promise((r) => setTimeout(r, 5000)),
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('/uploads guard serves the two public classes and 404s everything else', async () => {
  for (const [name, expected] of PLANTED) {
    const r = await fetch(`${base}/uploads/${name}`, { redirect: 'manual' });
    const body = await r.text();
    assert.equal(r.status, expected, `/uploads/${name} should be ${expected}, got ${r.status}`);
    if (expected === 200) assert.equal(body, `planted:${name}`, 'served bytes are the planted file');
  }
});

test('/uploads guard rejects subdirectory and traversal-shaped paths', async () => {
  const paths = [
    `/uploads/sub/photo-${HEX}.jpg`,          // anchored: no subdirectory
    '/uploads/%2e%2e%2fserver.js',            // encoded traversal
    `/uploads/..%2fphoto-${HEX}.jpg`,         // traversal prefix
    `/uploads/preview-${HEX}.mp4/extra`,      // trailing junk after a valid name
    `/uploads/preview-${HEX}.mp4%00.png`,     // null-byte style suffix
  ];
  for (const p of paths) {
    const r = await fetch(base + p, { redirect: 'manual' });
    await r.text();
    assert.equal(r.status, 404, `${p} should be 404, got ${r.status}`);
  }
});

test('source pin: the /uploads guard whitelists exactly photo images + preview mp4 + preview poster images', () => {
  const at = serverSrc.indexOf("app.use('/uploads'");
  assert.ok(at !== -1, '/uploads guard located in server.js');
  const block = serverSrc.slice(at, at + 400);
  assert.ok(block.includes('photo-[a-f0-9]+'), 'photo class pinned in the guard');
  assert.ok(block.includes('preview-[a-f0-9]+'), 'preview class pinned in the guard');
  assert.ok(block.includes('preview-[a-f0-9]+\\.(?:mp4|jpg|png|webp)'), 'preview is the video + its poster frames (A23b revised)');
  assert.ok(!/ppv-\[a-f0-9\]/.test(block), 'ppv class must NOT be whitelisted');
  assert.ok(!/voice-\[a-f0-9\]/.test(block), 'voice class must NOT be whitelisted');
});
