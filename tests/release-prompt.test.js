'use strict';
/*
 * RELEASE PROMPT — SIGN AT THE DOOR (Asce approved Oct 22 2026, firm
 * version: "She shouldn't be able to make it in the app unless she
 * signs. It's that simple."). The WOGENT performer release joined
 * onboarding in PR #86, but every model approved BEFORE it (the
 * Manager's "Release: MISSING" roster) was grandfathered and never
 * asked. This build closes that gap:
 *
 *  - The door: /api/me flags a model with no release on file
 *    (release_missing); the client routes her to ONE screen — the
 *    release as an agreement update, full text, a single I Agree
 *    button, and Log out. No Later, no dismiss: she cannot enter or
 *    use the app until she agrees. While her own ID packet is
 *    PENDING the onboarding flow is her path and the flag stays off.
 *  - The tap: POST /api/model/release/agree records the acceptance
 *    as method 'clickwrap' — WHO (account + name on record), WHAT
 *    (text version R1.0), WHEN (signed_at), FROM WHERE (ip) — never
 *    dressed up as a signature, never in contract_signatures.
 *  - Defense in depth: live starts (public AND Private Room host
 *    starts, same endpoint) and every battle door (invite, schedule,
 *    pool, accept, rematch) refuse a missing-release model with
 *    403 release_required, even for a stale session that somehow
 *    reaches them. Lives already in progress are never cut.
 *  - House exempt (it is the Producer). Fans/recruiters/admins are
 *    never flagged. Onboarding e-sign/paper flows are untouched.
 *  - A one-time announcement (platform_stats stamp + SRV DM x13)
 *    tells every model the release update is required to continue
 *    using SlutCamp.
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
const serverSrc = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(REPO, 'public/js/app.js'), 'utf8');
const mgrSrc = fs.readFileSync(path.join(REPO, 'public/manager/manager.js'), 'utf8');

function sliceFn(src, startMarker, endMarker) {
  const s = src.indexOf(startMarker);
  const e = src.indexOf(endMarker, s + startMarker.length);
  assert.ok(s !== -1 && e > s, `located ${startMarker} … ${endMarker}`);
  return src.slice(s, e);
}
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
const SRV = evalConst(serverSrc, 'const SRV =');
const LANG13 = ['en', 'es', 'pt', 'fr', 'de', 'ru', 'ja', 'zh', 'ko', 'it', 'pl', 'nl', 'tr'];

/* --------------------------- static pins --------------------------- */

test('server: clickwrap is a first-class record method (DDL + verbatim rebuild migration)', () => {
  assert.ok(serverSrc.includes("method TEXT NOT NULL CHECK(method IN ('esign','paper','clickwrap'))"),
    'fresh databases allow the click-agree record');
  const mig = sliceFn(serverSrc, 'One-time migration (Release Prompt', '/* One-time migration (Oct 15, 2026)');
  assert.ok(mig.includes("!/'clickwrap'/.test(ddl.sql"), 'the rebuild runs only while the stored DDL lacks clickwrap');
  assert.ok(mig.includes('INSERT INTO model_releases_new') && mig.includes('FROM model_releases'),
    'existing records are copied verbatim into the rebuilt table');
  assert.ok(mig.includes('signed_at, ip'), 'timestamps and IPs survive the rebuild');
});

test('server: the one-click agree endpoint records an honest clickwrap acceptance', () => {
  const agree = sliceFn(serverSrc, "app.post('/api/model/release/agree'", '// Admin: list all ID verifications');
  assert.ok(agree.includes("VALUES (?, 'clickwrap'"), 'stored as a click-agree, never as a signature');
  assert.ok(agree.includes('WOGENT_RELEASE.version'), 'the exact text version agreed to is pinned');
  assert.ok(agree.includes('req.user.display_name'), 'the name on record comes from her account');
  assert.ok(agree.includes("x-forwarded-for") && agree.includes('ip.slice(0, 60)'), 'the source IP is stamped');
  assert.ok(agree.includes('click_agree: true'), 'the attestations JSON marks the click acceptance');
  assert.ok(agree.includes('if (prev) return res.json({ ok: true, already: true'), 'a second tap is an idempotent no-op');
  assert.ok(agree.includes("isHouseAccountId(req.user.id)"), 'the house is a no-op (it is the Producer)');
  assert.ok(!agree.includes('contract_signatures'), 'release records NEVER land in contract_signatures');
});

