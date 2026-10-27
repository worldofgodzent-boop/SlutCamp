'use strict';
/*
 * PUMPUM VERSE (Phase 6 Live Battles — owner design Oct 20 2026, incl. the
 * Game Category add-on the same day).
 *
 * What this pins:
 *  - Money: battle spend (tips + Game Category buys + gifts) is
 *    ESCROWED — fan debited, nobody credited — until settle. Gross →
 *    house takes its standard cut off the top → pool splits 60%
 *    winner / 40% loser; tie 50/50; forfeit = loser regardless of
 *    score; zero-spend battles settle clean with no payout rows.
 *    battle_allocations sum to each model's payout.
 *  - Game Category add-on: BOTH models' game sheets are reachable by
 *    an entered fan during an active battle; a buy tags to the
 *    session's model's side and counts in her score; skip refunds
 *    from escrow in full; an unresolved request at battle end is
 *    auto-refunded and excluded from the settled gross.
 *  - Invite state machine: one pending invite per model, 60s
 *    expiry, decline → 10-minute same-pair cooldown, invites-closed
 *    toggle refuses direct invites and hides her from the picker.
 *  - Random matchmaking: pool pairing, both-accept → ready check,
 *    a decline returns the other model to the pool.
 *  - Scheduled showdowns: unconfirmed events never display on a
 *    profile; confirm displays them; no-show at +10 minutes
 *    auto-cancels and bells the reminder fan.
 *  - Side-tag integrity: a tip for a non-battler is refused; tips
 *    require entering; tips after the battle ends are refused.
 *  - Rematch: a finished battle spawns a fresh invite, same length.
 *  - Announcement: ann_battles_* SRV copy in all 13 languages, the
 *    battles_announced_at stamp, the boot broadcast (DM + bell to
 *    every model exactly once, fans never), the thread-link pin.
 *  - Migration: a pre-Phase-6 DB (game_requests without battle_id)
 *    boots clean and gains the column.
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

const LANG13 = ['en', 'es', 'pt', 'fr', 'de', 'ru', 'ja', 'zh', 'ko', 'it', 'pl', 'nl', 'tr'];

/* ---------------- static pins ---------------- */

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

test('battles: schema + escrow architecture present in server source', () => {
  for (const tbl of ['battles', 'battle_spend', 'battle_allocations', 'battle_pool', 'battle_viewers', 'battle_reminders'])
    assert.ok(serverSrc.includes(`CREATE TABLE IF NOT EXISTS ${tbl}`), `${tbl} table declared`);
  assert.ok(serverSrc.includes("addColumnIfMissing('models', 'battle_invites_open'"), 'invites toggle column');
  assert.ok(serverSrc.includes("addColumnIfMissing('game_requests', 'battle_id'"), 'game_requests.battle_id migration column');
  assert.ok(serverSrc.includes('function chargeBattleEscrow'), 'escrow charge exists');
  assert.ok(serverSrc.includes('function refundBattleEscrow'), 'escrow refund exists');
  assert.ok(serverSrc.includes('function settleBattle'), 'settle exists');
  assert.ok(serverSrc.includes('function finishBattle'), 'finish exists');
  // the house split itself is untouched: escrow/settle go through splitPayment
  const settle = serverSrc.slice(serverSrc.indexOf('function settleBattle'), serverSrc.indexOf('function finishBattle'));
  assert.ok(settle.includes('splitPayment(gross, null)'), 'pool = the standard splitPayment model share of gross');
  // game-buy routes through escrow when the session is in a live battle
  const buy = serverSrc.slice(serverSrc.indexOf("app.post('/api/live/:id/game-buy'"), serverSrc.indexOf("app.get('/api/live/:id/game-queue'"));
  assert.ok(buy.includes('liveBattleForSession(sess.id)'), 'game-buy checks for a live battle');
  assert.ok(buy.includes('chargeBattleEscrow'), 'game-buy escrows during battles');
  assert.ok(buy.includes('battle_id'), 'game-buy stamps the request with the battle id');
});

test('battles: announcement copy exists in all 13 languages + wiring', () => {
  for (const key of ['ann_battles_dm', 'ann_battles_bell_title', 'ann_battles_bell_body']) {
    const row = SRV[key];
    assert.ok(row, `${key} exists in the SRV table`);
    assert.deepEqual(Object.keys(row).sort(), [...LANG13].sort(), `${key} covers exactly the 13 languages`);
    for (const lang of LANG13) {
      assert.ok(row[lang].trim().length > 0, `${key}:${lang} non-empty`);
      if (lang !== 'en') assert.notEqual(row[lang], row.en, `${key}:${lang} is a real translation`);
    }
  }
  assert.ok(SRV.ann_battles_dm.en.includes('PumPum Verse'), 'EN DM headlines the PumPum Verse name');
  assert.ok(SRV.ann_battles_bell_title.en.includes('PumPum Verse'), 'EN bell title carries the PumPum Verse name');
  assert.ok(SRV.ann_battles_dm.en.includes('60% to the winner'), 'EN DM states the split openly');
  assert.ok(SRV.ann_battles_dm.en.includes('Game Category stays open'), 'EN DM carries the Game Category add-on');
  assert.ok(serverSrc.includes("addColumnIfMissing('platform_stats', 'battles_announced_at', 'TEXT')"),
    'one-time stamp column declared');
  assert.ok(serverSrc.includes('function announceBattlesToModels()'), 'broadcast function exists');
  assert.ok(serverSrc.includes('announceBattlesToModels();'), 'boot sweep calls the broadcast');
  const start = serverSrc.indexOf('function announceBattlesToModels()');
  const block = serverSrc.slice(start, serverSrc.indexOf('\n}\n', start));
  assert.ok(block.includes("srv('ann_battles_dm', m.language)"), 'DM copy localized per model');
  assert.ok(block.includes('`/#chat/${conv.id}`'), 'bell links the announcement thread');
  assert.ok(block.indexOf('INSERT INTO messages') < block.indexOf('UPDATE platform_stats SET battles_announced_at'),
    'stamp set only after the loop');
});

