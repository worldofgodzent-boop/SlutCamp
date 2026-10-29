'use strict';
/*
 * Official social links (owner, Oct 22 2026: "We need our official X
 * and instagram on slutcamp"):
 *   - X: @SlutCampApp — https://x.com/SlutCampApp
 *   - Instagram: @slcamp__ — https://instagram.com/slcamp__
 * BRAND accounts only — never the owner's personal accounts.
 *
 * Placement (spec: ~/workspace/projects/social-links-spec.md):
 *   a. The public footer (server.js seoFooter — the one that gained
 *      the legal links in the CCBill readiness build), beside the
 *      legal links, on every server-rendered public page.
 *   b. The official house page (/models/asceaaspade): a "Follow
 *      SlutCamp:" row in the hero, house-gated — a model's own page
 *      never grows social links.
 * Nowhere else in v1: not in the app, not on model profiles, not in
 * chat. Plain outbound links: hard-coded constants, new tab +
 * rel="noopener", no tracking parameters, no embeds, no feeds.
 * Labels are the brand names ("X" / "Instagram") — no STR keys.
 *
 * Static pins read the shipped server.js; the live checks boot the
 * real server (same harness as tests/ccbill-readiness.test.js).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const SERVER_JS = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');

const X_URL = 'https://x.com/SlutCampApp';
const IG_URL = 'https://instagram.com/slcamp__';
const X_ANCHOR = `<a href="${X_URL}" target="_blank" rel="noopener">X</a>`;
const IG_ANCHOR = `<a href="${IG_URL}" target="_blank" rel="noopener">Instagram</a>`;

const count = (hay, needle) => hay.split(needle).length - 1;

/* ---------------- static pins ---------------- */

test('brand social URLs are hard-coded constants, single-sourced', () => {
  assert.ok(SERVER_JS.includes(`const SOCIAL_X_URL = '${X_URL}';`), 'X constant');
  assert.ok(SERVER_JS.includes(`const SOCIAL_INSTAGRAM_URL = '${IG_URL}';`), 'Instagram constant');
  // The full URLs are BUILT from the constants everywhere else: the
  // literals appear exactly once each in the whole server source.
  assert.equal(count(SERVER_JS, X_URL), 1, 'X URL literal appears once (the constant)');
  assert.equal(count(SERVER_JS, IG_URL), 1, 'Instagram URL literal appears once (the constant)');
});

test('social anchors open in a new tab with rel="noopener", plain — no tracking params', () => {
  assert.ok(SERVER_JS.includes(
    'const seoSocialLinks = `<a href="${SOCIAL_X_URL}" target="_blank" rel="noopener">X</a> · <a href="${SOCIAL_INSTAGRAM_URL}" target="_blank" rel="noopener">Instagram</a>`;'),
    'seoSocialLinks snippet');
  assert.ok(!SERVER_JS.includes('utm_'), 'no tracking parameters anywhere in server source');
});

test('footer carries the social links beside the legal links', () => {
  const start = SERVER_JS.indexOf('const seoFooter = ');
  assert.ok(start >= 0, 'seoFooter not found');
  const footer = SERVER_JS.slice(start, SERVER_JS.indexOf('\n', start));
  assert.ok(footer.includes('${seoSocialLinks}'), 'footer embeds the social links');
  // Beside the legal links: after the DMCA link, before the operator line.
  assert.ok(footer.indexOf('/#dmca') < footer.indexOf('${seoSocialLinks}'),
    'social links sit after the legal-links row');
  assert.ok(footer.indexOf('${seoSocialLinks}') < footer.indexOf('Operated by World of Godz Entertainment LLC'),
    'social links sit before the operator line');
});

test('house hero row is gated to the house account only', () => {
  assert.ok(SERVER_JS.includes('const socialHtml = isHouseAccountId(m.id)'),
    'the follow row renders only when the page model is the house account');
  assert.ok(SERVER_JS.includes('`<p class="social">Follow SlutCamp: ${seoSocialLinks}</p>`'),
    'house hero follow row');
  assert.ok(SERVER_JS.includes('${socialHtml}'), 'profile template renders the row');
});

test('no personal-account URLs anywhere in the change', () => {
  assert.ok(!SERVER_JS.includes('ASCEAASPADE'), "owner's personal X handle must not ship");
  assert.ok(!SERVER_JS.includes('x.com/ASCEAASPADE'), 'no personal X URL');
  // Every social URL in the server source is one of the two brand
  // constants (the occurrence-count pins above), so no personal
  // Instagram URL can hide here either.
  assert.equal(count(SERVER_JS, 'https://x.com/'), 1, 'the only x.com URL is the brand constant');
  assert.equal(count(SERVER_JS, 'https://instagram.com/'), 1, 'the only instagram.com URL is the brand constant');
});

/* ---------------- live checks ---------------- */

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

async function waitForServer(deadlineMs = 30000) {
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

async function signupModel(username, displayName) {
  const r = await fetch(base + '/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username, password: 'social-pass-123', role: 'model', publicity_consent: true,
      display_name: displayName, dob: '1996-04-12', agree18: true, section: 'female',
    }),
  });
  const text = await r.text();
  assert.equal(r.status, 200, `signup ${username} failed: ${text}`);
  return JSON.parse(text);
}

let modelUsername = null;

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-social-'));
  for (const f of ['server.js', 'package.json']) {
    fs.copyFileSync(path.join(REPO, f), path.join(tmpDir, f));
  }
  for (const d of ['lib', 'public', 'data']) {
    fs.cpSync(path.join(REPO, d), path.join(tmpDir, d), { recursive: true });
  }
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(tmpDir, 'node_modules'), 'dir');
  await boot();
  // The house account (username exactly asceaaspade) and one ordinary
  // model, so the house page and a model page can be compared live.
  await signupModel('asceaaspade', 'SlutCamp');
  modelUsername = 'socialmodel' + Math.random().toString(36).slice(2, 8);
  await signupModel(modelUsername, 'Social Model');
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
  child = null;
});

test('live: /models footer carries both social links', async () => {
  const r = await fetch(base + '/models');
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.ok(html.includes(X_ANCHOR), '/models footer X link');
  assert.ok(html.includes(IG_ANCHOR), '/models footer Instagram link');
});

test('live: /join footer carries both social links (the shared public footer)', async () => {
  const r = await fetch(base + '/join');
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.ok(html.includes(X_ANCHOR), '/join footer X link');
  assert.ok(html.includes(IG_ANCHOR), '/join footer Instagram link');
});

test('live: house page carries the links in its hero AND its footer', async () => {
  const r = await fetch(base + '/models/asceaaspade');
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.ok(html.includes(`Follow SlutCamp: ${X_ANCHOR} · ${IG_ANCHOR}`),
    'house hero follow row with both links');
  assert.ok(count(html, X_ANCHOR) >= 2, 'X link appears in hero and footer');
  assert.ok(count(html, IG_ANCHOR) >= 2, 'Instagram link appears in hero and footer');
});

test('live: a model page gets the footer links only — no follow row', async () => {
  const r = await fetch(base + '/models/' + modelUsername);
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.ok(html.includes(X_ANCHOR), 'model page footer X link');
  assert.ok(html.includes(IG_ANCHOR), 'model page footer Instagram link');
  assert.ok(!html.includes('Follow SlutCamp:'), 'no house follow row on a model page');
  assert.equal(count(html, X_ANCHOR), 1, 'X link appears once (footer only)');
});
