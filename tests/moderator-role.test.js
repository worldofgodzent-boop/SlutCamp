'use strict';
/*
 * Moderator (worker) role — hired human staff, spec
 * moderator-role-spec.md incl. the 2026-10-23 invite-link addendum.
 *
 * Pinned here:
 *  - Invite links: owner creates a labeled single-use 7-day link; the
 *    link's signup alone can mint role='moderator' (the public signup
 *    role whitelist stays fan/model); used/revoked/expired links die.
 *  - Sign-in: moderators use /api/manager/login password-only (no
 *    passkey step-up anywhere on their surface); fans/models are
 *    still refused at that door.
 *  - Default-deny: every /api/admin/* route answers a moderator 403,
 *    including the audit log itself and the pre-existing /api/mod/
 *    presence guard. Moderator payloads carry NO money fields
 *    (absent, never zeroed).
 *  - ID queue: standard cases decidable (approve/reject-with-reason),
 *    borderline cases (missing release/consent, incomplete packet,
 *    flagged subject, open incident, worker-stamped) are escalated —
 *    moderator decisions on them answer 403; escalate is audited.
 *  - Safety: dismiss + official warning (bell lands); lives: end
 *    requires a reason and tears the session down.
 *  - Deactivation/hide lifecycle: model files with a mandatory reason
 *    → pending (account fully active, one pending max) → owner
 *    approve (hide → is_hidden; deactivate → banned + sessions dead;
 *    notified ×13) / deny (closed + notified). Moderator-filed
 *    fan-ban requests ride the same queue and change nothing until
 *    the owner approves.
 *  - Revocation: owner disable kills the moderator's live sessions
 *    instantly and refuses sign-in; re-enable restores sign-in.
 *  - Audit: moderator_actions rows exist for every mutation; the
 *    owner's admin Face ID/passkey machinery is untouched (pins).
 *  - Migration: a database whose users CHECK predates the role is
 *    widened on boot (allowModeratorRole), columns intact.
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
const appSrc = fs.readFileSync(path.join(REPO, 'public/js/app.js'), 'utf8');
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-modrole-'));
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

async function stop(h) {
  if (!h || !h.child) return;
  const child = h.child;
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((r) => {
    const to = setTimeout(r, 10000); // backstop: never hang the suite
    child.once('exit', () => { clearTimeout(to); r(); });
    // The child may have exited between the check above and attaching
    // the listener — re-check before killing, or the promise never fires.
    if (child.exitCode !== null || child.signalCode !== null) { clearTimeout(to); r(); return; }
    try { child.kill('SIGKILL'); } catch (_) { clearTimeout(to); r(); }
  });
}

async function req(base, method, p, { body, token, mgr } = {}) {
  const h = {};
  let payload;
  if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  if (token) h.authorization = 'Bearer ' + token;
  if (mgr) h['x-manager'] = '1';
  const r = await fetch(base + p, { method, headers: h, body: payload });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not json */ }
  return { status: r.status, json, text };
}

function dbAt(dir, fn, readOnly) {
  const db = new DatabaseSync(path.join(dir, 'wogent-chat.db'), readOnly ? { readOnly: true } : {});
  try { return fn(db); } finally { db.close(); }
}

