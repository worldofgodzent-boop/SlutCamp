'use strict';
/*
 * Role-based sign-in (owner order, Oct 17 2026): returning users got
 * confused — the front door offered "Become a fan / model /
 * affiliate" (join) but no clearly labelled way to just SIGN IN per
 * role, and he cannot explain it to everyone. His standard: "really
 * simple."
 *
 * What shipped:
 *  - Landing (logged-out): a sign-in card with three big buttons —
 *    "Sign in as a fan / model / affiliate" — each opening the
 *    existing login form carrying that role; joining stays in the
 *    same card as one quiet "Join free" link. The old ambiguous
 *    single "Log in / Sign up" button is gone.
 *  - Auth view: the same three choices sit above the login form
 *    (the picked one is solid, the others ghost); the form heading
 *    reflects the choice ("Model sign in"); arriving bare keeps the
 *    old "Welcome back" heading and no pre-pick.
 *  - Login itself is untouched: credentials, sessions and routing
 *    still follow the account's STORED role. A wrong-door pick is
 *    forgiven — she signs in anyway and gets one gentle toast
 *    ("You're signed in — this is a fan account").
 *  - One-time localized announcement DM + bell to MODELS only
 *    (role_signin_announced_at stamp, SRV copy), per the standing
 *    "message the girls about updates" rule.
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

const LANG13 = ['en', 'es', 'pt', 'fr', 'de', 'ru', 'ja', 'zh', 'ko', 'it', 'pl', 'nl', 'tr'];
const NEW_KEYS = ['signin_have_account', 'signin_as_fan', 'signin_as_model', 'signin_as_affiliate',
  'signin_h_fan', 'signin_h_model', 'signin_h_affiliate', 'signin_join_q', 'signin_join_free',
  'signin_wrong_role', 'role_word_fan', 'role_word_model', 'role_word_affiliate'];

/* Brace-matching extractor (same approach as the language suites). */
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

const landing = sliceFn(appSrc, 'async function vLanding()', 'async function shareApp()');
const auth = sliceFn(appSrc, 'function vAuth(params)', 'function renderAuthBody');
const authBody = sliceFn(appSrc, 'function renderAuthBody(', '/* Signup fields under the role cards.');
const login = sliceFn(appSrc, 'async function doLogin()', 'async function doSignup(role)');
const after = sliceFn(appSrc, 'async function afterLogin(data', '/* ----------------');

test('landing: guest sign-in card carries the three role buttons + a quiet join link', () => {
  assert.ok(landing.includes("t('signin_have_account')"), 'card heading key');
  for (const [id, key] of [['si-fan', 'signin_as_fan'], ['si-model', 'signin_as_model'], ['si-aff', 'signin_as_affiliate']]) {
    assert.ok(landing.includes(`id="${id}"`), `${id} button present`);
    assert.ok(landing.includes(`t('${key}')`), `${key} label used`);
  }
  assert.ok(landing.includes('id="si-join"'), 'join link present in the same card');
  assert.ok(landing.includes("t('signin_join_free')"), 'join link label key');
  assert.ok(landing.includes('${S.user ? \'\' : `'), 'card is guests-only');
  assert.ok(!landing.includes('id="go-login"'), 'the ambiguous single Log in / Sign up button is gone');
});

test('landing: buttons open the login form carrying their role; join opens signup', () => {
  assert.ok(landing.includes("siFan.onclick = () => show('auth', { mode: 'login', role: 'fan' })"), 'fan wiring');
  assert.ok(landing.includes("siModel.onclick = () => show('auth', { mode: 'login', role: 'model' })"), 'model wiring');
  assert.ok(landing.includes("siAff.onclick = () => show('auth', { mode: 'login', role: 'affiliate' })"), 'affiliate wiring');
  assert.ok(landing.includes("siJoin.onclick = () => show('auth', { mode: 'signup' })"), 'join wiring');
});

test('auth view: role context drives the heading; bare visits keep Welcome back', () => {
  assert.ok(auth.includes("const loginRole = mode === 'login'"), 'loginRole computed for login mode only');
  assert.ok(auth.includes("['fan', 'model', 'affiliate'].includes(params && params.role)"), 'role validated against the three');
  assert.ok(auth.includes("loginRole ? t('signin_h_' + loginRole) : t('welcome_back')"), 'heading reflects the pick, Welcome back otherwise');
  assert.ok(auth.includes("show('auth', { mode: 'login', role })"), 'Log in tab preserves the role context');
  assert.ok(auth.includes('renderAuthBody(mode, role, loginRole)'), 'loginRole handed to the body renderer');
});

