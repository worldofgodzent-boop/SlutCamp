'use strict';
/*
 * CCBill evaluation readiness patch (2026-10-21) — pins the pre-review
 * cleanup so a CCBill evaluator never sees a placeholder or dev string:
 *   1. DMCA page carries the designated agent's real mailing address +
 *      phone (17 U.S.C. §512(c)(2)); the "(Mailing address: to be
 *      provided)" placeholder is gone.
 *   2. The 2257 statement prints the same address as everywhere else
 *      ("7511 Oak Chase", no stray "St").
 *   3. The server-rendered public pages' footer links the legal pages
 *      (via the /#… in-app routes) and names the operator.
 *   4. The legacy POST /api/credits/buy 501 says the clean public
 *      message ("Card payments are launching soon.") — no dev text
 *      about processors plugging in; the wallet fallback toast matches.
 *   5. Billing §9 only advertises coins that are actually offered
 *      (no XRP until CRYPTO_XRP_ADDRESS is set).
 *   6. /join states the real ID rule: verified before going live or
 *      cashing out — not "before she can earn".
 *
 *   8. The Terms carry a published anti-trafficking / exploitation
 *      statement (section 13, all 13 languages): prohibition,
 *      verified-adult voluntariness, reporting to authorities + the
 *      National Human Trafficking Hotline (1-888-373-7888), immediate
 *      removal + termination — cross-linked from the 2257 page's
 *      content-complaints card. (Card-network expectation, research
 *      item P1-12; the pre-existing text had no such statement.)
 *   7. A one-time boot migration (marker platform_stats
 *      .ccbill_cleanup_2026_10_at) rewrites every case variant of
 *      "FaceTime" in model-authored text — models.bio, tip_menus.label,
 *      game_items.label — to "video call" (a public bio offering a
 *      "private FaceTime" reads to a reviewer like off-platform
 *      routing). Purchase-history snapshots (game_requests.label) and
 *      all other text are untouched.
 *
 *   9. A second one-time boot migration (marker platform_stats
 *      .ccbill_username_rename_2026_10_at) renames the two models
 *      whose username IS their Gmail address (krazykatz2022@gmail.com
 *      → krazykatz2022, shadecas27@gmail.com → shadecas27) — a public
 *      username must never publish a model's personal email. Sign-in
 *      resolves by USERNAME ONLY, so the rename changes the name
 *      they sign in with: the arm was first withheld for exactly
 *      that reason, then the owner had both models emailed their new
 *      sign-in name (same password) and ordered the change ("we
 *      change it, so we are in policy"). Guarded per pair: exact old
 *      username + role 'model' + target free, else skip (logged).
 *  10. A signup guard (POST /api/auth/signup): a MODEL signup whose
 *      username contains "@" is kicked back with
 *      username_is_email — "Your username can't be an email address
 *      — pick a name instead." — and no account is created, so the
 *      rename above never has to happen again. finalRole is the
 *      resolved role, so self-picked, invite-forced and referral
 *      model signups all pass the same gate; fan and recruiter
 *      signups are not covered (owner ordered models).
 *
 * Static pins read the shipped files; the live checks boot the real
 * server (same harness as tests/seo-pages.test.js).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const APP_JS = fs.readFileSync(path.join(REPO, 'public', 'js', 'app.js'), 'utf8');
const SERVER_JS = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');

function viewBody(src, name, nextName) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} not found`);
  const end = nextName ? src.indexOf(`function ${nextName}(`, start) : src.length;
  return src.slice(start, end > start ? end : src.length);
}

/* ---------------- static pins ---------------- */

test('DMCA page publishes the agent address + phone; placeholder is gone', () => {
  assert.ok(!APP_JS.includes('to be provided'), 'DMCA placeholder text must not ship');
  const dmca = viewBody(APP_JS, 'vDmca', 'vPrivacy');
  assert.ok(dmca.includes('DMCA Agent, World of Godz Entertainment LLC'));
  assert.ok(dmca.includes('7511 Oak Chase, San Antonio, TX 78239'), 'DMCA agent mailing address');
  assert.ok(dmca.includes('(210) 943-6509'), 'DMCA agent phone');
  assert.ok(dmca.includes('dmca@slutcamp.app'), 'DMCA agent email');
});

