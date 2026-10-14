'use strict';
/*
 * lib/ccbill.js — CCBill FlexForms (Dynamic Pricing) card loads.
 *
 * Flow: fan picks a package/custom amount in the wallet → POST /api/ccbill/checkout
 * creates a pending order (random token) and returns a signed FlexForms URL →
 * fan pays on CCBill's hosted form → CCBill's webhook (NewSaleSuccess) posts
 * back with our order_id → we credit the wallet EXACTLY ONCE (status transition
 * pending → credited inside one transaction, mirroring lib/crypto.js).
 *
 * Money safety:
 *  - Credits are issued ONLY from the server-to-server webhook, never from
 *    the fan's browser return (the return page only shows a message).
 *  - The order token is unguessable (128-bit random) and created server-side;
 *    the posted amount must equal the order amount or the order goes to
 *    'review' instead of crediting.
 *  - If CCBill sends a responseDigest and we hold the salt, a mismatch also
 *    routes the order to 'review' (an admin can release it manually).
 *  - Duplicate success posts are no-ops.
 *
 * Config (env; the rail is "configured" only when all four are set):
 *   CCBILL_ACCNUM, CCBILL_SUBACC, CCBILL_FLEXFORM_ID, CCBILL_SALT
 *   CCBILL_MAX_CENTS (optional; CCBill's default per-transaction cap is
 *   $100.00 — raise this only after CCBill approves a higher limit.)
 *
 * Spec notes (CCBill Dynamic Pricing, verified Oct 2026):
 *  - formDigest = hex MD5 of initialPrice + initialPeriod + currencyCode + salt,
 *    concatenated with no separators; price formatted with 2 decimals.
 *  - Prices must sit inside the account's approved band (default $2.95-$100).
 *  - Single (non-recurring) payments use a dedicated subaccount with User
 *    Management OFF; the link carries initialPrice/initialPeriod only.
 *  - Webhooks echo every variable passed into the form (our order_id returns).
 */
const crypto = require('node:crypto');

const FORM_BASE = 'https://api.ccbill.com/wap-frontflex/flexforms/';
const CURRENCY_USD = '840';
const INITIAL_PERIOD_DAYS = 30; // one-time charge modeled as an initial period
const MIN_CENTS = 295;          // CCBill account minimum

function cfg() {
  return {
    accnum: process.env.CCBILL_ACCNUM || '',
    subacc: process.env.CCBILL_SUBACC || '',
    flexformId: process.env.CCBILL_FLEXFORM_ID || '',
    salt: process.env.CCBILL_SALT || '',
    maxCents: (() => {
      const n = parseInt(process.env.CCBILL_MAX_CENTS || '', 10);
      return Number.isInteger(n) && n >= MIN_CENTS && n <= 100000 ? n : 10000;
    })(),
  };
}

function configured() {
  const c = cfg();
  return !!(c.accnum && c.subacc && c.flexformId && c.salt);
}

function md5hex(str) {
  return crypto.createHash('md5').update(str, 'utf8').digest('hex');
}

