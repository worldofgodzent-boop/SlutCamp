'use strict';
/*
 * Recruiter rate step-down (Assignment 07, Ms. Pink Oct 26 2026,
 * Asce decision 2026-10-26, binding):
 * - The recruiter rate is a % of GROSS, locked at signup, never
 *   changed afterward: before 2027-04-26 → 20; 2027-04-26 through
 *   2027-07-25 → 10; on/after 2027-07-26 → 5.
 * - Grandfathering is absolute: existing recruiters stay 20 forever
 *   (migration backfills recruiters.rate_pct = 20).
 * - ALL recruiter earnings math reads the STORED rate — splitPayment
 *   has no global rate constant in the payout path, and the cut is
 *   capped at the platform slice so it never comes from the model's 60%.
 * - The Recruiter Agreement version bumps R1.3 → R1.4, and its EN §4
 *   states the step-down schedule (not a flat 20%). Non-EN §4 bodies
 *   still state 20% — accurate for every signup today, but a
 *   translation pass is needed before 2027-04-26 (flagged for Ms. Pink).
 * - Recruiter dashboard + Manager recruiter rows display the locked rate.
 * Live boundary coverage: the tier function itself is evaluated from
 * source (its date mapping cannot be exercised through a signup API
 * in 2026), and the live payout test proves a stored 10% / 5% rate
 * drives the split, while a second recruiter's stored 20% is untouched.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const REPO = path.join(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
const managerSrc = fs.readFileSync(path.join(REPO, 'public/manager/manager.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(REPO, 'public/js/app.js'), 'utf8');

function evalTierFn() {
  const m = serverSrc.match(/function recruiterRatePctForSignupDate\(dateStr\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'tier function recruiterRatePctForSignupDate is defined');
  const sb = {};
  vm.createContext(sb);
  vm.runInContext(m[0] + '\nthis.__fn = recruiterRatePctForSignupDate;', sb);
  return sb.__fn;
}

/* ---------------- static pins ---------------- */

test('pins: tier boundaries are 2027-04-26 and 2027-07-26, locked at signup', () => {
  const fn = evalTierFn();
  assert.equal(fn('2026-10-26'), 20, 'today (2026) → 20');
  assert.equal(fn('2027-04-25'), 20, '2027-04-25 → 20');
  assert.equal(fn('2027-04-26'), 10, '2027-04-26 → 10');
  assert.equal(fn('2027-07-25'), 10, '2027-07-25 → 10');
  assert.equal(fn('2027-07-26'), 5, '2027-07-26 → 5');
  assert.equal(fn('2028-01-01'), 5, 'later dates → 5');
  assert.equal(fn('2027-04-26 10:00:00'), 10, 'datetime strings use the date part');
});

test('pins: migration stores the rate, splitPayment reads the stored rate', () => {
  assert.ok(serverSrc.includes("addColumnIfMissing('recruiters', 'rate_pct', 'INTEGER NOT NULL DEFAULT 20')"),
    'recruiters.rate_pct migration, existing rows backfill 20');
  const sp = serverSrc.slice(serverSrc.indexOf('function splitPayment('), serverSrc.indexOf('/* ---------------- fan spending'));
  assert.ok(sp.includes('r.rate_pct'), 'splitPayment selects the stored rate_pct');
  assert.ok(sp.includes('Math.round(grossCents * pct / 100)'), 'recruiter cut = gross * stored pct');
  assert.ok(sp.includes('Math.min(platformCents,'), 'recruiter cut is capped at the platform slice');
  assert.ok(!sp.includes('platformCents / 2'), 'no hard-coded half-platform recruiter cut remains in splitPayment');
});

