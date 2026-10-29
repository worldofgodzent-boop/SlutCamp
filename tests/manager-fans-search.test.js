'use strict';
/*
 * Manager Fans SEARCH BAR (owner, Oct 21 2026, from his Fans-tab
 * screenshot): "Not even gonna lie, I'm a need a search bar in here.
 * Too many fans to scroll through."
 *
 * THE FEATURE pinned here:
 *  - A search input at the TOP of the Manager Fans list. Typing filters
 *    the fan cards by display name AND username — case-insensitive,
 *    partial (substring) match; a leading @ on the query is ignored.
 *  - Filtering is hide/show ONLY: cards are rendered once and never
 *    re-rendered or re-bound while searching, so the per-fan actions
 *    (Credits / 💬 Message / Ban — each bound to its own card's fan id)
 *    keep hitting the exact fan shown, filtered or not.
 *  - While filtering, a count line reads "N of M fans"; clearing the
 *    search restores the full list and the plain "M fans" count.
 *  - A query with no matches shows a clean "No fans match your search."
 *    empty state instead of a bare void.
 * Manager is English-only — no STR ×13 work. No announcement ships with
 * this build (notification-thread-tap pin untouched).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const managerSrc = fs.readFileSync(path.join(REPO, 'public/manager/manager.js'), 'utf8');

/* ---------------- static pins ---------------- */

test('pins: Fans body renders search UI above the list', () => {
  const body = managerSrc.slice(managerSrc.indexOf('async function adminFansBody()'),
    managerSrc.indexOf('async function adminContractsBody()'));
  assert.ok(body.includes('id="fans-search"'), 'search input at the top of the Fans list');
  assert.ok(body.includes('type="search"'), 'input is a search field');
  assert.ok(body.includes('Search by name or @username'), 'placeholder names both match fields');
  assert.ok(body.includes('id="fans-search-clear"'), 'clear button present');
  assert.ok(body.includes('id="fans-count"'), 'match-count line present');
  assert.ok(body.includes('id="fans-list"'), 'cards wrapped in the filter scope');
  assert.ok(body.includes('id="fans-noresults"'), 'no-results state present');
  assert.ok(body.includes('No fans match your search.'), 'no-results copy');
  assert.ok(body.indexOf('id="fans-search"') < body.indexOf('id="fans-list"'),
    'search sits above the cards');
});

test('pins: each card carries its own id + name/username search key; actions stay per-fan', () => {
  const body = managerSrc.slice(managerSrc.indexOf('async function adminFansBody()'),
    managerSrc.indexOf('async function adminContractsBody()'));
  assert.ok(body.includes('data-fan-card="${f.id}"'), 'card keyed by the fan id');
  assert.ok(body.includes("data-fan-search=\"${esc((String(f.display_name || '') + ' ' + String(f.username || '')).toLowerCase())}\""),
    'search key = lowercased "display name + username"');
  // The actions on that same card still target the same fan id.
  assert.ok(body.includes('data-credit="${f.id}"'), 'Credits button targets the card fan');
  assert.ok(body.includes('data-f-msg="${f.id}"'), 'Message button targets the card fan');
  assert.ok(body.includes('data-ban="${f.id}"'), 'Ban button targets the card fan');
  assert.ok(body.includes('id="cr-${f.id}"'), 'credit amount input belongs to the card fan');
});

test('pins: wiring — hide/show filter bound in wireAdminBody, no re-render of cards', () => {
  const wire = managerSrc.slice(managerSrc.indexOf('// Fans\n  wireFansSearch();'),
    managerSrc.indexOf('// Fans\n  wireFansSearch();') + 60);
  assert.ok(wire.includes('wireFansSearch();'), 'Fans section of wireAdminBody wires the search');

  const fn = managerSrc.slice(managerSrc.indexOf('function fansFilterApply('),
    managerSrc.indexOf('async function adminSafetyBody()'));
  assert.ok(fn.includes("document.querySelectorAll('#fans-list [data-fan-card]')"),
    'filter scopes to the rendered cards');
  assert.ok(fn.includes("card.style.display = hit ? '' : 'none'"),
    'filtering is visibility-only (cards never re-rendered)');
  assert.ok(!fn.includes('innerHTML'), 'filter never touches card HTML/bindings');
  assert.ok(fn.includes('of ${cards.length} fans'), 'count reads "N of M fans" while filtering');
  assert.ok(fn.includes("replace(/^@+/, '')"), 'a leading @ on the query is ignored');

  const w = managerSrc.slice(managerSrc.indexOf('function wireFansSearch()'),
    managerSrc.indexOf('async function adminSafetyBody()'));
  assert.ok(w.includes("addEventListener('input'"), 'live filtering on every keystroke');
  assert.ok(w.includes("input.value = '';"), 'clear button empties the search');
  assert.ok(w.includes("fansFilterApply('')"), 'clearing re-applies the empty filter (full list back)');
});

