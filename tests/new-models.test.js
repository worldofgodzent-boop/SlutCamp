'use strict';
/*
 * "New models you may like" — the front-page rail (owner request,
 * 2026-10-16): every new model pops on the front page for her first
 * two weeks; the rail shows the top 10 of them, in directory rank.
 *
 * Three layers, same shape as tests/discovery.test.js:
 *
 * 1. Logic tests for the pure selection functions. The windowing is
 *    client-side over the /api/models payload's created_at (the
 *    endpoint returns the full roster ranked; the payload's order IS
 *    the directory rank, so the rail filters + caps without re-sorting).
 *    modelCreatedMs / newModelsRail are extracted from app.js and run
 *    as the real code against fabricated rosters at a fixed "now".
 *
 * 2. API shape tests against the REAL server (throwaway temp copy,
 *    reactions/discovery harness pattern): the guest payload and the
 *    fan payload both feed the selection function identically, a model
 *    who signs up today is on the rail, and she ages out on her own
 *    with zero admin action.
 *
 * 3. Source pins: rail rendered at the top of BOTH front-page views
 *    (fan directory + guest landing), hidden while Discovery is active,
 *    nothing rendered when nobody qualifies, NEW badge on rail tiles,
 *    the 14-day / 10-cap constants, EN/ES/PT strings, rail CSS.
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
const css = read('public/css/styles.css');

/* ---------------- extract the real client logic ---------------- */

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
function extractConst(src, name) {
  const m = src.match(new RegExp(`const ${name} = (\\d+);`));
  assert.ok(m, `const ${name} must be a plain numeric constant`);
  return Number(m[1]);
}

const logic = {};
{
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(
    `const NEW_MODEL_WINDOW_DAYS = ${extractConst(app, 'NEW_MODEL_WINDOW_DAYS')};\n`
    + `const NEW_MODELS_RAIL_MAX = ${extractConst(app, 'NEW_MODELS_RAIL_MAX')};\n`
    + extractFn(app, 'modelCreatedMs') + '\n'
    + extractFn(app, 'newModelsRail')
    + '\n;globalThis.__x = { modelCreatedMs, newModelsRail, NEW_MODEL_WINDOW_DAYS, NEW_MODELS_RAIL_MAX };',
    ctx);
  Object.assign(logic, ctx.__x);
}

/* ---------------- logic: the two-week window ---------------- */

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-10-16T12:00:00Z');
const stamp = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const M = (id, createdMs, over) => Object.assign({
  id, display_name: 'Model ' + id, username: 'm' + id,
  created_at: stamp(createdMs), rank_score: 100 - id,
  per_message_cents: 200, is_online: false, is_live: false, tags: [],
}, over || {});
const ids = (list) => list.map((m) => m.id);

test('constants: two weeks on the rail, top ten on the page', () => {
  assert.equal(logic.NEW_MODEL_WINDOW_DAYS, 14);
  assert.equal(logic.NEW_MODELS_RAIL_MAX, 10);
});

test('window: created_at parses as UTC in both payload shapes', () => {
  assert.equal(logic.modelCreatedMs({ created_at: '2026-10-16 12:00:00' }), NOW);
  assert.equal(logic.modelCreatedMs({ created_at: '2026-10-16T12:00:00Z' }), NOW);
  assert.ok(Number.isNaN(logic.modelCreatedMs({ created_at: '' })), 'missing → NaN');
  assert.ok(Number.isNaN(logic.modelCreatedMs({})), 'absent → NaN');
  assert.ok(Number.isNaN(logic.modelCreatedMs({ created_at: 'not a date' })), 'garbage → NaN');
});