test('2257 statement address matches the LLC address used everywhere else', () => {
  assert.ok(!APP_JS.includes('Oak Chase St'), 'stray "St" suffix must not ship');
  const st = viewBody(APP_JS, 'vStatement2257', null);
  assert.ok(st.includes('7511 Oak Chase<br>'), 'custodian address');
  assert.ok(st.includes('San Antonio, TX 78239, USA'));
});

test('public footer links the legal pages and names the operator', () => {
  for (const href of ['/#terms', '/#privacy', '/#billing', '/#2257', '/#dmca']) {
    assert.ok(SERVER_JS.includes(`href="${href}"`), `footer link ${href}`);
  }
  assert.ok(SERVER_JS.includes('Operated by World of Godz Entertainment LLC'), 'operator line in footer');
  // Existing footer links are kept.
  assert.ok(SERVER_JS.includes('<a href="/models">All models</a>'));
  assert.ok(SERVER_JS.includes('<a href="/join">Become a model</a>'));
});

test('legal footer links resolve: app routes /#… hashes to the legal views', () => {
  assert.ok(APP_JS.includes("legalViews = { terms: 'terms', privacy: 'privacy', billing: 'billing', '2257': 'statement2257', dmca: 'dmca' }"),
    'routeInitial maps legal hashes to the auth-screen legal views');
});

test('purchase path speaks the clean public message — no dev text anywhere user-visible', () => {
  assert.ok(!SERVER_JS.includes('will plug in here'), 'dev string in server 501');
  assert.ok(!APP_JS.includes('Payment processor coming soon'), 'dev string in wallet fallback toast');
  assert.ok(SERVER_JS.includes("message: 'Card payments are launching soon.'"), 'clean 501 message');
  assert.ok(APP_JS.includes("'Card payments are launching soon.'"), 'clean wallet fallback');
});

test('billing §9 advertises only coins that are actually offered (no XRP)', () => {
  const billing = viewBody(APP_JS, 'vBilling', 'vStatement2257');
  assert.ok(!billing.includes('XRP'), 'billing page must not offer XRP loads');
  assert.ok(billing.includes('Bitcoin (BTC), USDT, Ethereum (ETH) or Solana (SOL)'), 'offered coin list');
  assert.ok(billing.includes('for <b>Solana</b>, send the exact amount to the last decimal'), 'solana exact-amount note kept');
});

test('terms carry the anti-trafficking / exploitation statement in all 13 languages', () => {
  assert.ok(APP_JS.includes('13. No Trafficking or Exploitation'), 'EN terms section 13 title');
  assert.ok(APP_JS.includes('SlutCamp prohibits human trafficking, sexual exploitation, and non-consensual content in all forms'),
    'EN terms prohibition statement');
  assert.ok(APP_JS.includes('Every performer on SlutCamp is a verified adult acting voluntarily'), 'verified-adult voluntariness');
  assert.ok(APP_JS.includes('Violations result in immediate content removal and account termination'), 'consequences stated');
  const hotlineCount = APP_JS.split('1-888-373-7888').length - 1;
  assert.ok(hotlineCount >= 13, `hotline number in every language's terms (found ${hotlineCount})`);
  // Cross-link from the 2257 complaints surface.
  const st = viewBody(APP_JS, 'vStatement2257', null);
  assert.ok(st.includes('SlutCamp prohibits human trafficking and sexual exploitation (Terms of Service, section 13)'),
    '2257 page cross-links the policy');
  assert.ok(st.includes('National Human Trafficking Hotline (1-888-373-7888)'), 'hotline on the 2257 page');
});

test('/join states the real ID rule (live + cash out), not the old overstatement', () => {
  assert.ok(!SERVER_JS.includes('ID-verified before she can earn'), 'old /join claim must not ship');
  assert.ok(SERVER_JS.includes('every model is ID-verified before she can go live or cash out'), 'corrected /join claim');
});

/* ---------------- live checks ---------------- */

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

async function waitForServer(deadlineMs = 30000) {
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
  for (let attempt = 1; attempt <= 3; attempt++) {
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
      return;
    } catch (e) {
      lastErr = e;
      base = null;
      if (child && child.exitCode === null) child.kill('SIGKILL');
      child = null;
    }
  }
  throw lastErr || new Error('server failed to boot after 3 attempts');
}

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-ccbillready-'));
  for (const f of ['server.js', 'package.json']) {
    fs.copyFileSync(path.join(REPO, f), path.join(tmpDir, f));
  }
  for (const d of ['lib', 'public', 'data']) {
    fs.cpSync(path.join(REPO, d), path.join(tmpDir, d), { recursive: true });
  }
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(tmpDir, 'node_modules'), 'dir');
  await boot();
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
  child = null;
});

