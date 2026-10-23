'use strict';
/*
 * Custom Packages (owner, Oct 22 2026).
 *
 * Fans buy a model's pre-made packages or request a custom one. On a
 * request the MODEL sets the price after they talk in the request
 * thread; at payment the fan fills his shipping address + email; the
 * model sees shipping ONLY on the order. Credits are HELD at payment
 * and released on fan-confirmed receipt or 7 days after she marks
 * shipped; full refund if never shipped in 7 days; Manager settles
 * disputes from the hold. Pins:
 *  - Schema: the four package tables + the exactly-once partial
 *    unique index on (fan_id, client_request_id).
 *  - Escrow: payment debits the fan and writes ONE zero-split
 *    'package' row (battle-escrow pattern); the model is credited
 *    NOTHING until release; release splits 60/40 via 'package_release';
 *    refund re-credits the fan via a negative 'package_refund' row.
 *  - Exactly-once: a retried buy/accept with the same
 *    client_request_id returns the same order, charged once.
 *  - States: held → shipped → released (confirm OR the 7-day sweep);
 *    held unshipped 7 days → fan cancel refunds; disputed orders never
 *    auto-release; Manager release/refund settle any open hold.
 *  - Privacy: order LISTS never carry ship_* fields; the detail shows
 *    them only to the fan himself and the fulfilling model; a third
 *    party gets 403. The only return address anywhere is the SlutCamp
 *    business address constant.
 *  - Requests: own thread tables, chatScan blocks off-platform
 *    contact in the description AND thread messages; quote by the
 *    model only; decline/withdraw close the thread.
 *  - House: the official account cannot be requested from and lists
 *    no packages; buying requires the fan role structurally.
 *  - Spend: 'package' is its own dashboard category and refunds net
 *    against it (12 categories total).
 *  - Migration: a DB from the previous schema (package tables
 *    dropped) reboots with the tables recreated and data intact.
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
const APP_SRC = fs.readFileSync(path.join(REPO, 'public', 'js', 'app.js'), 'utf8');
const MANAGER_SRC = fs.readFileSync(path.join(REPO, 'public', 'manager', 'manager.js'), 'utf8');

/* ---------------- static pins ---------------- */

test('static: schema — four package tables, escrow states, exactly-once index', () => {
  for (const tbl of ['model_packages', 'package_requests', 'package_request_messages', 'package_orders'])
    assert.ok(SERVER_SRC.includes(`CREATE TABLE IF NOT EXISTS ${tbl}`), `${tbl} created`);
  assert.ok(SERVER_SRC.includes("'held','shipped','disputed','released','refunded'"),
    'order status CHECK carries the five hold states');
  assert.ok(SERVER_SRC.includes('ON package_orders(fan_id, client_request_id) WHERE client_request_id IS NOT NULL'),
    'exactly-once partial unique index on client_request_id');
  assert.ok(SERVER_SRC.includes('hold_txn_id'), 'order links its hold ledger row');
});

test('static: escrow — hold is a zero-split package row; release splits 60/40; refund nets spend', () => {
  assert.ok(SERVER_SRC.includes("packages: ['package']"), 'package spend category exists');
  assert.ok(SERVER_SRC.includes("package_refund: 'packages'"), 'package refunds net the packages category');
  const create = SERVER_SRC.slice(SERVER_SRC.indexOf('function createPackageOrder'),
    SERVER_SRC.indexOf('function releasePackageHold'));
  assert.ok(create.includes('assertFanCanSpend'), 'payment passes the standard spend gate');
  assert.ok(create.includes("'package', ?, 0, 0, NULL, 0"), 'hold row carries the gross with ZERO splits');
  const release = SERVER_SRC.slice(SERVER_SRC.indexOf('function releasePackageHold'),
    SERVER_SRC.indexOf('function refundPackageHold'));
  assert.ok(release.includes('splitPayment('), 'release uses the standard 60/40 split');
  assert.ok(release.includes("'package_release'"), 'release writes its own ledger row');
  assert.ok(release.includes("status IN ('held','shipped','disputed')"),
    'release is claimed conditionally — never paid twice');
  const refund = SERVER_SRC.slice(SERVER_SRC.indexOf('function refundPackageHold'),
    SERVER_SRC.indexOf('function packageAutoReleaseSweep'));
  assert.ok(refund.includes("'package_refund'"), 'refund writes a package_refund row');
  assert.ok(refund.includes('-order.price_cents'), 'refund row is negative (nets his spend)');
});

