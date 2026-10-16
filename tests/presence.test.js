'use strict';
/*
 * Unit tests for lib/presence.js — counts-only live presence.
 *
 * Uses an in-memory node:sqlite database. No timers are started (the
 * service's start() is never called), so nothing here is time-flaky
 * except the online-window pruning, which is driven by passing an
 * explicit `now` to counts().
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const { createPresenceService, chicagoDay } = require('../lib/presence.js');

function freshService() {
  const db = new DatabaseSync(':memory:');
  return { db, svc: createPresenceService({ db }) };
}

test('counts start at zero', () => {
  const { svc } = freshService();
  assert.deepEqual(svc.counts(), { guests: 0, fans: 0, models: 0, total: 0 });
});

test('ping tallies guests, fans and models — staff roles are never counted', () => {
  const { svc } = freshService();
  svc.ping('g:token1', 'guest');
  svc.ping('g:token2', 'guest');
  svc.ping('u:10', 'fan');
  svc.ping('u:20', 'model');
  svc.ping('u:1', 'admin');      // staff: tracked but never in headline counts
  svc.ping('u:30', 'recruiter'); // staff: same
  assert.deepEqual(svc.counts(), { guests: 2, fans: 1, models: 1, total: 4 });
});

test('ping with missing key or role is ignored', () => {
  const { svc } = freshService();
  svc.ping('', 'fan');
  svc.ping(null, 'fan');
  svc.ping('u:1', '');
  svc.ping('u:1', null);
  assert.deepEqual(svc.counts(), { guests: 0, fans: 0, models: 0, total: 0 });
});

test('re-pinging the same identity does not double count', () => {
  const { svc } = freshService();
  svc.ping('u:10', 'fan');
  svc.ping('u:10', 'fan');
  svc.ping('u:10', 'fan');
  assert.deepEqual(svc.counts(), { guests: 0, fans: 1, models: 0, total: 1 });
});

test('entries older than the online window are pruned from counts', () => {
  const { svc } = freshService();
  svc.ping('u:10', 'fan');
  const future = Date.now() + svc.WINDOW_MS + 60000;
  assert.deepEqual(svc.counts(future), { guests: 0, fans: 0, models: 0, total: 0 });
});

test('sampleNow persists one aggregate row and snapshot reads it back', () => {
  const { db, svc } = freshService();
  svc.ping('g:abc', 'guest');
  svc.ping('u:10', 'fan');
  svc.sampleNow();
  const rows = db.prepare('SELECT guests, fans, models, total FROM presence_samples').all();
  assert.equal(rows.length, 1);
  assert.deepEqual(
    { guests: rows[0].guests, fans: rows[0].fans, models: rows[0].models, total: rows[0].total },
    { guests: 1, fans: 1, models: 0, total: 2 });
  const snap = svc.snapshot();
  assert.equal(snap.now.total, 2);
  assert.ok(snap.peakToday >= 2);
  assert.equal(snap.samples.length, 1);
});

test('chicagoDay converts UTC timestamps to the America/Chicago calendar day', () => {
  // 2026-10-16 05:00 UTC = 2026-10-16 00:00 CDT
  assert.equal(chicagoDay(Date.UTC(2026, 9, 16, 5, 0, 0)), '2026-10-16');
  // 2026-01-01 04:00 UTC = 2025-12-31 22:00 CST (previous Chicago day)
  assert.equal(chicagoDay(Date.UTC(2026, 0, 1, 4, 0, 0)), '2025-12-31');
  // 2026-01-01 06:00 UTC = 2026-01-01 00:00 CST
  assert.equal(chicagoDay(Date.UTC(2026, 0, 1, 6, 0, 0)), '2026-01-01');
});
