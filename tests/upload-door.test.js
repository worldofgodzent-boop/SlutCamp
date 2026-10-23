'use strict';
/*
 * Upload Side Door — up.slutcamp.app (2026-10-23).
 *
 * The main site sits behind Cloudflare's proxy (100 MB request cap);
 * chat media (POST /api/media/send) deliberately allows 200 MB, so
 * uploads get a DNS-only subdomain straight to this same app.
 *
 * Pins:
 *  - Host gate: on Host up.slutcamp.app ONLY /api/media/send is
 *    served; every other path 404s (the door is never a second,
 *    un-proxied copy of the site). Other hosts are untouched.
 *  - The door passes media sends end-to-end: a model's PPV send with
 *    a Host of up.slutcamp.app lands exactly like a same-origin send
 *    (auth rides the Authorization header — no cookies anywhere).
 *  - CORS on /api/media/send only: the app origins
 *    (https://slutcamp.app, https://www.slutcamp.app) get an echoed
 *    Access-Control-Allow-Origin and a real preflight (POST, the
 *    token/content headers, no credentials header ever); any other
 *    origin gets NO CORS headers and its preflight falls through.
 *  - The client switch: GET /api/build-id carries upload_origin from
 *    the UPLOAD_ORIGIN env ('' default, trailing slash normalized).
 *    With the switch off, app.js resolves the upload URL to exactly
 *    '/api/media/send' — byte-identical to the pre-door behavior.
 *
 * Harness: fan-pics pattern — the real server boots in a throwaway
 * temp copy with SEED_DEMO=1. Door-host requests go through raw
 * node:http so the Host header is exact.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const serverSrc = read('server.js');
const appSrc = read('public/js/app.js');
const DOOR = 'up.slutcamp.app';

/* ---------------- static pins ---------------- */

test('static: server carries the host gate, the CORS grant and the build-id field', () => {
  for (const frag of [
    "const UPLOAD_ORIGIN = String(process.env.UPLOAD_ORIGIN || '').trim().replace(/\\/+$/, '');",
    "const UPLOAD_HOST = 'up.slutcamp.app';",
    "const APP_ORIGINS = ['https://slutcamp.app', 'https://www.slutcamp.app'];",
    "p === '/api/media/send' || p === '/api/media/send/'",
    "if ((req.hostname || '').toLowerCase() === UPLOAD_HOST && !isMediaSendPath(req.path))",
    "return res.status(404).json({ error: 'not_found' });",
    'function mediaSendCors(req, res, next)',
    "app.use('/api/media/send', mediaSendCors);",
    "res.set('Access-Control-Allow-Origin', origin);",
    "res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');",
    "res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Guest-Token');",
    'upload_origin: UPLOAD_ORIGIN',
    "=== UPLOAD_HOST) { ws.close(4404, 'not_found'); return; }",
  ]) {
    assert.ok(serverSrc.includes(frag), `server carries: ${frag}`);
  }
  // The CORS grant is scoped to the one route — no global CORS anywhere.
  assert.equal(serverSrc.split('Access-Control-Allow-Origin').length - 1, 1,
    'Access-Control-Allow-Origin is set in exactly one place (mediaSendCors)');
  assert.ok(!serverSrc.includes("set('Access-Control-Allow-Credentials'")
    && !serverSrc.includes('set("Access-Control-Allow-Credentials"'),
    'credentials header is never set (header-token auth; the name appears only in the door comment)');
});