test('battles: client strings exist in all 13 dictionaries + stage wiring', () => {
  for (const key of ['battle', 'battle_brand', 'battle_money_rule', 'battle_invite_from', 'battle_accept',
                     'battle_ready', 'battle_tip_her', 'battle_games_her', 'battle_you_won',
                     'battle_rematch', 'battle_open_invites', 'battle_random', 'battle_schedule',
                     'battle_looking', 'battle_in_battle', 'battle_history']) {
    const hits = appSrc.split(`    ${key}:`).length - 1;
    assert.equal(hits, 13, `${key} present in all 13 languages (found ${hits})`);
  }
  assert.ok(appSrc.includes('battleStage: vBattleStage'), 'battle stage view registered');
  assert.ok(appSrc.includes('function openBattleGameSheet'), 'fan can open a game sheet from the stage');
  assert.ok(appSrc.includes('renderBattleGameBody'), 'battle game sheet renders per-session menus');
  assert.ok(appSrc.includes('function openBattleTipSheet'), 'per-side tip sheet exists');
  assert.ok(appSrc.includes('routeBattleSignal'), 'battle peer connections route their own signals');
  assert.ok(appSrc.includes("id=\"battle-open-btn\""), 'broadcast view carries the Battle button');
  assert.ok(appSrc.includes("id=\"battle-panel\""), 'broadcast view carries the battle panel');
  // PumPum Verse stage layout (owner design update 2026-10-20): SIDE-BY-SIDE
  // vertical split — never stacked — with the brand + scoreboard centered.
  assert.ok(appSrc.includes('class="battle-arena"'), 'stage wraps both videos in the side-by-side arena');
  const arenaAt = appSrc.indexOf('class="battle-arena"');
  const vidA = appSrc.indexOf('id="battle-vid-a"', arenaAt);
  const divider = appSrc.indexOf('class="battle-divider"', arenaAt);
  const vidB = appSrc.indexOf('id="battle-vid-b"', arenaAt);
  const center = appSrc.indexOf('class="battle-center"', arenaAt);
  assert.ok(vidA > arenaAt && divider > vidA && vidB > divider && center > vidB,
    'arena order: video A | vertical divider | video B, then the center overlay');
  assert.ok(appSrc.includes("t('battle_brand')"), 'the PumPum Verse name renders on the scoreboard');
  assert.ok(appSrc.includes('battle-brand'), 'scoreboard carries the centered brand header');
  assert.ok(!appSrc.includes('max-height:34vh'), 'the old stacked-panels stage markup is gone');
  const css = fs.readFileSync(path.join(REPO, 'public/css/styles.css'), 'utf8');
  assert.ok(css.includes('.battle-arena {'), 'arena styles exist');
  assert.ok(css.includes('.battle-divider {'), 'vertical divider styles exist');
  assert.ok(css.includes('.battle-center {'), 'center overlay styles exist');
  assert.ok(/\.battle-center \{[^}]*left: 50%[^}]*top: 50%/.test(css), 'center overlay sits in the middle of the screen');
});

/* ---------------- boot harness (mirrors face-count-guard) ---------------- */

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
const PNG = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001080600000'
  + '01f15c4890000000a49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082', 'hex');
