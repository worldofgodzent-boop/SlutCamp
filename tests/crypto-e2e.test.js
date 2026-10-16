'use strict';
/*
 * End-to-end tests for crypto wallet loads (lib/crypto.js + server routes).
 *
 * Everything runs on THROWAWAY material: the receiving keys are the
 * published BIP39 "abandon … about" test vectors (NEVER a production
 * wallet), and every price/chain API is a local stub server — no live
 * chain is ever queried and no real funds move.
 *
 * Part A (in-process service):
 *   - invoice creation for every coin: address format + freshness,
 *     quoted amount math, 30-minute expiry, SOL amount-offset keying,
 *     XRP destination-tag keying, fixed-address mode (production shape).
 *   - watcher crediting for BTC / USDT / SOL / XRP via stub receipts,
 *     EXACTLY ONCE (re-poll + admin mark after watcher credit cannot
 *     double-credit; one wallet bump, one ledger row).
 *   - REGRESSION: in fixed-address mode a transfer that PREDATES an
 *     invoice must not credit it (receipts are window-scoped), while a
 *     fresh transfer still credits exactly once. Covers USDT + ETH.
 *
 * Part B (real server over HTTP, temp-copy boot like the smoke suite):
 *   - /api/crypto/config offers only configured coins (XRP refused),
 *   - a fan creates invoices over HTTP (QR issued, amounts match),
 *   - admin mark-credited credits the fan exactly once (second call
 *     409s, balance and ledger unchanged).
 *
 * Part D (per-invoice USDT — the xpub production mode):
 *   - derivation proven against a published BIP44 vector (Hardhat
 *     test-mnemonic account, addresses #0/#1/#2),
 *   - ONE index sequence per key family: interleaved/concurrent
 *     USDT+ETH creation never reuses an index or address, and the
 *     sequence survives restarts (persisted counter),
 *   - the watcher credits only the invoice whose derived address was
 *     paid (other indexes and the old fixed address are ignored),
 *   - precedence + config-error safety: a valid xpub beats the fixed
 *     address; a malformed or private-material xpub disables the
 *     coin instead of silently falling back,
 *   - the admin invoice list surfaces each invoice's derived address.
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

/* ---- throwaway test wallet material (published test vectors) ---- */
const TEST_BTC_XPUB = 'xpub6CatWdiZiodmUeTDp8LT5or8nmbKNcuyvz7WyksVFkKB4RHwCD3XyuvPEbvqAQY3rAPshWcMLoP2fMFMKHPJ4ZeZXYVUhLv1VMrjPC7PW6V';
const TEST_ETH_XPUB = 'xpub6DCoCpSuQZB2jawqnGMEPS63ePKWkwWPH4TU45Q7LPXWuNd8TMtVxRrgjtEshuqpK3mdhaWHPFsBngh5GFZaM6si3yZdUsT8ddYM3PwnATt';
const BTC_ADDR_0 = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'; // abandon-mnemonic m/84'/0'/0'/0/0
const BTC_ADDR_1 = 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g'; // .../0/1
/* Ethereum BIP44 receive addresses (external chain m/0/i) of the same
   abandon test account whose xpub is TEST_ETH_XPUB (m/44'/60'/0'). */
const ABANDON_ADDR = [
  '0x9858EfFD232B4033E47d90003D41EC34EcaEda94', // index 0
  '0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0', // index 1
  '0xb6716976A3ebe8D39aCEB04372f22Ff8e6802D7A', // index 2
  '0xF3f50213C1d2e255e4B2bAD430F8A38EEF8D718E', // index 3
  '0x51cA8ff9f1C0a99f88E86B8112eA3237F55374cA', // index 4
  '0xA40cFBFc8534FFC84E20a7d8bBC3729B26a35F6f', // index 5
];
/* Independent published vector: the account xpub of the Hardhat /
   Foundry default test mnemonic ("test test … junk") at m/44'/60'/0',
   and its first three receive addresses (Hardhat accounts #0/#1/#2 —
   reproduced by every Ethereum dev toolchain). */
const HARDHAT_XPUB = 'xpub6Ce9NcJvTk36xtLSrJLZqE7wtgA5deCeYs7rSQtreh4cj6ByPtrg9sD7V2FNFLPnf8heNP3FGkeV9qwfzvZNSd54JoNXVsXFYSYwHsnJxqP';
const HARDHAT_ADDR = [
  '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', // index 0
  '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', // index 1
  '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC', // index 2
];
const SOL_ADDR = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // throwaway string fixture
const XRP_ADDR = 'rEb8TK3gBgk5auZkwc6sHnwrGVJH8DuaLh';          // throwaway string fixture
const FIXED_ETH_ADDR = '0x000000000000000000000000000000000000dEaD';
const PRICES = { bitcoin: { usd: 50000 }, tether: { usd: 1 }, ethereum: { usd: 2500 }, solana: { usd: 100 }, ripple: { usd: 0.5 } };
const PKG25 = { id: 'p25', price_cents: 2500 };
const PKG10 = { id: 'p10', price_cents: 1000 };