test('window: 13d23h is IN, 14d01h is OUT, exactly 14d is OUT', () => {
  const justIn = M(1, NOW - (13 * DAY + 23 * HOUR));
  const justOut = M(2, NOW - (14 * DAY + 1 * HOUR));
  const exactEdge = M(3, NOW - 14 * DAY);
  const brandNew = M(4, NOW);
  const ancient = M(5, NOW - 90 * DAY);
  assert.deepEqual(ids(logic.newModelsRail([justIn, justOut, exactEdge, brandNew, ancient], NOW)),
    [1, 4], 'her two weeks end AT the 14-day mark, not a minute later');
});

test('window: future-dated and undated accounts never count as new', () => {
  const future = M(1, NOW + 1 * HOUR);
  const undated = { id: 2, display_name: 'No Date', username: 'nodate' };
  assert.deepEqual(logic.newModelsRail([future, undated], NOW), []);
});

test('cap + order: 12 qualifying → the top 10 by rank, payload order kept', () => {
  // Payload order IS the server rank (featured, then rank_score desc).
  // Two veterans sit interleaved at ranks 2 and 5 — they never qualify,
  // and they must not consume rail slots.
  const roster = [];
  for (let i = 1; i <= 14; i++) {
    const veteran = (i === 2 || i === 5);
    roster.push(M(i, NOW - (veteran ? 40 * DAY : i * HOUR), { rank_score: 200 - i }));
  }
  const rail = logic.newModelsRail(roster, NOW);
  assert.equal(rail.length, 10, 'cap is 10 even with 12 qualifying');
  assert.deepEqual(ids(rail), [1, 3, 4, 6, 7, 8, 9, 10, 11, 12],
    'the first ten qualifiers in rank order; #13/#14 by rank wait off the rail');
  assert.ok(!ids(rail).includes(2) && !ids(rail).includes(5), 'veterans never pop');
});

test('order: rail preserves rank even when a later model is newer', () => {
  const roster = [
    M(1, NOW - 10 * DAY, { rank_score: 90 }),
    M(2, NOW - 1 * HOUR, { rank_score: 50 }),
    M(3, NOW - 2 * DAY, { rank_score: 70 }),
  ];
  assert.deepEqual(ids(logic.newModelsRail(roster, NOW)), [1, 2, 3],
    'rank order wins over recency — the rail is a chart, not a feed');
});

test('empty cases: no roster, nobody new → empty rail (section renders nothing)', () => {
  assert.deepEqual(logic.newModelsRail([], NOW), []);
  assert.equal(logic.newModelsRail(null, NOW).length, 0,
    'null roster → empty (length check: the fallback [] is a vm-realm array)');
  assert.deepEqual(logic.newModelsRail([M(1, NOW - 30 * DAY), M(2, NOW - 15 * DAY)], NOW), []);
});

/* ---------------- server harness (discovery pattern) ---------------- */

let tmpDir = null;
let child = null;
let base = null;
let childLog = '';
let newModel = null; // { token, id, username }
let fanToken = null;

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

