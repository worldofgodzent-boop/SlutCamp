'use strict';
/*
 * Message reactions — two layers:
 *
 * 1. API tests for POST /api/messages/:id/react against the REAL server
 *    (boots server.js in a throwaway temp copy, same harness pattern as
 *    tests/smoke.test.js). The server side was already complete; these
 *    tests pin its contract: participant-only, guests read-only, one
 *    reaction per person (same emoji toggles off, a different one
 *    replaces), the six-emoji allowlist, and reactions riding along in
 *    the conversation messages payload.
 *
 * 2. Source pins for the iMessage-style long-press (2026-10-16): the
 *    gesture lives entirely in public/js/app.js — press-and-hold any
 *    .msg bubble inside #messages opens the existing reaction popover.
 *    The pins cover the ~500ms timer, the >10px move/scroll cancel
 *    paths, capture-phase click suppression after a fired press (a
 *    pressed locked PPV tile must NEVER unlock), contextmenu
 *    prevention, the editing/mini-act/popover guards, the once-only
 *    delegated binding, and that the original 🤍 button survives.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const app = read('public/js/app.js');
const css = read('public/css/styles.css');

/* ---------------- server harness (smoke.test.js pattern) ---------------- */

let tmpDir = null;
let child = null;
let base = null;
let childLog = '';

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

async function req(method, p, { body, token, guest } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = 'Bearer ' + token;
  if (guest) headers['x-guest-token'] = guest;
  const r = await fetch(base + p, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* HTML or empty */ }
  return { status: r.status, headers: r.headers, text, json };
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

/* Shared scenario state: fan A chats with seeded model bunny; fan A
 * sends one message; fan B is a stranger to that conversation. */
let fanA = null; // { token, id }
let fanB = null; // { token, id }
let model = null; // { token, id }
let convId = null;
let msgId = null;

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-reactions-'));
  for (const f of ['server.js', 'package.json']) {
    fs.copyFileSync(path.join(REPO, f), path.join(tmpDir, f));
  }
  for (const d of ['lib', 'public', 'data']) {
    fs.cpSync(path.join(REPO, d), path.join(tmpDir, d), { recursive: true });
  }
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(tmpDir, 'node_modules'), 'dir');

  let lastErr = null;
  for (let attempt = 1; attempt <= 3 && !base; attempt++) {
    const port = await freePort();
    // SEED_DEMO=1: this suite's fixtures ARE the demo accounts (bunny /
    // fandemo). Seeding is opt-in since the pre-launch fake-money
    // cleanup, so the harness opts in explicitly — and the demo-seed
    // purge stays out of the way while the flag is set.
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
    } catch (e) {
      lastErr = e;
      base = null;
      if (child && child.exitCode === null) child.kill('SIGKILL');
      child = null;
      for (const f of fs.readdirSync(tmpDir)) {
        if (/^wogent-chat\.db/.test(f)) fs.rmSync(path.join(tmpDir, f), { force: true });
      }
      fs.rmSync(path.join(tmpDir, 'uploads'), { recursive: true, force: true });
      fs.rmSync(path.join(tmpDir, 'private'), { recursive: true, force: true });
    }
  }
  if (!base) throw lastErr || new Error('server failed to boot after 3 attempts');

  // --- scenario setup ---
  const suffix = Math.random().toString(36).slice(2, 8);
  const mkFan = async (name) => {
    const s = await req('POST', '/api/auth/signup', {
      body: { username: name + suffix, password: 'react-pass-1', role: 'fan', display_name: name, dob: '1995-06-15', agree18: true },
    });
    assert.equal(s.status, 200, `fan signup failed: ${s.text}`);
    return { token: s.json.token, id: s.json.user.id };
  };
  fanA = await mkFan('rxfana');
  fanB = await mkFan('rxfanb');

  const models = await req('GET', '/api/models');
  assert.equal(models.status, 200);
  const bunny = models.json.models.find((m) => m.username === 'bunny');
  assert.ok(bunny, 'seeded model bunny must exist');
  const ml = await req('POST', '/api/auth/login', { body: { username: 'bunny', password: 'model123' } });
  assert.equal(ml.status, 200, `model login failed: ${ml.text}`);
  model = { token: ml.json.token, id: bunny.id };

  const start = await req('POST', '/api/conversations/start', { body: { model_id: bunny.id }, token: fanA.token });
  assert.equal(start.status, 200, `conversation start failed: ${start.text}`);
  convId = start.json.conversation.id;

  const sent = await req('POST', '/api/messages', { body: { conversation_id: convId, body: 'hey bunny 💋' }, token: fanA.token });
  assert.equal(sent.status, 200, `message send failed: ${sent.text}`);
  msgId = sent.json.message.id;
  assert.ok(Number.isInteger(msgId), 'message id must be an integer');
});