test('static: the ONLY return address is the SlutCamp business address', () => {
  assert.ok(SERVER_SRC.includes('500 Navarro St, 2nd Floor, PMB 7239'), 'business return address constant');
  assert.ok(SERVER_SRC.includes('PKG_RETURN_ADDRESS'), 'return address is one named constant');
  const detail = SERVER_SRC.slice(SERVER_SRC.indexOf('function packageOrderOut'),
    SERVER_SRC.indexOf('function pkgNotify'));
  assert.ok(detail.includes('viewerId === o.model_id'), 'return block goes to the fulfilling model only');
});

test('static: routes — fan-only buying, house refused, admin settle endpoints, photo via shared pipeline', () => {
  assert.ok(SERVER_SRC.includes("app.post('/api/packages/:id/buy', identMiddleware, requireUser, requireRole('fan')"),
    'buying requires the fan role (the model-role house account can never buy)');
  assert.ok(SERVER_SRC.includes("app.post('/api/package-requests/:id/accept', identMiddleware, requireUser, requireRole('fan')"),
    'accepting a quote requires the fan role');
  assert.ok(SERVER_SRC.includes("app.get('/api/admin/package-orders', ...adminOnly"), 'Manager order list is admin-gated');
  assert.ok(SERVER_SRC.includes("app.post('/api/admin/package-orders/:id/release', ...adminOnly"), 'Manager release is admin-gated');
  assert.ok(SERVER_SRC.includes("app.post('/api/admin/package-orders/:id/refund', ...adminOnly"), 'Manager refund is admin-gated');
  const photo = SERVER_SRC.slice(SERVER_SRC.indexOf("app.post('/api/model/packages/:id/photo'"),
    SERVER_SRC.indexOf("app.get('/api/models/:id/packages'"));
  assert.ok(photo.includes('photoUpload.single'), 'package photo rides the shared photo pipeline');
  assert.ok(SERVER_SRC.includes('packageAutoReleaseSweep'), 'the 7-day auto-release sweep exists');
});

test('static: client + manager wiring — peek, thread view, settings, wallet, spend label, Manager tab', () => {
  assert.ok(APP_SRC.includes('pkgRequest: vPackageRequest'), 'request thread is a registered view');
  assert.ok(APP_SRC.includes("'pkgRequest'"), 'pkgRequest is reachable by models (MODEL_VIEWS)');
  assert.ok(APP_SRC.includes('id="peek-packages"'), 'model peek carries the packages section');
  assert.ok(APP_SRC.includes('id="pkg-req-box"'), 'chat list carries the package requests box');
  assert.ok(APP_SRC.includes('loadPkgManager'), 'Settings carries her package manager');
  assert.ok(APP_SRC.includes('id="pkg-fan-orders"'), 'wallet carries the fan order list');
  assert.equal((APP_SRC.match(/spend_cat_packages:/g) || []).length, 13,
    'the Packages spend label exists in all 13 languages');
  assert.equal((APP_SRC.match(/pkg_pay_btn:/g) || []).length, 13,
    'package strings are carried in all 13 languages');
  assert.ok(MANAGER_SRC.includes('adminPackagesBody'), 'Manager has the Packages screen');
  assert.ok(MANAGER_SRC.includes("'/admin/package-orders'"), 'Manager reads the admin order list');
  assert.ok(MANAGER_SRC.includes("['packages', '📦 Packages']"), 'Manager nav carries Packages');
});

/* ---------------- boot harness (mirrors tests/fan-pics.test.js) ---------------- */

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

const stamp = Date.now().toString(36);

async function signupFan(base, name) {
  const s = await req(base, 'POST', '/api/auth/signup', {
    body: { username: `${name}${stamp}`, password: `${name}-pass-123`, role: 'fan',
      display_name: name, dob: '1995-05-05', agree18: true },
  });
  assert.equal(s.status, 200, `fan signup ${name}: ${s.text}`);
  return { token: s.json.token, id: s.json.user.id, username: `${name}${stamp}` };
}

/* 1x1 PNG — passes the shared image pipeline (type whitelist + size). */
const pngBuf = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64');
async function uploadForm(base, p, token, fields, fileField, filename) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields || {})) fd.append(k, v);
  if (fileField) fd.append(fileField, new Blob([pngBuf], { type: 'image/png' }), filename || 'pic.png');
  const r = await fetch(base + p, { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: fd });
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