/* ---- stub price + chain APIs (mutable state, driven by tests) ---- */
const chain = {
  btcTxs: {},      // address -> esplora-style tx array
  usdtRows: [],    // etherscan tokentx rows
  ethRows: [],     // etherscan txlist rows
  solDelta: null,  // lamport delta the stub reports for the SOL address
  xrpTx: null,     // { tag, units } the stub reports on account_tx
};
function resetChain() {
  chain.btcTxs = {}; chain.usdtRows = []; chain.ethRows = [];
  chain.solDelta = null; chain.xrpTx = null;
}
let stub = null;
let stubBase = null;

function startStub() {
  stub = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://stub');
    res.setHeader('content-type', 'application/json');
    if (u.pathname === '/prices') return res.end(JSON.stringify(PRICES));
    if (u.pathname.startsWith('/btc/address/')) {
      const addr = decodeURIComponent(u.pathname.split('/')[3]);
      return res.end(JSON.stringify(chain.btcTxs[addr] || []));
    }
    if (u.pathname === '/btc/blocks/tip/height') return res.end('100');
    if (u.pathname === '/eth') {
      const action = u.searchParams.get('action');
      if (action === 'tokentx') return res.end(JSON.stringify({ status: '1', result: chain.usdtRows }));
      if (action === 'txlist') return res.end(JSON.stringify({ status: '1', result: chain.ethRows }));
      return res.end(JSON.stringify({ status: '1', result: [] }));
    }
    if (u.pathname === '/sol' || u.pathname === '/xrp') {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        let j = {};
        try { j = JSON.parse(body || '{}'); } catch (e) { /* empty */ }
        if (u.pathname === '/sol') {
          if (j.method === 'getSignaturesForAddress') {
            const out = chain.solDelta == null ? [] : [{
              signature: 'soltx1', blockTime: Math.floor(Date.now() / 1000),
              confirmationStatus: 'finalized', err: null,
            }];
            return res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: out }));
          }
          if (j.method === 'getTransaction') {
            const post = 1000000000 + (chain.solDelta || 0);
            return res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {
              transaction: { message: { accountKeys: [SOL_ADDR] } },
              meta: { err: null, preBalances: [1000000000], postBalances: [post] },
            } }));
          }
          return res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }));
        }
        const txs = chain.xrpTx ? [{
          validated: true, meta: { TransactionResult: 'tesSUCCESS' },
          tx: { Destination: XRP_ADDR, DestinationTag: chain.xrpTx.tag,
                Amount: String(chain.xrpTx.units), hash: 'xrptx1' },
        }] : [];
        return res.end(JSON.stringify({ result: { transactions: txs } }));
      });
      return;
    }
    res.end('{}');
  });
  return new Promise((resolve) => stub.listen(0, '127.0.0.1', () => {
    stubBase = `http://127.0.0.1:${stub.address().port}`;
    resolve();
  }));
}

