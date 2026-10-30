'use strict';
/*
 * Auto-clip engine (Assignment 21, spec a21-auto-clip-spec-2026-10-28).
 *
 * What is under test (boots the REAL server.js, SEED_DEMO=1 throwaway
 * DB, CLIP_SWEEP_MS=400 so the engine's sweep is observable):
 * - Static pins: clips + rules_flags tables, the promo_autopost kill
 *   switch + threshold columns, the v1.7 consent constant, the flip
 *   hook next to A20's, the steering hook, the dormant X adapter, the
 *   vision/recorder INTERFACE STUB, the Manager Clips screen + routes,
 *   and the spec's wording rule (the product language is "clips" —
 *   the banned phrase never appears in the engine block).
 * - Flag OFF (default): a money moment with agreeing chat + viewer
 *   spikes logs a HIGH held clip and posts NOTHING.
 * - Money detection: a single tip/gift under the threshold makes no
 *   candidate; a 60s burst over the threshold does (medium — money
 *   alone); an overlapping later moment MERGES into the held clip.
 * - Exclusions: Male section, the house account and a Private Room
 *   session never produce clips, however big the gift.
 * - Rules watch: a pending co-performer packet + explicit flip flags
 *   (evidence, resolvable in the Manager); the model's own obfuscated
 *   steering message flags with its excerpt while the message itself
 *   posts normally and the live is untouched (never punishes); a
 *   clean message flags nothing.
 * - Settings: PUT /api/admin/settings validates promo_autopost (0/1)
 *   and clip_money_threshold_cents (range), bad values 400.
 * - Consent gate (boot 2, X stub configured): flag ON + a high clip
 *   still posts NOTHING until a v1.7 contract_signatures row exists;
 *   then the clip posts to the stub with her canonical link in the
 *   caption and the tweet URL lands on the clip row.
 * - Posting rules: max 3 posts per live and 15-minute spacing,
 *   exercised by backdating posted_at between sweep passes.
 *
 * The X "API" in boot 2 is a local HTTP stub — nothing real is ever
 * posted. Manager-login budget: 1 login per boot.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const REPO = path.join(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
const mgrSrc = fs.readFileSync(path.join(REPO, 'public/manager/manager.js'), 'utf8');
const MGRH = { 'x-manager': '1' };

/* ---------------- Part A: static pins ---------------- */

