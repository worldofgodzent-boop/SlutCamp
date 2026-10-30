'use strict';
/*
 * Manager geo analytics (owner ask Oct 30, 2026) — end to end against the
 * real server.
 *
 * Pins:
 *  - POST /api/track/visit captures geo from the Cloudflare headers the
 *    origin actually receives: CF-IPCountry (alpha-2, normalized to upper
 *    case) + CF-IPCity (percent-decoded). Junk codes (XX, T1, 3-letter,
 *    free text) and missing headers store NULL — the visit still counts,
 *    it just lands in the (unknown) bucket. A city never survives without
 *    a country.
 *  - With no CF headers, the bundled GeoLite resolver (lib/geo.js) is the
 *    fallback, keyed on the real client IP (x-forwarded-for first hop,
 *    the codebase's clientIp) — NOT req.ip, which is the proxy peer. The
 *    old code shipped req.ip to ip-api.com, so country/city were NULL for
 *    effectively every visit and the Manager showed (unknown) for all.
 *  - GET /api/admin/analytics returns countries [{code, n}] and cities
 *    [{city, code, n}] breakdowns alongside the existing fields, sorted
 *    by count desc, capped at 50 rows each. Legacy rows (NULL geo, or a
 *    pre-codecs full country name) pass through untouched.
 *  - The endpoint keeps the Manager's existing access rules (adminOnly):
 *    anonymous 401, non-admin 403.
 *  - Aggregate counts only: no IP or per-visitor geo anywhere in the
 *    payload (ip_hash is never selected).
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

const mgrLogin = async (base) => {
  const adm = await req(base, 'POST', '/api/manager/login', { body: { username: 'admin', password: 'admin123' } });
  assert.equal(adm.status, 200, `manager login: ${adm.text}`);
  return { token: adm.json.token, headers: { 'x-manager': '1' } };
};
const analytics = (base, mgr) => req(base, 'GET', '/api/admin/analytics?days=30', mgr);
const track = (base, headers) =>
  req(base, 'POST', '/api/track/visit', { headers, body: { path: '/', referrer: '' } });

/* ---------------- Boot A: capture + aggregation + gating ---------------- */

let A = null;
const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-geoanalytics-'));
after(async () => {
  if (A) { try { await A.kill(); } catch (_) { /* already gone */ } }
  // Each boot copies ~46MB into /tmp (a 512MB tmpfs): remove our dirs or
  // repeated full-suite runs fill the disk and later boots die (AGENTS.md).
  try { fs.rmSync(dirA, { recursive: true, force: true }); } catch (_) { /* best effort */ }
});

test('analytics endpoint keeps Manager access rules (anon 401, fan 403)', async () => {
  A = await boot(dirA);
  // /api/admin/* sits behind the Manager gate first: no x-manager header,
  // no service at all — even for the owner.
  const noHeader = await req(A.base, 'GET', '/api/admin/analytics?days=30');
  assert.equal(noHeader.status, 403, `no manager header: ${noHeader.text}`);
  assert.equal(noHeader.json.error, 'manager_only');
  // Through the gate but signed out: requireUser answers 401.
  const anon = await req(A.base, 'GET', '/api/admin/analytics?days=30', { headers: { 'x-manager': '1' } });
  assert.equal(anon.status, 401, `anon: ${anon.text}`);
  // Signed in as a fan: requireRole('admin') answers 403 — analytics is
  // owner/delegate territory, exactly as before this feature.
  const fan = await req(A.base, 'POST', '/api/auth/login', { body: { username: 'fandemo', password: 'fan123' } });
  assert.equal(fan.status, 200, `fan login: ${fan.text}`);
  const asFan = await req(A.base, 'GET', '/api/admin/analytics?days=30', { token: fan.json.token, headers: { 'x-manager': '1' } });
  assert.equal(asFan.status, 403, `fan: ${asFan.text}`);
});

