'use strict';
/*
 * PACKAGE THREAD MESSAGE BOX — owner screenshot, Oct 26 2026.
 * On the 📦 Custom package thread (fan side, Paradise), the message
 * input rendered as a skinny empty oval beside a full-width Send
 * button; the typed text sat on the page instead of in a box.
 *
 * ROOT CAUSE (code-verified): the base .btn style is
 * `display:block; width:100%` (stacked full-width buttons are the
 * app default). The thread's two input rows dropped a BARE .btn
 * into a flex .row next to a flex:1 input — the button's 100%
 * basis claimed the whole row and the input was crushed to its
 * minimum. The same crush sat in BOTH rows of this screen: the
 * message row (both sides) and the model's quote row.
 *
 * THE FIX pinned here (presentation only, call sites only — the
 * base .btn rule stays exactly as it is for the hundred other
 * screens that rely on it):
 *  - #pk-send and #pk-quote-send use the app's own in-row button
 *    style (.btn.small: width auto) + flex:none, so the input owns
 *    the row and the button hugs its label.
 *  - Both inputs gain min-width:0 so they can flex-shrink cleanly
 *    on narrow phones instead of overflowing at content width.
 *  - The standalone action buttons on this screen (Accept,
 *    Withdraw, Decline) stay full-width on purpose — pinned so a
 *    future "fix" doesn't shrink them by mistake.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(REPO, 'public/js/app.js'), 'utf8');
const cssSrc = fs.readFileSync(path.join(REPO, 'public/css/styles.css'), 'utf8');

test('pins: the message row — input owns the row, Send hugs its label', () => {
  assert.ok(appSrc.includes('<button class="btn small" id="pk-send" style="flex:none">'),
    'pk-send uses the in-row button style, not the full-width base');
  assert.ok(appSrc.includes('id="pk-input" placeholder="${t(\'pkg_send_ph\')}" maxlength="2000" style="flex:1;min-width:0"'),
    'pk-input keeps flex:1 and gains min-width:0');
  assert.ok(!appSrc.includes('<button class="btn" id="pk-send">'),
    'the bare full-width Send is gone');
});

test('pins: the quote row — same crush, same fix (model side of the screen)', () => {
  assert.ok(appSrc.includes('<button class="btn small" id="pk-quote-send" style="flex:none">'),
    'pk-quote-send uses the in-row button style');
  assert.ok(appSrc.includes('id="pk-quote" type="number" min="1" max="1000000" step="1" placeholder="${t(\'pkg_quote_ph\')}" style="flex:1;min-width:0"'),
    'pk-quote keeps flex:1 and gains min-width:0');
  assert.ok(!appSrc.includes('<button class="btn" id="pk-quote-send">'),
    'the bare full-width quote button is gone');
});

test('pins: standalone actions on this screen stay full-width; base .btn untouched', () => {
  assert.ok(appSrc.includes('<button class="btn ghost" id="pk-withdraw" style="width:100%;margin-top:8px">'),
    'Withdraw stays a full-width standalone button');
  assert.ok(appSrc.includes('<button class="btn ghost" id="pk-decline" style="width:100%;margin-top:8px">'),
    'Decline stays a full-width standalone button');
  assert.ok(cssSrc.includes('.btn {\n  display: block; width: 100%;'),
    'the base .btn rule is unchanged — the fix lives at the call sites');
});
