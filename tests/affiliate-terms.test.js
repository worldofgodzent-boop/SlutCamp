'use strict';
/*
 * Affiliate terms amendment — first-year quota (owner directive,
 * Oct 16 2026, restated twice): the Recruiter Agreement AND the
 * affiliate sign-up moment must clearly state:
 *   (1) SlutCamp may revoke an affiliate's link / affiliate status at
 *       any time, for any reason, without any notice — §5 "Termination
 *       — At Will" already said this almost verbatim and is NOT
 *       weakened by this build (pinned below, word for word);
 *   (2) an affiliate has ONE YEAR from becoming an affiliate to
 *       onboard a minimum of 10 models;
 *   (3) if the year runs out below 10 models, SlutCamp reviews the
 *       affiliate and, if deemed necessary, revokes the status;
 *   (4) if the affiliate's onboarded models made the Company a
 *       significant amount of money, SlutCamp extends the status
 *       until the quota is met.
 *
 * Implementation pinned here: a new §10 "First-Year Quota" in the
 * Recruiter Agreement (server.js), placed after §9 Governing Law &
 * Venue and before the closing disclaimer (renumbered §10 → §11 —
 * the same placement precedent as governing law / payout protection),
 * the version bump R1.2 → R1.3 that forces every current recruiter to
 * re-sign through the exact-version gate, and a short plain-language
 * notice (aff_quota_notice, EN/ES/PT) rendered directly at the
 * acceptance checkbox on BOTH affiliate signup forms (the entry
 * screen's Affiliate tab and the Manager invite form, which share
 * AFFILIATE_AGREEMENT_SECTIONS — the summary gains the quota entry
 * there too).
 *
 * TEXT ONLY, by the owner's words: the year-end step is a Company
 * review — there is deliberately NO automated quota enforcement, no
 * auto-revoke, no quota timers or flags in this build.
 *
 * Source pins + one temp-copy boot asserting the served contract.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
const app = fs.readFileSync(path.join(REPO, 'public/js/app.js'), 'utf8');

// The Recruiter Agreement object only (bounded by the route that
// immediately follows it in server.js).
const recStart = server.indexOf('const RECRUITER_CONTRACT = {');
const recEnd = server.indexOf("app.get('/api/credits/packages'", recStart);
const rec = server.slice(recStart, recEnd);

test('affiliate terms: Recruiter Agreement version bumped R1.2 → R1.3 (forces re-sign)', () => {
  assert.ok(server.includes("const RECRUITER_CONTRACT_VERSION = 'R1.3';"),
    'recruiter contract version is R1.3');
  assert.ok(!server.includes("const RECRUITER_CONTRACT_VERSION = 'R1.2';"),
    'old recruiter version R1.2 is gone');
  assert.ok(recStart !== -1 && recEnd > recStart, 'recruiter agreement located in server.js');
});

test('affiliate terms: §5 at-will revocation language is intact, unweakened', () => {
  assert.ok(rec.includes("title: '5. Termination — At Will'"), '§5 title intact');
  assert.ok(rec.includes('The Company may revoke your recruiter status AT ANY TIME, for any reason or no reason, with NO NOTICE required.'),
    '§5: revoke at any time, for any reason or no reason, with no notice required');
  assert.ok(rec.includes('When revoked, this Agreement ends immediately and you stop earning on all future revenue from your recruited models.'),
    '§5: revocation ends the agreement and future earnings immediately');
  assert.ok(rec.includes('Any balance already earned remains available for withdrawal.'),
    '§5: already-earned balance stays withdrawable');
});

test('affiliate terms: §10 First-Year Quota carries all four quota clauses', () => {
  assert.ok(rec.includes("title: '10. First-Year Quota — 10 Models in Your First Year'"),
    '§10 is the First-Year Quota section');
  // (2) one year from signup/acceptance, minimum 10 models
  assert.ok(rec.includes('You have ONE YEAR from the date you sign up and accept this Agreement to onboard a minimum of 10 models.'),
    'quota: ONE YEAR from signup/acceptance to onboard a minimum of 10 models');
  assert.ok(rec.includes('A model counts toward your quota only when she joins SlutCamp through your personal referral link and holds a model account.'),
    'quota: a model counts only when she joined through the affiliate link and holds a model account');
  // (3) year-end Company review; may revoke if below quota
  assert.ok(rec.includes('When your first year ends, the Company will review your account.'),
    'quota: the Company reviews the account when the first year ends');
  assert.ok(rec.includes('If you have onboarded fewer than 10 models, the Company may revoke your recruiter status if deemed necessary'),
    'quota: below 10 at review, the Company may revoke if deemed necessary');
  // (4) extension when her models earned the Company significant money
  assert.ok(rec.includes('If the models you onboarded have made the Company a significant amount of money, the Company will extend your recruiter status until the quota is met'),
    'quota: significant earnings extend the status until the quota is met');
  // the review is the Company's manual step — never an automatic cutoff
  assert.ok(rec.includes('reaching the one-year mark does not by itself automatically end your status'),
    'quota: the one-year mark alone does not automatically end the status');
  // §10 never dilutes §5
  assert.ok(rec.includes('to revoke your recruiter status and your referral link at any time, for any reason, without notice.'),
    'quota: §5 at-will revocation of status and link is preserved in full');
});

test('affiliate terms: quota placement + numbering are coherent (after §9, disclaimer last at §11)', () => {
  const i5 = rec.indexOf('5. Termination — At Will');
  const i9 = rec.indexOf('9. Governing Law & Venue');
  const i10 = rec.indexOf('10. First-Year Quota');
  const i11 = rec.indexOf('11. Plain-Language Disclaimer');
  assert.ok(i5 !== -1 && i9 > i5 && i10 > i9 && i11 > i10,
    'order: §5 termination → §9 governing law → §10 quota → §11 disclaimer');
  assert.ok(!rec.includes('10. Plain-Language Disclaimer'),
    'recruiter disclaimer no longer numbered 10');
  assert.equal(rec.split("title: '").length - 1, 11,
    'recruiter agreement has exactly 11 sections');
});

test('affiliate terms: signup notice exists in EN/ES/PT and renders at the acceptance point of both forms', () => {
  // i18n: the notice key is defined once per locale
  const defs = app.split('aff_quota_notice:').length - 1;
  assert.equal(defs, 3, `aff_quota_notice defined for en/es/pt (found ${defs})`);
  // EN notice states all four points briefly and defers to the Agreement
  const en = app.slice(app.indexOf('aff_quota_notice:'), app.indexOf('aff_quota_notice:') + 600);
  assert.ok(en.includes('can end your affiliate status and link at any time, for any reason, without notice'),
    'EN notice: revocation at any time, any reason, no notice');
  assert.ok(en.includes('You have one year to bring in at least 10 models.'),
    'EN notice: one year, at least 10 models');
  assert.ok(en.includes('SlutCamp will review your account and may end your status'),
    'EN notice: year-end review may end the status');
  assert.ok(en.includes('unless your models have earned SlutCamp significant money, in which case your status is extended until you reach 10'),
    'EN notice: significant-earnings extension until 10');
  assert.ok(en.includes('The full Agreement governs.'), 'EN notice: the full Agreement governs');
  // rendered via t() at the acceptance point of BOTH signup forms
  const renders = app.split("t('aff_quota_notice')").length - 1;
  assert.equal(renders, 2, `notice rendered on both affiliate signup forms (found ${renders})`);
  // the shared agreement summary shown on both forms carries the quota too
  assert.ok(app.includes("'9. First-Year Quota — 10 Models in Your First Year'"),
    'signup agreement summary includes the First-Year Quota entry');
  assert.ok(app.includes('You have ONE YEAR from signup to onboard at least 10 models through your link.'),
    'signup summary: one year / 10 models through your link');
  assert.ok(app.includes('your status is extended until you reach 10'),
    'signup summary: extension until 10 on significant earnings');
});

/* ---- served-contract boot (temp copy, same harness pattern) ---- */

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function makeCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-affterms-'));
  for (const d of ['server.js', 'package.json', 'lib', 'public', 'data']) {
    fs.cpSync(path.join(REPO, d), path.join(dir, d), { recursive: true });
  }
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  return dir;
}

