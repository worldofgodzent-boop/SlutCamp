'use strict';
/*
 * Manager presence strip — the "all peaks" fix (owner report Oct 30, 2026).
 *
 * The owner's card read "1 on the app now · peak today 4" while the
 * last-2-hours strip rendered as a solid wall of full-height bars.
 * The server data was never wrong (lib/presence.js samples store the
 * instantaneous count each minute, and peakToday is the day's true
 * MAX) — the fault was in public/manager/manager.js:
 *
 *   1. Bar heights were normalized by the strip window's OWN max.
 *      With a flat low count (1 person online for hours) the window
 *      max is that same 1, so every bar pegged to 100% height.
 *      Fix: scale by the true peak — max(peakToday, ...buckets, 1).
 *   2. presenceBuckets anchored its span to the first/last SAMPLE
 *      instead of the trailing 2 hours, so a short post-restart
 *      history stretched across the whole strip and every bar's
 *      place in time shifted. Fix: buckets are fixed 2.5-minute
 *      slices of the trailing 2h ending now; empty slices are 0.
 *
 * These tests extract the REAL presenceBuckets from manager.js (the
 * suite's established pattern, cf. manager-last-active.test.js), pin
 * the render-scale wiring by source shape, and pin the endpoint
 * payload for the owner's exact scenario at the service level.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { createPresenceService, chicagoDay } = require('../lib/presence.js');

const managerSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'manager', 'manager.js'), 'utf8');

function loadPresenceBuckets() {
  const start = managerSrc.indexOf('function presenceBuckets(');
  assert.ok(start >= 0, 'presenceBuckets exists in manager.js');
  const end = managerSrc.indexOf('\n}', start);
  assert.ok(end > start, 'presenceBuckets body is extractable');
  return new Function(`${managerSrc.slice(start, end + 2)}\nreturn presenceBuckets;`)();
}

const NOW = Date.UTC(2026, 9, 30, 19, 0, 0); // fixed clock — no time flakiness
const MIN = 60000;
const sm = (minutesAgo, total) => ({ ts: NOW - minutesAgo * MIN, guests: 0, fans: 0, models: total, total });

test('buckets are fixed slices of the trailing 2h ending now — a 20-minute history occupies only the last 8 slices', () => {
  const presenceBuckets = loadPresenceBuckets();
  const samples = [];
  for (let i = 20; i >= 1; i--) samples.push(sm(i, 1));
  const buckets = presenceBuckets(samples, 48, NOW);
  assert.equal(buckets.length, 48);
  assert.deepEqual(buckets.slice(0, 40), new Array(40).fill(0),
    'the first 100 minutes have no samples and must read as true zeros');
  assert.deepEqual(buckets.slice(40), new Array(8).fill(1),
    'the 20 minutes of real data land in the final 8 slices (48 x 2.5 min)');
});

test('a slice takes the highest sample inside it; untouched slices stay 0', () => {
  const presenceBuckets = loadPresenceBuckets();
  // 61 and 62 minutes ago fall in the same 2.5-minute slice (index 23).
  const buckets = presenceBuckets([sm(62, 1), sm(61, 3)], 48, NOW);
  assert.equal(buckets[23], 3);
  assert.equal(buckets.reduce((a, b) => a + b, 0), 3, 'no other slice is polluted');
});

test('samples older than the 2h window are ignored; a sample at the window start lands in slice 0', () => {
  const presenceBuckets = loadPresenceBuckets();
  assert.deepEqual(presenceBuckets([sm(121, 9)], 48, NOW), new Array(48).fill(0));
  const atStart = presenceBuckets([sm(120, 5)], 48, NOW);
  assert.equal(atStart[0], 5);
  assert.equal(atStart.reduce((a, b) => a + b, 0), 5);
});

test('owner scenario, data side: a flat 1 online for the full window buckets to a flat 1 (the render scale must not peg it to full height)', () => {
  const presenceBuckets = loadPresenceBuckets();
  const samples = [];
  for (let i = 120; i >= 1; i--) samples.push(sm(i, 1));
  const buckets = presenceBuckets(samples, 48, NOW);
  assert.deepEqual(buckets, new Array(48).fill(1),
    'buckets honestly report the flat count — paired with the peak scale below, these render at 1/peakToday height, not 100%');
});

test('render wiring: strip buckets against now and scales by peakToday, not the window max alone', () => {
  const card = managerSrc.slice(managerSrc.indexOf('async function refreshPresenceCard()'),
    managerSrc.indexOf('function presenceBuckets('));
  assert.ok(card.includes('presenceBuckets(samples, 48, Date.now())'),
    'buckets are computed against the fixed trailing-2h window ending now');
  assert.ok(card.includes('Math.max(1, data.peakToday || 0, ...buckets)'),
    'bar heights scale to the true peak today (buckets retained in the max for the midnight-straddle edge)');
});

test('service payload for the owner scenario is honest: now=1, peakToday=4 from an earlier burst, recent samples all <= 1', () => {
  const db = new DatabaseSync(':memory:');
  const svc = createPresenceService({ db });
  const now = Date.now();
  // An earlier burst today (3h ago): four people online at once.
  db.prepare('INSERT INTO presence_samples (ts, day, guests, fans, models, total) VALUES (?, ?, ?, ?, ?, ?)')
    .run(now - 3 * 60 * MIN, chicagoDay(now), 2, 1, 1, 4);
  // Now: exactly one model online, sampled as usual.
  svc.ping('u:20', 'model');
  svc.sampleNow();
  const snap = svc.snapshot();
  assert.deepEqual(snap.now, { guests: 0, fans: 0, models: 1, total: 1 });
  assert.equal(snap.peakToday, 4, 'peak today is the day\'s true maximum concurrency');
  assert.ok(snap.samples.length >= 1, 'recent samples are returned for the strip');
  assert.ok(snap.samples.every((s) => s.total <= 1),
    'samples inside the 2h window carry their own instantaneous counts, never the peak');
});
