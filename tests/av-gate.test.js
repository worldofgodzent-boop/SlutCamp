'use strict';
/*
 * Age-verification gate (lib/av.js + server wiring) — the owner's
 * design (Oct 16 2026): fans attest at the door; REAL verification
 * fires once, at the FIRST credit purchase, for fans in a regulated
 * state. Card path = 'transactional' method, crypto path = 'id'.
 *
 * Part A (unit, in-memory DB): the adapter contract — dormancy switch,
 * the 27-state list, the pure gate-decision matrix (incl. the
 * unknown-state policy), the stub's deterministic pass/fail,
 * exactly-once proof stamping, the webhook finalize path, the TN
 * re-attestation stamp, and the PROOF-ONLY schema guarantee (no
 * document/image/DOB evidence columns exist anywhere in this feature).
 *
 * Part B (real server over HTTP, temp-copy boots like the smoke and
 * crypto-e2e suites):
 *   B1 AV ENABLED (stub provider, fake CCBill creds, fixed-address
 *      USDT): a TX fan is gated at BOTH purchase initiations, verifies
 *      via start/complete, and then buys freely; verified proof is
 *      stamped exactly once; NY fans are never gated; an unknown-state
 *      fan IS gated until a purchase-time geo refresh places her in an
 *      unregulated state; a stored TX is overridden by a fresh NY geo;
 *      an 'avfail' fan fails the stub and stays gated; the webhook
 *      finalizes a session exactly once; models get 'forbidden', never
 *      'av_required'; a re-login stamps the TN re-attestation.
 *   B2 AV DORMANT (no AV_* env): the same TX fan buys on both rails
 *      with zero friction and /api/av/* refuses — today's behavior,
 *      pinned.
 *
 * Geo fixtures are real IPs the bundled geoip-lite resolves to the
 * states used (verified against the shipped dataset): TX 99.50.0.1
 * (Houston), NY 216.10.0.1 (New York), CA 9.9.9.9 (Berkeley).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const av = require('../lib/av.js');

const REPO = path.join(__dirname, '..');
const TX_IP = '99.50.0.1';
const NY_IP = '216.10.0.1';
const CA_IP = '9.9.9.9';

/* ---------------- Part A: unit ---------------- */

const AV_ENV_KEYS = ['AV_PROVIDER', 'AV_API_KEY', 'AV_WEBHOOK_SECRET'];
function setStubEnv() {
  for (const k of AV_ENV_KEYS) delete process.env[k];
  process.env.AV_PROVIDER = 'stub';
  process.env.AV_API_KEY = 'unit-test-key-only';
}
function clearAvEnv() {
  for (const k of AV_ENV_KEYS) delete process.env[k];
}

