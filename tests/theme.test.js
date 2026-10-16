'use strict';
/*
 * Unit tests for the seasonal theme engine (public/js/theme.js).
 *
 * resolveTheme() is a pure function of (date, override), so the whole
 * holiday calendar is testable with fabricated local Dates — no DOM,
 * no network, no clock mocking. The file-level tests pin the wiring:
 * index.html must load theme.js, and the THEMES metadata must mirror
 * the CSS pack files on disk in both directions, so a pack can never
 * ship half-added (engine entry without styles, or styles the engine
 * can never reach).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const theme = require('../public/js/theme.js');
const { resolveTheme, THEMES } = theme;

const REPO = path.join(__dirname, '..');
// Local date constructor: (year, month 1-12, day). resolveTheme reads
// local components, matching how the browser engine uses new Date().
const d = (y, m, day) => new Date(y, m - 1, day);

test('halloween runs Oct 1 through Oct 31, then stops', () => {
  assert.equal(resolveTheme(d(2026, 10, 1)), 'halloween');
  assert.equal(resolveTheme(d(2026, 10, 31)), 'halloween');
  assert.equal(resolveTheme(d(2026, 11, 1)), null);
  assert.equal(resolveTheme(d(2026, 9, 30)), null);
});

test('christmas runs Dec 1–25; Dec 26 is back to normal', () => {
  assert.equal(resolveTheme(d(2026, 12, 1)), 'christmas');
  assert.equal(resolveTheme(d(2026, 12, 25)), 'christmas');
  assert.equal(resolveTheme(d(2026, 12, 26)), null);
  assert.equal(resolveTheme(d(2026, 12, 27)), null);
});

test('newyear straddles the year boundary, Dec 28 – Jan 2', () => {
  assert.equal(resolveTheme(d(2026, 12, 28)), 'newyear');
  assert.equal(resolveTheme(d(2026, 12, 31)), 'newyear');
  assert.equal(resolveTheme(d(2027, 1, 1)), 'newyear');
  assert.equal(resolveTheme(d(2027, 1, 2)), 'newyear');
  assert.equal(resolveTheme(d(2027, 1, 3)), null);
});

test('valentines runs Feb 7–14 only', () => {
  assert.equal(resolveTheme(d(2027, 2, 7)), 'valentines');
  assert.equal(resolveTheme(d(2027, 2, 14)), 'valentines');
  assert.equal(resolveTheme(d(2027, 2, 6)), null);
  assert.equal(resolveTheme(d(2027, 2, 15)), null);
});

test('stpatricks runs Mar 10–17 only', () => {
  assert.equal(resolveTheme(d(2027, 3, 10)), 'stpatricks');
  assert.equal(resolveTheme(d(2027, 3, 17)), 'stpatricks');
  assert.equal(resolveTheme(d(2027, 3, 9)), null);
  assert.equal(resolveTheme(d(2027, 3, 18)), null);
});

test('july4 runs Jun 27 – Jul 4 only', () => {
  assert.equal(resolveTheme(d(2027, 6, 27)), 'july4');
  assert.equal(resolveTheme(d(2027, 7, 4)), 'july4');
  assert.equal(resolveTheme(d(2027, 6, 26)), null);
  assert.equal(resolveTheme(d(2027, 7, 5)), null);
});

test('thanksgiving 2026: starts Nov 20, ends on the 4th Thursday (Nov 26)', () => {
  assert.equal(theme.fourthThursdayOfNovember(2026), 26);
  assert.equal(resolveTheme(d(2026, 11, 19)), null);
  assert.equal(resolveTheme(d(2026, 11, 20)), 'thanksgiving');
  assert.equal(resolveTheme(d(2026, 11, 26)), 'thanksgiving');
  assert.equal(resolveTheme(d(2026, 11, 27)), null);
});

test('thanksgiving tracks the 4th Thursday in other years', () => {
  // 2025: 4th Thursday is Nov 27; 2027: Nov 25.
  assert.equal(theme.fourthThursdayOfNovember(2025), 27);
  assert.equal(theme.fourthThursdayOfNovember(2027), 25);
  assert.equal(resolveTheme(d(2025, 11, 27)), 'thanksgiving');
  assert.equal(resolveTheme(d(2025, 11, 28)), null);
  assert.equal(resolveTheme(d(2027, 11, 25)), 'thanksgiving');
});

test('easter 2026: Good Friday (Apr 3) through Easter Sunday (Apr 5)', () => {
  assert.deepEqual(theme.easterSunday(2026), { month: 4, day: 5 });
  assert.equal(resolveTheme(d(2026, 4, 2)), null);
  assert.equal(resolveTheme(d(2026, 4, 3)), 'easter');
  assert.equal(resolveTheme(d(2026, 4, 4)), 'easter');
  assert.equal(resolveTheme(d(2026, 4, 5)), 'easter');
  assert.equal(resolveTheme(d(2026, 4, 6)), null);
});

test('easter computus lands on known Sundays in other years', () => {
  assert.deepEqual(theme.easterSunday(2025), { month: 4, day: 20 });
  assert.deepEqual(theme.easterSunday(2027), { month: 3, day: 28 });
  assert.equal(resolveTheme(d(2027, 3, 26)), 'easter'); // Good Friday
  assert.equal(resolveTheme(d(2027, 3, 28)), 'easter'); // Easter Sunday
  assert.equal(resolveTheme(d(2027, 3, 29)), null);
});

test('a named override forces its theme on any date', () => {
  assert.equal(resolveTheme(d(2026, 7, 15), 'christmas'), 'christmas');
  assert.equal(resolveTheme(d(2026, 12, 25), 'halloween'), 'halloween');
});

test("override 'off' suppresses even an in-season theme", () => {
  assert.equal(resolveTheme(d(2026, 10, 31), 'off'), null);
  assert.equal(resolveTheme(d(2026, 7, 15), 'off'), null);
});

test('an unknown override is ignored and the calendar decides', () => {
  assert.equal(resolveTheme(d(2026, 10, 15), 'festivus'), 'halloween');
  assert.equal(resolveTheme(d(2026, 7, 15), 'festivus'), null);
});

test('index.html loads the theme engine', () => {
  const html = fs.readFileSync(path.join(REPO, 'public', 'index.html'), 'utf8');
  assert.ok(html.includes('<script src="/js/theme.js" defer></script>'),
    'public/index.html must include the theme.js script tag');
});

test('every THEMES entry has a CSS pack on disk, and vice versa', () => {
  const dir = path.join(REPO, 'public', 'css', 'themes');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.css'));
  // theme-base.css is the shared structural file, not a pack.
  const packsOnDisk = files.filter((f) => f !== 'theme-base.css')
    .map((f) => f.replace(/\.css$/, '')).sort();
  assert.deepEqual(packsOnDisk, Object.keys(THEMES).sort());
  assert.ok(files.includes('theme-base.css'), 'shared theme-base.css must exist');
  for (const name of Object.keys(THEMES)) {
    const css = fs.readFileSync(path.join(dir, name + '.css'), 'utf8');
    assert.ok(css.includes(`[data-theme='${name}']`),
      `${name}.css must scope its overrides to [data-theme='${name}']`);
    assert.ok(THEMES[name].greeting && THEMES[name].themeColor,
      `${name} metadata needs a greeting and a themeColor`);
    assert.ok(Array.isArray(THEMES[name].emojis) && THEMES[name].emojis.length > 0,
      `${name} metadata needs particle emojis`);
  }
});
