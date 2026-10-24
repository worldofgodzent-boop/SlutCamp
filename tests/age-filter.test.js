'use strict';
/*
 * Age Preference filter (Asce, Oct 23 2026 — Pink-style, placed as a
 * pill in the directory filter row): the fan picks a min–max age and
 * the directory grid shows only models inside it.
 *
 * Three layers, mirroring tests/discovery.test.js:
 *
 * 1. API tests against the REAL server: GET /api/models carries a
 *    computed whole-years `age` per model (birthday-boundary exact),
 *    `age: null` when no dob is on file, and the DOB ITSELF NEVER
 *    appears anywhere in the payload.
 *
 * 2. Logic tests for the client filter (extracted applyDiscovery /
 *    discActive run in a vm over fabricated rosters): range in/out,
 *    boundaries inclusive, max 65 is open-ended (65 and over), full
 *    range is a no-op, age:null always passes, and discActive lights
 *    up for an age-only filter (which is what hides the New Models
 *    rail + crown while filtering).
 *
 * 3. Source pins: the Age pill in the filter row with its state label,
 *    the slider sheet (Save / Cancel / Any age), localStorage
 *    persistence + the Clear-filters reset, STR keys ×13, slider CSS,
 *    and her age never being read by any tile/profile renderer.
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

/* Birthday-edge fixtures, computed off the local clock the server
 * shares: A turns 30 TODAY, B turns 30 TOMORROW, C turns 18 TODAY. */
const now = new Date();
const fmtDob = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const yearsAgo = (y, addDays) => fmtDob(new Date(now.getFullYear() - y, now.getMonth(), now.getDate() + (addDays || 0)));
const DOB_A = yearsAgo(30, 0);
const DOB_B = yearsAgo(30, 1);
const DOB_C = yearsAgo(18, 0);
const DOB_D = '1992-06-15';

const M = {}; // key → { token, id, username }

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-agefilter-'));
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
  const mkModel = async (key, name, dob) => {
    const s = await req('POST', '/api/auth/signup', {
      body: { username: name + suffix, password: 'age-pass-1', role: 'model', display_name: name, dob, agree18: true, section: 'female' },
    });
    assert.equal(s.status, 200, `model signup failed: ${s.text}`);
    M[key] = { token: s.json.token, id: s.json.user.id, username: name + suffix };
  };
  await mkModel('a', 'agea', DOB_A);
  await mkModel('b', 'ageb', DOB_B);
  await mkModel('c', 'agec', DOB_C);
  await mkModel('d', 'aged', DOB_D);

  /* Model D loses her dob (the legacy/data-gap case): no dob on file
   * must surface as age:null and pass every filter. */
  const dbPath = path.join(tmpDir, 'wogent-chat.db');
  assert.ok(fs.existsSync(dbPath), 'server db lives in the temp copy');
  const db = new DatabaseSync(dbPath);
  db.prepare('UPDATE users SET dob = NULL WHERE id = ?').run(M.d.id);
  db.close();
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

async function directoryRaw() {
  const r = await req('GET', '/api/models');
  assert.equal(r.status, 200, r.text);
  return r;
}

/* ---------------- API: the age payload ---------------- */

test('payload: every model carries age (integer or null) and NEVER a dob', async () => {
  const r = await directoryRaw();
  assert.ok(r.json.models.length >= 4, 'seeded + created models list');
  for (const m of r.json.models) {
    assert.ok('age' in m, `${m.username} must carry the computed age field`);
    assert.ok(m.age === null || Number.isInteger(m.age), `${m.username} age is a whole-years integer or null`);
    assert.ok(!('dob' in m), `${m.username} must NOT carry her dob`);
  }
  for (const dob of [DOB_A, DOB_B, DOB_C, DOB_D]) {
    assert.ok(!r.text.includes(dob), `the raw payload must never contain the dob string ${dob}`);
  }
  assert.ok(!r.text.includes('"dob"'), 'no dob key anywhere in the directory payload');
});

test('payload: birthday-boundary ages are exact', async () => {
  const { json } = await directoryRaw();
  const byName = (u) => json.models.find((m) => m.username === u);
  assert.equal(byName(M.a.username).age, 30, 'turns 30 today → 30');
  assert.equal(byName(M.b.username).age, 29, 'turns 30 tomorrow → still 29');
  assert.equal(byName(M.c.username).age, 18, 'turns 18 today → 18');
});

