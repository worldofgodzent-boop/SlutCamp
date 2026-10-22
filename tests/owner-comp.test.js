'use strict';
/*
 * Owner Comp Bypass (owner, 2026-10-22; spec:
 * ~/workspace/projects/owner-comp-bypass-spec.md).
 *
 * The house account (asceaaspade — the platform itself, a MODEL-role
 * user) texts and joins lives free. Scope pins:
 *  - House opens fan-side chats (conversations/start) and sends texts
 *    + voice notes with cost 0 — and the model actually receives them
 *    (fan-side delivery routing).
 *  - House joins public lives, explicit entry + per-minute unblur,
 *    stage join-requests, Private Room lives (WITHOUT consuming a
 *    sellable seat) and battle spectating — all with zero charges.
 *  - HARD RULE: comp activity is non-transactional. Wallets,
 *    platform_stats, the transactions table and rank_score are
 *    byte-identical before/after every house action; the decline /
 *    leave / live-end / safety-kill refund paths never fabricate a
 *    refund for a house request.
 *  - A normal fan at the same points is still charged exactly as
 *    before, and a non-house model still gets the fan-only 403s.
 *  - NOT comped (unchanged): private seat BUY, PPV unlock, tips.
 *
 * Harness: private-rooms pattern — the real server boots in a
 * throwaway temp copy with SEED_DEMO=1.
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
const serverSrc = read('server.js');
const appSrc = read('public/js/app.js');

/* ---------------- static pins ---------------- */

test('static: comp helper, widened gates and refund guards exist; money doors stay fan-only', () => {
  for (const frag of [
    'function isOwnerComp(user)',
    'const requireFanOrHouse',
    "app.post('/api/live/:id/join', identMiddleware, requireUser, requireFanOrHouse",
    "app.post('/api/live/:id/pay', identMiddleware, requireUser, requireFanOrHouse",
    "app.post('/api/live/:id/explicit-entry', identMiddleware, requireUser, requireFanOrHouse",
    "app.post('/api/live/:id/join-request', identMiddleware, requireUser, requireFanOrHouse",
    "app.post('/api/live/:id/leave', identMiddleware, requireUser, requireFanOrHouse",
    'if (isHouseAccountId(userId)) return true;',           // seatGate spectator pass
    'if (isHouseAccountId(fanId)) { stopLivePayTimer(sessionId, fanId); return; }', // billLiveMinute guard
    'is_house: isHouseAccountId(req.user.id)',              // /api/me client flag
    "if (req.user.role !== 'fan' && !isHouseAccountId(req.user.id))", // battles spectate + conversations/start
  ]) {
    assert.ok(serverSrc.includes(frag), `server carries: ${frag}`);
  }
  // The comp branches never stand next to a charge: the three live
  // money doors return owner_comp BEFORE any chargeFan call.
  const payIdx = serverSrc.indexOf("app.post('/api/live/:id/pay'");
  const payBlock = serverSrc.slice(payIdx, payIdx + 2600);
  assert.ok(payBlock.indexOf('isOwnerComp(req.user)') < payBlock.indexOf('chargeFan(')
    || !payBlock.includes('chargeFan('), 'pay: comp branch precedes any charge');
  // NOT comped — these doors keep their exact fan-only role gates.
  for (const frag of [
    "app.post('/api/private-events/:id/buy', identMiddleware, requireUser, requireRole('fan')",
    "app.post('/api/media/:id/unlock', identMiddleware, requireUser, requireRole('fan')",
  ]) {
    assert.ok(serverSrc.includes(frag), `still fan-only: ${frag}`);
  }
  // Client: both viewer doors admit the house via the /api/me flag.
  assert.ok((appSrc.match(/S\.user\.is_house/g) || []).length >= 2,
    'watchLive + openBattleStage check S.user.is_house');
  assert.ok(appSrc.includes('data.owner_comp'), 'client handles the comp /pay response');
});

