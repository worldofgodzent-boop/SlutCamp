'use strict';
/*
 * Canonical links (Asce's rule, Oct 23 2026): every share / promo /
 * recruit link says slutcamp.app — never the hosting hostname.
 *
 * A model posted her promo as slutcamp.onrender.com/#m/<name>
 * because the app built its links from location.origin, and she was
 * using the app on Render's hostname. Two halves pin the fix:
 *
 *   CLIENT — ONE helper, canonOrigin(): on slutcamp.app /
 *   www.slutcamp.app it returns the serving origin; anywhere else
 *   (onrender, staging, localhost) it returns https://slutcamp.app.
 *   Exactly three link builders use it: shareApp, the recruiter
 *   dashboard link, and the Settings promo link. Round-trips that
 *   must return to the SERVING origin (Phantom wallet redirects,
 *   the WebSocket URL, the MetaMask dapp link, WebAuthn) are pinned
 *   UNTOUCHED.
 *
 *   SERVER — a human who still lands on slutcamp.onrender.com with
 *   a GET/HEAD page request is 301'd to the same path + query on
 *   https://slutcamp.app (the browser carries the #fragment across,
 *   so #m/<name> survives). /api/* and /ws are never redirected,
 *   non-GET/HEAD is never redirected, and every other host —
 *   including up.slutcamp.app, the upload door — passes through.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const vm = require('node:vm');
const { spawn } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const serverSrc = read('server.js');
const appSrc = read('public/js/app.js');

/* ---------------- client: static pins + helper behavior ---------------- */

const canonMatch = appSrc.match(/^function canonOrigin\(\) \{[\s\S]*?^\}/m);

test('client: canonOrigin() is defined exactly once, with the canonical rule', () => {
  assert.ok(canonMatch, 'canonOrigin() helper located in app.js');
  assert.equal((appSrc.match(/function canonOrigin\(\)/g) || []).length, 1, 'exactly one helper');
  const src = canonMatch[0];
  assert.ok(src.includes("h === 'slutcamp.app'"), 'apex domain keeps its origin');
  assert.ok(src.includes("h === 'www.slutcamp.app'"), 'www keeps its origin');
  assert.ok(src.includes("'https://slutcamp.app'"), 'everything else canonicalizes to slutcamp.app');
  assert.doesNotThrow(() => new vm.Script(src), 'helper parses');
});

test('client behavior: canonOrigin() keeps the real domain, canonicalizes the rest', () => {
  const run = (location) => vm.runInNewContext(canonMatch[0] + '\ncanonOrigin();', { location });
  assert.equal(run({ hostname: 'slutcamp.app', origin: 'https://slutcamp.app' }),
    'https://slutcamp.app', 'apex serves its own origin');
  assert.equal(run({ hostname: 'www.slutcamp.app', origin: 'https://www.slutcamp.app' }),
    'https://www.slutcamp.app', 'www serves its own origin');
  assert.equal(run({ hostname: 'slutcamp.onrender.com', origin: 'https://slutcamp.onrender.com' }),
    'https://slutcamp.app', 'the onrender hostname NEVER leaks into a link');
  assert.equal(run({ hostname: 'localhost', origin: 'http://localhost:3000' }),
    'https://slutcamp.app', 'localhost canonicalizes too');
});

test('client: the three link builders use canonOrigin()', () => {
  assert.ok(appSrc.includes('const url = canonOrigin();'), 'shareApp shares the canonical origin');
  assert.ok(appSrc.includes('`${canonOrigin()}/#join/${r.referral_code}`'), 'recruiter dashboard link is canonical');
  assert.ok(appSrc.includes("canonOrigin() + '/#m/' + (S.user.username || '')"), 'Settings promo link is canonical');
});

test('client: the old origin-built link forms are gone', () => {
  assert.ok(!appSrc.includes('const url = location.origin'), 'shareApp no longer reads location.origin');
  assert.ok(!appSrc.includes('${window.location.origin}/#join/'), 'recruiter link no longer reads window.location.origin');
  assert.ok(!appSrc.includes("location.origin + '/#m/'"), 'promo link no longer reads location.origin');
});

test('client: serving-origin round-trips are untouched', () => {
  assert.equal((appSrc.match(/const origin = window\.location\.origin;/g) || []).length, 2,
    'both Phantom wallet redirects still return to the serving origin');
  assert.ok(appSrc.includes('`${proto}://${location.host}/ws'), 'WebSocket still targets the serving host');
  assert.ok(appSrc.includes('https://metamask.app.link/dapp/${window.location.host}/?pay_invoice=${inv.id}'),
    'MetaMask dapp link still targets the serving host');
});

/* ---------------- server harness (rank-cache pattern) ---------------- */

