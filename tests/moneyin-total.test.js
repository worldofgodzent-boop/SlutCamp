'use strict';
/*
 * Overview "Fan money added" combined total (Asce, Oct 22 2026).
 *
 * The Payouts tab already breaks wallet loads down by source
 * ("💰 Money in — wallet loads by source", fed by /api/admin/loads).
 * Asce wants ONE number — every rail poured together — on the
 * Overview tab. Pins:
 *  - GET /api/admin/overview carries money_in_today_cents +
 *    money_in_all_time_cents, computed by loadTotalsBySource — the
 *    very function that feeds /api/admin/loads — so the headline can
 *    never drift from the breakdown it summarizes (one ruler).
 *  - Seeded fixtures across all four rails (CCBill credited orders,
 *    credited crypto invoices, admin credit_grant rows, refund
 *    re-credits) land in the Overview totals EXACTLY as they land in
 *    the /admin/loads totals, window by window.
 *  - The loads aggregation's own exclusions hold: pending/uncredited
 *    rows, zero-credit invoices, and is_test credit grants never
 *    count; spend-type ledger rows (tips etc.) are not loads.
 *  - Manager Overview renders the two tiles from those fields.
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
const SERVER_SRC = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
const MANAGER_SRC = fs.readFileSync(path.join(REPO, 'public', 'manager', 'manager.js'), 'utf8');

/* ---------------- static pins ---------------- */

test('static: overview endpoint sums fan money added via the loads aggregator itself', () => {
  const start = SERVER_SRC.indexOf("app.get('/api/admin/overview'");
  assert.ok(start >= 0, 'overview route exists');
  const end = SERVER_SRC.indexOf("app.get('/api/admin/stats'", start);
  assert.ok(end > start, 'overview route block bounded');
  const block = SERVER_SRC.slice(start, end);
  assert.ok(block.includes('loadTotalsBySource(chicagoStartOfDaySql())'),
    'today window comes from loadTotalsBySource (one ruler)');
  assert.ok(block.includes('loadTotalsBySource(null)'),
    'all-time window comes from loadTotalsBySource (one ruler)');
  assert.ok(block.includes('money_in_today_cents'), 'overview carries money_in_today_cents');
  assert.ok(block.includes('money_in_all_time_cents'), 'overview carries money_in_all_time_cents');
});

test('static: Manager Overview renders the combined fan-money-added tiles', () => {
  assert.ok(MANAGER_SRC.includes('💰 Fan money added · all-time'), 'all-time tile label');
  assert.ok(MANAGER_SRC.includes('Fan money added · today'), 'today tile label');
  assert.ok(MANAGER_SRC.includes('o.money_in_all_time_cents'), 'all-time tile reads the overview field');
  assert.ok(MANAGER_SRC.includes('o.money_in_today_cents'), 'today tile reads the overview field');
});

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

const mgrLogin = async (base) => {
  const adm = await req(base, 'POST', '/api/manager/login', { body: { username: 'admin', password: 'admin123' } });
  assert.equal(adm.status, 200, `manager login: ${adm.text}`);
  return { token: adm.json.token, headers: { 'x-manager': '1' } };
};

/* ---------------- live scenario: fixtures across all four rails ---------------- */

let B = null;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-moneyin-'));
after(async () => {
  if (B) { try { await B.kill(); } catch (_) { /* already gone */ } }
  // Boot copies leak ~46MB each into /tmp; remove ours (gate hygiene).
  fs.rmSync(dir, { recursive: true, force: true });
});