test('moderator role: invites, allowlist, ID queue, safety, lives, deactivation lifecycle, revocation, audit', async (t) => {
  const dir = makeCopy();
  let h = await boot(dir, { SEED_DEMO: '1' });
  t.after(async () => { await stop(h); });
  let base = h.base;

  const adm = await req(base, 'POST', '/api/manager/login', { body: { username: 'admin', password: 'admin123' } });
  assert.equal(adm.status, 200, `manager login: ${adm.text}`);
  const atok = adm.json.token;
  const login = async (u, p) => {
    const r = await req(base, 'POST', '/api/auth/login', { body: { username: u, password: p } });
    assert.equal(r.status, 200, `login ${u}: ${r.text}`);
    return r.json.token;
  };
  const fanTok = await login('fandemo', 'fan123');
  const bunnyTok = await login('bunny', 'model123');
  const staceyTok = await login('stacey', 'model123');
  const bellaTok = await login('bella', 'model123');
  const meId = async (tok) => (await req(base, 'GET', '/api/me', { token: tok })).json.user.id;
  const fanId = await meId(fanTok);
  const bunnyId = await meId(bunnyTok);
  const staceyId = await meId(staceyTok);
  const bellaId = await meId(bellaTok);

  let wandaId = null;
  let mtok = null;
  let invite3Code = null;

  await t.test('invite lifecycle: create → validate → signup binds the role server-side', async () => {
    const c = await req(base, 'POST', '/api/admin/moderator-invites', { token: atok, mgr: true, body: { label: 'Wanda Worker' } });
    assert.equal(c.status, 200, c.text);
    assert.ok(c.json.invite && c.json.invite.url.includes('/moderator-invite/'), 'invite carries its URL');
    const code = c.json.invite.url.split('/moderator-invite/')[1];

    const v = await req(base, 'GET', `/api/moderator-invite/${code}`);
    assert.equal(v.status, 200);
    assert.equal(v.json.valid, true);
    assert.equal(v.json.label, 'Wanda Worker');

    const page = await req(base, 'GET', `/moderator-invite/${code}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /Join the SlutCamp team/);
    assert.match(page.text, /Wanda Worker/);

    const s = await req(base, 'POST', `/api/moderator-invite/${code}/signup`, {
      body: { display_name: 'Wanda Worker', email: 'wanda@example.com', password: 'workerpass1' },
    });
    assert.equal(s.status, 200, s.text);
    assert.equal(s.json.user.role, 'moderator', 'the token binds the role — the client never picks it');
    assert.equal(s.json.user.username, 'wanda@example.com');
    wandaId = s.json.user.id;

    const reuse = await req(base, 'POST', `/api/moderator-invite/${code}/signup`, {
      body: { display_name: 'Second Person', email: 'second@example.com', password: 'workerpass1' },
    });
    assert.equal(reuse.status, 400);
    assert.equal(reuse.json.error, 'invite_used', 'single-use: a spent link mints nobody');
    const v2 = await req(base, 'GET', `/api/moderator-invite/${code}`);
    assert.equal(v2.json.valid, false);
  });

  await t.test('revoked link fails; a third link is saved for the expiry check', async () => {
    const c = await req(base, 'POST', '/api/admin/moderator-invites', { token: atok, mgr: true, body: { label: 'Revoked Rita' } });
    const inv2 = c.json.invite;
    const rv = await req(base, 'POST', `/api/admin/moderator-invites/${inv2.id}/revoke`, { token: atok, mgr: true, body: {} });
    assert.equal(rv.status, 200, rv.text);
    const code2 = inv2.url.split('/moderator-invite/')[1];
    const s = await req(base, 'POST', `/api/moderator-invite/${code2}/signup`, {
      body: { display_name: 'Rita', email: 'rita@example.com', password: 'workerpass1' },
    });
    assert.equal(s.status, 400);
    assert.equal(s.json.error, 'invite_revoked');
    // Revoking a USED link is refused — the account is disabled instead.
    const usedList = await req(base, 'GET', '/api/admin/moderator-invites', { token: atok, mgr: true });
    const used = usedList.json.invites.find((i) => i.status === 'used');
    const rvUsed = await req(base, 'POST', `/api/admin/moderator-invites/${used.id}/revoke`, { token: atok, mgr: true, body: {} });
    assert.equal(rvUsed.status, 409);
    assert.equal(rvUsed.json.error, 'already_used');

    const c3 = await req(base, 'POST', '/api/admin/moderator-invites', { token: atok, mgr: true, body: { label: 'Expired Erin' } });
    invite3Code = c3.json.invite.url.split('/moderator-invite/')[1];
  });

  await t.test('no other signup path can mint the role', async () => {
    const s = await req(base, 'POST', '/api/auth/signup', {
      body: { username: 'sneakymod', password: 'whatever1', display_name: 'Sneaky', role: 'moderator', dob: '1995-01-01', agreedToTerms: true },
    });
    assert.equal(s.status, 400, s.text);
    assert.equal(s.json.error, 'bad_role');
  });

  await t.test('moderator sign-in: Manager door password-only; fans/models refused there', async () => {
    const m = await req(base, 'POST', '/api/manager/login', { body: { username: 'wanda@example.com', password: 'workerpass1' } });
    assert.equal(m.status, 200, m.text);
    assert.equal(m.json.user.role, 'moderator');
    mtok = m.json.token;
    // No passkey step-up stands between a moderator and her surface:
    const ov = await req(base, 'GET', '/api/mod/overview', { token: mtok, mgr: true });
    assert.equal(ov.status, 200, ov.text);
    // …but the Manager app header is still required on /api/mod/*.
    const noHdr = await req(base, 'GET', '/api/mod/overview', { token: mtok });
    assert.equal(noHdr.status, 403);
    assert.equal(noHdr.json.error, 'manager_only');
    const fan = await req(base, 'POST', '/api/manager/login', { body: { username: 'fandemo', password: 'fan123' } });
    assert.equal(fan.status, 403);
    assert.equal(fan.json.error, 'not_manager');
    const model = await req(base, 'POST', '/api/manager/login', { body: { username: 'bunny', password: 'model123' } });
    assert.equal(model.status, 403);
    assert.equal(model.json.error, 'not_manager');
    // The public door also knows her (manager_account interstitial).
    const pub = await req(base, 'POST', '/api/auth/login', { body: { username: 'wanda@example.com', password: 'workerpass1' } });
    assert.equal(pub.status, 200);
    assert.equal(pub.json.manager_account, true);
  });

  await t.test('default-deny: the whole /api/admin/* surface refuses a moderator', async () => {
    const gets = [
      '/api/admin/overview', '/api/admin/stats', '/api/admin/fans', '/api/admin/models',
      '/api/admin/payouts', '/api/admin/withdrawals', '/api/admin/refunds', '/api/admin/disputes',
      '/api/admin/chargebacks', '/api/admin/contracts', '/api/admin/affiliates', '/api/admin/gifts',
      '/api/admin/live', '/api/admin/id-verifications', '/api/admin/safety/incidents',
      '/api/admin/suggestions', '/api/admin/invites', '/api/admin/tax',
      '/api/admin/crypto-invoices', '/api/admin/loads', '/api/admin/conversations', '/api/admin/dmca',
      '/api/admin/bookings', '/api/admin/analytics', '/api/admin/package-orders',
      '/api/admin/moderators', '/api/admin/moderator-invites', '/api/admin/moderator-actions',
      '/api/admin/deactivation-requests', '/api/mod/presence',
    ];
    for (const p of gets) {
      const r = await req(base, 'GET', p, { token: mtok, mgr: true });
      assert.equal(r.status, 403, `${p} → ${r.status} (${r.text.slice(0, 80)})`);
    }
    const posts = [
      ['/api/admin/fans/' + fanId + '/credits', { amount_cents: 100 }],
      ['/api/admin/fans/' + fanId + '/ban', {}],
      ['/api/admin/moderator-invites', { label: 'Self Serve' }],
      ['/api/admin/moderators/' + wandaId + '/disable', {}],
      ['/api/admin/invites', { label: 'Self Serve', role: 'model' }],
    ];
    for (const [p, body] of posts) {
      const r = await req(base, 'POST', p, { token: mtok, mgr: true, body });
      assert.equal(r.status, 403, `POST ${p} → ${r.status}`);
    }
    const put = await req(base, 'PUT', '/api/admin/settings', { token: mtok, mgr: true, body: {} });
    assert.equal(put.status, 403, 'settings PUT refused');
  });

  await t.test('moderator payloads carry no money fields — absent, not zeroed', async () => {
    const fans = await req(base, 'GET', '/api/mod/fans', { token: mtok, mgr: true });
    assert.equal(fans.status, 200, fans.text);
    assert.ok(fans.json.fans.length >= 1);
    assert.ok(!fans.text.includes('credits_cents'), 'no balance column');
    assert.ok(!fans.text.includes('spent'), 'no spend column');
    assert.ok(!fans.text.includes('loads'), 'no load history');
    const ov = await req(base, 'GET', '/api/mod/overview', { token: mtok, mgr: true });
    assert.ok(!ov.text.includes('cents'), 'overview is counts only');
    for (const k of ['pending_id_reviews', 'live_now', 'fans', 'models', 'open_incidents'])
      assert.equal(typeof ov.json[k], 'number', `overview.${k} is a count`);
    const models = await req(base, 'GET', '/api/mod/models/pending', { token: mtok, mgr: true });
    assert.equal(models.status, 200, models.text);
    assert.ok(!models.text.includes('earnings'), 'no model earnings');
    const aff = await req(base, 'GET', '/api/mod/affiliates', { token: mtok, mgr: true });
    assert.equal(aff.status, 200, aff.text);
    assert.ok(!aff.text.includes('earnings'), 'no affiliate earnings');
    const live = await req(base, 'GET', '/api/mod/live', { token: mtok, mgr: true });
    assert.equal(live.status, 200, live.text);
    assert.ok(!live.text.includes('_cents'), 'no live money columns');
  });

  await t.test('fan thread: the moderator replies as herself, free, audited later', async () => {
    const post = await req(base, 'POST', `/api/mod/fans/${fanId}/message`, { token: mtok, mgr: true, body: { body: 'Hi! Moderator Wanda here — how can I help?' } });
    assert.equal(post.status, 200, post.text);
    const th = await req(base, 'GET', `/api/mod/fans/${fanId}/thread`, { token: mtok, mgr: true });
    assert.equal(th.status, 200);
    assert.ok(th.json.messages.some((m) => m.body.includes('Moderator Wanda')), 'reply is in the thread');
    assert.ok(th.json.messages.some((m) => m.sender_name === 'You (Moderator)'));
  });

  await t.test('suggestion box: read + triage status from the moderator seat', async () => {
    const s = await req(base, 'POST', '/api/suggestions', { token: fanTok, body: { text: 'Please add a dark mode for the theater view' } });
    assert.equal(s.status, 200, s.text);
    const list = await req(base, 'GET', '/api/mod/suggestions', { token: mtok, mgr: true });
    const mine = list.json.suggestions.find((x) => x.body.includes('dark mode'));
    assert.ok(mine, 'suggestion visible to the moderator');
    assert.equal(mine.suggester_role, 'fan');
    const st = await req(base, 'POST', `/api/mod/suggestions/${mine.id}/status`, { token: mtok, mgr: true, body: { status: 'done' } });
    assert.equal(st.status, 200, st.text);
  });

  await t.test('deactivation lifecycle: deny notifies (EN, then ES ×13 spot-check)', async () => {
    const noReason = await req(base, 'POST', '/api/model/deactivation-request', { token: bunnyTok, body: { type: 'hide', reason: '  ' } });
    assert.equal(noReason.status, 400);
    assert.equal(noReason.json.error, 'reason_required', 'the reason box is mandatory');
    const filed = await req(base, 'POST', '/api/model/deactivation-request', { token: bunnyTok, body: { type: 'hide', reason: 'Taking a break for family' } });
    assert.equal(filed.status, 200, filed.text);
    const again = await req(base, 'POST', '/api/model/deactivation-request', { token: bunnyTok, body: { type: 'deactivate', reason: 'second' } });
    assert.equal(again.status, 409, 'one pending request per model');
    assert.equal(again.json.error, 'request_pending');
    // Her account is FULLY active while the request waits.
    const me = await req(base, 'GET', '/api/me', { token: bunnyTok });
    assert.equal(me.status, 200);
    // The owner's Overview tile counts it and his queue shows it.
    const ov = await req(base, 'GET', '/api/admin/overview', { token: atok, mgr: true });
    assert.ok(ov.json.pending_deactivation_requests >= 1, 'overview tile count');
    const queue = await req(base, 'GET', '/api/admin/deactivation-requests', { token: atok, mgr: true });
    const row = queue.json.requests.find((r) => r.id === filed.json.request_id);
    assert.ok(row && row.status === 'pending' && row.model_username === 'bunny');
    const deny = await req(base, 'POST', `/api/admin/deactivation-requests/${row.id}/deny`, { token: atok, mgr: true, body: {} });
    assert.equal(deny.status, 200, deny.text);
    const notifs = await req(base, 'GET', '/api/notifications', { token: bunnyTok });
    assert.ok(JSON.stringify(notifs.json).includes('Asce reviewed your request'), 'denial bell lands (EN)');
    // Spanish spot-check of the ×13 copy: switch her language, file
    // again, deny again — the bell must arrive in Spanish.
    const lang = await req(base, 'PATCH', '/api/me/language', { token: bunnyTok, body: { language: 'es' } });
    assert.equal(lang.status, 200, lang.text);
    const filed2 = await req(base, 'POST', '/api/model/deactivation-request', { token: bunnyTok, body: { type: 'hide', reason: 'Otra pausa' } });
    assert.equal(filed2.status, 200, filed2.text);
    const deny2 = await req(base, 'POST', `/api/admin/deactivation-requests/${filed2.json.request_id}/deny`, { token: atok, mgr: true, body: {} });
    assert.equal(deny2.status, 200, deny2.text);
    const notifs2 = await req(base, 'GET', '/api/notifications', { token: bunnyTok });
    assert.ok(JSON.stringify(notifs2.json).includes('Tu solicitud fue revisada'), 'denial bell lands (ES)');
  });

  await t.test('deactivation lifecycle: hide approval hides her; deactivate approval bans + kills sessions', async () => {
    const filed = await req(base, 'POST', '/api/model/deactivation-request', { token: staceyTok, body: { type: 'hide', reason: 'Quiet month' } });
    assert.equal(filed.status, 200, filed.text);
    const ap = await req(base, 'POST', `/api/admin/deactivation-requests/${filed.json.request_id}/approve`, { token: atok, mgr: true, body: {} });
    assert.equal(ap.status, 200, ap.text);
    const dir1 = await req(base, 'GET', '/api/models');
    assert.ok(!dir1.json.models.some((m) => m.username === 'stacey'), 'hidden model leaves the public directory');
    const notifs = await req(base, 'GET', '/api/notifications', { token: staceyTok });
    assert.ok(JSON.stringify(notifs.json).includes('Your profile is hidden'), 'hide bell lands');

    const filed2 = await req(base, 'POST', '/api/model/deactivation-request', { token: bellaTok, body: { type: 'deactivate', reason: 'Moving on' } });
    assert.equal(filed2.status, 200, filed2.text);
    const ap2 = await req(base, 'POST', `/api/admin/deactivation-requests/${filed2.json.request_id}/approve`, { token: atok, mgr: true, body: {} });
    assert.equal(ap2.status, 200, ap2.text);
    const meAfter = await req(base, 'GET', '/api/me', { token: bellaTok });
    assert.ok(meAfter.status === 401 || meAfter.status === 403,
      `her live session died with the approval (${meAfter.status})`);
    const relogin = await req(base, 'POST', '/api/auth/login', { body: { username: 'bella', password: 'model123' } });
    assert.equal(relogin.status, 403);
    assert.equal(relogin.json.error, 'banned');
  });

  await t.test('moderator-filed fan ban: nothing changes until the owner approves', async () => {
    const noReason = await req(base, 'POST', `/api/mod/fans/${fanId}/ban-request`, { token: mtok, mgr: true, body: {} });
    assert.equal(noReason.status, 400);
    const filed = await req(base, 'POST', `/api/mod/fans/${fanId}/ban-request`, { token: mtok, mgr: true, body: { reason: 'Harassing models in chat' } });
    assert.equal(filed.status, 200, filed.text);
    const dup = await req(base, 'POST', `/api/mod/fans/${fanId}/ban-request`, { token: mtok, mgr: true, body: { reason: 'again' } });
    assert.equal(dup.status, 409);
    const stillIn = await req(base, 'POST', '/api/auth/login', { body: { username: 'fandemo', password: 'fan123' } });
    assert.equal(stillIn.status, 200, 'the fan is untouched while the request waits');
    const queue = await req(base, 'GET', '/api/admin/deactivation-requests', { token: atok, mgr: true });
    const row = queue.json.requests.find((r) => r.id === filed.json.request_id);
    assert.ok(row && row.type === 'fan_ban' && row.requested_by_role === 'moderator');
    const mine = await req(base, 'GET', '/api/mod/requests', { token: mtok, mgr: true });
    assert.ok(mine.json.requests.some((r) => r.id === filed.json.request_id && r.status === 'pending'));
    const ap = await req(base, 'POST', `/api/admin/deactivation-requests/${row.id}/approve`, { token: atok, mgr: true, body: {} });
    assert.equal(ap.status, 200, ap.text);
    const out = await req(base, 'POST', '/api/auth/login', { body: { username: 'fandemo', password: 'fan123' } });
    assert.equal(out.status, 403);
    assert.equal(out.json.error, 'banned', 'approval is what bans him — never the filing');
  });

  await t.test('owner revocation: disable kills live sessions + sign-in; re-enable restores', async () => {
    const dis = await req(base, 'POST', `/api/admin/moderators/${wandaId}/disable`, { token: atok, mgr: true, body: {} });
    assert.equal(dis.status, 200, dis.text);
    const dead = await req(base, 'GET', '/api/mod/overview', { token: mtok, mgr: true });
    assert.equal(dead.status, 401, 'existing session was deleted on the spot — the token is simply gone');
    assert.equal(dead.json.error, 'not_logged_in');
    const relogin = await req(base, 'POST', '/api/manager/login', { body: { username: 'wanda@example.com', password: 'workerpass1' } });
    assert.equal(relogin.status, 403);
    assert.equal(relogin.json.error, 'account_disabled');
    const pubLogin = await req(base, 'POST', '/api/auth/login', { body: { username: 'wanda@example.com', password: 'workerpass1' } });
    assert.equal(pubLogin.status, 403, 'the public door refuses her too');
    const en = await req(base, 'POST', `/api/admin/moderators/${wandaId}/enable`, { token: atok, mgr: true, body: {} });
    assert.equal(en.status, 200, en.text);
    // Re-enable is proven via the public door: /api/manager/login is
    // rate-limited to 5 attempts/IP/min (adminRateLimited, shared with
    // admin-login), and this suite legitimately spends all 5 in phase 1
    // (owner + moderator + fan + model + the disabled check above).
    const back = await req(base, 'POST', '/api/auth/login', { body: { username: 'wanda@example.com', password: 'workerpass1' } });
    assert.equal(back.status, 200, 're-enable restores sign-in');
    assert.equal(back.json.manager_account, true, 'public login flags the manager account');
    mtok = back.json.token;
  });

  await t.test('audit trail: every mutation above left its row; owner-only read', async () => {
    const a = await req(base, 'GET', '/api/admin/moderator-actions?limit=200', { token: atok, mgr: true });
    assert.equal(a.status, 200, a.text);
    const actions = a.json.actions.map((x) => x.action);
    for (const want of ['invite_created', 'invite_revoked', 'invite_signup', 'fan_reply',
      'suggestion_status', 'fan_ban_request', 'moderator_disabled', 'moderator_enabled'])
      assert.ok(actions.includes(want), `audit has ${want} (saw: ${actions.join(',')})`);
    const signupRow = a.json.actions.find((x) => x.action === 'invite_signup');
    assert.equal(signupRow.worker_id, wandaId);
    const asMod = await req(base, 'GET', '/api/admin/moderator-actions', { token: mtok, mgr: true });
    assert.equal(asMod.status, 403, 'a moderator can never read the audit log');
  });

  /* ---------- phase 2: seed the ID/safety/live fixtures ---------- */
  const signup = async (username, role) => {
    const r = await req(base, 'POST', '/api/auth/signup', {
      body: { username, password: 'fixturepass1', display_name: username, role, dob: '1995-03-04', agreedToTerms: true, agree18: true, section: 'female', ...(role === 'model' ? { publicity_consent: true } : {}) },
    });
    assert.equal(r.status, 200, `signup ${username}: ${r.text}`);
    return r.json.user.id;
  };
  const stdId = await signup('modstd', 'model');
  const norelId = await signup('modnorel', 'model');
  const flagId = await signup('modflag', 'model');
  const std2Id = await signup('modstd2', 'model');
  const fan2Id = await signup('fan2', 'fan');
  const fan2Tok = await login('fan2', 'fixturepass1');

  await stop(h);
  const fx = {};
  dbAt(dir, (db) => {
    db.prepare("UPDATE moderator_invites SET expires_at = '2000-01-01 00:00:00' WHERE code = ?").run(invite3Code);
    const rel = db.prepare("INSERT INTO model_releases (model_id, method, legal_name, stage_name, dob, release_version) VALUES (?, 'esign', 'Legal Name', 'Stage', '1995-03-04', 'R1.0')");
    rel.run(stdId); rel.run(flagId); rel.run(std2Id);
    const ver = db.prepare(`INSERT INTO id_verifications
      (model_id, co_performer_id, id_front_path, id_back_path, selfie_path, consent_form_path)
      VALUES (?, ?, ?, ?, ?, ?)`);
    const P = (n) => `/fixture/${n}.jpg`;
    fx.stdVer = Number(ver.run(stdId, null, P('f'), P('b'), P('s'), null).lastInsertRowid);
    fx.norelVer = Number(ver.run(norelId, null, P('f'), P('b'), P('s'), null).lastInsertRowid);
    fx.flagVer = Number(ver.run(flagId, null, P('f'), P('b'), P('s'), null).lastInsertRowid);
    fx.std2Ver = Number(ver.run(std2Id, null, P('f'), P('b'), P('s'), null).lastInsertRowid);
    const cp = db.prepare("INSERT INTO co_performers (owner_model_id, display_name) VALUES (?, ?)");
    const cpOk = Number(cp.run(stdId, 'Partner Pam').lastInsertRowid);
    const cpNo = Number(cp.run(stdId, 'Partner NoConsent').lastInsertRowid);
    fx.cpOkVer = Number(ver.run(stdId, cpOk, P('f'), P('b'), P('s'), P('consent')).lastInsertRowid);
    fx.cpNoVer = Number(ver.run(stdId, cpNo, P('f'), P('b'), P('s'), null).lastInsertRowid);
    db.prepare("INSERT INTO strikes (subject_key, strikes, flagged) VALUES (?, 3, 1)").run('u:' + flagId);
    const conv = db.prepare('INSERT INTO conversations (fan_id, model_id) VALUES (?, ?)').run(fan2Id, stdId);
    const convId = Number(conv.lastInsertRowid);
    const inc = db.prepare(`INSERT INTO safety_incidents
      (conversation_id, sender_id, sender_role, sender_name, flagged_text, matched)
      VALUES (?, ?, 'fan', 'fan2', 'call me at my personal number', 'personal_info')`);
    fx.incWarn = Number(inc.run(convId, fan2Id).lastInsertRowid);
    fx.incDismiss = Number(inc.run(convId, fan2Id).lastInsertRowid);
    fx.liveId = Number(db.prepare("INSERT INTO live_sessions (model_id, status, is_explicit) VALUES (?, 'live', 0)").run(stdId).lastInsertRowid);
  });

  h = await boot(dir, { SEED_DEMO: '1' });
  base = h.base;
  const adm2 = await req(base, 'POST', '/api/manager/login', { body: { username: 'admin', password: 'admin123' } });
  const atok2 = adm2.json.token;
  const m2 = await req(base, 'POST', '/api/manager/login', { body: { username: 'wanda@example.com', password: 'workerpass1' } });
  assert.equal(m2.status, 200, m2.text);
  const mtok2 = m2.json.token;

  await t.test('expired invite link fails', async () => {
    const s = await req(base, 'POST', `/api/moderator-invite/${invite3Code}/signup`, {
      body: { display_name: 'Erin', email: 'erin@example.com', password: 'workerpass1' },
    });
    assert.equal(s.status, 400);
    assert.equal(s.json.error, 'invite_expired');
  });

  await t.test('ID queue classification: standard vs escalated, with reasons', async () => {
    const q = await req(base, 'GET', '/api/mod/id-verifications', { token: mtok2, mgr: true });
    assert.equal(q.status, 200, q.text);
    const byId = Object.fromEntries(q.json.verifications.map((v) => [v.id, v]));
    assert.equal(byId[fx.stdVer].queue, 'standard');
    assert.equal(byId[fx.norelVer].queue, 'escalated');
    assert.ok(byId[fx.norelVer].escalate_reasons.includes('missing_release'));
    assert.equal(byId[fx.flagVer].queue, 'escalated');
    assert.ok(byId[fx.flagVer].escalate_reasons.includes('subject_flagged'));
    assert.equal(byId[fx.cpOkVer].queue, 'standard', 'partner with consent is standard');
    assert.equal(byId[fx.cpNoVer].queue, 'escalated');
    assert.ok(byId[fx.cpNoVer].escalate_reasons.includes('missing_consent'));
    // Overview splits the same way.
    const ov = await req(base, 'GET', '/api/mod/overview', { token: mtok2, mgr: true });
    assert.equal(ov.json.pending_id_reviews, 3, 'std own + std2 own + partner-with-consent');
    assert.equal(ov.json.escalated_id_reviews, 3, 'no-release + flagged + partner-no-consent');
  });

  await t.test('ID decisions: standard approve/reject work; escalated cases refuse the moderator', async () => {
    const ap = await req(base, 'POST', `/api/mod/id-verifications/${fx.stdVer}/approve`, { token: mtok2, mgr: true, body: {} });
    assert.equal(ap.status, 200, ap.text);
    const apEsc = await req(base, 'POST', `/api/mod/id-verifications/${fx.norelVer}/approve`, { token: mtok2, mgr: true, body: {} });
    assert.equal(apEsc.status, 403);
    assert.equal(apEsc.json.error, 'escalated_case');
    const noNote = await req(base, 'POST', `/api/mod/id-verifications/${fx.cpOkVer}/reject`, { token: mtok2, mgr: true, body: {} });
    assert.equal(noNote.status, 400);
    assert.equal(noNote.json.error, 'note_required', 'a moderator rejection always carries a reason');
    const rj = await req(base, 'POST', `/api/mod/id-verifications/${fx.cpOkVer}/reject`, { token: mtok2, mgr: true, body: { note: 'Consent form is blurry — please re-upload' } });
    assert.equal(rj.status, 200, rj.text);
    const ownerList = await req(base, 'GET', '/api/admin/id-verifications', { token: atok2, mgr: true });
    const stdRow = ownerList.json.verifications.find((v) => v.id === fx.stdVer);
    assert.equal(stdRow.status, 'approved', 'the approval really landed');
    const cpRow = ownerList.json.verifications.find((v) => v.id === fx.cpOkVer);
    assert.equal(cpRow.status, 'rejected');
    assert.equal(cpRow.reviewer_note, 'Consent form is blurry — please re-upload', 'her reason reaches the packet');
  });

  await t.test('escalate: stamps the case for the owner; the owner decision clears the stamp', async () => {
    const es = await req(base, 'POST', `/api/mod/id-verifications/${fx.std2Ver}/escalate`, { token: mtok2, mgr: true, body: { reason: 'Face in the selfie might not match the ID' } });
    assert.equal(es.status, 200, es.text);
    const apAfter = await req(base, 'POST', `/api/mod/id-verifications/${fx.std2Ver}/approve`, { token: mtok2, mgr: true, body: {} });
    assert.equal(apAfter.status, 403, 'once escalated, the case is the owner\'s');
    const ownerAp = await req(base, 'POST', `/api/admin/id-verifications/${fx.std2Ver}/approve`, { token: atok2, mgr: true, body: {} });
    assert.equal(ownerAp.status, 200, ownerAp.text);
    const audit = await req(base, 'GET', '/api/admin/moderator-actions?limit=200', { token: atok2, mgr: true });
    const acts = audit.json.actions.map((x) => x.action);
    for (const want of ['id_approve', 'id_reject', 'id_escalate'])
      assert.ok(acts.includes(want), `audit has ${want}`);
  });

  await t.test('safety: warning lands as a bell; dismiss closes the flag', async () => {
    const list = await req(base, 'GET', '/api/mod/safety/incidents?status=open', { token: mtok2, mgr: true });
    assert.ok(list.json.incidents.some((i) => i.id === fx.incWarn), 'fixture incident is listed');
    const noMsg = await req(base, 'POST', `/api/mod/safety/incidents/${fx.incWarn}/warn`, { token: mtok2, mgr: true, body: {} });
    assert.equal(noMsg.status, 400);
    const warn = await req(base, 'POST', `/api/mod/safety/incidents/${fx.incWarn}/warn`, { token: mtok2, mgr: true, body: { message: 'Sharing personal contact info is against the rules.' } });
    assert.equal(warn.status, 200, warn.text);
    const notifs = await req(base, 'GET', '/api/notifications', { token: fan2Tok });
    assert.ok(JSON.stringify(notifs.json).includes('Official warning'), 'the warning bell lands on the fan');
    const dis = await req(base, 'POST', `/api/mod/safety/incidents/${fx.incDismiss}/dismiss`, { token: mtok2, mgr: true, body: {} });
    assert.equal(dis.status, 200, dis.text);
    const closed = await req(base, 'GET', '/api/mod/safety/incidents?status=dismissed', { token: mtok2, mgr: true });
    assert.ok(closed.json.incidents.some((i) => i.id === fx.incDismiss));
  });

  await t.test('live end: reason is mandatory, teardown is real, payload had no money', async () => {
    const list = await req(base, 'GET', '/api/mod/live', { token: mtok2, mgr: true });
    assert.equal(list.status, 200, list.text);
    assert.ok(list.json.sessions.some((s) => s.id === fx.liveId), 'fixture live is listed');
    assert.ok(!list.text.includes('_cents'));
    const noReason = await req(base, 'POST', `/api/mod/live/${fx.liveId}/end`, { token: mtok2, mgr: true, body: {} });
    assert.equal(noReason.status, 400);
    assert.equal(noReason.json.error, 'reason_required');
    const end = await req(base, 'POST', `/api/mod/live/${fx.liveId}/end`, { token: mtok2, mgr: true, body: { reason: 'Underage person visible on camera' } });
    assert.equal(end.status, 200, end.text);
    const after = await req(base, 'GET', '/api/mod/live', { token: mtok2, mgr: true });
    assert.ok(!after.json.sessions.some((s) => s.id === fx.liveId), 'the session is ended');
  });

  await t.test('moderator files a model hide request; the owner queue decides it', async () => {
    const filed = await req(base, 'POST', `/api/mod/models/${flagId}/deactivation-request`, { token: mtok2, mgr: true, body: { type: 'hide', reason: 'She asked in chat to disappear for a while' } });
    assert.equal(filed.status, 200, filed.text);
    const still = await req(base, 'GET', '/api/models');
    assert.ok(still.json.models.some((m) => m.id === flagId || m.username === 'modflag'), 'nothing changed on filing');
    const deny = await req(base, 'POST', `/api/admin/deactivation-requests/${filed.json.request_id}/deny`, { token: atok2, mgr: true, body: {} });
    assert.equal(deny.status, 200, deny.text);
    const mine = await req(base, 'GET', '/api/mod/requests', { token: mtok2, mgr: true });
    const row = mine.json.requests.find((r) => r.id === filed.json.request_id);
    assert.equal(row.status, 'denied', 'the moderator sees the outcome of her filing');
    const audit = await req(base, 'GET', '/api/admin/moderator-actions?limit=300', { token: atok2, mgr: true });
    const acts = audit.json.actions.map((x) => x.action);
    for (const want of ['warning_sent', 'flag_dismiss', 'live_end', 'deactivation_request'])
      assert.ok(acts.includes(want), `audit has ${want}`);
  });

  await stop(h);
  dbAt(dir, (db) => {
    const v = db.prepare('SELECT escalated_at FROM id_verifications WHERE id = ?').get(fx.std2Ver);
    assert.equal(v.escalated_at, null, 'the owner\'s decision cleared the escalation stamp');
    const bella = db.prepare("SELECT banned FROM users WHERE username = 'bella'").get();
    assert.equal(bella.banned, 1);
    const stacey = db.prepare('SELECT is_hidden FROM models WHERE user_id = ?').get(staceyId);
    assert.equal(stacey.is_hidden, 1);
  }, true);
});

test('role migration: a pre-moderator users CHECK is widened on boot, data intact', async (t) => {
  const dir = makeCopy();
  let h = await boot(dir, { SEED_DEMO: '1' });
  const { base } = h;
  const adm = await req(base, 'POST', '/api/manager/login', { body: { username: 'admin', password: 'admin123' } });
  assert.equal(adm.status, 200, adm.text);
  await stop(h);
  // Roll the stored schema back to the pre-moderator CHECK, exactly
  // the state a production DB is in before this build deploys.
  dbAt(dir, (db) => {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
    assert.ok(row.sql.includes("'moderator'"), 'fresh schema carries the role');
    const oldSql = row.sql.replace(",'moderator'", '');
    const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name).join(', ');
    db.exec('PRAGMA foreign_keys=OFF');
    db.exec(oldSql.replace(/CREATE TABLE\s+"?users"?\s*\(/i, 'CREATE TABLE users_oldcheck ('));
    db.exec(`INSERT INTO users_oldcheck (${cols}) SELECT ${cols} FROM users`);
    db.exec('DROP TABLE users');
    db.exec('ALTER TABLE users_oldcheck RENAME TO users');
    db.exec('PRAGMA foreign_keys=ON');
  });
  h = await boot(dir, { SEED_DEMO: '1' });
  t.after(async () => { await stop(h); });
  const adm2 = await req(h.base, 'POST', '/api/manager/login', { body: { username: 'admin', password: 'admin123' } });
  assert.equal(adm2.status, 200, 'seeded admin survived the rebuild');
  const c = await req(h.base, 'POST', '/api/admin/moderator-invites', { token: adm2.json.token, mgr: true, body: { label: 'Mig Mary' } });
  assert.equal(c.status, 200, c.text);
  const code = c.json.invite.url.split('/moderator-invite/')[1];
  const s = await req(h.base, 'POST', `/api/moderator-invite/${code}/signup`, {
    body: { display_name: 'Mig Mary', email: 'mary@example.com', password: 'workerpass1' },
  });
  assert.equal(s.status, 200, s.text);
  assert.equal(s.json.user.role, 'moderator', 'the widened CHECK accepts the role on a migrated DB');
  await stop(h);
  dbAt(dir, (db) => {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
    assert.ok(row.sql.includes("'moderator'"), 'stored CHECK now includes moderator');
    const n = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'model'").get();
    assert.ok(n.c >= 3, 'seeded models survived the migration');
    const dis = db.prepare("SELECT name FROM pragma_table_info('users') WHERE name = 'disabled_at'").get();
    assert.ok(dis, 'disabled_at column exists after migration');
  }, true);
});

test('source pins: guards, SRV/client copy, manager wiring', () => {
  // The role exists in the fresh schema + the migration + the stamp.
  assert.match(serverSrc, /CHECK\(role IN \('fan','model','admin','recruiter','owner_delegate','moderator'\)\)/);
  assert.match(serverSrc, /function allowModeratorRole|allowModeratorRole\(\)/);
  assert.match(serverSrc, /addColumnIfMissing\('users', 'disabled_at', 'TEXT'\)/);
  // Admin gates stay PRINCIPAL-only: since PR #104 (Owner Delegate,
  // shipped before this merge), adminOnly is the requireManager chain —
  // admin + the ENABLED delegate seat. A moderator is NOT a Manager
  // principal, so requireManager refuses the role everywhere adminOnly
  // is used; the delegate's powers are neither widened nor narrowed.
  assert.match(serverSrc, /const adminOnly = \[identMiddleware, requireUser, requireManager, requireManagerStepUp, auditDelegateMutation\]/);
  assert.match(serverSrc, /const isManagerPrincipal = \(user\) =>\s*!!user && \(user\.role === 'admin' \|\| user\.role === 'owner_delegate'\)/);
  assert.match(serverSrc, /const moderatorOnly = \[identMiddleware, requireUser, requireRole\('moderator'\)\]/);
  assert.ok(!/requireRole\('admin', 'moderator'\)/.test(serverSrc), 'no admin route was widened to the role');
  assert.ok(!/requireRole\('moderator', 'admin'\)/.test(serverSrc));
  // Invite binding + revocation plumbing.
  assert.match(serverSrc, /app\.post\('\/api\/moderator-invite\/:code\/signup'/);
  assert.match(serverSrc, /createUser\(email, password, 'moderator', displayName, null, 'en'\)/);
  assert.match(serverSrc, /app\.post\('\/api\/admin\/moderators\/:id\/disable', \.\.\.adminOnly/);
  assert.match(serverSrc, /app\.get\('\/api\/admin\/moderator-actions', \.\.\.adminOnly/);
  assert.match(serverSrc, /app\.post\('\/api\/model\/deactivation-request', identMiddleware, requireUser, requireRole\('model'\)/);
  // SRV notification copy exists for the lifecycle outcomes.
  for (const k of ['bell_deact_hide_title', 'bell_deact_hide_body', 'bell_deact_done_title',
    'bell_deact_done_body', 'bell_deact_denied_title', 'bell_deact_denied_body', 'bell_live_ended_title'])
    assert.ok(serverSrc.includes(`${k}: { en:`), `SRV key ${k}`);
  // Client Settings card keys in all 13 dictionaries.
  assert.equal((appSrc.match(/deact_h:/g) || []).length, 13, 'deact_h ×13');
  assert.equal((appSrc.match(/deact_pending:/g) || []).length, 13, 'deact_pending ×13');
  assert.match(appSrc, /id="deact-card"/);
  assert.match(appSrc, /loadDeactSettings\(\)/);
  // Manager: moderator mode + workers/requests screens are wired.
  assert.match(managerSrc, /MOD_SCREENS/);
  assert.match(managerSrc, /role === 'moderator'/);
  assert.match(managerSrc, /api\('\/mod\/overview'\)/);
  assert.match(managerSrc, /adminWorkersBody/);
  assert.match(managerSrc, /adminRequestsBody/);
  assert.match(managerSrc, /pending_deactivation_requests/);
});
