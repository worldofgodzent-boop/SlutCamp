'use strict';
/*
 * Delegate audit log becomes a tap-to-open folder — owner request,
 * Oct 26 2026: the Settings screen rendered the audit log wide
 * open (25 rows fetched eagerly on every visit), and it "takes up
 * all my space." His words: "Create a folder for this, I can click
 * and check."
 *
 * THE SHAPE pinned here:
 *  - The Settings (More) body renders a collapsed folder: a toggle
 *    button, a body that starts display:none, and an empty rows box.
 *  - adminMoreBody does NOT fetch /admin/audit anymore — no eager
 *    fetch, no inline rows.
 *  - The toggle handler fetches /admin/audit?limit=25 on FIRST open
 *    only (M.auditLoaded), caches the rows on M, and re-fills from
 *    the cache after screen re-renders.
 *  - The row markup itself is unchanged (dlgAuditRowHTML renders
 *    the same .dlg-audit-row, badge, timestamp and Reason line the
 *    always-open card did) — this is a container change, not a
 *    content change. The underlying audit is untouched.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'public/manager/manager.js'), 'utf8');

function sliceFn(name) {
  const start = src.indexOf(`function ${name}`);
  assert.ok(start >= 0, `${name} exists`);
  const next = src.indexOf('\nfunction ', start + 10);
  const nextAsync = src.indexOf('\nasync function ', start + 10);
  const ends = [next, nextAsync].filter((i) => i > start);
  return src.slice(start, ends.length ? Math.min(...ends) : undefined);
}

test('Settings renders the audit log as a collapsed folder', () => {
  const body = sliceFn('adminMoreBody');
  assert.match(body, /id="dlg-audit-toggle"/, 'toggle button rendered');
  assert.match(body, /id="dlg-audit-body" style="display:none/, 'folder starts closed');
  assert.match(body, /id="dlg-audit-rows"/, 'rows box present, empty until opened');
  assert.match(body, /Delegate activity — audit log/, 'folder keeps its title');
});

test('Settings no longer fetches or renders the audit eagerly', () => {
  const body = sliceFn('adminMoreBody');
  assert.ok(!body.includes('/admin/audit'), 'no eager /admin/audit fetch in adminMoreBody');
  assert.ok(!body.includes('auditRows'), 'no inline audit rows in the body template');
});

test('the audit is fetched exactly once, from the toggle, on first open', () => {
  const fetches = src.match(/\/admin\/audit\?limit=25/g) || [];
  assert.equal(fetches.length, 1, 'exactly one audit fetch site in manager.js');
  assert.match(src, /go\('#dlg-audit-toggle'/, 'toggle is wired');
  assert.match(src, /M\.auditLoaded/, 'first-open guard present');
  assert.match(src, /M\.auditRows = \(data && data\.audit\) \|\| \[\]/, 'rows cached on M');
});

test('row markup is unchanged from the always-open card', () => {
  const row = sliceFn('dlgAuditRowHTML');
  assert.match(row, /class="dlg-audit-row"/);
  assert.match(row, /r\.actor_badge/);
  assert.match(row, /dlg-badge/);
  assert.match(row, /Reason: /);
});

test('folder state defaults live on M', () => {
  assert.match(src, /auditLoaded: false/);
  assert.match(src, /auditRows: null/);
});
