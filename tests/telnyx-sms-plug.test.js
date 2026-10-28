'use strict';
/*
 * Telnyx SMS sender plug (Assignment 15, Ms. Pink, Oct 28 2026).
 *
 * sendAdminSMS (server.js, the admin SMS 2FA sender) is now
 * provider-selectable, name / signature / { ok, error } shape kept:
 *   - TELNYX_API_KEY set        -> Telnyx: POST
 *     https://api.telnyx.com/v2/messages, Authorization: Bearer key,
 *     JSON body { from: TELNYX_FROM_NUMBER, to, text }. (Telnyx's
 *     send-a-message reference: `from` is the sender for a
 *     phone-number send; messaging_profile_id is only required for
 *     number-pool / alphanumeric sends.)
 *   - else legacy Twilio vars   -> the existing Twilio path, unchanged.
 *   - else                      -> { ok:false, error:'sms_not_configured' }
 *     and NO network call (today's dormancy, preserved).
 *
 * The sender has no HTTP surface of its own, so these live tests boot
 * the real server (same temp-dir pattern as
 * tests/fake-money-cleanup.test.js) and drive it through the real
 * POST /api/auth/admin-setup-phone route, which issues a code via
 * issueSmsCode and sends it via sendAdminSMS. The child's HTTP layer
 * is stubbed with a --require preload that intercepts ONLY the
 * Telnyx / Twilio hosts, records every call to a JSONL file, and
 * answers with canned responses: zero real network, fake env values
 * only, and nothing here can send a real text.
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
const SERVER_JS = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');

const ADMIN_USER = 'admin';       // seeded (SEED_DEMO=1) admin login
const ADMIN_PASS = 'admin123';    // seeded demo password, local dev only
const PHONE = '15125550142';      // fake recipient (555 number, 1 + 10 digits)
const PHONE_E164 = '+15125550142';
const TELNYX_KEY = 'fake-telnyx-key-for-tests';
const TELNYX_FROM = '+15125550099';
const TWILIO_SID = 'ACfake00000000000000000000000000';
const TWILIO_TOKEN = 'fake-twilio-token';
const TWILIO_FROM = '+15125550077';

// Preload written into each temp server copy and loaded with
// node --require: replaces the child's global fetch for the two SMS
// provider hosts only; everything else delegates to the real fetch.
const STUB_PRELOAD = `'use strict';
const fs = require('node:fs');
const realFetch = globalThis.fetch;
const logPath = process.env.SMS_STUB_LOG || '';
const mode = process.env.SMS_STUB_MODE || 'ok';
globalThis.fetch = async function (url, opts) {
  const o = opts || {};
  const u = String(url && url.url ? url.url : url);
  if (u.includes('api.telnyx.com') || u.includes('api.twilio.com')) {
    if (logPath) {
      fs.appendFileSync(logPath, JSON.stringify({
        url: u, method: o.method || 'GET', headers: o.headers || {},
        body: o.body == null ? null : String(o.body),
      }) + '\\n');
    }
    if (mode === 'throw') throw new Error('stub network failure');
    const status = mode === 'error' ? 400 : 200;
    const payload = mode === 'error'
      ? { errors: [{ code: '40002', title: 'stub error' }] }
      : { data: { id: 'stub-message-id' }, sid: 'SMstub' };
    return new Response(JSON.stringify(payload), {
      status, headers: { 'Content-Type': 'application/json' },
    });
  }
  return realFetch(url, o);
};
`;

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-telnyx-'));
  for (const d of ['server.js', 'package.json', 'lib', 'public', 'data']) {
    fs.cpSync(path.join(REPO, d), path.join(dir, d), { recursive: true });
  }
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  fs.writeFileSync(path.join(dir, 'sms-fetch-stub.cjs'), STUB_PRELOAD);
  return dir;
}

async function boot(dir, extraEnv) {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), CRYPTO_POLL_MS: '3600000', SEED_DEMO: '1' };
  for (const k of Object.keys(env)) {
    if (/^(CCBILL_|CRYPTO_|OPENAI_|TWILIO_|TELNYX_|VAPID_|WEBAUTHN_|SMS_STUB_)/.test(k)) delete env[k];
  }
  env.NODE_OPTIONS = `--require ${path.join(dir, 'sms-fetch-stub.cjs')}`;
  env.SMS_STUB_LOG = path.join(dir, 'sms-calls.jsonl');
  Object.assign(env, extraEnv || {});
  const child = spawn(process.execPath, ['server.js'], { cwd: dir, env });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode})\n${log}`);
    try {
      const r = await fetch(base + '/api/health');
      if (r.ok) break;
    } catch (e) { /* not up yet */ }
    if (Date.now() > deadline) { child.kill('SIGKILL'); throw new Error(`server did not come up\n${log}`); }
    await new Promise((r) => setTimeout(r, 150));
  }
  return { child, base };
}