/* ---- service factory (Part A) ---- */
function txnOf(db) {
  return (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); db.exec('COMMIT'); return r; }
    catch (e) { try { db.exec('ROLLBACK'); } catch (_) { /* noop */ } throw e; }
  };
}
function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY);
    CREATE TABLE wallets (user_id INTEGER PRIMARY KEY, credits_cents INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE transactions (fan_id INTEGER, type TEXT, gross_cents INTEGER, note TEXT);
    INSERT INTO users (id) VALUES (1);
    INSERT INTO wallets (user_id, credits_cents) VALUES (1, 0);
  `);
  return db;
}
let svcA = null;   // xpub mode (BTC + USDT/ETH derived)
let dbA = null;
let svcB = null;   // fixed-address mode (production shape for USDT/ETH)
let dbB = null;

test.before(async () => {
  await startStub();
  // Watchers + prices all read API bases at call time: point them at the stub.
  process.env.CRYPTO_PRICE_URL = `${stubBase}/prices`;
  process.env.CRYPTO_BTC_API_BASE = `${stubBase}/btc`;
  process.env.CRYPTO_ETH_API_BASE = `${stubBase}/eth`;
  process.env.CRYPTO_SOL_RPC = `${stubBase}/sol`;
  process.env.CRYPTO_XRPL_API = `${stubBase}/xrp`;
  // Receiving config for svcA (read at service creation).
  process.env.CRYPTO_BTC_XPUB = TEST_BTC_XPUB;
  process.env.CRYPTO_USDT_XPUB = TEST_ETH_XPUB;
  process.env.CRYPTO_SOL_ADDRESS = SOL_ADDR;
  process.env.CRYPTO_XRP_ADDRESS = XRP_ADDR;
  delete process.env.CRYPTO_USDT_ADDRESS;
  delete process.env.CRYPTO_ETH_XPUB;
  delete process.env.CRYPTO_ETH_ADDRESS;
  const { createCryptoService } = require('../lib/crypto.js');
  dbA = makeDb();
  svcA = createCryptoService({ db: dbA, txn: txnOf(dbA), notifyUser: () => {}, packages: [] });
  // svcB: production shape — no USDT/ETH xpub, one fixed address.
  delete process.env.CRYPTO_USDT_XPUB;
  process.env.CRYPTO_USDT_ADDRESS = FIXED_ETH_ADDR;
  dbB = makeDb();
  svcB = createCryptoService({ db: dbB, txn: txnOf(dbB), notifyUser: () => {}, packages: [] });
});
test.after(() => { if (stub) stub.close(); });

const walletOf = (db) => db.prepare('SELECT credits_cents FROM wallets WHERE user_id = 1').get().credits_cents;
const ledgerRows = (db) => db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE type = 'crypto_load'").get().n;

/* ---------------- Part A: invoice creation ---------------- */

test('A1: invoices per coin — formats, freshness, quote math, expiry', async () => {
  // BTC: fresh BIP84 address per invoice (the published test vectors).
  const b1 = await svcA.createInvoice(1, PKG25, 'BTC');
  const b2 = await svcA.createInvoice(1, PKG25, 'BTC');
  assert.equal(b1.address, BTC_ADDR_0);
  assert.equal(b2.address, BTC_ADDR_1);
  assert.match(b1.address, /^bc1q[0-9a-z]{38}$/);
  assert.equal(b1.amount_units, 50000);           // $25 @ $50,000/BTC
  assert.equal(b1.amount_crypto, '0.0005');
  assert.equal(b1.status, 'pending');
  assert.ok(b1.seconds_left > 1700 && b1.seconds_left <= 1800, `TTL ~30min, got ${b1.seconds_left}`);
  assert.ok(typeof b1.qr_svg === 'string' && b1.qr_svg.includes('<svg'), 'QR issued with the invoice');

  // USDT (xpub mode): fresh EIP-55 address per invoice, derived from
  // the abandon test-vector account at family indexes 0 and 1.
  const u1 = await svcA.createInvoice(1, PKG25, 'USDT');
  const u2 = await svcA.createInvoice(1, PKG25, 'USDT');
  assert.match(u1.address, /^0x[0-9a-fA-F]{40}$/);
  assert.notEqual(u1.address, u2.address);
  assert.equal(u1.address, ABANDON_ADDR[0]);
  assert.equal(u2.address, ABANDON_ADDR[1]);
  assert.equal(u1.amount_units, 25000000);        // $25 @ $1
  assert.equal(u1.amount_crypto, '25');

  // ETH rides the SAME Ethereum account as USDT, so both coins draw
  // derivation indexes from ONE family sequence: this ETH invoice gets
  // the NEXT index (2) — never a reused one. (Pre-fix, per-coin
  // sequences gave it index 0 and u1's exact address: two open invoices
  // sharing one deposit address.)
  const e1 = await svcA.createInvoice(1, PKG25, 'ETH');
  assert.equal(e1.address, ABANDON_ADDR[2]);
  assert.equal(svcA.getInvoice(u1.id).address_index, 0);
  assert.equal(svcA.getInvoice(u2.id).address_index, 1);
  assert.equal(svcA.getInvoice(e1.id).address_index, 2);
  assert.equal(e1.amount_units, 10000000);        // $25 @ $2,500 = 0.01 ETH in gwei units
  assert.equal(e1.amount_crypto, '0.01');

  // SOL: shared address; the exact amount (base + unique offset) is the key.
  const s1 = await svcA.createInvoice(1, PKG25, 'SOL');
  const s2 = await svcA.createInvoice(1, PKG25, 'SOL');
  assert.equal(s1.address, SOL_ADDR);
  assert.equal(s1.shared_address, true);
  const off1 = s1.amount_units - 250000000;
  assert.ok(off1 >= 10000 && off1 <= 99999, `SOL offset in range, got ${off1}`);
  assert.notEqual(s1.amount_units, s2.amount_units, 'open SOL invoices never share an amount');

  // XRP: shared address + destination tag = 100000 + invoice id.
  const x1 = await svcA.createInvoice(1, PKG10, 'XRP');
  assert.equal(x1.address, XRP_ADDR);
  assert.equal(x1.dest_tag, 100000 + x1.id);
  assert.equal(x1.amount_units, 20000000);        // $10 @ $0.50
});

test('A2: fixed-address mode (production shape) — USDT + ETH receive at the configured address', async () => {
  assert.equal(svcB.isPlaceholder('USDT'), false);
  assert.equal(svcB.isPlaceholder('ETH'), false);
  const u = await svcB.createInvoice(1, PKG25, 'USDT');
  const e = await svcB.createInvoice(1, PKG25, 'ETH');
  assert.equal(u.address, FIXED_ETH_ADDR);
  assert.equal(e.address, FIXED_ETH_ADDR);
});

/* ---------------- Part A: watcher crediting, exactly once ---------------- */

test('A3: BTC watcher credits a confirmed payment exactly once', async () => {
  resetChain();
  const inv = await svcA.createInvoice(1, PKG25, 'BTC');
  chain.btcTxs[inv.address] = [{
    txid: 'btctx1',
    vout: [{ scriptpubkey_address: inv.address, value: inv.amount_units }],
    status: { confirmed: true, block_height: 100 },
  }];
  const before = walletOf(dbA);
  await svcA.pollOnce();
  assert.equal(svcA.getInvoice(inv.id).status, 'credited');
  assert.equal(walletOf(dbA), before + 2500);
  assert.equal(ledgerRows(dbA), 1);
  // Replay: another poll + an admin mark must NOT credit again.
  await svcA.pollOnce();
  assert.deepEqual(svcA.markCreditedAdmin(inv.id, 99), { error: 'already_credited' });
  assert.equal(svcA.creditInvoice(svcA.getInvoice(inv.id), { cents: 2500, via: 'watcher' }), false);
  assert.equal(walletOf(dbA), before + 2500);
  assert.equal(ledgerRows(dbA), 1);
});

test('A4: SOL watcher matches by exact amount; XRP by destination tag', async () => {
  resetChain();
  const s = await svcA.createInvoice(1, PKG25, 'SOL');
  const beforeS = walletOf(dbA);
  await svcA.pollOnce(); // no payment reported yet
  assert.equal(svcA.getInvoice(s.id).status, 'pending');
  chain.solDelta = s.amount_units; // exact total arrives, finalized
  await svcA.pollOnce();
  assert.equal(svcA.getInvoice(s.id).status, 'credited');
  assert.equal(walletOf(dbA), beforeS + 2500);

  resetChain();
  const x = await svcA.createInvoice(1, PKG10, 'XRP');
  const beforeX = walletOf(dbA);
  chain.xrpTx = { tag: x.dest_tag, units: x.amount_units };
  await svcA.pollOnce();
  assert.equal(svcA.getInvoice(x.id).status, 'credited');
  assert.equal(walletOf(dbA), beforeX + 1000);
});

test('A5: REGRESSION — fixed-address receipts are window-scoped (old payments cannot credit new invoices)', async () => {
  // Own service instance: A2's still-open invoices on svcB must not be
  // able to absorb this test's stub receipts.
  const { createCryptoService } = require('../lib/crypto.js');
  const dbC = makeDb();
  const svcC = createCryptoService({ db: dbC, txn: txnOf(dbC), notifyUser: () => {}, packages: [] });
  const nowSec = Math.floor(Date.now() / 1000);
  const oldSec = nowSec - 2 * 24 * 3600;
  resetChain();
  // The shared address received plenty BEFORE these invoices existed.
  const u = await svcC.createInvoice(1, PKG25, 'USDT');
  const e = await svcC.createInvoice(1, PKG25, 'ETH');
  chain.usdtRows = [{ hash: '0xold', to: FIXED_ETH_ADDR, value: String(u.amount_units), confirmations: '900', timeStamp: String(oldSec) }];
  chain.ethRows = [{ hash: '0xoldeth', to: FIXED_ETH_ADDR, value: String(e.amount_units * 1000000000), confirmations: '900', timeStamp: String(oldSec), isError: '0' }];
  await svcC.pollOnce();
  assert.equal(svcC.getInvoice(u.id).status, 'pending', 'old USDT transfer must not credit a new invoice');
  assert.equal(svcC.getInvoice(e.id).status, 'pending', 'old ETH transfer must not credit a new invoice');
  assert.equal(walletOf(dbC), 0);
  assert.equal(ledgerRows(dbC), 0);
  // A FRESH transfer inside the window credits — exactly once.
  chain.usdtRows.push({ hash: '0xfresh', to: FIXED_ETH_ADDR, value: String(u.amount_units), confirmations: '20', timeStamp: String(nowSec) });
  await svcC.pollOnce();
  assert.equal(svcC.getInvoice(u.id).status, 'credited');
  assert.equal(walletOf(dbC), 2500);
  await svcC.pollOnce();
  assert.equal(walletOf(dbC), 2500);
  assert.equal(ledgerRows(dbC), 1);
});

/* ---------------- Phase 2: fan-UX pins + watcher-fix pins ---------------- */

test('C: pay screen names the network in plain words and warns against wrong-network sends', () => {
  const src = fs.readFileSync(path.join(REPO, 'public/js/app.js'), 'utf8');
  // Plain-words network per coin; USDT is Ethereum (ERC-20) in this app.
  assert.ok(src.includes('CRYPTO_NETWORKS'), 'network map exists');
  assert.ok(src.includes("USDT: 'Ethereum (ERC-20)'"), 'USDT network named as Ethereum (ERC-20)');
  for (const coin of ['BTC', 'ETH', 'SOL', 'XRP']) {
    assert.ok(new RegExp(`${coin}:\\s*'[^']+'`).test(src.split('CRYPTO_NETWORKS')[1].slice(0, 200)), `${coin} has a plain-words network`);
  }
  // The pay screen shows the network AND the warning, for every coin.
  const render = src.slice(src.indexOf('function renderCryptoInvoice'), src.indexOf('function watchCryptoInvoice'));
  assert.ok(render.includes("t('crypto_on_network'"), 'pay screen names the network');
  assert.ok(render.includes("t('crypto_warn_network'"), 'pay screen warns against wrong-network sends');
  // Warning text exists in all three locales.
  assert.ok((src.match(/crypto_warn_network:/g) || []).length >= 3, 'warn string in EN/ES/PT');
  assert.ok((src.match(/crypto_on_network:/g) || []).length >= 3, 'network string in EN/ES/PT');
  // The good bones stay: server QR, one-tap copy, live status polling,
  // automatic return to the wallet once credited.
  assert.ok(render.includes('inv.qr_svg'), 'pay screen renders the server QR');
  assert.ok(render.includes('ci-copy'), 'pay screen keeps the copy button');
  const watch = src.slice(src.indexOf('function watchCryptoInvoice'), src.indexOf('async function startCryptoInvoice'));
  assert.ok(watch.includes('8000'), 'status polling stays live while the screen is open');
  assert.ok(watch.includes("show('wallet'"), 'credited state returns the fan to their wallet');
});

