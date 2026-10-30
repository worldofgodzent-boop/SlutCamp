'use strict';
/*
 * AgeChecker integration (Assignment 16, Ms. Pink, Oct 28 2026) —
 * the first real provider branch in lib/av.js, built ONLY from the
 * contract essentials Ms. Pink pulled from the AgeChecker dashboard:
 *   POST /v1/create -> { uuid }; GET /v1/status/<uuid>; POST
 *   /v1/id-verify (UK/FR/DE/AU route + US fallback); hosted session
 *   link https://verify.agechecker.net/s/<uuid>; webhook PUT with
 *   X-AgeChecker-Signature = base64 HMAC-SHA1(raw body, secret);
 *   /v1/fraud-risk is OUT of scope and never called.
 *
 * Locked design pinned here: verification fires ONCE at a fan's
 * first credit purchase; tier by billing country FIRST, IP second;
 * US -> data check (/v1/create) with ID-scan fallback; UK/FR/DE/AU
 * -> ID scan (/v1/id-verify) straight; everywhere else -> NO
 * provider call. Dormant while AGECHECKER_API_KEY /
 * AGECHECKER_SECRET are unset (AV_PROVIDER=agechecker selects the
 * adapter). Proof only: uuid + method + timestamps.
 *
 * Part A (unit, in-memory DB): the global fetch is replaced with a
 * recorder that answers the documented shapes — zero real network.
 * Part B (real server over HTTP, temp-copy boots like
 * tests/av-gate.test.js): AGECHECKER_API_BASE points at a local
 * stub server on 127.0.0.1 — zero real network.
 *
 * Geo fixtures are real IPs the bundled geoip-lite resolves to the
 * countries used (verified against the shipped dataset): TX
 * 99.50.0.1, GB 81.2.69.160, FR 90.63.0.1, ES 83.44.0.1.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const av = require('../lib/av.js');

const REPO = path.join(__dirname, '..');
const TX_IP = '99.50.0.1';
const GB_IP = '81.2.69.160';
const FR_IP = '90.63.0.1';
const ES_IP = '83.44.0.1';

const AC_KEY = 'fake-agechecker-domain-key';
const AC_SECRET = 'fake-agechecker-secret-for-tests';

/* ---------------- env helpers ---------------- */

const AC_ENV_KEYS = ['AV_PROVIDER', 'AV_API_KEY', 'AV_WEBHOOK_SECRET',
  'AGECHECKER_API_KEY', 'AGECHECKER_SECRET', 'AGECHECKER_API_BASE'];
function clearAcEnv() {
  for (const k of AC_ENV_KEYS) delete process.env[k];
}
function setAcEnv() {
  clearAcEnv();
  process.env.AV_PROVIDER = 'agechecker';
  process.env.AGECHECKER_API_KEY = AC_KEY;
  process.env.AGECHECKER_SECRET = AC_SECRET;
}

/* ---------------- fetch recorder (Part A) ---------------- */

let fetchCalls = [];
let statusByUuid = new Map();
let createSeq = 0;
let idSeq = 0;
const realFetch = globalThis.fetch;

function jsonResp(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'content-type': 'application/json' },
  });
}

function installFetchStub() {
  fetchCalls = [];
  statusByUuid = new Map();
  createSeq = 0;
  idSeq = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    let body = null;
    if (init.body) { try { body = JSON.parse(init.body); } catch (_) { body = String(init.body); } }
    fetchCalls.push({ url: u, method: init.method || 'GET', headers: init.headers || {}, body });
    if (u.endsWith('/v1/create')) { createSeq += 1; return jsonResp({ uuid: 'ac-create-' + createSeq }); }
    if (u.endsWith('/v1/id-verify')) { idSeq += 1; return jsonResp({ uuid: 'ac-id-' + idSeq }); }
    const m = u.match(/\/v1\/status\/(.+)$/);
    if (m) return jsonResp({ status: statusByUuid.get(decodeURIComponent(m[1])) || 'accepted' });
    throw new Error('unstubbed fetch (zero real network in tests): ' + u);
  };
}
function uninstallFetchStub() { globalThis.fetch = realFetch; }
test.after(() => uninstallFetchStub());

/* ---------------- Part A: unit ---------------- */