/* Model signup + house-release e-sign via the real API + ID approval
 * by DB surgery (the av-shield fixture pattern) — a fully onboarded
 * model, since packages are an in-app model feature behind the
 * release door. */
async function modelSignup(base, dir, name) {
  const un = `${name}${stamp}`;
  const s = await req(base, 'POST', '/api/auth/signup', {
    body: { username: un, password: `${name}-pass-123`, role: 'model',
      display_name: name, dob: '1996-06-06', agree18: true, section: 'female' },
  });
  assert.equal(s.status, 200, `model signup ${name}: ${s.text}`);
  const token = s.json.token, userId = s.json.user.id;
  const rel = await req(base, 'POST', '/api/model/release/sign', { token, body: {
    legal_name: 'Fixture Model', stage_name: name, dob: '1996-06-06',
    attestations: { adult: true, freewill: true, rights: true } } });
  assert.equal(rel.status, 200, `release agree: ${rel.text}`);
  const d = new DatabaseSync(path.join(dir, 'wogent-chat.db'));
  try {
    d.prepare("INSERT INTO id_verifications (model_id, status) VALUES (?, 'approved')").run(userId);
  } finally { d.close(); }
  return { token, id: userId, username: un };
}

const SHIP = { ship_name: 'Fixture Fan', ship_street: '1 Test Way', ship_city: 'Austin',
  ship_state: 'TX', ship_zip: '78701', ship_country: 'USA', ship_email: 'fan@example.test' };

/* ---------------- live lifecycle ---------------- */

let B = null;
const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-pkg-'));
after(async () => {
  if (B) { try { await B.kill(); } catch (_) { /* already gone */ } }
  fs.rmSync(dir1, { recursive: true, force: true });
});