test('C2: watcher fix pins — ETH-family receipts are window-scoped and newest-first', () => {
  const src = fs.readFileSync(path.join(REPO, 'lib/crypto.js'), 'utf8');
  assert.ok(src.includes('function inInvoiceWindow'), 'window helper exists');
  assert.ok(src.includes('fetchUsdtReceipts(inv)'), 'USDT fetcher is invoice-scoped');
  assert.ok(src.includes('fetchEthReceipts(inv)'), 'ETH fetcher is invoice-scoped');
  assert.ok((src.match(/sort=desc/g) || []).length >= 2, 'etherscan queries return newest first');
});

/* ---------------- Part D: per-invoice USDT (xpub mode) ----------------
   The production upgrade path: setting CRYPTO_USDT_XPUB switches
   USDT/ETH from ONE fixed shared address to a fresh derived address
   per invoice. Covered: BIP44 derivation against a published test
   vector, family-wide index allocation (concurrency + restart),
   per-invoice watcher scoping, xpub-over-fixed precedence, and the
   config-error state (a set-but-unusable xpub disables the coin —
   it never silently falls back). */

/* Build a service with an exact receiving-config env, restored after
   creation (the service reads receiving config at creation; the price
   + chain stub bases stay global from test.before). */
const RECEIVING_KEYS = ['CRYPTO_BTC_XPUB', 'CRYPTO_USDT_XPUB', 'CRYPTO_USDT_ADDRESS',
  'CRYPTO_ETH_XPUB', 'CRYPTO_ETH_ADDRESS', 'CRYPTO_SOL_ADDRESS', 'CRYPTO_XRP_ADDRESS'];
