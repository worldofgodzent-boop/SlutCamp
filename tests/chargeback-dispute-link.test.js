'use strict';
/*
 * Chargeback↔dispute linkage (owner, Oct 19 2026 — CCBill-readiness
 * audit, ~/workspace/projects/ccbill-chargeback-audit-2026-10-19.md §1):
 * recording a chargeback ran the clawback engine but never created the
 * `disputes` row the retention sweep reads, so a charged-back fan's
 * chats aged out on the normal 7-day sweep while the case was live —
 * evidence protection needed the separate, unlinked "File dispute"
 * action. The fix lives in POST /api/admin/chargebacks: after a
 * successful NON-DUPLICATE chargeback, open a disputes row for the fan
 * (status 'open', keyed to the chargeback's processor reference) when
 * they have no open dispute already — at most one open dispute per fan.
 * The clawback engine, the sweep guard, and all money math are
 * untouched (pinned by payout-protection + manager-chats-monitor).
 *
 * This suite pins the linkage itself, end to end:
 *   1. a recorded chargeback opens exactly one open dispute for the
 *      fan, with the chargeback's amount + processor reference;
 *   2. a duplicate chargeback (same source+external_id) opens nothing;
 *   3. a second, distinct chargeback while a dispute is open opens no
 *      second row (it links to the existing open dispute);
 *   4. END-TO-END: chargeback recorded → the fan's >7-day-old chat
 *      messages SURVIVE a sweep run (the chain the audit could not
 *      prove), while an unprotected control conversation is swept;
 *   5. closing the dispute restores sweep eligibility.
 * Boot/seed pattern mirrors manager-chats-monitor (seed between boots)
 * and payout-protection (real HTTP + Manager endpoints throughout).
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

/* ---------------- static pins ---------------- */

test('pins: the linkage lives in the chargebacks endpoint, guarded, engine untouched', () => {
  const start = serverSrc.indexOf("app.post('/api/admin/chargebacks'");
  assert.ok(start > 0, 'chargebacks endpoint exists');
  const handler = serverSrc.slice(start, serverSrc.indexOf("app.put('/api/admin/settings'", start));
  assert.ok(handler.includes('applyChargeback('), 'endpoint still runs the clawback engine');
  assert.ok(handler.includes('if (!r.duplicate)'), 'linkage only fires on a non-duplicate chargeback');
  assert.ok(handler.includes("status = 'open'"), 'guard checks for an already-open dispute');
  assert.ok(handler.includes('INSERT INTO disputes'), 'linkage inserts the disputes row');
  assert.ok(handler.includes("'open')"), 'the new row opens in status open (what the sweep guard reads)');
  // The engine and the sweep guard themselves carry no disputes writes.
  const engine = serverSrc.slice(serverSrc.indexOf('function applyChargeback('),
    serverSrc.indexOf('function getModelFraudFlags('));
  assert.ok(!engine.includes('INSERT INTO disputes'), 'clawback engine untouched by the linkage');
});

/* ---------------- live harness (manager-chats-monitor pattern) ---------------- */

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-cblink-'));
  for (const d of ['server.js', 'package.json', 'lib', 'public', 'data']) {
    fs.cpSync(path.join(REPO, d), path.join(dir, d), { recursive: true });
  }
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  return dir;
}

async function boot(dir) {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), SEED_DEMO: '1', CRYPTO_POLL_MS: '3600000' };
  for (const k of Object.keys(env)) {
    if (/^(CCBILL_|CRYPTO_|OPENAI_|TWILIO_|VAPID_|WEBAUTHN_|AV_)/.test(k)) delete env[k];
  }
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

async function signup(base, username, role) {
  const s = await req(base, 'POST', '/api/auth/signup', {
    body: { username, password: `${username}-pass-123`, role,
      display_name: username, dob: '1995-05-05', agree18: true, ...(role === 'model' ? { section: 'female', publicity_consent: true } : {}) },
  });
  assert.equal(s.status, 200, `signup ${username}: ${s.text}`);
  return { token: s.json.token, id: s.json.user.id };
}

const ago = (days) =>
  new Date(Date.now() - days * 864e5).toISOString().slice(0, 19).replace('T', ' ');
const NOW = new Date().toISOString().slice(0, 19).replace('T', ' ');

function withDb(dir, fn) {
  const db = new DatabaseSync(path.join(dir, 'wogent-chat.db'));
  db.exec('PRAGMA busy_timeout = 10000');
  try { return fn(db); } finally { db.close(); }
}

/* ---------------- the linkage, end to end ---------------- */