test('static: client routes both media sends through the upload-origin switch', () => {
  for (const frag of [
    'function resolveUploadOrigin()',
    'async function mediaSendUrl()',
    "return (await resolveUploadOrigin()) + '/api/media/send';",
    "typeof d.upload_origin === 'string'",
  ]) {
    assert.ok(appSrc.includes(frag), `client carries: ${frag}`);
  }
  assert.equal(appSrc.split('fetch(await mediaSendUrl()').length - 1, 2,
    'uploadMedia and uploadFanPic both post via mediaSendUrl()');
  assert.ok(!appSrc.includes("fetch('/api/media/send'"),
    'no call site hard-codes the same-origin path anymore');
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
async function req(base, method, p, { body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = 'Bearer ' + token;
  const r = await fetch(base + p, { method, headers,
    body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
  return { status: r.status, text, json };
}
/* Raw request with an exact Host header (fetch forbids overriding it). */
function rawReq(base, { method = 'GET', path: p, host, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    const r = http.request({ hostname: u.hostname, port: u.port, path: p, method,
      headers: { ...headers, ...(host ? { host } : {}) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}
const PNG = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001080600000' +
  '01f15c4890000000a49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082', 'hex');
async function sendMediaVia(base, host, token, { convId, kind, extra = {} }) {
  const fd = new FormData();
  fd.append('file', new Blob([PNG], { type: 'image/png' }), 'pic.png');
  fd.append('conversation_id', String(convId));
  fd.append('kind', kind);
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  const rq = new Request('http://door.invalid/api/media/send', { method: 'POST', body: fd });
  const buf = Buffer.from(await rq.arrayBuffer());
  return rawReq(base, { method: 'POST', path: '/api/media/send', host,
    headers: { 'content-type': rq.headers.get('content-type'),
      'content-length': String(buf.length), authorization: 'Bearer ' + token },
    body: buf });
}
async function signup(base, username, role, extra = {}) {
  const s = await req(base, 'POST', '/api/auth/signup', {
    body: { username, password: 'hunter22x', role, display_name: username,
      dob: '1995-05-05', agree18: true, ...extra },
  });
  assert.equal(s.status, 200, `signup ${username}: ${s.text}`);
  return { token: s.json.token, id: s.json.user.id, username };
}

/* ---------------- runtime: switch OFF ---------------- */

test('runtime: host gate, door send, CORS grant — switch off', { timeout: 300000 }, async () => {
  const dir = makeCopy('uploaddoor');
  let h = null;
  try {
    h = await boot(dir, { UPLOAD_ORIGIN: '' });
    const base = h.base;

    // The switch is off: the advertised origin is empty.
    const bid = await req(base, 'GET', '/api/build-id');
    assert.equal(bid.status, 200);
    assert.equal(bid.json.upload_origin, '', 'upload_origin defaults to empty (same-origin)');

    // Host gate: the door serves nothing but the media route.
    for (const p of ['/', '/api/health', '/api/models', '/api/build-id', '/manager', '/uploads/x.png']) {
      const r = await rawReq(base, { path: p, host: DOOR });
      assert.equal(r.status, 404, `door host 404s ${p} (got ${r.status})`);
      assert.equal(r.json && r.json.error, 'not_found', `door host 404 body for ${p}`);
    }
    // The gate lets the media route itself through (to its own auth).
    const unauthed = await rawReq(base, { method: 'POST', path: '/api/media/send', host: DOOR });
    assert.equal(unauthed.status, 401, `door media route reached, auth fires: ${unauthed.status} ${unauthed.text}`);
    assert.equal(unauthed.json.error, 'not_logged_in');

    // Other hosts are untouched by the gate.
    const models = await req(base, 'GET', '/api/models');
    assert.equal(models.status, 200, 'main host /api/models still serves');
    const health = await rawReq(base, { path: '/api/health', host: 'slutcamp.app' });
    assert.equal(health.status, 200, 'apex host /api/health still serves');

    // A full send THROUGH the door: model PPV image, header auth.
    const suffix = Math.random().toString(36).slice(2, 8);
    const model = await signup(base, 'udmodel' + suffix, 'model', { section: 'female' });
    const fan = await signup(base, 'udfan' + suffix, 'fan');
    const start = await req(base, 'POST', '/api/conversations/start', { token: fan.token, body: { model_id: model.id } });
    assert.equal(start.status, 200, `start conv: ${start.text}`);
    const convId = start.json.conversation.id;
    const sent = await sendMediaVia(base, DOOR, model.token,
      { convId, kind: 'ppv_image', extra: { price_cents: '0', duration_sec: '0' } });
    assert.equal(sent.status, 200, `door send: ${sent.status} ${sent.text}`);
    assert.ok(sent.json && sent.json.message && sent.json.message.id, 'door send delivered a message');
    // …and the same send works same-origin, byte-for-byte the old path.
    const sentMain = await sendMediaVia(base, undefined, model.token,
      { convId, kind: 'ppv_image', extra: { price_cents: '0', duration_sec: '0' } });
    assert.equal(sentMain.status, 200, `main-host send still works: ${sentMain.status} ${sentMain.text}`);

    // CORS preflight from an app origin: granted, exact grant shape.
    for (const origin of ['https://slutcamp.app', 'https://www.slutcamp.app']) {
      const pre = await rawReq(base, { method: 'OPTIONS', path: '/api/media/send',
        headers: { origin, 'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization,content-type' } });
      assert.equal(pre.status, 204, `preflight ${origin}: ${pre.status}`);
      assert.equal(pre.headers['access-control-allow-origin'], origin, 'origin echoed');
      assert.match(pre.headers['access-control-allow-methods'] || '', /POST/, 'POST allowed');
      const ah = (pre.headers['access-control-allow-headers'] || '').toLowerCase();
      assert.ok(ah.includes('authorization'), 'Authorization header allowed');
      assert.ok(ah.includes('content-type'), 'Content-Type header allowed');
      assert.ok(ah.includes('x-guest-token'), 'X-Guest-Token header allowed');
      assert.equal(pre.headers['access-control-allow-credentials'], undefined, 'no credentials header');
    }
    // Preflight also answers on the door host itself.
    const preDoor = await rawReq(base, { method: 'OPTIONS', path: '/api/media/send', host: DOOR,
      headers: { origin: 'https://slutcamp.app', 'access-control-request-method': 'POST' } });
    assert.equal(preDoor.status, 204, `door preflight: ${preDoor.status}`);
    assert.equal(preDoor.headers['access-control-allow-origin'], 'https://slutcamp.app');

    // A stranger origin gets nothing: no grant on preflight or actual.
    const preEvil = await rawReq(base, { method: 'OPTIONS', path: '/api/media/send',
      headers: { origin: 'https://evil.example.com', 'access-control-request-method': 'POST' } });
    assert.equal(preEvil.headers['access-control-allow-origin'], undefined, 'no grant for stranger preflight');
    const postTrusted = await rawReq(base, { method: 'POST', path: '/api/media/send',
      headers: { origin: 'https://slutcamp.app' } });
    assert.equal(postTrusted.status, 401, 'actual request still runs the route (auth)');
    assert.equal(postTrusted.headers['access-control-allow-origin'], 'https://slutcamp.app',
      'actual response carries the grant for the app origin');
    const postEvil = await rawReq(base, { method: 'POST', path: '/api/media/send',
      headers: { origin: 'https://evil.example.com' } });
    assert.equal(postEvil.status, 401);
    assert.equal(postEvil.headers['access-control-allow-origin'], undefined,
      'actual response carries NO grant for a stranger origin');
    const postNoOrigin = await rawReq(base, { method: 'POST', path: '/api/media/send' });
    assert.equal(postNoOrigin.headers['access-control-allow-origin'], undefined,
      'same-origin style request (no Origin) untouched');
  } finally {
    await stop(h);
  }
});

/* ---------------- runtime: switch ON ---------------- */

test('runtime: UPLOAD_ORIGIN is advertised normalized on /api/build-id', { timeout: 300000 }, async () => {
  const dir = makeCopy('uploaddoor-on');
  let h = null;
  try {
    h = await boot(dir, { UPLOAD_ORIGIN: 'https://up.slutcamp.app/' });
    const bid = await req(h.base, 'GET', '/api/build-id');
    assert.equal(bid.status, 200);
    assert.equal(bid.json.upload_origin, 'https://up.slutcamp.app',
      'env origin advertised with the trailing slash stripped');
    assert.ok(bid.json.build !== undefined && bid.json.cache, 'the rest of the payload is unchanged');
  } finally {
    await stop(h);
  }
});
