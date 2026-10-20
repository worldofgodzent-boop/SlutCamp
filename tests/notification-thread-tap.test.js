'use strict';
/*
 * Notification thread tap (owner ruling, Oct 17 2026 — refinement of
 * the PR #31 tap fix): a model's test video showed message and
 * announcement bells landing her on the CHATS LIST, forcing a second
 * tap into the thread. Owner: "I want them to go straight to the
 * message when they click it. Make it simple and easy."
 *
 * Two halves:
 *  - Server (server.js): every admin-DM bell now carries the link
 *    '/#chat/<convId>' — the conversation the DM was just inserted
 *    into. Sites: the 5 one-time broadcasts (game_category,
 *    agreement_12, public_photo, notif_fix, preview_video), the 6
 *    per-model welcome-flow senders (welcome, guide, guide_video,
 *    home_screen_video, id_verify, affiliate_program), the admin→fan
 *    apology DM ('message') and the Manager admin→model message
 *    route ('message'). Every other bell (tip, facetime, live,
 *    stage_request, booking) keeps its existing link.
 *  - Client (public/js/app.js, inside vNotifications): routeNotifTap
 *    gains a FIRST link rule — '/#chat/<id>' opens THAT conversation
 *    via the new openNotifThread helper (fetch /conversations, find
 *    by id, show('chat', { conv })). Legacy bells already delivered
 *    with link '' get the same treatment: when the type belongs to
 *    the admin-DM family, the tap opens the ADMIN thread (the
 *    conversation whose other.role === 'admin') directly. Any miss —
 *    fetch failed, thread gone, no admin thread — lands on the
 *    role's chats list, exactly the PR #31 fallback.
 *
 * routeNotifTap stays synchronous and keeps its (n, ftById)
 * signature: it delegates to openNotifThread only when that helper
 * exists (the same typeof-guard style as rejoinLiveBroadcast), so
 * the PR #31 suite — which extracts the router WITHOUT the helper —
 * keeps passing unchanged.
 *
 * Layers, per suite convention:
 *  1. Logic tests: the REAL routeNotifTap + openNotifThread
 *     extracted from app.js and run in a vm against stubbed
 *     show/api/S. The router fires the helper without awaiting it,
 *     so tests settle a macrotask before asserting the final show.
 *  2. Source pins: all 15 server call sites carry the thread link
 *     (per-function statement extraction + an exact global count),
 *     and the client's /#chat/ rule sits before the generic
 *     chats-list fallback.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const REPO = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(REPO, 'public/js/app.js'), 'utf8');
const server = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');

/* ---------------- extraction helpers ---------------- */

function extractFn(src, name) {
  let start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  // Keep a leading 'async ' — openNotifThread is an async function
  // and its body is a syntax error without it.
  if (src.slice(start - 6, start) === 'async ') start -= 6;
  let depth = 0;
  let end = -1;
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (!depth) { end = j + 1; break; } }
  }
  assert.ok(end > start, `${name} braces must balance`);
  return src.slice(start, end);
}

// The notifyUser(...) statement inside a server function body: from
// the call to the first ');' after it (inner parens in these calls
// are always followed by ',', never ');').
function notifyStatement(body, from = 0) {
  const i = body.indexOf('notifyUser(', from);
  assert.ok(i >= 0, 'notifyUser call present');
  const end = body.indexOf(');', i);
  assert.ok(end > i, 'notifyUser statement terminates');
  return body.slice(i, end);
}

/* ---------------- logic: the real router + helper ---------------- */

const ADMIN_CONV = { id: 9, other: { id: 1, role: 'admin', display_name: 'Asce (Admin)' }, unread_count: 3 };
const FAN_CONV = { id: 5, other: { id: 31, role: 'fan', display_name: 'Some Fan' }, unread_count: 1 };
const MODEL_CONV = { id: 42, other: { id: 15, role: 'model', display_name: 'Bunny' }, unread_count: 0 };

