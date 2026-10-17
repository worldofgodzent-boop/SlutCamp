'use strict';
/*
 * Notification tap routing (owner bug report, Oct 17 2026): a model
 * opened her 🔔 Notifications and tapped a bell (e.g. the public-photo
 * announcement) — nothing opened; the list just flickered. Root cause:
 * the [data-notif] handler in vNotifications marked the bell read and
 * then, for every link except a fan's '/#live', called
 * show('notifications', {}) — re-rendering the very screen she was on.
 * Server-side most bells carry link '' (every admin announcement +
 * 'message' bells), so nearly every tap was a no-op re-render.
 *
 * The fix is client-only (public/js/app.js, inside vNotifications): a
 * routeNotifTap(n, ftById) router looks the bell up in the in-scope
 * notifs array and routes by link, then type:
 *   /#ft/<id> (or #ft/<id>) with a live request → showFtRequestCard
 *   /#bookings                                  → bookings
 *   /#live                                      → fan: fanLive, model: lives
 *   /live/<id> (stage_request, her OWN session) → rejoinLiveBroadcast(id)
 *   type 'tip' (link null)                      → model: modelEarnings
 *   everything else ('', null, '/#chat', other) → modelChats / fanChats
 * After markRead the handler NEVER re-renders the notifications list;
 * the defensive no-navigation fallback settles the tapped row's read
 * state in place (drop .unread + the dot) instead.
 *
 * Two layers, per suite convention:
 *  1. Logic tests: the REAL routeNotifTap extracted from app.js and run
 *     in a vm against stubbed show/showFtRequestCard/rejoin/S.
 *  2. Source pins: the tap handler carries no show('notifications')
 *     fallthrough, the in-place fallback exists, markRead is intact,
 *     and the protected neighbours (FaceTime Accept/Decline, ft-open,
 *     Mark-all-read) still re-render exactly as before.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const REPO = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(REPO, 'public/js/app.js'), 'utf8');

// vNotifications only (bounded by the follow/unfollow section after it).
const vStart = app.indexOf('async function vNotifications()');
const vEnd = app.indexOf('// Fan: follow/unfollow a model', vStart);
assert.ok(vStart !== -1 && vEnd > vStart, 'vNotifications located in app.js');
const vNotif = app.slice(vStart, vEnd);
// The [data-notif] tap wiring only (bounded by the Box actions comment).
const tapStart = vNotif.indexOf("app.querySelectorAll('[data-notif]')");
const tapEnd = vNotif.indexOf('// Box actions', tapStart);
assert.ok(tapStart !== -1 && tapEnd > tapStart, 'tap handler located');
const tapBlock = vNotif.slice(tapStart, tapEnd);

/* ---------------- logic: the real router, extracted ---------------- */

function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  let depth = 0;
  let end = -1;
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (!depth) { end = j + 1; break; } }
  }
  assert.ok(end > start, `${name} braces must balance`);
  return src.slice(start, end);
}

// Build the router in a fresh vm world. `role` becomes S.user.role;
// `withRejoin:false` leaves rejoinLiveBroadcast undefined, exactly the
// degraded case the router must survive. Returns { route, calls }.
function makeRouter({ role, withRejoin = true }) {
  const calls = [];
  const ctx = {
    S: { user: role ? { role } : null },
    show: (view) => calls.push(['show', view]),
    showFtRequestCard: (fr) => calls.push(['ftCard', fr]),
  };
  if (withRejoin) ctx.rejoinLiveBroadcast = (id) => calls.push(['rejoin', id]);
  vm.createContext(ctx);
  vm.runInContext(extractFn(app, 'routeNotifTap') + '\n;globalThis.__route = routeNotifTap;', ctx);
  return { route: ctx.__route, calls };
}
const bell = (over) => Object.assign(
  { id: 1, type: 'message', title: 'x', body: '', link: '', read: false }, over);

test('routing: /#live still routes fans to fanLive, models to lives', () => {
  const fan = makeRouter({ role: 'fan' });
  assert.equal(fan.route(bell({ link: '/#live', type: 'live' }), {}), true);
  assert.deepEqual(fan.calls, [['show', 'fanLive']]);
  const model = makeRouter({ role: 'model' });
  assert.equal(model.route(bell({ link: '/#live', type: 'live' }), {}), true);
  assert.deepEqual(model.calls, [['show', 'lives']]);
});

test('routing: /#bookings routes to the bookings screen', () => {
  const model = makeRouter({ role: 'model' });
  assert.equal(model.route(bell({ link: '/#bookings', type: 'booking' }), {}), true);
  assert.deepEqual(model.calls, [['show', 'bookings']]);
  const fan = makeRouter({ role: 'fan' });
  assert.equal(fan.route(bell({ link: '/#bookings', type: 'booking' }), {}), true);
  assert.deepEqual(fan.calls, [['show', 'bookings']]);
});

test("routing: '' and '/#chat' land on the role's chats list", () => {
  const model = makeRouter({ role: 'model' });
  assert.equal(model.route(bell({ link: '', type: 'message' }), {}), true);
  assert.deepEqual(model.calls, [['show', 'modelChats']]);
  const fan = makeRouter({ role: 'fan' });
  assert.equal(fan.route(bell({ link: '/#chat', type: 'message' }), {}), true);
  assert.deepEqual(fan.calls, [['show', 'fanChats']]);
});

