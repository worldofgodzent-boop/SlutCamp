'use strict';
/*
 * Composite model ranking (owner directive, Oct 16 2026): "Not just by
 * fan likes, I want it by likes and money earned."
 *
 *   rank_score = like_count + (lifetime_model_earnings_cents / 100)
 *
 * 1 point per fan like + 1 point per $1.00 of the model's CREDITED
 * earnings (her splitPayment share), float, no floor, net of refunds.
 * Earnings = SUM(transactions.model_cents) excluding 'payout' rows
 * (money OUT) and is_test rows (pre-launch test money). One derivation —
 * recomputeModelRank() on the server — hooked into chargeFan/refundFan
 * (every credit/reversal flows through them) and the like endpoint,
 * plus an unconditional boot backfill.
 *
 * Layers:
 * 1. API tests against the REAL server (throwaway temp copy, the
 *    reactions/discovery harness pattern, SEED_DEMO=1 so fandemo brings
 *    his $100 of test credits to spend):
 *      rkA — likes only      (5 likes, $0 earned)      → 5.00
 *      rkB — earnings only   (0 likes, $10 tip → $6)   → 6.00
 *      rkC — mixed           (2 likes, $5 tip → $3)    → 5.00
 *      rkD — fractional      (0 likes, $1.48 tip → 89¢)→ 0.89
 *    A and C tie at 5.00; the directory tiebreak (like_count DESC) puts
 *    A ahead. Then: like→unlike returns D's score; an admin refund
 *    claws B back to 0; a featured float must NOT change anyone's true
 *    rank_position; and a stopped-server DB seed + reboot proves the
 *    boot backfill (incl. payout/test-row exclusions).
 * 2. Client logic: applyDiscovery default ('top') preserves the
 *    composite order; 'liked' sorts by like count alone; discActive
 *    drives badge suppression; rankBadgeFor labels 1–10 only.
 * 3. Source pins: migration, recompute call sites, badge markup +
 *    suppression wiring at both directory call sites, peek rank line.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const REPO = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const app = read('public/js/app.js');
const server = read('server.js');
const css = read('public/css/styles.css');

/* ---------------- server harness (discovery.test.js pattern) ---------------- */

let tmpDir = null;
let child = null;
let base = null;
let childLog = '';

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