/* ---------------- behavior: the real filter fn on a stub DOM ---------------- */

function loadFilter() {
  const src = managerSrc.slice(managerSrc.indexOf('function fansFilterApply('),
    managerSrc.indexOf('function wireFansSearch()'));
  return (document) => new Function('document', `${src}\nreturn fansFilterApply;`)(document);
}

// Search keys exactly as adminFansBody renders them:
// lowercased "display name + ' ' + username".
function stubDom(fans) {
  const cards = fans.map((f) => ({
    dataset: {
      fanCard: String(f.id),
      fanSearch: (String(f.display_name || '') + ' ' + String(f.username || '')).toLowerCase(),
    },
    style: {},
  }));
  const count = { textContent: '' };
  const noresults = { style: { display: 'none' } };
  const document = {
    querySelectorAll(sel) {
      assert.equal(sel, '#fans-list [data-fan-card]');
      return cards;
    },
    getElementById(id) {
      if (id === 'fans-count') return count;
      if (id === 'fans-noresults') return noresults;
      return null;
    },
  };
  const visibleIds = () => cards.filter((c) => c.style.display !== 'none').map((c) => Number(c.dataset.fanCard));
  return { document, cards, count, noresults, visibleIds };
}

const FANS = [
  { id: 11, display_name: 'Jay', username: 'jaybird' },
  { id: 22, display_name: 'Mike', username: 'mikey22' },
  { id: 33, display_name: 'Jaylene', username: 'jay_x' },
];

test('behavior: filter by display name and username, case-insensitive + partial', () => {
  const apply = loadFilter();
  const dom = stubDom(FANS);

  // No query: everything visible, plain count, no empty state.
  assert.equal(apply(dom.document)(''), 3);
  assert.deepEqual(dom.visibleIds(), [11, 22, 33]);
  assert.equal(dom.count.textContent, '3 fans');
  assert.equal(dom.noresults.style.display, 'none');

  // Display name, partial + shouting case.
  assert.equal(apply(dom.document)('JAY'), 2);
  assert.deepEqual(dom.visibleIds(), [11, 33], 'both Jays by display name');
  assert.equal(dom.count.textContent, '2 of 3 fans');

  // Display-name partial that only one fan has.
  assert.equal(apply(dom.document)('jayl'), 1);
  assert.deepEqual(dom.visibleIds(), [33]);

  // Username match (not in any display name).
  assert.equal(apply(dom.document)('mikey22'), 1);
  assert.deepEqual(dom.visibleIds(), [22], 'username finds Mike');
  assert.equal(dom.count.textContent, '1 of 3 fans');

  // Leading @ is ignored (fans render as @username).
  assert.equal(apply(dom.document)('@jay_x'), 1);
  assert.deepEqual(dom.visibleIds(), [33]);

  // Whitespace around the query is trimmed.
  assert.equal(apply(dom.document)('  mike  '), 1);
  assert.deepEqual(dom.visibleIds(), [22]);
});

test('behavior: no-results state, then clearing restores the full list', () => {
  const apply = loadFilter();
  const dom = stubDom(FANS);

  assert.equal(apply(dom.document)('zzz-no-such-fan'), 0);
  assert.deepEqual(dom.visibleIds(), []);
  assert.equal(dom.count.textContent, '0 of 3 fans');
  assert.equal(dom.noresults.style.display, '', 'clean no-results state shows');

  // Clear: every card back, count back to plain total, empty state gone.
  assert.equal(apply(dom.document)(''), 3);
  assert.deepEqual(dom.visibleIds(), [11, 22, 33]);
  assert.equal(dom.count.textContent, '3 fans');
  assert.equal(dom.noresults.style.display, 'none');
  for (const c of dom.cards) assert.equal(c.style.display, '', 'no card left hidden after clear');
});

