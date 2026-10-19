'use strict';
/*
 * Dedicated 1-on-1 booking rate (owner, Oct 18 2026 — relayed from
 * Stacey: "How do you even set bookings... I can't select the rates of
 * a booked call unless it'll be the same price as the live").
 *
 * The bug: a booked 1-on-1 priced silently off the model's FaceTime
 * per-minute rate (server: `model.per_minute_cents * minutes` in BOTH
 * booking-creation paths), so an $11/min video rate auto-quoted $660
 * for a 60-minute booking and the ONLY way to change it was to move her
 * FaceTime rate too. Bookings now have their own rate:
 *  - models.booking_rate_cents (nullable; NULL = fall back to
 *    per_minute_cents, so nothing changes until she sets it),
 *  - a Settings slider (s-bk, $1–$100/min, step 50¢) saved through
 *    PUT /api/model/profile with server-side range validation,
 *  - the fan side quotes the EFFECTIVE rate everywhere: the
 *    bookings-availability payload's rate_cents, the /api/models
 *    payload's booking_rate_cents (resolved), and the chat booking
 *    sheet's rate argument — displayed price always = charged price,
 *  - a one-time, stamp-guarded, models-only announcement through the
 *    official notices thread (announceBookingRate).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');

const REPO = path.join(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(REPO, 'public/js/app.js'), 'utf8');

/* ---------------- static pins ---------------- */

test('pins: schema, pricing fallback, payload resolution, settings save', () => {
  // Schema: nullable dedicated rate on the model row.
  assert.ok(serverSrc.includes("addColumnIfMissing('models', 'booking_rate_cents', 'INTEGER')"),
    'booking_rate_cents migration (nullable — NULL means "not set")');
  // BOTH booking-creation paths resolve the effective rate and store IT.
  const fallbacks = serverSrc.match(/model\.booking_rate_cents \?\? model\.per_minute_cents/g) || [];
  assert.ok(fallbacks.length >= 3,
    `effective-rate fallback in slot create + legacy create + availability (got ${fallbacks.length})`);
  assert.ok(!serverSrc.includes('const total = model.per_minute_cents * minutes;'),
    'slot path no longer prices off the raw FaceTime rate');
  assert.ok(!serverSrc.includes('const total = model.per_minute_cents * durationMin;'),
    'legacy path no longer prices off the raw FaceTime rate');
  // Availability payload quotes the effective rate.
  assert.ok(serverSrc.includes('rate_cents: model.booking_rate_cents ?? model.per_minute_cents'),
    'bookings-availability rate_cents is the effective booking rate');
  // /api/models payload resolves the rate in shapeRow (raw column rides
  // the SELECT; the published value is resolved, never the raw NULL).
  assert.ok(serverSrc.includes('m.booking_rate_cents, m.section, m.is_online'), 'roster SELECT carries the column');
  assert.ok(serverSrc.includes('pub.booking_rate_cents = r.booking_rate_cents ?? r.per_minute_cents;'),
    'roster payload resolves booking_rate_cents');
  // Conversation payload (the chat booking sheet's source) resolves too.
  assert.ok(serverSrc.includes('booking_rate_cents: m ? (m.booking_rate_cents ?? m.per_minute_cents) : 0'),
    'otherParty resolves booking_rate_cents');
  // Settings save: validated $1–$100 (100..10000) on PUT /api/model/profile.
  const put = serverSrc.slice(serverSrc.indexOf("app.put('/api/model/profile'"),
    serverSrc.indexOf("app.put('/api/model/profile'") + 2600);
  assert.ok(put.includes('booking_rate_cents'), 'profile PUT accepts booking_rate_cents');
  assert.ok(put.includes('badRate(booking_rate_cents, 100, 10000)'), 'profile PUT range-validates it');
  assert.ok(put.includes("updates.push('booking_rate_cents = ?')"), 'profile PUT persists it');
});

test('pins: client — settings slider, save wiring, fan quote, i18n key ×13', () => {
  assert.ok(appSrc.includes('id="s-bk"'), 'booking-rate slider exists');
  const slider = appSrc.slice(appSrc.indexOf('id="s-bk"') - 200, appSrc.indexOf('id="s-bk"') + 200);
  assert.ok(slider.includes('min="100"') && slider.includes('max="10000"') && slider.includes('step="50"'),
    'slider band is $1–$100 in 50¢ steps');
  assert.ok(slider.includes('m.booking_rate_cents ?? m.per_minute_cents'),
    'slider starts at the EFFECTIVE rate (own rate, else FaceTime rate)');
  assert.ok(appSrc.includes('id="s-bk-label"'), 'slider has a live $ label');
  assert.ok(appSrc.includes("const booking_rate_cents = parseInt($('#s-bk').value);"),
    'rates save reads the slider');
  assert.ok(appSrc.includes('per_voice_cents, booking_rate_cents, explicit_rate_cents'),
    'rates save sends booking_rate_cents in the PUT body');
  // Fan booking sheet: the legacy fallback quote comes from the resolved
  // booking rate first, never straight off the FaceTime rate.
  assert.ok(appSrc.includes('conv.other.booking_rate_cents || conv.other.per_minute_cents || 399'),
    'chat Book button quotes the effective booking rate');
  // i18n: the new settings label exists in exactly the 13 client dicts.
  const keyCount = (appSrc.match(/per_min_booking_l:/g) || []).length;
  assert.equal(keyCount, 13, 'per_min_booking_l present in all 13 languages');
});

