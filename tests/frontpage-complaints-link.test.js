'use strict';
/*
 * Front-page + profile-peek complaints links (owner, 2026-10-27).
 *
 * The CCBill fix package (PR #111) put the Complaints & Content
 * Removal policy link in the public footer, the Terms link row and
 * the Settings legal card — but NOT at the bottom of the app's own
 * front page, which is where the owner looked for it. This follow-up
 * adds the SAME small link across the in-app content surfaces, in
 * the owner's priority order:
 *
 *   1. the fan "Models" home screen (vFanModels) — below the tile
 *      grid + Prev/Next pagination, at the foot of the view;
 *   2. the model profile peek (openModelPeek) — at the very bottom
 *      of the peek's scrollable content, after the Close row, above
 *      the pinned Message bar;
 *   3. her clean profile — SHARED RENDERER, no separate link: her
 *      clean feed renders inside the peek (#peek-feed, from the same
 *      public endpoint her public page uses), so the peek's bottom
 *      link covers it; her public web page already carries the
 *      server footer link (PR #111);
 *   4. the chat screen (vChat) — a labeled link row in the chat
 *      FOOTER, directly above the message composer (owner
 *      correction, Oct 27 2026: "chat footer" in so many words —
 *      the first pass put an ⚖️ icon button in the chat header;
 *      an icon alone is not findable enough, so it was REPLACED,
 *      not supplemented);
 *   5. the live room (vLiveWatch) — a small link in the live
 *      controls row beside Leave stream; this renderer ALSO carries
 *      private-room viewing (watchLive), and the private-room page
 *      (vPrivateEvent) gets the same bottom link row;
 *   6. the 1-on-1 video call (#active-call) — the link is injected
 *      into the call HUD (static HTML in index.html) on the
 *      syncExplicitBtn pattern, refreshed from updateCallHUD;
 *   7. the random video call — the PumPum Verse battle stage
 *      (vBattleStage, home of 🎲 Random matchmaking): a link row at
 *      the foot of the stage, above Leave;
 *   8. the model's own broadcast room (vLiveBroadcast) — the same
 *      labeled link in the broadcast controls, under the Pause/End
 *      row (this renderer had no link in the first pass).
 *
 * On the session surfaces (live, broadcast, battle, call) a tap
 * leaves through that surface's normal cleanup first (endLiveView /
 * battleClientTeardown / hangupCall) — the policy page lives in the
 * app underneath those layers, and no session or billing timer is
 * ever stranded behind it.
 *
 * Both reuse the EXISTING i18n key 'complaints_label' (no new keys)
 * and open the existing complaints view via show('complaints', {}),
 * the wiring the Terms screen (#t-complaints) already uses. Scope
 * pins below also assert the link did NOT spread: the guest landing
 * (vLanding, which shares homeTilesHTML with the fan home) carries
 * no copy of it.
 *
 * Static source pins only — the change is client markup + wiring;
 * the full gate is run separately on the restart-proof runner.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_JS = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');

/* Slice of APP_JS between two top-level markers (no brace matching —
 * these renderers are full of nested template literals). */
function fnSpan(startMarker, endMarker) {
  const a = APP_JS.indexOf(startMarker);
  assert.ok(a >= 0, `start marker present: ${startMarker}`);
  const b = APP_JS.indexOf(endMarker, a + startMarker.length);
  assert.ok(b > a, `end marker present after start: ${endMarker}`);
  return APP_JS.slice(a, b);
}

const HOME = fnSpan('async function vFanModels()', '\nfunction playlistOrder(');
const LANDING = fnSpan('async function vLanding()', '\nfunction vSectionGate(');
const PEEK = fnSpan('function openModelPeek(m, models)', '\nasync function vFanModels()');
const CHAT = fnSpan('async function vChat(params)', '\nfunction openFaceTimeSheet()');
const LIVE = fnSpan('function vLiveWatch()', '\nfunction endLiveView(');
const BROADCAST = fnSpan('function vLiveBroadcast()', '\nfunction startMicMeter(');
const PRIV = fnSpan('async function vPrivateEvent({ id })', '\nasync function vAffiliateAgreement(');
const BATTLE = fnSpan('async function vBattleStage(params)', '\nasync function openBattleTipSheet(');
const CALLHUD = fnSpan('function updateCallHUD()', '\nfunction updateJoinCountdown()');