test('live: packages — CRUD, escrow lifecycle, requests, privacy, house, spend',
  { timeout: 300000 }, async () => {
    B = await boot(dir1);
    const base = B.base;
    const db = () => new DatabaseSync(path.join(dir1, 'wogent-chat.db'));
    const sql = (q, ...args) => { const d = db(); try { return d.prepare(q).all(...args); } finally { d.close(); } };
    const sqlRun = (q, ...args) => { const d = db(); try { return d.prepare(q).run(...args); } finally { d.close(); } };
    const walletOf = (id) => sql('SELECT * FROM wallets WHERE user_id = ?', id)[0];
    const setCredits = (id, cents) => sqlRun('UPDATE wallets SET credits_cents = ? WHERE user_id = ?', cents, id);
    const txns = (type, fanId) => sql('SELECT * FROM transactions WHERE type = ? AND fan_id = ?', type, fanId);

    const mgr = await mgrLogin(base);
    const model = await modelSignup(base, dir1, 'pkgmodel');
    const model2 = await modelSignup(base, dir1, 'pkgmodel2');
    const fan = await signupFan(base, 'pkgfan');
    const fan2 = await signupFan(base, 'pkgfan2');
    const poor = await signupFan(base, 'pkgpoor');
    setCredits(fan.id, 100000);
    setCredits(fan2.id, 50000);
    setCredits(poor.id, 100);

    /* ---- her package list: create, validate, edit, photo ---- */
    let r = await req(base, 'POST', '/api/model/packages', { token: model.token,
      body: { title: 'Silk Set', description: 'Silk + a note', price_credits: 50 } });
    assert.equal(r.status, 200, `create package: ${r.text}`);
    const pkgId = r.json.package.id;
    assert.equal(r.json.package.price_cents, 5000);
    r = await req(base, 'POST', '/api/model/packages', { token: model.token,
      body: { title: 'Bad', price_credits: 0 } });
    assert.equal(r.status, 400, 'zero price refused');
    r = await req(base, 'POST', '/api/model/packages', { token: model.token,
      body: { title: '', price_credits: 10 } });
    assert.equal(r.status, 400, 'empty title refused');
    r = await req(base, 'PUT', `/api/model/packages/${pkgId}`, { token: model.token,
      body: { price_credits: 60 } });
    assert.equal(r.status, 200, `edit price: ${r.text}`);
    assert.equal(r.json.package.price_cents, 6000);
    r = await req(base, 'PUT', `/api/model/packages/${pkgId}`, { token: model2.token,
      body: { price_credits: 1 } });
    assert.equal(r.status, 404, "another model cannot edit her package");
    const photo = await uploadForm(base, `/api/model/packages/${pkgId}/photo`, model.token, {}, 'file', 'pkg.png');
    assert.equal(photo.status, 200, `package photo: ${photo.text}`);
    assert.match(photo.json.photo_url, /^\/uploads\/photo-/, 'photo rides the public pipeline naming');
    const photoGet = await fetch(base + photo.json.photo_url);
    assert.equal(photoGet.status, 200, 'package photo is publicly served');
    r = await req(base, 'GET', `/api/models/${model.id}/packages`);
    assert.equal(r.status, 200);
    assert.equal(r.json.packages.length, 1, 'public list carries her active package');
    assert.equal(r.json.packages[0].price_cents, 6000);

    /* ---- buy #1: the hold ---- */
    r = await req(base, 'POST', `/api/packages/${pkgId}/buy`, { token: fan.token,
      body: { ...SHIP, client_request_id: 'cp-buy-1' } });
    assert.equal(r.status, 200, `buy: ${r.text}`);
    const order1 = r.json.order;
    assert.equal(order1.status, 'held');
    assert.equal(walletOf(fan.id).credits_cents, 94000, 'fan debited into the hold');
    assert.equal(walletOf(model.id).earnings_cents, 0, 'model earns NOTHING while held');
    const holds = txns('package', fan.id);
    assert.equal(holds.length, 1, 'exactly one hold ledger row');
    assert.equal(holds[0].gross_cents, 6000);
    assert.equal(holds[0].model_cents, 0, 'hold row model split is zero');
    assert.equal(holds[0].platform_cents, 0, 'hold row platform split is zero');
    assert.equal(order1.ship_email, SHIP.ship_email, 'the buyer sees his own shipping on the detail');

    /* lists never carry shipping; third parties are shut out */
    r = await req(base, 'GET', '/api/orders', { token: fan.token });
    assert.equal(r.json.orders.length, 1);
    assert.ok(!JSON.stringify(r.json).includes(SHIP.ship_email), 'fan order LIST carries no shipping email');
    r = await req(base, 'GET', '/api/orders', { token: model.token });
    assert.equal(r.json.orders.length, 1, 'the model sees the order in her list');
    assert.ok(!JSON.stringify(r.json).includes(SHIP.ship_email), 'model order LIST carries no shipping email');
    r = await req(base, 'GET', `/api/orders/${order1.id}`, { token: model.token });
    assert.equal(r.json.order.ship_email, SHIP.ship_email, 'the fulfilling model sees shipping on the ORDER');
    assert.ok(JSON.stringify(r.json.order.return_block || '').includes('500 Navarro St'),
      'the model detail carries the business return address');
    r = await req(base, 'GET', `/api/orders/${order1.id}`, { token: fan2.token });
    assert.equal(r.status, 403, 'a third-party fan cannot open the order');
    r = await req(base, 'GET', `/api/orders/${order1.id}`, { token: model2.token });
    assert.equal(r.status, 403, 'another model cannot open the order');

    /* exactly-once retry */
    r = await req(base, 'POST', `/api/packages/${pkgId}/buy`, { token: fan.token,
      body: { ...SHIP, client_request_id: 'cp-buy-1' } });
    assert.equal(r.status, 200);
    assert.equal(r.json.duplicate, true, 'retry reports the duplicate');
    assert.equal(r.json.order.id, order1.id, 'retry returns the same order');
    assert.equal(txns('package', fan.id).length, 1, 'still exactly one hold row');
    assert.equal(walletOf(fan.id).credits_cents, 94000, 'retry charged nothing');

    /* insufficient balance: nothing stored, nobody charged */
    r = await req(base, 'POST', `/api/packages/${pkgId}/buy`, { token: poor.token,
      body: { ...SHIP, client_request_id: 'cp-poor-1' } });
    assert.equal(r.status, 402, `poor fan refused: ${r.text}`);
    assert.equal(txns('package', poor.id).length, 0, 'no hold row for the failed buy');
    r = await req(base, 'GET', '/api/orders', { token: poor.token });
    assert.equal(r.json.orders.length, 0, 'no order for the failed buy');

    /* cancel too early, then ship → confirm → release 60/40 */
    r = await req(base, 'POST', `/api/orders/${order1.id}/cancel`, { token: fan.token });
    assert.equal(r.status, 400, 'cancel inside 7 days refused');
    assert.equal(r.json.error, 'cancel_too_early');
    r = await req(base, 'POST', `/api/orders/${order1.id}/ship`, { token: model.token,
      body: { tracking: 'TRK-1' } });
    assert.equal(r.status, 200, `ship: ${r.text}`);
    assert.equal(r.json.order.status, 'shipped');
    r = await req(base, 'POST', `/api/orders/${order1.id}/confirm-receipt`, { token: fan.token });
    assert.equal(r.status, 200, `confirm: ${r.text}`);
    assert.equal(r.json.order.status, 'released');
    assert.equal(walletOf(model.id).earnings_cents, 3600, 'model got her 60% on release');
    const rel1 = txns('package_release', fan.id);
    assert.equal(rel1.length, 1);
    assert.equal(rel1[0].model_cents, 3600, 'release row model share 60%');
    assert.equal(rel1[0].platform_cents, 2400, 'release row platform share 40%');

    /* ---- buy #2: auto-release 7 days after shipping (lazy sweep) ---- */
    r = await req(base, 'POST', `/api/packages/${pkgId}/buy`, { token: fan.token,
      body: { ...SHIP, client_request_id: 'cp-buy-2' } });
    const order2 = r.json.order;
    await req(base, 'POST', `/api/orders/${order2.id}/ship`, { token: model.token, body: {} });
    sqlRun("UPDATE package_orders SET shipped_at = datetime('now','-8 days') WHERE id = ?", order2.id);
    r = await req(base, 'GET', `/api/orders/${order2.id}`, { token: fan.token });
    assert.equal(r.json.order.status, 'released', 'shipped 7+ days auto-releases on read');
    assert.equal(walletOf(model.id).earnings_cents, 7200, 'auto-release paid her 60% too');

    /* ---- buy #3: never ships → fan cancels after 7 days → full refund ---- */
    r = await req(base, 'POST', `/api/packages/${pkgId}/buy`, { token: fan.token,
      body: { ...SHIP, client_request_id: 'cp-buy-3' } });
    const order3 = r.json.order;
    const before3 = walletOf(fan.id).credits_cents;
    sqlRun("UPDATE package_orders SET created_at = datetime('now','-8 days') WHERE id = ?", order3.id);
    r = await req(base, 'POST', `/api/orders/${order3.id}/cancel`, { token: fan.token });
    assert.equal(r.status, 200, `late cancel: ${r.text}`);
    assert.equal(r.json.order.status, 'refunded');
    assert.equal(walletOf(fan.id).credits_cents, before3 + 6000, 'refund returns the full hold');
    assert.equal(walletOf(model.id).earnings_cents, 7200, 'a refund never touches her earnings');
    const refunds = txns('package_refund', fan.id);
    assert.equal(refunds.length, 1);
    assert.equal(refunds[0].gross_cents, -6000, 'refund row nets his spend back down');

    /* ---- buy #4: dispute freezes the timer; Manager refunds ---- */
    r = await req(base, 'POST', `/api/packages/${pkgId}/buy`, { token: fan.token,
      body: { ...SHIP, client_request_id: 'cp-buy-4' } });
    const order4 = r.json.order;
    await req(base, 'POST', `/api/orders/${order4.id}/ship`, { token: model.token, body: {} });
    r = await req(base, 'POST', `/api/orders/${order4.id}/dispute`, { token: fan.token,
      body: { reason: 'Box never arrived' } });
    assert.equal(r.status, 200, `dispute: ${r.text}`);
    assert.equal(r.json.order.status, 'disputed');
    sqlRun("UPDATE package_orders SET shipped_at = datetime('now','-8 days') WHERE id = ?", order4.id);
    r = await req(base, 'GET', `/api/orders/${order4.id}`, { token: fan.token });
    assert.equal(r.json.order.status, 'disputed', 'a disputed order NEVER auto-releases');
    r = await req(base, 'GET', '/api/admin/package-orders?status=disputed', { ...mgr });
    assert.equal(r.status, 200);
    const mgrRow = (r.json.orders || []).find((o) => o.id === order4.id);
    assert.ok(mgrRow, 'Manager sees the disputed order');
    assert.equal(mgrRow.ship_email, SHIP.ship_email, 'Manager sees shipping for the dispute');
    const before4 = walletOf(fan.id).credits_cents;
    r = await req(base, 'POST', `/api/admin/package-orders/${order4.id}/refund`, { ...mgr, body: {} });
    assert.equal(r.status, 200, `manager refund: ${r.text}`);
    assert.equal(walletOf(fan.id).credits_cents, before4 + 6000, 'Manager refund returns the fan in full');

    /* ---- buy #5: Manager releases a held order ---- */
    r = await req(base, 'POST', `/api/packages/${pkgId}/buy`, { token: fan.token,
      body: { ...SHIP, client_request_id: 'cp-buy-5' } });
    const order5 = r.json.order;
    r = await req(base, 'POST', `/api/admin/package-orders/${order5.id}/release`, { ...mgr, body: {} });
    assert.equal(r.status, 200, `manager release: ${r.text}`);
    assert.equal(walletOf(model.id).earnings_cents, 10800, 'Manager release paid her 60%');
    r = await req(base, 'POST', `/api/admin/package-orders/${order5.id}/release`, { ...mgr, body: {} });
    assert.equal(r.status, 409, 'a settled order cannot be settled twice');

    /* fan spend: the packages category nets holds minus refunds */
    r = await req(base, 'GET', '/api/me/spending', { token: fan.token });
    assert.equal(r.json.by_category.length, 12, 'spend dashboard carries 12 categories');
    const pkgCat = r.json.by_category.find((c) => c.category === 'packages');
    assert.ok(pkgCat, 'packages is its own spend category');
    assert.equal(pkgCat.lifetime_cents, 18000, '5 holds x $60 - 2 refunds x $60 = $180 net');

    /* ---- custom request: talk → she quotes → he accepts → order ---- */
    r = await req(base, 'POST', '/api/package-requests', { token: fan2.token,
      body: { model_id: model.id, description: 'Something silky, my size, surprise me' } });
    assert.equal(r.status, 200, `create request: ${r.text}`);
    const reqId = r.json.request.id;
    assert.equal(r.json.request.status, 'open');
    r = await req(base, 'POST', `/api/package-requests/${reqId}/messages`, { token: fan2.token,
      body: { body: 'Red if you have it?' } });
    assert.equal(r.status, 200, `thread fan msg: ${r.text}`);
    r = await req(base, 'POST', `/api/package-requests/${reqId}/messages`, { token: model.token,
      body: { body: 'Red silk, yes love' } });
    assert.equal(r.status, 200, `thread model msg: ${r.text}`);
    r = await req(base, 'POST', `/api/package-requests/${reqId}/messages`, { token: fan2.token,
      body: { body: 'pay me on cashapp instead' } });
    assert.equal(r.json.blocked, true, 'off-platform payment text is blocked in the thread');
    r = await req(base, 'GET', `/api/package-requests/${reqId}`, { token: model.token });
    assert.equal(r.json.messages.length, 3, 'the blocked message was never stored');
    r = await req(base, 'POST', `/api/package-requests/${reqId}/quote`, { token: fan2.token,
      body: { price_credits: 25 } });
    assert.equal(r.status, 403, 'the fan cannot quote his own request');
    r = await req(base, 'POST', `/api/package-requests/${reqId}/quote`, { token: model.token,
      body: { price_credits: 25 } });
    assert.equal(r.status, 200, `quote: ${r.text}`);
    assert.equal(r.json.request.quote_cents, 2500);
    r = await req(base, 'POST', `/api/package-requests/${reqId}/accept`, { token: fan2.token,
      body: { ...SHIP, client_request_id: 'cp-accept-1' } });
    assert.equal(r.status, 200, `accept: ${r.text}`);
    const reqOrder = r.json.order;
    assert.equal(reqOrder.status, 'held');
    assert.equal(reqOrder.price_cents, 2500, 'the order carries HER quoted price');
    assert.equal(walletOf(fan2.id).credits_cents, 47500, 'accept debited the fan into the hold');
    r = await req(base, 'POST', `/api/package-requests/${reqId}/accept`, { token: fan2.token,
      body: { ...SHIP, client_request_id: 'cp-accept-1' } });
    assert.equal(r.status, 200);
    assert.equal(r.json.duplicate, true, 'accept retry is a no-charge duplicate');
    assert.equal(txns('package', fan2.id).length, 1, 'request order charged exactly once');
    r = await req(base, 'GET', `/api/package-requests/${reqId}`, { token: fan2.token });
    assert.equal(r.json.request.status, 'ordered');
    await req(base, 'POST', `/api/orders/${reqOrder.id}/ship`, { token: model.token, body: {} });
    r = await req(base, 'POST', `/api/orders/${reqOrder.id}/confirm-receipt`, { token: fan2.token });
    assert.equal(r.json.order.status, 'released');
    assert.equal(walletOf(model.id).earnings_cents, 12300, 'request order released her 60% of $25');

    /* decline + withdraw close threads; blocked descriptions never open one */
    r = await req(base, 'POST', '/api/package-requests', { token: fan2.token,
      body: { model_id: model.id, description: 'A second idea' } });
    const req2 = r.json.request.id;
    r = await req(base, 'POST', `/api/package-requests/${req2}/decline`, { token: model.token });
    assert.equal(r.status, 200);
    r = await req(base, 'POST', `/api/package-requests/${req2}/messages`, { token: fan2.token,
      body: { body: 'hello?' } });
    assert.equal(r.status, 409, 'a declined thread is closed to messages');
    r = await req(base, 'POST', '/api/package-requests', { token: fan2.token,
      body: { model_id: model.id, description: 'A third idea' } });
    const req3 = r.json.request.id;
    r = await req(base, 'POST', `/api/package-requests/${req3}/withdraw`, { token: fan2.token });
    assert.equal(r.status, 200);
    r = await req(base, 'POST', '/api/package-requests', { token: fan2.token,
      body: { model_id: model.id, description: 'find me on venmo instead' } });
    assert.equal(r.json.blocked, true, 'off-platform text in the request itself is blocked');
    r = await req(base, 'GET', '/api/package-requests', { token: fan2.token });
    assert.equal(r.json.requests.length, 3, 'the blocked request was never created');

    /* ---- house: never a seller, never requestable ---- */
    // The demo seed has no house account; house identity is the
    // username itself, so register it through the real signup.
    const hs = await req(base, 'POST', '/api/auth/signup', {
      body: { username: 'asceaaspade', password: 'house-pass-123', role: 'model',
        display_name: 'SlutCamp Live', dob: '1990-01-01', agree18: true, section: 'female' } });
    assert.equal(hs.status, 200, `house signup: ${hs.text}`);
    const house = { id: hs.json.user.id };
    r = await req(base, 'GET', `/api/models/${house.id}/packages`);
    assert.deepEqual(r.json.packages, [], 'the house lists no packages');
    r = await req(base, 'POST', '/api/package-requests', { token: fan.token,
      body: { model_id: house.id, description: 'A package please' } });
    assert.equal(r.status, 403, 'the house cannot be requested from');
    assert.equal(r.json.error, 'official_account');
    assert.equal(sql('SELECT COUNT(*) AS n FROM package_orders WHERE model_id = ?', house.id)[0].n, 0,
      'zero package orders ever touch the house');
    assert.equal(sql('SELECT COUNT(*) AS n FROM transactions WHERE model_id = ? AND type LIKE \'package%\'', house.id)[0].n, 0,
      'zero package ledger rows ever touch the house');
  });

