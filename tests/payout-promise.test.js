'use strict';
/*
 * Published payout promise — GET /payouts (owner quick win, Oct 16
 * 2026). Payout protection is live in the product and in the Model
 * Agreement (v1.4 §5 + §13), but until now a recruit only got a
 * one-line mention on /join. /payouts publishes the mechanics in plain
 * language so a model can read them BEFORE signing up.
 *
 * The page is pinned to the Terms it summarises: the split (§4), the
 * 7-day hold, the manual human payout review (§5), the exact
 * chargeback recovery order and the never-out-of-pocket rule (§13),
 * the fraud-forfeiture exception (§13) — and the Agreement-governs
 * line, with the version rendered from MODEL_CONTRACT.version itself.
 * The forbidden-copy pins are load-bearing: the page must NEVER market
 * a "Chargeback Shield" or claim the platform absorbs chargebacks —
 * that claim is deliberately unpublished.
 *
 * Harness: same boot-the-real-server pattern as tests/seo-pages.test.js
 * (temp copy, throwaway DB). No fixtures needed — the page is public
 * and roster-independent.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const SERVER_SRC = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');

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

async function req(method, p) {
  const r = await fetch(base + p, { method, redirect: 'manual' });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* HTML or empty */ }
  return { status: r.status, headers: r.headers, text, json };
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

async function killServer() {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((r) => child.once('exit', r)),
      new Promise((r) => setTimeout(r, 5000)),
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  child = null;
}

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-payout-'));
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
  await killServer();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

/* ---------------- the page ---------------- */

test('/payouts: 200 with the standard public-page head treatment', async () => {
  const r = await req('GET', '/payouts');
  assert.equal(r.status, 200, r.text.slice(0, 200));
  assert.match(r.headers.get('content-type') || '', /text\/html/);
  assert.ok(r.text.includes('<title>How SlutCamp Pays Models — The Payout Promise | 18+</title>'), 'title');
  assert.ok(r.text.includes('name="description"'), 'meta description');
  assert.ok(r.text.includes('<link rel="canonical" href="https://slutcamp.app/payouts">'), 'canonical');
  assert.ok(r.text.includes('name="rating" content="adult"'), 'adult rating meta');
  assert.ok(r.text.includes('RTA-5042-1996-1400-1577-RTA'), 'RTA label meta');
  assert.ok(r.text.includes('name="twitter:card"'), 'twitter card');
  assert.ok((r.headers.get('cache-control') || '').includes('max-age=300'), 'anonymous cache header');
});

test('/payouts: the split and the 7-day hold, stated plainly', async () => {
  const r = await req('GET', '/payouts');
  assert.ok(r.text.includes('You keep 60% of everything'), '60% split');
  assert.ok(r.text.includes('SlutCamp keeps 40%'), '40% platform side');
  assert.ok(r.text.includes('become withdrawable 7 days after'), '7-day window');
  assert.ok(r.text.includes('one week behind'), 'one-week framing');
  assert.ok(r.text.includes('available balance separately'), 'available vs in-window balance');
  assert.ok(r.text.includes('Chargeback fraud'), 'honest why: chargeback fraud');
});

test('/payouts: withdrawals are reviewed and paid by a human', async () => {
  const r = await req('GET', '/payouts');
  assert.ok(r.text.includes('reviewed and paid manually by a person'), 'human review');
  assert.ok(r.text.includes('no silent automatic payouts'), 'no silent auto-payouts');
  assert.ok(r.text.includes('several business days'), '§5 timing honesty');
  assert.ok(r.text.includes('no guaranteed payout date'), '§5 no-guaranteed-date honesty');
});

test('/payouts: the chargeback recovery order, in the Terms order', async () => {
  const r = await req('GET', '/payouts');
  const i1 = r.text.indexOf("fan's unspent credits");
  const i2 = r.text.indexOf('your unpaid earnings from that fan');
  const i3 = r.text.indexOf('recovered AUTOMATICALLY from your future earnings');
  assert.ok(i1 > -1, 'step 1: fan unspent credits');
  assert.ok(i2 > i1, 'step 2: model unpaid earnings from that fan, after step 1');
  assert.ok(i3 > i2, 'step 3: automatic recovery from future earnings, after step 2');
  assert.ok(r.text.includes('until it is repaid in full'), 'recovery runs until repaid');
});

