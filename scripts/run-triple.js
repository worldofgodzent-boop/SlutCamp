'use strict';
/*
 * scripts/run-triple.js — Asce's "run test triple" rule, literally.
 *
 * Runs the FULL test suite three times in a row (three separate
 * `node --test` child processes) and fails if ANY of the three runs
 * fails. A suite that only passes sometimes is a failing suite: this
 * is how intermittent/flaky tests get caught before code goes live.
 *
 * Usage: npm run test:triple
 */
const { spawnSync } = require('node:child_process');

const RUNS = 3;
const results = [];

for (let i = 1; i <= RUNS; i++) {
  console.log(`\n================ TEST RUN ${i} OF ${RUNS} ================`);
  const r = spawnSync(process.execPath, ['--test'], {
    stdio: 'inherit',
    cwd: __dirname + '/..',
    env: process.env,
  });
  // spawnSync status is null when the child died by signal — treat as fail.
  const ok = r.status === 0;
  results.push(ok);
  console.log(`================ RUN ${i}: ${ok ? 'PASS' : 'FAIL'} ================`);
}

console.log('\n---------------- TRIPLE-TEST SUMMARY ----------------');
results.forEach((ok, i) => console.log(`  Run ${i + 1}: ${ok ? 'PASS' : 'FAIL'}`));
if (results.every(Boolean)) {
  console.log('  RESULT: PASS — all 3 runs green. Cleared by the triple-test rule.');
} else {
  console.log('  RESULT: FAIL — at least one run failed. Do NOT ship. Investigate before merging.');
  process.exit(1);
}
