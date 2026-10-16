'use strict';
/*
 * lib/av.js — Age-verification (AV) provider adapter + purchase gate.
 *
 * Owner's design (Asce, Oct 16 2026): fans attest 18+ at the door, as
 * they always have. REAL verification fires exactly once — at a fan's
 * FIRST credit purchase — and only for fans located in a state with an
 * adult-site age-verification law (AV_STATES below). Card buyers verify
 * through the provider's TRANSACTIONAL-DATA check (the cardholder's
 * identity/age cross-checked against bank/database records — merely
 * charging a card proves nothing); crypto buyers, who have no card,
 * verify through the provider's ID check.
 *
 * DORMANT BY DEFAULT, exactly like the CCBill rail: the feature is
 * "enabled" only when AV_PROVIDER and AV_API_KEY are both set in the
 * environment. While dormant, every purchase path behaves exactly as it
 * did before this module existed (pinned by tests) and /api/av/* refuses
 * with av_not_configured.
 *
 * PROOF-ONLY STORAGE (a hard rule of this design): we never store the
 * fan's document, photo, date of birth, or any provider payload. The
 * evidence stays with the provider; we keep only the fact of the check
 * (AV_USER_COLUMNS) plus an opaque provider reference. Several AV
 * statutes PROHIBIT retaining the identifying data — this design makes
 * retention impossible rather than merely policy.
 *
 * PROVIDER INTERFACE — what a real provider integration must implement
 * (the call sites in server.js never change, only this module grows a
 * branch):
 *   createVerification({ userId, username, method })
 *       -> { session_ref, redirect_url, stub, method }
 *       Real providers return a hosted `redirect_url` the fan's browser
 *       visits; the result then arrives via handleWebhook (or the fan
 *       returns and the client polls /api/av/status).
 *   completeVerification({ userId, username, session_ref })
 *       -> { ok, passed, already? } | { ok: false, error }
 *       The in-app completion path (the stub completes here; a real
 *       provider adapter resolves the session's server-side result).
 *   handleWebhook(payload) -> { handled }
 *       Server-to-server result delivery; finalizes the session.
 *   verifyWebhookSignature(payload, signature) -> boolean
 *       MUST verify the provider's signature (HMAC over the raw payload
 *       against AV_WEBHOOK_SECRET) before handleWebhook is trusted at
 *       activation time. The stub scheme below is test-only.
 *   stampReattestation(userId) -> boolean
 *       Tennessee mechanism: periodic re-verification is satisfied by a
 *       cheap session re-attestation stamp on login — no provider call.
 *
 * THE STUB PROVIDER (AV_PROVIDER=stub) exists for tests and local
 * development ONLY. Its outcome is deterministic by test input: a
 * username containing "avfail" FAILS, everyone else passes. It must
 * never be the production provider.
 */
const crypto = require('node:crypto');

/* The 27 states with adult-site age-verification laws in force
 * (compliance research, Oct 2026): AL AZ AR FL GA ID IN IA KS KY LA MS
 * MO MT NE NC ND OH OK SC SD TN TX UT VA WV WY. Edit the list HERE and
 * nowhere else — the gate, the status endpoint and the tests all read
 * this single source. */
const AV_STATES = Object.freeze([
  'AL', 'AZ', 'AR', 'FL', 'GA', 'ID', 'IN', 'IA', 'KS', 'KY', 'LA', 'MS',
  'MO', 'MT', 'NE', 'NC', 'ND', 'OH', 'OK', 'SC', 'SD', 'TN', 'TX', 'UT',
  'VA', 'WV', 'WY',
]);
const AV_STATE_SET = new Set(AV_STATES);

/* Verification methods: 'transactional' = card/transactional-data
 * check (card purchase path), 'id' = document/ID check (crypto path). */
const METHODS = Object.freeze(['transactional', 'id']);

/* The ONLY columns this feature adds to users — the complete proof
 * record. fan_state is a coarse location fact (a 2-letter code), the
 * rest are timestamps, the method used, and the provider's opaque
 * reference. A test asserts this list never grows evidence fields. */
