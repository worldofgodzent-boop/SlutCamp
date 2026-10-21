'use strict';
/*
 * CCBill evaluation readiness patch (2026-10-21) — pins the pre-review
 * cleanup so a CCBill evaluator never sees a placeholder or dev string:
 *   1. DMCA page carries the designated agent's real mailing address +
 *      phone (17 U.S.C. §512(c)(2)); the "(Mailing address: to be
 *      provided)" placeholder is gone.
 *   2. The 2257 statement prints the same address as everywhere else
 *      ("7511 Oak Chase", no stray "St").
 *   3. The server-rendered public pages' footer links the legal pages
 *      (via the /#… in-app routes) and names the operator.
 *   4. The legacy POST /api/credits/buy 501 says the clean public
 *      message ("Card payments are launching soon.") — no dev text
 *      about processors plugging in; the wallet fallback toast matches.
 *   5. Billing §9 only advertises coins that are actually offered
 *      (no XRP until CRYPTO_XRP_ADDRESS is set).
 *   6. /join states the real ID rule: verified before going live or
 *      cashing out — not "before she can earn".
 *
 * Static pins read the shipped files; the live checks boot the real
 * server (same harness as tests/seo-pages.test.js).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const APP_JS = fs.readFileSync(path.join(REPO, 'public', 'js', 'app.js'), 'utf8');
const SERVER_JS = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');

function viewBody(src, name, nextName) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} not found`);
  const end = nextName ? src.indexOf(`function ${nextName}(`, start) : src.length;
  return src.slice(start, end > start ? end : src.length);
}

/* ---------------- static pins ---------------- */

test('DMCA page publishes the agent address + phone; placeholder is gone', () => {
  assert.ok(!APP_JS.includes('to be provided'), 'DMCA placeholder text must not ship');
  const dmca = viewBody(APP_JS, 'vDmca', 'vPrivacy');
  assert.ok(dmca.includes('DMCA Agent, World of Godz Entertainment LLC'));
  assert.ok(dmca.includes('7511 Oak Chase, San Antonio, TX 78239'), 'DMCA agent mailing address');
  assert.ok(dmca.includes('(210) 943-6509'), 'DMCA agent phone');
  assert.ok(dmca.includes('dmca@slutcamp.app'), 'DMCA agent email');
});

test('2257 statement address matches the LLC address used everywhere else', () => {
  assert.ok(!APP_JS.includes('Oak Chase St'), 'stray "St" suffix must not ship');
  const st = viewBody(APP_JS, 'vStatement2257', null);
  assert.ok(st.includes('7511 Oak Chase<br>'), 'custodian address');
  assert.ok(st.includes('San Antonio, TX 78239, USA'));
});

test('public footer links the legal pages and names the operator', () => {
  for (const href of ['/#terms', '/#privacy', '/#billing', '/#2257', '/#dmca']) {
    assert.ok(SERVER_JS.includes(`href="${href}"`), `footer link ${href}`);
  }
  assert.ok(SERVER_JS.includes('Operated by World of Godz Entertainment LLC'), 'operator line in footer');
  // Existing footer links are kept.
  assert.ok(SERVER_JS.includes('<a href="/models">All models</a>'));
  assert.ok(SERVER_JS.includes('<a href="/join">Become a model</a>'));
});

test('legal footer links resolve: app routes /#… hashes to the legal views', () => {
  assert.ok(APP_JS.includes("legalViews = { terms: 'terms', privacy: 'privacy', billing: 'billing', '2257': 'statement2257', dmca: 'dmca' }"),
    'routeInitial maps legal hashes to the auth-screen legal views');
});

test('purchase path speaks the clean public message — no dev text anywhere user-visible', () => {
  assert.ok(!SERVER_JS.includes('will plug in here'), 'dev string in server 501');
  assert.ok(!APP_JS.includes('Payment processor coming soon'), 'dev string in wallet fallback toast');
  assert.ok(SERVER_JS.includes("message: 'Card payments are launching soon.'"), 'clean 501 message');
  assert.ok(APP_JS.includes("'Card payments are launching soon.'"), 'clean wallet fallback');
});

test('billing §9 advertises only coins that are actually offered (no XRP)', () => {
  const billing = viewBody(APP_JS, 'vBilling', 'vStatement2257');
  assert.ok(!billing.includes('XRP'), 'billing page must not offer XRP loads');
  assert.ok(billing.includes('Bitcoin (BTC), USDT, Ethereum (ETH) or Solana (SOL)'), 'offered coin list');
  assert.ok(billing.includes('for <b>Solana</b>, send the exact amount to the last decimal'), 'solana exact-amount note kept');
});

test('/join states the real ID rule (live + cash out), not the old overstatement', () => {
  assert.ok(!SERVER_JS.includes('ID-verified before she can earn'), 'old /join claim must not ship');
  assert.ok(SERVER_JS.includes('every model is ID-verified before she can go live or cash out'), 'corrected /join claim');
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

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-ccbillready-'));
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
  child = null;
});

test('live: /join carries the corrected ID claim and the legal footer', async () => {
  const r = await fetch(base + '/join');
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.ok(html.includes('ID-verified before she can go live or cash out'));
  assert.ok(!html.includes('before she can earn'));
  for (const href of ['/#terms', '/#privacy', '/#billing', '/#2257', '/#dmca']) {
    assert.ok(html.includes(`href="${href}"`), `/join footer link ${href}`);
  }
  assert.ok(html.includes('Operated by World of Godz Entertainment LLC'));
});

test('live: /models footer carries the legal links + operator line', async () => {
  const r = await fetch(base + '/models');
  assert.equal(r.status, 200);
  const html = await r.text();
  for (const href of ['/#terms', '/#privacy', '/#billing', '/#2257', '/#dmca']) {
    assert.ok(html.includes(`href="${href}"`), `/models footer link ${href}`);
  }
  assert.ok(html.includes('Operated by World of Godz Entertainment LLC'));
});

test('live: legacy credit buy answers 501 with the clean message', async () => {
  const login = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'fandemo', password: 'fan123' }),
  });
  assert.equal(login.status, 200, 'fandemo login');
  const { token } = await login.json();
  assert.ok(token, 'login token');
  const buy = await fetch(base + '/api/credits/buy', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ package: 'p10' }),
  });
  assert.equal(buy.status, 501);
  const body = await buy.json();
  assert.equal(body.error, 'payment_not_connected');
  assert.equal(body.message, 'Card payments are launching soon.');
});
