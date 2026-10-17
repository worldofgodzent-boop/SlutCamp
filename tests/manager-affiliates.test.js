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
    const alphaId = Number(insUser.run('aff_alpha', 'x', 'recruiter', 'Alpha Recruiter', null, 0, '2026-03-04 05:06:07').lastInsertRowid);
    const betaTs = sqlTs(new Date(Date.now() - 5 * 86400e3));
    const betaId = Number(insUser.run('aff_beta', 'x', 'recruiter', 'Beta Recruiter', null, 1, betaTs).lastInsertRowid);
    const insRec = db.prepare(
      'INSERT INTO recruiters (user_id, name, city, referral_code, created_at) VALUES (?,?,?,?,?)');
    const alphaRec = Number(insRec.run(alphaId, 'Alpha Recruiter', 'Austin', 'alpha123', '2026-03-04 05:06:07').lastInsertRowid);
    const betaRec = Number(insRec.run(betaId, 'Beta Recruiter', '', 'beta456', betaTs).lastInsertRowid);

    const insModelUser = db.prepare(
      "INSERT INTO users (username, password_hash, role, display_name, dob, created_at) VALUES (?, 'x', 'model', ?, NULL, '2026-04-01 00:00:00')");
    const insModel = db.prepare('INSERT INTO models (user_id, recruiter_id) VALUES (?,?)');
    const alphaModels = [];
    for (const n of ['affm_one', 'affm_two', 'affm_three']) {
      const uid = Number(insModelUser.run(n, n).lastInsertRowid);
      insModel.run(uid, alphaRec);
      alphaModels.push(uid);
    }
    const soloUid = Number(insModelUser.run('affm_solo', 'affm_solo').lastInsertRowid);
    insModel.run(soloUid, null); // unattributed model — never counts

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
    return { alphaId, betaId, alphaRec, betaRec, betaTs };
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
    assert.equal(alpha.signed_up_at, '2026-03-04 05:06:07');
    assert.equal(alpha.models_onboarded, 3);
    assert.equal(alpha.quota_target, 10);
    assert.equal(alpha.quota_met, false);
    assert.equal(alpha.year_end, '2027-03-04', 'year end = signup + 1 year');
    assert.equal(alpha.earnings_cents, 750);
    assert.equal(alpha.banned, false);

    // Beta: banned surfaces, zero counts, her own year-end.
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
  // Overview bubble: payload + tile.
  assert.ok(serverSrc.includes("(SELECT COUNT(*) FROM users WHERE role = 'recruiter') AS affiliates"),
    'overview payload carries the affiliates count');
  assert.ok(managerSrc.includes('${o.affiliates ?? \'—\'}</div><div class="l">Affiliates</div>'),
    'overview grid renders an Affiliates stat bubble');
});