function makeSvc(envPatch) {
  const db = makeDb();
  const { createCryptoService } = require('../lib/crypto.js');
  const saved = {};
  for (const k of RECEIVING_KEYS) {
    saved[k] = process.env[k];
    if (envPatch[k] == null) delete process.env[k]; else process.env[k] = envPatch[k];
  }
  try {
    return { svc: createCryptoService({ db, txn: txnOf(db), notifyUser: () => {}, packages: [] }), db };
  } finally {
    for (const k of RECEIVING_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

test('D1: derivation matches the published BIP44 vector (Hardhat accounts #0/#1/#2)', async () => {
  const { svc } = makeSvc({ CRYPTO_USDT_XPUB: HARDHAT_XPUB, CRYPTO_BTC_XPUB: TEST_BTC_XPUB, CRYPTO_SOL_ADDRESS: SOL_ADDR, CRYPTO_XRP_ADDRESS: XRP_ADDR });
  assert.equal(svc.isPlaceholder('USDT'), false);
  assert.equal(svc.isPlaceholder('ETH'), false);
  // Interleaved USDT/ETH creation walks the shared family sequence:
  // the derived address at each step is exactly the published vector.
  const a = await svc.createInvoice(1, PKG25, 'USDT');
  const b = await svc.createInvoice(1, PKG25, 'ETH');
  const c = await svc.createInvoice(1, PKG25, 'USDT');
  assert.equal(a.address, HARDHAT_ADDR[0]);
  assert.equal(b.address, HARDHAT_ADDR[1]);
  assert.equal(c.address, HARDHAT_ADDR[2]);
  assert.equal(svc.getInvoice(a.id).address_index, 0);
  assert.equal(svc.getInvoice(b.id).address_index, 1);
  assert.equal(svc.getInvoice(c.id).address_index, 2);
});

test('D2: concurrent USDT+ETH creation never reuses an index or address', async () => {
  const { svc } = makeSvc({ CRYPTO_USDT_XPUB: TEST_ETH_XPUB, CRYPTO_BTC_XPUB: TEST_BTC_XPUB, CRYPTO_SOL_ADDRESS: SOL_ADDR, CRYPTO_XRP_ADDRESS: XRP_ADDR });
  const coins = ['USDT', 'ETH', 'USDT', 'ETH', 'USDT', 'ETH'];
  const invs = await Promise.all(coins.map((coin) => svc.createInvoice(1, PKG25, coin)));
  const addrs = invs.map((i) => i.address);
  assert.equal(new Set(addrs).size, 6, 'six open invoices, six distinct deposit addresses');
  assert.deepEqual(new Set(addrs), new Set(ABANDON_ADDR), 'addresses are exactly family indexes 0-5');
  const idxs = invs.map((i) => svc.getInvoice(i.id).address_index).sort((x, y) => x - y);
  assert.deepEqual(idxs, [0, 1, 2, 3, 4, 5]);
});

test('D3: index allocation survives restarts (counter persists in the DB)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-xpub-restart-'));
  const file = path.join(dir, 'inv.db');
  try {
    const open = () => {
      const db = new DatabaseSync(file);
      db.exec(`
        CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS wallets (user_id INTEGER PRIMARY KEY, credits_cents INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS transactions (fan_id INTEGER, type TEXT, gross_cents INTEGER, note TEXT);
        INSERT OR IGNORE INTO users (id) VALUES (1);
        INSERT OR IGNORE INTO wallets (user_id, credits_cents) VALUES (1, 0);
      `);
      return db;
    };
    const env = { CRYPTO_USDT_XPUB: TEST_ETH_XPUB, CRYPTO_BTC_XPUB: TEST_BTC_XPUB, CRYPTO_SOL_ADDRESS: SOL_ADDR, CRYPTO_XRP_ADDRESS: XRP_ADDR };
    const saved = {};
    for (const k of RECEIVING_KEYS) { saved[k] = process.env[k]; if (env[k] == null) delete process.env[k]; else process.env[k] = env[k]; }
    const { createCryptoService } = require('../lib/crypto.js');
    let db = open();
    let svc = createCryptoService({ db, txn: txnOf(db), notifyUser: () => {}, packages: [] });
    const first = await svc.createInvoice(1, PKG25, 'USDT');
    assert.equal(first.address, ABANDON_ADDR[0]);
    db.close();
    // "Restart": a brand-new service on the same database file must
    // continue the family sequence, not restart it at index 0.
    db = open();
    svc = createCryptoService({ db, txn: txnOf(db), notifyUser: () => {}, packages: [] });
    const second = await svc.createInvoice(1, PKG25, 'ETH');
    const third = await svc.createInvoice(1, PKG25, 'USDT');
    assert.equal(second.address, ABANDON_ADDR[1]);
    assert.equal(third.address, ABANDON_ADDR[2]);
    assert.equal(svc.getInvoice(second.id).address_index, 1);
    db.close();
    for (const k of RECEIVING_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('D4: xpub watcher credits only the invoice whose derived address was paid', async () => {
  const { svc, db } = makeSvc({ CRYPTO_USDT_XPUB: TEST_ETH_XPUB, CRYPTO_BTC_XPUB: TEST_BTC_XPUB, CRYPTO_SOL_ADDRESS: SOL_ADDR, CRYPTO_XRP_ADDRESS: XRP_ADDR });
  resetChain();
  const nowSec = Math.floor(Date.now() / 1000);
  const a = await svc.createInvoice(1, PKG25, 'USDT'); // index 0
  const b = await svc.createInvoice(1, PKG25, 'USDT'); // index 1
  const c = await svc.createInvoice(1, PKG25, 'ETH');  // index 2
  assert.equal(a.address, ABANDON_ADDR[0]);
  assert.equal(b.address, ABANDON_ADDR[1]);
  assert.equal(c.address, ABANDON_ADDR[2]);
  // The chain shows: b's USDT amount paid to B's address; a's amount
  // paid to C's address (wrong invoice); a full payment to the old
  // FIXED address (must count for nobody in xpub mode).
  chain.usdtRows = [
    { hash: '0xb', to: b.address, value: String(b.amount_units), confirmations: '20', timeStamp: String(nowSec) },
    { hash: '0xc', to: c.address, value: String(a.amount_units), confirmations: '20', timeStamp: String(nowSec) },
    { hash: '0xfixed', to: FIXED_ETH_ADDR, value: String(a.amount_units), confirmations: '20', timeStamp: String(nowSec) },
  ];
  chain.ethRows = [
    { hash: '0xfixedeth', to: FIXED_ETH_ADDR, value: String(c.amount_units * 1000000000), confirmations: '20', timeStamp: String(nowSec), isError: '0' },
  ];
  await svc.pollOnce();
  assert.equal(svc.getInvoice(b.id).status, 'credited', 'payment to B address credits B');
  assert.equal(svc.getInvoice(a.id).status, 'pending', 'payment to another index never credits A');
  assert.equal(svc.getInvoice(c.id).status, 'pending', 'fixed-address payment is ignored in xpub mode');
  assert.equal(walletOf(db), 2500);
  assert.equal(ledgerRows(db), 1);
  // Now C is paid natively at its own derived address: only C credits.
  chain.ethRows.push({ hash: '0xcpaid', to: c.address, value: String(c.amount_units * 1000000000), confirmations: '20', timeStamp: String(nowSec), isError: '0' });
  await svc.pollOnce();
  assert.equal(svc.getInvoice(c.id).status, 'credited');
  assert.equal(svc.getInvoice(a.id).status, 'pending');
  assert.equal(walletOf(db), 5000);
  assert.equal(ledgerRows(db), 2);
});

test('D5: precedence + config-error safety (xpub wins; a broken xpub disables, never falls back)', async () => {
  // Both set and valid: the xpub wins over the fixed address.
  const both = makeSvc({ CRYPTO_USDT_XPUB: HARDHAT_XPUB, CRYPTO_USDT_ADDRESS: FIXED_ETH_ADDR, CRYPTO_BTC_XPUB: TEST_BTC_XPUB, CRYPTO_SOL_ADDRESS: SOL_ADDR, CRYPTO_XRP_ADDRESS: XRP_ADDR });
  const inv = await both.svc.createInvoice(1, PKG25, 'USDT');
  assert.equal(inv.address, HARDHAT_ADDR[0], 'derived address, not the fixed one');

  // Malformed USDT xpub + fixed address present: USDT and (riding)
  // ETH are disabled — invoices refused, fixed address NOT used.
  const bad = makeSvc({ CRYPTO_USDT_XPUB: 'xpub6BogusChecksum1111111111111111111111111111111111111111', CRYPTO_USDT_ADDRESS: FIXED_ETH_ADDR, CRYPTO_BTC_XPUB: TEST_BTC_XPUB, CRYPTO_SOL_ADDRESS: SOL_ADDR, CRYPTO_XRP_ADDRESS: XRP_ADDR });
  assert.equal(bad.svc.isPlaceholder('USDT'), true);
  assert.equal(bad.svc.isPlaceholder('ETH'), true, 'ETH inherits the broken USDT account state');
  await assert.rejects(() => bad.svc.createInvoice(1, PKG25, 'USDT'), /coin_not_configured/);
  await assert.rejects(() => bad.svc.createInvoice(1, PKG25, 'ETH'), /coin_not_configured/);

  // Malformed DEDICATED ETH xpub: ETH alone is disabled; USDT (valid
  // xpub of its own) keeps working.
  const badEth = makeSvc({ CRYPTO_USDT_XPUB: TEST_ETH_XPUB, CRYPTO_ETH_XPUB: 'xpub6BogusChecksum1111111111111111111111111111111111111111', CRYPTO_BTC_XPUB: TEST_BTC_XPUB, CRYPTO_SOL_ADDRESS: SOL_ADDR, CRYPTO_XRP_ADDRESS: XRP_ADDR });
  assert.equal(badEth.svc.isPlaceholder('ETH'), true);
  assert.equal(badEth.svc.isPlaceholder('USDT'), false);
  await assert.rejects(() => badEth.svc.createInvoice(1, PKG25, 'ETH'), /coin_not_configured/);
  const ok = await badEth.svc.createInvoice(1, PKG25, 'USDT');
  assert.equal(ok.address, ABANDON_ADDR[0]);

  // An extended PRIVATE key pasted as the xpub is refused the same
  // way (watch-only is non-negotiable).
  const nodeCrypto = require('node:crypto');
  const { HDKey } = require('@scure/bip32');
  const seed = nodeCrypto.pbkdf2Sync('test test test test test test test test test test test junk', 'mnemonic', 2048, 64, 'sha512');
  const xprv = HDKey.fromMasterSeed(seed).derive("m/44'/60'/0'").privateExtendedKey;
  const priv = makeSvc({ CRYPTO_USDT_XPUB: xprv, CRYPTO_BTC_XPUB: TEST_BTC_XPUB, CRYPTO_SOL_ADDRESS: SOL_ADDR, CRYPTO_XRP_ADDRESS: XRP_ADDR });
  assert.equal(priv.svc.isPlaceholder('USDT'), true, 'private key material is a config error, not a key');
  await assert.rejects(() => priv.svc.createInvoice(1, PKG25, 'USDT'), /coin_not_configured/);

  // Malformed BTC xpub: BTC is hidden too (previously it was listed
  // as configured while creation threw).
  const badBtc = makeSvc({ CRYPTO_BTC_XPUB: 'xpub6BogusChecksum1111111111111111111111111111111111111111', CRYPTO_USDT_XPUB: TEST_ETH_XPUB, CRYPTO_SOL_ADDRESS: SOL_ADDR, CRYPTO_XRP_ADDRESS: XRP_ADDR });
  assert.equal(badBtc.svc.isPlaceholder('BTC'), true);
  await assert.rejects(() => badBtc.svc.createInvoice(1, PKG25, 'BTC'), /coin_not_configured/);
});

test('D6: admin invoice list surfaces the derived address per invoice', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT);
    CREATE TABLE wallets (user_id INTEGER PRIMARY KEY, credits_cents INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE transactions (fan_id INTEGER, type TEXT, gross_cents INTEGER, note TEXT);
    INSERT INTO users (id, username, display_name) VALUES (1, 'fan1', 'Fan One');
    INSERT INTO wallets (user_id, credits_cents) VALUES (1, 0);
  `);
  const saved = {};
  const env = { CRYPTO_USDT_XPUB: TEST_ETH_XPUB, CRYPTO_BTC_XPUB: TEST_BTC_XPUB, CRYPTO_SOL_ADDRESS: SOL_ADDR, CRYPTO_XRP_ADDRESS: XRP_ADDR };
  for (const k of RECEIVING_KEYS) { saved[k] = process.env[k]; if (env[k] == null) delete process.env[k]; else process.env[k] = env[k]; }
  const { createCryptoService } = require('../lib/crypto.js');
  const svc = createCryptoService({ db, txn: txnOf(db), notifyUser: () => {}, packages: [] });
  for (const k of RECEIVING_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  await svc.createInvoice(1, PKG25, 'USDT');
  await svc.createInvoice(1, PKG25, 'ETH');
  const rows = svc.listAllInvoices(10);
  assert.equal(rows.length, 2);
  const byCoin = Object.fromEntries(rows.map((r) => [r.coin, r]));
  assert.equal(byCoin.USDT.address, ABANDON_ADDR[0], 'Manager list shows the USDT invoice derived address');
  assert.equal(byCoin.ETH.address, ABANDON_ADDR[1], 'Manager list shows the ETH invoice derived address');
  assert.equal(byCoin.USDT.fan_username, 'fan1');
});

/* ---------------- Part B: real server over HTTP ---------------- */

const REPO = path.join(__dirname, '..');
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

test('B: HTTP end-to-end — config, fan invoices, admin mark-credited exactly once', { timeout: 120000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-crypto-e2e-'));
  for (const d of ['server.js', 'package.json', 'lib', 'public', 'data']) {
    fs.cpSync(path.join(REPO, d), path.join(dir, d), { recursive: true });
  }
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  const port = await freePort();
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(CCBILL_|CRYPTO_|OPENAI_|TWILIO_|VAPID_|WEBAUTHN_)/.test(k)) delete env[k];
  }
  Object.assign(env, {
    PORT: String(port), SEED_DEMO: '1', CRYPTO_POLL_MS: '3600000',
    CRYPTO_BTC_XPUB: TEST_BTC_XPUB, CRYPTO_USDT_ADDRESS: FIXED_ETH_ADDR,
    CRYPTO_SOL_ADDRESS: SOL_ADDR, CRYPTO_PRICE_URL: `${stubBase}/prices`,
  });
  const child = spawn(process.execPath, ['server.js'], { cwd: dir, env });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode})\n${log}`);
    try { const r = await fetch(base + '/api/health'); if (r.ok) break; } catch (e) { /* not up */ }
    if (Date.now() > deadline) throw new Error(`server did not come up\n${log}`);
    await new Promise((r) => setTimeout(r, 150));
  }

  // Config: exactly the configured coins are offered; XRP (no address) is not.
  const cfg = await req(base, 'GET', '/api/crypto/config');
  assert.equal(cfg.status, 200);
  assert.deepEqual(cfg.json.coins.map((c) => c.coin), ['USDT', 'BTC', 'ETH', 'SOL']);
  assert.equal(cfg.json.required_confirmations, 1);
  assert.equal(cfg.json.ttl_minutes, 30);

  // Fan signs up and creates invoices over HTTP.
  const s = await req(base, 'POST', '/api/auth/signup', {
    body: { username: 'cryptofan', password: 'fan-pass-123', role: 'fan', display_name: 'Crypto Fan', dob: '1995-05-05', agree18: true },
  });
  assert.equal(s.status, 200, `signup: ${s.text}`);
  const fanToken = s.json.token;

  const btc = await req(base, 'POST', '/api/crypto/invoices', { token: fanToken, body: { package_id: 'p25', coin: 'BTC' } });
  assert.equal(btc.status, 201, `btc invoice: ${btc.text}`);
  assert.equal(btc.json.invoice.address, BTC_ADDR_0);
  assert.equal(btc.json.invoice.amount_crypto, '0.0005');
  assert.ok(btc.json.invoice.qr_svg && btc.json.invoice.qr_svg.includes('<svg'), 'QR svg issued');
  assert.equal(btc.json.invoice.status, 'pending');

  const usdt = await req(base, 'POST', '/api/crypto/invoices', { token: fanToken, body: { package_id: 'p25', coin: 'USDT' } });
  assert.equal(usdt.status, 201, `usdt invoice: ${usdt.text}`);
  assert.equal(usdt.json.invoice.address, FIXED_ETH_ADDR);

  const sol = await req(base, 'POST', '/api/crypto/invoices', { token: fanToken, body: { package_id: 'p25', coin: 'SOL' } });
  assert.equal(sol.status, 201, `sol invoice: ${sol.text}`);
  assert.equal(sol.json.invoice.address, SOL_ADDR);
  assert.ok(sol.json.invoice.amount_units > 250000000, 'SOL amount carries its matching offset');

  const xrp = await req(base, 'POST', '/api/crypto/invoices', { token: fanToken, body: { package_id: 'p25', coin: 'XRP' } });
  assert.equal(xrp.status, 503);
  assert.equal(xrp.json.error, 'coin_not_configured');

  // Admin marks the BTC invoice credited — the fan is credited exactly once.
  const adm = await req(base, 'POST', '/api/manager/login', { body: { username: 'admin', password: 'admin123' } });
  assert.equal(adm.status, 200, `manager login: ${adm.text}`);
  const mgr = { token: adm.json.token, headers: { 'x-manager': '1' } };
  const invId = btc.json.invoice.id;
  const mark = await req(base, 'POST', `/api/admin/crypto-invoices/${invId}/mark-credited`, mgr);
  assert.equal(mark.status, 200, `mark-credited: ${mark.text}`);
  const me = await req(base, 'GET', '/api/me', { token: fanToken });
  assert.equal(me.json.wallet.credits_cents, 2500);
  const after = await req(base, 'GET', `/api/crypto/invoices/${invId}`, { token: fanToken });
  assert.equal(after.json.invoice.status, 'credited');
  assert.equal(after.json.invoice.credited_cents, 2500);

  const mark2 = await req(base, 'POST', `/api/admin/crypto-invoices/${invId}/mark-credited`, mgr);
  assert.equal(mark2.status, 409, 'second mark-credited must conflict');
  const me2 = await req(base, 'GET', '/api/me', { token: fanToken });
  assert.equal(me2.json.wallet.credits_cents, 2500, 'balance unchanged after replay');

  // Ledger: exactly one crypto_load row for this fan, for the full package.
  child.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 300));
  const db = new DatabaseSync(path.join(dir, 'wogent-chat.db'), { readOnly: true });
  try {
    const rows = db.prepare("SELECT gross_cents FROM transactions WHERE type = 'crypto_load'").all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].gross_cents, 2500);
  } finally { db.close(); }
});