async function req(method, p, { body, token, headers } = {}) {
  const h = { ...(headers || {}) };
  if (body !== undefined) h['content-type'] = 'application/json';
  if (token) h.authorization = 'Bearer ' + token;
  const r = await fetch(base + p, {
    method,
    headers: h,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* HTML or empty */ }
  return { status: r.status, headers: r.headers, text, json };
}

async function waitForServer(deadlineMs = 60000) {
  const start = Date.now();
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early with code ${child.exitCode}\n--- server log ---\n${childLog}`);
    }
    try {
      const r = await fetch(base + '/api/credits/packages');
      if (r.status === 200) return;
    } catch (_) { /* not up yet */ }
    if (Date.now() - start > deadlineMs) {
      throw new Error(`server did not respond within ${deadlineMs}ms\n--- server log ---\n${childLog}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function boot() {
  let lastErr = null;
  for (let attempt = 1; attempt <= 3 && !base; attempt++) {
    const port = await freePort();
    const env = { ...process.env, PORT: String(port), CRYPTO_POLL_MS: '3600000', SEED_DEMO: '1' };
    for (const k of Object.keys(env)) {
      if (/^(CCBILL_|CRYPTO_|OPENAI_|TWILIO_|VAPID_)/.test(k)) delete env[k];
    }
    childLog = '';
    child = spawn(process.execPath, ['server.js'], { cwd: tmpDir, env });
    child.stdout.on('data', (d) => { childLog += d; });
    child.stderr.on('data', (d) => { childLog += d; });
    base = `http://127.0.0.1:${port}`;
    try {
      await waitForServer();
    } catch (e) {
      lastErr = e;
      base = null;
      if (child && child.exitCode === null) child.kill('SIGKILL');
      child = null;
    }
  }
  if (!base) throw lastErr || new Error('server failed to boot after 3 attempts');
}

async function stopServer() {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((r) => child.once('exit', r)),
      new Promise((r) => setTimeout(r, 5000)),
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  child = null;
  base = null;
}

/* ---------------- scenario ---------------- */

const MODELS = {}; // key → { token, id, username }
const FANS = [];   // 5 liking fans
let fandemo = null; // seed fan with $100 test credits — the tipper
let mgr = null;     // manager headers for admin calls

async function directory() {
  const r = await req('GET', '/api/models');
  assert.equal(r.status, 200, r.text);
  return r.json.models;
}
const inDir = async (id) => (await directory()).find((m) => m.id === id);

async function tipTo(modelId, amountCents) {
  const start = await req('POST', '/api/conversations/start', {
    body: { model_id: modelId }, token: fandemo.token });
  assert.equal(start.status, 200, `conversation start failed: ${start.text}`);
  const tip = await req('POST', '/api/tips', {
    body: { conversation_id: start.json.conversation.id, amount_cents: amountCents },
    token: fandemo.token });
  assert.equal(tip.status, 200, `tip of ${amountCents} to model ${modelId} failed: ${tip.text}`);
}

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-ranking-'));
  for (const f of ['server.js', 'package.json']) {
    fs.copyFileSync(path.join(REPO, f), path.join(tmpDir, f));
  }
  for (const d of ['lib', 'public', 'data']) {
    fs.cpSync(path.join(REPO, d), path.join(tmpDir, d), { recursive: true });
  }
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(tmpDir, 'node_modules'), 'dir');
  await boot();

  const suffix = Math.random().toString(36).slice(2, 8);
  const signup = async (name, role, display) => {
    const s = await req('POST', '/api/auth/signup', {
      body: { username: name + suffix, password: 'rank-pass-1', role, display_name: display, dob: '1996-04-12', agree18: true, ...(role === 'model' ? { section: 'female' } : {}) },
    });
    assert.equal(s.status, 200, `${role} signup failed: ${s.text}`);
    return { token: s.json.token, id: s.json.user.id, username: name + suffix };
  };
  for (const key of ['rka', 'rkb', 'rkc', 'rkd']) {
    MODELS[key] = await signup(key, 'model', 'Rank ' + key.slice(2).toUpperCase());
  }
  for (let i = 1; i <= 5; i++) FANS.push(await signup('rkfan' + i, 'fan', 'Rank Fan ' + i));

  const login = await req('POST', '/api/auth/login', { body: { username: 'fandemo', password: 'fan123' } });
  assert.equal(login.status, 200, `fandemo login failed: ${login.text}`);
  const me = await req('GET', '/api/me', { token: login.json.token });
  fandemo = { token: login.json.token, id: me.json.user.id };

  const adm = await req('POST', '/api/manager/login', { body: { username: 'admin', password: 'admin123' } });
  assert.equal(adm.status, 200, `manager login failed: ${adm.text}`);
  mgr = { token: adm.json.token, headers: { 'x-manager': '1' } };

  // Likes: 5 fans → A; 2 of them → C.
  for (const f of FANS) {
    const r = await req('POST', `/api/models/${MODELS.rka.id}/like`, { token: f.token });
    assert.equal(r.status, 200, `like A failed: ${r.text}`);
  }
  for (const f of FANS.slice(0, 2)) {
    const r = await req('POST', `/api/models/${MODELS.rkc.id}/like`, { token: f.token });
    assert.equal(r.status, 200, `like C failed: ${r.text}`);
  }
  // Earnings via real tips from fandemo's seeded $100 (60/40 split):
  await tipTo(MODELS.rkb.id, 1000); // B earns $6.00
  await tipTo(MODELS.rkc.id, 500);  // C earns $3.00
  await tipTo(MODELS.rkd.id, 148);  // D earns 89¢ (fractional — no floor)
});

