'use strict';
/*
 * PUBLIC COUNTS on her page — owner build order, Oct 26 2026.
 * A recruit asked how she gains followers "like IG, where everyone
 * can see the number." Truth at the time: her like count showed,
 * but the follows (Playlist) count was displayed NOWHERE — not to
 * fans, not even to her. Asce: "We need to reflect that. We need to
 * show how many people add her to playlist and how many likes.
 * That's a big thing for female. It's like followed and etc…
 * Both fans and models need see this." Then: "Woman go crazy.
 * They need that validation."
 *
 * THE BUILD pinned here:
 *  - GET /api/models computes follower_count (COUNT of follows)
 *    beside like_count; the shaped payload carries BOTH spellings
 *    (follower_count on the row, followers_count beside
 *    likes_count), so cards and her profile read the same truth.
 *  - POST /api/follows/:modelId returns the fresh follower_count
 *    with the toggle, and the client updates every rendered count
 *    for her in place ([data-follow-count]).
 *  - Her profile (the peek sheet) gains ❤️ Likes + 👥 Followers
 *    rows; the landing card and the fan-home card gain a 👥 chip
 *    beside the heart. New labels ×13 (followers_label,
 *    likes_label). Counts are computed live from the follows and
 *    model_likes tables — no stored counters to drift.
 *  - The follows engine itself (toggle semantics, fan-only,
 *    live-alert bells) is untouched.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(REPO, 'public/js/app.js'), 'utf8');

test('pins: server computes and returns the follower count', () => {
  assert.ok(serverSrc.includes('(SELECT COUNT(*) FROM follows WHERE model_id = u.id) AS follower_count'),
    '/api/models query counts follows beside likes');
  assert.ok(serverSrc.includes('followers_count: r.follower_count || 0'),
    'shaped payload carries followers_count beside likes_count');
  assert.ok(serverSrc.includes('res.json({ following: !existing, follower_count })'),
    'the follows toggle returns the fresh count');
});

test('pins: client renders both numbers — profile rows, card chips, live update', () => {
  assert.ok(appSrc.includes("❤️ ${t('likes_label')}"), 'profile shows a Likes row');
  assert.ok(appSrc.includes("👥 ${t('followers_label')}"), 'profile shows a Followers row');
  assert.ok(appSrc.includes('data-follow-count="${m.id}"'), 'rendered counts carry the live-update hook');
  assert.ok(appSrc.includes('document.querySelectorAll(`[data-follow-count="${modelId}"]`)'),
    'toggleFollow refreshes every rendered count in place');
  // The card numbers live in the shared tile renderer (see
  // counts-tiles.test.js): every viewer sees them, not just fans.
  assert.ok(appSrc.includes('tile-counts'), 'the shared tile carries the counts line');
  assert.ok(!appSrc.includes('tile-followers'), 'no fan-only followers chip remains');
});

test('pins: labels exist in all 13 languages', () => {
  for (const key of ['followers_label:', 'likes_label:']) {
    const n = (appSrc.match(new RegExp(key, 'g')) || []).length;
    assert.equal(n, 13, `${key} present ×13 (got ${n})`);
  }
});

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
function makeCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-counts-'));
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
  const child = spawn(process.execPath, ['server.js'], { cwd: dir, env });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode})\n${log}`);
    try { const r = await fetch(base + '/api/health'); if (r.ok) break; } catch (e) { /* not up yet */ }
    if (Date.now() > deadline) { child.kill('SIGKILL'); throw new Error(`server did not come up\n${log}`); }
    await new Promise((r) => setTimeout(r, 150));
  }
  return { child, base };
}
function stop(h) { try { h.child.kill('SIGKILL'); } catch (e) { /* already down */ } }
async function req(base, method, p, opts) {
  opts = opts || {};
  const h = { 'content-type': 'application/json' };
  let payload;
  if (opts.body !== undefined) payload = JSON.stringify(opts.body);
  if (opts.token) h.authorization = 'Bearer ' + opts.token;
  const r = await fetch(base + p, { method, headers: h, body: payload });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not json */ }
  return { status: r.status, json, text };
}

test('live: her follower count is public, exact, and moves with the toggle', { timeout: 120000 }, async (t) => {
  const dir = makeCopy();
  const h = await boot(dir, { SEED_DEMO: '1' });
  t.after(() => stop(h));
  const { base } = h;
  const signup = (body) => req(base, 'POST', '/api/auth/signup', {
    body: { password: 'counts-pass-1', display_name: 'Counts Tester', dob: '1995-05-05', agree18: true, ...body },
  });
  const model = await signup({ username: 'countsmodel', role: 'model', section: 'female', display_name: 'Counts Model', publicity_consent: true });
  assert.equal(model.status, 200, `model signup: ${model.text}`);
  const modelId = model.json.user.id;
  const fan1 = await signup({ username: 'countsfan1', role: 'fan' });
  const fan2 = await signup({ username: 'countsfan2', role: 'fan' });
  assert.equal(fan1.status, 200, `fan1 signup: ${fan1.text}`);
  assert.equal(fan2.status, 200, `fan2 signup: ${fan2.text}`);

  const listed = async () => {
    const r = await req(base, 'GET', '/api/models');
    assert.equal(r.status, 200);
    const m = (r.json.models || []).find((x) => x.id === modelId);
    assert.ok(m, 'model is listed');
    return m;
  };

  let m = await listed();
  assert.equal(m.follower_count, 0, 'starts at 0 followers (row spelling)');
  assert.equal(m.followers_count, 0, 'starts at 0 followers (profile spelling)');
  assert.equal(m.likes_count, 0, 'likes ride the same payload');

  const on1 = await req(base, 'POST', `/api/follows/${modelId}`, { body: {}, token: fan1.json.token });
  assert.equal(on1.status, 200, `follow 1: ${on1.text}`);
  assert.deepEqual([on1.json.following, on1.json.follower_count], [true, 1], 'toggle returns the fresh count');
  const on2 = await req(base, 'POST', `/api/follows/${modelId}`, { body: {}, token: fan2.json.token });
  assert.deepEqual([on2.json.following, on2.json.follower_count], [true, 2], 'second fan moves it to 2');

  m = await listed();
  assert.equal(m.follower_count, 2, 'the public listing shows 2 followers');
  assert.equal(m.followers_count, 2, 'the profile spelling agrees');

  const like = await req(base, 'POST', `/api/models/${modelId}/like`, { body: {}, token: fan1.json.token });
  assert.equal(like.status, 200, `like: ${like.text}`);
  m = await listed();
  assert.equal(m.likes_count, 1, 'her like count is public on the same payload');

  const off = await req(base, 'POST', `/api/follows/${modelId}`, { body: {}, token: fan1.json.token });
  assert.deepEqual([off.json.following, off.json.follower_count], [false, 1], 'unfollow drops the count at once');
  m = await listed();
  assert.equal(m.followers_count, 1, 'and the listing agrees');
});
