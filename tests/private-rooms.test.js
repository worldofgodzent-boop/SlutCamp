'use strict';
/*
 * Phase 5 — Private Room Events (owner-designed 2026-10-20;
 * spec: phase5-private-rooms-spec.md). ADDITIVE penthouse layer:
 * public lives and explicit rooms are untouched.
 *
 * Pins the locked design:
 *  - Weekly cap: platform-set (Manager-adjustable, default 2) per model
 *    per Mon–Sun America/Chicago week, counted by event start; she picks
 *    the days; cancelling frees the slot; a different week is unaffected.
 *  - Top-spenders tracker: her fans ranked by NET spend ON HER from the
 *    fan-spend ledger (refunds net out, test rows excluded, banned fans
 *    out), all-time + last-30-days.
 *  - Invite broadcast: ONE system message per selected fan per event
 *    (the invite row is the frequency limit), spenders only, bell links
 *    the DM thread; re-inviting sends nothing twice.
 *  - Seat purchase: invitees first during the invite window (24h from
 *    creation, capped at showtime), then public leftovers; standard
 *    60/40 chargeFan split; sold out / double-buy / low balance refused.
 *  - Private live: seat-holders only (join + chat gated), never listed
 *    publicly, followers NOT blasted, seat-holders belled at the event.
 *  - Cancel + stale sweep refund every seat in full (private_seat_refund
 *    nets rank/earnings automatically).
 *  - The model announcement ships as code and fires exactly once.
 *  - Schema migrates a PREVIOUS-version database (booted from HEAD code).
 *
 * Harness: safety-pii-block / face-count-guard patterns — the real
 * server boots in throwaway temp copies with SEED_DEMO=1.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const vm = require('node:vm');
const { spawn, execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const REPO = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const serverSrc = read('server.js');
const appSrc = read('public/js/app.js');
const managerSrc = read('public/manager/manager.js');

/* ---------------- SRV / I18N eval helpers ---------------- */

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
const LANGS = ['en', 'es', 'pt', 'fr', 'de', 'ru', 'ja', 'zh', 'ko', 'it', 'pl', 'nl', 'tr'];
const PR_SRV_KEYS = ['ann_privateroom_dm', 'ann_privateroom_bell_title', 'ann_privateroom_bell_body',
  'private_invite_msg', 'private_invite_bell_title', 'private_invite_bell_body',
  'private_seat_bell_title', 'private_seat_bell_body',
  'private_live_bell_title', 'private_live_bell_body',
  'private_cancel_bell_title', 'private_cancel_bell_body',
  'private_noshow_bell_title', 'private_noshow_bell_body'];

/* ---------------- static pins ---------------- */

test('static: private-room SRV copy exists in all 13 languages, EN is the owner draft', () => {
  for (const k of PR_SRV_KEYS) {
    assert.ok(SRV[k], `SRV key present: ${k}`);
    for (const lang of LANGS) {
      assert.equal(typeof SRV[k][lang], 'string', `${k}.${lang} is a string`);
      assert.ok(SRV[k][lang].trim().length > 0, `${k}.${lang} is not empty`);
    }
  }
  assert.ok(SRV.ann_privateroom_dm.en.startsWith('📣 NEW: The Private Room 🔒'),
    'announcement DM opens with the owner headline');
  assert.ok(SRV.ann_privateroom_dm.en.includes('max 2 private rooms per week'),
    'announcement DM carries the owner cap copy');
  assert.ok(SRV.ann_privateroom_dm.en.includes('These are your whales 🐳'),
    'announcement DM is the owner explainer verbatim');
  assert.ok(SRV.private_invite_msg.en.includes('{date}') && SRV.private_invite_msg.en.includes('{seats}') && SRV.private_invite_msg.en.includes('{price}'),
    'invite message templates its vars');
});

