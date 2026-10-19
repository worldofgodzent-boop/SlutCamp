'use strict';
/*
 * Home controls tidy (owner design, Oct 19 2026 — "make these look
 * better and less crowded… I need everything neat"): the discovery bar
 * on the home screens (guest landing + fan/model home, shared renderer)
 * drops two chip groups and reshapes a third:
 *
 *   - the small 🔴 Live chip is GONE — the big Lives button already
 *     goes to lives; the 🟢 Online chip stays (round 2 moves the tag
 *     dropdown up beside it — see the round-2 note below).
 *   - the $ / $$ / $$$ price-band chips are GONE — price ordering lives
 *     in the sort select, whose option list is pinned UNCHANGED
 *     (top, liked, online, price_low, price_high, newest).
 *   - the row of tag chips is ONE dropdown: it shows the selected tag
 *     (or the neutral "All tags" label), lists exactly the tags the
 *     chips used to show (tags used by the current payload, plus a
 *     clear/none choice), and writes the very same disc.tag state — so
 *     applyDiscovery composes with search/sort/Online/section exactly
 *     as before (that composition is pinned in tests/discovery.test.js;
 *     here we pin the CONTROL and its rendering).
 *
 * Round 2 (owner, later Oct 19 2026 — annotated screenshot of the live
 * home: "cut the tag button and bring it up beside the live button…
 * bring the New Models up more underneath the tabs, so there's not a
 * big gap"): the dropdown leaves its own full-width row and rides the
 * 🟢 Online row — [Online] [dropdown flex-filling the rest] [✖ Clear
 * when active], one row that never wraps — and the bar's bottom
 * spacing tightens so the "🆕 New models you may like" rail sits
 * neatly right under the controls. Same control, same state, same
 * options; only the layout moved.
 *
 * Pins are static (source shape) + a render simulation: the real
 * discoveryBarHTML is extracted from app.js and executed in a vm
 * against fabricated rosters/states, asserting on the HTML it emits.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const REPO = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const app = read('public/js/app.js');
const css = read('public/css/styles.css');

const barBody = app.slice(app.indexOf('function discoveryBarHTML'), app.indexOf('function wireDiscovery'));
const wireBody = app.slice(app.indexOf('function wireDiscovery'), app.indexOf('function homeTilesHTML'));

/* ---------------- static pins: the bar markup ---------------- */

test('tidy pins: bar keeps Online, drops the Live chip and the price-band chips', () => {
  assert.ok(barBody.includes('data-disc-toggle="online"'), '🟢 Online chip stays');
  assert.ok(!barBody.includes('data-disc-toggle="live"'), 'no small 🔴 Live chip — the big Lives button covers it');
  assert.ok(!barBody.includes('data-disc-price'), 'no $ / $$ / $$$ price-band chips');
  assert.ok(!barBody.includes('disc_band'), 'the bar no longer renders band labels');
  assert.ok(barBody.includes('id="disc-clear"'), 'clear-filters chip still appears when filters are active');
});

test('tidy pins: tags are one dropdown writing the same disc.tag state', () => {
  assert.ok(barBody.includes('<select') && barBody.includes('id="disc-tag"'), 'a tag <select> renders');
  assert.ok(barBody.includes("t('disc_tag_any')"), 'neutral label comes from STR (disc_tag_any)');
  assert.ok(!barBody.includes('data-disc-tag='), 'the old tag chip row is gone');
  assert.ok(wireBody.includes("$('#disc-tag')"), 'the dropdown is wired');
  assert.ok(wireBody.includes('disc.tag = tg.value'), 'picking writes disc.tag — same state the chips wrote');
  assert.ok(!wireBody.includes('data-disc-price'), 'price-chip click wiring removed with the chips');
  assert.ok(!wireBody.includes('data-disc-tag'), 'tag-chip click wiring removed with the chips');
  /* Round 2 pin update (Oct 19 2026): the dropdown no longer renders
   * as its own full-width row — it is an inline wrap inside the chips
   * row, and the whole bar is exactly two rows. */
  assert.ok(barBody.includes('<span class="disc-selectwrap">'), 'round 2: dropdown is an inline wrap on the Online row');
  assert.ok(!barBody.includes('<div class="disc-row disc-selectwrap">'), 'round 2: the old full-width dropdown row is gone');
  assert.equal(barBody.split('class="disc-row').length - 1, 2,
    'round 2: the bar is exactly two rows (search/sort, then Online + tags + clear)');
});