test('pins: every recruiter creation path stores the signup-tier rate', () => {
  const inserts = [...serverSrc.matchAll(/INSERT INTO recruiters \([^)]+\)/g)].map((m) => m[0]);
  assert.ok(inserts.length >= 3, `recruiters inserts found: ${inserts.length}`);
  for (const ins of inserts) assert.ok(ins.includes('rate_pct'), `insert stores rate_pct: ${ins}`);
  assert.ok(serverSrc.includes('recruiterRatePctForSignupDate(new Date().toISOString())'),
    'signup inserts compute the tier from the signup date');
});

test('pins: agreement bumps to R1.4 and EN §4 states the schedule', () => {
  assert.ok(serverSrc.includes("const RECRUITER_CONTRACT_VERSION = 'R1.4';"), 'agreement version is R1.4');
  assert.ok(!serverSrc.includes("const RECRUITER_CONTRACT_VERSION = 'R1.3';"), 'old version R1.3 is gone');
  const s4 = serverSrc.slice(serverSrc.indexOf("title: '4. Your Cut'"), serverSrc.indexOf("title: '5. Termination"));
  assert.ok(s4.includes('20% if you sign up before April 26, 2027'), '§4: 20% tier stated');
  assert.ok(s4.includes('10% if you sign up April 26, 2027 through July 25, 2027'), '§4: 10% tier stated');
  assert.ok(s4.includes('5% if you sign up on or after July 26, 2027'), '§4: 5% tier stated');
  assert.ok(s4.includes('locked at signup and never changes'), '§4: locked at signup');
  assert.ok(s4.includes('model keeps her full 60%'), '§4: model keeps 60%');
});

test('pins: dashboard, contract, and Manager rows carry the locked rate', () => {
  assert.ok(serverSrc.includes('rate_pct: r.rate_pct == null ? 20 : Number(r.rate_pct)'),
    'recruiter dashboard carries rate_pct');
  assert.ok(serverSrc.includes('recruiter_rate_pct:'), 'contract endpoint carries the locked rate');
  assert.ok(serverSrc.includes('SELECT r.id, r.name, r.city, r.referral_code, r.created_at, r.rate_pct,'),
    'admin recruiters list carries rate_pct');
  assert.ok(managerSrc.includes('Locked rate:'), 'Manager affiliates row displays the locked rate');
  assert.ok(managerSrc.includes('locked rate ${p.rate_pct'), 'Manager partners row displays the locked rate');
  assert.ok(appSrc.includes('Locked recruiter rate:'), 'recruiter dashboard UI displays the locked rate');
  const en4 = appSrc.slice(appSrc.indexOf("['4. Your Cut'"), appSrc.indexOf("['4. Your Cut'") + 600);
  assert.ok(en4.includes('20% before April 26, 2027'), 'signup summary EN §4 states the 20% tier');
  assert.ok(en4.includes('10% April 26, 2027 through July 25, 2027'), 'signup summary EN §4 states the 10% tier');
  assert.ok(en4.includes('5% on or after July 26, 2027'), 'signup summary EN §4 states the 5% tier');
});

