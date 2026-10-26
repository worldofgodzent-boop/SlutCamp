'use strict';
/*
 * Analytics countries + cities fix (Assignment 06, Ms. Pink Oct 26 2026):
 * - POST /api/track/visit must resolve the visitor IP through
 *   clientIp(req) (x-forwarded-for first hop), not the proxy's own
 *   address, so the geo lookup can place the visit.
 * - GET /api/admin/analytics carries a cities aggregation (top 20,
 *   { city, country, n }) alongside the unchanged countries one.
 * - Manager Analytics shows a "Top cities" section under Countries.
 * - Historical visits (hashed IPs only) stay "(unknown)" forever;
 *   there is NO backfill in this build.
 * Live assertions never depend on ip-api: the forwarded-IP proof is
 * the stored ip_hash, and city counts come from fixture rows inserted
 * directly into the DB.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const REPO = path.join(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
const managerSrc = fs.readFileSync(path.join(REPO, 'public/manager/manager.js'), 'utf8');

/* ---------------- static pins ---------------- */

test('pins: /api/track/visit resolves the visitor IP through clientIp(req)', () => {
  const ep = serverSrc.slice(
    serverSrc.indexOf("app.post('/api/track/visit'"),
    serverSrc.indexOf("app.get('/api/admin/analytics'"));
  assert.ok(ep.includes("const ip = clientIp(req) || 'unknown';"),
    'track endpoint uses clientIp(req) with an unknown fallback');
  assert.ok(!ep.includes('req.ip || req.socket.remoteAddress'),
    'the proxy-address form is gone from the track endpoint');
  assert.ok(ep.includes('geoFor(ip)'), 'geo lookup still runs on the resolved IP');
  assert.ok(ep.includes('hashIP(ip)'), 'the stored hash still comes from the resolved IP');
});

test('pins: /api/admin/analytics carries a cities aggregation, countries unchanged', () => {
  const ep = serverSrc.slice(
    serverSrc.indexOf("app.get('/api/admin/analytics'"),
    serverSrc.indexOf("app.get('/api/admin/2fa'"));
  assert.ok(ep.includes("SELECT COALESCE(country, '(unknown)') AS c"),
    'countries aggregation is unchanged');
  assert.ok(ep.includes('SELECT city, country, COUNT(*) AS n'),
    'cities rows are shaped { city, country, n }');
  assert.ok(ep.includes("city IS NOT NULL AND city != ''"),
    'cities exclude NULL and empty cities');
  assert.ok(ep.includes('GROUP BY city, country ORDER BY n DESC LIMIT 20'),
    'cities are grouped by city+country, count order, top 20');
  assert.ok(ep.includes('cities'), 'the analytics response carries cities');
});

test('pins: Manager Analytics renders a Top cities section under Countries', () => {
  const body = managerSrc.slice(
    managerSrc.indexOf('async function adminAnalyticsBody()'),
    managerSrc.indexOf('async function adminDmcaBody()'));
  assert.ok(body.includes('🏙 Top cities'), 'Top cities heading is rendered');
  assert.ok(body.includes('rows(a.cities'), 'Top cities rows come from the cities aggregation');
  const countriesAt = body.indexOf('🌍 Countries');
  const citiesAt = body.indexOf('🏙 Top cities');
  const pagesAt = body.indexOf('📄 Top pages');
  assert.ok(countriesAt !== -1 && citiesAt > countriesAt && pagesAt > citiesAt,
    'Top cities sits directly under Countries, before Top pages');
});

/* ---------------- live: forwarded IP + cities end to end ---------------- */

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-analytics-geo-'));
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
  const deadline = Date.now() + 30000;
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

async function req(base, method, p, { body, token, mgr, headers } = {}) {
  const h = { ...(headers || {}) };
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

function withDb(dir, fn) {
  const db = new DatabaseSync(path.join(dir, 'wogent-chat.db'));
  db.exec('PRAGMA busy_timeout = 10000');
  try { return fn(db); } finally { db.close(); }
}

test('live: forwarded IP is the one recorded, fixture cities aggregate in count order', { timeout: 180000 }, async (t) => {
  const dir = makeCopy();
  const h = await boot(dir, { SEED_DEMO: '1' });
  t.after(() => { stop(h); try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });
  const { base } = h;

  const js = await req(base, 'GET', '/manager/manager.js');
  assert.equal(js.status, 200);
  assert.ok(js.text.includes('🏙 Top cities'), 'served manager.js renders Top cities');

  const adm = await req(base, 'POST', '/api/manager/login', { body: { username: 'admin', password: 'admin123' } });
  assert.equal(adm.status, 200, `manager login: ${adm.text}`);
  const atok = adm.json.token;

  // Forwarded-IP proof: no live geo assertion — only the stored hash.
  const visit = await req(base, 'POST', '/api/track/visit', {
    body: { path: '/', referrer: '' },
    headers: { 'x-forwarded-for': '8.8.8.8' },
  });
  assert.equal(visit.status, 200, `track visit: ${visit.text}`);
  const expectedHash = crypto.createHash('sha256').update('8.8.8.8|visit-salt').digest('hex').slice(0, 32);
  const rows = withDb(dir, (db) =>
    db.prepare('SELECT ip_hash, country, city FROM visits WHERE ip_hash = ?').all(expectedHash));
  assert.equal(rows.length, 1,
    'the visits row is keyed by the forwarded IP hash, not the proxy address');

  // Fixture cities, inserted directly — no ip-api involvement.
  withDb(dir, (db) => {
    const ins = db.prepare('INSERT INTO visits (ip_hash, country, city, referrer, path, user_agent) VALUES (?, ?, ?, ?, ?, ?)');
    for (let i = 0; i < 3; i++) ins.run(`fixture-paris-${i}`, 'France', 'Paris', null, '/', null);
    for (let i = 0; i < 2; i++) ins.run(`fixture-berlin-${i}`, 'Germany', 'Berlin', null, '/', null);
    ins.run('fixture-tokyo-0', 'Japan', 'Tokyo', null, '/', null);
    ins.run('fixture-null-0', 'France', null, null, '/', null);
    ins.run('fixture-empty-0', 'France', '', null, '/', null);
  });

  const an = await req(base, 'GET', '/api/admin/analytics?days=30', { token: atok, mgr: true });
  assert.equal(an.status, 200, `analytics: ${an.text}`);
  assert.ok(Array.isArray(an.json.cities), 'analytics carries a cities array');
  for (const r of an.json.cities) {
    assert.ok(Object.prototype.hasOwnProperty.call(r, 'city'), 'every cities row has city');
    assert.ok(Object.prototype.hasOwnProperty.call(r, 'country'), 'every cities row has country');
    assert.ok(Object.prototype.hasOwnProperty.call(r, 'n'), 'every cities row has n');
    assert.ok(r.city !== null && r.city !== '', 'no NULL/empty city leaks into cities');
  }
  const byCity = new Map(an.json.cities.map((r) => [r.city, r]));
  assert.equal(byCity.get('Paris').n, 3, 'Paris aggregates 3 fixture visits');
  assert.equal(byCity.get('Berlin').n, 2, 'Berlin aggregates 2 fixture visits');
  assert.equal(byCity.get('Tokyo').n, 1, 'Tokyo aggregates 1 fixture visit');
  const order = an.json.cities.map((r) => r.city);
  assert.ok(order.indexOf('Paris') < order.indexOf('Berlin') &&
            order.indexOf('Berlin') < order.indexOf('Tokyo'),
    'fixture cities come back in count order');
  assert.ok(Array.isArray(an.json.countries), 'countries aggregation is still present');
});