test('tidy round 2 pins: single-row CSS + tightened bar-to-rail spacing', () => {
  assert.match(css, /\.disc-selectwrap\s*\{[^}]*flex:\s*1 1 auto;[^}]*min-width:\s*0;/,
    'the tag wrap flex-fills the Online row beside the chip and may shrink');
  assert.match(css, /\.disc-chips\s*\{[^}]*flex-wrap:\s*nowrap;/,
    'the Online row never wraps to a second line');
  assert.match(css, /\.disc-chips \.disc-chip\s*\{[^}]*flex:\s*0 0 auto;[^}]*white-space:\s*nowrap;/,
    'the chips hold their size on the shared row');
  assert.match(css, /\.disc-bar\s*\{\s*margin-bottom:\s*10px;/,
    'bar bottom margin tightened (was 14px) so the rail pulls up');
  assert.match(css, /\.disc-bar \.disc-row:last-child\s*\{\s*margin-bottom:\s*0;/,
    'the last row adds no margin of its own — the bar margin is the only gap above the rail');
  assert.ok(css.includes('.new-rail-wrap { margin-bottom: 14px; }')
    && css.includes('.new-rail-title { font-weight: 800; margin: 2px 0 8px; }'),
    'rail-side spacing untouched — the tightening came from the bar side only');
});

test('tidy pins: sort options are exactly the pre-tidy list, unchanged', () => {
  assert.ok(barBody.includes("['top', 'liked', 'online', 'price_low', 'price_high', 'newest']"),
    'sort select keeps all six options (Top ranked / Most liked / Online first / price low→high / price high→low / Newest)');
});

test('tidy pins: dropdown styling + STR key in all 13 languages', () => {
  assert.ok(css.includes('.disc-tagpick'), 'tag select styling exists');
  assert.ok(css.includes('.disc-selectwrap') && css.includes("content: '▾'"), 'the wrap draws the ▾ arrow');
  assert.equal(app.split('disc_tag_any:').length - 1, 13, 'disc_tag_any translated in all 13 tables');
});

/* ---------------- render simulation: the real discoveryBarHTML ---------------- */

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

const sim = {};
{
  const tagsLiteral = app.match(/const DISCOVERY_TAGS = (\[[\s\S]*?\]);/)[1];
  const discLiteral = app.match(/const disc = (\{[^}]*\});/)[1];
  const barStart = app.indexOf('function discoveryBarHTML(models)');
  const barEnd = app.indexOf('\n}\n', barStart);
  assert.ok(barStart >= 0 && barEnd > barStart, 'discoveryBarHTML extraction bounds');
  const barSrc = app.slice(barStart, barEnd + 3);
  assert.ok(barSrc.includes('id="disc-tag"'), 'extraction really captured the bar renderer');

  const ctx = {
    t: (k) => ({
      search_models_ph: 'SEARCH', disc_online: 'ONLINE', clear_filters: 'CLEAR',
      disc_tag_any: 'ALL TAGS', sort_top: 'S:top', sort_liked: 'S:liked',
      sort_online: 'S:online', sort_price_low: 'S:price_low',
      sort_price_high: 'S:price_high', sort_newest: 'S:newest',
    }[k] || k),
    esc: (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;'),
  };
  vm.createContext(ctx);
  vm.runInContext(
    `const DISCOVERY_TAGS = ${tagsLiteral};\n`
    + `const disc = ${discLiteral};\n`
    + extractFn(app, 'discActive') + '\n'
    + barSrc
    + '\n;globalThis.__x = { discoveryBarHTML, disc };', ctx);
  Object.assign(sim, ctx.__x);
}
const resetDisc = (over) => Object.assign(sim.disc,
  { q: '', online: false, live: false, price: 'any', tag: '', sort: 'top' }, over);
const ROSTER = [
  { username: 'a', tags: ['Latina', 'Curvy'] },
  { username: 'b', tags: [] },
  { username: 'c', tags: ['Latina'] },
];

