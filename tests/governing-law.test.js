'use strict';
/*
 * Texas governing law + venue (owner directive, Oct 16 2026: "Work with
 * the Texas law" — the LLC is Texas, so Texas law governs the contracts).
 * Source pins for the clause in all three legal documents: the fan Terms
 * of Service (public/js/app.js vTerms), the Model Agreement and the
 * Recruiter Agreement (server.js). Each clause states:
 *   - Texas governing law, without regard to conflict-of-laws rules;
 *   - disputes in the state or federal courts located in Texas, with
 *     both parties consenting to personal jurisdiction and venue there;
 *   - the CARVE-OUT: nothing waives or limits rights a user's home state
 *     grants that cannot legally be waived (privacy rights are
 *     non-waivable — e.g. CA Civ. Code §1798.192 voids waiver provisions —
 *     and an overreaching clause risks being struck entirely; the
 *     carve-out keeps the Texas clause enforceable).
 * Before this build, NO governing-law/venue clause existed anywhere.
 *
 * Placement follows the payout-protection precedent: the new section
 * goes immediately before each document's closing section, which is
 * renumbered — Model disclaimer 14 → 15, Recruiter disclaimer 9 → 10,
 * fan Terms "Changes" 11 → 12. Version handling follows the agreements'
 * exact-version signing gate: a text change bumps the version (Model
 * 1.3 → 1.4, Recruiter R1.1 → R1.2), so every existing signer reads
 * signed:false until they re-sign the new text. (The Recruiter version
 * has since moved to R1.3 for the first-year quota — the pin in the
 * recruiter test below tracks the current version.)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
const app = fs.readFileSync(path.join(REPO, 'public/js/app.js'), 'utf8');

const LAW = 'governed by the laws of the State of Texas';
const CARVE_OUT = 'Nothing in this section waives or limits any right your home state gives you that cannot legally be waived';
const AGREEMENT_LAW_SENTENCE = 'This Agreement is governed by the laws of the State of Texas, without regard to its conflict-of-laws rules.';
const AGREEMENT_VENUE_SENTENCE = 'must be brought in the state or federal courts located in Texas, and you and the Company consent to the personal jurisdiction and venue of those courts.';

function occurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

test('governing law: Model Agreement §14 carries the Texas clause; version pin tracks v1.6', () => {
  // The version pin tracks the CURRENT version, per this suite's own
  // convention: v1.6 (the CCBill compliance amendments — depicted-person
  // verification/consent duties in §3/§6 and the Standards prohibition
  // in §7) superseded v1.5 (the §15 section & who-may-appear clause),
  // which superseded the v1.4 text this test originally pinned — the
  // Texas clause itself is unchanged and still §14.
  assert.ok(server.includes("const CONTRACT_VERSION = '1.6';"), 'model contract version is 1.6 (forces re-sign of the new text)');
  assert.ok(!server.includes("const CONTRACT_VERSION = '1.5';"), 'old model version 1.5 is gone');
  assert.ok(!server.includes("const CONTRACT_VERSION = '1.4';"), 'old model version 1.4 is gone');
  assert.ok(!server.includes("const CONTRACT_VERSION = '1.3';"), 'old model version 1.3 is gone');
  assert.ok(server.includes("title: '14. Governing Law & Venue'"), 'model §14 is Governing Law & Venue');
  assert.ok(server.includes(AGREEMENT_LAW_SENTENCE), 'model clause: Texas governing law, no conflict-of-laws rules');
  assert.ok(server.includes(AGREEMENT_VENUE_SENTENCE), 'model clause: Texas courts + consent to personal jurisdiction and venue');
  assert.ok(server.includes(CARVE_OUT), 'model clause: non-waivable home-state rights carve-out present');
  const i13 = server.indexOf('13. Payout Holds, Chargeback Reversals & Fraud');
  const i14 = server.indexOf('14. Governing Law & Venue');
  const i15 = server.indexOf('15. Your Section & Who May Appear');
  const i16 = server.indexOf('16. Plain-Language Disclaimer');
  assert.ok(i13 !== -1 && i14 > i13 && i15 > i14 && i16 > i15, 'model clause sits after §13, before the section clause and the disclaimer');
  assert.ok(!server.includes('14. Plain-Language Disclaimer'), 'model disclaimer no longer numbered 14');
  assert.ok(!server.includes('15. Plain-Language Disclaimer'), 'model disclaimer renumbered to 16 by the v1.5 section clause');
});

test('governing law: Recruiter Agreement §9 carries the Texas clause; version pin tracks the R1.3 quota bump', () => {
  // R1.2 was the governing-law bump; R1.3 (affiliate first-year quota,
  // tests/affiliate-terms.test.js) superseded it — the version pin
  // tracks the current version, per the payout-protection precedent.
  assert.ok(server.includes("const RECRUITER_CONTRACT_VERSION = 'R1.3';"), 'recruiter contract version is R1.3 (R1.2 added governing law; R1.3 adds the quota)');
  assert.ok(!server.includes("const RECRUITER_CONTRACT_VERSION = 'R1.2';"), 'old recruiter version R1.2 is gone');
  const rec = server.slice(server.indexOf('const RECRUITER_CONTRACT = {'));
  assert.ok(rec.includes("title: '9. Governing Law & Venue'"), 'recruiter §9 is Governing Law & Venue');
  assert.ok(rec.includes(AGREEMENT_LAW_SENTENCE), 'recruiter clause: Texas governing law, no conflict-of-laws rules');
  assert.ok(rec.includes(AGREEMENT_VENUE_SENTENCE), 'recruiter clause: Texas courts + consent to personal jurisdiction and venue');
  assert.ok(rec.includes(CARVE_OUT), 'recruiter clause: non-waivable home-state rights carve-out present');
  const i9 = rec.indexOf('9. Governing Law & Venue');
  const i11 = rec.indexOf('11. Plain-Language Disclaimer');
  assert.ok(i9 !== -1 && i11 > i9, 'recruiter clause sits before the disclaimer (renumbered to §11 by the quota section at §10)');
  assert.ok(!server.includes('9. Plain-Language Disclaimer'), 'recruiter disclaimer no longer numbered 9');
  assert.ok(!server.includes('10. Plain-Language Disclaimer'), 'recruiter disclaimer no longer numbered 10 (quota took §10)');
});

test('governing law: fan Terms §11 carries the Texas clause; Changes renumbered to §12', () => {
  // Fan Terms live in the EN legal_terms_html i18n entry since the 13-language build.
  const tStart = app.indexOf('legal_terms_html:');
  const terms = app.slice(tStart, app.indexOf('legal_terms_html:', tStart + 1));
  assert.ok(terms.includes('11. Governing Law'), 'fan Terms §11 is Governing Law');
  assert.ok(terms.includes('These terms are governed by the laws of the State of Texas, without regard to its conflict-of-laws rules.'),
    'fan clause: Texas governing law, no conflict-of-laws rules');
  assert.ok(terms.includes('must be brought in the state or federal courts located in Texas, and you and SlutCamp consent to the personal jurisdiction and venue of those courts.'),
    'fan clause: Texas courts + consent to personal jurisdiction and venue');
  assert.ok(terms.includes(CARVE_OUT), 'fan clause: non-waivable home-state rights carve-out present');
  const i10 = terms.indexOf('10. Chargebacks & Fraud');
  const i11 = terms.indexOf('11. Governing Law');
  const i12 = terms.indexOf('12. Changes');
  assert.ok(i10 !== -1 && i11 > i10 && i12 > i11, 'fan clause sits after §10 and before the renumbered §12 Changes');
  assert.ok(!terms.includes('11. Changes'), 'fan Terms no longer number Changes as 11 (the separate Privacy Policy keeps its own §11 — untouched, out of scope)');
  assert.ok(terms.includes('Last updated October 27, 2026'), 'fan Terms header date is October 27, 2026 (the CCBill compliance build added §14 and redated)');
});

test('governing law: exactly one clause per document; agreement dates unchanged', () => {
  assert.equal(occurrences(server, LAW), 2, 'server.js carries the governing-law sentence exactly twice (model + recruiter)');
  assert.equal(occurrences(app, LAW), 1, 'app.js carries the governing-law sentence exactly once (fan Terms)');
  assert.equal(occurrences(server, CARVE_OUT), 2, 'the carve-out appears in both agreements');
  assert.equal(occurrences(app, CARVE_OUT), 1, 'the carve-out appears in the fan Terms');
  // The governing-law build itself redated nothing. The Recruiter
  // Agreement still carries October 16, 2026; the Model Agreement was
  // legitimately redated to October 18, 2026 by the v1.5
  // sections-clause bump, and again to October 27, 2026 by the v1.6
  // CCBill compliance bump (version bumps move the date —
  // the v1.2→v1.4 bumps did the same).
  assert.equal(occurrences(server, "updated: 'October 16, 2026'"), 1, 'the recruiter agreement remains dated October 16, 2026');
  assert.equal(occurrences(server, "updated: 'October 27, 2026'"), 1, 'the model agreement is dated October 27, 2026 (v1.6)');
});