function stop(handle) {
  if (handle && handle.child && handle.child.exitCode === null) handle.child.kill('SIGKILL');
}

// Temp copies are ~48MB each (public/ + data/); /tmp can be small, so
// every boot's copy is removed as soon as its server stops.
function cleanup(handle, dir) {
  stop(handle);
  fs.rmSync(dir, { recursive: true, force: true });
}

async function post(base, route, body) {
  const r = await fetch(base + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  let json = null;
  try { json = await r.json(); } catch (e) { /* no body */ }
  return { status: r.status, json };
}

function stubCalls(dir) {
  const f = path.join(dir, 'sms-calls.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function latestSmsCode(dir) {
  const db = new DatabaseSync(path.join(dir, 'wogent-chat.db'), { readOnly: true });
  try {
    return db.prepare('SELECT code FROM sms_codes ORDER BY id DESC LIMIT 1').get() || null;
  } finally {
    db.close();
  }
}

function setupPhone(base) {
  return post(base, '/api/auth/admin-setup-phone', {
    username: ADMIN_USER, password: ADMIN_PASS, phone: PHONE,
  });
}

/* (a)+(b) Telnyx selected: exactly one POST, Bearer header,           */
/* { from, to, text } body; a 2xx answers { ok:true } end-to-end.      */
test('telnyx env: one POST to Telnyx with Bearer + {from,to,text}, send succeeds', async () => {
  const dir = makeCopy();
  const h = await boot(dir, {
    TELNYX_API_KEY: TELNYX_KEY, TELNYX_FROM_NUMBER: TELNYX_FROM, SMS_STUB_MODE: 'ok',
  });
  try {
    const r = await setupPhone(h.base);
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.sent, true);
    const calls = stubCalls(dir);
    assert.equal(calls.length, 1, 'exactly one provider HTTP call');
    const c = calls[0];
    assert.equal(c.url, 'https://api.telnyx.com/v2/messages');
    assert.equal(c.method, 'POST');
    assert.equal(c.headers.Authorization, 'Bearer ' + TELNYX_KEY);
    assert.equal(c.headers['Content-Type'], 'application/json');
    const body = JSON.parse(c.body);
    assert.deepEqual(Object.keys(body).sort(), ['from', 'text', 'to']);
    assert.equal(body.from, TELNYX_FROM);
    assert.equal(body.to, PHONE_E164);
    const row = latestSmsCode(dir);
    assert.ok(row && /^\d{6}$/.test(row.code), 'a 6-digit code was issued');
    assert.equal(body.text, `SlutCamp admin code: ${row.code}. Expires in 5 min.`);
  } finally {
    cleanup(h, dir);
  }
});

/* (b) Telnyx error / network failure: { ok:false }, never a throw —   */
/* the route surfaces sms_failed and the request completes.            */
test('telnyx error response and network throw: ok:false, no throw', async () => {
  for (const mode of ['error', 'throw']) {
    const dir = makeCopy();
    const h = await boot(dir, {
      TELNYX_API_KEY: TELNYX_KEY, TELNYX_FROM_NUMBER: TELNYX_FROM, SMS_STUB_MODE: mode,
    });
    try {
      const r = await setupPhone(h.base);
      assert.equal(r.status, 500, `mode ${mode}: route reports the failed send`);
      assert.equal(r.json.error, 'sms_failed');
      assert.equal(stubCalls(dir).length, 1, `mode ${mode}: exactly one attempted call`);
    } finally {
      cleanup(h, dir);
    }
  }
});

/* (c) No provider env: sms_not_configured and ZERO provider calls.    */
test('no sms env: sms_not_configured, zero HTTP calls', async () => {
  const dir = makeCopy();
  const h = await boot(dir, { SMS_STUB_MODE: 'ok' });
  try {
    const r = await setupPhone(h.base);
    assert.equal(r.status, 500);
    assert.equal(r.json.error, 'sms_not_configured');
    assert.deepEqual(stubCalls(dir), []);
  } finally {
    cleanup(h, dir);
  }
});

/* Telnyx key set but no from-number: still not configured, no call.   */
test('telnyx key without from number: sms_not_configured, zero HTTP calls', async () => {
  const dir = makeCopy();
  const h = await boot(dir, { TELNYX_API_KEY: TELNYX_KEY, SMS_STUB_MODE: 'ok' });
  try {
    const r = await setupPhone(h.base);
    assert.equal(r.status, 500);
    assert.equal(r.json.error, 'sms_not_configured');
    assert.deepEqual(stubCalls(dir), []);
  } finally {
    cleanup(h, dir);
  }
});

/* (d) Twilio-only env: the legacy path is selected, unchanged —       */
/* Twilio Messages URL, Basic auth, form-encoded From/To/Body, and     */
/* no Telnyx call even when both transports could be configured.       */
test('twilio-only env: legacy Twilio path selected', async () => {
  const dir = makeCopy();
  const h = await boot(dir, {
    TWILIO_SID: TWILIO_SID, TWILIO_TOKEN: TWILIO_TOKEN, TWILIO_FROM, SMS_STUB_MODE: 'ok',
  });
  try {
    const r = await setupPhone(h.base);
    assert.equal(r.status, 200);
    assert.equal(r.json.sent, true);
    const calls = stubCalls(dir);
    assert.equal(calls.length, 1);
    const c = calls[0];
    assert.equal(c.url, `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`);
    assert.equal(c.headers.Authorization,
      'Basic ' + Buffer.from(TWILIO_SID + ':' + TWILIO_TOKEN).toString('base64'));
    assert.equal(c.headers['Content-Type'], 'application/x-www-form-urlencoded');
    const form = new URLSearchParams(c.body);
    assert.equal(form.get('From'), TWILIO_FROM);
    assert.equal(form.get('To'), PHONE_E164);
    assert.match(form.get('Body'), /^SlutCamp admin code: \d{6}\. Expires in 5 min\.$/);
  } finally {
    cleanup(h, dir);
  }
});

test('telnyx wins when both telnyx and twilio env are set', async () => {
  const dir = makeCopy();
  const h = await boot(dir, {
    TELNYX_API_KEY: TELNYX_KEY, TELNYX_FROM_NUMBER: TELNYX_FROM,
    TWILIO_SID: TWILIO_SID, TWILIO_TOKEN: TWILIO_TOKEN, TWILIO_FROM, SMS_STUB_MODE: 'ok',
  });
  try {
    const r = await setupPhone(h.base);
    assert.equal(r.status, 200);
    const calls = stubCalls(dir);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.telnyx.com/v2/messages');
  } finally {
    cleanup(h, dir);
  }
});

/* (e) Issue/verify flow unchanged: the code issued at setup verifies  */
/* through the real route, 2FA switches on, codes are single-use.      */
test('issue/verify flow unchanged: setup code verifies and enables 2FA', async () => {
  const dir = makeCopy();
  const h = await boot(dir, {
    TELNYX_API_KEY: TELNYX_KEY, TELNYX_FROM_NUMBER: TELNYX_FROM, SMS_STUB_MODE: 'ok',
  });
  try {
    const sent = await setupPhone(h.base);
    assert.equal(sent.status, 200);
    const row = latestSmsCode(dir);
    assert.ok(row, 'code row exists after setup');

    const bad = await post(h.base, '/api/auth/admin-verify-phone', {
      username: ADMIN_USER, code: '000000',
    });
    assert.equal(bad.status, 401);
    assert.equal(bad.json.error, 'bad_code');

    const good = await post(h.base, '/api/auth/admin-verify-phone', {
      username: ADMIN_USER, code: row.code,
    });
    assert.equal(good.status, 200);
    assert.ok(good.json.token, 'verify returns a full session token');
    assert.equal(latestSmsCode(dir), null, 'code is consumed (single use)');

    const db = new DatabaseSync(path.join(dir, 'wogent-chat.db'), { readOnly: true });
    try {
      const stats = db.prepare('SELECT admin_phone, admin_2fa_on FROM platform_stats WHERE id = 1').get();
      assert.equal(stats.admin_phone, PHONE_E164);
      assert.equal(stats.admin_2fa_on, 1);
    } finally {
      db.close();
    }
  } finally {
    cleanup(h, dir);
  }
});

/* Source pins: the plug lives inside the existing sender, the login   */
/* flow is NOT re-wired to SMS 2FA, and no credential-shaped literal   */
/* or real Telnyx key is baked into the server source.                 */
test('source pins: sender shape kept, 2FA not re-enabled in login, no secrets', () => {
  assert.match(SERVER_JS, /async function sendAdminSMS\(to, body\) \{/);
  assert.match(SERVER_JS, /https:\/\/api\.telnyx\.com\/v2\/messages/);
  assert.match(SERVER_JS, /'Bearer ' \+ telnyxKey/);
  assert.match(SERVER_JS, /JSON\.stringify\(\{ from: telnyxFrom, to, text: body \}\)/);
  // Dormancy is checked before any provider call in both transports.
  assert.match(SERVER_JS, /if \(!telnyxFrom\) return \{ ok: false, error: 'sms_not_configured' \};/);
  assert.match(SERVER_JS, /if \(!sid \|\| !token \|\| !from\) return \{ ok: false, error: 'sms_not_configured' \};/);
  // The admin login step still issues a full session directly; the
  // sender's only route callers remain the two setup/settings flows.
  const callers = SERVER_JS.match(/await sendAdminSMS\(/g) || [];
  assert.equal(callers.length, 2);
  assert.doesNotMatch(SERVER_JS, /KEY[A-Za-z0-9]{8,}_[A-Za-z0-9_-]{20,}/);
});