test('live: overview money-added totals equal the /admin/loads totals, all rails, both windows',
  { timeout: 180000 }, async () => {
    // Boot 1 — create schema + one fan through the real API.
    const b1 = await boot(dir);
    const s = await req(b1.base, 'POST', '/api/auth/signup', {
      body: { username: 'moneyinfan', password: 'moneyinfan-pass-123', role: 'fan',
        display_name: 'Money In Fan', dob: '1995-05-05', agree18: true },
    });
    assert.equal(s.status, 200, `fan signup: ${s.text}`);
    const fanId = s.json.user.id;
    await b1.kill();

    // DB surgery — one fixture per rail per window, plus rows that
    // must NEVER count (pending, zero-credit, is_test, spend-type).
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const OLD = '2020-06-15 12:00:00';
    const db = new DatabaseSync(path.join(dir, 'wogent-chat.db'));
    // Rail 1 — CCBill credited orders (pending order must not count)
    db.prepare(`INSERT INTO ccbill_orders (token, user_id, amount_cents, status, credited_at)
                VALUES ('mi-t1', ?, 5000, 'credited', ?)`).run(fanId, now);
    db.prepare(`INSERT INTO ccbill_orders (token, user_id, amount_cents, status, credited_at)
                VALUES ('mi-t2', ?, 7000, 'credited', ?)`).run(fanId, OLD);
    db.prepare(`INSERT INTO ccbill_orders (token, user_id, amount_cents, status, credited_at)
                VALUES ('mi-t3', ?, 99900, 'pending', NULL)`).run(fanId);
    // Rail 2 — crypto invoices (zero-credit + pending must not count)
    const inv = `INSERT INTO crypto_invoices
      (user_id, package_id, package_usd_cents, coin, amount_crypto, amount_units,
       rate_usd, address, expires_at, status, credited_cents, credited_at)
      VALUES (?, 'custom', 0, ?, '0', 0, 1, 'addr', '2030-01-01 00:00:00', ?, ?, ?)`;
    db.prepare(inv).run(fanId, 'BTC', 'credited', 3000, now);
    db.prepare(inv).run(fanId, 'USDT', 'credited_partial', 2500, OLD);
    db.prepare(inv).run(fanId, 'ETH', 'credited', 0, now);
    db.prepare(inv).run(fanId, 'SOL', 'pending', 0, null);
    // Rail 3 — admin credit grants (is_test grant + a spend row must not count)
    db.prepare(`INSERT INTO transactions (fan_id, type, gross_cents, is_test, created_at)
                VALUES (?, 'credit_grant', 1200, 0, ?)`).run(fanId, now);
    db.prepare(`INSERT INTO transactions (fan_id, type, gross_cents, is_test, created_at)
                VALUES (?, 'credit_grant', 800, 0, ?)`).run(fanId, OLD);
    db.prepare(`INSERT INTO transactions (fan_id, type, gross_cents, is_test, created_at)
                VALUES (?, 'credit_grant', 44400, 1, ?)`).run(fanId, now);
    db.prepare(`INSERT INTO transactions (fan_id, type, gross_cents, is_test, created_at)
                VALUES (?, 'tip', 77700, 0, ?)`).run(fanId, now);
    // Rail 4 — refund re-credits
    db.prepare(`INSERT INTO refunds (user_id, amount_cents, reason, created_at)
                VALUES (?, 400, 'fixture', ?)`).run(fanId, now);
    db.prepare(`INSERT INTO refunds (user_id, amount_cents, reason, created_at)
                VALUES (?, 600, 'fixture', ?)`).run(fanId, OLD);
    db.close();

    // Boot 2 — the same DB, now read both endpoints as the Manager.
    B = await boot(dir);
    const mgr = await mgrLogin(B.base);
    const loads = await req(B.base, 'GET', '/api/admin/loads?limit=100', { ...mgr });
    assert.equal(loads.status, 200, `loads: ${loads.text}`);
    const ov = await req(B.base, 'GET', '/api/admin/overview', { ...mgr });
    assert.equal(ov.status, 200, `overview: ${ov.text}`);

    // Hand-computed expectations.
    //   today:    5000 (ccbill) + 3000 (crypto) + 1200 (admin) + 400 (refund) = 9600
    //   all-time: today + 7000 + 2500 + 800 + 600 = 20500
    assert.equal(loads.json.totals.today.total_cents, 9600, 'loads today fixture sum');
    assert.equal(loads.json.totals.all_time.total_cents, 20500, 'loads all-time fixture sum');
    // The headline equals the breakdown — by construction, and in fact.
    assert.equal(ov.json.money_in_today_cents, 9600, 'overview today == loads today');
    assert.equal(ov.json.money_in_all_time_cents, 20500, 'overview all-time == loads all-time');
    assert.equal(ov.json.money_in_today_cents, loads.json.totals.today.total_cents);
    assert.equal(ov.json.money_in_all_time_cents, loads.json.totals.all_time.total_cents);
    // The pre-existing overview money fields are untouched.
    assert.equal(typeof ov.json.gross_today_cents, 'number');
    assert.equal(typeof ov.json.all_time.gross_cents, 'number');
  });
