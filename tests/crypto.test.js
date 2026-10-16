'use strict';
/*
 * Unit tests for lib/crypto.js — watch-only crypto loads.
 *
 * Covered WITHOUT any network or real keys:
 *  - fmtUnits(): the integer-units -> display-string conversion every
 *    amount on every invoice goes through.
 *  - Coin table sanity (order, decimals).
 *  - Placeholder safety: with NO receiving config in env, every coin is
 *    a test/placeholder coin and createInvoice() must REFUSE to issue an
 *    invoice (fans must never be sent to a test address). That refusal
 *    happens before any price fetch, so no network is touched.
 *  - publicInvoice() payment-URI shapes per coin (pure formatting).
 *
 * Deliberately NOT covered here: spot-price fetching and chain watchers
 * (they call live public APIs), and crediting from real chain receipts.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

// The suite must see the "nothing configured" state regardless of the
// shell it runs in: strip any real receiving config before the service
// is created (the service reads env at creation time).
for (const k of ['CRYPTO_BTC_XPUB', 'CRYPTO_USDT_XPUB', 'CRYPTO_USDT_ADDRESS',
                 'CRYPTO_ETH_XPUB', 'CRYPTO_ETH_ADDRESS', 'CRYPTO_SOL_ADDRESS',
                 'CRYPTO_XRP_ADDRESS']) delete process.env[k];

const { createCryptoService, fmtUnits } = require('../lib/crypto.js');

test('fmtUnits formats integer units with the coin decimals', () => {
  assert.equal(fmtUnits(0, 8), '0');
  assert.equal(fmtUnits(100000000, 8), '1');          // 1 BTC in sats
  assert.equal(fmtUnits(1500000, 6), '1.5');          // 1.5 USDT
  assert.equal(fmtUnits(1, 6), '0.000001');           // smallest USDT unit
  assert.equal(fmtUnits(123456789, 6), '123.456789');
  assert.equal(fmtUnits(2000000000, 9), '2');         // 2 SOL / ETH-unit
  assert.equal(fmtUnits(-2500000, 6), '-2.5');
  assert.equal(fmtUnits(100500000, 8), '1.005');      // trailing zeros trimmed, inner kept
});

function txnOf(db) {
  return (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); db.exec('COMMIT'); return r; }
    catch (e) { try { db.exec('ROLLBACK'); } catch (_) { /* noop */ } throw e; }
  };
}

function makeService() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY);
    CREATE TABLE wallets (user_id INTEGER PRIMARY KEY, credits_cents INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE transactions (fan_id INTEGER, type TEXT, gross_cents INTEGER, note TEXT);
    INSERT INTO users (id) VALUES (1);
    INSERT INTO wallets (user_id, credits_cents) VALUES (1, 0);
  `);
  return createCryptoService({ db, txn: txnOf(db), notifyUser: () => {}, packages: [] });
}

test('coin table: order and decimals match the accounting units', () => {
  const svc = makeService();
  assert.deepEqual(svc.COIN_ORDER, ['USDT', 'BTC', 'ETH', 'SOL', 'XRP']);
  assert.equal(svc.COINS.USDT.decimals, 6);
  assert.equal(svc.COINS.BTC.decimals, 8);
  assert.equal(svc.COINS.ETH.decimals, 9);
  assert.equal(svc.COINS.SOL.decimals, 9);
  assert.equal(svc.COINS.XRP.decimals, 6);
});

test('with no receiving config, every coin reports as placeholder', () => {
  const svc = makeService();
  for (const coin of svc.COIN_ORDER) {
    assert.equal(svc.isPlaceholder(coin), true, `${coin} should be placeholder with empty env`);
  }
});

test('createInvoice refuses unknown coins and placeholder coins (no network)', async () => {
  const svc = makeService();
  const pkg = { id: 'p10', price_cents: 1000 };
  await assert.rejects(() => svc.createInvoice(1, pkg, 'DOGE'), /bad_coin/);
  for (const coin of ['BTC', 'USDT', 'ETH', 'SOL', 'XRP']) {
    await assert.rejects(() => svc.createInvoice(1, pkg, coin), /coin_not_configured/,
      `${coin} invoice must be refused while it only has a test address`);
  }
});

function fakeInvoice(over = {}) {
  return {
    id: 7, user_id: 1, coin: 'BTC', package_id: 'p10', package_usd_cents: 1000,
    amount_crypto: '0.001', amount_units: 100000, rate_usd: 10000,
    address: 'bc1qexampleaddress', dest_tag: null, address_placeholder: 0,
    status: 'pending', txid: null, received_amount: '0', received_units: 0,
    confirmations: 0, credited_cents: 0,
    created_at: '2026-10-16 10:00:00', expires_at: '2999-01-01 00:00:00', credited_at: null,
    ...over,
  };
}

test('publicInvoice builds per-coin payment URIs', async () => {
  const svc = makeService();

  const btc = await svc.publicInvoice(fakeInvoice(), false);
  assert.equal(btc.payment_uri, 'bitcoin:bc1qexampleaddress?amount=0.001');
  assert.equal(btc.shared_address, false);
  assert.ok(btc.seconds_left > 0);

  const eth = await svc.publicInvoice(fakeInvoice({
    coin: 'ETH', address: '0xabc0000000000000000000000000000000000000',
    amount_crypto: '0.004', amount_units: 4000000,
  }), false);
  // ETH accounting unit is gwei; the URI carries wei = units * 1e9.
  assert.equal(eth.payment_uri,
    'ethereum:0xabc0000000000000000000000000000000000000?value=4000000000000000');

  const xrp = await svc.publicInvoice(fakeInvoice({
    coin: 'XRP', address: 'rExampleAddress', dest_tag: 100007, amount_crypto: '40', amount_units: 40000000,
  }), false);
  assert.equal(xrp.payment_uri, 'rExampleAddress?dt=100007');
  assert.equal(xrp.shared_address, true);
  assert.equal(xrp.dest_tag, 100007);

  const sol = await svc.publicInvoice(fakeInvoice({
    coin: 'SOL', address: 'SolExampleAddress', amount_crypto: '0.07', amount_units: 70000000,
  }), false);
  assert.equal(sol.payment_uri, 'solana:SolExampleAddress?amount=0.07');
  assert.equal(sol.shared_address, true);
});