test('live: /join carries the corrected ID claim and the legal footer', async () => {
  const r = await fetch(base + '/join');
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.ok(html.includes('ID-verified before she can go live or cash out'));
  assert.ok(!html.includes('before she can earn'));
  for (const href of ['/#terms', '/#privacy', '/#billing', '/#2257', '/#dmca']) {
    assert.ok(html.includes(`href="${href}"`), `/join footer link ${href}`);
  }
  assert.ok(html.includes('Operated by World of Godz Entertainment LLC'));
});

test('live: /models footer carries the legal links + operator line', async () => {
  const r = await fetch(base + '/models');
  assert.equal(r.status, 200);
  const html = await r.text();
  for (const href of ['/#terms', '/#privacy', '/#billing', '/#2257', '/#dmca']) {
    assert.ok(html.includes(`href="${href}"`), `/models footer link ${href}`);
  }
  assert.ok(html.includes('Operated by World of Godz Entertainment LLC'));
});

test('static: the FaceTime scrub migration ships, marker-guarded, authored-text only', () => {
  assert.ok(SERVER_JS.includes("addColumnIfMissing('platform_stats', 'ccbill_cleanup_2026_10_at', 'TEXT')"), 'stamp column');
  assert.ok(SERVER_JS.includes('ccbillReadinessCleanupOnce'), 'migration present');
  assert.ok(SERVER_JS.includes("s.replace(/facetime/gi, 'video call')"), 'case-insensitive replacement');
  assert.ok(SERVER_JS.includes('UPDATE models SET bio'), 'bios scrubbed');
  assert.ok(SERVER_JS.includes('UPDATE tip_menus SET label'), 'tip-menu labels scrubbed');
  assert.ok(SERVER_JS.includes('UPDATE game_items SET label'), 'game-item labels scrubbed');
});

test('static: the username-rename migration ships, marker-guarded, exact pairs only', () => {
  assert.ok(SERVER_JS.includes("addColumnIfMissing('platform_stats', 'ccbill_username_rename_2026_10_at', 'TEXT')"), 'rename stamp column');
  assert.ok(SERVER_JS.includes('ccbillUsernameRenameOnce'), 'rename migration present');
  assert.ok(SERVER_JS.includes("['krazykatz2022@gmail.com', 'krazykatz2022']"), 'pair 1 pinned');
  assert.ok(SERVER_JS.includes("['shadecas27@gmail.com', 'shadecas27']"), 'pair 2 pinned');
  assert.ok(SERVER_JS.includes("if (u.role !== 'model')"), 'role guard: only models are renamed');
  assert.ok(SERVER_JS.includes('UPDATE users SET username = ? WHERE id = ?'), 'rename by user id');
});

test('static: the signup guard ships server-side and the client speaks it in all 13 languages', () => {
  assert.ok(SERVER_JS.includes("if (finalRole === 'model' && String(username).includes('@'))"),
    'guard fires on the resolved model role');
  assert.ok(SERVER_JS.includes("error: 'username_is_email'"), 'guard error code');
  assert.ok(SERVER_JS.includes("Your username can't be an email address — pick a name instead."), 'guard friendly message');
  const keyCount = APP_JS.split('err_username_is_email:').length - 1;
  assert.equal(keyCount, 13, `err_username_is_email in every dictionary (found ${keyCount})`);
  assert.ok(APP_JS.includes("username_is_email: t('err_username_is_email')"), 'signup forms map the error to the friendly toast');
});

test('live: legacy credit buy answers 501 with the clean message', async () => {
  const login = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'fandemo', password: 'fan123' }),
  });
  assert.equal(login.status, 200, 'fandemo login');
  const { token } = await login.json();
  assert.ok(token, 'login token');
  const buy = await fetch(base + '/api/credits/buy', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ package: 'p10' }),
  });
  assert.equal(buy.status, 501);
  const body = await buy.json();
  assert.equal(body.error, 'payment_not_connected');
  assert.equal(body.message, 'Card payments are launching soon.');
});