function createCcbillService({ db, txn, notifyUser }) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS ccbill_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT NOT NULL UNIQUE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    amount_cents INTEGER NOT NULL,
    package_id TEXT NOT NULL DEFAULT 'custom',
    status TEXT NOT NULL DEFAULT 'pending',
    ccbill_subscription_id TEXT,
    ccbill_transaction_id TEXT,
    raw_event TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    credited_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ccbill_orders_user ON ccbill_orders(user_id, status);
  `);

  function formDigest(priceStr, periodDays) {
    const c = cfg();
    return md5hex(`${priceStr}${periodDays}${CURRENCY_USD}${c.salt}`);
  }

  // Create a pending order and the signed FlexForms URL for it.
  function createCheckout(userId, amountCents, packageId) {
    if (!configured()) { const e = new Error('not_configured'); e.code = 'not_configured'; throw e; }
    const c = cfg();
    if (!Number.isInteger(amountCents) || amountCents < MIN_CENTS || amountCents > c.maxCents) {
      const e = new Error('bad_amount'); e.code = 'bad_amount'; throw e;
    }
    const token = crypto.randomBytes(16).toString('hex');
    db.prepare(`INSERT INTO ccbill_orders (token, user_id, amount_cents, package_id)
                VALUES (?,?,?,?)`).run(token, userId, amountCents, packageId || 'custom');
    const price = (amountCents / 100).toFixed(2);
    const q = new URLSearchParams({
      clientAccnum: c.accnum,
      clientSubacc: c.subacc,
      initialPrice: price,
      initialPeriod: String(INITIAL_PERIOD_DAYS),
      currencyCode: CURRENCY_USD,
      formDigest: formDigest(price, INITIAL_PERIOD_DAYS),
      order_id: token,
    });
    return { url: `${FORM_BASE}${encodeURIComponent(c.flexformId)}?${q.toString()}`, token };
  }

  function creditOrder(order, { via, adminId = null, subscriptionId = null, transactionId = null }) {
    let credited = false;
    txn(() => {
      const upd = db.prepare(`UPDATE ccbill_orders
        SET status = 'credited', credited_at = datetime('now'),
            ccbill_subscription_id = COALESCE(?, ccbill_subscription_id),
            ccbill_transaction_id = COALESCE(?, ccbill_transaction_id)
        WHERE id = ? AND status IN ('pending', 'review')`)
        .run(subscriptionId, transactionId, order.id);
      if (!upd.changes) return;
      db.prepare('UPDATE wallets SET credits_cents = credits_cents + ? WHERE user_id = ?')
        .run(order.amount_cents, order.user_id);
      db.prepare(`INSERT INTO transactions (fan_id, type, gross_cents, note)
                  VALUES (?, 'ccbill_load', ?, ?)`)
        .run(order.user_id, order.amount_cents,
          `Card load · CCBill · order #${order.id}${subscriptionId ? ' · sub ' + subscriptionId : ''}${via === 'manual' ? ' · released by admin' : ''}`);
      credited = true;
    });
    if (credited && notifyUser) {
      try {
        notifyUser(order.user_id, 'wallet', '💳 Card load credited',
          `Your card payment confirmed — $${(order.amount_cents / 100).toFixed(2)} in credits was added to your wallet.`, null);
      } catch (e) { /* bell is a bonus */ }
    }
    return credited;
  }

  function parsePostedCents(payload) {
    const raw = payload.billedAmount ?? payload.initialPrice ?? payload.amount ?? payload.price;
    if (raw === undefined || raw === null || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.round(n * 100) : null;
  }

  // Handle one webhook / approval-post payload (already parsed to an object).
  // Always resolves to { httpStatus } 200 for well-formed posts so CCBill
  // stops retrying; crediting decisions are recorded on the order row.
  function handleEvent(payload) {
    const eventType = String(payload.eventType || payload.event_type || '');
    const token = payload.order_id || payload.orderId || null;
    const subscriptionId = payload.subscriptionId || payload.subscription_id || null;
    const transactionId = payload.transactionId || payload.transaction_id || null;
    const raw = JSON.stringify(payload).slice(0, 4000);

    const looksDenied = !eventType && (payload.denyReason || payload.reasonForDenial || payload.denial_id);
    if (eventType === 'NewSaleFailure' || looksDenied) {
      if (token) {
        db.prepare(`UPDATE ccbill_orders SET status = 'failed', raw_event = ?
                    WHERE token = ? AND status = 'pending'`).run(raw, token);
      }
      console.log('ccbill: NewSaleFailure', token || '(no token)');
      return { handled: 'failure' };
    }
    if (eventType && eventType !== 'NewSaleSuccess') {
      // Refunds/chargebacks/voids and everything else: log loudly, never
      // auto-move money. Chargeback handling stays a human decision.
      console.log(`ccbill: event ${eventType} (logged only)`, raw.slice(0, 300));
      return { handled: 'logged' };
    }
    // NewSaleSuccess — or a classic Approval Post, which carries no
    // eventType but does carry our order token + a subscription id.
    if (!token) { console.log('ccbill: success post without order token (ignored)'); return { handled: 'ignored' } }
    const order = db.prepare('SELECT * FROM ccbill_orders WHERE token = ?').get(token);
    if (!order) { console.log('ccbill: success post for unknown token (ignored)'); return { handled: 'ignored' }; }
    if (order.status === 'credited') return { handled: 'duplicate' };

    db.prepare('UPDATE ccbill_orders SET raw_event = ? WHERE id = ?').run(raw, order.id);

    const posted = parsePostedCents(payload);
    if (posted !== null && posted !== order.amount_cents) {
      db.prepare(`UPDATE ccbill_orders SET status = 'review' WHERE id = ? AND status = 'pending'`).run(order.id);
      console.warn(`ccbill: order #${order.id} amount mismatch (posted ${posted}, expected ${order.amount_cents}) — held for review`);
      return { handled: 'review_amount' };
    }
    // Response digest (production posts): MD5(subscriptionId + '1' + salt).
    const digest = payload.responseDigest || payload.response_digest;
    if (digest && subscriptionId && cfg().salt) {
      const expected = md5hex(`${subscriptionId}1${cfg().salt}`);
      if (String(digest).toLowerCase() !== expected) {
        db.prepare(`UPDATE ccbill_orders SET status = 'review' WHERE id = ? AND status = 'pending'`).run(order.id);
        console.warn(`ccbill: order #${order.id} response digest mismatch — held for review`);
        return { handled: 'review_digest' };
      }
    }
    const ok = creditOrder(order, { via: 'webhook', subscriptionId, transactionId });
    console.log(`ccbill: order #${order.id} ${ok ? 'credited' : 'not credited (state ' + order.status + ')'} $${(order.amount_cents / 100).toFixed(2)}`);
    return { handled: ok ? 'credited' : 'noop' };
  }

  function markCreditedAdmin(orderId, adminId) {
    const order = db.prepare('SELECT * FROM ccbill_orders WHERE id = ?').get(orderId);
    if (!order) return { error: 'not_found' };
    if (order.status === 'credited') return { error: 'already_credited' };
    const ok = creditOrder(order, { via: 'manual', adminId });
    console.log(`ccbill: admin #${adminId} manually credited order #${orderId} ($${(order.amount_cents / 100).toFixed(2)})`);
    return ok ? { ok: true } : { error: 'already_credited' };
  }

  return { configured, maxCents: () => cfg().maxCents, createCheckout, handleEvent, markCreditedAdmin, formDigest };
}

module.exports = { createCcbillService, configured, MIN_CENTS };