test.after(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((r) => child.once('exit', r)),
      new Promise((r) => setTimeout(r, 5000)),
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

/* ---------------- API: reaction semantics ---------------- */

test('react: participant fan reacts ❤️ → 200 with the reactions payload', async () => {
  const r = await req('POST', `/api/messages/${msgId}/react`, { body: { emoji: '❤️' }, token: fanA.token });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.reactions.length, 1);
  assert.equal(r.json.reactions[0].emoji, '❤️');
  assert.equal(r.json.reactions[0].user_id, fanA.id);
  assert.equal(r.json.reactions[0].mine, true);
});

test('react: same emoji again toggles the reaction OFF', async () => {
  const r = await req('POST', `/api/messages/${msgId}/react`, { body: { emoji: '❤️' }, token: fanA.token });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.reactions, []);
});

test('react: a different emoji REPLACES the previous one (one per person)', async () => {
  const first = await req('POST', `/api/messages/${msgId}/react`, { body: { emoji: '🔥' }, token: fanA.token });
  assert.equal(first.status, 200, first.text);
  assert.deepEqual(first.json.reactions.map((x) => x.emoji), ['🔥']);
  const second = await req('POST', `/api/messages/${msgId}/react`, { body: { emoji: '😍' }, token: fanA.token });
  assert.equal(second.status, 200, second.text);
  assert.equal(second.json.reactions.length, 1, 'still exactly one reaction from the fan');
  assert.equal(second.json.reactions[0].emoji, '😍');
  assert.equal(second.json.reactions[0].user_id, fanA.id);
});

test('react: the model in the conversation can react too', async () => {
  const r = await req('POST', `/api/messages/${msgId}/react`, { body: { emoji: '💦' }, token: model.token });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.reactions.length, 2);
  const byUser = new Map(r.json.reactions.map((x) => [x.user_id, x]));
  assert.equal(byUser.get(fanA.id).emoji, '😍');
  assert.equal(byUser.get(fanA.id).mine, false, 'fan reaction is not "mine" for the model');
  assert.equal(byUser.get(model.id).emoji, '💦');
  assert.equal(byUser.get(model.id).mine, true);
});

test('react: a non-participant fan gets 403', async () => {
  const r = await req('POST', `/api/messages/${msgId}/react`, { body: { emoji: '❤️' }, token: fanB.token });
  assert.equal(r.status, 403, r.text);
  assert.equal(r.json.error, 'forbidden');
});

test('react: guests are read-only — 403 login_required', async () => {
  const g = await req('POST', '/api/guest/token', { body: {} });
  assert.equal(g.status, 200);
  const r = await req('POST', `/api/messages/${msgId}/react`, { body: { emoji: '❤️' }, guest: g.json.guest_token });
  assert.equal(r.status, 403, r.text);
  assert.equal(r.json.error, 'login_required');
});

test('react: an emoji outside the six gets 400 bad_emoji', async () => {
  const r = await req('POST', `/api/messages/${msgId}/react`, { body: { emoji: '🚀' }, token: fanA.token });
  assert.equal(r.status, 400, r.text);
  assert.equal(r.json.error, 'bad_emoji');
});

test('react: reactions ride along in the conversation messages payload', async () => {
  const r = await req('GET', `/api/conversations/${convId}/messages`, { token: fanA.token });
  assert.equal(r.status, 200, r.text);
  const m = r.json.messages.find((x) => x.id === msgId);
  assert.ok(m, 'the message must be in the thread payload');
  assert.equal(m.reactions.length, 2);
  const byUser = new Map(m.reactions.map((x) => [x.user_id, x]));
  assert.equal(byUser.get(fanA.id).emoji, '😍');
  assert.equal(byUser.get(fanA.id).mine, true);
  assert.equal(byUser.get(model.id).emoji, '💦');
  assert.equal(byUser.get(model.id).mine, false);
});

/* ---------------- client: long-press source pins ---------------- */

function lpSection() {
  const start = app.indexOf('iMessage-style long-press on the bubble itself');
  assert.ok(start !== -1, 'long-press section not found in app.js');
  const end = app.indexOf('function startEditMsg', start);
  assert.ok(end !== -1, 'end of long-press section not found');
  return app.slice(start, end);
}