/* ---------------- the shared label: existing key, all 13 languages ---------------- */

test('label: complaints_label resolves in all 13 languages (existing key, no new keys)', () => {
  const lines = APP_JS.split('\n').filter((l) => /^\s+complaints_label: '/.test(l));
  assert.equal(lines.length, 13, 'complaints_label present exactly once per language (13)');
  for (const l of lines) {
    const v = l.replace(/^\s+complaints_label: '/, '').replace(/',$/, '');
    assert.ok(v.length > 0, `non-empty label: ${l.trim()}`);
  }
  const en = lines.find((l) => l.includes("'Complaints & Content Removal'"));
  assert.ok(en, 'EN label is the policy title');
});

/* ---------------- placement 1: the fan Models home screen ---------------- */

test('home: vFanModels renders the complaints link from the shared label key', () => {
  assert.ok(HOME.includes('id="home-complaints"'), 'home link carries id home-complaints');
  assert.ok(
    HOME.includes(`<a href="javascript:void(0)" id="home-complaints" style="color:var(--pink)">\${t('complaints_label')}</a>`),
    'home link label resolves from t(\'complaints_label\') — no hardcoded text, no new key',
  );
});

test('home: the link sits BELOW the tile grid + pagination block', () => {
  const tiles = HOME.indexOf('homeTilesHTML(shown, heartFor');
  const link = HOME.indexOf('id="home-complaints"');
  assert.ok(tiles >= 0, 'home view renders homeTilesHTML (grid + pager)');
  assert.ok(link > tiles, 'link row is emitted after the grid/pagination block, at the foot of the view');
});

test('home: the link is wired to the complaints view like the Terms row', () => {
  assert.ok(HOME.includes("$('#home-complaints')"), 'home wiring looks the link up by id');
  assert.ok(
    /hcp\.onclick = \(\) => show\('complaints', \{\}\);/.test(HOME),
    'tap opens show(\'complaints\', {}) — the #t-complaints pattern',
  );
});

test('home: scoped — the guest landing (which shares homeTilesHTML) has no copy', () => {
  assert.ok(!LANDING.includes('home-complaints'), 'landing markup has no home-complaints link');
  assert.ok(!LANDING.includes("show('complaints'"), 'landing has no complaints wiring');
});

/* ---------------- placement 2: the model profile peek ---------------- */

test('peek: the sheet renders the complaints link from the shared label key', () => {
  assert.ok(PEEK.includes('data-peek-complaints'), 'peek link carries data-peek-complaints');
  assert.ok(
    PEEK.includes(`<a href="javascript:void(0)" data-peek-complaints style="color:var(--pink)">\${t('complaints_label')}</a>`),
    'peek link label resolves from t(\'complaints_label\') — no hardcoded text, no new key',
  );
});

test('peek: the link sits after the Close row, inside the scroll content, above the pinned Message bar', () => {
  const close = PEEK.indexOf('>Close</button>');
  const link = PEEK.indexOf('data-peek-complaints');
  const scrollEnd = PEEK.indexOf('</div>', link);
  const msgbar = PEEK.indexOf('class="peek-msgbar"');
  assert.ok(close >= 0, 'peek has its Close row');
  assert.ok(link > close, 'link is after the Close row — the very bottom of the content');
  assert.ok(msgbar > link, 'link renders before (above) the pinned Message bar markup');
  assert.ok(scrollEnd > link && scrollEnd < msgbar, 'link is inside .peek-scroll, which closes before the Message bar');
});

test('peek: the link closes the sheet and opens the complaints view', () => {
  assert.ok(PEEK.includes("sheet.querySelector('[data-peek-complaints]')"), 'peek wiring looks the link up in the sheet');
  assert.ok(
    /cpLink\.onclick = \(\) => \{\s*sheet\.remove\(\);\s*show\('complaints', \{\}\);\s*\};/.test(PEEK),
    'tap removes the sheet, then show(\'complaints\', {}) — like every other peek navigation',
  );
});

/* ---------------- surface 3: her clean profile (shared renderer = the peek) ---------------- */

test('clean profile: her clean feed renders INSIDE the peek, above its bottom link', () => {
  // There is no standalone in-app clean-profile view: loadPeekFeed
  // fills #peek-feed in the peek sheet from the same public endpoint
  // her public page renders from. The peek's bottom complaints link
  // (pinned above) is therefore this surface's link — no duplicate.
  assert.ok(APP_JS.includes('async function loadPeekFeed(m)'), 'the clean feed loader exists');
  assert.ok(APP_JS.includes('api(`/models/${m.id}/feed`)'), 'it reads the public clean-feed endpoint');
  const feedBox = PEEK.indexOf('id="peek-feed"');
  const link = PEEK.indexOf('data-peek-complaints');
  assert.ok(feedBox >= 0, 'the peek sheet carries the clean-feed container');
  assert.ok(link > feedBox, 'the peek bottom link sits below the clean-feed section in the same scroll');
});

/* ---------------- surface 4: the chat screen ---------------- */

test('chat: the footer carries the labeled complaints link row, directly above the composer', () => {
  assert.ok(
    CHAT.includes(`<a href="javascript:void(0)" id="chat-complaints" style="color:var(--pink)">\${t('complaints_label')}</a>`),
    'chat link label resolves from t(\'complaints_label\') — no hardcoded text, no new key',
  );
  const footer = CHAT.indexOf('class="chat-footer"');
  const link = CHAT.indexOf('id="chat-complaints"');
  const composer = CHAT.indexOf('class="chat-input-bar"');
  assert.ok(footer >= 0 && link > footer, 'the link row is inside the chat footer');
  assert.ok(composer > link, 'the link row sits directly above the message composer (.chat-input-bar)');
});

test('chat: the header icon button is GONE — replaced, not supplemented', () => {
  assert.ok(!CHAT.includes('c-complaints'), 'no #c-complaints anywhere in vChat — neither markup nor wiring');
  assert.ok(!CHAT.includes('⚖️</button>'), 'the icon-only header button was removed');
});

test('chat: the footer link is wired to the complaints view', () => {
  assert.ok(CHAT.includes("const ccp = $('#chat-complaints');"), 'chat wiring looks the link up by id');
  assert.ok(
    /ccp\.onclick = \(\) => show\('complaints', \{\}\);/.test(CHAT),
    'tap opens show(\'complaints\', {}) — the same wiring as every other surface',
  );
});

/* ---------------- surface 5: the live room (+ private room) ---------------- */

test('live: the live controls carry the complaints link beside Leave stream', () => {
  assert.ok(
    LIVE.includes(`<a href="javascript:void(0)" id="live-complaints" class="small" style="color:var(--pink);margin-left:12px">\${t('complaints_label')}</a>`),
    'live link label resolves from t(\'complaints_label\') — no hardcoded text, no new key',
  );
  const controls = LIVE.indexOf('class="live-controls"');
  const leave = LIVE.indexOf('id="live-leave-btn"');
  const link = LIVE.indexOf('id="live-complaints"');
  assert.ok(controls >= 0 && leave > controls, 'live controls row located');
  assert.ok(link > leave, 'link sits in the controls row, beside Leave stream');
});

test('live: the link leaves through the normal cleanup, then opens the policy', () => {
  assert.ok(
    LIVE.includes("lcp.onclick = () => { endLiveView(); show('complaints', {}); };"),
    'tap runs endLiveView() first — no live session or timer stranded — then show(\'complaints\', {})',
  );
});

test('private room: viewing shares the live renderer, and the room page carries the link too', () => {
  // Joining a private room routes into watchLive (the liveWatch
  // renderer pinned above) — the in-room placement is shared, not
  // duplicated. The room's own page gets the standard bottom row.
  assert.ok(APP_JS.includes("$('#pr-join').onclick = () => watchLive(ev.session_id);"),
    'private-room viewing enters the liveWatch renderer (shared placement)');
  assert.ok(
    PRIV.includes(`<a href="javascript:void(0)" id="pr-complaints" style="color:var(--pink)">\${t('complaints_label')}</a>`),
    'private-room page link resolves from t(\'complaints_label\')',
  );
  assert.ok(
    PRIV.includes("$('#pr-complaints').onclick = () => show('complaints', {});"),
    'private-room page link opens show(\'complaints\', {})',
  );
  const back = PRIV.indexOf('id="pr-back"');
  const link = PRIV.indexOf('id="pr-complaints"');
  assert.ok(back >= 0 && link > back, 'page link sits at the foot of the page, after the back row');
});

/* ---------------- surface 6: the 1-on-1 video call HUD ---------------- */

test('call: the HUD gains the complaints link via the sync pattern, labelled from the shared key', () => {
  assert.ok(APP_JS.includes('function syncCallComplaintsLink()'), 'the HUD sync function exists');
  assert.ok(APP_JS.includes("a.id = 'call-complaints';"), 'it injects #call-complaints into the call HUD');
  assert.ok(APP_JS.includes("a.textContent = t('complaints_label');"), 'its text resolves from t(\'complaints_label\') — no new key');
  assert.ok(CALLHUD.includes('syncCallComplaintsLink();'), 'updateCallHUD refreshes it for the life of the call');
});

test('call: tapping the link hangs up through the normal path first', () => {
  assert.ok(
    APP_JS.includes("a.onclick = () => { hangupCall(); show('complaints', {}); };"),
    'tap runs hangupCall() — server end + UI teardown — then show(\'complaints\', {})',
  );
});

/* ---------------- surface 7: the random video call (battle stage) ---------------- */

test('battle: the stage foot carries the complaints link above Leave', () => {
  assert.ok(
    BATTLE.includes(`<a href="javascript:void(0)" id="battle-complaints" style="color:var(--pink)">\${t('complaints_label')}</a>`),
    'battle link label resolves from t(\'complaints_label\') — no hardcoded text, no new key',
  );
  const chatBox = BATTLE.indexOf('id="battle-chat-box"');
  const link = BATTLE.indexOf('id="battle-complaints"');
  const leave = BATTLE.indexOf('id="battle-leave"');
  assert.ok(chatBox >= 0 && link > chatBox, 'link sits at the foot of the stage, below the battle chat');
  assert.ok(leave > link, 'link sits just above the Leave button');
});

test('battle: the link tears the stage down first, then opens the policy', () => {
  assert.ok(
    /bcp\.onclick = \(\) => \{\s*battleClientTeardown\(\);\s*battleView = null;\s*show\('complaints', \{\}\);\s*\};/.test(BATTLE),
    'tap runs the Leave teardown (battleClientTeardown + battleView = null), then show(\'complaints\', {})',
  );
});

/* ---------------- surface 8: the model's own broadcast room ---------------- */

test('broadcast: the broadcast controls carry the complaints link under the Pause/End row', () => {
  assert.ok(
    BROADCAST.includes(`<a href="javascript:void(0)" id="live-broadcast-complaints" style="color:var(--pink)">\${t('complaints_label')}</a>`),
    'broadcast link label resolves from t(\'complaints_label\') — no hardcoded text, no new key',
  );
  assert.ok(!BROADCAST.includes('id="live-complaints"'), 'no id collision with the watch room\'s #live-complaints');
  const controls = BROADCAST.indexOf('class="live-controls"');
  const end = BROADCAST.indexOf('id="live-end-btn"');
  const link = BROADCAST.indexOf('id="live-broadcast-complaints"');
  assert.ok(controls >= 0 && end > controls, 'broadcast controls row located');
  assert.ok(link > end, 'link sits in the controls area, under the Pause/End row');
});

test('broadcast: the link ends the broadcast through its own end path, then opens the policy', () => {
  assert.ok(BROADCAST.includes("const bcl = $('#live-broadcast-complaints');"), 'broadcast wiring looks the link up by id');
  assert.ok(
    /bcl\.onclick = \(\) => \{ endLiveView\(\); show\('complaints', \{\}\); \};/.test(BROADCAST),
    'tap runs endLiveView() first — server end, tracks stopped, stage + timers torn down — then show(\'complaints\', {})',
  );
});
