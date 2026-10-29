'use strict';
/*
 * STREAMING RELAY (Cloudflare Realtime SFU) — owner build Oct 21 2026.
 *
 * What this pins:
 *  - Dark by default: with CF_REALTIME_APP_ID / CF_REALTIME_APP_SECRET
 *    unset, /api/relay/* answers 503 relay_disabled, /api/live/start
 *    reports relay_enabled:false, join reports relay_available:false —
 *    the mesh behaves exactly as before the relay existed.
 *  - With config present (a local mock stands in for Cloudflare — no
 *    live network in tests), the brokered SFU flow works end to end:
 *    host publishes (offer -> our server -> mock -> answer), a fan
 *    subscribes (mock offer -> tracks with mids), only the subscriber
 *    may renegotiate/close his subscription, and the publication is
 *    recorded so join can flag relay_available.
 *  - Auth boundaries: only the session's own model may publish;
 *    subscribers are fans (public sessions) or the opposing battler of
 *    a live battle on the session — never a stranger model, never the
 *    host herself; battleOut carries per-side host_relay/guest_relay.
 *  - Private Rooms are refused at BOTH relay doors (they stay P2P).
 *  - Client wiring: publish rides startLiveBroadcast + rejoin only;
 *    subscribe rides watchLive (before join) + the two battle connect
 *    paths; the model counts via_relay viewers instead of meshing
 *    them; teardown closes relay connections on every exit path.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const REPO = path.join(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(REPO, 'public/js/app.js'), 'utf8');
const relaySrc = fs.readFileSync(path.join(REPO, 'lib', 'relay.js'), 'utf8');

function span(src, from, to) {
  const i = src.indexOf(from);
  assert.ok(i >= 0, 'marker found: ' + from);
  const j = src.indexOf(to, i + from.length);
  assert.ok(j > i, 'end marker found: ' + to);
  return src.slice(i, j);
}
const count = (src, s) => src.split(s).length - 1;

/* ---------------- static pins ---------------- */

test('relay: lib shape — config gate, Cloudflare base, SFU verbs', () => {
  assert.ok(relaySrc.includes("process.env.CF_REALTIME_APP_ID"), 'app id env');
  assert.ok(relaySrc.includes("process.env.CF_REALTIME_APP_SECRET"), 'app secret env');
  assert.ok(relaySrc.includes('https://rtc.live.cloudflare.com/v1'), 'default CF base');
  assert.ok(relaySrc.includes('`Bearer ${c.appSecret}`'), 'secret rides as Bearer, server-side');
  for (const fn of ['createSession', 'publishTracks', 'subscribeTracks', 'renegotiate', 'closeTracks'])
    assert.ok(relaySrc.includes(`async function ${fn}`), 'lib exports ' + fn);
  assert.ok(relaySrc.includes('sessions/new'), 'session create path');
  assert.ok(relaySrc.includes('/tracks/new'), 'tracks path');
  assert.ok(relaySrc.includes('/renegotiate'), 'renegotiate path');
  assert.ok(relaySrc.includes('/tracks/close'), 'close path');
});

test('relay: server endpoints + auth + private-room refusal', () => {
  assert.ok(serverSrc.includes("require('./lib/relay')"), 'server loads the relay lib');
  const pub = span(serverSrc, "app.post('/api/relay/publish'", "app.post('/api/relay/subscribe'");
  assert.ok(pub.includes("requireRole('model')"), 'publish is model-only');
  assert.ok(pub.includes('sess.model_id !== req.user.id'), 'only the session owner publishes');
  assert.ok(pub.includes('relay_private_room'), 'publish refuses Private Rooms');
  assert.ok(pub.includes('relayPubs.set(sess.id'), 'publication is recorded');
  const sub = span(serverSrc, "app.post('/api/relay/subscribe'", "app.post('/api/relay/renegotiate'");
  assert.ok(sub.includes('relay_private_room'), 'subscribe refuses Private Rooms');
  assert.ok(sub.includes('modelRegionBlocked'), 'fan subscribe keeps the region gate');
  assert.ok(sub.includes('liveBattleForSession'), 'model subscribe is battle-scoped');
  assert.ok(sub.includes('relay_unavailable'), 'no publication -> clean 409');
  const ren = span(serverSrc, "app.post('/api/relay/renegotiate'", "app.post('/api/relay/close'");
  assert.ok(ren.includes('sub.userId !== req.user.id'), 'only the subscriber renegotiates');
  for (const p of ['/api/relay/publish', '/api/relay/subscribe', '/api/relay/renegotiate', '/api/relay/close'])
    assert.ok(serverSrc.includes(`app.post('${p}'`), 'endpoint exists: ' + p);
  assert.ok(serverSrc.includes("return res.status(503).json({ error: 'relay_disabled' })"),
    'unconfigured relay answers 503 relay_disabled');
});