/* ---------------- live: served asset + the API the cards/actions use ---------------- */

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function makeCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-fanssearch-'));
  for (const d of ['server.js', 'package.json', 'lib', 'public', 'data']) {
    fs.cpSync(path.join(REPO, d), path.join(dir, d), { recursive: true });
  }
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  return dir;
}

async function boot(dir, extraEnv) {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), CRYPTO_POLL_MS: '3600000', ...extraEnv };
  for (const k of Object.keys(env)) {
    if (/^(CCBILL_|CRYPTO_|OPENAI_|TWILIO_|VAPID_|WEBAUTHN_|AV_)/.test(k)) delete env[k];
  }
  if (!('SEED_DEMO' in extraEnv)) delete env.SEED_DEMO;
  const child = spawn(process.execPath, ['server.js'], { cwd: dir, env });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode})\n${log}`);
    try {
      const r = await fetch(base + '/api/health');
      if (r.ok) break;
    } catch (e) { /* not up yet */ }
    if (Date.now() > deadline) { child.kill('SIGKILL'); throw new Error(`server did not come up\n${log}`); }
    await new Promise((r) => setTimeout(r, 150));
  }
  return { child, base, log: () => log };
}

function stop(h) {
  if (h && h.child && h.child.exitCode === null) h.child.kill('SIGKILL');
}

async function req(base, method, p, { body, token, mgr } = {}) {
  const h = {};
  let payload;
  if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  if (token) h.authorization = 'Bearer ' + token;
  if (mgr) h['x-manager'] = '1';
  const r = await fetch(base + p, { method, headers: h, body: payload });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not json */ }
  return { status: r.status, json, text };
}

test('live: manager.js ships the search; /admin/fans feeds it; a credit action lands on its own fan only', { timeout: 120000 }, async (t) => {
  const dir = makeCopy();
  const h = await boot(dir, { SEED_DEMO: '1' });
  t.after(() => stop(h));
  const { base } = h;

  // The served Manager asset carries the search (what production serves).
  const js = await req(base, 'GET', '/manager/manager.js');
  assert.equal(js.status, 200);
  assert.ok(js.text.includes('id="fans-search"'), 'served manager.js has the Fans search input');
  assert.ok(js.text.includes('function fansFilterApply('), 'served manager.js has the filter');

  const adm = await req(base, 'POST', '/api/manager/login', { body: { username: 'admin', password: 'admin123' } });
  assert.equal(adm.status, 200, `manager login: ${adm.text}`);
  const atok = adm.json.token;

  // A second fan so "the action hit the right fan" is distinguishable.
  const other = await req(base, 'POST', '/api/auth/signup', {
    body: { username: 'searchfan', password: 'search-fan-pass', role: 'fan',
            display_name: 'Search Fan', dob: '1995-05-05', agree18: true },
  });
  assert.equal(other.status, 200, `second fan signup: ${other.text}`);
  const otherId = other.json.user.id;

  const list1 = await req(base, 'GET', '/api/admin/fans', { token: atok, mgr: true });
  assert.equal(list1.status, 200, `fans list: ${list1.text}`);
  const fans = list1.json.fans || [];
  const demo = fans.find((f) => f.username === 'fandemo');
  const second = fans.find((f) => f.id === otherId);
  assert.ok(demo && second, 'both fans listed');
  // Every row the filter consumes carries the two fields it matches on.
  for (const f of fans) {
    assert.ok(typeof f.display_name === 'string' && typeof f.username === 'string',
      'fan rows carry display_name + username for the search key');
  }

  // The Credits action (the exact endpoint the card button posts to)
  // lands on the addressed fan and nobody else.
  const before = second.credits_cents;
  const demoBefore = demo.credits_cents;
  const grant = await req(base, 'POST', `/api/admin/fans/${otherId}/credits`,
    { token: atok, mgr: true, body: { amount_cents: 700 } });
  assert.equal(grant.status, 200, `grant: ${grant.text}`);
  const list2 = await req(base, 'GET', '/api/admin/fans', { token: atok, mgr: true });
  const second2 = (list2.json.fans || []).find((f) => f.id === otherId);
  const demo2 = (list2.json.fans || []).find((f) => f.username === 'fandemo');
  assert.equal(second2.credits_cents, before + 700, 'credit landed on the addressed fan');
  assert.equal(demo2.credits_cents, demoBefore, 'the other fan was untouched');
});