test.after(async () => {
  await stopServer();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

/* ---------------- API: the composite formula ---------------- */

test('composite: rank_score = likes + credited earnings in dollars', async () => {
  const a = await inDir(MODELS.rka.id);
  const b = await inDir(MODELS.rkb.id);
  const c = await inDir(MODELS.rkc.id);
  const d = await inDir(MODELS.rkd.id);
  assert.equal(b.rank_score, 6, 'earnings-only: $6.00 earned = 6 points');
  assert.equal(a.rank_score, 5, 'likes-only: 5 likes = 5 points');
  assert.equal(c.rank_score, 5, 'mixed: 2 likes + $3.00 earned = 5 points');
  assert.equal(d.rank_score, 0.89, 'fractional: 89¢ earned moves the score by exactly 0.89 (no floor)');
  assert.equal(a.like_count, 5);
  assert.equal(b.like_count, 0);
  const stacey = (await directory()).find((m) => m.username === 'stacey');
  assert.equal(stacey.rank_score, 0, 'a model with no likes and no earnings scores 0');
});

test('composite: /api/models default order + rank_position follow the formula', async () => {
  const models = await directory();
  const mine = models.filter((m) => ['rka', 'rkb', 'rkc', 'rkd']
    .some((k) => MODELS[k].id === m.id)).map((m) => m.id);
  assert.deepEqual(mine, [MODELS.rkb.id, MODELS.rka.id, MODELS.rkc.id, MODELS.rkd.id],
    'payload order: B (6) → A (5, 5 likes) → C (5, 2 likes) → D (0.89); the 5.00 tie breaks on like count');
  const pos = {};
  for (const m of models) pos[m.id] = m.rank_position;
  assert.equal(pos[MODELS.rkb.id], 1);
  assert.equal(pos[MODELS.rka.id], 2);
  assert.equal(pos[MODELS.rkc.id], 3);
  assert.equal(pos[MODELS.rkd.id], 4);
});

test('composite: like then unlike returns the score exactly', async () => {
  const fan = FANS[0]; // already likes A and C, not D
  const like = await req('POST', `/api/models/${MODELS.rkd.id}/like`, { token: fan.token });
  assert.equal(like.status, 200, like.text);
  assert.equal(like.json.liked, true);
  assert.equal((await inDir(MODELS.rkd.id)).rank_score, 1.89, '0.89 earnings + 1 like');
  const unlike = await req('POST', `/api/models/${MODELS.rkd.id}/like`, { token: fan.token });
  assert.equal(unlike.status, 200, unlike.text);
  assert.equal(unlike.json.liked, false);
  assert.equal((await inDir(MODELS.rkd.id)).rank_score, 0.89, 'unlike returns the score to earnings alone');
});

test('labels: featured float changes payload order but NOT rank_position', async () => {
  const feat = await req('POST', `/api/admin/models/${MODELS.rkd.id}/feature`, {
    body: { featured: true }, ...mgr });
  assert.equal(feat.status, 200, feat.text);
  const models = await directory();
  assert.equal(models[0].id, MODELS.rkd.id, 'featured model floats to the top of the payload');
  assert.equal(models[0].is_featured, true);
  const d = models.find((m) => m.id === MODELS.rkd.id);
  const b = models.find((m) => m.id === MODELS.rkb.id);
  assert.equal(d.rank_position, 4, 'her TRUE composite position is 4 — the float must not label her #1');
  assert.equal(b.rank_position, 1, 'B still holds the true #1');
  const un = await req('POST', `/api/admin/models/${MODELS.rkd.id}/feature`, {
    body: { featured: false }, ...mgr });
  assert.equal(un.status, 200, un.text);
  assert.equal((await directory())[0].id, MODELS.rkb.id, 'unfeatured: composite #1 leads the payload again');
});

test('composite: an admin refund reverses earnings and lowers the score', async () => {
  const refund = await req('POST', '/api/admin/refunds', {
    body: { user_id: fandemo.id, amount_cents: 1000, model_id: MODELS.rkb.id, reason: 'ranking test reversal' },
    ...mgr });
  assert.equal(refund.status, 200, refund.text);
  const b = await inDir(MODELS.rkb.id);
  const d = await inDir(MODELS.rkd.id);
  const a = await inDir(MODELS.rka.id);
  const c = await inDir(MODELS.rkc.id);
  assert.equal(b.rank_score, 0, 'refunding the $10 tip claws back the $6.00 of earnings — score returns to 0');
  assert.equal(a.rank_position, 1, 'A inherits #1');
  assert.equal(c.rank_position, 2);
  assert.ok(b.rank_position > d.rank_position, 'B (0) now ranks below D (0.89)');
});

/* ---------------- boot backfill (stopped-server DB seed) ---------------- */

test('backfill: a pre-existing ledger + likes recompute on boot; payout and test rows excluded', async () => {
  await stopServer();
  const dbPath = path.join(tmpDir, 'wogent-chat.db');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = 10000');
  const stacey = db.prepare("SELECT id FROM users WHERE username = 'stacey'").get();
  assert.ok(stacey, 'seeded stacey must exist');
  const fans = db.prepare("SELECT id FROM users WHERE role = 'fan' ORDER BY id LIMIT 3").all();
  assert.equal(fans.length, 3);
  for (const f of fans) {
    db.prepare('INSERT INTO model_likes (fan_id, model_id) VALUES (?, ?)').run(f.id, stacey.id);
  }
  const ins = db.prepare(`INSERT INTO transactions
    (fan_id, model_id, type, gross_cents, model_cents, platform_cents, note, is_test)
    VALUES (?,?,?,?,?,?,?,?)`);
  ins.run(fandemo.id, stacey.id, 'tip', 1000, 600, 400, 'backfill seed tip', 0);       // +$6.00 earned
  ins.run(null, stacey.id, 'payout', 5000, 5000, 0, 'backfill seed payout', 0);          // money OUT — excluded
  ins.run(fandemo.id, stacey.id, 'tip', 99900, 99900, 0, 'backfill seed test row', 1);    // test money — excluded
  db.prepare('UPDATE models SET rank_score = 999 WHERE user_id = ?').run(stacey.id);    // stale garbage to heal
  db.close();

  await boot();
  const s = (await directory()).find((m) => m.username === 'stacey');
  assert.equal(s.rank_score, 9, 'backfill: 3 likes + $6.00 = 9.00 (payout $50 and test $999 ignored, stale 999 healed)');
  assert.equal(s.rank_position, 1, 'backfilled 9.00 tops the roster');
});

/* ---------------- client logic (extracted pure functions) ---------------- */

function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  let depth = 0;
  let end = -1;
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (!depth) { end = j + 1; break; } }
  }
  assert.ok(end > start, `${name} braces must balance`);
  return src.slice(start, end);
}
const logic = {};
{
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(
    extractFn(app, 'discPriceBand') + '\n'
    + extractFn(app, 'discActive') + '\n'
    + extractFn(app, 'applyDiscovery') + '\n'
    + extractFn(app, 'rankBadgeFor')
    + '\n;globalThis.__x = { discActive, applyDiscovery, rankBadgeFor };', ctx);
  Object.assign(logic, ctx.__x);
}
const D = (over) => Object.assign(
  { q: '', online: false, live: false, price: 'any', tag: '', sort: 'top' }, over);

