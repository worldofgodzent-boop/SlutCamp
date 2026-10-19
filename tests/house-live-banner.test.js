'use strict';
/*
 * House-live banner + house exemptions + Manager section switcher
 * (owner rulings, Oct 18 2026, on top of the storefront-sections
 * build):
 *
 *  1. BANNER: fans and guests see the HOUSE account's schedule
 *     broadcast at the head of the app — GET /api/live/schedule now
 *     carries a `house` field { next, live_session_id } computed for
 *     the house account ONLY, from the unfiltered upcoming list (the
 *     house is the platform; section tabs never filter it out).
 *     Client renders it on fan home, the guest landing and the Live
 *     tab from that one field; no slot + not live → no banner.
 *  2. EXEMPTIONS: "The SlutCamp live is exempt from all that" +
 *     "We don't need that in my SlutCamp login" — isIdVerified()
 *     returns true for the house account at the single point every
 *     caller consults (live/start today, anything tomorrow), and the
 *     ID Verification card never renders in the house's own Settings
 *     (server-driven `house` flag on GET /api/model/id-verification).
 *     Real models keep the full gate: unverified → 403 at live/start.
 *  3. SECTION SWITCHER: PATCH /api/admin/models/:id/section (admin
 *     only, enum-validated) + one-tap Female | Male | Couple buttons
 *     on each Manager model card — "in case one slips through the
 *     cracks". The switch is real: fan tab payloads move her.
 *
 * Static source pins (suite convention) + functional boots.
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
const appSrc = fs.readFileSync(path.join(REPO, 'public/js/app.js'), 'utf8');
const serverSrc = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
const managerSrc = fs.readFileSync(path.join(REPO, 'public/manager/manager.js'), 'utf8');
const cssSrc = fs.readFileSync(path.join(REPO, 'public/css/styles.css'), 'utf8');

const LANG13 = ['en', 'es', 'pt', 'fr', 'de', 'ru', 'ja', 'zh', 'ko', 'it', 'pl', 'nl', 'tr'];

/* Brace-matching extractor (same approach as the other suites). */
function literalSpan(src, marker) {
  const i = src.indexOf(marker);
  assert.ok(i >= 0, 'marker found: ' + marker);
  let j = src.indexOf('{', i), depth = 0, k = j, inStr = null, esc = false, inTpl = false, td = 0;
  for (; k < src.length; k++) {
    const c = src[k];
    if (inTpl) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '$' && src[k + 1] === '{') { td++; k++; continue; }
      if (c === '}' && td > 0) { td--; continue; }
      if (c === '`' && td === 0) inTpl = false;
      continue;
    }
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '`') { inTpl = true; continue; }
    if (c === "'" || c === '"') { inStr = c; continue; }
    if (c === '{') depth++;
    if (c === '}') { depth--; if (depth === 0) return [j, k + 1]; }
  }
  throw new Error('unbalanced: ' + marker);
}
function evalConst(src, marker) {
  const [s, e] = literalSpan(src, marker);
  const name = marker.replace('const ', '').replace(' =', '').trim();
  const sb = {};
  vm.createContext(sb);
  vm.runInContext(marker + ' ' + src.slice(s, e) + `;\nthis.__v = ${name};`, sb);
  return sb.__v;
}
function sliceFn(src, startMarker, endMarker) {
  const s = src.indexOf(startMarker);
  const e = src.indexOf(endMarker, s);
  assert.ok(s !== -1 && e > s, `located ${startMarker} … ${endMarker}`);
  return src.slice(s, e);
}

/* --------------------------- static pins --------------------------- */

test('server: isIdVerified exempts the house account at the single point', () => {
  const fn = sliceFn(serverSrc, 'function isIdVerified(modelUserId)', '\n}\n');
  assert.ok(fn.includes('if (isHouseAccountId(modelUserId)) return true;'),
    'house accounts count as verified with no id_verifications row');
  assert.ok(fn.indexOf('isHouseAccountId(modelUserId)') < fn.indexOf('id_verifications'),
    'the exemption short-circuits before the DB lookup');
});