test('visit capture: CF headers, junk values, fallback, payload shape', async () => {
  const mgr = await mgrLogin(A.base);
  const post = async (headers, times = 1) => {
    for (let i = 0; i < times; i++) {
      const r = await track(A.base, headers);
      assert.equal(r.status, 200, `track: ${r.text}`);
      assert.equal(r.json.ok, true);
    }
  };
  await post({ 'cf-ipcountry': 'jm', 'cf-ipcity': 'Kingston' }, 2);        // lowercase code normalizes
  await post({ 'cf-ipcountry': 'US', 'cf-ipcity': 'San%20Antonio' }, 3);   // city percent-decoded
  await post({ 'cf-ipcountry': 'ca' });                                    // country only, no city
  await post({ 'cf-ipcountry': 'XX', 'cf-ipcity': 'Nowhere' });            // XX = unknown; city must not survive
  await post({ 'cf-ipcountry': 'T1' });                                    // Tor = unknown
  await post({ 'cf-ipcountry': 'USA' });                                   // not alpha-2 = unknown
  await post({ 'cf-ipcountry': 'not-a-code' });                            // junk = unknown
  await post({}, 2);                                                       // no headers (loopback) = unknown
  await post({ 'x-forwarded-for': '8.8.8.8' });                            // GeoLite fallback: US, no city

  const { status, json: a } = await analytics(A.base, mgr);
  assert.equal(status, 200);
  // Payload shape: every pre-existing field survives, cities is new.
  for (const k of ['days', 'total', 'unique', 'byDay', 'referrers', 'countries', 'cities', 'pages']) {
    assert.ok(k in a, `payload missing ${k}`);
  }
  assert.equal(a.total, 13, 'every tracked visit counts, geo or not');
  assert.ok(a.unique >= 2 && a.unique <= a.total, 'unique is a real count, not the proxy hash of old');
  assert.ok(!JSON.stringify(a).includes('ip_hash'), 'no ip_hash leaks into the payload');

  // Countries: exact counts per code, sorted desc.
  const byCode = new Map(a.countries.map((r) => [r.code, r.n]));
  assert.equal(byCode.get('US'), 4, '3 header + 1 GeoLite fallback');
  assert.equal(byCode.get('JM'), 2);
  assert.equal(byCode.get('CA'), 1);
  assert.equal(byCode.get(null), 6, 'XX + T1 + USA + junk + 2 headerless');
  const counts = a.countries.map((r) => r.n);
  assert.deepEqual(counts, [...counts].sort((x, y) => y - x), 'countries sorted desc');
  for (const r of a.countries) assert.deepEqual(Object.keys(r).sort(), ['code', 'n'], 'country row shape');

  // Cities: only resolved cities, with their country code.
  assert.deepEqual(a.cities, [
    { city: 'San Antonio', code: 'US', n: 3 },
    { city: 'Kingston', code: 'JM', n: 2 },
  ]);
});

/* ---------------- Boot B: legacy rows + top-50 caps (DB surgery) ---------------- */

test('legacy rows pass through; countries/cities capped at 50, sorted desc', async () => {
  await A.kill(); A = null;
  const db = new DatabaseSync(path.join(dirA, 'wogent-chat.db'));
  db.exec('PRAGMA busy_timeout = 10000');
  const ins = db.prepare('INSERT INTO visits (ip_hash, country, city, path) VALUES (?,?,?,?)');
  // A hypothetical pre-codecs row: full country name stored by the old
  // ip-api path. It must group as its own bucket, never crash the payload.
  for (let i = 0; i < 3; i++) ins.run('legacyhash', 'Canada', 'Toronto', '/');
  // 60 one-visit countries + 55 one-visit cities to force the caps.
  const codes = [];
  for (const a of ['A', 'B', 'C', 'D', 'E']) for (const b of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') codes.push(a + b);
  const singles = codes.filter((c) => !['US', 'JM', 'CA', 'XX', 'T1'].includes(c)).slice(0, 60);
  assert.equal(singles.length, 60);
  for (const c of singles) ins.run('caphash' + c, c, null, '/');
  for (let i = 1; i <= 55; i++) ins.run('cityhash' + i, 'US', 'City' + String(i).padStart(2, '0'), '/');
  db.close();

  const B = await boot(dirA);
  try {
    const mgr = await mgrLogin(B.base);
    const { status, json: a } = await analytics(B.base, mgr);
    assert.equal(status, 200);
    assert.equal(a.countries.length, 50, 'countries capped at 50');
    assert.equal(a.cities.length, 50, 'cities capped at 50');
    const counts = a.countries.map((r) => r.n);
    assert.deepEqual(counts, [...counts].sort((x, y) => y - x), 'countries still sorted desc at the cap');
    // High-count rows survive the cap; the legacy name bucket is intact.
    const byCode = new Map(a.countries.map((r) => [r.code, r.n]));
    assert.equal(byCode.get(null), 6);
    assert.equal(byCode.get('US'), 4 + 55, 'US gains the 55 surgery city rows');
    assert.equal(byCode.get('Canada'), 3, 'legacy full-name bucket passes through');
    assert.equal(byCode.get('JM'), 2);
    const cityByName = new Map(a.cities.map((r) => [r.city, r]));
    assert.equal(cityByName.get('San Antonio').n, 3);
    assert.equal(cityByName.get('Toronto').code, 'Canada');
    assert.equal(cityByName.get('Kingston').n, 2);
  } finally {
    await B.kill();
  }
});