function makeSvc() {
  setStubEnv();
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT,
      fan_state TEXT, av_verified_at TEXT, av_method TEXT,
      av_provider_ref TEXT, av_last_attested_at TEXT);
    INSERT INTO users (id, username) VALUES (1, 'regularfan'), (2, 'avfailfan');
  `);
  const svc = av.createAvService({ db });
  return { db, svc };
}
const userRow = (db, id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);

test('AV_STATES is exactly the 27 regulated states', () => {
  const expected = ['AL', 'AZ', 'AR', 'FL', 'GA', 'ID', 'IN', 'IA', 'KS', 'KY', 'LA', 'MS',
    'MO', 'MT', 'NE', 'NC', 'ND', 'OH', 'OK', 'SC', 'SD', 'TN', 'TX', 'UT', 'VA', 'WV', 'WY'];
  assert.deepEqual([...av.AV_STATES].sort(), expected.sort());
  assert.equal(av.AV_STATES.length, 27);
  assert.equal(new Set(av.AV_STATES).size, 27, 'no duplicates');
  for (const s of ['CA', 'NY', 'PA', 'NV', 'CO', 'IL']) {
    assert.equal(av.isRegulatedState(s), false, `${s} must NOT be regulated`);
  }
  assert.equal(av.isRegulatedState('tx'), true, 'case-insensitive');
  assert.equal(av.isRegulatedState(null), false);
  assert.equal(av.isRegulatedState(''), false);
});

test('enabled() requires BOTH AV_PROVIDER and AV_API_KEY (CCBill-style dormancy)', () => {
  clearAvEnv();
  assert.equal(av.enabled(), false);
  process.env.AV_PROVIDER = 'stub';
  assert.equal(av.enabled(), false, 'provider without key stays dormant');
  delete process.env.AV_PROVIDER;
  process.env.AV_API_KEY = 'x';
  assert.equal(av.enabled(), false, 'key without provider stays dormant');
  setStubEnv();
  assert.equal(av.enabled(), true);
  assert.equal(av.providerName(), 'stub');
  clearAvEnv();
  assert.equal(av.providerName(), null);
});

test('gateDecision matrix — who is gated, who is never gated', () => {
  const D = av.gateDecision;
  // Non-fans are outside this feature entirely.
  assert.equal(D({ role: 'model', avVerifiedAt: null, geoCountry: 'US', geoState: 'TX', storedState: 'TX' }).gate, false);
  assert.equal(D({ role: 'admin', avVerifiedAt: null, geoCountry: 'US', geoState: 'TX', storedState: null }).gate, false);
  assert.equal(D({ role: 'recruiter', avVerifiedAt: null, geoCountry: null, geoState: null, storedState: null }).gate, false);
  // Verified once = verified for good.
  assert.equal(D({ role: 'fan', avVerifiedAt: '2026-10-16 00:00:00', geoCountry: 'US', geoState: 'TX', storedState: 'TX' }).reason, 'already_verified');
  // Verifiably outside the US: no state, no gate.
  assert.equal(D({ role: 'fan', avVerifiedAt: null, geoCountry: 'CA', geoState: null, storedState: 'TX' }).reason, 'non_us');
  // Fresh geo beats the stored state, both directions.
  assert.equal(D({ role: 'fan', avVerifiedAt: null, geoCountry: 'US', geoState: 'NY', storedState: 'TX' }).gate, false);
  assert.equal(D({ role: 'fan', avVerifiedAt: null, geoCountry: 'US', geoState: 'TX', storedState: 'NY' }).gate, true);
  // Stored state decides when this request's geo is unusable.
  assert.equal(D({ role: 'fan', avVerifiedAt: null, geoCountry: null, geoState: null, storedState: 'FL' }).gate, true);
  assert.equal(D({ role: 'fan', avVerifiedAt: null, geoCountry: null, geoState: null, storedState: 'CA' }).gate, false);
  assert.equal(D({ role: 'fan', avVerifiedAt: null, geoCountry: 'US', geoState: null, storedState: 'TN' }).gate, true);
  // UNKNOWN state gates on purpose (documented in lib/av.js): the
  // purchase is the choke point; a lookup failure must not wave a
  // regulated-state fan through.
  const unk = D({ role: 'fan', avVerifiedAt: null, geoCountry: null, geoState: null, storedState: null });
  assert.equal(unk.gate, true);
  assert.equal(unk.reason, 'unknown_state');
  assert.equal(D({ role: 'fan', avVerifiedAt: null, geoCountry: 'US', geoState: null, storedState: null }).gate, true);
});

test('stub verification: create → complete stamps proof exactly once', () => {
  const { db, svc } = makeSvc();
  const s = svc.createVerification({ userId: 1, username: 'regularfan', method: 'transactional' });
  assert.match(s.session_ref, /^stub_[a-f0-9]{32}$/);
  assert.equal(s.redirect_url, null);
  assert.equal(s.stub, true);
  assert.equal(s.method, 'transactional');

  const r = svc.completeVerification({ userId: 1, username: 'regularfan', sessionRef: s.session_ref });
  assert.deepEqual(r, { ok: true, passed: true, already: false });
  const u = userRow(db, 1);
  assert.ok(u.av_verified_at, 'proof timestamp stamped');
  assert.equal(u.av_method, 'transactional');
  assert.equal(u.av_provider_ref, s.session_ref);

  // Replay the same session AND complete a second session: the
  // original proof stamp must not move.
  const stamp = u.av_verified_at;
  const replay = svc.completeVerification({ userId: 1, username: 'regularfan', sessionRef: s.session_ref });
  assert.deepEqual(replay, { ok: true, passed: true, already: true });
  const s2 = svc.createVerification({ userId: 1, username: 'regularfan', method: 'id' });
  svc.completeVerification({ userId: 1, username: 'regularfan', sessionRef: s2.session_ref });
  assert.equal(userRow(db, 1).av_verified_at, stamp, 'proof stamp is exactly-once');
  assert.equal(userRow(db, 1).av_provider_ref, s.session_ref, 'first proof ref wins');

  // Unknown / someone else's session ref never completes.
  assert.deepEqual(
    svc.completeVerification({ userId: 1, username: 'regularfan', sessionRef: 'stub_deadbeef' }),
    { ok: false, error: 'unknown_session' });
  const s3 = svc.createVerification({ userId: 2, username: 'avfailfan', method: 'id' });
  assert.deepEqual(
    svc.completeVerification({ userId: 1, username: 'regularfan', sessionRef: s3.session_ref }),
    { ok: false, error: 'unknown_session' }, 'a session belongs to its fan');
  clearAvEnv();
});

test("stub verification: an 'avfail' fan fails and is stamped with nothing", () => {
  const { db, svc } = makeSvc();
  const s = svc.createVerification({ userId: 2, username: 'avfailfan', method: 'id' });
  const r = svc.completeVerification({ userId: 2, username: 'avfailfan', sessionRef: s.session_ref });
  assert.deepEqual(r, { ok: true, passed: false, already: false });
  const u = userRow(db, 2);
  assert.equal(u.av_verified_at, null);
  assert.equal(u.av_method, null);
  assert.equal(u.av_provider_ref, null);
  const sess = db.prepare('SELECT * FROM av_sessions WHERE provider_ref = ?').get(s.session_ref);
  assert.equal(sess.status, 'failed');
  assert.ok(sess.completed_at);
  clearAvEnv();
});

test('webhook path finalizes a session exactly once', () => {
  const { db, svc } = makeSvc();
  const s = svc.createVerification({ userId: 1, username: 'regularfan', method: 'id' });
  assert.deepEqual(svc.handleWebhook({ session_ref: s.session_ref, outcome: 'pass' }), { handled: 'verified' });
  assert.ok(userRow(db, 1).av_verified_at);
  assert.equal(userRow(db, 1).av_method, 'id');
  assert.deepEqual(svc.handleWebhook({ session_ref: s.session_ref, outcome: 'pass' }), { handled: 'duplicate' });
  assert.deepEqual(svc.handleWebhook({ session_ref: 'stub_nope', outcome: 'pass' }), { handled: 'ignored' });
  assert.deepEqual(svc.handleWebhook({}), { handled: 'ignored' });
  assert.equal(svc.verifyWebhookSignature({}, undefined), true, 'stub scheme accepts while stub is configured');
  clearAvEnv();
  assert.equal(svc.verifyWebhookSignature({}, undefined), false, 'dormant rejects every webhook');
});

test('TN re-attestation stamps only verified fans, only when enabled', () => {
  const { db, svc } = makeSvc();
  assert.equal(svc.stampReattestation(1), false, 'unverified fan: nothing to re-attest');
  const s = svc.createVerification({ userId: 1, username: 'regularfan', method: 'transactional' });
  svc.completeVerification({ userId: 1, username: 'regularfan', sessionRef: s.session_ref });
  assert.equal(svc.stampReattestation(1), true);
  assert.ok(userRow(db, 1).av_last_attested_at);
  clearAvEnv();
  assert.equal(svc.stampReattestation(1), false, 'dormant: no stamping');
});

test('service refuses while dormant or for an unimplemented provider', () => {
  const { svc } = makeSvc();
  clearAvEnv();
  assert.throws(() => svc.createVerification({ userId: 1, username: 'x', method: 'id' }),
    (e) => e.code === 'av_not_configured');
  process.env.AV_PROVIDER = 'realcorp';
  process.env.AV_API_KEY = 'k';
  assert.throws(() => svc.createVerification({ userId: 1, username: 'x', method: 'id' }),
    (e) => e.code === 'av_provider_not_implemented',
    'a named-but-unbuilt provider fails loudly instead of silently passing fans');
  clearAvEnv();
});

test('PROOF-ONLY schema: the feature stores refs and outcomes, never evidence', () => {
  // The exported column contract is the complete AV footprint on users.
  assert.deepEqual([...av.AV_USER_COLUMNS].sort(),
    ['av_last_attested_at', 'av_method', 'av_provider_ref', 'av_verified_at', 'fan_state']);
  for (const col of av.AV_USER_COLUMNS) {
    assert.ok(!/doc|image|photo|selfie|dob|birth|passport|licen[cs]e|payload|address/i.test(col),
      `AV column ${col} must not be an evidence field`);
  }
  // av_sessions carries no payload/document columns either.
  const { db } = makeSvc();
  const cols = db.prepare('PRAGMA table_info(av_sessions)').all().map((c) => c.name).sort();
  assert.deepEqual(cols,
    ['completed_at', 'created_at', 'id', 'method', 'provider', 'provider_ref', 'status', 'user_id']);
  clearAvEnv();
});

/* ---------------- Part B: real server over HTTP ---------------- */

const PRICES = { bitcoin: { usd: 50000 }, tether: { usd: 1 }, ethereum: { usd: 2500 }, solana: { usd: 100 }, ripple: { usd: 0.5 } };
const FIXED_USDT = '0x000000000000000000000000000000000000dEaD';
const CCBILL_FAKE = {
  CCBILL_ACCNUM: '900000001', CCBILL_SUBACC: '0001',
  CCBILL_FLEXFORM_ID: 'fake-flexform-id', CCBILL_SALT: 'fake-salt-for-tests-only',
};
let priceStub = null;
let priceUrl = null;

test.before(async () => {
  priceStub = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(PRICES));
  });
  await new Promise((r) => priceStub.listen(0, '127.0.0.1', r));
  priceUrl = `http://127.0.0.1:${priceStub.address().port}/prices`;
});
test.after(() => { if (priceStub) priceStub.close(); });

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function req(base, method, p, { body, token, headers } = {}) {
  const h = { ...(headers || {}) };
  if (body !== undefined) h['content-type'] = 'application/json';
  if (token) h.authorization = 'Bearer ' + token;
  const r = await fetch(base + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not json */ }
  return { status: r.status, json, text };
}