test('live: chargeback opens one open dispute; sweep honors it; closing releases it', { timeout: 120000 }, async () => {
  const dir = makeCopy();
  let h = await boot(dir);
  let model, fan, control;
  try {
    const mgr1 = await mgrLogin(h.base);
    model = await signup(h.base, 'linkmodel', 'model');
    fan = await signup(h.base, 'linkfan', 'fan');
    control = await signup(h.base, 'controlfan', 'fan');
    // Give the fan spendable credits so the chargeback has a real
    // step-1 reversal to bite on (no load_ref — the manual path).
    const grant = await req(h.base, 'POST', `/api/admin/fans/${fan.id}/credits`,
      { ...mgr1, body: { amount_cents: 6000 } });
    assert.equal(grant.status, 200, `grant: ${grant.text}`);
  } finally {
    stop(h);
  }

  // Seed aged conversations directly (chatmon pattern): the dispute
  // fan's chat and an unprotected control chat, both >7 days old.
  const S = withDb(dir, (db) => {
    const insConv = db.prepare(
      'INSERT INTO conversations (fan_id, model_id, is_official, updated_at) VALUES (?,?,0,?)');
    const insMsg = db.prepare(
      'INSERT INTO messages (conversation_id, sender_id, body, created_at) VALUES (?,?,?,?)');
    const convFan = Number(insConv.run(fan.id, model.id, ago(11)).lastInsertRowid);
    insMsg.run(convFan, fan.id, 'evidence one', ago(11));
    insMsg.run(convFan, model.id, 'evidence two', ago(10));
    const convCtl = Number(insConv.run(control.id, model.id, ago(11)).lastInsertRowid);
    insMsg.run(convCtl, control.id, 'control one', ago(11));
    insMsg.run(convCtl, model.id, 'control two', ago(10));
    return { convFan, convCtl };
  });

  h = await boot(dir);
  try {
    const mgr = await mgrLogin(h.base);
    const disputesFor = async (userId) =>
      (await req(h.base, 'GET', '/api/admin/disputes', mgr)).json.disputes
        .filter((d) => d.user_id === userId);
    const cleanup = () => req(h.base, 'POST', '/api/admin/conversations/cleanup', { ...mgr });
    const msgCount = (convId) => withDb(dir, (db) =>
      db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(convId).n);
    const convExists = (convId) => withDb(dir, (db) =>
      !!db.prepare('SELECT id FROM conversations WHERE id = ?').get(convId));

    assert.equal((await disputesFor(fan.id)).length, 0, 'no dispute exists before any chargeback');

    /* (1) recording a chargeback opens exactly one open dispute */
    const cb1 = await req(h.base, 'POST', '/api/admin/chargebacks', { ...mgr,
      body: { user_id: fan.id, amount_cents: 2500, external_id: 'cb-link-1', reason: 'issuer chargeback' } });
    assert.equal(cb1.status, 200, `cb1: ${cb1.text}`);
    assert.equal(cb1.json.ok, true);
    assert.ok(Number.isInteger(cb1.json.dispute_id), 'response carries the opened dispute id');
    assert.deepEqual(cb1.json.reversed,
      { fan_cents: 2500, model_cents: 0, negative_cents: 0, platform_absorbed_cents: 0 },
      'the clawback itself is unchanged: step 1 takes the fan’s unspent credits');
    let rows = await disputesFor(fan.id);
    assert.equal(rows.length, 1, 'exactly one dispute row for the fan');
    assert.equal(rows[0].id, cb1.json.dispute_id, 'the listed dispute is the one the response named');
    assert.equal(rows[0].status, 'open', 'the dispute is open (what the sweep guard keys on)');
    assert.equal(rows[0].amount_cents, 2500, 'dispute amount = the chargeback amount');
    assert.equal(rows[0].transaction_ref, 'cb-link-1', 'dispute is keyed to the chargeback’s processor reference');
    assert.ok(rows[0].reason.includes('Chargeback manual:cb-link-1'),
      `reason names the chargeback: ${rows[0].reason}`);
    assert.ok(rows[0].reason.includes('issuer chargeback'), 'the operator’s reason is preserved');
    const disputeId = rows[0].id;

    /* (2) a duplicate chargeback creates no second dispute */
    const replay = await req(h.base, 'POST', '/api/admin/chargebacks', { ...mgr,
      body: { user_id: fan.id, amount_cents: 2500, external_id: 'cb-link-1', reason: 'issuer chargeback' } });
    assert.equal(replay.status, 200, `replay: ${replay.text}`);
    assert.equal(replay.json.duplicate, true, 'replay is the engine’s idempotent no-op');
    rows = await disputesFor(fan.id);
    assert.equal(rows.length, 1, 'duplicate chargeback opened no second dispute');
    assert.equal(rows[0].id, disputeId);

    /* (3) a second, distinct chargeback opens no duplicate open dispute */
    const cb2 = await req(h.base, 'POST', '/api/admin/chargebacks', { ...mgr,
      body: { user_id: fan.id, amount_cents: 500, external_id: 'cb-link-2' } });
    assert.equal(cb2.status, 200, `cb2: ${cb2.text}`);
    assert.equal(cb2.json.dispute_id, disputeId, 'the second chargeback links to the existing open dispute');
    rows = await disputesFor(fan.id);
    assert.equal(rows.filter((d) => d.status === 'open').length, 1, 'still exactly one open dispute for the fan');
    assert.equal(rows.length, 1, 'and still exactly one dispute row in total');

    /* (4) END-TO-END: the fan's aged messages survive a sweep run;
           the unprotected control conversation does not */
    const run1 = await cleanup();
    assert.equal(run1.status, 200, `cleanup: ${run1.text}`);
    assert.equal(msgCount(S.convFan), 2, 'chargeback fan’s aged messages SURVIVED the sweep — evidence kept');
    assert.ok(convExists(S.convFan), 'the protected conversation itself is intact');
    assert.equal(msgCount(S.convCtl), 0, 'control fan’s aged messages were swept — the sweep really ran');
    assert.ok(!convExists(S.convCtl), 'the emptied control conversation was removed');

    /* (5) closing the dispute restores sweep eligibility */
    const close = await req(h.base, 'PUT', `/api/admin/disputes/${disputeId}`, { ...mgr, body: { status: 'won' } });
    assert.equal(close.status, 200, `close dispute: ${close.text}`);
    const run2 = await cleanup();
    assert.equal(run2.status, 200, `cleanup 2: ${run2.text}`);
    assert.equal(msgCount(S.convFan), 0, 'once the case closes, the fan’s aged messages sweep normally');
    assert.ok(!convExists(S.convFan), 'the emptied conversation is removed after close');
  } finally {
    stop(h);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