const AV_USER_COLUMNS = Object.freeze([
  'fan_state', 'av_verified_at', 'av_method', 'av_provider_ref', 'av_last_attested_at',
]);

function cfg() {
  return {
    provider: String(process.env.AV_PROVIDER || '').trim().toLowerCase(),
    apiKey: process.env.AV_API_KEY || '',
    webhookSecret: process.env.AV_WEBHOOK_SECRET || '',
  };
}

/* Dormancy switch, mirroring lib/ccbill.js configured(): the rail is
 * live only when a provider AND its key are both present. */
function enabled() {
  const c = cfg();
  return !!(c.provider && c.apiKey);
}

function providerName() {
  return cfg().provider || null;
}

function isRegulatedState(state) {
  return !!state && AV_STATE_SET.has(String(state).toUpperCase());
}

/*
 * The gate decision, pure and unit-tested. Inputs describe what we know
 * about the fan RIGHT NOW (fresh geo from this request beats the stored
 * signup state; server.js persists any fresh state before calling).
 *
 * UNKNOWN-STATE POLICY: if we cannot place the fan in ANY state (geo
 * lookup failed AND nothing stored) we GATE the purchase. Rationale:
 * the purchase is the choke point of the whole design — a fan who is
 * actually in a regulated state must not slip through on a lookup
 * failure, and geoip's fail-open convention (right for model region
 * blocking, where the harm is over-hiding) would silently defeat the
 * one check this feature exists to make. The cost of a wrong gate is
 * one quick verification; the cost of a wrong pass is the exact
 * statutory exposure the owner chose to close. A fan verifiably
 * OUTSIDE the US is never gated: US state AV laws attach to the fan's
 * state, and there isn't one.
 */
function gateDecision({ role, avVerifiedAt, geoCountry, geoState, storedState }) {
  if (role !== 'fan') return { gate: false, reason: 'not_fan', state: null };
  if (avVerifiedAt) return { gate: false, reason: 'already_verified', state: null };
  if (geoCountry && geoCountry !== 'US') return { gate: false, reason: 'non_us', state: null };
  const state = (geoCountry === 'US' && geoState)
    ? String(geoState).toUpperCase()
    : (storedState ? String(storedState).toUpperCase() : null);
  if (state && !isRegulatedState(state)) return { gate: false, reason: 'unregulated_state', state };
  if (state) return { gate: true, reason: 'regulated_state', state };
  return { gate: true, reason: 'unknown_state', state: null };
}

/* STUB ONLY: deterministic pass/fail by test input. */
function stubOutcomeFor(username) {
  return String(username || '').toLowerCase().includes('avfail') ? 'fail' : 'pass';
}

function notConfigured() {
  const e = new Error('av_not_configured');
  e.code = 'av_not_configured';
  return e;
}

