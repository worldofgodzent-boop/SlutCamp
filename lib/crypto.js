'use strict';
/* ------------------------------------------------------------------ */
/* SlutCamp crypto wallet loads (v1) — WATCH-ONLY architecture.        */
/*                                                                     */
/* SECURITY POSTURE (non-negotiable, per spec Oct 13, 2026):           */
/* this server holds ONLY extended PUBLIC keys (xpub/zpub) and public  */
/* addresses. There are NO private keys and NO seed phrases anywhere   */
/* in this codebase or on this server. Funds can only be moved OUT by  */
/* the wallet owner from his own wallet app.                           */
/*                                                                     */
/* Flow: fan picks a credit package + coin (BTC / USDT-ERC20) -> the   */
/* service quotes the crypto amount at spot and derives a FRESH        */
/* deposit address from the xpub for that invoice -> a watcher polls   */
/* public chain APIs -> after 1 confirmation the fan wallet is         */
/* credited through the same ledger path as every other credit grant.  */
/*                                                                     */
/* Crediting rules (Corry, Oct 13):                                    */
/*  - confirmed received >= 98% of quote  -> credit the FULL package   */
/*  - confirmed received in (0, 98%) when the window closes -> credit  */
/*    proportional credits, invoice closes as 'credited_partial'       */
/*  - overpayment -> package credited; excess recorded on the invoice  */
/*  - nothing received at expiry -> 'expired'; seen-but-unconfirmed    */
/*    at expiry -> 'underpaid' (admin reviews in the Treasury card)    */
/*                                                                     */
/* Env (all optional; chain/price bases are configurable so tests can  */
/* point at stubs):                                                    */
/*   CRYPTO_BTC_XPUB        account xpub/zpub for BTC (BIP84 derive    */
/*                          m/0/i receive addresses). Unset -> PUBLIC  */
/*                          TEST VECTOR placeholder (see below).       */
/*   CRYPTO_USDT_XPUB       account xpub for USDT (ETH, derive m/0/i).  */
/*   CRYPTO_USDT_ADDRESS    fixed USDT deposit address (fallback when  */
/*                          no USDT xpub is configured).               */
/*   CRYPTO_BTC_API_BASE    esplora-style base (default mempool.space) */
/*   CRYPTO_ETH_API_BASE    etherscan-style base (default etherscan)   */
/*   CRYPTO_ETHERSCAN_KEY   optional API key for the ETH endpoint      */
/*   CRYPTO_PRICE_URL       price feed (CoinGecko shape)               */
/*   CRYPTO_PRICE_FALLBACK_BASE  Coinbase spot base for fallback       */
/*   CRYPTO_INVOICE_TTL_MIN invoice window in minutes (default 30)     */
/*   CRYPTO_POLL_MS         watcher interval (default 60000)           */
/*   CRYPTO_REQUIRED_CONFS  confirmations needed (default 1)           */
/* ------------------------------------------------------------------ */

const { HDKey } = require('@scure/bip32');
const { p2wpkh } = require('@scure/btc-signer');
const { secp256k1 } = require('@noble/curves/secp256k1.js');
const { keccak_256 } = require('@noble/hashes/sha3.js');
const { bytesToHex } = require('@noble/hashes/utils.js');
const QRCode = require('qrcode');

/* PUBLIC TEST VECTOR (BIP84 spec example zpub). Used ONLY when no real
   xpub is configured, so dev/test can run end to end. The matching
   private keys are published in the BIP — NEVER send real funds to
   addresses derived from it. Boot logs a loud warning when in use. */
const TEST_XPUB = 'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';

const USDT_CONTRACT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const REQUIRED_CONFS = Math.max(1, parseInt(process.env.CRYPTO_REQUIRED_CONFS || '1', 10) || 1);
const TTL_MIN = Math.max(1, parseInt(process.env.CRYPTO_INVOICE_TTL_MIN || '30', 10) || 30);
const POLL_MS = Math.max(1000, parseInt(process.env.CRYPTO_POLL_MS || '60000', 10) || 60000);
const FULL_TOLERANCE = 0.98; // >=98% of quote confirmed -> full package

const COINS = {
  BTC: { decimals: 8, symbol: 'BTC' },
  USDT: { decimals: 6, symbol: 'USDT' },
};

/* ---------------- small helpers ---------------- */