test('server: releasePromptNeeded — the door population, exactly', () => {
  const fn = sliceFn(serverSrc, 'function releasePromptNeeded(modelUserId)', '/* ------');
  assert.ok(fn.includes('if (isHouseAccountId(modelUserId)) return false;'), 'house exempt');
  assert.ok(fn.includes('if (modelReleaseRow(modelUserId)) return false;'), 'any record on file clears the door');
  assert.ok(fn.includes("v.status === 'pending') return false"), 'a pending packet keeps the onboarding path — the door never fights it');
});

test('server: /api/me flags only the model caller, on her own payload', () => {
  const me = sliceFn(serverSrc, "app.get('/api/me'", '/* --- Display name changes');
  assert.ok(me.includes('out.user.release_missing = releasePromptNeeded(req.user.id);'),
    'the flag rides her own /api/me user object');
  assert.ok(me.indexOf('out.user.release_missing') > me.indexOf("if (req.user.role === 'model')"),
    'set inside the model branch only');
});

test('server: live start refuses a missing release AFTER the ID check (public + Private Room share the endpoint)', () => {
  const start = sliceFn(serverSrc, "app.post('/api/live/start'", '// Fan leaves the live view');
  assert.ok(start.includes("error: 'release_required'"), 'the refusal is a named 403');
  assert.ok(start.includes("srv('release_required_live', userLang(req.user.id))"), 'the message is localized via SRV');
  assert.ok(start.indexOf("error: 'id_verification_required'") < start.indexOf("error: 'release_required'"),
    'ID first, release second — the refusal order never masks the ID gate');
  assert.ok(start.includes('if (!releaseOnFile(req.user.id))'), 'house exempt through releaseOnFile');
  assert.ok(!sliceFn(serverSrc, "app.post('/api/live/:id/end'", "app.get('/api/live/schedule'").includes('releaseOnFile'),
    'no release check on ending a live — an in-progress live is never cut by this build');
});

test('server: every battle door refuses a missing release; exits stay open', () => {
  const helper = sliceFn(serverSrc, 'function battleReleaseBlock(req, res)', 'function validBattleMinutes');
  assert.ok(helper.includes("error: 'release_required'"), 'the battle refusal is the same named 403');
  for (const route of ["app.post('/api/battles/invite'", "app.post('/api/battles/schedule'",
                       "app.post('/api/battles/pool/enter'"]) {
    const fn = sliceFn(serverSrc, route, "app.post('/api/battles");
    assert.ok(fn.includes('battleReleaseBlock(req, res)'), `${route} checks the release`);
    assert.ok(fn.indexOf('id_verification_required') < fn.indexOf('battleReleaseBlock'), `${route}: ID check precedes the release check`);
  }
  const accept = sliceFn(serverSrc, "app.post('/api/battles/:id/accept'", "app.post('/api/battles/:id/decline'");
  assert.ok(accept.includes('battleReleaseBlock(req, res)'), 'accepting a battle is entering as a performer — checked');
  const rematch = sliceFn(serverSrc, "app.post('/api/battles/:id/rematch'", "app.post('/api/battles/:id/remind'");
  assert.ok(rematch.includes('battleReleaseBlock(req, res)'), 'a rematch invite is a fresh entry — checked');
  const decline = sliceFn(serverSrc, "app.post('/api/battles/:id/decline'", "app.post('/api/battles/:id/cancel'");
  assert.ok(!decline.includes('battleReleaseBlock'), 'declining is never blocked — she can always walk away');
  const cancel = sliceFn(serverSrc, "app.post('/api/battles/:id/cancel'", '/* Scheduled showdown');
  assert.ok(!cancel.includes('battleReleaseBlock'), 'cancelling is never blocked');
});