test('long-press: wiring lives in bindMessageActions and binds exactly once', () => {
  assert.match(app, /function bindMessageActions\(scope\) \{\n  if \(!scope\) return;\n  bindLongPressReact\(scope\);/);
  const lp = lpSection();
  assert.match(lp, /function bindLongPressReact\(box\)/);
  assert.match(lp, /box\.dataset\.lpBound === '1'/, 'dataset flag guards against double-binding');
  assert.match(lp, /box\.dataset\.lpBound = '1'/);
});

test('long-press: ~500ms pointerdown timer fires the EXISTING popover on the bubble', () => {
  const lp = lpSection();
  assert.match(lp, /const LONG_PRESS_MS = 500;/);
  assert.match(lp, /box\.addEventListener\('pointerdown', \(e\) => \{/);
  assert.match(lp, /\}, LONG_PRESS_MS\);/);
  assert.match(lp, /openReactPop\(parseInt\(b\.dataset\.mid, 10\), b\);/,
    'the popover opens anchored on the pressed bubble itself');
  assert.match(lp, /navigator\.vibrate\) navigator\.vibrate\(10\)/, 'haptic tick on fire, guarded');
  assert.match(lp, /bubble\.classList\.add\('pressing'\)/, 'press feedback while arming');
  assert.match(lp, /lpState\.bubble\.classList\.remove\('pressing'\)|b\.classList\.remove\('pressing'\)/);
});

test('long-press: move >10px, pointerup, pointercancel and scroll all cancel', () => {
  const lp = lpSection();
  assert.match(lp, /const LONG_PRESS_MOVE_PX = 10;/);
  assert.match(lp, /box\.addEventListener\('pointermove', \(e\) => \{/);
  assert.match(lp, /Math\.abs\(e\.clientX - lpState\.x\) > LONG_PRESS_MOVE_PX/);
  assert.match(lp, /box\.addEventListener\('pointerup', lpCancel\);/);
  assert.match(lp, /box\.addEventListener\('pointercancel', lpCancel\);/);
  assert.match(lp, /box\.addEventListener\('scroll', lpCancel\);/);
});

test('long-press: a fired press swallows the following click in the capture phase', () => {
  const lp = lpSection();
  assert.match(lp, /const LP_CLICK_SWALLOW_MS = 400;/);
  assert.match(lp, /lpLastFiredAt = Date\.now\(\);/, 'fire timestamp recorded');
  assert.match(lp, /box\.addEventListener\('click', \(e\) => \{/);
  assert.match(lp, /Date\.now\(\) - lpLastFiredAt < LP_CLICK_SWALLOW_MS/);
  assert.match(lp, /e\.preventDefault\(\);\n      e\.stopPropagation\(\);/);
  assert.match(lp, /\}, true\);/, 'click listener is capture-phase, ahead of bubble handlers like PPV unlock');
});

test('long-press: contextmenu is prevented inside #messages', () => {
  const lp = lpSection();
  assert.match(lp, /box\.addEventListener\('contextmenu', \(e\) => \{ e\.preventDefault\(\); \}\);/);
});

test('long-press: guards — editing message, mini-act buttons, open popover never arm', () => {
  const lp = lpSection();
  assert.match(lp, /e\.target\.closest\('\.mini-act'\)/, '🤍/✏️ keep their own click behavior');
  assert.match(lp, /editingMsgId === mid\) return;/, 'the message being edited never arms');
  assert.match(lp, /e\.target\.closest\('\.msg-edit'\)/, 'presses inside the inline editor are text work');
  assert.match(lp, /reactPop && reactPop\.el\.contains\(e\.target\)/, 'presses inside the open popover are skipped');
  assert.match(lp, /e\.target\.closest\('\.msg'\)/, 'arming starts from the bubble itself');
});

test('long-press: the original 🤍 button is untouched', () => {
  assert.match(app, /<button type="button" class="mini-act" data-react="\$\{m\.id\}" aria-label="React">🤍<\/button>/);
  assert.match(app, /openReactPop\(parseInt\(b\.dataset\.react\), b\)/);
});

test('long-press CSS: no callout menu on bubbles; .pressing feedback is scoped', () => {
  assert.match(css, /\.msg \{ -webkit-touch-callout: none; \}/);
  assert.match(css, /\.msg\.pressing \{/);
  const pressing = css.slice(css.indexOf('.msg.pressing'));
  assert.match(pressing, /transform: scale\(/);
  assert.match(pressing, /user-select: none/, 'selection suppressed only while pressing');
  assert.doesNotMatch(css, /\.msg \{[^}]*user-select: none/,
    'bubbles must NOT get a blanket user-select:none — text copy stays possible');
});