test('pins: announcement — stamp, models-only, official thread, SRV keys', () => {
  assert.ok(serverSrc.includes("addColumnIfMissing('platform_stats', 'booking_rate_announced_at'"),
    'announcement stamp column');
  assert.ok(serverSrc.includes('function announceBookingRate()'), 'announcement sweep exists');
  const annStart = serverSrc.indexOf('function announceBookingRate()');
  const ann = serverSrc.slice(annStart, serverSrc.indexOf('\n}\n', annStart) + 3);
  assert.ok(ann.includes("role = 'model'"), 'announcement goes to MODELS ONLY');
  assert.ok(!ann.includes("'fan'"), 'announcement never targets fans');
  assert.ok(ann.includes('officialThreadFor('), 'announcement lands in the official thread');
  assert.ok(ann.includes("srv('ann_booking_rate_dm', p.language)"), 'DM copy localized per recipient');
  for (const k of ['ann_booking_rate_dm', 'ann_booking_rate_bell_title', 'ann_booking_rate_bell_body']) {
    assert.ok(serverSrc.includes(`${k}: {`), `SRV copy key ${k} (13 languages — parity pinned by languages-13)`);
  }
  assert.ok(serverSrc.includes('announceBookingRate();'), 'announcement runs at boot');
});

/* ---------------- live harness (manager-chats-monitor pattern) ---------------- */

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

function makeCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-bkrate-'));
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
  const deadline = Date.now() + 20000;
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
  let payload;
  if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  if (token) h.authorization = 'Bearer ' + token;
  const r = await fetch(base + p, { method, headers: h, body: payload });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not json */ }
  return { status: r.status, json, text };
}

const login = async (base, username, password) => {
  const r = await req(base, 'POST', '/api/auth/login', { body: { username, password } });
  assert.equal(r.status, 200, `login ${username}: ${r.text}`);
  return r.json.token;
};

async function bunnyRow(base) {
  const models = (await req(base, 'GET', '/api/models')).json.models;
  const bunny = models.find((m) => m.username === 'bunny');
  assert.ok(bunny, 'seeded bunny is on the public roster');
  return bunny;
}

/* ---------------- live: settings save + validation + payload ---------------- */

test('live: settings save persists + range-validates; payloads resolve the effective rate', async () => {
  const dir = makeCopy();
  const h = await boot(dir, { SEED_DEMO: '1' });
  try {
    const model = await login(h.base, 'bunny', 'model123');
    const fan = await login(h.base, 'fandemo', 'fan123');
    const bunny = await bunnyRow(h.base);

    // Stacey's shape: $11/min FaceTime, a $3/min booking rate of her own.
    let r = await req(h.base, 'PUT', '/api/model/profile', {
      token: model, body: { per_minute_cents: 1100, booking_rate_cents: 300 } });
    assert.equal(r.status, 200, `save rates: ${r.text}`);
    assert.equal(r.json.model.booking_rate_cents, 300, 'PUT response carries the saved booking rate');
    assert.equal(r.json.model.per_minute_cents, 1100, 'FaceTime rate saved alongside, independently');

    const me = await req(h.base, 'GET', '/api/me', { token: model });
    assert.equal(me.json.model.booking_rate_cents, 300, '/api/me model row carries the booking rate');

    // Range validation: $1–$100/min, integers only.
    for (const bad of [99, 10001, 250.5, '300']) {
      r = await req(h.base, 'PUT', '/api/model/profile', { token: model, body: { booking_rate_cents: bad } });
      assert.equal(r.status, 400, `booking_rate_cents=${JSON.stringify(bad)} refused`);
      assert.equal(r.json.error, 'bad_rate');
    }
    for (const ok of [100, 10000]) {
      r = await req(h.base, 'PUT', '/api/model/profile', { token: model, body: { booking_rate_cents: ok } });
      assert.equal(r.status, 200, `booking_rate_cents=${ok} accepted (band edge)`);
    }
    r = await req(h.base, 'PUT', '/api/model/profile', { token: model, body: { booking_rate_cents: 300 } });
    assert.equal(r.status, 200);

    // Fan-facing payloads resolve the EFFECTIVE rate (300), not her 1100.
    const roster = await bunnyRow(h.base);
    assert.equal(roster.booking_rate_cents, 300, 'roster payload booking_rate_cents is resolved');
    assert.equal(roster.per_minute_cents, 1100, 'roster still shows her true FaceTime rate');
    const avail = await req(h.base, 'GET', `/api/models/${bunny.id}/bookings-availability?days=7`, { token: fan });
    assert.equal(avail.status, 200, `availability: ${avail.text}`);
    assert.equal(avail.json.rate_cents, 300, 'availability rate_cents quotes the booking rate');

    // Moving ONLY the FaceTime rate leaves the booking rate standing.
    r = await req(h.base, 'PUT', '/api/model/profile', { token: model, body: { per_minute_cents: 1200 } });
    assert.equal(r.status, 200);
    const avail2 = await req(h.base, 'GET', `/api/models/${bunny.id}/bookings-availability?days=7`, { token: fan });
    assert.equal(avail2.json.rate_cents, 300, 'booking quote survives a FaceTime-rate change');
  } finally { stop(h); }
});