const fmtUnits = (units, decimals) => {
  const neg = units < 0;
  const s = String(Math.abs(Math.trunc(units))).padStart(decimals + 1, '0');
  const int = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return (neg ? '-' : '') + int + (frac ? '.' + frac : '');
};

const sqlTs = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
const parseTs = (ts) => new Date(String(ts).replace(' ', 'T') + 'Z').getTime();

async function fetchJson(url, ms = 12000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error('http_' + r.status);
    return await r.json();
  } finally { clearTimeout(timer); }
}

/* ---------------- HD derivation (watch-only) ---------------- */

function parseXpub(str) {
  let versions;
  if (str.startsWith('zpub')) versions = { public: 0x04b24746, private: 0x04b2430c };
  else if (str.startsWith('vpub')) versions = { public: 0x045f1cf6, private: 0x045f18bc };
  else if (str.startsWith('tpub')) versions = { public: 0x043587cf, private: 0x04358394 };
  const testnet = str.startsWith('tpub') || str.startsWith('vpub');
  return { hd: HDKey.fromExtendedKey(str, versions), testnet };
}

function ethAddressFromPubkey(pubBytes) {
  const unc = secp256k1.Point.fromHex(bytesToHex(pubBytes)).toBytes(false); // 65B, 0x04 prefix
  const lower = bytesToHex(keccak_256(unc.slice(1)).slice(-20));
  const hashHex = bytesToHex(keccak_256(new TextEncoder().encode(lower)));
  let out = '0x';
  for (let i = 0; i < 40; i++) out += parseInt(hashHex[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  return out; // EIP-55 checksummed
}

/* ---------------- spot prices ---------------- */

let priceCache = { at: 0, prices: null };
async function fetchSpotPrices() {
  if (priceCache.prices && Date.now() - priceCache.at < 30000) return priceCache.prices;
  const primary = process.env.CRYPTO_PRICE_URL
    || 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,tether&vs_currencies=usd';
  try {
    const j = await fetchJson(primary);
    const btc = j && j.bitcoin && Number(j.bitcoin.usd);
    const usdt = j && j.tether && Number(j.tether.usd);
    if (btc > 0 && usdt > 0) {
      priceCache = { at: Date.now(), prices: { BTC: btc, USDT: usdt } };
      return priceCache.prices;
    }
    throw new Error('bad_price_shape');
  } catch (e) {
    // Fallback: Coinbase spot (two calls). Configurable base for tests.
    try {
      const base = (process.env.CRYPTO_PRICE_FALLBACK_BASE || 'https://api.coinbase.com/v2/prices').replace(/\/$/, '');
      const [b, u] = await Promise.all([
        fetchJson(`${base}/BTC-USD/spot`),
        fetchJson(`${base}/USDT-USD/spot`),
      ]);
      const btc = b && b.data && Number(b.data.amount);
      const usdt = u && u.data && Number(u.data.amount);
      if (btc > 0 && usdt > 0) {
        priceCache = { at: Date.now(), prices: { BTC: btc, USDT: usdt } };
        return priceCache.prices;
      }
    } catch (e2) { /* fall through to rate_unavailable */ }
    const err = new Error('rate_unavailable'); err.code = 'rate_unavailable'; throw err;
  }
}

/* ---------------- chain watchers (public APIs) ---------------- */

async function fetchBtcReceipts(address) {
  const base = (process.env.CRYPTO_BTC_API_BASE || 'https://mempool.space/api').replace(/\/$/, '');
  const [txs, tip] = await Promise.all([
    fetchJson(`${base}/address/${address}/txs`),
    fetchJson(`${base}/blocks/tip/height`),
  ]);
  const tipH = Number(tip);
  const out = [];
  for (const tx of Array.isArray(txs) ? txs : []) {
    let units = 0;
    for (const o of tx.vout || []) if (o.scriptpubkey_address === address) units += Number(o.value) || 0;
    if (units <= 0) continue;
    const conf = tx.status && tx.status.confirmed && Number.isFinite(tipH)
      ? Math.max(1, tipH - Number(tx.status.block_height) + 1) : 0;
    out.push({ txid: tx.txid, units, confirmations: conf });
  }
  return out;
}

async function fetchUsdtReceipts(address) {
  const base = (process.env.CRYPTO_ETH_API_BASE || 'https://api.etherscan.io/api').replace(/\/$/, '');
  const key = process.env.CRYPTO_ETHERSCAN_KEY ? `&apikey=${encodeURIComponent(process.env.CRYPTO_ETHERSCAN_KEY)}` : '';
  const url = `${base}?module=account&action=tokentx&contractaddress=${USDT_CONTRACT}`
    + `&address=${address}&page=1&offset=100&sort=asc${key}`;
  const j = await fetchJson(url);
  const rows = j && Array.isArray(j.result) ? j.result : [];
  const out = [];
  for (const r of rows) {
    if (String(r.to || '').toLowerCase() !== address.toLowerCase()) continue;
    let units = 0;
    try { units = Number(BigInt(r.value)); } catch (e) { units = 0; }
    if (!(units > 0)) continue;
    out.push({ txid: r.hash, units, confirmations: parseInt(r.confirmations || '0', 10) || 0 });
  }
  return out;
}

/* ---------------- the service ---------------- */

function createCryptoService({ db, txn, notifyUser, packages }) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS crypto_invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    package_id TEXT NOT NULL,
    package_usd_cents INTEGER NOT NULL,
    coin TEXT NOT NULL,
    amount_crypto TEXT NOT NULL,
    amount_units INTEGER NOT NULL,
    rate_usd REAL NOT NULL,
    address TEXT NOT NULL,
    address_index INTEGER NOT NULL DEFAULT 0,
    address_placeholder INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    txid TEXT,
    txids TEXT,
    received_amount TEXT NOT NULL DEFAULT '0',
    received_units INTEGER NOT NULL DEFAULT 0,
    confirmations INTEGER NOT NULL DEFAULT 0,
    excess_units INTEGER NOT NULL DEFAULT 0,
    credited_cents INTEGER NOT NULL DEFAULT 0,
    credited_via TEXT,
    credited_by INTEGER,
    swept_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    credited_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_crypto_inv_status ON crypto_invoices(status, id);
  CREATE INDEX IF NOT EXISTS idx_crypto_inv_user ON crypto_invoices(user_id, id);
  CREATE TABLE IF NOT EXISTS crypto_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  );`);

  /* ----- key material (public only) ----- */
  let btcKey = null, usdtKey = null;
  try {
    btcKey = { ...parseXpub(process.env.CRYPTO_BTC_XPUB || TEST_XPUB), placeholder: !process.env.CRYPTO_BTC_XPUB };
  } catch (e) { console.error('crypto: bad CRYPTO_BTC_XPUB —', e.message); }
  try {
    if (process.env.CRYPTO_USDT_XPUB) usdtKey = { ...parseXpub(process.env.CRYPTO_USDT_XPUB), placeholder: false };
    else if (!process.env.CRYPTO_USDT_ADDRESS) usdtKey = { ...parseXpub(TEST_XPUB), placeholder: true };
  } catch (e) { console.error('crypto: bad CRYPTO_USDT_XPUB —', e.message); }
  if ((btcKey && btcKey.placeholder) || (usdtKey && usdtKey.placeholder)) {
    console.warn('⚠️  crypto: NO real xpub configured — invoices derive from the PUBLIC BIP84 TEST VECTOR. '
      + 'Set CRYPTO_BTC_XPUB / CRYPTO_USDT_XPUB (or CRYPTO_USDT_ADDRESS) before accepting real payments.');
  }

  function addressFor(coin, index) {
    if (coin === 'BTC') {
      if (!btcKey) { const e = new Error('coin_not_configured'); e.code = 'coin_not_configured'; throw e; }
      const child = btcKey.hd.deriveChild(0).deriveChild(index);
      return { address: p2wpkh(child.publicKey, btcKey.testnet ? 'testnet' : undefined).address,
               placeholder: btcKey.placeholder ? 1 : 0 };
    }
    // USDT
    if (usdtKey) {
      const child = usdtKey.hd.deriveChild(0).deriveChild(index);
      return { address: ethAddressFromPubkey(child.publicKey), placeholder: usdtKey.placeholder ? 1 : 0 };
    }
    if (process.env.CRYPTO_USDT_ADDRESS) {
      // Fixed-address fallback (no per-invoice derivation for USDT).
      return { address: process.env.CRYPTO_USDT_ADDRESS, placeholder: 0 };
    }
    const e = new Error('coin_not_configured'); e.code = 'coin_not_configured'; throw e;
  }

  function paymentUri(inv) {
    if (inv.coin === 'BTC') return `bitcoin:${inv.address}?amount=${inv.amount_crypto}`;
    return `ethereum:${USDT_CONTRACT}/transfer?address=${inv.address}&uint256=${inv.amount_units}`;
  }

  async function publicInvoice(inv, withQr) {
    const out = {
      id: inv.id, coin: inv.coin, package_id: inv.package_id,
      package_usd_cents: inv.package_usd_cents,
      amount_crypto: inv.amount_crypto, amount_units: inv.amount_units,
      rate_usd: inv.rate_usd, address: inv.address,
      address_placeholder: !!inv.address_placeholder,
      status: inv.status, txid: inv.txid,
      received_crypto: inv.received_amount, received_units: inv.received_units,
      confirmations: inv.confirmations, required_confirmations: REQUIRED_CONFS,
      credited_cents: inv.credited_cents,
      created_at: inv.created_at, expires_at: inv.expires_at, credited_at: inv.credited_at,
      seconds_left: Math.max(0, Math.round((parseTs(inv.expires_at) - Date.now()) / 1000)),
      payment_uri: paymentUri(inv),
    };
    if (withQr) {
      try { out.qr_svg = await QRCode.toString(out.payment_uri, { type: 'svg', margin: 1, width: 232 }); }
      catch (e) { out.qr_svg = null; }
    }
    return out;
  }

  /* ----- settings (sweep helper) ----- */
  function getSettings() {
    const rows = db.prepare('SELECT key, value FROM crypto_settings').all();
    const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    return {
      sweep_btc_address: m.sweep_btc_address || '',
      sweep_usdt_address: m.sweep_usdt_address || '',
      sweep_threshold_usd: Number(m.sweep_threshold_usd) > 0 ? Number(m.sweep_threshold_usd) : 200,
      exchange: 'Coinbase',
    };
  }
  function saveSettings(patch) {
    const put = db.prepare(`INSERT INTO crypto_settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
    txn(() => {
      if (typeof patch.sweep_btc_address === 'string') put.run('sweep_btc_address', patch.sweep_btc_address.trim().slice(0, 120));
      if (typeof patch.sweep_usdt_address === 'string') put.run('sweep_usdt_address', patch.sweep_usdt_address.trim().slice(0, 120));
      if (patch.sweep_threshold_usd !== undefined) {
        const n = Number(patch.sweep_threshold_usd);
        if (Number.isFinite(n) && n >= 0 && n <= 1000000) put.run('sweep_threshold_usd', String(Math.round(n)));
      }
    });
    return getSettings();
  }

  /* ----- invoice creation ----- */
  async function createInvoice(userId, pkg, coin) {
    if (!COINS[coin]) { const e = new Error('bad_coin'); e.code = 'bad_coin'; throw e; }
    const prices = await fetchSpotPrices(); // throws rate_unavailable
    const spot = prices[coin];
    if (!(spot > 0)) { const e = new Error('rate_unavailable'); e.code = 'rate_unavailable'; throw e; }
    const dec = COINS[coin].decimals;
    const raw = (pkg.price_cents / 100 / spot) * Math.pow(10, dec);
    const units = Math.ceil(raw - 1e-6); // round UP to the smallest unit (fan paying the exact quote always covers it)
    let row;
    txn(() => {
      const maxIdx = db.prepare('SELECT COALESCE(MAX(address_index), -1) AS m FROM crypto_invoices WHERE coin = ?').get(coin).m;
      const index = maxIdx + 1;
      const { address, placeholder } = addressFor(coin, index);
      const info = db.prepare(`INSERT INTO crypto_invoices
        (user_id, package_id, package_usd_cents, coin, amount_crypto, amount_units, rate_usd,
         address, address_index, address_placeholder, status, expires_at)
        VALUES (?,?,?,?,?,?,?,?,?,?, 'pending', ?)`)
        .run(userId, pkg.id, pkg.price_cents, coin, fmtUnits(units, dec), units, spot,
             address, index, placeholder, sqlTs(new Date(Date.now() + TTL_MIN * 60000)));
      row = db.prepare('SELECT * FROM crypto_invoices WHERE id = ?').get(Number(info.lastInsertRowid));
    });
    return publicInvoice(row, true);
  }

  /* ----- THE crediting path (watcher + admin override share it) -----
     Exactly-once: the status flip is conditional inside the same DB
     transaction as the wallet update + ledger row, so a second caller
     (double poll, admin racing the watcher) can never credit twice. */
  function creditInvoice(inv, { cents, via, adminId = null, partial = false }) {
    let credited = false;
    txn(() => {
      const upd = db.prepare(`UPDATE crypto_invoices
        SET status = ?, credited_cents = ?, credited_at = datetime('now'), credited_via = ?, credited_by = ?
        WHERE id = ? AND status NOT IN ('credited', 'credited_partial')`)
        .run(partial ? 'credited_partial' : 'credited', cents, via, adminId, inv.id);
      if (!upd.changes) return;
      db.prepare('UPDATE wallets SET credits_cents = credits_cents + ? WHERE user_id = ?').run(cents, inv.user_id);
      db.prepare(`INSERT INTO transactions (fan_id, type, gross_cents, note)
                  VALUES (?, 'crypto_load', ?, ?)`)
        .run(inv.user_id, cents,
          `Crypto load · ${inv.coin} · invoice #${inv.id}${inv.txid ? ' · tx ' + inv.txid : ''}${partial ? ' · partial (underpaid)' : ''}`);
      credited = true;
    });
    if (credited && notifyUser) {
      try {
        notifyUser(inv.user_id, 'wallet', '🪙 Crypto load credited',
          partial ? `Part of your ${inv.coin} payment arrived — $${(cents / 100).toFixed(2)} in credits was added to your wallet.`
                  : `Your ${inv.coin} payment confirmed — $${(cents / 100).toFixed(2)} in credits was added to your wallet.`,
          null);
      } catch (e) { /* bell is a bonus */ }
    }
    return credited;
  }

  function markCreditedAdmin(id, adminId) {
    const inv = db.prepare('SELECT * FROM crypto_invoices WHERE id = ?').get(id);
    if (!inv) return { error: 'not_found' };
    if (inv.status === 'credited' || inv.status === 'credited_partial') return { error: 'already_credited' };
    // Manual override credits the FULL package value (admin's judgment call).
    const ok = creditInvoice(inv, { cents: inv.package_usd_cents, via: 'manual', adminId });
    console.log(`crypto: admin #${adminId} manually marked invoice #${id} credited (${inv.coin}, $${(inv.package_usd_cents / 100).toFixed(2)})`);
    return ok ? { ok: true } : { error: 'already_credited' };
  }

  /* ----- watcher ----- */
  async function pollInvoice(inv) {
    const receipts = inv.coin === 'BTC' ? await fetchBtcReceipts(inv.address) : await fetchUsdtReceipts(inv.address);
    const dec = COINS[inv.coin].decimals;
    let total = 0, confirmed = 0, maxConf = 0;
    const txids = [];
    for (const r of receipts) {
      total += r.units;
      if (r.confirmations >= REQUIRED_CONFS) confirmed += r.units;
      if (r.units > 0 && r.confirmations > maxConf) maxConf = r.confirmations;
      if (!txids.includes(r.txid)) txids.push(r.txid);
    }
    const expired = Date.now() > parseTs(inv.expires_at);
    db.prepare(`UPDATE crypto_invoices SET received_units = ?, received_amount = ?, confirmations = ?,
                txid = ?, txids = ? WHERE id = ?`)
      .run(total, fmtUnits(total, dec), maxConf, txids[0] || null, JSON.stringify(txids), inv.id);
    const fresh = { ...inv, received_units: total, txid: txids[0] || inv.txid };

    if (confirmed * 100 >= Math.round(inv.amount_units * FULL_TOLERANCE * 100)) {
      // >= 98% confirmed -> FULL package (absorbs fee-shaving). Record any excess.
      if (confirmed > inv.amount_units) {
        db.prepare('UPDATE crypto_invoices SET excess_units = ? WHERE id = ?').run(confirmed - inv.amount_units, inv.id);
      }
      creditInvoice(fresh, { cents: inv.package_usd_cents, via: 'watcher' });
      return;
    }
    if (expired) {
      if (confirmed > 0) {
        const cents = Math.floor(inv.package_usd_cents * confirmed / inv.amount_units);
        if (cents >= 1) { creditInvoice(fresh, { cents, via: 'watcher', partial: true }); return; }
        db.prepare(`UPDATE crypto_invoices SET status = 'underpaid' WHERE id = ? AND status IN ('pending','confirming')`).run(inv.id);
      } else if (total > 0) {
        db.prepare(`UPDATE crypto_invoices SET status = 'underpaid' WHERE id = ? AND status IN ('pending','confirming')`).run(inv.id);
      } else {
        db.prepare(`UPDATE crypto_invoices SET status = 'expired' WHERE id = ? AND status IN ('pending','confirming')`).run(inv.id);
      }
      return;
    }
    db.prepare(`UPDATE crypto_invoices SET status = ? WHERE id = ? AND status IN ('pending','confirming')`)
      .run(total > 0 ? 'confirming' : 'pending', inv.id);
  }

  let polling = false;
  async function pollOnce() {
    if (polling) return;
    polling = true;
    try {
      const open = db.prepare(`SELECT * FROM crypto_invoices WHERE status IN ('pending','confirming') ORDER BY id ASC LIMIT 100`).all();
      for (const inv of open) {
        try { await pollInvoice(inv); }
        catch (e) { console.error(`crypto: poll invoice #${inv.id} failed —`, e.message); }
      }
    } finally { polling = false; }
  }

  /* ----- treasury (admin sweep view) ----- */
  async function treasury() {
    const settings = getSettings();
    let prices = null;
    try { prices = await fetchSpotPrices(); } catch (e) { /* fall back to credited USD */ }
    const coins = [];
    for (const coin of Object.keys(COINS)) {
      const rows = db.prepare(`SELECT * FROM crypto_invoices
        WHERE coin = ? AND status IN ('credited','credited_partial') AND swept_at IS NULL`).all(coin);
      const units = rows.reduce((s, r) => s + (r.received_units || 0), 0);
      const spot = prices ? prices[coin] : null;
      const usdCents = spot ? Math.round(units / Math.pow(10, COINS[coin].decimals) * spot * 100)
                            : rows.reduce((s, r) => s + (r.credited_cents || 0), 0);
      coins.push({
        coin, count: rows.length, units,
        amount_crypto: fmtUnits(units, COINS[coin].decimals),
        usd_cents: usdCents, spot_usd: spot,
        placeholder: coin === 'BTC' ? !!(btcKey && btcKey.placeholder) : !!(usdtKey && usdtKey.placeholder),
        worth_sweeping: usdCents >= Math.round(settings.sweep_threshold_usd * 100),
      });
    }
    return { coins, settings };
  }

  function sweep(coin) {
    if (!COINS[coin]) return { error: 'bad_coin' };
    const info = db.prepare(`UPDATE crypto_invoices SET swept_at = datetime('now')
      WHERE coin = ? AND status IN ('credited','credited_partial') AND swept_at IS NULL`).run(coin);
    return { ok: true, swept: info.changes };
  }

  function start() {
    setInterval(() => { pollOnce().catch((e) => console.error('crypto: poll failed —', e.message)); }, POLL_MS);
    setTimeout(() => { pollOnce().catch(() => {}); }, 5000);
    console.log(`₿ crypto watcher on (poll ${POLL_MS}ms · ${REQUIRED_CONFS} conf · TTL ${TTL_MIN}m)`);
  }

  return {
    COINS, REQUIRED_CONFS, TTL_MIN,
    createInvoice, publicInvoice, creditInvoice, markCreditedAdmin,
    pollOnce, start, treasury, sweep, getSettings, saveSettings,
    fetchSpotPrices,
    getInvoice: (id) => db.prepare('SELECT * FROM crypto_invoices WHERE id = ?').get(id),
    listUserInvoices: (userId, limit = 20) => db.prepare(
      'SELECT * FROM crypto_invoices WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(userId, limit),
    listAllInvoices: (limit = 200) => db.prepare(`
      SELECT ci.*, u.username AS fan_username, u.display_name AS fan_name
      FROM crypto_invoices ci JOIN users u ON u.id = ci.user_id
      ORDER BY ci.id DESC LIMIT ?`).all(limit),
  };
}

module.exports = { createCryptoService, fmtUnits };
