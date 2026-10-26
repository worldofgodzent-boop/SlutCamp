'use strict';
/*
 * Model link landing (owner report, Oct 26 2026): clicking a girl's
 * link (#m/<username>) brings the visitor to the front door and the
 * age gate — correct — but passing the gate dropped her on the
 * directory (fanModels), not in that girl's inbox.
 *
 * Root cause: routeInitial's #m/ branch resolved the model, then
 * deliberately sent every guest to the model list ("show model list
 * (they can sign up then chat)"), and nothing remembered which girl
 * the link was for.
 *
 * Fix: a guest with a resolved target lands in that model's chat,
 * the same destination a signed-in fan gets. Guests can hold a
 * conversation (POST /api/conversations/start accepts a guest), and
 * the thread migrates into her account when she signs up. If the
 * chat can't open (region block, server error), the branch falls
 * back to the directory instead of stranding her. Signed-in
 * non-fans still land on the directory; a bad username still falls
 * back to the directory.
 *
 * Static source pins (suite convention for client behaviour).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(REPO, 'public/js/app.js'), 'utf8');

const rStart = app.indexOf('async function routeInitial()');
const rEnd = app.indexOf("window.addEventListener('hashchange'", rStart);
assert.ok(rStart !== -1 && rEnd > rStart, 'routeInitial located in app.js');
const route = app.slice(rStart, rEnd);

const mStart = route.indexOf('// Model promo link: #m/USERNAME');
assert.ok(mStart !== -1, '#m/ branch located in routeInitial');
const branch = route.slice(mStart, mStart + 3000);

test('#m/ guest: a resolved target opens her chat, not the directory', () => {
  assert.ok(branch.includes('const opened = await openChatWithModel(target.id);'),
    'guest path opens the target model chat');
  assert.ok(branch.includes('if (opened) return;'),
    'a successful chat open ends routing there');
  assert.ok(branch.includes("return show('fanModels', {});"),
    'directory remains only as the fallback');
});

test('#m/ guest: the old directory-dump behaviour is gone', () => {
  assert.ok(!app.includes('Guest or non-fan: show model list'),
    'old guest-to-directory comment/behaviour removed');
});

test('openChatWithModel reports whether the chat opened', () => {
  const oStart = app.indexOf('async function openChatWithModel(modelId)');
  assert.ok(oStart !== -1, 'openChatWithModel located in app.js');
  const fn = app.slice(oStart, oStart + 700);
  assert.ok(fn.includes("show('chat', { conv: data.conversation }); return true;"),
    'success shows the chat and returns true');
  assert.ok(fn.includes('return false;'), 'failure returns false');
});

test('#m/ signed-in fan path is unchanged (live first, else chat)', () => {
  assert.ok(branch.includes('if (target.live_session_id) return watchLive(target.live_session_id);'),
    'live fan still goes to the live');
  assert.ok(branch.includes('return openChatWithModel(target.id);'),
    'fan still goes straight to her chat');
});
