'use strict';
/*
 * Clean feed Settings buttons (Oct 23 2026 hotfix) — the Clean feed
 * manager's "Add clean photo" / "Add clean video" buttons rendered as
 * an inline, label-width pair (btn ghost small, the video button with
 * an inline margin-left:6px). On a phone the pair wraps and the second
 * button sits indented — staggered, half-width, unlike the full-width
 * stacked buttons everywhere else in Settings (Asce's screenshot,
 * Oct 23 2026). The fix is presentation only: the two buttons render
 * inside a .cf-add-stack flex-column wrapper, each width:100%, the
 * stack's gap as the only spacing, and NO inline margin on either
 * button. Ids, labels, handlers and the feed_full note logic are
 * pinned unchanged here so the layout can never regress silently.
 *
 * Harness: static pins over the shipped client sources (the
 * update.test.js pattern) — no server boot needed for markup/CSS.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(REPO, 'public/js/app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(REPO, 'public/css/styles.css'), 'utf8');

// The loadCleanFeedSettings body, up to the next top-level function.
const fnStart = APP.indexOf('async function loadCleanFeedSettings()');
assert.ok(fnStart >= 0, 'loadCleanFeedSettings exists in app.js');
const fnEnd = APP.indexOf('async function renderPkSettingsCard', fnStart);
assert.ok(fnEnd > fnStart, 'loadCleanFeedSettings body is sliceable');
const FN = APP.slice(fnStart, fnEnd);

function buttonTag(id) {
  const m = FN.match(new RegExp('<button[^>]*id="' + id + '"[^>]*>'));
  assert.ok(m, 'button #' + id + ' is rendered by loadCleanFeedSettings');
  return m[0];
}

test('add buttons render inside the cf-add-stack wrapper', () => {
  const stackAt = FN.indexOf('class="cf-add-stack"');
  assert.ok(stackAt >= 0, 'buttons are wrapped in .cf-add-stack');
  assert.ok(stackAt < FN.indexOf('id="cf-add-photo"'), 'wrapper opens before the photo button');
  assert.ok(stackAt < FN.indexOf('id="cf-add-video"'), 'wrapper opens before the video button');
});

test('neither add button carries an inline margin (the stagger source)', () => {
  assert.ok(!/margin-left/.test(buttonTag('cf-add-photo')), 'photo button has no inline margin-left');
  assert.ok(!/margin-left/.test(buttonTag('cf-add-video')), 'video button has no inline margin-left');
  assert.ok(!/style=/.test(buttonTag('cf-add-video')), 'video button has no inline style at all');
});

test('ids and labels are unchanged', () => {
  assert.ok(buttonTag('cf-add-photo').includes("t('feed_add_photo')") || FN.includes('id="cf-add-photo"'), 'photo button id present');
  assert.ok(FN.includes('id="cf-add-photo"') && FN.includes("${t('feed_add_photo')}"), 'photo button keeps its label string');
  assert.ok(FN.includes('id="cf-add-video"') && FN.includes("${t('feed_add_video')}"), 'video button keeps its label string');
  assert.ok(FN.includes("pics.length < maxP") && FN.includes("vids.length < maxV"), 'cap conditionals still gate each button');
});

test('handlers and the feed_full note are unchanged', () => {
  assert.ok(FN.includes("box.querySelector('#cf-add-photo')"), 'photo handler still wired by id');
  assert.ok(FN.includes("box.querySelector('#cf-add-video')"), 'video handler still wired by id');
  assert.ok(FN.includes("apiUpload('/model/feed/photo'"), 'photo upload endpoint unchanged');
  assert.ok(FN.includes("fetch('/api/model/feed/video'"), 'video upload endpoint unchanged');
  assert.ok(FN.includes("${t('feed_full')}") || FN.includes("t('feed_full')"), 'feed_full note still rendered');
  assert.ok(FN.includes('pics.length >= maxP || vids.length >= maxV'), 'feed_full condition unchanged');
});

test('CSS stacks the buttons full-width with gap-only spacing', () => {
  const stack = CSS.match(/\.cf-add-stack\s*\{([^}]*)\}/);
  assert.ok(stack, '.cf-add-stack rule exists');
  assert.ok(/display:\s*flex/.test(stack[1]), 'stack is a flex container');
  assert.ok(/flex-direction:\s*column/.test(stack[1]), 'stack is a vertical column');
  assert.ok(/gap:/.test(stack[1]), 'stack spacing comes from its gap');
  const btn = CSS.match(/\.cf-add-stack \.btn\s*\{([^}]*)\}/);
  assert.ok(btn, '.cf-add-stack .btn rule exists');
  assert.ok(/width:\s*100%/.test(btn[1]), 'stacked buttons are full width');
  assert.ok(/margin-left:\s*0/.test(btn[1]), 'stacked buttons carry no left margin');
});