test('server: id-verification status carries the house flag + verified for the house', () => {
  const route = sliceFn(serverSrc, "app.get('/api/model/id-verification'", "app.post('/api/model/id-verification'");
  assert.ok(route.includes('house: isHouseAccountId(req.user.id)'), 'house flag is server truth, not a client username literal');
  assert.ok(route.includes('verified: isIdVerified(req.user.id)'), 'verified still flows from isIdVerified');
});

test('server: /live/schedule carries the house block, computed unfiltered', () => {
  const route = sliceFn(serverSrc, "app.get('/api/live/schedule', (req, res) => {\n  const TZ", "app.get('/api/live/:id'");
  assert.ok(route.includes('const house = { next: null, live_session_id: null };'), 'house block shape');
  assert.ok(route.includes('upcoming.find((u) => u.model_id === hidS)'),
    'next slot comes from the UNFILTERED upcoming list — section tabs cannot hide the house');
  assert.ok(route.includes("WHERE model_id = ? AND status = 'live'"), 'live session lookup for the house');
  assert.ok(route.includes('res.json({ upcoming: visUpcoming.slice(0, 20), house });'), 'house rides the response');
});

test('server: section switch endpoint — admin-only, enum-validated, writes models.section', () => {
  const route = sliceFn(serverSrc, "app.patch('/api/admin/models/:id/section'", '\n});');
  assert.ok(route.includes('...adminOnly'), 'same auth as the other /api/admin/models routes');
  assert.ok(route.includes('MODEL_SECTIONS.includes(section)'), 'validated against the section enum');
  assert.ok(route.includes("res.status(400).json({ error: 'bad_section'"), 'anything else → 400');
  assert.ok(route.includes("db.prepare('UPDATE models SET section = ? WHERE user_id = ?').run(section, req.params.id);"),
    'updates her model row');
  assert.ok(route.includes('res.json({ ok: true, section });'), 'happy-path shape');
  const list = sliceFn(serverSrc, "app.get('/api/admin/models', ...adminOnly", '\n});');
  assert.ok(list.includes('m.section'), 'the Manager models payload carries her current section');
});

test('client: banner copy keys exist in all 13 language tables', () => {
  const I18N = evalConst(appSrc, 'const I18N =');
  for (const lang of LANG13) {
    assert.ok(I18N[lang], `language table ${lang} exists`);
    assert.ok(typeof I18N[lang].house_next_live === 'string' && I18N[lang].house_next_live.length > 0,
      `${lang}: house_next_live`);
    assert.ok(typeof I18N[lang].house_live_now === 'string' && I18N[lang].house_live_now.length > 0,
      `${lang}: house_live_now`);
    for (const ph of ['{title}', '{day}', '{time}', '{countdown}']) {
      assert.ok(I18N[lang].house_next_live.includes(ph), `${lang}: house_next_live carries ${ph}`);
    }
  }
  assert.ok(I18N.en.house_next_live.startsWith('📅 SlutCamp Live'), 'EN upcoming copy');
  assert.ok(I18N.en.house_live_now.startsWith('🔴 SlutCamp is LIVE now'), 'EN live copy');
});

test('client: banner renders from the house field on fan home, landing and the Live tab', () => {
  const helper = sliceFn(appSrc, 'function houseBannerHTML(house)', 'function wireHouseBanner()');
  assert.ok(helper.includes('house.live_session_id'), 'live state wins the banner');
  assert.ok(helper.includes('house.next'), 'next slot renders when not live');
  assert.ok(helper.includes("t('house_live_now')"), 'live copy via STR');
  assert.ok(helper.includes("t('house_next_live'"), 'upcoming copy via STR');
  assert.ok(helper.includes('bookingCountdown(n.starts_at)'), 'countdown in the existing style');
  assert.ok(helper.includes("return '';"), 'no slot + not live → no banner');
  const wire = sliceFn(appSrc, 'function wireHouseBanner()', '\n}\n');
  assert.ok(wire.includes('watchLive(parseInt(lb.dataset.houseLive))'), 'live banner tap enters the stream');
  for (const view of ['async function vLanding()', 'async function vFanModels()', 'async function vFanLive()']) {
    const body = sliceFn(appSrc, view, '\n}\n\n');
    assert.ok(body.includes('houseBannerHTML(house)'), `${view} renders the banner`);
  }
  assert.ok(cssSrc.includes('.house-banner'), 'banner styles exist');
  assert.ok(cssSrc.includes('.house-banner.live'), 'live banner variant exists');
});

