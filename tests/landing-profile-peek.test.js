'use strict';
/*
 * Landing (public front door) profile-first hotfix (owner report,
 * Oct 17 2026): tapping a model on the main page still went straight
 * to her text chat — "nothing has changed."
 *
 * Root cause: PR #37 rerouted tile taps to her profile page
 * (openModelPeek) in the logged-in home grid and the Lives list, but
 * the LANDING view kept the old handler — non-live tap →
 * openChatWithModel directly — so anyone landing on the public front
 * door (guests, and fans who land there) never saw her profile page.
 *
 * Fix: the landing's tile handler follows the same profile-first
 * rule as the home grid. Live tiles still join the stream directly.
 * Fallback to the chat open remains only for a tile whose model is
 * somehow absent from the payload (parity with the home grid).
 *
 * Guest bar: the peek's pinned Message bar is fan-only, so a
 * logged-out guest opening her profile from the landing gets a bar
 * in the same pinned spot. Oct 17 2026 it was join-only (tap routed
 * to the auth view; guests were never handed a conversation).
 * SUPERSEDED Oct 30 2026 (owner: front-door messages must land in
 * her inbox): the guest bar now opens her REAL guest chat via
 * openChatWithModel — guests hold a conversation server-side, 3
 * free messages, then the paywall; the thread migrates into his
 * account when he signs up. Fan / model / fan-preview behaviour is
 * untouched: the guest bar is gated on !S.user, so a signed-in user
 * of any role never sees it, and the fan bar still requires a
 * signed-in fan or fan-preview.
 *
 * Static source pins (suite convention for client behaviour).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(REPO, 'public/js/app.js'), 'utf8');

const lStart = app.indexOf('async function vLanding()');
const lEnd = app.indexOf('async function shareApp()', lStart);
assert.ok(lStart !== -1 && lEnd > lStart, 'vLanding located in app.js');
const landing = app.slice(lStart, lEnd);

const pStart = app.indexOf('function openModelPeek(');
const pEnd = app.indexOf('async function vFanModels()', pStart);
assert.ok(pStart !== -1 && pEnd > pStart, 'openModelPeek located in app.js');
const peek = app.slice(pStart, pEnd);

test('landing tiles: non-live tap opens her profile page first, chat only as fallback', () => {
  assert.ok(landing.includes('const m = models.find((x) => x.id === parseInt(b.dataset.model));'),
    'landing handler resolves the tapped model from the payload');
  assert.ok(landing.includes('if (m) { openModelPeek(m, models); return; }'),
    'landing tap opens the peek (profile page) and stops there');
  const peekAt = landing.indexOf('openModelPeek(m, models)');
  const chatAt = landing.indexOf('openChatWithModel(parseInt(b.dataset.model))');
  assert.ok(chatAt > peekAt, 'openChatWithModel survives only as the not-found fallback, after the peek');
});

test('landing tiles: live tiles still join the stream directly', () => {
  assert.ok(landing.includes('if (liveId) return watchLive(parseInt(liveId));'),
    'live check unchanged and first in the landing handler');
  const liveAt = landing.indexOf('if (liveId) return watchLive(parseInt(liveId));');
  const peekAt = landing.indexOf('openModelPeek(m, models)');
  assert.ok(peekAt > liveAt, 'profile routing happens only after the live branch');
});

test('peek guest bar: gated to logged-out guests; fan bar gating untouched', () => {
  assert.ok(peek.includes('const showGuestBar = !S.user;'),
    'guest bar renders only when nobody is signed in');
  assert.ok(peek.includes("const showMsgBar = !isMe && !!S.user && (S.user.role === 'fan' || S.user.is_house || isFanPreview());"),
    'fan Message bar gating unchanged (fans / fan-preview only, never isMe)');
});

test('peek guest bar: renders in the same pinned bar, outside the scroll region', () => {
  assert.ok(peek.includes('${showGuestBar ?'), 'guest bar renders conditionally');
  assert.ok(peek.includes('data-peek-join'), 'guest bar button carries the join hook');
  assert.ok(peek.includes("t('msg_her_btn')"), 'guest bar label is the Message-her label, i18n-keyed');
  const bars = peek.match(/class="peek-msgbar"/g) || [];
  assert.equal(bars.length, 2, 'exactly two pinned bars exist: fan Message bar + guest bar');
  const scrollAt = peek.indexOf('<div class="peek-scroll">');
  const guestAt = peek.indexOf('data-peek-join');
  assert.ok(guestAt > scrollAt, 'guest bar renders after/outside the scroll region, like the fan bar');
});

test('peek guest bar: tap opens her real guest chat (Oct 30 2026 front-door fix)', () => {
  const jStart = peek.indexOf("sheet.querySelector('[data-peek-join]')");
  const jEnd = peek.indexOf("sheet.querySelector('[data-peek-complaints]')", jStart);
  assert.ok(jStart !== -1 && jEnd > jStart, 'guest bar wiring located');
  const joinWire = peek.slice(jStart, jEnd);
  assert.ok(joinWire.includes('sheet.remove();'), 'her page closes first');
  assert.ok(joinWire.includes('openChatWithModel(m.id);'),
    'the guest is handed her conversation — his free messages land in her inbox');
  assert.ok(!joinWire.includes("show('auth', {});"),
    'the old join-wall route is gone from the guest bar');
});

test('msg_her_btn i18n key exists in all 13 language tables', () => {
  const hits = app.match(/msg_her_btn: '/g) || [];
  assert.equal(hits.length, 13, 'one msg_her_btn per language');
  assert.ok(app.includes("msg_her_btn: '💬 Message her'"), 'en label present');
});