function makeSvc() {
  setAcEnv();
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT,
      fan_state TEXT, av_verified_at TEXT, av_method TEXT,
      av_provider_ref TEXT, av_last_attested_at TEXT);
    INSERT INTO users (id, username) VALUES
      (1, 'usfan'), (2, 'gbfan'), (3, 'frfan'), (4, 'esfan'), (5, 'cryptofan');
  `);
  return { db, svc: av.createAvService({ db }) };
}
const userRow = (db, id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
const sessionRow = (db, ref) => db.prepare('SELECT * FROM av_sessions WHERE provider_ref = ?').get(ref);

test('A16 dormancy: agechecker needs AV_PROVIDER=agechecker AND both AGECHECKER_* vars', () => {
  clearAcEnv();
  assert.equal(av.enabled(), false);
  process.env.AV_PROVIDER = 'agechecker';
  assert.equal(av.enabled(), false, 'provider selected but no AgeChecker keys: dormant');
  process.env.AGECHECKER_API_KEY = AC_KEY;
  assert.equal(av.enabled(), false, 'key without secret: dormant (webhook results could not be trusted)');
  delete process.env.AGECHECKER_API_KEY;
  process.env.AGECHECKER_SECRET = AC_SECRET;
  assert.equal(av.enabled(), false, 'secret without key: dormant');
  process.env.AGECHECKER_API_KEY = AC_KEY;
  assert.equal(av.enabled(), true);
  assert.equal(av.providerName(), 'agechecker');
  // The generic AV_API_KEY does NOT activate the AgeChecker branch:
  // the contract names AGECHECKER_* as the credential source.
  clearAcEnv();
  process.env.AV_PROVIDER = 'agechecker';
  process.env.AV_API_KEY = 'some-other-key';
  assert.equal(av.enabled(), false, 'AV_API_KEY alone never activates agechecker');
  clearAcEnv();
});

test('A16 service refuses while dormant (agechecker selected, keys unset)', async () => {
  const { svc } = makeSvc();
  clearAcEnv();
  process.env.AV_PROVIDER = 'agechecker'; // selected, but no AGECHECKER_* keys
  await assert.rejects(
    async () => svc.createVerification({ userId: 1, username: 'usfan', method: 'transactional', ipCountry: 'US' }),
    (e) => e.code === 'av_not_configured');
  clearAcEnv();
});

test('tier helpers: billing country wins, UK normalizes to GB, routes per spec', () => {
  assert.equal(av.tierCountry({ billingCountry: 'GB', ipCountry: 'US' }), 'GB');
  assert.equal(av.tierCountry({ billingCountry: 'US', ipCountry: 'GB' }), 'US');
  assert.equal(av.tierCountry({ billingCountry: null, ipCountry: 'fr' }), 'FR');
  assert.equal(av.tierCountry({ billingCountry: null, ipCountry: null }), null);
  assert.equal(av.tierCountry({ billingCountry: 'UK', ipCountry: null }), 'GB');
  assert.equal(av.agecheckerRoute('US'), 'data');
  for (const c of ['GB', 'UK', 'FR', 'DE', 'AU']) {
    assert.equal(av.agecheckerRoute(c), 'id', `${c} goes straight to the ID scan`);
  }
  for (const c of ['ES', 'CA', 'JP', 'BR', null, '']) {
    assert.equal(av.agecheckerRoute(c), null, `${c} gets NO provider call`);
  }
  assert.deepEqual([...av.AGECHECKER_DATA_COUNTRIES], ['US']);
  assert.deepEqual([...av.AGECHECKER_ID_COUNTRIES].sort(), ['AU', 'DE', 'FR', 'GB']);
});

test('agecheckerGateDecision matrix — strict countries gate, everyone else passes', () => {
  const D = av.agecheckerGateDecision;
  const fan = { role: 'fan', avVerifiedAt: null };
  assert.equal(D({ role: 'model', avVerifiedAt: null, ipCountry: 'US', method: 'transactional' }).gate, false);
  assert.equal(D({ ...fan, avVerifiedAt: '2026-10-28 00:00:00', ipCountry: 'US', method: 'transactional' }).reason, 'already_verified');
  // US card -> data route; US crypto -> ID route (no card data to check).
  assert.deepEqual(D({ ...fan, ipCountry: 'US', method: 'transactional' }),
    { gate: true, reason: 'strict_country', country: 'US', route: 'data' });
  assert.equal(D({ ...fan, ipCountry: 'US', method: 'id' }).route, 'id');
  // ID countries gate on either rail, always via the ID route.
  for (const c of ['GB', 'FR', 'DE', 'AU']) {
    assert.deepEqual(D({ ...fan, ipCountry: c, method: 'transactional' }),
      { gate: true, reason: 'strict_country', country: c, route: 'id' }, c);
  }
  // Billing country decides even when the IP disagrees.
  assert.equal(D({ ...fan, billingCountry: 'GB', ipCountry: 'US', method: 'transactional' }).country, 'GB');
  assert.equal(D({ ...fan, billingCountry: 'ES', ipCountry: 'US', method: 'transactional' }).gate, false);
  // Non-strict: never gated, either rail.
  for (const c of ['ES', 'CA', 'JP']) {
    assert.equal(D({ ...fan, ipCountry: c, method: 'transactional' }).reason, 'non_strict_country');
    assert.equal(D({ ...fan, ipCountry: c, method: 'id' }).gate, false);
  }
  // Unknown country gates (choke-point policy), rail picks the flow.
  assert.deepEqual(D({ ...fan, ipCountry: null, method: 'transactional' }),
    { gate: true, reason: 'unknown_country', country: null, route: 'data' });
  assert.equal(D({ ...fan, ipCountry: null, method: 'id' }).route, 'id');
});

test('US fan: POST /v1/create data route — request shape, session row, hosted link', async () => {
  const { db, svc } = makeSvc();
  installFetchStub();
  const s = await svc.createVerification({ userId: 1, username: 'usfan', method: 'transactional', ipCountry: 'US' });
  assert.equal(fetchCalls.length, 1, 'exactly one provider call');
  const call = fetchCalls[0];
  assert.equal(call.url, 'https://api.agechecker.net/v1/create');
  assert.equal(call.method, 'POST');
  assert.deepEqual(call.body, { key: AC_KEY }, 'POST body carries the documented key field only');
  assert.equal(call.headers['X-AgeChecker-Secret'], AC_SECRET);
  assert.equal(s.session_ref, 'ac-create-1');
  assert.equal(s.redirect_url, 'https://verify.agechecker.net/s/ac-create-1');
  assert.equal(s.stub, false);
  assert.equal(s.method, 'transactional');
  const row = sessionRow(db, 'ac-create-1');
  assert.equal(row.provider, 'agechecker');
  assert.equal(row.method, 'transactional');
  assert.equal(row.status, 'pending');
  assert.equal(row.user_id, 1);
  uninstallFetchStub();
  clearAcEnv();
});

test('GB / FR / UK fans go straight to /v1/id-verify — /v1/create is never called', async () => {
  const { db, svc } = makeSvc();
  installFetchStub();
  const gb = await svc.createVerification({ userId: 2, username: 'gbfan', method: 'transactional', ipCountry: 'GB' });
  const fr = await svc.createVerification({ userId: 3, username: 'frfan', method: 'id', ipCountry: 'FR' });
  const uk = await svc.createVerification({ userId: 2, username: 'gbfan', method: 'transactional', ipCountry: 'UK' });
  assert.equal(createSeq, 0, '/v1/create never called for ID countries');
  assert.equal(idSeq, 3);
  for (const s of [gb, fr, uk]) {
    assert.equal(s.method, 'id');
    assert.equal(s.stub, false);
    assert.ok(s.redirect_url.startsWith('https://verify.agechecker.net/s/ac-id-'));
    assert.equal(sessionRow(db, s.session_ref).method, 'id');
  }
  assert.ok(fetchCalls.every((c) => c.url.endsWith('/v1/id-verify')));
  uninstallFetchStub();
  clearAcEnv();
});

test('adapter tiering: billing country beats IP in both directions; crypto degrades US to ID', async () => {
  const { svc } = makeSvc();
  installFetchStub();
  const a = await svc.createVerification({ userId: 1, username: 'usfan', method: 'transactional', billingCountry: 'GB', ipCountry: 'US' });
  assert.equal(a.method, 'id', 'GB billing wins over US IP');
  const b = await svc.createVerification({ userId: 1, username: 'usfan', method: 'transactional', billingCountry: 'US', ipCountry: 'GB' });
  assert.equal(b.method, 'transactional', 'US billing wins over GB IP');
  const c = await svc.createVerification({ userId: 5, username: 'cryptofan', method: 'id', ipCountry: 'US' });
  assert.equal(c.method, 'id', 'US crypto purchase takes the ID route (no card data exists)');
  assert.equal(createSeq, 1);
  assert.equal(idSeq, 2);
  uninstallFetchStub();
  clearAcEnv();
});

test('non-strict country: the adapter itself refuses and makes ZERO provider calls', async () => {
  const { svc } = makeSvc();
  installFetchStub();
  await assert.rejects(
    svc.createVerification({ userId: 4, username: 'esfan', method: 'transactional', ipCountry: 'ES' }),
    (e) => e.code === 'av_not_required');
  await assert.rejects(
    svc.createVerification({ userId: 4, username: 'esfan', method: 'id', billingCountry: 'CA', ipCountry: 'ES' }),
    (e) => e.code === 'av_not_required');
  assert.equal(fetchCalls.length, 0, 'no provider call for non-strict countries');
  uninstallFetchStub();
  clearAcEnv();
});

test('complete: accepted stamps proof exactly once (uuid + method), replay reports already', async () => {
  const { db, svc } = makeSvc();
  installFetchStub();
  const s = await svc.createVerification({ userId: 1, username: 'usfan', method: 'transactional', ipCountry: 'US' });
  const r = await svc.completeVerification({ userId: 1, username: 'usfan', sessionRef: s.session_ref });
  assert.deepEqual(r, { ok: true, passed: true, already: false });
  const poll = fetchCalls[fetchCalls.length - 1];
  assert.equal(poll.method, 'GET');
  assert.equal(poll.url, 'https://api.agechecker.net/v1/status/ac-create-1');
  assert.equal(poll.headers['X-AgeChecker-Key'], AC_KEY, 'status poll carries the documented GET key header');
  const u = userRow(db, 1);
  assert.ok(u.av_verified_at, 'proof timestamp stamped');
  assert.equal(u.av_method, 'transactional');
  assert.equal(u.av_provider_ref, 'ac-create-1', 'the retained reference is the AgeChecker uuid');
  const replay = await svc.completeVerification({ userId: 1, username: 'usfan', sessionRef: s.session_ref });
  assert.deepEqual(replay, { ok: true, passed: true, already: true });
  assert.equal(userRow(db, 1).av_provider_ref, 'ac-create-1');
  // Someone else's session never resolves.
  assert.deepEqual(
    await svc.completeVerification({ userId: 2, username: 'gbfan', sessionRef: s.session_ref }),
    { ok: false, error: 'unknown_session' });
  uninstallFetchStub();
  clearAcEnv();
});

test('complete: denied fails the session and stamps nothing; not_created is an error', async () => {
  const { db, svc } = makeSvc();
  installFetchStub();
  const s = await svc.createVerification({ userId: 1, username: 'usfan', method: 'transactional', ipCountry: 'US' });
  statusByUuid.set('ac-create-1', 'denied');
  const r = await svc.completeVerification({ userId: 1, username: 'usfan', sessionRef: s.session_ref });
  assert.deepEqual(r, { ok: true, passed: false, already: false });
  const u = userRow(db, 1);
  assert.equal(u.av_verified_at, null);
  assert.equal(u.av_provider_ref, null);
  assert.equal(sessionRow(db, 'ac-create-1').status, 'failed');

  const s2 = await svc.createVerification({ userId: 1, username: 'usfan', method: 'transactional', ipCountry: 'US' });
  statusByUuid.set('ac-create-2', 'not_created');
  assert.deepEqual(
    await svc.completeVerification({ userId: 1, username: 'usfan', sessionRef: s2.session_ref }),
    { ok: false, error: 'av_not_created' });
  assert.equal(sessionRow(db, 'ac-create-2').status, 'pending', 'not_created leaves the session untouched');
  uninstallFetchStub();
  clearAcEnv();
});

test('complete: in-progress statuses leave the session open and stamp nothing', async () => {
  const { db, svc } = makeSvc();
  installFetchStub();
  const s = await svc.createVerification({ userId: 2, username: 'gbfan', method: 'transactional', ipCountry: 'GB' });
  for (const st of ['pending', 'phone_validation', 'signature', 'sms_sent']) {
    statusByUuid.set('ac-id-1', st);
    const r = await svc.completeVerification({ userId: 2, username: 'gbfan', sessionRef: s.session_ref });
    assert.equal(r.ok, true, st);
    assert.equal(r.passed, false, st);
    assert.equal(r.pending, true, st);
    assert.equal(sessionRow(db, 'ac-id-1').status, 'pending', st);
  }
  assert.equal(userRow(db, 2).av_verified_at, null);
  uninstallFetchStub();
  clearAcEnv();
});

test('US fallback: photo_id on the data route starts the ID scan; the session continues under the new uuid', async () => {
  const { db, svc } = makeSvc();
  installFetchStub();
  const s = await svc.createVerification({ userId: 1, username: 'usfan', method: 'transactional', ipCountry: 'US' });
  assert.equal(s.session_ref, 'ac-create-1');
  statusByUuid.set('ac-create-1', 'photo_id');
  const r = await svc.completeVerification({ userId: 1, username: 'usfan', sessionRef: 'ac-create-1' });
  assert.equal(r.ok, true);
  assert.equal(r.pending, true);
  assert.equal(r.fallback, 'id');
  assert.equal(r.session_ref, 'ac-id-1', 'the fallback returns the new verification uuid');
  assert.equal(r.redirect_url, 'https://verify.agechecker.net/s/ac-id-1');
  assert.equal(idSeq, 1, 'exactly one /v1/id-verify call');
  const row = db.prepare('SELECT * FROM av_sessions WHERE id = 1').get();
  assert.equal(row.provider_ref, 'ac-id-1', 'pending session re-pointed at the ID-scan uuid');
  assert.equal(row.method, 'id');
  assert.equal(row.status, 'pending');
  // The retired create uuid no longer resolves.
  assert.deepEqual(
    await svc.completeVerification({ userId: 1, username: 'usfan', sessionRef: 'ac-create-1' }),
    { ok: false, error: 'unknown_session' });
  // The ID scan accepts: proof names the FINAL uuid and the id method.
  const done = await svc.completeVerification({ userId: 1, username: 'usfan', sessionRef: 'ac-id-1' });
  assert.deepEqual(done, { ok: true, passed: true, already: false });
  const u = userRow(db, 1);
  assert.equal(u.av_provider_ref, 'ac-id-1');
  assert.equal(u.av_method, 'id');
  assert.ok(u.av_verified_at);
  uninstallFetchStub();
  clearAcEnv();
});

test('webhook: base64 HMAC-SHA1 over the raw body gates everything; outcomes finalize exactly once', async () => {
  const { db, svc } = makeSvc();
  installFetchStub();
  const s = await svc.createVerification({ userId: 1, username: 'usfan', method: 'transactional', ipCountry: 'US' });
  const rawBody = JSON.stringify({ uuid: s.session_ref, status: 'accepted' });
  const sig = crypto.createHmac('sha1', AC_SECRET).update(rawBody, 'utf8').digest('base64');
  assert.equal(svc.verifyWebhookSignature(rawBody, sig), true, 'string raw body verifies');
  assert.equal(svc.verifyWebhookSignature(Buffer.from(rawBody, 'utf8'), sig), true, 'Buffer raw body verifies');
  assert.equal(svc.verifyWebhookSignature(rawBody, sig.slice(0, -2) + 'xx'), false, 'tampered signature rejected');
  assert.equal(svc.verifyWebhookSignature(rawBody, undefined), false);
  assert.equal(svc.verifyWebhookSignature(rawBody, ''), false);
  assert.equal(svc.verifyWebhookSignature(JSON.stringify({ uuid: s.session_ref, status: 'denied' }), sig), false,
    'a signature never carries to a different body');

  assert.deepEqual(svc.handleWebhook({ uuid: s.session_ref, status: 'accepted' }), { handled: 'verified' });
  const u = userRow(db, 1);
  assert.ok(u.av_verified_at);
  assert.equal(u.av_provider_ref, s.session_ref);
  assert.equal(u.av_method, 'transactional');
  assert.deepEqual(svc.handleWebhook({ uuid: s.session_ref, status: 'accepted' }), { handled: 'duplicate' });
  assert.deepEqual(svc.handleWebhook({ uuid: 'ac-nope', status: 'accepted' }), { handled: 'ignored' });
  assert.deepEqual(svc.handleWebhook({ status: 'accepted' }), { handled: 'ignored' });
  uninstallFetchStub();
  clearAcEnv();
});

test('webhook: non-final statuses change nothing; a denial stores NO reason (proof-only)', async () => {
  const { db, svc } = makeSvc();
  installFetchStub();
  const s = await svc.createVerification({ userId: 2, username: 'gbfan', method: 'transactional', ipCountry: 'GB' });
  assert.deepEqual(svc.handleWebhook({ uuid: s.session_ref, status: 'photo_id' }), { handled: 'ignored' });
  assert.deepEqual(svc.handleWebhook({ uuid: s.session_ref, status: 'pending' }), { handled: 'ignored' });
  assert.equal(sessionRow(db, s.session_ref).status, 'pending');
  assert.deepEqual(
    svc.handleWebhook({ uuid: s.session_ref, status: 'denied', reason: 'document_underage_marker' }),
    { handled: 'failed' });
  const row = sessionRow(db, s.session_ref);
  assert.equal(row.status, 'failed');
  assert.ok(!JSON.stringify(row).includes('document_underage_marker'),
    'the deny reason is read for the outcome and never persisted');
  assert.ok(!JSON.stringify(userRow(db, 2)).includes('document_underage_marker'));
  const cols = db.prepare('PRAGMA table_info(av_sessions)').all().map((c) => c.name).sort();
  assert.deepEqual(cols,
    ['completed_at', 'created_at', 'id', 'method', 'provider', 'provider_ref', 'status', 'user_id'],
    'av_sessions gained no payload/reason columns for AgeChecker');
  uninstallFetchStub();
  clearAcEnv();
});

/* ---------------- Part B: real server over HTTP ----------------
   Same temp-copy boot discipline as tests/av-gate.test.js (Bearer
   tokens from /api/auth/signup, package_id purchases, full-map
   price stub), plus a local AgeChecker stub server that the
   AGECHECKER_API_BASE override points at. */

const PRICES = { bitcoin: { usd: 50000 }, tether: { usd: 1 }, ethereum: { usd: 2500 }, solana: { usd: 100 }, ripple: { usd: 0.5 } };
const FIXED_USDT = '0x000000000000000000000000000000000000dEaD';
const CCBILL_FAKE = {
  CCBILL_ACCNUM: '900000001', CCBILL_SUBACC: '0001',
  CCBILL_FLEXFORM_ID: 'fake-flexform-id', CCBILL_SALT: 'fake-salt-for-tests-only',
};

let acCalls = [];
let acBase = null;
let priceUrl = null;

test.before(async () => {
  const acStub = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); } catch (_) { body = null; }
      acCalls.push({ method: req.method, path: req.url, body,
        secretHeader: req.headers['x-agechecker-secret'] || null,
        keyHeader: req.headers['x-agechecker-key'] || null });
      res.setHeader('content-type', 'application/json');
      if (req.method === 'POST' && req.url === '/v1/create') return res.end(JSON.stringify({ uuid: 'boot-create-1' }));
      if (req.method === 'POST' && req.url === '/v1/id-verify') return res.end(JSON.stringify({ uuid: 'boot-id-1' }));
      if (req.method === 'GET' && req.url.startsWith('/v1/status/')) return res.end(JSON.stringify({ status: 'accepted' }));
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'unknown_stub_path' }));
    });
  });
  await new Promise((r) => acStub.listen(0, '127.0.0.1', r));
  acStub.unref();
  acBase = `http://127.0.0.1:${acStub.address().port}`;

  const priceStub = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(PRICES));
  });
  await new Promise((r) => priceStub.listen(0, '127.0.0.1', r));
  priceStub.unref();
  priceUrl = `http://127.0.0.1:${priceStub.address().port}/prices`;
});

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