test('client: the house Settings hide the ID card on the server flag; real models keep it', () => {
  const settings = sliceFn(appSrc, 'async function vModelSettings()', 'async function renderTaxCard(containerId)');
  assert.ok(settings.includes('(idvData && idvData.house)'), 'hide driven by the server house flag');
  assert.ok(!appSrc.includes("username === 'asceaaspade'") && !appSrc.includes('username === HOUSE'),
    'no client-side username literal decides the hide');
  assert.ok(settings.includes('idv-submit') || appSrc.includes('idv-submit'),
    'the submit card still exists for real models');
});

test('manager: every model card carries one-tap Female | Male | Couple buttons wired to the endpoint', () => {
  for (const sec of ['female', 'male', 'couple']) {
    assert.ok(managerSrc.includes(`data-m-section="\${m.id}" data-section="${sec}"`), `${sec} button on the card`);
  }
  assert.ok(managerSrc.includes("m.section === 'male'") && managerSrc.includes("m.section === 'couple'"),
    'the current section is the visually marked one');
  const wire = sliceFn(managerSrc, "document.querySelectorAll('[data-m-section]')", "document.querySelectorAll('[data-m-del]')");
  assert.ok(wire.includes('`/admin/models/${id}/section`'), 'buttons call the switch endpoint');
  assert.ok(wire.includes("method: 'PATCH'"), 'via PATCH');
});

