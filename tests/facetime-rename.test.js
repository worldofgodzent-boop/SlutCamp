'use strict';
/*
 * FaceTime -> "video call" feature rename (2026-10-21, owner order).
 *
 * The CCBill readiness build scrubbed "FaceTime" out of model-authored
 * text (bios, tip-menu + game-item labels); the final readiness audit
 * then counted 73 occurrences of Apple's trademark still branding the
 * in-app 1-on-1 video feature itself — call invites, bell copy,
 * refund toasts, the model guide, Model Agreement section 12, the
 * client STR tables in all 13 languages. A compliance reviewer inside
 * the ccbillreview account lives on exactly that surface, so the
 * feature was renamed to "video call" (each language's existing
 * video-call term, for i18n consistency) in ALL user-facing copy.
 *
 * This suite pins it:
 *   1. No /facetime/i survives anywhere in server.js, public/js/app.js
 *      or public/css/styles.css outside the allowlisted INTERNAL
 *      identifiers (DB table/column, /facetime/* routes, 'facetime:*'
 *      WS event types + the 'facetime' notification type, the
 *      FACETIME_DURATIONS const, openFaceTimeSheet, the
 *      in_facetime_call error code) and the legacy bio-scrub migration
 *      block, which must keep matching the old word in stored
 *      user-authored text and is marker-guarded + already shipped.
 *   2. The new copy is actually present (the test cannot pass by the
 *      strings simply being deleted).
 *   3. Both shipped JS files still parse.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SERVER_JS = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const APP_JS = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
const STYLES_CSS = fs.readFileSync(path.join(ROOT, 'public', 'css', 'styles.css'), 'utf8');

/* Internal identifiers that may keep the old token: they never render. */
const INTERNAL_TOKENS = [
  'facetime_requests',   // DB table
  'facetime_req_id',     // DB column
  '/facetime/',          // API routes (client + server must agree)
  "'facetime:",          // WS event types 'facetime:request' etc.
  '"facetime:',
  'facetime:update',
  'facetime:queue',
  'facetime:request',
  'FACETIME_DURATIONS',  // const in both files
  'openFaceTimeSheet',   // client function name
  "'facetime'",          // notification type key in notifyUser(...)
  'in_facetime_call',    // API error code
  ', facetime)',         // (defensive) identifier lists
];

/* Line span of the legacy readiness scrub migration in server.js: the
 * one block that must keep matching /facetime/ in stored user text.
 * Located by anchors so a refactor that moves it updates this test
 * loudly instead of silently widening the allowance. */
function scrubBlockSpan(lines) {
  const start = lines.findIndex((l) => l.includes("FaceTime is Apple's product"));
  const end = lines.findIndex((l) => l.includes('[cleanup] CCBill readiness scrub'));
  assert.ok(start > 0, 'scrub block start anchor present');
  assert.ok(end > start, 'scrub block end anchor present');
  return [Math.max(0, start - 6), end + 6];
}

function strayHits(src, label) {
  const lines = src.split('\n');
  const span = label === 'server.js' ? scrubBlockSpan(lines) : null;
  const hits = [];
  lines.forEach((line, i) => {
    if (!/facetime/i.test(line)) return;
    if (span && i >= span[0] && i <= span[1]) return;
    if (INTERNAL_TOKENS.some((tok) => line.includes(tok))) return;
    hits.push(`${label}:${i + 1}: ${line.trim().slice(0, 120)}`);
  });
  return hits;
}

test('rename: no user-facing "FaceTime" left in server.js', () => {
  assert.deepEqual(strayHits(SERVER_JS, 'server.js'), []);
});

test('rename: no user-facing "FaceTime" left in the client bundle (app.js)', () => {
  assert.deepEqual(strayHits(APP_JS, 'app.js'), []);
});

test('rename: no user-facing "FaceTime" left in styles.css', () => {
  assert.deepEqual(strayHits(STYLES_CSS, 'styles.css'), []);
});

test('rename: the new copy is present (server bells, guide, agreement)', () => {
  for (const s of [
    '📹 Video call request',
    '{fan} wants a {min}-min video call with you',
    '📹 VIDEO CALLS — private video by the minute',
    'the Video Call Waiting List',
    "'Video call never started — refunded'",
    'Solicitud de videollamada',
    '📹 Görüntülü arama isteği',
  ]) assert.ok(SERVER_JS.includes(s), `server copy present: ${s}`);
});

test('rename: the new copy is present (client STR + UI strings)', () => {
  for (const s of [
    '{name} wants a video call — {min} min · {amount}',
    'Your video call line',
    'Video call request sent 📹',
    '⏳ In your video call line — #{pos}',
    '영상 통화를 원합니다',
    '🔴 In videochiamata ora',
  ]) assert.ok(APP_JS.includes(s), `client copy present: ${s}`);
});

test('rename: both shipped JS files parse', () => {
  const vm = require('node:vm');
  assert.doesNotThrow(() => new vm.Script(SERVER_JS), 'server.js parses');
  assert.doesNotThrow(() => new vm.Script(APP_JS), 'app.js parses');
});