/* ---------------- harness (same pattern as other suites) ---------------- */

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-recruiter-stepdown-'));
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
  const deadline = Date.now() + 30000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode})\n${log}`);
    try { const r = await fetch(base + '/api/health'); if (r.ok) break; } catch (_) {}
    if (Date.now() > deadline) { child.kill('SIGKILL'); throw new Error(`server did not come up\n${log}`); }
    await new Promise((r) => setTimeout(r, 150));
  }
  return { child, base, log: () => log };
}
function stop(h) { if (h && h.child && h.child.exitCode === null) h.child.kill('SIGKILL'); }
async function req(base, method, p, { body, token, headers } = {}) {
  const h = { 'content-type': 'application/json', ...(headers || {}) };
  if (token) h.authorization = 'Bearer ' + token;
  const r = await fetch(base + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null; try { data = await r.json(); } catch (_) {}
  return { status: r.status, data };
}
function withDb(dir, fn) {
  const db = new DatabaseSync(path.join(dir, 'wogent-chat.db'));
  db.exec('PRAGMA busy_timeout = 10000');
  try { return fn(db); } finally { db.close(); }
}
async function signup(base, username, role, extra = {}) {
  const r = await req(base, 'POST', '/api/auth/signup', {
    body: { username, password: 'hunter22', role, display_name: username, dob: '1995-04-01', agree18: true,
            ...(role === 'model' ? { section: 'female', publicity_consent: true } : {}), ...extra },
  });
  assert.equal(r.status, 200, `signup ${username}: ${JSON.stringify(r.data)}`);
  return { token: r.data.token, id: r.data.user.id, username };
}
async function affiliateSignup(base, username) {
  const r = await req(base, 'POST', '/api/affiliate/signup', {
    body: { username, password: 'hunter22', display_name: username, agreed: true } });
  assert.equal(r.status, 200, `affiliate signup ${username}: ${JSON.stringify(r.data)}`);
  return { token: r.data.token, id: r.data.user.id, username };
}
async function tip(base, fanToken, modelUserId, amountCents) {
  const start = await req(base, 'POST', '/api/conversations/start', { token: fanToken, body: { model_id: modelUserId } });
  assert.equal(start.status, 200, `conversation start: ${JSON.stringify(start.data)}`);
  const t = await req(base, 'POST', '/api/tips', { token: fanToken, body: { conversation_id: start.data.conversation.id, amount_cents: amountCents } });
  assert.equal(t.status, 200, `tip: ${JSON.stringify(t.data)}`);
  return t;
}

test('live: stored rate drives the split, grandfathered 20% untouched, agreement is R1.4', { timeout: 180000 }, async (t) => {
  const dir = makeCopy();
  const h = await boot(dir, { SEED_DEMO: '1' });
  t.after(() => { stop(h); try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });
  const { base } = h;

  const mgr = await req(base, 'POST', '/api/manager/login', { body: { username: 'admin', password: 'admin123' } });
  assert.equal(mgr.status, 200, `manager login: ${JSON.stringify(mgr.data)}`);
  const mgrHeaders = { headers: { 'x-manager': '1' }, token: mgr.data.token };

  const fan = await signup(base, 'stepfan', 'fan');
  const grant = await req(base, 'POST', `/api/admin/fans/${fan.id}/credits`, { ...mgrHeaders, body: { amount_cents: 100000 } });
  assert.equal(grant.status, 200, `grant credits: ${JSON.stringify(grant.data)}`);

  const rec = await affiliateSignup(base, 'steorec');
  let dash = await req(base, 'GET', '/api/recruiter/dashboard', { token: rec.token });
  assert.equal(dash.status, 200);
  assert.equal(dash.data.recruiter.rate_pct, 20, 'a signup today locks 20%');
  const code = dash.data.recruiter.referral_code;

  const contract = await req(base, 'GET', '/api/recruiter/contract', { token: rec.token });
  assert.equal(contract.status, 200);
  assert.equal(contract.data.version, 'R1.4', 'served agreement is R1.4');
  assert.equal(contract.data.signed_version, 'R1.4', 'new signup auto-signs R1.4');
  assert.equal(contract.data.recruiter_rate_pct, 20, 'contract endpoint carries the locked rate');
  const s4 = contract.data.sections.find((s) => s.title.startsWith('4.'));
  assert.ok(s4 && s4.body.includes('April 26, 2027'), 'served §4 states the step-down schedule');

  const model = await signup(base, 'stepmodel', 'model', { referral_code: code });
  dash = await req(base, 'GET', '/api/recruiter/dashboard', { token: rec.token });
  assert.equal(dash.data.model_count, 1, 'model attributed through the link');

  // 20% tier: $10 gross → model $6, platform $2 after recruiter $2.
  await tip(base, fan.token, model.id, 1000);
  dash = await req(base, 'GET', '/api/recruiter/dashboard', { token: rec.token });
  assert.equal(dash.data.earnings_cents, 200, '20% of $10 gross = $2 recruiter cut');
  let txn = withDb(dir, (db) => db.prepare('SELECT model_cents, platform_cents, recruiter_cents FROM transactions WHERE model_id = ? ORDER BY id DESC LIMIT 1').get(model.id));
  assert.deepEqual([txn.model_cents, txn.platform_cents, txn.recruiter_cents], [600, 200, 200],
    'model keeps 60%, platform keeps the rest after the recruiter cut');

  // Simulate a 10% locked recruiter: only the stored rate changes, nothing else.
  withDb(dir, (db) => db.prepare('UPDATE recruiters SET rate_pct = 10 WHERE user_id = ?').run(rec.id));
  dash = await req(base, 'GET', '/api/recruiter/dashboard', { token: rec.token });
  assert.equal(dash.data.recruiter.rate_pct, 10, 'dashboard shows the stored 10%');
  await tip(base, fan.token, model.id, 1000);
  dash = await req(base, 'GET', '/api/recruiter/dashboard', { token: rec.token });
  assert.equal(dash.data.earnings_cents, 300, '10% of the next $10 gross = $1 more');
  txn = withDb(dir, (db) => db.prepare('SELECT model_cents, platform_cents, recruiter_cents FROM transactions WHERE model_id = ? ORDER BY id DESC LIMIT 1').get(model.id));
  assert.deepEqual([txn.model_cents, txn.platform_cents, txn.recruiter_cents], [600, 300, 100],
    'at 10%, platform keeps 30% and the model still keeps 60%');

  // Simulate a 5% locked recruiter.
  withDb(dir, (db) => db.prepare('UPDATE recruiters SET rate_pct = 5 WHERE user_id = ?').run(rec.id));
  await tip(base, fan.token, model.id, 1000);
  dash = await req(base, 'GET', '/api/recruiter/dashboard', { token: rec.token });
  assert.equal(dash.data.earnings_cents, 350, '5% of the next $10 gross = $0.50 more');
  txn = withDb(dir, (db) => db.prepare('SELECT model_cents, platform_cents, recruiter_cents FROM transactions WHERE model_id = ? ORDER BY id DESC LIMIT 1').get(model.id));
  assert.deepEqual([txn.model_cents, txn.platform_cents, txn.recruiter_cents], [600, 350, 50],
    'at 5%, platform keeps 35% and the model still keeps 60%');

  // Grandfathering: a second recruiter, created today, still pays 20% — the
  // first recruiter's stored rate change did not move a global constant.
  const rec2 = await affiliateSignup(base, 'steorec2');
  const dash2a = await req(base, 'GET', '/api/recruiter/dashboard', { token: rec2.token });
  assert.equal(dash2a.data.recruiter.rate_pct, 20, 'second recruiter locks 20%');
  const model2 = await signup(base, 'stepmodel2', 'model', { referral_code: dash2a.data.recruiter.referral_code });
  await tip(base, fan.token, model2.id, 1000);
  const dash2b = await req(base, 'GET', '/api/recruiter/dashboard', { token: rec2.token });
  assert.equal(dash2b.data.earnings_cents, 200, 'second recruiter still earns 20% of gross');

  // Manager rows carry the locked rates.
  const partners = await req(base, 'GET', '/api/admin/recruiters', mgrHeaders);
  assert.equal(partners.status, 200, `admin recruiters: ${JSON.stringify(partners.data)}`);
  const byUser = new Map(partners.data.recruiters.map((r) => [r.user_id, r]));
  assert.equal(byUser.get(rec.id).rate_pct, 5, 'admin partners row shows the first recruiter at 5%');
  assert.equal(byUser.get(rec2.id).rate_pct, 20, 'admin partners row shows the second recruiter at 20%');

  // Served Manager JS renders the locked-rate lines.
  const jsResp = await fetch(base + '/manager/manager.js');
  assert.equal(jsResp.status, 200);
  const jsText = await jsResp.text();
  assert.ok(jsText.includes('Locked rate:'), 'served manager.js renders Locked rate');
});
