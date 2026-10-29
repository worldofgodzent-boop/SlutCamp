'use strict';
/*
 * Manager 🔗 Affiliates screen (owner request, Oct 17 2026: "add a
 * Affiliate section that keep track of how many affiliate signed up").
 *
 *  - GET /api/admin/affiliates — admin-only (X-Manager header + admin
 *    role + passkey step-up chain via ...adminOnly), READ-ONLY.
 *  - Headline stat = count of recruiter-role accounts; supporting
 *    stats: new in last 30 days, models onboarded via affiliate links
 *    (models.recruiter_id — the attribution splitPayment pays on),
 *    lifetime recruiter earnings from the ledger with the Manager's
 *    standard ruler (is_test = 0 + earning types, refunds netted).
 *  - Roster row per affiliate: signup date, models onboarded, §10
 *    quota progress (x / 10) + year-end date (signup + 1 year),
 *    lifetime earnings, banned flag. NO enforcement — the §10 review
 *    is a human year-end decision (agreement R1.3 §10).
 *  - Overview bubble (owner clarification, Oct 17 2026: "I want is
 *    in the bubble where I can see the numbers"): /api/admin/overview
 *    carries the SAME recruiter-role count as `affiliates`, rendered
 *    as an "Affiliates" stat tile in the Overview grid.
 *  - Actions (owner refinement #2, Oct 17 2026 — compact cards "like
 *    notification boxes" with resets, modeled on the Models screen):
 *    POST /api/admin/affiliates/:id/username + /:id/password.
 *    Rename is attribution-safe (models key on recruiters.id, the
 *    link is recruiters.referral_code); password reset mirrors the
 *    model flow (bcrypt(10), min 6, generated temp when blank,
 *    deleteUserSessions). Username uniqueness is sitewide +
 *    case-insensitive; a refusal changes nothing ("Username is taken").
 *  - One-account extension (PR #45, folded in at ship): an affiliate
 *    is a capability — merged_into IS NULL AND (role='recruiter' OR a
 *    recruiters row). Merged models count ONCE with combined numbers,
 *    retired duplicates never appear and are refused as reset
 *    targets, and the §10 window runs off recruiters.created_at.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');

const REPO = path.join(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
const managerSrc = fs.readFileSync(path.join(REPO, 'public/manager/manager.js'), 'utf8');

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-affadmin-'));
  for (const d of ['server.js', 'package.json', 'lib', 'public', 'data']) {
    fs.cpSync(path.join(REPO, d), path.join(dir, d), { recursive: true });
  }
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  return dir;
}

async function boot(dir, extraEnv) {
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
  const deadline = Date.now() + 60000;
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

async function req(base, method, p, { body, token, headers } = {}) {
  const h = { ...(headers || {}) };
  let payload;
  if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  if (token) h.authorization = 'Bearer ' + token;
  const r = await fetch(base + p, { method, headers: h, body: payload });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not json */ }
  return { status: r.status, json, text };
}

const mgrLogin = async (base) => {
  const adm = await req(base, 'POST', '/api/manager/login', { body: { username: 'admin', password: 'admin123' } });
  assert.equal(adm.status, 200, `manager login: ${adm.text}`);
  return { token: adm.json.token, headers: { 'x-manager': '1' } };
};

const sqlTs = (d) => d.toISOString().slice(0, 19).replace('T', ' ');

/* Seed two affiliates directly into the DB of a once-booted copy:
   Alpha — signed up 2026-03-04, 3 models onboarded, $7.50 net earnings.
   Beta  — signed up 5 days ago, 0 models, no earnings, banned (removed). */
