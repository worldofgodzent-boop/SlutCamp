'use strict';
/*
 * Front-door guest messages MUST land in the model's inbox (owner,
 * Oct 30 2026: "We need it to land in her inbox"). The chain had two
 * breaks, both proven against the unmodified tree before this fix:
 *
 *  1. Inbox invisibility (server): guest messages store sender_id
 *     NULL, and the user-side unread math used `sender_id != ?` —
 *     never true for a NULL row in SQL. A guest fan's messages were
 *     stored, but her per-conversation unread_count was 0, her total
 *     unread (home-screen badge + push badge) excluded them, and her
 *     marking the thread read never cleared them (is_read stayed 0).
 *  2. Front-door entry (client + public page): the public page's
 *     "Chat with her" button linked to the generic front door and the
 *     peek's guest bar was join-only, so the advertised "first 3 free,
 *     no account needed" flow never reached a composer. (Client pins
 *     live in tests/landing-profile-peek.test.js; the public-page CTA
 *     is pinned live below.)
 *
 * This suite boots the real server (smoke.test.js harness pattern)
 * and walks the exact API path the front door drives: guest token →
 * conversations/start → messages → the model's inbox list, thread,
 * read-marking and reply → the free cap still stops at 3.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const REPO = path.join(__dirname, '..');

let tmpDir = null;
let child = null;
let base = null;
let childLog = '';
const F = {};

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function boot() {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), CRYPTO_POLL_MS: '3600000' };
  for (const k of Object.keys(env)) {
    if (/^(CCBILL_|CRYPTO_|OPENAI_|TWILIO_|VAPID_|WEBAUTHN_|AV_|SEED_DEMO)/.test(k)) delete env[k];
  }
  childLog = '';
  child = spawn(process.execPath, ['server.js'], { cwd: tmpDir, env });
  child.stdout.on('data', (d) => { childLog += d; });
  child.stderr.on('data', (d) => { childLog += d; });
  base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode})\n${childLog}`);
    try { const r = await fetch(base + '/api/health'); if (r.ok) return; } catch (e) { /* not up */ }
    if (Date.now() > deadline) { child.kill('SIGKILL'); throw new Error(`server did not come up\n${childLog}`); }
    await new Promise((r) => setTimeout(r, 150));
  }
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

async function req(method, p, { body, token, guest } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = 'Bearer ' + token;
  if (guest) headers['x-guest-token'] = guest;
  const r = await fetch(base + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (_) { /* HTML */ }
  return { status: r.status, text, json };
}

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-guestinbox-'));
  for (const d of ['server.js', 'package.json', 'lib', 'public', 'data']) {
    fs.cpSync(path.join(REPO, d), path.join(tmpDir, d), { recursive: true });
  }
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(tmpDir, 'node_modules'), 'dir');
  await boot();

  const suffix = Math.random().toString(36).slice(2, 8);
  const ms = await req('POST', '/api/auth/signup', { body: {
    username: 'guestinbox' + suffix, password: 'guest-inbox-pass-1', role: 'model',
    publicity_consent: true, display_name: 'Inbox Model', dob: '1996-04-12',
    agree18: true, section: 'female' } });
  assert.equal(ms.status, 200, `model signup: ${ms.text}`);
  F.modelId = ms.json.user.id;
  F.modelToken = ms.json.token;
  F.username = ms.json.user.username;

  const gt = await req('POST', '/api/guest/token', { body: {} });
  assert.equal(gt.status, 200, `guest token: ${gt.text}`);
  F.guest = gt.json.guest_token;

  const start = await req('POST', '/api/conversations/start', { guest: F.guest, body: { model_id: F.modelId } });
  assert.equal(start.status, 200, `guest start: ${start.text}`);
  F.convId = start.json.conversation.id;
});

test.after(async () => {
  await killServer();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('public page: "Chat with her" drops the visitor into HER chat (#m/ deep link)', async () => {
  const page = await req('GET', '/models/' + F.username);
  assert.equal(page.status, 200, page.text.slice(0, 120));
  assert.ok(page.text.includes(`<a class="cta" href="/#m/${F.username}">`),
    'the CTA carries her #m/ link, not the generic front door');
});

test('guest sends land in the model inbox — listed, previewed, and BADGED unread', async () => {
  const s1 = await req('POST', '/api/messages', { guest: F.guest, body: { conversation_id: F.convId, body: 'Hi! First free message' } });
  assert.equal(s1.status, 200, `guest send 1: ${s1.text}`);
  const s2 = await req('POST', '/api/messages', { guest: F.guest, body: { conversation_id: F.convId, body: 'Second one — love your page' } });
  assert.equal(s2.status, 200, `guest send 2: ${s2.text}`);

  const list = await req('GET', '/api/conversations', { token: F.modelToken });
  assert.equal(list.status, 200);
  const conv = (list.json.conversations || []).find((c) => c.id === F.convId);
  assert.ok(conv, 'the guest conversation is IN her inbox list');
  assert.equal(conv.other.is_guest, true, 'the other side reads as the guest fan');
  assert.equal(conv.last_message.body, 'Second one — love your page', 'her list previews his latest message');
  assert.equal(conv.unread_count, 2,
    'his messages BADGE in her inbox (sender_id NULL must count as not-hers)');
});

test('model reads the thread, marks it read, and the guest messages actually clear', async () => {
  const msgs = await req('GET', `/api/conversations/${F.convId}/messages`, { token: F.modelToken });
  assert.equal(msgs.status, 200);
  assert.deepEqual((msgs.json.messages || []).map((m) => m.body),
    ['Hi! First free message', 'Second one — love your page'], 'she reads both guest messages');

  const rd = await req('POST', `/api/conversations/${F.convId}/read`, { token: F.modelToken });
  assert.equal(rd.status, 200, `mark read: ${rd.text}`);

  const gMsgs = await req('GET', `/api/conversations/${F.convId}/messages`, { guest: F.guest });
  assert.deepEqual((gMsgs.json.messages || []).map((m) => m.is_read), [1, 1],
    'her read-marking clears guest messages too (NULL sender again)');

  const list = await req('GET', '/api/conversations', { token: F.modelToken });
  const conv = (list.json.conversations || []).find((c) => c.id === F.convId);
  assert.equal(conv.unread_count, 0, 'her unread for the thread is back to 0 after reading');
});

test('model replies in the same thread and the guest sees it', async () => {
  const rep = await req('POST', '/api/messages', { token: F.modelToken, body: { conversation_id: F.convId, body: 'Hi love, thanks for stopping by!' } });
  assert.equal(rep.status, 200, `model reply: ${rep.text}`);
  const gMsgs = await req('GET', `/api/conversations/${F.convId}/messages`, { guest: F.guest });
  const bodies = (gMsgs.json.messages || []).map((m) => m.body);
  assert.equal(bodies[bodies.length - 1], 'Hi love, thanks for stopping by!', 'her reply reaches the guest');
});

test('the first-3-free cap still holds for the guest (4th message is the paywall)', async () => {
  const s3 = await req('POST', '/api/messages', { guest: F.guest, body: { conversation_id: F.convId, body: 'Third and last free one' } });
  assert.equal(s3.status, 200, `guest send 3: ${s3.text}`);
  assert.equal(s3.json.free_remaining, 0, 'the counter runs out exactly at 3');
  const s4 = await req('POST', '/api/messages', { guest: F.guest, body: { conversation_id: F.convId, body: 'One too many' } });
  assert.equal(s4.status, 402, `guest send 4 must be the paywall: ${s4.text}`);
  assert.equal(s4.json.error, 'trial_over');
});