test('static: schema, endpoints, cap setting and client wiring exist', () => {
  for (const frag of ['CREATE TABLE IF NOT EXISTS private_events',
    'CREATE TABLE IF NOT EXISTS private_event_invites',
    'CREATE TABLE IF NOT EXISTS private_event_seats',
    "addColumnIfMissing('live_sessions', 'private_event_id'",
    "addColumnIfMissing('messages', 'private_event_id'",
    "addColumnIfMissing('platform_stats', 'private_room_announced_at'",
    "addColumnIfMissing('platform_stats', 'private_room_cap'",
    "app.get('/api/model/top-spenders'",
    "app.post('/api/model/private-events/:id/invite'",
    "app.post('/api/private-events/:id/buy'",
    "'private_seat'", "'private_seat_refund'",
    'function announcePrivateRoomsToModels()',
    'function sweepStalePrivateEvents()']) {
    assert.ok(serverSrc.includes(frag), `server carries: ${frag}`);
  }
  // Private lives never light the public surfaces.
  assert.ok(serverSrc.includes('ls.private_event_id IS NULL'),
    'public live surfaces exclude private sessions');
  // Client: view registered, bell route, tracker + event page strings used.
  assert.ok(appSrc.includes('privateEvent: vPrivateEvent'), 'privateEvent view registered');
  assert.ok(appSrc.includes('#pevent'), 'bell route handles #pevent links');
  for (const k of ['pr_h', 'pr_spenders', 'pr_buy', 'pr_start_room', 'pr_invites_sent']) {
    assert.ok(appSrc.includes(`t('${k}'`), `client uses t('${k}')`);
  }
  // Manager: the cap is adjustable in Settings.
  assert.ok(managerSrc.includes('set-prcap'), 'Manager has the private-room cap card');
  assert.ok(managerSrc.includes('private_room_cap'), 'Manager saves private_room_cap');
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

/* Chicago week helpers: find the Monday (Chicago) of the week that
   contains now+30d, so cap tests never straddle a week boundary. */
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
function chicagoToUtcIso(y, m, d, h, mi) {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  return new Date(guess - tzOffsetMs('America/Chicago', new Date(guess))).toISOString();
}
function futureMonday(addDays = 0) {
  const base = new Date(Date.now() + 30 * 86400000);
  const p = chicagoParts(base);
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
  const mondayDay = +p.day - ((wd + 6) % 7) + addDays;
  return chicagoToUtcIso(+p.year, +p.month, mondayDay, 20, 0);
}

/* ---------------- runtime: the whole feature ---------------- */

test('runtime: cap, tracker, invites, seats, private live, refunds, announcement-once', { timeout: 300000 }, async () => {
  const dir = makeCopy('privaterooms');
  let h = null;
  try {
    h = await boot(dir);
    const base = h.base;
    const mgrLogin = await req(base, 'POST', '/api/manager/login', { body: { username: 'admin', password: 'admin123' } });
    assert.equal(mgrLogin.status, 200, `manager login: ${mgrLogin.text}`);
    const MGR = { token: mgrLogin.json.token, headers: { 'x-manager': '1' } };

    /* --- announcement fired exactly once on first boot --- */
    {
      const db = openDb(dir);
      const bunny = db.prepare("SELECT id FROM users WHERE username = 'bunny'").get();
      const bells = db.prepare("SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND title = ?")
        .get(bunny.id, SRV.ann_privateroom_bell_title.en).c;
      assert.equal(bells, 1, 'seeded model got exactly one announcement bell');
      const stamp = db.prepare('SELECT private_room_announced_at FROM platform_stats WHERE id = 1').get();
      assert.ok(stamp.private_room_announced_at, 'announcement stamp set');
      const capRow = db.prepare('SELECT private_room_cap FROM platform_stats WHERE id = 1').get();
      assert.equal(capRow.private_room_cap, 2, 'default weekly cap is 2');
      db.close();
    }

    const suffix = Math.random().toString(36).slice(2, 8);
    const signup = async (username, role, extra = {}) => {
      const s = await req(base, 'POST', '/api/auth/signup', {
        body: { username: username + suffix, password: 'hunter22x', role,
          display_name: username, dob: '1995-05-05', agree18: true, ...extra },
      });
      assert.equal(s.status, 200, `signup ${username}: ${s.text}`);
      return { token: s.json.token, id: s.json.user.id, username: username + suffix };
    };
    const model = await signup('prmodel', 'model', { section: 'female' });
    const unverified = await signup('prraw', 'model', { section: 'female' });
    const F1 = await signup('prfan1', 'fan');
    const F2 = await signup('prfan2', 'fan');
    const F3 = await signup('prfan3', 'fan');
    const F4 = await signup('prfan4', 'fan');

    // ID-verify the model (upload + Manager approve), like the real gate.
    {
      const up = await upload(base, '/api/model/id-verification', model.token);
      assert.equal(up.status, 200, `ID upload: ${up.text}`);
      const q = await req(base, 'GET', '/api/admin/id-verifications', { ...MGR });
      const row = q.json.verifications.find((v) => v.model_id === model.id && !v.co_performer_id);
      assert.ok(row, 'ID submission queued');
      // PR #86: her own packet cannot be approved until her WOGENT
      // release is on file — she signs it first, like a real model.
      const sign = await req(base, 'POST', '/api/model/release/sign', { token: model.token, body: {
        legal_name: 'Test Signer', stage_name: model.username, dob: '1995-05-05',
        attestations: { adult: true, freewill: true, rights: true } } });
      assert.equal(sign.status, 200, `release sign: ${sign.text}`);
      const ap = await req(base, 'POST', `/api/admin/id-verifications/${row.id}/approve`, { ...MGR });
      assert.equal(ap.status, 200, `approve: ${ap.text}`);
    }
    // An unverified model cannot create (her room could never open).
    {
      const r = await req(base, 'POST', '/api/model/private-events', { token: unverified.token,
        body: { title: 'x', starts_at: futureMonday(0), seats: 5, seat_price_cents: 1000 } });
      assert.equal(r.status, 403, r.text);
      assert.equal(r.json.error, 'id_verification_required');
    }

    // Fund the fans (writable DB grant, booking-rate pattern).
    {
      const db = openDb(dir, false);
      for (const f of [F1, F2, F3]) {
        db.prepare('UPDATE wallets SET credits_cents = 100000 WHERE user_id = ?').run(f.id);
      }
      db.prepare('UPDATE wallets SET credits_cents = 100 WHERE user_id = ?').run(F4.id);
      db.close();
    }

    // Spend history: F1 $50, F2 $20, F3 $5 in tips ON HER.
    const convOf = {};
    for (const [f, amt] of [[F1, 5000], [F2, 2000], [F3, 500]]) {
      const st = await req(base, 'POST', '/api/conversations/start', { token: f.token, body: { model_id: model.id } });
      assert.equal(st.status, 200, `conv start: ${st.text}`);
      convOf[f.id] = st.json.conversation.id;
      const tip = await req(base, 'POST', '/api/tips', { token: f.token,
        body: { conversation_id: convOf[f.id], amount_cents: amt } });
      assert.equal(tip.status, 200, `tip: ${tip.text}`);
    }

    /* --- tracker ranking --- */
    {
      const tr = await req(base, 'GET', '/api/model/top-spenders', { token: model.token });
      assert.equal(tr.status, 200, tr.text);
      assert.deepEqual(tr.json.spenders.map((x) => x.fan_id), [F1.id, F2.id, F3.id],
        'ranked by net spend on her, biggest first');
      assert.deepEqual(tr.json.spenders.map((x) => x.spend_cents), [5000, 2000, 500]);
      const tr30 = await req(base, 'GET', '/api/model/top-spenders?range=30d', { token: model.token });
      assert.deepEqual(tr30.json.spenders.map((x) => x.fan_id), [F1.id, F2.id, F3.id], '30d range ranks too');
      // Test rows never count: flip F3's tip to is_test and he drops off.
      const db = openDb(dir, false);
      db.prepare("UPDATE transactions SET is_test = 1 WHERE fan_id = ? AND type = 'tip'").run(F3.id);
      db.close();
      const tr2 = await req(base, 'GET', '/api/model/top-spenders', { token: model.token });
      assert.deepEqual(tr2.json.spenders.map((x) => x.fan_id), [F1.id, F2.id], 'is_test spend excluded');
    }

    /* --- weekly cap --- */
    const mk = (starts_at, extra = {}) => req(base, 'POST', '/api/model/private-events', {
      token: model.token,
      body: { title: 'Room', starts_at, seats: 2, seat_price_cents: 1000, ...extra },
    });
    const E1 = await mk(futureMonday(0));
    assert.equal(E1.status, 200, `E1: ${E1.text}`);
    const E2 = await mk(futureMonday(1));
    assert.equal(E2.status, 200, `E2: ${E2.text}`);
    const E3over = await mk(futureMonday(2));
    assert.equal(E3over.status, 409, `third same-week event refused: ${E3over.text}`);
    assert.equal(E3over.json.error, 'weekly_cap_reached');
    // Validation pins.
    assert.equal((await mk(futureMonday(3), { seats: 21 })).status, 400, 'seat ceiling 20');
    assert.equal((await mk(futureMonday(3), { seat_price_cents: 50 })).status, 400, 'price floor $1');
    assert.equal((await mk(new Date(Date.now() - 3600000).toISOString())).status, 400, 'no past events');
    // Cancelling frees the slot.
    const cx = await req(base, 'POST', `/api/model/private-events/${E2.json.event.id}/cancel`, { token: model.token });
    assert.equal(cx.status, 200, cx.text);
    const E3 = await mk(futureMonday(2));
    assert.equal(E3.status, 200, `after cancel a new same-week event fits: ${E3.text}`);
    // A different week is a different budget.
    const E4 = await mk(futureMonday(7));
    assert.equal(E4.status, 200, `next week allowed: ${E4.text}`);
    // Manager raises the cap → honored immediately.
    const setCap = await req(base, 'PUT', '/api/admin/settings', { ...MGR, body: { private_room_cap: 3 } });
    assert.equal(setCap.status, 200, setCap.text);
    const E5 = await mk(futureMonday(3));
    assert.equal(E5.status, 200, `cap 3 admits a third live event: ${E5.text}`);
    const badCap = await req(base, 'PUT', '/api/admin/settings', { ...MGR, body: { private_room_cap: 9 } });
    assert.equal(badCap.status, 400, 'cap range is 1..7');

    const e1 = E1.json.event.id;

    /* --- invite broadcast: selected spenders only, exactly once --- */
    {
      const inv = await req(base, 'POST', `/api/model/private-events/${e1}/invite`, {
        token: model.token, body: { fan_ids: [F1.id, F2.id, F4.id] } });
      assert.equal(inv.status, 200, inv.text);
      assert.equal(inv.json.invited, 2, 'two spenders invited');
      assert.equal(inv.json.skipped, 1, 'non-spender skipped');
      const db = openDb(dir);
      const msgs = db.prepare('SELECT * FROM messages WHERE private_event_id = ?').all(e1);
      assert.equal(msgs.length, 2, 'exactly one invite message per invited fan');
      assert.ok(msgs.every((m) => m.sender_id === model.id), 'invite arrives in her DM thread with her fans');
      const bell = db.prepare("SELECT * FROM notifications WHERE user_id = ? AND link LIKE '/#chat/%' AND title LIKE ?")
        .get(F1.id, '%invited you to her Private Room');
      assert.ok(bell, 'invitee belled, linked at the DM thread');
      const again = await req(base, 'POST', `/api/model/private-events/${e1}/invite`, {
        token: model.token, body: { fan_ids: [F1.id] } });
      assert.equal(again.json.invited, 0, 're-invite sends nothing twice');
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM messages WHERE private_event_id = ?').get(e1).c, 2);
      db.close();
    }

    /* --- seat purchase: invite window, split, sold out --- */
    {
      const noInv = await req(base, 'POST', `/api/private-events/${e1}/buy`, { token: F3.token });
      assert.equal(noInv.status, 403, `non-invitee refused during window: ${noInv.text}`);
      assert.equal(noInv.json.error, 'invite_only');
      const before = openDb(dir).prepare('SELECT credits_cents FROM wallets WHERE user_id = ?').get(F1.id).credits_cents;
      const buy1 = await req(base, 'POST', `/api/private-events/${e1}/buy`, { token: F1.token });
      assert.equal(buy1.status, 200, buy1.text);
      assert.equal(buy1.json.seats_left, 1);
      const db = openDb(dir);
      assert.equal(db.prepare('SELECT credits_cents FROM wallets WHERE user_id = ?').get(F1.id).credits_cents,
        before - 1000, 'seat price debited');
      const tx = db.prepare("SELECT * FROM transactions WHERE fan_id = ? AND type = 'private_seat'").get(F1.id);
      assert.ok(tx && tx.gross_cents === 1000 && tx.model_cents === 600 && tx.platform_cents === 400,
        'standard 60/40 split on the seat charge');
      const dup = await req(base, 'POST', `/api/private-events/${e1}/buy`, { token: F1.token });
      assert.equal(dup.status, 409, 'one seat per fan');
      assert.equal(dup.json.error, 'already_seated');
      const buy2 = await req(base, 'POST', `/api/private-events/${e1}/buy`, { token: F2.token });
      assert.equal(buy2.status, 200, 'second seat sells');
      db.close();
      // Public phase: backdate the invite-window end so it has passed.
      const dbw = openDb(dir, false);
      dbw.prepare("UPDATE private_events SET invite_window_ends_at = ? WHERE id = ?")
        .run(new Date(Date.now() - 3600000).toISOString(), E5.json.event.id);
      dbw.close();
      const pub = await req(base, 'GET', `/api/private-events/${E5.json.event.id}`, { token: F3.token });
      assert.equal(pub.json.event.phase, 'public', 'leftover seats open publicly after the window');
      // E5 has 2 seats: F3 takes one publicly, F1 the last, then sold out.
      assert.equal((await req(base, 'POST', `/api/private-events/${E5.json.event.id}/buy`, { token: F3.token })).status, 200);
      assert.equal((await req(base, 'POST', `/api/private-events/${E5.json.event.id}/buy`, { token: F1.token })).status, 200);
      const sold = await req(base, 'POST', `/api/private-events/${E5.json.event.id}/buy`, { token: F2.token });
      assert.equal(sold.status, 409, sold.text);
      assert.equal(sold.json.error, 'sold_out');
      // Insufficient credits on a fresh public event.
      const E6 = await mk(futureMonday(14));
      assert.equal(E6.status, 200);
      const dbw2 = openDb(dir, false);
      dbw2.prepare("UPDATE private_events SET invite_window_ends_at = ? WHERE id = ?")
        .run(new Date(Date.now() - 3600000).toISOString(), E6.json.event.id);
      dbw2.close();
      const poor = await req(base, 'POST', `/api/private-events/${E6.json.event.id}/buy`, { token: F4.token });
      assert.equal(poor.status, 402, `low balance refused: ${poor.text}`);
    }

    /* --- private live: seat-holders only, invisible publicly --- */
    let sessionId = null;
    {
      const f2Bells = openDb(dir).prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ?').get(F2.id).c;
      const f3Bells = openDb(dir).prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ?').get(F3.id).c;
      const start = await req(base, 'POST', '/api/live/start', { token: model.token,
        body: { title: 'Penthouse', private_event_id: e1 } });
      assert.equal(start.status, 200, `private start: ${start.text}`);
      sessionId = start.json.session_id;
      assert.ok(sessionId, 'session created');
      const db = openDb(dir);
      const f2After = db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ?').get(F2.id).c;
      const f3After = db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ?').get(F3.id).c;
      assert.ok(f2After > f2Bells, 'seat-holder belled at showtime');
      assert.equal(f3After, f3Bells, 'non-holder NOT belled (no follower blast)');
      const liveBell = db.prepare("SELECT * FROM notifications WHERE user_id = ? AND link = ?")
        .get(F2.id, `/#pevent/${e1}`);
      assert.ok(liveBell, 'showtime bell links the event page');
      db.close();
      const list = await req(base, 'GET', '/api/live', { token: F1.token });
      assert.ok(!(list.json.sessions || []).some((s) => s.id === sessionId),
        'private session never appears in the public live list');
      const joinNo = await req(base, 'POST', `/api/live/${sessionId}/join`, { token: F3.token });
      assert.equal(joinNo.status, 403, `non-holder join refused: ${joinNo.text}`);
      assert.equal(joinNo.json.error, 'seat_required');
      const joinOk = await req(base, 'POST', `/api/live/${sessionId}/join`, { token: F1.token });
      assert.equal(joinOk.status, 200, `seat-holder joins: ${joinOk.text}`);
      const chatNo = await req(base, 'GET', `/api/live/${sessionId}/chat`, { token: F3.token });
      assert.equal(chatNo.status, 403, 'non-holder cannot read the room chat');
      const chatOk = await req(base, 'GET', `/api/live/${sessionId}/chat`, { token: F1.token });
      assert.equal(chatOk.status, 200, 'seat-holder reads the room chat');
      const view = await req(base, 'GET', `/api/private-events/${e1}`, { token: F1.token });
      assert.equal(view.json.event.status, 'live');
      assert.equal(view.json.event.has_seat, true);
      const end = await req(base, 'POST', `/api/live/${sessionId}/end`, { token: model.token });
      assert.equal(end.status, 200, end.text);
      const after = await req(base, 'GET', `/api/private-events/${e1}`, { token: F1.token });
      assert.equal(after.json.event.status, 'ended', 'ending the live closes the event');
    }

    /* --- cancel refunds every seat in full --- */
    {
      const e3 = E3.json.event.id;
      const inv = await req(base, 'POST', `/api/model/private-events/${e3}/invite`, {
        token: model.token, body: { fan_ids: [F1.id] } });
      assert.equal(inv.json.invited, 1);
      assert.equal((await req(base, 'POST', `/api/private-events/${e3}/buy`, { token: F1.token })).status, 200);
      const before = openDb(dir).prepare('SELECT credits_cents FROM wallets WHERE user_id = ?').get(F1.id).credits_cents;
      const cx = await req(base, 'POST', `/api/model/private-events/${e3}/cancel`, { token: model.token });
      assert.equal(cx.status, 200, cx.text);
      assert.equal(cx.json.refunded, 1, 'one seat refunded');
      const db = openDb(dir);
      assert.equal(db.prepare('SELECT credits_cents FROM wallets WHERE user_id = ?').get(F1.id).credits_cents,
        before + 1000, 'full seat price back in the wallet');
      const rtx = db.prepare("SELECT * FROM transactions WHERE fan_id = ? AND type = 'private_seat_refund'").get(F1.id);
      assert.ok(rtx && rtx.gross_cents === -1000 && rtx.model_cents === -600,
        'refund nets the split back out of the ledger');
      assert.equal(db.prepare('SELECT status FROM private_events WHERE id = ?').get(e3).status, 'cancelled');
      db.close();
      // …and the tracker nets it too: F1 = 5000 tip + 1000 (E1 seat) +
      // 1000 (E5 seat) + 1000 (E3 seat) − 1000 (E3 refund) = 7000.
      const tr = await req(base, 'GET', '/api/model/top-spenders', { token: model.token });
      const f1 = tr.json.spenders.find((x) => x.fan_id === F1.id);
      assert.equal(f1.spend_cents, 7000, 'tracker counts seats and nets refunds');
    }

    /* --- stale sweep on reboot + announcement stays silent --- */
    {
      const E7 = await mk(futureMonday(21));
      assert.equal(E7.status, 200, E7.text);
      const e7 = E7.json.event.id;
      const dbw = openDb(dir, false);
      dbw.prepare("UPDATE private_events SET invite_window_ends_at = ? WHERE id = ?")
        .run(new Date(Date.now() - 3600000).toISOString(), e7);
      dbw.close();
      assert.equal((await req(base, 'POST', `/api/private-events/${e7}/buy`, { token: F2.token })).status, 200,
        'seat bought in the (backdated) public phase');
      const dbw2 = openDb(dir, false);
      dbw2.prepare('UPDATE private_events SET starts_at = ? WHERE id = ?')
        .run(new Date(Date.now() - 4 * 3600000).toISOString(), e7);
      const bunnyId = dbw2.prepare("SELECT id FROM users WHERE username = 'bunny'").get().id;
      const bellsBefore = dbw2.prepare("SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND title = ?")
        .get(bunnyId, SRV.ann_privateroom_bell_title.en).c;
      const f2Before = dbw2.prepare('SELECT credits_cents FROM wallets WHERE user_id = ?').get(F2.id).credits_cents;
      dbw2.close();
      await stop(h);
      h = await boot(dir); // sweep runs at boot; announcement must NOT refire
      const db = openDb(dir);
      assert.equal(db.prepare('SELECT status FROM private_events WHERE id = ?').get(e7).status, 'ended',
        'stale event closed by the sweep');
      assert.equal(db.prepare('SELECT credits_cents FROM wallets WHERE user_id = ?').get(F2.id).credits_cents,
        f2Before + 1000, 'no-show seat refunded in full');
      assert.equal(db.prepare("SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND title = ?")
        .get(bunnyId, SRV.ann_privateroom_bell_title.en).c, bellsBefore,
        'announcement does not fire twice');
      db.close();
    }
  } finally {
    await stop(h);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------- migration: previous version's schema ---------------- */

test('migration: a database created by the previous (pre-Phase-5) code upgrades in place', { timeout: 300000 }, async () => {
  const dir = makeCopy('prold');
  let h = null;
  try {
    // Replace the working tree files with the pinned pre-Phase-5 base
    // commit (PR #73 merge) and boot THAT, so the DB is genuinely the
    // previous version's schema. The base is pinned explicitly: HEAD on
    // this branch IS the Phase 5 commit, so "HEAD" is no longer the
    // previous version.
    const PREV = 'dcb199b0ee56b6db94d6aa978f06260928258886';
    const headFiles = execFileSync('git', ['-C', REPO, 'ls-tree', '-r', '--name-only', PREV],
      { encoding: 'utf8' }).split('\n').filter(Boolean)
      .filter((f) => f.startsWith('lib/') || f.startsWith('public/') || f === 'server.js' || f === 'package.json');
    for (const f of headFiles) {
      const content = execFileSync('git', ['-C', REPO, 'show', `${PREV}:${f}`], { maxBuffer: 128 * 1024 * 1024 });
      fs.mkdirSync(path.join(dir, path.dirname(f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), content);
    }
    h = await boot(dir);
    const login = await req(h.base, 'POST', '/api/auth/login', { body: { username: 'bunny', password: 'model123' } });
    assert.equal(login.status, 200, `old-code login: ${login.text}`);
    const bunnyToken = login.json.token;
    const bunnyId = login.json.user.id;
    await stop(h); h = null;
    {
      const db = openDb(dir);
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
      assert.ok(!tables.includes('private_events'), 'old schema has no private_events yet');
      db.close();
    }
    // Upgrade: drop the NEW code over the old database and boot.
    for (const d of ['server.js', 'package.json', 'lib', 'public']) {
      fs.rmSync(path.join(dir, d), { recursive: true, force: true });
      fs.cpSync(path.join(REPO, d), path.join(dir, d), { recursive: true });
    }
    h = await boot(dir);
    const db = openDb(dir);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
    for (const t of ['private_events', 'private_event_invites', 'private_event_seats']) {
      assert.ok(tables.includes(t), `migration creates ${t}`);
    }
    const psCols = db.prepare('PRAGMA table_info(platform_stats)').all().map((r) => r.name);
    assert.ok(psCols.includes('private_room_cap') && psCols.includes('private_room_announced_at'),
      'platform_stats gains the cap + stamp');
    const lsCols = db.prepare('PRAGMA table_info(live_sessions)').all().map((r) => r.name);
    assert.ok(lsCols.includes('private_event_id'), 'live_sessions gains private_event_id');
    const me = db.prepare('SELECT username FROM users WHERE id = ?').get(bunnyId);
    assert.equal(me.username, 'bunny', 'pre-existing data intact');
    db.close();
    const list = await req(h.base, 'GET', '/api/model/private-events', { token: bunnyToken });
    assert.equal(list.status, 200, `feature works on the migrated DB: ${list.text}`);
    assert.equal(list.json.cap, 2, 'cap defaults to 2 on the migrated DB');
  } finally {
    await stop(h);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