/* ---------------- harness ---------------- */

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
  const env = { ...process.env, PORT: String(port), CRYPTO_POLL_MS: '3600000', SEED_DEMO: '1', ...extraEnv };
  for (const k of Object.keys(env)) {
    if (/^(CCBILL_|CRYPTO_|OPENAI_|TWILIO_|VAPID_|WEBAUTHN_|AV_)/.test(k)) delete env[k];
  }
  const c = spawn(process.execPath, ['server.js'], { cwd: dir, env });
  let log = '';
  c.stdout.on('data', (d) => { log += d; });
  c.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 45000;
  for (;;) {
    if (c.exitCode !== null) throw new Error(`server exited early (${c.exitCode})\n${log}`);
    try {
      const r = await fetch(base + '/api/health');
      if (r.ok) break;
    } catch (e) { /* not up yet */ }
    if (Date.now() > deadline) { c.kill('SIGKILL'); throw new Error(`server did not come up\n${log}`); }
    await new Promise((r) => setTimeout(r, 150));
  }
  return { child: c, base };
}
async function stop(h) {
  if (h && h.child && h.child.exitCode === null) {
    h.child.kill('SIGTERM');
    await Promise.race([
      new Promise((r) => h.child.once('exit', r)),
      new Promise((r) => setTimeout(r, 5000)),
    ]);
    if (h.child.exitCode === null) h.child.kill('SIGKILL');
  }
}
async function req(base, method, p, { body, token, headers: extra } = {}) {
  const headers = { ...(extra || {}) };
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
const PNG = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001080600000' +
  '01f15c4890000000a49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082', 'hex');
async function upload(base, p, token) {
  const fd = new FormData();
  for (const f of ['id_front', 'id_back', 'selfie']) {
    fd.append(f, new Blob([PNG], { type: 'image/png' }), `${f}.png`);
  }
  const r = await fetch(base + p, { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: fd });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
  return { status: r.status, text, json };
}
function openDb(dir, readOnly = true) {
  const d = new DatabaseSync(path.join(dir, 'wogent-chat.db'), readOnly ? { readOnly: true } : {});
  d.exec('PRAGMA busy_timeout = 10000');
  return d;
}
/* The whole money surface, serialized: any comp leak — a wallet cent,
 * a platform cent, a transaction row, a rank point — breaks equality. */
function moneySnapshot(dir) {
  const db = openDb(dir);
  const snap = JSON.stringify({
    wallets: db.prepare('SELECT user_id, credits_cents, earnings_cents FROM wallets ORDER BY user_id').all(),
    stats: db.prepare('SELECT earnings_cents FROM platform_stats WHERE id = 1').get(),
    tx: db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(gross_cents),0) AS gross, COALESCE(SUM(model_cents),0) AS mc, COALESCE(SUM(platform_cents),0) AS pc FROM transactions').get(),
    ranks: db.prepare('SELECT user_id, rank_score FROM models ORDER BY user_id').all(),
  });
  db.close();
  return snap;
}
function walletOf(dir, userId) {
  const db = openDb(dir);
  const w = db.prepare('SELECT credits_cents, earnings_cents FROM wallets WHERE user_id = ?').get(userId);
  db.close();
  return w;
}
function chicagoParts(date) {
  const parts = {};
  new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric',
    month: 'numeric', day: 'numeric', weekday: 'short' }).formatToParts(date)
    .forEach((p) => { parts[p.type] = p.value; });
  return parts;
}
function tzOffsetMs(tz, date) {
  const parts = {};
  new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric',
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(date).forEach((p) => { parts[p.type] = p.value; });
  const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24,
    +parts.minute, +parts.second);
  return asUTC - date.getTime();
}
function futureMondayIso() {
  const base = new Date(Date.now() + 30 * 86400000);
  const p = chicagoParts(base);
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
  const mondayDay = +p.day - ((wd + 6) % 7);
  const guess = Date.UTC(+p.year, +p.month - 1, mondayDay, 20, 0);
  return new Date(guess - tzOffsetMs('America/Chicago', new Date(guess))).toISOString();
}

/* ---------------- runtime ---------------- */