async function boot(dir, extraEnv = {}) {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), CRYPTO_POLL_MS: '3600000', ...extraEnv };
  for (const k of Object.keys(env)) {
    if (/^(CCBILL_|CRYPTO_|OPENAI_|TWILIO_|VAPID_|WEBAUTHN_|AV_)/.test(k)) delete env[k];
  }
  if (!('SEED_DEMO' in extraEnv)) delete env.SEED_DEMO;
  const child = spawn(process.execPath, ['server.js'], { cwd: dir, env });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode})\n${log}`);
    try {
      const r = await fetch(base + '/api/health');
      if (r.ok) break;
    } catch (e) { /* not up yet */ }
    if (Date.now() > deadline) { child.kill('SIGKILL'); throw new Error(`server did not come up\n${log}`); }
    await new Promise((r) => setTimeout(r, 150));
  }
  return { child, base, log: () => log };
}

function stop(h) {
  if (h && h.child && h.child.exitCode === null) h.child.kill('SIGKILL');
}

async function req(base, method, p, { body, token } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  const r = await fetch(base + p, {
    method, headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await r.json(); } catch (e) { /* non-JSON */ }
  return { status: r.status, data };
}

test('affiliate terms: served contract is R1.3, auto-signed at R1.3, and serves the quota section', async () => {
  const dir = makeCopy();
  try {
    const h = await boot(dir);
    try {
      let r = await req(h.base, 'POST', '/api/affiliate/signup', {
        body: { username: 'quotagal', password: 'hunter22', display_name: 'Quota Gal', agreed: true } });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      const token = r.data.token;

      r = await req(h.base, 'GET', '/api/recruiter/contract', { token });
      assert.equal(r.status, 200);
      assert.equal(r.data.version, 'R1.3', 'served agreement version is R1.3');
      assert.equal(r.data.signed, true, 'self-serve signup auto-signs the current version');
      assert.equal(r.data.signed_version, 'R1.3', 'signature recorded at R1.3');
      assert.equal(r.data.sections.length, 11, 'served agreement has 11 sections');
      const titles = r.data.sections.map((s) => s.title);
      assert.equal(titles[4], '5. Termination — At Will');
      assert.equal(titles[9], '10. First-Year Quota — 10 Models in Your First Year');
      assert.equal(titles[10], '11. Plain-Language Disclaimer');
      const quota = r.data.sections[9].body;
      assert.ok(quota.includes('ONE YEAR') && quota.includes('minimum of 10 models'),
        'served quota: one year / minimum 10 models');
      assert.ok(quota.includes('will review your account') && quota.includes('may revoke'),
        'served quota: review + possible revocation');
      assert.ok(quota.includes('significant amount of money') && quota.includes('extend your recruiter status until the quota is met'),
        'served quota: significant-earnings extension');
      const term = r.data.sections[4].body;
      assert.ok(term.includes('AT ANY TIME, for any reason or no reason, with NO NOTICE required'),
        'served §5 revocation language intact');
    } finally { stop(h); }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
