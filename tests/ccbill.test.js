'use strict';
/*
 * Unit tests for lib/ccbill.js — CCBill FlexForms checkout + webhook
 * crediting, exercised against an in-memory SQLite DB with FAKE env
 * credentials (dummy values invented for these tests only).
 *
 * Money-safety behaviors under test (the whole point of the module):
 *  - credits are issued only from the server-to-server webhook path,
 *  - exactly once per order (duplicate success posts are no-ops),
 *  - an amount mismatch or bad response digest parks the order in
 *    'review' and credits NOTHING,
 *  - checkout refuses amounts outside the approved band.
 *
 * No network is touched: createCheckout only builds a URL string and
 * handleEvent only reads/writes the local test DB.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const ccbill = require('../lib/ccbill.js');

const FAKE = {
  CCBILL_ACCNUM: '900000001',
  CCBILL_SUBACC: '0001',
  CCBILL_FLEXFORM_ID: 'fake-flexform-id',
  CCBILL_SALT: 'fake-salt-for-tests-only',
};
const ENV_KEYS = [...Object.keys(FAKE), 'CCBILL_MAX_CENTS'];

function setFakeEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, FAKE);
}
function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

function txnOf(db) {
  return (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); db.exec('COMMIT'); return r; }
    catch (e) { try { db.exec('ROLLBACK'); } catch (_) { /* already rolled back */ } throw e; }
  };
}

/* Minimal stand-ins for the tables server.js owns; the service creates
 * its own ccbill_orders table. Mirrors exactly the columns lib/ccbill.js
 * reads/writes (wallets.credits_cents, transactions.fan_id/type/gross_cents/note). */