test('runtime: house texts + joins every live free; ledger untouched; fans still pay', { timeout: 300000 }, async () => {
  const dir = makeCopy('ownercomp');
  let h = null;
  try {
    h = await boot(dir);
    const base = h.base;
    const mgrLogin = await req(base, 'POST', '/api/manager/login', { body: { username: 'admin', password: 'admin123' } });
    assert.equal(mgrLogin.status, 200, `manager login: ${mgrLogin.text}`);
    const MGR = { token: mgrLogin.json.token, headers: { 'x-manager': '1' } };

    const suffix = Math.random().toString(36).slice(2, 8);
    const signup = async (username, role, extra = {}) => {
      const s = await req(base, 'POST', '/api/auth/signup', {
        body: { username, password: 'hunter22x', role,
          display_name: username, dob: '1995-05-05', agree18: true, ...extra },
      });
      assert.equal(s.status, 200, `signup ${username}: ${s.text}`);
      return { token: s.json.token, id: s.json.user.id, username };
    };
    // The house account: username EXACTLY asceaaspade (identity is the username).
    const house = await signup('asceaaspade', 'model', { section: 'female' });
    const model = await signup('ocmodel' + suffix, 'model', { section: 'female' });
    const model2 = await signup('ocmodel2' + suffix, 'model', { section: 'female' });
    const model3 = await signup('ocmodel3' + suffix, 'model', { section: 'female' });
    const fan = await signup('ocfan' + suffix, 'fan');
    const fan2 = await signup('ocfan2' + suffix, 'fan');

    const verifyOwnId = async (acct) => {
      const up = await upload(base, '/api/model/id-verification', acct.token);
      assert.equal(up.status, 200, `ID upload ${acct.username}: ${up.text}`);
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
    await verifyOwnId(model);
    await verifyOwnId(model2);

    {
      const db = openDb(dir, false);
      db.prepare('UPDATE wallets SET credits_cents = 100000 WHERE user_id IN (?, ?)').run(fan.id, fan2.id);
      db.prepare('UPDATE models SET explicit_rate_cents = 500 WHERE user_id = ?').run(model.id);
      db.close();
    }
    const perMsg = openDb(dir).prepare('SELECT per_message_cents FROM models WHERE user_id = ?').get(model.id).per_message_cents;
    assert.ok(perMsg > 0, 'model has a per-message price');

    /* /api/me flag: house true, fan false */
    {
      const meH = await req(base, 'GET', '/api/me', { token: house.token });
      assert.equal(meH.json.user.is_house, true, 'house flagged on /api/me');
      const meF = await req(base, 'GET', '/api/me', { token: fan.token });
      assert.equal(meF.json.user.is_house, false, 'fan not flagged');
    }

    /* ---------- TEXTS ---------- */
    // Fan control: 3 free, the 4th charges exactly per_message_cents.
    const fanConv = await req(base, 'POST', '/api/conversations/start', { token: fan.token, body: { model_id: model.id } });
    assert.equal(fanConv.status, 200, `fan start: ${fanConv.text}`);
    const fanConvId = fanConv.json.conversation.id;
    for (let i = 0; i < 3; i++) {
      const m = await req(base, 'POST', '/api/messages', { token: fan.token,
        body: { conversation_id: fanConvId, body: `free ${i}` } });
      assert.equal(m.status, 200, m.text);
      assert.equal(m.json.cost_cents, 0, 'trial messages are free');
    }
    const fanW0 = walletOf(dir, fan.id).credits_cents;
    const paid = await req(base, 'POST', '/api/messages', { token: fan.token,
      body: { conversation_id: fanConvId, body: 'fourth — paid' } });
    assert.equal(paid.status, 200, paid.text);
    assert.equal(paid.json.cost_cents, perMsg, 'fan charged the model rate');
    assert.equal(walletOf(dir, fan.id).credits_cents, fanW0 - perMsg, 'fan wallet debited');

    // A non-house MODEL still cannot open a fan-side chat.
    const modelStart = await req(base, 'POST', '/api/conversations/start', { token: model2.token, body: { model_id: model.id } });
    assert.equal(modelStart.status, 403, `non-house model start refused: ${modelStart.text}`);
    assert.equal(modelStart.json.error, 'fans_only');

    // House: opens the chat, sends past the trial, pays nothing, and
    // the model actually receives the messages.
    const snapTexts0 = moneySnapshot(dir);
    const houseConv = await req(base, 'POST', '/api/conversations/start', { token: house.token, body: { model_id: model.id } });
    assert.equal(houseConv.status, 200, `house start: ${houseConv.text}`);
    const houseConvId = houseConv.json.conversation.id;
    for (let i = 0; i < 5; i++) {
      const m = await req(base, 'POST', '/api/messages', { token: house.token,
        body: { conversation_id: houseConvId, body: `house text ${i} 💋` } });
      assert.equal(m.status, 200, `house send ${i}: ${m.text}`);
      assert.equal(m.json.cost_cents, 0, 'house text is free');
    }
    {
      const db = openDb(dir);
      const trials = db.prepare('SELECT COUNT(*) AS n FROM free_trials WHERE subject_key = ?').get(`u:${house.id}`).n;
      assert.equal(trials, 0, 'house consumed no free-trial allowance');
      const got = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND sender_id = ?')
        .get(houseConvId, house.id).n;
      assert.equal(got, 5, 'house messages stored in the thread');
      db.close();
    }
    const thread = await req(base, 'GET', `/api/conversations/${houseConvId}/messages`, { token: model.token });
    assert.equal(thread.status, 200, thread.text);
    assert.ok(JSON.stringify(thread.json).includes('house text 4'), 'model reads the house texts');
    assert.equal(moneySnapshot(dir), snapTexts0, 'LEDGER: house texts moved no money');

    /* ---------- PUBLIC LIVE + EXPLICIT ---------- */
    const start = await req(base, 'POST', '/api/live/start', { token: model.token, body: { title: 'OC live' } });
    assert.equal(start.status, 200, `live start: ${start.text}`);
    const sid = start.json.session_id;

    // Non-house model still refused at the viewer door (control).
    const modelJoin = await req(base, 'POST', `/api/live/${sid}/join`, { token: model2.token });
    assert.equal(modelJoin.status, 403, `non-house model join refused: ${modelJoin.text}`);

    const fanJoin = await req(base, 'POST', `/api/live/${sid}/join`, { token: fan.token });
    assert.equal(fanJoin.status, 200, `fan join: ${fanJoin.text}`);
    const houseJoin = await req(base, 'POST', `/api/live/${sid}/join`, { token: house.token });
    assert.equal(houseJoin.status, 200, `house join: ${houseJoin.text}`);
    assert.equal(houseJoin.json.explicit_paid, true, 'house joins comped-unblurred');
    assert.ok(houseJoin.json.explicit_until > Date.now() + 365 * 86400000, 'house grace is far-future');
    assert.equal(houseJoin.json.explicit_entry_cents, 0, 'house sees $0 entry');
    assert.equal(houseJoin.json.join_cents, 0, 'house sees $0 stage fee');
    const entryCents = fanJoin.json.explicit_entry_cents;
    assert.ok(entryCents > 0, 'fan sees the real entry price');

    const flip = await req(base, 'POST', `/api/live/${sid}/mode`, { token: model.token, body: { is_explicit: 1 } });
    assert.equal(flip.status, 200, `mode flip: ${flip.text}`);

    const snapLive0 = moneySnapshot(dir);
    const hEntry = await req(base, 'POST', `/api/live/${sid}/explicit-entry`, { token: house.token });
    assert.equal(hEntry.status, 200, `house entry: ${hEntry.text}`);
    assert.equal(hEntry.json.owner_comp, true, 'house entry is comp');
    const hPay = await req(base, 'POST', `/api/live/${sid}/pay`, { token: house.token });
    assert.equal(hPay.status, 200, `house pay: ${hPay.text}`);
    assert.equal(hPay.json.owner_comp, true, 'house unblur is comp');
    assert.equal(hPay.json.rate_cents, 0, 'house per-minute rate is $0');
    assert.equal(moneySnapshot(dir), snapLive0, 'LEDGER: house explicit entry + unblur moved no money');

    // Fan control: entry charges exactly the entry price, once.
    const fanW1 = walletOf(dir, fan.id).credits_cents;
    const fEntry = await req(base, 'POST', `/api/live/${sid}/explicit-entry`, { token: fan.token });
    assert.equal(fEntry.status, 200, `fan entry: ${fEntry.text}`);
    assert.equal(walletOf(dir, fan.id).credits_cents, fanW1 - entryCents, 'fan debited the entry price');
    const modelEarn = walletOf(dir, model.id).earnings_cents;
    assert.ok(modelEarn > 0, 'model earned from the fan entry');

    /* ---------- STAGE JOIN-REQUESTS ---------- */
    // Fan: charged the stage fee; decline refunds in full.
    const fanW2 = walletOf(dir, fan.id).credits_cents;
    const fReq = await req(base, 'POST', `/api/live/${sid}/join-request`, { token: fan.token, body: { mode: 'video' } });
    assert.equal(fReq.status, 200, `fan stage req: ${fReq.text}`);
    assert.ok(fReq.json.fee_cents > 0, 'fan fee is real');
    assert.equal(walletOf(dir, fan.id).credits_cents, fanW2 - fReq.json.fee_cents, 'fan debited the stage fee');
    const fDec = await req(base, 'POST', `/api/live/join-requests/${fReq.json.request_id}/decline`, { token: model.token });
    assert.equal(fDec.status, 200, `fan decline: ${fDec.text}`);
    assert.equal(fDec.json.refunded_cents, fReq.json.fee_cents, 'fan refunded in full');
    assert.equal(walletOf(dir, fan.id).credits_cents, fanW2, 'fan made whole after decline');

    // House: $0 fee; decline fabricates NO refund; ledger identical.
    const snapStage0 = moneySnapshot(dir);
    const hReq = await req(base, 'POST', `/api/live/${sid}/join-request`, { token: house.token, body: { mode: 'video' } });
    assert.equal(hReq.status, 200, `house stage req: ${hReq.text}`);
    assert.equal(hReq.json.fee_cents, 0, 'house stage fee is $0');
    const hDec = await req(base, 'POST', `/api/live/join-requests/${hReq.json.request_id}/decline`, { token: model.token });
    assert.equal(hDec.status, 200, `house decline: ${hDec.text}`);
    assert.equal(hDec.json.refunded_cents, 0, 'no fabricated refund for the house');
    assert.equal(moneySnapshot(dir), snapStage0, 'LEDGER: house stage request + decline moved no money');

    // House request left pending, then she ends the live: the end
    // cleanup declines it with NO refund fabrication.
    const hReq2 = await req(base, 'POST', `/api/live/${sid}/join-request`, { token: house.token, body: { mode: 'mic' } });
    assert.equal(hReq2.status, 200, `house stage req 2: ${hReq2.text}`);
    const snapEnd0 = moneySnapshot(dir);
    const end = await req(base, 'POST', `/api/live/${sid}/end`, { token: model.token });
    assert.equal(end.status, 200, `live end: ${end.text}`);
    assert.equal(moneySnapshot(dir), snapEnd0, 'LEDGER: live-end cleanup moved no money for a house request');
    {
      const db = openDb(dir);
      const row = db.prepare('SELECT status FROM live_join_requests WHERE id = ?').get(hReq2.json.request_id);
      assert.equal(row.status, 'declined', 'house request auto-declined at end');
      db.close();
    }

    /* ---------- PRIVATE ROOM ---------- */
    const evRes = await req(base, 'POST', '/api/model/private-events', { token: model.token,
      body: { title: 'OC Penthouse', starts_at: futureMondayIso(), seats: 3, seat_price_cents: 1500 } });
    assert.equal(evRes.status, 200, `create event: ${evRes.text}`);
    const evId = evRes.json.event.id;
    {
      const db = openDb(dir, false);
      db.prepare('UPDATE private_events SET invite_window_ends_at = ? WHERE id = ?')
        .run(new Date(Date.now() - 3600000).toISOString(), evId);
      db.close();
    }
    // House view: has the seat (spectator pass), can never buy.
    const hEv = await req(base, 'GET', `/api/private-events/${evId}`, { token: house.token });
    assert.equal(hEv.status, 200, `house event view: ${hEv.text}`);
    assert.equal(hEv.json.event.has_seat, true, 'house shows as seated (comp pass)');
    assert.equal(hEv.json.event.can_buy, false, 'house can never buy a seat');
    const hBuy = await req(base, 'POST', `/api/private-events/${evId}/buy`, { token: house.token });
    assert.equal(hBuy.status, 403, `house buy stays fan-only: ${hBuy.text}`);

    // Fan control: buys the seat at full price.
    const fanW3 = walletOf(dir, fan.id).credits_cents;
    const fBuy = await req(base, 'POST', `/api/private-events/${evId}/buy`, { token: fan.token });
    assert.equal(fBuy.status, 200, `fan buy: ${fBuy.text}`);
    assert.equal(walletOf(dir, fan.id).credits_cents, fanW3 - 1500, 'fan debited the seat price');

    const pStart = await req(base, 'POST', '/api/live/start', { token: model.token,
      body: { title: 'OC Penthouse live', private_event_id: evId } });
    assert.equal(pStart.status, 200, `private start: ${pStart.text}`);
    const psid = pStart.json.session_id;

    const snapPriv0 = moneySnapshot(dir);
    const hPJoin = await req(base, 'POST', `/api/live/${psid}/join`, { token: house.token });
    assert.equal(hPJoin.status, 200, `house joins the private live: ${hPJoin.text}`);
    assert.equal(moneySnapshot(dir), snapPriv0, 'LEDGER: house private-room entry moved no money');
    {
      const db = openDb(dir);
      const seats = db.prepare('SELECT COUNT(*) AS n FROM private_event_seats WHERE event_id = ?').get(evId).n;
      assert.equal(seats, 1, 'house consumed NO sellable seat (only the fan seat row exists)');
      const houseSeat = db.prepare('SELECT COUNT(*) AS n FROM private_event_seats WHERE event_id = ? AND fan_id = ?')
        .get(evId, house.id).n;
      assert.equal(houseSeat, 0, 'no seat row for the house');
      db.close();
    }
    // Controls: a seatless fan is refused; the seat-holder enters.
    const noSeat = await req(base, 'POST', `/api/live/${psid}/join`, { token: fan2.token });
    assert.equal(noSeat.status, 403, `seatless fan refused: ${noSeat.text}`);
    assert.equal(noSeat.json.error, 'seat_required');
    const seatJoin = await req(base, 'POST', `/api/live/${psid}/join`, { token: fan.token });
    assert.equal(seatJoin.status, 200, `seat-holder join: ${seatJoin.text}`);
    const pEnd = await req(base, 'POST', `/api/live/${psid}/end`, { token: model.token });
    assert.equal(pEnd.status, 200, `private end: ${pEnd.text}`);

    /* ---------- BATTLE SPECTATING ---------- */
    const goLive = async (acct) => {
      const r = await req(base, 'POST', '/api/live/start', { token: acct.token, body: { title: 'OC battle live' } });
      assert.equal(r.status, 200, `go live ${acct.username}: ${r.text}`);
      return r.json.session_id;
    };
    await goLive(model);
    await goLive(model2);
    const inv = await req(base, 'POST', '/api/battles/invite', { token: model.token,
      body: { opponent_id: model2.id, minutes: 5 } });
    assert.equal(inv.status, 200, `battle invite: ${inv.text}`);
    const bid = inv.json.battle.id;
    const acc = await req(base, 'POST', `/api/battles/${bid}/accept`, { token: model2.token });
    assert.equal(acc.status, 200, `battle accept: ${acc.text}`);
    await req(base, 'POST', `/api/battles/${bid}/ready`, { token: model.token });
    const rdy = await req(base, 'POST', `/api/battles/${bid}/ready`, { token: model2.token });
    assert.equal(rdy.json.battle.status, 'live', `battle live: ${rdy.text}`);

    // Non-battler model control: refused.
    const m3Enter = await req(base, 'POST', `/api/battles/${bid}/enter`, { token: model3.token });
    assert.equal(m3Enter.status, 403, `non-battler model refused: ${m3Enter.text}`);

    const snapBattle0 = moneySnapshot(dir);
    const hEnter = await req(base, 'POST', `/api/battles/${bid}/enter`, { token: house.token });
    assert.equal(hEnter.status, 200, `house spectates: ${hEnter.text}`);
    assert.equal(moneySnapshot(dir), snapBattle0, 'LEDGER: house battle spectating moved no money');
    {
      const db = openDb(dir);
      const bv = db.prepare('SELECT COUNT(*) AS n FROM battle_viewers WHERE battle_id = ? AND fan_id = ?')
        .get(bid, house.id).n;
      assert.equal(bv, 1, 'house recorded as a battle viewer');
      db.close();
    }
    const fEnter = await req(base, 'POST', `/api/battles/${bid}/enter`, { token: fan.token });
    assert.equal(fEnter.status, 200, `fan spectates as before: ${fEnter.text}`);
  } finally {
    await stop(h);
  }
});
