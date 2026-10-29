'use strict';
/*
 * Manager 🔗 Affiliates — 🗑 Delete (owner request, Oct 18 2026: "I
 * need a delete button for the ones I revoke or refresh/renew").
 *
 * DELETE /api/admin/affiliates/:id — admin-only (X-Manager + admin
 * role via ...adminOnly), same target family as the resets:
 * merged_into IS NULL AND (role='recruiter' OR a recruiters row).
 * What delete does depends on the account kind:
 *  - STANDALONE recruiter account → full retirement: recruiters row
 *    + code aliases deleted (links die; her models keep their
 *    accounts, recruiter_id → NULL via FK), sessions killed, users
 *    row retired like the one-account merge retires a duplicate
 *    (banned + scrambled password + status 'deleted') AND username
 *    tombstoned / email cleared so she can sign up FRESH (renewal:
 *    new account, new link, new §10 window). The users row and the
 *    ledger are never hard-deleted.
 *  - CAPABILITY holder (fan/model with a recruiters row) → ONLY the
 *    affiliate side is stripped (row + aliases); her account,
 *    earnings and login are untouched and /api/me is_affiliate
 *    flips to false.
 * Refusals (no writes): protected accounts (admin / house /
 * fandemo / the CCBill review account) → 403; already-merged or
 * already-deleted duplicates → 409; a PENDING withdrawal → 409
 * (resolve the payout first); non-affiliate targets → 404.
 * The lingering "removed" case (recruiter-role, banned, recruiters
 * row already deleted by the old Partners remove) retires cleanly
 * through the standalone branch — that is how the owner clears the
 * card that used to linger with no link.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-affdel-'));
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

function stampPlayMoney(db) {
  db.prepare(`UPDATE platform_stats SET play_money_zeroed_at = datetime('now')
              WHERE id = 1 AND play_money_zeroed_at IS NULL`).run();
}

/* Standalone recruiter: row + code + a merge-style alias, one
   attributed model, one ledger row paying her 300¢. */
function seedStandalone(dir) {
  const db = new DatabaseSync(path.join(dir, 'wogent-chat.db'));
  db.exec('PRAGMA busy_timeout = 10000');
  try {
    stampPlayMoney(db);
    const fan = db.prepare("SELECT id FROM users WHERE username = 'fandemo'").get();
    const insUser = db.prepare(
      'INSERT INTO users (username, password_hash, role, display_name, dob, banned, email, created_at) VALUES (?,?,?,?,?,?,?,?)');
    const soloId = Number(insUser.run('del_solo', bcrypt.hashSync('solo-pass-123', 10), 'recruiter', 'Solo Recruiter', null, 0, 'solo@example.com', '2026-02-01 10:00:00').lastInsertRowid);
    const recId = Number(db.prepare(
      'INSERT INTO recruiters (user_id, name, city, referral_code, created_at) VALUES (?,?,?,?,?)')
      .run(soloId, 'Solo Recruiter', '', 'delcode1', '2026-02-01 10:00:00').lastInsertRowid);
    db.prepare('INSERT INTO recruiter_code_aliases (code, recruiter_id) VALUES (?,?)').run('delalias1', recId);
    const insWallet = db.prepare('INSERT INTO wallets (user_id) VALUES (?)');
    insWallet.run(soloId);
    const modelId = Number(insUser.run('delm_one', 'x', 'model', 'delm_one', null, 0, null, '2026-03-01 00:00:00').lastInsertRowid);
    insWallet.run(modelId);
    db.prepare('INSERT INTO models (user_id, recruiter_id) VALUES (?,?)').run(modelId, recId);
    db.prepare(
      `INSERT INTO transactions (fan_id, model_id, type, gross_cents, model_cents, platform_cents, recruiter_id, recruiter_cents, is_test)
       VALUES (?,?,?,?,?,?,?,?,0)`).run(fan.id, modelId, 'message', 1500, 900, 300, recId, 300);
    return { soloId, recId, modelId };
  } finally {
    db.close();
  }
}