/* ---------------- boot migration: FaceTime scrub ----------------
 * Launch-wipe-style harness: copy the tree, boot a fresh DB (every
 * one-time stamp is consumed on the empty DB — the production
 * precondition), write "old state" fixtures straight into the stopped
 * DB, NULL the scrub stamp, reboot and read the truth back. */

const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');

function makeCopy2() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-ccbillscrub-'));
  for (const d of ['server.js', 'package.json', 'lib', 'public', 'data']) {
    fs.cpSync(path.join(REPO, d), path.join(dir, d), { recursive: true });
  }
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  return dir;
}

async function boot2(dir) {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), CRYPTO_POLL_MS: '3600000' };
  for (const k of Object.keys(env)) {
    if (/^(CCBILL_|CRYPTO_|OPENAI_|TWILIO_|VAPID_|WEBAUTHN_|SEED_DEMO)/.test(k)) delete env[k];
  }
  const proc = spawn(process.execPath, ['server.js'], { cwd: dir, env });
  let log = '';
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });
  const b = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20000;
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`server exited early (${proc.exitCode})\n${log}`);
    try {
      const r = await fetch(b + '/api/health');
      if (r.ok) break;
    } catch (e) { /* not up yet */ }
    if (Date.now() > deadline) { proc.kill('SIGKILL'); throw new Error(`server did not come up\n${log}`); }
    await new Promise((r) => setTimeout(r, 150));
  }
  return { proc, base: b, log: () => log };
}

function stop2(h) {
  if (h && h.proc && h.proc.exitCode === null) h.proc.kill('SIGKILL');
}

function readDb2(dir, fn) {
  const db = new DatabaseSync(path.join(dir, 'wogent-chat.db'), { readOnly: true });
  try { return fn(db); } finally { db.close(); }
}

