'use strict';
/*
 * Manager ping on team messages (Assignment 09, Ms. Pink 2026-10-26).
 *
 * What is under test, and what is NOT:
 * - Static pins on the shipped public/manager/manager.js: shell poll every
 *   15s, newest-only endpoint, localStorage last-seen key, Team nav badge
 *   element, "(n) Slut Manager" title flag, start on shell entry, stop on
 *   logout, and NO sound / push / server-route additions in the new section.
 * - Unit tests of the shipped teamPingNext decision function, extracted
 *   from manager.js itself (not a copy): baseline on first sign-in, mark
 *   seen on channel open, foreign-newer unread count, own-newest never
 *   badges and preserves pending foreign unread, stale newest is a no-op.
 * - Live server tests: the existing /api/admin/team-messages endpoint
 *   already supports ?limit=1 and returns exactly the newest message with
 *   id + author + author_label — that is what the shell poll reads. No
 *   server change is part of this assignment, and none is asserted here.
 * - NOT tested here: live-browser badge/title rendering (node tests +
 *   source pins only, same caveat as prior assignments). The gate is
 *   Ms. Pink's.
 * Boots the REAL server.js (SEED_DEMO=1 throwaway DB). Login budget: two
 * Manager logins (admin, kaykay) — the same 5/min per-IP limit applies.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const MGRJS = path.join(REPO, 'public', 'manager', 'manager.js');
const MGR = { 'x-manager': '1' };

/* ---------------- static pins + teamPingNext unit tests ---------------- */

const mgrSrc = fs.readFileSync(MGRJS, 'utf8');
const pingSection = mgrSrc.slice(
  mgrSrc.indexOf('Manager ping on team messages (Assignment 09)'),
  mgrSrc.indexOf('async function peekBody()'));