test('server: the announcement — stamp, function, boot call, SRV copy x13', () => {
  assert.ok(serverSrc.includes("addColumnIfMissing('platform_stats', 'release_prompt_announced_at', 'TEXT')"),
    'the one-time stamp column exists');
  const fn = sliceFn(serverSrc, 'function announceReleasePromptToModels()', '/* ------');
  assert.ok(fn.includes("role = 'model'"), 'models only');
  assert.ok(fn.includes("srv('ann_release_prompt_dm', p.language)"), 'the DM is in her stored language');
  assert.ok(fn.includes("notifyUser(p.id, 'release_prompt'"), 'the bell rides along');
  assert.ok(serverSrc.includes('announceReleasePromptToModels();'), 'invoked at boot with the other announcements');
  for (const k of ['ann_release_prompt_dm', 'ann_release_prompt_bell_title', 'ann_release_prompt_bell_body', 'release_required_live']) {
    assert.ok(SRV[k], `SRV ${k} exists`);
    assert.deepEqual(Object.keys(SRV[k]).sort(), [...LANG13].sort(), `SRV ${k} covers all 13 languages`);
    for (const lang of LANG13) assert.ok(SRV[k][lang].trim().length > 0, `SRV ${k}:${lang} non-empty`);
  }
  assert.ok(SRV.ann_release_prompt_dm.en.includes('tap I Agree'), 'EN announcement names the one-tap action');
  assert.ok(SRV.ann_release_prompt_dm.en.includes('stays paused'), 'EN announcement says the app stays paused until she agrees');
});

test('client: the door — one screen, one tap, log out, NO way to dismiss it', () => {
  const gate = sliceFn(appSrc, 'async function vReleaseGate()', '/* Blur app content when backgrounded');
  assert.ok(gate.includes("api('/model/release')"), 'the full release text loads from the server (single source)');
  assert.ok(gate.includes("api('/model/release/agree'"), 'the one tap posts the agreement');
  assert.ok(gate.includes("$('#rel-gate-out').onclick = () => logout(false);"), 'log out is always reachable from the door');
  assert.ok(gate.includes("tabbar.classList.add('hidden')"), 'no tab bar behind the door');
  assert.ok(gate.includes('S.releaseSigned = true'), 'agreeing lifts the door for good');
  assert.ok(!gate.includes('release_dismiss') && !gate.includes('localStorage') && !gate.includes('sessionStorage'),
    'NO dismiss state of any kind — there is no Later');
  assert.ok(!/onclick[^>]*=.*remove\(\)/.test(gate.replace("$('#rel-gate-out').onclick = () => logout(false);", '')),
    'no self-removing close control besides log out');
  assert.ok(appSrc.includes('releaseGate: vReleaseGate'), 'the router knows the door view');
  const showFn = sliceFn(appSrc, 'function show(view, params)', 'S.view = view;');
  assert.ok(showFn.includes('S.releaseSigned === false') && showFn.includes("view = 'releaseGate'"),
    'show() routes flagged models to the door');
  assert.ok(showFn.includes("view !== 'releaseGate' && view !== 'modelContract'"),
    'the contract door and the release door queue in order, never trap each other');
  const refresh = sliceFn(appSrc, 'async function refreshMe()', 'function logout(');
  assert.ok(refresh.includes('S.releaseSigned = !data.user.release_missing'), 'the flag refreshes from /api/me on every bootstrap');
  assert.ok(appSrc.includes("go.onclick = () => show('releaseGate', {})"), 'the Settings banner entry opens the same door screen');
});

test('client: door strings exist in all 13 language tables', () => {
  for (const k of ['release_gate_h', 'release_gate_sub', 'release_gate_body',
                   'release_gate_agree', 'release_gate_out', 'release_gate_fail']) {
    const hits = appSrc.match(new RegExp(`${k}: '`, 'g')) || [];
    assert.equal(hits.length, 13, `${k} present once per language`);
  }
});

test('manager: ID Checks renders a clickwrap record as agreed-in-app, never MISSING', () => {
  assert.ok(mgrSrc.includes("r.release_method === 'clickwrap'"), 'the queue has a clickwrap branch');
  assert.ok(mgrSrc.includes('agreed in app'), 'the record reads as a one-tap agreement');
  assert.ok(mgrSrc.includes('Agreement record'), 'the reviewer can open the agreement record');
});

