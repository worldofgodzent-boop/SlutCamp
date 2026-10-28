'use strict';
/*
 * Launch gate (Assignment 18, Part 1, Oct 28 2026) — a Manager-
 * flippable platform flag (platform_stats.launch_gate_enabled,
 * default OFF). While OFF, the directory (GET /api/models), the
 * clean feed and the public SEO index behave exactly as today.
 * While ON, a model who is NOT ID-approved OR has NO profile
 * picture (models.photo_url) is excluded from all three surfaces,
 * computed live from the same signals the surfaces already use
 * (isIdVerified + photo presence) — she returns the moment she
 * complies, with nothing to re-upload.
 *
 * Harness: the tests/clean-feed.test.js pattern — boot the real
 * server from a temp copy, fixtures by real signup + real uploads,
 * then a kill → DB-surgery → reboot step for the fixture no API
 * creates (an approved ID). The flag itself is flipped through the
 * real Manager settings route (PUT /api/admin/settings), never by
 * surgery, so the live-read behaviour is what is pinned.
 *
 * Fixtures:
 *   gateok<sfx>    — profile picture + (surgery) approved ID +
 *                    one clean-feed photo: compliant, never gated.
 *   gatenopic<sfx> — (surgery) approved ID, NO profile picture,
 *                    one clean-feed photo: gated ONLY by the flag.
 *   gatenoid<sfx>  — profile picture, NO approved ID, one clean-
 *                    feed photo: listed today (media blanked by the
 *                    upload gate); excluded everywhere by the flag.
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
const SERVER = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
const MANAGER = fs.readFileSync(path.join(REPO, 'public/manager/manager.js'), 'utf8');

let tmpDir = null;
let child = null;
let base = null;
let childLog = '';

const F = {};
let MGR = null;

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

async function req(method, p, { body, token, headers } = {}) {
  const h = { ...(headers || {}) };
  if (body !== undefined) h['content-type'] = 'application/json';
  if (token) h.authorization = 'Bearer ' + token;
  const r = await fetch(base + p, {
    method, headers: h,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* HTML or empty */ }
  return { status: r.status, headers: r.headers, text, json };
}

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

async function upload(token, route, field) {
  const fd = new FormData();
  fd.append(field, new Blob([PNG_1PX], { type: 'image/png' }), 'pixel.png');
  fd.append('appearance', 'solo');
  const r = await fetch(base + route, {
    method: 'POST', headers: { authorization: 'Bearer ' + token }, body: fd,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
  return { status: r.status, text, json };
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

async function killServer() {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((r) => child.once('exit', r)),
      new Promise((r) => setTimeout(r, 5000)),
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  child = null;
}

async function mkModel(username, display) {
  const s = await req('POST', '/api/auth/signup', {
    body: { username, password: 'gate-pass-123', role: 'model', publicity_consent: true, display_name: display, dob: '1996-04-12', agree18: true, section: 'female' },
  });
  assert.equal(s.status, 200, `signup ${username} failed: ${s.text}`);
  return { username, id: s.json.user.id, token: s.json.token };
}

async function mgrLogin() {
  const adm = await req('POST', '/api/manager/login', { body: { username: 'admin', password: 'admin123' } });
  assert.equal(adm.status, 200, `manager login: ${adm.text}`);
  return { token: adm.json.token, headers: { 'x-manager': '1' } };
}

const dirHas = async (username) => {
  const r = await req('GET', '/api/models');
  assert.equal(r.status, 200);
  return r.json.models.some((m) => m.username === username);
};
const gridHas = async (username) => {
  const r = await req('GET', '/models');
  assert.equal(r.status, 200);
  return r.text.includes(`/models/${username}`);
};
const sitemapHas = async (username) => {
  const r = await req('GET', '/sitemap.xml');
  assert.equal(r.status, 200);
  return r.text.includes(`/models/${username}<`);
};
const feedStreamHas = async (url) => {
  const r = await req('GET', '/feed');
  assert.equal(r.status, 200);
  return r.text.includes(url);
};
const modelFeedLen = async (id) => {
  const r = await req('GET', `/api/models/${id}/feed`);
  assert.equal(r.status, 200);
  return r.json.items.length;
};
const flagNow = async () => {
  const r = await req('GET', '/api/admin/stats', { ...MGR });
  assert.equal(r.status, 200);
  return r.json.launch_gate_enabled;
};

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-launchflag-'));
  for (const f of ['server.js', 'package.json']) {
    fs.copyFileSync(path.join(REPO, f), path.join(tmpDir, f));
  }
  for (const d of ['lib', 'public', 'data']) {
    fs.cpSync(path.join(REPO, d), path.join(tmpDir, d), { recursive: true });
  }
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(tmpDir, 'node_modules'), 'dir');

  await boot();
  MGR = await mgrLogin();
  const suffix = Math.random().toString(36).slice(2, 8);

  F.ok = await mkModel('gateok' + suffix, 'Gate Ok');
  F.nopic = await mkModel('gatenopic' + suffix, 'Gate Nopic');
  F.noid = await mkModel('gatenoid' + suffix, 'Gate Noid');

  // Profile pictures (her profile photo, models.photo_url) for OK
  // and NOID through the real upload endpoint; NOPIC never sets one.
  for (const m of [F.ok, F.noid]) {
    const up = await upload(m.token, '/api/model/photo', 'photo');
    assert.equal(up.status, 200, `profile photo upload ${m.username}: ${up.text}`);
    const me = await req('GET', '/api/me', { token: m.token });
    assert.ok(me.json.model.photo_url, `${m.username} has a profile picture on file`);
  }
  const meNopic = await req('GET', '/api/me', { token: F.nopic.token });
  assert.equal(meNopic.json.model.photo_url, '', 'NOPIC has no profile picture');

  // One clean-feed photo each, posted pre-approval like feedstar's.
  for (const m of [F.ok, F.nopic, F.noid]) {
    const f = await upload(m.token, '/api/model/feed/photo', 'photo');
    assert.equal(f.status, 200, `feed photo upload ${m.username}: ${f.text}`);
    m.feedUrl = f.json.item.url;
  }
});