// Build the router AND the thread opener in a fresh vm world. The
// stubbed api('/conversations') resolves with `convs`; apiFails
// makes it throw, like a dead network.
function makeWorld({ role, convs = [], apiFails = false }) {
  const calls = [];
  const ctx = {
    S: { user: role ? { role } : null },
    // Params are copied into THIS realm (JSON round-trip): the object
    // literals the router passes are vm-realm objects, whose
    // prototypes deepStrictEqual would reject despite equal content.
    show: (view, params) => calls.push(['show', view,
      params === undefined ? params : JSON.parse(JSON.stringify(params))]),
    showFtRequestCard: (fr) => calls.push(['ftCard', fr]),
    api: async (url) => {
      calls.push(['api', url]);
      if (apiFails) throw new Error('network down');
      return { status: 200, data: { conversations: convs } };
    },
  };
  vm.createContext(ctx);
  vm.runInContext(
    extractFn(app, 'openNotifThread') + '\n' +
    extractFn(app, 'routeNotifTap') + '\n;globalThis.__route = routeNotifTap;', ctx);
  return { route: ctx.__route, calls };
}
const bell = (over) => Object.assign(
  { id: 1, type: 'message', title: 'x', body: '', link: '', read: false }, over);
// The router delegates without awaiting; one macrotask flushes the
// helper's fetch + show. Two for safety against engine scheduling.
const settle = async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};
const shows = (calls) => calls.filter((c) => c[0] === 'show');

test('thread: /#chat/<id> opens exactly that conversation', async () => {
  const w = makeWorld({ role: 'model', convs: [FAN_CONV, MODEL_CONV, ADMIN_CONV] });
  assert.equal(w.route(bell({ link: '/#chat/42', type: 'message' }), {}), true);
  await settle();
  assert.deepEqual(w.calls[0], ['api', '/conversations']);
  assert.deepEqual(shows(w.calls), [['show', 'chat', { conv: MODEL_CONV }]]);
});

test('thread: /#chat/<id> with an unknown id falls back to the chats list', async () => {
  const model = makeWorld({ role: 'model', convs: [FAN_CONV, ADMIN_CONV] });
  assert.equal(model.route(bell({ link: '/#chat/999', type: 'message' }), {}), true);
  await settle();
  assert.deepEqual(shows(model.calls), [['show', 'modelChats', {}]]);
  const fan = makeWorld({ role: 'fan', convs: [MODEL_CONV] });
  assert.equal(fan.route(bell({ link: '/#chat/999', type: 'message' }), {}), true);
  await settle();
  assert.deepEqual(shows(fan.calls), [['show', 'fanChats', {}]]);
});

test('thread: /#chat/<id> with a failed fetch falls back to the chats list', async () => {
  const w = makeWorld({ role: 'model', apiFails: true });
  assert.equal(w.route(bell({ link: '/#chat/42', type: 'public_photo' }), {}), true);
  await settle();
  assert.deepEqual(shows(w.calls), [['show', 'modelChats', {}]]);
});

test('legacy: \'\' + public_photo opens the admin thread, not the list', async () => {
  // The admin thread is NOT first in the list — it must be found by
  // other.role === 'admin', not by position.
  const w = makeWorld({ role: 'model', convs: [FAN_CONV, ADMIN_CONV] });
  assert.equal(w.route(bell({ link: '', type: 'public_photo' }), {}), true);
  await settle();
  assert.deepEqual(shows(w.calls), [['show', 'chat', { conv: ADMIN_CONV }]]);
});

test('legacy: \'\' + message opens the admin thread for fans too', async () => {
  // The fan apology DM case: admin sits in the model seat, so the
  // fan's admin thread is other.role === 'admin' as well.
  const w = makeWorld({ role: 'fan', convs: [MODEL_CONV, ADMIN_CONV] });
  assert.equal(w.route(bell({ link: '', type: 'message' }), {}), true);
  await settle();
  assert.deepEqual(shows(w.calls), [['show', 'chat', { conv: ADMIN_CONV }]]);
});

