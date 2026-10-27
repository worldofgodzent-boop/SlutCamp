'use strict';
/*
 * COUNTS ON EVERY TILE — owner screenshot follow-up, Oct 26 2026.
 * The public-counts build put the 👥 chip inside the fan-only tile
 * hearts. Asce, looking at the home grid browsed as a model (the
 * house view), asked: "So the like and playlist number will reflect
 * on her profile card here?" — and in that view the tiles carry no
 * heart at all, so no numbers showed. His standing line for this
 * feature: "Both fans and models need see this."
 *
 * THE FIX pinned here: the numbers move into the ONE shared tile
 * renderer (modelTileHTML — grid, hero, and New Models rail all
 * ride it), in the tile's info block under the price line:
 * "❤️ n · 👥 n", rendered for EVERY viewer — guest, fan, model.
 * The interactive hearts stay exactly as they were (like heart on
 * the landing, follow heart on the fan home, none for model
 * viewers); only the printed numbers became universal. The landing
 * heart's own count span and the tile line share the
 * [data-like-count] hook so a like tap moves both, and the tile
 * line's follower number rides the [data-follow-count] hook the
 * follows toggle already refreshes globally.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(REPO, 'public/js/app.js'), 'utf8');

test('pins: the shared tile renderer prints both counts for every viewer', () => {
  const tileFn = appSrc.slice(appSrc.indexOf('function modelTileHTML'), appSrc.indexOf('function newModelsRailHTML'));
  assert.ok(tileFn.includes('tile-counts'), 'tile carries the counts line');
  assert.ok(tileFn.includes('data-like-count="${m.id}"'), 'tile like number carries the live hook');
  assert.ok(tileFn.includes('data-follow-count="${m.id}"'), 'tile follower number carries the live hook');
  assert.ok(tileFn.includes('${m.like_count || 0}') && tileFn.includes('${m.follower_count || 0}'),
    'both numbers come from the payload counts');
  assert.ok(!tileFn.includes('heartFor'), 'the counts are NOT gated on the fan-only heart');
});

test('pins: hearts are back to hearts only — no duplicate numbers', () => {
  assert.ok(!appSrc.includes('tile-followers'), 'the fan-only followers chip is gone');
  assert.ok(appSrc.includes('<span class="like-count" data-like-count="${m.id}">'),
    'the landing heart count shares the live hook (no second number to drift)');
});

test('pins: a like tap refreshes the tile line as well as the heart', () => {
  assert.ok(appSrc.includes('document.querySelectorAll(`[data-like-count="${modelId}"]`)'),
    'the like handler updates every rendered like count in place');
});