test.after(async () => { await killServer(); });

/* ---------------- the flag itself: default + the flip route ------ */

test('the flag defaults to OFF on a fresh boot and only the Manager flips it', async () => {
  assert.equal(await flagNow(), 0, 'fresh boot: launch_gate_enabled is 0');

  const bad = await req('PUT', '/api/admin/settings', { ...MGR, body: { launch_gate_enabled: 2 } });
  assert.equal(bad.status, 400, 'a non-0/1 value is refused');
  assert.equal(bad.json.error, 'bad_launch_gate');

  const fan = await req('PUT', '/api/admin/settings', { token: F.ok.token, body: { launch_gate_enabled: 1 } });
  assert.ok(fan.status >= 400, 'a model token cannot flip the flag');
  assert.equal(await flagNow(), 0, 'flag unchanged after refused flips');

  // Static pins: the storage, the settings handler and the Manager
  // toggle all carry the one setting name.
  assert.ok(SERVER.includes("addColumnIfMissing('platform_stats', 'launch_gate_enabled'"),
    'the flag is a platform_stats column, default 0');
  assert.ok(MANAGER.includes('launch_gate_enabled') && MANAGER.includes('set-launchgate'),
    'the Manager Settings view carries the launch-gate toggle');
});

/* ---------------- OFF = today, before any ID approval ------------ */

test('flag OFF before approvals: everyone is listed as today', async () => {
  for (const m of [F.ok, F.nopic, F.noid]) {
    assert.equal(await dirHas(m.username), true, `${m.username} in the directory`);
    assert.equal(await gridHas(m.username), true, `${m.username} on the /models grid`);
    assert.equal(await sitemapHas(m.username), true, `${m.username} in the sitemap`);
    // The standing ID gate (not this flag) keeps every feed item
    // private until approval — Part 1 changes none of that.
    assert.equal(await feedStreamHas(m.feedUrl), false, `${m.username} feed post still ID-gated`);
    assert.equal(await modelFeedLen(m.id), 0, `${m.username} public feed empty pre-approval`);
  }
});

/* ---------------- surgery: approve OK + NOPIC -------------------- */

test('surgery: ID approval for the compliant and no-picture models', async () => {
  await killServer();
  const db = new DatabaseSync(path.join(tmpDir, 'wogent-chat.db'));
  db.exec('PRAGMA busy_timeout = 10000');
  const col = db.prepare("SELECT name FROM pragma_table_info('platform_stats') WHERE name = 'launch_gate_enabled'").get();
  assert.ok(col, 'the launch_gate_enabled column was migrated in at boot');
  const row = db.prepare('SELECT launch_gate_enabled FROM platform_stats WHERE id = 1').get();
  assert.equal(row.launch_gate_enabled, 0, 'the stored default is OFF');
  db.prepare("INSERT INTO id_verifications (model_id, status) VALUES (?, 'approved')").run(F.ok.id);
  db.prepare("INSERT INTO id_verifications (model_id, status) VALUES (?, 'approved')").run(F.nopic.id);
  db.close();
  await boot();
  MGR = await mgrLogin();
});