test('legacy: every admin-DM family type opens the admin thread', async () => {
  for (const type of ['welcome', 'guide', 'guide_video', 'home_screen_video',
    'id_verify', 'affiliate_program', 'game_category', 'agreement_12',
    'notif_fix', 'preview_video']) {
    const w = makeWorld({ role: 'model', convs: [ADMIN_CONV] });
    assert.equal(w.route(bell({ link: '', type }), {}), true, type);
    await settle();
    assert.deepEqual(shows(w.calls), [['show', 'chat', { conv: ADMIN_CONV }]], type);
  }
});

test('legacy: \'\' + unknown type stays on the chats list and never fetches', async () => {
  const w = makeWorld({ role: 'model', convs: [ADMIN_CONV] });
  assert.equal(w.route(bell({ link: '', type: 'mystery' }), {}), true);
  await settle();
  assert.deepEqual(w.calls, [['show', 'modelChats', {}]]);
});

test('legacy: admin-DM bell with NO admin thread falls back to the chats list', async () => {
  const w = makeWorld({ role: 'model', convs: [FAN_CONV, MODEL_CONV] });
  assert.equal(w.route(bell({ link: '', type: 'notif_fix' }), {}), true);
  await settle();
  assert.deepEqual(shows(w.calls), [['show', 'modelChats', {}]]);
});

test('legacy: admin-DM bell with a failed fetch falls back to the chats list', async () => {
  const w = makeWorld({ role: 'fan', apiFails: true });
  assert.equal(w.route(bell({ link: '', type: 'welcome' }), {}), true);
  await settle();
  assert.deepEqual(shows(w.calls), [['show', 'fanChats', {}]]);
});

test('regression: \'/#chat\' with no id and other links never fetch', async () => {
  const w = makeWorld({ role: 'fan', convs: [ADMIN_CONV] });
  assert.equal(w.route(bell({ link: '/#chat', type: 'message' }), {}), true);
  assert.equal(w.route(bell({ link: '/#bookings', type: 'booking' }), {}), true);
  await settle();
  assert.deepEqual(w.calls, [['show', 'fanChats', {}], ['show', 'bookings', {}]]);
});

/* ---------------- source pins: server ---------------- */

const ADMIN_DM_FNS = [
  'sendModelWelcome', 'sendModelGuide', 'sendModelGuideVideo',
  'sendModelHomeScreenVideo', 'sendModelIdVerify', 'sendModelAffiliate',
  'announceGameCategoryToModels', 'announceAgreement12ToModels',
  'announcePublicPhotoToModels', 'announceNotifFixToModels',
  'announcePreviewVideoToModels', 'announceThreadTapToModels',
  'announceLanguagesToModels', 'announceRoleSigninToModels', 'sendAdminApologyDm',
];

test('pin: every admin-DM sender/broadcast bell carries its thread link', () => {
  for (const fn of ADMIN_DM_FNS) {
    const stmt = notifyStatement(extractFn(server, fn));
    assert.ok(stmt.includes('`/#chat/${conv.id}`'), `${fn} bell must link to its thread`);
    assert.ok(!stmt.endsWith(", ''"), `${fn} bell must not keep the empty link`);
  }
});

test('pin: the Manager admin→model message bell carries its thread link', () => {
  const start = server.indexOf("app.post('/api/admin/models/:id/message'");
  assert.ok(start >= 0, 'admin→model message route located');
  const stmt = notifyStatement(server.slice(start, start + 1600));
  assert.ok(stmt.startsWith("notifyUser(m.id, 'message'"), 'route bell is the model message bell');
  assert.ok(stmt.includes('`/#chat/${conv.id}`'), 'route bell must link to its thread');
});