test('A21 server pins: tables, flag, consent gate, hooks, dormant adapter, vision stub', () => {
  assert.ok(serverSrc.includes('CREATE TABLE IF NOT EXISTS clips'), 'clips table declared');
  assert.ok(serverSrc.includes('CREATE TABLE IF NOT EXISTS rules_flags'), 'rules_flags table declared');
  assert.ok(serverSrc.includes("addColumnIfMissing('platform_stats', 'promo_autopost', 'INTEGER NOT NULL DEFAULT 0')"),
    'kill switch column, default OFF');
  assert.ok(serverSrc.includes("addColumnIfMissing('platform_stats', 'clip_money_threshold_cents', 'INTEGER NOT NULL DEFAULT 2000')"),
    'money threshold column, default $20');
  assert.ok(serverSrc.includes("const CLIP_CONSENT_VERSION = '1.7'"), 'consent pinned to Agreement v1.7');
  assert.ok(serverSrc.includes('sig.contract_version === CLIP_CONSENT_VERSION'),
    'consent reads her latest model-agreement signature');
  assert.ok(serverSrc.includes('if (isExplicit && !sess.is_explicit) maybeClipWatch(sess);'),
    'engine arms on the same 0→1 flip as A20');
  assert.ok(serverSrc.includes('if (end > nowE) continue; // window still open'),
    'a window is scored only once it has closed (complete signal picture)');
  assert.ok(serverSrc.includes('if (end > nowE) continue;'),
    'merged windows defer scoring until close as well');
  assert.ok(serverSrc.includes('maybeClipSteeringFlag(sess, req.user, body, msg.id)'),
    'steering watch hooks the live-chat insert');
  assert.ok(serverSrc.includes("reason: 'x_not_configured'"), 'X adapter dormant without a token');
  assert.ok(serverSrc.includes('https://slutcamp.app/models/'), 'captions carry her canonical link');
  assert.ok(serverSrc.includes('`${SOCIAL_X_URL}/status/${j.data.id}`'),
    'tweet URLs derive from the one brand constant (social-links pin: a single x.com base)');
  assert.ok(serverSrc.includes('Come join our SlutCamp'), 'spec caption template 1');
  assert.ok(serverSrc.includes('Sluts gon wild'), 'spec caption template 2');
  const block = serverSrc.slice(serverSrc.indexOf('AUTO-CLIP ENGINE'),
    serverSrc.indexOf('Total unread DM messages'));
  assert.ok(block.includes('INTERFACE STUB'), 'vision/recorder layer is a marked interface stub');
  assert.ok(block.includes("vision: 'no_signal'"), 'the stub returns no-signal honestly');
  assert.ok(block.includes('LOCAL-FIRST') && block.includes('NSFWJS'),
    'vision scoring is documented LOCAL-FIRST on the in-production NSFWJS model');
  assert.ok(block.includes('confirmed adult use in writing'),
    'no paid vision API may score explicit frames without written adult-use confirmation');
  assert.ok(!/screen[\s-]?record/i.test(block), 'spec wording: "clips", never the banned phrase');
  assert.ok(block.includes("sess.private_event_id"), 'private-room wall in the scope gate');
  assert.ok(block.includes('isHouseAccountId(sess.model_id)'), 'house excluded in the scope gate');
  assert.ok(serverSrc.includes("app.get('/api/admin/clips'"), 'Manager clips route');
  assert.ok(serverSrc.includes("app.post('/api/admin/rules-flags/:id/resolve'"), 'flag resolve route');
  assert.ok(serverSrc.includes("error: 'bad_promo_autopost'"), 'flag validation');
  assert.ok(serverSrc.includes("error: 'bad_clip_threshold'"), 'threshold validation');
  assert.ok(serverSrc.includes('CLIP_POST_CAP_PER_LIVE = 3'), 'spec cap: 3 posts per live');
  assert.ok(serverSrc.includes('CLIP_POST_SPACING_SEC = 15 * 60'), 'spec spacing: 15 minutes');
});

test('A21 manager pins: Clips screen next to Promos + Settings kill-switch card', () => {
  assert.ok(mgrSrc.includes("['clips', '🎬 Clips']"), 'Clips nav entry');
  assert.ok(mgrSrc.includes("'invites', 'promos', 'clips'"), 'Clips sits in Growth next to promos');
  assert.ok(mgrSrc.includes('clips: adminClipsBody'), 'screen registered');
  assert.ok(mgrSrc.includes("api('/admin/clips')"), 'screen reads the clips log');
  assert.ok(mgrSrc.includes('id="set-autopost"'), 'Settings kill-switch checkbox');
  assert.ok(mgrSrc.includes("id=\"set-autopost-go\"") || mgrSrc.includes('set-autopost-go'), 'Settings save wired');
  assert.ok(mgrSrc.includes('data-flag-resolve'), 'flag resolve buttons');
});

/* ---------------- harness (promo-ping pattern) ---------------- */

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
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
    if (/^(CCBILL_|CRYPTO_|OPENAI_|TWILIO_|VAPID_|WEBAUTHN_|AV_)/.test(k) && !(k in extraEnv)) delete env[k];
  }
  env.SEED_DEMO = '1';
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
const PNG = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001080600000'
  + '01f15c4890000000a49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082', 'hex');
