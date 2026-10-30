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
 *   - .tile-follow shrinks to a compact 24px pill with a hard
 *     max-width + ellipsis, so no language's "Following" label can
 *     stretch it back over her text;
 *   - .tile-heart shrinks with it (28px) so the stack stays
 *     proportionate;
 *   - .tile-info's right reserve covers the action stack, so her
 *     name, handle, price and counts never run under either pill.
 *
 * Follow-up tune (owner, later Oct 30, from the live tiles):
 * "String the follow a little bit more." The pill went 11px ->
 * 10.5px type, 0 9px -> 0 7px padding, 94px -> 84px cap, and the
 * reserve eased 104px -> 88px so her name/handle/price lines
 * reclaimed 16px. No-overlap now rests on the pill's RENDERED
 * width: every shipped "✓ Following" label (the widest is 11
 * glyphs) renders ~74px at 10.5px type, inside the 78px the
 * reserve leaves past the stack's 10px offset. The 84px cap is
 * the runaway ceiling only — a longer future label ellipsizes
 * inside the pill instead of stretching it.
 *
 * These pins are static source checks on that geometry contract.
 * Text widths use the standard ~0.5em average-glyph approximation
 * (the same coarse style as the original pins) — no layout engine.
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
  assert.equal(px(body, 'font-size'), 10.5, 'follow pill type is 10.5px (follow-up tune)');
  assert.equal(px(body, 'max-width'), 84, 'follow pill cap is 84px (follow-up tune)');
  const pad = body.match(/padding:\s*0\s+([0-9.]+)px/);
  assert.ok(pad && parseFloat(pad[1]) === 7, 'follow pill side padding is 7px (follow-up tune)');
  assert.ok(body.includes('text-overflow: ellipsis'), 'an over-long label ellipsizes instead of stretching the pill');
});

test('A23a: the Like heart shrinks with the pill', () => {
  const body = ruleBody('.tile-heart');
  assert.ok(px(body, 'height') <= 30, 'heart pill height stays proportionate to the follow pill (<=30px)');
});

test('A23a: the info block clears the rendered action stack', () => {
  const info = ruleBody('.tile-info');
  const follow = ruleBody('.tile-follow');
  const reserve = px(info, 'right');
  const cap = px(follow, 'max-width');
  assert.equal(reserve, 88, 'info reserve is 88px (follow-up tune: 104px - the 16px handed back to her lines)');
  assert.equal(cap, 84, 'pill cap is 84px');
  // 10px is the stack's right offset (.tile-actions right: 10px).
  // The widest shipped label, '✓ Following', is 11 glyphs; at the
  // ~0.5em approximation its rendered width (glyphs + side padding
  // + borders) must clear the text edge the reserve leaves.
  const fontSize = px(follow, 'font-size');
  const padX = parseFloat(follow.match(/padding:\s*0\s+([0-9.]+)px/)[1]);
  const rendered = 11 * fontSize * 0.5 + 2 * padX + 2;
  assert.ok(rendered <= reserve - 10,
    `rendered '✓ Following' pill (~${rendered.toFixed(1)}px) clears the reserve past the stack offset (${reserve - 10}px)`);
});

test('A23a: her name and handle fit the full-width column without the ellipsis', () => {
  // Tile width at the app column's full width: #phone caps at
  // 480px, .screen pads 16px a side, .tile-grid is 2 columns with
  // a 12px gap -> (480 - 32 - 12) / 2 = 218px per tile. On
  // narrower phones the ellipsis stays the designed fallback;
  // this pins the full-column case the reserve was tuned against.
  const info = ruleBody('.tile-info');
  const usable = 218 - px(info, 'left') - px(info, 'right');
  const namePx = px(ruleBody('.tile-name'), 'font-size');
  const subPx = px(ruleBody('.tile-sub'), 'font-size');
  const nameWidth = 12 * namePx * 0.5; // a 12-character display name
  const handleWidth = 11 * subPx * 0.5; // '@' + a 10-character username
  assert.ok(nameWidth <= usable,
    `12-char name (~${nameWidth.toFixed(1)}px) fits the usable line (${usable}px)`);
  assert.ok(handleWidth <= usable,
    `10-char username (~${handleWidth.toFixed(1)}px) fits the usable line (${usable}px)`);
});

test('A23a: the tile still renders the follow + like stack (renderer untouched)', () => {
  assert.ok(appSrc.includes('tile-follow'), 'the tile still renders the follow pill');
  assert.ok(appSrc.includes('data-follow-btn'), 'the follow pill keeps its tap hook');
  assert.ok(appSrc.includes('tile-heart'), 'the tile still renders the like heart');
  assert.ok(appSrc.includes('data-like-count'), 'the like count still renders');
  assert.ok(appSrc.includes('data-follow-count'), 'the follower count still renders');
});
