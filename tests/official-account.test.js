'use strict';
/*
 * The OFFICIAL house account (owner, Oct 17 2026): the in-app
 * "SlutCamp" account (username asceaaspade, a model-role user) is the
 * APP ITSELF, not a model. The owner saw its tile sitting in the model
 * rail with a $1.49/msg price and ruled:
 *
 *  - It must NOT pop up like a model: no home-grid / Discovery / New
 *    Models / ranked tile, no rank badge or rank position, no landing
 *    tile. The server enforces this in GET /api/models — the account
 *    leaves the `models` roster for every viewer and travels separately
 *    as `official`, so no client surface can leak it back in.
 *  - It stays PINNED at the top of the fan home as an official card:
 *    logo avatar + "SlutCamp" + Official label. LIVE → tapping joins
 *    the stream exactly like a live model tile; quiet → tapping opens
 *    its profile page look-only.
 *  - Fans can NOT message it: no Message bar on its profile page (the
 *    Official label stands in its place), fan chat lists never offer
 *    it, and the server rejects fan/guest conversation starts AND
 *    message sends into a house thread (cannot_message_official).
 *    Scoping proof: the admin announcement-DM path (fan side = the
 *    ADMIN user, model side = a real model, built directly by the
 *    broadcast code) is untouched, and the house account's own replies
 *    in a thread still work — its logged-in experience is unchanged.
 *  - When it goes live, EVERY fan is notified (bell + push via the
 *    existing notifyUser machinery), not just followers; a regular
 *    model's go-live still notifies followers only.
 *
 * Layers: static source pins for the client + server wiring, then live
 * API tests against the real server (new-models harness pattern +
 * direct DB access like av-shield) with a house account signed up
 * under the exact production username.
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
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const server = read('server.js');
const app = read('public/js/app.js');
const css = read('public/css/styles.css');

/* ---------------- static pins: server ---------------- */

test('pins: server — house identity is the immutable username, never a numeric id', () => {
  assert.ok(server.includes("const HOUSE_USERNAME = 'asceaaspade';"), 'house username constant');
  assert.ok(server.includes('function houseAccountId()'), 'house id resolver exists');
  assert.ok(server.includes('function isHouseAccountId('), 'house predicate exists');
  assert.ok(server.includes("WHERE username = ? AND role = 'model'"),
    'identity resolves by username + model role');
});

test('pins: server — DM block lives on both write paths with one error code', () => {
  assert.equal(server.split("error: 'cannot_message_official'").length - 1, 2,
    'conversation start + message send both reject with cannot_message_official');
  const start = server.slice(server.indexOf("app.post('/api/conversations/start'"),
    server.indexOf('/* --- Safety pause auto-lift'));
  assert.ok(start.includes('isHouseAccountId(model.id)'), 'start blocks the house account');
  assert.ok(start.indexOf('isHouseAccountId(model.id)') < start.indexOf('INSERT INTO conversations'),
    'block is checked before any conversation is created');
  const send = server.slice(server.indexOf("app.post('/api/messages'"),
    server.indexOf("app.post('/api/messages/:id/react'"));
  assert.ok(send.includes('isHouseAccountId(conv.model_id) && (conv.is_official || !isModelSender)'),
    'send block: the official notices thread rejects every send; other house threads stay fan-side-blocked (notices build, Oct 18 2026)');
});

test('pins: server — fan-side conversation lists filter the house account', () => {
  const list = server.slice(server.indexOf("app.get('/api/conversations'"),
    server.indexOf("app.get('/api/conversations/:id/messages'"));
  assert.ok(list.includes("req.ident.user.role === 'fan'"), 'filter keys off the fan role');
  assert.ok(list.includes('c.model_id !== hid'), 'house threads filtered from fan lists');
});

test('pins: server — house go-live fans out to every fan; regular models keep follower targeting', () => {
  const live = server.slice(server.indexOf("app.post('/api/live/start'"),
    server.indexOf("app.post('/api/live/:id/leave'"));
  assert.ok(live.includes('isHouseAccountId(req.user.id)'), 'go-live branches on the house account');
  assert.ok(live.includes("SELECT id AS fan_id FROM users WHERE role = 'fan' AND banned = 0"),
    'house audience = all fan accounts');
  assert.ok(live.includes('SELECT fan_id FROM follows WHERE model_id = ?'),
    'regular audience = followers (unchanged)');
});

/* ---------------- static pins: client ---------------- */

