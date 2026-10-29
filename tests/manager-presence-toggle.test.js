'use strict';
/*
 * Manager Online/Offline switch — owner field defect, Oct 19 2026:
 * "Whenever I switch the models online or offline from the manager
 * account it's not working." Live repro (production, demo model):
 * he forced the model ONLINE in the Manager; her own app still said
 * Offline — even after a manual refresh.
 *
 * ROOT CAUSE (write/read source mismatch): the Manager toggle writes
 * users.presence_override and every FAN read applies effectiveOnline()
 * — fans were always right. But /api/me handed the model app the RAW
 * models row (SELECT * FROM models), so S.model.is_online was her own
 * toggle's raw state and the Manager's flip never reached her screen.
 *
 * THE FIX pinned here:
 *  - /api/me applies effectiveOnline() to the model payload and rides
 *    presence_override along, so her app shows the same truth fans see.
 *  - Her own profile PUT (is_online) during a Manager hold changes
 *    nothing fans or she sees — the Manager's word is final until he
 *    returns her to Auto, when her own toggle rules again.
 *  - Her client picks the flip up on its own: the 30s presence
 *    heartbeat rides a refreshMe for models + an in-place switch sync
 *    (syncOnlineToggleUI) — no reload, no manual refresh. Her switch
 *    tap during a Manager hold explains itself (mgr_presence_locked)
 *    instead of silently doing nothing. (Source pins below.)
 *  - Bulk "Put everyone online": POST /api/admin/models/presence-all-online
 *    sets presence_override='on' for the SAME population the single
 *    toggle covers — role='model', not banned, not the featured
 *    system account. Admin-only, online only (no bulk-offline).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-mgrtoggle-'));
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

test('manager presence switch: her screen, fan view, finality, bulk', async (t) => {
  const dir = makeCopy();
  const h = await boot(dir, { SEED_DEMO: '1' });
  t.after(() => stop(h));
  const { base } = h;

  const adm = await req(base, 'POST', '/api/manager/login', { body: { username: 'admin', password: 'admin123' } });
  assert.equal(adm.status, 200, `manager login: ${adm.text}`);
  const atok = adm.json.token;
  const login = async (u) => {
    const r = await req(base, 'POST', '/api/auth/login', { body: { username: u, password: u === 'fandemo' ? 'fan123' : 'model123' } });
    assert.equal(r.status, 200, `login ${u}: ${r.text}`);
    return r.json.token;
  };
  const btok = await login('bunny');
  const fanTok = await login('fandemo');

  const adminModels = async () => (await req(base, 'GET', '/api/admin/models', { token: atok, mgr: true })).json.models;
  const bunnyRow = async () => (await adminModels()).find((m) => m.username === 'bunny');
  const bunnyId = (await bunnyRow()).id;
  const fanSeesBunny = async () => {
    const r = await req(base, 'GET', '/api/models');
    return r.json.models.find((m) => m.username === 'bunny').is_online;
  };
  const sheSees = async () => {
    const me = await req(base, 'GET', '/api/me', { token: btok });
    assert.equal(me.status, 200, `model /api/me: ${me.text}`);
    return me.json.model;
  };
  const setPresence = (id, mode) =>
    req(base, 'POST', `/api/admin/models/${id}/presence`, { token: atok, mgr: true, body: { mode } });
  const setHerToggle = (v) =>
    req(base, 'PUT', '/api/model/profile', { token: btok, body: { is_online: v } });

  await t.test('shape A: she is OFF, Manager forces ONLINE — her own app agrees with fans', async () => {
    await setHerToggle(0);
    await setPresence(bunnyId, 'auto');
    assert.equal(await fanSeesBunny(), false);
    assert.equal((await sheSees()).is_online, 0);
    const on = await setPresence(bunnyId, 'on');
    assert.equal(on.status, 200, on.text);
    assert.equal(on.json.online, true);
    assert.equal(await fanSeesBunny(), true, 'fans see her online');
    const mine = await sheSees();
    assert.equal(mine.is_online, 1, 'HER screen (fresh /api/me) says online — the owner defect');
    assert.equal(mine.presence_override, 'on', 'her client can tell the Manager holds her status');
  });

  await t.test('shape B: she is ON, Manager forces OFFLINE — her own app agrees with fans', async () => {
    await setHerToggle(1);
    const off = await setPresence(bunnyId, 'off');
    assert.equal(off.status, 200, off.text);
    assert.equal(await fanSeesBunny(), false, 'fans see her offline');
    const mine = await sheSees();
    assert.equal(mine.is_online, 0, 'HER screen says offline — the owner defect, other direction');
    assert.equal(mine.presence_override, 'off');
  });

  await t.test("the Manager's word is final: her own toggle activity cannot undo it", async () => {
    // Manager holds her OFF; she flips her own toggle on — nobody's view may change.
    await setHerToggle(1);
    assert.equal(await fanSeesBunny(), false, 'fans still see the Manager-set offline');
    assert.equal((await sheSees()).is_online, 0, 'her screen still shows the Manager-set offline');
    // Manager holds her ON; she flips her own toggle off — same finality.
    await setPresence(bunnyId, 'on');
    await setHerToggle(0);
    assert.equal(await fanSeesBunny(), true);
    assert.equal((await sheSees()).is_online, 1);
    // Back to Auto: her own toggle (currently off) rules again, everywhere.
    const auto = await setPresence(bunnyId, 'auto');
    assert.equal(auto.status, 200, auto.text);
    assert.equal(await fanSeesBunny(), false);
    const mine = await sheSees();
    assert.equal(mine.is_online, 0);
    assert.equal(mine.presence_override, 'auto');
  });

  await t.test('endpoint validation + enforcement', async () => {
    const bad = await setPresence(bunnyId, 'bogus');
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, 'bad_mode');
    assert.match(bad.json.message, /mode must be/, 'failures carry a human message — no silent no-ops');
    const fanMe = await req(base, 'GET', '/api/me', { token: fanTok });
    const notModel = await setPresence(fanMe.json.user.id, 'on');
    assert.equal(notModel.status, 404, 'presence control only exists for models');
    const asModel = await req(base, 'POST', `/api/admin/models/${bunnyId}/presence`,
      { token: btok, mgr: true, body: { mode: 'on' } });
    assert.equal(asModel.status, 403, 'a model token cannot drive the Manager switch');
  });

  await t.test('bulk "put everyone online": population, totals, enforcement', async () => {
    const rows = await adminModels();
    const byName = Object.fromEntries(rows.map((m) => [m.username, m]));
    // Reset everyone to Auto, then carve out the two exclusions:
    // bella deactivated, stacey the featured system account.
    for (const m of rows) await setPresence(m.id, 'auto');
    const ban = await req(base, 'PUT', `/api/admin/models/${byName.bella.id}`,
      { token: atok, mgr: true, body: { banned: 1 } });
    assert.equal(ban.status, 200, ban.text);
    const feat = await req(base, 'POST', `/api/admin/models/${byName.stacey.id}/feature`,
      { token: atok, mgr: true, body: {} });
    assert.equal(feat.status, 200, feat.text);

    // The single toggle refuses the featured account — bulk must agree.
    const singleFeatured = await setPresence(byName.stacey.id, 'on');
    assert.equal(singleFeatured.status, 400);
    assert.equal(singleFeatured.json.error, 'featured_account');

    const bulk = await req(base, 'POST', '/api/admin/models/presence-all-online',
      { token: atok, mgr: true, body: {} });
    assert.equal(bulk.status, 200, bulk.text);
    assert.equal(bulk.json.ok, true);
    assert.equal(bulk.json.total, 1, 'only bunny is covered (bella banned, stacey featured)');
    const after = Object.fromEntries((await adminModels()).map((m) => [m.username, m]));
    assert.equal(after.bunny.presence_override, 'on');
    assert.equal(after.stacey.presence_override, 'auto', 'featured system account untouched');
    assert.equal(after.bella.presence_override, 'auto', 'deactivated model untouched');

    // Restore the roster, bulk again: everyone covered, everyone on.
    await req(base, 'PUT', `/api/admin/models/${byName.bella.id}`, { token: atok, mgr: true, body: { banned: 0 } });
    await req(base, 'POST', `/api/admin/models/${byName.stacey.id}/feature`,
      { token: atok, mgr: true, body: { featured: false } });
    const bulk2 = await req(base, 'POST', '/api/admin/models/presence-all-online',
      { token: atok, mgr: true, body: {} });
    assert.equal(bulk2.status, 200, bulk2.text);
    assert.equal(bulk2.json.total, 3);
    for (const m of await adminModels()) assert.equal(m.presence_override, 'on', `${m.username} online`);
    // A covered model's own screen agrees (spot-check bunny via /api/me).
    assert.equal((await sheSees()).is_online, 1);

    const asModel = await req(base, 'POST', '/api/admin/models/presence-all-online',
      { token: btok, mgr: true, body: {} });
    assert.equal(asModel.status, 403, 'bulk is admin-only');
    const noAuth = await req(base, 'POST', '/api/admin/models/presence-all-online', { body: {} });
    assert.ok(noAuth.status === 401 || noAuth.status === 403, `unauthenticated bulk refused (${noAuth.status})`);
  });
});

test('client source pins: propagation, in-place sync, toggle guard, bulk button', () => {
  // Her 30s presence heartbeat rides a /api/me refresh for models…
  assert.match(appSrc, /S\.user\.role === 'model'\) \{\s*\n?\s*refreshMe\(\)\.then\(syncOnlineToggleUI\)/,
    'heartbeat picks up Manager flips for models');
  // …and the switch follows in place (class + label), never a reload.
  assert.match(appSrc, /function syncOnlineToggleUI\(\)/, 'in-place switch sync exists');
  assert.match(appSrc, /tgl\.classList\.toggle\('on', on\)/, 'sync flips the switch class');
  // Her own switch tap during a Manager hold explains itself.
  assert.match(appSrc, /presence_override === 'on' \|\| S\.model\.presence_override === 'off'\)\s*\n?\s*return toast\(t\('mgr_presence_locked'\)\)/,
    'toggle tap during a Manager hold toasts instead of silently no-oping');
  assert.equal((appSrc.match(/mgr_presence_locked:/g) || []).length, 13,
    'mgr_presence_locked exists in all 13 language dictionaries');
  // Manager: the bulk button + its endpoint wiring.
  assert.match(managerSrc, /id="pres-all-online"/, 'bulk button rendered on the Models screen');
  assert.match(managerSrc, /Put everyone online/, 'bulk button label');
  assert.match(managerSrc, /\/admin\/models\/presence-all-online/, 'bulk button calls the bulk endpoint');
  assert.match(serverSrc, /app\.post\('\/api\/admin\/models\/presence-all-online', \.\.\.adminOnly/,
    'bulk endpoint is behind the same adminOnly chain as the single toggle');
});