/* --------------------------- functional boots --------------------------- */

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
function makeCopy(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `slutcamp-${tag}-`));
  for (const d of ['server.js', 'package.json', 'lib', 'public', 'data']) {
    fs.cpSync(path.join(REPO, d), path.join(dir, d), { recursive: true });
  }
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  return dir;
}
async function boot(dir, extraEnv = {}) {
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
async function req(base, method, p, { body, token, headers } = {}) {
  const hdrs = { ...(headers || {}) };
  if (body !== undefined) hdrs['content-type'] = 'application/json';
  if (token) hdrs.authorization = 'Bearer ' + token;
  const r = await fetch(base + p, {
    method, headers: hdrs, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
  return { status: r.status, text, json };
}
function openDb(dir, readOnly = true) {
  const __db = new DatabaseSync(path.join(dir, 'wogent-chat.db'), readOnly ? { readOnly: true } : {});
  __db.exec('PRAGMA busy_timeout = 10000');
  return __db;
}
const signupModel = (base, username, display, extra = {}) => req(base, 'POST', '/api/auth/signup', {
  body: { username, password: 'hunter22', role: 'model', display_name: display, dob: '1996-03-03', agree18: true, ...extra },
});
const login = async (base, username, password = 'hunter22') =>
  (await req(base, 'POST', '/api/auth/login', { body: { username, password } })).json.token;

test('live: house exemptions, banner states, and the Manager section switch', { timeout: 300000 }, async () => {
  const dir = makeCopy('housebanner');
  let h = null;
  try {
    h = await boot(dir, { SEED_DEMO: '1' });
    // The house account signs up under its exact production username;
    // a plain unverified model; a model the Manager will move; a fan.
    assert.equal((await signupModel(h.base, 'asceaaspade', 'SlutCamp', { section: 'female' })).status, 200);
    assert.equal((await signupModel(h.base, 'plainjane', 'Plain Jane', { section: 'female' })).status, 200);
    assert.equal((await signupModel(h.base, 'switchgal', 'Switch Gal', { section: 'female' })).status, 200);
    const fan = await req(h.base, 'POST', '/api/auth/signup', {
      body: { username: 'bannerfan', password: 'hunter22', role: 'fan', display_name: 'Banner Fan', dob: '1996-03-03', agree18: true },
    });
    assert.equal(fan.status, 200, `fan signup: ${fan.text}`);
    const houseTok = await login(h.base, 'asceaaspade');
    const janeTok = await login(h.base, 'plainjane');
    const fanTok = fan.json.token || await login(h.base, 'bannerfan');
    const adminTok = await login(h.base, 'admin', 'admin123');
    assert.ok(houseTok && janeTok && fanTok && adminTok, 'all logins issued');
    const MGR = { 'x-manager': '1' };

    // --- Feature 2: house ID status, no card, live without a row ---
    const houseDb = openDb(dir);
    const houseId = houseDb.prepare("SELECT id FROM users WHERE username = 'asceaaspade'").get().id;
    const janeId = houseDb.prepare("SELECT id FROM users WHERE username = 'plainjane'").get().id;
    const switchId = houseDb.prepare("SELECT id FROM users WHERE username = 'switchgal'").get().id;
    assert.equal(houseDb.prepare('SELECT COUNT(*) AS n FROM id_verifications WHERE model_id = ?').get(houseId).n, 0,
      'precondition: the house has NO id_verifications row');
    houseDb.close();

    const houseIdv = await req(h.base, 'GET', '/api/model/id-verification', { token: houseTok });
    assert.equal(houseIdv.status, 200, houseIdv.text);
    assert.equal(houseIdv.json.house, true, 'house flag set for the house account');
    assert.equal(houseIdv.json.verified, true, 'house counts as verified with no row');
    const janeIdv = await req(h.base, 'GET', '/api/model/id-verification', { token: janeTok });
    assert.equal(janeIdv.json.house, false, 'a real model is not flagged house');
    assert.equal(janeIdv.json.verified, false, 'a real unverified model reads unverified');

    const janeLive = await req(h.base, 'POST', '/api/live/start', { body: { title: 'Jane live' }, token: janeTok });
    assert.equal(janeLive.status, 403, `unverified real model still blocked: ${janeLive.text}`);
    assert.equal(janeLive.json.error, 'id_verification_required');
    const houseLive = await req(h.base, 'POST', '/api/live/start', { body: { title: 'House show' }, token: houseTok });
    assert.equal(houseLive.status, 200, `house goes live with no ID row: ${houseLive.text}`);
    const houseSid = houseLive.json.session_id;
    assert.ok(Number.isInteger(houseSid), 'house session id issued');

    // --- Feature 1: banner states on /api/live/schedule ---
    const schedLive = await req(h.base, 'GET', '/api/live/schedule');
    assert.equal(schedLive.status, 200, schedLive.text);
    assert.ok(schedLive.json.house, 'house block present for a guest');
    assert.equal(schedLive.json.house.live_session_id, houseSid, 'house live → live_session_id set');
    assert.equal(schedLive.json.house.next, null, 'no slot seeded yet → next is null');
    const end = await req(h.base, 'POST', `/api/live/${houseSid}/end`, { body: {}, token: houseTok });
    assert.equal(end.status, 200, end.text);
    const schedIdle = await req(h.base, 'GET', '/api/live/schedule');
    assert.equal(schedIdle.json.house.live_session_id, null, 'live ended → live_session_id back to null');
    assert.equal(schedIdle.json.house.next, null, 'still no slot → next stays null (no banner)');

    // --- Feature 3: the Manager section switcher ---
    const sw = (method, p, opts) => req(h.base, method, p, opts);
    const noAuth = await sw('PATCH', `/api/admin/models/${switchId}/section`, { body: { section: 'male' }, headers: MGR });
    assert.equal(noAuth.status, 401, `no token → 401: ${noAuth.text}`);
    const fanTry = await sw('PATCH', `/api/admin/models/${switchId}/section`, { body: { section: 'male' }, token: fanTok, headers: MGR });
    assert.equal(fanTry.status, 403, `fan token → 403: ${fanTry.text}`);
    const noMgr = await sw('PATCH', `/api/admin/models/${switchId}/section`, { body: { section: 'male' }, token: adminTok });
    assert.equal(noMgr.status, 403, `admin without X-Manager → 403: ${noMgr.text}`);
    const badSec = await sw('PATCH', `/api/admin/models/${switchId}/section`, { body: { section: 'bogus' }, token: adminTok, headers: MGR });
    assert.equal(badSec.status, 400, `invalid section → 400: ${badSec.text}`);
    assert.equal(badSec.json.error, 'bad_section');
    const missing = await sw('PATCH', '/api/admin/models/999999/section', { body: { section: 'male' }, token: adminTok, headers: MGR });
    assert.equal(missing.status, 404, 'unknown model → 404');

    const rosterNames = async (p) => (await req(h.base, 'GET', p, { token: fanTok })).json.models.map((m) => m.username);
    assert.ok((await rosterNames('/api/models')).includes('switchgal'), 'before: she is on the default (Female) storefront');
    assert.ok(!(await rosterNames('/api/models?tab=male')).includes('switchgal'), 'before: she is not behind the Male tab');
    const moved = await sw('PATCH', `/api/admin/models/${switchId}/section`, { body: { section: 'male' }, token: adminTok, headers: MGR });
    assert.equal(moved.status, 200, `switch succeeds: ${moved.text}`);
    assert.deepEqual(moved.json, { ok: true, section: 'male' });
    assert.ok(!(await rosterNames('/api/models')).includes('switchgal'), 'after: gone from the default storefront');
    assert.ok((await rosterNames('/api/models?tab=male')).includes('switchgal'), 'after: she is behind the Male tab');
    const adminList = await req(h.base, 'GET', '/api/admin/models', { token: adminTok, headers: MGR });
    const row = (adminList.json.models || []).find((m) => m.id === switchId);
    assert.ok(row, 'her Manager card row exists');
    assert.equal(row.section, 'male', 'the Manager payload reports her new section');
    stop(h); h = null;

    // --- Feature 1 (scheduled slot): seed weekly house slots, reboot ---
    const wdb = openDb(dir, false);
    for (let d = 0; d < 7; d++) {
      wdb.prepare('INSERT INTO live_schedule (model_id, day_of_week, start_time, title) VALUES (?,?,?,?)')
        .run(houseId, d, '23:59', 'House Party');
    }
    wdb.close();
    h = await boot(dir, { SEED_DEMO: '1' });
    const sched = await req(h.base, 'GET', '/api/live/schedule');
    assert.ok(sched.json.house.next, 'a seeded slot → house.next populated');
    assert.equal(sched.json.house.next.title, 'House Party');
    assert.ok(Number.isInteger(sched.json.house.next.starts_at) && sched.json.house.next.starts_at > Date.now(),
      'starts_at is a sane future timestamp');
    assert.ok(typeof sched.json.house.next.day_label === 'string' && sched.json.house.next.day_label.length > 0, 'day_label present');
    assert.ok(typeof sched.json.house.next.time_label === 'string' && sched.json.house.next.time_label.length > 0, 'time_label present');
    assert.equal(sched.json.house.live_session_id, null, 'not live → live_session_id null');
    // The house banner survives a Male-tab view even though the house
    // sits in the Female section — the house is never tab-filtered.
    const schedMale = await req(h.base, 'GET', '/api/live/schedule?tab=male');
    assert.ok(schedMale.json.house.next, 'house.next survives ?tab=male');
    assert.equal(schedMale.json.house.next.title, 'House Party');
    stop(h); h = null;
  } finally {
    stop(h);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