test('render: default bar — Online only, no Live/price chips, dropdown lists used tags', () => {
  resetDisc({});
  const html = sim.discoveryBarHTML(ROSTER);
  assert.ok(html.includes('data-disc-toggle="online"'), 'Online chip rendered');
  assert.ok(!html.includes('data-disc-toggle="live"'), 'no Live chip in the HTML');
  assert.ok(!html.includes('data-disc-price'), 'no price-band chips in the HTML');
  assert.ok(!html.includes('id="disc-clear"'), 'no clear chip while nothing is filtered');
  assert.ok(html.includes('id="disc-tag"'), 'tag dropdown rendered');
  assert.ok(html.includes('<option value="" selected>ALL TAGS</option>'), 'neutral label selected when no tag picked');
  assert.ok(html.includes('<option value="Latina"') && !html.includes('<option value="Latina" selected'),
    'used tag Latina offered, unselected');
  assert.ok(html.includes('<option value="Curvy"') && !html.includes('<option value="Curvy" selected'),
    'used tag Curvy offered, unselected');
  assert.ok(!html.includes('value="Gaming"'), 'unused catalogue tags are NOT offered (same list the chips showed)');
  /* Round 2: Online and the dropdown share ONE row — the rendered bar
   * has exactly two .disc-row containers (round 1 rendered three),
   * with the Online chip before the dropdown inside the chips row. */
  assert.equal(html.split('class="disc-row').length - 1, 2,
    'round 2: rendered bar is two rows — no separate dropdown row');
  const chipsAt = html.indexOf('disc-row disc-chips');
  assert.ok(chipsAt >= 0
    && html.indexOf('data-disc-toggle="online"', chipsAt) >= 0
    && html.indexOf('data-disc-toggle="online"', chipsAt) < html.indexOf('id="disc-tag"', chipsAt),
    'round 2: Online chip and tag dropdown sit in the same row, Online first');
});

test('render: the dropdown shows the selected tag; the filter survives a section with no users of it', () => {
  resetDisc({ tag: 'Latina' });
  let html = sim.discoveryBarHTML(ROSTER);
  assert.ok(html.includes('<option value="Latina" selected>Latina</option>'), 'selected tag is the dropdown label');
  assert.ok(!html.includes('<option value="" selected>'), 'neutral label no longer selected');
  html = sim.discoveryBarHTML([{ username: 'z', tags: [] }]);
  assert.ok(html.includes('id="disc-tag"'), 'dropdown still renders — control never vanishes mid-filter');
  assert.ok(html.includes('<option value="Latina" selected>Latina</option>'), 'active tag still listed and selected');
});

test('render: no tags anywhere and none selected — no dropdown at all; the Online row renders as before', () => {
  resetDisc({});
  const html = sim.discoveryBarHTML([{ username: 'a', tags: [] }, { username: 'b', tags: [] }]);
  assert.ok(!html.includes('id="disc-tag"'), 'dropdown omitted when there is nothing to pick');
  assert.ok(html.includes('data-disc-toggle="online"'), 'the Online chip row still renders on its own');
});

test('render: Online on-state + clear chip; sort select carries all six options in order', () => {
  resetDisc({ online: true });
  const html = sim.discoveryBarHTML(ROSTER);
  assert.ok(html.includes('disc-chip on" data-disc-toggle="online"'), 'Online chip shows its on state');
  assert.ok(html.includes('id="disc-clear"'), 'clear chip appears once a filter is active');
  /* Round 2: with Clear showing, the row order is Online, dropdown,
   * Clear — all inside the one chips-row container. */
  const chipsAt = html.indexOf('disc-row disc-chips');
  const onAt = html.indexOf('data-disc-toggle="online"', chipsAt);
  const tagAt = html.indexOf('id="disc-tag"', chipsAt);
  const clearAt = html.indexOf('id="disc-clear"', chipsAt);
  assert.ok(chipsAt >= 0 && onAt >= 0 && tagAt > onAt && clearAt > tagAt,
    'round 2 row order: Online, tag dropdown, Clear — all on the one row');
  const sortHtml = html.slice(html.indexOf('id="disc-sort"'), html.indexOf('</select>', html.indexOf('id="disc-sort"')));
  const order = ['top', 'liked', 'online', 'price_low', 'price_high', 'newest'];
  let at = -1;
  for (const v of order) {
    const i = sortHtml.indexOf(`value="${v}"`);
    assert.ok(i > at, `sort option ${v} present and in order`);
    at = i;
  }
});