async function upload(base, p, token) {
  const fd = new FormData();
  for (const f of ['id_front', 'id_back', 'selfie']) fd.append(f, new Blob([PNG], { type: 'image/png' }), `${f}.png`);
  const r = await fetch(base + p, { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: fd });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
  return { status: r.status, text, json };
}
function openDb(dir, readOnly = true) {
  const db = new DatabaseSync(path.join(dir, 'wogent-chat.db'), readOnly ? { readOnly: true } : {});
  db.exec('PRAGMA busy_timeout = 10000');
  return db;
}
async function waitFor(cond, ms = 12000) {
  const start = Date.now();
  for (;;) {
    if (cond()) return true;
    if (Date.now() - start > ms) return false;
    await new Promise((r) => setTimeout(r, 120));
  }
}
/* A post is COMPLETE when the clips row says so — not when the X stub
 * logs the hit. The stub records the request the moment the engine
 * SENDS it; the engine marks the clip 'posted' only after the stub's
 * response round-trips back and its UPDATE commits. Waiting on the
 * hit count alone and then reading the row races that commit: under
 * gate-level CPU contention the read can land first and see 'held'
 * (the flake that sank the A16/A11/A12 gates and geo pass 2, always
 * at the same assertion). Poll the real end state instead — stub
 * hits AND the session's posted rows — with a deadline sized for a
 * loaded box (a post needs a full sweep cycle + HTTP round trip +
 * commit, and a starved sweep stretches seconds, not milliseconds). */
async function waitForPosted(dir, sessionId, hits, hitCount, postedCount, ms = 90000) {
  return waitFor(() => hits.length === hitCount
    && clipsFor(dir, sessionId).filter((c) => c.status === 'posted').length === postedCount, ms);
}
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const tsOf = (sec) => new Date(sec * 1000).toISOString().slice(0, 19).replace('T', ' ');
const nowSec = () => Math.floor(Date.now() / 1000);

async function mgrLogin(base) {
  const mgr = await req(base, 'POST', '/api/manager/login', { body: { username: 'admin', password: 'admin123' } });
  assert.equal(mgr.status, 200, `manager login: ${mgr.text}`);
  return { token: mgr.json.token, headers: MGRH };
}

/* A model the way the app makes one (promo-ping pattern): signup → ID
 * packet → WOGENT release → Manager approval → live. */
async function makeLiveModel(base, MGR, username, section) {
  const s = await req(base, 'POST', '/api/auth/signup', {
    body: { username, password: 'hunter22', role: 'model', display_name: username,
      dob: '1995-05-05', agree18: true, section, publicity_consent: true },
  });
  assert.equal(s.status, 200, `signup ${username}: ${s.text}`);
  const acct = { token: s.json.token, id: s.json.user.id, username };
  const up = await upload(base, '/api/model/id-verification', acct.token);
  assert.equal(up.status, 200, `ID upload ${username}: ${up.text}`);
  const sign = await req(base, 'POST', '/api/model/release/sign', { token: acct.token, body: {
    legal_name: 'Test Signer', stage_name: username, dob: '1995-05-05',
    attestations: { adult: true, freewill: true, rights: true } } });
  assert.equal(sign.status, 200, `release sign ${username}: ${sign.text}`);
  const q = await req(base, 'GET', '/api/admin/id-verifications', { ...MGR });
  const row = q.json.verifications.find((v) => v.model_id === acct.id && !v.co_performer_id);
  assert.ok(row, `ID submission queued for ${username}`);
  const ap = await req(base, 'POST', `/api/admin/id-verifications/${row.id}/approve`, { ...MGR });
  assert.equal(ap.status, 200, `approve ${username}: ${ap.text}`);
  const live = await req(base, 'POST', '/api/live/start', { token: acct.token, body: { title: `${username} live` } });
  assert.equal(live.status, 200, `live start ${username}: ${live.text}`);
  return { ...acct, sessionId: live.json.session_id };
}
const flip = (base, acct, sessionId, on) =>
  req(base, 'POST', `/api/live/${sessionId}/mode`, { token: acct.token, body: { is_explicit: on } });