test('payload: no dob on file → age null', async () => {
  const { json } = await directoryRaw();
  const d = json.models.find((m) => m.username === M.d.username);
  assert.ok(d, 'the dob-less model still lists');
  assert.equal(d.age, null);
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
    + extractFn(app, 'applyDiscovery')
    + '\n;globalThis.__x = { discActive, applyDiscovery };', ctx);
  Object.assign(logic, ctx.__x);
}

const ROSTER = [
  { id: 1, display_name: 'Young', username: 'young', age: 19, per_message_cents: 100, is_online: true, is_live: false, tags: [], rank_score: 5, like_count: 1, created_at: '2026-10-01 00:00:00' },
  { id: 2, display_name: 'Mid', username: 'mid', age: 25, per_message_cents: 100, is_online: true, is_live: false, tags: [], rank_score: 9, like_count: 1, created_at: '2026-10-01 00:00:00' },
  { id: 3, display_name: 'Edge', username: 'edge', age: 27, per_message_cents: 100, is_online: true, is_live: false, tags: [], rank_score: 7, like_count: 1, created_at: '2026-10-01 00:00:00' },
  { id: 4, display_name: 'Older', username: 'older', age: 45, per_message_cents: 100, is_online: true, is_live: false, tags: [], rank_score: 6, like_count: 1, created_at: '2026-10-01 00:00:00' },
  { id: 5, display_name: 'Senior', username: 'senior', age: 70, per_message_cents: 100, is_online: true, is_live: false, tags: [], rank_score: 4, like_count: 1, created_at: '2026-10-01 00:00:00' },
  { id: 6, display_name: 'Unknown', username: 'unknown', age: null, per_message_cents: 100, is_online: true, is_live: false, tags: [], rank_score: 3, like_count: 1, created_at: '2026-10-01 00:00:00' },
];
const D = (over) => Object.assign(
  { q: '', online: false, live: false, price: 'any', tag: '', sort: 'top', ageMin: 18, ageMax: 65 }, over);
const ids = (list) => list.map((m) => m.id);

test('logic: full range is a no-op — everybody passes, incl. 65+ and unknown', () => {
  assert.deepEqual(ids(logic.applyDiscovery(ROSTER, D({}))), [1, 2, 3, 4, 5, 6]);
});

test('logic: range keeps only models inside it, boundaries inclusive', () => {
  assert.deepEqual(ids(logic.applyDiscovery(ROSTER, D({ ageMin: 18, ageMax: 27 }))), [1, 2, 3, 6],
    '19/25/27 in (27 is the boundary), 45 + 70 out, unknown passes');
  assert.deepEqual(ids(logic.applyDiscovery(ROSTER, D({ ageMin: 25, ageMax: 25 }))), [2, 6],
    'a single-age window keeps exactly that age');
});

test('logic: max 65 is open-ended — 65 and over all pass', () => {
  assert.deepEqual(ids(logic.applyDiscovery(ROSTER, D({ ageMin: 30, ageMax: 65 }))), [4, 5, 6],
    '45 and 70 in (70 rides the 65+ open end), under-30s out, unknown passes');
  assert.deepEqual(ids(logic.applyDiscovery(ROSTER, D({ ageMin: 18, ageMax: 64 }))), [1, 2, 3, 4, 6],
    'cap the max below 65 and the 70-year-old falls out');
});

test('logic: age null passes even the tightest window', () => {
  assert.deepEqual(ids(logic.applyDiscovery(ROSTER, D({ ageMin: 40, ageMax: 50 }))), [4, 6]);
});

test('logic: discActive lights up for an age-only filter, stays dark at full range', () => {
  assert.equal(logic.discActive(D({})), false, 'pure default view');
  assert.equal(logic.discActive(D({ ageMin: 21 })), true, 'raised min activates discovery (rail + crown hide)');
  assert.equal(logic.discActive(D({ ageMax: 40 })), true, 'lowered max activates discovery');
  assert.equal(logic.discActive({ q: '', online: false, live: false, price: 'any', tag: '', sort: 'top' }), false,
    'a state object with no age fields at all reads as full range');
});