test('pin: exactly 25 thread links exist server-side — no more, no fewer', () => {
  // 17 named functions + the Manager route. (The thread-tap broadcast
  // joined the list when it shipped — its bell demonstrates the
  // feature; the 13-languages broadcast joined later the same day;
  // the profile-media broadcast joined with the 10-pictures + two-
  // videos profile expansion; the role-sign-in broadcast joined
  // with the "Sign in as a model" front-door buttons; the one-account
  // broadcast joined with the Model/Affiliate one-login update; the
  // notices-thread launch announcement joined when SlutCamp
  // announcements got their own pinned inbox; the chat-retention
  // broadcast joined when chats began auto-cleaning after 7 days;
  // the booking-rate broadcast joined with the dedicated 1-on-1
  // booking rate; the agreement-v1.5 broadcast joined when the
  // Model Agreement gained its §15 clause; the storefront broadcast
  // joined when the fan home gained section tabs — it follows the
  // retention/agreement shape (officialThreadFor + conv.id bell),
  // unlike the older fan blasts, whose bells link through a per-fan
  // `thr` variable instead and are not part of this count; the
  // rank-congrats bell joined with the per-section ranking ladders —
  // its bell links the model to her official Notices thread, the
  // sanctioned pattern; the faceguard broadcast joined with the
  // Phase 4 face-count guard announcement — its bell links each
  // model to her official Notices thread, the same sanctioned
  // pattern.) Any other bell gaining a '/#chat/' link
  // (or one of the 25 losing it) trips this count.
  assert.equal(server.split('/#chat/${conv.id}').length - 1, 25);
});

test('pin: non-DM bells keep their links (tip/facetime/live/booking untouched)', () => {
  assert.ok(server.includes("notifyUser(modelId, 'tip'"), 'tip bell present');
  assert.ok(server.includes("'facetime', srv('bell_ft_turn_title'"), 'facetime bells present (copy via SRV since the 13-language expansion)');
  assert.ok(server.includes("'booking', srv('bell_booking_fan_active_title', userLang(b.fan_id)), copy, '/#bookings'"),
    'booking bell keeps its /#bookings link');
});

/* ---------------- source pins: client ---------------- */

test('pin: the /#chat/ rule is the FIRST link rule, before the chats fallback', () => {
  const route = extractFn(app, 'routeNotifTap');
  const chatAt = route.indexOf('#chat\\/');
  assert.ok(chatAt >= 0, 'routeNotifTap matches /#chat/<id> links');
  assert.ok(chatAt < route.indexOf('#ft\\/'), '/#chat/ rule precedes the FaceTime link rule');
  const fallbackAt = route.indexOf("show(role === 'model' ? 'modelChats' : 'fanChats', {})");
  assert.ok(fallbackAt > chatAt, '/#chat/ rule precedes the generic chats-list fallback');
  assert.ok(route.includes("typeof openNotifThread === 'function'"),
    'delegation is typeof-guarded (PR #31 extraction keeps passing)');
});

test('pin: the legacy rule covers the whole admin-DM family', () => {
  const route = extractFn(app, 'routeNotifTap');
  assert.ok(route.includes('ADMIN_DM_TYPES'), 'legacy type list present');
  for (const type of ['message', 'welcome', 'guide', 'guide_video',
    'home_screen_video', 'id_verify', 'affiliate_program', 'game_category',
    'agreement_12', 'public_photo', 'notif_fix', 'preview_video']) {
    assert.ok(route.includes(`'${type}'`), `legacy list includes ${type}`);
  }
  assert.ok(route.includes('openNotifThread(0, role)'),
    'legacy bells open the admin thread (convId 0)');
});

test('pin: openNotifThread fetches conversations and finds by id / admin role', () => {
  const helper = extractFn(app, 'openNotifThread');
  assert.ok(helper.includes("api('/conversations')"), 'helper fetches the conversation list');
  assert.ok(helper.includes('c.id === convId'), 'helper finds the named thread by id');
  assert.ok(helper.includes("c.other.role === 'admin'"), 'helper finds the admin thread by role');
  assert.ok(helper.includes("show('chat', { conv })"), 'helper opens the thread view');
  assert.ok(helper.includes('modelChats') && helper.includes('fanChats'),
    'helper falls back to the role chats list');
});