test('client: default sort is the composite; Most liked is purely like-ordered', () => {
  // Fabricated in composite order (B, A, C, D) with likes misaligned.
  const roster = [
    { id: 2, rank_score: 6, like_count: 0, per_message_cents: 100, is_online: false, is_live: false, tags: [], created_at: '2026-10-02 00:00:00', display_name: 'B', username: 'b' },
    { id: 1, rank_score: 5, like_count: 5, per_message_cents: 100, is_online: false, is_live: false, tags: [], created_at: '2026-10-01 00:00:00', display_name: 'A', username: 'a' },
    { id: 3, rank_score: 5, like_count: 2, per_message_cents: 100, is_online: false, is_live: false, tags: [], created_at: '2026-10-03 00:00:00', display_name: 'C', username: 'c' },
    { id: 4, rank_score: 0.89, like_count: 0, per_message_cents: 100, is_online: false, is_live: false, tags: [], created_at: '2026-10-04 00:00:00', display_name: 'D', username: 'd' },
  ];
  const ids = (l) => l.map((m) => m.id);
  assert.deepEqual(ids(logic.applyDiscovery(roster, D({}))), [2, 1, 3, 4],
    'default (top ranked) preserves the server composite order untouched');
  assert.deepEqual(ids(logic.applyDiscovery(roster, D({ sort: 'liked' }))), [1, 3, 2, 4],
    'most liked: 5 likes → 2 likes → 0-like pair by rank tiebreak — B\'s earnings do NOT buy position here');
});