/* --------------------------- functional boot --------------------------- */

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
const PNG = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001080600000'
  + '01bc2f5d0000000d49444154789c6360000000020001e221bc330000000049454e44ae426082', 'hex');
async function uploadRaw(base, p, token, fd) {
  const headers = {};
  if (token) headers.authorization = 'Bearer ' + token;
  const r = await fetch(base + p, { method: 'POST', headers, body: fd });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
  return { status: r.status, text, json };
}
function idDocsUpload(base, token) {
  const fd = new FormData();
  for (const f of ['id_front', 'id_back', 'selfie'])
    fd.append(f, new Blob([PNG], { type: 'image/png' }), `${f}.png`);
  return uploadRaw(base, '/api/model/id-verification', token, fd);
}

test('live: flagged at the door, one tap agrees, live/battles/private rooms unlock', { timeout: 300000 }, async () => {
  const dir = makeCopy('relprompt');
  let h = null;
  try {
    h = await boot(dir, { SEED_DEMO: '1' });
    const base = h.base;
    const mgrLogin = await req(base, 'POST', '/api/manager/login', { body: { username: 'admin', password: 'admin123' } });
    assert.equal(mgrLogin.status, 200, `manager login: ${mgrLogin.text}`);
    const MGR = { token: mgrLogin.json.token, headers: { 'x-manager': '1' } };
    const adminApi = (method, p, opts = {}) => req(base, method, p, { ...opts, token: MGR.token, headers: MGR.headers });

    const signup = async (username, role) => {
      const s = await req(base, 'POST', '/api/auth/signup', {
        body: { username, password: 'hunter22', role, display_name: username,
          dob: '1995-05-05', agree18: true, ...(role === 'model' ? { section: 'female', publicity_consent: true } : {}) },
      });
      assert.equal(s.status, 200, `signup ${username}: ${s.text}`);
      return { token: s.json.token, id: s.json.user.id, username };
    };
    /* Grandfathered: ID approved directly in the DB — the exact
       pre-PR#86 production state (approved, no release row). */
    const grandfather = async (username) => {
      const acct = await signup(username, 'model');
      const up = await idDocsUpload(base, acct.token);
      assert.equal(up.status, 200, `ID upload ${username}: ${up.text}`);
      const db = openDb(dir, false);
      db.prepare("UPDATE id_verifications SET status = 'approved', reviewed_at = datetime('now') WHERE model_id = ? AND co_performer_id IS NULL")
        .run(acct.id);
      db.close();
      return acct;
    };
    /* Onboarded the PR #86 way: documents, e-sign, then approval. */
    const onboard = async (username) => {
      const acct = await signup(username, 'model');
      const up = await idDocsUpload(base, acct.token);
      assert.equal(up.status, 200, `ID upload ${username}: ${up.text}`);
      const sign = await req(base, 'POST', '/api/model/release/sign', { token: acct.token, body: {
        legal_name: 'Test Signer', stage_name: username, dob: '1995-05-05',
        attestations: { adult: true, freewill: true, rights: true } } });
      assert.equal(sign.status, 200, `e-sign ${username}: ${sign.text}`);
      const q = await adminApi('GET', '/api/admin/id-verifications');
      const row = q.json.verifications.find((v) => v.model_id === acct.id && !v.co_performer_id);
      const ap = await adminApi('POST', `/api/admin/id-verifications/${row.id}/approve`);
      assert.equal(ap.status, 200, `approve ${username}: ${ap.text}`);
      return acct;
    };
    const me = async (acct) => (await req(base, 'GET', '/api/me', { token: acct.token })).json;

    const G = await grandfather('doorgal');   // approved, NO release — the door population
    const H = await onboard('doorhost');      // release via onboarding — never flagged
    const J = await onboard('doorjudy');      // second onboarded model (battle partner)

    /* --- the flag population --- */
    assert.equal((await me(G)).user.release_missing, true, 'grandfathered model is flagged at bootstrap');
    assert.equal((await me(H)).user.release_missing, false, 'onboarding-signed model is never flagged');
    const fan = await signup('doorfan', 'fan');
    assert.equal((await me(fan)).user.release_missing, undefined, 'fans carry no flag');
    const docG = await req(base, 'GET', '/api/model/release', { token: G.token });
    assert.equal(docG.json.signed, false, 'her release state reads unsigned');

    /* --- every performing door refuses her --- */
    const liveBlock = await req(base, 'POST', '/api/live/start', { token: G.token, body: { title: 'door test' } });
    assert.equal(liveBlock.status, 403, `live start refused: ${liveBlock.text}`);
    assert.equal(liveBlock.json.error, 'release_required');
    assert.ok(typeof liveBlock.json.message === 'string' && liveBlock.json.message.length > 10, 'a clear localized message rides along');

    const invBlock = await req(base, 'POST', '/api/battles/invite', { token: G.token, body: { opponent_id: H.id, minutes: 5 } });
    assert.equal(invBlock.status, 403, `battle invite refused: ${invBlock.text}`);
    assert.equal(invBlock.json.error, 'release_required');

    const invH = await req(base, 'POST', '/api/battles/invite', { token: H.token, body: { opponent_id: G.id, minutes: 5 } });
    assert.equal(invH.status, 200, `signed model may invite her: ${invH.text}`);
    const accBlock = await req(base, 'POST', `/api/battles/${invH.json.battle.id}/accept`, { token: G.token });
    assert.equal(accBlock.status, 403, `battle accept refused: ${accBlock.text}`);
    assert.equal(accBlock.json.error, 'release_required');
    const decline = await req(base, 'POST', `/api/battles/${invH.json.battle.id}/decline`, { token: G.token });
    assert.equal(decline.status, 200, 'declining is never blocked — she can always walk away');

    const poolBlock = await req(base, 'POST', '/api/battles/pool/enter', { token: G.token, body: {} });
    assert.equal(poolBlock.status, 403, `battle pool refused: ${poolBlock.text}`);
    assert.equal(poolBlock.json.error, 'release_required');

    const ev = await req(base, 'POST', '/api/model/private-events', { token: G.token, body: {
      title: 'Door Room', starts_at: new Date(Date.now() + 3 * 86400000).toISOString(), seats: 2, seat_price_cents: 1000 } });
    assert.equal(ev.status, 200, `event creation (ID-only gate) still works: ${ev.text}`);
    const privBlock = await req(base, 'POST', '/api/live/start', { token: G.token, body: { private_event_id: ev.json.event.id } });
    assert.equal(privBlock.status, 403, `private room host start refused: ${privBlock.text}`);
    assert.equal(privBlock.json.error, 'release_required');

    /* --- ONE TAP --- */
    const agree = await req(base, 'POST', '/api/model/release/agree', { token: G.token, body: {} });
    assert.equal(agree.status, 200, `agree: ${agree.text}`);
    assert.equal(agree.json.ok, true);
    assert.equal(agree.json.release.method, 'clickwrap');
    assert.equal(agree.json.release.version, 'R1.0');
    {
      const db = openDb(dir);
      const r = db.prepare('SELECT * FROM model_releases WHERE model_id = ?').get(G.id);
      assert.ok(r, 'the acceptance is recorded');
      assert.equal(r.method, 'clickwrap');
      assert.equal(r.release_version, 'R1.0', 'the exact text version agreed to is pinned');
      assert.equal(r.legal_name, 'doorgal', 'the name on record is her account name');
      assert.ok(r.signed_at, 'a timestamp is stamped');
      assert.ok(r.ip && r.ip.length > 0, 'the source IP is stamped');
      assert.deepEqual(JSON.parse(r.attestations), { click_agree: true, text_version: 'R1.0' });
      const poison = db.prepare("SELECT COUNT(*) AS n FROM contract_signatures WHERE user_id = ? AND contract_version LIKE 'R%'").get(G.id);
      assert.equal(poison.n, 0, 'no release record ever lands in contract_signatures');
      db.close();
    }
    const again = await req(base, 'POST', '/api/model/release/agree', { token: G.token, body: {} });
    assert.equal(again.status, 200, 'a second tap still succeeds');
    assert.equal(again.json.already, true, '...as an idempotent no-op');
    {
      const db = openDb(dir);
      const n = db.prepare('SELECT COUNT(*) AS n FROM model_releases WHERE model_id = ?').get(G.id);
      db.close();
      assert.equal(n.n, 1, 'still exactly one record');
    }

    /* --- the door lifts, everywhere --- */
    assert.equal((await me(G)).user.release_missing, false, 'the bootstrap flag clears');
    const stG = await req(base, 'GET', '/api/model/id-verification', { token: G.token });
    assert.equal(stG.json.release.method, 'clickwrap');
    assert.equal(stG.json.packet_complete, true);
    const queue = await adminApi('GET', '/api/admin/id-verifications');
    const rowG = queue.json.verifications.find((v) => v.model_id === G.id && !v.co_performer_id);
    assert.equal(rowG.release_on_file, 1, 'Manager flips to on-file through the existing wiring');
    assert.equal(rowG.release_method, 'clickwrap');

    const live = await req(base, 'POST', '/api/live/start', { token: G.token, body: { title: 'door test live' } });
    assert.equal(live.status, 200, `live start opens after agreeing: ${live.text}`);
    const sid = live.json.session_id;
    const liveList = await req(base, 'GET', '/api/live');
    assert.ok((liveList.json.live || []).some((s) => s.session_id === sid), 'her live is listed — in progress and untouched');
    const pool = await req(base, 'POST', '/api/battles/pool/enter', { token: G.token, body: {} });
    assert.equal(pool.status, 200, `pool entry opens after agreeing: ${pool.text}`);
    await req(base, 'POST', '/api/battles/pool/leave', { token: G.token });
    const invJ = await req(base, 'POST', '/api/battles/invite', { token: J.token, body: { opponent_id: G.id, minutes: 5 } });
    assert.equal(invJ.status, 200, `fresh invite: ${invJ.text}`);
    const acc = await req(base, 'POST', `/api/battles/${invJ.json.battle.id}/accept`, { token: G.token });
    assert.equal(acc.status, 200, `battle accept opens after agreeing: ${acc.text}`);
    const end = await req(base, 'POST', `/api/live/${sid}/end`, { token: G.token });
    assert.equal(end.status, 200, 'her live ends normally');

    /* --- the rest of the population --- */
    const fresh = await signup('doorfresh', 'model');
    assert.equal((await me(fresh)).user.release_missing, true,
      'a brand-new model meets the door at the door — signing comes before everything');

    const P = await signup('doorpend', 'model');
    const upP = await idDocsUpload(base, P.token);
    assert.equal(upP.status, 200);
    assert.equal((await me(P)).user.release_missing, false,
      'packet PENDING: onboarding is her path, the flag stays off');
    const qP = await adminApi('GET', '/api/admin/id-verifications');
    const rowP = qP.json.verifications.find((v) => v.model_id === P.id && !v.co_performer_id);
    const blockedP = await adminApi('POST', `/api/admin/id-verifications/${rowP.id}/approve`);
    assert.equal(blockedP.status, 409, 'her packet still cannot complete without the release (PR #86)');
    assert.equal(blockedP.json.error, 'release_missing');
    const signP = await req(base, 'POST', '/api/model/release/sign', { token: P.token, body: {
      legal_name: 'Pend Signer', stage_name: 'doorpend', dob: '1995-05-05',
      attestations: { adult: true, freewill: true, rights: true } } });
    assert.equal(signP.status, 200);
    const apP = await adminApi('POST', `/api/admin/id-verifications/${rowP.id}/approve`);
    assert.equal(apP.status, 200, 'the onboarding path completes untouched');
    assert.equal((await me(P)).user.release_missing, false);

    const R = await signup('doorrej', 'model');
    const upR = await idDocsUpload(base, R.token);
    assert.equal(upR.status, 200);
    {
      const db = openDb(dir, false);
      db.prepare("UPDATE id_verifications SET status = 'rejected', reviewed_at = datetime('now') WHERE model_id = ? AND co_performer_id IS NULL")
        .run(R.id);
      db.close();
    }
    assert.equal((await me(R)).user.release_missing, true,
      'a rejected-ID model (the Shay case) meets the door too — she re-signs on her way back in');

    const fanAgree = await req(base, 'POST', '/api/model/release/agree', { token: fan.token, body: {} });
    assert.equal(fanAgree.status, 403, 'the agree endpoint is model-only');

    /* HOUSE: exempt from flag, endpoint, and the live block. */
    const house = await signup('asceaaspade', 'model');
    assert.equal((await me(house)).user.release_missing, false, 'the house is never flagged');
    const agreeH = await req(base, 'POST', '/api/model/release/agree', { token: house.token, body: {} });
    assert.equal(agreeH.status, 200, `house agree no-op: ${agreeH.text}`);
    assert.equal(agreeH.json.house, true);
    const liveH = await req(base, 'POST', '/api/live/start', { token: house.token, body: { title: 'house live' } });
    assert.equal(liveH.status, 200, `house live starts with no release record: ${liveH.text}`);
    await req(base, 'POST', `/api/live/${liveH.json.session_id}/end`, { token: house.token });
  } finally {
    stop(h);
  }
});