test('relay: advertisement + suppression wiring on existing surfaces', () => {
  const start = span(serverSrc, "app.post('/api/live/start'", "app.post('/api/live/:id/leave'");
  assert.ok(start.includes('relay_enabled: relayLib.configured() && !privEv'),
    'start advertises relay_enabled (never for Private Rooms)');
  const join = span(serverSrc, "app.post('/api/live/:id/join'", "app.post('/api/live/:id/pay'");
  assert.ok(join.includes('via_relay: true'), 'join flags relay viewers to the model');
  assert.ok(join.includes('relay_available: relayPubs.has(sess.id)'), 'join advertises relay_available');
  const enter = span(serverSrc, "app.post('/api/battles/:id/enter'", "app.get('/api/battles/live'");
  assert.ok(enter.includes('via_relay: true'), 'battle enter flags relay viewers too');
  const bout = span(serverSrc, 'function battleOut(b)', 'function getBattle(');
  assert.ok(bout.includes('host_relay: !!relayPubs.get(b.host_session_id)'), 'battleOut host_relay');
  assert.ok(bout.includes('guest_relay: !!relayPubs.get(b.guest_session_id)'), 'battleOut guest_relay');
  const leave = span(serverSrc, "app.post('/api/live/:id/leave'", "app.get('/api/live/schedule'");
  assert.ok(leave.includes('relayDropViewerSub(sess.id, req.user.id, true)'), 'leave drops the relay sub');
  const end = span(serverSrc, "app.post('/api/live/:id/end'", "app.post('/api/relay/publish'");
  assert.ok(end.includes('endLiveSession(sess, clientIp(req))'),
    'live end runs the shared teardown helper (Moderator build refactor: the route body moved into endLiveSession so the moderator live-cut ends a session with identical semantics)');
  const teardown = span(serverSrc, 'function endLiveSession(sess, ip)', "app.post('/api/live/:id/end'");
  assert.ok(teardown.includes('relayTeardownSession(sess.id)'), 'live end tears the relay state down');
});

test('relay: client wiring — publish/subscribe placement + fallback + counts', () => {
  assert.equal(count(appSrc, 'relayPublishStart('), 3, 'publish: 1 def + start + rejoin calls');
  assert.equal(count(appSrc, 'relaySubscribeStart('), 3, 'subscribe: 1 def + watchLive + battleConnectSession');
  assert.equal(count(appSrc, 'battleConnectSession('), 4, 'battle connect: 1 def + stage x2 + battler');
  assert.equal(count(appSrc, 'relayClose('), 4, 'close: 1 def + watchLive join-fail + endLiveView + battle PC close');
  const wl = span(appSrc, 'async function watchLive(sessionId)', 'function vLiveWatch()');
  assert.ok(wl.indexOf('relaySubscribeStart(sessionId)') < wl.indexOf('/join'),
    'watchLive subscribes BEFORE joining (so the join can be flagged)');
  assert.ok(wl.includes('pc.ontrack = livePcOnTrack'), 'mesh path keeps the shared track handler');
  assert.ok(appSrc.includes("if (m.via_relay) { liveRelayViewers.add(m.fan_id); updateLiveViewerCount(); }"),
    'model counts relay viewers instead of meshing them');
  assert.ok(appSrc.includes('livePCs.size + liveRelayViewers.size'),
    'viewer count = mesh PCs + relay viewers');
  assert.ok(appSrc.includes('if (liveRelayViewers.has(fanId)) return;'),
    'a relay viewer is never mesh-connected after the fact');
  const start = span(appSrc, 'async function startLiveBroadcast()', '/* --- Speech safety bot');
  assert.ok(start.includes('if (data.relay_enabled) relayPublishStart(data.session_id, stream);'),
    'broadcast start publishes when the server enables the relay');
});