test('client: badge gate — positions 1 and 10 labeled, 11+ and unknown unlabeled', () => {
  assert.equal(logic.rankBadgeFor({ rank_position: 1 }), 1);
  assert.equal(logic.rankBadgeFor({ rank_position: 10 }), 10);
  assert.equal(logic.rankBadgeFor({ rank_position: 11 }), 0, 'position 11 gets no badge');
  assert.equal(logic.rankBadgeFor({ rank_position: null }), 0);
  assert.equal(logic.rankBadgeFor({}), 0);
  assert.equal(logic.rankBadgeFor(null), 0);
});

test('client: badge suppression state — discActive is false ONLY in the pure default view', () => {
  assert.equal(logic.discActive(D({})), false, 'default Top ranked view: badges may show');
  assert.equal(logic.discActive(D({ sort: 'price_low' })), true, 'a price-sorted list must never label anyone');
  assert.equal(logic.discActive(D({ sort: 'liked' })), true);
  assert.equal(logic.discActive(D({ q: 'x' })), true, 'search active hides badges');
  assert.equal(logic.discActive(D({ tag: 'Cosplay' })), true, 'tag filter active hides badges');
});

/* ---------------- source pins ---------------- */

test('pins: server — migration, one derivation, every mutation hook, boot backfill', () => {
  assert.ok(server.includes("addColumnIfMissing('models', 'rank_score'"), 'rank_score is an additive migration');
  assert.ok(server.includes('function recomputeModelRank('), 'single derivation exists');
  assert.equal(server.split('recomputeModelRank(modelId);').length - 1, 3,
    'hooked in chargeFan (credit), refundFan (reversal) and the like endpoint — nowhere else needed');
  assert.ok(server.includes("type <> 'payout' AND is_test = 0"),
    'earnings sum excludes payout rows and test money');
  assert.ok(server.includes('recomputeAllModelRanks()'), 'boot backfill recomputes every model');
  assert.ok(server.includes('[ranking]'), 'boot backfill logs its run');
  assert.ok(server.includes('ORDER BY m.is_featured DESC,\n             m.rank_score DESC'),
    'directory orders by the stored composite after the featured float');
  assert.ok(server.includes('rank_position: rankPos.get(r.id)'),
    'payload carries the true composite position');
});

test('pins: client — badge markup, both call sites suppress with discovery, peek line localized', () => {
  assert.ok(app.includes('tile-rank-badge'), 'tile badge markup exists');
  assert.ok(app.includes('opts.rankBadge'), 'modelTileHTML renders the badge from its opt');
  assert.ok(app.includes('opts.rankBadges !== false'), 'homeTilesHTML mirrors the crown suppression pattern');
  assert.equal(app.split('rankBadges: !discActive(disc)').length - 1, 2,
    'guest landing + fan home both hide badges whenever discovery is active');
  assert.ok(app.includes("t('ranked_n'"), 'peek states her rank via the localized string');
  assert.equal(app.split('ranked_n:').length - 1, 13, 'ranked_n exists in all 13 languages');
  assert.equal(app.split('sort_top:').length - 1, 13, 'sort_top (Top ranked) exists in all 13 languages');
  assert.ok(app.includes("'top', 'liked', 'online'"), 'Top ranked is the first sort option, Most liked kept');
  assert.ok(app.includes("sort: 'top'"), 'discovery state defaults to Top ranked');
  assert.ok(css.includes('.tile-rank-badge'), 'badge styles exist');
});
