'use strict';
/*
 * Self-serve affiliate signup tests — the entry screen's Affiliate tab
 * (owner request, Oct 16 2026): Sign up gains a third role card next to
 * Fan/Model. POST /api/affiliate/signup creates a recruiter with NO
 * invite code, reusing the exact creation path of the Manager
 * affiliate-invite signup (createRecruiterAccount): agreement
 * auto-signed at the current version, 18+ attestation recorded (never
 * a fake DOB), and a recruiters row whose referral_code is her
 * partner link (#join/CODE attributes model signups to her).
 *
 * Pins: (1) signup → recruiter with signed agreement + partner code,
 * and a model joining through her code is attributed to her;
 * (2) unified login works and recruiter-only endpoints open for her
 * but 403 for a fan; (3) validations mirror the invite flow
 * (duplicate username 409, no agreement 400 must_agree — the invite
 * flow's attestation gate — short password/missing fields 400);
 * (4) the Manager invite-code signup still works end to end;
 * (5) source pins for the entry tab + route wiring.
 *
 * Temp-copy boot harness, same pattern as the other suites.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const REPO = path.join(__dirname, '..');

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-affsignup-'));
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

function readDb(dir, readOnly = true) {
  const __db = new DatabaseSync(path.join(dir, 'wogent-chat.db'), { readOnly });
  __db.exec('PRAGMA busy_timeout = 10000');
  return __db;
}

test('source pins: Affiliate role card + form wired to POST /api/affiliate/signup', () => {
  const app = fs.readFileSync(path.join(REPO, 'public/js/app.js'), 'utf8');
  const srv = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
  // Entry role chooser: third card, same role-card UI, honest pitch keys
  assert.ok(app.includes('id="r-aff"'), 'affiliate role card present');
  assert.ok(app.includes("t('im_affiliate')"), 'affiliate card label via i18n');
  assert.ok(app.includes("t('affiliate_desc')"), 'affiliate card pitch via i18n');
  assert.ok(app.includes("t('aff_join_sub')"), 'affiliate form pitch via i18n');
  assert.ok(!app.includes('20% of what she makes'), 'dishonest affiliate line absent');
  // The form posts to the new route and shares the agreement sections
  assert.ok(app.includes("api('/affiliate/signup'"), 'form posts to /api/affiliate/signup');
  assert.ok(app.includes('AFFILIATE_AGREEMENT_SECTIONS'), 'shared agreement sections used');
  assert.ok(app.includes('function renderSignupFields'), 'role fields renderer present');
  assert.ok(app.includes('function doAffiliateSignup'), 'affiliate submit handler present');
  // i18n: the new keys exist in all three locales
  for (const key of ['im_affiliate', 'affiliate_desc', 'aff_join_sub']) {
    const n = app.split(`${key}:`).length - 1;
    assert.ok(n >= 3, `${key} defined for en/es/pt (found ${n})`);
  }
  // Server: the route exists and BOTH signup paths share one creation helper
  assert.ok(srv.includes("app.post('/api/affiliate/signup'"), 'self-serve route registered');
  assert.ok(srv.includes('function createRecruiterAccount('), 'shared creation helper exists');
  assert.ok((srv.match(/= createRecruiterAccount\(uname, dname, pwd, req\)/g) || []).length === 2,
    'invite + self-serve routes both call the shared helper');
});

test('self-serve affiliate signup: recruiter created, agreement signed, partner code attributes models', async () => {
  const dir = makeCopy();
  try {
    const h = await boot(dir);
    try {
      // --- validations mirror the invite flow ---
      let r = await req(h.base, 'POST', '/api/affiliate/signup', {
        body: { username: 'affgal', password: 'hunter22', display_name: 'Aff Gal', agreed: false } });
      assert.equal(r.status, 400); assert.equal(r.data.error, 'must_agree');
      r = await req(h.base, 'POST', '/api/affiliate/signup', {
        body: { username: 'affgal', password: 'hunter22', display_name: 'Aff Gal' } });
      assert.equal(r.status, 400); assert.equal(r.data.error, 'must_agree');
      r = await req(h.base, 'POST', '/api/affiliate/signup', {
        body: { username: 'affgal', password: 'short', display_name: 'Aff Gal', agreed: true } });
      assert.equal(r.status, 400); assert.equal(r.data.error, 'missing_fields');
      r = await req(h.base, 'POST', '/api/affiliate/signup', {
        body: { username: 'affgal', password: 'hunter22', agreed: true } });
      assert.equal(r.status, 400); assert.equal(r.data.error, 'missing_fields');

      // --- the signup itself ---
      r = await req(h.base, 'POST', '/api/affiliate/signup', {
        body: { username: 'affgal', password: 'hunter22', display_name: 'Aff Gal', agreed: true } });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      assert.equal(r.data.ok, true);
      assert.equal(r.data.user.role, 'recruiter');
      const affToken = r.data.token;
      assert.ok(affToken, 'session token issued');

      // duplicate username refused, same as the invite flow
      r = await req(h.base, 'POST', '/api/affiliate/signup', {
        body: { username: 'affgal', password: 'hunter22', display_name: 'Copy Cat', agreed: true } });
      assert.equal(r.status, 409); assert.equal(r.data.error, 'username_taken');

      // --- agreement already signed at the current version ---
      r = await req(h.base, 'GET', '/api/recruiter/contract', { token: affToken });
      assert.equal(r.status, 200);
      assert.equal(r.data.version, 'R1.3');
      assert.equal(r.data.signed, true);
      assert.equal(r.data.signed_version, 'R1.3');

      // --- partner code provisioned + visible on the dashboard ---
      r = await req(h.base, 'GET', '/api/recruiter/dashboard', { token: affToken });
      assert.equal(r.status, 200);
      const code = r.data.recruiter.referral_code;
      assert.match(code, /^[a-f0-9]{8}$/);
      assert.equal(r.data.model_count, 0);

      // the public partner-link validation resolves her code
      r = await req(h.base, 'GET', `/api/referral/${code}`);
      assert.equal(r.data.valid, true);
      assert.equal(r.data.recruiter_name, 'Aff Gal');

      // --- a model joining through #join/CODE is attributed to her ---
      r = await req(h.base, 'POST', '/api/auth/signup', {
        body: { username: 'modelgal', password: 'hunter22', role: 'model',
                display_name: 'Model Gal', dob: '1995-04-01', agree18: true, section: 'female',
                referral_code: code } });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      assert.equal(r.data.user.role, 'model');
      r = await req(h.base, 'GET', '/api/recruiter/dashboard', { token: affToken });
      assert.equal(r.data.model_count, 1);
      assert.equal(r.data.models[0].username, 'modelgal');

      // --- unified login: same username+password, recruiter doors open ---
      r = await req(h.base, 'POST', '/api/auth/login', {
        body: { username: 'affgal', password: 'hunter22' } });
      assert.equal(r.status, 200);
      assert.equal(r.data.user.role, 'recruiter');
      const loginToken = r.data.token;
      r = await req(h.base, 'GET', '/api/recruiter/contract', { token: loginToken });
      assert.equal(r.status, 200);

      // --- a fan is refused at the recruiter-only endpoints ---
      r = await req(h.base, 'POST', '/api/auth/signup', {
        body: { username: 'fangal', password: 'hunter22', role: 'fan',
                display_name: 'Fan Gal', dob: '1995-04-01', agree18: true } });
      assert.equal(r.status, 200);
      const fanToken = r.data.token;
      r = await req(h.base, 'GET', '/api/recruiter/contract', { token: fanToken });
      assert.equal(r.status, 403);
      r = await req(h.base, 'GET', '/api/recruiter/dashboard', { token: fanToken });
      assert.equal(r.status, 403);
    } finally { stop(h); }

    // --- DB truth: attestation stored, no fake DOB, signature + link rows ---
    const db = readDb(dir);
    const u = db.prepare("SELECT * FROM users WHERE username = 'affgal'").get();
    assert.equal(u.role, 'recruiter');
    assert.equal(u.dob, null, 'no fake DOB stored');
    assert.ok(u.age_attested_at, '18+ attestation timestamp recorded');
    const rec = db.prepare('SELECT * FROM recruiters WHERE user_id = ?').get(u.id);
    assert.ok(rec && /^[a-f0-9]{8}$/.test(rec.referral_code), 'recruiters row with partner code');
    const sig = db.prepare('SELECT * FROM contract_signatures WHERE user_id = ?').get(u.id);
    assert.ok(sig && sig.contract_version === 'R1.3', 'agreement signature at current version');
    const m = db.prepare("SELECT * FROM models WHERE user_id = (SELECT id FROM users WHERE username = 'modelgal')").get();
    assert.equal(m.recruiter_id, rec.id, 'model attributed to the self-serve affiliate');
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('regression: Manager affiliate invite-code signup still works', async () => {
  const dir = makeCopy();
  const CODE = 'abcdef0123456789ab'; // 18-hex invite code, role 'recruiter'
  try {
    // Boot once so the schema exists, then issue an invite directly in
    // the DB (the Manager endpoint that does this is admin-gated and
    // covered elsewhere; the row shape is what the flow consumes).
    let h = await boot(dir);
    stop(h);
    let db = readDb(dir, false);
    const maker = db.prepare("SELECT id FROM users LIMIT 1").get();
    let createdBy = maker && maker.id;
    if (!createdBy) {
      const info = db.prepare(
        "INSERT INTO users (username, password_hash, role, display_name) VALUES ('boss', 'x', 'admin', 'Boss')"
      ).run();
      createdBy = Number(info.lastInsertRowid);
    }
    db.prepare("INSERT INTO invite_links (code, label, role, created_by, expires_at) VALUES (?, 'Test', 'recruiter', ?, datetime('now', '+6 hours'))")
      .run(CODE, createdBy);
    db.close();

    h = await boot(dir);
    try {
      let r = await req(h.base, 'GET', `/api/affiliate-invite/${CODE}`);
      assert.equal(r.data.valid, true);
      r = await req(h.base, 'POST', `/api/affiliate-invite/${CODE}/signup`, {
        body: { username: 'invgal', password: 'hunter22', display_name: 'Inv Gal', agreed: true } });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      assert.equal(r.data.user.role, 'recruiter');
      const invToken = r.data.token;
      r = await req(h.base, 'GET', '/api/recruiter/dashboard', { token: invToken });
      assert.equal(r.status, 200);
      assert.match(r.data.recruiter.referral_code, /^[a-f0-9]{8}$/);
      // code is spent now
      r = await req(h.base, 'GET', `/api/affiliate-invite/${CODE}`);
      assert.equal(r.data.valid, false);
      r = await req(h.base, 'POST', `/api/affiliate-invite/${CODE}/signup`, {
        body: { username: 'invgal2', password: 'hunter22', display_name: 'Inv Two', agreed: true } });
      assert.equal(r.status, 400); assert.equal(r.data.error, 'bad_invite');
    } finally { stop(h); }

    db = readDb(dir);
    const inv = db.prepare('SELECT * FROM invite_links WHERE code = ?').get(CODE);
    const u = db.prepare("SELECT id FROM users WHERE username = 'invgal'").get();
    assert.equal(inv.used_by, u.id, 'invite marked used by the new recruiter');
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