/* ---------------- live: pricing, both paths, fallback ---------------- */

test('live: bookings charge the booking rate when set, the FaceTime rate when NULL', async () => {
  const dir = makeCopy();
  const h1 = await boot(dir, { SEED_DEMO: '1' });
  stop(h1);
  // Seed between boots: a rich fan + bunny bookable every weekday.
  {
    const db = new DatabaseSync(path.join(dir, 'wogent-chat.db'));
    db.exec('PRAGMA busy_timeout = 10000');
    try {
      const fan = db.prepare("SELECT id FROM users WHERE username = 'fandemo'").get();
      const bunny = db.prepare("SELECT id FROM users WHERE username = 'bunny'").get();
      db.prepare('UPDATE wallets SET credits_cents = 1000000 WHERE user_id = ?').run(fan.id);
      const ins = db.prepare(`INSERT INTO model_availability (model_id, weekday, start_min, end_min)
                              VALUES (?,?,?,?)`);
      for (let wd = 0; wd <= 6; wd++) ins.run(bunny.id, wd, 0, 1439);
    } finally { db.close(); }
  }
  const h = await boot(dir, { SEED_DEMO: '1' });
  try {
    const model = await login(h.base, 'bunny', 'model123');
    const fan = await login(h.base, 'fandemo', 'fan123');
    const bunny = await bunnyRow(h.base);
    const put = await req(h.base, 'PUT', '/api/model/profile', {
      token: model, body: { per_minute_cents: 1100, booking_rate_cents: 300 } });
    assert.equal(put.status, 200, `seed rates: ${put.text}`);

    const bookRow = (id) => {
      const db = new DatabaseSync(path.join(dir, 'wogent-chat.db'));
      db.exec('PRAGMA busy_timeout = 10000');
      try { return db.prepare('SELECT * FROM bookings WHERE id = ?').get(id); }
      finally { db.close(); }
    };
    const aligned = (ms) => Math.ceil(ms / (30 * 60 * 1000)) * (30 * 60 * 1000);
    const now = Date.now();

    // Legacy request path — 30 min at her $3 booking rate, NOT $11.
    let r = await req(h.base, 'POST', '/api/bookings', { token: fan, body: {
      model_id: bunny.id, scheduled_at: now + 3 * 3600e3, duration_min: 30 } });
    assert.equal(r.status, 200, `legacy booking: ${r.text}`);
    assert.equal(r.json.total_cents, 300 * 30, 'legacy booking charges the booking rate');
    const legacyId = r.json.booking_id;
    assert.equal(bookRow(legacyId).rate_cents, 300, 'legacy booking stores the booking rate');

    // Slot path — 10 min at her $3 booking rate.
    r = await req(h.base, 'POST', '/api/bookings', { token: fan, body: {
      model_id: bunny.id, starts_at: aligned(now + 2 * 3600e3), minutes: 10 } });
    assert.equal(r.status, 200, `slot booking: ${r.text}`);
    assert.equal(r.json.total_cents, 300 * 10, 'slot booking charges the booking rate');
    assert.equal(bookRow(r.json.booking_id).rate_cents, 300, 'slot booking stores the booking rate');

    // NULL the dedicated rate: both paths fall back to the FaceTime rate,
    // and the payloads resolve to it too.
    {
      const db = new DatabaseSync(path.join(dir, 'wogent-chat.db'));
      db.exec('PRAGMA busy_timeout = 10000');
      try { db.prepare('UPDATE models SET booking_rate_cents = NULL WHERE user_id = ?').run(bunny.id); }
      finally { db.close(); }
    }
    r = await req(h.base, 'POST', '/api/bookings', { token: fan, body: {
      model_id: bunny.id, scheduled_at: now + 6 * 3600e3, duration_min: 15 } });
    assert.equal(r.status, 200, `fallback legacy booking: ${r.text}`);
    assert.equal(r.json.total_cents, 1100 * 15, 'NULL rate → legacy booking charges the FaceTime rate');
    assert.equal(bookRow(r.json.booking_id).rate_cents, 1100, 'fallback booking stores the FaceTime rate');

    r = await req(h.base, 'POST', '/api/bookings', { token: fan, body: {
      model_id: bunny.id, starts_at: aligned(now + 5 * 3600e3), minutes: 10 } });
    assert.equal(r.status, 200, `fallback slot booking: ${r.text}`);
    assert.equal(r.json.total_cents, 1100 * 10, 'NULL rate → slot booking charges the FaceTime rate');

    const roster = await bunnyRow(h.base);
    assert.equal(roster.booking_rate_cents, 1100, 'NULL rate → roster resolves to the FaceTime rate');
    const avail = await req(h.base, 'GET', `/api/models/${bunny.id}/bookings-availability?days=7`, { token: fan });
    assert.equal(avail.json.rate_cents, 1100, 'NULL rate → availability resolves to the FaceTime rate');

    // The bookings made while her rate was set keep their stored rate.
    assert.equal(bookRow(legacyId).rate_cents, 300, 'earlier booking untouched by the later NULL');
    assert.equal(bookRow(legacyId).total_cents, 9000, 'earlier booking total untouched');
  } finally { stop(h); }
});