test('migration: a previous-CHECK database gains clickwrap and keeps every record', { timeout: 300000 }, async () => {
  const dir = makeCopy('relprompt-mig');
  let h = null;
  try {
    h = await boot(dir, { SEED_DEMO: '1' });
    const base = h.base;
    const s = await req(base, 'POST', '/api/auth/signup', {
      body: { username: 'migsigned', password: 'hunter22', role: 'model', publicity_consent: true, display_name: 'migsigned',
        dob: '1995-05-05', agree18: true, section: 'female' },
    });
    assert.equal(s.status, 200, `signup: ${s.text}`);
    const sign = await req(base, 'POST', '/api/model/release/sign', { token: s.json.token, body: {
      legal_name: 'Mig Signer', stage_name: 'migsigned', dob: '1995-05-05',
      attestations: { adult: true, freewill: true, rights: true } } });
    assert.equal(sign.status, 200, `e-sign before the rollback: ${sign.text}`);
    stop(h); h = null;
    /* Roll model_releases back to the PR #86 DDL (two methods only),
       carrying her e-sign row with it — the lived-in production shape
       this build's boot migration must upgrade in place. */
    {
      const db = openDb(dir, false);
      db.exec(`CREATE TABLE model_releases_old (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        model_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
        method TEXT NOT NULL CHECK(method IN ('esign','paper')),
        legal_name TEXT NOT NULL DEFAULT '',
        stage_name TEXT NOT NULL DEFAULT '',
        dob TEXT NOT NULL DEFAULT '',
        release_version TEXT NOT NULL DEFAULT '',
        attestations TEXT NOT NULL DEFAULT '',
        paper_path TEXT,
        signed_at TEXT NOT NULL DEFAULT (datetime('now')),
        ip TEXT NOT NULL DEFAULT ''
      )`);
      db.exec(`INSERT INTO model_releases_old
        (id, model_id, method, legal_name, stage_name, dob, release_version,
         attestations, paper_path, signed_at, ip)
        SELECT id, model_id, method, legal_name, stage_name, dob, release_version,
         attestations, paper_path, signed_at, ip FROM model_releases`);
      db.exec('DROP TABLE model_releases');
      db.exec('ALTER TABLE model_releases_old RENAME TO model_releases');
      db.close();
    }
    h = await boot(dir, { SEED_DEMO: '1' });
    {
      const db = openDb(dir);
      const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'model_releases'").get();
      assert.ok(/'clickwrap'/.test(ddl.sql), 'the boot migration widened the CHECK');
      const r = db.prepare('SELECT * FROM model_releases WHERE model_id = ?').get(s.json.user.id);
      db.close();
      assert.ok(r, 'her record survived the rebuild');
      assert.equal(r.method, 'esign', '...exactly as signed — method untouched');
      assert.equal(r.legal_name, 'Mig Signer');
      assert.equal(r.release_version, 'R1.0');
    }
    const doc = await req(h.base, 'GET', '/api/model/release', { token: s.json.token });
    assert.equal(doc.status, 200);
    assert.equal(doc.json.signed, true, 'the migrated record still reads signed');
    /* …and a clickwrap record now fits the rebuilt table. */
    const s2 = await req(h.base, 'POST', '/api/auth/signup', {
      body: { username: 'migdoor', password: 'hunter22', role: 'model', publicity_consent: true, display_name: 'migdoor',
        dob: '1995-05-05', agree18: true, section: 'female' },
    });
    assert.equal(s2.status, 200);
    const agree = await req(h.base, 'POST', '/api/model/release/agree', { token: s2.json.token, body: {} });
    assert.equal(agree.status, 200, `click-agree on the migrated table: ${agree.text}`);
    assert.equal(agree.json.release.method, 'clickwrap');
  } finally {
    stop(h);
  }
});