function seedAffiliates(dir) {
  const db = new DatabaseSync(path.join(dir, 'wogent-chat.db'));
  db.exec('PRAGMA busy_timeout = 10000');
  try {
    // The one-time play-money cleanup already ran in production; make
    // sure its boot stamp is set so later boots never re-audit these
    // seeded ledger rows.
    db.prepare(`UPDATE platform_stats SET play_money_zeroed_at = datetime('now')
                WHERE id = 1 AND play_money_zeroed_at IS NULL`).run();
    const fan = db.prepare("SELECT id FROM users WHERE username = 'fandemo'").get();
    assert.ok(fan, 'seed fan exists');

    const insUser = db.prepare(
      'INSERT INTO users (username, password_hash, role, display_name, dob, banned, created_at) VALUES (?,?,?,?,?,?,?)');
    const alphaId = Number(insUser.run('aff_alpha', bcrypt.hashSync('alpha-pass-123', 10), 'recruiter', 'Alpha Recruiter', null, 0, '2026-03-04 05:06:07').lastInsertRowid);
    const betaTs = sqlTs(new Date(Date.now() - 5 * 86400e3));
    const betaId = Number(insUser.run('aff_beta', bcrypt.hashSync('beta-pass-123', 10), 'recruiter', 'Beta Recruiter', null, 1, betaTs).lastInsertRowid);
    const insRec = db.prepare(
      'INSERT INTO recruiters (user_id, name, city, referral_code, created_at) VALUES (?,?,?,?,?)');
    const alphaRec = Number(insRec.run(alphaId, 'Alpha Recruiter', 'Austin', 'alpha123', '2026-03-04 05:06:07').lastInsertRowid);
    const betaRec = Number(insRec.run(betaId, 'Beta Recruiter', '', 'beta456', betaTs).lastInsertRowid);
    // Every real account gets a wallet at creation (createUser /
    // createRecruiterAccount) — mirror that or the recruiter
    // dashboard (which reads the wallet) 500s.
    const insWallet = db.prepare('INSERT INTO wallets (user_id) VALUES (?)');
    insWallet.run(alphaId);
    insWallet.run(betaId);

    const insModelUser = db.prepare(
      "INSERT INTO users (username, password_hash, role, display_name, dob, created_at) VALUES (?, 'x', 'model', ?, NULL, '2026-04-01 00:00:00')");
    const insModel = db.prepare('INSERT INTO models (user_id, recruiter_id) VALUES (?,?)');
    const alphaModels = [];
    for (const n of ['affm_one', 'affm_two', 'affm_three']) {
      const uid = Number(insModelUser.run(n, n).lastInsertRowid);
      insModel.run(uid, alphaRec);
      insWallet.run(uid);
      alphaModels.push(uid);
    }
    const soloUid = Number(insModelUser.run('affm_solo', 'affm_solo').lastInsertRowid);
    insModel.run(soloUid, null); // unattributed model — never counts
    insWallet.run(soloUid);

    const insTxn = db.prepare(
      `INSERT INTO transactions (fan_id, model_id, type, gross_cents, model_cents, platform_cents, recruiter_id, recruiter_cents, is_test)
       VALUES (?,?,?,?,?,?,?,?,?)`);
    insTxn.run(fan.id, alphaModels[0], 'message', 2500, 1500, 500, alphaRec, 500, 0);
    insTxn.run(fan.id, alphaModels[1], 'call', 1250, 750, 250, alphaRec, 250, 0);
    insTxn.run(fan.id, alphaModels[2], 'tip', 500, 300, 100, alphaRec, 100, 0);
    insTxn.run(fan.id, alphaModels[0], 'tip', -500, -300, -100, alphaRec, -100, 0); // refund nets out
    insTxn.run(fan.id, alphaModels[0], 'message', 3885, 2331, 777, alphaRec, 777, 1); // test money — excluded
    insTxn.run(fan.id, alphaModels[0], 'chargeback', -999, 0, 0, alphaRec, 999, 0); // non-earning type — excluded
    insTxn.run(fan.id, soloUid, 'message', 1000, 600, 400, null, 0, 0); // no recruiter — excluded
    return { alphaId, betaId, alphaRec, betaRec, betaTs, alphaModels, fanId: fan.id, soloUid };
  } finally {
    db.close();
  }
}