test('pins: client — peek is look-only for the official account, Official label in the bar’s place', () => {
  const peek = app.slice(app.indexOf('function openModelPeek('),
    app.indexOf('async function vFanModels()'));
  assert.ok(peek.includes('const isOfficial = !!m.is_official;'), 'peek reads the official flag');
  assert.ok(peek.includes('officialBarHTML'), 'official bar content defined');
  assert.ok(peek.includes('? officialBarHTML'), 'bar block branches to the official label');
  assert.equal(peek.split('? officialBarHTML').length - 1, 2,
    'BOTH pinned bars (fan Message bar + guest join bar) branch to the official label');
  assert.ok(peek.includes("official-pill\">${t('official_label')}"),
    'official pill renders by the name and in the bar');
  assert.ok(peek.includes("${isOfficial ? '' : `<div class=\"peek-row\"><span>Messages</span>"),
    'no per-message price row for the official account');
  // The fan Message button itself is untouched for real models.
  assert.ok(peek.includes('data-peek-msg="${m.id}"'), 'real models keep their Message button');
});

test('pins: client — pinned official card tops the fan home and routes both states', () => {
  assert.ok(app.includes('function officialCardHTML(official)'), 'card renderer exists');
  assert.ok(app.includes("if (!official) return '';"), 'no house account → no card');
  const home = app.slice(app.indexOf('async function vFanModels()'),
    app.indexOf('async function vFanChats()'));
  assert.ok(home.includes('const official = data.official || null;'), 'home reads the official object');
  assert.ok(home.indexOf('${officialCardHTML(official)}') !== -1 &&
    home.indexOf('${officialCardHTML(official)}') < home.indexOf('${newModelsRailHTML(models, heartFor)}'),
    'card renders above the rails/grid');
  assert.ok(home.includes("app.querySelectorAll('[data-official]')"), 'card tap is wired');
  assert.ok(home.includes('watchLive(parseInt(official.live_session_id))'),
    'LIVE state joins the stream like a live tile');
  assert.ok(home.includes('openModelPeek(official, models);'),
    'quiet state opens the look-only profile page');
  const card = app.slice(app.indexOf('function officialCardHTML('),
    app.indexOf('/* ---------------- LANDING'));
  assert.ok(card.includes("t('official_label')"), 'card carries the Official label');
  assert.ok(card.includes('official.is_live'), 'card branches on the live state');
  assert.ok(!card.includes('data-model='), 'card is never a model tile');
});

