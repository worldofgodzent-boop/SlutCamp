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
 *
 * THE AGECHECKER ADAPTER (AV_PROVIDER=agechecker, Assignment 16,
 * Ms. Pink Oct 28 2026) is the first real provider branch. It is
 * built ONLY from the API contract essentials Ms. Pink pulled from
 * the AgeChecker dashboard (api.agechecker.net):
 *   - Auth: API key as body field 'key' on POSTs; account secret as
 *     header X-AgeChecker-Secret (the contract also allows body
 *     'secret'); GETs carry header X-AgeChecker-Key.
 *   - POST /v1/create starts a data/records check and returns a
 *     verification 'uuid'; GET /v1/status/<uuid> polls it. The buyer
 *     flow is HOSTED: the fan is sent to the session link
 *     https://verify.agechecker.net/s/<uuid>.
 *   - POST /v1/id-verify is the ID-scan path.
 *   - Results also arrive by webhook: a PUT to our callback URL with
 *     uuid/status/reason, signed X-AgeChecker-Signature = base64
 *     HMAC-SHA1 of the raw body keyed by the account secret.
 *   - /v1/fraud-risk and the other paid add-ons are OUT of v1 scope
 *     and are never called.
 * CREDENTIALS: AgeChecker reads ITS OWN env names —
 * AGECHECKER_API_KEY / AGECHECKER_SECRET (set in Render at
 * activation, never in code). AV_PROVIDER=agechecker selects the
 * adapter; the rail stays DORMANT until BOTH AgeChecker vars are set
 * (the secret is required because unsigned results are never
 * trusted). AGECHECKER_API_BASE overrides the API host (test
 * support only, mirroring OPENAI_API_BASE / CF_REALTIME_API_BASE).
 *
 * COUNTRY TIERING (the locked A16 design, replacing the state list
 * FOR THIS PROVIDER ONLY — the stub keeps the AV_STATES gate):
 * verification fires once at a fan's first credit purchase, tiered
 * by card BILLING country first, IP country second. Strict
 * countries: US -> data/records check first, ID scan as the fallback
 * when the data check cannot decide; UK/FR/DE/AU -> straight to the
 * ID scan; everywhere else -> NO provider call at all (attestation +
 * card, exactly as today). NOTE: the hosted CCBill flow never shows
 * this platform a card, so NO billing-country source exists in the
 * codebase today — server.js passes billingCountry: null and the IP
 * country decides until a source lands; the resolver already prefers
 * billing the moment one is supplied. A crypto purchase has no card
 * data to check, so for a US fan the data route degrades to the ID
 * route (the same fallback, decided up front).
 * PROOF-ONLY still holds: av_provider_ref stores the AgeChecker
 * uuid, av_method the route taken; deny reasons and every other
 * provider payload field are read for the outcome and NEVER stored.
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

/* AgeChecker's own credential env (Ms. Pink's contract: the keys
 * come from Render at activation under THESE names, never in code).
 * AGECHECKER_API_BASE exists for tests, mirroring the base-override
 * convention of lib/transcribe.js / lib/relay.js. */
const AGECHECKER_BASE_DEFAULT = 'https://api.agechecker.net';
function agecheckerCfg() {
  return {
    apiKey: process.env['AGECHECKER_API_KEY'] || '',
    secret: process.env['AGECHECKER_SECRET'] || '',
    base: String(process.env.AGECHECKER_API_BASE || AGECHECKER_BASE_DEFAULT).replace(/\/+$/, ''),
  };
}

/* Dormancy switch, mirroring lib/ccbill.js configured(): the rail is
 * live only when a provider AND its key are both present. The
 * AgeChecker branch reads its credentials from the AGECHECKER_* vars
 * (NOT AV_API_KEY) and requires the secret too: without it, webhook
 * results cannot be signature-verified, so the rail stays dormant. */
