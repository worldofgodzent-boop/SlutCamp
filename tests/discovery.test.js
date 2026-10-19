'use strict';
/*
 * Discovery 2.0 — search / filters / tags / similar models for the model
 * directory (the playbook's #1 quick win: OnlyFans has NO in-platform
 * discovery; this is the gap SlutCamp closes).
 *
 * Three layers:
 *
 * 1. API tests against the REAL server (boots server.js in a throwaway
 *    temp copy, same harness pattern as tests/reactions.test.js): the
 *    directory payload now carries `tags` + `created_at` for every model
 *    (guests included), and PUT /api/model/profile persists discovery
 *    tags with the catalogue/cap rules enforced server-side.
 *
 * 2. Logic tests for the client-side filter/sort/similar functions.
 *    GET /api/models returns the FULL roster in one call (no server
 *    pagination), so filtering is client-side by design. The functions
 *    (applyDiscovery / discPriceBand / similarModels) are pure — the
 *    tests extract them from public/js/app.js and run the real code
 *    against fabricated rosters.
 *
 * 3. Source pins for the UI wiring: discovery bar in BOTH directory
 *    views (guest landing + fan home), tag chips on tiles, the peek
 *    "More like her" rail, and the Settings tag picker.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const vm = require('node:vm');
const { spawn } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const app = read('public/js/app.js');
const server = read('server.js');
const css = read('public/css/styles.css');

/* ---------------- server harness (reactions.test.js pattern) ---------------- */

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

async function req(method, p, { body, token, guest } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = 'Bearer ' + token;
  if (guest) headers['x-guest-token'] = guest;
  const r = await fetch(base + p, {
    method,
    headers,
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

/* Scenario: seeded bunny/stacey/bella (SEED_DEMO=1) + three models
 * created through the real signup API with distinct rates/tags:
 *   zara — $2.00/msg, online, tags [Tattoos, Cosplay, Gaming]
 *   mia  — $4.50/msg, online, tags [Tattoos, Fitness]
 *   gia  — $9.00/msg, offline, tags [Cosplay]                       */
const M = {}; // username → { token, id }
let fan = null;

async function directory() {
  const r = await req('GET', '/api/models');
  assert.equal(r.status, 200, r.text);
  return r.json.models;
}
const inDirectory = async (username) => (await directory()).find((m) => m.username === username);

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-discovery-'));
  for (const f of ['server.js', 'package.json']) {
    fs.copyFileSync(path.join(REPO, f), path.join(tmpDir, f));
  }
  for (const d of ['lib', 'public', 'data']) {
    fs.cpSync(path.join(REPO, d), path.join(tmpDir, d), { recursive: true });
  }
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(tmpDir, 'node_modules'), 'dir');

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
      for (const f of fs.readdirSync(tmpDir)) {
        if (/^wogent-chat\.db/.test(f)) fs.rmSync(path.join(tmpDir, f), { force: true });
      }
      fs.rmSync(path.join(tmpDir, 'uploads'), { recursive: true, force: true });
      fs.rmSync(path.join(tmpDir, 'private'), { recursive: true, force: true });
    }
  }
  if (!base) throw lastErr || new Error('server failed to boot after 3 attempts');

  const suffix = Math.random().toString(36).slice(2, 8);
  const mkUser = async (name, role, display) => {
    const s = await req('POST', '/api/auth/signup', {
      body: { username: name + suffix, password: 'disc-pass-1', role, display_name: display, dob: '1996-04-12', agree18: true, ...(role === 'model' ? { section: 'female' } : {}) },
    });
    assert.equal(s.status, 200, `${role} signup failed: ${s.text}`);
    return { token: s.json.token, id: s.json.user.id, username: name + suffix };
  };
  fan = await mkUser('discfan', 'fan', 'Disc Fan');

  const mkModel = async (name, display, profile) => {
    const u = await mkUser(name, 'model', display);
    const put = await req('PUT', '/api/model/profile', { body: profile, token: u.token });
    assert.equal(put.status, 200, `profile setup for ${name} failed: ${put.text}`);
    M[name] = u;
  };
  await mkModel('zara', 'Zara Ink', { per_message_cents: 200, is_online: 1, tags: ['Tattoos', 'Cosplay', 'Gaming'] });
  await mkModel('mia', 'Mia Fit', { per_message_cents: 450, is_online: 1, tags: ['Tattoos', 'Fitness'] });
  await mkModel('gia', 'Gia Gold', { per_message_cents: 900, is_online: 0, tags: ['Cosplay'] });
});

