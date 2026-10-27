'use strict';
/*
 * Tip endpoint payload validation (launch-audit finding F9b, Oct 19 2026).
 *
 * POST /api/models/:id/tip used to pass req.body.menu_id straight into the
 * tip_menus lookup; a body without a usable menu_id (missing, null, object,
 * array) detonated as an unhandled 500 HTML stack page (TypeError: unbound
 * SQLite parameter). Pins:
 *  - missing menu_id            -> 400 JSON { error: 'menu_id_required' }
 *  - null / object / array / '' -> 400 JSON, never a 500, and NO money moves
 *  - well-formed but unknown id -> the pre-existing clean 404
 *    { error: 'menu_item_not_found' } (default-N past the end, unknown
 *    numeric custom id)
 *  - the happy path is byte-for-byte the old behavior: fan debited the menu
 *    price exactly once, model gross sales += price, rank_score moves by
 *    the 60% credited share in dollars (default-1: 1000c -> +$6.00).
 */
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const REPO = path.join(__dirname, '..');

/* ---------------- boot harness (mirrors tests/spend-dashboard.test.js) ---------------- */

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function boot(dir) {
  for (const d of ['server.js', 'package.json', 'lib', 'public', 'data']) {
    fs.cpSync(path.join(REPO, d), path.join(dir, d), { recursive: true });
  }
  if (!fs.existsSync(path.join(dir, 'node_modules'))) {
    fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  }
  const port = await freePort();
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(CCBILL_|CRYPTO_|OPENAI_|TWILIO_|VAPID_|WEBAUTHN_)/.test(k)) delete env[k];
  }
  Object.assign(env, { PORT: String(port), SEED_DEMO: '1', CRYPTO_POLL_MS: '3600000' });
  const child = spawn(process.execPath, ['server.js'], { cwd: dir, env });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode})\n${log}`);
    try { const r = await fetch(base + '/api/health'); if (r.ok) break; } catch (e) { /* not up */ }
    if (Date.now() > deadline) throw new Error(`server did not come up\n${log}`);
    await new Promise((r) => setTimeout(r, 150));
  }
  return { dir, base, child, log: () => log,
    async kill() { if (child.exitCode === null) child.kill('SIGKILL'); await new Promise((r) => setTimeout(r, 300)); } };
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

/* ---------------- scenario helpers ---------------- */

async function signup(base, username, role) {
  const s = await req(base, 'POST', '/api/auth/signup', {
    body: { username, password: `${username}-pass-123`, role,
      display_name: username, dob: '1995-05-05', agree18: true, ...(role === 'model' ? { section: 'female', publicity_consent: true } : {}) },
  });
  assert.equal(s.status, 200, `signup ${username}: ${s.text}`);
  return { token: s.json.token, id: s.json.user.id };
}
const mgrLogin = async (base) => {
  const adm = await req(base, 'POST', '/api/manager/login', { body: { username: 'admin', password: 'admin123' } });
  assert.equal(adm.status, 200, `manager login: ${adm.text}`);
  return { token: adm.json.token, headers: { 'x-manager': '1' } };
};
const grant = async (base, mgr, fanId, cents) => {
  const r = await req(base, 'POST', `/api/admin/fans/${fanId}/credits`, { ...mgr, body: { amount_cents: cents } });
  assert.equal(r.status, 200, `grant: ${r.text}`);
};
function dbRead(dir, fn) {
  const db = new DatabaseSync(path.join(dir, 'wogent-chat.db'));
  db.exec('PRAGMA busy_timeout = 10000');
  try { return fn(db); } finally { db.close(); }
}
const salesOf = (dir, modelId) => dbRead(dir, (db) =>
  db.prepare(`SELECT COALESCE(SUM(gross_cents), 0) AS s FROM transactions
              WHERE model_id = ? AND type <> 'payout' AND is_test = 0`).get(modelId).s);
const rankOf = async (base, modelId) => {
  const r = await req(base, 'GET', '/api/models');
  assert.equal(r.status, 200, `models list: ${r.text}`);
  const m = (r.json.models || []).find((x) => x.id === modelId);
  assert.ok(m, 'model present in /api/models');
  return m.rank_score;
};

/* ---------------- the scenario ---------------- */

test('tip: malformed payloads are clean 400 JSON (never 500); unknown ids stay 404; happy path unchanged', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-tipval-'));
  const srv = await boot(dir);
  after(async () => { await srv.kill(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = srv.base;

  const fan = await signup(base, 'tipvalfan', 'fan');
  const model = await signup(base, 'tipvalmodel', 'model');
  const mgr = await mgrLogin(base);
  await grant(base, mgr, fan.id, 10000);

  const tip = (body) => req(base, 'POST', `/api/models/${model.id}/tip`, { token: fan.token, body });
  const salesBefore = salesOf(dir, model.id);
  const rankBefore = await rankOf(base, model.id);

  // Missing menu_id — the audit's exact probe shape.
  const missing = await tip({ amount_cents: 100 });
  assert.equal(missing.status, 400, `missing menu_id: ${missing.text}`);
  assert.equal(missing.json && missing.json.error, 'menu_id_required', `missing menu_id body: ${missing.text}`);

  // Empty body entirely.
  const empty = await tip({});
  assert.equal(empty.status, 400, `empty body: ${empty.text}`);
  assert.equal(empty.json && empty.json.error, 'menu_id_required');

  // Malformed menu_id types (null / object / array / boolean / empty string).
  for (const bad of [null, { id: 1 }, ['default-1'], true, '', '   ']) {
    const r = await tip({ menu_id: bad, context: 'profile' });
    assert.equal(r.status, 400, `menu_id=${JSON.stringify(bad)}: ${r.status} ${r.text}`);
    assert.equal(r.json && r.json.error, 'menu_id_required', `menu_id=${JSON.stringify(bad)} body: ${r.text}`);
  }

  // Well-formed but unresolvable ids keep the pre-existing clean 404.
  for (const unknown of ['default-99', 424242]) {
    const r = await tip({ menu_id: unknown, context: 'profile' });
    assert.equal(r.status, 404, `menu_id=${unknown}: ${r.status} ${r.text}`);
    assert.equal(r.json && r.json.error, 'menu_item_not_found', `menu_id=${unknown} body: ${r.text}`);
  }

  // None of the rejected requests moved money or sales.
  const salesMid = salesOf(dir, model.id);
  assert.equal(salesMid, salesBefore, 'rejected tips must not move model sales');

  // Happy path — exactly the old behavior (default-1 = 1000c).
  const ok = await tip({ menu_id: 'default-1', context: 'profile' });
  assert.equal(ok.status, 200, `happy tip: ${ok.text}`);
  assert.equal(ok.json.ok, true);
  assert.equal(ok.json.price_cents, 1000);
  assert.equal(ok.json.balance_cents, 10000 - 1000,
    'fan debited exactly the menu price once (which also proves the 400/404 attempts charged nothing)');

  const salesAfter = salesOf(dir, model.id);
  assert.equal(salesAfter - salesBefore, 1000, 'model gross sales += the full tip price');
  const rankAfter = await rankOf(base, model.id);
  assert.ok(Math.abs((rankAfter - rankBefore) - 6) < 1e-9,
    `rank_score moves by the 60% credited share in dollars (+6.00), got ${rankBefore} -> ${rankAfter}`);
});
