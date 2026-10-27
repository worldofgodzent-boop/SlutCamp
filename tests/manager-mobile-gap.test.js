'use strict';
/*
 * Manager mobile dead space — owner field defect, Oct 26 2026:
 * opening a chat thread in the Manager on his phone parked the
 * thread halfway down the screen under a tall empty band ("Why
 * does it always show like this? What's the top empty space for?").
 *
 * ROOT CAUSE (layout, verified against the shell CSS): .mgr-shell
 * is a grid with min-height calc(100dvh - var(--topbar-h)). On
 * phones (max-width:860px) it collapses to ONE column — sidebar
 * chip bar stacked over the content — and a grid's auto rows
 * STRETCH by default (align-content: normal). When a screen's
 * content is shorter than the shell's min-height (a chat thread
 * with one message, short screens), the leftover height is
 * distributed into the rows: the chip bar's row balloons, the
 * sticky chips sit at its top, and the content starts below a
 * tall dead band. Long screens (Overview) fill the height
 * naturally, so the defect showed mainly on short screens.
 *
 * THE FIX pinned here: in the phone media query, .mgr-shell
 * carries align-content:start so rows size to their content and
 * the content follows the chip bar directly. The Manager styles
 * live in TWO places that must stay in step: the inline <style>
 * in public/manager/index.html and public/manager/manager.css.
 * Desktop layout (two columns) is deliberately untouched.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public/manager/index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/manager/manager.css'), 'utf8');

// Slice from the phone media query to the end of that block's shell rule.
function mobileShellRule(src, label) {
  const i = src.indexOf('@media (max-width:860px)');
  const j = src.indexOf('@media (max-width: 860px)');
  const start = i >= 0 ? i : j;
  assert.ok(start >= 0, `${label}: phone media query present`);
  const seg = src.slice(start, start + 4000);
  const m = seg.match(/\.mgr-shell\s*\{([^}]*)\}/);
  assert.ok(m, `${label}: .mgr-shell rule inside the phone media query`);
  return m[1];
}

test('phone shell does not stretch rows (index.html inline style)', () => {
  const rule = mobileShellRule(html, 'index.html');
  assert.match(rule, /grid-template-columns:\s*1fr/, 'single column on phones');
  assert.match(rule, /align-content:\s*start/, 'rows pack at the top — no dead band');
});

test('phone shell does not stretch rows (manager.css)', () => {
  const rule = mobileShellRule(css, 'manager.css');
  assert.match(rule, /grid-template-columns:\s*1fr/, 'single column on phones');
  assert.match(rule, /align-content:\s*start/, 'rows pack at the top — no dead band');
});

test('desktop shell is untouched: two columns, full-height frame', () => {
  for (const [label, src] of [['index.html', html], ['manager.css', css]]) {
    const base = src.match(/\.mgr-shell\s*\{\s*display:\s*grid;[^}]*\}/);
    assert.ok(base, `${label}: base .mgr-shell rule present`);
    assert.match(base[0], /grid-template-columns:\s*256px/, `${label}: desktop sidebar column kept`);
    assert.match(base[0], /min-height:\s*calc\(100dvh - var\(--topbar-h\)\)/, `${label}: frame height kept`);
    assert.ok(!/align-content/.test(base[0]), `${label}: no align-content on the desktop base rule`);
  }
});