test.after(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((r) => child.once('exit', r)),
      new Promise((r) => setTimeout(r, 5000)),
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

/* ---------------- API: directory payload ---------------- */

test('directory: guest payload carries tags[] + created_at on every model', async () => {
  const models = await directory(); // no token — the guest view
  assert.ok(models.length >= 6, 'seeded + created models must all list');
  for (const m of models) {
    assert.ok(Array.isArray(m.tags), `${m.username} must carry a tags array`);
    assert.equal(typeof m.created_at, 'string', `${m.username} must carry created_at (Newest sort)`);
    assert.ok(m.created_at.length >= 10);
    assert.equal(typeof m.per_message_cents, 'number');
    assert.equal(typeof m.is_online, 'boolean');
    assert.equal(typeof m.is_live, 'boolean');
    assert.equal(typeof m.rank_score, 'number');
  }
  const bunny = models.find((m) => m.username === 'bunny');
  assert.deepEqual(bunny.tags, [], 'existing models default to no tags');
});

test('directory: created models show their rates, online flags and tags', async () => {
  const zara = await inDirectory(M.zara.username);
  assert.equal(zara.per_message_cents, 200);
  assert.equal(zara.is_online, true);
  assert.deepEqual(zara.tags, ['Tattoos', 'Cosplay', 'Gaming']);
  const gia = await inDirectory(M.gia.username);
  assert.equal(gia.is_online, false);
  assert.deepEqual(gia.tags, ['Cosplay']);
});

/* ---------------- API: tag persistence + rules ---------------- */

test('tags: PUT persists — visible in the directory and in /api/me', async () => {
  const put = await req('PUT', '/api/model/profile', {
    body: { tags: ['Fitness', 'Live daily'] }, token: M.mia.token });
  assert.equal(put.status, 200, put.text);
  const mia = await inDirectory(M.mia.username);
  assert.deepEqual(mia.tags, ['Fitness', 'Live daily']);
  const me = await req('GET', '/api/me', { token: M.mia.token });
  assert.equal(me.status, 200);
  assert.deepEqual(JSON.parse(me.json.model.tags || '[]'), ['Fitness', 'Live daily']);
  // restore for the other tests
  const back = await req('PUT', '/api/model/profile', {
    body: { tags: ['Tattoos', 'Fitness'] }, token: M.mia.token });
  assert.equal(back.status, 200);
});

test('tags: the list caps at 5 — extra catalogue tags are dropped', async () => {
  const six = ['Cosplay', 'Gaming', 'Fitness', 'Tattoos', 'Latina'];
  const put = await req('PUT', '/api/model/profile', {
    body: { tags: [...six, 'Ebony'] }, token: M.gia.token });
  assert.equal(put.status, 200, put.text);
  const gia = await inDirectory(M.gia.username);
  assert.deepEqual(gia.tags, six, 'first five kept, sixth dropped');
  const back = await req('PUT', '/api/model/profile', {
    body: { tags: ['Cosplay'] }, token: M.gia.token });
  assert.equal(back.status, 200);
});

test('tags: unknown tags are dropped and duplicates collapse', async () => {
  const put = await req('PUT', '/api/model/profile', {
    body: { tags: ['Fitness', 'Not A Real Tag', 'Fitness', 'Tattoos'] }, token: M.mia.token });
  assert.equal(put.status, 200, put.text);
  const mia = await inDirectory(M.mia.username);
  assert.deepEqual(mia.tags, ['Fitness', 'Tattoos']);
  const back = await req('PUT', '/api/model/profile', {
    body: { tags: ['Tattoos', 'Fitness'] }, token: M.mia.token });
  assert.equal(back.status, 200);
});

test('tags: a non-array tags value is a 400 and changes nothing', async () => {
  const put = await req('PUT', '/api/model/profile', {
    body: { tags: 'Fitness' }, token: M.mia.token });
  assert.equal(put.status, 400, put.text);
  assert.equal(put.json.error, 'bad_tags');
  const mia = await inDirectory(M.mia.username);
  assert.deepEqual(mia.tags, ['Tattoos', 'Fitness']);
});

test('tags: an empty list clears her tags', async () => {
  const put = await req('PUT', '/api/model/profile', {
    body: { tags: [] }, token: M.zara.token });
  assert.equal(put.status, 200, put.text);
  const zara = await inDirectory(M.zara.username);
  assert.deepEqual(zara.tags, []);
  const back = await req('PUT', '/api/model/profile', {
    body: { tags: ['Tattoos', 'Cosplay', 'Gaming'] }, token: M.zara.token });
  assert.equal(back.status, 200);
});

test('tags: fans cannot write model profile fields (role guard intact)', async () => {
  const put = await req('PUT', '/api/model/profile', {
    body: { tags: ['Fitness'] }, token: fan.token });
  assert.equal(put.status, 403, put.text);
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
function extractArray(src, marker) {
  const m = src.match(new RegExp(marker + '\\s*=\\s*(\\[[\\s\\S]*?\\]);'));
  assert.ok(m, `${marker} array literal must exist`);
  // JSON round-trip: vm-realm arrays fail deepStrictEqual prototype checks.
  return JSON.parse(JSON.stringify(vm.runInNewContext(m[1])));
}

const CLIENT_TAGS = extractArray(app, 'const DISCOVERY_TAGS');
const SERVER_TAGS = extractArray(server, 'const MODEL_TAGS');
const logic = {};
{
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(
    extractFn(app, 'discPriceBand') + '\n'
    + extractFn(app, 'applyDiscovery') + '\n'
    + extractFn(app, 'similarModels')
    + '\n;globalThis.__x = { discPriceBand, applyDiscovery, similarModels };', ctx);
  Object.assign(logic, ctx.__x);
}

test('tags: the client and server catalogues are the same list', () => {
  assert.deepEqual(CLIENT_TAGS, SERVER_TAGS);
  assert.ok(CLIENT_TAGS.length >= 12 && CLIENT_TAGS.length <= 20,
    'catalogue stays a curated handful, not a free-for-all');
});

/* like_count values are deliberately MISALIGNED with rank_score (gia
 * out-ranks zara on the composite but has fewer likes) so the pure
 * 'Most liked' sort provably differs from the default 'Top ranked'. */
const ROSTER = [
  { id: 1, display_name: 'Zara Ink', username: 'zara', per_message_cents: 200, is_online: true, is_live: false, tags: ['Tattoos', 'Cosplay'], rank_score: 5, like_count: 3, created_at: '2026-10-01 00:00:00' },
  { id: 2, display_name: 'Mia Fit', username: 'mia', per_message_cents: 450, is_online: true, is_live: true, tags: ['Tattoos', 'Fitness'], rank_score: 9, like_count: 12, created_at: '2026-10-03 00:00:00' },
  { id: 3, display_name: 'Gia Gold', username: 'gia', per_message_cents: 900, is_online: false, is_live: false, tags: ['Cosplay'], rank_score: 7, like_count: 1, created_at: '2026-10-02 00:00:00' },
  { id: 4, display_name: 'Bunny', username: 'bunny', per_message_cents: 149, is_online: true, is_live: false, tags: [], rank_score: 20, like_count: 30, created_at: '2026-09-01 00:00:00' },
];
const D = (over) => Object.assign(
  { q: '', online: false, live: false, price: 'any', tag: '', sort: 'top' }, over);
const ids = (list) => list.map((m) => m.id);

test('logic: price bands — $ ≤ $2, $$ ≤ $5, $$$ above', () => {
  assert.equal(logic.discPriceBand(0), 1);
  assert.equal(logic.discPriceBand(200), 1);
  assert.equal(logic.discPriceBand(201), 2);
  assert.equal(logic.discPriceBand(500), 2);
  assert.equal(logic.discPriceBand(501), 3);
});

test('logic: search matches display name or username, case-insensitive', () => {
  assert.deepEqual(ids(logic.applyDiscovery(ROSTER, D({ q: 'zara' }))), [1]);
  assert.deepEqual(ids(logic.applyDiscovery(ROSTER, D({ q: 'INK' }))), [1]);
  assert.deepEqual(ids(logic.applyDiscovery(ROSTER, D({ q: 'bunny' }))), [4]);
  assert.deepEqual(ids(logic.applyDiscovery(ROSTER, D({ q: 'nobody' }))), []);
});

test('logic: online / live / price / tag filters, alone and combined', () => {
  assert.deepEqual(ids(logic.applyDiscovery(ROSTER, D({ online: true }))), [1, 2, 4]);
  assert.deepEqual(ids(logic.applyDiscovery(ROSTER, D({ live: true }))), [2]);
  assert.deepEqual(ids(logic.applyDiscovery(ROSTER, D({ price: '1' }))), [1, 4]);
  assert.deepEqual(ids(logic.applyDiscovery(ROSTER, D({ price: '2' }))), [2]);
  assert.deepEqual(ids(logic.applyDiscovery(ROSTER, D({ price: '3' }))), [3]);
  assert.deepEqual(ids(logic.applyDiscovery(ROSTER, D({ tag: 'Tattoos' }))), [1, 2]);
  assert.deepEqual(ids(logic.applyDiscovery(ROSTER, D({ tag: 'Cosplay' }))), [1, 3]);
  assert.deepEqual(ids(logic.applyDiscovery(ROSTER,
    D({ tag: 'Tattoos', online: true, price: '1' }))), [1]);
});

test('logic: sorts — default preserves server rank order; others reorder with rank tiebreak', () => {
  assert.deepEqual(ids(logic.applyDiscovery([ROSTER[2], ROSTER[0], ROSTER[1]], D({}))), [3, 1, 2],
    'default (top ranked) must NOT reorder what the server ranked');
  assert.deepEqual(ids(logic.applyDiscovery(ROSTER, D({ sort: 'liked' }))), [4, 2, 1, 3],
    'most liked sorts by like count alone (zara 3 likes passes gia 1 like despite the lower rank)');
  assert.deepEqual(ids(logic.applyDiscovery(ROSTER, D({ sort: 'price_low' }))), [4, 1, 2, 3]);
  assert.deepEqual(ids(logic.applyDiscovery(ROSTER, D({ sort: 'price_high' }))), [3, 2, 1, 4]);
  assert.deepEqual(ids(logic.applyDiscovery(ROSTER, D({ sort: 'online' }))), [4, 2, 1, 3]);
  assert.deepEqual(ids(logic.applyDiscovery(ROSTER, D({ sort: 'newest' }))), [2, 3, 1, 4]);
});

test('logic: similar models — shared tags first, then rank; never herself; capped at 6', () => {
  const zara = ROSTER[0];
  assert.deepEqual(ids(logic.similarModels(zara, ROSTER)), [2, 3, 4],
    'mia + gia share one tag each (rank breaks the tie), bunny shares none');
  const many = Array.from({ length: 9 }, (_, i) => ({
    id: 10 + i, display_name: 'M' + i, username: 'm' + i, tags: ['Cosplay'],
    rank_score: i, per_message_cents: 100, is_online: false, is_live: false,
    created_at: '2026-10-01 00:00:00',
  }));
  const sims = logic.similarModels(zara, [zara, ...many]);
  assert.equal(sims.length, 6);
  assert.ok(!sims.some((s) => s.id === zara.id));
  assert.deepEqual(ids(logic.similarModels(ROSTER[3], ROSTER)), [2, 3, 1],
    'no tags anywhere → falls back to pure rank order');
  assert.deepEqual(logic.similarModels(zara, [zara]), [], 'alone in the roster → nothing to show');
});

/* ---------------- source pins: UI wiring ---------------- */

test('pins: discovery bar renders in BOTH directory views and both apply the filter state', () => {
  assert.equal(app.split('applyDiscovery(models, disc)').length - 1, 2,
    'guest landing + fan home both filter the roster');
  assert.equal(app.split('${discoveryBarHTML(models)}').length - 1, 2,
    'guest landing + fan home both render the search/filter bar');
  assert.ok(app.includes("wireDiscovery('landing')"), 'guest view wires the controls');
  assert.ok(app.includes("wireDiscovery('fanModels')"), 'fan view wires the controls');
  assert.ok(app.includes('id="disc-q"'), 'search input exists');
  assert.ok(app.includes('id="disc-sort"'), 'sort control exists');
  assert.ok(app.includes('data-disc-toggle="online"') && app.includes('data-disc-toggle="live"'),
    'online + live toggles exist');
  assert.ok(app.includes('data-disc-tag='), 'directory tag row exists');
});

test('pins: tiles show tag chips; the peek carries tags + the More-like-her rail', () => {
  assert.ok(app.includes('m.tags.slice(0, 3)') && app.includes('tag-chip'),
    'model tiles render up to 3 tag chips');
  assert.ok(app.includes("t('more_like_her')"), 'peek has the More like her heading');
  assert.ok(app.includes('data-sim="') || app.includes('data-sim="${s.id}"'),
    'peek rail cards carry the model id');
  assert.ok(app.includes('data-peek-tag="') || app.includes('data-peek-tag="${esc(tg)}"'),
    'peek tags are tappable filters');
  assert.ok(app.includes('similarModels(m, models)'), 'peek ranks via similarModels');
});

test('pins: Settings tag picker saves through the profile PUT; crown only in default order', () => {
  assert.ok(app.includes('data-tag-pick="') || app.includes('data-tag-pick="${esc(tg)}"'),
    'settings renders the tag picker chips');
  assert.ok(app.includes('id="s-tags-save"'), 'settings has the save button');
  assert.ok(app.includes('tags: selTags'), 'settings saves tags via PUT /api/model/profile');
  assert.ok(app.includes('selTags.length >= 5'), 'client enforces the same 5-tag cap');
  assert.ok(app.includes('opts.crown'), 'homeTilesHTML can suppress the Top-Model crown');
  assert.ok(app.includes('crown: !discActive(disc)'), 'crown suppressed whenever discovery is active');
});

test('pins: server migration + catalogue + endpoint wiring', () => {
  assert.ok(server.includes("addColumnIfMissing('models', 'tags'"),
    'tags column is an additive migration');
  assert.ok(server.includes('const MAX_MODEL_TAGS = 5'), 'server caps tags at 5');
  assert.ok(server.includes('m.tags'), 'directory endpoint selects tags');
  assert.ok(server.includes('tags: parseModelTags(rawTags)'),
    'directory endpoint returns tags as a clean array');
  assert.ok(server.includes("error: 'bad_tags'"), 'profile PUT rejects non-array tags');
  assert.ok(css.includes('.disc-chip') && css.includes('.tag-chip') && css.includes('.sim-rail'),
    'discovery styles exist');
});
