'use strict';
/*
 * Service worker freshness + forced-refresh tests (2026-10-16) —
 * source-assertion tests.
 *
 * Service workers are not executed by this suite; these tests pin the
 * wiring in public/sw.js (and its server-side stamping in server.js) so
 * the fixes can't silently rot:
 *   - The cache name must carry the '__BUILD__' deploy token. The
 *     earlier static names pinned whatever a device fetched first:
 *     'slutcamp-v3' served the first theme.js a device ever saw
 *     forever (cache-first, never revalidated), which froze installed
 *     PWAs on an old season — no promo strip, stale pop-up timing, no
 *     new theme packs. server.js stamps the token with the deploy's
 *     build id (slutcamp-<sha>), so every deploy flushes every cache;
 *     with no build id available it stamps 'v4', i.e. the static
 *     slutcamp-v4 behavior.
 *   - /js/theme.js must be network-first (exact list entry).
 *   - /css/themes/* (theme-base.css + every seasonal pack) must be
 *     network-first via the prefix rule, so future packs are covered
 *     without another edit here.
 *   - The original four network-first shell entries must remain.
 *   - A new worker must take over immediately (skipWaiting on install,
 *     clients.claim on activate) and activate must delete every cache
 *     that is not its own — the flush itself.
 *
 * The matcher below mirrors the fetch handler's condition exactly:
 *   NETWORK_FIRST.includes(pathname) ||
 *   NETWORK_FIRST_PREFIXES.some((p) => pathname.startsWith(p))
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

const sw = read('public/sw.js');
const server = read('server.js');

// Pull a `const NAME = ['a', 'b'];` string-array literal out of the source.
function stringArray(name) {
  const m = sw.match(new RegExp(`const ${name} = \\[([^\\]]*)\\];`));
  assert.ok(m, `${name} array literal not found in sw.js`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

const NETWORK_FIRST = stringArray('NETWORK_FIRST');
const NETWORK_FIRST_PREFIXES = stringArray('NETWORK_FIRST_PREFIXES');
const isNetworkFirst = (p) =>
  NETWORK_FIRST.includes(p) || NETWORK_FIRST_PREFIXES.some((pre) => p.startsWith(pre));

test('cache name carries the per-deploy __BUILD__ token (no static version left)', () => {
  assert.match(sw, /const CACHE = 'slutcamp-__BUILD__';/);
  assert.doesNotMatch(sw, /const CACHE = 'slutcamp-v[0-9]+';/);
});

test('server stamps the __BUILD__ token with the deploy build id when serving /sw.js', () => {
  // A dedicated route (registered ahead of the static middleware).
  assert.match(server, /app\.get\('\/sw\.js'/);
  assert.match(server, /split\('__BUILD__'\)\.join\(BUILD_ID \|\| 'v4'\)/);
  // Build id sources: Render's injected commit, then git, then null.
  assert.match(server, /RENDER_GIT_COMMIT/);
  assert.match(server, /rev-parse/);
  // The stamped cache name + the static fallback name.
  assert.match(server, /BUILD_ID \? `slutcamp-\$\{BUILD_ID\}` : 'slutcamp-v4'/);
});

test('activate deletes every cache that is not the current one (the flush)', () => {
  assert.match(sw, /keys\.filter\(\(k\) => k !== CACHE\)\.map\(\(k\) => caches\.delete\(k\)\)/);
});

test('new workers take over immediately: skipWaiting + clients.claim', () => {
  assert.match(sw, /self\.skipWaiting\(\)/);
  assert.match(sw, /self\.clients\.claim\(\)/);
});

test('/js/theme.js is network-first', () => {
  assert.ok(NETWORK_FIRST.includes('/js/theme.js'), 'theme.js missing from NETWORK_FIRST');
  assert.ok(isNetworkFirst('/js/theme.js'));
});

test('/css/themes/ assets are network-first via the prefix rule', () => {
  assert.ok(
    NETWORK_FIRST_PREFIXES.includes('/css/themes/'),
    "'/css/themes/' missing from NETWORK_FIRST_PREFIXES"
  );
  // The fetch handler must actually consult the prefix list.
  assert.match(sw, /NETWORK_FIRST_PREFIXES\.some\(\(p\) => url\.pathname\.startsWith\(p\)\)/);
  // Every theme stylesheet shipped in the repo is covered.
  const themeCss = fs.readdirSync(path.join(REPO, 'public/css/themes'))
    .filter((f) => f.endsWith('.css'));
  assert.ok(themeCss.length > 0, 'no theme CSS files found');
  for (const f of themeCss) {
    assert.ok(isNetworkFirst(`/css/themes/${f}`), `/css/themes/${f} is not network-first`);
  }
});

test('original four network-first shell entries are unchanged', () => {
  for (const p of ['/', '/index.html', '/css/styles.css', '/js/app.js']) {
    assert.ok(NETWORK_FIRST.includes(p), `${p} missing from NETWORK_FIRST`);
    assert.ok(isNetworkFirst(p));
  }
});