test('affiliates delete: standalone recruiter retires fully and frees her username', async () => {
  const dir = makeCopy();
  const h1 = await boot(dir, { SEED_DEMO: '1' });
  stop(h1);
  const seeded = seedStandalone(dir);
  const h = await boot(dir, { SEED_DEMO: '1' });
  try {
    const mgr = await mgrLogin(h.base);
    const del = (id, opts = mgr) => req(h.base, 'DELETE', `/api/admin/affiliates/${id}`, { ...opts });

    // Baseline: she is on the roster (with her role for the UI),
    // counted once in both the tab stats and the Overview bubble,
    // and both her link and her alias resolve.
    const before = await req(h.base, 'GET', '/api/admin/affiliates', { ...mgr });
    assert.equal(before.json.stats.total_affiliates, 1);
    const row0 = before.json.affiliates.find((a) => a.user_id === seeded.soloId);
    assert.ok(row0, 'standalone affiliate on the roster before delete');
    assert.equal(row0.role, 'recruiter', 'roster carries the account role for the Delete confirm copy');
    const ov0 = await req(h.base, 'GET', '/api/admin/overview', { ...mgr });
    assert.equal(ov0.json.affiliates, 1, 'overview bubble counts her before delete');
    assert.equal((await req(h.base, 'GET', '/api/referral/delcode1')).json.valid, true, 'primary link live');
    assert.equal((await req(h.base, 'GET', '/api/referral/delalias1')).json.valid, true, 'alias link live');

    // Her own live session works before the delete.
    const login = await req(h.base, 'POST', '/api/auth/login', { body: { username: 'del_solo', password: 'solo-pass-123' } });
    assert.equal(login.status, 200, `recruiter login: ${login.text}`);
    const dash = await req(h.base, 'GET', '/api/recruiter/dashboard', { token: login.json.token });
    assert.equal(dash.status, 200, 'recruiter dashboard works before delete');

    // Auth gates: anonymous → 401; fan token + header → 403;
    // admin token WITHOUT the X-Manager header → 403 manager_only.
    const anon = await req(h.base, 'DELETE', `/api/admin/affiliates/${seeded.soloId}`, { headers: { 'x-manager': '1' } });
    assert.equal(anon.status, 401, 'anonymous delete rejected');
    const fanSignup = await req(h.base, 'POST', '/api/auth/signup', {
      body: { username: 'del_gatefan', password: 'gatefan-pass-123', role: 'fan',
        display_name: 'del_gatefan', dob: '1995-05-05', agree18: true },
    });
    assert.equal(fanSignup.status, 200, `fan signup: ${fanSignup.text}`);
    const fanTry = await del(seeded.soloId, { token: fanSignup.json.token, headers: { 'x-manager': '1' } });
    assert.equal(fanTry.status, 403, 'fan cannot delete an affiliate');
    const noHeader = await req(h.base, 'DELETE', `/api/admin/affiliates/${seeded.soloId}`, { token: mgr.token });
    assert.equal(noHeader.status, 403, 'missing X-Manager header rejected');
    assert.equal(noHeader.json.error, 'manager_only');

    // The delete itself.
    const done = await del(seeded.soloId);
    assert.equal(done.status, 200, `delete: ${done.text}`);
    assert.equal(done.json.ok, true);
    assert.equal(done.json.mode, 'account_retired', 'standalone branch retires the account');

    // Roster + both counts drop.
    const after = await req(h.base, 'GET', '/api/admin/affiliates', { ...mgr });
    assert.equal(after.json.stats.total_affiliates, 0, 'tab count drops after delete');
    assert.equal(after.json.affiliates.length, 0, 'roster drops her after delete');
    const ov1 = await req(h.base, 'GET', '/api/admin/overview', { ...mgr });
    assert.equal(ov1.json.affiliates, 0, 'overview bubble drops after delete');

    // Her login is dead: old credentials 401, old session 401.
    const loginOld = await req(h.base, 'POST', '/api/auth/login', { body: { username: 'del_solo', password: 'solo-pass-123' } });
    assert.equal(loginOld.status, 401, 'old login no longer works');
    const dashOld = await req(h.base, 'GET', '/api/recruiter/dashboard', { token: login.json.token });
    assert.equal(dashOld.status, 401, 'pre-delete session invalidated');

    // Both links are dead — and a model signup through the old link
    // is refused as a bad referral.
    assert.equal((await req(h.base, 'GET', '/api/referral/delcode1')).json.valid, false, 'primary link dead');
    assert.equal((await req(h.base, 'GET', '/api/referral/delalias1')).json.valid, false, 'alias link dead');
    const joinOld = await req(h.base, 'POST', '/api/auth/signup', {
      body: { username: 'del_newmodel', password: 'newmodel-pass-1', role: 'model', publicity_consent: true,
        display_name: 'New Model', dob: '1999-06-15', agree18: true, section: 'female', referral_code: 'delcode1' },
    });
    assert.equal(joinOld.status, 400, 'signup through a dead link refused');
    assert.equal(joinOld.json.error, 'bad_referral');

    // Database truth: users row kept (never hard-deleted) but
    // retired + tombstoned; her model survives, detached; the
    // ledger row survives with its amounts.
    const db = new DatabaseSync(path.join(dir, 'wogent-chat.db'), { readOnly: true });
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(seeded.soloId);
    assert.ok(u, 'users row preserved for history');
    assert.equal(u.banned, 1, 'retired account is banned');
    assert.equal(u.status, 'deleted', 'retired account carries the deleted marker');
    assert.notEqual(u.username, 'del_solo', 'username tombstoned');
    assert.ok(String(u.username).startsWith('deleted-'), 'tombstone name is clearly a retirement marker');
    assert.equal(u.email, null, 'email freed');
    const m = db.prepare('SELECT * FROM models WHERE user_id = ?').get(seeded.modelId);
    assert.ok(m, 'her model account survives');
    assert.equal(m.recruiter_id, null, 'her model is detached (FK set null), not deleted');
    const txnRow = db.prepare('SELECT * FROM transactions WHERE model_id = ?').get(seeded.modelId);
    assert.ok(txnRow, 'ledger history preserved');
    assert.equal(txnRow.recruiter_cents, 300, 'ledger amounts untouched');
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM recruiters WHERE id = ?').get(seeded.recId).c, 0, 'recruiters row deleted');
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM recruiter_code_aliases WHERE recruiter_id = ?').get(seeded.recId).c, 0, 'aliases deleted');
    db.close();

    // Refresh/renew: the freed username signs up again as a FRESH
    // affiliate — new account, new link, back on the roster.
    const fresh = await req(h.base, 'POST', '/api/affiliate/signup', {
      body: { username: 'del_solo', password: 'fresh-pass-123', display_name: 'Solo Again', agreed: true },
    });
    assert.equal(fresh.status, 200, `fresh signup with the freed username: ${fresh.text}`);
    const renewed = await req(h.base, 'GET', '/api/admin/affiliates', { ...mgr });
    assert.equal(renewed.json.stats.total_affiliates, 1, 'renewed affiliate counted again');
    const rowN = renewed.json.affiliates.find((a) => a.username === 'del_solo');
    assert.ok(rowN, 'renewed affiliate back on the roster');
    assert.notEqual(rowN.referral_code, 'delcode1', 'renewal gets a brand-new link');
  } finally {
    stop(h);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* Capability holder: a MODEL account with a recruiters row, wallet
   earnings that must survive, one attributed recruit. */
function seedCapability(dir) {
  const db = new DatabaseSync(path.join(dir, 'wogent-chat.db'));
  db.exec('PRAGMA busy_timeout = 10000');
  try {
    stampPlayMoney(db);
    const fan = db.prepare("SELECT id FROM users WHERE username = 'fandemo'").get();
    const insUser = db.prepare(
      'INSERT INTO users (username, password_hash, role, display_name, dob, banned, created_at) VALUES (?,?,?,?,?,?,?)');
    const insWallet = db.prepare('INSERT INTO wallets (user_id) VALUES (?)');
    const capId = Number(insUser.run('del_cap', bcrypt.hashSync('cap-pass-123', 10), 'model', 'Cap Delete', null, 0, '2026-05-01 09:00:00').lastInsertRowid);
    insWallet.run(capId);
    db.prepare('UPDATE wallets SET earnings_cents = 4242, credits_cents = 111 WHERE user_id = ?').run(capId);
    db.prepare('INSERT INTO models (user_id) VALUES (?)').run(capId);
    const recId = Number(db.prepare(
      'INSERT INTO recruiters (user_id, name, city, referral_code, created_at) VALUES (?,?,?,?,?)')
      .run(capId, 'Cap Delete', '', 'delcap99', '2026-04-15 10:00:00').lastInsertRowid);
    db.prepare('INSERT INTO recruiter_code_aliases (code, recruiter_id) VALUES (?,?)').run('delcapalias', recId);
    const recruitId = Number(insUser.run('delcapm_one', 'x', 'model', 'delcapm_one', null, 0, '2026-06-01 00:00:00').lastInsertRowid);
    insWallet.run(recruitId);
    db.prepare('INSERT INTO models (user_id, recruiter_id) VALUES (?,?)').run(recruitId, recId);
    db.prepare(
      `INSERT INTO transactions (fan_id, model_id, type, gross_cents, model_cents, platform_cents, recruiter_id, recruiter_cents, is_test)
       VALUES (?,?,?,?,?,?,?,?,0)`).run(fan.id, recruitId, 'message', 1500, 900, 300, recId, 300);
    return { capId, recId, recruitId };
  } finally {
    db.close();
  }
}

test('affiliates delete: capability holder loses ONLY the affiliate side', async () => {
  const dir = makeCopy();
  const h1 = await boot(dir, { SEED_DEMO: '1' });
  stop(h1);
  const seeded = seedCapability(dir);
  const h = await boot(dir, { SEED_DEMO: '1' });
  try {
    const mgr = await mgrLogin(h.base);
    const login = await req(h.base, 'POST', '/api/auth/login', { body: { username: 'del_cap', password: 'cap-pass-123' } });
    assert.equal(login.status, 200, `model login: ${login.text}`);
    const meBefore = await req(h.base, 'GET', '/api/me', { token: login.json.token });
    assert.equal(meBefore.json.user.is_affiliate, true, 'capability visible before delete');
    assert.equal(meBefore.json.user.affiliate_code, 'delcap99');
    const roster0 = await req(h.base, 'GET', '/api/admin/affiliates', { ...mgr });
    const row0 = roster0.json.affiliates.find((a) => a.user_id === seeded.capId);
    assert.ok(row0, 'capability holder on the roster before delete');
    assert.equal(row0.role, 'model', 'roster marks her as a model account (capability, not standalone)');
    assert.equal((await req(h.base, 'GET', '/api/referral/delcap99')).json.valid, true, 'her link live before delete');

    const done = await req(h.base, 'DELETE', `/api/admin/affiliates/${seeded.capId}`, { ...mgr });
    assert.equal(done.status, 200, `delete: ${done.text}`);
    assert.equal(done.json.mode, 'affiliate_removed', 'capability branch strips only the affiliate side');

    // Her session was NOT killed and her login still works; the
    // capability flag flips off (the Model|Affiliate switch goes).
    const meAfter = await req(h.base, 'GET', '/api/me', { token: login.json.token });
    assert.equal(meAfter.status, 200, 'her existing session survives the strip');
    assert.equal(meAfter.json.user.is_affiliate, false, 'is_affiliate false after the strip');
    assert.equal(meAfter.json.user.affiliate_code, null, 'no affiliate code after the strip');
    const loginAgain = await req(h.base, 'POST', '/api/auth/login', { body: { username: 'del_cap', password: 'cap-pass-123' } });
    assert.equal(loginAgain.status, 200, 'her login is untouched');

    // Roster drops her AS AN AFFILIATE; her link + alias are dead.
    const roster1 = await req(h.base, 'GET', '/api/admin/affiliates', { ...mgr });
    assert.equal(roster1.json.affiliates.find((a) => a.user_id === seeded.capId), undefined, 'off the affiliate roster');
    assert.equal(roster1.json.stats.total_affiliates, 0);
    assert.equal((await req(h.base, 'GET', '/api/referral/delcap99')).json.valid, false, 'her link dead');
    assert.equal((await req(h.base, 'GET', '/api/referral/delcapalias')).json.valid, false, 'her alias dead');

    // Database truth: account fully intact — same username, active,
    // model row present, wallet earnings + credits untouched; only
    // the recruiters row/aliases are gone and her recruit detached.
    const db = new DatabaseSync(path.join(dir, 'wogent-chat.db'), { readOnly: true });
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(seeded.capId);
    assert.equal(u.username, 'del_cap', 'username untouched');
    assert.equal(u.banned, 0, 'account not banned');
    assert.equal(u.status, 'active', 'account not retired');
    assert.ok(db.prepare('SELECT * FROM models WHERE user_id = ?').get(seeded.capId), 'model profile intact');
    const w = db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(seeded.capId);
    assert.equal(w.earnings_cents, 4242, 'model earnings untouched');
    assert.equal(w.credits_cents, 111, 'credits untouched');
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM recruiters WHERE id = ?').get(seeded.recId).c, 0, 'recruiters row deleted');
    const recruit = db.prepare('SELECT * FROM models WHERE user_id = ?').get(seeded.recruitId);
    assert.ok(recruit, 'her recruited model survives');
    assert.equal(recruit.recruiter_id, null, 'her recruited model detached going forward');
    db.close();
  } finally {
    stop(h);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('affiliates delete: the lingering "removed" card (no recruiters row) retires cleanly', async () => {
  const dir = makeCopy();
  const h1 = await boot(dir, { SEED_DEMO: '1' });
  stop(h1);
  // Vkoza's exact production state: recruiter-role, banned by the
  // old Partners remove, recruiters row already gone — yet the card
  // still surfaces on the roster with no link.
  const db = new DatabaseSync(path.join(dir, 'wogent-chat.db'));
  db.exec('PRAGMA busy_timeout = 10000');
  let goneId;
  try {
    stampPlayMoney(db);
    goneId = Number(db.prepare(
      'INSERT INTO users (username, password_hash, role, display_name, dob, banned, created_at) VALUES (?,?,?,?,?,?,?)')
      .run('del_gone', bcrypt.hashSync('gone-pass-123', 10), 'recruiter', 'Gone Recruiter', null, 1, '2026-01-10 08:00:00').lastInsertRowid);
    db.prepare('INSERT INTO wallets (user_id) VALUES (?)').run(goneId);
  } finally {
    db.close();
  }
  const h = await boot(dir, { SEED_DEMO: '1' });
  try {
    const mgr = await mgrLogin(h.base);
    const before = await req(h.base, 'GET', '/api/admin/affiliates', { ...mgr });
    const row0 = before.json.affiliates.find((a) => a.user_id === goneId);
    assert.ok(row0, 'the lingering card is on the roster before delete');
    assert.equal(row0.banned, true, 'flagged removed');
    assert.equal(row0.referral_link, null, 'no link — the old remove already took the row');

    const done = await req(h.base, 'DELETE', `/api/admin/affiliates/${goneId}`, { ...mgr });
    assert.equal(done.status, 200, `delete of the lingering card: ${done.text}`);
    assert.equal(done.json.mode, 'account_retired', 'no-row standalone still retires the account');

    const after = await req(h.base, 'GET', '/api/admin/affiliates', { ...mgr });
    assert.equal(after.json.affiliates.find((a) => a.user_id === goneId), undefined, 'lingering card finally cleared');
    assert.equal(after.json.stats.total_affiliates, 0);
    const db2 = new DatabaseSync(path.join(dir, 'wogent-chat.db'), { readOnly: true });
    const u = db2.prepare('SELECT * FROM users WHERE id = ?').get(goneId);
    assert.equal(u.status, 'deleted');
    assert.notEqual(u.username, 'del_gone', 'username freed for a fresh signup');
    db2.close();
  } finally {
    stop(h);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* Refusal fixtures in one DB: protected accounts (admin from the
   demo seed, fandemo, an inserted house account + CCBill review
   account), a retired merged duplicate, a plain fan + model
   (non-affiliates), and a recruiter with a PENDING withdrawal. */
function seedRefusals(dir) {
  const db = new DatabaseSync(path.join(dir, 'wogent-chat.db'));
  db.exec('PRAGMA busy_timeout = 10000');
  try {
    stampPlayMoney(db);
    const insUser = db.prepare(
      'INSERT INTO users (username, password_hash, role, display_name, dob, banned, created_at) VALUES (?,?,?,?,?,?,?)');
    const insWallet = db.prepare('INSERT INTO wallets (user_id) VALUES (?)');
    const admin = db.prepare("SELECT id FROM users WHERE username = 'admin'").get();
    const fandemo = db.prepare("SELECT id FROM users WHERE username = 'fandemo'").get();
    const houseId = Number(insUser.run('asceaaspade', 'x', 'model', 'SlutCamp', null, 0, '2026-01-01 00:00:00').lastInsertRowid);
    insWallet.run(houseId);
    db.prepare('INSERT INTO models (user_id) VALUES (?)').run(houseId);
    const reviewId = Number(insUser.run('ccbillreview', 'x', 'model', 'Review', null, 0, '2026-01-01 00:00:00').lastInsertRowid);
    insWallet.run(reviewId);
    const survivorId = Number(insUser.run('del_surv', 'x', 'model', 'del_surv', null, 0, '2026-05-01 00:00:00').lastInsertRowid);
    insWallet.run(survivorId);
    db.prepare('INSERT INTO models (user_id) VALUES (?)').run(survivorId);
    const dupId = Number(insUser.run('del_dup', 'x', 'recruiter', 'Dup', null, 1, '2025-11-20 10:00:00').lastInsertRowid);
    insWallet.run(dupId);
    db.prepare("UPDATE users SET status = 'merged', merged_into = ? WHERE id = ?").run(survivorId, dupId);
    const plainFanId = Number(insUser.run('del_plainfan', bcrypt.hashSync('fan-pass-123', 10), 'fan', 'Plain Fan', null, 0, '2026-06-01 00:00:00').lastInsertRowid);
    insWallet.run(plainFanId);
    const pendId = Number(insUser.run('del_pend', bcrypt.hashSync('pend-pass-123', 10), 'recruiter', 'Pend Recruiter', null, 0, '2026-02-15 00:00:00').lastInsertRowid);
    insWallet.run(pendId);
    const pendRec = Number(db.prepare(
      'INSERT INTO recruiters (user_id, name, city, referral_code, created_at) VALUES (?,?,?,?,?)')
      .run(pendId, 'Pend Recruiter', '', 'pendcode1', '2026-02-15 00:00:00').lastInsertRowid);
    db.prepare("INSERT INTO withdrawals (model_id, amount_cents, status) VALUES (?, 5000, 'pending')").run(pendId);
    return { adminId: admin.id, fandemoId: fandemo.id, houseId, reviewId, dupId, plainFanId, plainModelId: survivorId, pendId, pendRec };
  } finally {
    db.close();
  }
}

test('affiliates delete: refusals — protected, merged duplicate, pending withdrawal, non-affiliate', async () => {
  const dir = makeCopy();
  const h1 = await boot(dir, { SEED_DEMO: '1' });
  stop(h1);
  const seeded = seedRefusals(dir);
  const h = await boot(dir, { SEED_DEMO: '1' });
  try {
    const mgr = await mgrLogin(h.base);
    const del = (id) => req(h.base, 'DELETE', `/api/admin/affiliates/${id}`, { ...mgr });

    // Protected accounts → 403 protected_account, and stay intact.
    for (const [label, id] of [['admin', seeded.adminId], ['fandemo', seeded.fandemoId],
        ['house', seeded.houseId], ['ccbill review', seeded.reviewId]]) {
      const r = await del(id);
      assert.equal(r.status, 403, `${label} account refused`);
      assert.equal(r.json.error, 'protected_account');
      assert.ok(r.json.message, 'owner-facing message present');
    }
    const db = new DatabaseSync(path.join(dir, 'wogent-chat.db'), { readOnly: true });
    assert.equal(db.prepare('SELECT status FROM users WHERE id = ?').get(seeded.houseId).status, 'active', 'house account untouched');
    assert.equal(db.prepare('SELECT banned FROM users WHERE id = ?').get(seeded.fandemoId).banned, 0, 'fandemo untouched');
    db.close();

    // Retired merged duplicate → 409 already_retired (never a target).
    const dup = await del(seeded.dupId);
    assert.equal(dup.status, 409, 'merged duplicate refused');
    assert.equal(dup.json.error, 'already_retired');
    assert.ok(dup.json.message, 'owner-facing message present');

    // Non-affiliates → 404 (plain fan, plain model, missing id).
    for (const id of [seeded.plainFanId, seeded.plainModelId, 999999]) {
      const r = await del(id);
      assert.equal(r.status, 404, `non-affiliate ${id} refused with 404`);
      assert.equal(r.json.error, 'not_found');
    }

    // Pending withdrawal → 409 with NOTHING changed: she stays on
    // the roster, her row + link stay live. Once the payout is
    // resolved (no longer pending), the delete goes through.
    const pend = await del(seeded.pendId);
    assert.equal(pend.status, 409, 'pending withdrawal refused');
    assert.equal(pend.json.error, 'pending_withdrawal');
    assert.ok(/payout/i.test(pend.json.message), 'message names the payout blocker');
    const still = await req(h.base, 'GET', '/api/admin/affiliates', { ...mgr });
    assert.ok(still.json.affiliates.find((a) => a.user_id === seeded.pendId), 'refused delete leaves her on the roster');
    assert.equal((await req(h.base, 'GET', '/api/referral/pendcode1')).json.valid, true, 'refused delete leaves her link live');

    const dbw = new DatabaseSync(path.join(dir, 'wogent-chat.db'));
    dbw.exec('PRAGMA busy_timeout = 10000');
    dbw.prepare("UPDATE withdrawals SET status = 'rejected' WHERE model_id = ?").run(seeded.pendId);
    dbw.close();
    const afterResolve = await del(seeded.pendId);
    assert.equal(afterResolve.status, 200, `delete after payout resolved: ${afterResolve.text}`);
    assert.equal(afterResolve.json.mode, 'account_retired');
  } finally {
    stop(h);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pins: delete route, protection helper, roster role + UI wiring exist', () => {
  assert.ok(serverSrc.includes("app.delete('/api/admin/affiliates/:id', ...adminOnly"), 'delete route exists behind adminOnly');
  assert.ok(serverSrc.includes('function isAffiliateDeleteProtected(user)'), 'delete protection helper exists');
  assert.ok(serverSrc.includes("'ccbillreview'"), 'CCBill review account is delete-protected');
  assert.ok(serverSrc.includes("error: 'pending_withdrawal'"), 'pending-withdrawal refusal exists');
  assert.ok(serverSrc.includes("u.status != 'deleted'"), 'roster/count exclude admin-deleted retirees');
  assert.ok(serverSrc.includes('u.role AS role'), 'roster carries the account role for the UI confirm copy');
  assert.ok(managerSrc.includes('data-aff-del="'), 'delete button on the affiliate card');
  assert.ok(managerSrc.includes('🗑 Delete'), 'delete button is labeled');
  assert.ok(managerSrc.includes("method: 'DELETE'"), 'manager delete calls the DELETE endpoint');
  assert.ok(managerSrc.includes('data-aff-role="'), 'card carries the role so the confirm copy matches the branch');
});