function enabled() {
  const c = cfg();
  if (!c.provider) return false;
  if (c.provider === 'agechecker') {
    const a = agecheckerCfg();
    return !!(a.apiKey && a.secret);
  }
  return !!c.apiKey;
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

/* ---------------- AgeChecker country tiering (A16) ----------------
 * The locked A16 design tiers by COUNTRY, not US state. 'GB' is the
 * ISO code the geo data uses for the United Kingdom; 'UK' is accepted
 * as an input alias (Ms. Pink's spec writes UK) and normalized here,
 * at the single choke point every tier decision flows through. */
const AGECHECKER_DATA_COUNTRIES = Object.freeze(['US']);
const AGECHECKER_ID_COUNTRIES = Object.freeze(['GB', 'FR', 'DE', 'AU']);

function normalizeCountry(country) {
  if (!country) return null;
  const c = String(country).trim().toUpperCase();
  if (!c) return null;
  return c === 'UK' ? 'GB' : c;
}

/* Billing country FIRST, IP country second — the spec's order. A
 * null billing country (no source exists in the hosted card flow
 * today) simply falls through to the IP country. */
function tierCountry({ billingCountry, ipCountry } = {}) {
  return normalizeCountry(billingCountry) || normalizeCountry(ipCountry);
}

/* Which AgeChecker flow a country gets: 'data' (POST /v1/create,
 * records check), 'id' (POST /v1/id-verify), or null — null means NO
 * provider call at all (attestation + card, exactly as today). */
function agecheckerRoute(country) {
  const c = normalizeCountry(country);
  if (!c) return null;
  if (AGECHECKER_DATA_COUNTRIES.includes(c)) return 'data';
  if (AGECHECKER_ID_COUNTRIES.includes(c)) return 'id';
  return null;
}

/* The AgeChecker gate decision, pure like gateDecision. `method` is
 * the purchase rail ('transactional' card / 'id' crypto) and only
 * matters for the two documented degradations, which mirror the
 * policies above: an UNKNOWN country gates (the purchase choke-point
 * rule from gateDecision) with the rail choosing the flow, and a US
 * crypto purchase takes the ID route up front (no card data exists
 * for a data check). */
function agecheckerGateDecision({ role, avVerifiedAt, billingCountry, ipCountry, method }) {
  if (role !== 'fan') return { gate: false, reason: 'not_fan', country: null, route: null };
  if (avVerifiedAt) return { gate: false, reason: 'already_verified', country: null, route: null };
  const country = tierCountry({ billingCountry, ipCountry });
  if (!country) {
    return { gate: true, reason: 'unknown_country', country: null, route: method === 'id' ? 'id' : 'data' };
  }
  const route = agecheckerRoute(country);
  if (!route) return { gate: false, reason: 'non_strict_country', country, route: null };
  return {
    gate: true, reason: 'strict_country', country,
    route: route === 'data' && method === 'id' ? 'id' : route,
  };
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

  /* ---------------- AgeChecker adapter (A16) ----------------
   * One HTTP helper for the whole adapter. Auth follows the
   * contract: POSTs send the domain key as body field 'key' and the
   * account secret as the X-AgeChecker-Secret header; GETs send the
   * key as the X-AgeChecker-Key header (the contract documents that
   * header for GET /v1/latest; the status poll is the only other GET
   * and takes the same header). Bodies carry the auth fields ONLY —
   * the buyer flow is hosted, so the provider collects the buyer's
   * data on its own page and /v1/create needs nothing else from us. */
  async function agecheckerFetch(pathname, { method = 'GET', body } = {}) {
    const a = agecheckerCfg();
    const headers = {};
    const init = { method, headers, signal: AbortSignal.timeout(20000) };
    if (method === 'GET') {
      headers['X-AgeChecker-Key'] = a.apiKey;
    } else {
      headers['content-type'] = 'application/json';
      headers['X-AgeChecker-Secret'] = a.secret;
      init.body = JSON.stringify({ key: a.apiKey, ...(body || {}) });
    }
    let r;
    try {
      r = await fetch(a.base + pathname, init);
    } catch (e) {
      const err = new Error('av_provider_unreachable');
      err.code = 'av_provider_error';
      throw err;
    }
    let json = null;
    try { json = await r.json(); } catch (_) { /* non-JSON reply */ }
    if (!r.ok) {
      const err = new Error('av_provider_http_' + r.status);
      err.code = 'av_provider_error';
      throw err;
    }
    return json || {};
  }

  function agecheckerSessionLink(uuid) {
    return 'https://verify.agechecker.net/s/' + encodeURIComponent(uuid);
  }

  /* Start an AgeChecker verification and row it as a pending
   * session. Async (real HTTP) — the stub path stays synchronous and
   * callers await the result, which is a no-op for plain values. */
  async function createVerificationAgeChecker({ userId, method, billingCountry, ipCountry }) {
    const country = tierCountry({ billingCountry, ipCountry });
    let route = agecheckerRoute(country);
    if (country && !route) {
      // A verifiably non-strict country gets NO provider call, ever —
      // the gate normally stops this earlier; the adapter refuses too.
      const e = new Error('av_not_required');
      e.code = 'av_not_required';
      throw e;
    }
    if (!route) route = method === 'id' ? 'id' : 'data'; // unknown country: the rail chooses
    if (route === 'data' && method === 'id') route = 'id'; // crypto: no card data to check
    const resp = await agecheckerFetch(route === 'id' ? '/v1/id-verify' : '/v1/create',
      { method: 'POST', body: {} });
    const uuid = resp && resp.uuid ? String(resp.uuid) : null;
    if (!uuid) {
      const e = new Error('av_provider_error');
      e.code = 'av_provider_error';
      throw e;
    }
    const m = route === 'id' ? 'id' : 'transactional';
    db.prepare(`INSERT INTO av_sessions (user_id, method, provider, provider_ref)
                VALUES (?,?,?,?)`).run(userId, m, 'agechecker', uuid);
    return { session_ref: uuid, redirect_url: agecheckerSessionLink(uuid), stub: false, method: m };
  }

  /* Resolve an AgeChecker session server-side (never trust a client
   * claim): poll GET /v1/status/<uuid> and map the contract's
   * statuses. accepted/denied finalize; 'photo_id' on the data route
   * is the data check saying it cannot decide, so the ID-scan
   * fallback starts HERE and the pending session continues under the
   * new uuid (the proof, when it lands, names the final uuid);
   * every other documented status is still in progress. */
  async function completeVerificationAgeChecker({ s }) {
    const resp = await agecheckerFetch('/v1/status/' + encodeURIComponent(s.provider_ref),
      { method: 'GET' });
    const status = String((resp && resp.status) || '').toLowerCase();
    if (status === 'accepted') {
      finalizeSession(s, true);
      return { ok: true, passed: true, already: false };
    }
    if (status === 'denied') {
      finalizeSession(s, false);
      return { ok: true, passed: false, already: false };
    }
    if (status === 'not_created') return { ok: false, error: 'av_not_created' };
    if (status === 'photo_id' && s.method === 'transactional') {
      const fb = await agecheckerFetch('/v1/id-verify', { method: 'POST', body: {} });
      const uuid = fb && fb.uuid ? String(fb.uuid) : null;
      if (!uuid) {
        const e = new Error('av_provider_error');
        e.code = 'av_provider_error';
        throw e;
      }
      db.prepare(`UPDATE av_sessions SET provider_ref = ?, method = 'id'
                  WHERE id = ? AND status = 'pending'`).run(uuid, s.id);
      return {
        ok: true, passed: false, already: false, pending: true, fallback: 'id',
        session_ref: uuid, redirect_url: agecheckerSessionLink(uuid),
      };
    }
    return { ok: true, passed: false, already: false, pending: true };
  }

  function createVerification({ userId, username, method, billingCountry, ipCountry }) {
    if (!enabled()) throw notConfigured();
    const c = cfg();
    if (c.provider === 'agechecker') {
      return createVerificationAgeChecker({ userId, method, billingCountry, ipCountry });
    }
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
    if (c.provider === 'agechecker') {
      // Real provider: resolve the session result server-side with the
      // provider (never trust a client claim) and finalizeSession().
      if (s.provider !== 'agechecker') return { ok: false, error: 'unknown_session' };
      return completeVerificationAgeChecker({ s });
    }
    if (c.provider !== 'stub') {
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
    if (cfg().provider === 'agechecker') {
      // AgeChecker's shape: { uuid, status, reason }. Only the two
      // final statuses change anything; a non-final status (pending,
      // photo_id, …) is acknowledged and ignored, and the deny
      // `reason` is NEVER persisted (proof-only storage).
      const ref = payload && payload.uuid;
      if (!ref) return { handled: 'ignored' };
      const s = sessionByRef(ref);
      if (!s || s.provider !== 'agechecker') return { handled: 'ignored' };
      if (s.status !== 'pending') return { handled: 'duplicate' };
      const status = String(payload.status || '').toLowerCase();
      if (status === 'accepted') { finalizeSession(s, true); return { handled: 'verified' }; }
      if (status === 'denied') { finalizeSession(s, false); return { handled: 'failed' }; }
      return { handled: 'ignored' };
    }
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
    // configured provider. Dormant = reject everything.
    const c = cfg();
    if (c.provider === 'stub') return true;
    if (c.provider === 'agechecker') {
      // Contract scheme: X-AgeChecker-Signature is the base64
      // HMAC-SHA1 of the RAW request body keyed by the account
      // secret. server.js passes the captured raw body for this
      // provider; a parsed-object payload (direct/unit calls) is
      // re-serialized as a fallback. Timing-safe comparison.
      const a = agecheckerCfg();
      if (!a.secret || !signature) return false;
      const raw = Buffer.isBuffer(payload) ? payload
        : (typeof payload === 'string' ? Buffer.from(payload, 'utf8')
          : Buffer.from(JSON.stringify(payload || {}), 'utf8'));
      const expected = crypto.createHmac('sha1', a.secret).update(raw).digest('base64');
      const got = Buffer.from(String(signature), 'utf8');
      const want = Buffer.from(expected, 'utf8');
      return got.length === want.length && crypto.timingSafeEqual(got, want);
    }
    return false;
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
  normalizeCountry,
  tierCountry,
  agecheckerRoute,
  agecheckerGateDecision,
  AGECHECKER_DATA_COUNTRIES,
  AGECHECKER_ID_COUNTRIES,
};