test('static pins: poll, endpoint, storage key, badge, title, lifecycle', () => {
  assert.ok(mgrSrc.includes('TEAM_PING_INTERVAL_MS = 15000'), 'poll is 15s');
  assert.ok(mgrSrc.includes("api('/admin/team-messages?limit=1')"), 'newest-only poll');
  assert.ok(mgrSrc.includes("TEAM_PING_SEEN_KEY = 'sc_team_last_seen_id'"), 'last-seen key');
  assert.ok(mgrSrc.includes('id="badge-team"'), 'Team nav badge element');
  assert.ok(mgrSrc.includes("') Slut Manager'"), 'title flag format "(n) Slut Manager"');
  assert.ok(mgrSrc.includes('startTeamPing();'), 'poll starts with the shell');
  assert.ok(mgrSrc.includes('stopTeamPing();'), 'poll stops on logout');
  assert.ok(!/new Audio|Notification|PushManager/.test(pingSection),
    'no sound, no push stack in the ping section');
  assert.ok(!/app\.(get|post)\(/.test(pingSection), 'no server routes added');
  assert.ok(!pingSection.includes('setInterval') || pingSection.includes('TEAM_PING_INTERVAL_MS'),
    'the only new timer is the 15s shell poll');
});

function loadTeamPingNext() {
  const start = mgrSrc.indexOf('/* TEAM_PING_NEXT_START */');
  const end = mgrSrc.indexOf('/* TEAM_PING_NEXT_END */');
  assert.ok(start >= 0 && end > start, 'teamPingNext markers present');
  const fnText = mgrSrc.slice(start, end)
    .replace('/* TEAM_PING_NEXT_START */', '').trim();
  return new Function(`return (${fnText.replace(/^function teamPingNext/, 'function')})`)();
}
const teamPingNext = loadTeamPingNext();

test('teamPingNext: baseline, open-marks-seen, foreign count, own never badges', () => {
  // No newest message: state untouched, pending preserved.
  assert.deepEqual(teamPingNext(10, 2, null, 'delegate:kaykay', false), { lastSeen: 10, unread: 2 });
  // First sign-in baselines to the current newest id — no badge storm.
  assert.deepEqual(teamPingNext(null, 0, { id: 5, author: 'owner' }, 'delegate:kaykay', false), { lastSeen: 5, unread: 0 });
  assert.deepEqual(teamPingNext(null, 0, { id: 5, author: 'delegate:kaykay' }, 'delegate:kaykay', false), { lastSeen: 5, unread: 0 });
  // Opening the channel marks seen and clears.
  assert.deepEqual(teamPingNext(10, 3, { id: 15, author: 'owner' }, 'delegate:kaykay', true), { lastSeen: 15, unread: 0 });
  // Stale newest: no-op.
  assert.deepEqual(teamPingNext(10, 1, { id: 10, author: 'owner' }, 'delegate:kaykay', false), { lastSeen: 10, unread: 1 });
  // Foreign newer: unread = newest id minus last-seen id.
  assert.deepEqual(teamPingNext(10, 0, { id: 12, author: 'owner' }, 'delegate:kaykay', false), { lastSeen: 10, unread: 2 });
  // Own newest never badges; pending foreign unread is preserved, not dropped.
  assert.deepEqual(teamPingNext(10, 1, { id: 12, author: 'delegate:kaykay' }, 'delegate:kaykay', false), { lastSeen: 10, unread: 1 });
  assert.deepEqual(teamPingNext(10, 0, { id: 12, author: 'delegate:kaykay' }, 'delegate:kaykay', false), { lastSeen: 10, unread: 0 });
  // Documented count corner: an own message interleaved since lastSeen is
  // included when the next foreign newest recomputes from lastSeen (upper
  // bound, not exact — see the code comment; exact counts in that corner
  // would need a server-side count or a wider fetch, neither built here).
  assert.deepEqual(teamPingNext(10, 0, { id: 12, author: 'owner' }, 'delegate:kaykay', false), { lastSeen: 10, unread: 2 });
});

/* ---------------- live server: limit=1 returns the newest only ---------------- */

let tmpDir = null;
let child = null;
let base = null;
let childLog = '';

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
async function req(method, p, { body, token, headers = {} } = {}) {
  const h = { ...headers };
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
  return { status: r.status, json, text };
}
async function waitForServer(deadlineMs = 60000) {
  const start = Date.now();
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${child.exitCode}\n${childLog}`);
    try { const r = await fetch(base + '/api/health'); if (r.status === 200) return; } catch (_) {}
    if (Date.now() - start > deadlineMs) throw new Error(`server did not respond\n${childLog}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}
const A = (token) => ({ token, headers: MGR });
const AB = (token, body) => ({ token, headers: MGR, body });
async function managerLogin(username, password) {
  return req('POST', '/api/manager/login', { body: { username, password } });
}

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-ping-'));
  for (const f of ['server.js', 'package.json']) fs.copyFileSync(path.join(REPO, f), path.join(tmpDir, f));
  for (const d of ['lib', 'public', 'data']) fs.cpSync(path.join(REPO, d), path.join(tmpDir, d), { recursive: true });
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(tmpDir, 'node_modules'), 'dir');
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), SEED_DEMO: '1' };
  for (const k of Object.keys(env)) {
    if (/^(CCBILL_|CRYPTO_|OPENAI_|TWILIO_|VAPID_|WEBAUTHN_)/.test(k)) delete env[k];
  }
  child = spawn(process.execPath, ['server.js'], { cwd: tmpDir, env });
  child.stdout.on('data', (d) => { childLog += d; });
  child.stderr.on('data', (d) => { childLog += d; });
  base = `http://127.0.0.1:${port}`;
  await waitForServer();
});
test.after(() => {
  if (child && child.exitCode === null) child.kill('SIGKILL');
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

let adminToken = null;
let kaykayToken = null;

test('live: owner + kaykay sign in, limit=1 returns only the newest message', async () => {
  const login = await managerLogin('admin', 'admin123'); // manager-login #1
  assert.equal(login.status, 200, JSON.stringify(login.json));
  adminToken = login.json.token;
  const set = await req('POST', '/api/admin/delegate/kaykay/set-password',
    AB(adminToken, { password: 'KayKayPass!23' }));
  assert.equal(set.status, 200, JSON.stringify(set.json));
  const en = await req('POST', '/api/admin/delegate/kaykay/enable', AB(adminToken, {}));
  assert.equal(en.status, 200, JSON.stringify(en.json));
  const klogin = await managerLogin('kaykay', 'KayKayPass!23'); // manager-login #2
  assert.equal(klogin.status, 200, JSON.stringify(klogin.json));
  kaykayToken = klogin.json.token;

  const empty = await req('GET', '/api/admin/team-messages?limit=1', A(adminToken));
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.json.messages, []);

  const p1 = await req('POST', '/api/admin/team-messages', AB(adminToken, { body: 'Owner: first' }));
  assert.equal(p1.status, 200);
  assert.equal(p1.json.message.author, 'owner');
  const p2 = await req('POST', '/api/admin/team-messages', AB(kaykayToken, { body: 'Kay Kay: second' }));
  assert.equal(p2.status, 200);
  assert.equal(p2.json.message.author, 'delegate:kaykay');
  assert.equal(p2.json.message.author_label, 'Kay Kay');

  // The shell poll's exact read: one row, the newest, with author identity.
  const newest = await req('GET', '/api/admin/team-messages?limit=1', A(kaykayToken));
  assert.equal(newest.status, 200);
  assert.equal(newest.json.messages.length, 1);
  assert.equal(newest.json.messages[0].id, p2.json.message.id);
  assert.equal(newest.json.messages[0].author, 'delegate:kaykay');
  assert.equal(newest.json.messages[0].author_label, 'Kay Kay');
  // limit=0 falls back to the default 50 (parseInt 0 is falsy in the
  // server's `|| 50`), so it returns both; limit=1 is the poll's read.
  const fallback = await req('GET', '/api/admin/team-messages?limit=0', A(adminToken));
  assert.equal(fallback.json.messages.length, 2);
  const all = await req('GET', '/api/admin/team-messages?limit=200', A(adminToken));
  assert.deepEqual(all.json.messages.map((m) => m.author), ['owner', 'delegate:kaykay']);
  assert.ok(all.json.messages[0].id < all.json.messages[1].id);
});