/* Fixtures written straight into the ledger tables — the exact row
 * shapes the real spend/chat paths write. */
function giftId(db) {
  const g = db.prepare('SELECT id FROM gifts ORDER BY id LIMIT 1').get();
  assert.ok(g, 'seeded gift catalog present');
  return g.id;
}
function addGift(db, sessionId, fanId, gid, cents, atSec) {
  db.prepare(`INSERT INTO gift_events (session_id, fan_id, gift_id, gross_cents, model_cents, platform_cents, created_at)
              VALUES (?,?,?,?,?,?,?)`).run(sessionId, fanId, gid, cents, 0, 0, tsOf(atSec));
}
function addChatBurst(db, sessionId, senderId, n, centerSec, spreadSec = 8) {
  const ins = db.prepare('INSERT INTO stream_chat (session_id, sender_id, body, created_at) VALUES (?,?,?,?)');
  for (let i = 0; i < n; i++) {
    const at = centerSec - spreadSec + Math.floor((2 * spreadSec * i) / Math.max(1, n - 1));
    ins.run(sessionId, senderId, 'lets gooo', tsOf(at));
  }
}
function clipsFor(dir, sessionId) {
  const db = openDb(dir);
  try { return db.prepare('SELECT * FROM clips WHERE session_id = ? ORDER BY id').all(sessionId); }
  finally { db.close(); }
}
function flagsFor(dir, modelId, type) {
  const db = openDb(dir);
  try {
    return db.prepare('SELECT * FROM rules_flags WHERE model_id = ? AND type = ? ORDER BY id').all(modelId, type);
  } finally { db.close(); }
}
function userId(dir, username) {
  const db = openDb(dir);
  try { return db.prepare('SELECT id FROM users WHERE username = ?').get(username).id; }
  finally { db.close(); }
}

/* ---------------- Part B: boot 1 — flag OFF ---------------- */