async function req(method, p, { body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = 'Bearer ' + token;
  const r = await fetch(base + p, {
    method, headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* HTML or empty */ }
  return { status: r.status, text, json };
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

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-newmodels-'));
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
  const signup = async (name, role, display) => {
    const s = await req('POST', '/api/auth/signup', {
      body: { username: name + suffix, password: 'newmod-pass-1', role, display_name: display, dob: '1997-05-20', agree18: true },
    });
    assert.equal(s.status, 200, `${role} signup failed: ${s.text}`);
    return { token: s.json.token, id: s.json.user.id, username: name + suffix };
  };
  const f = await signup('railfan', 'fan', 'Rail Fan');
  fanToken = f.token;
  newModel = await signup('railmodel', 'model', 'Rail Model');
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

test('api: guest + fan payloads both feed the rail; a signup today pops; she ages out alone', async () => {
  const guest = await req('GET', '/api/models');
  assert.equal(guest.status, 200, guest.text);
  const fan = await req('GET', '/api/models', { token: fanToken });
  assert.equal(fan.status, 200, fan.text);
  const gModels = guest.json.models;
  const fModels = fan.json.models;
  assert.ok(gModels.length >= 3, 'seeded roster present');
  assert.deepEqual(fModels.map((m) => m.username), gModels.map((m) => m.username),
    'guests and fans rank the same roster');
  for (const m of [...gModels, ...fModels]) {
    assert.ok(Number.isFinite(logic.modelCreatedMs(m)),
      `${m.username} created_at must parse on both payload shapes`);
  }
  const now = Date.now();
  const gRail = logic.newModelsRail(gModels, now);
  const fRail = logic.newModelsRail(fModels, now);
  assert.deepEqual(ids(fRail), ids(gRail), 'same rail for guests and fans');
  assert.ok(gRail.length >= 1 && gRail.length <= 10, 'rail is capped at 10');
  assert.ok(gRail.some((m) => m.username === newModel.username),
    'a model who joined today pops on the front page immediately');
  assert.deepEqual(ids(gRail), ids(gModels).filter((id) => ids(gRail).includes(id)),
    'rail order is a subsequence of the payload rank order');
  const later = logic.newModelsRail(gModels, now + 15 * DAY);
  assert.ok(!later.some((m) => m.username === newModel.username),
    'fifteen days on, she has aged out with no admin action');
});

/* ---------------- source pins ---------------- */

test('pins: the rail renders at the top of BOTH front-page views', () => {
  assert.equal(app.split('${newModelsRailHTML(models, heartFor)}').length - 1, 2,
    'fan directory + guest landing both render the rail');
  assert.ok(app.includes('const heartFor'), 'both views share one heart/follow renderer between rail and grid');
});

test('pins: hide rules — silent while Discovery is active, silent when nobody qualifies', () => {
  const rail = extractFn(app, 'newModelsRailHTML');
  assert.ok(rail.indexOf('discActive(disc)') >= 0
    && rail.indexOf('discActive(disc)') < rail.indexOf('newModelsRail(models'),
  'the Discovery-active check runs before any selection');
  assert.ok(rail.includes("if (discActive(disc)) return '';"),
    'search/filter/sort active → no rail (mirrors the crown rule)');
  assert.ok(rail.includes("if (!fresh.length) return '';"),
    'nobody inside her two weeks → no section, no empty heading');
  assert.ok(rail.includes('newModelsRail(models, Date.now())'),
    'the window is evaluated at render time — aging out needs no cron');
});

test('pins: rail tiles are real directory tiles wearing a NEW badge', () => {
  assert.ok(app.includes('modelTileHTML(m, { isNew: true, heartHTML: heart(m) })'),
    'rail reuses modelTileHTML with the view’s own heart renderer');
  const tile = extractFn(app, 'modelTileHTML');
  assert.ok(tile.includes("opts.isNew ? `<span class=\"tile-new-pill"),
    'the NEW badge renders only when the tile is flagged new');
  assert.ok(tile.includes("t('new_badge')"), 'badge text is localized');
  assert.ok(app.includes("t('new_models_title')"), 'section heading is localized');
  assert.equal(app.split('new_models_title:').length - 1, 3, 'title exists in EN + ES + PT');
  assert.equal(app.split('new_badge:').length - 1, 3, 'badge exists in EN + ES + PT');
  assert.ok(app.includes("new_models_title: '🆕 New models you may like'"),
    'the owner’s exact section name ships in English');
});

test('pins: rail styles exist and rail tiles keep the tile look at rail size', () => {
  assert.ok(css.includes('.tile-new-pill'), 'NEW pill styled');
  assert.ok(css.includes('.tile-new-pill.below-viewers'), 'live rail tiles drop the badge under the viewer count');
  assert.ok(css.includes('.new-rail {'), 'rail container styled');
  assert.ok(css.includes('overflow-x: auto'), 'rail scrolls horizontally like the peek rail');
  assert.ok(css.includes('.new-rail .model-tile'), 'rail constrains the shared tile component');
  assert.ok(css.includes('.new-rail-title'), 'section heading styled');
});