function makeService() {
  setFakeEnv();
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY);
    CREATE TABLE wallets (user_id INTEGER PRIMARY KEY, credits_cents INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE transactions (fan_id INTEGER, type TEXT, gross_cents INTEGER, note TEXT);
    INSERT INTO users (id) VALUES (1);
    INSERT INTO wallets (user_id, credits_cents) VALUES (1, 0);
  `);
  const notes = [];
  const svc = ccbill.createCcbillService({
    db, txn: txnOf(db), notifyUser: (...a) => notes.push(a),
  });
  return { db, svc, notes };
}

const md5hex = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');
const balance = (db) => db.prepare('SELECT credits_cents FROM wallets WHERE user_id = 1').get().credits_cents;
const orderByToken = (db, token) => db.prepare('SELECT * FROM ccbill_orders WHERE token = ?').get(token);

test('configured() is false when any of the four env keys is missing', () => {
  clearEnv();
  assert.equal(ccbill.configured(), false);
  setFakeEnv();
  assert.equal(ccbill.configured(), true);
  for (const k of Object.keys(FAKE)) {
    setFakeEnv();
    delete process.env[k];
    assert.equal(ccbill.configured(), false, `missing ${k} must mean not configured`);
  }
  clearEnv();
});

test('MIN_CENTS is the CCBill $2.95 floor', () => {
  assert.equal(ccbill.MIN_CENTS, 295);
});

test('createCheckout refuses to run when not configured', () => {
  // Fresh DB, but env cleared AFTER service creation: cfg() reads env live.
  const { svc } = makeService();
  clearEnv();
  assert.throws(() => svc.createCheckout(1, 2500, 'p25'), /not_configured/);
});

test('formDigest is MD5 of price + period + currency 840 + salt, no separators', () => {
  const { svc } = makeService();
  const expected = md5hex('25.00' + '30' + '840' + FAKE.CCBILL_SALT);
  assert.equal(svc.formDigest('25.00', 30), expected);
  assert.notEqual(svc.formDigest('25.00', 30), svc.formDigest('50.00', 30));
});

test('createCheckout rejects amounts outside the band and non-integers', () => {
  const { svc } = makeService();
  assert.throws(() => svc.createCheckout(1, 294, 'custom'), /bad_amount/);   // below $2.95
  assert.throws(() => svc.createCheckout(1, 10001, 'custom'), /bad_amount/); // above default $100 cap
  assert.throws(() => svc.createCheckout(1, 2500.5, 'custom'), /bad_amount/); // fractional cents
  assert.throws(() => svc.createCheckout(1, -100, 'custom'), /bad_amount/);
});

test('CCBILL_MAX_CENTS raises the cap when set to a valid value', () => {
  const { svc } = makeService();
  process.env.CCBILL_MAX_CENTS = '50000';
  assert.equal(svc.maxCents(), 50000);
  const { token } = svc.createCheckout(1, 20000, 'custom');
  assert.match(token, /^[a-f0-9]{32}$/);
  delete process.env.CCBILL_MAX_CENTS;
  assert.equal(svc.maxCents(), 10000);
});

test('createCheckout returns a signed FlexForms URL and a pending order', () => {
  const { db, svc } = makeService();
  const { url, token } = svc.createCheckout(1, 2500, 'p25');
  assert.match(token, /^[a-f0-9]{32}$/);
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, 'https://api.ccbill.com/wap-frontflex/flexforms/' + FAKE.CCBILL_FLEXFORM_ID);
  assert.equal(u.searchParams.get('clientAccnum'), FAKE.CCBILL_ACCNUM);
  assert.equal(u.searchParams.get('clientSubacc'), FAKE.CCBILL_SUBACC);
  assert.equal(u.searchParams.get('initialPrice'), '25.00');
  assert.equal(u.searchParams.get('initialPeriod'), '30');
  assert.equal(u.searchParams.get('currencyCode'), '840');
  assert.equal(u.searchParams.get('order_id'), token);
  assert.equal(u.searchParams.get('formDigest'), md5hex('25.00' + '30' + '840' + FAKE.CCBILL_SALT));
  const row = orderByToken(db, token);
  assert.equal(row.status, 'pending');
  assert.equal(row.amount_cents, 2500);
  assert.equal(row.package_id, 'p25');
});

function successPayload(token, over = {}) {
  const subscriptionId = 'sub_fake_123';
  return {
    eventType: 'NewSaleSuccess',
    order_id: token,
    subscriptionId,
    transactionId: 'txn_fake_1',
    billedAmount: '25.00',
    responseDigest: md5hex(subscriptionId + '1' + FAKE.CCBILL_SALT),
    ...over,
  };
}

test('webhook success credits the wallet exactly once; a duplicate post is a no-op', () => {
  const { db, svc, notes } = makeService();
  const { token } = svc.createCheckout(1, 2500, 'p25');
  const r1 = svc.handleEvent(successPayload(token));
  assert.equal(r1.handled, 'credited');
  assert.equal(balance(db), 2500);
  assert.equal(orderByToken(db, token).status, 'credited');
  assert.equal(notes.length, 1, 'fan should get exactly one credit notification');

  const r2 = svc.handleEvent(successPayload(token));
  assert.equal(r2.handled, 'duplicate');
  assert.equal(balance(db), 2500, 'duplicate webhook must NOT credit twice');
  const ledger = db.prepare("SELECT COUNT(*) AS c FROM transactions WHERE type = 'ccbill_load'").get().c;
  assert.equal(ledger, 1);
});

test('amount mismatch parks the order in review and credits nothing', () => {
  const { db, svc } = makeService();
  const { token } = svc.createCheckout(1, 2500, 'p25');
  const r = svc.handleEvent(successPayload(token, { billedAmount: '10.00' }));
  assert.equal(r.handled, 'review_amount');
  assert.equal(balance(db), 0);
  assert.equal(orderByToken(db, token).status, 'review');
});

test('bad response digest parks the order in review and credits nothing', () => {
  const { db, svc } = makeService();
  const { token } = svc.createCheckout(1, 2500, 'p25');
  const r = svc.handleEvent(successPayload(token, { responseDigest: 'deadbeef'.repeat(4) }));
  assert.equal(r.handled, 'review_digest');
  assert.equal(balance(db), 0);
  assert.equal(orderByToken(db, token).status, 'review');
});

test('NewSaleFailure marks a pending order failed and credits nothing', () => {
  const { db, svc } = makeService();
  const { token } = svc.createCheckout(1, 2500, 'p25');
  const r = svc.handleEvent({ eventType: 'NewSaleFailure', order_id: token });
  assert.equal(r.handled, 'failure');
  assert.equal(balance(db), 0);
  assert.equal(orderByToken(db, token).status, 'failed');
});

test('success post for an unknown token is ignored', () => {
  const { db, svc } = makeService();
  const r = svc.handleEvent(successPayload('f'.repeat(32)));
  assert.equal(r.handled, 'ignored');
  assert.equal(balance(db), 0);
});

test('admin can release a review-held order exactly once', () => {
  const { db, svc } = makeService();
  const { token } = svc.createCheckout(1, 2500, 'p25');
  svc.handleEvent(successPayload(token, { billedAmount: '10.00' })); // -> review
  const order = orderByToken(db, token);
  assert.deepEqual(svc.markCreditedAdmin(order.id, 99), { ok: true });
  assert.equal(balance(db), 2500);
  assert.deepEqual(svc.markCreditedAdmin(order.id, 99), { error: 'already_credited' });
  assert.equal(balance(db), 2500);
  assert.deepEqual(svc.markCreditedAdmin(424242, 99), { error: 'not_found' });
});