test('auth body: the three role choices sit above the login form, picked one solid', () => {
  const loginBranch = authBody.slice(0, authBody.indexOf("$('#a-go').onclick = doLogin;"));
  for (const r of ['fan', 'model', 'affiliate']) {
    assert.ok(loginBranch.includes(`data-si-role="${r}"`), `${r} choice present`);
    assert.ok(loginBranch.includes(`loginRole === '${r}' ? '' : 'ghost'`), `${r} choice highlights when picked`);
    assert.ok(loginBranch.includes(`t('signin_as_${r === 'affiliate' ? 'affiliate' : r}')`), `${r} choice label`);
  }
  assert.ok(authBody.includes("b.onclick = () => show('auth', { mode: 'login', role: b.dataset.siRole });"),
    'picking a role re-opens the login form with that context');
});

test('login flow: role hint is advisory only; mismatch yields one gentle toast, never a block', () => {
  assert.ok(appSrc.includes('function pickedLoginRole()'), 'hint helper exists');
  assert.ok(appSrc.includes('S.viewParams && S.viewParams.role'), 'hint read from the auth view params');
  assert.ok(login.includes('afterLogin(data, { roleHint: pickedLoginRole() })'), 'password login passes the hint');
  assert.ok(appSrc.includes('afterLogin(v.data, { roleHint: pickedLoginRole() })'), 'Face ID login passes the hint');
  assert.ok(after.includes("{ fan: 'fan', model: 'model', affiliate: 'recruiter' }"), 'affiliate hint maps to the recruiter role');
  assert.ok(after.includes("toast(t('signin_wrong_role', { role: t(wordKey) }))"), 'gentle notice on mismatch');
  assert.ok(after.includes("S.user.role !== 'admin'"), 'admin sign-ins are never nagged');
  // Routing is still purely by stored role, before any toast.
  const routeAt = after.indexOf("show('fanModels', {})");
  const toastAt = after.indexOf('signin_wrong_role');
  assert.ok(routeAt !== -1 && toastAt > routeAt, 'routing happens first and never consults the hint');
});

test('i18n: the sign-in keys exist, non-empty, in all 13 languages; wrong-role keeps its {role} slot', () => {
  const I18N = evalConst(appSrc, 'const I18N =');
  assert.deepEqual(Object.keys(I18N).sort(), [...LANG13].sort(), 'still exactly the 13 languages');
  for (const lang of LANG13) {
    for (const k of NEW_KEYS) {
      assert.equal(typeof I18N[lang][k], 'string', `${lang}:${k} exists`);
      assert.ok(I18N[lang][k].trim().length > 0, `${lang}:${k} not empty`);
    }
    assert.ok(I18N[lang].signin_wrong_role.includes('{role}'), `${lang}: wrong-role keeps {role}`);
  }
  assert.equal(I18N.en.signin_as_fan, 'Sign in as a fan');
  assert.equal(I18N.en.signin_as_model, 'Sign in as a model');
  assert.equal(I18N.en.signin_as_affiliate, 'Sign in as an affiliate');
  assert.equal(I18N.en.signin_h_model, 'Model sign in');
});