test('boot migration: FaceTime scrub fires exactly once, authored text only', { timeout: 240000 }, async (t) => {
  const dir = makeCopy2();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  /* Boot 1 — fresh DB: the scrub consumes its stamp on an empty DB. */
  let h = await boot2(dir);
  stop2(h);
  assert.ok(readDb2(dir, (db) => db.prepare('SELECT ccbill_cleanup_2026_10_at AS s FROM platform_stats WHERE id = 1').get().s),
    'boot 1 stamps the scrub on the empty DB');

  /* Fixtures — the OLD state: FaceTime wording in authored text. */
  const fx = new DatabaseSync(path.join(dir, 'wogent-chat.db'));
  fx.exec('PRAGMA busy_timeout = 10000');
  let aId, bId, fanId;
  try {
    const insUser = fx.prepare(`INSERT INTO users (username, password_hash, role, display_name, dob)
                                  VALUES (?, ?, ?, ?, '1990-01-01')`);
    aId = insUser.run('scrubmodela', bcrypt.hashSync('scrub-pass-a', 10), 'model', 'Scrub A').lastInsertRowid;
    bId = insUser.run('scrubmodelb', bcrypt.hashSync('scrub-pass-b', 10), 'model', 'Scrub B').lastInsertRowid;
    fanId = insUser.run('scrubfan', bcrypt.hashSync('scrub-pass-f', 10), 'fan', 'Scrub Fan').lastInsertRowid;
    fx.prepare('INSERT INTO models (user_id, bio) VALUES (?, ?)').run(aId,
      'Book a private FaceTime 💋 or FACETIME me — facetime fans welcome!');
    fx.prepare('INSERT INTO models (user_id, bio) VALUES (?, ?)').run(bId,
      'No mention here — video call me maybe');
    fx.prepare(`INSERT INTO tip_menus (model_id, emoji, label, price_cents, sort_order)
                VALUES (?, '💋', 'FaceTime date 💋', 500, 0)`).run(aId);
    fx.prepare(`INSERT INTO tip_menus (model_id, emoji, label, price_cents, sort_order)
                VALUES (?, '💋', 'Kiss 💋', 300, 0)`).run(bId);
    fx.prepare(`INSERT INTO game_items (model_id, section, label, price_cents)
                VALUES (?, 'regular', 'facetime special', 500)`).run(aId);
    fx.prepare(`INSERT INTO game_items (model_id, section, label, price_cents)
                VALUES (?, 'regular', 'Dance', 300)`).run(bId);
    // A bought request's label is a purchase-history snapshot — NOT authored text.
    const sessId = fx.prepare('INSERT INTO live_sessions (model_id) VALUES (?)').run(aId).lastInsertRowid;
    fx.prepare(`INSERT INTO game_requests (session_id, model_id, fan_id, label, price_cents, status)
                VALUES (?, ?, ?, 'FaceTime snapshot', 500, 'done')`).run(sessId, aId, fanId);
    // The production precondition: old text exists, the scrub has NOT run on it.
    fx.prepare('UPDATE platform_stats SET ccbill_cleanup_2026_10_at = NULL WHERE id = 1').run();
  } finally { fx.close(); }

  /* Boot 2 — the scrub fires. */
  h = await boot2(dir);
  assert.ok(h.log().includes('[cleanup] CCBill readiness scrub: "FaceTime" replaced with "video call" in 1 model bio(s), 1 tip-menu label(s), 1 game-item label(s).'),
    'boot log reports exactly the scrubbed rows');
  const modelsJson = await (await fetch(h.base + '/api/models')).text();
  assert.ok(!/facetime/i.test(modelsJson), 'public /api/models carries no FaceTime wording after the scrub');
  stop2(h);

  readDb2(dir, (db) => {
    const bioA = db.prepare('SELECT bio FROM models WHERE user_id = ?').get(aId).bio;
    assert.equal(bioA, 'Book a private video call 💋 or video call me — video call fans welcome!');
    const bioB = db.prepare('SELECT bio FROM models WHERE user_id = ?').get(bId).bio;
    assert.equal(bioB, 'No mention here — video call me maybe', 'clean bio untouched');
    assert.equal(db.prepare('SELECT label FROM tip_menus WHERE model_id = ?').get(aId).label, 'video call date 💋');
    assert.equal(db.prepare('SELECT label FROM tip_menus WHERE model_id = ?').get(bId).label, 'Kiss 💋');
    assert.equal(db.prepare('SELECT label FROM game_items WHERE model_id = ?').get(aId).label, 'video call special');
    assert.equal(db.prepare('SELECT label FROM game_items WHERE model_id = ?').get(bId).label, 'Dance');
    assert.equal(db.prepare('SELECT label FROM game_requests WHERE model_id = ?').get(aId).label, 'FaceTime snapshot',
      'purchase-history snapshot is NOT rewritten');
    assert.ok(db.prepare('SELECT ccbill_cleanup_2026_10_at AS s FROM platform_stats WHERE id = 1').get().s, 'stamp set');
  });

  /* Boot 3 — the stamp holds: a NEW FaceTime bio written after the
   * scrub survives, proving the pass is one-time (marker-guarded),
   * not an every-boot rewrite. */
  const fx2 = new DatabaseSync(path.join(dir, 'wogent-chat.db'));
  try {
    fx2.prepare("UPDATE models SET bio = 'FaceTime forever' WHERE user_id = ?").run(bId);
  } finally { fx2.close(); }
  h = await boot2(dir);
  stop2(h);
  assert.ok(!h.log().includes('[cleanup] CCBill readiness scrub'), 'no second run in the boot log');
  readDb2(dir, (db) => {
    assert.equal(db.prepare('SELECT bio FROM models WHERE user_id = ?').get(bId).bio, 'FaceTime forever',
      'post-stamp text is not rewritten — the pass ran exactly once');
  });
});

/* ---------------- boot migration: username renames ----------------
 * Same old-state harness: fresh boot consumes the rename stamp,
 * fixtures write the production precondition (two models whose
 * username is a Gmail address), the stamp is NULLed, reboot. */