async function bootServer(extraEnv) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-a16-'));
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
    if (/^(CCBILL_|CRYPTO_|OPENAI_|TWILIO_|VAPID_|WEBAUTHN_|AV_|AGECHECKER_)/.test(k)) delete env[k];
  }
  Object.assign(env, extraEnv);
  const child = spawn(process.execPath, ['server.js'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
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

async function closeServer(srv) {
  if (srv.child.exitCode === null) srv.child.kill('SIGKILL');
  fs.rmSync(srv.dir, { recursive: true, force: true });
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

async function signupFan(base, username, ip) {
  const r = await req(base, 'POST', '/api/auth/signup', {
    body: { username, password: 'fan-pass-123', role: 'fan', display_name: username, dob: '1995-05-05', agree18: true },
    headers: ip ? { 'x-forwarded-for': ip } : {},
  });
  assert.equal(r.status, 200, `signup ${username}: ${r.text.slice(0, 300)}`);
  assert.ok(r.json && r.json.token, 'signup returns a bearer token');
  return r.json.token;
}

const avStart = (base, token, ip, method) => req(base, 'POST', '/api/av/start', {
  token, body: { method }, headers: ip ? { 'x-forwarded-for': ip } : {},
});
const checkout = (base, token, ip) => req(base, 'POST', '/api/ccbill/checkout', {
  token, body: { package_id: 'p25' }, headers: ip ? { 'x-forwarded-for': ip } : {},
});
const invoice = (base, token, ip) => req(base, 'POST', '/api/crypto/invoices', {
  token, body: { package_id: 'p25', coin: 'USDT' }, headers: ip ? { 'x-forwarded-for': ip } : {},
});

function signAc(raw) {
  return crypto.createHmac('sha1', AC_SECRET).update(raw, 'utf8').digest('base64');
}

async function putAcWebhook(base, payloadObj, { signature } = {}) {
  const bodyRaw = JSON.stringify(payloadObj);
  const headers = { 'content-type': 'application/json' };
  if (signature !== null) headers['x-agechecker-signature'] = signature !== undefined ? signature : signAc(bodyRaw);
  const r = await fetch(base + '/api/av/webhook', { method: 'PUT', headers, body: bodyRaw });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not json */ }
  return { status: r.status, json, text };
}

const AC_BOOT_ENV = () => ({
  AV_PROVIDER: 'agechecker',
  AGECHECKER_API_KEY: AC_KEY,
  AGECHECKER_SECRET: AC_SECRET,
  AGECHECKER_API_BASE: acBase,
});

test('A16 live: first purchase triggers ONCE per tier; signup/browse never call; webhook PUT finalizes', { timeout: 240000 }, async (t) => {
  acCalls = [];
  const srv = await bootServer({
    ...CCBILL_FAKE,
    CRYPTO_USDT_ADDRESS: FIXED_USDT, CRYPTO_PRICE_URL: priceUrl,
    ...AC_BOOT_ENV(),
  });
  t.after(() => closeServer(srv));
  const base = srv.base;
  const createCalls = () => acCalls.filter((c) => c.path === '/v1/create');
  const idCalls = () => acCalls.filter((c) => c.path === '/v1/id-verify');

  /* --- US fan (Texas): data-check route --- */
  const us = await signupFan(base, 'a16usfan', TX_IP);
  assert.equal(acCalls.length, 0, 'signup made no provider call');
  let st = await req(base, 'GET', '/api/av/status', { token: us });
  assert.equal(st.json.enabled, true);
  assert.equal(st.json.provider, 'agechecker');
  assert.equal(st.json.verified, false);
  const browse = await req(base, 'GET', '/api/models', {});
  assert.equal(browse.status, 200, 'browse works');
  assert.equal(acCalls.length, 0, 'browse/status made no provider call');

  let r = await checkout(base, us, TX_IP);
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'av_required');
  assert.equal(r.json.method, 'transactional', 'US card buyer is told the data-check method');
  assert.equal(r.json.country, 'US');
  assert.equal(acCalls.length, 0, 'the gate itself calls nobody — verification starts when the fan starts it');

  r = await avStart(base, us, TX_IP, 'transactional');
  assert.equal(r.status, 200, r.text.slice(0, 200));
  assert.equal(r.json.stub, false);
  assert.equal(r.json.session_ref, 'boot-create-1');
  assert.equal(r.json.redirect_url, 'https://verify.agechecker.net/s/boot-create-1');
  assert.equal(createCalls().length, 1);
  assert.deepEqual(createCalls()[0].body, { key: AC_KEY });
  assert.equal(createCalls()[0].secretHeader, AC_SECRET);
  assert.equal(idCalls().length, 0);

  // Still gated until a verified result lands.
  r = await checkout(base, us, TX_IP);
  assert.equal(r.status, 403, 'starting a check is not passing it');

  // The webhook is a PUT and the signature is load-bearing.
  const bad = await putAcWebhook(base, { uuid: 'boot-create-1', status: 'accepted' }, { signature: 'bogus' });
  assert.equal(bad.status, 401);
  assert.equal(bad.json.error, 'bad_signature');
  st = await req(base, 'GET', '/api/av/status', { token: us });
  assert.equal(st.json.verified, false, 'a bad-signature webhook changed nothing');

  const good = await putAcWebhook(base, { uuid: 'boot-create-1', status: 'accepted' });
  assert.equal(good.status, 200);
  assert.equal(good.json.handled, 'verified');
  st = await req(base, 'GET', '/api/av/status', { token: us });
  assert.equal(st.json.verified, true);
  assert.equal(st.json.method, 'transactional');

  // Verify-once cache: purchases flow, provider untouched.
  r = await checkout(base, us, TX_IP);
  assert.equal(r.status, 200);
  assert.ok(String(r.json.url).includes('flexforms'), 'real checkout URL issued after verification');
  assert.equal(acCalls.length, 1, 'second purchase made ZERO provider calls');

  /* --- GB fan: straight to the ID scan, on both rails --- */
  const gb = await signupFan(base, 'a16gbfan', GB_IP);
  r = await checkout(base, gb, GB_IP);
  assert.equal(r.status, 403);
  assert.equal(r.json.method, 'id', 'GB card buyer is routed to the ID check');
  assert.equal(r.json.country, 'GB');
  r = await invoice(base, gb, GB_IP);
  assert.equal(r.status, 403);
  assert.equal(r.json.method, 'id', 'GB crypto buyer is gated the same way');
  assert.equal(acCalls.length, 1, 'gating made no provider calls');

  // Even a client asking for the transactional method gets the ID
  // route: the country tiering in the adapter decides.
  r = await avStart(base, gb, GB_IP, 'transactional');
  assert.equal(r.status, 200, r.text.slice(0, 200));
  assert.equal(r.json.method, 'id');
  assert.equal(r.json.session_ref, 'boot-id-1');
  assert.equal(idCalls().length, 1);
  assert.equal(createCalls().length, 1, '/v1/create was never called for the GB fan');

  const gbHook = await putAcWebhook(base, { uuid: 'boot-id-1', status: 'accepted' });
  assert.equal(gbHook.json.handled, 'verified');
  r = await checkout(base, gb, GB_IP);
  assert.equal(r.status, 200, 'GB fan buys after the ID check');
  assert.equal(acCalls.length, 2, 'no further provider calls');

  /* --- FR fan: gate-level spot check of a second ID country --- */
  const fr = await signupFan(base, 'a16frfan', FR_IP);
  r = await checkout(base, fr, FR_IP);
  assert.equal(r.status, 403);
  assert.equal(r.json.method, 'id');
  assert.equal(r.json.country, 'FR');

  /* --- ES fan: non-strict — no gate, no calls, attestation path --- */
  const es = await signupFan(base, 'a16esfan', ES_IP);
  r = await checkout(base, es, ES_IP);
  assert.equal(r.status, 200, 'non-strict country buys immediately, exactly as today');
  assert.ok(String(r.json.url).includes('flexforms'));
  r = await invoice(base, es, ES_IP);
  assert.equal(r.status, 201, 'crypto path unchanged for non-strict countries');
  st = await req(base, 'GET', '/api/av/status', { token: es });
  assert.equal(st.json.verified, false, 'no verification was recorded or needed');
  assert.equal(acCalls.length, 2, 'the ES fan never touched the provider');
});

test('A16 live dormant: AV_PROVIDER=agechecker without AGECHECKER_* keys behaves exactly as today', { timeout: 240000 }, async (t) => {
  acCalls = [];
  const srv = await bootServer({
    ...CCBILL_FAKE,
    AV_PROVIDER: 'agechecker',
    AGECHECKER_API_BASE: acBase, // pointed at the stub, but no credentials
  });
  t.after(() => closeServer(srv));
  const base = srv.base;
  const tok = await signupFan(base, 'a16sleepy', TX_IP);
  const st = await req(base, 'GET', '/api/av/status', { token: tok });
  assert.equal(st.json.enabled, false, 'no AGECHECKER_* keys: the rail is dormant');
  assert.equal(st.json.provider, 'agechecker');
  assert.equal(st.json.verified, false);
  const r = await checkout(base, tok, TX_IP);
  assert.equal(r.status, 200, 'a Texas fan buys with NO gate while the provider is unconfigured');
  assert.ok(String(r.json.url).includes('flexforms'));
  const start = await req(base, 'POST', '/api/av/start', { token: tok, body: { method: 'transactional' } });
  assert.equal(start.status, 503);
  assert.equal(start.json.error, 'av_not_configured');
  assert.equal(acCalls.length, 0, 'dormant means zero provider HTTP, even with a base URL set');
});

/* ---------------- Part C: source pins ---------------- */

test('source pins: confined to lib/av.js + server.js wiring; fraud-risk never wired', () => {
  const avSrc = fs.readFileSync(path.join(REPO, 'lib', 'av.js'), 'utf8');
  const srvSrc = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
  assert.ok(avSrc.includes("'/v1/create'") || avSrc.includes('"/v1/create"'));
  assert.ok(avSrc.includes('/v1/id-verify'));
  assert.ok(avSrc.includes('/v1/status/'));
  assert.ok(!avSrc.includes("'/v1/fraud-risk'") && !avSrc.includes('"/v1/fraud-risk"'),
    '/v1/fraud-risk is a paid add-on: out of v1 scope, never called');
  assert.ok(srvSrc.includes("app.put('/api/av/webhook'"), 'AgeChecker delivers by PUT on the same callback path');
  assert.ok(srvSrc.includes('x-agechecker-signature'));
  assert.ok(srvSrc.includes('agecheckerGateDecision'), 'the purchase gate consults the country tiering');
  // The dormant stub pins from tests/av-gate.test.js still hold.
  assert.ok(srvSrc.includes("avPurchaseGate(req, 'transactional')"));
  assert.ok(srvSrc.includes("avPurchaseGate(req, 'id')"));
});