test('routing: admin announcement bells (link \'\') open the model chats', () => {
  // The exact reported case: the "📸 NEW UPDATE: You're live on
  // Google!" bell is a public_photo announcement with link ''.
  for (const type of ['welcome', 'guide', 'game_category', 'agreement_12', 'public_photo', 'id_verify', 'affiliate_program']) {
    const model = makeRouter({ role: 'model' });
    assert.equal(model.route(bell({ link: '', type }), {}), true, type);
    assert.deepEqual(model.calls, [['show', 'modelChats']], type);
  }
  // Any non-model/fan role falls to fanChats per the routing table.
  const rec = makeRouter({ role: 'recruiter' });
  assert.equal(rec.route(bell({ link: '', type: 'welcome' }), {}), true);
  assert.deepEqual(rec.calls, [['show', 'fanChats']]);
});

test("routing: 'tip' bells (link null) open model earnings; fans go to chats", () => {
  const model = makeRouter({ role: 'model' });
  assert.equal(model.route(bell({ link: null, type: 'tip' }), {}), true);
  assert.deepEqual(model.calls, [['show', 'modelEarnings']]);
  const fan = makeRouter({ role: 'fan' });
  assert.equal(fan.route(bell({ link: null, type: 'tip' }), {}), true);
  assert.deepEqual(fan.calls, [['show', 'fanChats']]);
});

test('routing: FaceTime bells open the live request card when it is still live', () => {
  const fr = { id: 7, status: 'queued' };
  const model = makeRouter({ role: 'model' });
  assert.equal(model.route(bell({ link: '/#ft/7', type: 'facetime' }), { 7: fr }), true);
  assert.deepEqual(model.calls, [['ftCard', fr]]);
  // Same for the slash-less spelling.
  const model2 = makeRouter({ role: 'model' });
  assert.equal(model2.route(bell({ link: '#ft/7', type: 'facetime' }), { 7: fr }), true);
  assert.deepEqual(model2.calls, [['ftCard', fr]]);
  // Request no longer live (finished/cancelled) → falls to chats.
  const stale = makeRouter({ role: 'model' });
  assert.equal(stale.route(bell({ link: '/#ft/7', type: 'facetime' }), {}), true);
  assert.deepEqual(stale.calls, [['show', 'modelChats']]);
});

test("routing: '/live/<id>' stage requests rejoin the model's own broadcast", () => {
  const model = makeRouter({ role: 'model' });
  assert.equal(model.route(bell({ link: '/live/42', type: 'stage_request' }), {}), true);
  assert.deepEqual(model.calls, [['rejoin', 42]]);
  // Without rejoinLiveBroadcast available, the model lands on her
  // chats (where the Back-to-Live affordance lives) — never a dead tap.
  const degraded = makeRouter({ role: 'model', withRejoin: false });
  assert.equal(degraded.route(bell({ link: '/live/42', type: 'stage_request' }), {}), true);
  assert.deepEqual(degraded.calls, [['show', 'modelChats']]);
});

test('routing: unknown links fall back to the role chats list', () => {
  const fan = makeRouter({ role: 'fan' });
  assert.equal(fan.route(bell({ link: '/#mystery', type: 'whatever' }), {}), true);
  assert.deepEqual(fan.calls, [['show', 'fanChats']]);
});

/* ---------------- source pins ---------------- */

test("pin: the tap handler never falls through to show('notifications', {})", () => {
  assert.ok(!tapBlock.includes("show('notifications'"),
    'tapping a bell must not re-render the notifications list (the glitch)');
  assert.ok(tapBlock.includes('routeNotifTap(n, ftById)'),
    'the tap routes through routeNotifTap with the looked-up bell');
  assert.ok(tapBlock.includes('notifs.find('),
    'the bell object is looked up from the in-scope notifs array by id');
});

test('pin: the no-navigation fallback updates the row in place', () => {
  assert.ok(tapBlock.includes("classList.remove('unread')"),
    'fallback removes the unread class from the tapped row');
  assert.ok(tapBlock.includes("querySelector('.unread-dot')"),
    'fallback looks for the row\'s unread dot');
  assert.ok(tapBlock.includes('dot.remove()'),
    'fallback removes the unread dot element');
});

test('pin: markRead behaviour is unchanged (POST ids + badge refresh)', () => {
  assert.ok(vNotif.includes("await api('/notifications/read', { method: 'POST',"),
    'markRead still POSTs to /notifications/read');
  assert.ok(vNotif.includes('body: JSON.stringify({ ids: [parseInt(btn.dataset.notif)] })'),
    'markRead still sends the tapped bell id');
  assert.ok(tapBlock.includes('await markRead(b);'), 'tap still marks read first');
  assert.ok(vNotif.includes('refreshNotifBadge();'), 'badge refresh still wired');
});

test('pin: protected neighbours untouched — read-all + FaceTime actions still re-render', () => {
  // Exactly three show('notifications', {}) remain in vNotifications:
  // Mark-all-read, FaceTime Accept, FaceTime Decline. The ft-open row
  // still opens the request card. Nothing else may re-render the list.
  const renders = vNotif.split("show('notifications', {})").length - 1;
  assert.equal(renders, 3, 'only read-all / ft-accept / ft-decline re-render');
  assert.ok(vNotif.includes("app.querySelectorAll('[data-ft-acc]')"), 'ft accept handler present');
  assert.ok(vNotif.includes("app.querySelectorAll('[data-ft-dec]')"), 'ft decline handler present');
  assert.ok(vNotif.includes("app.querySelectorAll('[data-ft-open]')"), 'ft open handler present');
  assert.ok(vNotif.includes('if (fr) showFtRequestCard(fr);'), 'ft open still opens the card');
  assert.ok(vNotif.includes("$('#notif-read-all').onclick"), 'mark-all-read handler present');
});