test('boot migration: username renames fire exactly once, guarded to the two models', { timeout: 240000 }, async (t) => {
  const dir = makeCopy2();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  /* Boot 1 — fresh DB: the rename pass consumes its stamp empty. */
  let h = await boot2(dir);
  stop2(h);
  assert.ok(readDb2(dir, (db) => db.prepare('SELECT ccbill_username_rename_2026_10_at AS s FROM platform_stats WHERE id = 1').get().s),
    'boot 1 stamps the rename pass on the empty DB');

  /* Fixtures — the OLD state, plus accounts that must never move. */
  const fx = new DatabaseSync(path.join(dir, 'wogent-chat.db'));
  fx.exec('PRAGMA busy_timeout = 10000');
  let katId, ashaId, fanMailId, ccbillId;
  try {
    const insUser = fx.prepare(`INSERT INTO users (username, password_hash, role, display_name, dob)
                                  VALUES (?, ?, ?, ?, '1990-01-01')`);
    katId = insUser.run('krazykatz2022@gmail.com', bcrypt.hashSync('kat-pass-1', 10), 'model', 'Kat-Licious').lastInsertRowid;
    ashaId = insUser.run('shadecas27@gmail.com', bcrypt.hashSync('asha-pass-1', 10), 'model', 'Fat.p.Asha').lastInsertRowid;
    fanMailId = insUser.run('somefan@gmail.com', bcrypt.hashSync('fan-pass-1', 10), 'fan', 'Mail Fan').lastInsertRowid;
    ccbillId = insUser.run('ccbillreview', bcrypt.hashSync('review-pass-1', 10), 'fan', 'CCBill Review').lastInsertRowid;
    fx.prepare('INSERT INTO models (user_id, bio) VALUES (?, ?)').run(katId, 'Kat bio');
    fx.prepare('INSERT INTO models (user_id, bio) VALUES (?, ?)').run(ashaId, 'Asha bio');
    fx.prepare('UPDATE platform_stats SET ccbill_username_rename_2026_10_at = NULL WHERE id = 1').run();
  } finally { fx.close(); }

  /* Boot 2 — the renames fire. */
  h = await boot2(dir);
  assert.ok(h.log().includes('[cleanup] username renamed: krazykatz2022@gmail.com → krazykatz2022'), 'rename 1 logged');
  assert.ok(h.log().includes('[cleanup] username renamed: shadecas27@gmail.com → shadecas27'), 'rename 2 logged');
  const modelsJson = await (await fetch(h.base + '/api/models')).text();
  assert.ok(modelsJson.includes('"username":"krazykatz2022"'), 'public roster shows the new sign-in name');
  assert.ok(modelsJson.includes('"username":"shadecas27"'), 'public roster shows the new sign-in name');
  assert.ok(!modelsJson.includes('@gmail.com'), 'no Gmail username stays public after the rename');
  // The models were emailed first: new sign-in name, SAME password.
  const login = await fetch(h.base + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'krazykatz2022', password: 'kat-pass-1' }),
  });
  assert.equal(login.status, 200, 'renamed model signs in with the new name + same password');
  const oldLogin = await fetch(h.base + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'krazykatz2022@gmail.com', password: 'kat-pass-1' }),
  });
  assert.notEqual(oldLogin.status, 200, 'the old Gmail sign-in name no longer resolves');
  stop2(h);

  readDb2(dir, (db) => {
    assert.equal(db.prepare('SELECT username FROM users WHERE id = ?').get(katId).username, 'krazykatz2022');
    assert.equal(db.prepare('SELECT username FROM users WHERE id = ?').get(ashaId).username, 'shadecas27');
    assert.equal(db.prepare('SELECT username FROM users WHERE id = ?').get(fanMailId).username, 'somefan@gmail.com',
      'a fan with an email-shaped username is NOT renamed (models only)');
    assert.equal(db.prepare('SELECT username FROM users WHERE id = ?').get(ccbillId).username, 'ccbillreview',
      'the CCBill review account is untouched');
    assert.ok(db.prepare('SELECT ccbill_username_rename_2026_10_at AS s FROM platform_stats WHERE id = 1').get().s, 'rename stamp set');
  });

  /* Boot 3 — one-time semantics: even if the old Gmail username
   * somehow reappears, the stamped pass never runs again. */
  const fx2 = new DatabaseSync(path.join(dir, 'wogent-chat.db'));
  try {
    fx2.prepare("UPDATE users SET username = 'krazykatz2022@gmail.com' WHERE id = ?").run(katId);
  } finally { fx2.close(); }
  h = await boot2(dir);
  stop2(h);
  assert.ok(!h.log().includes('[cleanup] username renamed'), 'no second rename run in the boot log');
  readDb2(dir, (db) => {
    assert.equal(db.prepare('SELECT username FROM users WHERE id = ?').get(katId).username, 'krazykatz2022@gmail.com',
      'post-stamp rows are not renamed — the pass ran exactly once');
  });
});