/* ---------------- source pins ---------------- */

test('pins: Age pill sits in the filter row and shows its state', () => {
  const barBody = app.slice(app.indexOf('function discoveryBarHTML'), app.indexOf('function wireDiscovery'));
  assert.ok(barBody.includes('id="disc-age"'), 'the Age pill renders in the bar');
  assert.ok(barBody.indexOf('data-disc-toggle="online"') < barBody.indexOf('id="disc-age"'),
    'pill rides the chips row after the Online pill');
  assert.ok(barBody.indexOf('id="disc-age"') < barBody.indexOf('id="disc-tag"'),
    'pill sits before the tag dropdown in the same row');
  assert.ok(barBody.includes('🎂'), 'pill carries the cake marker');
  assert.ok(barBody.includes("t('disc_age_any')"), 'off state reads Any age from STR');
  assert.ok(barBody.includes("'65+'"), 'an open-ended max reads 65+');
});

test('pins: the sheet — dual slider, live readout, Save / Cancel / Any age', () => {
  assert.ok(app.includes('function openAgeSheet('), 'sheet opener exists');
  assert.ok(app.includes('id="age-min"') && app.includes('id="age-max"'), 'two thumbs, one per bound');
  assert.ok(app.includes('id="age-readout"'), 'live readout element');
  assert.ok(app.includes('id="age-save"') && app.includes('id="age-cancel"') && app.includes('id="age-any"'),
    'Save / Cancel / Any-age buttons');
  assert.ok(app.includes("t('disc_age_pref')"), 'sheet title comes from STR');
  assert.ok(app.includes("t('disc_age_save')") && app.includes("t('cancel')"), 'buttons come from STR');
});

test('pins: persistence — saved on commit, loaded at boot, reset by Clear filters', () => {
  assert.ok(app.includes("const AGE_PREF_KEY = 'sc_age_pref'"), 'one storage key');
  assert.ok(app.includes('localStorage.setItem(AGE_PREF_KEY'), 'the choice is written');
  assert.ok(app.includes('localStorage.getItem(AGE_PREF_KEY'), 'the choice is read back at boot');
  const wireBody = app.slice(app.indexOf('function wireDiscovery'), app.indexOf('function homeTilesHTML'));
  assert.ok(wireBody.includes("$('#disc-age')"), 'the pill is wired in both directory views');
  assert.ok(wireBody.includes('openAgeSheet('), 'tapping the pill opens the sheet');
  assert.ok(wireBody.includes('disc.ageMin = 18; disc.ageMax = 65; saveAgePref();'),
    'Clear filters returns the age range to full and persists it');
});

test('pins: STR keys in all 13 languages, non-empty; slider CSS exists', () => {
  for (const key of ['disc_age_pref', 'disc_age_any', 'disc_age_save']) {
    const hits = app.match(new RegExp(`${key}: '((?:[^'\\\\]|\\\\.)*)'`, 'g')) || [];
    assert.equal(hits.length, 13, `${key} exists in all 13 tables`);
    for (const h of hits) {
      const v = h.slice(h.indexOf("'") + 1, -1);
      assert.ok(v.trim().length > 0, `${key} is never empty`);
    }
  }
  assert.ok(css.includes('.age-dual') && css.includes('.age-fill') && css.includes('.age-track'),
    'dual-slider styles exist');
  assert.ok(css.includes('.age-sheet-btns'), 'sheet button row styled');
});

test('pins: her age is never rendered — the only model-age reads in app.js are the filter', () => {
  const reads = app.match(/\bm\.age\b/g) || [];
  assert.equal(reads.length, 3, 'applyDiscovery reads m.age (null test + both bounds) — no renderer may');
  const tStart = app.indexOf('function modelTileHTML');
  const tileBody = app.slice(tStart, app.indexOf('\nfunction ', tStart));
  assert.ok(!/\bm\.age\b/.test(tileBody), 'tiles never read her age');
  assert.ok(server.includes('age: ageFromDob(dobRaw)'), 'server ships the computed age');
  assert.ok(server.includes('dob: dobRaw'), 'server destructures dob OUT of the payload');
  assert.ok(server.includes('function ageFromDob(dob)'), 'the age derivation exists server-side');
});
