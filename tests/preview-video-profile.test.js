'use strict';
/*
 * Preview video on her profile (owner request, Oct 17 2026): a model's
 * preview video (models.preview_video_url) already looped muted on
 * home tiles, but it never played on her profile, and the Settings
 * copy told her to "Keep it SFW" — which is part of why NO model had
 * uploaded one. The owner wants the preview connected to her PROFILE:
 * a fan opening her profile sees it playing, taps it and the sound
 * comes on ("a preview of them talking... whatever they want for a
 * few seconds") — explicit explicitly allowed on this in-app surface.
 *
 * The fix touches the ONE profile peek the app has — openModelPeek in
 * public/js/app.js (shared by the fan directory, the lives list and
 * fan-preview mode; there is no separate guest peek — guests go
 * straight to chat). When preview_video_url is set, her video renders
 * as the peek's hero (autoplay, muted, loop, playsinline) with a 🔊
 * sound pill; tapping toggles sound, unmuting restarts from 0 so her
 * spoken hook is heard from the top. No video → the peek renders
 * exactly as before. Settings copy drops the SFW restriction.
 *
 * Static source pins (suite convention for client behaviour — no DOM
 * harness exists): the hero + tap handler, the i18n pill keys in
 * en/es/pt, the new Settings guidance, and the hero CSS.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(REPO, 'public/js/app.js'), 'utf8');
const css = fs.readFileSync(path.join(REPO, 'public/css/styles.css'), 'utf8');

// openModelPeek only (bounded by vFanModels after it).
const pStart = app.indexOf('function openModelPeek(');
const pEnd = app.indexOf('async function vFanModels()', pStart);
assert.ok(pStart !== -1 && pEnd > pStart, 'openModelPeek located in app.js');
const peek = app.slice(pStart, pEnd);

test('peek renders the preview video as hero media when preview_video_url is set', () => {
  assert.ok(peek.includes('${m.preview_video_url ?'), 'hero is conditional on preview_video_url');
  assert.ok(peek.includes('class="peek-hero"'), 'hero wrapper rendered');
  const v = peek.match(/<video[^>]*data-peek-video[^>]*>/);
  assert.ok(v, 'hero video element present');
  for (const attr of ['autoplay', 'muted', 'loop', 'playsinline']) {
    assert.ok(v[0].includes(attr), `hero video carries ${attr}`);
  }
  assert.ok(v[0].includes('src="${esc(m.preview_video_url)}"'), 'hero video src is her preview_video_url');
  // The sound pill rides the hero.
  assert.ok(peek.includes('data-peek-sound'), 'sound pill rendered');
  assert.ok(peek.includes("t('tap_for_sound')"), 'pill label is i18n-keyed');
});

test('peek with no preview video renders exactly as before (avatar hero only)', () => {
  // The hero block is a ternary: the else branch is empty and the
  // original centred avatar block follows it unchanged.
  const heroAt = peek.indexOf('${m.preview_video_url ?');
  const avatarAt = peek.indexOf("avatarHTML(m.display_name, 'xl', m.photo_url)", heroAt);
  assert.ok(avatarAt > heroAt, 'avatar block still follows the conditional hero');
  assert.ok(peek.slice(heroAt, avatarAt).includes("` : ''}"), 'ternary closes to empty when unset');
});

test('peek tap toggles sound: unmute restarts from the beginning, re-tap re-mutes', () => {
  assert.ok(peek.includes("sheet.querySelector('[data-peek-video]')"), 'handler finds the hero video');
  assert.ok(peek.includes('pv.muted = false'), 'tap unmutes');
  assert.ok(peek.includes('pv.currentTime = 0'), 'unmute restarts from 0 (spoken hook from the top)');
  assert.ok(peek.includes('pv.muted = true'), 'second tap re-mutes');
  assert.ok(peek.includes('pv.onclick = togglePeekSound'), 'video tap wired');
  assert.ok(peek.includes('pill.onclick = togglePeekSound'), 'pill tap wired to the same toggle');
  assert.ok(peek.includes("t('tap_to_mute')"), 'pill mirrors state via i18n');
});

test('sound pill i18n keys exist in en, es and pt', () => {
  assert.ok(app.includes("tap_for_sound: 'Tap for sound'"), 'en tap_for_sound');
  assert.ok(app.includes("tap_to_mute: 'Tap to mute'"), 'en tap_to_mute');
  assert.ok(app.includes("tap_for_sound: 'Toca para escuchar'"), 'es tap_for_sound');
  assert.ok(app.includes("tap_to_mute: 'Toca para silenciar'"), 'es tap_to_mute');
  assert.ok(app.includes("tap_for_sound: 'Toque para ouvir'"), 'pt tap_for_sound');
  assert.ok(app.includes("tap_to_mute: 'Toque para silenciar'"), 'pt tap_to_mute');
});

test('peek hero CSS exists (full-width cover video + sound pill)', () => {
  assert.ok(css.includes('.peek-hero-video'), 'hero video class styled');
  assert.ok(css.includes('.peek-sound-pill'), 'sound pill styled');
  const block = css.slice(css.indexOf('.peek-hero-video'), css.indexOf('.peek-sound-pill'));
  assert.ok(block.includes('object-fit: cover'), 'hero video covers its frame');
});

test('Settings copy: SFW restriction gone, app-only explicit-allowed guidance in', () => {
  assert.ok(!app.includes('Keep it SFW'), 'SFW restriction removed from Settings');
  assert.ok(app.includes('plays on your home tile and on your profile'), 'copy names tile + profile');
  assert.ok(app.includes('as wild as you like: talking, teasing, explicit'), 'explicit explicitly allowed');
  assert.ok(app.includes('never on Google or your public page'), 'app-only promise stated');
  assert.ok(app.includes('Everything after it stays paid'), 'free-hook / paid-rest framing kept');
  assert.ok(app.includes('Under 15MB'), 'size cap still stated');
  // Upload/remove behaviour untouched.
  assert.ok(app.includes('id="s-preview-video"'), 'preview upload button still wired');
  assert.ok(app.includes('id="s-preview-remove"'), 'preview remove button still wired');
});

test('home tile preview rendering untouched (still the muted tile loop)', () => {
  assert.ok(app.includes('`<video class="tile-media" src="${esc(m.preview_video_url)}" autoplay muted loop playsinline></video>`'),
    'home tile media unchanged');
});