function createAvService({ db }) {
  /* Verification sessions: the audit trail is refs and outcomes only —
   * no provider payloads, no documents, no personal data. */
  db.exec(`
  CREATE TABLE IF NOT EXISTS av_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    method TEXT NOT NULL,
    provider TEXT NOT NULL,
    provider_ref TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_av_sessions_user ON av_sessions(user_id, status);
  `);

  /* Flip a pending session to its final state exactly once and, on a
   * pass, stamp the user's proof fields (also exactly once — the
   * av_verified_at IS NULL guard means a later session can never move
   * the original proof). Returns true when this call did the flip. */
  function finalizeSession(session, passed) {
    const upd = db.prepare(`UPDATE av_sessions
      SET status = ?, completed_at = datetime('now')
      WHERE id = ? AND status = 'pending'`)
      .run(passed ? 'passed' : 'failed', session.id);
    if (!upd.changes) return false;
    if (passed) {
      db.prepare(`UPDATE users
        SET av_verified_at = datetime('now'), av_method = ?, av_provider_ref = ?
        WHERE id = ? AND av_verified_at IS NULL`)
        .run(session.method, session.provider_ref, session.user_id);
    }
    return true;
  }

  function sessionByRef(ref) {
    return db.prepare('SELECT * FROM av_sessions WHERE provider_ref = ?')
      .get(String(ref || ''));
  }

  function createVerification({ userId, username, method }) {
    if (!enabled()) throw notConfigured();
    const c = cfg();
    if (c.provider !== 'stub') {
      // A real provider adapter lands here at activation: create the
      // provider-side session and return its hosted URL. Call sites do
      // not change.
      const e = new Error('av_provider_not_implemented');
      e.code = 'av_provider_not_implemented';
      throw e;
    }
    const m = METHODS.includes(method) ? method : 'transactional';
    const ref = 'stub_' + crypto.randomBytes(16).toString('hex');
    db.prepare(`INSERT INTO av_sessions (user_id, method, provider, provider_ref)
                VALUES (?,?,?,?)`).run(userId, m, c.provider, ref);
    // The stub has no hosted page: redirect_url is null and `stub: true`
    // tells the client to render its in-app continue step, which calls
    // POST /api/av/complete.
    return { session_ref: ref, redirect_url: null, stub: true, method: m };
  }

  function completeVerification({ userId, username, sessionRef }) {
    if (!enabled()) throw notConfigured();
    const s = sessionByRef(sessionRef);
    if (!s || s.user_id !== userId) return { ok: false, error: 'unknown_session' };
    if (s.status !== 'pending') {
      // Replay of an already-final session: report the recorded outcome;
      // the proof stamp is never rewritten.
      return { ok: true, passed: s.status === 'passed', already: true };
    }
    const c = cfg();
    if (c.provider !== 'stub') {
      // Real provider: resolve the session result server-side with the
      // provider (never trust a client claim) and finalizeSession().
      const e = new Error('av_provider_not_implemented');
      e.code = 'av_provider_not_implemented';
      throw e;
    }
    const passed = stubOutcomeFor(username) === 'pass';
    finalizeSession(s, passed);
    return { ok: true, passed, already: false };
  }

  /* Provider server-to-server result delivery. A real provider posts
   * its own payload shape; normalize it to { session_ref, outcome }
   * here at activation. The stub accepts exactly that shape. */
  function handleWebhook(payload) {
    const ref = payload && (payload.session_ref || payload.provider_ref);
    if (!ref) return { handled: 'ignored' };
    const s = sessionByRef(ref);
    if (!s) return { handled: 'ignored' };
    if (s.status !== 'pending') return { handled: 'duplicate' };
    const passed = payload.outcome === 'pass' || payload.status === 'passed' || payload.passed === true;
    finalizeSession(s, passed);
    return { handled: passed ? 'verified' : 'failed' };
  }

  function verifyWebhookSignature(payload, signature) {
    // STUB SCHEME (test/local only): the stub provider has no signing
    // scheme, so its webhooks are accepted only while the stub is the
    // configured provider. A real provider MUST be verified here —
    // HMAC of the raw payload against AV_WEBHOOK_SECRET — before
    // handleWebhook's result is trusted. Dormant = reject everything.
    return cfg().provider === 'stub';
  }

  /* Tennessee periodic re-verification: once a fan is verified, each
   * fresh login re-attests the session — a timestamp, no provider
   * call, no fee. Only ever stamps fans who already hold proof. */
  function stampReattestation(userId) {
    if (!enabled()) return false;
    const r = db.prepare(`UPDATE users SET av_last_attested_at = datetime('now')
                          WHERE id = ? AND av_verified_at IS NOT NULL`).run(userId);
    return r.changes > 0;
  }

  return {
    enabled, providerName, createVerification, completeVerification,
    handleWebhook, verifyWebhookSignature, stampReattestation,
  };
}

module.exports = {
  createAvService,
  enabled,
  providerName,
  isRegulatedState,
  gateDecision,
  stubOutcomeFor,
  AV_STATES,
  METHODS,
  AV_USER_COLUMNS,
};