test('affiliates endpoint: auth gates (manager header + admin role)', async () => {
  const dir = makeCopy();
  const h = await boot(dir, { SEED_DEMO: '1' });
  try {
    // No session at all → 401.
    const anon = await req(h.base, 'GET', '/api/admin/affiliates', { headers: { 'x-manager': '1' } });
    assert.equal(anon.status, 401, 'anonymous rejected');

    const mgr = await mgrLogin(h.base);
    // Admin token WITHOUT the X-Manager header → 403 manager_only.
    const noHeader = await req(h.base, 'GET', '/api/admin/affiliates', { token: mgr.token });
    assert.equal(noHeader.status, 403, 'missing X-Manager header rejected');
    assert.equal(noHeader.json.error, 'manager_only');

    // Fan token WITH the header → 403 (not an admin).
    const fanSignup = await req(h.base, 'POST', '/api/auth/signup', {
      body: { username: 'afffan_gate', password: 'afffan-pass-123', role: 'fan',
        display_name: 'afffan_gate', dob: '1995-05-05', agree18: true },
    });
    assert.equal(fanSignup.status, 200, `fan signup: ${fanSignup.text}`);
    const fanTry = await req(h.base, 'GET', '/api/admin/affiliates',
      { token: fanSignup.json.token, headers: { 'x-manager': '1' } });
    assert.equal(fanTry.status, 403, 'fan cannot read affiliates');

    // Proper manager call on an empty roster → 200 with zeroed stats.
    const empty = await req(h.base, 'GET', '/api/admin/affiliates', { ...mgr });
    assert.equal(empty.status, 200, `manager call: ${empty.text}`);
    assert.equal(empty.json.stats.total_affiliates, 0);

    // The Overview payload carries the same count for its stat bubble.
    const ovEmpty = await req(h.base, 'GET', '/api/admin/overview', { ...mgr });
    assert.equal(ovEmpty.status, 200, `overview: ${ovEmpty.text}`);
    assert.equal(ovEmpty.json.affiliates, 0, 'overview bubble starts at 0');
    assert.equal(empty.json.stats.new_last_30_days, 0);
    assert.equal(empty.json.stats.models_onboarded, 0);
    assert.equal(empty.json.stats.recruiter_earnings_cents, 0);
    assert.deepEqual(empty.json.affiliates, []);
  } finally {
    stop(h);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('affiliates endpoint: counts, quota math, earnings ruler, roster shape', async () => {
  const dir = makeCopy();
  const h1 = await boot(dir, { SEED_DEMO: '1' });
  stop(h1);
  const seeded = seedAffiliates(dir);
  const h = await boot(dir, { SEED_DEMO: '1' });
  try {
    const mgr = await mgrLogin(h.base);
    const r = await req(h.base, 'GET', '/api/admin/affiliates', { ...mgr });
    assert.equal(r.status, 200, `affiliates: ${r.text}`);
    const { stats, affiliates } = r.json;

    // The Overview bubble reads the SAME count (one source of truth).
    const ov = await req(h.base, 'GET', '/api/admin/overview', { ...mgr });
    assert.equal(ov.status, 200, `overview: ${ov.text}`);
    assert.equal(ov.json.affiliates, 2, 'overview payload affiliates count matches');

    // Headline + supporting stats.
    assert.equal(stats.total_affiliates, 2, 'two recruiter-role accounts');
    assert.equal(stats.new_last_30_days, 1, 'only Beta signed up in the last 30 days');
    assert.equal(stats.models_onboarded, 3, 'three models attributed to a recruiter');
    assert.equal(stats.recruiter_earnings_cents, 750, 'ledger earnings: 500+250+100−100 refund; test + chargeback-type rows excluded');

    // Roster: newest signup first.
    assert.equal(affiliates.length, 2);
    const [beta, alpha] = affiliates;
    assert.equal(beta.username, 'aff_beta', 'newest first');
    assert.equal(alpha.username, 'aff_alpha');

    // Alpha: quota progress + year-end math + earnings.
    assert.equal(alpha.recruiter_id, seeded.alphaRec);
    assert.equal(alpha.referral_code, 'alpha123');
    // Refinement #3: every roster row carries the username AND her
    // full shareable link (origin + '/#join/' + code, exactly as her
    // own dashboard builds it) so the card can print both for a
    // locked-out affiliate.
    assert.equal(alpha.username, 'aff_alpha');
    assert.equal(alpha.referral_link, 'https://slutcamp.app/#join/alpha123');
    assert.equal(alpha.signed_up_at, '2026-03-04 05:06:07');
    assert.equal(alpha.models_onboarded, 3);
    assert.equal(alpha.quota_target, 10);
    assert.equal(alpha.quota_met, false);
    assert.equal(alpha.year_end, '2027-03-04', 'year end = signup + 1 year');
    assert.equal(alpha.earnings_cents, 750);
    assert.equal(alpha.banned, false);

    // Beta: banned surfaces, zero counts, her own year-end + link.
    assert.equal(beta.username, 'aff_beta');
    assert.equal(beta.referral_link, 'https://slutcamp.app/#join/beta456');
    assert.equal(beta.banned, true, 'stored banned flag surfaces as status');
    assert.equal(beta.models_onboarded, 0);
    assert.equal(beta.earnings_cents, 0);
    const betaYearEnd = new Date(seeded.betaTs.replace(' ', 'T') + 'Z');
    betaYearEnd.setUTCFullYear(betaYearEnd.getUTCFullYear() + 1);
    assert.equal(beta.year_end, betaYearEnd.toISOString().slice(0, 10));
  } finally {
    stop(h);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('affiliates actions: username + password reset (recruiter-only, attribution-safe)', async () => {
  const dir = makeCopy();
  const h1 = await boot(dir, { SEED_DEMO: '1' });
  stop(h1);
  const seeded = seedAffiliates(dir);
  const h = await boot(dir, { SEED_DEMO: '1' });
  try {
    const mgr = await mgrLogin(h.base);
    const login = (username, password) => req(h.base, 'POST', '/api/auth/login', { body: { username, password } });
    const setUsername = (id, username, opts = mgr) =>
      req(h.base, 'POST', `/api/admin/affiliates/${id}/username`, { ...opts, body: { username } });
    const setPassword = (id, body, opts = mgr) =>
      req(h.base, 'POST', `/api/admin/affiliates/${id}/password`, { ...opts, body });

    // Auth gates on the actions: fan token + header → 403; no header → 403.
    const fanSignup = await req(h.base, 'POST', '/api/auth/signup', {
      body: { username: 'afffan_act', password: 'afffan-pass-123', role: 'fan',
        display_name: 'afffan_act', dob: '1995-05-05', agree18: true },
    });
    assert.equal(fanSignup.status, 200, `fan signup: ${fanSignup.text}`);
    const fanTry = await setUsername(seeded.alphaId, 'whatever',
      { token: fanSignup.json.token, headers: { 'x-manager': '1' } });
    assert.equal(fanTry.status, 403, 'fan cannot rename an affiliate');
    const noHeader = await req(h.base, 'POST', `/api/admin/affiliates/${seeded.alphaId}/password`,
      { token: mgr.token, body: { password: 'whatever-123' } });
    assert.equal(noHeader.status, 403, 'missing X-Manager header rejected on actions');
    assert.equal(noHeader.json.error, 'manager_only');

    // Non-recruiter targets are refused (model, fan, missing id) on BOTH actions.
    for (const target of [seeded.alphaModels[0], seeded.fanId, 999999]) {
      const ru = await setUsername(target, 'newname');
      assert.equal(ru.status, 404, `username reset refuses non-recruiter ${target}`);
      const rp = await setPassword(target, { password: 'whatever-123' });
      assert.equal(rp.status, 404, `password reset refuses non-recruiter ${target}`);
    }

    // Username validation: empty → 400; duplicates → 409 (case-insensitive).
    const empty = await setUsername(seeded.alphaId, '   ');
    assert.equal(empty.status, 400);
    assert.equal(empty.json.error, 'username_required');
    const dupSeed = await setUsername(seeded.betaId, 'FANDEMO');
    assert.equal(dupSeed.status, 409, 'case-insensitive clash with a seed user');
    assert.equal(dupSeed.json.error, 'username_taken');
    const dupPeer = await setUsername(seeded.betaId, 'AFF_ALPHA');
    assert.equal(dupPeer.status, 409, 'case-insensitive clash with another affiliate');
    // On refusal NOTHING changes — Beta keeps her username, models, earnings.
    const afterRefusals = await req(h.base, 'GET', '/api/admin/affiliates', { ...mgr });
    const betaRow0 = afterRefusals.json.affiliates.find((a) => a.user_id === seeded.betaId);
    assert.equal(betaRow0.username, 'aff_beta', 'refused renames leave the username untouched');
    assert.equal(betaRow0.models_onboarded, 0);
    assert.equal(betaRow0.earnings_cents, 0);

    // Rename Alpha → attribution, link and earnings untouched.
    const renamed = await setUsername(seeded.alphaId, 'AlphaNew');
    assert.equal(renamed.status, 200, `rename: ${renamed.text}`);
    assert.deepEqual(renamed.json, { ok: true, username: 'AlphaNew' });
    const after = await req(h.base, 'GET', '/api/admin/affiliates', { ...mgr });
    const alphaRow = after.json.affiliates.find((a) => a.user_id === seeded.alphaId);
    assert.equal(alphaRow.username, 'AlphaNew');
    assert.equal(alphaRow.models_onboarded, 3, 'onboarded count unchanged after rename');
    assert.equal(alphaRow.earnings_cents, 750, 'earnings unchanged after rename');
    assert.equal(alphaRow.referral_code, 'alpha123', 'referral link code unchanged after rename');

    // She logs in with the NEW username + her existing password.
    const loginNew = await login('AlphaNew', 'alpha-pass-123');
    assert.equal(loginNew.status, 200, `login with new username: ${loginNew.text}`);
    const oldToken = loginNew.json.token;
    const dashBefore = await req(h.base, 'GET', '/api/recruiter/dashboard', { token: oldToken });
    assert.equal(dashBefore.status, 200, 'recruiter session works before password reset');
    assert.equal(dashBefore.json.model_count, 3, 'her dashboard still shows her 3 models');

    // Password reset: too short → 400; real reset → old sessions die,
    // old password fails, new password logs in.
    const short = await setPassword(seeded.alphaId, { password: 'abc' });
    assert.equal(short.status, 400);
    assert.equal(short.json.error, 'password_too_short');
    const reset = await setPassword(seeded.alphaId, { password: 'brand-new-pass' });
    assert.equal(reset.status, 200, `password reset: ${reset.text}`);
    assert.deepEqual(reset.json, { ok: true, generated: false });
    const dashAfter = await req(h.base, 'GET', '/api/recruiter/dashboard', { token: oldToken });
    assert.equal(dashAfter.status, 401, 'pre-reset session invalidated (mirrors model reset)');
    const loginOld = await login('AlphaNew', 'alpha-pass-123');
    assert.equal(loginOld.status, 401, 'old password no longer works');
    const loginBrandNew = await login('AlphaNew', 'brand-new-pass');
    assert.equal(loginBrandNew.status, 200, 'new password logs in');

    // Generated temp path (no password sent) — mirrors the model flow.
    const gen = await setPassword(seeded.betaId, {});
    assert.equal(gen.status, 200, `generated reset: ${gen.text}`);
    assert.equal(gen.json.generated, true);
    assert.ok(typeof gen.json.password === 'string' && gen.json.password.length >= 6, 'temp password returned');
    const db = new DatabaseSync(path.join(dir, 'wogent-chat.db'), { readOnly: true });
    const betaHash = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(seeded.betaId).password_hash;
    db.close();
    assert.ok(bcrypt.compareSync(gen.json.password, betaHash), 'temp password matches the stored hash');
  } finally {
    stop(h);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* Seed the post-one-account (PR #45) end state: a MODEL account that
   holds the affiliate capability (recruiters row created EARLIER than
   her model account — a merge preserves the earlier affiliate start),
   plus her retired standalone affiliate duplicate (merged_into →
   survivor, banned, status 'merged', no recruiters row of its own —
   attribution/ledger were repointed to the survivor at merge). */
function seedCapabilityPair(dir) {
  const db = new DatabaseSync(path.join(dir, 'wogent-chat.db'));
  db.exec('PRAGMA busy_timeout = 10000');
  try {
    db.prepare(`UPDATE platform_stats SET play_money_zeroed_at = datetime('now')
                WHERE id = 1 AND play_money_zeroed_at IS NULL`).run();
    const fan = db.prepare("SELECT id FROM users WHERE username = 'fandemo'").get();
    const insUser = db.prepare(
      'INSERT INTO users (username, password_hash, role, display_name, dob, banned, created_at) VALUES (?,?,?,?,?,?,?)');
    const insWallet = db.prepare('INSERT INTO wallets (user_id) VALUES (?)');
    const survivorId = Number(insUser.run('cap_model', bcrypt.hashSync('model-pass-123', 10), 'model', 'Cap Model', null, 0, '2026-05-01 09:00:00').lastInsertRowid);
    insWallet.run(survivorId);
    db.prepare("INSERT INTO models (user_id) VALUES (?)").run(survivorId);
    const recId = Number(db.prepare(
      'INSERT INTO recruiters (user_id, name, city, referral_code, created_at) VALUES (?,?,?,?,?)')
      .run(survivorId, 'Cap Model', '', 'capcode1', '2025-11-20 10:00:00').lastInsertRowid);
    const dupId = Number(insUser.run('cap_dup', 'x', 'recruiter', 'Cap Model', null, 1, '2025-11-20 10:00:00').lastInsertRowid);
    insWallet.run(dupId);
    db.prepare("UPDATE users SET status = 'merged', merged_into = ? WHERE id = ?").run(survivorId, dupId);
    const recruits = [];
    for (const n of ['capm_one', 'capm_two']) {
      const uid = Number(insUser.run(n, 'x', 'model', n, null, 0, '2026-06-01 00:00:00').lastInsertRowid);
      insWallet.run(uid);
      db.prepare('INSERT INTO models (user_id, recruiter_id) VALUES (?,?)').run(uid, recId);
      recruits.push(uid);
    }
    db.prepare(
      `INSERT INTO transactions (fan_id, model_id, type, gross_cents, model_cents, platform_cents, recruiter_id, recruiter_cents, is_test)
       VALUES (?,?,?,?,?,?,?,?,0)`).run(fan.id, recruits[0], 'message', 1500, 900, 300, recId, 300);
    return { survivorId, dupId, recId };
  } finally {
    db.close();
  }
}

test('one-account extension: merged model counts once, resets land on her surviving login', async () => {
  const dir = makeCopy();
  const h1 = await boot(dir, { SEED_DEMO: '1' });
  stop(h1);
  const seeded = seedCapabilityPair(dir);
  const h = await boot(dir, { SEED_DEMO: '1' });
  try {
    const mgr = await mgrLogin(h.base);
    const { json } = await req(h.base, 'GET', '/api/admin/affiliates', { ...mgr });
    // She appears ONCE with combined numbers; the retired duplicate
    // never appears; the quota window runs off her AFFILIATE start
    // (recruiters.created_at 2025-11-20), not her model account date.
    assert.equal(json.affiliates.length, 1, 'exactly one roster row (the survivor)');
    assert.equal(json.stats.total_affiliates, 1, 'overview-grade count matches the roster');
    const row = json.affiliates[0];
    assert.equal(row.user_id, seeded.survivorId);
    assert.equal(row.username, 'cap_model');
    assert.equal(row.signed_up_at, '2025-11-20 10:00:00', 'affiliate start = recruiters.created_at');
    assert.equal(row.year_end, '2026-11-20', 'year end = affiliate start + 1 year');
    assert.equal(row.models_onboarded, 2, 'combined onboarded count');
    assert.equal(row.earnings_cents, 300, 'combined earnings');
    assert.equal(row.referral_link, 'https://slutcamp.app/#join/capcode1');
    const overview = await req(h.base, 'GET', '/api/admin/overview', { ...mgr });
    assert.equal(overview.json.affiliates, 1, 'overview bubble counts the capability holder once');

    // The retired duplicate is refused as a reset target on BOTH actions.
    const dupPw = await req(h.base, 'POST', `/api/admin/affiliates/${seeded.dupId}/password`,
      { ...mgr, body: { password: 'whatever-123' } });
    assert.equal(dupPw.status, 404, 'retired duplicate refused for password reset');
    const dupUn = await req(h.base, 'POST', `/api/admin/affiliates/${seeded.dupId}/username`,
      { ...mgr, body: { username: 'whatever' } });
    assert.equal(dupUn.status, 404, 'retired duplicate refused for username reset');

    // PINNED: password reset on the merged model via the affiliate
    // endpoint succeeds and her single login works with the new one.
    const reset = await req(h.base, 'POST', `/api/admin/affiliates/${seeded.survivorId}/password`,
      { ...mgr, body: { password: 'fresh-pass-456' } });
    assert.equal(reset.status, 200, `merged-model password reset: ${reset.text}`);
    const loginOld = await req(h.base, 'POST', '/api/auth/login',
      { body: { username: 'cap_model', password: 'model-pass-123' } });
    assert.equal(loginOld.status, 401, 'old password fails after reset');
    const loginNew = await req(h.base, 'POST', '/api/auth/login',
      { body: { username: 'cap_model', password: 'fresh-pass-456' } });
    assert.equal(loginNew.status, 200, `surviving login works with the new password: ${loginNew.text}`);
    assert.equal(loginNew.json.user.role, 'model', 'her single login is the model account');

    // Username reset also lands on the surviving login.
    const ren = await req(h.base, 'POST', `/api/admin/affiliates/${seeded.survivorId}/username`,
      { ...mgr, body: { username: 'cap_model_new' } });
    assert.equal(ren.status, 200, `merged-model username reset: ${ren.text}`);
    const loginRenamed = await req(h.base, 'POST', '/api/auth/login',
      { body: { username: 'cap_model_new', password: 'fresh-pass-456' } });
    assert.equal(loginRenamed.status, 200, 'she signs in under the new username');
  } finally {
    stop(h);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pins: route, attribution source, nav + screen wiring exist', () => {
  assert.ok(serverSrc.includes("app.get('/api/admin/affiliates', ...adminOnly"), 'admin affiliates route exists behind adminOnly');
  assert.ok(serverSrc.includes('LEFT JOIN recruiters r ON r.user_id = u.id'), 'roster keys off recruiter-role accounts');
  assert.ok(serverSrc.includes('FROM models m WHERE m.recruiter_id = r.id'), 'onboarded count uses models.recruiter_id attribution');
  assert.ok(serverSrc.includes('t.is_test = 0'), 'earnings read excludes test money');
  assert.ok(managerSrc.includes("['affiliates', '🔗 Affiliates']"), 'manager nav entry exists');
  assert.ok(managerSrc.includes("'partners', 'affiliates'"), 'affiliates grouped with People in the sidebar');
  assert.ok(managerSrc.includes('affiliates: adminAffiliatesBody'), 'manager screen registered');
  assert.ok(managerSrc.includes('async function adminAffiliatesBody()'), 'manager body exists');
  assert.ok(managerSrc.includes("api('/admin/affiliates')"), 'manager body reads the admin endpoint');
  // Overview bubble: payload + tile. The count predicate is the
  // one-account capability predicate (PR #45 extension): live
  // accounts that are recruiter-role OR hold a recruiters row.
  assert.ok(serverSrc.includes("u.merged_into IS NULL\n        AND (u.role = 'recruiter' OR EXISTS (SELECT 1 FROM recruiters r WHERE r.user_id = u.id)) AND u.status != 'deleted') AS affiliates"),
    'overview payload carries the capability-aware affiliates count (admin-deleted retirees excluded — Affiliates Delete, Oct 18 2026)');
  assert.ok(managerSrc.includes('${o.affiliates ?? \'—\'}</div><div class="l">Affiliates</div>'),
    'overview grid renders an Affiliates stat bubble');
  // Username/password reset actions (refinement #2).
  assert.ok(serverSrc.includes("app.post('/api/admin/affiliates/:id/username', ...adminOnly"), 'username reset route exists behind adminOnly');
  assert.ok(serverSrc.includes("app.post('/api/admin/affiliates/:id/password', ...adminOnly"), 'password reset route exists behind adminOnly');
  const pwBody = serverSrc.slice(serverSrc.indexOf("app.post('/api/admin/affiliates/:id/password'"),
    serverSrc.indexOf("app.post('/api/admin/affiliates/:id/password'") + 1400);
  assert.ok(pwBody.includes('affiliateResetTarget(req.params.id)'), 'password reset resolves targets via the capability-aware lookup');
  assert.ok(serverSrc.includes("u.merged_into IS NULL AND (u.role = 'recruiter' OR r.id IS NOT NULL)"),
    'reset target predicate: live affiliate-capability holders only');
  assert.ok(serverSrc.includes('if (!u || isMergeProtected(u)) return null;'),
    'reset targets refuse merge-protected accounts');
  assert.ok(pwBody.includes('bcrypt.hashSync(password, 10)'), 'password reset hashes with bcrypt(10) like the model flow');
  assert.ok(pwBody.includes('deleteUserSessions(u.id)'), 'password reset kills live sessions like the model flow');
  // Refinement #3: payload link construction + card renders both lines.
  assert.ok(serverSrc.includes('`${SEO_ORIGIN}/#join/${a.referral_code}`'), 'endpoint builds the full affiliate link from the canonical origin');
  assert.ok(managerSrc.includes('Username: <b>@${esc(a.username)}</b>'), 'card prints a labeled Username line');
  assert.ok(managerSrc.includes('🔗 Link: <span style="word-break:break-all;user-select:all">${esc(a.referral_link'), 'card prints the full affiliate link');
  assert.ok(managerSrc.includes('data-aff-user="'), 'username button on the affiliate card');
  assert.ok(managerSrc.includes("out.textContent = 'Username is taken'"), 'UI surfaces the plain "Username is taken" refusal');
  assert.ok(managerSrc.includes('data-aff-pw="'), 'password button on the affiliate card');
  assert.ok(managerSrc.includes("if (tab === 'affiliates')"), 'affiliates wiring registered in wireAdminBody');
  // Editor Cancel buttons (owner, Oct 18 2026): both inline editors
  // can be backed out of — Cancel collapses the editor and discards
  // the typed input with NO api call (the handler only clears the
  // editor box; it never reaches the save paths).
  assert.ok(managerSrc.includes('id="afu-cancel-${id}">Cancel</button>'), 'username editor has a Cancel button beside Save');
  assert.ok(managerSrc.includes('id="afp-cancel-${id}">Cancel</button>'), 'password editor has a Cancel button');
  assert.ok(managerSrc.includes("$('#afu-cancel-' + id).onclick = () => { box.innerHTML = ''; };"),
    'username Cancel collapses the editor, discarding input');
  assert.ok(managerSrc.includes("$('#afp-cancel-' + id).onclick = () => { box.innerHTML = ''; };"),
    'password Cancel collapses the editor, discarding input');
  // 🗑 Delete confirm (Affiliates Delete, Oct 18 2026): the confirm
  // step's Cancel aborts before any DELETE call is made.
  assert.ok(managerSrc.includes('if (!confirm(msg)) return;'), 'delete confirm Cancel aborts the action');
  assert.ok(managerSrc.indexOf('if (!confirm(msg)) return;') < managerSrc.indexOf("method: 'DELETE'"),
    'the DELETE api call sits behind the confirm guard');
});