/* ---------------- OFF = today, after approvals ------------------- */

test('flag OFF after approvals: surfaces exactly as today', async () => {
  assert.equal(await flagNow(), 0, 'flag still OFF after the reboot');
  for (const m of [F.ok, F.nopic, F.noid]) {
    assert.equal(await dirHas(m.username), true, `${m.username} in the directory`);
    assert.equal(await gridHas(m.username), true, `${m.username} on the /models grid`);
    assert.equal(await sitemapHas(m.username), true, `${m.username} in the sitemap`);
  }
  assert.equal(await feedStreamHas(F.ok.feedUrl), true, 'compliant model posts to the stream');
  assert.equal(await feedStreamHas(F.nopic.feedUrl), true, 'no-picture model posts to the stream while OFF');
  assert.equal(await feedStreamHas(F.noid.feedUrl), false, 'unapproved model still held by the standing ID gate');
  assert.equal(await modelFeedLen(F.ok.id), 1, 'compliant model public feed carries her post');
  assert.equal(await modelFeedLen(F.nopic.id), 1, 'no-picture model public feed carries her post while OFF');
  assert.equal(await modelFeedLen(F.noid.id), 0, 'unapproved model public feed empty');
});

/* ---------------- ON: the gate bites on all three surfaces ------- */

test('flag ON: non-compliant models leave directory, clean feed and SEO index; compliant untouched', async () => {
  const flip = await req('PUT', '/api/admin/settings', { ...MGR, body: { launch_gate_enabled: 1 } });
  assert.equal(flip.status, 200, `flip ON: ${flip.text}`);
  assert.equal(flip.json.launch_gate_enabled, 1);
  assert.equal(await flagNow(), 1, 'stats read the flag ON');

  // (a) the directory
  assert.equal(await dirHas(F.ok.username), true, 'compliant model stays in the directory');
  assert.equal(await dirHas(F.nopic.username), false, 'no profile picture: out of the directory');
  assert.equal(await dirHas(F.noid.username), false, 'no ID approval: out of the directory');

  // (b) the clean feed
  assert.equal(await feedStreamHas(F.ok.feedUrl), true, 'compliant model stays in the /feed stream');
  assert.equal(await feedStreamHas(F.nopic.feedUrl), false, 'no profile picture: out of the /feed stream');
  assert.equal(await modelFeedLen(F.ok.id), 1, 'compliant model public feed untouched');
  assert.equal(await modelFeedLen(F.nopic.id), 0, 'no profile picture: public feed empty while ON');
  assert.equal(await modelFeedLen(F.noid.id), 0, 'unapproved model public feed empty while ON');

  // (c) the SEO surfaces
  assert.equal(await gridHas(F.ok.username), true, 'compliant model stays on the /models grid');
  assert.equal(await gridHas(F.nopic.username), false, 'no profile picture: off the /models grid');
  assert.equal(await gridHas(F.noid.username), false, 'no ID approval: off the /models grid');
  assert.equal(await sitemapHas(F.ok.username), true, 'compliant model stays in the sitemap');
  assert.equal(await sitemapHas(F.nopic.username), false, 'no profile picture: out of the sitemap');
  assert.equal(await sitemapHas(F.noid.username), false, 'no ID approval: out of the sitemap');

  // Index exclusion never unpublishes her page (the house-flag
  // precedent): her public page still serves while she is gated.
  const page = await req('GET', `/models/${F.nopic.username}`);
  assert.equal(page.status, 200, 'her public page itself still serves while gated');
});

/* ---------------- OFF again: everyone returns, nothing stored ---- */

test('flag OFF again: every surface is restored live, with no surgery', async () => {
  const flip = await req('PUT', '/api/admin/settings', { ...MGR, body: { launch_gate_enabled: 0 } });
  assert.equal(flip.status, 200, `flip OFF: ${flip.text}`);
  assert.equal(await flagNow(), 0, 'stats read the flag OFF');

  for (const m of [F.ok, F.nopic, F.noid]) {
    assert.equal(await dirHas(m.username), true, `${m.username} back in the directory`);
    assert.equal(await gridHas(m.username), true, `${m.username} back on the /models grid`);
    assert.equal(await sitemapHas(m.username), true, `${m.username} back in the sitemap`);
  }
  assert.equal(await feedStreamHas(F.nopic.feedUrl), true, 'no-picture model back in the /feed stream');
  assert.equal(await modelFeedLen(F.nopic.id), 1, 'no-picture model public feed restored');
});