test('boot migration: rename guards skip a taken target and a non-model row', { timeout: 240000 }, async (t) => {
  const dir = makeCopy2();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  let h = await boot2(dir);
  stop2(h);

  const fx = new DatabaseSync(path.join(dir, 'wogent-chat.db'));
  fx.exec('PRAGMA busy_timeout = 10000');
  let katId, ashaId;
  try {
    const insUser = fx.prepare(`INSERT INTO users (username, password_hash, role, display_name, dob)
                                  VALUES (?, ?, ?, ?, '1990-01-01')`);
    // Pair 1 blocked: the target name is already somebody else's.
    insUser.run('krazykatz2022', bcrypt.hashSync('squat-pass', 10), 'fan', 'Squatter');
    katId = insUser.run('krazykatz2022@gmail.com', bcrypt.hashSync('kat-pass-1', 10), 'model', 'Kat-Licious').lastInsertRowid;
    // Pair 2 blocked: the Gmail row exists but is NOT a model.
    ashaId = insUser.run('shadecas27@gmail.com', bcrypt.hashSync('asha-pass-1', 10), 'fan', 'Not A Model').lastInsertRowid;
    fx.prepare('INSERT INTO models (user_id, bio) VALUES (?, ?)').run(katId, 'Kat bio');
    fx.prepare('UPDATE platform_stats SET ccbill_username_rename_2026_10_at = NULL WHERE id = 1').run();
  } finally { fx.close(); }

  h = await boot2(dir);
  stop2(h);
  assert.ok(h.log().includes("[cleanup] username rename SKIPPED for krazykatz2022@gmail.com: target 'krazykatz2022' is already taken."),
    'taken-target skip is logged, not forced');
  assert.ok(h.log().includes("[cleanup] username rename SKIPPED for shadecas27@gmail.com: role is 'fan', not 'model'."),
    'wrong-role skip is logged, not forced');
  readDb2(dir, (db) => {
    assert.equal(db.prepare('SELECT username FROM users WHERE id = ?').get(katId).username, 'krazykatz2022@gmail.com',
      'the blocked rename did not happen');
    assert.equal(db.prepare('SELECT username FROM users WHERE id = ?').get(ashaId).username, 'shadecas27@gmail.com',
      'the non-model row is untouched');
    assert.ok(db.prepare('SELECT ccbill_username_rename_2026_10_at AS s FROM platform_stats WHERE id = 1').get().s,
      'the pass still stamps — a guard skip is final, not retried every boot');
  });
});

/* ---------------- signup guard ---------------- */

test('signup guard: an email-shaped MODEL username is kicked back and creates no account', { timeout: 240000 }, async (t) => {
  const dir = makeCopy2();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const h = await boot2(dir);
  t.after(() => stop2(h));
  const signup = (body) => fetch(h.base + '/api/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const baseBody = { password: 'secret1', dob: '1995-05-05', agree18: true };

  const bad = await signup({ ...baseBody, username: 'newmodel@gmail.com', role: 'model', display_name: 'New Model', section: 'female' });
  assert.equal(bad.status, 400, 'email-shaped model username is rejected');
  const badBody = await bad.json();
  assert.equal(badBody.error, 'username_is_email');
  assert.equal(badBody.message, "Your username can't be an email address — pick a name instead.");

  // The rejection created nothing: signing in as the ghost fails.
  const ghostLogin = await fetch(h.base + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'newmodel@gmail.com', password: 'secret1' }),
  });
  assert.notEqual(ghostLogin.status, 200, 'no ghost account behind the rejection');

  const good = await signup({ ...baseBody, username: 'newmodel', role: 'model', display_name: 'New Model', section: 'female' });
  assert.equal(good.status, 200, 'a normal model username signs up fine');
  const goodBody = await good.json();
  assert.equal(goodBody.user.username, 'newmodel');

  // The guard is model-scoped (the owner ordered models): a FAN
  // signup with an email-shaped username is not blocked by it.
  const fan = await signup({ ...baseBody, username: 'fan@gmail.com', role: 'fan', display_name: 'New Fan' });
  assert.equal(fan.status, 200, 'fan signup is outside the guard scope');
  stop2(h);

  readDb2(dir, (db) => {
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE username = 'newmodel@gmail.com'").get().n, 0,
      'the rejected signup left no user row');
  });
});
