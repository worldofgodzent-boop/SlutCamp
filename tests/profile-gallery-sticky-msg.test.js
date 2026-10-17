'use strict';
/*
 * Fan profile page: gallery + always-visible Message bar (owner
 * request, Oct 17 2026): "When you get to the page and see the model,
 * I want the fans to be able to click the profile, then they get to
 * see a couple picture and a couple videos. In that page, while they
 * scroll, I want the option to message that model to be available at
 * all times."
 *
 * Before: a fan tapping a model tile went STRAIGHT into a chat — the
 * only profile card (openModelPeek) was look-only and shown to model
 * viewers / fan-preview. Now a fan's tile tap (home grid + lives
 * list; live tiles still join the stream) opens her profile page:
 * the preview-video hero she already had, a gallery of her profile
 * pictures, and a Message bar pinned to the bottom of the sheet that
 * stays visible while the page scrolls and opens her chat via the
 * existing openChatWithModel path (3-free-texts + per-message price
 * rules live there and in the chat screen).
 *
 * Gallery composition was refined by the follow-up build (owner,
 * same day: "I don't want this to be Instagram" — up to 10 pictures
 * and exactly two main videos): the gallery is her main photo plus
 * her gallery uploads (the clean public photo stays on the Google
 * pages only), and her second video renders in the scroll region.
 * Those pins live in tests/profile-media-gallery.test.js; the two
 * gallery pins below were updated to the refined composition.
 *
 * The bar is a fan action only: models browsing a sister stay
 * look-only, the model herself never gets one (isMe), and the admin's
 * fan-preview sees the bar but tapping it gets the preview toast
 * instead of a real conversation.
 *
 * Static source pins (suite convention for client behaviour).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(REPO, 'public/js/app.js'), 'utf8');
const css = fs.readFileSync(path.join(REPO, 'public/css/styles.css'), 'utf8');
const server = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');

const pStart = app.indexOf('function openModelPeek(');
const pEnd = app.indexOf('async function vFanModels()', pStart);
assert.ok(pStart !== -1 && pEnd > pStart, 'openModelPeek located in app.js');
const peek = app.slice(pStart, pEnd);

test('directory payload carries her photos and preview video fields', () => {
  const at = server.indexOf("app.get('/api/models'");
  assert.ok(at !== -1, '/api/models route located');
  const route = server.slice(at, at + 1600);
  assert.ok(route.includes('m.public_photo_url'), 'SELECT includes public_photo_url');
  assert.ok(route.includes('m.photo_url'), 'SELECT still includes photo_url');
  assert.ok(route.includes('m.preview_video_url'), 'SELECT still includes preview_video_url');
});

test('peek gallery: her main photo + gallery uploads, deduped, capped at 10', () => {
  assert.ok(peek.includes('const galleryPics = [...new Set([m.photo_url, ...(Array.isArray(m.gallery_photos) ? m.gallery_photos : [])].filter(Boolean))].slice(0, 10);'),
    'gallery built from photo_url + gallery_photos, deduped, capped at 10');
  assert.ok(peek.includes('${galleryPics.length ?'), 'gallery renders only when she has pictures');
  assert.ok(peek.includes('class="peek-gallery"'), 'gallery wrapper rendered');
  assert.ok(peek.includes('class="peek-gallery-img"'), 'gallery images rendered');
  assert.ok(peek.includes('src="${esc(p)}"'), 'gallery image src is escaped');
});

test('peek page scrolls in .peek-scroll; the Message bar sits outside it (always visible)', () => {
  assert.ok(peek.includes('<div class="peek-scroll">'), 'scroll region opens the peek');
  const scrollAt = peek.indexOf('<div class="peek-scroll">');
  const barAt = peek.indexOf('class="peek-msgbar"');
  assert.ok(barAt > scrollAt, 'message bar renders after/outside the scroll region');
  assert.ok(peek.includes("panel.classList.add('peek-sheet')"), 'panel switched to the flex-column peek layout');
});

test('sticky Message bar: fan-only, never for herself, label is i18n + her per-message price', () => {
  assert.ok(peek.includes("const showMsgBar = !isMe && !!S.user && (S.user.role === 'fan' || isFanPreview());"),
    'bar gated to fans / fan-preview, never isMe, never model viewers');
  assert.ok(peek.includes('${showMsgBar ?'), 'bar renders conditionally');
  assert.ok(peek.includes('data-peek-msg="${m.id}"'), 'button carries her model id');
  assert.ok(peek.includes("t('msg_her_btn')"), 'button label is i18n-keyed');
  assert.ok(peek.includes("t('per_msg_rate', { price: fmt(m.per_message_cents) })"),
    'button shows her per-message price via the existing rate key');
});

test('Message bar tap opens her chat through the existing path; preview gets the toast', () => {
  assert.ok(peek.includes("sheet.querySelector('[data-peek-msg]')"), 'handler finds the bar button');
  assert.ok(peek.includes('parseInt(msgBtn.dataset.peekMsg)'), 'handler reads the model id off the button');
  assert.ok(peek.includes('sheet.remove();'), 'sheet closes before the chat opens');
  assert.ok(peek.includes('openChatWithModel(id);'), 'chat opens via the existing openChatWithModel path');
  assert.ok(peek.includes("if (isFanPreview()) { toast('👁 Preview mode — messaging is fan-only'); return; }"),
    'fan-preview sees the bar but cannot start a real conversation');
});

test('msg_her_btn i18n key exists in all 13 language tables', () => {
  const hits = app.match(/msg_her_btn: '/g) || [];
  assert.equal(hits.length, 13, 'one msg_her_btn per language');
  assert.ok(app.includes("msg_her_btn: '💬 Message her'"), 'en label present');
});

test('fan tile taps land on her profile first (home grid + lives); live still joins the stream', () => {
  const home = app.slice(app.indexOf('async function vFanModels()'), app.indexOf('async function vFanChats()'));
  assert.ok(home.includes("if (S.user && S.user.role === 'fan')"), 'home grid routes fans to the profile');
  assert.ok(home.includes('if (m) { openModelPeek(m, models); return; }'), 'home fan tap opens the peek');
  assert.ok(home.includes('if (liveId) return watchLive(parseInt(liveId));'), 'home live tiles unchanged');
  const lives = app.slice(app.indexOf('async function vLives()'), app.indexOf('async function vChatList('));
  assert.ok(lives.includes("if (S.user && S.user.role === 'fan')"), 'lives list routes fans to the profile');
  assert.ok(lives.includes('if (m) { openModelPeek(m, models); return; }'), 'lives fan tap opens the peek');
  assert.ok(lives.includes('if (liveId) return watchLive(parseInt(liveId));'), 'lives live tiles unchanged');
});

test('profile page CSS: flex-column sheet, scroll region, pinned bar, gallery grid', () => {
  const rule = (sel) => {
    const m = css.match(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}'));
    return m ? m[1] : '';
  };
  const sheetBlock = rule('.sheet.peek-sheet');
  assert.ok(sheetBlock, 'peek sheet variant styled');
  assert.ok(sheetBlock.includes('flex-direction: column'), 'peek sheet is a column flex');
  assert.ok(sheetBlock.includes('overflow: hidden'), 'sheet itself no longer scrolls (the inner region does)');
  assert.ok(rule('.peek-scroll').includes('overflow-y: auto'), 'peek page scrolls inside .peek-scroll');
  assert.ok(rule('.peek-gallery').includes('grid'), 'gallery is a grid');
  assert.ok(rule('.peek-gallery-img').includes('object-fit: cover'), 'gallery images cover their tiles');
  assert.ok(rule('.peek-msgbar').includes('flex: 0 0 auto'), 'message bar is pinned (never scrolls away, never shrinks)');
  assert.ok(rule('.peek-msg-btn').includes('width: 100%'), 'message button styled full-width');
});