test('/payouts: never out of pocket for a chargeback shortfall', async () => {
  const r = await req('GET', '/payouts');
  assert.ok(
    r.text.includes('You are never required to make a manual or out-of-pocket payment for a chargeback shortfall'),
    'the never-out-of-pocket sentence');
  assert.ok(r.text.includes('never collected back from you out of pocket'), 'already-withdrawn protection');
});

test('/payouts: fraud is the stated exception and can forfeit earnings', async () => {
  const r = await req('GET', '/payouts');
  assert.ok(r.text.includes('None of the above protects fraud'), 'fraud exception framing');
  assert.ok(r.text.includes('fraudulently obtained earnings are forfeited'), 'forfeiture');
  assert.ok(r.text.includes('self-dealing'), 'self-dealing named');
});

test('/payouts: the Agreement governs, with its live version', async () => {
  const r = await req('GET', '/payouts');
  assert.ok(r.text.includes('the Agreement governs'), 'Agreement-governs line');
  assert.ok(r.text.includes('The legal text is the Model Agreement itself'), 'legal text pointer');
  // The version is rendered from MODEL_CONTRACT.version (pinned in the
  // source test below) — the page must show the version actually in force.
  const m = SERVER_SRC.match(/const CONTRACT_VERSION = '([0-9.]+)'/);
  assert.ok(m, 'CONTRACT_VERSION found in source');
  assert.ok(r.text.includes(`version ${m[1]}`), `page carries Model Agreement version ${m[1]}`);
  assert.ok(r.text.includes('section 13 (Payout Holds, Chargeback Reversals'), 'section 13 named');
});

/* ---------------- forbidden copy ---------------- */

test('/payouts: forbidden marketing copy is absent', async () => {
  const r = await req('GET', '/payouts');
  assert.ok(!/shield/i.test(r.text), 'no "Shield" claim anywhere on the page');
  assert.ok(!/absorb/i.test(r.text), 'no "absorb" claim anywhere on the page');
  assert.ok(!/we (cover|pay) (all|every) chargeback/i.test(r.text), 'no platform-covers-chargebacks promise');
});

/* ---------------- wiring ---------------- */

test('sitemap: the dynamic sitemap lists /payouts', async () => {
  const r = await req('GET', '/sitemap.xml');
  assert.equal(r.status, 200);
  assert.ok(r.text.includes('<loc>https://slutcamp.app/payouts</loc>'), '/payouts in sitemap');
});

test('/join links to the payout promise', async () => {
  const r = await req('GET', '/join');
  assert.equal(r.status, 200);
  assert.ok(r.text.includes('<a href="/payouts">Read our payout promise</a>'), 'payout promise link on /join');
});

test('SPA root and /api/models are unaffected', async () => {
  const root = await req('GET', '/');
  assert.equal(root.status, 200);
  assert.ok(root.text.includes('/js/app.js'), 'SPA shell still served at /');
  const dir = await req('GET', '/api/models');
  assert.equal(dir.status, 200);
  assert.ok(Array.isArray(dir.json.models), 'directory JSON intact');
});

test('source pins: route is registered with the public pages, version is live-rendered', () => {
  const routeAt = SERVER_SRC.indexOf("app.get('/payouts'");
  assert.ok(routeAt > -1, '/payouts route exists');
  const staticAt = SERVER_SRC.indexOf('app.use(express.static');
  assert.ok(routeAt < staticAt, '/payouts registers before express.static (beats the SPA fallback)');
  assert.ok(SERVER_SRC.includes("entry(SEO_ORIGIN + '/payouts', 'weekly', '0.8')"), 'sitemap entry present');
  const routeBody = SERVER_SRC.slice(routeAt, SERVER_SRC.indexOf("app.get('/sitemap.xml'", routeAt));
  assert.ok(routeBody.includes('${MODEL_CONTRACT.version}'), 'page renders the Agreement version from MODEL_CONTRACT, never a hardcoded copy');
});