/* ---------------- migration: previous schema reboots clean ---------------- */

test('migration: a DB without the package tables reboots with them recreated, data intact',
  { timeout: 180000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-pkg-mig-'));
    let b = null;
    try {
      b = await boot(dir);
      const model = await modelSignup(b.base, dir, 'migm');
      const fan = await signupFan(b.base, 'migfan');
      await b.kill(); b = null;
      // Roll the schema back to the previous release: drop the four
      // package tables (and their index) as if they never existed.
      const d = new DatabaseSync(path.join(dir, 'wogent-chat.db'));
      d.exec(`DROP TABLE IF EXISTS package_orders;
              DROP TABLE IF EXISTS package_request_messages;
              DROP TABLE IF EXISTS package_requests;
              DROP TABLE IF EXISTS model_packages;`);
      d.close();
      b = await boot(dir);
      const r = await req(b.base, 'POST', '/api/model/packages', { token: model.token,
        body: { title: 'Back Again', price_credits: 10 } });
      assert.equal(r.status, 200, `package create after re-migration: ${r.text}`);
      const me = await req(b.base, 'GET', '/api/me', { token: fan.token });
      assert.equal(me.status, 200, 'pre-existing accounts survive the re-migration');
      await b.kill(); b = null;
    } finally {
      if (b) { try { await b.kill(); } catch (_) { /* gone */ } }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
