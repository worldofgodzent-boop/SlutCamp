'use strict';
/*
 * Manager phone-width squeeze — owner field defect, Oct 28 2026:
 * the whole Manager (top bar, nav pills, Team channel) rendered
 * crushed into the left of the phone screen with dead space down
 * the right ("Why does my team channel still look like this?").
 *
 * ROOT CAUSE (Kay Kay's diagnosis, device-emulation measurements
 * against channel-realistic content, on main a43be42): the Manager
 * had no horizontal containment. ONE unbreakable token wider than
 * the ~340px phone content column — a 64-hex media filename in a
 * team message (document 525px wide at a 390 viewport), a full
 * media URL in a Settings row (653), a long email in Models (451),
 * a source-URL cell in the Overview totals (421) — widened the
 * whole document, and the phone rendered the shell squeezed into
 * the left of the ~2x-wide page. Ordinary prose never triggers it.
 *
 * THE FIX pinned here (phone media query only, BOTH style sources
 * in step — the inline <style> in public/manager/index.html and
 * public/manager/manager.css):
 *   - .mgr-shell track 1fr -> minmax(0, 1fr): the single column
 *     may shrink below its content's intrinsic width.
 *   - .mgr-side gains min-width: 0: the chip-bar row cannot force
 *     the track wider either.
 *   - #mgr-content { min-width: 0; overflow-wrap: anywhere; }:
 *     content shrinks to the column and unbreakable strings wrap
 *     instead of widening the page.
 * Desktop layout is deliberately untouched. After the fix every
 * Manager view measures exactly viewport width at 390 and 430.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public/manager/index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/manager/manager.css'), 'utf8');

function phoneBlock(src, label) {
  const i = src.indexOf('@media (max-width:860px)');
  const j = src.indexOf('@media (max-width: 860px)');
  const start = i >= 0 ? i : j;
  assert.ok(start >= 0, `${label}: phone media query present`);
  return src.slice(start, start + 5000);
}

for (const [label, src] of [['index.html', html], ['manager.css', css]]) {
  test(`phone width guard present (${label})`, () => {
    const seg = phoneBlock(src, label);
    const shell = seg.match(/\.mgr-shell\s*\{([^}]*)\}/);
    assert.ok(shell, `${label}: .mgr-shell rule inside the phone media query`);
    assert.match(shell[1], /grid-template-columns:\s*minmax\(0,\s*1fr\)/, `${label}: phone column may shrink (minmax(0, 1fr))`);
    const side = seg.match(/\.mgr-side\s*\{([^}]*)\}/);
    assert.ok(side, `${label}: .mgr-side rule inside the phone media query`);
    assert.match(side[1], /min-width:\s*0/, `${label}: chip bar cannot widen the track`);
    const content = seg.match(/#mgr-content\s*\{([^}]*)\}/);
    assert.ok(content, `${label}: #mgr-content rule inside the phone media query`);
    assert.match(content[1], /min-width:\s*0/, `${label}: content may shrink to the column`);
    assert.match(content[1], /overflow-wrap:\s*anywhere/, `${label}: unbreakable strings wrap instead of widening the page`);
  });
}

test('desktop shell keeps the fixed sidebar column in both sources', () => {
  for (const [label, src] of [['index.html', html], ['manager.css', css]]) {
    const base = src.match(/\.mgr-shell\s*\{\s*display:\s*grid;[^}]*\}/);
    assert.ok(base, `${label}: base .mgr-shell rule present`);
    assert.match(base[0], /grid-template-columns:\s*256px/, `${label}: desktop sidebar column kept`);
  }
});