let tmpDir = null;
let child = null;
let base = null;
let port = null;
let childLog = '';

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

/* Raw HTTP so the Host header is exactly what the test says — fetch
 * will not send a forged Host. No redirect following, ever. */
function rawReq(method, p, host) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (host) headers.host = host;
    const r = http.request({ hostname: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    r.on('error', reject);
    r.end();
  });
}

async function waitForServer(deadlineMs = 60000) {
  const start = Date.now();
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early with code ${child.exitCode}\n--- server log ---\n${childLog}`);
    }
    try {
      const r = await rawReq('GET', '/api/credits/packages');
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
  for (let attempt = 1; attempt <= 3 && !base; attempt++) {
    port = await freePort();
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
    } catch (e) {
      lastErr = e;
      base = null;
      if (child && child.exitCode === null) child.kill('SIGKILL');
      child = null;
    }
  }
  if (!base) throw lastErr || new Error('server failed to boot after 3 attempts');
}

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-canonlinks-'));
  for (const f of ['server.js', 'package.json']) {
    fs.copyFileSync(path.join(REPO, f), path.join(tmpDir, f));
  }
  for (const d of ['lib', 'public', 'data']) {
    fs.cpSync(path.join(REPO, d), path.join(tmpDir, d), { recursive: true });
  }
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(tmpDir, 'node_modules'), 'dir');
  await boot();
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
});

/* ---------------- server: the canonical-host redirect ---------------- */

const ONRENDER = 'slutcamp.onrender.com';

test('server pin: the redirect middleware is the first app.use and host-exact', () => {
  const firstUse = serverSrc.indexOf('app.use(');
  const gateAt = serverSrc.indexOf("req.hostname !== 'slutcamp.onrender.com'");
  assert.ok(gateAt !== -1, 'canonical-host middleware present');
  assert.ok(gateAt > firstUse && gateAt < serverSrc.indexOf('app.use(', firstUse + 1),
    'the host check lives inside the very first app.use');
  assert.ok(serverSrc.includes("res.redirect(301, 'https://slutcamp.app' + req.url)"),
    'redirect target is the canonical origin + the untouched req.url');
});

test('server: onrender host GET / 301s to the canonical root', async () => {
  const r = await rawReq('GET', '/', ONRENDER);
  assert.equal(r.status, 301);
  assert.equal(r.headers.location, 'https://slutcamp.app/');
});

test('server: onrender host redirect preserves path + query', async () => {
  const r = await rawReq('GET', '/join?ref=zz9&x=1', ONRENDER);
  assert.equal(r.status, 301);
  assert.equal(r.headers.location, 'https://slutcamp.app/join?ref=zz9&x=1');
  const m = await rawReq('GET', '/models/Staceyg217', ONRENDER);
  assert.equal(m.status, 301);
  assert.equal(m.headers.location, 'https://slutcamp.app/models/Staceyg217');
});

test('server: onrender host HEAD page request redirects with no body', async () => {
  const r = await rawReq('HEAD', '/models', ONRENDER);
  assert.equal(r.status, 301);
  assert.equal(r.headers.location, 'https://slutcamp.app/models');
  assert.equal(r.text, '');
});

test('server: onrender host /api/ is NOT redirected', async () => {
  const r = await rawReq('GET', '/api/credits/packages', ONRENDER);
  assert.equal(r.status, 200, 'API keeps answering on the origin host');
  assert.equal(r.headers.location, undefined);
});

test('server: onrender host non-GET/HEAD is NOT redirected', async () => {
  const r = await rawReq('POST', '/join', ONRENDER);
  assert.notEqual(r.status, 301, 'a POST is never answered with a redirect');
  assert.equal(r.headers.location, undefined);
});

test('server: onrender host /ws path is NOT redirected', async () => {
  const r = await rawReq('GET', '/ws', ONRENDER);
  assert.notEqual(r.status, 301);
  assert.equal(r.headers.location, undefined);
});

test('server: the real domain is NOT redirected', async () => {
  const r = await rawReq('GET', '/', 'slutcamp.app');
  assert.equal(r.status, 200);
  assert.equal(r.headers.location, undefined);
  const w = await rawReq('GET', '/', 'www.slutcamp.app');
  assert.equal(w.status, 200);
  assert.equal(w.headers.location, undefined);
});

test('server: the upload-door host is NOT redirected by this rule', async () => {
  const r = await rawReq('GET', '/', 'up.slutcamp.app');
  assert.equal(r.status, 200);
  assert.equal(r.headers.location, undefined);
});

test('server: any other host (localhost) passes through untouched', async () => {
  const r = await rawReq('GET', '/');
  assert.equal(r.status, 200);
  assert.equal(r.headers.location, undefined);
});
