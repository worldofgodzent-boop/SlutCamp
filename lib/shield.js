'use strict';
/*
 * lib/shield.js — pre-purchase explicit-media shield (SlutCamp).
 *
 * The age-verification design (owner, Oct 16 2026) verifies a fan at his
 * FIRST CREDIT PURCHASE: attestation at the door, a real transactional/
 * ID check at the money moment (see lib/av.js from the dormant-gate
 * build). The state AV statutes gate ACCESS to sexual material, not
 * just purchase — so everything a viewer in a regulated state can reach
 * BEFORE that purchase must be non-explicit. This module is the pure
 * decision layer for that shield; server.js applies it to payloads and
 * byte gates.
 *
 * ACTIVATION — mirrors the CCBill dormancy convention (lib/ccbill.js):
 * the shield is ACTIVE only when an AV provider is configured
 * (AV_PROVIDER + AV_API_KEY both present in env). With no provider
 * configured the app behaves EXACTLY as it did before the shield
 * existed; the tests pin that.
 *
 * WHO IS SHIELDED (when active) — a fan who has not completed age
 * verification (users.av_verified_at IS NULL) AND whose location is a
 * regulated state or UNKNOWN:
 *  - fan_state (stamped by the gate build) wins when present;
 *  - otherwise the request's IP geo decides (US state, or known
 *    non-US);
 *  - unknown location fails CLOSED (shielded): an unverified fan we
 *    cannot place might be sitting in a regulated state, and his
 *    remedy is the one verification at his first purchase.
 * A fan in a KNOWN non-regulated state (another US state, or outside
 * the US) is never shielded: no law requires his verification, and the
 * purchase gate will never demand it of him, so shielding him would
 * be permanent friction with no compliance gain.
 * Models and admins are never shielded (ID-verified at onboarding /
 * operators). Guests carry no identity to verify and receive no chat
 * media bytes under ANY configuration (the file-token route requires
 * login), so for guests the shield applies only to the public
 * directory payload (preview loops), resolved from request geo.
 */

/* The 27 states with AV laws in force (research, Oct 16 2026). Single
 * source of truth: AV_STATES lives in lib/av.js (the purchase gate) —
 * this list is imported, never duplicated, so the two can never drift. */
const { AV_STATES } = require('./av');
const AV_STATE_SET = new Set(AV_STATES);

/* Dormancy switch, ccbill-style: configured only when BOTH are set.
 * Reads env at call time (never cached) so config flips apply on
 * restart exactly like the other rails. */
function avConfigured() {
  return !!((process.env.AV_PROVIDER || '').trim() &&
            (process.env.AV_API_KEY || '').trim());
}

/*
 * Resolve a viewer's AV location from the best available evidence.
 *   storedState — users.fan_state (US state code) when the gate build
 *                 has stamped one, else null/undefined.
 *   geo         — lib/geo.js lookupIp() result for the request, or null.
 * Returns { state, known } where state is a US state code, 'NON-US'
 * (known to be outside the US), or null (unknown), and known says
 * whether the location is established at all.
 */
function resolveAvLocation(storedState, geo) {
  const s = String(storedState || '').trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(s)) return { state: s, known: true };
  if (geo && geo.country) {
    if (geo.country !== 'US') return { state: 'NON-US', known: true };
    if (geo.state) return { state: String(geo.state).toUpperCase(), known: true };
    return { state: null, known: false }; // US, but the state is unclear
  }
  return { state: null, known: false };
}

/* Is this location subject to an AV statute (or unresolvable, which
 * fails closed)? */
function locationShielded(loc) {
  if (!loc || !loc.known) return true;
  return AV_STATE_SET.has(loc.state);
}

/*
 * The one fan rule, used for every surface:
 *   shielded ⇔ AV configured AND fan AND not yet verified AND
 *              location regulated-or-unknown.
 * `user` is a users row (needs role + av_verified_at).
 */
function fanShielded(user, loc) {
  if (!avConfigured()) return false;
  if (!user || user.role !== 'fan') return false;
  if (user.av_verified_at) return false;
  return locationShielded(loc);
}

/* Guests: same location rule, no identity — regulated-or-unknown geo
 * means the public payload is shielded for them too. */
function guestShielded(loc) {
  if (!avConfigured()) return false;
  return locationShielded(loc);
}

module.exports = {
  AV_STATES,
  avConfigured,
  resolveAvLocation,
  locationShielded,
  fanShielded,
  guestShielded,
};