async function bootServer(extraEnv) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-avgate-'));
  for (const f of ['server.js', 'package.json']) {
    fs.copyFileSync(path.join(REPO, f), path.join(dir, f));
  }
  for (const d of ['lib', 'public', 'data']) {
    fs.cpSync(path.join(REPO, d), path.join(dir, d), { recursive: true });
  }
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), CRYPTO_POLL_MS: '3600000' };
  for (const k of Object.keys(env)) {
    if (/^(CCBILL_|CRYPTO_|OPENAI_|TWILIO_|VAPID_|WEBAUTHN_|AV_)/.test(k)) delete env[k];
  }
  Object.assign(env, extraEnv);
  const child = spawn(process.execPath, ['server.js'], { cwd: dir, env });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode})\n${log}`);
    try { const r = await fetch(base + '/api/health'); if (r.ok) break; } catch (e) { /* not up */ }
    if (Date.now() > deadline) throw new Error(`server did not come up\n${log}`);
    await new Promise((r) => setTimeout(r, 150));
  }
  return { base, dir, child };
}

async function signupFan(base, username, ip) {
  const r = await req(base, 'POST', '/api/auth/signup', {
    body: { username, password: 'fan-pass-123', role: 'fan', display_name: username, dob: '1995-05-05', agree18: true },
    headers: ip ? { 'x-forwarded-for': ip } : {},
  });
  assert.equal(r.status, 200, `signup ${username}: ${r.text}`);
  return r.json.token;
}
const avStatus = (base, token) => req(base, 'GET', '/api/av/status', { token });
const checkout = (base, token, ip) => req(base, 'POST', '/api/ccbill/checkout', {
  token, body: { package_id: 'p25' }, headers: ip ? { 'x-forwarded-for': ip } : {},
});
const invoice = (base, token, ip) => req(base, 'POST', '/api/crypto/invoices', {
  token, body: { package_id: 'p25', coin: 'USDT' }, headers: ip ? { 'x-forwarded-for': ip } : {},
});

test('B1: AV ENABLED — gate fires at both purchase paths, verification unlocks, dormancy rules hold', { timeout: 180000 }, async (t) => {
  const { base, dir, child } = await bootServer({
    ...CCBILL_FAKE,
    CRYPTO_USDT_ADDRESS: FIXED_USDT, CRYPTO_PRICE_URL: priceUrl,
    AV_PROVIDER: 'stub', AV_API_KEY: 'http-test-key-only',
  });
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /* --- TX fan: gated at BOTH purchase initiations --- */
  const tx = await signupFan(base, 'avtxfan', TX_IP);
  let st = await avStatus(base, tx);
  assert.equal(st.json.enabled, true);
  assert.equal(st.json.provider, 'stub');
  assert.equal(st.json.state, 'TX', 'signup stamped the fan state from IP');
  assert.equal(st.json.verified, false);

  let r = await checkout(base, tx, TX_IP);
  assert.equal(r.status, 403, `card checkout gated: ${r.text}`);
  assert.equal(r.json.error, 'av_required');
  assert.equal(r.json.method, 'transactional', 'card path verifies via transactional data');

  r = await invoice(base, tx, TX_IP);
  assert.equal(r.status, 403, `crypto invoice gated: ${r.text}`);
  assert.equal(r.json.error, 'av_required');
  assert.equal(r.json.method, 'id', 'crypto path verifies via ID check');
  const invList = await req(base, 'GET', '/api/crypto/invoices', { token: tx });
  assert.equal(invList.json.invoices.length, 0, 'the gate creates NO invoice');

  /* --- verify via start/complete, then both rails open --- */
  const start = await req(base, 'POST', '/api/av/start', { token: tx, body: { method: 'transactional' } });
  assert.equal(start.status, 200, `av start: ${start.text}`);
  assert.equal(start.json.stub, true);
  const done = await req(base, 'POST', '/api/av/complete', { token: tx, body: { session_ref: start.json.session_ref } });
  assert.equal(done.status, 200);
  assert.equal(done.json.passed, true);
  st = await avStatus(base, tx);
  assert.equal(st.json.verified, true);
  assert.equal(st.json.method, 'transactional');
  assert.ok(st.json.verified_at);
  assert.equal(st.json.last_attested_at, null, 'no TN stamp before a fresh login');
  const firstStamp = st.json.verified_at;

  // Exactly-once: replay + a second full session leave the stamp alone.
  await new Promise((r2) => setTimeout(r2, 1100));
  const replay = await req(base, 'POST', '/api/av/complete', { token: tx, body: { session_ref: start.json.session_ref } });
  assert.equal(replay.json.passed, true);
  const start2 = await req(base, 'POST', '/api/av/start', { token: tx, body: { method: 'id' } });
  await req(base, 'POST', '/api/av/complete', { token: tx, body: { session_ref: start2.json.session_ref } });
  st = await avStatus(base, tx);
  assert.equal(st.json.verified_at, firstStamp, 'proof stamp never moves once set');

  r = await checkout(base, tx, TX_IP);
  assert.equal(r.status, 200, `checkout after verify: ${r.text}`);
  assert.ok(String(r.json.url).includes('flexforms'), 'real checkout URL issued');
  r = await invoice(base, tx, TX_IP);
  assert.equal(r.status, 201, `invoice after verify: ${r.text}`);

  /* --- TN re-attestation: the next login stamps it --- */
  const login = await req(base, 'POST', '/api/auth/login', { body: { username: 'avtxfan', password: 'fan-pass-123' } });
  assert.equal(login.status, 200);
  st = await avStatus(base, login.json.token);
  assert.ok(st.json.last_attested_at, 'login stamped the session re-attestation');

  /* --- NY fan: never gated, never verified --- */
  const ny = await signupFan(base, 'avnyfan', NY_IP);
  st = await avStatus(base, ny);
  assert.equal(st.json.state, 'NY');
  r = await checkout(base, ny, NY_IP);
  assert.equal(r.status, 200, `NY checkout ungated: ${r.text}`);
  r = await invoice(base, ny, NY_IP);
  assert.equal(r.status, 201, `NY invoice ungated: ${r.text}`);
  st = await avStatus(base, ny);
  assert.equal(st.json.verified, false, 'ungated fans are not force-verified');

  /* --- Unknown-state fan: gated until a purchase-time refresh places her --- */
  const unk = await signupFan(base, 'avunkfan', null);
  st = await avStatus(base, unk);
  assert.equal(st.json.state, null, 'loopback signup resolves no state');
  r = await checkout(base, unk, null);
  assert.equal(r.status, 403, 'unknown state is gated (choke-point policy)');
  assert.equal(r.json.error, 'av_required');
  assert.equal(r.json.state, null);
  r = await checkout(base, unk, CA_IP);
  assert.equal(r.status, 200, `fresh CA geo at purchase releases the gate: ${r.text}`);
  st = await avStatus(base, unk);
  assert.equal(st.json.state, 'CA', 'purchase-time refresh persisted the fresh state');

  /* --- Stored TX, fresh NY at purchase: the fresh geo wins --- */
  const tx2 = await signupFan(base, 'avtxfan2', TX_IP);
  r = await checkout(base, tx2, NY_IP);
  assert.equal(r.status, 200, `fresh unregulated geo beats a stored regulated state: ${r.text}`);
  st = await avStatus(base, tx2);
  assert.equal(st.json.state, 'NY');
  assert.equal(st.json.verified, false);

  /* --- avfail fan: the stub fails her and the gate stays shut --- */
  const bad = await signupFan(base, 'avfailfan', TX_IP);
  const bs = await req(base, 'POST', '/api/av/start', { token: bad, body: { method: 'transactional' } });
  const bc = await req(base, 'POST', '/api/av/complete', { token: bad, body: { session_ref: bs.json.session_ref } });
  assert.equal(bc.json.passed, false);
  r = await checkout(base, bad, TX_IP);
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'av_required');

  /* --- Webhook fan: provider-posted result finalizes exactly once --- */
  const wh = await signupFan(base, 'avwhfan', TX_IP);
  const ws = await req(base, 'POST', '/api/av/start', { token: wh, body: { method: 'id' } });
  let hook = await req(base, 'POST', '/api/av/webhook', { body: { session_ref: ws.json.session_ref, outcome: 'pass' } });
  assert.equal(hook.status, 200);
  assert.equal(hook.json.handled, 'verified');
  st = await avStatus(base, wh);
  assert.equal(st.json.verified, true);
  assert.equal(st.json.method, 'id');
  hook = await req(base, 'POST', '/api/av/webhook', { body: { session_ref: ws.json.session_ref, outcome: 'pass' } });
  assert.equal(hook.json.handled, 'duplicate');
  hook = await req(base, 'POST', '/api/av/webhook', { body: { session_ref: 'stub_nope', outcome: 'pass' } });
  assert.equal(hook.json.handled, 'ignored');

  /* --- Models are outside the gate: forbidden, never av_required --- */
  const ms = await req(base, 'POST', '/api/auth/signup', {
    body: { username: 'avmodel', password: 'model-pass-123', role: 'model', display_name: 'AV Model', dob: '1995-05-05', agree18: true, section: 'female' },
    headers: { 'x-forwarded-for': TX_IP },
  });
  assert.equal(ms.status, 200, `model signup: ${ms.text}`);
  r = await checkout(base, ms.json.token, TX_IP);
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'forbidden', 'role gate answers models — the AV gate never sees them');
  r = await req(base, 'POST', '/api/av/start', { token: ms.json.token, body: { method: 'id' } });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'forbidden');

  /* --- Proof-only schema on the real server DB --- */
  child.kill('SIGKILL');
  await new Promise((r2) => setTimeout(r2, 300));
  const db = new DatabaseSync(path.join(dir, 'wogent-chat.db'), { readOnly: true });
  try {
    const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
    for (const c of av.AV_USER_COLUMNS) assert.ok(cols.includes(c), `users.${c} exists`);
    const avCols = cols.filter((c) => c.startsWith('av_') || c === 'fan_state').sort();
    assert.deepEqual(avCols, [...av.AV_USER_COLUMNS].sort(), 'no AV columns beyond the proof set');
    assert.ok(!cols.some((c) => /av.*(doc|image|selfie|birth|passport)/i.test(c)),
      'no evidence columns were added for AV');
    const txRow = db.prepare("SELECT fan_state, av_method FROM users WHERE username = 'avtxfan'").get();
    assert.equal(txRow.fan_state, 'TX');
    assert.equal(txRow.av_method, 'transactional');
  } finally { db.close(); }
});

test('B2: AV DORMANT — purchases behave exactly as today and /api/av/* refuses', { timeout: 180000 }, async (t) => {
  const { base, dir, child } = await bootServer({
    ...CCBILL_FAKE,
    CRYPTO_USDT_ADDRESS: FIXED_USDT, CRYPTO_PRICE_URL: priceUrl,
    // no AV_* env at all — the production configuration today
  });
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const tx = await signupFan(base, 'avtxfan', TX_IP);
  const st = await avStatus(base, tx);
  assert.equal(st.json.enabled, false);
  assert.equal(st.json.provider, null);
  assert.equal(st.json.state, 'TX', 'state detection is harmless bookkeeping even while dormant');

  let r = await checkout(base, tx, TX_IP);
  assert.equal(r.status, 200, `dormant card checkout: ${r.text}`);
  assert.ok(String(r.json.url).includes('flexforms'));
  r = await invoice(base, tx, TX_IP);
  assert.equal(r.status, 201, `dormant crypto invoice: ${r.text}`);

  r = await req(base, 'POST', '/api/av/start', { token: tx, body: { method: 'id' } });
  assert.equal(r.status, 503);
  assert.equal(r.json.error, 'av_not_configured');
  r = await req(base, 'POST', '/api/av/complete', { token: tx, body: { session_ref: 'stub_x' } });
  assert.equal(r.status, 503);
  assert.equal(r.json.error, 'av_not_configured');
  r = await req(base, 'POST', '/api/av/webhook', { body: { session_ref: 'stub_x', outcome: 'pass' } });
  assert.equal(r.status, 401, 'dormant webhook rejects everything');

  const login = await req(base, 'POST', '/api/auth/login', { body: { username: 'avtxfan', password: 'fan-pass-123' } });
  assert.equal(login.status, 200, 'login unaffected while dormant');
});

/* ---------------- Part C: source pins ---------------- */

test('source pins — both purchase routes carry the gate; the client handles av_required in all 13 languages', () => {
  const server = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
  assert.ok(server.includes("avPurchaseGate(req, 'transactional')"), 'card checkout is gated (transactional)');
  assert.ok(server.includes("avPurchaseGate(req, 'id')"), 'crypto invoice creation is gated (id)');
  assert.ok(!/av_(dob|document|image|selfie)/.test(server), 'server stores no AV evidence fields');

  const app = fs.readFileSync(path.join(REPO, 'public', 'js', 'app.js'), 'utf8');
  assert.ok(app.includes('function showAvGate'), 'client gate renderer exists');
  assert.equal((app.match(/error === 'av_required'/g) || []).length, 4,
    'all four purchase call sites handle av_required (2 card + 2 crypto)');
  assert.equal((app.match(/av_gate_body:/g) || []).length, 13, 'gate copy exists in all 13 languages');
  assert.ok(app.includes("One quick age check before your first purchase — required by your state\\'s law."),
    'the owner-approved gate sentence is the EN copy');
});
