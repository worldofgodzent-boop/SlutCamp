'use strict';
/*
 * Model-home section filter — the leak + the missing tabs (owner
 * ruling, Oct 19 2026).
 *
 * WHAT HAPPENED: Phase 1 shipped with a deliberate exemption —
 * effectiveBrowseSet() returned null for model/admin viewers, so a
 * model browsing her home directory got the UNFILTERED roster. On
 * Oct 19 2026 the owner, signed in as the house MODEL account, found
 * a male-section model (Shane, @cjlongdick#31, explicit photo) at #3
 * on his front page and again as the first card of the "New models
 * you may like" rail — even though Shane's section was 'male' and
 * guests/fans never saw him. The client even SENT ?tab=female (api()
 * appends browseTab for every viewer); the server ignored it for his
 * role. His words: "I don't want males on my store front" + "I don't
 * see sections" (the model home also never rendered the tab strip).
 *
 * THE RULE NOW (supersedes the Phase 1 exemption):
 *   - /api/models, /api/live and /api/live/schedule apply the SAME
 *     tab filter for EVERY viewer — guest, fan, model, app-side
 *     admin token. Default (no/invalid tab) = the Female set
 *     {female, couple}; solo males appear only behind an explicit
 *     Male/All tab. The New Models rail is a pure client-side slice
 *     of the /api/models payload, so the filtered payload IS the
 *     rail's data — no male can headline it by default.
 *   - Discovery (search / sort / Online / Live / price / tags) is
 *     likewise a client-side filter over that same payload, so the
 *     section filter composes first, exactly as on the fan home.
 *   - The model home (vFanModels — ONE renderer shared with the fan
 *     home) renders the SAME section strip and wires it for model
 *     viewers too: lands on Female per entry, taps re-filter in
 *     place.
 *   - The ONLY unfiltered roster left is the Manager's /api/admin/*
 *     surface (X-Manager + admin role) — untouched by this fix.
 *
 * Static source pins + a functional boot, same harness shape as
 * tests/storefront-sections.test.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const REPO = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(REPO, 'public/js/app.js'), 'utf8');
const serverSrc = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');

function sliceFn(src, startMarker, endMarker) {
  const s = src.indexOf(startMarker);
  const e = src.indexOf(endMarker, s);
  assert.ok(s !== -1 && e > s, `located ${startMarker} … ${endMarker}`);
  return src.slice(s, e);
}

/* --------------------------- static pins: server --------------------------- */

test('server: effectiveBrowseSet has NO role exemption — every viewer is tab-filtered', () => {
  const eff = sliceFn(serverSrc, 'function effectiveBrowseSet', '\n}\n');
  assert.ok(!eff.includes('return null'), 'no null (unfiltered) return remains');
  assert.ok(!eff.includes('viewerRoleOf'), 'the helper no longer inspects the viewer role');
  assert.ok(!eff.includes("role === 'admin'") && !eff.includes("role === 'model'"), 'no admin/model carve-out');
  assert.ok(eff.includes('req.query.tab'), 'the tab still comes from the request');
  assert.ok(eff.includes('DEFAULT_BROWSE_SET'), 'no/invalid tab still falls back to the Female set');
  // All three public directory surfaces still route through the helper.
  const models = sliceFn(serverSrc, "app.get('/api/models',", '// Fan likes/unlikes a model');
  assert.ok(models.includes('const bset = effectiveBrowseSet(req);'), 'directory uses the (now universal) set');
  const live = sliceFn(serverSrc, "app.get('/api/live',", '// Fan joins as a free viewer');
  assert.ok(live.includes('const bset = effectiveBrowseSet(req);'), 'lives use the same set');
  const sched = sliceFn(serverSrc, "app.get('/api/live/schedule',", "app.get('/api/live/:id'");
  assert.ok(sched.includes('const bsetS = effectiveBrowseSet(req);'), 'schedule uses the same set');
  // The Manager roster stays its own handler — untouched, unfiltered.
  assert.ok(serverSrc.includes("app.get('/api/admin/models', ...adminOnly"), 'Manager roster handler intact');
});