/* ---------------- live: announcement ---------------- */

test('live: announcement — models only, localized, stamp-guarded, fires once', async () => {
  const dir = makeCopy();
  const h1 = await boot(dir, { SEED_DEMO: '1' });
  stop(h1);
  let bkModel = null;
  let bkFan = null;
  {
    const db = new DatabaseSync(path.join(dir, 'wogent-chat.db'));
    db.exec('PRAGMA busy_timeout = 10000');
    try {
      db.prepare(`UPDATE platform_stats SET official_inbox_announced_at = NULL,
                  chat_retention_announced_at = NULL,
                  booking_rate_announced_at = NULL WHERE id = 1`).run();
      const insUser = db.prepare(
        'INSERT INTO users (username, password_hash, role, display_name, dob, banned, email, language, created_at) VALUES (?,?,?,?,?,?,?,?,?)');
      const mk = (u, role, name, lang) => Number(insUser.run(
        u, bcrypt.hashSync(`${u}-pass-123`, 10), role, name, '1995-05-05', 0, null, lang || 'en', '2026-02-01 10:00:00').lastInsertRowid);
      const house = mk('asceaaspade', 'model', 'SlutCamp');
      bkModel = mk('bkmodel', 'model', 'Bea Booking', 'es');
      bkFan = mk('bkfan', 'fan', 'Fred Fan');
      for (const id of [house, bkModel]) db.prepare('INSERT INTO models (user_id) VALUES (?)').run(id);
    } finally { db.close(); }
  }
  const countDms = () => {
    const db = new DatabaseSync(path.join(dir, 'wogent-chat.db'));
    db.exec('PRAGMA busy_timeout = 10000');
    try {
      const modelDm = db.prepare(`SELECT COUNT(*) AS n FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        WHERE c.fan_id = ? AND c.is_official = 1 AND m.body LIKE '%PROPIA tarifa%'`).get(bkModel).n;
      const fanDm = db.prepare(`SELECT COUNT(*) AS n FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        WHERE (c.fan_id = ? OR c.model_id = ?)
          AND (m.body LIKE '%PROPIA tarifa%' OR m.body LIKE '%their OWN rate%')`).get(bkFan, bkFan).n;
      const stamp = db.prepare('SELECT booking_rate_announced_at AS s FROM platform_stats WHERE id = 1').get().s;
      return { modelDm, fanDm, stamp };
    } finally { db.close(); }
  };
  const h = await boot(dir, { SEED_DEMO: '1' });
  try {
    const after = countDms();
    assert.ok(after.stamp, 'booking-rate announcement stamp set at boot');
    assert.equal(after.modelDm, 1, 'ES model got the booking-rate DM in her official thread, localized');
    assert.equal(after.fanDm, 0, 'the fan got NO booking-rate DM (models only)');
  } finally { stop(h); }
  const h2 = await boot(dir, { SEED_DEMO: '1' });
  try {
    const again = countDms();
    assert.equal(again.modelDm, 1, 'second boot sends nothing again (stamp guard)');
  } finally { stop(h2); }
});