async function upload(base, p, token, fields = ['id_front', 'id_back', 'selfie']) {
  const fd = new FormData();
  for (const f of fields) fd.append(f, new Blob([PNG], { type: 'image/png' }), `${f}.png`);
  const r = await fetch(base + p, { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: fd });
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

/* One shared world per test file run: two verified models + a funded
 * fan, driven through the public API exactly like the app does. */
async function makeWorld(base, dir, MGR, tag) {
  const signup = async (username, role) => {
    const s = await req(base, 'POST', '/api/auth/signup', {
      body: { username, password: 'hunter22', role, display_name: username,
        dob: '1995-05-05', agree18: true, section: 'female',
        ...(role === 'model' ? { publicity_consent: true } : {}) },
    });
    assert.equal(s.status, 200, `signup ${username}: ${s.text}`);
    return { token: s.json.token, id: s.json.user.id, username };
  };
  const verifyOwnId = async (acct) => {
    const up = await upload(base, '/api/model/id-verification', acct.token);
    assert.equal(up.status, 200, `ID upload: ${up.text}`);
    const q = await req(base, 'GET', '/api/admin/id-verifications', { ...MGR });
    const row = q.json.verifications.find((v) => v.model_id === acct.id && !v.co_performer_id);
    assert.ok(row, 'own ID submission queued');
    // PR #86: her own packet cannot be approved until her WOGENT
    // release is on file — she signs it first, like a real model.
    const sign = await req(base, 'POST', '/api/model/release/sign', { token: acct.token, body: {
      legal_name: 'Test Signer', stage_name: acct.username, dob: '1995-05-05',
      attestations: { adult: true, freewill: true, rights: true } } });
    assert.equal(sign.status, 200, `release sign ${acct.username}: ${sign.text}`);
    const ap = await req(base, 'POST', `/api/admin/id-verifications/${row.id}/approve`, { ...MGR });
    assert.equal(ap.status, 200, `approve: ${ap.text}`);
  };
  const host = await signup(`${tag}host`, 'model');
  await verifyOwnId(host);
  const guest = await signup(`${tag}guest`, 'model');
  await verifyOwnId(guest);
  const fan = await signup(`${tag}fan`, 'fan');
  const db = openDb(dir, false);
  db.prepare('UPDATE wallets SET credits_cents = 1000000 WHERE user_id = ?').run(fan.id);
  db.close();
  const goLive = async (acct) => {
    const r = await req(base, 'POST', '/api/live/start', { token: acct.token, body: { title: `${tag} live` } });
    assert.equal(r.status, 200, `go live ${acct.username}: ${r.text}`);
    return r.json.session_id;
  };
  /* Drive a Door-1 battle to live: both live → invite → accept → ready ×2. */
  const startBattle = async (minutes = 5) => {
    const hs = await goLive(host);
    const gs = await goLive(guest);
    const inv = await req(base, 'POST', '/api/battles/invite', {
      token: host.token, body: { opponent_id: guest.id, minutes } });
    assert.equal(inv.status, 200, `invite: ${inv.text}`);
    const bid = inv.json.battle.id;
    const acc = await req(base, 'POST', `/api/battles/${bid}/accept`, { token: guest.token });
    assert.equal(acc.status, 200, `accept: ${acc.text}`);
    assert.equal(acc.json.battle.status, 'ready_check');
    const r1 = await req(base, 'POST', `/api/battles/${bid}/ready`, { token: host.token });
    assert.equal(r1.status, 200, `host ready: ${r1.text}`);
    const r2 = await req(base, 'POST', `/api/battles/${bid}/ready`, { token: guest.token });
    assert.equal(r2.status, 200, `guest ready: ${r2.text}`);
    assert.equal(r2.json.battle.status, 'live', `battle live: ${r2.text}`);
    return { bid, hs, gs };
  };
  const forceEndBattle = async (bid, asToken) => {
    const db2 = openDb(dir, false);
    db2.prepare("UPDATE battles SET ends_at = datetime('now', '-1 minute') WHERE id = ?").run(bid);
    db2.close();
    const r = await req(base, 'GET', `/api/battles/${bid}`, { token: asToken });
    assert.equal(r.status, 200, `battle read: ${r.text}`);
    assert.equal(r.json.battle.status, 'finished', `battle finished: ${r.text}`);
    return r.json.battle;
  };
  const gameOn = async (acct, sessionId, label, price) => {
    const on = await req(base, 'POST', `/api/live/${sessionId}/game`, { token: acct.token, body: { on: true } });
    assert.equal(on.status, 200, `game on: ${on.text}`);
    const it = await req(base, 'POST', '/api/game/items', {
      token: acct.token, body: { section: 'regular', label, price_cents: price } });
    assert.equal(it.status, 200, `game item: ${it.text}`);
    return it.json.item.id;
  };
  const earnings = (userId) => {
    const d = openDb(dir);
    const w = d.prepare('SELECT earnings_cents FROM wallets WHERE user_id = ?').get(userId);
    d.close();
    return w.earnings_cents;
  };
  const fanCredits = () => {
    const d = openDb(dir);
    const w = d.prepare('SELECT credits_cents FROM wallets WHERE user_id = ?').get(fan.id);
    d.close();
    return w.credits_cents;
  };
  return { host, guest, fan, signup, verifyOwnId, goLive, startBattle, forceEndBattle, gameOn, earnings, fanCredits };
}

async function mgrLogin(base) {
  const mgr = await req(base, 'POST', '/api/manager/login', { body: { username: 'admin', password: 'admin123' } });
  assert.equal(mgr.status, 200, `manager login: ${mgr.text}`);
  return { token: mgr.json.token, headers: { 'x-manager': '1' } };
}

/* ---------------- functional: money + game add-on ---------------- */

test('battles: escrow split math — tips + game buys settle 60/40 after the house cut', { timeout: 300000 }, async () => {
  const dir = makeCopy('battlemath');
  let h = null;
  try {
    h = await boot(dir, { SEED_DEMO: '1' });
    const MGR = await mgrLogin(h.base);
    const W = await makeWorld(h.base, dir, MGR, 'bm');
    const { bid, hs, gs } = await W.startBattle(5);
    // Custom tip items for round numbers ($200 host, $100 guest)
    const menuH = await req(h.base, 'POST', '/api/model/tip-menu', {
      token: W.host.token, body: { emoji: '🔥', label: 'Big love', price_cents: 20000 } });
    const menuG = await req(h.base, 'POST', '/api/model/tip-menu', {
      token: W.guest.token, body: { emoji: '💋', label: 'Kiss', price_cents: 10000 } });
    assert.equal(menuH.status, 200, menuH.text);
    assert.equal(menuG.status, 200, menuG.text);
    // Fan enters, then spends: host tips 20000+10000, guest tip 10000,
    // guest GAME buy 10000 (marked done so it stays in the pot).
    const ent = await req(h.base, 'POST', `/api/battles/${bid}/enter`, { token: W.fan.token });
    assert.equal(ent.status, 200, `enter: ${ent.text}`);
    const fanStart = W.fanCredits();
    const tipH = await req(h.base, 'POST', `/api/battles/${bid}/tip`, {
      token: W.fan.token, body: { side_model_id: W.host.id, menu_id: menuH.json.id } });
    assert.equal(tipH.status, 200, `host tip: ${tipH.text}`);
    assert.equal(tipH.json.battle.host_score_cents, 20000);
    const tipH2 = await req(h.base, 'POST', `/api/battles/${bid}/tip`, {
      token: W.fan.token, body: { side_model_id: W.host.id, menu_id: 'default-4' } }); // $50 default item
    assert.equal(tipH2.status, 200, `host tip 2: ${tipH2.text}`);
    const tipG = await req(h.base, 'POST', `/api/battles/${bid}/tip`, {
      token: W.fan.token, body: { side_model_id: W.guest.id, menu_id: menuG.json.id } });
    assert.equal(tipG.status, 200, `guest tip: ${tipG.text}`);
    const guestItem = await W.gameOn(W.guest, gs, 'Dance for you', 10000);
    const buy = await req(h.base, 'POST', `/api/live/${gs}/game-buy`, {
      token: W.fan.token, body: { item_id: guestItem } });
    assert.equal(buy.status, 200, `guest game buy: ${buy.text}`);
    assert.equal(buy.json.battle_id, bid, 'game buy is stamped into the battle');
    const done = await req(h.base, 'POST', `/api/game/requests/${buy.json.request_id}/resolve`, {
      token: W.guest.token, body: { action: 'done' } });
    assert.equal(done.status, 200, `resolve done: ${done.text}`);
    // ESCROW: the fan is out the full gross; NEITHER model has a cent yet.
    assert.equal(W.fanCredits(), fanStart - 45000, 'fan debited the full gross into escrow');
    assert.equal(W.earnings(W.host.id), 0, 'host not credited before settle');
    assert.equal(W.earnings(W.guest.id), 0, 'guest not credited before settle');
    const st = await req(h.base, 'GET', `/api/battles/${bid}`, { token: W.fan.token });
    assert.equal(st.json.battle.host_score_cents, 25000, 'host score = her side spend');
    assert.equal(st.json.battle.guest_score_cents, 20000, 'guest score includes her game buy');
    // Settle: G=45000 → house 18000 → pool 27000 → winner 16200 / loser 10800.
    const fin = await W.forceEndBattle(bid, W.host.token);
    assert.equal(fin.gross_cents, 45000);
    assert.equal(fin.house_cents, 18000, 'house takes its standard 40% off the top');
    assert.equal(fin.pool_cents, 27000);
    assert.equal(fin.winner_id, W.host.id);
    assert.equal(fin.winner_cents, 16200, 'winner takes 60% of the pool');
    assert.equal(fin.loser_cents, 10800, 'loser still takes 40% of the pool');
    assert.equal(W.earnings(W.host.id), 16200);
    assert.equal(W.earnings(W.guest.id), 10800);
    const db = openDb(dir);
    const allocs = db.prepare('SELECT model_id, SUM(cents) AS s FROM battle_allocations WHERE battle_id = ? GROUP BY model_id').all(bid);
    const byModel = Object.fromEntries(allocs.map((a) => [a.model_id, a.s]));
    assert.equal(byModel[W.host.id], 16200, 'allocations trace the winner payout');
    assert.equal(byModel[W.guest.id], 10800, 'allocations trace the loser payout');
    const payouts = db.prepare("SELECT COUNT(*) AS c FROM transactions WHERE type = 'battle_payout' AND model_id IN (?,?)").get(W.host.id, W.guest.id);
    assert.equal(payouts.c, 2, 'one payout row per model');
    const spendStates = db.prepare("SELECT DISTINCT status FROM battle_spend WHERE battle_id = ?").all(bid);
    assert.deepEqual(spendStates.map((s) => s.status), ['settled'], 'all spend settled');
    db.close();
  } finally {
    stop(h);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('battles: game sheets reachable for BOTH sides; skip refunds escrow; unresolved buy excluded from pot', { timeout: 300000 }, async () => {
  const dir = makeCopy('battlegame');
  let h = null;
  try {
    h = await boot(dir, { SEED_DEMO: '1' });
    const MGR = await mgrLogin(h.base);
    const W = await makeWorld(h.base, dir, MGR, 'bg');
    const { bid, hs, gs } = await W.startBattle(5);
    const hostItem = await W.gameOn(W.host, hs, 'Host dance', 5000);
    const guestItem = await W.gameOn(W.guest, gs, 'Guest dance', 7000);
    await req(h.base, 'POST', `/api/battles/${bid}/enter`, { token: W.fan.token });
    // ADD-ON PIN: the entered fan can open BOTH models' game sheets
    // mid-battle, each with her own items at her own prices.
    for (const [sess, itemId, price] of [[hs, hostItem, 5000], [gs, guestItem, 7000]]) {
      const menu = await req(h.base, 'GET', `/api/live/${sess}/game-menu`, { token: W.fan.token });
      assert.equal(menu.status, 200, `game-menu for session ${sess}: ${menu.text}`);
      assert.equal(menu.json.game_on, true);
      const flat = [...menu.json.sections.regular, ...menu.json.sections.explicit, ...menu.json.sections.special];
      const found = flat.find((i) => i.id === itemId);
      assert.ok(found, 'her item is on her sheet during the battle');
      assert.equal(found.price_cents, price, 'her own price');
    }
    // Explicit mode is paused during a battle (public-live rules).
    const mode = await req(h.base, 'POST', `/api/live/${hs}/mode`, { token: W.host.token, body: { is_explicit: true } });
    assert.equal(mode.status, 409, `mode blocked: ${mode.text}`);
    assert.equal(mode.json.error, 'in_battle');
    // Buy the host's item, then she SKIPS it → full escrow refund.
    const fanStart = W.fanCredits();
    const buyH = await req(h.base, 'POST', `/api/live/${hs}/game-buy`, { token: W.fan.token, body: { item_id: hostItem } });
    assert.equal(buyH.status, 200, `host game buy: ${buyH.text}`);
    assert.equal(buyH.json.battle_id, bid);
    assert.equal(W.fanCredits(), fanStart - 5000);
    let st = await req(h.base, 'GET', `/api/battles/${bid}`, { token: W.fan.token });
    assert.equal(st.json.battle.host_score_cents, 5000, 'buy counts toward her score while held');
    const skip = await req(h.base, 'POST', `/api/game/requests/${buyH.json.request_id}/resolve`, {
      token: W.host.token, body: { action: 'skip' } });
    assert.equal(skip.status, 200, `skip: ${skip.text}`);
    assert.equal(W.fanCredits(), fanStart, 'skip refunds the fan in full from escrow');
    assert.equal(W.earnings(W.host.id), 0, 'skip never touches model earnings');
    st = await req(h.base, 'GET', `/api/battles/${bid}`, { token: W.fan.token });
    assert.equal(st.json.battle.host_score_cents, 0, 'refunded buy leaves the score');
    // Buy the guest's item and leave it UNRESOLVED; tip the host $100.
    const buyG = await req(h.base, 'POST', `/api/live/${gs}/game-buy`, { token: W.fan.token, body: { item_id: guestItem } });
    assert.equal(buyG.status, 200, `guest game buy: ${buyG.text}`);
    const menuH = await req(h.base, 'POST', '/api/model/tip-menu', {
      token: W.host.token, body: { emoji: '🔥', label: 'Big love', price_cents: 10000 } });
    const tip = await req(h.base, 'POST', `/api/battles/${bid}/tip`, {
      token: W.fan.token, body: { side_model_id: W.host.id, menu_id: menuH.json.id } });
    assert.equal(tip.status, 200, `tip: ${tip.text}`);
    const fanBeforeEnd = W.fanCredits();
    const fin = await W.forceEndBattle(bid, W.host.token);
    assert.equal(W.fanCredits(), fanBeforeEnd + 7000, 'unresolved game buy auto-refunded at battle end');
    assert.equal(fin.gross_cents, 10000, 'refunded buy is EXCLUDED from the settled gross');
    assert.equal(fin.pool_cents, 6000);
    assert.equal(fin.winner_cents, 3600);
    assert.equal(fin.loser_cents, 2400);
    const db = openDb(dir);
    const gr = db.prepare('SELECT status FROM game_requests WHERE id = ?').get(buyG.json.request_id);
    assert.equal(gr.status, 'refunded', 'the request itself is marked refunded');
    db.close();
  } finally {
    stop(h);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('battles: tie 50/50, forfeit loses regardless of score, zero-spend settles clean', { timeout: 300000 }, async () => {
  const dir = makeCopy('battleoutcomes');
  let h = null;
  try {
    h = await boot(dir, { SEED_DEMO: '1' });
    const MGR = await mgrLogin(h.base);
    const W = await makeWorld(h.base, dir, MGR, 'bo');
    const menu = await req(h.base, 'POST', '/api/model/tip-menu', {
      token: W.host.token, body: { emoji: '🔥', label: 'Ten', price_cents: 10000 } });
    const menuId = menu.json.id;
    // --- tie ---
    {
      const { bid } = await W.startBattle(5);
      await req(h.base, 'POST', `/api/battles/${bid}/enter`, { token: W.fan.token });
      await req(h.base, 'POST', `/api/battles/${bid}/tip`, { token: W.fan.token, body: { side_model_id: W.host.id, menu_id: menuId } });
      // guest has no custom menu — her tip lands via the live-context tip route on host's menu? No:
      // use the battle tip with the HOST's menu id against the guest side must fail (menu is hers only).
      const wrong = await req(h.base, 'POST', `/api/battles/${bid}/tip`, { token: W.fan.token, body: { side_model_id: W.guest.id, menu_id: menuId } });
      assert.equal(wrong.status, 404, `menu belongs to the side's model only: ${wrong.text}`);
      const tipG = await req(h.base, 'POST', `/api/battles/${bid}/tip`, { token: W.fan.token, body: { side_model_id: W.guest.id, menu_id: 'default-3' } }); // 3000
      assert.equal(tipG.status, 200, tipG.text);
      const tipG2 = await req(h.base, 'POST', `/api/battles/${bid}/tip`, { token: W.fan.token, body: { side_model_id: W.guest.id, menu_id: 'default-4' } }); // 5000
      assert.equal(tipG2.status, 200, tipG2.text);
      const tipG3 = await req(h.base, 'POST', `/api/battles/${bid}/tip`, { token: W.fan.token, body: { side_model_id: W.guest.id, menu_id: 'default-1' } }); // 1000... total guest 9000; add default-1 again? ids can repeat-buy
      assert.equal(tipG3.status, 200, tipG3.text);
      const fin = await W.forceEndBattle(bid, W.host.token);
      assert.equal(fin.gross_cents, 19000);
      // host 10000 vs guest 9000 — NOT a tie; fix expectations: host wins.
      assert.equal(fin.winner_id, W.host.id);
    }
    // --- clean tie with exact equal custom menus ---
    {
      const menuG = await req(h.base, 'POST', '/api/model/tip-menu', {
        token: W.guest.token, body: { emoji: '🔥', label: 'Ten', price_cents: 10000 } });
      const { bid } = await W.startBattle(5);
      await req(h.base, 'POST', `/api/battles/${bid}/enter`, { token: W.fan.token });
      await req(h.base, 'POST', `/api/battles/${bid}/tip`, { token: W.fan.token, body: { side_model_id: W.host.id, menu_id: menuId } });
      await req(h.base, 'POST', `/api/battles/${bid}/tip`, { token: W.fan.token, body: { side_model_id: W.guest.id, menu_id: menuG.json.id } });
      const hostBefore = W.earnings(W.host.id), guestBefore = W.earnings(W.guest.id);
      const fin = await W.forceEndBattle(bid, W.host.token);
      assert.equal(fin.winner_id, null, 'tie has no winner');
      assert.equal(fin.pool_cents, 12000);
      assert.equal(fin.winner_cents, 6000, 'tie share stored host-side');
      assert.equal(fin.loser_cents, 6000);
      assert.equal(W.earnings(W.host.id), hostBefore + 6000, 'tie pays 50/50');
      assert.equal(W.earnings(W.guest.id), guestBefore + 6000, 'tie pays 50/50');
    }
    // --- forfeit: guest is AHEAD on score but ends her live ---
    {
      const { bid, gs } = await W.startBattle(5);
      await req(h.base, 'POST', `/api/battles/${bid}/enter`, { token: W.fan.token });
      const menuG = await req(h.base, 'POST', '/api/model/tip-menu', {
        token: W.guest.token, body: { emoji: '🔥', label: 'Thirty', price_cents: 30000 } });
      await req(h.base, 'POST', `/api/battles/${bid}/tip`, { token: W.fan.token, body: { side_model_id: W.guest.id, menu_id: menuG.json.id } });
      const hostBefore = W.earnings(W.host.id), guestBefore = W.earnings(W.guest.id);
      const end = await req(h.base, 'POST', `/api/live/${gs}/end`, { token: W.guest.token });
      assert.equal(end.status, 200, `guest ends live: ${end.text}`);
      const st = await req(h.base, 'GET', `/api/battles/${bid}`, { token: W.host.token });
      assert.equal(st.json.battle.status, 'finished', 'battle finishes on the forfeit');
      assert.equal(st.json.battle.winner_id, W.host.id, 'the side still standing wins');
      assert.equal(st.json.battle.forfeit_by, W.guest.id, 'ending her live is the forfeit');
      assert.equal(st.json.battle.gross_cents, 30000);
      assert.equal(W.earnings(W.host.id), hostBefore + 10800, 'winner 60% of the 18000 pool');
      assert.equal(W.earnings(W.guest.id), guestBefore + 7200, 'forfeiter still gets the loser 40%');
      const db = openDb(dir);
      const hostSess = db.prepare("SELECT COUNT(*) AS c FROM live_sessions WHERE model_id = ? AND status = 'live'").get(W.host.id);
      assert.equal(hostSess.c, 0, 'the surviving session is ended by the finish too');
      db.close();
    }
    // --- zero-spend battle ---
    {
      const { bid } = await W.startBattle(5);
      const hostBefore = W.earnings(W.host.id), guestBefore = W.earnings(W.guest.id);
      const fin = await W.forceEndBattle(bid, W.host.token);
      assert.equal(fin.gross_cents, 0);
      assert.equal(fin.pool_cents, 0);
      assert.equal(W.earnings(W.host.id), hostBefore, 'zero-spend: no earnings move');
      assert.equal(W.earnings(W.guest.id), guestBefore);
      const db = openDb(dir);
      const payouts = db.prepare("SELECT COUNT(*) AS c FROM transactions WHERE type = 'battle_payout' AND note LIKE ?").get(`%Battle #${bid}%`);
      assert.equal(payouts.c, 0, 'zero-spend: no payout rows');
      db.close();
    }
  } finally {
    stop(h);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------- functional: doors ---------------- */

test('battles: invite state machine — one pending, 60s expiry, decline cooldown, invites-closed', { timeout: 300000 }, async () => {
  const dir = makeCopy('battleinvite');
  let h = null;
  try {
    h = await boot(dir, { SEED_DEMO: '1' });
    const MGR = await mgrLogin(h.base);
    const W = await makeWorld(h.base, dir, MGR, 'bi');
    const third = await W.signup('bithird', 'model');
    await W.verifyOwnId(third);
    // unverified model cannot invite (going-live eligibility gate)
    const unver = await W.signup('biunver', 'model');
    const gate = await req(h.base, 'POST', '/api/battles/invite', { token: unver.token, body: { opponent_id: W.guest.id, minutes: 5 } });
    assert.equal(gate.status, 403, `unverified inviter refused: ${gate.text}`);
    // first invite OK
    const inv = await req(h.base, 'POST', '/api/battles/invite', { token: W.host.token, body: { opponent_id: W.guest.id, minutes: 5 } });
    assert.equal(inv.status, 200, `invite: ${inv.text}`);
    const bid = inv.json.battle.id;
    // one pending per model: a second invite while one is open → 409
    const second = await req(h.base, 'POST', '/api/battles/invite', { token: W.host.token, body: { opponent_id: third.id, minutes: 5 } });
    assert.equal(second.status, 409, `second pending refused: ${second.text}`);
    assert.equal(second.json.error, 'invite_pending');
    // bad minutes
    const badMin = await req(h.base, 'POST', '/api/battles/invite', { token: third.token, body: { opponent_id: W.host.id, minutes: 7 } });
    assert.equal(badMin.status, 400, `bad minutes: ${badMin.text}`);
    // decline → silent + cooldown on the same ordered pair
    const dec = await req(h.base, 'POST', `/api/battles/${bid}/decline`, { token: W.guest.token });
    assert.equal(dec.status, 200, `decline: ${dec.text}`);
    const reinvite = await req(h.base, 'POST', '/api/battles/invite', { token: W.host.token, body: { opponent_id: W.guest.id, minutes: 5 } });
    assert.equal(reinvite.status, 429, `cooldown: ${reinvite.text}`);
    assert.equal(reinvite.json.error, 'cooldown');
    // expiry: a fresh invite (different pair), force-expire, accept refused
    const inv2 = await req(h.base, 'POST', '/api/battles/invite', { token: third.token, body: { opponent_id: W.host.id, minutes: 10 } });
    assert.equal(inv2.status, 200, `invite2: ${inv2.text}`);
    const bid2 = inv2.json.battle.id;
    const db = openDb(dir, false);
    db.prepare("UPDATE battles SET expires_at = datetime('now', '-1 minute') WHERE id = ?").run(bid2);
    db.close();
    const mine = await req(h.base, 'GET', '/api/battles/mine', { token: W.host.token });
    assert.equal(mine.status, 200);
    assert.ok(!mine.json.pending.some((b) => b.id === bid2), 'expired invite leaves the pending list');
    const accLate = await req(h.base, 'POST', `/api/battles/${bid2}/accept`, { token: W.host.token });
    assert.equal(accLate.status, 409, `late accept refused: ${accLate.text}`);
    // invites-closed toggle: refuses direct invites + hides from the picker
    const tgl = await req(h.base, 'PUT', '/api/model/profile', { token: third.token, body: { battle_invites_open: 0 } });
    assert.equal(tgl.status, 200, `toggle: ${tgl.text}`);
    const closedInv = await req(h.base, 'POST', '/api/battles/invite', { token: W.host.token, body: { opponent_id: third.id, minutes: 5 } });
    assert.equal(closedInv.status, 409, `invites closed: ${closedInv.text}`);
    assert.equal(closedInv.json.error, 'invites_closed');
    const opps = await req(h.base, 'GET', '/api/battles/opponents', { token: W.host.token });
    assert.ok(!opps.json.opponents.some((o) => o.id === third.id), 'closed model hidden from the picker');
    assert.ok(opps.json.opponents.some((o) => o.id === W.guest.id), 'open model visible in the picker');
  } finally {
    stop(h);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('battles: random matchmaking — pairing, decline returns the other to the pool, full start', { timeout: 300000 }, async () => {
  const dir = makeCopy('battlepool');
  let h = null;
  try {
    h = await boot(dir, { SEED_DEMO: '1' });
    const MGR = await mgrLogin(h.base);
    const W = await makeWorld(h.base, dir, MGR, 'bp');
    const third = await W.signup('bpthird', 'model');
    await W.verifyOwnId(third);
    // pool requires live
    const notLive = await req(h.base, 'POST', '/api/battles/pool/enter', { token: W.host.token, body: {} });
    assert.equal(notLive.status, 409, `pool needs live: ${notLive.text}`);
    await W.goLive(W.host);
    await W.goLive(W.guest);
    await W.goLive(third);
    const e1 = await req(h.base, 'POST', '/api/battles/pool/enter', { token: W.host.token, body: {} });
    assert.equal(e1.status, 200, `enter 1: ${e1.text}`);
    assert.equal(e1.json.in_pool, true, 'first in waits in the pool');
    const e2 = await req(h.base, 'POST', '/api/battles/pool/enter', { token: W.guest.token, body: {} });
    assert.equal(e2.status, 200, `enter 2: ${e2.text}`);
    assert.ok(e2.json.battle, 'second entrant triggers the pairing');
    const bid = e2.json.battle.id;
    assert.equal(e2.json.battle.kind, 'random');
    assert.equal(e2.json.battle.minutes, 10, 'random battles are always 10 minutes');
    // host declines → guest returns to the pool, no penalty
    const dec = await req(h.base, 'POST', `/api/battles/${bid}/decline`, { token: W.host.token });
    assert.equal(dec.status, 200, `decline: ${dec.text}`);
    const mineG = await req(h.base, 'GET', '/api/battles/mine', { token: W.guest.token });
    assert.equal(mineG.json.pool.in_pool, true, 'the declined-against model is back in the pool');
    // third model enters → pairs with the waiting guest
    const e3 = await req(h.base, 'POST', '/api/battles/pool/enter', { token: third.token, body: {} });
    assert.ok(e3.json.battle, `third pairs with the waiter: ${e3.text}`);
    const bid2 = e3.json.battle.id;
    const a1 = await req(h.base, 'POST', `/api/battles/${bid2}/accept`, { token: W.guest.token });
    assert.equal(a1.json.battle.status, 'invited', 'one accept is not enough for random');
    const a2 = await req(h.base, 'POST', `/api/battles/${bid2}/accept`, { token: third.token });
    assert.equal(a2.json.battle.status, 'ready_check', 'both accepts move to the ready check');
    const hostId = a2.json.battle.host.id;
    const rHost = await req(h.base, 'POST', `/api/battles/${bid2}/ready`, { token: hostId === W.guest.id ? W.guest.token : third.token });
    assert.equal(rHost.status, 200, `ready 1: ${rHost.text}`);
    const rOther = await req(h.base, 'POST', `/api/battles/${bid2}/ready`, { token: hostId === W.guest.id ? third.token : W.guest.token });
    assert.equal(rOther.status, 200, `ready 2: ${rOther.text}`);
    assert.equal(rOther.json.battle.status, 'live', 'random battle starts after both ready');
  } finally {
    stop(h);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('battles: scheduled showdown — confirm gate, profile display, reminder, no-show cancel', { timeout: 300000 }, async () => {
  const dir = makeCopy('battlesched');
  let h = null;
  try {
    h = await boot(dir, { SEED_DEMO: '1' });
    const MGR = await mgrLogin(h.base);
    const W = await makeWorld(h.base, dir, MGR, 'bs');
    const startsAt = new Date(Date.now() + 2 * 3600000).toISOString();
    const sch = await req(h.base, 'POST', '/api/battles/schedule', {
      token: W.host.token, body: { opponent_id: W.guest.id, minutes: 15, starts_at: startsAt } });
    assert.equal(sch.status, 200, `schedule: ${sch.text}`);
    const bid = sch.json.battle.id;
    // unconfirmed → invisible on profiles
    let ev = await req(h.base, 'GET', `/api/models/${W.guest.id}/battle-events`, {});
    assert.equal(ev.json.events.length, 0, 'unconfirmed showdown never displays');
    const remindEarly = await req(h.base, 'POST', `/api/battles/${bid}/remind`, { token: W.fan.token });
    assert.equal(remindEarly.status, 409, 'no reminders before confirmation');
    // host cannot confirm her own event; the opponent confirms
    const hostConfirm = await req(h.base, 'POST', `/api/battles/${bid}/accept`, { token: W.host.token });
    assert.equal(hostConfirm.status, 403, `host confirm refused: ${hostConfirm.text}`);
    const conf = await req(h.base, 'POST', `/api/battles/${bid}/accept`, { token: W.guest.token });
    assert.equal(conf.status, 200, `confirm: ${conf.text}`);
    assert.equal(conf.json.battle.confirmed, true);
    ev = await req(h.base, 'GET', `/api/models/${W.guest.id}/battle-events`, {});
    assert.equal(ev.json.events.length, 1, 'confirmed showdown displays on her profile');
    assert.equal(ev.json.events[0].opponent.id, W.host.id, 'profile names the opponent');
    ev = await req(h.base, 'GET', `/api/models/${W.host.id}/battle-events`, {});
    assert.equal(ev.json.events.length, 1, '...and on his profile too');
    const remind = await req(h.base, 'POST', `/api/battles/${bid}/remind`, { token: W.fan.token });
    assert.equal(remind.status, 200, `remind: ${remind.text}`);
    assert.equal(remind.json.reminded, true);
    // too early to start
    const early = await req(h.base, 'POST', `/api/battles/${bid}/start`, { token: W.host.token });
    assert.equal(early.status, 409, `too early: ${early.text}`);
    assert.equal(early.json.error, 'too_early');
    // no-show: 11 minutes past start, nobody started → auto-cancel + bells
    const db = openDb(dir, false);
    db.prepare("UPDATE battles SET starts_at = datetime('now', '-11 minutes') WHERE id = ?").run(bid);
    db.close();
    const mine = await req(h.base, 'GET', '/api/battles/mine', { token: W.host.token });
    assert.equal(mine.status, 200);
    assert.ok(!mine.json.scheduled.some((b) => b.id === bid), 'cancelled showdown leaves the schedule list');
    const db2 = openDb(dir);
    const row = db2.prepare('SELECT status FROM battles WHERE id = ?').get(bid);
    assert.equal(row.status, 'cancelled', 'no-show auto-cancels');
    const bell = db2.prepare("SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND type = 'battle'").get(W.fan.id);
    assert.ok(bell.c >= 1, 'the reminder fan is belled about the cancellation');
    db2.close();
  } finally {
    stop(h);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('battles: side-tag integrity, enter gate, chat, rematch', { timeout: 300000 }, async () => {
  const dir = makeCopy('battletag');
  let h = null;
  try {
    h = await boot(dir, { SEED_DEMO: '1' });
    const MGR = await mgrLogin(h.base);
    const W = await makeWorld(h.base, dir, MGR, 'bt');
    const third = await W.signup('btthird', 'model');
    await W.verifyOwnId(third);
    const { bid, hs } = await W.startBattle(5);
    // tip before entering → refused
    const early = await req(h.base, 'POST', `/api/battles/${bid}/tip`, {
      token: W.fan.token, body: { side_model_id: W.host.id, menu_id: 'default-0' } });
    assert.equal(early.status, 403, `enter first: ${early.text}`);
    assert.equal(early.json.error, 'enter_first');
    await req(h.base, 'POST', `/api/battles/${bid}/enter`, { token: W.fan.token });
    // a side that is not in this battle → refused, nothing escrowed
    const fanStart = W.fanCredits();
    const bad = await req(h.base, 'POST', `/api/battles/${bid}/tip`, {
      token: W.fan.token, body: { side_model_id: third.id, menu_id: 'default-0' } });
    assert.equal(bad.status, 400, `bad side: ${bad.text}`);
    assert.equal(bad.json.error, 'bad_side');
    assert.equal(W.fanCredits(), fanStart, 'a refused tip never debits');
    // missing menu_id is a clean 400 (the PR #62 lesson)
    const noMenu = await req(h.base, 'POST', `/api/battles/${bid}/tip`, {
      token: W.fan.token, body: { side_model_id: W.host.id } });
    assert.equal(noMenu.status, 400, `menu_id required: ${noMenu.text}`);
    assert.equal(noMenu.json.error, 'menu_id_required');
    // shared chat: fan posts, guest model reads the same room; a phone
    // number is blocked and never stored
    const post = await req(h.base, 'POST', `/api/battles/${bid}/chat`, {
      token: W.fan.token, body: { body: 'Team host all the way!' } });
    assert.equal(post.status, 200, `chat post: ${post.text}`);
    const read = await req(h.base, 'GET', `/api/battles/${bid}/chat`, { token: W.guest.token });
    assert.equal(read.status, 200, `chat read: ${read.text}`);
    assert.ok(read.json.messages.some((m) => m.body === 'Team host all the way!'), 'one shared room for both fanbases');
    const blocked = await req(h.base, 'POST', `/api/battles/${bid}/chat`, {
      token: W.fan.token, body: { body: 'call me 484 555 1234' } });
    assert.equal(blocked.status, 423, `safety block: ${blocked.text}`);
    const read2 = await req(h.base, 'GET', `/api/battles/${bid}/chat`, { token: W.guest.token });
    assert.ok(!read2.json.messages.some((m) => m.body.includes('484')), 'blocked message is never stored');
    // the live list flags the battle + the surviving session ends the fan view
    const liveList = await req(h.base, 'GET', '/api/live', { token: W.fan.token });
    const hostRow = liveList.json.live.find((r) => r.session_id === hs);
    assert.equal(hostRow.battle_id, bid, 'live list carries the battle id');
    // finish, then: tips refused, rematch spawns a fresh same-length invite
    await W.forceEndBattle(bid, W.host.token);
    const late = await req(h.base, 'POST', `/api/battles/${bid}/tip`, {
      token: W.fan.token, body: { side_model_id: W.host.id, menu_id: 'default-0' } });
    assert.equal(late.status, 409, `tip after finish refused: ${late.text}`);
    const rem = await req(h.base, 'POST', `/api/battles/${bid}/rematch`, { token: W.host.token });
    assert.equal(rem.status, 200, `rematch: ${rem.text}`);
    assert.equal(rem.json.battle.kind, 'rematch');
    assert.equal(rem.json.battle.minutes, 5, 'rematch keeps the same length');
    assert.equal(rem.json.battle.status, 'invited');
    const acc = await req(h.base, 'POST', `/api/battles/${rem.json.battle.id}/accept`, { token: W.guest.token });
    assert.equal(acc.json.battle.status, 'ready_check', 'accepted rematch goes to the ready check');
    // earnings endpoint carries the transparent battle breakdown
    const earn = await req(h.base, 'GET', '/api/model/earnings', { token: W.host.token });
    assert.equal(earn.status, 200, `earnings: ${earn.text}`);
    assert.ok(Array.isArray(earn.json.battles), 'earnings payload carries battles');
    const rowB = earn.json.battles.find((b) => b.id === bid);
    assert.ok(rowB, 'the finished battle is in her history');
    for (const f of ['gross_cents', 'house_cents', 'pool_cents', 'winner_cents', 'loser_cents', 'your_cents', 'result'])
      assert.ok(f in rowB, `breakdown field ${f} present`);
  } finally {
    stop(h);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------- announcement + migration ---------------- */

test('battles: announcement broadcast — every model DMd once, fans never, stamp set', { timeout: 300000 }, async () => {
  const dir = makeCopy('battleann');
  let h = null;
  try {
    h = await boot(dir, { SEED_DEMO: '1' });
    stop(h);
    let db = openDb(dir);
    const stamp = db.prepare('SELECT battles_announced_at FROM platform_stats WHERE id = 1').get();
    assert.ok(stamp && stamp.battles_announced_at, 'stamp set after first boot');
    const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
    const models = db.prepare("SELECT id, username FROM users WHERE role = 'model'").all();
    assert.ok(models.length >= 3, 'seed models exist');
    const countFor = (modelId) => db.prepare(
      `SELECT COUNT(*) AS c FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE c.fan_id = ? AND c.model_id = ? AND m.sender_id = ? AND m.body LIKE '%PumPum Verse%'`
    ).get(admin.id, modelId, admin.id).c;
    for (const m of models) assert.equal(countFor(m.id), 1, `${m.username} got exactly one announcement`);
    const bell = db.prepare("SELECT COUNT(*) AS c FROM notifications WHERE type = 'battles'").get();
    assert.ok(bell.c >= models.length, 'every model got the battles bell');
    const fan = db.prepare("SELECT id FROM users WHERE role = 'fan' LIMIT 1").get();
    const fanBell = db.prepare("SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND type = 'battles'").get(fan.id);
    assert.equal(fanBell.c, 0, 'fans get no model announcement');
    db.close();
    h = await boot(dir, { SEED_DEMO: '1' });
    stop(h); h = null;
    db = openDb(dir);
    for (const m of models) assert.equal(countFor(m.id), 1, `${m.username} not re-sent on second boot`);
    db.close();
  } finally {
    stop(h);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('battles: migration — a pre-Phase-6 database boots and gains battle_id', { timeout: 300000 }, async () => {
  const dir = makeCopy('battlemig');
  let h = null;
  try {
    // Pre-create the DB with the OLD game_requests DDL (no battle_id)
    // and no battles tables at all — the previous version's schema.
    const db = new DatabaseSync(path.join(dir, 'wogent-chat.db'));
    db.exec(`CREATE TABLE game_requests (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  INTEGER NOT NULL,
      model_id    INTEGER NOT NULL,
      fan_id      INTEGER NOT NULL,
      item_id     INTEGER,
      label       TEXT NOT NULL,
      price_cents INTEGER NOT NULL,
      status      TEXT NOT NULL DEFAULT 'pending',
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT
    );`);
    db.close();
    h = await boot(dir, { SEED_DEMO: '1' });
    stop(h); h = null;
    const db2 = openDb(dir);
    const cols = db2.prepare('PRAGMA table_info(game_requests)').all().map((c) => c.name);
    assert.ok(cols.includes('battle_id'), 'battle_id column added by the migration path');
    const mcols = db2.prepare('PRAGMA table_info(models)').all().map((c) => c.name);
    assert.ok(mcols.includes('battle_invites_open'), 'battle_invites_open column present');
    const tbl = db2.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'battles'").get();
    assert.ok(tbl, 'battles table created on the old database');
    db2.close();
  } finally {
    stop(h);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