/* --------------------------- static pins: client --------------------------- */

test('client: the model home renders AND wires the section strip (shared vFanModels renderer)', () => {
  const home = sliceFn(appSrc, 'async function vFanModels()', 'async function vFanLive()');
  assert.ok(home.includes('${sectionTabsHTML()}'), 'home renders the strip unconditionally');
  assert.ok(!home.includes("isModelViewer ? '' : sectionTabsHTML()"), 'the model-viewer suppression is GONE');
  assert.ok(home.includes("wireSectionTabs(() => show('fanModels', {}))"), 'the strip is wired to re-render the home');
  assert.ok(!home.includes('if (!isModelViewer) wireSectionTabs'), 'wiring is no longer fan-only');
  // The strip lands on Female per entry for every viewer (shared state).
  assert.ok(appSrc.includes("let browseTab = 'female';"), 'tab state starts at female — every visit, every viewer');
  // Directory reads carry the tab for every viewer (one mechanism).
  const apiFn = sliceFn(appSrc, 'async function api(path, opts)', '\n}\n');
  assert.ok(apiFn.includes("path === '/models' || path === '/live' || path === '/live/schedule'"), 'tab rides all three directory reads');
  assert.ok(apiFn.includes("path += '?tab=' + browseTab;"), 'tab passed as ?tab=');
});

test('client: the New Models rail + Discovery are slices of the /api/models payload (no side channel)', () => {
  const home = sliceFn(appSrc, 'async function vFanModels()', 'async function vFanLive()');
  assert.ok(home.includes("await api('/models')"), 'home fetches the directory once');
  assert.ok(home.includes('newModelsRailHTML(models, heartFor)'), 'the rail renders from that same payload');
  assert.ok(home.includes('applyDiscovery(models, disc)'), 'Discovery filters that same payload');
  const rail = sliceFn(appSrc, 'function newModelsRail(models', 'function newModelsRailHTML');
  assert.ok(!rail.includes('api(') && !rail.includes('fetch('), 'rail windowing is pure — no fetch of its own');
  const railHTML = sliceFn(appSrc, 'function newModelsRailHTML(models', 'function discoveryBarHTML');
  assert.ok(!railHTML.includes('api(') && !railHTML.includes('fetch('), 'rail HTML is pure — no fetch of its own');
});