test('server: announcement is stamped, SRV-localized in all 13, and wired at boot', () => {
  assert.ok(serverSrc.includes("addColumnIfMissing('platform_stats', 'role_signin_announced_at'"), 'stamp column migrates in');
  assert.ok(serverSrc.includes('function announceRoleSigninToModels()'), 'announcement function exists');
  assert.ok(serverSrc.includes('announceRoleSigninToModels();'), 'invoked at boot');
  assert.ok(serverSrc.includes("srv('ann_role_signin_dm', m.language)"), 'DM copy localized per model');
  assert.ok(serverSrc.includes("notifyUser(m.id, 'role_signin'"), 'bell sent with the role_signin type');
  const SRV = evalConst(serverSrc, 'const SRV =');
  for (const k of ['ann_role_signin_dm', 'ann_role_signin_bell_title', 'ann_role_signin_bell_body']) {
    assert.deepEqual(Object.keys(SRV[k]).sort(), [...LANG13].sort(), `${k} covers all 13 languages`);
    for (const lang of LANG13) assert.ok(SRV[k][lang].trim().length > 0, `${k}:${lang} not empty`);
  }
  assert.ok(SRV.ann_role_signin_dm.en.includes('Sign in as a model'), 'EN DM names the new button');
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

async function req(base, method, p, { body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = 'Bearer ' + token;
  const r = await fetch(base + p, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
  return { status: r.status, text, json };
}

test('functional: login still signs in every role by its stored role', async () => {
  const dir = makeCopy('rolesigninlogin');
  let h = null;
  try {
    h = await boot(dir, { SEED_DEMO: '1' });
    const fan = await req(h.base, 'POST', '/api/auth/login', { body: { username: 'fandemo', password: 'fan123' } });
    assert.equal(fan.status, 200, `fan login works: ${fan.text}`);
    assert.equal(fan.json.user.role, 'fan', 'fan account reports role fan');
    const model = await req(h.base, 'POST', '/api/auth/login', { body: { username: 'bunny', password: 'model123' } });
    assert.equal(model.status, 200, `model login works: ${model.text}`);
    assert.equal(model.json.user.role, 'model', 'model account reports role model');
    const bad = await req(h.base, 'POST', '/api/auth/login', { body: { username: 'bunny', password: 'wrong-pass' } });
    assert.notEqual(bad.status, 200, 'wrong password still rejected');
    // Affiliate: self-serve signup creates the recruiter, then plain
    // login signs her in as one — no separate door on the server.
    const su = await req(h.base, 'POST', '/api/affiliate/signup', {
      body: { username: 'affgal', password: 'hunter22', display_name: 'Aff Gal', agreed: true },
    });
    assert.equal(su.status, 200, `affiliate signup works: ${su.text}`);
    const aff = await req(h.base, 'POST', '/api/auth/login', { body: { username: 'affgal', password: 'hunter22' } });
    assert.equal(aff.status, 200, `affiliate login works: ${aff.text}`);
    assert.equal(aff.json.user.role, 'recruiter', 'affiliate account reports role recruiter');
  } finally {
    stop(h);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('announcement: every model DMd + belled exactly once, in her language; stamp set; no re-send', async () => {
  const SRV = evalConst(serverSrc, 'const SRV =');
  const dir = makeCopy('rolesigninann');
  try {
    const h1 = await boot(dir, { SEED_DEMO: '1' });
    stop(h1);
    let db = new DatabaseSync(path.join(dir, 'wogent-chat.db'), { readOnly: true });
    const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
    assert.ok(admin, 'seeded admin exists');
    const stamp = db.prepare('SELECT role_signin_announced_at FROM platform_stats WHERE id = 1').get();
    assert.ok(stamp && stamp.role_signin_announced_at, 'announcement stamp is set after first boot');
    const models = db.prepare("SELECT id, username FROM users WHERE role = 'model'").all();
    assert.ok(models.length >= 3, 'seed models exist');
    const dmCount = (modelId, body) => db.prepare(
      `SELECT COUNT(*) AS c FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE c.fan_id = ? AND c.model_id = ? AND m.sender_id = ? AND m.body = ?`
    ).get(admin.id, modelId, admin.id, body).c;
    for (const m of models) {
      assert.equal(dmCount(m.id, SRV.ann_role_signin_dm.en), 1, `${m.username} got exactly one EN announcement DM`);
      const bell = db.prepare("SELECT title, body, link FROM notifications WHERE user_id = ? AND type = 'role_signin'").get(m.id);
      assert.ok(bell, `${m.username} got the bell`);
      assert.equal(bell.title, SRV.ann_role_signin_bell_title.en, 'bell title is the EN SRV copy');
      assert.equal(bell.body, SRV.ann_role_signin_bell_body.en, 'bell body is the EN SRV copy');
      assert.ok(bell.link && bell.link.startsWith('/#chat/'), 'bell opens the announcement thread itself');
    }
    const fan = db.prepare("SELECT id FROM users WHERE role = 'fan' LIMIT 1").get();
    const fanBells = db.prepare("SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND type = 'role_signin'").get(fan.id).c;
    assert.equal(fanBells, 0, 'fans receive no announcement');
    db.close();

    // Localization: switch one model to Spanish, clear the stamp and
    // the first round, boot again — she gets the Spanish copy.
    const wdb = new DatabaseSync(path.join(dir, 'wogent-chat.db'));
    wdb.exec('PRAGMA busy_timeout = 10000');
    wdb.prepare("UPDATE users SET language = 'es' WHERE username = 'bunny'").run();
    wdb.prepare('UPDATE platform_stats SET role_signin_announced_at = NULL WHERE id = 1').run();
    wdb.prepare("DELETE FROM notifications WHERE type = 'role_signin'").run();
    wdb.prepare(`DELETE FROM messages WHERE conversation_id IN
      (SELECT c.id FROM conversations c JOIN users a ON a.id = c.fan_id WHERE a.role = 'admin')`).run();
    wdb.close();
    const h2 = await boot(dir, { SEED_DEMO: '1' });
    stop(h2);
    db = new DatabaseSync(path.join(dir, 'wogent-chat.db'), { readOnly: true });
    const bunny = db.prepare("SELECT id FROM users WHERE username = 'bunny'").get();
    assert.equal(dmCount(bunny.id, SRV.ann_role_signin_dm.es), 1, 'bunny got the announcement in her stored Spanish');
    const esBell = db.prepare("SELECT title FROM notifications WHERE user_id = ? AND type = 'role_signin'").get(bunny.id);
    assert.equal(esBell.title, SRV.ann_role_signin_bell_title.es, 'bunny bell is in Spanish');
    const stamp2 = db.prepare('SELECT role_signin_announced_at FROM platform_stats WHERE id = 1').get();
    assert.ok(stamp2.role_signin_announced_at, 'stamp re-set after the localized round');
    db.close();

    const h3 = await boot(dir, { SEED_DEMO: '1' });
    stop(h3);
    db = new DatabaseSync(path.join(dir, 'wogent-chat.db'), { readOnly: true });
    assert.equal(dmCount(bunny.id, SRV.ann_role_signin_dm.es), 1, 'no re-send on the next boot');
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