test('announcement: every model DMd exactly once in her language, stamp set, no re-send', { timeout: 300000 }, async () => {
  const dir = makeCopy('relprompt-ann');
  let h = null;
  try {
    /* Boot 1: no house account exists yet (the seed has none), so the
       announcement — like agreement v1.5 before it — waits unstamped. */
    h = await boot(dir, { SEED_DEMO: '1' });
    stop(h); h = null;
    {
      const db = openDb(dir);
      const stamp = db.prepare('SELECT release_prompt_announced_at FROM platform_stats WHERE id = 1').get();
      db.close();
      assert.ok(stamp && !stamp.release_prompt_announced_at, 'no house at boot → stamp stays unset, retried later');
    }
    /* Create the house, then boot 2 fires it. */
    h = await boot(dir, { SEED_DEMO: '1' });
    const hs = await req(h.base, 'POST', '/api/auth/signup', {
      body: { username: 'asceaaspade', password: 'hunter22', role: 'model', publicity_consent: true, display_name: 'SlutCamp',
        dob: '1995-05-05', agree18: true, section: 'female' },
    });
    assert.equal(hs.status, 200, `house signup: ${hs.text}`);
    stop(h); h = null;
    h = await boot(dir, { SEED_DEMO: '1' });
    stop(h); h = null;
    let db = openDb(dir);
    const house = db.prepare("SELECT id FROM users WHERE username = 'asceaaspade' AND role = 'model'").get();
    assert.ok(house, 'house exists');
    const stamp = db.prepare('SELECT release_prompt_announced_at FROM platform_stats WHERE id = 1').get();
    assert.ok(stamp && stamp.release_prompt_announced_at, 'the stamp is set once the announcement fires');
    const models = db.prepare("SELECT id, username FROM users WHERE role = 'model' AND id != ?").all(house.id);
    assert.ok(models.length >= 3, 'seed models exist');
    const dmCount = (modelId) => db.prepare(
      `SELECT COUNT(*) AS c FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE c.fan_id = ? AND c.model_id = ? AND c.is_official = 1 AND m.sender_id = ? AND m.body = ?`
    ).get(modelId, house.id, house.id, SRV.ann_release_prompt_dm.en).c;
    for (const m of models) {
      assert.equal(dmCount(m.id), 1, `${m.username} got exactly one release-prompt DM`);
      const bell = db.prepare("SELECT title, body FROM notifications WHERE user_id = ? AND type = 'release_prompt'").get(m.id);
      assert.ok(bell, `${m.username} got the release-prompt bell`);
      assert.equal(bell.title, SRV.ann_release_prompt_bell_title.en);
      assert.equal(bell.body, SRV.ann_release_prompt_bell_body.en);
    }
    const houseDm = db.prepare('SELECT COUNT(*) AS c FROM messages WHERE sender_id = ? AND body = ?')
      .get(house.id, SRV.ann_release_prompt_dm.en).c;
    assert.equal(houseDm, models.length, 'the house sent one DM per model — and received none');
    const fan = db.prepare("SELECT id FROM users WHERE role = 'fan' LIMIT 1").get();
    const fanBell = db.prepare("SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND type = 'release_prompt'").get(fan.id).c;
    assert.equal(fanBell, 0, 'fans hear nothing');
    db.close();
    /* Boot 3: never twice. */
    h = await boot(dir, { SEED_DEMO: '1' });
    stop(h); h = null;
    db = openDb(dir);
    for (const m of models) assert.equal(dmCount(m.id), 1, `${m.username} not re-sent on the next boot`);
    db.close();
  } finally {
    stop(h);
  }
});