/* ---------------- boot harness (mirrors live-battles) ---------------- */

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
  const env = { ...process.env, PORT: String(port), CRYPTO_POLL_MS: '3600000', ...extraEnv };
  for (const k of Object.keys(env)) {
    if (/^(CCBILL_|CRYPTO_|OPENAI_|TWILIO_|VAPID_|WEBAUTHN_|AV_)/.test(k)) delete env[k];
    if (k.startsWith('CF_REALTIME_') && !(k in extraEnv)) delete env[k];
  }
  if (!('SEED_DEMO' in extraEnv)) delete env.SEED_DEMO;
  const child = spawn(process.execPath, ['server.js'], { cwd: dir, env });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60000;
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
  const hdrs = { ...(headers || {}) };
  if (body !== undefined) hdrs['content-type'] = 'application/json';
  if (token) hdrs.authorization = 'Bearer ' + token;
  const r = await fetch(base + p, {
    method, headers: hdrs, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
  return { status: r.status, text, json };
}
const PNG = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001080600000'
  + '01f15c4890000000a49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082', 'hex');
async function upload(base, p, token, fields = ['id_front', 'id_back', 'selfie']) {
  const fd = new FormData();
  for (const f of fields) fd.append(f, new Blob([PNG], { type: 'image/png' }), `${f}.png`);
  const r = await fetch(base + p, { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: fd });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
  return { status: r.status, text, json };
}
async function mgrLogin(base) {
  const mgr = await req(base, 'POST', '/api/manager/login', { body: { username: 'admin', password: 'admin123' } });
  assert.equal(mgr.status, 200, `manager login: ${mgr.text}`);
  return { token: mgr.json.token, headers: { 'x-manager': '1' } };
}
async function makeAccounts(base, MGR, tag) {
  const signup = async (username, role) => {
    const s = await req(base, 'POST', '/api/auth/signup', {
      body: { username, password: 'hunter22', role, display_name: username,
        dob: '1995-05-05', agree18: true, section: 'female',
        ...(role === 'model' ? { publicity_consent: true } : {}) },
    });
    assert.equal(s.status, 200, `signup ${username}: ${s.text}`);
    return { token: s.json.token, id: s.json.user.id, username };
  };
  const verifyOwnId = async (acct) => {
    const up = await upload(base, '/api/model/id-verification', acct.token);
    assert.equal(up.status, 200, `ID upload: ${up.text}`);
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
  const host = await signup(`${tag}host`, 'model'); await verifyOwnId(host);
  const guest = await signup(`${tag}guest`, 'model'); await verifyOwnId(guest);
  const stranger = await signup(`${tag}stranger`, 'model'); await verifyOwnId(stranger);
  const fan = await signup(`${tag}fan`, 'fan');
  const fan2 = await signup(`${tag}fan2`, 'fan');
  const goLive = async (acct, extra = {}) => {
    const r = await req(base, 'POST', '/api/live/start', { token: acct.token, body: { title: `${tag} live`, ...extra } });
    assert.equal(r.status, 200, `go live ${acct.username}: ${r.text}`);
    return r.json;
  };
  return { host, guest, stranger, fan, fan2, goLive };
}

/* ---------------- functional: dark by default ---------------- */

test('relay: unconfigured = disabled everywhere, mesh untouched', { timeout: 180000 }, async () => {
  const dir = makeCopy('relaydark');
  let h = null;
  try {
    h = await boot(dir, { SEED_DEMO: '1' });
    const MGR = await mgrLogin(h.base);
    const W = await makeAccounts(h.base, MGR, 'rd');
    const started = await W.goLive(W.host);
    assert.equal(started.relay_enabled, false, 'start reports relay_enabled:false');
    const sid = started.session_id;
    const det = await req(h.base, 'GET', `/api/live/${sid}`, { token: W.host.token });
    assert.equal(det.json.relay_enabled, false, 'session details report relay_enabled:false');
    const pub = await req(h.base, 'POST', '/api/relay/publish', { token: W.host.token,
      body: { session_id: sid, sessionDescription: { type: 'offer', sdp: 'x' }, tracks: [{ mid: '0', trackName: 'video' }] } });
    assert.equal(pub.status, 503); assert.equal(pub.json.error, 'relay_disabled');
    const sub = await req(h.base, 'POST', '/api/relay/subscribe', { token: W.fan.token, body: { session_id: sid } });
    assert.equal(sub.status, 503); assert.equal(sub.json.error, 'relay_disabled');
    const ren = await req(h.base, 'POST', '/api/relay/renegotiate', { token: W.fan.token,
      body: { cf_session_id: 'cf-x', sessionDescription: { type: 'answer', sdp: 'x' } } });
    assert.equal(ren.status, 503); assert.equal(ren.json.error, 'relay_disabled');
    const cls = await req(h.base, 'POST', '/api/relay/close', { token: W.fan.token, body: { cf_session_id: 'cf-x' } });
    assert.equal(cls.status, 200, 'close is always safe');
    const join = await req(h.base, 'POST', `/api/live/${sid}/join`, { token: W.fan.token });
    assert.equal(join.status, 200, 'mesh join still works');
    assert.equal(join.json.relay_available, false, 'join reports relay_available:false');
  } finally { stop(h); }
});

/* ---------------- functional: live against a mock Cloudflare ------- */

function startMockCf() {
  const calls = [];
  let n = 0;
  const srv = http.createServer((rq, rs) => {
    let body = '';
    rq.on('data', (d) => { body += d; });
    rq.on('end', () => {
      let json = null;
      try { json = JSON.parse(body); } catch (_) { /* empty */ }
      calls.push({ method: rq.method, url: rq.url, auth: rq.headers.authorization, json });
      rs.setHeader('content-type', 'application/json');
      if (rq.method === 'POST' && rq.url.endsWith('/sessions/new')) {
        n += 1;
        return rs.end(JSON.stringify({ sessionId: 'cf-sess-' + n }));
      }
      if (rq.method === 'POST' && rq.url.includes('/tracks/new')) {
        if (json && json.sessionDescription) {
          return rs.end(JSON.stringify({
            sessionDescription: { type: 'answer', sdp: 'mock-answer-sdp' },
            tracks: (json.tracks || []).map((t) => ({ location: 'local', mid: t.mid, trackName: t.trackName })),
          }));
        }
        return rs.end(JSON.stringify({
          sessionDescription: { type: 'offer', sdp: 'mock-offer-sdp' },
          requiresImmediateRenegotiation: true,
          tracks: (json.tracks || []).map((t, i) => ({ location: 'remote', mid: String(i), trackName: t.trackName, sessionId: t.sessionId })),
        }));
      }
      if (rq.method === 'PUT' && (rq.url.includes('/renegotiate') || rq.url.includes('/tracks/close')))
        return rs.end('{}');
      rs.statusCode = 404;
      rs.end('{}');
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1',
    () => resolve({ srv, calls, port: srv.address().port })));
}

test('relay: configured flow — publish, subscribe, renegotiate, battle auth, private refusal', { timeout: 180000 }, async () => {
  const mock = await startMockCf();
  const dir = makeCopy('relaylive');
  let h = null;
  try {
    h = await boot(dir, { SEED_DEMO: '1',
      CF_REALTIME_APP_ID: 'app-test', CF_REALTIME_APP_SECRET: 'secret-test',
      CF_REALTIME_API_BASE: `http://127.0.0.1:${mock.port}/v1` });
    const MGR = await mgrLogin(h.base);
    const W = await makeAccounts(h.base, MGR, 'rl');
    const started = await W.goLive(W.host);
    assert.equal(started.relay_enabled, true, 'start reports relay_enabled:true when configured');
    const sid = started.session_id;
    const offer = { type: 'offer', sdp: 'host-offer-sdp' };
    const pubTracks = [{ mid: '0', trackName: 'video' }, { mid: '1', trackName: 'audio' }];

    // No publication yet -> subscribe is a clean 409 (client meshes).
    const early = await req(h.base, 'POST', '/api/relay/subscribe', { token: W.fan.token, body: { session_id: sid } });
    assert.equal(early.status, 409); assert.equal(early.json.error, 'relay_unavailable');

    // Only the session's own model may publish; bodies are validated.
    const notMine = await req(h.base, 'POST', '/api/relay/publish', { token: W.guest.token,
      body: { session_id: sid, sessionDescription: offer, tracks: pubTracks } });
    assert.equal(notMine.status, 404, 'non-owner publish refused');
    const fanPub = await req(h.base, 'POST', '/api/relay/publish', { token: W.fan.token,
      body: { session_id: sid, sessionDescription: offer, tracks: pubTracks } });
    assert.equal(fanPub.status, 403, 'fan publish refused (model-only)');
    const badBody = await req(h.base, 'POST', '/api/relay/publish', { token: W.host.token,
      body: { session_id: sid, sessionDescription: offer, tracks: [] } });
    assert.equal(badBody.status, 400, 'empty track list refused');

    // Publish: our server brokers the offer to (mock) Cloudflare.
    const pub = await req(h.base, 'POST', '/api/relay/publish', { token: W.host.token,
      body: { session_id: sid, sessionDescription: offer, tracks: pubTracks } });
    assert.equal(pub.status, 200, `publish: ${pub.text}`);
    assert.equal(pub.json.sessionDescription.sdp, 'mock-answer-sdp', 'SFU answer handed back verbatim');
    const pubCf = pub.json.cf_session_id;
    assert.ok(pubCf, 'publication cf session id returned');
    const newCall = mock.calls.find((c) => c.url.endsWith('/sessions/new'));
    assert.equal(newCall.auth, 'Bearer secret-test', 'App Secret rides as Bearer to Cloudflare');
    assert.ok(newCall.url.startsWith('/v1/apps/app-test/'), 'app id in the CF path');
    const pubCall = mock.calls.find((c) => c.url.includes('/tracks/new') && c.json && c.json.sessionDescription);
    assert.equal(pubCall.json.sessionDescription.sdp, 'host-offer-sdp');
    assert.deepEqual(pubCall.json.tracks[0], { location: 'local', mid: '0', trackName: 'video' });

    // Subscribe: fan pulls the publication; shape + CF request pinned.
    const sub = await req(h.base, 'POST', '/api/relay/subscribe', { token: W.fan.token, body: { session_id: sid } });
    assert.equal(sub.status, 200, `subscribe: ${sub.text}`);
    assert.equal(sub.json.sessionDescription.type, 'offer');
    assert.equal(sub.json.sessionDescription.sdp, 'mock-offer-sdp');
    assert.deepEqual(sub.json.tracks, [
      { mid: '0', trackName: 'video', kind: 'video' },
      { mid: '1', trackName: 'audio', kind: 'audio' },
    ]);
    const subCf = sub.json.cf_session_id;
    assert.notEqual(subCf, pubCf, 'subscriber gets his own CF session');
    const subCall = mock.calls.find((c) => c.url.includes('/tracks/new') && c.json && !c.json.sessionDescription);
    assert.deepEqual(subCall.json.tracks[0], { location: 'remote', sessionId: pubCf, trackName: 'video' },
      'remote tracks point at the publisher session');

    // Join after subscribing: allowed, and the surface flags relay.
    const join = await req(h.base, 'POST', `/api/live/${sid}/join`, { token: W.fan.token });
    assert.equal(join.status, 200);
    assert.equal(join.json.relay_available, true, 'join reports relay_available:true once published');

    // Renegotiate: owner only, body validated, answer brokered.
    const wrongFan = await req(h.base, 'POST', '/api/relay/renegotiate', { token: W.fan2.token,
      body: { cf_session_id: subCf, sessionDescription: { type: 'answer', sdp: 'x' } } });
    assert.equal(wrongFan.status, 403, 'a stranger cannot renegotiate someone else\'s subscription');
    const badRen = await req(h.base, 'POST', '/api/relay/renegotiate', { token: W.fan.token,
      body: { cf_session_id: subCf, sessionDescription: { type: 'offer', sdp: 'x' } } });
    assert.equal(badRen.status, 400, 'renegotiate requires an answer');
    const ren = await req(h.base, 'POST', '/api/relay/renegotiate', { token: W.fan.token,
      body: { cf_session_id: subCf, sessionDescription: { type: 'answer', sdp: 'fan-answer-sdp' } } });
    assert.equal(ren.status, 200, `renegotiate: ${ren.text}`);
    const renCall = mock.calls.find((c) => c.method === 'PUT' && c.url.includes('/renegotiate'));
    assert.ok(renCall.url.includes(`/sessions/${subCf}/`), 'renegotiate targets the subscriber session');
    assert.equal(renCall.json.sessionDescription.sdp, 'fan-answer-sdp');

    // Close: a non-owner close is a harmless no-op; the owner's ends it.
    const strayClose = await req(h.base, 'POST', '/api/relay/close', { token: W.fan2.token, body: { cf_session_id: subCf } });
    assert.equal(strayClose.status, 200);
    const ren2 = await req(h.base, 'POST', '/api/relay/renegotiate', { token: W.fan.token,
      body: { cf_session_id: subCf, sessionDescription: { type: 'answer', sdp: 'fan-answer-sdp' } } });
    assert.equal(ren2.status, 200, 'subscription survives a stranger\'s close');
    const ownClose = await req(h.base, 'POST', '/api/relay/close', { token: W.fan.token, body: { cf_session_id: subCf } });
    assert.equal(ownClose.status, 200);
    const ren3 = await req(h.base, 'POST', '/api/relay/renegotiate', { token: W.fan.token,
      body: { cf_session_id: subCf, sessionDescription: { type: 'answer', sdp: 'fan-answer-sdp' } } });
    assert.equal(ren3.status, 403, 'closed subscription can no longer renegotiate');

    /* Battles: per-side flags + battler-only cross-subscribe. */
    const gStarted = await W.goLive(W.guest);
    const gsid = gStarted.session_id;
    const db = new DatabaseSync(path.join(dir, 'wogent-chat.db'));
    db.exec('PRAGMA busy_timeout = 10000');
    const bid = Number(db.prepare(`INSERT INTO battles (kind, host_id, guest_id, status,
      host_session_id, guest_session_id, started_at, ends_at)
      VALUES ('invite', ?, ?, 'live', ?, ?, datetime('now'), datetime('now', '+1 hour'))`)
      .run(W.host.id, W.guest.id, sid, gsid).lastInsertRowid);
    db.close();
    const bGet = await req(h.base, 'GET', `/api/battles/${bid}`, { token: W.fan.token });
    assert.equal(bGet.status, 200, `battle get: ${bGet.text}`);
    assert.equal(bGet.json.battle.host_relay, true, 'host side published -> host_relay:true');
    assert.equal(bGet.json.battle.guest_relay, false, 'guest side unpublished -> guest_relay:false');
    const cross = await req(h.base, 'POST', '/api/relay/subscribe', { token: W.guest.token, body: { session_id: sid } });
    assert.equal(cross.status, 200, 'opposing battler may pull the host\'s stream');
    const selfSub = await req(h.base, 'POST', '/api/relay/subscribe', { token: W.host.token, body: { session_id: sid } });
    assert.equal(selfSub.status, 403, 'the host cannot subscribe to her own session');
    const strangerSub = await req(h.base, 'POST', '/api/relay/subscribe', { token: W.stranger.token, body: { session_id: sid } });
    assert.equal(strangerSub.status, 403, 'a non-battler model cannot subscribe');

    /* Ending the live retires the publication. */
    const end = await req(h.base, 'POST', `/api/live/${sid}/end`, { token: W.host.token });
    assert.equal(end.status, 200);
    const late = await req(h.base, 'POST', '/api/relay/subscribe', { token: W.fan2.token, body: { session_id: sid } });
    assert.equal(late.status, 404, 'no subscribing to an ended live');

    /* Private Rooms stay P2P: both relay doors refuse. */
    const ev = await req(h.base, 'POST', '/api/model/private-events', { token: W.stranger.token,
      body: { title: 'closed room', starts_at: new Date(Date.now() + 3600e3).toISOString(), seats: 5, seat_price_cents: 500 } });
    assert.equal(ev.status, 200, `event create: ${ev.text}`);
    const pStart = await req(h.base, 'POST', '/api/live/start', { token: W.stranger.token,
      body: { title: 'closed room', private_event_id: ev.json.event.id } });
    assert.equal(pStart.status, 200, `private start: ${pStart.text}`);
    assert.equal(pStart.json.relay_enabled, false, 'private start never advertises the relay');
    const pPub = await req(h.base, 'POST', '/api/relay/publish', { token: W.stranger.token,
      body: { session_id: pStart.json.session_id, sessionDescription: offer, tracks: pubTracks } });
    assert.equal(pPub.status, 403); assert.equal(pPub.json.error, 'relay_private_room');
    const pSub = await req(h.base, 'POST', '/api/relay/subscribe', { token: W.fan.token,
      body: { session_id: pStart.json.session_id } });
    assert.equal(pSub.status, 403); assert.equal(pSub.json.error, 'relay_private_room');
  } finally {
    stop(h);
    mock.srv.close();
  }
});
