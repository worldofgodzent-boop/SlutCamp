'use strict';
/*
 * A23a (owner, Oct 30 2026, from his phone): "Fix the following or
 * follow, make it smaller. Make it neat." On the model tiles the
 * Follow/Following pill (A22) rendered as a big pink slab — the
 * .tile-info text block only reserved 64px at the right for the
 * heart, so the wider pill reached back over her name, price and
 * counts lines.
 *
 * The fix is CSS-only, in the ONE shared tile stylesheet (modelTileHTML
 * is the single renderer for the home grid, the New Models rail and
 * the lives view):
 *   - .tile-follow shrinks to a compact 24px / 11px pill with a hard
 *     max-width + ellipsis, so no language's "Following" label can
 *     stretch it back over her text;
 *   - .tile-heart shrinks with it (28px) so the stack stays
 *     proportionate;
 *   - .tile-info's right reserve grows to 104px — the stack's full
 *     footprint (10px offset + the pill's 94px cap) — so her name,
 *     handle, price and counts can never run under either pill.
 *
 * These pins are static source checks on that geometry contract.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'styles.css'), 'utf8');
const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');

function ruleBody(selector) {
  const idx = css.indexOf(selector + ' {');
  assert.ok(idx !== -1, `selector ${selector} exists in styles.css`);
  const open = css.indexOf('{', idx);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}
function px(body, prop) {
  const m = body.match(new RegExp(prop + ':\\s*([0-9.]+)px'));
  return m ? parseFloat(m[1]) : null;
}

test('A23a: the Follow pill is compact and width-capped', () => {
  const body = ruleBody('.tile-follow');
  assert.ok(px(body, 'height') <= 26, 'follow pill height is compact (<=26px)');
  assert.ok(px(body, 'font-size') <= 11.5, 'follow pill type is small (<=11.5px)');
  assert.ok(px(body, 'max-width') !== null && px(body, 'max-width') <= 100, 'follow pill has a hard max-width cap (<=100px)');
  assert.ok(body.includes('text-overflow: ellipsis'), 'an over-long label ellipsizes instead of stretching the pill');
});

test('A23a: the Like heart shrinks with the pill', () => {
  const body = ruleBody('.tile-heart');
  assert.ok(px(body, 'height') <= 30, 'heart pill height stays proportionate to the follow pill (<=30px)');
});

test('A23a: the info block reserves the whole action stack', () => {
  const info = ruleBody('.tile-info');
  const follow = ruleBody('.tile-follow');
  const reserve = px(info, 'right');
  const cap = px(follow, 'max-width');
  assert.ok(reserve !== null && cap !== null, 'both the reserve and the pill cap are set in px');
  // 10px is the stack's right offset (.tile-actions right: 10px).
  assert.ok(reserve >= cap + 10, `info reserve (${reserve}px) clears the pill cap (${cap}px) plus the stack offset`);
});

test('A23a: the tile still renders the follow + like stack (renderer untouched)', () => {
  assert.ok(appSrc.includes('tile-follow'), 'the tile still renders the follow pill');
  assert.ok(appSrc.includes('data-follow-btn'), 'the follow pill keeps its tap hook');
  assert.ok(appSrc.includes('tile-heart'), 'the tile still renders the like heart');
  assert.ok(appSrc.includes('data-like-count'), 'the like count still renders');
  assert.ok(appSrc.includes('data-follow-count'), 'the follower count still renders');
});