test('pins: i18n — official strings exist in all 13 languages; CSS styles exist', () => {
  assert.equal((app.match(/official_label: '/g) || []).length, 13, 'official_label ×13');
  assert.equal((app.match(/official_tagline: '/g) || []).length, 13, 'official_tagline ×13');
  assert.ok(app.includes("official_label: 'Official'"), 'EN label present');
  assert.ok(css.includes('.official-card'), 'pinned card styled');
  assert.ok(css.includes('.official-pill'), 'official pill styled');
  assert.ok(css.includes('.peek-official-bar'), 'peek official bar styled');
});

/* ---------------- live API tests (real server) ---------------- */

let tmpDir = null;
let child = null;
let base = null;
let childLog = '';
let house = null;   // { token, id, username } — username exactly 'asceaaspade'
let reg = null;     // regular model
let reg2 = null;    // second regular model (rank checks)
let fan1 = null;    // follows reg
let fan2 = null;    // follows nobody
let adminId = null;

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
    method, headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* HTML or empty */ }
  return { status: r.status, text, json };
}

function dbExec(sql, params = []) {
  const db = new DatabaseSync(path.join(tmpDir, 'wogent-chat.db'));
  db.exec('PRAGMA busy_timeout = 10000');
  try { db.prepare(sql).run(...params); } finally { db.close(); }
}
function dbAll(sql, params = []) {
  const db = new DatabaseSync(path.join(tmpDir, 'wogent-chat.db'), { readOnly: true });
  try { return db.prepare(sql).all(...params); } finally { db.close(); }
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-official-'));
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
  const signup = async (username, role, display) => {
    const s = await req('POST', '/api/auth/signup', {
      body: { username, password: 'official-pass-1', role, display_name: display, dob: '1997-05-20', agree18: true, ...(role === 'model' ? { section: 'female' } : {}) },
    });
    assert.equal(s.status, 200, `${role} signup (${username}) failed: ${s.text}`);
    return { token: s.json.token, id: s.json.user.id, username };
  };
  // The house account signs up under its EXACT production username.
  house = await signup('asceaaspade', 'model', 'SlutCamp');
  reg = await signup('regmodel' + suffix, 'model', 'Reg Model');
  reg2 = await signup('regmodeltwo' + suffix, 'model', 'Reg Model Two');
  fan1 = await signup('offfan1' + suffix, 'fan', 'Fan One');
  fan2 = await signup('offfan2' + suffix, 'fan', 'Fan Two');
  const adminLogin = await req('POST', '/api/auth/login', {
    body: { username: 'admin', password: 'admin123' },
  });
  assert.equal(adminLogin.status, 200, 'seeded admin login: ' + adminLogin.text);
  adminId = adminLogin.json.user.id;
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

test('api: house account is out of the roster for guests AND fans; official travels separately', async () => {
  for (const token of [undefined, fan1.token]) {
    const r = await req('GET', '/api/models', token ? { token } : {});
    assert.equal(r.status, 200, r.text);
    const names = r.json.models.map((m) => m.username);
    assert.ok(!names.includes('asceaaspade'), 'house account never appears in models[]');
    assert.ok(names.includes(reg.username) && names.includes(reg2.username),
      'regular models remain in the roster');
    assert.ok(r.json.official, 'official object is present');
    assert.equal(r.json.official.username, 'asceaaspade');
    assert.equal(r.json.official.is_official, true, 'official is flagged');
    assert.equal(r.json.official.rank_position, null, 'official holds no rank position');
    assert.equal(r.json.official.is_featured, false, 'official is not the featured model');
    assert.ok(!r.json.models.some((m) => m.is_official), 'no roster row carries the flag');
  }
});

test('api: rank positions are computed without the house account', async () => {
  // Give the house account a runaway rank score: if it were ranked it
  // would hold #1 and push everyone down a place.
  dbExec('UPDATE models SET rank_score = 99999 WHERE user_id = ?', [house.id]);
  dbExec('UPDATE models SET rank_score = 20 WHERE user_id = ?', [reg2.id]);
  dbExec('UPDATE models SET rank_score = 10 WHERE user_id = ?', [reg.id]);
  const r = await req('GET', '/api/models', { token: fan1.token });
  assert.equal(r.status, 200, r.text);
  const byName = new Map(r.json.models.map((m) => [m.username, m]));
  assert.equal(byName.get(reg2.username).rank_position, 1, 'top regular model is #1');
  assert.equal(byName.get(reg.username).rank_position, 2, 'second regular model is #2, not #3');
});

test('dm: a fan cannot open a conversation with the house account — nothing is created', async () => {
  const r = await req('POST', '/api/conversations/start', {
    body: { model_id: house.id }, token: fan1.token,
  });
  assert.equal(r.status, 403, r.text);
  assert.equal(r.json.error, 'cannot_message_official');
  const rows = dbAll('SELECT id FROM conversations WHERE fan_id = ? AND model_id = ?',
    [fan1.id, house.id]);
  assert.equal(rows.length, 0, 'no conversation row was created');
});

test('dm: a guest cannot open a conversation with the house account either', async () => {
  const gt = await req('POST', '/api/guest/token', { body: {} });
  assert.equal(gt.status, 200, gt.text);
  const guestToken = gt.json.guest_token;
  assert.ok(guestToken, 'guest token issued');
  const r = await req('POST', '/api/conversations/start', {
    body: { model_id: house.id }, guest: guestToken,
  });
  assert.equal(r.status, 403, r.text);
  assert.equal(r.json.error, 'cannot_message_official');
  const rows = dbAll('SELECT id FROM conversations WHERE guest_token = ? AND model_id = ?',
    [guestToken, house.id]);
  assert.equal(rows.length, 0, 'no guest conversation was created');
});

test('dm: fan writes into a legacy house thread are rejected; the house account itself can still reply', async () => {
  // Simulate a thread created before this rule existed.
  dbExec('INSERT INTO conversations (fan_id, model_id) VALUES (?, ?)', [fan1.id, house.id]);
  const conv = dbAll('SELECT id FROM conversations WHERE fan_id = ? AND model_id = ?',
    [fan1.id, house.id])[0];
  assert.ok(conv, 'legacy thread staged');

  const blocked = await req('POST', '/api/messages', {
    body: { conversation_id: conv.id, body: 'hi slutcamp' }, token: fan1.token,
  });
  assert.equal(blocked.status, 403, blocked.text);
  assert.equal(blocked.json.error, 'cannot_message_official');
  assert.equal(dbAll('SELECT id FROM messages WHERE conversation_id = ?', [conv.id]).length, 0,
    'the blocked write saved nothing and charged nothing');

  const own = await req('POST', '/api/messages', {
    body: { conversation_id: conv.id, body: 'House reply — our own side still works.' }, token: house.token,
  });
  assert.equal(own.status, 200, own.text);
  assert.equal(dbAll('SELECT id FROM messages WHERE conversation_id = ?', [conv.id]).length, 1,
    'the house account’s own reply landed');
});

test('dm: fan chat lists never offer the house account; the house inbox keeps its thread', async () => {
  const fanList = await req('GET', '/api/conversations', { token: fan1.token });
  assert.equal(fanList.status, 200, fanList.text);
  assert.ok(!fanList.json.conversations.some((c) => c.other && c.other.id === house.id),
    'fan chat list hides the house thread');
  const houseList = await req('GET', '/api/conversations', { token: house.token });
  assert.equal(houseList.status, 200, houseList.text);
  assert.ok(houseList.json.conversations.some((c) => c.other && c.other.id === fan1.id),
    'house model inbox still shows the thread');
});

test('announcements: the admin-thread DM path to a real model is unaffected', async () => {
  // Exactly the broadcast pattern: fan side = ADMIN user, model side =
  // a real model, conversation + message inserted directly. (The
  // boot-time broadcasts may already have opened this thread — fetch
  // or create, like the broadcast code itself does.)
  let conv = dbAll('SELECT id FROM conversations WHERE fan_id = ? AND model_id = ?',
    [adminId, reg.id])[0];
  if (!conv) {
    dbExec('INSERT INTO conversations (fan_id, model_id) VALUES (?, ?)', [adminId, reg.id]);
    conv = dbAll('SELECT id FROM conversations WHERE fan_id = ? AND model_id = ?',
      [adminId, reg.id])[0];
  }
  assert.ok(conv, 'admin thread exists');
  dbExec('INSERT INTO messages (conversation_id, sender_id, body) VALUES (?, ?, ?)',
    [conv.id, adminId, '🔔 Announcement: something new shipped!']);
  const msgs = await req('GET', `/api/conversations/${conv.id}/messages?limit=50`, { token: reg.token });
  assert.equal(msgs.status, 200, msgs.text);
  assert.ok(msgs.json.messages.some((m) => m.body && m.body.includes('Announcement')),
    'the model sees the announcement in her admin thread');
  const reply = await req('POST', '/api/messages', {
    body: { conversation_id: conv.id, body: 'Got it, thanks!' }, token: reg.token,
  });
  assert.equal(reply.status, 200, reply.text);
});

test('live: house go-live notifies EVERY fan; a regular model’s go-live notifies followers only', async () => {
  // fan1 follows reg; fan2 follows nobody.
  const fol = await req('POST', `/api/follows/${reg.id}`, { body: {}, token: fan1.token });
  assert.equal(fol.status, 200, fol.text);
  assert.equal(fol.json.following, true);
  // Both models get ID-verified so they may go live.
  dbExec("INSERT INTO id_verifications (model_id, status) VALUES (?, 'approved')", [house.id]);
  dbExec("INSERT INTO id_verifications (model_id, status) VALUES (?, 'approved')", [reg.id]);

  const liveNotifs = async (token) => {
    const n = await req('GET', '/api/notifications', { token });
    assert.equal(n.status, 200, n.text);
    return n.json.notifications.filter((x) => x.type === 'live');
  };
  assert.equal((await liveNotifs(fan1.token)).length, 0, 'baseline: fan1 has no live bells');
  assert.equal((await liveNotifs(fan2.token)).length, 0, 'baseline: fan2 has no live bells');

  // House goes live → both fans are notified, follower or not.
  const start = await req('POST', '/api/live/start', { body: { title: 'House show' }, token: house.token });
  assert.equal(start.status, 200, start.text);
  const sid = start.json.session_id;
  const f1 = await liveNotifs(fan1.token);
  const f2 = await liveNotifs(fan2.token);
  assert.equal(f1.length, 1, 'fan1 (non-follower of the house) is notified');
  assert.equal(f2.length, 1, 'fan2 (follows nobody) is notified');
  assert.ok(f2[0].title.includes('SlutCamp'), 'the bell names the house account');

  // The official object now reports the live state the pinned card needs.
  const dir = await req('GET', '/api/models', { token: fan1.token });
  assert.equal(dir.json.official.is_live, true, 'official shows LIVE');
  assert.equal(dir.json.official.live_session_id, sid, 'official carries the session to join');

  const end = await req('POST', `/api/live/${sid}/end`, { body: {}, token: house.token });
  assert.equal(end.status, 200, end.text);

  // Regular model goes live → only her follower is notified.
  const start2 = await req('POST', '/api/live/start', { body: {}, token: reg.token });
  assert.equal(start2.status, 200, start2.text);
  assert.equal((await liveNotifs(fan1.token)).length, 2, 'her follower gets the bell');
  assert.equal((await liveNotifs(fan2.token)).length, 1, 'the non-follower gets nothing new');
  await req('POST', `/api/live/${start2.json.session_id}/end`, { body: {}, token: reg.token });
});