/* --------------------------- functional boot --------------------------- */

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
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
  const h = { ...(headers || {}) };
  if (body !== undefined) h['content-type'] = 'application/json';
  if (token) h.authorization = 'Bearer ' + token;
  const r = await fetch(base + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
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
const login = async (base, username, password) =>
  (await req(base, 'POST', '/api/auth/login', { body: { username, password } })).json.token;

test('live: a MODEL viewer’s home payload is tab-filtered — grid, rail window, lives, schedule; Manager roster stays unfiltered', { timeout: 300000 }, async () => {
  const dir = makeCopy('modelhome');
  let h = null;
  try {
    h = await boot(dir, { SEED_DEMO: '1' });
    assert.equal((await signupModel(h.base, 'mhguy', 'MH Guy', { section: 'male' })).status, 200, 'male model joins');
    assert.equal((await signupModel(h.base, 'mhgal', 'MH Gal', { section: 'female' })).status, 200, 'female model joins');
    assert.equal((await signupModel(h.base, 'mhcpl', 'MH Couple', { section: 'couple' })).status, 200, 'couple joins');
    // His profile photo (the screenshot showed his photo on the grid).
    const pdb = openDb(dir, false);
    pdb.prepare("UPDATE models SET photo_url = '/uploads/mh-guy.jpg' WHERE user_id = (SELECT id FROM users WHERE username = 'mhguy')").run();
    pdb.close();

    const modelTok = await login(h.base, 'mhgal', 'hunter22');
    const seedModelTok = await login(h.base, 'bunny', 'model123');
    const adminTok = await login(h.base, 'admin', 'admin123');
    const fanTok = await login(h.base, 'fandemo', 'fan123');
    assert.ok(modelTok && seedModelTok && adminTok && fanTok, 'all viewer logins up');

    const roster = async (p, token) => {
      const r = await req(h.base, 'GET', p, token ? { token } : {});
      assert.equal(r.status, 200, `GET ${p}: ${r.text.slice(0, 120)}`);
      return r.json;
    };
    const names = (j) => j.models.map((m) => m.username);
    const sectionsOf = (j) => [...new Set(j.models.map((m) => m.section))].sort();

    // — THE MODEL-HOME REQUEST, exactly as vFanModels issues it:
    // api('/models') with browseTab at its 'female' entry value and
    // the model's own Bearer token. This payload feeds BOTH the
    // ranked grid and the New Models rail.
    let j = await roster('/api/models?tab=female', modelTok);
    assert.ok(!names(j).includes('mhguy'), 'MODEL HOME INVARIANT: the male model is NOT in the model viewer’s default payload');
    assert.ok(!sectionsOf(j).includes('male'), 'model viewer default payload carries zero male-section rows');
    assert.deepEqual(sectionsOf(j), ['couple', 'female'], 'model viewer default = the Female set, same as a fan');
    assert.ok(names(j).includes('mhgal') && names(j).includes('mhcpl'), 'female + couple models still show on her home');
    // The rail window (created within 14 days — every account here is
    // brand-new, mhguy included): the rail slices THIS payload, so if
    // he were in it he would headline the rail. He is not in it.
    const railFresh = j.models.filter((m) => (Date.now() - Date.parse(String(m.created_at).replace(' ', 'T') + 'Z')) < 14 * 24 * 3600 * 1000);
    assert.ok(railFresh.length > 0, 'rail window is non-empty in this fixture');
    assert.ok(!railFresh.some((m) => m.section === 'male'), 'RAIL INVARIANT: no male-section card can appear in the New Models rail by default');
    // A seed model (bunny) browsing her home: same clean payload.
    j = await roster('/api/models?tab=female', seedModelTok);
    assert.ok(!names(j).includes('mhguy'), 'seed model viewer: default payload clean too');
    // No tab at all (and a bogus tab) fall back to the Female set.
    j = await roster('/api/models', modelTok);
    assert.ok(!names(j).includes('mhguy'), 'model viewer, no tab: Female set — zero solo males');
    j = await roster('/api/models?tab=bogus', modelTok);
    assert.ok(!names(j).includes('mhguy'), 'model viewer, bogus tab: falls back to the Female set');
    // Her EXPLICIT taps still work — the sections are hers to browse.
    j = await roster('/api/models?tab=male', modelTok);
    assert.ok(names(j).includes('mhguy') && names(j).includes('mhcpl'), 'model viewer behind Male: male + couple');
    assert.ok(!names(j).includes('mhgal'), 'model viewer behind Male: no solo females');
    j = await roster('/api/models?tab=couples', modelTok);
    assert.deepEqual(sectionsOf(j), ['couple'], 'model viewer behind Couples: couples only');
    j = await roster('/api/models?tab=all', modelTok);
    assert.deepEqual(sectionsOf(j), ['couple', 'female', 'male'], 'model viewer behind All: everything');
    // The payload carries his photo only behind those explicit tabs —
    // the default payload never even ships the photo URL.
    j = await roster('/api/models?tab=female', modelTok);
    assert.ok(!JSON.stringify(j).includes('mh-guy.jpg'), 'default payload does not carry the male model’s photo anywhere');

    // — App-side ADMIN token on the public directory: filtered too.
    j = await roster('/api/models', adminTok);
    assert.deepEqual(sectionsOf(j), ['couple', 'female'], 'app-side admin token, no tab: the Female set');
    j = await roster('/api/models?tab=all', adminTok);
    assert.deepEqual(sectionsOf(j), ['couple', 'female', 'male'], 'app-side admin token behind All: everything');

    // — Fan + guest behavior UNCHANGED.
    j = await roster('/api/models', fanTok);
    assert.ok(!names(j).includes('mhguy'), 'fan default: still zero solo males');
    j = await roster('/api/models?tab=male', fanTok);
    assert.ok(names(j).includes('mhguy'), 'fan behind Male: still sees him');
    j = await roster('/api/models');
    assert.ok(!names(j).includes('mhguy'), 'guest default: still zero solo males');

    // — The MANAGER roster (X-Manager + admin) stays unfiltered.
    const mgr = await req(h.base, 'GET', '/api/admin/models', { token: adminTok, headers: { 'x-manager': '1' } });
    assert.equal(mgr.status, 200, `Manager roster serves: ${mgr.text.slice(0, 120)}`);
    assert.ok((mgr.json.models || []).some((m) => m.username === 'mhguy'), 'Manager roster still lists the male model (unfiltered by design)');

    // — Lives: same filter for a model viewer.
    const vdb = openDb(dir, false);
    for (const u of ['mhgal', 'mhguy']) {
      const uid = vdb.prepare('SELECT id FROM users WHERE username = ?').get(u).id;
      vdb.prepare("INSERT INTO id_verifications (model_id, status) VALUES (?, 'approved')").run(uid);
    }
    vdb.close();
    const guyTok = await login(h.base, 'mhguy', 'hunter22');
    // Release Prompt (Oct 22 2026): both models agree to the WOGENT
    // release at the door before going live.
    assert.equal((await req(h.base, 'POST', '/api/model/release/agree', { body: {}, token: guyTok })).status, 200, 'male model agrees to the release');
    assert.equal((await req(h.base, 'POST', '/api/model/release/agree', { body: {}, token: modelTok })).status, 200, 'female model agrees to the release');
    assert.equal((await req(h.base, 'POST', '/api/live/start', { body: { title: 'Guy live' }, token: guyTok })).status, 200, 'male model goes live');
    assert.equal((await req(h.base, 'POST', '/api/live/start', { body: { title: 'Gal live' }, token: modelTok })).status, 200, 'female model goes live');
    const liveNames = async (p, token) => (await roster(p, token)).live.map((l) => l.model_name).sort();
    assert.deepEqual(await liveNames('/api/live', modelTok), ['MH Gal'], 'model viewer, lives no tab: only her show — his is filtered');
    assert.deepEqual(await liveNames('/api/live?tab=male', modelTok), ['MH Guy'], 'model viewer, lives behind Male: his show');
    assert.deepEqual(await liveNames('/api/live?tab=all', modelTok), ['MH Gal', 'MH Guy'], 'model viewer, lives behind All: both');
    assert.deepEqual(await liveNames('/api/live'), ['MH Gal'], 'guest lives default unchanged');
    stop(h); h = null;

    // — Schedule: seed weekly slots for the male + couple models.
    const wdb = openDb(dir, false);
    const idOf = (u) => wdb.prepare('SELECT id FROM users WHERE username = ?').get(u).id;
    for (const u of ['mhguy', 'mhcpl']) {
      for (let d = 0; d < 7; d++) {
        wdb.prepare('INSERT INTO live_schedule (model_id, day_of_week, start_time, title) VALUES (?,?,?,?)').run(idOf(u), d, '23:59', 'Late show');
        wdb.prepare('INSERT INTO live_schedule (model_id, day_of_week, start_time, title) VALUES (?,?,?,?)').run(idOf(u), d, '00:01', 'Early show');
      }
    }
    wdb.close();
    h = await boot(dir, { SEED_DEMO: '1' });
    const modelTok2 = await login(h.base, 'mhgal', 'hunter22');
    const schedNames = async (p, token) => [...new Set((await roster(p, token)).upcoming.map((u) => u.model_name))].sort();
    assert.deepEqual(await schedNames('/api/live/schedule', modelTok2), ['MH Couple'], 'model viewer, schedule no tab: the couple’s slots, never the male’s');
    assert.deepEqual(await schedNames('/api/live/schedule?tab=male', modelTok2), ['MH Couple', 'MH Guy'], 'model viewer, schedule behind Male: both');
    assert.deepEqual(await schedNames('/api/live/schedule?tab=all', modelTok2), ['MH Couple', 'MH Guy'], 'model viewer, schedule behind All: both');
    stop(h); h = null;
  } finally {
    stop(h);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