test('B: detection, tiers, merge, exclusions, rules watch, settings validation (flag OFF)',
  { timeout: 300000 }, async (t) => {
    const dir = makeCopy('a21off');
    const h = await boot(dir, { CLIP_SWEEP_MS: '400', X_BEARER_TOKEN: '' });
    t.after(() => { stop(h); fs.rmSync(dir, { recursive: true, force: true }); });

    const MGR = await mgrLogin(h.base); // manager login #1 (only)
    const fem1 = await makeLiveModel(h.base, MGR, 'a21fem1', 'female');
    const fem2 = await makeLiveModel(h.base, MGR, 'a21fem2', 'female');
    const male = await makeLiveModel(h.base, MGR, 'a21male', 'male');
    const house = await makeLiveModel(h.base, MGR, 'asceaaspade', 'female');
    const fem3 = await makeLiveModel(h.base, MGR, 'a21fem3', 'female');
    const fanId = userId(dir, 'fandemo');

    const wdb = openDb(dir, false);
    const gid = giftId(wdb);

    /* --- B1: money + chat spike + viewer spike → HIGH held, no post --- */
    const f1 = await flip(h.base, fem1, fem1.sessionId, true);
    assert.equal(f1.status, 200, `fem1 flip: ${f1.text}`);
    const t1 = nowSec() - 120; // a fully-developed moment: its window has closed
    addGift(wdb, fem1.sessionId, fanId, gid, 2500, t1);
    addChatBurst(wdb, fem1.sessionId, fanId, 12, t1);
    // Viewer spike: every other existing user "joins" inside the window.
    const others = wdb.prepare('SELECT id FROM users WHERE id != ?').all(fem1.id).map((r) => r.id);
    assert.ok(others.length >= 8, `enough users for a viewer spike (${others.length})`);
    const insV = wdb.prepare('INSERT OR IGNORE INTO live_viewers (session_id, fan_id, joined_at) VALUES (?,?,?)');
    for (const id of others) insV.run(fem1.sessionId, id, tsOf(t1));
    assert.ok(await waitFor(() => clipsFor(dir, fem1.sessionId).length === 1),
      'one clip candidate logged');
    let clips = clipsFor(dir, fem1.sessionId);
    assert.equal(clips[0].status, 'held', 'flag OFF → held, never posted');
    assert.equal(clips[0].tier, 'high', 'money + chat + viewer agreement → high');
    assert.ok(clips[0].score >= 70, `score ${clips[0].score} >= 70`);
    assert.equal(clips[0].tweet_url, null, 'no tweet URL while held');
    const sig1 = JSON.parse(clips[0].signals);
    assert.equal(sig1.money_total_cents, 2500, 'signals carry the exact ledger total');
    assert.equal(sig1.chat_spike, true, 'chat spike recorded');
    assert.equal(sig1.viewer_spike, true, 'viewer spike recorded');
    // The Manager sees it, with the flag OFF.
    const mgrClips = await req(h.base, 'GET', '/api/admin/clips', { ...MGR });
    assert.equal(mgrClips.status, 200, `admin clips: ${mgrClips.text}`);
    assert.equal(mgrClips.json.promo_autopost, false, 'Manager reports the flag OFF');
    assert.ok(mgrClips.json.clips.some((c) => c.id === clips[0].id && c.username === 'a21fem1'),
      'Manager log names the clip + model');

    /* --- B1b: a moment arriving in REAL time is scored only when its
           window closes — never frozen mid-burst at a lower tier --- */
    const fem1b = await makeLiveModel(h.base, MGR, 'a21fem1b', 'female');
    await flip(h.base, fem1b, fem1b.sessionId, true);
    const tb = nowSec();
    addGift(wdb, fem1b.sessionId, fanId, gid, 2500, tb);
    addChatBurst(wdb, fem1b.sessionId, fanId, 12, tb);
    await settle(2400); // several sweeps pass; the window (tb-15 .. tb+15) is still open
    assert.equal(clipsFor(dir, fem1b.sessionId).length, 0,
      'window still open → nothing scored yet');
    assert.ok(await waitFor(() => clipsFor(dir, fem1b.sessionId).length === 1, 45000),
      'once the window closes, the clip lands');
    const b1b = clipsFor(dir, fem1b.sessionId)[0];
    assert.equal(b1b.tier, 'high', 'scored on the complete window: money + chat spike → high');
    assert.equal(b1b.status, 'held', 'flag OFF → held');

    /* --- B2: under-threshold single = nothing; burst = medium; overlap merges --- */
    await flip(h.base, fem2, fem2.sessionId, true);
    const t2 = nowSec() - 400; // past-anchored timeline: every window below has closed
    addGift(wdb, fem2.sessionId, fanId, gid, 1500, t2); // $15 < $20 threshold
    await settle(1600);
    assert.equal(clipsFor(dir, fem2.sessionId).length, 0, 'single under threshold → no candidate');
    addGift(wdb, fem2.sessionId, fanId, gid, 800, t2 + 100);
    addGift(wdb, fem2.sessionId, fanId, gid, 800, t2 + 120);
    addGift(wdb, fem2.sessionId, fanId, gid, 800, t2 + 140); // burst: $24 in 40s
    assert.ok(await waitFor(() => clipsFor(dir, fem2.sessionId).length === 1),
      'burst over threshold → one candidate');
    clips = clipsFor(dir, fem2.sessionId);
    assert.equal(clips[0].tier, 'medium', 'money alone (no supporting signal) → medium');
    assert.equal(clips[0].score, 50, 'money-only score is 50');
    assert.equal(JSON.parse(clips[0].signals).money_total_cents, 2400, 'burst total is exact');
    // A later big gift whose window overlaps the held clip MERGES into it.
    addGift(wdb, fem2.sessionId, fanId, gid, 2500, t2 + 165);
    assert.ok(await waitFor(() => {
      const cs = clipsFor(dir, fem2.sessionId);
      return cs.length === 1 && JSON.parse(cs[0].signals).money_total_cents === 4900;
    }), 'overlapping moment merged into the held clip');
    clips = clipsFor(dir, fem2.sessionId);
    assert.equal(clips.length, 1, 'still exactly one clip after the merge');
    assert.equal(clips[0].score, 60, 'merged total ≥ 2× threshold adds the big-moment points');

    /* --- B3: exclusions — male, house, private room --- */
    await flip(h.base, male, male.sessionId, true);
    addGift(wdb, male.sessionId, fanId, gid, 5000, nowSec() - 120);
    await flip(h.base, house, house.sessionId, true);
    addGift(wdb, house.sessionId, fanId, gid, 5000, nowSec() - 120);
    const priv = wdb.prepare(
      "INSERT INTO live_sessions (model_id, status, is_explicit, private_event_id) VALUES (?, 'live', 1, 999001)")
      .run(fem1.id);
    const privId = Number(priv.lastInsertRowid);
    addGift(wdb, privId, fanId, gid, 5000, nowSec() - 120);
    await settle(2000);
    assert.equal(clipsFor(dir, male.sessionId).length, 0, 'Male section never clips');
    assert.equal(clipsFor(dir, house.sessionId).length, 0, 'house account never clips');
    assert.equal(clipsFor(dir, privId).length, 0, 'Private Room session never clips');

    /* --- B4: co-performer cross-check flag + Manager resolve --- */
    wdb.prepare("INSERT INTO co_performers (owner_model_id, display_name, status) VALUES (?, 'Partner Pending', 'pending')")
      .run(fem3.id);
    await flip(h.base, fem3, fem3.sessionId, true);
    assert.ok(await waitFor(() => flagsFor(dir, fem3.id, 'coperformer_unapproved').length === 1),
      'pending co-performer + explicit flip → one flag');
    const flag = flagsFor(dir, fem3.id, 'coperformer_unapproved')[0];
    assert.ok(flag.evidence.includes('Partner Pending'), 'flag evidence names the pending packet');
    assert.equal(flag.status, 'open', 'flag starts open');
    assert.equal(flagsFor(dir, fem1.id, 'coperformer_unapproved').length, 0,
      'no co-performers → no flag');
    const mgrFlags = await req(h.base, 'GET', '/api/admin/clips', { ...MGR });
    assert.ok(mgrFlags.json.flags.some((f) => f.id === flag.id && f.username === 'a21fem3'),
      'Manager flags list carries it');
    const rz = await req(h.base, 'POST', `/api/admin/rules-flags/${flag.id}/resolve`, { ...MGR, body: {} });
    assert.equal(rz.status, 200, `flag resolve: ${rz.text}`);
    assert.equal(flagsFor(dir, fem3.id, 'coperformer_unapproved')[0].status, 'resolved',
      'resolve closes the flag');
    wdb.close();

    /* --- B5: steering watch — flags the excerpt, punishes nothing --- */
    const steer = await req(h.base, 'POST', `/api/live/${fem1.sessionId}/chat`, {
      token: fem1.token, body: { body: 'tip me through my c a s h a p p instead' } });
    assert.equal(steer.status, 200, `steering message itself posts normally: ${steer.text}`);
    assert.ok(await waitFor(() => flagsFor(dir, fem1.id, 'offplatform_steering').length === 1),
      'obfuscated steering → flag');
    const sflag = flagsFor(dir, fem1.id, 'offplatform_steering')[0];
    assert.ok(sflag.evidence.includes('steering_obfuscated_payment'), 'flag names the pattern');
    assert.ok(sflag.evidence.includes('c a s h a p p'), 'flag preserves the excerpt');
    const clean = await req(h.base, 'POST', `/api/live/${fem1.sessionId}/chat`, {
      token: fem1.token, body: { body: 'welcome in everyone, say hi and stay awhile' } });
    assert.equal(clean.status, 200, `clean message posts: ${clean.text}`);
    await settle(1200);
    assert.equal(flagsFor(dir, fem1.id, 'offplatform_steering').length, 1, 'clean message flags nothing');
    const sessRow = (() => { const db = openDb(dir); try {
      return db.prepare('SELECT is_explicit FROM live_sessions WHERE id = ?').get(fem1.sessionId);
    } finally { db.close(); } })();
    assert.equal(sessRow.is_explicit, 1, 'the live is untouched — the watch never punishes');

    /* --- B6: settings validation --- */
    const bad1 = await req(h.base, 'PUT', '/api/admin/settings', { ...MGR, body: { promo_autopost: 2 } });
    assert.equal(bad1.status, 400, `flag 2 rejected: ${bad1.text}`);
    assert.equal(bad1.json.error, 'bad_promo_autopost');
    const bad2 = await req(h.base, 'PUT', '/api/admin/settings', { ...MGR, body: { clip_money_threshold_cents: 50 } });
    assert.equal(bad2.status, 400, `threshold $0.50 rejected: ${bad2.text}`);
    assert.equal(bad2.json.error, 'bad_clip_threshold');
    const okSet = await req(h.base, 'PUT', '/api/admin/settings', { ...MGR, body: { clip_money_threshold_cents: 3000 } });
    assert.equal(okSet.status, 200, `threshold $30 accepted: ${okSet.text}`);
    const mgrAfter = await req(h.base, 'GET', '/api/admin/clips', { ...MGR });
    assert.equal(mgrAfter.json.clip_money_threshold_cents, 3000, 'Manager reads the new threshold');
    const reset = await req(h.base, 'PUT', '/api/admin/settings', { ...MGR, body: { clip_money_threshold_cents: 2000 } });
    assert.equal(reset.status, 200, 'threshold reset');
  });

/* ---------------- Part C: boot 2 — consent gate + posting rules ---------------- */

test('C: consent gate, then cap + spacing behind flag ON (X stub)',
  { timeout: 300000 }, async (t) => {
    const hits = [];
    const stub = http.createServer((rq, rs) => {
      let b = '';
      rq.on('data', (c) => { b += c; });
      rq.on('end', () => {
        hits.push({ url: rq.url, body: b });
        rs.writeHead(201, { 'content-type': 'application/json' });
        rs.end(JSON.stringify({ data: { id: '17999' } }));
      });
    });
    await new Promise((r) => stub.listen(0, '127.0.0.1', r));
    t.after(() => stub.close());

    const dir = makeCopy('a21on');
    const h = await boot(dir, {
      CLIP_SWEEP_MS: '400',
      X_BEARER_TOKEN: 'test-token',
      X_API_BASE: `http://127.0.0.1:${stub.address().port}`,
    });
    t.after(() => { stop(h); fs.rmSync(dir, { recursive: true, force: true }); });

    const MGR = await mgrLogin(h.base); // manager login #1 (only)
    const on = await req(h.base, 'PUT', '/api/admin/settings', { ...MGR, body: { promo_autopost: 1 } });
    assert.equal(on.status, 200, `flag ON: ${on.text}`);

    const fem = await makeLiveModel(h.base, MGR, 'a21cfem', 'female');
    const fanId = userId(dir, 'fandemo');
    const wdb = openDb(dir, false);
    const gid = giftId(wdb);

    /* --- C1: flag ON + high clip, but NO v1.7 signature → nothing posts --- */
    await flip(h.base, fem, fem.sessionId, true);
    const t1 = nowSec() - 120; // a fully-developed moment: its window has closed
    addGift(wdb, fem.sessionId, fanId, gid, 2500, t1);
    addChatBurst(wdb, fem.sessionId, fanId, 12, t1); // chat spike → 70 = high
    assert.ok(await waitFor(() => clipsFor(dir, fem.sessionId).length === 1, 45000), 'high clip logged');
    assert.equal(clipsFor(dir, fem.sessionId)[0].tier, 'high', 'money + chat spike → high');
    await settle(2200);
    assert.equal(hits.length, 0, 'consent gate: flag ON alone posts NOTHING');
    assert.equal(clipsFor(dir, fem.sessionId)[0].status, 'held', 'clip waits, held');

    // She accepts Agreement v1.7 (fixture row — the version does not
    // exist yet; this is exactly the signature the gate will read).
    wdb.prepare("INSERT INTO contract_signatures (user_id, contract_version, display_name) VALUES (?, '1.7', 'Test Signer')")
      .run(fem.id);
    assert.ok(await waitForPosted(dir, fem.sessionId, hits, 1, 1), 'with consent, the high clip posts');
    const posted = clipsFor(dir, fem.sessionId)[0];
    assert.equal(posted.status, 'posted', 'clip marked posted');
    assert.equal(posted.tweet_url, 'https://x.com/SlutCampApp/status/17999', 'tweet URL recorded (built from the brand constant)');
    const caption = JSON.parse(hits[0].body).text;
    assert.ok(caption.includes('https://slutcamp.app/models/a21cfem'),
      `caption carries her canonical link: ${caption}`);

    /* --- C2: cap (3 per live) + spacing (15 min), priority earliest-first --- */
    const fem2 = await makeLiveModel(h.base, MGR, 'a21cfem2', 'female');
    wdb.prepare("INSERT INTO contract_signatures (user_id, contract_version, display_name) VALUES (?, '1.7', 'Test Signer')")
      .run(fem2.id);
    await flip(h.base, fem2, fem2.sessionId, true);
    const base0 = nowSec() - 3600;
    for (let i = 0; i < 4; i++) {
      addGift(wdb, fem2.sessionId, fanId, gid, 2500, base0 + i * 200);
      addChatBurst(wdb, fem2.sessionId, fanId, 12, base0 + i * 200);
    }
    assert.ok(await waitFor(() => clipsFor(dir, fem2.sessionId).length === 4, 45000), 'four high clips logged');
    assert.ok(await waitForPosted(dir, fem2.sessionId, hits, 2, 1), 'first post fires');
    await settle(2200);
    assert.equal(hits.length, 2, 'spacing: the second clip does NOT follow immediately');
    let rows = clipsFor(dir, fem2.sessionId);
    assert.equal(rows.filter((c) => c.status === 'posted').length, 1, 'one posted so far');
    assert.equal(rows.find((c) => c.status === 'posted').window_start,
      rows[0].window_start, 'priority: the earliest high window posted first');

    const backdate = (clipId) => {
      const db = openDb(dir, false);
      try { db.prepare('UPDATE clips SET posted_at = ? WHERE id = ?').run(tsOf(nowSec() - 16 * 60), clipId); }
      finally { db.close(); }
    };
    backdate(rows.find((c) => c.status === 'posted').id);
    assert.ok(await waitForPosted(dir, fem2.sessionId, hits, 3, 2), 'after 15+ min, the second posts');
    rows = clipsFor(dir, fem2.sessionId);
    backdate(rows.filter((c) => c.status === 'posted').sort((a, b) => b.id - a.id)[0].id);
    assert.ok(await waitForPosted(dir, fem2.sessionId, hits, 4, 3), 'the third posts');
    rows = clipsFor(dir, fem2.sessionId);
    assert.equal(rows.filter((c) => c.status === 'posted').length, 3, 'three posted');
    backdate(rows.filter((c) => c.status === 'posted').sort((a, b) => b.id - a.id)[0].id);
    await settle(2500);
    assert.equal(hits.length, 4, 'cap: the fourth high clip never posts');
    rows = clipsFor(dir, fem2.sessionId);
    assert.equal(rows.filter((c) => c.status === 'posted').length, 3, 'cap holds at 3 per live');
    assert.equal(rows.filter((c) => c.status === 'held').length, 1, 'the extra moment stays held, not wasted');
    wdb.close();
  });
