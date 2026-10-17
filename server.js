/*
 * SlutCamp — server.js
 * Fan-to-model paid chat platform. World of Godz Entertainment LLC.
 *
 * Stack: Express (REST) + ws (WebSocket realtime) + node:sqlite (built-in).
 * Money is ALWAYS stored in integer cents. 1 credit = $1 = 100 cents.
 *
 * Key flows:
 *  - Guests browse models free, get 3 FREE messages per model, then hit paywall.
 *  - Fans pay per message ($1.49 default) / per video-call minute ($3.99 default).
 *  - Safety monitor scans every message for off-platform contact keywords.
 *    On hit: message blocked, chat paused, incident logged, strikes counted.
 *
 * Run:  npm install && npm start   →  http://localhost:3000
 */
'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { DatabaseSync } = require('node:sqlite');
const { WebSocketServer } = require('ws');
const { transcribeAudio } = require('./lib/transcribe');
const geoLib = require('./lib/geo');
const shieldLib = require('./lib/shield');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 3000;

/* ------------------------------------------------------------------ */
/* Forced refresh on every deploy (Asce's rule, 2026-10-16): nobody    */
/* sits on a stale build — users are lazy and will not refresh         */
/* themselves, not even for a login-gated update. Two halves:          */
/*                                                                     */
/*  1. The service worker's cache name is stamped PER DEPLOY. sw.js    */
/*     carries a '__BUILD__' placeholder; the /sw.js route below        */
/*     replaces it with BUILD_ID, so every deploy serves a             */
/*     byte-different worker under a brand-new cache name. The new     */
/*     worker skipWaiting()s, and its activate handler deletes every   */
/*     cache that is not its own — a full flush on every phone,        */
/*     with zero manual cache-bump edits.                              */
/*  2. GET /api/build-id lets an already-open app notice the deploy:   */
/*     app.js polls it and reloads itself the moment it is idle        */
/*     (never mid-call, mid-live, mid-purchase, or mid-typing).        */
/*                                                                     */
/* BUILD_ID resolution, first hit wins: RENDER_GIT_COMMIT (Render      */
/* injects it into build AND runtime), else `git rev-parse` against    */
/* this checkout, else null. Every step is guarded: a failure here     */
/* must NEVER break boot — it only ever degrades the cache name to     */
/* the static 'slutcamp-v4' fallback (the pre-automation behavior).    */
/* ------------------------------------------------------------------ */
function resolveBuildId() {
  try {
    const fromEnv = String(process.env.RENDER_GIT_COMMIT || '').trim();
    if (fromEnv) return fromEnv.slice(0, 12);
  } catch (e) { /* fall through to git */ }
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'],
      { cwd: __dirname, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
    if (out) return out;
  } catch (e) { /* no git / no checkout — fall through to null */ }
  return null;
}
let BUILD_ID = null;
try { BUILD_ID = resolveBuildId(); } catch (e) { BUILD_ID = null; }
const BUILD_TIME = new Date().toISOString();
const SW_CACHE_NAME = BUILD_ID ? `slutcamp-${BUILD_ID}` : 'slutcamp-v4';
if (BUILD_ID) console.log(`[build] deploy build id: ${BUILD_ID} (sw cache: ${SW_CACHE_NAME})`);
else console.warn('[build] ⚠️  no build id available (no RENDER_GIT_COMMIT, no git) — sw cache stays ' + SW_CACHE_NAME);

/* ---- W-9 tax-ID encryption (AES-256-GCM) ---- */
// TAX_ENC_KEY is hashed to 32 bytes. If unset, we generate an EPHEMERAL key and
// warn loudly: encrypted rows can't be decrypted after a restart without the key.
// Set TAX_ENC_KEY on Render (long random string) and back it up in the Secure Vault.
let _taxKey = null, _taxKeyEphemeral = false;
function taxKey() {
  if (_taxKey) return _taxKey;
  const raw = process.env.TAX_ENC_KEY || '';
  if (raw) {
    _taxKey = crypto.createHash('sha256').update(raw, 'utf8').digest();
  } else {
    _taxKey = crypto.randomBytes(32);
    _taxKeyEphemeral = true;
    console.warn('[TAX] ⚠️  TAX_ENC_KEY is not set — using an EPHEMERAL encryption key. ' +
      'Tax IDs submitted now will be UNREADABLE after the next server restart. ' +
      'Set TAX_ENC_KEY env var to a long random string and back it up.');
  }
  return _taxKey;
}
function encTax(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', taxKey(), iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), ct.toString('base64'), tag.toString('base64')].join(':');
}
function decTax(stored) {
  if (!stored) return '';
  const parts = String(stored).split(':');
  if (parts.length !== 3) throw new Error('tax_decrypt_bad_format');
  const d = crypto.createDecipheriv('aes-256-gcm', taxKey(), Buffer.from(parts[0], 'base64'));
  d.setAuthTag(Buffer.from(parts[2], 'base64'));
  return Buffer.concat([d.update(Buffer.from(parts[1], 'base64')), d.final()]).toString('utf8');
}
function taxKeyIsEphemeral() { taxKey(); return _taxKeyEphemeral; }

app.use(express.json({ limit: '256kb' }));

/* ------------------------------------------------------------------ */
/* Invite link previews — an invite link must say WHICH kind it is    */
/* before anyone taps it. Chat apps (iMessage, X, WhatsApp) build     */
/* the preview from the served <title>/OG tags, and both invite       */
/* kinds used to serve the generic homepage tags — the owner once     */
/* sent a model invite to someone meant to be an affiliate because    */
/* the links looked identical (Oct 15). So the two invite URL forms   */
/* get their own tags injected at serve time:                         */
/*   GET /?invite=<code>    → "Your Model Invite" tags                */
/*   GET /affiliate/<code>  → "SlutCamp Affiliate" tags               */
/* Everything else falls through to the static shell, byte-for-byte   */
/* untouched. The affiliate path form also gets a one-line shim that  */
/* moves the code into the #affiliate/<code> hash the client router   */
/* reads, so it lands on the affiliate signup exactly like the hash   */
/* link the Manager generates.                                        */
/* ------------------------------------------------------------------ */
const INDEX_HTML_PATH = path.join(__dirname, 'public', 'index.html');
let _indexCache = { mtimeMs: 0, html: '' };
function indexHtml() {
  const st = fs.statSync(INDEX_HTML_PATH);
  if (st.mtimeMs !== _indexCache.mtimeMs) {
    _indexCache = { mtimeMs: st.mtimeMs, html: fs.readFileSync(INDEX_HTML_PATH, 'utf8') };
  }
  return _indexCache.html;
}
function inviteMeta(html, meta) {
  let out = html
    .replace(/<title>[^<]*<\/title>/, '<title>' + meta.title + '</title>')
    .replace(/(<meta name="description" content=")[^"]*(")/, '$1' + meta.desc + '$2')
    .replace(/(<meta property="og:title" content=")[^"]*(")/, '$1' + meta.title + '$2')
    .replace(/(<meta property="og:description" content=")[^"]*(")/, '$1' + meta.desc + '$2')
    .replace(/(<meta property="og:url" content=")[^"]*(")/, '$1' + meta.url + '$2')
    .replace(/(<meta name="twitter:title" content=")[^"]*(")/, '$1' + meta.title + '$2')
    .replace(/(<meta name="twitter:description" content=")[^"]*(")/, '$1' + meta.desc + '$2');
  if (meta.shim) out = out.replace('<script src="/js/app.js', meta.shim + '\n<script src="/js/app.js');
  return out;
}
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  const aff = req.path.match(/^\/affiliate\/([a-f0-9]{18})$/);
  if (aff) {
    const code = aff[1];
    const html = inviteMeta(indexHtml(), {
      title: "SlutCamp Affiliate — You're invited to earn 20%",
      desc: "You've been invited to join the SlutCamp affiliate program. Recruit models with your personal link and earn 20% of everything they make. Open your invite to get started.",
      url: 'https://slutcamp.app/affiliate/' + code,
      shim: "<script>try{history.replaceState({},'','/#affiliate/" + code + "')}catch(e){}</script>",
    });
    return res.type('html').set('Cache-Control', 'public, max-age=0').send(html);
  }
  if (req.path === '/' && /^[a-f0-9]{18}$/.test(String(req.query.invite || ''))) {
    const code = String(req.query.invite);
    const html = inviteMeta(indexHtml(), {
      title: 'SlutCamp — Your Model Invite 💋',
      desc: 'Your personal invite to join SlutCamp as a model. Create your model account, go live, chat with fans, and keep 60% of everything you earn. Open your invite to claim it.',
      url: 'https://slutcamp.app/?invite=' + code,
    });
    return res.type('html').set('Cache-Control', 'public, max-age=0').send(html);
  }
  return next();
});

/* /sw.js is the ONE file the static middleware must not serve verbatim:
   stamp the '__BUILD__' placeholder in the cache name with this deploy's
   build id, so the worker (and its cache) is new on every deploy — the
   forced-refresh mechanism described at resolveBuildId() above.
   Registered BEFORE express.static so it wins for /sw.js. 'no-cache'
   makes browsers revalidate the worker script promptly instead of
   sitting on the HTTP cache. Any failure falls back to sendFile of the
   raw worker (token unstamped) — degraded, never broken. */
let _swSource = null;
app.get('/sw.js', (req, res) => {
  const swPath = path.join(__dirname, 'public', 'sw.js');
  try {
    if (_swSource === null) _swSource = fs.readFileSync(swPath, 'utf8');
    return res.type('application/javascript')
      .set('Cache-Control', 'no-cache')
      .send(_swSource.split('__BUILD__').join(BUILD_ID || 'v4'));
  } catch (err) {
    console.error('[sw] dynamic /sw.js failed, serving raw file:', err.message);
    _swSource = null;
    return res.sendFile(swPath);
  }
});

/* ------------------------------------------------------------------ */
/* Public SEO pages (owner, Oct 16 2026). The app is a single-page    */
/* shell, so Google used to see exactly ONE page — the homepage.      */
/* Fans search model names; these server-rendered pages give every    */
/* public model a real, crawlable page of her own, plus a models      */
/* index, tag hubs, a model-recruiting page, and a DYNAMIC sitemap    */
/* that grows/shrinks with the roster automatically.                  */
/*                                                                    */
/* Registered BEFORE express.static (same reason as /sw.js above):    */
/* the dynamic /sitemap.xml must beat the static file, and these      */
/* paths must beat the SPA fallback at the bottom of this file.       */
/*                                                                    */
/* Visibility mirrors GET /api/models exactly at the row level:       */
/* role='model' AND banned=0 AND models.is_hidden=0. (The API also    */
/* applies per-viewer region blocking; a public page has no viewer    */
/* region, so the canonical roster is what crawlers get.) Nothing     */
/* explicit lives here — her separate CLEAN public photo only (never   */
/* the in-app storefront photo, which may be explicit by design), and  */
/* no gallery/PPV/media.                                              */
/* Every model-supplied string is HTML-escaped: names and bios are    */
/* user input, and these pages are public.                            */
/* ------------------------------------------------------------------ */
const SEO_ORIGIN = 'https://slutcamp.app';
const seoEsc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const seoMoney = (cents) => '$' + ((Number(cents) || 0) / 100).toFixed(2);
const seoDesc = (bio, name) => {
  const clean = String(bio || '').replace(/\s+/g, ' ').trim();
  if (!clean) return `${name} is a model on SlutCamp — chat, live shows and private video calls. Join free and meet her live.`;
  if (clean.length <= 160) return clean;
  const cut = clean.slice(0, 157);
  const at = cut.lastIndexOf(' ');
  return (at > 60 ? cut.slice(0, at) : cut) + '…';
};
// The public roster, shaped for the SEO pages. One query, same
// ordering + rank positions as GET /api/models (minus the featured
// float: rank_position is the TRUE composite position there too).
function seoPublicModels() {
  const rows = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.presence_override, u.created_at,
           m.bio, m.per_message_cents, m.public_photo_url, m.tags, m.is_featured, m.is_online,
           ls.id AS live_session_id
    FROM users u JOIN models m ON m.user_id = u.id
    LEFT JOIN live_sessions ls ON ls.model_id = u.id AND ls.status = 'live'
    WHERE u.role = 'model' AND u.banned = 0 AND m.is_hidden = 0
    ORDER BY m.is_featured DESC, m.rank_score DESC,
             (SELECT COUNT(*) FROM model_likes WHERE model_id = u.id) DESC,
             (CASE u.presence_override WHEN 'on' THEN 1 WHEN 'off' THEN 0 ELSE m.is_online END) DESC,
             u.created_at DESC, u.display_name ASC
  `).all();
  const rankOrder = db.prepare(`
    SELECT u.id FROM users u JOIN models m ON m.user_id = u.id
    WHERE u.role = 'model' AND u.banned = 0 AND m.is_hidden = 0
    ORDER BY m.rank_score DESC,
             (SELECT COUNT(*) FROM model_likes WHERE model_id = u.id) DESC,
             (CASE u.presence_override WHEN 'on' THEN 1 WHEN 'off' THEN 0 ELSE m.is_online END) DESC,
             u.created_at DESC, u.display_name ASC
  `).all();
  const rankPos = new Map(rankOrder.map((r, i) => [r.id, i + 1]));
  return rows.map((r) => ({
    id: r.id,
    username: r.username,
    display_name: r.display_name,
    bio: r.bio || '',
    per_message_cents: r.per_message_cents,
    public_photo_url: r.public_photo_url || '',
    tags: parseModelTags(r.tags),
    is_online: effectiveOnline(r.presence_override, r.is_online),
    is_live: !!r.live_session_id,
    rank_position: rankPos.get(r.id) || null,
    url: '/models/' + encodeURIComponent(r.username),
    photo_abs: r.public_photo_url ? SEO_ORIGIN + r.public_photo_url : SEO_ORIGIN + '/img/lips-logo.png',
  }));
}
const seoTagSlug = (tag) => tag.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
function seoLiveTags(models) {
  const used = new Set();
  for (const m of models) for (const t of m.tags) used.add(t);
  return MODEL_TAGS.filter((t) => used.has(t));
}
const SEO_CSS = `
  * { box-sizing: border-box; }
  body { margin:0; background:#1a0d18; color:#f5eef4; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; }
  a { color:#ff5c9e; }
  .wrap { max-width:860px; margin:0 auto; padding:20px 16px 56px; }
  .brand { font-size:26px; font-weight:800; letter-spacing:.3px; }
  .brand a { color:#f5eef4; text-decoration:none; }
  .brand .camp { background:linear-gradient(135deg,#8b5cf6,#ff5c9e); -webkit-background-clip:text; background-clip:text; color:transparent; }
  .age { display:inline-block; margin-left:8px; padding:2px 8px; border:1px solid #ff5c9e; border-radius:999px; color:#ff5c9e; font-size:12px; font-weight:700; vertical-align:middle; }
  .hero { text-align:center; padding:28px 0 8px; }
  .hero img.photo { width:220px; height:220px; object-fit:cover; border-radius:24px; border:3px solid #8b5cf6; }
  h1 { font-size:30px; margin:16px 0 4px; }
  .uname { color:#c9a8c4; margin:0 0 10px; }
  .status { font-weight:700; margin:6px 0; }
  .status .live { color:#ff5c6e; } .status .on { color:#4ade80; } .status .off { color:#9c8a99; }
  .rank { display:inline-block; background:linear-gradient(135deg,#8b5cf6,#ff5c9e); color:#fff; font-weight:800; padding:4px 12px; border-radius:999px; font-size:14px; }
  .bio { font-size:17px; line-height:1.55; color:#ead9e8; white-space:pre-wrap; max-width:640px; margin:14px auto; text-align:left; }
  .tags { margin:12px 0; } .tags a { display:inline-block; margin:3px; padding:5px 12px; border:1px solid #8b5cf6; border-radius:999px; text-decoration:none; font-size:14px; }
  .price { font-size:18px; margin:10px 0; }
  .cta { display:inline-block; margin-top:16px; background:linear-gradient(135deg,#8b5cf6,#ff5c9e); color:#fff; font-weight:800; font-size:18px; padding:14px 34px; border-radius:999px; text-decoration:none; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:14px; margin-top:20px; }
  .card { background:#241019; border-radius:16px; overflow:hidden; text-decoration:none; color:#f5eef4; display:block; }
  .card img { width:100%; height:170px; object-fit:cover; display:block; background:#2c1522; }
  .card .pad { padding:10px 12px; } .card .nm { font-weight:700; } .card .un { color:#c9a8c4; font-size:13px; }
  .card .st { font-size:13px; font-weight:700; margin-top:4px; }
  .pitch { font-size:17px; line-height:1.6; color:#ead9e8; }
  .pitch li { margin:10px 0; }
  .pitch h2 { font-size:22px; margin:28px 0 8px; color:#f5eef4; }
  .pitch ol li { margin:10px 0; }
  footer { margin-top:44px; text-align:center; color:#9c8a99; font-size:13px; }
`;
function seoHead({ title, desc, url, image }) {
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'ProfilePage',
    mainEntity: { '@type': 'Person', name: title, url, image },
    url,
  };
  return `<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${seoEsc(title)}</title>
<meta name="description" content="${seoEsc(desc)}">
<meta name="robots" content="index, follow">
<meta name="rating" content="adult">
<meta name="rating" content="RTA-5042-1996-1400-1577-RTA">
<link rel="canonical" href="${seoEsc(url)}">
<link rel="icon" type="image/png" href="/img/lips-logo.png">
<meta property="og:type" content="profile">
<meta property="og:site_name" content="SlutCamp">
<meta property="og:title" content="${seoEsc(title)}">
<meta property="og:description" content="${seoEsc(desc)}">
<meta property="og:url" content="${seoEsc(url)}">
<meta property="og:image" content="${seoEsc(image || (SEO_ORIGIN + '/img/lips-logo.png'))}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${seoEsc(title)}">
<meta name="twitter:description" content="${seoEsc(desc)}">
<meta name="twitter:image" content="${seoEsc(image || (SEO_ORIGIN + '/img/lips-logo.png'))}">
<meta name="theme-color" content="#150b26">
<script type="application/ld+json">${JSON.stringify(ld).replace(/<\//g, '<\\/')}</script>
<style>${SEO_CSS}</style>`;
}
function seoStatus(m) {
  if (m.is_live) return '<span class="live">🔴 Live now</span>';
  if (m.is_online) return '<span class="on">🟢 Online now</span>';
  return '<span class="off">⚪ Offline</span>';
}
function seoModelCard(m) {
  const img = m.public_photo_url
    ? `<img src="${seoEsc(m.public_photo_url)}" alt="${seoEsc(m.display_name)}" loading="lazy">`
    : `<img src="/img/lips-logo.png" alt="${seoEsc(m.display_name)}" loading="lazy">`;
  return `<a class="card" href="${seoEsc(m.url)}">${img}<div class="pad">
    <div class="nm">${seoEsc(m.display_name)}</div>
    <div class="un">@${seoEsc(m.username)}</div>
    <div class="st">${seoStatus(m)}</div>
    <div class="un">${seoMoney(m.per_message_cents)} / message</div>
  </div></a>`;
}
const seoBrand = `<div class="brand"><a href="/">Slut<span class="camp">Camp</span></a><span class="age">18+</span></div>`;
const seoFooter = `<footer>SlutCamp is an 18+ platform. You must be of legal age in your location to use it.<br><a href="/models">All models</a> · <a href="/join">Become a model</a> · <a href="/">Open the app</a></footer>`;

// GET /models/:username — her public, crawlable page.
app.get('/models/:username', (req, res) => {
  const models = seoPublicModels();
  const want = String(req.params.username || '').toLowerCase();
  const m = models.find((x) => x.username.toLowerCase() === want);
  if (!m) {
    return res.status(404).type('html').set('Cache-Control', 'public, max-age=300')
      .send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Model not found — SlutCamp</title><meta name="robots" content="noindex"></head><body style="background:#1a0d18;color:#f5eef4;font-family:sans-serif;text-align:center;padding:60px 20px"><h1>Model not found</h1><p>That profile isn't public. <a href="/models" style="color:#ff5c9e">Browse all models</a></p></body></html>`);
  }
  const url = SEO_ORIGIN + m.url;
  const title = `${m.display_name} (@${m.username}) on SlutCamp`;
  const desc = seoDesc(m.bio, m.display_name);
  const tagsHtml = m.tags.length
    ? `<div class="tags">${m.tags.map((t) => `<a href="/tags/${seoTagSlug(t)}">${seoEsc(t)}</a>`).join('')}</div>` : '';
  const rankHtml = m.rank_position && m.rank_position <= 10
    ? `<div><span class="rank">🏆 Ranked #${m.rank_position} on SlutCamp</span></div>` : '';
  const photoHtml = m.public_photo_url
    ? `<img class="photo" src="${seoEsc(m.public_photo_url)}" alt="${seoEsc(m.display_name)} on SlutCamp">`
    : `<img class="photo" src="/img/lips-logo.png" alt="${seoEsc(m.display_name)} on SlutCamp">`;
  res.type('html').set('Cache-Control', 'public, max-age=300').send(`<!DOCTYPE html>
<html lang="en">
<head>${seoHead({ title, desc, url, image: m.photo_abs })}</head>
<body><div class="wrap">
${seoBrand}
<div class="hero">
  ${photoHtml}
  <h1>${seoEsc(m.display_name)}</h1>
  <p class="uname">@${seoEsc(m.username)}</p>
  ${rankHtml}
  <p class="status">${seoStatus(m)}</p>
  <p class="price">💬 Messages from ${seoMoney(m.per_message_cents)}</p>
  ${tagsHtml}
  <div><a class="cta" href="/">💋 Chat with her on SlutCamp</a></div>
</div>
${m.bio ? `<p class="bio">${seoEsc(m.bio)}</p>` : ''}
${seoFooter}
</div></body></html>`);
});

// GET /models — the crawlable hub every other page points to.
app.get('/models', (req, res) => {
  const models = seoPublicModels();
  const url = SEO_ORIGIN + '/models';
  res.type('html').set('Cache-Control', 'public, max-age=300').send(`<!DOCTYPE html>
<html lang="en">
<head>${seoHead({ title: 'Models on SlutCamp — Live Chat & Private Video | 18+', desc: 'Browse every model on SlutCamp: live shows, private chat and one-on-one video calls. Join free and meet them live.', url })}</head>
<body><div class="wrap">
${seoBrand}
<h1>Models on SlutCamp</h1>
<p class="pitch">Live shows, private chat and one-on-one video calls with independent models. Join free — chat with her in the app.</p>
<div class="grid">${models.map(seoModelCard).join('\n')}</div>
${seoFooter}
</div></body></html>`);
});

// GET /tags/:tag — hub for one Discovery tag (live tags only).
app.get('/tags/:tag', (req, res) => {
  const models = seoPublicModels();
  const live = seoLiveTags(models);
  const tag = live.find((t) => seoTagSlug(t) === String(req.params.tag || '').toLowerCase());
  if (!tag) return res.status(404).type('html').set('Cache-Control', 'public, max-age=300')
    .send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Tag not found — SlutCamp</title><meta name="robots" content="noindex"></head><body style="background:#1a0d18;color:#f5eef4;font-family:sans-serif;text-align:center;padding:60px 20px"><h1>Tag not found</h1><p><a href="/models" style="color:#ff5c9e">Browse all models</a></p></body></html>`);
  const tagged = models.filter((m) => m.tags.includes(tag));
  const url = SEO_ORIGIN + '/tags/' + seoTagSlug(tag);
  res.type('html').set('Cache-Control', 'public, max-age=300').send(`<!DOCTYPE html>
<html lang="en">
<head>${seoHead({ title: `${tag} models on SlutCamp | 18+`, desc: `Models tagged ${tag} on SlutCamp — live shows, private chat and video calls. Join free and meet them live.`, url })}</head>
<body><div class="wrap">
${seoBrand}
<h1>${seoEsc(tag)} models</h1>
<div class="grid">${tagged.map(seoModelCard).join('\n')}</div>
${seoFooter}
</div></body></html>`);
});

// GET /join — model recruiting, server-rendered. (EN-only v1: these
// public pages are EN, matching the homepage shell's SEO copy.)
app.get('/join', (req, res) => {
  const url = SEO_ORIGIN + '/join';
  res.type('html').set('Cache-Control', 'public, max-age=300').send(`<!DOCTYPE html>
<html lang="en">
<head>${seoHead({ title: 'Become a Model on SlutCamp — Keep 60% of What You Earn | 18+', desc: 'Join SlutCamp as a model: keep 60% of everything you earn, get discovered by fans inside the app, set your own prices, and sign in with Face ID.', url })}</head>
<body><div class="wrap">
${seoBrand}
<h1>Become a SlutCamp model 💋</h1>
<div class="pitch">
<p>SlutCamp is the creator platform built to be found. On the big platforms, nobody discovers you — you bring your own audience or you starve. Here, fans browse, search and filter the directory inside the app, and new models get their own spotlight rail. Your fans come to you.</p>
<ul>
  <li><strong>Keep 60% of everything you earn</strong> — chat, tips, gifts, calls, live shows, bookings. One split, no surprises.</li>
  <li><strong>Built-in discovery</strong> — searchable directory, tags, rankings and a New Models spotlight. Fans find you without you posting anywhere else.</li>
  <li><strong>Your earnings are protected</strong> — payouts run on a published weekly cycle, and chargeback handling is written into the Terms you sign, so a fan's bank dispute isn't handled on a whim. <a href="/payouts">Read our payout promise</a></li>
  <li><strong>Face ID sign-in</strong> — your account unlocks with your face. No password to leak, nothing biometric ever leaves your phone.</li>
  <li><strong>You set your prices</strong> — per-message, per-minute, live rates, games and bookings are yours to price and change anytime.</li>
  <li><strong>ID-verified community</strong> — every model is ID-verified before she can earn, and fans pay through one wallet: no subscription stacking, no games.</li>
</ul>
<p style="text-align:center"><a class="cta" href="/">Apply in the app — it's free</a></p>
<p>Applying takes a few minutes: create your model account, verify your ID, set your prices, and go live. You must be 18+ and able to work legally where you live.</p>
</div>
${seoFooter}
</div></body></html>`);
});

// GET /payouts — the published payout promise (owner, Oct 16 2026).
// A plain-language, PUBLIC summary of how models get paid, readable
// BEFORE signup. Every mechanic stated here is drawn from the shipped
// Model Agreement (v1.4: section 4 split, section 5 payouts, section
// 13 hold / chargeback order / fraud) — this page publishes the
// mechanics, nothing more: it deliberately does NOT promise that the
// platform absorbs chargebacks. The Agreement governs; the version
// below is pinned to MODEL_CONTRACT.version by tests so the page can
// never silently drift from the legal text it summarises.
app.get('/payouts', (req, res) => {
  const url = SEO_ORIGIN + '/payouts';
  res.type('html').set('Cache-Control', 'public, max-age=300').send(`<!DOCTYPE html>
<html lang="en">
<head>${seoHead({ title: 'How SlutCamp Pays Models — The Payout Promise | 18+', desc: 'How getting paid works on SlutCamp, in plain language: keep 60% of everything you earn, a 7-day (one-week) payout window, human-reviewed withdrawals, and exactly how chargebacks are handled — all written into the Model Agreement.', url })}</head>
<body><div class="wrap">
${seoBrand}
<h1>The SlutCamp payout promise 💋</h1>
<div class="pitch">
<p>Thinking about modelling here? Read this before you sign up. This is exactly how getting paid works on SlutCamp, in plain language — and it isn't marketing copy: every rule below is written into the Model Agreement (version ${MODEL_CONTRACT.version}) that every model reads and signs in the app before she can earn. This page is a summary of those rules; the Agreement itself is the legal text, and the Agreement governs.</p>
<h2>You keep 60% of everything</h2>
<p>You keep 60% of everything fans spend on you — chats, calls, gifts, live access, private content, bookings. SlutCamp keeps 40%. One split, on everything, no tiers and no fine-print percentages. You set your own prices inside the app.</p>
<h2>Your money runs one week behind (the 7-day window)</h2>
<p>New earnings become withdrawable 7 days after they're earned — your money runs one week behind what you make. The app always shows your available balance separately from earnings still inside their window, so you can see exactly what is payable and what is still clearing.</p>
<p>Why the wait? Chargeback fraud. When a fan pays by card, his bank can pull the payment back days later. The one-week window means a reversed purchase is usually caught while the money is still on the platform — before it has been paid out — instead of becoming a problem after the fact. The window protects models' payouts and the platform at the same time. If the window ever changes, it is announced in the app, and earnings already inside their window keep the window they started with.</p>
<h2>Withdrawals are reviewed and paid by a human</h2>
<p>Request a withdrawal of your available balance in the app, any time. Every payout is then reviewed and paid manually by a person on the SlutCamp team — there are no silent automatic payouts, which is one more check against fraud. Pending requests may take several business days; there is no guaranteed payout date.</p>
<h2>If a fan charges back</h2>
<p>Fans pay with prepaid credits. If a fan's credit purchase is charged back, refunded, or otherwise reversed by his bank or card issuer, the reversed money is recovered in this order:</p>
<ol>
  <li>The fan's unspent credits from that purchase come back first.</li>
  <li>Then your unpaid earnings from that fan — earnings still inside their one-week window first, then earnings that already cleared it.</li>
  <li>If anything is still left over — including because you already withdrew the earnings it relates to — the shortfall becomes a balance you owe, and it is recovered AUTOMATICALLY from your future earnings before anything new becomes withdrawable, until it is repaid in full.</li>
</ol>
<p>Read that last step again, because it matters: earnings you have already properly withdrawn are never collected back from you out of pocket. You are never required to make a manual or out-of-pocket payment for a chargeback shortfall. A shortfall is recovered from future earnings only.</p>
<h2>The fraud exception</h2>
<p>None of the above protects fraud. Coordinated purchasing, self-dealing (buying from yourself or through accounts you control), chargeback schemes, or any other scheme to manufacture earnings or payouts is fraud. For fraud, SlutCamp may place payouts on hold or under review, reverse earnings, and terminate accounts — and fraudulently obtained earnings are forfeited.</p>
<p>The legal text is the Model Agreement itself (currently version ${MODEL_CONTRACT.version}) — you will read and sign the full Agreement in the app, including section 5 (Payouts) and section 13 (Payout Holds, Chargeback Reversals &amp; Fraud). If this page and the Agreement ever differ, the Agreement governs.</p>
<p style="text-align:center"><a class="cta" href="/">Apply in the app — it's free</a></p>
<p>New here? <a href="/join">See what modelling on SlutCamp looks like</a>.</p>
</div>
${seoFooter}
</div></body></html>`);
});

// GET /sitemap.xml — DYNAMIC (replaces the old 1-URL static file):
// roster changes flow in automatically, no manual step. No lastmod:
// neither models nor users carries a real updated_at, and a faked
// lastmod is worse than none.
app.get('/sitemap.xml', (req, res) => {
  const models = seoPublicModels();
  const liveTags = seoLiveTags(models);
  const entry = (loc, freq, pri) =>
    `  <url>\n    <loc>${seoEsc(loc)}</loc>\n    <changefreq>${freq}</changefreq>\n    <priority>${pri}</priority>\n  </url>`;
  const urls = [
    entry(SEO_ORIGIN + '/', 'daily', '1.0'),
    entry(SEO_ORIGIN + '/models', 'daily', '0.9'),
    entry(SEO_ORIGIN + '/join', 'weekly', '0.8'),
    entry(SEO_ORIGIN + '/payouts', 'weekly', '0.8'),
    ...models.map((m) => entry(SEO_ORIGIN + m.url, 'daily', '0.7')),
    ...liveTags.map((t) => entry(SEO_ORIGIN + '/tags/' + seoTagSlug(t), 'weekly', '0.5')),
  ];
  res.type('application/xml').set('Cache-Control', 'public, max-age=3600')
    .send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`);
});

app.use(express.static(path.join(__dirname, 'public')));

/* ------------------------------------------------------------------ */
/* Slut Manager gate (defense in depth). Every /api/admin/* endpoint    */
/* ALSO requires the X-Manager: 1 header, which only the Slut Manager   */
/* client (public/manager/) sends. The per-route admin-session check    */
/* remains the real gate — this header rule means an admin session in    */
/* the PUBLIC app cannot reach admin endpoints anymore, because the     */
/* public client never sends the header. Same rule for /api/mod/*       */
/* (admin-only presence counts).                                        */
/* Exempt: GET /api/admin/id-verifications/:id/photo/:which — loaded    */
/* by an <img> tag (custom headers are impossible there); it is gated   */
/* by a single-use token in the query string instead.                   */
/* ------------------------------------------------------------------ */
function requireManagerHeader(req, res, next) {
  if (/^\/id-verifications\/\d+\/photo\//.test(req.path)) return next();
  if (req.headers['x-manager'] === '1') return next();
  return res.status(403).json({ error: 'manager_only' });
}
app.use('/api/admin', requireManagerHeader);
app.use('/api/mod', requireManagerHeader);

// Persistent disk on Render (/data) — falls back to local for dev
const DATA_DIR = fs.existsSync('/data') ? '/data' : __dirname;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Uploads dir for PPV media + voice notes (served only via authed /api/media/:id/file)
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
// Model profile photos are public (fans see them on the grid).
// PPV media + voice notes stay private: only files prefixed "photo-" are served here.
// Everything else in uploads/ is still served only via authed /api/media/:id/file.
app.use('/uploads', (req, res, next) => {
  if (/^\/photo-[a-f0-9]+\.(jpg|png|webp)$/.test(req.path)) return next();
  return res.status(404).end();
}, express.static(UPLOAD_DIR));

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) =>
      cb(null, crypto.randomBytes(16).toString('hex') + path.extname(file.originalname || '').slice(0, 8)),
  }),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB cap — phone videos (1080p/4K HEVC) pass 30MB in seconds
  fileFilter: (req, file, cb) => {
    const ok = /^(image\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+|audio\/(mp4|mpeg|ogg|webm|wav|x-m4a))$/.test(file.mimetype);
    cb(ok ? null : new Error('bad_file_type'), ok);
  },
});

// Profile photos: images only, 5MB cap
const photoUpload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }[file.mimetype] || '.jpg';
      cb(null, 'photo-' + crypto.randomBytes(16).toString('hex') + ext);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /^image\/(jpeg|png|webp)$/.test(file.mimetype);
    cb(ok ? null : new Error('bad_file_type'), ok);
  },
});

// Model preview video: short loop for home screen (max 15MB, ~10 sec)
const previewVideoUpload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      cb(null, 'preview-' + crypto.randomBytes(16).toString('hex') + '.mp4');
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /^video\//.test(file.mimetype);
    cb(ok ? null : new Error('bad_file_type'), ok);
  },
});

// ID verification images: SENSITIVE PII. Stored OUTSIDE uploads/ in a private
// dir that is never served statically — admin views them only via the
// authenticated /api/admin/id-verifications/:id/photo/:which endpoint.
const ID_DIR = path.join(DATA_DIR, 'private', 'id_verification');
if (!fs.existsSync(ID_DIR)) fs.mkdirSync(ID_DIR, { recursive: true });

const idUpload = multer({
  storage: multer.diskStorage({
    destination: ID_DIR,
    filename: (req, file, cb) => {
      const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }[file.mimetype] || '.jpg';
      cb(null, 'idv-' + crypto.randomBytes(16).toString('hex') + ext);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB per ID photo
  fileFilter: (req, file, cb) => {
    const ok = /^image\/(jpeg|png|webp)$/.test(file.mimetype);
    cb(ok ? null : new Error('bad_file_type'), ok);
  },
});

/* ------------------------------------------------------------------ */
/* Database                                                            */
/* ------------------------------------------------------------------ */

const db = new DatabaseSync(path.join(DATA_DIR, 'wogent-chat.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// Tiny transaction helper (node:sqlite has no .transaction() wrapper)
function txn(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE NOT NULL COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK(role IN ('fan','model','admin','recruiter')),
  display_name  TEXT NOT NULL,
  dob           TEXT,
  banned        INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS models (
  user_id          INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  bio              TEXT NOT NULL DEFAULT '',
  per_message_cents INTEGER NOT NULL DEFAULT 149,
  per_minute_cents  INTEGER NOT NULL DEFAULT 399,
  is_online        INTEGER NOT NULL DEFAULT 0,
  explicit_join_cents INTEGER NOT NULL DEFAULT 2500,
  explicit_mic_join_cents INTEGER NOT NULL DEFAULT 1500,
  join_cents INTEGER NOT NULL DEFAULT 1000,
  mic_join_cents INTEGER NOT NULL DEFAULT 500
);

-- Model likes (fans tap heart on model cards)
CREATE TABLE IF NOT EXISTS model_likes (
  fan_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  model_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (fan_id, model_id)
);
CREATE INDEX IF NOT EXISTS idx_model_likes_model ON model_likes(model_id);

CREATE TABLE IF NOT EXISTS wallets (
  user_id        INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  credits_cents  INTEGER NOT NULL DEFAULT 0,
  earnings_cents INTEGER NOT NULL DEFAULT 0,
  paid_out_cents INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS platform_stats (
  id              INTEGER PRIMARY KEY CHECK(id = 1),
  earnings_cents  INTEGER NOT NULL DEFAULT 0,
  commission_pct  INTEGER NOT NULL DEFAULT 40
);

-- Model bank accounts for manual payouts (one per model; updating replaces)
CREATE TABLE IF NOT EXISTS payout_accounts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id       INTEGER UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  holder_name    TEXT NOT NULL DEFAULT '',
  routing_number TEXT NOT NULL DEFAULT '',
  account_number TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Model withdrawal requests (manual payouts by Asce; 'pending'|'paid'|'rejected')
CREATE TABLE IF NOT EXISTS withdrawals (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at   TEXT,
  note         TEXT NOT NULL DEFAULT ''
);

-- W-9 / 1099 tax profiles for models & partners (IRS: 1099-NEC at $600+/year).
-- tax_id_encrypted is AES-256-GCM ciphertext (see encTax/decTax); only tax_id_last4
-- ever leaves the server. Filing happens outside the app (accountant/tax software).
CREATE TABLE IF NOT EXISTS tax_profiles (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  legal_name      TEXT NOT NULL DEFAULT '',
  business_name   TEXT NOT NULL DEFAULT '',
  tax_id_type     TEXT NOT NULL DEFAULT 'ssn' CHECK(tax_id_type IN ('ssn','ein')),
  tax_id_encrypted TEXT NOT NULL DEFAULT '',
  tax_id_last4    TEXT NOT NULL DEFAULT '',
  address_line1   TEXT NOT NULL DEFAULT '',
  address_line2   TEXT NOT NULL DEFAULT '',
  city            TEXT NOT NULL DEFAULT '',
  state           TEXT NOT NULL DEFAULT '',
  zip             TEXT NOT NULL DEFAULT '',
  submitted_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  electronic_1099_consent INTEGER NOT NULL DEFAULT 0,
  electronic_1099_consent_at TEXT
);

-- Fraud/chargeback protection: every credit purchase attempt (velocity checks)
CREATE TABLE IF NOT EXISTS purchase_attempts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER REFERENCES users(id),
  package_id       TEXT,
  amount_cents     INTEGER NOT NULL,
  card_fingerprint TEXT,
  ip               TEXT,
  status           TEXT NOT NULL, -- 'pending' | 'completed' | 'failed' | 'blocked'
  note             TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Admin-issued refunds (linked to purchases for dispute cross-checks)
CREATE TABLE IF NOT EXISTS refunds (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id             INTEGER NOT NULL REFERENCES users(id),
  purchase_attempt_id INTEGER REFERENCES purchase_attempts(id),
  model_id            INTEGER REFERENCES users(id),
  amount_cents        INTEGER NOT NULL,
  reason              TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Chargeback / payment disputes
CREATE TABLE IF NOT EXISTS disputes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER REFERENCES users(id),
  transaction_ref TEXT,
  amount_cents    INTEGER NOT NULL,
  reason          TEXT,
  status          TEXT NOT NULL DEFAULT 'open', -- 'open' | 'won' | 'lost'
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A conversation is either fan<->model (fan_id set) or guest<->model (guest_token set)
CREATE TABLE IF NOT EXISTS conversations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  fan_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
  guest_token TEXT,
  model_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_paused   INTEGER NOT NULL DEFAULT 0,
  paused_at   TEXT,                       -- when the safety monitor paused the chat (auto-lifts after 4h)
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(fan_id, model_id),
  UNIQUE(guest_token, model_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       INTEGER REFERENCES users(id),   -- NULL when sender is a guest
  guest_token     TEXT,                            -- set when sender is a guest
  body            TEXT NOT NULL,
  cost_cents      INTEGER NOT NULL DEFAULT 0,
  is_read         INTEGER NOT NULL DEFAULT 0,
  is_flagged      INTEGER NOT NULL DEFAULT 0,      -- blocked by safety monitor
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);

CREATE TABLE IF NOT EXISTS calls (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  fan_id         INTEGER NOT NULL REFERENCES users(id),
  model_id       INTEGER NOT NULL REFERENCES users(id),
  rate_cents     INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','ended')),
  started_at     TEXT,
  ended_at       TEXT,
  minutes_billed INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- FaceTime (instant 1-on-1 from chat): fan prepays a duration block and
-- requests; model accepts (starts now or queues behind her current call).
CREATE TABLE IF NOT EXISTS facetime_requests (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  fan_id            INTEGER NOT NULL REFERENCES users(id),
  model_id          INTEGER NOT NULL REFERENCES users(id),
  duration_min      INTEGER NOT NULL,
  amount_cents      INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','queued','invited','in_call','done','declined','cancelled','expired')),
  call_id           INTEGER REFERENCES calls(id),
  invite_expires_ms INTEGER,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at        TEXT,
  ended_at          TEXT
);
CREATE INDEX IF NOT EXISTS idx_ft_model_status ON facetime_requests (model_id, status, id);
CREATE INDEX IF NOT EXISTS idx_ft_fan ON facetime_requests (fan_id, status);

CREATE TABLE IF NOT EXISTS transactions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  fan_id         INTEGER REFERENCES users(id),
  model_id       INTEGER REFERENCES users(id),
  type           TEXT NOT NULL,
  gross_cents    INTEGER NOT NULL,
  model_cents    INTEGER NOT NULL DEFAULT 0,
  platform_cents INTEGER NOT NULL DEFAULT 0,
  note           TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Free trial tracking: subject_key is 'u:<userId>' or 'g:<guestToken>'
CREATE TABLE IF NOT EXISTS free_trials (
  subject_key TEXT NOT NULL,
  model_id    INTEGER NOT NULL,
  free_used   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (subject_key, model_id)
);

-- Safety monitor: editable keyword list
CREATE TABLE IF NOT EXISTS safety_keywords (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword TEXT UNIQUE NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
);

-- Safety monitor: incident log
CREATE TABLE IF NOT EXISTS safety_incidents (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       INTEGER REFERENCES users(id),
  guest_token     TEXT,
  sender_role     TEXT NOT NULL,
  sender_name     TEXT NOT NULL,
  flagged_text    TEXT NOT NULL,
  matched         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved','dismissed')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Strikes: subject_key 'u:<id>' or 'g:<token>'; 3 strikes => flagged for review
CREATE TABLE IF NOT EXISTS strikes (
  subject_key TEXT PRIMARY KEY,
  strikes     INTEGER NOT NULL DEFAULT 0,
  flagged     INTEGER NOT NULL DEFAULT 0
);

-- PPV media + voice notes attached to chat messages
CREATE TABLE IF NOT EXISTS media_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       INTEGER REFERENCES users(id),
  guest_token     TEXT,
  kind            TEXT NOT NULL CHECK(kind IN ('ppv_image','ppv_video','voice')),
  mime            TEXT NOT NULL,
  file_path       TEXT NOT NULL,
  price_cents     INTEGER NOT NULL DEFAULT 0,
  duration_sec    INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_media_conv ON media_items(conversation_id, id);

-- Who unlocked which media (fans must be logged in to unlock/pay)
CREATE TABLE IF NOT EXISTS media_unlocks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  media_id   INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  fan_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(media_id, fan_id)
);

-- Emoji reactions on chat messages: one per person per message (toggle/replace)
CREATE TABLE IF NOT EXISTS message_reactions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(message_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_reactions_msg ON message_reactions(message_id);

-- Audit trail for message edits: every pre-edit body, oldest first.
-- Never exposed to fans/models in any serializer (dispute evidence only).
CREATE TABLE IF NOT EXISTS message_edits (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  old_body   TEXT NOT NULL,
  edited_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_msgedits_msg ON message_edits(message_id, id);

-- Live cam sessions ("pay to play")
CREATE TABLE IF NOT EXISTS live_sessions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status              TEXT NOT NULL DEFAULT 'live' CHECK(status IN ('live','ended')),
  explicit_rate_cents INTEGER NOT NULL DEFAULT 499,
  is_explicit         INTEGER NOT NULL DEFAULT 0,
  started_at          TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at            TEXT
);

-- Game Category: the model's own priced request list for her lives.
-- She authors items in three sections; presets are copied in on first
-- fetch so she can edit/delete them like her own.
CREATE TABLE IF NOT EXISTS game_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  section       TEXT NOT NULL CHECK(section IN ('regular','explicit','special')),
  label         TEXT NOT NULL,
  price_cents   INTEGER NOT NULL,
  duration_sec  INTEGER,
  active        INTEGER NOT NULL DEFAULT 1,
  special_ready INTEGER NOT NULL DEFAULT 0,
  sort          INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_game_items_model ON game_items(model_id, section, sort, id);

-- Game Category purchases on a live session. Label/price are snapshots
-- (she can edit her list mid-live; a bought request never changes).
-- status: pending → current (she started it) → done | skipped (refunded)
-- | refunded (auto-refund when the live ended first).
CREATE TABLE IF NOT EXISTS game_requests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  INTEGER NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
  model_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fan_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id     INTEGER REFERENCES game_items(id) ON DELETE SET NULL,
  label       TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK(status IN ('pending','current','done','skipped','refunded')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_game_req_session ON game_requests(session_id, status, id);

-- Fans watching a live session
CREATE TABLE IF NOT EXISTS live_viewers (
  session_id   INTEGER NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
  fan_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_paying    INTEGER NOT NULL DEFAULT 0,
  joined_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (session_id, fan_id)
);

-- Blur/pay event log for live sessions (admin oversight)
CREATE TABLE IF NOT EXISTS blur_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
  fan_id     INTEGER REFERENCES users(id),
  event      TEXT NOT NULL,
  detail     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Model invite links: admin generates, model signs up through the link
CREATE TABLE IF NOT EXISTS invite_links (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT UNIQUE NOT NULL,
  label      TEXT NOT NULL DEFAULT '',
  role       TEXT NOT NULL DEFAULT 'model' CHECK(role IN ('model','recruiter')),
  created_by INTEGER NOT NULL REFERENCES users(id),
  used_by    INTEGER REFERENCES users(id),
  is_revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  used_at    TEXT,
  expires_at TEXT NOT NULL DEFAULT (datetime('now', '+6 hours'))
);

-- Group live stream chat (FREE messages during group streams — the funnel)
CREATE TABLE IF NOT EXISTS stream_chat (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
  sender_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  is_flagged INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_stream_chat ON stream_chat(session_id, id);

-- Virtual gift catalog (admin-editable)
CREATE TABLE IF NOT EXISTS gifts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  emoji      TEXT NOT NULL,
  name       TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- Gift send events (split via platform commission_pct)
CREATE TABLE IF NOT EXISTS gift_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id     INTEGER NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
  fan_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  gift_id        INTEGER NOT NULL REFERENCES gifts(id),
  gross_cents    INTEGER NOT NULL,
  model_cents    INTEGER NOT NULL DEFAULT 0,
  platform_cents INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_gift_stream ON gift_events(session_id, id);

-- Unified gift send log (TikTok-style gifts in chat and on live streams)
CREATE TABLE IF NOT EXISTS gift_sends (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  fan_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  model_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  gift_id         INTEGER NOT NULL REFERENCES gifts(id),
  price_cents     INTEGER NOT NULL,
  context         TEXT NOT NULL DEFAULT 'live' CHECK(context IN ('chat','live')),
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  session_id      INTEGER REFERENCES live_sessions(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_giftsends_model ON gift_sends(model_id, id);
CREATE INDEX IF NOT EXISTS idx_giftsends_conv ON gift_sends(conversation_id, id);

-- Priority messages: fans pay for banner screen time during group streams.
-- One shows at a time; the rest queue FIFO. More spend = longer on screen (max 30s).
CREATE TABLE IF NOT EXISTS priority_messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   INTEGER NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
  fan_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fan_name     TEXT NOT NULL DEFAULT '',
  message      TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  duration_sec INTEGER NOT NULL,
  voice        INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'queued',
  ends_at      INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pm_session ON priority_messages(session_id, status, id);

-- Fan "join live" requests: fan pays $10 to request camera time on the model's
-- group stream; model approves/declines. One fan on stage at a time, 3-min limit.
CREATE TABLE IF NOT EXISTS live_join_requests (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id       INTEGER NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
  fan_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status           TEXT NOT NULL DEFAULT 'pending',
  stage_started_at INTEGER NOT NULL DEFAULT 0,
  is_explicit      INTEGER NOT NULL DEFAULT 0,
  mode             TEXT NOT NULL DEFAULT 'video',
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ljr_session ON live_join_requests(session_id, status);

-- Private 1-on-1 booked lives: fan pays upfront (rate x duration), model approves.
CREATE TABLE IF NOT EXISTS bookings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fan_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scheduled_at  INTEGER NOT NULL,
  duration_min  INTEGER NOT NULL,
  total_cents   INTEGER NOT NULL,
  rate_cents    INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_bookings_model ON bookings(model_id, status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_bookings_fan ON bookings(fan_id, status, scheduled_at);

-- Model's weekly 1-on-1 availability windows (America/Chicago wall clock;
-- one window per weekday in v1) + per-day / per-week booking caps live on
-- the models row (bookings_day_cap / bookings_week_cap, NULL = no limit).
CREATE TABLE IF NOT EXISTS model_availability (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  weekday   INTEGER NOT NULL CHECK(weekday BETWEEN 0 AND 6),
  start_min INTEGER NOT NULL,
  end_min   INTEGER NOT NULL,
  UNIQUE(model_id, weekday)
);
CREATE INDEX IF NOT EXISTS idx_avail_model ON model_availability(model_id);

-- Model's recurring weekly PUBLIC live schedule (e.g. Fridays 8pm)
CREATE TABLE IF NOT EXISTS live_schedule (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day_of_week INTEGER NOT NULL,
  start_time  TEXT NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sched_model ON live_schedule(model_id);
-- Safety flags on group stream chat (separate from 1-on-1 conversation incidents)
CREATE TABLE IF NOT EXISTS stream_flags (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  INTEGER NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
  sender_id   INTEGER REFERENCES users(id),
  sender_name TEXT NOT NULL,
  flagged_text TEXT NOT NULL,
  matched     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Fan Suggestion Box: ideas submitted from the fan Wallet card.
-- username is a snapshot at submit time (display names can change).
CREATE TABLE IF NOT EXISTS suggestions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  username   TEXT NOT NULL DEFAULT '',
  body       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_suggestions_status ON suggestions(status, id);
`);

db.prepare(`INSERT OR IGNORE INTO platform_stats (id, earnings_cents, commission_pct)
            VALUES (1, 0, 40)`).run();

// --- Lightweight migrations for DBs created before these features ---
function addColumnIfMissing(table, col, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
addColumnIfMissing('messages', 'media_id', 'INTEGER REFERENCES media_items(id)');
addColumnIfMissing('messages', 'edited_at', 'TEXT'); // set when the sender edits within the 5-min window
addColumnIfMissing('calls', 'prepaid_min', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('calls', 'is_explicit', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('calls', 'explicit_pending', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('calls', 'facetime_req_id', 'INTEGER');
addColumnIfMissing('models', 'per_voice_cents', 'INTEGER NOT NULL DEFAULT 299');
addColumnIfMissing('models', 'explicit_rate_cents', 'INTEGER NOT NULL DEFAULT 499');
addColumnIfMissing('models', 'photo_url', "TEXT NOT NULL DEFAULT ''");
// Clean PUBLIC photo for the Google-facing pages only (owner rule,
// Oct 16 2026): her in-app storefront photo (photo_url) may be explicit
// and must never reach the public pages, so the SEO surfaces read ONLY
// this column. '' = unset → public pages show the branded logo instead.
addColumnIfMissing('models', 'public_photo_url', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('live_sessions', 'title', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('live_sessions', 'brb', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('live_sessions', 'game_on', 'INTEGER NOT NULL DEFAULT 0'); // Game Category live this session
addColumnIfMissing('platform_stats', 'game_category_announced_at', 'TEXT'); // one-time model broadcast stamp
addColumnIfMissing('platform_stats', 'agreement_12_announced_at', 'TEXT'); // one-time v1.2 agreement broadcast stamp
addColumnIfMissing('platform_stats', 'public_photo_announced_at', 'TEXT'); // one-time public-photo (Google pages) broadcast stamp
addColumnIfMissing('platform_stats', 'notif_fix_announced_at', 'TEXT'); // one-time notification-tap fix broadcast stamp
addColumnIfMissing('platform_stats', 'preview_video_announced_at', 'TEXT'); // one-time preview-video-on-profile broadcast stamp
addColumnIfMissing('platform_stats', 'thread_tap_announced_at', 'TEXT'); // one-time one-tap-to-the-message broadcast stamp
addColumnIfMissing('platform_stats', 'fan_preview_announced_at', 'TEXT'); // one-time fan preview-video blast stamp
addColumnIfMissing('platform_stats', 'languages_announced_at', 'TEXT'); // one-time 13-languages model broadcast stamp
addColumnIfMissing('platform_stats', 'fan_languages_announced_at', 'TEXT'); // one-time 13-languages fan blast stamp
addColumnIfMissing('platform_stats', 'suggestion_box_announced_at', 'TEXT'); // one-time Suggestion Box fan blast stamp
addColumnIfMissing('live_viewers', 'explicit_until', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('live_viewers', 'explicit_paid', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('platform_stats', 'explicit_gift_grace_sec', 'INTEGER NOT NULL DEFAULT 180');
addColumnIfMissing('conversations', 'paused_at', 'TEXT');
addColumnIfMissing('messages', 'gift_json', 'TEXT'); // TikTok-style gift payload on chat gift messages
addColumnIfMissing('models', 'preview_video_url', "TEXT NOT NULL DEFAULT ''"); // Loop preview on home screen
// Profile media expansion (owner, Oct 17 2026): a SECOND main profile
// video (preview_video_url stays Video 1) + a gallery of extra profile
// pictures. gallery_photos is a JSON array of /uploads/photo-* URLs,
// same storage pattern as models.tags; the profile page shows her main
// photo_url first, then these, capped at MAX_PROFILE_PICS total.
addColumnIfMissing('models', 'preview_video_url_2', "TEXT NOT NULL DEFAULT ''"); // Second main profile video
addColumnIfMissing('models', 'gallery_photos', "TEXT NOT NULL DEFAULT '[]'"); // Extra profile pictures (JSON array)
addColumnIfMissing('platform_stats', 'profile_media_announced_at', 'TEXT'); // one-time profile-media broadcast stamp
addColumnIfMissing('invite_links', 'expires_at', "TEXT NOT NULL DEFAULT (datetime('now', '+6 hours'))");
addColumnIfMissing('invite_links', 'role', "TEXT NOT NULL DEFAULT 'model'");
addColumnIfMissing('tax_profiles', 'electronic_1099_consent', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('tax_profiles', 'electronic_1099_consent_at', 'TEXT');
// Payout protection (Oct 16, 2026): earnings maturity + chargeback engine.
// available_at stamps when a ledger earning becomes withdrawable
// (NULL = grandfathered/matured; see grandfatherEarningsOnce below).
addColumnIfMissing('transactions', 'available_at', 'TEXT');
addColumnIfMissing('platform_stats', 'earnings_hold_days', 'INTEGER NOT NULL DEFAULT 7');
addColumnIfMissing('platform_stats', 'flag_concentration_pct', 'INTEGER NOT NULL DEFAULT 80');
addColumnIfMissing('platform_stats', 'flag_concentration_min_cents', 'INTEGER NOT NULL DEFAULT 10000');
addColumnIfMissing('platform_stats', 'flag_concentration_days', 'INTEGER NOT NULL DEFAULT 30');
addColumnIfMissing('platform_stats', 'flag_cb_escalate_count', 'INTEGER NOT NULL DEFAULT 2');
addColumnIfMissing('platform_stats', 'flag_cb_escalate_rate_pct', 'INTEGER NOT NULL DEFAULT 20');
addColumnIfMissing('platform_stats', 'payout_protection_at', 'TEXT'); // one-time grandfathering marker
db.exec(`CREATE TABLE IF NOT EXISTS chargebacks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  fan_id INTEGER NOT NULL REFERENCES users(id),
  load_ref TEXT,
  load_txn_id INTEGER REFERENCES transactions(id),
  amount_cents INTEGER NOT NULL,
  reason TEXT,
  recorded_by INTEGER REFERENCES users(id),
  reversed_fan_cents INTEGER NOT NULL DEFAULT 0,
  reversed_model_cents INTEGER NOT NULL DEFAULT 0,
  negative_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'processed',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source, external_id)
)`);
db.exec(`CREATE TABLE IF NOT EXISTS chargeback_allocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chargeback_id INTEGER NOT NULL REFERENCES chargebacks(id),
  model_id INTEGER REFERENCES users(id),
  step INTEGER NOT NULL,
  bucket TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  transaction_id INTEGER REFERENCES transactions(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_cb_alloc_model ON chargeback_allocations(model_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_cb_alloc_cb ON chargeback_allocations(chargeback_id)');
// Backfill: existing invites without expiry get 6h from creation
db.exec(`UPDATE invite_links SET expires_at = datetime(created_at, '+6 hours') WHERE expires_at IS NULL OR expires_at = ''`);
addColumnIfMissing('priority_messages', 'voice', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('live_join_requests', 'is_explicit', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('live_join_requests', 'mode', "TEXT NOT NULL DEFAULT 'video'");
addColumnIfMissing('models', 'explicit_join_cents', 'INTEGER NOT NULL DEFAULT 2500');
addColumnIfMissing('models', 'explicit_mic_join_cents', 'INTEGER NOT NULL DEFAULT 1500');
addColumnIfMissing('models', 'join_cents', 'INTEGER NOT NULL DEFAULT 1000');
addColumnIfMissing('models', 'mic_join_cents', 'INTEGER NOT NULL DEFAULT 500');
addColumnIfMissing('calls', 'booking_id', 'INTEGER REFERENCES bookings(id)');
// Pre-purchase explicit-media shield (Oct 16, 2026): proof-only AV
// columns (the dormant purchase gate stamps av_verified_at and
// fan_state; the shield only reads them — NO document/DOB data is
// ever stored for AV) and the model-set explicit flag on chat media.
addColumnIfMissing('users', 'av_verified_at', 'TEXT');
addColumnIfMissing('users', 'fan_state', 'TEXT');
addColumnIfMissing('media_items', 'is_explicit', 'INTEGER NOT NULL DEFAULT 0');
// 1-on-1 slot bookings (Oct 15, 2026): availability caps on the model row;
// bookings.kind separates instant slot bookings ('slot', confirmed on pay)
// from the legacy ask-and-approve flow ('request'). Presence stamps drive
// no-show resolution; reminded_* stamps dedupe the T-3d / T-3h / T-15m
// model reminder sweep structurally (one send per threshold, ever).
addColumnIfMissing('models', 'bookings_day_cap', 'INTEGER');
addColumnIfMissing('models', 'bookings_week_cap', 'INTEGER');
addColumnIfMissing('bookings', 'kind', "TEXT NOT NULL DEFAULT 'request'");
addColumnIfMissing('bookings', 'model_present', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('bookings', 'fan_present', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('bookings', 'reminded_3d', 'TEXT');
addColumnIfMissing('bookings', 'reminded_3h', 'TEXT');
addColumnIfMissing('bookings', 'reminded_15m', 'TEXT');
// No-show rules (owner ruling, Oct 15): fan_join_deadline (ms epoch) is
// stamped when the model activates a booking — his 3-minute join clock;
// start_notified_at dedupes her "your 1-on-1 is now active" ping.
addColumnIfMissing('bookings', 'fan_join_deadline', 'INTEGER');
addColumnIfMissing('bookings', 'start_notified_at', 'TEXT');
addColumnIfMissing('platform_stats', 'explicit_entry_cents', 'INTEGER NOT NULL DEFAULT 499');
addColumnIfMissing('platform_stats', 'admin_phone', 'TEXT');
addColumnIfMissing('platform_stats', 'admin_2fa_on', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('platform_stats', 'test_money_cleared_at', 'TEXT');
addColumnIfMissing('platform_stats', 'commission_60_40_fixed_at', 'TEXT'); // one-time canonical 60/40 correction stamp
addColumnIfMissing('platform_stats', 'demo_purge_at', 'TEXT'); // one-time demo-seed purge stamp
addColumnIfMissing('transactions', 'is_test', 'INTEGER NOT NULL DEFAULT 0');
// Admin visibility switch: hidden models vanish from the public listings
// (home grid, Lives) without touching their account (Corry, Oct 12 2026).
addColumnIfMissing('models', 'is_hidden', 'INTEGER NOT NULL DEFAULT 0');
// Discovery 2.0 (Oct 16 2026): model-picked discovery tags as a JSON array
// of catalogue strings. Additive only — existing models default to none.
addColumnIfMissing('models', 'tags', "TEXT NOT NULL DEFAULT '[]'");
// Composite ranking (owner, Oct 16 2026): stored rank_score = fan likes +
// lifetime credited model earnings in dollars (see recomputeModelRank).
// Additive only — the boot backfill fills real values before serving.
addColumnIfMissing('models', 'rank_score', 'REAL NOT NULL DEFAULT 0');
// Fraud protection: account status ('active' | 'frozen') + ledger IP on every money row
addColumnIfMissing('users', 'status', "TEXT NOT NULL DEFAULT 'active'");
addColumnIfMissing('transactions', 'ip', 'TEXT');

// Display name changes: fans get 1 per 30 days (self-service); models submit requests for admin approval
addColumnIfMissing('users', 'name_changed_at', 'TEXT');

// UI language preference — set from the in-app language picker, returned
// by /api/me so it follows the user across devices. 13 languages since the
// Oct 17 2026 expansion (Arabic deferred — RTL layout is separate work).
addColumnIfMissing('users', 'language', "TEXT NOT NULL DEFAULT 'en'");
const SUPPORTED_LANGS = ['en', 'es', 'pt', 'fr', 'de', 'ru', 'ja', 'zh', 'ko', 'it', 'pl', 'nl', 'tr'];

// Fan spend dashboard: the fan's OPTIONAL monthly spend cap, in cents.
// NULL = no cap (the default for every existing fan — nobody's spending
// changes until they set one). Enforced inside chargeFan(); read by
// GET /api/me/spending. See the spending block above chargeFan.
addColumnIfMissing('users', 'spend_cap_cents', 'INTEGER');

// Optional contact email for update blasts (favorite models + deals).
// NULL = never opted in. Owner rule (Oct 17 2026): NEVER forced — a fan
// adds it at sign-up or in Settings, can skip it everywhere, and can
// clear it anytime. Collection only for now: no email provider exists
// yet, so nothing sends to this address until one is wired up.
addColumnIfMissing('users', 'email', 'TEXT');

// Admin presence override per model ('auto' | 'on' | 'off'): 'auto' = her own
// is_online toggle decides; 'on'/'off' force what fans SEE. Display/discovery
// only — never blocks her app, messages or going live (Asce, Oct 14 2026).
addColumnIfMissing('users', 'presence_override', "TEXT NOT NULL DEFAULT 'auto'");

// Model welcome celebration: welcomed_at NULL = not yet welcomed. Everyone
// who already has an account when this ships counts as welcomed — only NEW
// model signups get the congratulations overlay.
(function () {
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!cols.includes('welcomed_at')) {
    db.exec('ALTER TABLE users ADD COLUMN welcomed_at TEXT');
    db.exec("UPDATE users SET welcomed_at = datetime('now')");
  }
})();

// Welcome MESSAGE in her app inbox (from Asce (Admin)): stamped when sent.
// NULL = not sent yet; the boot sweep delivers to anyone missing it.
addColumnIfMissing('users', 'welcome_msg_sent_at', 'TEXT');

// Guide MESSAGE (how the app works / how she makes money) — lands right
// behind the welcome DM in her admin thread. NULL = not sent yet; the
// boot sweep delivers to anyone missing it.
addColumnIfMissing('users', 'guide_msg_sent_at', 'TEXT');

// Guide VIDEO message (1-minute tour) — same thread, lands behind the
// guide DM. Gated on the video file existing on disk: until it ships, the
// stamp stays NULL and nobody gets the message; once the file lands, the
// boot sweep delivers it to every model missing the stamp.
addColumnIfMissing('users', 'guide_video_sent_at', 'TEXT');

// Add-to-home-screen VIDEO message — same thread, same delivery pattern
// as the guide video. Gated on the video file existing on disk: until it
// ships, the stamp stays NULL; once the file lands, the boot sweep
// delivers it to every model missing the stamp.
addColumnIfMissing('users', 'ath_video_sent_at', 'TEXT');

// ID-verification step MESSAGE — lands in her admin thread behind the
// ATH video DM, for genuinely NEW model signups only. Everyone who
// already has an account when this ships is pre-stamped at migration
// (same discipline as welcomed_at above): the boot sweep must never
// retro-blast existing models with a "finish setting up" message.
(function () {
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!cols.includes('id_verify_msg_sent_at')) {
    db.exec('ALTER TABLE users ADD COLUMN id_verify_msg_sent_at TEXT');
    db.exec("UPDATE users SET id_verify_msg_sent_at = datetime('now')");
  }
})();

// Affiliate-program MESSAGE — same discipline as the ID-verification
// stamp above: lands behind the ID DM in a NEW model's admin thread.
// Pre-stamped for every account that exists when this ships, so the
// boot sweep only ever reaches genuinely new signups.
(function () {
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!cols.includes('affiliate_msg_sent_at')) {
    db.exec('ALTER TABLE users ADD COLUMN affiliate_msg_sent_at TEXT');
    db.exec("UPDATE users SET affiliate_msg_sent_at = datetime('now')");
  }
})();
db.exec(`
CREATE TABLE IF NOT EXISTS name_change_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requested_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'rejected'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);`);

// --- Recruiters/partners: who recruited each model ---
db.exec(`
CREATE TABLE IF NOT EXISTS recruiters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  referral_code TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
addColumnIfMissing('models', 'recruiter_id', 'INTEGER REFERENCES recruiters(id) ON DELETE SET NULL');
addColumnIfMissing('models', 'is_featured', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('transactions', 'recruiter_id', 'INTEGER REFERENCES recruiters(id) ON DELETE SET NULL');
addColumnIfMissing('transactions', 'recruiter_cents', 'INTEGER NOT NULL DEFAULT 0');

// Allow the 'recruiter' role: rebuild users table if its CHECK doesn't include it
(function allowRecruiterRole() {
  let sql = null;
  try { sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get(); } catch (e) { /* ignore */ }
  if (!sql || !sql.sql || sql.sql.includes("'recruiter'")) return;
  db.exec('PRAGMA foreign_keys=OFF');
  try {
    db.exec(`
      CREATE TABLE users_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('fan','model','admin','recruiter')),
        display_name TEXT NOT NULL,
        dob TEXT,
        banned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO users_new (id, username, password_hash, role, display_name, dob, banned, created_at)
        SELECT id, username, password_hash, role, display_name, dob, banned, created_at FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;
    `);
  } finally {
    db.exec('PRAGMA foreign_keys=ON');
  }
})();

db.exec(`
CREATE TABLE IF NOT EXISTS sms_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  code TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sms_codes_user ON sms_codes(user_id);
`);

// One-time: rename admin display name (never show real name to models/fans)
try {
  db.prepare(`UPDATE users SET display_name = 'Asce (Admin)' WHERE username = 'admin' AND display_name = 'Corry (Admin)'`).run();
} catch (e) { /* already renamed */ }

// Model contract signatures (independent-contractor agreement).
// History-preserving since v1.2 (Oct 15, 2026): one row PER SIGNING, so
// re-signing a new version never overwrites the old record — readers
// always take a user's LATEST row for the relevant version family.
db.exec(`
CREATE TABLE IF NOT EXISTS contract_signatures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  contract_version TEXT NOT NULL,
  signed_at TEXT NOT NULL DEFAULT (datetime('now')),
  display_name TEXT NOT NULL,
  ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_contract_signatures_user ON contract_signatures(user_id);

-- Model ID verification for 18 U.S.C. §2257 compliance.
-- ID images are sensitive PII stored in private/id_verification/ (never served statically).
CREATE TABLE IF NOT EXISTS id_verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
  id_front_path TEXT,
  id_back_path TEXT,
  selfie_path TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at TEXT,
  reviewer_note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_id_verifications_status ON id_verifications(status);

-- Follows: fans follow models to get "she's live" notifications
CREATE TABLE IF NOT EXISTS follows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fan_id INTEGER NOT NULL,
  model_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(fan_id, model_id)
);
CREATE INDEX IF NOT EXISTS idx_follows_model ON follows(model_id);
CREATE INDEX IF NOT EXISTS idx_follows_fan ON follows(fan_id);

-- Region blocks: models hide themselves from fans in chosen places
-- (level: country | state | county | city). Resolved per-request from the
-- fan's IP via lib/geo.js; matching fans never see the model at all.
CREATE TABLE IF NOT EXISTS model_region_blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id INTEGER NOT NULL REFERENCES users(id),
  level TEXT NOT NULL CHECK(level IN ('country','state','county','city')),
  country_code TEXT NOT NULL DEFAULT 'US',
  state_code TEXT,
  county_name TEXT,
  city_name TEXT,
  label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mrb_model ON model_region_blocks(model_id);

-- In-app notifications (bell icon)
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL DEFAULT 'general',
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, id);

-- Web Push subscriptions (browser push; needs VAPID keys to actually send)
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT,
  auth TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pushsubs_user ON push_subscriptions(user_id);

-- Model tip menu: custom tip items she defines (e.g. "💋 Blow a kiss — $5")
CREATE TABLE IF NOT EXISTS tip_menus (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id INTEGER NOT NULL,
  emoji TEXT NOT NULL DEFAULT '💰',
  label TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tipmenus_model ON tip_menus(model_id, sort_order);

-- Tip menu purchase log
CREATE TABLE IF NOT EXISTS tip_sends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fan_id INTEGER NOT NULL,
  model_id INTEGER NOT NULL,
  menu_id INTEGER,
  price_cents INTEGER NOT NULL,
  context TEXT NOT NULL DEFAULT 'profile',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tipsends_model ON tip_sends(model_id, id);
`);

/* One-time migration (Oct 15, 2026): contract_signatures shipped with a
   UNIQUE(user_id) constraint — one signature per user, forever — which
   makes re-signing a new agreement version impossible without erasing
   the old record. Rebuild the table without it (every existing row is
   copied verbatim: the v1.1 history stays exactly as signed). Runs only
   while the stored DDL still carries the constraint. */
try {
  const ddl = db.prepare(`SELECT sql FROM sqlite_master
    WHERE type = 'table' AND name = 'contract_signatures'`).get();
  if (ddl && /user_id\s+INTEGER\s+NOT\s+NULL\s+UNIQUE/i.test(ddl.sql || '')) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`CREATE TABLE contract_signatures_hist (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id),
        contract_version TEXT NOT NULL,
        signed_at TEXT NOT NULL DEFAULT (datetime('now')),
        display_name TEXT NOT NULL,
        ip TEXT
      )`);
      db.exec(`INSERT INTO contract_signatures_hist
        (id, user_id, contract_version, signed_at, display_name, ip)
        SELECT id, user_id, contract_version, signed_at, display_name, ip
        FROM contract_signatures`);
      db.exec('DROP TABLE contract_signatures');
      db.exec('ALTER TABLE contract_signatures_hist RENAME TO contract_signatures');
      db.exec('CREATE INDEX IF NOT EXISTS idx_contract_signatures_user ON contract_signatures(user_id)');
      db.exec('COMMIT');
      console.log('[contract] signatures table rebuilt without UNIQUE — history preserved.');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (err) { /* already closed */ }
      throw e;
    }
  }
} catch (e) { console.error('[contract] signature migration failed', e); }

// Seed the safety keyword list (admin can edit these later in Settings)
const DEFAULT_KEYWORDS = [
  'snapchat', 'snap', 'instagram', 'ig', 'whatsapp', 'telegram', 'kik',
  'twitter dm', 'cashapp', 'cash app', 'venmo', 'zelle', 'paypal',
  'real name', 'where do you live', 'meet up', 'meetup', 'address',
  'phone number', 'call me', 'text me', 'my number',
  'nigger', 'wetback', 'wet back',
];
const kwCount = db.prepare('SELECT COUNT(*) AS c FROM safety_keywords').get().c;
if (kwCount === 0) {
  const ins = db.prepare('INSERT INTO safety_keywords (keyword) VALUES (?)');
  for (const kw of DEFAULT_KEYWORDS) ins.run(kw);
}

// Seed the virtual gift catalog (admin can edit prices/add/remove later).
// TikTok-style emoji gift tiers.
const TIKTOK_GIFTS = [
  ['❤️', 'Heart', 100],
  ['🌹', 'Rose', 200],
  ['🍦', 'Ice Cream', 500],
  ['🧸', 'Teddy', 800],
  ['💎', 'Diamond', 1000],
  ['🔥', 'Fire', 1500],
  ['👑', 'Crown', 2000],
  ['🚀', 'Rocket', 5000],
  ['🏆', 'Trophy', 10000],
];
// Legacy catalog prices — migration only retouches gifts still at these defaults,
// so anything the admin customized is left alone.
const LEGACY_GIFT_PRICES = {
  '🌹|Rose': 100, '💋|Kiss': 500, '🔥|Fire': 1000,
  '💎|Diamond': 2500, '🚗|Sports Car': 5000, '🚀|Rocket': 10000,
};
const giftCount = db.prepare('SELECT COUNT(*) AS c FROM gifts').get().c;
if (giftCount === 0) {
  const ins = db.prepare('INSERT INTO gifts (emoji, name, price_cents, sort_order) VALUES (?,?,?,?)');
  TIKTOK_GIFTS.forEach(([emoji, name, price], i) => ins.run(emoji, name, price, i));
} else {
  // One-time migration to the TikTok tiers: insert missing gifts in price order,
  // update prices that are still at legacy defaults.
  const findGift = db.prepare('SELECT * FROM gifts WHERE emoji = ? AND name = ?');
  const insGift = db.prepare('INSERT INTO gifts (emoji, name, price_cents, sort_order) VALUES (?,?,?,?)');
  const updPrice = db.prepare('UPDATE gifts SET price_cents = ? WHERE id = ?');
  const priceRank = db.prepare('SELECT COUNT(*) AS n FROM gifts WHERE price_cents < ?');
  for (const [emoji, name, price] of TIKTOK_GIFTS) {
    const row = findGift.get(emoji, name);
    if (!row) {
      insGift.run(emoji, name, price, priceRank.get(price).n);
    } else {
      const legacy = LEGACY_GIFT_PRICES[emoji + '|' + name];
      if (legacy != null && row.price_cents === legacy) updPrice.run(price, row.id);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const getCommission = () =>
  db.prepare('SELECT commission_pct FROM platform_stats WHERE id = 1').get().commission_pct;

// Gift grace period: how long ANY gift keeps a viewer's screen unblurred during explicit (seconds)
const getGiftGraceSec = () => {
  const r = db.prepare('SELECT explicit_gift_grace_sec FROM platform_stats WHERE id = 1').get();
  const s = r && r.explicit_gift_grace_sec;
  return Number.isInteger(s) && s >= 30 && s <= 3600 ? s : 180;
};

// Explicit entry fee: one-time charge per viewer to unblur when she goes explicit (cents)
const getEntryCents = () => {
  const r = db.prepare('SELECT explicit_entry_cents FROM platform_stats WHERE id = 1').get();
  const s = r && r.explicit_entry_cents;
  return Number.isInteger(s) && s >= 100 && s <= 10000 ? s : 499;
};

const getWallet = (userId) =>
  db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(userId);

/* ---------------- Payout protection (Oct 16, 2026) ----------------
   Earnings maturity: every NEW earning is stamped available_at =
   earned + earnings_hold_days (Manager setting, DEFAULT 7 — the
   owner's "one week behind" rule). Withdrawable = matured earnings
   only. The lot walk is the single source of truth: it replays the
   earner's ledger rows (models via model_cents, recruiters via
   recruiter_cents — recruiters ride the same wallet + withdrawal
   path, so the same maturity applies to them) in ledger order.
   Positive rows open lots; negative rows (refunds, chargeback
   reversals) consume lots HELD-first, then matured, FIFO inside each
   bucket; a step-3 'chargeback_adjustment' row skips lots entirely
   and lands directly in `debt` — a negative adjustment future
   earnings offset before anything becomes withdrawable. Invariant
   (pinned by tests): wallet.earnings_cents == matured + holding − debt. */

const getPayoutSettings = () => {
  const r = db.prepare(`SELECT earnings_hold_days, flag_concentration_pct,
    flag_concentration_min_cents, flag_concentration_days,
    flag_cb_escalate_count, flag_cb_escalate_rate_pct
    FROM platform_stats WHERE id = 1`).get() || {};
  const pick = (v, d, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : d);
  return {
    holdDays: pick(r.earnings_hold_days, 7, 0, 60),
    concentrationPct: pick(r.flag_concentration_pct, 80, 1, 100),
    concentrationMinCents: pick(r.flag_concentration_min_cents, 10000, 0, 10000000),
    concentrationDays: pick(r.flag_concentration_days, 30, 1, 365),
    cbEscalateCount: pick(r.flag_cb_escalate_count, 2, 1, 100),
    cbEscalateRatePct: pick(r.flag_cb_escalate_rate_pct, 20, 1, 100),
  };
};
const getHoldDays = () => getPayoutSettings().holdDays;

const nowSql = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
// When an earning made right now becomes withdrawable (same
// 'YYYY-MM-DD HH:MM:SS' UTC shape as datetime('now')).
const earningsAvailableAt = () =>
  new Date(Date.now() + getHoldDays() * 86400000).toISOString().slice(0, 19).replace('T', ' ');

// Replay an earner's ledger into { matured, holding, debt, lots }.
// opts.fanId restricts the replay to one fan's rows. Lots keep their
// fan attribution so the chargeback engine can tell one fan's unpaid
// earnings from another's (see pairUnpaid).
function replayEarnings(userId, fanId = null) {
  const rec = db.prepare('SELECT id FROM recruiters WHERE user_id = ?').get(userId);
  const recId = rec ? rec.id : -1;
  const rows = db.prepare(`SELECT fan_id, model_id, model_cents, recruiter_cents, available_at, type
    FROM transactions
    WHERE is_test = 0 AND type != 'payout'
      AND ((model_id = ? AND model_cents != 0) OR (recruiter_id = ? AND recruiter_cents != 0))
      ${fanId ? 'AND fan_id = ?' : ''}
    ORDER BY id ASC`).all(...(fanId ? [userId, recId, fanId] : [userId, recId]));
  const now = nowSql();
  const lots = [];
  let debt = 0;
  const consume = (amt) => { // held lots first, then matured; FIFO per bucket
    let left = amt;
    for (const heldPass of [true, false]) {
      for (const lot of lots) {
        if (!left) break;
        if ((lot.available_at > now) !== heldPass || lot.amount <= 0) continue;
        const take = Math.min(lot.amount, left);
        lot.amount -= take; left -= take;
      }
      if (!left) break;
    }
    return left;
  };
  for (const r of rows) {
    const amt = r.model_id === userId ? r.model_cents : r.recruiter_cents;
    if (amt > 0) {
      let a = amt;
      if (debt > 0) { const off = Math.min(debt, a); debt -= off; a -= off; }
      if (a > 0) lots.push({ amount: a, available_at: r.available_at || '1970-01-01 00:00:00', fan_id: r.fan_id });
    } else if (amt < 0) {
      // A chargeback step-3 row is a negative ADJUSTMENT, not a reversal
      // of lots the model still has: it goes straight to debt (future
      // earnings offset it first) and never eats existing lots — the
      // wallet decrement and the debt are the same cents, counted once.
      if (r.type === 'chargeback_adjustment') debt += -amt;
      else debt += consume(-amt);
    }
  }
  let matured = 0, holding = 0;
  for (const lot of lots) {
    if (lot.available_at > now) holding += lot.amount; else matured += lot.amount;
  }
  return { matured, holding, debt, lots };
}
const walkLots = (userId, fanId = null) => {
  const { matured, holding, debt } = replayEarnings(userId, fanId);
  return { matured, holding, debt };
};
const getEarningsBreakdown = (userId) => walkLots(userId);

/* What step 2 of a chargeback may still reverse from one (fan, model)
   pair: the pair's lots that are actually UNPAID. A payout is cash that
   already left the platform — wallet.paid_out_cents — so lots it paid
   for are NOT reversible from the balance; booking them as reversed
   would double-count money that is gone, and the true shortfall would
   never reach step 3 as debt. Attribution convention: payouts consumed
   the earner's lots FIFO in ledger order (the order the replay walks),
   whichever fan they came from. Pending withdrawal REQUESTS are not
   subtracted — a request reserves nothing the pay path doesn't re-check
   (it refuses once a chargeback has eaten the balance). */
function pairUnpaid(userId, fanId) {
  const { lots } = replayEarnings(userId);
  const w = getWallet(userId);
  let paidLeft = w ? w.paid_out_cents : 0;
  const now = nowSql();
  let holding = 0, matured = 0;
  for (const lot of lots) {
    if (paidLeft > 0) {
      const gone = Math.min(lot.amount, paidLeft);
      lot.amount -= gone; paidLeft -= gone;
    }
    if (lot.amount <= 0 || lot.fan_id !== fanId) continue;
    if (lot.available_at > now) holding += lot.amount; else matured += lot.amount;
  }
  return { holding, matured };
}

// Model's withdrawable balance: MATURED earnings only, minus paid out,
// minus pending requests, minus any negative adjustment (debt).
// Server-enforced: the withdrawal request flow and both Manager payout
// paths all go through this one function.
const getModelAvailableRaw = (userId) => {
  const w = getWallet(userId);
  if (!w) return 0;
  const pending = db.prepare(
    `SELECT COALESCE(SUM(amount_cents), 0) AS s FROM withdrawals WHERE model_id = ? AND status = 'pending'`
  ).get(userId).s;
  const b = getEarningsBreakdown(userId);
  return b.matured - b.debt - w.paid_out_cents - pending;
};
const getModelAvailable = (userId) => Math.max(0, getModelAvailableRaw(userId));

const getUserPublic = (u) => ({
  id: u.id, username: u.username, role: u.role,
  display_name: u.display_name, banned: !!u.banned,
  status: u.status || 'active',
  language: u.language || 'en',
  welcomed: !!u.welcomed_at,
});

/* Optional contact email — same loose shape check as the DMCA report
 * route. Empty/absent means the fan SKIPPED it (owner rule: never
 * forced) and stores NULL; a provided value must look like an email. */
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
function optionalEmail(raw) {
  const v = String(raw == null ? '' : raw).trim().slice(0, 160);
  if (!v) return { email: null };
  if (!EMAIL_RE.test(v)) return { error: 'bad_email' };
  return { email: v };
}

const fmt$ = (c) => '$' + (c / 100).toFixed(2); // server-side money formatter (cents → $x.xx)

function splitPayment(grossCents, modelUserId) {
  const commission = getCommission();
  const modelCents = Math.round(grossCents * (100 - commission) / 100);
  let platformCents = grossCents - modelCents;
  let recruiterCents = 0, recruiterId = null, recruiterUserId = null;
  if (modelUserId) {
    const r = db.prepare(`SELECT r.id, r.user_id FROM recruiters r
                          JOIN models m ON m.recruiter_id = r.id
                          WHERE m.user_id = ?`).get(modelUserId);
    if (r) {
      recruiterId = r.id; recruiterUserId = r.user_id;
      recruiterCents = Math.round(platformCents / 2);
      platformCents -= recruiterCents;
    }
  }
  return { modelCents, platformCents, recruiterCents, recruiterId, recruiterUserId, commission };
}

/* ---------------- fan spending + optional monthly cap ----------------
 * Owner-authorized quick win (Oct 16 2026): a fan-facing "Your spending"
 * dashboard plus an OPTIONAL fan-set monthly spend cap.
 *
 * WHAT COUNTS AS SPEND — exactly the rows chargeFan()/refundFan() write:
 *   charges (positive gross): message, voice, ppv, tip, tip_menu, call,
 *     call_explicit, live_explicit, live_explicit_entry, live_join_request,
 *     game, gift, priority (pay-to-speak TTS), booking
 *   refunds (negative gross, netting against spend via the signed sum):
 *     call_refund → calls, live_join_refund → lives, game_refund → games,
 *     booking_refund / booking_no_show → bookings, and refundFan's generic
 *     'refund' → its own 'refunds' bucket.
 * EXCLUDED, deliberately:
 *   - is_test rows — the same exclusion every money display in this file
 *     uses (pre-launch test money never counts);
 *   - money IN: 'ccbill_load' / 'crypto_load' loads and admin
 *     'credit_grant' rows are credits, not spend;
 *   - 'chargeback' / 'chargeback_adjustment' rows — a chargeback revokes
 *     unspent credits / reverses earnings; the original spend stays spent;
 *   - POSITIVE 'refund' rows: refundFan writes NEGATIVE gross, but the
 *     admin refund route's no-model branch writes a POSITIVE 'refund'
 *     row for a direct credit return — that is money back with no spend
 *     attached, so only negative 'refund' rows count.
 *
 * MONTH BASIS: transactions.created_at is SQLite datetime('now') — UTC —
 * so "this month" is the current UTC calendar month, the same basis the
 * whole ledger already runs on. A refund counts in the month the REFUND
 * posts (the ledger is append-only; history is never rewritten), so a
 * refund of last month's charge restores headroom THIS month.
 *
 * Aggregation is READ-ONLY: nothing here ever writes to the ledger.
 */
const SPEND_CATEGORY_TYPES = {
  messages: ['message'],
  ppv: ['ppv'],
  voice: ['voice'],
  tips: ['tip', 'tip_menu'],
  gifts: ['gift'],
  calls: ['call', 'call_explicit'],
  lives: ['live_explicit', 'live_explicit_entry', 'live_join_request'],
  bookings: ['booking'],
  games: ['game'],
  tts: ['priority'],
};
const SPEND_REFUND_TYPE_CATEGORY = {
  call_refund: 'calls', live_join_refund: 'lives', game_refund: 'games',
  booking_refund: 'bookings', booking_no_show: 'bookings', refund: 'refunds',
};
const SPEND_TYPE_CATEGORY = {};
for (const [cat, types] of Object.entries(SPEND_CATEGORY_TYPES))
  for (const t of types) SPEND_TYPE_CATEGORY[t] = cat;
Object.assign(SPEND_TYPE_CATEGORY, SPEND_REFUND_TYPE_CATEGORY);
const SPEND_TYPES_SQL = Object.keys(SPEND_TYPE_CATEGORY).map((t) => `'${t}'`).join(',');
// The one spend-row predicate, shared by every aggregation below.
const fanSpendWhere = (alias = '') =>
  `${alias}fan_id = ? AND ${alias}is_test = 0 AND ${alias}type IN (${SPEND_TYPES_SQL})` +
  ` AND NOT (${alias}type = 'refund' AND ${alias}gross_cents > 0)`;

function fanSpendCents(fanId, monthOnly) {
  const row = db.prepare(
    `SELECT COALESCE(SUM(gross_cents), 0) AS cents FROM transactions
     WHERE ${fanSpendWhere()}${monthOnly ? " AND created_at >= strftime('%Y-%m-01', 'now')" : ''}`
  ).get(fanId);
  return row.cents;
}

// The fan's cap in cents, or null when unset (the default — no cap).
function getFanSpendCap(fanId) {
  const u = db.prepare('SELECT spend_cap_cents FROM users WHERE id = ?').get(fanId);
  return u && u.spend_cap_cents != null ? u.spend_cap_cents : null;
}

// Everything GET /api/me/spending returns. by_category carries every
// category key (zeros included — the client hides empty rows), each with
// this-month and lifetime nets; top_models is lifetime, top 5, net > 0.
function getFanSpending(fanId) {
  const byCategory = {};
  for (const cat of [...Object.keys(SPEND_CATEGORY_TYPES), 'refunds'])
    byCategory[cat] = { category: cat, month_cents: 0, lifetime_cents: 0 };
  const rows = db.prepare(
    `SELECT type,
       SUM(gross_cents) AS lifetime_cents,
       SUM(CASE WHEN created_at >= strftime('%Y-%m-01', 'now') THEN gross_cents ELSE 0 END) AS month_cents
     FROM transactions WHERE ${fanSpendWhere()} GROUP BY type`).all(fanId);
  for (const r of rows) {
    const bucket = byCategory[SPEND_TYPE_CATEGORY[r.type]];
    if (!bucket) continue;
    bucket.lifetime_cents += r.lifetime_cents;
    bucket.month_cents += r.month_cents;
  }
  const topModels = db.prepare(
    `SELECT model_id, u.display_name AS display_name, SUM(gross_cents) AS cents
     FROM transactions t JOIN users u ON u.id = t.model_id
     WHERE ${fanSpendWhere('t.')} AND t.model_id IS NOT NULL
     GROUP BY t.model_id HAVING cents > 0 ORDER BY cents DESC LIMIT 5`).all(fanId)
    .map((r) => ({ model_id: r.model_id, display_name: r.display_name, cents: r.cents }));
  return {
    month_cents: fanSpendCents(fanId, true),
    lifetime_cents: fanSpendCents(fanId, false),
    by_category: Object.values(byCategory),
    top_models: topModels,
    cap_cents: getFanSpendCap(fanId),
  };
}

/* Response body for a refused charge. Spend-cap refusals get their own
 * code plus the cap and the month-to-date spend, so the client can say
 * exactly which limit stopped the charge; everything else keeps the
 * long-standing insufficient_credits shape. */
function chargeErrorBody(e, neededCents, fanId) {
  if (e && e.message === 'spend_cap_reached')
    return { error: 'spend_cap_reached', cap_cents: e.cap_cents ?? null,
      month_spent_cents: e.month_spent_cents ?? null, needed_cents: neededCents };
  const wallet = fanId ? getWallet(fanId) : null;
  return { error: 'insufficient_credits', needed_cents: neededCents,
    balance_cents: wallet ? wallet.credits_cents : 0 };
}

// Move money: fan pays grossCents. Throws Error('insufficient_credits') if short.
// ip is recorded on the ledger row for fraud/chargeback evidence.
function chargeFan(fanId, modelId, grossCents, type, note, ip = null) {
  const wallet = getWallet(fanId);
  if (!wallet || wallet.credits_cents < grossCents) throw new Error('insufficient_credits');
  /* Optional monthly spend cap (fan-set; NULL = no cap). Checked HERE, in
   * the single funnel every spend type flows through, so messages, PPV,
   * tips, gifts, calls, lives, bookings, games and TTS are all covered.
   * Semantics: spending UP TO the cap is allowed; a charge that would
   * CROSS it is refused whole — never partial-charged. The month's spend
   * is the net ledger sum (refunds restore headroom). Free actions never
   * reach chargeFan, so they are unaffected. */
  if (grossCents > 0) {
    const capCents = getFanSpendCap(fanId);
    if (capCents != null) {
      const monthSpent = Math.max(0, fanSpendCents(fanId, true));
      if (monthSpent + grossCents > capCents) {
        const err = new Error('spend_cap_reached');
        err.cap_cents = capCents;
        err.month_spent_cents = monthSpent;
        throw err;
      }
    }
  }
  const { modelCents, platformCents, recruiterCents, recruiterId, recruiterUserId } = splitPayment(grossCents, modelId);
  txn(() => {
    db.prepare('UPDATE wallets SET credits_cents = credits_cents - ? WHERE user_id = ?')
      .run(grossCents, fanId);
    db.prepare('UPDATE wallets SET earnings_cents = earnings_cents + ? WHERE user_id = ?')
      .run(modelCents, modelId);
    db.prepare('UPDATE platform_stats SET earnings_cents = earnings_cents + ? WHERE id = 1')
      .run(platformCents);
    if (recruiterUserId && recruiterCents > 0) {
      db.prepare('UPDATE wallets SET earnings_cents = earnings_cents + ? WHERE user_id = ?')
        .run(recruiterCents, recruiterUserId);
    }
    db.prepare(`INSERT INTO transactions
      (fan_id, model_id, type, gross_cents, model_cents, platform_cents, recruiter_id, recruiter_cents, note, ip, available_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(fanId, modelId, type, grossCents, modelCents, platformCents, recruiterId, recruiterCents, note || null, ip, earningsAvailableAt());
  });
  if (modelId) recomputeModelRank(modelId);
  return { modelCents, platformCents, recruiterCents };
}

/* Reverse a charge: fan gets grossCents back; model + platform earnings reduced.
   Used when the model declines a paid join-live request (full refund). */
function refundFan(fanId, modelId, grossCents, type, note, ip = null) {
  const { modelCents, platformCents, recruiterCents, recruiterId, recruiterUserId } = splitPayment(grossCents, modelId);
  txn(() => {
    db.prepare('UPDATE wallets SET credits_cents = credits_cents + ? WHERE user_id = ?')
      .run(grossCents, fanId);
    db.prepare('UPDATE wallets SET earnings_cents = earnings_cents - ? WHERE user_id = ?')
      .run(modelCents, modelId);
    db.prepare('UPDATE platform_stats SET earnings_cents = earnings_cents - ? WHERE id = 1')
      .run(platformCents);
    if (recruiterUserId && recruiterCents > 0) {
      db.prepare('UPDATE wallets SET earnings_cents = earnings_cents - ? WHERE user_id = ?')
        .run(recruiterCents, recruiterUserId);
    }
    db.prepare(`INSERT INTO transactions
      (fan_id, model_id, type, gross_cents, model_cents, platform_cents, recruiter_id, recruiter_cents, note, ip)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(fanId, modelId, type, -grossCents, -modelCents, -platformCents, recruiterId, -recruiterCents, note || null, ip);
  });
  if (modelId) recomputeModelRank(modelId);
  return { modelCents, platformCents, recruiterCents };
}

/* ---------------- composite model ranking ----------------
 * rank_score = like_count + (lifetime model earnings / $1).
 * Owner directive (Oct 16 2026): "Not just by fan likes, I want it by
 * likes and money earned." 1 fan like = 1 point; $1.00 of credited model
 * earnings = 1 point (float, no floor — every cent counts
 * proportionally). Lifetime totals for v1.
 *
 * Earnings = SUM(transactions.model_cents) for the model: her actual
 * credited share out of splitPayment, with refundFan's negative
 * reversal rows netting against it automatically. EXCLUDED:
 *  - 'payout' rows — money OUT to the model is recorded with a positive
 *    model_cents but it is a withdrawal, not earnings;
 *  - is_test rows — pre-launch test money never counts (the same
 *    exclusion every money display uses);
 *  - fan-side admin credit grants carry model_id NULL, so they can
 *    never enter this sum.
 * The sum equals wallets.earnings_cents + paid_out_cents for the model,
 * i.e. exactly what her own earnings views are built on.
 *
 * recomputeModelRank() is the SINGLE derivation: it re-reads both
 * sources of truth and rewrites the stored column, so it is idempotent
 * and safe to call after any mutation. Every earnings credit/reversal
 * in the codebase flows through chargeFan()/refundFan(), which call it;
 * the like endpoint calls it; a boot backfill (below) recomputes all. */
function modelEarningsCents(modelUserId) {
  return db.prepare(`SELECT COALESCE(SUM(model_cents), 0) AS cents FROM transactions
                     WHERE model_id = ? AND type <> 'payout' AND is_test = 0`).get(modelUserId).cents;
}
function recomputeModelRank(modelUserId) {
  if (!modelUserId) return 0;
  const likes = db.prepare('SELECT COUNT(*) AS n FROM model_likes WHERE model_id = ?').get(modelUserId).n;
  const score = Math.round((likes + modelEarningsCents(modelUserId) / 100) * 100) / 100;
  db.prepare('UPDATE models SET rank_score = ? WHERE user_id = ?').run(score, modelUserId);
  return score;
}
function recomputeAllModelRanks() {
  const ids = db.prepare('SELECT user_id FROM models').all();
  for (const r of ids) recomputeModelRank(r.user_id);
  return ids.length;
}
/* ---------------- Chargeback engine (Payout Protection) ----------------
   applyChargeback reverses a disputed credit load in a STRICT order,
   each step capped at what is actually there, every reversal its own
   append-only ledger row + a chargeback_allocations row (history is
   never edited):
     1. the fan's UNSPENT credits from that load (wallet down),
     2. the models' UNPAID earnings from that fan — held lots first,
        then matured lots (recruiter cents are NOT clawed back; the
        platform absorbs the recruiter share of a charged-back load).
        UNPAID means still on the platform: earnings the model already
        withdrew are cash gone, so pairUnpaid nets payouts out of the
        pair's lots (FIFO) and step 2 can never "reverse" money that
        already left — that shortfall belongs to step 3,
     3. any remainder becomes a negative adjustment (a debt) against
        the model with the largest lifetime earnings from that fan —
        INCLUDING the case where the earnings were already withdrawn
        before the chargeback landed. The debt is repaid AUTOMATICALLY:
        the lot walk offsets every future earning against it before
        anything becomes withdrawable, with no manual step and no
        out-of-pocket payment ever demanded for a chargeback shortfall.
        If no model ever earned from this fan, the platform absorbs it.
   Exactly-once: idempotent on (source, external_id); a replay is a
   no-op, and a second DISTINCT chargeback on the same load processes
   only its own amount (per-load reversals never exceed the load).
   Crypto loads can never be charged back — refused with a clear error.
   Attribution convention (wallets are fungible): step 1 uses the fan's
   live credit balance, capped by the disputed load's unreversed
   remainder when a load is referenced; step 2 walks each (fan, model)
   pair's own ledger rows in order, so a pair can never be reversed
   below zero net. A chargeback NEVER auto-bans or freezes the fan —
   it only leaves the record the fraud flags count; the owner decides. */
function applyChargeback({ source, external_id, fan_id, load_ref = null, amount_cents, reason = null, recorded_by = null }) {
  source = String(source || 'manual');
  external_id = String(external_id || '').trim();
  const amount = parseInt(amount_cents);
  if (!external_id) return { error: 'missing_external_id' };
  if (!Number.isInteger(amount) || amount <= 0) return { error: 'bad_amount' };
  if (source === 'crypto') return { error: 'crypto_not_chargebackable' };
  const fan = db.prepare('SELECT * FROM users WHERE id = ?').get(parseInt(fan_id));
  if (!fan) return { error: 'fan_not_found' };

  // Resolve the disputed load when a reference is given. load_ref may be
  // a CCBill order id, a CCBill order token, or a crypto invoice id
  // (crypto → refused: it can never be charged back).
  let loadTxn = null, loadCap = null, loadRefStored = null;
  if (load_ref !== null && load_ref !== undefined && String(load_ref) !== '') {
    const rawRef = String(load_ref);
    const forceCrypto = rawRef.startsWith('crypto_invoice:');
    const ref = rawRef.replace(/^(ccbill_order|crypto_invoice):/, '');
    const order = forceCrypto ? null : db.prepare('SELECT * FROM ccbill_orders WHERE id = ? OR token = ?')
      .get(/^\d+$/.test(ref) ? parseInt(ref) : -1, ref);
    if (order) {
      if (order.user_id !== fan.id) return { error: 'load_fan_mismatch' };
      loadTxn = db.prepare("SELECT * FROM transactions WHERE type = 'ccbill_load' AND note LIKE ?")
        .get(`%order #${order.id}%`) || null;
      loadCap = order.amount_cents;
      loadRefStored = `ccbill_order:${order.id}`;
    } else if (/^\d+$/.test(ref)
               && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='crypto_invoices'").get()) {
      const inv = db.prepare('SELECT * FROM crypto_invoices WHERE id = ?').get(parseInt(ref));
      if (inv) return { error: 'crypto_not_chargebackable' };
    }
    if (!loadRefStored) return { error: 'load_not_found' };
  }

  // Per-load cap: total reversals against one load never exceed the load.
  let remaining = amount;
  if (loadCap !== null) {
    const prior = db.prepare('SELECT COALESCE(SUM(amount_cents),0) AS s FROM chargebacks WHERE load_ref = ?')
      .get(loadRefStored).s;
    remaining = Math.min(remaining, Math.max(0, loadCap - prior));
  }

  let cbId = null;
  const reversed = { fan_cents: 0, model_cents: 0, negative_cents: 0, platform_absorbed_cents: 0 };
  try {
    txn(() => {
      const info = db.prepare(`INSERT INTO chargebacks
        (source, external_id, fan_id, load_ref, load_txn_id, amount_cents, reason, recorded_by)
        VALUES (?,?,?,?,?,?,?,?)`).run(source, external_id, fan.id, loadRefStored,
        loadTxn ? loadTxn.id : null, amount, reason ? String(reason).slice(0, 300) : null, recorded_by);
      cbId = Number(info.lastInsertRowid);
      const noteFor = (step) => `Chargeback ${source}:${external_id} (step ${step})`;
      const alloc = (modelId, step, bucket, cents, txnId) => db.prepare(
        `INSERT INTO chargeback_allocations (chargeback_id, model_id, step, bucket, amount_cents, transaction_id)
         VALUES (?,?,?,?,?,?)`).run(cbId, modelId, step, bucket, cents, txnId || null);

      /* Step 1 — the fan's unspent credits from the load. */
      if (remaining > 0) {
        const w = getWallet(fan.id);
        const take = Math.min(remaining, w ? w.credits_cents : 0);
        if (take > 0) {
          db.prepare('UPDATE wallets SET credits_cents = credits_cents - ? WHERE user_id = ?').run(take, fan.id);
          const t = db.prepare(`INSERT INTO transactions (fan_id, model_id, type, gross_cents, model_cents, note)
            VALUES (?, NULL, 'chargeback', ?, 0, ?)`).run(fan.id, -take, noteFor(1));
          alloc(null, 1, 'fan_credits', take, Number(t.lastInsertRowid));
          reversed.fan_cents = take; remaining -= take;
        }
      }

      /* Step 2 — models' unpaid earnings from this fan, held first.
         pairUnpaid nets out lots already paid out in cash; what she
         already withdrew is not reversible here and falls to step 3. */
      if (remaining > 0) {
        const pairs = db.prepare(`SELECT model_id FROM transactions
          WHERE fan_id = ? AND model_id IS NOT NULL AND is_test = 0 AND type != 'payout'
          GROUP BY model_id HAVING SUM(model_cents) > 0
          ORDER BY SUM(model_cents) DESC`).all(fan.id);
        for (const p of pairs) {
          if (remaining <= 0) break;
          const bd = pairUnpaid(p.model_id, fan.id);
          for (const bucket of ['holding', 'matured']) {
            if (remaining <= 0) break;
            const take = Math.min(remaining, bd[bucket]);
            if (take <= 0) continue;
            db.prepare('UPDATE wallets SET earnings_cents = earnings_cents - ? WHERE user_id = ?').run(take, p.model_id);
            const t = db.prepare(`INSERT INTO transactions (fan_id, model_id, type, gross_cents, model_cents, note)
              VALUES (?, ?, 'chargeback', 0, ?, ?)`).run(fan.id, p.model_id, -take, noteFor(2));
            alloc(p.model_id, 2, bucket === 'holding' ? 'held' : 'matured', take, Number(t.lastInsertRowid));
            reversed.model_cents += take; remaining -= take;
          }
        }
      }

      /* Step 3 — remainder: negative adjustment vs the model with the
         largest lifetime earnings from this fan; else platform absorbs. */
      if (remaining > 0) {
        const top = db.prepare(`SELECT model_id FROM transactions
          WHERE fan_id = ? AND model_id IS NOT NULL AND is_test = 0 AND type != 'payout' AND model_cents > 0
          GROUP BY model_id ORDER BY SUM(model_cents) DESC LIMIT 1`).get(fan.id);
        if (top) {
          db.prepare('UPDATE wallets SET earnings_cents = earnings_cents - ? WHERE user_id = ?').run(remaining, top.model_id);
          const t = db.prepare(`INSERT INTO transactions (fan_id, model_id, type, gross_cents, model_cents, note)
            VALUES (?, ?, 'chargeback_adjustment', 0, ?, ?)`).run(fan.id, top.model_id, -remaining, noteFor(3));
          alloc(top.model_id, 3, 'negative', remaining, Number(t.lastInsertRowid));
          reversed.negative_cents = remaining; remaining = 0;
        } else {
          alloc(null, 3, 'platform_absorbed', remaining, null);
          reversed.platform_absorbed_cents = remaining; remaining = 0;
        }
      }

      db.prepare(`UPDATE chargebacks SET reversed_fan_cents = ?, reversed_model_cents = ?,
        negative_cents = ? WHERE id = ?`).run(reversed.fan_cents, reversed.model_cents,
        reversed.negative_cents + reversed.platform_absorbed_cents, cbId);
    });
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE constraint failed: chargebacks'))
      return { ok: true, duplicate: true };
    throw e;
  }
  console.log(`[chargeback] ${source}:${external_id} fan #${fan.id} $${(amount / 100).toFixed(2)} → fan ${reversed.fan_cents}¢, models ${reversed.model_cents}¢, negative ${reversed.negative_cents}¢, absorbed ${reversed.platform_absorbed_cents}¢ (recorded_by ${recorded_by || 'system'})`);
  return { ok: true, chargeback_id: cbId, reversed };
}

/* Fraud flags — ADVISORY ONLY. They never block, hold, or reject a
   payout by themselves; the owner sees them in the Manager before
   approving. Thresholds are the Manager-editable flag_* settings. */
function getModelFraudFlags(modelId) {
  const s = getPayoutSettings();
  const flags = [];
  // (a) Concentration: one fan's spend on this model is ≥ pct of that
  // fan's lifetime spend, the fan account is younger than the window,
  // and the fan's lifetime spend clears the floor.
  const conc = db.prepare(`SELECT t.fan_id, u.display_name AS fan_name, u.created_at,
      SUM(t.gross_cents) AS pair_spend,
      (SELECT COALESCE(SUM(gross_cents),0) FROM transactions
        WHERE fan_id = t.fan_id AND is_test = 0 AND gross_cents > 0 AND model_id IS NOT NULL) AS life_spend
    FROM transactions t JOIN users u ON u.id = t.fan_id
    WHERE t.model_id = ? AND t.is_test = 0 AND t.gross_cents > 0
    GROUP BY t.fan_id`).all(modelId);
  for (const r of conc) {
    if (r.life_spend < s.concentrationMinCents) continue;
    if (r.pair_spend * 100 < r.life_spend * s.concentrationPct) continue;
    const ageDays = (Date.now() - new Date(String(r.created_at).replace(' ', 'T') + 'Z').getTime()) / 86400000;
    if (!(ageDays < s.concentrationDays)) continue;
    flags.push({ kind: 'concentration', level: 'info', fan_id: r.fan_id, fan_name: r.fan_name,
      label: `New fan, concentrated spend — ${r.fan_name || 'a fan'} put ${Math.round(r.pair_spend * 100 / r.life_spend)}% of their ${fmt$(r.life_spend)} lifetime spend on this model within their first ${s.concentrationDays} days` });
  }
  // (b) Chargeback rate: model-attributed chargebacks ÷ attributed
  // loads (loads by fans who have spent with this model).
  const cbCount = db.prepare(`SELECT COUNT(DISTINCT chargeback_id) AS n FROM chargeback_allocations
    WHERE model_id = ? AND step IN (2,3)`).get(modelId).n;
  if (cbCount > 0) {
    const loadCount = db.prepare(`SELECT COUNT(*) AS n FROM transactions
      WHERE type IN ('ccbill_load','crypto_load') AND fan_id IN
        (SELECT DISTINCT fan_id FROM transactions WHERE model_id = ? AND is_test = 0 AND fan_id IS NOT NULL)`)
      .get(modelId).n;
    const rate = loadCount > 0 ? cbCount / loadCount : 1;
    const escalated = cbCount >= s.cbEscalateCount || rate >= s.cbEscalateRatePct / 100;
    flags.push({ kind: 'chargeback_rate', level: escalated ? 'escalated' : 'info',
      label: `${cbCount} chargeback${cbCount === 1 ? '' : 's'} across ${loadCount} attributed load${loadCount === 1 ? '' : 's'} (${Math.round(rate * 100)}%)` });
  }
  // (c) Shared payment signal: ≥2 fans who spent with this model used
  // the same card fingerprint at checkout (purchase_attempts). No
  // signup/login IP exists in the schema, so IP matching is NOT done.
  const shared = db.prepare(`SELECT pa.card_fingerprint AS fp, COUNT(DISTINCT pa.user_id) AS fans
    FROM purchase_attempts pa
    WHERE pa.card_fingerprint IS NOT NULL AND pa.user_id IN
      (SELECT DISTINCT fan_id FROM transactions WHERE model_id = ? AND is_test = 0 AND fan_id IS NOT NULL)
    GROUP BY pa.card_fingerprint HAVING COUNT(DISTINCT pa.user_id) >= 2`).all(modelId);
  for (const r of shared) flags.push({ kind: 'shared_card', level: 'info',
    label: `${r.fans} fans who spent with this model share a payment card fingerprint` });
  return flags;
}

/* ---------------- identity: logged-in user OR guest ---------------- */

// Sessions stored in DB (on persistent disk) so logins survive deploys
db.exec(`CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
// Passkey (WebAuthn) credentials — Phase 1. Only the credential PUBLIC key is
// stored; the private key / biometric never leaves the user's device.
db.exec(`CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,
  device_label TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT
)`);
addColumnIfMissing('sessions', 'passkey_verified_at', 'TEXT'); // set when this session passed the Manager Face ID step-up; enforced by requirePasskeyStepUp once the admin has a passkey enrolled
const bannedGuests = new Set();  // guest tokens banned by admin (in-memory, MVP)
const socketsBySubject = new Map(); // 'u:123' | 'g:token' -> Set<ws>
const adminTempTokens = new Map();  // tempToken -> { userId, expiresAt } (2FA pending)
const adminLoginAttempts = new Map(); // ip -> { count, resetAt } (rate limit)

/* ---- SMS 2FA for admin (Twilio) ---- */

function getAdmin2FAState() {
  const r = db.prepare('SELECT admin_phone, admin_2fa_on FROM platform_stats WHERE id = 1').get();
  return { phone: r ? r.admin_phone : null, on: r ? !!r.admin_2fa_on : false };
}

async function sendAdminSMS(to, body) {
  const sid = process.env.TWILIO_SID, token = process.env.TWILIO_TOKEN, from = process.env.TWILIO_FROM;
  if (!sid || !token || !from) return { ok: false, error: 'sms_not_configured' };
  try {
    const auth = Buffer.from(sid + ':' + token).toString('base64');
    const params = new URLSearchParams({ From: from, To: to, Body: body });
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
      method: 'POST',
      headers: { 'Authorization': 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    if (!r.ok) return { ok: false, error: 'sms_failed' };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'sms_failed' };
  }
}

function genSmsCode() {
  return String(crypto.randomInt(100000, 1000000));
}

// Issue a fresh code for the user (invalidates older ones). Returns the code.
function issueSmsCode(userId) {
  db.prepare('DELETE FROM sms_codes WHERE user_id = ?').run(userId);
  const code = genSmsCode();
  db.prepare('INSERT INTO sms_codes (user_id, code, expires_at) VALUES (?, ?, ?)')
    .run(userId, code, Date.now() + 5 * 60 * 1000);
  return code;
}

function adminRateLimited(ip) {
  const now = Date.now();
  let rec = adminLoginAttempts.get(ip);
  if (!rec || now > rec.resetAt) {
    rec = { count: 0, resetAt: now + 60000 };
    adminLoginAttempts.set(ip, rec);
  }
  rec.count++;
  return rec.count > 5;
}

function createAdminTempToken(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  adminTempTokens.set(token, { userId, expiresAt: Date.now() + 10 * 60 * 1000 });
  return token;
}

function maskPhone(phone) {
  if (!phone) return '';
  const digits = String(phone).replace(/\D/g, '');
  return '•••' + digits.slice(-4);
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?,?)').run(token, userId);
  return token;
}

function getSessionUserId(token) {
  const r = db.prepare('SELECT user_id FROM sessions WHERE token = ?').get(token);
  return r ? r.user_id : null;
}

function deleteSession(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function deleteUserSessions(userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

// Returns {kind:'user',user} | {kind:'guest',token} | {kind:'banned'} | null
function getIdentity(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) {
    const userId = getSessionUserId(h.slice(7));
    if (!userId) return null;
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) return null;
    if (user.banned) return { kind: 'banned' };
    if (user.status === 'frozen') return { kind: 'frozen' };
    return { kind: 'user', user };
  }
  const g = req.headers['x-guest-token'] || (req.body && req.body.guest_token) || req.query.guest_token;
  if (g && typeof g === 'string' && /^[a-f0-9]{32}$/.test(g)) {
    if (bannedGuests.has(g)) return { kind: 'banned' };
    return { kind: 'guest', token: g };
  }
}

const subjectKey = (ident) =>
  ident.kind === 'user' ? `u:${ident.user.id}` : `g:${ident.token}`;

// Client IP (Render sits behind a proxy — trust x-forwarded-for first hop)
const clientIp = (req) => {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.ip || (req.socket && req.socket.remoteAddress) || '';
};

/* ---------------- Region blocking (lib/geo.js) ----------------
   Models can hide themselves from regions (country/state/county/city).
   Resolution is IP-based and FAIL-OPEN: unknown location = never blocked. */
const geoOfReq = (req) => geoLib.lookupIp(clientIp(req));
function modelRegionBlocked(modelId, geo) {
  if (!geo) return false;
  const blocks = db.prepare('SELECT * FROM model_region_blocks WHERE model_id = ?').all(modelId);
  return geoLib.matchesAny(blocks, geo);
}
// Every model id blocked for this geo (one pass — used by list endpoints)
function blockedModelIds(geo) {
  if (!geo) return new Set();
  const set = new Set();
  for (const b of db.prepare('SELECT * FROM model_region_blocks').all()) {
    if (geoLib.blockMatches(b, geo)) set.add(b.model_id);
  }
  return set;
}
const regionBlocked = (res) => res.status(403).json({ error: 'region_blocked',
  message: 'This model is not available in your region.' });

/* ---------------- Pre-purchase explicit-media shield ----------------
   Decision layer lives in lib/shield.js (pure + unit-tested). ACTIVE
   only when an AV provider is configured; while dormant every helper
   below answers "not shielded" and behavior is byte-for-byte today's.
   Explicit-flagged free chat media is then withheld (payload flag +
   byte gates) from unverified fans in regulated/unknown locations,
   explicit live/call entry refuses them, and public preview loops are
   withheld from shielded viewers. Owners (the sender), other models,
   and admins always see media clear. */
function shieldLocForUser(req, user) {
  return shieldLib.resolveAvLocation(user && user.fan_state, geoOfReq(req));
}
function shieldAppliesToIdent(req, ident) {
  if (!ident) return shieldLib.guestShielded(shieldLib.resolveAvLocation(null, geoOfReq(req)));
  if (ident.kind === 'guest') return shieldLib.guestShielded(shieldLib.resolveAvLocation(null, geoOfReq(req)));
  if (ident.kind !== 'user') return false;
  return shieldLib.fanShielded(ident.user, shieldLocForUser(req, ident.user));
}
/* Same rule from a bare users row (WS pushes, where the receiver is not
   the requester: location resolves from the stored fan_state alone,
   so unknown state fails closed exactly like the request path). */
function shieldAppliesToUserRow(user) {
  return shieldLib.fanShielded(user, shieldLib.resolveAvLocation(user && user.fan_state, null));
}
const avRequired = (res) => res.status(403).json({ error: 'av_required',
  message: 'Age verification is required before this purchase in your state. Verify once at your first credit purchase.' });
// Role of the Bearer-session viewer on public endpoints (null = guest/anon)
function viewerRoleOf(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return null;
  const uid = getSessionUserId(h.slice(7));
  if (!uid) return null;
  const u = db.prepare('SELECT role FROM users WHERE id = ?').get(uid);
  return u ? u.role : null;
}

function identMiddleware(req, res, next) {
  const ident = getIdentity(req);
  if (!ident) return res.status(401).json({ error: 'not_logged_in' });
  if (ident.kind === 'banned') return res.status(403).json({ error: 'banned' });
  if (ident.kind === 'frozen') return res.status(403).json({ error: 'account_frozen',
    message: 'Your account has been frozen due to a billing dispute. Contact support.' });
  req.ident = ident;
  next();
}

const requireUser = (req, res, next) => {
  if (req.ident.kind !== 'user') return res.status(401).json({ error: 'login_required' });
  req.user = req.ident.user;
  next();
};

const requireRole = (...roles) => (req, res, next) => {
  if (req.ident.kind !== 'user' || !roles.includes(req.ident.user.role)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  req.user = req.ident.user;
  next();
};

function pushToSubject(key, event) {
  const set = socketsBySubject.get(key);
  if (!set) return;
  const data = JSON.stringify(event);
  for (const ws of set) if (ws.readyState === 1) ws.send(data);
}
const pushToUser = (userId, e) => pushToSubject(`u:${userId}`, e);

/* ---------------- notifications + web push ----------------
   notifyUser(): writes an in-app notification row, pushes it live over WS,
   and attempts a Web Push (requires VAPID keys — see below).
   Web Push setup: set env VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT
   and `npm install web-push`. Without keys, in-app + WS notifications still
   work; sendWebPush logs a one-time note and returns. */
let _webPushWarned = false;
async function sendWebPush(userId, payload) {
  const pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) {
    if (!_webPushWarned) {
      _webPushWarned = true;
      console.log('[push] VAPID keys not configured — Web Push disabled. ' +
        'Set VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY/VAPID_SUBJECT and install web-push to enable.');
    }
    return { sent: 0, skipped: true };
  }
  let webpush;
  try { webpush = require('web-push'); }
  catch (e) { console.log('[push] web-push package not installed — run: npm install web-push'); return { sent: 0, skipped: true }; }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@slutcamp.app', pub, priv);
  const subs = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId);
  let sent = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload));
      sent++;
    } catch (e) {
      // 410 Gone / 404 = dead subscription — clean it up
      if (e.statusCode === 410 || e.statusCode === 404)
        db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(s.id);
    }
  }
  return { sent, skipped: false };
}

// Total unread DM messages waiting for a user — the exact math behind
// GET /api/conversations (each conversation's unread_count summed), so the
// home-screen icon badge can never disagree with the in-app badges.
function totalUnreadDms(userId) {
  if (!userId) return 0;
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE (c.fan_id = ? OR c.model_id = ?)
      AND m.sender_id != ? AND m.is_read = 0`).get(userId, userId, userId);
  return row ? row.n : 0;
}

function notifyUser(userId, type, title, body, link) {
  const info = db.prepare(
    `INSERT INTO notifications (user_id, type, title, body, link) VALUES (?,?,?,?,?)`)
    .run(userId, type, title, body || null, link || null);
  const n = db.prepare('SELECT * FROM notifications WHERE id = ?').get(info.lastInsertRowid);
  pushToUser(userId, { type: 'notification:new', notification: n });
  sendWebPush(userId, { title, body: body || '', link: link || '/',
    badge_unread: totalUnreadDms(userId) }).catch(() => {});
  return n;
}

// Phone buzz for a new chat message — Web Push only, no bell row (the
// conversation unread badge covers in-app). Skipped when the recipient is
// in the app right now: their socket already delivered it live.
function buzzChatRecipient(userId, title, body) {
  if (!userId) return;
  const set = socketsBySubject.get(`u:${userId}`);
  if (set && set.size) return;
  // badge_unread is counted AFTER the new message was saved (callers buzz
  // post-insert), so the icon badge includes the message that just landed.
  sendWebPush(userId, { title, body, link: '/',
    badge_unread: totalUnreadDms(userId) }).catch(() => {});
}

// Notify every online admin about something (safety incidents, etc.)
function pushToAdmins(event) {
  const admins = db.prepare(`SELECT id FROM users WHERE role = 'admin'`).all();
  for (const a of admins) pushToUser(a.id, event);
}

// 2257 ID verification: a model must be approved before going live.
// (Since Oct 15 it no longer gates fan→model texting — owner rule: fans
// can always text her; the message waits in her inbox.)
function isIdVerified(modelUserId) {
  const r = db.prepare('SELECT status FROM id_verifications WHERE model_id = ?').get(modelUserId);
  return !!(r && r.status === 'approved');
}

/* ------------------------------------------------------------------ */
/* Safety monitor                                                      */
/* ------------------------------------------------------------------ */

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Returns the matched keyword/reason, or null if clean.
function safetyScan(text) {
  const kws = db.prepare('SELECT keyword FROM safety_keywords WHERE enabled = 1').all();
  for (const { keyword } of kws) {
    // Word-boundary match so 'ig' doesn't flag 'big', 'snap' doesn't flag 'snapshot'.
    const re = new RegExp(`\\b${escapeRegExp(keyword)}\\b`, 'i');
    if (re.test(text)) return keyword;
  }
  // Phone numbers: 123-456-7890, (123) 456-7890, 1234567890, 123 456 7890
  if (/\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/.test(text)) return 'phone_number';
  if (/\(\d{3}\)\s?\d{3}[-.\s]?\d{4}/.test(text)) return 'phone_number';
  if (/\b\d{10}\b/.test(text)) return 'phone_number';
  // Email addresses
  if (/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(text)) return 'email_address';
  // Street addresses: 123 Main St, 456 Oak Avenue, 789 Elm Rd, etc.
  if (/\b\d{1,6}\s+[A-Za-z][A-Za-z.'-]*(\s+[A-Za-z][A-Za-z.'-]*){0,3}\s+(st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|ct|court|way|pl|place|ter|terrace|pkwy|parkway|cir|circle|trl|trail|hwy|highway)\b/i.test(text)) return 'street_address';
  // ZIP codes: 12345 or 12345-6789
  if (/\b\d{5}(-\d{4})?\b/.test(text)) return 'zip_code';
  // Payment info: Cash App, Venmo, PayPal, Zelle, card numbers — triggers immediate live kill
  if (/\$[a-zA-Z][a-zA-Z0-9_]{1,}/.test(text)) return 'payment_cashtag'; // $cashtag
  if (/\b(cash\s?app|venmo|paypal|zelle|apple\s?pay|cashapp)\b/i.test(text)) return 'payment_app';
  if (/\b\d{4}[-.\s]?\d{4}[-.\s]?\d{4}[-.\s]?\d{4}\b/.test(text)) return 'payment_card';
  // Social media outside the app: handles, platforms, follow/DM requests
  if (/\b(instagram|insta|snapchat|snap|tiktok|tik\s?tok|twitter|facebook|fb|whatsapp|telegram|onlyfans)\b/i.test(text)) return 'social_media';
  if (/\b(follow me|dm me|add me|find me|link in bio|my (insta|snap|tik ?tok|twitter))\b/i.test(text)) return 'social_media';
  if (/(^|\s)@[a-zA-Z0-9._]{2,}/.test(text)) return 'social_handle';
  return null;
}

// Record a strike; returns total strikes. Flags account at 3.
function addStrike(key) {
  const row = db.prepare('SELECT * FROM strikes WHERE subject_key = ?').get(key);
  const n = (row ? row.strikes : 0) + 1;
  db.prepare(`INSERT INTO strikes (subject_key, strikes, flagged)
              VALUES (?, ?, ?)
              ON CONFLICT(subject_key) DO UPDATE SET strikes = ?, flagged = ?`)
    .run(key, n, n >= 3 ? 1 : 0, n, n >= 3 ? 1 : 0);
  return n;
}

/* ------------------------------------------------------------------ */
/* Seed data                                                           */
/* ------------------------------------------------------------------ */

// Signup language: the client sends its UI language (browser-detected on
// first visit); only the 13 supported codes are honored, anything else
// falls back to 'en'. Stored on the user row at creation so her welcome
// DM lands in her language.
function signupLanguage(req) {
  const l = String((req.body && req.body.language) || '').toLowerCase();
  return SUPPORTED_LANGS.includes(l) ? l : 'en';
}

function createUser(username, password, role, displayName, dob, language) {
  const lang = SUPPORTED_LANGS.includes(language) ? language : 'en';
  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare(
    'INSERT INTO users (username, password_hash, role, display_name, dob, language) VALUES (?,?,?,?,?,?)'
  ).run(username, hash, role, displayName, dob, lang);
  db.prepare('INSERT INTO wallets (user_id) VALUES (?)').run(info.lastInsertRowid);
  if (role === 'model') {
    db.prepare('INSERT INTO models (user_id) VALUES (?)').run(info.lastInsertRowid);
    // Automatic: the congratulations/welcome message lands in her inbox.
    try { sendModelWelcome(Number(info.lastInsertRowid)); } catch (e) { /* boot sweep retries */ }
    // Right behind it: the "how it works / how you make money" playbook DM.
    try { sendModelGuide(Number(info.lastInsertRowid)); } catch (e) { /* boot sweep retries */ }
    // And the 1-minute tour video — sent only once the video file exists.
    try { sendModelGuideVideo(Number(info.lastInsertRowid)); } catch (e) { /* boot sweep retries */ }
    // And the add-to-home-screen video — sent only once the video file exists.
    try { sendModelHomeScreenVideo(Number(info.lastInsertRowid)); } catch (e) { /* boot sweep retries */ }
    // And the ID-verification step — the last setup gate (going live +
    // payouts stay locked until her ID is approved).
    try { sendModelIdVerify(Number(info.lastInsertRowid)); } catch (e) { /* boot sweep retries */ }
    // And the affiliate program — earn 20% recruiting other models.
    try { sendModelAffiliate(Number(info.lastInsertRowid)); } catch (e) { /* boot sweep retries */ }
  }
  return Number(info.lastInsertRowid);
}

/* ------------------------------------------------------------------ */
/* Server-side string table (SRV) — notification bells, admin DM      */
/* texts and announcement copy in all 13 supported languages.         */
/* srv(key, lang, vars): recipient-language lookup with EN fallback;  */
/* {var} placeholders substitute exactly like the client's t().       */
/* The welcome/guide DM bodies keep their own per-language maps       */
/* (MODEL_WELCOME / MODEL_GUIDE / MODEL_ID_VERIFY / MODEL_AFFILIATE)  */
/* below — this table covers everything composed at a call site.      */
/* ------------------------------------------------------------------ */
const SRV = {
  guide_video_text: { en: '🎬 Watch your 1-minute tour: https://slutcamp.app/video/model-guide.mp4', es: '🎬 Mira tu tour de 1 minuto: https://slutcamp.app/video/model-guide.mp4', pt: '🎬 Assista ao seu tour de 1 minuto: https://slutcamp.app/video/model-guide.mp4', fr: '🎬 Regardez votre visite d\'1 minute : https://slutcamp.app/video/model-guide.mp4', de: '🎬 Schau dir deine 1-minütige Tour an: https://slutcamp.app/video/model-guide.mp4', ru: '🎬 Смотрите ваш 1-минутный тур: https://slutcamp.app/video/model-guide.mp4', ja: '🎬 1分ツアーを見てね：https://slutcamp.app/video/model-guide.mp4', zh: '🎬 观看你的 1 分钟导览：https://slutcamp.app/video/model-guide.mp4', ko: '🎬 1분 투어 보기: https://slutcamp.app/video/model-guide.mp4', it: '🎬 Guarda il tuo tour di 1 minuto: https://slutcamp.app/video/model-guide.mp4', pl: '🎬 Obejrzyj swoją 1-minutową wycieczkę: https://slutcamp.app/video/model-guide.mp4', nl: '🎬 Bekijk je 1-minuut tour: https://slutcamp.app/video/model-guide.mp4', tr: '🎬 1 dakikalık turunu izle: https://slutcamp.app/video/model-guide.mp4' },
  ath_video_text: { en: '📲 Put SlutCamp on your home screen — watch this, takes 30 seconds: https://slutcamp.app/video/add-to-home-screen.mp4', es: '📲 Pon SlutCamp en tu pantalla de inicio — mira esto, toma 30 segundos: https://slutcamp.app/video/add-to-home-screen.mp4', pt: '📲 Coloque a SlutCamp na sua tela inicial — assista a isto, leva 30 segundos: https://slutcamp.app/video/add-to-home-screen.mp4', fr: '📲 Mettez SlutCamp sur votre écran d\'accueil — regardez ceci, ça prend 30 secondes : https://slutcamp.app/video/add-to-home-screen.mp4', de: '📲 SlutCamp auf deinen Startbildschirm legen — schau dir das an, dauert 30 Sekunden: https://slutcamp.app/video/add-to-home-screen.mp4', ru: '📲 Добавьте SlutCamp на главный экран — посмотрите это, займёт 30 секунд: https://slutcamp.app/video/add-to-home-screen.mp4', ja: '📲 SlutCampをホーム画面に追加 — これを見てね、30秒で終わるよ：https://slutcamp.app/video/add-to-home-screen.mp4', zh: '📲 把 SlutCamp 放到你的主屏幕 — 看看这个，只需 30 秒：https://slutcamp.app/video/add-to-home-screen.mp4', ko: '📲 홈 화면에 SlutCamp 추가하기 — 이 영상을 보세요, 30초면 됩니다: https://slutcamp.app/video/add-to-home-screen.mp4', it: '📲 Metti SlutCamp sulla tua schermata home — guarda questo, ci vogliono 30 secondi: https://slutcamp.app/video/add-to-home-screen.mp4', pl: '📲 Umieść SlutCamp na ekranie głównym — obejrzyj to, zajmuje 30 sekund: https://slutcamp.app/video/add-to-home-screen.mp4', nl: '📲 Zet SlutCamp op je startscherm — bekijk dit, duurt 30 seconden: https://slutcamp.app/video/add-to-home-screen.mp4', tr: '📲 SlutCamp\'i ana ekranına koy — bunu izle, 30 saniye sürer: https://slutcamp.app/video/add-to-home-screen.mp4' },
  bell_welcome_title: { en: '🎉 Welcome to SlutCamp!', es: '🎉 ¡Bienvenida a SlutCamp!', pt: '🎉 Bem-vinda à SlutCamp!', fr: '🎉 Bienvenue sur SlutCamp !', de: '🎉 Willkommen bei SlutCamp!', ru: '🎉 Добро пожаловать в SlutCamp!', ja: '🎉 SlutCampへようこそ！', zh: '🎉 欢迎来到 SlutCamp！', ko: '🎉 SlutCamp에 오신 것을 환영합니다!', it: '🎉 Benvenuta su SlutCamp!', pl: '🎉 Witaj w SlutCamp!', nl: '🎉 Welkom bij SlutCamp!', tr: '🎉 SlutCamp\'e hoş geldin!' },
  bell_welcome_body: { en: 'Congratulations — Asce sent you a message in your inbox 💋', es: 'Felicidades — Asce te envió un mensaje a tu bandeja 💋', pt: 'Parabéns — Asce te enviou uma mensagem na sua caixa de entrada 💋', fr: 'Félicitations — Asce vous a envoyé un message dans votre boîte 💋', de: 'Glückwunsch — Asce hat dir eine Nachricht in dein Postfach geschickt 💋', ru: 'Поздравляем — Asce отправил вам сообщение в ваши входящие 💋', ja: 'おめでとう — Asceから受信箱にメッセージが届いています 💋', zh: '恭喜 — Asce 在你的收件箱里给你发了一条消息 💋', ko: '축하합니다 — Asce가 받은편지함에 메시지를 보냈습니다 💋', it: 'Congratulazioni — Asce ti ha mandato un messaggio nella tua inbox 💋', pl: 'Gratulacje — Asce wysłał Ci wiadomość do skrzynki odbiorczej 💋', nl: 'Gefeliciteerd — Asce heeft je een bericht gestuurd in je inbox 💋', tr: 'Tebrikler — Asce sana gelen kutunda bir mesaj gönderdi 💋' },
  bell_guide_title: { en: '💋 How SlutCamp works', es: '💋 Cómo funciona SlutCamp', pt: '💋 Como a SlutCamp funciona', fr: '💋 Comment fonctionne SlutCamp', de: '💋 So funktioniert SlutCamp', ru: '💋 Как работает SlutCamp', ja: '💋 SlutCampの仕組み', zh: '💋 SlutCamp 如何运作', ko: '💋 SlutCamp 이용 방법', it: '💋 Come funziona SlutCamp', pl: '💋 Jak działa SlutCamp', nl: '💋 Hoe SlutCamp werkt', tr: '💋 SlutCamp nasıl çalışır' },
  bell_guide_body: { en: 'Asce sent you the playbook — how the app works and how you get paid 💰', es: 'Asce te envió la guía — cómo funciona la app y cómo te pagan 💰', pt: 'Asce te enviou o manual — como o app funciona e como você recebe 💰', fr: 'Asce vous a envoyé le guide — comment l\'appli fonctionne et comment vous êtes payée 💰', de: 'Asce hat dir das Playbook geschickt — wie die App funktioniert und wie du bezahlt wirst 💰', ru: 'Asce отправил вам руководство — как работает приложение и как вы получаете оплату 💰', ja: 'Asceがプレイブックを送りました — アプリの仕組みと支払いの受け方 💰', zh: 'Asce 给你发了手册 — 应用如何运作以及你如何获得报酬 💰', ko: 'Asce가 플레이북을 보냈습니다 — 앱 이용 방법과 수익을 받는 방법 💰', it: 'Asce ti ha mandato la guida — come funziona l\'app e come vieni pagata 💰', pl: 'Asce wysłał Ci przewodnik — jak działa aplikacja i jak otrzymujesz wypłaty 💰', nl: 'Asce heeft je het playbook gestuurd — hoe de app werkt en hoe je betaald krijgt 💰', tr: 'Asce sana rehberi gönderdi — uygulama nasıl çalışır ve nasıl ödeme alırsın 💰' },
  bell_guide_video_title: { en: '🎬 Your 1-minute tour is here', es: '🎬 Tu tour de 1 minuto ya llegó', pt: '🎬 Seu tour de 1 minuto chegou', fr: '🎬 Votre visite d\'1 minute est là', de: '🎬 Deine 1-minütige Tour ist da', ru: '🎬 Ваш 1-минутный тур здесь', ja: '🎬 あなたの1分ツアーが届きました', zh: '🎬 你的 1 分钟导览来了', ko: '🎬 1분 투어가 도착했습니다', it: '🎬 Il tuo tour di 1 minuto è qui', pl: '🎬 Twoja 1-minutowa wycieczka jest tutaj', nl: '🎬 Je 1-minuut tour is hier', tr: '🎬 1 dakikalık turun burada' },
  bell_guide_video_body: { en: 'Asce sent you a quick video tour of how SlutCamp works 💋', es: 'Asce te envió un tour rápido en video de cómo funciona SlutCamp 💋', pt: 'Asce te enviou um tour rápido em vídeo de como a SlutCamp funciona 💋', fr: 'Asce vous a envoyé une visite vidéo rapide de SlutCamp 💋', de: 'Asce hat dir eine kurze Videotour geschickt, wie SlutCamp funktioniert 💋', ru: 'Asce отправил вам короткий видеотур о том, как работает SlutCamp 💋', ja: 'AsceがSlutCampの仕組みを説明する短いビデオツアーを送りました 💋', zh: 'Asce 给你发了一个关于 SlutCamp 如何运作的快速视频导览 💋', ko: 'Asce가 SlutCamp 이용 방법을 담은 짧은 영상 투어를 보냈습니다 💋', it: 'Asce ti ha mandato un rapido tour video di come funziona SlutCamp 💋', pl: 'Asce wysłał Ci krótką wycieczkę wideo o tym, jak działa SlutCamp 💋', nl: 'Asce heeft je een snelle videotour gestuurd over hoe SlutCamp werkt 💋', tr: 'Asce sana SlutCamp\'in nasıl çalıştığına dair hızlı bir video turu gönderdi 💋' },
  bell_home_screen_title: { en: '📲 Put SlutCamp on your home screen', es: '📲 Pon SlutCamp en tu pantalla de inicio', pt: '📲 Coloque a SlutCamp na sua tela inicial', fr: '📲 Mettez SlutCamp sur votre écran d\'accueil', de: '📲 SlutCamp auf deinen Startbildschirm legen', ru: '📲 Добавьте SlutCamp на главный экран', ja: '📲 SlutCampをホーム画面に追加', zh: '📲 把 SlutCamp 放到你的主屏幕', ko: '📲 홈 화면에 SlutCamp 추가하기', it: '📲 Metti SlutCamp sulla tua schermata home', pl: '📲 Umieść SlutCamp na ekranie głównym', nl: '📲 Zet SlutCamp op je startscherm', tr: '📲 SlutCamp\'i ana ekranına koy' },
  bell_home_screen_body: { en: 'Asce sent you a 30-second video showing how to add SlutCamp to your home screen 💋', es: 'Asce te envió un video de 30 segundos que muestra cómo agregar SlutCamp a tu pantalla de inicio 💋', pt: 'Asce te enviou um vídeo de 30 segundos mostrando como adicionar a SlutCamp à sua tela inicial 💋', fr: 'Asce vous a envoyé une vidéo de 30 secondes montrant comment ajouter SlutCamp à votre écran d\'accueil 💋', de: 'Asce hat dir ein 30-Sekunden-Video geschickt, das zeigt, wie du SlutCamp zu deinem Startbildschirm hinzufügst 💋', ru: 'Asce отправил вам 30-секундное видео, показывающее, как добавить SlutCamp на главный экран 💋', ja: 'AsceがSlutCampをホーム画面に追加する方法を説明する30秒動画を送りました 💋', zh: 'Asce 给你发了一个 30 秒的视频，展示如何把 SlutCamp 添加到你的主屏幕 💋', ko: 'Asce가 홈 화면에 SlutCamp를 추가하는 방법을 보여주는 30초 영상을 보냈습니다 💋', it: 'Asce ti ha mandato un video di 30 secondi che mostra come aggiungere SlutCamp alla tua schermata home 💋', pl: 'Asce wysłał Ci 30-sekundowe wideo pokazujące, jak dodać SlutCamp do ekranu głównego 💋', nl: 'Asce heeft je een video van 30 seconden gestuurd die laat zien hoe je SlutCamp aan je startscherm toevoegt 💋', tr: 'Asce sana SlutCamp\'i ana ekranına nasıl ekleyeceğini gösteren 30 saniyelik bir video gönderdi 💋' },
  bell_id_verify_title: { en: '🪪 One last step: verify your ID', es: '🪪 Un último paso: verifica tu ID', pt: '🪪 Um último passo: verifique seu documento', fr: '🪪 Dernière étape : vérifiez votre pièce d\'identité', de: '🪪 Ein letzter Schritt: Verifiziere deinen Ausweis', ru: '🪪 Последний шаг: подтвердите ваше удостоверение личности', ja: '🪪 最後のステップ：身分証を確認', zh: '🪪 最后一步：验证你的身份证件', ko: '🪪 마지막 단계: 신분증 인증하기', it: '🪪 Ultimo passo: verifica il tuo documento', pl: '🪪 Ostatni krok: zweryfikuj swój dokument tożsamości', nl: '🪪 Laatste stap: verifieer je ID', tr: '🪪 Son bir adım: Kimliğini doğrula' },
  bell_id_verify_body: { en: 'It unlocks going live and getting paid — 2 minutes in Settings 💋', es: 'Desbloquea salir en vivo y cobrar — 2 minutos en Ajustes 💋', pt: 'Isso libera entrar ao vivo e receber — 2 minutos em Configurações 💋', fr: 'Cela débloque le direct et les paiements — 2 minutes dans Paramètres 💋', de: 'Es schaltet Live-Gehen und Bezahltwerden frei — 2 Minuten in den Einstellungen 💋', ru: 'Это открывает выход в эфир и получение оплаты — 2 минуты в Настройках 💋', ja: 'ライブ配信と支払い受け取りがアンロックされます — 設定で2分 💋', zh: '它能解锁开播和获得报酬 — 在设置中只需 2 分钟 💋', ko: '라이브와 수익 받기가 잠금 해제됩니다 — 설정에서 2분이면 됩니다 💋', it: 'Sblocca l\'andare live e l\'essere pagata — 2 minuti in Impostazioni 💋', pl: 'Odblokowuje transmisje na żywo i wypłaty — 2 minuty w Ustawieniach 💋', nl: 'Het ontgrendelt live gaan en betaald krijgen — 2 minuten in Instellingen 💋', tr: 'Canlıya geçmeyi ve ödeme almayı açar — Ayarlar\'da 2 dakika 💋' },
  bell_affiliate_title: { en: '💰 Make money bringing models', es: '💰 Gana dinero trayendo modelos', pt: '💰 Ganhe dinheiro trazendo modelos', fr: '💰 Gagnez de l\'argent en amenant des modèles', de: '💰 Verdiene Geld, indem du Modelle bringst', ru: '💰 Зарабатывайте, привлекая моделей', ja: '💰 モデルを紹介して稼ごう', zh: '💰 靠带来模特赚钱', ko: '💰 모델을 데려와 수익을 얻으세요', it: '💰 Guadagna portando modelle', pl: '💰 Zarabiaj, przyprowadzając modelki', nl: '💰 Verdien geld door modellen te brengen', tr: '💰 Model getirerek para kazan' },
  bell_affiliate_body: { en: 'Earn 20% of everything your recruited models make — reply here for your link 💋', es: 'Gana el 20% de todo lo que ganen las modelos que reclutes — responde aquí para obtener tu enlace 💋', pt: 'Ganhe 20% de tudo o que suas modelos recrutadas ganharem — responda aqui para receber seu link 💋', fr: 'Gagnez 20% de tout ce que vos modèles recrutées gagnent — répondez ici pour votre lien 💋', de: 'Verdiene 20% von allem, was deine angeworbenen Modelle verdienen — antworte hier für deinen Link 💋', ru: 'Зарабатывайте 20% от всего, что зарабатывают привлечённые вами модели — ответьте здесь, чтобы получить вашу ссылку 💋', ja: 'あなたが募集したモデルの収益の20%を稼げます — リンクが欲しい場合はここに返信してね 💋', zh: '赚取你招募的模特全部收入的 20% — 在这里回复获取你的链接 💋', ko: '모집한 모델이 버는 모든 수익의 20%를 받으세요 — 링크를 받으려면 여기에 답장하세요 💋', it: 'Guadagna il 20% di tutto ciò che guadagnano le modelle che hai reclutato — rispondi qui per il tuo link 💋', pl: 'Zarabiaj 20% wszystkiego, co zarobią zrekrutowane przez Ciebie modelki — odpowiedz tutaj po swój link 💋', nl: 'Verdien 20% van alles wat je geworven modellen maken — antwoord hier voor je link 💋', tr: 'Getirdiğin modellerin kazandığı her şeyin %20\'sini kazan — bağlantın için buraya yanıt ver 💋' },
  bell_tip_title: { en: '💰 {fan} tipped {emoji} {label}!', es: '💰 ¡{fan} dio una propina {emoji} {label}!', pt: '💰 {fan} deu uma gorjeta {emoji} {label}!', fr: '💰 {fan} a donné un pourboire {emoji} {label} !', de: '💰 {fan} hat {emoji} {label} als Trinkgeld gegeben!', ru: '💰 {fan} отправил чаевые {emoji} {label}!', ja: '💰 {fan} が {emoji} {label} をチップしました！', zh: '💰 {fan} 打赏了 {emoji} {label}！', ko: '💰 {fan}님이 {emoji} {label} 팁을 보냈습니다!', it: '💰 {fan} ha dato una mancia {emoji} {label}!', pl: '💰 {fan} dał napiwek {emoji} {label}!', nl: '💰 {fan} gaf een fooi {emoji} {label}!', tr: '💰 {fan} bahşiş verdi {emoji} {label}!' },
  bell_tip_body: { en: '{amount} tip received', es: 'Propina de {amount} recibida', pt: 'Gorjeta de {amount} recebida', fr: 'Pourboire de {amount} reçu', de: '{amount} Trinkgeld erhalten', ru: 'Получены чаевые {amount}', ja: '{amount} のチップを受け取りました', zh: '收到 {amount} 小费', ko: '{amount} 팁을 받았습니다', it: 'Mancia di {amount} ricevuta', pl: 'Otrzymano napiwek {amount}', nl: '{amount} fooi ontvangen', tr: '{amount} bahşiş alındı' },
  bell_ft_turn_title: { en: '📹 Your turn!', es: '📹 ¡Tu turno!', pt: '📹 Sua vez!', fr: '📹 À votre tour !', de: '📹 Du bist dran!', ru: '📹 Ваша очередь!', ja: '📹 あなたの番です！', zh: '📹 轮到你了！', ko: '📹 차례입니다!', it: '📹 È il tuo turno!', pl: '📹 Twoja kolej!', nl: '📹 Jouw beurt!', tr: '📹 Sıra sende!' },
  bell_ft_turn_body: { en: '{model} is ready for your FaceTime — join in the next 90 seconds or the spot passes on.', es: '{model} está lista para tu FaceTime — únete en los próximos 90 segundos o el espacio pasa al siguiente.', pt: '{model} está pronta para seu FaceTime — entre nos próximos 90 segundos ou a vaga passa para o próximo.', fr: '{model} est prête pour votre FaceTime — rejoignez dans les 90 prochaines secondes, sinon la place passe.', de: '{model} ist bereit für dein FaceTime — tritt in den nächsten 90 Sekunden bei, sonst geht der Platz weiter.', ru: '{model} готова к вашему FaceTime — присоединяйтесь в течение следующих 90 секунд, иначе место перейдёт дальше.', ja: '{model} があなたのFaceTimeの準備ができています — 次の90秒以内に参加しないと枠が次に移ります。', zh: '{model} 已准备好与你 FaceTime — 在接下来 90 秒内加入，否则名额会顺延。', ko: '{model}님이 FaceTime 준비를 마쳤습니다 — 다음 90초 안에 참여하지 않으면 자리가 넘어갑니다.', it: '{model} è pronta per il tuo FaceTime — entra nei prossimi 90 secondi o il posto passa a un altro.', pl: '{model} jest gotowa na Twój FaceTime — dołącz w ciągu następnych 90 sekund, bo miejsce przejdzie dalej.', nl: '{model} is klaar voor je FaceTime — doe binnen de volgende 90 seconden mee of de plek gaat door.', tr: '{model} FaceTime\'ın için hazır — sonraki 90 saniye içinde katıl, yoksa sıra başkasına geçer.' },
  bell_ft_req_title: { en: '📹 FaceTime request', es: '📹 Solicitud de FaceTime', pt: '📹 Solicitação de FaceTime', fr: '📹 Demande FaceTime', de: '📹 FaceTime-Anfrage', ru: '📹 Запрос FaceTime', ja: '📹 FaceTimeリクエスト', zh: '📹 FaceTime 请求', ko: '📹 FaceTime 요청', it: '📹 Richiesta FaceTime', pl: '📹 Prośba o FaceTime', nl: '📹 FaceTime-verzoek', tr: '📹 FaceTime isteği' },
  bell_ft_req_body: { en: '{fan} wants a {min}-min FaceTime with you — {amount}.', es: '{fan} quiere un FaceTime de {min} min contigo — {amount}.', pt: '{fan} quer um FaceTime de {min} min com você — {amount}.', fr: '{fan} veut un FaceTime de {min} min avec vous — {amount}.', de: '{fan} will ein {min}-minütiges FaceTime mit dir — {amount}.', ru: '{fan} хочет FaceTime с вами на {min} мин — {amount}.', ja: '{fan} があなたと {min}分のFaceTimeを希望しています — {amount}。', zh: '{fan} 想与你进行 {min} 分钟的 FaceTime — {amount}。', ko: '{fan}님이 {min}분 FaceTime을 원합니다 — {amount}.', it: '{fan} vuole un FaceTime di {min} min con te — {amount}.', pl: '{fan} chce FaceTime z Tobą na {min} min — {amount}.', nl: '{fan} wil een FaceTime van {min} min met jou — {amount}.', tr: '{fan} seninle {min} dakikalık bir FaceTime istiyor — {amount}.' },
  bell_ft_accepted_title: { en: '📹 She accepted!', es: '📹 ¡Aceptó!', pt: '📹 Ela aceitou!', fr: '📹 Elle a accepté !', de: '📹 Sie hat akzeptiert!', ru: '📹 Она приняла!', ja: '📹 彼女が承諾しました！', zh: '📹 她接受了！', ko: '📹 그녀가 수락했습니다!', it: '📹 Ha accettato!', pl: '📹 Zaakceptowała!', nl: '📹 Ze heeft geaccepteerd!', tr: '📹 Kabul etti!' },
  bell_ft_accepted_body: { en: '{model} accepted your FaceTime — join in the next 90 seconds.', es: '{model} aceptó tu FaceTime — únete en los próximos 90 segundos.', pt: '{model} aceitou seu FaceTime — entre nos próximos 90 segundos.', fr: '{model} a accepté votre FaceTime — rejoignez dans les 90 prochaines secondes.', de: '{model} hat dein FaceTime akzeptiert — tritt in den nächsten 90 Sekunden bei.', ru: '{model} приняла ваш FaceTime — присоединяйтесь в течение следующих 90 секунд.', ja: '{model} があなたのFaceTimeを承諾しました — 次の90秒以内に参加してね。', zh: '{model} 接受了你的 FaceTime — 在接下来 90 秒内加入。', ko: '{model}님이 FaceTime을 수락했습니다 — 다음 90초 안에 참여하세요.', it: '{model} ha accettato il tuo FaceTime — entra nei prossimi 90 secondi.', pl: '{model} zaakceptowała Twój FaceTime — dołącz w ciągu następnych 90 sekund.', nl: '{model} heeft je FaceTime geaccepteerd — doe binnen de volgende 90 seconden mee.', tr: '{model} FaceTime\'ını kabul etti — sonraki 90 saniye içinde katıl.' },
  bell_live_title: { en: '🔴 {model} just went live!', es: '🔴 ¡{model} acaba de salir en vivo!', pt: '🔴 {model} acabou de entrar ao vivo!', fr: '🔴 {model} vient de passer en direct !', de: '🔴 {model} ist gerade live gegangen!', ru: '🔴 {model} только что вышла в эфир!', ja: '🔴 {model} がライブを開始しました！', zh: '🔴 {model} 刚刚开播了！', ko: '🔴 {model}님이 방금 라이브를 시작했습니다!', it: '🔴 {model} è appena andata live!', pl: '🔴 {model} właśnie rozpoczęła transmisję na żywo!', nl: '🔴 {model} is net live gegaan!', tr: '🔴 {model} az önce canlıya geçti!' },
  bell_live_body_titled: { en: '“{title}” — tap to watch.', es: '“{title}” — toca para ver.', pt: '“{title}” — toque para assistir.', fr: '“{title}” — touchez pour regarder.', de: '“{title}” — tippen zum Ansehen.', ru: '«{title}» — нажмите, чтобы смотреть.', ja: '“{title}” — タップして視聴。', zh: '“{title}” — 点击观看。', ko: '“{title}” — 탭하여 시청하세요.', it: '“{title}” — tocca per guardare.', pl: '„{title}” — dotknij, aby oglądać.', nl: '“{title}” — tik om te kijken.', tr: '“{title}” — izlemek için dokun.' },
  bell_live_body: { en: 'Tap to watch her now.', es: 'Toca para verla ahora.', pt: 'Toque para assistir a ela agora.', fr: 'Touchez pour la regarder maintenant.', de: 'Tippen, um sie jetzt anzusehen.', ru: 'Нажмите, чтобы смотреть её сейчас.', ja: 'タップして今すぐ彼女を視聴。', zh: '点击立即观看她。', ko: '탭하여 지금 그녀를 시청하세요.', it: 'Tocca per guardarla ora.', pl: 'Dotknij, aby oglądać ją teraz.', nl: 'Tik om haar nu te kijken.', tr: 'Onu şimdi izlemek için dokun.' },
  bell_stage_title: { en: '🎥 {fan} wants to join your live!', es: '🎥 {fan} quiere unirse a tu en vivo', pt: '🎥 {fan} quer entrar na sua live!', fr: '🎥 {fan} veut rejoindre votre direct !', de: '🎥 {fan} will bei deinem Live mitmachen!', ru: '🎥 {fan} хочет присоединиться к вашему эфиру!', ja: '🎥 {fan} があなたのライブに参加したいです！', zh: '🎥 {fan} 想加入你的直播！', ko: '🎥 {fan}님이 라이브에 참여하고 싶어 합니다!', it: '🎥 {fan} vuole unirsi alla tua live!', pl: '🎥 {fan} chce dołączyć do Twojej transmisji na żywo!', nl: '🎥 {fan} wil meedoen aan je live!', tr: '🎥 {fan} canlına katılmak istiyor!' },
  bell_stage_body: { en: 'Tap to review and approve (paid {fee})', es: 'Toca para revisar y aprobar (pago de {fee})', pt: 'Toque para revisar e aprovar (pago {fee})', fr: 'Touchez pour examiner et approuver (payé {fee})', de: 'Tippen zum Überprüfen und Genehmigen (bezahlt {fee})', ru: 'Нажмите, чтобы рассмотреть и одобрить (оплачено {fee})', ja: 'タップして確認・承認（有料 {fee}）', zh: '点击查看并批准（已付费 {fee}）', ko: '탭하여 검토하고 승인하세요 (유료 {fee})', it: 'Tocca per esaminare e approvare (a pagamento {fee})', pl: 'Dotknij, aby sprawdzić i zatwierdzić (płatne {fee})', nl: 'Tik om te beoordelen en goed te keuren (betaald {fee})', tr: 'İncelemek ve onaylamak için dokun (ücretli {fee})' },
  bell_booking_fan_active_title: { en: '📹 Your 1-on-1 is now active', es: '📹 Tu 1 a 1 ya está activo', pt: '📹 Seu 1 a 1 está ativo agora', fr: '📹 Votre 1-à-1 est maintenant actif', de: '📹 Dein 1-zu-1 ist jetzt aktiv', ru: '📹 Ваш 1-на-1 теперь активен', ja: '📹 あなたの1対1が有効になりました', zh: '📹 你的一对一已激活', ko: '📹 1:1이 지금 활성화되었습니다', it: '📹 Il tuo 1-a-1 è ora attivo', pl: '📹 Twoje 1 na 1 jest teraz aktywne', nl: '📹 Je 1-op-1 is nu actief', tr: '📹 Bire birin şimdi aktif' },
  bell_booking_fan_active_body: { en: '📹 Your FaceTime call with {model} is now active — you have 3 minutes to get to the call.', es: '📹 Tu llamada FaceTime con {model} ya está activa — tienes 3 minutos para llegar a la llamada.', pt: '📹 Sua chamada FaceTime com {model} está ativa agora — você tem 3 minutos para entrar na chamada.', fr: '📹 Votre appel FaceTime avec {model} est maintenant actif — vous avez 3 minutes pour rejoindre l\'appel.', de: '📹 Dein FaceTime-Anruf mit {model} ist jetzt aktiv — du hast 3 Minuten, um zum Anruf zu kommen.', ru: '📹 Ваш звонок FaceTime с {model} теперь активен — у вас есть 3 минуты, чтобы попасть на звонок.', ja: '📹 {model} とのFaceTime通話が有効になりました — 通話に参加するまで3分あります。', zh: '📹 你与 {model} 的 FaceTime 通话已激活 — 你有 3 分钟时间进入通话。', ko: '📹 {model}님과의 FaceTime 통화가 지금 활성화되었습니다 — 3분 안에 통화에 참여하세요.', it: '📹 La tua chiamata FaceTime con {model} è ora attiva — hai 3 minuti per arrivare alla chiamata.', pl: '📹 Twoja rozmowa FaceTime z {model} jest teraz aktywna — masz 3 minuty, aby dotrzeć na rozmowę.', nl: '📹 Je FaceTime-gesprek met {model} is nu actief — je hebt 3 minuten om naar het gesprek te gaan.', tr: '📹 {model} ile FaceTime araman şimdi aktif — aramaya gitmek için 3 dakikan var.' },
  bell_booking_fan_noshow_model_title: { en: '💔 Fan no-show', es: '💔 El fan no se presentó', pt: '💔 Fã não apareceu', fr: '💔 Fan absent', de: '💔 Fan-No-Show', ru: '💔 Фанат не явился', ja: '💔 ファンのノーショー', zh: '💔 粉丝爽约', ko: '💔 팬 노쇼', it: '💔 Fan assente', pl: '💔 Fan się nie pojawił', nl: '💔 Fan no-show', tr: '💔 Hayran gelmedi' },
  bell_booking_fan_noshow_model_body: { en: '💔 {fan} never showed up for your 1-on-1 — the booking is paid, you keep it.', es: '💔 {fan} nunca se presentó a tu 1 a 1 — la reserva está pagada, te la quedas.', pt: '💔 {fan} nunca apareceu no seu 1 a 1 — a reserva está paga, você fica com ela.', fr: '💔 {fan} ne s\'est jamais présenté à votre 1-à-1 — la réservation est payée, vous la gardez.', de: '💔 {fan} ist nie zu deinem 1-zu-1 erschienen — die Buchung ist bezahlt, du behältst sie.', ru: '💔 {fan} так и не явился на ваш 1-на-1 — бронирование оплачено, вы его сохраняете.', ja: '💔 {fan} はあなたの1対1に現れませんでした — 予約は支払い済みで、あなたのものになります。', zh: '💔 {fan} 没有出现在你的一对一中 — 预约已付款，你保留这笔费用。', ko: '💔 {fan}님이 1:1에 나타나지 않았습니다 — 예약은 결제되었으며, 금액은 내 것입니다.', it: '💔 {fan} non si è mai presentato al tuo 1-a-1 — la prenotazione è pagata, la trattieni tu.', pl: '💔 {fan} nigdy nie pojawił się na Waszym 1 na 1 — rezerwacja jest opłacona, zatrzymujesz ją.', nl: '💔 {fan} is nooit verschenen voor je 1-op-1 — de boeking is betaald, je houdt hem.', tr: '💔 {fan} bire birine hiç gelmedi — rezervasyon ödendi, sen alırsın.' },
  bell_booking_fan_noshow_fan_title: { en: '📅 You missed your 1-on-1', es: '📅 Perdiste tu 1 a 1', pt: '📅 Você perdeu seu 1 a 1', fr: '📅 Vous avez manqué votre 1-à-1', de: '📅 Du hast dein 1-zu-1 verpasst', ru: '📅 Вы пропустили ваш 1-на-1', ja: '📅 1対1を逃しました', zh: '📅 你错过了你的一对一', ko: '📅 1:1을 놓쳤습니다', it: '📅 Hai perso il tuo 1-a-1', pl: '📅 Przegapiłeś swoje 1 na 1', nl: '📅 Je hebt je 1-op-1 gemist', tr: '📅 Bire birini kaçırdın' },
  bell_booking_fan_noshow_fan_body: { en: 'You missed your 1-on-1 with {model} — no-show bookings aren\'t refunded (your slot was reserved for you).', es: 'Perdiste tu 1 a 1 con {model} — las reservas con ausencia no se reembolsan (tu espacio estuvo reservado para ti).', pt: 'Você perdeu seu 1 a 1 com {model} — reservas com falta não são reembolsadas (seu horário foi reservado para você).', fr: 'Vous avez manqué votre 1-à-1 avec {model} — les réservations en cas d\'absence ne sont pas remboursées (votre créneau vous était réservé).', de: 'Du hast dein 1-zu-1 mit {model} verpasst — No-Show-Buchungen werden nicht erstattet (dein Slot war für dich reserviert).', ru: 'Вы пропустили ваш 1-на-1 с {model} — бронирования при неявке не возвращаются (ваш слот был зарезервирован за вами).', ja: '{model} との1対1を逃しました — ノーショー予約は返金されません（あなたの枠が予約されていました）。', zh: '你错过了与 {model} 的一对一 — 爽约的预约不予退款（该时段已为你保留）。', ko: '{model}님과의 1:1을 놓쳤습니다 — 노쇼 예약은 환불되지 않습니다 (자리가 나를 위해 예약되어 있었습니다).', it: 'Hai perso il tuo 1-a-1 con {model} — le prenotazioni con assenza non vengono rimborsate (il tuo posto era riservato per te).', pl: 'Przegapiłeś swoje 1 na 1 z {model} — rezerwacje z nieobecnością nie podlegają zwrotowi (Twój termin był zarezerwowany dla Ciebie).', nl: 'Je hebt je 1-op-1 met {model} gemist — no-show boekingen worden niet terugbetaald (je slot was voor jou gereserveerd).', tr: '{model} ile bire birini kaçırdın — gelinmeyen rezervasyonlar iade edilmez (yerin senin için ayrılmıştı).' },
  bell_booking_model_noshow_title: { en: '📅 You missed a 1-on-1', es: '📅 Perdiste un 1 a 1', pt: '📅 Você perdeu um 1 a 1', fr: '📅 Vous avez manqué un 1-à-1', de: '📅 Du hast ein 1-zu-1 verpasst', ru: '📅 Вы пропустили 1-на-1', ja: '📅 1対1を逃しました', zh: '📅 你错过了一次一对一', ko: '📅 1:1을 놓쳤습니다', it: '📅 Hai perso un 1-a-1', pl: '📅 Przegapiłaś 1 na 1', nl: '📅 Je hebt een 1-op-1 gemist', tr: '📅 Bir bire biri kaçırdın' },
  bell_booking_model_noshow_body: { en: 'You missed your 1-on-1 with {fan} — he was refunded in full.', es: 'Perdiste tu 1 a 1 con {fan} — se le reembolsó por completo.', pt: 'Você perdeu seu 1 a 1 com {fan} — ele foi reembolsado integralmente.', fr: 'Vous avez manqué votre 1-à-1 avec {fan} — il a été intégralement remboursé.', de: 'Du hast dein 1-zu-1 mit {fan} verpasst — er wurde vollständig erstattet.', ru: 'Вы пропустили ваш 1-на-1 с {fan} — ему вернули полную сумму.', ja: '{fan} との1対1を逃しました — 彼は全額返金されました。', zh: '你错过了与 {fan} 的一对一 — 他已获得全额退款。', ko: '{fan}님과의 1:1을 놓쳤습니다 — 그에게는 전액 환불되었습니다.', it: 'Hai perso il tuo 1-a-1 con {fan} — è stato rimborsato per intero.', pl: 'Przegapiłaś swoje 1 na 1 z {fan} — otrzymał pełny zwrot.', nl: 'Je hebt je 1-op-1 met {fan} gemist — hij is volledig terugbetaald.', tr: '{fan} ile bire birini kaçırdın — ona tam iade yapıldı.' },
  bell_booking_reminder_title: { en: '📅 1-on-1 reminder', es: '📅 Recordatorio de 1 a 1', pt: '📅 Lembrete de 1 a 1', fr: '📅 Rappel de 1-à-1', de: '📅 1-zu-1 Erinnerung', ru: '📅 Напоминание о 1-на-1', ja: '📅 1対1リマインダー', zh: '📅 一对一提醒', ko: '📅 1:1 알림', it: '📅 Promemoria 1-a-1', pl: '📅 Przypomnienie o 1 na 1', nl: '📅 1-op-1 herinnering', tr: '📅 Bire bir hatırlatması' },
  bell_booking_reminder_body: { en: '📅 Reminder: your 1-on-1 with {fan} is {label} — {when}, {min} min{tail} 💋', es: '📅 Recordatorio: tu 1 a 1 con {fan} es {label} — {when}, {min} min{tail} 💋', pt: '📅 Lembrete: seu 1 a 1 com {fan} é {label} — {when}, {min} min{tail} 💋', fr: '📅 Rappel : votre 1-à-1 avec {fan} est {label} — {when}, {min} min{tail} 💋', de: '📅 Erinnerung: dein 1-zu-1 mit {fan} ist {label} — {when}, {min} Min.{tail} 💋', ru: '📅 Напоминание: ваш 1-на-1 с {fan} {label} — {when}, {min} мин{tail} 💋', ja: '📅 リマインダー：{fan} との1対1は {label} — {when}、{min}分{tail} 💋', zh: '📅 提醒：你与 {fan} 的一对一是 {label} — {when}，{min} 分钟{tail} 💋', ko: '📅 알림: {fan}님과의 1:1이 {label}입니다 — {when}, {min}분{tail} 💋', it: '📅 Promemoria: il tuo 1-a-1 con {fan} è {label} — {when}, {min} min{tail} 💋', pl: '📅 Przypomnienie: Twoje 1 na 1 z {fan} jest {label} — {when}, {min} min{tail} 💋', nl: '📅 Herinnering: je 1-op-1 met {fan} is {label} — {when}, {min} min{tail} 💋', tr: '📅 Hatırlatma: {fan} ile bire birin {label} — {when}, {min} dk{tail} 💋' },
  reminder_label_3d: { en: 'in 3 days', es: 'en 3 días', pt: 'em 3 dias', fr: 'dans 3 jours', de: 'in 3 Tagen', ru: 'через 3 дня', ja: '3日後', zh: '3 天后', ko: '3일 후', it: 'tra 3 giorni', pl: 'za 3 dni', nl: 'over 3 dagen', tr: '3 gün içinde' },
  reminder_label_3h: { en: 'in 3 hours', es: 'en 3 horas', pt: 'em 3 horas', fr: 'dans 3 heures', de: 'in 3 Stunden', ru: 'через 3 часа', ja: '3時間後', zh: '3 小时后', ko: '3시간 후', it: 'tra 3 ore', pl: 'za 3 godziny', nl: 'over 3 uur', tr: '3 saat içinde' },
  reminder_label_15m: { en: 'in 15 minutes', es: 'en 15 minutos', pt: 'em 15 minutos', fr: 'dans 15 minutes', de: 'in 15 Minuten', ru: 'через 15 минут', ja: '15分後', zh: '15 分钟后', ko: '15분 후', it: 'tra 15 minuti', pl: 'za 15 minut', nl: 'over 15 minuten', tr: '15 dakika içinde' },
  reminder_tail_15m: { en: ' — get ready!', es: ' — ¡prepárate!', pt: ' — se prepare!', fr: ' — préparez-vous !', de: ' — mach dich bereit!', ru: ' — приготовьтесь!', ja: ' — 準備してね！', zh: ' — 准备好了！', ko: ' — 준비하세요!', it: ' — preparati!', pl: ' — przygotuj się!', nl: ' — maak je klaar!', tr: ' — hazırlan!' },
  bell_booking_start_title: { en: '📅 Your 1-on-1 is now active', es: '📅 Tu 1 a 1 ya está activo', pt: '📅 Seu 1 a 1 está ativo agora', fr: '📅 Votre 1-à-1 est maintenant actif', de: '📅 Dein 1-zu-1 ist jetzt aktiv', ru: '📅 Ваш 1-на-1 теперь активен', ja: '📅 あなたの1対1が有効になりました', zh: '📅 你的一对一已激活', ko: '📅 1:1이 지금 활성화되었습니다', it: '📅 Il tuo 1-a-1 è ora attivo', pl: '📅 Twoje 1 na 1 jest teraz aktywne', nl: '📅 Je 1-op-1 is nu actief', tr: '📅 Bire birin şimdi aktif' },
  bell_booking_start_body: { en: '📅 Your 1-on-1 with {fan} is now active — you have 5 minutes to get to the call or their money will be fully refunded.', es: '📅 Tu 1 a 1 con {fan} ya está activo — tienes 5 minutos para llegar a la llamada o se le reembolsará su dinero por completo.', pt: '📅 Seu 1 a 1 com {fan} está ativo agora — você tem 5 minutos para entrar na chamada ou o dinheiro dele será reembolsado integralmente.', fr: '📅 Votre 1-à-1 avec {fan} est maintenant actif — vous avez 5 minutes pour rejoindre l\'appel, sinon son argent sera intégralement remboursé.', de: '📅 Dein 1-zu-1 mit {fan} ist jetzt aktiv — du hast 5 Minuten, um zum Anruf zu kommen, sonst wird sein Geld vollständig erstattet.', ru: '📅 Ваш 1-на-1 с {fan} теперь активен — у вас есть 5 минут, чтобы попасть на звонок, иначе его деньги будут полностью возвращены.', ja: '📅 {fan} との1対1が有効になりました — 通話に参加するまで5分あります。過ぎると彼の支払いは全額返金されます。', zh: '📅 你与 {fan} 的一对一已激活 — 你有 5 分钟时间进入通话，否则他的款项将全额退还。', ko: '📅 {fan}님과의 1:1이 지금 활성화되었습니다 — 5분 안에 통화에 참여하지 않으면 그에게 전액 환불됩니다.', it: '📅 Il tuo 1-a-1 con {fan} è ora attivo — hai 5 minuti per arrivare alla chiamata o i suoi soldi saranno rimborsati per intero.', pl: '📅 Twoje 1 na 1 z {fan} jest teraz aktywne — masz 5 minut, aby dotrzeć na rozmowę, w przeciwnym razie jego pieniądze zostaną w pełni zwrócone.', nl: '📅 Je 1-op-1 met {fan} is nu actief — je hebt 5 minuten om naar het gesprek te gaan of zijn geld wordt volledig terugbetaald.', tr: '📅 {fan} ile bire birin şimdi aktif — aramaya gitmek için 5 dakikan var, yoksa parası tam iade edilecek.' },
  bell_booking_new_title: { en: '📅 New 1-on-1 booked', es: '📅 Nuevo 1 a 1 reservado', pt: '📅 Novo 1 a 1 reservado', fr: '📅 Nouveau 1-à-1 réservé', de: '📅 Neues 1-zu-1 gebucht', ru: '📅 Забронирован новый 1-на-1', ja: '📅 新しい1対1が予約されました', zh: '📅 新的一对一已预约', ko: '📅 새 1:1이 예약되었습니다', it: '📅 Nuovo 1-a-1 prenotato', pl: '📅 Zarezerwowano nowe 1 na 1', nl: '📅 Nieuwe 1-op-1 geboekt', tr: '📅 Yeni bire bir rezerve edildi' },
  bell_booking_new_body: { en: '{fan} booked a {min}-min 1-on-1 — {when}.', es: '{fan} reservó un 1 a 1 de {min} min — {when}.', pt: '{fan} reservou um 1 a 1 de {min} min — {when}.', fr: '{fan} a réservé un 1-à-1 de {min} min — {when}.', de: '{fan} hat ein {min}-minütiges 1-zu-1 gebucht — {when}.', ru: '{fan} забронировал 1-на-1 на {min} мин — {when}.', ja: '{fan} が {min}分の1対1を予約しました — {when}。', zh: '{fan} 预约了 {min} 分钟的一对一 — {when}。', ko: '{fan}님이 {min}분 1:1을 예약했습니다 — {when}.', it: '{fan} ha prenotato un 1-a-1 di {min} min — {when}.', pl: '{fan} zarezerwował 1 na 1 na {min} min — {when}.', nl: '{fan} heeft een 1-op-1 van {min} min geboekt — {when}.', tr: '{fan} {min} dakikalık bir bire bir rezerve etti — {when}.' },
  apology_dm_body: { en: 'We\'re so sorry 💔 {model} couldn\'t make your 1-on-1 today — that\'s on us. Your {amount} has been refunded in full to your balance. She\'d love to make it up to you — her latest openings are on her booking calendar 💋', es: 'Lo sentimos mucho 💔 {model} no pudo hacer tu 1 a 1 hoy — es culpa nuestra. Tu {amount} se reembolsó por completo a tu saldo. Le encantaría compensártelo — sus horarios más recientes están en su calendario de reservas 💋', pt: 'Sentimos muito 💔 {model} não pôde comparecer ao seu 1 a 1 hoje — a culpa é nossa. Seu {amount} foi reembolsado integralmente para seu saldo. Ela adoraria compensar você — os horários mais recentes dela estão no calendário de reservas dela 💋', fr: 'Nous sommes vraiment désolés 💔 {model} n\'a pas pu assurer votre 1-à-1 aujourd\'hui — c\'est de notre faute. Votre {amount} a été intégralement remboursé sur votre solde. Elle adorerait se rattraper — ses dernières disponibilités sont sur son calendrier de réservation 💋', de: 'Es tut uns so leid 💔 {model} konnte dein 1-zu-1 heute nicht wahrnehmen — das geht auf uns. Deine {amount} wurde vollständig auf dein Guthaben erstattet. Sie würde es gerne wiedergutmachen — ihre neuesten Öffnungen sind in ihrem Buchungskalender 💋', ru: 'Нам очень жаль 💔 {model} не смогла прийти на ваш 1-на-1 сегодня — это наша вина. Ваши {amount} были полностью возвращены на ваш баланс. Она с радостью загладит вину — её последние свободные места в её календаре бронирований 💋', ja: '本当にごめんなさい 💔 {model} は今日あなたの1対1に参加できませんでした — 私たちの責任です。{amount} は全額あなたの残高に返金されました。彼女は埋め合わせをしたいと思っています — 最新の空き状況は彼女の予約カレンダーにあります 💋', zh: '我们非常抱歉 💔 {model} 今天无法赴约你的一对一 — 这是我们的责任。你的 {amount} 已全额退回到你的余额。她很想弥补你 — 她最新的空位在她的预约日历上 💋', ko: '정말 죄송합니다 💔 {model}님이 오늘 1:1에 오지 못했습니다 — 저희 책임입니다. {amount}는 잔액으로 전액 환불되었습니다. 그녀가 꼭 만회하고 싶어 합니다 — 그녀의 최신 빈 일정은 예약 캘린더에 있습니다 💋', it: 'Ci dispiace tantissimo 💔 {model} non ha potuto fare il tuo 1-a-1 oggi — è colpa nostra. Il tuo {amount} è stato rimborsato per intero sul tuo saldo. Le piacerebbe farsi perdonare — le sue ultime disponibilità sono sul suo calendario prenotazioni 💋', pl: 'Bardzo przepraszamy 💔 {model} nie mogła dziś dotrzeć na Twoje 1 na 1 — to nasza wina. Twoje {amount} zostało w pełni zwrócone na Twoje saldo. Chętnie Ci to wynagrodzi — jej najnowsze wolne terminy są w jej kalendarzu rezerwacji 💋', nl: 'Het spijt ons zo 💔 {model} kon je 1-op-1 vandaag niet halen — dat ligt aan ons. Je {amount} is volledig terugbetaald naar je saldo. Ze zou het graag goedmaken — haar nieuwste openingen staan op haar boekingskalender 💋', tr: 'Çok üzgünüz 💔 {model} bugünkü bire birine gelemedi — bu bizim hatamız. {amount} tutarın bakiyene tam olarak iade edildi. Bunu telafi etmeyi çok ister — en son boşlukları rezervasyon takviminde 💋' },
  ann_lang_dm: { en: '🌍 BIG NEWS: SlutCamp now speaks 13 languages! You — and your fans — can switch the whole app to your own language anytime in Settings: buttons, messages, notifications and even the agreements. English · Español · Português · Français · Deutsch · Русский · 日本語 · 中文 · 한국어 · Italiano · Polski · Nederlands · Türkçe. Fans from everywhere can now feel at home here — tell your boys! 💋', es: '🌍 GRANDES NOTICIAS: ¡SlutCamp ahora habla 13 idiomas! Tú — y tus fans — pueden cambiar toda la app a su propio idioma cuando quieran en Ajustes: botones, mensajes, notificaciones e incluso los acuerdos. English · Español · Português · Français · Deutsch · Русский · 日本語 · 中文 · 한국어 · Italiano · Polski · Nederlands · Türkçe. Los fans de todas partes ahora pueden sentirse en casa aquí — ¡cuéntaselo a tus chicos! 💋', pt: '🌍 GRANDE NOVIDADE: a SlutCamp agora fala 13 idiomas! Você — e seus fãs — podem trocar o app inteiro para o seu idioma quando quiserem em Configurações: botões, mensagens, notificações e até os contratos. English · Español · Português · Français · Deutsch · Русский · 日本語 · 中文 · 한국어 · Italiano · Polski · Nederlands · Türkçe. Fãs de todo lugar agora podem se sentir em casa aqui — avisa seus garotos! 💋', fr: '🌍 GRANDE NOUVELLE : SlutCamp parle maintenant 13 langues ! Vous — et vos fans — pouvez basculer toute l\'appli dans votre propre langue à tout moment dans Paramètres : boutons, messages, notifications et même les contrats. English · Español · Português · Français · Deutsch · Русский · 日本語 · 中文 · 한국어 · Italiano · Polski · Nederlands · Türkçe. Les fans du monde entier peuvent désormais se sentir chez eux ici — dites-le à vos gars ! 💋', de: '🌍 GROSSE NEUIGKEITEN: SlutCamp spricht jetzt 13 Sprachen! Du — und deine Fans — könnt die ganze App jederzeit in den Einstellungen auf eure eigene Sprache umstellen: Schaltflächen, Nachrichten, Benachrichtigungen und sogar die Vereinbarungen. English · Español · Português · Français · Deutsch · Русский · 日本語 · 中文 · 한국어 · Italiano · Polski · Nederlands · Türkçe. Fans von überall können sich hier jetzt zu Hause fühlen — erzähl es deinen Jungs! 💋', ru: '🌍 БОЛЬШИЕ НОВОСТИ: SlutCamp теперь говорит на 13 языках! Вы — и ваши фанаты — можете переключить всё приложение на свой язык в любое время в Настройках: кнопки, сообщения, уведомления и даже соглашения. English · Español · Português · Français · Deutsch · Русский · 日本語 · 中文 · 한국어 · Italiano · Polski · Nederlands · Türkçe. Фанаты со всего мира теперь могут чувствовать себя здесь как дома — расскажите своим парням! 💋', ja: '🌍 ビッグニュース：SlutCampは13言語に対応しました！あなたも — あなたのファンも — 設定でいつでもアプリ全体を自分の言語に切り替えられます：ボタン、メッセージ、通知、契約まで。English · Español · Português · Français · Deutsch · Русский · 日本語 · 中文 · 한국어 · Italiano · Polski · Nederlands · Türkçe。世界中のファンがここでくつろげるようになりました — あなたのボーイズに教えてあげて！ 💋', zh: '🌍 重大消息：SlutCamp 现在支持 13 种语言！你 — 以及你的粉丝 — 可以随时在设置中将整个应用切换到你自己的语言：按钮、消息、通知甚至协议。English · Español · Português · Français · Deutsch · Русский · 日本語 · 中文 · 한국어 · Italiano · Polski · Nederlands · Türkçe。现在来自世界各地的粉丝都能在这里感到宾至如归 — 告诉你的小伙子们吧！💋', ko: '🌍 큰 소식: SlutCamp가 이제 13개 언어를 지원합니다! 나와 팬들 모두 설정에서 언제든지 앱 전체를 본인의 언어로 바꿀 수 있습니다: 버튼, 메시지, 알림, 심지어 계약까지. English · Español · Português · Français · Deutsch · Русский · 日本語 · 中文 · 한국어 · Italiano · Polski · Nederlands · Türkçe. 이제 전 세계 팬들이 여기서 편안함을 느낄 수 있습니다 — 친구들에게 알려주세요! 💋', it: '🌍 GRANDE NOVITÀ: SlutCamp ora parla 13 lingue! Tu — e i tuoi fan — potete cambiare l\'intera app nella vostra lingua in qualsiasi momento in Impostazioni: pulsanti, messaggi, notifiche e persino i contratti. English · Español · Português · Français · Deutsch · Русский · 日本語 · 中文 · 한국어 · Italiano · Polski · Nederlands · Türkçe. Fan da ovunque ora possono sentirsi a casa qui — dillo ai tuoi ragazzi! 💋', pl: '🌍 WIELKA WIADOMOŚĆ: SlutCamp mówi teraz w 13 językach! Ty — i Twoi fani — możecie w każdej chwili przełączyć całą aplikację na własny język w Ustawieniach: przyciski, wiadomości, powiadomienia, a nawet umowy. English · Español · Português · Français · Deutsch · Русский · 日本語 · 中文 · 한국어 · Italiano · Polski · Nederlands · Türkçe. Fani z całego świata mogą teraz czuć się tu jak w domu — powiedz swoim chłopakom! 💋', nl: '🌍 GROOT NIEUWS: SlutCamp spreekt nu 13 talen! Jij — en je fans — kunnen de hele app op elk moment in Instellingen naar je eigen taal schakelen: knoppen, berichten, meldingen en zelfs de overeenkomsten. English · Español · Português · Français · Deutsch · Русский · 日本語 · 中文 · 한국어 · Italiano · Polski · Nederlands · Türkçe. Fans van overal kunnen zich hier nu thuis voelen — vertel het je jongens! 💋', tr: '🌍 BÜYÜK HABER: SlutCamp artık 13 dil konuşuyor! Sen — ve hayranların — tüm uygulamayı Ayarlar\'dan istediğin zaman kendi diline çevirebilirsiniz: düğmeler, mesajlar, bildirimler ve hatta sözleşmeler. English · Español · Português · Français · Deutsch · Русский · 日本語 · 中文 · 한국어 · Italiano · Polski · Nederlands · Türkçe. Artık her yerden hayranlar burada kendini evinde hissedebilir — oğlanlarına söyle! 💋' },
  ann_lang_bell_title: { en: '🌍 NEW UPDATE: SlutCamp speaks 13 languages!', es: '🌍 NUEVA ACTUALIZACIÓN: ¡SlutCamp habla 13 idiomas!', pt: '🌍 NOVA ATUALIZAÇÃO: a SlutCamp fala 13 idiomas!', fr: '🌍 NOUVELLE MISE À JOUR : SlutCamp parle 13 langues !', de: '🌍 NEUES UPDATE: SlutCamp spricht 13 Sprachen!', ru: '🌍 НОВОЕ ОБНОВЛЕНИЕ: SlutCamp говорит на 13 языках!', ja: '🌍 新しいアップデート：SlutCampは13言語に対応！', zh: '🌍 新更新：SlutCamp 支持 13 种语言！', ko: '🌍 새 업데이트: SlutCamp가 13개 언어를 지원합니다!', it: '🌍 NUOVO AGGIORNAMENTO: SlutCamp parla 13 lingue!', pl: '🌍 NOWA AKTUALIZACJA: SlutCamp mówi w 13 językach!', nl: '🌍 NIEUWE UPDATE: SlutCamp spreekt 13 talen!', tr: '🌍 YENİ GÜNCELLEME: SlutCamp 13 dil konuşuyor!' },
  ann_lang_bell_body: { en: 'Switch the whole app to your language in Settings — your fans too! 💋', es: 'Cambia toda la app a tu idioma en Ajustes — ¡tus fans también! 💋', pt: 'Troque o app inteiro para seu idioma em Configurações — seus fãs também! 💋', fr: 'Basculez toute l\'appli dans votre langue dans Paramètres — vos fans aussi ! 💋', de: 'Stelle die ganze App in den Einstellungen auf deine Sprache um — deine Fans auch! 💋', ru: 'Переключите всё приложение на ваш язык в Настройках — ваши фанаты тоже! 💋', ja: '設定でアプリ全体をあなたの言語に切り替えてね — あなたのファンも！ 💋', zh: '在设置中将整个应用切换到你的语言 — 你的粉丝也可以！💋', ko: '설정에서 앱 전체를 본인의 언어로 바꾸세요 — 팬들도 마찬가지입니다! 💋', it: 'Cambia l\'intera app nella tua lingua in Impostazioni — anche i tuoi fan! 💋', pl: 'Przełącz całą aplikację na swój język w Ustawieniach — Twoi fani też! 💋', nl: 'Schakel de hele app in Instellingen naar jouw taal — je fans ook! 💋', tr: 'Tüm uygulamayı Ayarlar\'dan diline çevir — hayranların da! 💋' },
  ann_suggest_title: { en: '💡 NEW: The Suggestion Box is open!', es: '💡 NUEVO: ¡El buzón de sugerencias está abierto!', pt: '💡 NOVIDADE: A caixa de sugestões está aberta!', fr: '💡 NOUVEAU : La boîte à suggestions est ouverte !', de: '💡 NEU: Die Vorschlagsbox ist geöffnet!', ru: '💡 НОВОЕ: Ящик предложений открыт!', ja: '💡 新機能：ご意見ボックスがオープン！', zh: '💡 新功能：意见箱已开启！', ko: '💡 새 소식: 건의함이 열렸어요!', it: '💡 NOVITÀ: La cassetta dei suggerimenti è aperta!', pl: '💡 NOWOŚĆ: Skrzynka sugestii jest otwarta!', nl: '💡 NIEUW: De ideeënbus is geopend!', tr: '💡 YENİ: Öneri kutusu açıldı!' },
  ann_suggest_body: { en: 'Want something on the app we haven\'t added yet? Tell us! Open your Wallet and drop your idea in the 💡 Suggestion Box — we read every single one 💋', es: '¿Quieres algo en la app que aún no agregamos? ¡Cuéntanos! Abre tu billetera y deja tu idea en el 💡 Buzón de sugerencias — leemos cada una 💋', pt: 'Quer algo no app que ainda não adicionamos? Conta pra gente! Abra sua carteira e deixe sua ideia na 💡 Caixa de sugestões — lemos todas 💋', fr: 'Vous voulez quelque chose dans l\'app que nous n\'avons pas encore ajouté ? Dites-le-nous ! Ouvrez votre portefeuille et déposez votre idée dans la 💡 Boîte à suggestions — nous lisons chacune d\'elles 💋', de: 'Wünschst du dir etwas in der App, das wir noch nicht hinzugefügt haben? Sag es uns! Öffne deine Wallet und hinterlasse deine Idee in der 💡 Vorschlagsbox — wir lesen jede einzelne 💋', ru: 'Хотите что-то в приложении, чего мы ещё не добавили? Расскажите нам! Откройте кошелёк и оставьте свою идею в 💡 Ящике предложений — мы читаем каждое 💋', ja: 'アプリにまだない機能がほしい？教えて！ウォレットを開いて💡ご意見ボックスにアイデアを入れてね — 全部読んでます💋', zh: '想要应用里还没有的功能？告诉我们！打开你的钱包，把想法投进 💡 意见箱 — 每一条我们都会看 💋', ko: '앱에 아직 없는 기능이 있었으면 하나요? 알려주세요! 지갑을 열고 💡 건의함에 아이디어를 남겨주세요 — 하나하나 다 읽어요 💋', it: 'Vuoi qualcosa nell\'app che non abbiamo ancora aggiunto? Diccelo! Apri il tuo portafoglio e lascia la tua idea nella 💡 Cassetta dei suggerimenti — le leggiamo tutte 💋', pl: 'Chcesz czegoś w aplikacji, czego jeszcze nie dodaliśmy? Powiedz nam! Otwórz portfel i zostaw swój pomysł w 💡 Skrzynce sugestii — czytamy każdą 💋', nl: 'Wil je iets in de app dat we nog niet hebben toegevoegd? Vertel het ons! Open je wallet en laat je idee achter in de 💡 Ideeënbus — we lezen ze allemaal 💋', tr: 'Uygulamada henüz eklemediğimiz bir şey mi istiyorsun? Bize söyle! Cüzdanını aç ve fikrini 💡 Öneri kutusuna bırak — hepsini tek tek okuyoruz 💋' },
  ann_profile_media_dm: { en: '📸🎬 NEW UPDATE: Your profile just got bigger! Fans who open your profile now see up to 10 of your pictures AND two profile videos — your preview video plus a second main video you add yourself. Twerk, introduce yourself, tease — whatever you want, it\'s your page and your hook. Add yours: Settings → My photo 💋', es: '📸🎬 NUEVA ACTUALIZACIÓN: ¡Tu perfil creció! Los fans que abren tu perfil ahora ven hasta 10 de tus fotos Y dos videos de perfil: tu video de vista previa más un segundo video principal que agregas tú. Twerk, preséntate, provoca — lo que quieras, es tu página y tu gancho. Agrega los tuyos: Ajustes → Mi foto 💋', pt: '📸🎬 NOVA ATUALIZAÇÃO: Seu perfil ficou maior! Os fãs que abrem seu perfil agora veem até 10 das suas fotos E dois vídeos de perfil — seu vídeo de prévia mais um segundo vídeo principal que você mesma adiciona. Twerk, se apresente, provoque — o que quiser, é a sua página e o seu gancho. Adicione os seus: Configurações → Minha foto 💋', fr: '📸🎬 NOUVELLE MISE À JOUR : Ton profil s\'agrandit ! Les fans qui ouvrent ton profil voient maintenant jusqu\'à 10 de tes photos ET deux vidéos de profil — ta vidéo d\'aperçu plus une deuxième vidéo principale que tu ajoutes toi-même. Twerk, présente-toi, provoque — ce que tu veux, c\'est ta page et ton accroche. Ajoute les tiennes : Paramètres → Ma photo 💋', de: '📸🎬 NEUES UPDATE: Dein Profil ist gewachsen! Fans, die dein Profil öffnen, sehen jetzt bis zu 10 deiner Bilder UND zwei Profilvideos — dein Vorschauvideo plus ein zweites Hauptvideo, das du selbst hinzufügst. Twerk, stell dich vor, tease — was du willst, es ist deine Seite und dein Hook. Füge deine hinzu: Einstellungen → Mein Foto 💋', ru: '📸🎬 НОВОЕ ОБНОВЛЕНИЕ: Твой профиль стал больше! Фанаты, которые открывают твой профиль, теперь видят до 10 твоих фото И два видео профиля — твоё превью-видео плюс второе главное видео, которое ты добавляешь сама. Тверк, представься, дразни — что хочешь, это твоя страница и твой крючок. Добавь свои: Настройки → Моё фото 💋', ja: '📸🎬 新しいアップデート：あなたのプロフィールが大きくなりました！プロフィールを開いたファンには、あなたの写真が最大10枚、そしてプロフィール動画が2本 — プレビュー動画と、あなた自身が追加する2本目のメイン動画 — が表示されます。トゥワーク、自己紹介、ティーズ — 何でもOK、あなたのページであなたのフックです。追加はこちら：設定 → マイ写真 💋', zh: '📸🎬 新更新：你的主页变大了！打开你主页的粉丝现在能看到你多达 10 张照片，还有两段主页视频 — 你的预览视频加上你自己添加的第二段主视频。电臀舞、自我介绍、撩人 — 随你喜欢，这是你的页面、你的招牌。在这里添加：设置 → 我的照片 💋', ko: '📸🎬 새 업데이트: 프로필이 더 커졌어요! 프로필을 여는 팬들은 이제 당신의 사진을 최대 10장, 그리고 프로필 영상 두 개 — 미리보기 영상과 직접 추가하는 두 번째 메인 영상 — 를 볼 수 있어요. 트월킹, 자기소개, 티징 — 원하는 대로, 당신의 페이지이자 당신의 훅이에요. 추가하기: 설정 → 내 사진 💋', it: '📸🎬 NUOVO AGGIORNAMENTO: Il tuo profilo è cresciuto! I fan che aprono il tuo profilo ora vedono fino a 10 delle tue foto E due video profilo — il tuo video di anteprima più un secondo video principale che aggiungi tu. Twerk, presentati, provoca — quello che vuoi, è la tua pagina e il tuo gancio. Aggiungi i tuoi: Impostazioni → La mia foto 💋', pl: '📸🎬 NOWA AKTUALIZACJA: Twój profil się powiększył! Fani, którzy otwierają Twój profil, widzą teraz do 10 Twoich zdjęć ORAZ dwa filmy profilowe — Twój film poglądowy plus drugi główny film, który dodajesz sama. Twerk, przedstaw się, drażnij — co chcesz, to Twoja strona i Twój haczyk. Dodaj swoje: Ustawienia → Moje zdjęcie 💋', nl: '📸🎬 NIEUWE UPDATE: Je profiel is groter geworden! Fans die je profiel openen, zien nu tot 10 van je foto\'s EN twee profielvideo\'s — je previewvideo plus een tweede hoofdvideo die je zelf toevoegt. Twerk, stel jezelf voor, tease — wat je wilt, het is jouw pagina en jouw hook. Voeg de jouwe toe: Instellingen → Mijn foto 💋', tr: '📸🎬 YENİ GÜNCELLEME: Profilin büyüdü! Profilini açan hayranlar artık 10 fotoğrafını VE iki profil videonu görüyor — önizleme videon artı kendin eklediğin ikinci bir ana video. Twerk yap, kendini tanıt, kışkırt — ne istersen, bu senin sayfan ve senin kancan. Seninkileri ekle: Ayarlar → Fotoğrafım 💋' },
  ann_profile_media_bell_title: { en: '📸 NEW UPDATE: 10 pictures + 2 videos on your profile!', es: '📸 NUEVA ACTUALIZACIÓN: ¡10 fotos + 2 videos en tu perfil!', pt: '📸 NOVA ATUALIZAÇÃO: 10 fotos + 2 vídeos no seu perfil!', fr: '📸 NOUVELLE MISE À JOUR : 10 photos + 2 vidéos sur ton profil !', de: '📸 NEUES UPDATE: 10 Bilder + 2 Videos auf deinem Profil!', ru: '📸 НОВОЕ ОБНОВЛЕНИЕ: 10 фото + 2 видео в твоём профиле!', ja: '📸 新しいアップデート：プロフィールに写真10枚＋動画2本！', zh: '📸 新更新：你的主页有 10 张照片 + 2 段视频！', ko: '📸 새 업데이트: 프로필에 사진 10장 + 영상 2개!', it: '📸 NUOVO AGGIORNAMENTO: 10 foto + 2 video sul tuo profilo!', pl: '📸 NOWA AKTUALIZACJA: 10 zdjęć + 2 filmy na Twoim profilu!', nl: '📸 NIEUWE UPDATE: 10 foto\'s + 2 video\'s op je profiel!', tr: '📸 YENİ GÜNCELLEME: Profilinde 10 fotoğraf + 2 video!' },
  ann_profile_media_bell_body: { en: 'Fans see up to 10 pictures and both your profile videos. Add yours in Settings 💋', es: 'Los fans ven hasta 10 fotos y tus dos videos de perfil. Agrega los tuyos en Ajustes 💋', pt: 'Os fãs veem até 10 fotos e os seus dois vídeos de perfil. Adicione os seus em Configurações 💋', fr: 'Les fans voient jusqu\'à 10 photos et tes deux vidéos de profil. Ajoute les tiennes dans Paramètres 💋', de: 'Fans sehen bis zu 10 Bilder und beide deiner Profilvideos. Füge deine in den Einstellungen hinzu 💋', ru: 'Фанаты видят до 10 фото и оба твоих видео профиля. Добавь свои в Настройках 💋', ja: 'ファンには写真が最大10枚とプロフィール動画2本の両方が表示されます。設定で追加してね 💋', zh: '粉丝能看到多达 10 张照片和你的两段主页视频。在设置中添加 💋', ko: '팬들은 사진 최대 10장과 프로필 영상 두 개를 모두 봐요. 설정에서 추가하세요 💋', it: 'I fan vedono fino a 10 foto ed entrambi i tuoi video profilo. Aggiungi i tuoi in Impostazioni 💋', pl: 'Fani widzą do 10 zdjęć i oba Twoje filmy profilowe. Dodaj swoje w Ustawieniach 💋', nl: 'Fans zien tot 10 foto\'s en allebei je profielvideo\'s. Voeg de jouwe toe in Instellingen 💋', tr: 'Hayranlar 10 fotoğrafını ve iki profil videonu da görüyor. Seninkileri Ayarlar\'dan ekle 💋' },
  suggest_admin_title: { en: '💡 New suggestion from {username}', es: '💡 Nueva sugerencia de {username}', pt: '💡 Nova sugestão de {username}', fr: '💡 Nouvelle suggestion de {username}', de: '💡 Neuer Vorschlag von {username}', ru: '💡 Новое предложение от {username}', ja: '💡 {username} さんからの新しい提案', zh: '💡 来自 {username} 的新建议', ko: '💡 {username}님의 새 건의', it: '💡 Nuovo suggerimento da {username}', pl: '💡 Nowa sugestia od {username}', nl: '💡 Nieuwe suggestie van {username}', tr: '💡 {username} kullanıcısından yeni öneri' },
  ann_lang_fan_title: { en: '🌍 NEW: SlutCamp speaks YOUR language!', es: '🌍 NUEVO: ¡SlutCamp habla TU idioma!', pt: '🌍 NOVIDADE: a SlutCamp fala SEU idioma!', fr: '🌍 NOUVEAU : SlutCamp parle VOTRE langue !', de: '🌍 NEU: SlutCamp spricht DEINE Sprache!', ru: '🌍 НОВОЕ: SlutCamp говорит на ВАШЕМ языке!', ja: '🌍 新機能：SlutCampはあなたの言語に対応！', zh: '🌍 新功能：SlutCamp 说你的语言！', ko: '🌍 새 소식: SlutCamp가 당신의 언어를 지원합니다!', it: '🌍 NOVITÀ: SlutCamp parla la TUA lingua!', pl: '🌍 NOWOŚĆ: SlutCamp mówi w TWOIM języku!', nl: '🌍 NIEUW: SlutCamp spreekt JOUW taal!', tr: '🌍 YENİ: SlutCamp SENİN dilini konuşuyor!' },
  ann_lang_fan_body: { en: 'The whole app now speaks 13 languages — switch anytime in Settings: buttons, messages and agreements included 💋', es: 'Toda la app ahora habla 13 idiomas — cámbialo cuando quieras en Ajustes: botones, mensajes y acuerdos incluidos 💋', pt: 'O app inteiro agora fala 13 idiomas — troque quando quiser em Configurações: botões, mensagens e contratos incluídos 💋', fr: 'Toute l\'appli parle maintenant 13 langues — changez à tout moment dans Paramètres : boutons, messages et contrats inclus 💋', de: 'Die ganze App spricht jetzt 13 Sprachen — stelle jederzeit in den Einstellungen um: Schaltflächen, Nachrichten und Vereinbarungen inklusive 💋', ru: 'Всё приложение теперь говорит на 13 языках — переключайте в любое время в Настройках: кнопки, сообщения и соглашения включены 💋', ja: 'アプリ全体が13言語に対応しました — 設定でいつでも切り替え可能：ボタン、メッセージ、契約も含まれます 💋', zh: '整个应用现在支持 13 种语言 — 随时在设置中切换：包括按钮、消息和协议 💋', ko: '이제 앱 전체가 13개 언어를 지원합니다 — 설정에서 언제든지 바꾸세요: 버튼, 메시지, 계약까지 포함됩니다 💋', it: 'L\'intera app ora parla 13 lingue — cambia in qualsiasi momento in Impostazioni: pulsanti, messaggi e contratti inclusi 💋', pl: 'Cała aplikacja mówi teraz w 13 językach — przełącz w każdej chwili w Ustawieniach: przyciski, wiadomości i umowy w zestawie 💋', nl: 'De hele app spreekt nu 13 talen — schakel op elk moment in Instellingen: knoppen, berichten en overeenkomsten inbegrepen 💋', tr: 'Tüm uygulama artık 13 dil konuşuyor — Ayarlar\'dan istediğin zaman değiştir: düğmeler, mesajlar ve sözleşmeler dahil 💋' },
};

function srv(key, lang, vars) {
  const row = SRV[key];
  let s = (row && (row[lang] || row.en)) || key;
  if (vars) for (const k in vars) s = s.split('{' + k + '}').join(String(vars[k]));
  return s;
}

/* The stored UI language of a user id (recipient-side bell/DM copy). */
function userLang(userId) {
  try {
    const u = db.prepare('SELECT language FROM users WHERE id = ?').get(userId);
    return (u && u.language) || 'en';
  } catch (e) { return 'en'; }
}

/* ------------------------------------------------------------------ */
/* Model welcome message — congratulations in her app inbox           */
/* ------------------------------------------------------------------ */
const MODEL_WELCOME = {
  en: (name) => `🎉 Congratulations, ${name}!

Welcome to SlutCamp 💋 You're officially one of our models — and you're in early. Early models get seen first, and the fans are already waiting.

💰 You keep 60% of everything: paid messages, live streams + video calls paid per minute at YOUR prices, tips and paid content.

To start earning:
✍️ Sign your model agreement
🪪 Verify your ID (2257 — keeps you legal and paid)
📸 Add your photo, set your prices, and go live

Questions? Just reply right here. Welcome to the family 🔥 — Asce`,
  es: (name) => `🎉 ¡Felicidades, ${name}!

Bienvenida a SlutCamp 💋 Ya eres oficialmente una de nuestras modelos — y llegaste temprano. Las primeras modelos se ven primero, y los fans ya están esperando.

💰 Te quedas con el 60% de todo: mensajes pagos, lives y videollamadas pagadas por minuto a TUS precios, propinas y contenido pago.

Para empezar a ganar:
✍️ Firma tu acuerdo de modelo
🪪 Verifica tu ID (2257 — te mantiene legal y cobrando)
📸 Sube tu foto, pon tus precios y sal en vivo

¿Preguntas? Responde aquí mismo. Bienvenida a la familia 🔥 — Asce`,
  pt: (name) => `🎉 Parabéns, ${name}!

Bem-vinda à SlutCamp 💋 Você agora é oficialmente uma das nossas modelos — e chegou cedo. As primeiras modelos são vistas primeiro, e os fãs já estão esperando.

💰 Você fica com 60% de tudo: mensagens pagas, lives e videochamadas pagas por minuto nos SEUS preços, gorjetas e conteúdo pago.

Para começar a ganhar:
✍️ Assine seu contrato de modelo
🪪 Verifique seu documento (2257 — mantém você legal e recebendo)
📸 Adicione sua foto, defina seus preços e entre ao vivo

Dúvidas? Responda aqui mesmo. Bem-vinda à família 🔥 — Asce`,
  fr: (name) => `🎉 Félicitations, ${name} !

Bienvenue sur SlutCamp 💋 Vous êtes officiellement l'un de nos modèles — et vous arrivez tôt. Les premiers modèles sont vus en premier, et les fans attendent déjà.

💰 Vous gardez 60% de tout : messages payants, diffusions en direct + appels vidéo payés à la minute à VOS tarifs, pourboires et contenu payant.

Pour commencer à gagner :
✍️ Signez votre contrat de modèle
🪪 Vérifiez votre pièce d'identité (2257 — pour rester en règle et être payée)
📸 Ajoutez votre photo, définissez vos tarifs et passez en direct

Des questions ? Répondez simplement ici même. Bienvenue dans la famille 🔥 — Asce`,
  de: (name) => `🎉 Glückwunsch, ${name}!

Willkommen bei SlutCamp 💋 Du bist jetzt offiziell eines unserer Modelle — und du bist früh dabei. Frühe Modelle werden zuerst gesehen, und die Fans warten schon.

💰 Du behältst 60% von allem: bezahlte Nachrichten, Livestreams + Videoanrufe, die pro Minute zu DEINEN Preisen abgerechnet werden, Trinkgelder und bezahlte Inhalte.

So fängst du an zu verdienen:
✍️ Unterschreibe deine Model-Vereinbarung
🪪 Verifiziere deinen Ausweis (2257 — hält dich legal und bezahlt)
📸 Füge dein Foto hinzu, lege deine Preise fest und geh live

Fragen? Antworte einfach hier. Willkommen in der Familie 🔥 — Asce`,
  ru: (name) => `🎉 Поздравляем, ${name}!

Добро пожаловать в SlutCamp 💋 Теперь вы официально одна из наших моделей — и вы здесь с самого начала. Первых моделей видят первыми, а фанаты уже ждут.

💰 Вы сохраняете 60% от всего: платные сообщения, прямые эфиры + видеозвонки с оплатой за минуту по ВАШИМ ценам, чаевые и платный контент.

Чтобы начать зарабатывать:
✍️ Подпишите ваше соглашение модели
🪪 Подтвердите удостоверение личности (2257 — это сохраняет вашу легальность и оплату)
📸 Добавьте фото, установите цены и выходите в эфир

Вопросы? Просто ответьте прямо здесь. Добро пожаловать в семью 🔥 — Asce`,
  ja: (name) => `🎉 おめでとう、${name}さん！

SlutCampへようこそ 💋 あなたは正式に当社のモデルの1人です — しかも早めに参加できました。早いモデルのほうが先に目立てるし、ファンはもう待っています。

💰 あなたはすべての60%をキープします：有料メッセージ、ライブ配信＋あなたの値段で1分ごとに課金されるビデオ通話、チップ、有料コンテンツ。

稼ぎ始めるには：
✍️ モデル契約にサインする
🪪 身分証を確認する（2257 — 法的に守られて、ちゃんと支払いが受けられるよ）
📸 写真を追加して、料金を設定して、ライブ配信を開始

質問は？ここに返信してね。ファミリーへようこそ 🔥 — Asce`,
  zh: (name) => `🎉 恭喜你，${name}！

欢迎来到 SlutCamp 💋 你已正式成为我们的模特之一 — 而且你入驻得很早。早期模特会优先被看到，粉丝们已经在等你了。

💰 所有收入你都能留 60%：付费消息、直播 + 按分钟计费的视频通话（价格由你定）、小费和付费内容。

开始赚钱：
✍️ 签署你的模特协议
🪪 验证你的身份证件（2257 — 让你合法且能拿到报酬）
📸 添加你的照片、设置价格，然后开始直播

有问题？直接在这里回复。欢迎加入这个大家庭 🔥 — Asce`,
  ko: (name) => `🎉 축하합니다, ${name}님!

SlutCamp에 오신 것을 환영합니다 💋 이제 공식적으로 저희 모델 중 한 분입니다 — 게다가 일찍 합류하셨네요. 초기 모델이 가장 먼저 노출되고, 팬들이 이미 기다리고 있습니다.

💰 모든 수익의 60%를 가져가세요: 유료 메시지, 본인이 정한 분당 가격으로 진행하는 라이브 스트림 + 영상 통화, 팁과 유료 콘텐츠.

수익을 시작하려면:
✍️ 모델 계약서에 서명하세요
🪪 신분증을 인증하세요 (2257 — 합법적으로 활동하고 수익을 받기 위해 필요합니다)
📸 사진을 추가하고, 가격을 설정한 뒤 라이브를 시작하세요

궁금한 점이 있으신가요? 바로 여기에 답장하세요. 가족이 된 것을 환영합니다 🔥 — Asce`,
  it: (name) => `🎉 Congratulazioni, ${name}!

Benvenuta su SlutCamp 💋 Sei ufficialmente una delle nostre modelle — e sei tra le prime. Le prime modelle vengono viste per prime, e i fan stanno già aspettando.

💰 Trattieni il 60% di tutto: messaggi a pagamento, live stream + videochiamate pagate al minuto ai TUOI prezzi, mance e contenuti a pagamento.

Per iniziare a guadagnare:
✍️ Firma il tuo contratto da modella
🪪 Verifica il tuo documento (2257 — ti mantiene in regola e pagata)
📸 Aggiungi la tua foto, imposta i tuoi prezzi e vai live

Domande? Rispondi pure qui. Benvenuta in famiglia 🔥 — Asce`,
  pl: (name) => `🎉 Gratulacje, ${name}!

Witaj w SlutCamp 💋 Jesteś teraz oficjalnie jedną z naszych modelek — i jesteś tu wcześnie. Wczesne modelki są widoczne jako pierwsze, a fani już czekają.

💰 Zatrzymujesz 60% wszystkiego: płatnych wiadomości, transmisji na żywo + rozmów wideo płatnych za minutę według TWOICH cen, napiwków i płatnych treści.

Aby zacząć zarabiać:
✍️ Podpisz umowę modelki
🪪 Zweryfikuj swój dokument tożsamości (2257 — dzięki temu działasz legalnie i otrzymujesz wypłaty)
📸 Dodaj swoje zdjęcie, ustaw ceny i rozpocznij transmisję na żywo

Pytania? Po prostu odpowiedz tutaj. Witaj w rodzinie 🔥 — Asce`,
  nl: (name) => `🎉 Gefeliciteerd, ${name}!

Welkom bij SlutCamp 💋 Je bent officieel één van onze modellen — en je bent er vroeg bij. Vroege modellen worden als eerste gezien, en de fans wachten al.

💰 Je houdt 60% van alles: betaalde berichten, livestreams + videogesprekken betaald per minuut tegen JOUW tarieven, fooien en betaalde content.

Om te beginnen met verdienen:
✍️ Onderteken je modellenovereenkomst
🪪 Verifieer je ID (2257 — houdt je legaal en betaald)
📸 Voeg je foto toe, stel je tarieven in en ga live

Vragen? Antwoord gewoon hier. Welkom bij de familie 🔥 — Asce`,
  tr: (name) => `🎉 Tebrikler, ${name}!

SlutCamp'e hoş geldin 💋 Artık resmen modellerimizden birisin — ve erken geldin. Erken modeller önce görülür, hayranlar da çoktan bekliyor.

💰 Her şeyin %60'ını sen alırsın: ücretli mesajlar, canlı yayınlar + SENİN fiyatlarınla dakika başına ücretli görüntülü aramalar, bahşişler ve ücretli içerik.

Kazanmaya başlamak için:
✍️ Model sözleşmeni imzala
🪪 Kimliğini doğrula (2257 — seni yasal ve kazançta tutar)
📸 Fotoğrafını ekle, fiyatlarını belirle ve canlıya geç

Soruların mı var? Buraya yanıt ver. Aileye hoş geldin 🔥 — Asce`,
};

/* Send the welcome message into a model's inbox exactly once. Sender is
   the admin account (shows as "Asce (Admin)"). Free (cost 0), never blocks
   signup — if anything fails, the boot sweep retries next start. */
function sendModelWelcome(modelUserId) {
  const m = db.prepare("SELECT id, display_name, language, welcome_msg_sent_at FROM users WHERE id = ? AND role = 'model'")
    .get(modelUserId);
  if (!m || m.welcome_msg_sent_at) return false;
  const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1").get();
  if (!admin || admin.id === m.id) return false;
  let conv = db.prepare('SELECT id FROM conversations WHERE fan_id = ? AND model_id = ?').get(admin.id, m.id);
  if (!conv) {
    const info = db.prepare('INSERT INTO conversations (fan_id, model_id) VALUES (?,?)').run(admin.id, m.id);
    conv = { id: Number(info.lastInsertRowid) };
  }
  const make = MODEL_WELCOME[m.language] || MODEL_WELCOME.en;
  db.prepare('INSERT INTO messages (conversation_id, sender_id, body) VALUES (?,?,?)')
    .run(conv.id, admin.id, make(m.display_name));
  db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?").run(conv.id);
  db.prepare("UPDATE users SET welcome_msg_sent_at = datetime('now') WHERE id = ?").run(m.id);
  try {
    notifyUser(m.id, 'welcome', srv('bell_welcome_title', m.language),
      srv('bell_welcome_body', m.language), `/#chat/${conv.id}`);
  } catch (e) { /* the bell is a bonus; the message is the deliverable */ }
  return true;
}

/* Boot sweep: every model who never got the welcome message gets it now. */
function sendPendingModelWelcomes() {
  const rows = db.prepare("SELECT id FROM users WHERE role = 'model' AND welcome_msg_sent_at IS NULL").all();
  for (const r of rows) { try { sendModelWelcome(r.id); } catch (e) { /* retry next boot */ } }
}

/* ------------------------------------------------------------------ */
/* Model guide message — how the app works + how she makes money.     */
/* Lands in the same admin thread, right behind the welcome DM.       */
/* (One message: the copy is ~1.5k chars; messages.body is unbounded  */
/* TEXT and this insert path has no cap — the 2,000-char slice only   */
/* applies to user-typed chat via POST /api/messages.)                */
/* ------------------------------------------------------------------ */
const MODEL_GUIDE = {
  en: `💋 How SlutCamp works — and how you get paid

Welcome in! Here's the whole game, quick:

🏠 HOME — the shop window. Fans scroll the girls here. Your spot is earned: more likes ❤️ + more sales = higher up, and the #1 girl wears the 👑. Peek at the other girls from your Home tab — see what the top girls charge and how they do it.

💬 CHATS — fans pay per message at YOUR price. Every text he sends you earns. Set your price in Settings.

📹 FACETIME — private video by the minute (10–60 min, he pays upfront). Accept when you want; if you're mid-call he waits in line. Mid-call you can offer to switch explicit for double. Your rate, your call.

🔴 GO LIVE — stream to everyone. Fans pay to join your stage, tip you, and fight for the 👑 at the top of your live (top spender of the stream). Your biggest spenders land in your 🏆 Fan Club under Earnings — treat them sweet, they pay the rent.

📅 BOOKINGS — fans schedule FaceTime dates ahead. Guaranteed prepaid minutes.

💰 YOUR MONEY — you keep 60% of EVERYTHING. Watch it live in Earnings. Before your first payout, add your tax info (W-9) in Settings — you're a 1099 contractor, we never touch your taxes.

⚠️ THE ONE RULE — everything stays on SlutCamp. Never move a fan to Cash App, Venmo, Zelle or another app, and never drop your number or socials in chat. The system listens for it — it ends the stream and strikes your account. Protect your bag.

Start here: sign your agreement → verify your ID → photo + prices → go live. Fans are waiting 🔥

Questions? Reply right here, I read everything. — Asce`,
  es: `💋 Cómo funciona SlutCamp — y cómo te pagan

¡Bienvenida! Aquí va todo el juego, rápido:

🏠 INICIO — el escaparate. Los fans recorren a las chicas aquí. Tu lugar se gana: más likes ❤️ + más ventas = más arriba, y la chica #1 lleva la 👑. Espía a las demás chicas desde tu pestaña de Inicio — mira cuánto cobran las mejores y cómo lo hacen.

💬 CHATS — los fans pagan por mensaje a TU precio. Cada texto que te manda te hace ganar. Pon tu precio en Ajustes.

📹 FACETIME — video privado por minuto (10–60 min, él paga por adelantado). Acepta cuando quieras; si estás en una llamada, él espera en la fila. A mitad de llamada puedes ofrecer cambiar a explícito por el doble. Tu tarifa, tú decides.

🔴 SAL EN VIVO — transmite para todos. Los fans pagan por unirse a tu escenario, te dan propinas y pelean por la 👑 en lo alto de tu live (el que más gasta de la transmisión). Tus fans que más gastan llegan a tu 🏆 Fan Club en Ganancias — trátalos bien, ellos pagan la renta.

📅 RESERVAS — los fans reservan fechas de FaceTime por adelantado. Minutos prepagados garantizados.

💰 TU DINERO — te quedas con el 60% de TODO. Míralo en vivo en Ganancias. Antes de tu primer pago, agrega tu información de impuestos (W-9) en Ajustes — eres contratista 1099, nunca tocamos tus impuestos.

⚠️ LA ÚNICA REGLA — todo se queda en SlutCamp. Nunca muevas a un fan a Cash App, Venmo, Zelle u otra app, y nunca dejes tu número ni tus redes en el chat. El sistema lo escucha — termina la transmisión y sanciona tu cuenta. Protege tu bolsa.

Empieza aquí: firma tu acuerdo → verifica tu ID → foto + precios → sal en vivo. Los fans están esperando 🔥

¿Preguntas? Responde aquí mismo, leo todo. — Asce`,
  pt: `💋 Como a SlutCamp funciona — e como você é paga

Bem-vinda! Aqui está o jogo todo, rapidinho:

🏠 INÍCIO — a vitrine. Os fãs passam pelas garotas aqui. Seu lugar é conquistado: mais likes ❤️ + mais vendas = mais no topo, e a garota nº 1 usa a 👑. Espie as outras garotas na sua aba Início — veja quanto as tops cobram e como elas fazem.

💬 CHATS — os fãs pagam por mensagem no SEU preço. Cada texto que ele te manda, você ganha. Defina seu preço em Configurações.

📹 FACETIME — vídeo privado por minuto (10–60 min, ele paga adiantado). Aceite quando quiser; se estiver no meio de uma chamada, ele espera na fila. No meio da chamada você pode oferecer trocar para explícito pelo dobro. Sua tarifa, você decide.

🔴 ENTRE AO VIVO — transmita para todo mundo. Os fãs pagam para entrar no seu palco, te dão gorjetas e brigam pela 👑 no topo da sua live (quem mais gasta na transmissão). Seus maiores gastadores caem no seu 🏆 Fan Club em Ganhos — trate-os com carinho, são eles que pagam o aluguel.

📅 AGENDAMENTOS — os fãs agendam datas de FaceTime com antecedência. Minutos pré-pagos garantidos.

💰 SEU DINHEIRO — você fica com 60% de TUDO. Acompanhe ao vivo em Ganhos. Antes do seu primeiro pagamento, adicione suas informações fiscais (W-9) em Configurações — você é autônoma 1099, a gente nunca mexe nos seus impostos.

⚠️ A ÚNICA REGRA — tudo fica na SlutCamp. Nunca leve um fã para o Cash App, Venmo, Zelle ou outro app, e nunca jogue seu número ou suas redes no chat. O sistema escuta — ele encerra a transmissão e penaliza sua conta. Proteja sua grana.

Comece aqui: assine seu contrato → verifique seu documento → foto + preços → entre ao vivo. Os fãs estão esperando 🔥

Dúvidas? Responda aqui mesmo, eu leio tudo. — Asce`,
  fr: `💋 Comment fonctionne SlutCamp — et comment vous êtes payée

Bienvenue ! Voici tout le jeu, en rapide :

🏠 ACCUEIL — la vitrine. Les fans font défiler les filles ici. Votre place se mérite : plus de likes ❤️ + plus de ventes = plus haut, et la fille n°1 porte la 👑. Jetez un œil aux autres filles depuis votre onglet Accueil — voyez ce que les meilleures facturent et comment elles s'y prennent.

💬 DISCUSSIONS — les fans paient par message à VOTRE tarif. Chaque texto qu'il vous envoie vous rapporte. Définissez votre tarif dans Paramètres.

📹 FACETIME — vidéo privée à la minute (10–60 min, il paie d'avance). Acceptez quand vous voulez ; si vous êtes en plein appel, il attend en file. En plein appel, vous pouvez proposer de passer en explicite pour le double. Votre tarif, votre décision.

🔴 PASSER EN DIRECT — diffusez pour tout le monde. Les fans paient pour rejoindre votre scène, vous donnent des pourboires et se battent pour la 👑 en haut de votre direct (le plus gros dépensier du stream). Vos plus gros dépensiers atterrissent dans votre 🏆 Fan Club sous Gains — traitez-les bien, ce sont eux qui paient le loyer.

📅 RÉSERVATIONS — les fans programment des rendez-vous FaceTime à l'avance. Minutes prépayées garanties.

💰 VOTRE ARGENT — vous gardez 60% de TOUT. Suivez-le en direct dans Gains. Avant votre premier paiement, ajoutez vos informations fiscales (W-9) dans Paramètres — vous êtes une contractante indépendante 1099, nous ne touchons jamais à vos impôts.

⚠️ LA RÈGLE UNIQUE — tout reste sur SlutCamp. Ne déplacez jamais un fan vers Cash App, Venmo, Zelle ou une autre appli, et ne laissez jamais votre numéro ou vos réseaux sociaux dans la discussion. Le système écoute — il met fin au stream et sanctionne votre compte. Protégez votre argent.

Commencez ici : signez votre contrat → vérifiez votre pièce d'identité → photo + tarifs → passez en direct. Les fans attendent 🔥

Des questions ? Répondez ici même, je lis tout. — Asce`,
  de: `💋 So funktioniert SlutCamp — und so wirst du bezahlt

Willkommen drin! Hier ist das ganze Spiel, kurz:

🏠 START — das Schaufenster. Fans scrollen hier durch die Mädchen. Dein Platz ist verdient: mehr Likes ❤️ + mehr Verkäufe = weiter oben, und das #1-Mädchen trägt die 👑. Schau dir die anderen Mädchen in deinem Start-Tab an — sieh, was die Top-Mädchen verlangen und wie sie es machen.

💬 CHATS — Fans zahlen pro Nachricht zu DEINEM Preis. Jeder Text, den er dir schickt, verdient. Lege deinen Preis in den Einstellungen fest.

📹 FACETIME — privates Video pro Minute (10–60 Min., er zahlt im Voraus). Akzeptiere, wenn du willst; wenn du mitten in einem Anruf bist, wartet er in der Schlange. Während des Anrufs kannst du anbieten, für das Doppelte auf explizit zu wechseln. Dein Preis, deine Entscheidung.

🔴 LIVE GEHEN — streame für alle. Fans zahlen, um deiner Bühne beizutreten, dir Trinkgeld zu geben und um die 👑 oben in deinem Live zu kämpfen (Top-Ausgeber des Streams). Deine größten Ausgeber landen in deinem 🏆 Fanclub unter Einnahmen — behandle sie süß, sie zahlen die Miete.

📅 BUCHUNGEN — Fans planen FaceTime-Termine im Voraus. Garantierte, im Voraus bezahlte Minuten.

💰 DEIN GELD — du behältst 60% von ALLEM. Beobachte es live unter Einnahmen. Vor deiner ersten Auszahlung füge deine Steuerinformationen (W-9) in den Einstellungen hinzu — du bist eine 1099-Vertragspartnerin, wir fassen deine Steuern nie an.

⚠️ DIE EINE REGEL — alles bleibt auf SlutCamp. Bewege einen Fan niemals zu Cash App, Venmo, Zelle oder einer anderen App und gib niemals deine Nummer oder Socials im Chat weiter. Das System hört mit — es beendet den Stream und schlägt deinen Account. Schütze deine Tasche.

Starte hier: unterschreibe deine Vereinbarung → verifiziere deinen Ausweis → Foto + Preise → geh live. Fans warten 🔥

Fragen? Antworte hier, ich lese alles. — Asce`,
  ru: `💋 Как работает SlutCamp — и как вы получаете оплату

Добро пожаловать! Вот вся игра, быстро:

🏠 ГЛАВНАЯ — витрина магазина. Фанаты листают девушек здесь. Ваше место заслужено: больше лайков ❤️ + больше продаж = выше, а девушка №1 носит 👑. Загляните к другим девушкам из вкладки Главная — посмотрите, сколько берут топовые девушки и как они это делают.

💬 ЧАТЫ — фанаты платят за сообщение по ВАШЕЙ цене. Каждое отправленное им сообщение приносит вам доход. Установите вашу цену в Настройках.

📹 FACETIME — приватное видео по минутам (10–60 мин, он платит вперёд). Принимайте, когда хотите; если вы в середине звонка, он ждёт в очереди. В середине звонка вы можете предложить перейти к откровенному за двойную плату. Ваш тариф, ваше решение.

🔴 ВЫХОД В ЭФИР — трансляция для всех. Фанаты платят, чтобы присоединиться к вашей сцене, отправляют вам чаевые и борются за 👑 на вершине вашего эфира (самый щедрый фанат трансляции). Ваши самые щедрые фанаты попадают в ваш 🏆 Фан-клуб в разделе Доход — относитесь к ним ласково, они оплачивают аренду.

📅 БРОНИРОВАНИЯ — фанаты заранее назначают даты FaceTime. Гарантированные предоплаченные минуты.

💰 ВАШИ ДЕНЬГИ — вы сохраняете 60% от ВСЕГО. Следите за этим в реальном времени в разделе Доход. Перед первой выплатой добавьте вашу налоговую информацию (W-9) в Настройках — вы подрядчик 1099, мы никогда не трогаем ваши налоги.

⚠️ ОДНО ПРАВИЛО — всё остаётся на SlutCamp. Никогда не переводите фаната в Cash App, Venmo, Zelle или другое приложение и никогда не оставляйте ваш номер или соцсети в чате. Система следит за этим — она завершает трансляцию и выносит предупреждение вашему аккаунту. Берегите свой заработок.

Начните здесь: подпишите соглашение → подтвердите удостоверение личности → фото + цены → выходите в эфир. Фанаты ждут 🔥

Вопросы? Ответьте прямо здесь, я читаю всё. — Asce`,
  ja: `💋 SlutCampの仕組み — そして支払いの受け方

ようこそ！全体の流れをサクッと説明するね：

🏠 ホーム — ショーウィンドウ。ファンはここで女の子たちをスクロールします。あなたの順位は努力で決まります：いいね ❤️ が多いほど＋売上が多いほど上位に表示され、1位の女の子は 👑 を着けます。ホームタブから他の女の子たちを覗いてみて — トップの子たちがどれくらい請求して、どうやってるか見てみてね。

💬 チャット — ファンはあなたの値段でメッセージごとに支払います。彼が送るテキスト1通ごとにあなたが稼げます。料金は設定で決めてね。

📹 FACETIME — 1分ごとのプライベートビデオ（10〜60分、彼は前払い）。好きなときに承諾してね。通話中の場合は彼は列で待ちます。通話中に露骨に切り替えるオファーを2倍で出すこともできます。あなたの料金、あなたの判断。

🔴 ライブ配信 — 全員に向けて配信。ファンはステージ参加のために支払い、チップを送り、あなたのライブ上位の 👑 を競います（その配信での最高額利用者）。あなたの最大の支援者は収益内の 🏆 ファンクラブに入ります — 大切にしてね、彼らが家賃を払ってくれるんだから。

📅 予約 — ファンはFaceTimeの予定を事前に予約します。前払い保証の分数です。

💰 あなたのお金 — あなたはすべての60%をキープします。収益でライブで確認してね。初回出金の前に、設定で税務情報（W-9）を追加してね — あなたは1099の個人事業主です。当社があなたの税金に触れることは決してありません。

⚠️ たった1つのルール — すべてはSlutCamp内に留めてね。ファンをCash App、Venmo、Zelleや別のアプリに決して移さず、チャットで番号やSNSを決して出さないでね。システムが監視しています — 配信が終了し、アカウントにペナルティが付きます。あなたの収入を守ってね。

ここから始めてね：契約にサイン → 身分証を確認 → 写真＋料金 → ライブ配信。ファンが待ってるよ 🔥

質問は？ここに返信してね、全部読んでいます。— Asce`,
  zh: `💋 SlutCamp 如何运作 — 以及你如何获得报酬

欢迎加入！这是全部玩法，很简单：

🏠 首页 — 橱窗。粉丝在这里浏览女孩们。你的位置靠争取：点赞越多 ❤️ + 销售越多 = 排名越靠前，排名第一的女孩戴着 👑。从你的首页标签看看其他女孩 — 看看顶级女孩收多少钱、她们怎么做。

💬 聊天 — 粉丝按你定的价格为每条消息付费。他发给你的每条短信你都能赚钱。在设置中设置你的价格。

📹 FACETIME — 按分钟计费的私密视频（10–60 分钟，他预付费用）。想接的时候就接；如果你正在通话中，他会排队等候。通话中你可以提出切换到露骨模式，价格翻倍。你的费率，你做主。

🔴 开始直播 — 向所有人直播。粉丝付费加入你的舞台、给你打赏，并在你的直播顶部争夺 👑（本场直播消费最高者）。你消费最高的粉丝会进入收入下的 🏆 粉丝俱乐部 — 好好待他们，他们付房租。

📅 预约 — 粉丝提前预约 FaceTime 约会。保证预付的分钟数。

💰 你的钱 — 所有收入你留 60%。在收入中实时查看。在首次提现前，在设置中添加你的税务信息 (W-9) — 你是 1099 独立承包商，我们从不碰你的税。

⚠️ 唯一规则 — 一切都留在 SlutCamp。绝不要把粉丝转移到 Cash App、Venmo、Zelle 或其他应用，也绝不要在聊天中留下你的号码或社交账号。系统会监听 — 它会结束直播并对你的账号记过。保护好你的钱袋。

从这里开始：签署协议 → 验证身份证件 → 照片 + 价格 → 开始直播。粉丝们在等你 🔥

有问题？直接在这里回复，我什么都看。— Asce`,
  ko: `💋 SlutCamp 이용 방법 — 그리고 수익을 받는 방법

환영합니다! 전체 게임을 빠르게 알려드립니다:

🏠 홈 — 상점의 쇼윈도입니다. 팬들이 여기서 여자들을 스크롤합니다. 내 자리는 노력으로 얻어집니다: 좋아요 ❤️가 많고 + 판매가 많을수록 더 위에 올라가고, 1위인 그녀는 👑를 착용합니다. 홈 탭에서 다른 그녀들을 살펴보세요 — 상위 그녀들이 얼마를 받고 어떻게 하는지 보세요.

💬 채팅 — 팬이 본인이 정한 가격으로 메시지마다 결제합니다. 그가 보내는 문자마다 수익이 발생합니다. 설정에서 가격을 정하세요.

📹 FACETIME — 분당 프라이빗 영상 (10–60분, 그가 선불로 결제합니다). 원할 때 수락하세요; 통화 중이면 그는 줄을 서서 기다립니다. 통화 중에는 선정적으로 전환하면 두 배를 받도록 제안할 수 있습니다. 내 요금, 내 결정입니다.

🔴 라이브 시작 — 모두에게 스트리밍하세요. 팬이 무대에 참여하기 위해 결제하고, 팁을 주고, 라이브 맨 위의 👑를 차지하기 위해 경쟁합니다 (스트림의 최고 지출자). 가장 많이 쓰는 팬들은 수익 아래의 🏆 팬클럽에 들어갑니다 — 그들을 달콤하게 대하세요, 그들이 월세를 냅니다.

📅 예약 — 팬이 FaceTime 날짜를 미리 예약합니다. 보장된 선불 시간입니다.

💰 내 돈 — 모든 것의 60%를 가져갑니다. 수익에서 실시간으로 확인하세요. 첫 지급 전에 설정에서 세금 정보(W-9)를 추가하세요 — 1099 계약자이며, 저희는 세금에 절대 손대지 않습니다.

⚠️ 유일한 규칙 — 모든 것은 SlutCamp 안에 머무릅니다. 팬을 Cash App, Venmo, Zelle이나 다른 앱으로 절대 이동시키지 말고, 채팅에 번호나 소셜 계정을 절대 올리지 마세요. 시스템이 이를 감지합니다 — 스트림이 종료되고 계정에 경고가 쌓입니다. 내 수익을 지키세요.

여기서 시작하세요: 계약서에 서명 → 신분증 인증 → 사진 + 가격 → 라이브 시작. 팬들이 기다리고 있습니다 🔥

궁금한 점이 있으신가요? 바로 여기에 답장하세요, 저는 모든 것을 읽습니다. — Asce`,
  it: `💋 Come funziona SlutCamp — e come vieni pagata

Benvenuta! Ecco tutto il gioco, in breve:

🏠 HOME — la vetrina. I fan scorrono le ragazze qui. Il tuo posto si guadagna: più like ❤️ + più vendite = più in alto, e la ragazza #1 indossa la 👑. Dai un'occhiata alle altre ragazze dalla tua scheda Home — vedi quanto chiedono le top e come fanno.

💬 CHAT — i fan pagano per messaggio al TUO prezzo. Ogni messaggio che ti manda guadagna. Imposta il tuo prezzo in Impostazioni.

📹 FACETIME — video privato al minuto (10–60 min, lui paga in anticipo). Accetta quando vuoi; se sei in un'altra chiamata lui aspetta in fila. Durante la chiamata puoi proporre di passare a esplicito per il doppio. La tua tariffa, la tua scelta.

🔴 VAI LIVE — trasmetti a tutti. I fan pagano per unirsi al tuo palco, ti danno mance e lottano per la 👑 in cima alla tua live (il maggior spenditore dello stream). I tuoi maggiori spenditori finiscono nel tuo 🏆 Fan Club sotto Guadagni — trattali bene, pagano l'affitto.

📅 PRENOTAZIONI — i fan programmano appuntamenti FaceTime in anticipo. Minuti prepagati garantiti.

💰 I TUOI SOLDI — trattieni il 60% di TUTTO. Guardalo in tempo reale in Guadagni. Prima del tuo primo pagamento, aggiungi le tue informazioni fiscali (W-9) in Impostazioni — sei una collaboratrice 1099, non tocchiamo mai le tue tasse.

⚠️ L'UNICA REGOLA — tutto resta su SlutCamp. Non spostare mai un fan su Cash App, Venmo, Zelle o un'altra app, e non lasciare mai il tuo numero o i tuoi social in chat. Il sistema ascolta — termina lo stream e colpisce il tuo account. Proteggi il tuo guadagno.

Inizia qui: firma il contratto → verifica il documento → foto + prezzi → vai live. I fan stanno aspettando 🔥

Domande? Rispondi qui, leggo tutto. — Asce`,
  pl: `💋 Jak działa SlutCamp — i jak otrzymujesz wypłaty

Witaj! Oto cała gra, w skrócie:

🏠 STRONA GŁÓWNA — witryna sklepowa. Fani przewijają tu dziewczyny. Twoje miejsce trzeba zdobyć: więcej polubień ❤️ + więcej sprzedaży = wyżej, a dziewczyna nr 1 nosi 👑. Podejrzyj inne dziewczyny w zakładce Strona główna — zobacz, ile pobierają najlepsze dziewczyny i jak to robią.

💬 CZATY — fani płacą za wiadomość według TWOJEJ ceny. Każda wiadomość, którą Ci wyśle, zarabia. Ustaw swoją cenę w Ustawieniach.

📹 FACETIME — prywatne wideo za minutę (10–60 min, on płaci z góry). Akceptuj, kiedy chcesz; jeśli jesteś w trakcie rozmowy, on czeka w kolejce. W trakcie rozmowy możesz zaproponować przejście do erotyki za podwójną stawkę. Twoja stawka, Twoja decyzja.

🔴 NA ŻYWO — streamuj do wszystkich. Fani płacą, aby dołączyć do Twojej sceny, dają Ci napiwki i walczą o 👑 na górze Twojej transmisji (największy wydający transmisji). Twoi najwięksi wydający trafiają do Twojego 🏆 Klubu Fanów w Zarobkach — traktuj ich słodko, oni płacą czynsz.

📅 REZERWACJE — fani umawiają terminy FaceTime z wyprzedzeniem. Gwarantowane przedpłacone minuty.

💰 TWOJE PIENIĄDZE — zatrzymujesz 60% WSZYSTKIEGO. Obserwuj to na żywo w Zarobkach. Przed pierwszą wypłatą dodaj swoje informacje podatkowe (W-9) w Ustawieniach — jesteś wykonawcą 1099, nigdy nie dotykamy Twoich podatków.

⚠️ JEDNA ZASADA — wszystko zostaje w SlutCamp. Nigdy nie przenoś fana do Cash App, Venmo, Zelle ani innej aplikacji i nigdy nie podawaj swojego numeru ani social mediów na czacie. System tego nasłuchuje — kończy transmisję i obciąża Twoje konto. Chroń swoją kasę.

Zacznij tutaj: podpisz umowę → zweryfikuj dokument tożsamości → zdjęcie + ceny → rozpocznij transmisję na żywo. Fani czekają 🔥

Pytania? Odpowiedz tutaj, czytam wszystko. — Asce`,
  nl: `💋 Hoe SlutCamp werkt — en hoe je betaald krijgt

Welkom binnen! Hier is het hele spel, snel:

🏠 HOME — de etalage. Fans scrollen hier langs de meiden. Jouw plek is verdiend: meer likes ❤️ + meer verkopen = hoger, en het #1 meisje draagt de 👑. Kijk vanaf je Home-tab naar de andere meiden — zie wat de topmeiden vragen en hoe ze het doen.

💬 CHATS — fans betalen per bericht tegen JOUW tarief. Elke sms die hij je stuurt verdient. Stel je tarief in bij Instellingen.

📹 FACETIME — privévideo per minuut (10–60 min, hij betaalt vooraf). Accepteer wanneer je wilt; als je midden in een gesprek zit, wacht hij in de rij. Midden in het gesprek kun je aanbieden om expliciet te schakelen voor het dubbele. Jouw tarief, jouw beslissing.

🔴 GA LIVE — stream naar iedereen. Fans betalen om mee te doen aan je podium, geven je fooien en vechten om de 👑 bovenaan je live (topbesteder van de stream). Je grootste besteders landen in je 🏆 Fanclub onder Inkomsten — behandel ze lief, zij betalen de huur.

📅 BOEKINGEN — fans plannen FaceTime-dates vooruit. Gegarandeerde vooraf betaalde minuten.

💰 JOUW GELD — je houdt 60% van ALLES. Bekijk het live bij Inkomsten. Voeg vóór je eerste uitbetaling je belastinginfo (W-9) toe bij Instellingen — je bent een 1099-contractant, wij raken je belastingen nooit aan.

⚠️ DE ENE REGEL — alles blijft op SlutCamp. Verplaats een fan nooit naar Cash App, Venmo, Zelle of een andere app, en laat nooit je nummer of socials vallen in de chat. Het systeem luistert ernaar — het beëindigt de stream en slaat je account. Bescherm je geld.

Begin hier: onderteken je overeenkomst → verifieer je ID → foto + tarieven → ga live. Fans wachten 🔥

Vragen? Antwoord gewoon hier, ik lees alles. — Asce`,
  tr: `💋 SlutCamp nasıl çalışır — ve nasıl ödeme alırsın

Hoş geldin! İşte tüm oyun, hızlıca:

🏠 ANA SAYFA — vitrin. Hayranlar kızları burada kaydırır. Yerin kazanılır: daha fazla beğeni ❤️ + daha fazla satış = daha yukarı, ve 1 numaralı kız 👑 takar. Ana Sayfa sekmeden diğer kızlara göz at — en iyi kızların ne ücret aldığını ve nasıl yaptığını gör.

💬 SOHBETLER — hayranlar SENİN fiyatınla mesaj başına öder. Gönderdiği her metin kazandırır. Fiyatını Ayarlar'da belirle.

📹 FACETIME — dakika başına özel video (10–60 dk, önceden öder). İstediğinde kabul et; aramanın ortasındaysan sırada bekler. Arama ortasında iki katına müstehcene geçmeyi teklif edebilirsin. Senin ücretin, senin kararın.

🔴 CANLIYA GEÇ — herkese yayın yap. Hayranlar sahnene katılmak için öder, sana bahşiş verir ve canlı yayının en üstündeki 👑 için yarışır (yayının en çok harcayanı). En çok harcayanların Kazançlar altında 🏆 Hayran Kulübüne düşer — onlara tatlı davran, kirayı onlar öder.

📅 REZERVASYONLAR — hayranlar FaceTime randevularını önceden planlar. Garantili ön ödemeli dakikalar.

💰 PARAN — HER ŞEYİN %60'ını sen alırsın. Kazançlar'da canlı izle. İlk ödemenden önce, Ayarlar'da vergi bilgilerini (W-9) ekle — sen bir 1099 yüklenicisisin, vergilerine asla dokunmayız.

⚠️ TEK KURAL — her şey SlutCamp'te kalır. Bir hayranı asla Cash App, Venmo, Zelle veya başka bir uygulamaya taşıma ve sohbette numaranı veya sosyal hesaplarını asla paylaşma. Sistem bunu dinler — yayını bitirir ve hesabına ihtar verir. Çantanı koru.

Buradan başla: sözleşmeni imzala → kimliğini doğrula → fotoğraf + fiyatlar → canlıya geç. Hayranlar bekliyor 🔥

Soruların mı var? Buraya yanıt ver, her şeyi okurum. — Asce`,
};

/* Send the guide message into a model's inbox exactly once (same
   mechanics as the welcome: admin sender, free, stamped, bell ping). */
function sendModelGuide(modelUserId) {
  const m = db.prepare("SELECT id, display_name, language, guide_msg_sent_at FROM users WHERE id = ? AND role = 'model'")
    .get(modelUserId);
  if (!m || m.guide_msg_sent_at) return false;
  const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1").get();
  if (!admin || admin.id === m.id) return false;
  let conv = db.prepare('SELECT id FROM conversations WHERE fan_id = ? AND model_id = ?').get(admin.id, m.id);
  if (!conv) {
    const info = db.prepare('INSERT INTO conversations (fan_id, model_id) VALUES (?,?)').run(admin.id, m.id);
    conv = { id: Number(info.lastInsertRowid) };
  }
  const text = MODEL_GUIDE[m.language] || MODEL_GUIDE.en;
  db.prepare('INSERT INTO messages (conversation_id, sender_id, body) VALUES (?,?,?)')
    .run(conv.id, admin.id, text);
  db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?").run(conv.id);
  db.prepare("UPDATE users SET guide_msg_sent_at = datetime('now') WHERE id = ?").run(m.id);
  try {
    notifyUser(m.id, 'guide', srv('bell_guide_title', m.language),
      srv('bell_guide_body', m.language), `/#chat/${conv.id}`);
  } catch (e) { /* the bell is a bonus; the message is the deliverable */ }
  return true;
}

/* Boot sweep: every model who never got the guide message gets it now. */
function sendPendingModelGuides() {
  const rows = db.prepare("SELECT id FROM users WHERE role = 'model' AND guide_msg_sent_at IS NULL").all();
  for (const r of rows) { try { sendModelGuide(r.id); } catch (e) { /* retry next boot */ } }
}

/* ------------------------------------------------------------------ */
/* Model guide VIDEO message — the 1-minute tour, same admin thread.  */
/* The video file ships separately (public/video/model-guide.mp4).   */
/* Until it exists on disk: send nothing, leave the stamp NULL — the  */
/* boot sweep then delivers it to everyone the moment the file lands. */
/*                                                                    */
/* Delivery is a plain text link, NOT a native media_items message:   */
/* free admin→model media would render locked for her (the unlock     */
/* path is fan-only — serializer unlock logic + POST /unlock are      */
/* fan-role), while the static /video/ URL plays for anyone.          */
/* ------------------------------------------------------------------ */
const GUIDE_VIDEO_FILE = path.join(__dirname, 'public', 'video', 'model-guide.mp4');
/* (DM text lives in the SRV table: key guide_video_text, per-language.) */

function sendModelGuideVideo(modelUserId) {
  const m = db.prepare("SELECT id, display_name, language, guide_video_sent_at FROM users WHERE id = ? AND role = 'model'")
    .get(modelUserId);
  if (!m || m.guide_video_sent_at) return false;
  if (!fs.existsSync(GUIDE_VIDEO_FILE)) return false; // video not shipped yet — stay unstamped
  const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1").get();
  if (!admin || admin.id === m.id) return false;
  let conv = db.prepare('SELECT id FROM conversations WHERE fan_id = ? AND model_id = ?').get(admin.id, m.id);
  if (!conv) {
    const info = db.prepare('INSERT INTO conversations (fan_id, model_id) VALUES (?,?)').run(admin.id, m.id);
    conv = { id: Number(info.lastInsertRowid) };
  }
  db.prepare('INSERT INTO messages (conversation_id, sender_id, body) VALUES (?,?,?)')
    .run(conv.id, admin.id, srv('guide_video_text', m.language));
  db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?").run(conv.id);
  db.prepare("UPDATE users SET guide_video_sent_at = datetime('now') WHERE id = ?").run(m.id);
  try {
    notifyUser(m.id, 'guide_video', srv('bell_guide_video_title', m.language),
      srv('bell_guide_video_body', m.language), `/#chat/${conv.id}`);
  } catch (e) { /* the bell is a bonus; the message is the deliverable */ }
  return true;
}

/* Boot sweep: once the video file exists, every model missing it gets it. */
function sendPendingModelGuideVideos() {
  if (!fs.existsSync(GUIDE_VIDEO_FILE)) return; // video not shipped yet
  const rows = db.prepare("SELECT id FROM users WHERE role = 'model' AND guide_video_sent_at IS NULL").all();
  for (const r of rows) { try { sendModelGuideVideo(r.id); } catch (e) { /* retry next boot */ } }
}

/* ------------------------------------------------------------------ */
/* Add-to-home-screen VIDEO message — same admin thread, same pattern */
/* as the guide video above. The video file ships in the repo at      */
/* public/video/add-to-home-screen.mp4. Until it exists on disk: send */
/* nothing, leave the stamp NULL — the boot sweep then delivers it to */
/* everyone the moment the file lands.                                */
/*                                                                    */
/* Delivery is a plain text link, NOT a native media_items message —  */
/* same reason as the guide video: free admin→model media would       */
/* render locked for her, while the static /video/ URL plays for      */
/* anyone.                                                            */
/* ------------------------------------------------------------------ */
const ATH_VIDEO_FILE = path.join(__dirname, 'public', 'video', 'add-to-home-screen.mp4');
/* (DM text lives in the SRV table: key ath_video_text, per-language.) */

function sendModelHomeScreenVideo(modelUserId) {
  const m = db.prepare("SELECT id, display_name, language, ath_video_sent_at FROM users WHERE id = ? AND role = 'model'")
    .get(modelUserId);
  if (!m || m.ath_video_sent_at) return false;
  if (!fs.existsSync(ATH_VIDEO_FILE)) return false; // video not shipped yet — stay unstamped
  const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1").get();
  if (!admin || admin.id === m.id) return false;
  let conv = db.prepare('SELECT id FROM conversations WHERE fan_id = ? AND model_id = ?').get(admin.id, m.id);
  if (!conv) {
    const info = db.prepare('INSERT INTO conversations (fan_id, model_id) VALUES (?,?)').run(admin.id, m.id);
    conv = { id: Number(info.lastInsertRowid) };
  }
  db.prepare('INSERT INTO messages (conversation_id, sender_id, body) VALUES (?,?,?)')
    .run(conv.id, admin.id, srv('ath_video_text', m.language));
  db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?").run(conv.id);
  db.prepare("UPDATE users SET ath_video_sent_at = datetime('now') WHERE id = ?").run(m.id);
  try {
    notifyUser(m.id, 'home_screen_video', srv('bell_home_screen_title', m.language),
      srv('bell_home_screen_body', m.language), `/#chat/${conv.id}`);
  } catch (e) { /* the bell is a bonus; the message is the deliverable */ }
  return true;
}

/* Boot sweep: once the video file exists, every model missing it gets it. */
function sendPendingModelHomeScreenVideos() {
  if (!fs.existsSync(ATH_VIDEO_FILE)) return; // video not shipped yet
  const rows = db.prepare("SELECT id FROM users WHERE role = 'model' AND ath_video_sent_at IS NULL").all();
  for (const r of rows) { try { sendModelHomeScreenVideo(r.id); } catch (e) { /* retry next boot */ } }
}

/* ------------------------------------------------------------------ */
/* ID-verification step message — the last welcome DM, same admin     */
/* thread. Signup does NOT require ID verification, but her approval  */
/* gates going live (POST /api/live/start) and payouts — this DM      */
/* tells her exactly that, with the real in-app path: the ⚙️ Settings */
/* tab, where the "🪪 ID Verification" card sits right at the top of  */
/* Model Settings (ID front / ID back / Selfie holding ID, Submit).   */
/*                                                                    */
/* NEW SIGNUPS ONLY: the id_verify_msg_sent_at column is pre-stamped  */
/* for every account that exists when this ships (migration above),   */
/* so the boot sweep below can only ever reach models created after   */
/* the deploy — never a retro blast. Gated on the announcement print  */
/* existing on disk (same discipline as the guide video): until the  */
/* print ships, nothing is sent and the stamp stays NULL. The print   */
/* URL rides on its own line at the end of the DM.                    */
/* ------------------------------------------------------------------ */
const ID_VERIFY_IMG_FILE = path.join(__dirname, 'public', 'img', 'id-verify-announce.png');
const ID_VERIFY_IMG_URL = 'https://slutcamp.app/img/id-verify-announce.png';
const MODEL_ID_VERIFY = {
  en: `Welcome to SlutCamp 💋 One last step to finish setting up: verify your ID — it's what unlocks going live and getting paid. It takes 2 minutes right in the app: Settings → 🪪 ID Verification (the card right at the top). Snap your ID + a quick selfie and you're done — we approve fast. 👑
${ID_VERIFY_IMG_URL}`,
  es: `Bienvenida a SlutCamp 💋 Un último paso para terminar de configurarte: verifica tu ID — es lo que desbloquea salir en vivo y cobrar. Toma 2 minutos en la app: Ajustes → 🪪 ID Verification (la tarjeta que está arriba de todo). Toma una foto de tu ID + una selfie rápida y listo — aprobamos rápido. 👑
${ID_VERIFY_IMG_URL}`,
  pt: `Bem-vinda à SlutCamp 💋 Um último passo para terminar de configurar: verifique seu documento — é o que desbloqueia entrar ao vivo e receber. Leva 2 minutos no app: Configurações → 🪪 ID Verification (o cartão bem no topo). Tire uma foto do seu documento + uma selfie rápida e pronto — aprovamos rápido. 👑
${ID_VERIFY_IMG_URL}`,
  fr: `Bienvenue sur SlutCamp 💋 Une dernière étape pour terminer la configuration : vérifiez votre pièce d'identité — c'est ce qui débloque le direct et les paiements. Cela prend 2 minutes directement dans l'appli : Paramètres → 🪪 Vérification d'identité (la carte tout en haut). Photographiez votre pièce d'identité + un selfie rapide et c'est terminé — nous approuvons vite. 👑
https://slutcamp.app/img/id-verify-announce.png`,
  de: `Willkommen bei SlutCamp 💋 Ein letzter Schritt, um die Einrichtung abzuschließen: Verifiziere deinen Ausweis — das schaltet Live-Gehen und Bezahltwerden frei. Es dauert 2 Minuten direkt in der App: Einstellungen → 🪪 Ausweisverifizierung (die Karte ganz oben). Fotografiere deinen Ausweis + ein kurzes Selfie und du bist fertig — wir genehmigen schnell. 👑
https://slutcamp.app/img/id-verify-announce.png`,
  ru: `Добро пожаловать в SlutCamp 💋 Последний шаг, чтобы завершить настройку: подтвердите ваше удостоверение личности — это то, что открывает выход в эфир и получение оплаты. Это займёт 2 минуты прямо в приложении: Настройки → 🪪 Проверка удостоверения личности (карточка в самом верху). Сфотографируйте ваше удостоверение + быстрое селфи, и вы готовы — мы одобряем быстро. 👑
https://slutcamp.app/img/id-verify-announce.png`,
  ja: `SlutCampへようこそ 💋 セットアップを完了するための最後のステップ：身分証を確認してね — ライブ配信と支払い受け取りがアンロックされます。アプリ内で2分で終わります：設定 → 🪪 身分証確認（一番上のカード）。身分証を撮影＋簡単な自撮りで完了 — 承認は早いです。👑
https://slutcamp.app/img/id-verify-announce.png`,
  zh: `欢迎来到 SlutCamp 💋 完成设置的最后一步：验证你的身份证件 — 它能解锁开播和获得报酬。在应用中只需 2 分钟：设置 → 🪪 身份验证（就在顶部的卡片）。拍下你的身份证件 + 一张快速自拍就完成了 — 我们审核很快。👑
https://slutcamp.app/img/id-verify-announce.png`,
  ko: `SlutCamp에 오신 것을 환영합니다 💋 설정을 마치는 마지막 단계: 신분증을 인증하세요 — 라이브와 수익 받기가 잠금 해제됩니다. 앱에서 바로 2분이면 됩니다: 설정 → 🪪 신분증 인증 (맨 위에 있는 카드). 신분증 사진 + 간단한 셀카를 찍으면 완료입니다 — 빠르게 승인합니다. 👑
https://slutcamp.app/img/id-verify-announce.png`,
  it: `Benvenuta su SlutCamp 💋 Un ultimo passo per finire la configurazione: verifica il tuo documento — è ciò che sblocca l'andare live e l'essere pagata. Ci vogliono 2 minuti direttamente nell'app: Impostazioni → 🪪 Verifica documento (la scheda proprio in cima). Scatta una foto del documento + un rapido selfie e hai finito — approviamo in fretta. 👑
https://slutcamp.app/img/id-verify-announce.png`,
  pl: `Witaj w SlutCamp 💋 Ostatni krok, aby dokończyć konfigurację: zweryfikuj swój dokument tożsamości — to on odblokowuje transmisje na żywo i wypłaty. Zajmuje to 2 minuty prosto w aplikacji: Ustawienia → 🪪 Weryfikacja tożsamości (karta na samej górze). Zrób zdjęcie dokumentu + szybkie selfie i gotowe — zatwierdzamy szybko. 👑
https://slutcamp.app/img/id-verify-announce.png`,
  nl: `Welkom bij SlutCamp 💋 Een laatste stap om het instellen af te ronden: verifieer je ID — dat ontgrendelt live gaan en betaald krijgen. Het duurt 2 minuten direct in de app: Instellingen → 🪪 ID-verificatie (de kaart helemaal bovenaan). Maak een foto van je ID + een snelle selfie en je bent klaar — wij keuren snel goed. 👑
https://slutcamp.app/img/id-verify-announce.png`,
  tr: `SlutCamp'e hoş geldin 💋 Kurulumu bitirmek için son bir adım: Kimliğini doğrula — canlıya geçmeyi ve ödeme almayı açan şey bu. Uygulamada 2 dakika sürer: Ayarlar → 🪪 Kimlik Doğrulama (en üstteki kart). Kimliğinin fotoğrafını çek + hızlı bir selfie ve bitti — hızlı onaylarız. 👑
https://slutcamp.app/img/id-verify-announce.png`,
};

function sendModelIdVerify(modelUserId) {
  const m = db.prepare("SELECT id, display_name, language, id_verify_msg_sent_at FROM users WHERE id = ? AND role = 'model'")
    .get(modelUserId);
  if (!m || m.id_verify_msg_sent_at) return false;
  if (!fs.existsSync(ID_VERIFY_IMG_FILE)) return false; // print not shipped yet — stay unstamped
  const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1").get();
  if (!admin || admin.id === m.id) return false;
  let conv = db.prepare('SELECT id FROM conversations WHERE fan_id = ? AND model_id = ?').get(admin.id, m.id);
  if (!conv) {
    const info = db.prepare('INSERT INTO conversations (fan_id, model_id) VALUES (?,?)').run(admin.id, m.id);
    conv = { id: Number(info.lastInsertRowid) };
  }
  const text = MODEL_ID_VERIFY[m.language] || MODEL_ID_VERIFY.en;
  db.prepare('INSERT INTO messages (conversation_id, sender_id, body) VALUES (?,?,?)')
    .run(conv.id, admin.id, text);
  db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?").run(conv.id);
  db.prepare("UPDATE users SET id_verify_msg_sent_at = datetime('now') WHERE id = ?").run(m.id);
  try {
    notifyUser(m.id, 'id_verify', srv('bell_id_verify_title', m.language),
      srv('bell_id_verify_body', m.language), `/#chat/${conv.id}`);
  } catch (e) { /* the bell is a bonus; the message is the deliverable */ }
  return true;
}

/* Boot sweep: only post-deploy signups can be unstamped (see the
   migration pre-stamp), so this delivers the DM to genuinely new
   models whose signup-time send failed — never to existing models. */
function sendPendingModelIdVerifies() {
  if (!fs.existsSync(ID_VERIFY_IMG_FILE)) return; // print not shipped yet
  const rows = db.prepare("SELECT id FROM users WHERE role = 'model' AND id_verify_msg_sent_at IS NULL").all();
  for (const r of rows) { try { sendModelIdVerify(r.id); } catch (e) { /* retry next boot */ } }
}

/* ------------------------------------------------------------------ */
/* Affiliate-program message — the final welcome DM, lands right      */
/* behind the ID-verification DM in the same admin thread.            */
/*                                                                    */
/* How the program really works (surveyed, not invented): recruiting  */
/* runs on a separate 'recruiter' account. Admin issues her a         */
/* one-time affiliate invite (Manager → Invites, role 'recruiter');   */
/* she signs up at /#affiliate/<code>, accepts the recruiter          */
/* agreement, and gets a recruiters row with a personal referral      */
/* code — her recruiting link is /#join/<code>, shown on her          */
/* recruiter dashboard. Models who join through it are attributed to  */
/* her (models.recruiter_id) and she earns 20% — her cut comes out    */
/* of the platform's share; the recruited model keeps her full cut    */
/* (recruiter agreement §4; splitPayment pays recruiters half the     */
/* platform slice). A MODEL account has NO self-serve path to a       */
/* link — so this DM's call-to-action is the real one: reply in this  */
/* thread and admin sets her up. Same newness gate as the ID DM: the  */
/* affiliate_msg_sent_at column is pre-stamped for every account      */
/* that exists when this ships — new signups only, never a blast.     */
/* ------------------------------------------------------------------ */
const AFFILIATE_IMG_FILE = path.join(__dirname, 'public', 'img', 'affiliate-program-announce.png');
const AFFILIATE_IMG_URL = 'https://slutcamp.app/img/affiliate-program-announce.png';
const MODEL_AFFILIATE = {
  en: `💰 One more way to make money here: our affiliate program. Recruit other models onto SlutCamp with your personal link, and you'll make 20% of everything those models make. It's that simple: they earn, you earn. ⏳ This offer is limited — the program won't be around forever, so get set up while it's open. Interested? Reply right here and we'll send your affiliate signup link and set up your personal recruiting link. If you have any questions, let me know. 💋
${AFFILIATE_IMG_URL}`,
  es: `💰 Otra forma de ganar dinero aquí: nuestro programa de afiliadas. Recluta a otras modelos en SlutCamp con tu enlace personal y ganarás el 20% de todo lo que esas modelos ganen. Así de simple: ellas ganan, tú ganas. ⏳ Esta oferta es limitada — el programa no estará disponible para siempre, así que actívalo mientras esté abierto. ¿Te interesa? Responde aquí mismo y te enviamos tu enlace de registro de afiliada y configuramos tu enlace personal de reclutamiento. Si tienes preguntas, avísame. 💋
${AFFILIATE_IMG_URL}`,
  pt: `💰 Outra forma de ganhar dinheiro aqui: nosso programa de afiliadas. Recrute outras modelos para a SlutCamp com seu link pessoal e você ganha 20% de tudo que essas modelos ganharem. É simples assim: elas ganham, você ganha. ⏳ Esta oferta é limitada — o programa não estará disponível para sempre, então garanta o seu enquanto está aberto. Quer participar? Responda aqui mesmo e enviamos seu link de cadastro de afiliada e configuramos seu link pessoal de recrutamento. Se tiver dúvidas, é só me chamar. 💋
${AFFILIATE_IMG_URL}`,
  fr: `💰 Une autre façon de gagner de l'argent ici : notre programme d'affiliation. Recrutez d'autres modèles sur SlutCamp avec votre lien personnel, et vous gagnerez 20% de tout ce que ces modèles gagnent. C'est aussi simple que ça : elles gagnent, vous gagnez. ⏳ Cette offre est limitée — le programme ne durera pas éternellement, alors configurez-vous pendant qu'il est ouvert. Intéressée ? Répondez ici même et nous vous enverrons votre lien d'inscription d'affilié et configurerons votre lien de recrutement personnel. Si vous avez des questions, faites-le-moi savoir. 💋
https://slutcamp.app/img/affiliate-program-announce.png`,
  de: `💰 Noch eine Möglichkeit, hier Geld zu verdienen: unser Affiliate-Programm. Wirb andere Modelle mit deinem persönlichen Link für SlutCamp an, und du verdienst 20% von allem, was diese Modelle verdienen. So einfach ist es: Sie verdienen, du verdienst. ⏳ Dieses Angebot ist begrenzt — das Programm wird nicht für immer da sein, also richte dich ein, solange es offen ist. Interessiert? Antworte hier und wir senden dir deinen Affiliate-Anmeldelink und richten deinen persönlichen Anwerbelink ein. Wenn du Fragen hast, lass es mich wissen. 💋
https://slutcamp.app/img/affiliate-program-announce.png`,
  ru: `💰 Ещё один способ зарабатывать здесь: наша партнёрская программа. Привлекайте других моделей на SlutCamp по вашей личной ссылке, и вы будете зарабатывать 20% от всего, что зарабатывают эти модели. Всё просто: они зарабатывают, вы зарабатываете. ⏳ Это предложение ограничено — программа не будет существовать вечно, поэтому настройтесь, пока она открыта. Интересно? Ответьте прямо здесь, и мы отправим вам ссылку для регистрации партнёра и настроим вашу личную рекрутинговую ссылку. Если у вас есть вопросы, дайте мне знать. 💋
https://slutcamp.app/img/affiliate-program-announce.png`,
  ja: `💰 ここでもう1つ稼ぐ方法：当社のアフィリエイトプログラム。あなた専用のリンクで他のモデルをSlutCampに募集すると、それらのモデルの収益の20%があなたに入ります。シンプルでしょ：彼女たちが稼げば、あなたも稼げます。⏳ このオファーは期間限定です — プログラムはいつまでも続くわけではないので、受付中の今のうちに設定してね。興味ある？ここに返信してくれれば、アフィリエイト登録リンクを送って、あなた専用の募集リンクを設定します。質問があれば教えてね。💋
https://slutcamp.app/img/affiliate-program-announce.png`,
  zh: `💰 在这里赚钱的另一种方式：我们的推广伙伴计划。用你的个人链接招募其他模特加入 SlutCamp，你将获得那些模特全部收入的 20%。就这么简单：她们赚钱，你赚钱。⏳ 此优惠有限 — 该计划不会永远存在，所以趁它开放时赶紧设置。感兴趣？直接在这里回复，我们会发送你的推广伙伴注册链接，并为你设置个人招募链接。如有任何问题，请告诉我。💋
https://slutcamp.app/img/affiliate-program-announce.png`,
  ko: `💰 여기서 돈을 버는 또 다른 방법: 제휴 프로그램입니다. 개인 링크로 다른 모델들을 SlutCamp에 모집하면, 그 모델들이 버는 모든 수익의 20%를 받게 됩니다. 그만큼 간단합니다: 그들이 벌면, 나도 법니다. ⏳ 이 기회는 기간 한정입니다 — 프로그램이 영원히 열려 있지 않으니, 열려 있을 때 설정하세요. 관심이 있으신가요? 바로 여기에 답장하시면 제휴 가입 링크를 보내드리고 개인 모집 링크를 설정해 드립니다. 궁금한 점이 있으면 알려주세요. 💋
https://slutcamp.app/img/affiliate-program-announce.png`,
  it: `💰 Un altro modo per guadagnare qui: il nostro programma affiliati. Recluta altre modelle su SlutCamp con il tuo link personale, e guadagnerai il 20% di tutto ciò che quelle modelle guadagnano. È semplicissimo: loro guadagnano, tu guadagni. ⏳ Questa offerta è limitata — il programma non ci sarà per sempre, quindi configurati finché è aperto. Interessata? Rispondi qui e ti manderemo il tuo link di registrazione affiliata e configureremo il tuo link personale di reclutamento. Se hai domande, fammelo sapere. 💋
https://slutcamp.app/img/affiliate-program-announce.png`,
  pl: `💰 Jeszcze jeden sposób na zarabianie tutaj: nasz program afiliacyjny. Rekrutuj inne modelki do SlutCamp za pomocą swojego osobistego linku, a zarobisz 20% wszystkiego, co te modelki zarobią. To takie proste: one zarabiają, Ty zarabiasz. ⏳ Ta oferta jest ograniczona — program nie będzie dostępny na zawsze, więc skonfiguruj się, póki jest otwarty. Zainteresowana? Odpowiedz tutaj, a wyślemy Ci link do rejestracji afiliacyjnej i skonfigurujemy Twój osobisty link rekrutacyjny. Jeśli masz pytania, daj mi znać. 💋
https://slutcamp.app/img/affiliate-program-announce.png`,
  nl: `💰 Nog een manier om hier geld te verdienen: ons affiliate-programma. Werf andere modellen naar SlutCamp met je persoonlijke link, en je verdient 20% van alles wat die modellen maken. Zo simpel is het: zij verdienen, jij verdient. ⏳ Dit aanbod is beperkt — het programma blijft niet voor altijd bestaan, dus stel het in terwijl het open is. Geïnteresseerd? Antwoord gewoon hier en we sturen je affiliate-aanmeldlink en stellen je persoonlijke werflink in. Als je vragen hebt, laat het me weten. 💋
https://slutcamp.app/img/affiliate-program-announce.png`,
  tr: `💰 Burada para kazanmanın bir yolu daha: ortaklık programımız. Kişisel bağlantınla SlutCamp'e başka modeller getir, o modellerin kazandığı her şeyin %20'sini kazanırsın. Bu kadar basit: onlar kazanır, sen kazanırsın. ⏳ Bu teklif sınırlı — program sonsuza dek burada olmayacak, açıkken kurulumunu yap. İlgileniyor musun? Buraya yanıt ver, sana ortaklık kayıt bağlantını gönderelim ve kişisel işe alım bağlantını kuralım. Soruların varsa bana bildir. 💋
https://slutcamp.app/img/affiliate-program-announce.png`,
};

function sendModelAffiliate(modelUserId) {
  const m = db.prepare("SELECT id, display_name, language, affiliate_msg_sent_at FROM users WHERE id = ? AND role = 'model'")
    .get(modelUserId);
  if (!m || m.affiliate_msg_sent_at) return false;
  if (!fs.existsSync(AFFILIATE_IMG_FILE)) return false; // print not shipped yet — stay unstamped
  const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1").get();
  if (!admin || admin.id === m.id) return false;
  let conv = db.prepare('SELECT id FROM conversations WHERE fan_id = ? AND model_id = ?').get(admin.id, m.id);
  if (!conv) {
    const info = db.prepare('INSERT INTO conversations (fan_id, model_id) VALUES (?,?)').run(admin.id, m.id);
    conv = { id: Number(info.lastInsertRowid) };
  }
  const text = MODEL_AFFILIATE[m.language] || MODEL_AFFILIATE.en;
  db.prepare('INSERT INTO messages (conversation_id, sender_id, body) VALUES (?,?,?)')
    .run(conv.id, admin.id, text);
  db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?").run(conv.id);
  db.prepare("UPDATE users SET affiliate_msg_sent_at = datetime('now') WHERE id = ?").run(m.id);
  try {
    notifyUser(m.id, 'affiliate_program', srv('bell_affiliate_title', m.language),
      srv('bell_affiliate_body', m.language), `/#chat/${conv.id}`);
  } catch (e) { /* the bell is a bonus; the message is the deliverable */ }
  return true;
}

/* Boot sweep: only post-deploy signups can be unstamped (migration
   pre-stamp), so this only ever retries genuinely new models. */
function sendPendingModelAffiliates() {
  if (!fs.existsSync(AFFILIATE_IMG_FILE)) return; // print not shipped yet
  const rows = db.prepare("SELECT id FROM users WHERE role = 'model' AND affiliate_msg_sent_at IS NULL").all();
  for (const r of rows) { try { sendModelAffiliate(r.id); } catch (e) { /* retry next boot */ } }
}

/* ------------------------------------------------------------------ */
/* Game Category launch announcement — ONE-TIME broadcast to every    */
/* model, same admin-thread DM pattern as the guide/ATH videos. The   */
/* stamp lives on platform_stats (game_category_announced_at): once   */
/* set, no boot ever sends it again. Models who sign up later don't   */
/* get it (their welcome flow covers features); every model who       */
/* exists at launch gets exactly one copy.                            */
/* ------------------------------------------------------------------ */
const GAME_CATEGORY_ANNOUNCE_TEXT = "🎲 NEW UPDATE: Game Category is here! On your live, fans can now tap Game Category and buy requests from YOUR list — your items, your prices, and his name + his request splash across your screen. Build your list in your live controls (ready-made ideas are already loaded — make them yours), and flip the game ON when you're ready. The Specials shelf holds your rare treats: you decide when they're available 💋 How it works: https://slutcamp.app/img/game-category-announce.png";

function announceGameCategoryToModels() {
  const st = db.prepare('SELECT game_category_announced_at FROM platform_stats WHERE id = 1').get();
  if (!st || st.game_category_announced_at) return 0;
  const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1").get();
  if (!admin) return 0;
  const models = db.prepare("SELECT id FROM users WHERE role = 'model' AND banned = 0").all();
  let sent = 0;
  for (const m of models) {
    if (m.id === admin.id) continue;
    try {
      let conv = db.prepare('SELECT id FROM conversations WHERE fan_id = ? AND model_id = ?').get(admin.id, m.id);
      if (!conv) {
        const info = db.prepare('INSERT INTO conversations (fan_id, model_id) VALUES (?,?)').run(admin.id, m.id);
        conv = { id: Number(info.lastInsertRowid) };
      }
      db.prepare('INSERT INTO messages (conversation_id, sender_id, body) VALUES (?,?,?)')
        .run(conv.id, admin.id, GAME_CATEGORY_ANNOUNCE_TEXT);
      db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?").run(conv.id);
      try {
        notifyUser(m.id, 'game_category', '🎲 NEW UPDATE: Game Category is here!',
          'Fans can now buy requests from YOUR list on live — build it in your live controls 💋', `/#chat/${conv.id}`);
      } catch (e) { /* the bell is a bonus; the message is the deliverable */ }
      sent++;
    } catch (e) { /* one bad thread must not block the rest — flag stays unset only if ALL fail */ }
  }
  if (sent > 0 || models.length === 0) {
    db.prepare("UPDATE platform_stats SET game_category_announced_at = datetime('now') WHERE id = 1").run();
  }
  return sent;
}

/* ------------------------------------------------------------------ */
/* Model agreement v1.2 — ONE-TIME broadcast to every model, same     */
/* admin-thread DM pattern + flag discipline as the Game Category     */
/* announcement (agreement_12_announced_at on platform_stats). Every  */
/* existing model must re-sign: the version-aware contract status     */
/* locks 1.1 signers to the signing screen until they sign 1.2.        */
/* ------------------------------------------------------------------ */
const AGREEMENT_12_ANNOUNCE_TEXT = "📄 New model agreement — please read & sign. We added the 1-on-1 booking + FaceTime waiting-list rules (booking reminders, the 5-minute start window, fan no-shows paying out to you) as agreement v1.2. Open the app and tap to read and sign — it takes 20 seconds. Until you sign, going live and earning stay paused. 💋";

function announceAgreement12ToModels() {
  const st = db.prepare('SELECT agreement_12_announced_at FROM platform_stats WHERE id = 1').get();
  if (!st || st.agreement_12_announced_at) return 0;
  const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1").get();
  if (!admin) return 0;
  const models = db.prepare("SELECT id FROM users WHERE role = 'model' AND banned = 0").all();
  let sent = 0;
  for (const m of models) {
    if (m.id === admin.id) continue;
    try {
      let conv = db.prepare('SELECT id FROM conversations WHERE fan_id = ? AND model_id = ?').get(admin.id, m.id);
      if (!conv) {
        const info = db.prepare('INSERT INTO conversations (fan_id, model_id) VALUES (?,?)').run(admin.id, m.id);
        conv = { id: Number(info.lastInsertRowid) };
      }
      db.prepare('INSERT INTO messages (conversation_id, sender_id, body) VALUES (?,?,?)')
        .run(conv.id, admin.id, AGREEMENT_12_ANNOUNCE_TEXT);
      db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?").run(conv.id);
      try {
        notifyUser(m.id, 'agreement_12', '📄 New model agreement — please read & sign',
          'Agreement v1.2 is ready — open the app to read and sign 💋', `/#chat/${conv.id}`);
      } catch (e) { /* the bell is a bonus; the message is the deliverable */ }
      sent++;
    } catch (e) { /* one bad thread must not block the rest */ }
  }
  if (sent > 0 || models.length === 0) {
    db.prepare("UPDATE platform_stats SET agreement_12_announced_at = datetime('now') WHERE id = 1").run();
  }
  return sent;
}

/* ------------------------------------------------------------------ */
/* Public model pages on Google — ONE-TIME broadcast to every model,  */
/* same admin-thread DM pattern + flag discipline as the Game         */
/* Category announcement (public_photo_announced_at on platform_      */
/* stats). The SEO pages (PR #25) put every public model on Google    */
/* with a CLEAN public photo (models.public_photo_url) — her in-app   */
/* storefront pic is never used there; until she sets a public photo  */
/* her page shows the SlutCamp logo. The link is personalised with    */
/* her username. Models who sign up later don't get this one (their   */
/* Settings carry the same label/explainer).                          */
/* ------------------------------------------------------------------ */
function publicPhotoAnnounceText(username) {
  return `📸 NEW UPDATE: You're live on Google! Your public SlutCamp page is up — fans who search your name can now find you at https://slutcamp.app/models/${username}. That page shows the world a CLEAN photo of you — it never uses your in-app profile pic, so that one can stay exactly as wild as you like. To set yours: open the app → Settings → My Photo → Public photo, and upload a clean photo (clothes on). Until you do, your page will show the SlutCamp logo instead of your face — and a face is what gets clicked 💋`;
}

function announcePublicPhotoToModels() {
  const st = db.prepare('SELECT public_photo_announced_at FROM platform_stats WHERE id = 1').get();
  if (!st || st.public_photo_announced_at) return 0;
  const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1").get();
  if (!admin) return 0;
  const models = db.prepare("SELECT id, username FROM users WHERE role = 'model' AND banned = 0").all();
  let sent = 0;
  for (const m of models) {
    if (m.id === admin.id) continue;
    try {
      let conv = db.prepare('SELECT id FROM conversations WHERE fan_id = ? AND model_id = ?').get(admin.id, m.id);
      if (!conv) {
        const info = db.prepare('INSERT INTO conversations (fan_id, model_id) VALUES (?,?)').run(admin.id, m.id);
        conv = { id: Number(info.lastInsertRowid) };
      }
      db.prepare('INSERT INTO messages (conversation_id, sender_id, body) VALUES (?,?,?)')
        .run(conv.id, admin.id, publicPhotoAnnounceText(m.username));
      db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?").run(conv.id);
      try {
        notifyUser(m.id, 'public_photo', "📸 NEW UPDATE: You're live on Google!",
          'Set your clean public photo — Settings → My Photo → Public photo 💋', `/#chat/${conv.id}`);
      } catch (e) { /* the bell is a bonus; the message is the deliverable */ }
      sent++;
    } catch (e) { /* one bad thread must not block the rest */ }
  }
  if (sent > 0 || models.length === 0) {
    db.prepare("UPDATE platform_stats SET public_photo_announced_at = datetime('now') WHERE id = 1").run();
  }
  return sent;
}

/* ------------------------------------------------------------------ */
/* Notification-tap fix — ONE-TIME broadcast to every model, same     */
/* admin-thread DM + stamp pattern as the broadcasts above            */
/* (notif_fix_announced_at on platform_stats). Tapping a bell used    */
/* to just re-render the list ("glitched", owner report Oct 17,       */
/* 2026); bells now route to their screen. Owner's standing rule:     */
/* every update gets a message to the girls.                          */
/* ------------------------------------------------------------------ */
function announceNotifFixToModels() {
  const st = db.prepare('SELECT notif_fix_announced_at FROM platform_stats WHERE id = 1').get();
  if (!st || st.notif_fix_announced_at) return 0;
  const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1").get();
  if (!admin) return 0;
  const models = db.prepare("SELECT id, username FROM users WHERE role = 'model' AND banned = 0").all();
  let sent = 0;
  for (const m of models) {
    if (m.id === admin.id) continue;
    try {
      let conv = db.prepare('SELECT id FROM conversations WHERE fan_id = ? AND model_id = ?').get(admin.id, m.id);
      if (!conv) {
        const info = db.prepare('INSERT INTO conversations (fan_id, model_id) VALUES (?,?)').run(admin.id, m.id);
        conv = { id: Number(info.lastInsertRowid) };
      }
      db.prepare('INSERT INTO messages (conversation_id, sender_id, body) VALUES (?,?,?)')
        .run(conv.id, admin.id, `🔔 FIXED: Your notifications open now! Tapping a notification used to just flicker — now it takes you straight there: messages open the chat, bookings open your bookings, tips open your earnings, FaceTime requests open the request. Try it — tap that bell 💋`);
      db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?").run(conv.id);
      try {
        notifyUser(m.id, 'notif_fix', '🔔 FIXED: Your notifications open now!',
          'Tap a notification — it takes you straight to the message, booking or request 💋', `/#chat/${conv.id}`);
      } catch (e) { /* the bell is a bonus; the message is the deliverable */ }
      sent++;
    } catch (e) { /* one bad thread must not block the rest */ }
  }
  if (sent > 0 || models.length === 0) {
    db.prepare("UPDATE platform_stats SET notif_fix_announced_at = datetime('now') WHERE id = 1").run();
  }
  return sent;
}

/* ------------------------------------------------------------------ */
/* Preview video on her profile — ONE-TIME broadcast to every model,  */
/* same admin-thread DM + stamp pattern as the broadcasts above       */
/* (preview_video_announced_at on platform_stats). Her preview video  */
/* already looped on home tiles; it now also plays as the hero of her */
/* profile peek (tap = sound on). Settings no longer says SFW — the   */
/* clip is her free in-app hook, explicit allowed, never public.      */
/* Owner's standing rule: every update gets a message to the girls.   */
/* ------------------------------------------------------------------ */
function announcePreviewVideoToModels() {
  const st = db.prepare('SELECT preview_video_announced_at FROM platform_stats WHERE id = 1').get();
  if (!st || st.preview_video_announced_at) return 0;
  const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1").get();
  if (!admin) return 0;
  const models = db.prepare("SELECT id, username FROM users WHERE role = 'model' AND banned = 0").all();
  let sent = 0;
  for (const m of models) {
    if (m.id === admin.id) continue;
    try {
      let conv = db.prepare('SELECT id FROM conversations WHERE fan_id = ? AND model_id = ?').get(admin.id, m.id);
      if (!conv) {
        const info = db.prepare('INSERT INTO conversations (fan_id, model_id) VALUES (?,?)').run(admin.id, m.id);
        conv = { id: Number(info.lastInsertRowid) };
      }
      db.prepare('INSERT INTO messages (conversation_id, sender_id, body) VALUES (?,?,?)')
        .run(conv.id, admin.id, `🎬 NEW UPDATE: Your preview video now plays on your profile! Fans who open your profile see it playing — they tap it and hear you too. Make it your hook: a few seconds, as wild as you like, it's free to watch and everything after it stays paid. Add yours: Settings → Preview video 💋`);
      db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?").run(conv.id);
      try {
        notifyUser(m.id, 'preview_video', '🎬 NEW UPDATE: Your preview video now plays on your profile!',
          'Fans see it on your profile — tap it and they hear you too. Add yours in Settings 💋', `/#chat/${conv.id}`);
      } catch (e) { /* the bell is a bonus; the message is the deliverable */ }
      sent++;
    } catch (e) { /* one bad thread must not block the rest */ }
  }
  if (sent > 0 || models.length === 0) {
    db.prepare("UPDATE platform_stats SET preview_video_announced_at = datetime('now') WHERE id = 1").run();
  }
  return sent;
}

/* ------------------------------------------------------------------ */
/* Profile media expansion — ONE-TIME broadcast to every model,      */
/* same admin-thread DM + stamp pattern as the broadcasts above       */
/* (profile_media_announced_at on platform_stats), copy localized    */
/* per model via the SRV table (the languages-broadcast pattern).     */
/* Her profile page now holds up to 10 pictures and TWO main videos;  */
/* the owner's standing rule: every update gets a message to the      */
/* girls.                                                             */
/* ------------------------------------------------------------------ */
function announceProfileMediaToModels() {
  const st = db.prepare('SELECT profile_media_announced_at FROM platform_stats WHERE id = 1').get();
  if (!st || st.profile_media_announced_at) return 0;
  const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1").get();
  if (!admin) return 0;
  const models = db.prepare("SELECT id, username, language FROM users WHERE role = 'model' AND banned = 0").all();
  let sent = 0;
  for (const m of models) {
    if (m.id === admin.id) continue;
    try {
      let conv = db.prepare('SELECT id FROM conversations WHERE fan_id = ? AND model_id = ?').get(admin.id, m.id);
      if (!conv) {
        const info = db.prepare('INSERT INTO conversations (fan_id, model_id) VALUES (?,?)').run(admin.id, m.id);
        conv = { id: Number(info.lastInsertRowid) };
      }
      db.prepare('INSERT INTO messages (conversation_id, sender_id, body) VALUES (?,?,?)')
        .run(conv.id, admin.id, srv('ann_profile_media_dm', m.language));
      db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?").run(conv.id);
      try {
        notifyUser(m.id, 'profile_media', srv('ann_profile_media_bell_title', m.language),
          srv('ann_profile_media_bell_body', m.language), `/#chat/${conv.id}`);
      } catch (e) { /* the bell is a bonus; the message is the deliverable */ }
      sent++;
    } catch (e) { /* one bad thread must not block the rest */ }
  }
  if (sent > 0 || models.length === 0) {
    db.prepare("UPDATE platform_stats SET profile_media_announced_at = datetime('now') WHERE id = 1").run();
  }
  return sent;
}

/* ------------------------------------------------------------------ */
/* One-tap thread routing — ONE-TIME broadcast to every model, same   */
/* admin-thread DM + stamp pattern as the broadcasts above            */
/* (thread_tap_announced_at on platform_stats). PR #33 made bell taps */
/* open the message itself; this is that update's message to the      */
/* girls (owner's standing rule). The bell itself carries the new     */
/* /#chat/<convId> link, so tapping it demonstrates the feature.      */
/* ------------------------------------------------------------------ */
function announceThreadTapToModels() {
  const st = db.prepare('SELECT thread_tap_announced_at FROM platform_stats WHERE id = 1').get();
  if (!st || st.thread_tap_announced_at) return 0;
  const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1").get();
  if (!admin) return 0;
  const models = db.prepare("SELECT id, username FROM users WHERE role = 'model' AND banned = 0").all();
  let sent = 0;
  for (const m of models) {
    if (m.id === admin.id) continue;
    try {
      let conv = db.prepare('SELECT id FROM conversations WHERE fan_id = ? AND model_id = ?').get(admin.id, m.id);
      if (!conv) {
        const info = db.prepare('INSERT INTO conversations (fan_id, model_id) VALUES (?,?)').run(admin.id, m.id);
        conv = { id: Number(info.lastInsertRowid) };
      }
      db.prepare('INSERT INTO messages (conversation_id, sender_id, body) VALUES (?,?,?)')
        .run(conv.id, admin.id, `👆 UPDATE: One tap, straight to the message! Now when you tap a notification, it opens the message itself — no more landing on the list first. Messages, announcements, everything from us opens right up. Simple and easy 💋`);
      db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?").run(conv.id);
      try {
        notifyUser(m.id, 'thread_tap', '👆 UPDATE: One tap, straight to the message!',
          'Tap a notification — it opens the message itself now. One tap, straight in 💋', `/#chat/${conv.id}`);
      } catch (e) { /* the bell is a bonus; the message is the deliverable */ }
      sent++;
    } catch (e) { /* one bad thread must not block the rest */ }
  }
  if (sent > 0 || models.length === 0) {
    db.prepare("UPDATE platform_stats SET thread_tap_announced_at = datetime('now') WHERE id = 1").run();
  }
  return sent;
}

/* ------------------------------------------------------------------ */
/* Fan blast — ONE-TIME bell + Web Push to every fan (stamp           */
/* fan_preview_announced_at on platform_stats). Fans have no email or */
/* text channel today (no provider; users held no contact info until  */
/* the optional email opt-in shipped alongside this), so notifyUser — */
/* bell row + push — is the entire fan channel. First use: profile    */
/* preview videos are live, and notifications open straight to the    */
/* message. No admin DM: fans have no standing broadcast thread.      */
/* ------------------------------------------------------------------ */
function announceFanPreviewToFans() {
  const st = db.prepare('SELECT fan_preview_announced_at FROM platform_stats WHERE id = 1').get();
  if (!st || st.fan_preview_announced_at) return 0;
  const fans = db.prepare("SELECT id FROM users WHERE role = 'fan' AND banned = 0").all();
  let sent = 0;
  for (const f of fans) {
    try {
      notifyUser(f.id, 'fan_news', '🎬 NEW: Her profile video plays now!',
        "Tap any girl's profile — her preview video plays right there. Tap the video for sound 🔊 And your notifications now open straight to the message. Come see who's new 💋", '');
      sent++;
    } catch (e) { /* one bad fan must not block the rest */ }
  }
  if (sent > 0 || fans.length === 0) {
    db.prepare("UPDATE platform_stats SET fan_preview_announced_at = datetime('now') WHERE id = 1").run();
  }
  return sent;
}

/* ------------------------------------------------------------------ */
/* 13-languages announcement — ONE-TIME broadcasts (stamps            */
/* languages_announced_at / fan_languages_announced_at). Each         */
/* recipient gets the copy in HER stored language via the SRV table.  */
/* ------------------------------------------------------------------ */
function announceLanguagesToModels() {
  const st = db.prepare('SELECT languages_announced_at FROM platform_stats WHERE id = 1').get();
  if (!st || st.languages_announced_at) return 0;
  const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1").get();
  if (!admin) return 0;
  const models = db.prepare("SELECT id, username, language FROM users WHERE role = 'model' AND banned = 0").all();
  let sent = 0;
  for (const m of models) {
    if (m.id === admin.id) continue;
    try {
      let conv = db.prepare('SELECT id FROM conversations WHERE fan_id = ? AND model_id = ?').get(admin.id, m.id);
      if (!conv) {
        const info = db.prepare('INSERT INTO conversations (fan_id, model_id) VALUES (?,?)').run(admin.id, m.id);
        conv = { id: Number(info.lastInsertRowid) };
      }
      db.prepare('INSERT INTO messages (conversation_id, sender_id, body) VALUES (?,?,?)')
        .run(conv.id, admin.id, srv('ann_lang_dm', m.language));
      db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?").run(conv.id);
      try {
        notifyUser(m.id, 'languages', srv('ann_lang_bell_title', m.language),
          srv('ann_lang_bell_body', m.language), `/#chat/${conv.id}`);
      } catch (e) { /* the bell is a bonus; the message is the deliverable */ }
      sent++;
    } catch (e) { /* one bad thread must not block the rest */ }
  }
  if (sent > 0 || models.length === 0) {
    db.prepare("UPDATE platform_stats SET languages_announced_at = datetime('now') WHERE id = 1").run();
  }
  return sent;
}

function announceLanguagesToFans() {
  const st = db.prepare('SELECT fan_languages_announced_at FROM platform_stats WHERE id = 1').get();
  if (!st || st.fan_languages_announced_at) return 0;
  const fans = db.prepare("SELECT id, language FROM users WHERE role = 'fan' AND banned = 0").all();
  let sent = 0;
  for (const f of fans) {
    try {
      notifyUser(f.id, 'fan_languages', srv('ann_lang_fan_title', f.language),
        srv('ann_lang_fan_body', f.language), '');
      sent++;
    } catch (e) { /* one bad fan must not block the rest */ }
  }
  if (sent > 0 || fans.length === 0) {
    db.prepare("UPDATE platform_stats SET fan_languages_announced_at = datetime('now') WHERE id = 1").run();
  }
  return sent;
}

/* ------------------------------------------------------------------ */
/* Suggestion Box announcement — ONE-TIME bell + Web Push to every    */
/* fan (stamp suggestion_box_announced_at on platform_stats, set      */
/* BEFORE sending so a mid-send crash can never double-blast). Each   */
/* fan gets the copy in his stored language via the SRV table. No     */
/* admin DM: fans have no standing broadcast thread (same fan channel */
/* rule as the preview blast).                                        */
/* ------------------------------------------------------------------ */
function announceSuggestionBoxToFans() {
  const st = db.prepare('SELECT suggestion_box_announced_at FROM platform_stats WHERE id = 1').get();
  if (!st || st.suggestion_box_announced_at) return 0;
  const fans = db.prepare("SELECT id, language FROM users WHERE role = 'fan' AND banned = 0").all();
  db.prepare("UPDATE platform_stats SET suggestion_box_announced_at = datetime('now') WHERE id = 1").run();
  let sent = 0;
  for (const f of fans) {
    try {
      notifyUser(f.id, 'suggestion_box', srv('ann_suggest_title', f.language),
        srv('ann_suggest_body', f.language), '');
      sent++;
    } catch (e) { /* one bad fan must not block the rest */ }
  }
  return sent;
}

function seed() {
  // Demo accounts are DEV-ONLY and strictly opt-in (SEED_DEMO=1). A seeded
  // fan carries $100 of test credits and every seeded password is printed
  // in the README, so a production boot must never create them by default.
  if (process.env.SEED_DEMO !== '1') return;
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (count > 0) return;

  createUser('admin', 'admin123', 'admin', 'Asce (Admin)', '1990-01-01');

  const bunnyId = createUser('bunny', 'model123', 'model', 'Bunny', '1998-05-14');
  db.prepare(`UPDATE models SET bio = ?, per_message_cents = 149,
              per_minute_cents = 399, is_online = 1 WHERE user_id = ?`)
    .run(`Heyy I'm Bunny 🐰 Your playful cosplay girl. First 3 messages are FREE — come say hi! 😈`, bunnyId);

  const staceyId = createUser('stacey', 'model123', 'model', 'Stacey', '1997-09-02');
  db.prepare(`UPDATE models SET bio = ?, per_message_cents = 149,
              per_minute_cents = 399, is_online = 1 WHERE user_id = ?`)
    .run(`Stacey here 💋 Sweet with a wild side. First 3 messages FREE!`, staceyId);

  const bellaId = createUser('bella', 'model123', 'model', 'Bella Red', '1999-02-20');
  db.prepare(`UPDATE models SET bio = ?, per_message_cents = 149,
              per_minute_cents = 399, is_online = 0 WHERE user_id = ?`)
    .run(`Bella Red 🌹 Ebony goddess. Premium attention for premium fans. First 3 messages FREE.`, bellaId);

  const fanId = createUser('fandemo', 'fan123', 'fan', 'Demo Fan', '1995-07-07');
  db.prepare('UPDATE wallets SET credits_cents = 10000 WHERE user_id = ?').run(fanId); // $100

  // Sample conversation so demo accounts see the chat UI immediately
  const conv = db.prepare('INSERT INTO conversations (fan_id, model_id) VALUES (?,?)')
    .run(fanId, bunnyId).lastInsertRowid;
  const seedMsg = db.prepare(
    'INSERT INTO messages (conversation_id, sender_id, body, cost_cents, is_read) VALUES (?,?,?,?,?)');
  seedMsg.run(conv, bunnyId, 'Heyy! Thanks for stopping by 💋 Your first 3 messages are FREE — say hi!', 0, 1);

  console.log('Seeded: admin/admin123 · bunny|stacey|bella/model123 · fandemo/fan123 ($100)');
}
seed();
sendPendingModelWelcomes();
sendPendingModelGuides();
sendPendingModelGuideVideos();
sendPendingModelHomeScreenVideos();
sendPendingModelIdVerifies();
sendPendingModelAffiliates();
try { const n = announceGameCategoryToModels(); if (n) console.log(`[game] Category announcement sent to ${n} models.`); } catch (e) { /* retry next boot */ }
try { const n = announceAgreement12ToModels(); if (n) console.log(`[contract] Agreement v1.2 announcement sent to ${n} models.`); } catch (e) { /* retry next boot */ }
try { const n = announcePublicPhotoToModels(); if (n) console.log(`[seo] Public-photo announcement sent to ${n} models.`); } catch (e) { /* retry next boot */ }
try { const n = announceNotifFixToModels(); if (n) console.log(`[notif] Notification-fix announcement sent to ${n} models.`); } catch (e) { /* retry next boot */ }
try { const n = announcePreviewVideoToModels(); if (n) console.log(`[preview] Preview-video announcement sent to ${n} models.`); } catch (e) { /* retry next boot */ }
try { const n = announceProfileMediaToModels(); if (n) console.log(`[profilemedia] Profile-media announcement sent to ${n} models.`); } catch (e) { /* retry next boot */ }
try { const n = announceThreadTapToModels(); if (n) console.log(`[threadtap] Thread-tap announcement sent to ${n} models.`); } catch (e) { /* retry next boot */ }
try { const n = announceFanPreviewToFans(); if (n) console.log(`[fanblast] Fan preview blast sent to ${n} fans.`); } catch (e) { /* retry next boot */ }
try { const n = announceLanguagesToModels(); if (n) console.log(`[lang] Languages announcement sent to ${n} models.`); } catch (e) { /* retry next boot */ }
try { const n = announceLanguagesToFans(); if (n) console.log(`[fanlang] Languages blast sent to ${n} fans.`); } catch (e) { /* retry next boot */ }
try { const n = announceSuggestionBoxToFans(); if (n) console.log(`[suggest] Suggestion box announcement sent to ${n} fans.`); } catch (e) { /* retry next boot */ }

// One-time grandfathering for payout protection (Oct 16, 2026): every
// earning recorded BEFORE this feature existed counts as fully matured —
// its available_at becomes its own earn date, so no existing balance is
// ever trapped by the new hold window. Runs exactly once (marker on
// platform_stats.payout_protection_at).
(function grandfatherEarningsOnce() {
  try {
    const row = db.prepare('SELECT payout_protection_at FROM platform_stats WHERE id = 1').get();
    if (!row || row.payout_protection_at) return;
    db.prepare('UPDATE transactions SET available_at = created_at WHERE available_at IS NULL').run();
    db.prepare("UPDATE platform_stats SET payout_protection_at = datetime('now') WHERE id = 1").run();
    console.log('[payout] Existing earnings grandfathered as matured (payout protection live).');
  } catch (e) { console.log('[payout] grandfathering failed:', e.message); }
})();

// One-time pre-launch cleanup (Corry, Oct 12 2026): every cent on the
// platform so far is TEST money — demo credits only, no real payment has
// ever been processed. Clear model/recruiter balances so nobody mistakes
// demo earnings for money actually owed. NOTHING is deleted: transactions
// stay on the ledger flagged is_test=1, and money displays exclude test
// rows from here on. Runs exactly once (marker on platform_stats).
(function clearTestMoneyOnce() {
  try {
    const row = db.prepare('SELECT test_money_cleared_at FROM platform_stats WHERE id = 1').get();
    if (!row || row.test_money_cleared_at) return;
    db.prepare('UPDATE transactions SET is_test = 1 WHERE is_test = 0').run();
    db.prepare(`UPDATE wallets SET earnings_cents = 0, paid_out_cents = 0
                WHERE user_id IN (SELECT id FROM users WHERE role IN ('model','recruiter'))`).run();
    db.prepare('UPDATE platform_stats SET earnings_cents = 0 WHERE id = 1').run();
    db.prepare(`UPDATE withdrawals SET status = 'rejected', decided_at = datetime('now'),
                note = 'Pre-launch test balance cleared' WHERE status = 'pending'`).run();
    db.prepare("UPDATE platform_stats SET test_money_cleared_at = datetime('now') WHERE id = 1").run();
    console.log('[cleanup] Pre-launch test money cleared (transactions flagged is_test, balances zeroed).');
  } catch (e) { console.log('[cleanup] test money clear failed:', e.message); }
})();

// One-time correction (Asce, Oct 16 2026): the canonical split has always
// been 60/40 — model keeps 60%, platform keeps 40%. Early defaults shipped
// the wrong platform cut, and a schema default never updates existing DBs
// (INSERT OR IGNORE). Force existing rows to 40 exactly once (marker on
// platform_stats); afterwards the Manager setting stays admin-adjustable.
(function fixCommission6040Once() {
  try {
    const row = db.prepare('SELECT commission_60_40_fixed_at FROM platform_stats WHERE id = 1').get();
    if (!row || row.commission_60_40_fixed_at) return;
    db.prepare('UPDATE platform_stats SET commission_pct = 40 WHERE id = 1').run();
    db.prepare("UPDATE platform_stats SET commission_60_40_fixed_at = datetime('now') WHERE id = 1").run();
    console.log('[commission] Canonical 60/40 split applied (platform commission set to 40%).');
  } catch (e) { console.log('[commission] 60/40 correction failed:', e.message); }
})();

/* One-time pre-launch purge (Asce, Oct 16 2026): delete the demo seed
   MODEL accounts and every trace of their fake money. seed() only ever
   created five accounts — admin + bunny/stacey/bella + fandemo — but
   only the three models are purge targets. Two accounts are NEVER
   purge targets: the admin (the owner's Manager login — deleting it
   would lock him out; its password state is audited in the log below
   instead) and fandemo (the owner's own test account — "that's how I
   run tests on the app", owner decision Oct 16 2026 — so fandemo's
   account and its $100 of test credits stay exactly as they are).
   A target is purged ONLY on a THREE-PART key, all three required:
   (1) username matches a seed name (the column is COLLATE NOCASE, so
   'Bunny' matches 'bunny'), (2) role matches the seed role, and
   (3) PASSWORD FINGERPRINT: the stored hash still verifies against
   the seed's default password ('model123') via bcrypt.compareSync —
   the same technique the admin audit below uses. The fingerprint is
   the load-bearing check: name + role are NOT proof an account is a
   seed — in the live DB the original seeds were removed long ago and
   a REAL model has since registered the name "Bunny" (real photo,
   real sales). Her password is not the seed default, so she is
   skipped with a loud log line and left completely untouched; only
   an account still running the README-public seed password can be a
   seed (or indistinguishable from one). On top of the key sits a
   hard PICTURES GUARD (owner rule): any candidate that owns uploaded
   media (media_items.sender_id) or has a profile photo set
   (models.photo_url) is skipped outright — a seed never uploaded
   anything, so pictures mean a real person joined. And a hard
   ID-VERIFICATION GUARD (owner rule): a candidate whose
   id_verifications row is 'approved' is skipped outright — the
   seeds were never ID-verified, and an approved check is conclusive
   proof of a real person. ALL guards (role, pictures, ID-verified,
   password fingerprint) are evaluated for every candidate and every
   trip is logged, so a real account stays protected even when one
   of the other checks would have passed it; the purge fires only
   when NO guard trips. The purge never scans by balance and never
   touches a non-seed user. Dependent rows are
   swept by enumerating the LIVE schema (declared FKs UNION legacy
   user columns — the technique the admin model-delete uses), money
   tables INCLUDED this time: a seed account's ledger rows and wallet
   are fake money and go with the account. Runs exactly once (marker:
   platform_stats.demo_purge_at); skipped entirely while SEED_DEMO=1
   (a dev box that opted into demos keeps them, marker unstamped). */
(function purgeDemoSeedsOnce() {
  try {
    if (process.env.SEED_DEMO === '1') return;
    const row = db.prepare('SELECT demo_purge_at FROM platform_stats WHERE id = 1').get();
    if (!row || row.demo_purge_at) return;
    const SEEDS = [
      { username: 'bunny', role: 'model', seedPassword: 'model123' },
      { username: 'stacey', role: 'model', seedPassword: 'model123' },
      { username: 'bella', role: 'model', seedPassword: 'model123' },
    ];
    const tableExists = (t) => !!db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(t);
    // Every (table, column) in the live schema that can point at a user.
    const pairs = new Map();
    const allTables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'users'"
    ).all().map((r) => r.name);
    for (const t of allTables) {
      for (const fk of db.prepare(`PRAGMA foreign_key_list(${t})`).all())
        if (fk.table === 'users') pairs.set(`${t}.${fk.from}`, { t, c: fk.from });
      for (const col of db.prepare(`PRAGMA table_info(${t})`).all())
        if (['user_id', 'model_id', 'fan_id', 'sender_id'].includes(col.name))
          pairs.set(`${t}.${col.name}`, { t, c: col.name });
    }
    const purgedNames = [];
    db.exec('BEGIN IMMEDIATE');
    try {
      // Cross-references between a seed's own rows resolve at COMMIT,
      // so the sweep order inside the transaction is free.
      db.exec('PRAGMA defer_foreign_keys = ON');
      for (const s of SEEDS) {
        const u = db.prepare('SELECT id, username, role, password_hash FROM users WHERE username = ?').get(s.username);
        if (!u) continue;
        if (u.role !== s.role) {
          console.log(`[cleanup] SKIPPED ${s.username}: live role is '${u.role}', not the seed role '${s.role}' — not a seed account, left untouched.`);
          continue;
        }
        // GUARDS — ALL of them are evaluated for every candidate and
        // every trip is logged; the account is purged only when NO
        // guard trips. Any single trip means "real person": untouched.
        let guardTripped = false;
        // Pictures guard (owner rule): a seed never uploaded anything
        // — no media rows, no profile photo. Any account WITH pictures
        // is a real model who joined, whatever her password state.
        const mediaRows = tableExists('media_items')
          ? db.prepare('SELECT COUNT(*) AS n FROM media_items WHERE sender_id = ?').get(u.id).n : 0;
        const hasPhotoCol = db.prepare('PRAGMA table_info(models)').all()
          .some((c) => c.name === 'photo_url');
        const modelRow = hasPhotoCol
          ? db.prepare('SELECT photo_url FROM models WHERE user_id = ?').get(u.id) : null;
        if (mediaRows > 0 || (modelRow && modelRow.photo_url)) {
          console.log(`[cleanup] SKIPPED ${u.username}: account has uploaded pictures — real account, left untouched.`);
          guardTripped = true;
        }
        // ID-verification guard (owner rule): an approved ID check
        // (id_verifications.status = 'approved', the isIdVerified
        // test) is conclusive proof of a real person — the seed
        // models were never ID-verified.
        if (tableExists('id_verifications') && isIdVerified(u.id)) {
          console.log(`[cleanup] SKIPPED ${u.username}: ID-verified model — real account, left untouched.`);
          guardTripped = true;
        }
        // Password fingerprint: a real person who re-registered a seed
        // name after the seeds were removed has her OWN password — the
        // seed default will not verify against her hash. Only an
        // account still running the seed default can be a seed.
        let isSeedPassword = false;
        try { isSeedPassword = bcrypt.compareSync(s.seedPassword, u.password_hash); } catch (e) { /* ignore */ }
        if (!isSeedPassword) {
          console.log(`[cleanup] SKIPPED ${u.username}: password is not the seed default — looks like a real account, left untouched.`);
          guardTripped = true;
        }
        if (guardTripped) continue;
        const w = db.prepare('SELECT credits_cents, earnings_cents FROM wallets WHERE user_id = ?').get(u.id)
          || { credits_cents: 0, earnings_cents: 0 };
        let rows = 0;
        // The seed's conversation threads go entirely (both sides' rows).
        const convIds = db.prepare('SELECT id FROM conversations WHERE fan_id = ? OR model_id = ?')
          .all(u.id, u.id).map((r) => r.id);
        if (convIds.length) {
          const ph = convIds.map(() => '?').join(',');
          for (const t of ['messages', 'media_items', 'safety_incidents'])
            if (tableExists(t))
              rows += db.prepare(`DELETE FROM ${t} WHERE conversation_id IN (${ph})`).run(...convIds).changes;
        }
        for (const { t, c } of pairs.values())
          rows += db.prepare(`DELETE FROM ${t} WHERE ${c} = ?`).run(u.id).changes;
        db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
        purgedNames.push(u.username);
        console.log(`[cleanup] purged seed account ${u.username} (${u.role}) balance ${w.credits_cents + w.earnings_cents} (credits ${w.credits_cents} + earnings ${w.earnings_cents}) — ${rows} dependent rows removed.`);
      }
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
      throw e;
    }
    db.prepare("UPDATE platform_stats SET demo_purge_at = datetime('now') WHERE id = 1").run();
    if (purgedNames.length) {
      console.log(`[cleanup] Demo seed purge complete: ${purgedNames.length} account(s) removed (${purgedNames.join(', ')}). No other users were touched.`);
    } else {
      console.log('[cleanup] Demo seed purge: no seed accounts found — nothing to purge.');
    }
    // The seeded admin is preserved on purpose (owner lockout). Audit its
    // password state so the deploy log answers the launch question: is
    // the Manager still protected by the README-public default password?
    const admin = db.prepare("SELECT id, password_hash FROM users WHERE username = 'admin'").get();
    if (admin) {
      let isDefault = false;
      try { isDefault = bcrypt.compareSync('admin123', admin.password_hash); } catch (e) { /* ignore */ }
      if (isDefault) {
        console.log('[cleanup] ⚠️ CRITICAL: user "admin" still signs in with the README-public default password admin123 — change it in Slut Manager before launch.');
      } else {
        console.log('[cleanup] Admin account "admin" preserved (never a purge target); its password is not the README default.');
      }
    }
    // fandemo is preserved on purpose too: it is the owner's own test
    // account (owner decision, Oct 16 2026), so it is never a purge
    // target and its balance is never touched — audit the preservation
    // so the deploy log shows the decision held.
    const fandemo = db.prepare("SELECT id FROM users WHERE username = 'fandemo'").get();
    if (fandemo) {
      console.log('[cleanup] fandemo preserved — owner\'s test account, untouched.');
    }
  } catch (e) { console.log('[cleanup] demo seed purge failed:', e.message); }
})();

/* Composite ranking backfill (owner, Oct 16 2026): stored rank_score
 * must be correct the moment a deploy lands, with zero manual steps —
 * recompute EVERY model on every boot from the two sources of truth
 * (model_likes + the earnings ledger). Deliberately NOT a one-time
 * marker: the derivation is a couple of indexed queries per model, it
 * is idempotent, and running it unconditionally self-heals any mutation
 * path that ever misses its recomputeModelRank() hook. Placed after
 * seed() and every one-time cleanup above so it sees their final
 * state (test-money rows already flagged, seed models already purged). */
try {
  const rankN = recomputeAllModelRanks();
  console.log(`[ranking] Composite ranks recomputed for ${rankN} models (likes + lifetime earnings $).`);
} catch (e) { console.log('[ranking] backfill failed:', e.message); }

/* ------------------------------------------------------------------ */
/* Public: guest tokens + model browsing (no login needed)              */
/* ------------------------------------------------------------------ */

// POST /api/guest/token → {guest_token} — anonymous visitor identity
app.post('/api/guest/token', (req, res) => {
  const token = crypto.randomBytes(16).toString('hex');
  res.json({ guest_token: token });
});

/* ---- Discovery 2.0: model tags ---------------------------------------
 * A small curated catalogue keeps tags browsable (fans filter the
 * directory by them) instead of free-text chaos. Models pick up to
 * MAX_MODEL_TAGS in Settings; stored on models.tags as a JSON array.
 * public/js/app.js mirrors this list as DISCOVERY_TAGS — the test suite
 * pins the two copies equal, so edit both or neither. */
const MODEL_TAGS = [
  'New here', 'Live daily', 'Video calls', 'Voice notes',
  'Gaming', 'Gamer girl', 'Fitness', 'Cosplay',
  'Tattoos', 'Piercings', 'Latina', 'Ebony',
  'Blonde', 'Brunette', 'Redhead', 'Curvy', 'Petite', 'MILF',
];
const MODEL_TAG_SET = new Set(MODEL_TAGS);
const MAX_MODEL_TAGS = 5;
// Stored value → clean array (unknown/legacy entries dropped on read).
function parseModelTags(raw) {
  try {
    const a = JSON.parse(raw || '[]');
    return Array.isArray(a) ? a.filter((t) => MODEL_TAG_SET.has(t)) : [];
  } catch (e) { return []; }
}
// PUT input → clean array capped at MAX_MODEL_TAGS, or null when the
// input isn't an array at all (caller 400s).
function cleanModelTags(input) {
  if (!Array.isArray(input)) return null;
  const out = [];
  for (const t of input) {
    if (typeof t === 'string' && MODEL_TAG_SET.has(t) && !out.includes(t)) out.push(t);
  }
  return out.slice(0, MAX_MODEL_TAGS);
}

/* ------------------------------------------------------------------ */
/* Profile picture gallery (owner, Oct 17 2026): her profile page is  */
/* NOT a feed — it shows her main photo plus up to MAX_PROFILE_PICS-1 */
/* gallery uploads, and exactly two main videos. The gallery list is  */
/* stored as a JSON array on the model row (same pattern as tags);    */
/* only /uploads/photo-* URLs the photo pipeline itself produced are  */
/* ever valid entries, so a stored value can never point elsewhere.   */
/* public_photo_url stays separate: it is the clean Google pic and    */
/* never joins the in-app profile gallery.                            */
/* ------------------------------------------------------------------ */
const MAX_PROFILE_PICS = 10;
const GALLERY_PHOTO_RE = /^\/uploads\/photo-[a-f0-9]+\.(jpg|png|webp)$/;
// Stored value → clean array of gallery URLs (junk/dupe entries dropped).
function parseGalleryPhotos(raw) {
  try {
    const a = JSON.parse(raw || '[]');
    if (!Array.isArray(a)) return [];
    const out = [];
    for (const u of a) {
      if (typeof u === 'string' && GALLERY_PHOTO_RE.test(u) && !out.includes(u)) out.push(u);
    }
    return out;
  } catch (e) { return []; }
}
// The profile page's picture list: main photo first, then her gallery
// uploads, deduped, capped at MAX_PROFILE_PICS total.
function profilePicsList(modelRow) {
  const pics = [];
  if (modelRow.photo_url) pics.push(modelRow.photo_url);
  for (const u of parseGalleryPhotos(modelRow.gallery_photos)) {
    if (!pics.includes(u)) pics.push(u);
  }
  return pics.slice(0, MAX_PROFILE_PICS);
}

/* ------------------------------------------------------------------ */
/* The OFFICIAL house account (owner, Oct 17 2026): the in-app        */
/* "SlutCamp" account is the APP ITSELF, not a model. It never        */
/* appears in model listings/rankings, fans can never message it,     */
/* and it lives as a permanent pinned card at the top of the fan      */
/* home instead. When it goes live, EVERY fan is notified (not just   */
/* followers) and joining/tipping works exactly like a regular live.  */
/* Identity = the model-role user with this username. Usernames are   */
/* immutable here (name changes touch display_name only), and the      */
/* username column is UNIQUE + NOCASE, so this match is exact and     */
/* can never collide with a numeric id.                               */
/* ------------------------------------------------------------------ */
const HOUSE_USERNAME = 'asceaaspade';
function houseAccountId() {
  const r = db.prepare("SELECT id FROM users WHERE username = ? AND role = 'model'")
    .get(HOUSE_USERNAME);
  return r ? r.id : null;
}
function isHouseAccountId(userId) {
  if (!userId) return false;
  const hid = houseAccountId();
  return hid !== null && hid === userId;
}

// GET /api/models — PUBLIC so guests can browse before signing up.
// Ordering: featured (SlutCamp Live) pinned first; regular models by
// composite rank_score = fan likes + lifetime credited model earnings
// in dollars (owner, Oct 16 2026: "Not just by fan likes — likes and
// money earned"). rank_score is a stored column maintained by
// recomputeModelRank() and backfilled on every boot.
// rank_position in the payload is her TRUE 1-based position in that
// composite order — the array order is NOT her rank, because the
// featured model floats above it. Positions are computed over the full
// eligible roster BEFORE region filtering, so a rank means the same
// thing to every viewer.
// total_sales = lifetime gross fan spend from transactions attributed
// to the model, excluding 'payout' rows (money OUT to the model, not
// sales); refund rows are negative and net against sales automatically.
// (Payload field kept for compatibility; it no longer drives ranking.)
app.get('/api/models', (req, res) => {
  const houseId = houseAccountId();
  const rows = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.presence_override, u.created_at, m.bio, m.per_message_cents,
           m.per_minute_cents, m.per_voice_cents, m.is_online, m.photo_url, m.public_photo_url, m.tags,
           m.preview_video_url, m.preview_video_url_2, m.gallery_photos, m.is_featured, m.rank_score,
           ls.id AS live_session_id, ls.explicit_rate_cents AS live_explicit_rate_cents,
           (SELECT COUNT(*) FROM live_viewers WHERE session_id = ls.id) AS live_viewers,
           (SELECT COUNT(*) FROM model_likes WHERE model_id = u.id) AS like_count,
           (SELECT COALESCE(SUM(gross_cents), 0) FROM transactions
             WHERE model_id = u.id AND type <> 'payout' AND is_test = 0) AS total_sales_cents
    FROM users u JOIN models m ON m.user_id = u.id
    LEFT JOIN live_sessions ls ON ls.model_id = u.id AND ls.status = 'live'
    WHERE u.role = 'model' AND u.banned = 0 AND m.is_hidden = 0
    ORDER BY m.is_featured DESC,
             m.rank_score DESC,
             like_count DESC,
             (CASE u.presence_override WHEN 'on' THEN 1 WHEN 'off' THEN 0 ELSE m.is_online END) DESC,
             u.created_at DESC, u.display_name ASC
  `).all();
  // True composite rank positions: the directory's own ordering chain
  // (rank, then likes / online / newest / name as tiebreaks) WITHOUT
  // the featured float.
  const rankOrder = db.prepare(`
    SELECT u.id,
           (SELECT COUNT(*) FROM model_likes WHERE model_id = u.id) AS like_count
    FROM users u JOIN models m ON m.user_id = u.id
    WHERE u.role = 'model' AND u.banned = 0 AND m.is_hidden = 0
    ORDER BY m.rank_score DESC,
             like_count DESC,
             (CASE u.presence_override WHEN 'on' THEN 1 WHEN 'off' THEN 0 ELSE m.is_online END) DESC,
             u.created_at DESC, u.display_name ASC
  `).all();
  // The house account holds no rank position — it is not a model, so
  // it is removed from the position map before positions are assigned
  // (a model ranked below it must not be shifted by its presence).
  const rankPos = new Map(rankOrder.filter((r) => r.id !== houseId).map((r, i) => [r.id, i + 1]));
  // Check which models the current fan has liked (if logged in)
  let likedSet = new Set();
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) {
    const userId = getSessionUserId(h.slice(7));
    if (userId) {
      const liked = db.prepare('SELECT model_id FROM model_likes WHERE fan_id = ?').all(userId);
      likedSet = new Set(liked.map((l) => l.model_id));
    }
  }
  // Region blocking: fans/guests never see models who blocked their region.
  // Models and admins browsing the grid are exempt.
  let visible = rows;
  const vRole = viewerRoleOf(req);
  if (vRole !== 'model' && vRole !== 'admin') {
    const blocked = blockedModelIds(geoOfReq(req));
    if (blocked.size) visible = rows.filter((r) => !blocked.has(r.id));
  }
  // The official house account leaves the model roster here (owner,
  // Oct 17 2026): no home grid, no Discovery, no New Models rail, no
  // ranked view, no landing tile — for ANY viewer. It travels separately
  // as `official` (below) to power the pinned card on the fan home. It
  // is pulled from the UNfiltered rows on purpose: region blocking is a
  // per-model fan control, and the app itself is never blocked off its
  // own home screen.
  const houseRow = houseId ? (rows.find((r) => r.id === houseId) || null) : null;
  if (houseId) visible = visible.filter((r) => r.id !== houseId);
  // Pre-purchase shield: a model's looping preview video is explicit-
  // capable storefront media with no lock of its own, so for a shielded
  // viewer (unverified fan or guest in a regulated/unknown location,
  // AV configured) the payload withholds it and the tile falls back to
  // her photo — the photo itself stays public (it IS the shop window).
  const dirIdent = getIdentity(req);
  const dirShielded = dirIdent && dirIdent.kind === 'user'
    ? shieldLib.fanShielded(dirIdent.user, shieldLocForUser(req, dirIdent.user))
    : shieldLib.guestShielded(shieldLib.resolveAvLocation(null, geoOfReq(req)));
  const shapeRow = (r) => {
    const sched = db.prepare(`SELECT day_of_week, start_time FROM live_schedule
      WHERE model_id = ? ORDER BY day_of_week, start_time`).all(r.id);
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const summary = sched.length
      ? sched.map((s) => `${days[s.day_of_week]} ${s.start_time.replace(/^0/, '')}`).join(', ')
      : '';
    const { presence_override, tags: rawTags, gallery_photos: rawGallery, ...pub } = r;
    // Her second profile video is storefront media exactly like the
    // first — the shield withholds both, never the pictures (they ARE
    // the shop window, same rule as photo_url).
    if (dirShielded) { pub.preview_video_url = ''; pub.preview_video_url_2 = ''; }
    return { ...pub, tags: parseModelTags(rawTags),
      gallery_photos: parseGalleryPhotos(rawGallery),
      is_online: effectiveOnline(presence_override, r.is_online),
      is_live: !!r.live_session_id, is_featured: !!r.is_featured,
      live_viewers: r.live_viewers || 0, schedule_summary: summary, liked: likedSet.has(r.id),
      likes_count: r.like_count || 0,
      total_sales: Math.round(r.total_sales_cents || 0) / 100,
      rank_score: r.rank_score || 0,
      rank_position: rankPos.get(r.id) || null };
  };
  // The official object: same public shape as a model row (the pinned
  // card and its look-only profile page render from it), flagged, and
  // never ranked or featured — those concepts belong to models.
  const official = houseRow
    ? { ...shapeRow(houseRow), is_official: true, is_featured: false, rank_position: null }
    : null;
  res.json({ models: visible.map(shapeRow), official });
});

// Fan likes/unlikes a model (heart on model cards)
app.post('/api/models/:id/like', identMiddleware, requireUser, requireRole('fan'), (req, res) => {
  const modelId = parseInt(req.params.id);
  const model = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'model'").get(modelId);
  if (!model) return res.status(404).json({ error: 'not_found' });
  if (modelRegionBlocked(modelId, geoOfReq(req))) return regionBlocked(res);
  const existing = db.prepare('SELECT 1 FROM model_likes WHERE fan_id = ? AND model_id = ?')
    .get(req.user.id, modelId);
  if (existing) {
    db.prepare('DELETE FROM model_likes WHERE fan_id = ? AND model_id = ?').run(req.user.id, modelId);
  } else {
    db.prepare('INSERT INTO model_likes (fan_id, model_id) VALUES (?,?)').run(req.user.id, modelId);
  }
  const count = db.prepare('SELECT COUNT(*) AS n FROM model_likes WHERE model_id = ?').get(modelId).n;
  recomputeModelRank(modelId);
  res.json({ ok: true, liked: !existing, like_count: count });
});

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */

function isAdult(dob) {
  if (!dob) return false;
  const birth = new Date(dob + 'T00:00:00');
  if (isNaN(birth)) return false;
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  const m = now.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < birth.getDate())) age--;
  return age >= 18;
}

/* 18+ attestation record. Flows that don't collect a real date of birth
 * (quick signup, affiliate signup) must NEVER store a fake DOB — they store
 * what actually happened: the user attested 18+, when, and from what IP. */
addColumnIfMissing('users', 'age_attested_at', 'TEXT');
addColumnIfMissing('users', 'age_attested_ip', 'TEXT');
function recordAgeAttestation(userId, req) {
  db.prepare('UPDATE users SET age_attested_at = datetime(\'now\'), age_attested_ip = ? WHERE id = ?')
    .run(String(clientIp(req) || '').slice(0, 60), userId);
}

/* Age verification (lib/av.js) — PROOF-ONLY columns. fan_state is the
 * fan's US state (2-letter code) resolved from IP at signup and
 * refreshed at purchase time; av_verified_at / av_method /
 * av_provider_ref are the entire verification record (when, how, and
 * the provider's opaque reference). No document, image, DOB or provider
 * payload is EVER stored for AV — the evidence stays with the provider.
 * av_last_attested_at is the Tennessee re-attestation stamp (login). */
addColumnIfMissing('users', 'fan_state', 'TEXT');
addColumnIfMissing('users', 'av_verified_at', 'TEXT');
addColumnIfMissing('users', 'av_method', 'TEXT');
addColumnIfMissing('users', 'av_provider_ref', 'TEXT');
addColumnIfMissing('users', 'av_last_attested_at', 'TEXT');
function recordFanState(userId, req) {
  const geo = geoOfReq(req);
  if (geo && geo.country === 'US' && geo.state) {
    db.prepare('UPDATE users SET fan_state = ? WHERE id = ?').run(geo.state, userId);
  }
}

// POST /api/auth/signup — optional guest_token migrates guest chats/trials
// Optional invite_code: model invite link — forces role='model', tags the invite as used.
app.post('/api/auth/signup', (req, res) => {
  const { username, password, role, display_name, dob, agree18, guest_token, invite_code } = req.body || {};
  if (!username || !password || !display_name || !dob)
    return res.status(400).json({ error: 'missing_fields' });
  if (String(password).length < 6) return res.status(400).json({ error: 'password_too_short' });

  // Invite-code flow: the link determines the role (always model)
  let invite = null;
  let finalRole = role;
  if (invite_code) {
    invite = db.prepare('SELECT * FROM invite_links WHERE code = ?').get(String(invite_code).trim());
    if (!invite || invite.is_revoked)
      return res.status(400).json({ error: 'bad_invite', message: 'This invite link is invalid or has been revoked.' });
    if (invite.used_by)
      return res.status(400).json({ error: 'invite_used', message: 'This invite link has already been used.' });
    if (invite.expires_at && new Date(invite.expires_at + 'Z') < new Date())
      return res.status(400).json({ error: 'invite_expired', message: 'This invite link has expired. Ask for it to be refreshed.' });
    finalRole = 'model';
  }
  // Referral-code flow: a partner's link attributes the new model to that recruiter
  let recruiterId = null;
  if (req.body.referral_code) {
    const rc = db.prepare(`SELECT r.id FROM recruiters r JOIN users u ON u.id = r.user_id
                           WHERE r.referral_code = ? AND u.banned = 0`)
      .get(String(req.body.referral_code).trim());
    if (!rc) return res.status(400).json({ error: 'bad_referral', message: 'This referral link is invalid.' });
    recruiterId = rc.id;
  }
  if (!['fan', 'model'].includes(finalRole)) return res.status(400).json({ error: 'bad_role' });
  if (!agree18 || !isAdult(dob)) return res.status(400).json({ error: 'must_be_18' });
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username.trim()))
    return res.status(409).json({ error: 'username_taken' });

  // Optional contact email — skippable (owner rule: never forced);
  // validated only when the fan actually provided one.
  const contact = optionalEmail(req.body.email);
  if (contact.error)
    return res.status(400).json({ error: 'bad_email', message: "That email doesn't look right — check it, or leave it blank and skip." });

  const id = createUser(username.trim(), password, finalRole, display_name.trim().slice(0, 40), dob, signupLanguage(req));
  if (contact.email) db.prepare('UPDATE users SET email = ? WHERE id = ?').run(contact.email, id);
  recordAgeAttestation(id, req);
  if (finalRole === 'fan') recordFanState(id, req);

  // Mark the invite as used by this model
  if (invite) {
    db.prepare(`UPDATE invite_links SET used_by = ?, used_at = datetime('now') WHERE id = ?`)
      .run(id, invite.id);
  }

  // Attribute the model to her recruiter (null = Corry's own)
  if (recruiterId && finalRole === 'model') {
    db.prepare('UPDATE models SET recruiter_id = ? WHERE user_id = ?').run(recruiterId, id);
  }

  // Migrate guest history → new account (chats, free-trial counts, strikes)
  mergeGuestIntoUser(id, guest_token);

  const token = createSession(id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  res.json({ token, user: getUserPublic(user) });
});

// POST /api/auth/quick-signup — streamlined fan signup from Wallet: username + password + 18 + payment info
addColumnIfMissing('users', 'pay_full_name', 'TEXT');
addColumnIfMissing('users', 'pay_method', 'TEXT');
addColumnIfMissing('users', 'pay_card_last4', 'TEXT');
addColumnIfMissing('users', 'pay_cashtag', 'TEXT');
app.post('/api/auth/quick-signup', (req, res) => {
  const { username, password, full_name, pay_method, card_last4, cashtag, guest_token, agree18 } = req.body || {};
  if (!username || !password || !full_name)
    return res.status(400).json({ error: 'missing_fields' });
  if (String(password).length < 6) return res.status(400).json({ error: 'password_too_short' });
  if (!agree18) return res.status(400).json({ error: 'must_be_18' });
  if (!['card', 'cashapp'].includes(pay_method))
    return res.status(400).json({ error: 'bad_pay_method' });
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username.trim()))
    return res.status(409).json({ error: 'username_taken' });

  // 18+ is attested (checkbox + timestamp + IP on file) — never a fake DOB.
  // Fan policy (Corry, Oct 12 2026): attestation + payment card is enough —
  // no ID upload for fans. ID verification is for models only (2257).
  const id = createUser(username.trim(), password, 'fan', username.trim().slice(0, 40), null, signupLanguage(req));
  recordAgeAttestation(id, req);
  recordFanState(id, req);
  db.prepare('UPDATE users SET pay_full_name = ?, pay_method = ?, pay_card_last4 = ?, pay_cashtag = ? WHERE id = ?')
    .run(full_name.trim().slice(0, 80), pay_method, card_last4 || null, cashtag || null, id);

  // Migrate guest history to the new account
  mergeGuestIntoUser(id, guest_token);

  const token = createSession(id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  res.json({ token, user: getUserPublic(user) });
});

// Fold a guest's history into a real account (signup + login).
// Conflict-safe: if the fan already has a thread with a model the guest
// chatted with, the guest messages move INTO that thread and the guest
// thread is removed — a plain UPDATE crashes on UNIQUE(fan_id, model_id)
// and fails the whole login (bit Corry's fandemo login, Oct 12 2026).
// Merges must never fail auth: every step is guarded; worst case the
// history simply stays guest-owned.
function mergeGuestIntoUser(userId, guest_token) {
  if (!guest_token || !/^[a-f0-9]{32}$/.test(guest_token)) return;
  const gk = `g:${guest_token}`, uk = `u:${userId}`;
  try {
    const guestConvs = db.prepare(
      'SELECT id, model_id FROM conversations WHERE guest_token = ? AND fan_id IS NULL').all(guest_token);
    for (const gc of guestConvs) {
      const existing = db.prepare(
        'SELECT id FROM conversations WHERE fan_id = ? AND model_id = ?').get(userId, gc.model_id);
      if (existing) {
        db.prepare('UPDATE messages SET conversation_id = ? WHERE conversation_id = ?').run(existing.id, gc.id);
        db.prepare('DELETE FROM conversations WHERE id = ?').run(gc.id);
      } else {
        db.prepare('UPDATE conversations SET fan_id = ?, guest_token = NULL WHERE id = ?').run(userId, gc.id);
      }
    }
  } catch (e) { console.log('[auth] guest conversation merge failed:', e.message); }
  try {
    db.prepare(`DELETE FROM free_trials WHERE subject_key = ?
                 AND model_id IN (SELECT model_id FROM free_trials WHERE subject_key = ?)`).run(gk, uk);
    db.prepare('UPDATE free_trials SET subject_key = ? WHERE subject_key = ?').run(uk, gk);
  } catch (e) { console.log('[auth] free_trials merge failed:', e.message); }
  try {
    const gs = db.prepare('SELECT strikes, flagged FROM strikes WHERE subject_key = ?').get(gk);
    if (gs) {
      const us = db.prepare('SELECT strikes, flagged FROM strikes WHERE subject_key = ?').get(uk);
      if (us) {
        db.prepare('UPDATE strikes SET strikes = ?, flagged = ? WHERE subject_key = ?')
          .run(us.strikes + gs.strikes, Math.max(us.flagged, gs.flagged), uk);
        db.prepare('DELETE FROM strikes WHERE subject_key = ?').run(gk);
      } else {
        db.prepare('UPDATE strikes SET subject_key = ? WHERE subject_key = ?').run(uk, gk);
      }
    }
  } catch (e) { console.log('[auth] strikes merge failed:', e.message); }
  try {
    db.prepare(`UPDATE messages SET guest_token = NULL WHERE guest_token = ?
                AND conversation_id IN (SELECT id FROM conversations WHERE fan_id = ?)`).run(guest_token, userId);
  } catch (e) { /* cosmetic cleanup only */ }
}

app.post('/api/auth/login', (req, res) => {
  const { username, password, guest_token } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get((username || '').trim());
  if (!user || !bcrypt.compareSync(password || '', user.password_hash))
    return res.status(401).json({ error: 'bad_login' });
  if (user.banned) return res.status(403).json({ error: 'banned' });
  if (user.status === 'frozen') return res.status(403).json({ error: 'account_frozen',
    message: 'Your account has been frozen due to a billing dispute. Contact support.' });

  if (guest_token) mergeGuestIntoUser(user.id, guest_token);

  const token = createSession(user.id);
  // TN periodic re-verification: a verified fan re-attests by signing in
  // (timestamp only, no provider call). No-op while AV is dormant.
  try { avSvc.stampReattestation(user.id); } catch (e) { /* never block a login */ }
  // Slut Manager split: the manager account CAN sign in here now, but the
  // response flags it (manager_account) so the public client shows the
  // "you're on the manager account" interstitial instead of dropping him
  // straight into the app. Admin API endpoints stay unreachable from the
  // public app regardless (X-Manager header rule above).
  res.json({ token, user: getUserPublic(user), manager_account: user.role === 'admin' });
});

app.post('/api/auth/logout', identMiddleware, requireUser, (req, res) => {
  deleteSession((req.headers.authorization || '').slice(7));
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Passkeys (WebAuthn) — Face ID sign-in, an option for EVERYONE       */
/* (final scope per Asce, Oct 16 2026):                                */
/* - Fans/models/admins may enroll a passkey while signed in           */
/*   (register-*) and later sign in with it (login-*) — password       */
/*   sign-in stays fully intact as the backup.                         */
/* - For the ADMIN the passkey is ALSO the enforced SECOND step of     */
/*   Manager sign-in: password first, then a Face ID confirmation      */
/*   (stepup-*) stamps sessions.passkey_verified_at, and only then do  */
/*   /api/admin/* and /api/mod/* unlock (see requirePasskeyStepUp).    */
/*   Bootstrap safety: while the admin has NO passkey enrolled, the    */
/*   step-up is not enforced — he can never lock himself out.          */
/*                                                                    */
/* "Face ID" = the DEVICE's biometrics (Face ID, Android face unlock,  */
/* Touch ID, Windows Hello) proving possession of a passkey. The       */
/* biometric itself NEVER reaches this server — we only store the      */
/* credential public key and verify signatures.                        */
/*                                                                    */
/* RP ID / origin: set WEBAUTHN_RP_ID + WEBAUTHN_ORIGIN on Render in   */
/* production (slutcamp.app / https://slutcamp.app). When unset, the    */
/* RP ID is derived from the request Host and the expected origin      */
/* from the Origin header (local dev / tests).                         */
/* ------------------------------------------------------------------ */

const WEBAUTHN_RP_NAME = 'SlutCamp';
const WEBAUTHN_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const webauthnChallenges = new Map(); // key -> { challenge, expiresAt }
const passkeyLoginAttempts = new Map(); // ip -> { count, resetAt } (rate limit, mirrors adminLoginAttempts)

function webauthnRp(req) {
  const rpID = process.env.WEBAUTHN_RP_ID
    || String(req.headers.host || 'localhost').split(':')[0];
  let origin = process.env.WEBAUTHN_ORIGIN || req.headers.origin || '';
  if (!origin) {
    const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
    origin = `${proto}://${req.headers.host || 'localhost'}`;
  }
  return { rpID, origin };
}

function stashChallenge(key, challenge) {
  webauthnChallenges.set(key, { challenge, expiresAt: Date.now() + WEBAUTHN_CHALLENGE_TTL_MS });
}

// Single-use: reading a challenge consumes it (replay protection).
function takeChallenge(key) {
  const rec = webauthnChallenges.get(key);
  webauthnChallenges.delete(key);
  if (!rec || Date.now() > rec.expiresAt) return null;
  return rec.challenge;
}

// Same shape as adminRateLimited: >5 attempts per IP per minute, per scope.
function passkeyRateLimited(scope, ip) {
  const key = scope + ':' + ip;
  const now = Date.now();
  let rec = passkeyLoginAttempts.get(key);
  if (!rec || now > rec.resetAt) {
    rec = { count: 0, resetAt: now + 60000 };
    passkeyLoginAttempts.set(key, rec);
  }
  rec.count++;
  return rec.count > 5;
}

const credsOfUser = (userId) =>
  db.prepare('SELECT * FROM webauthn_credentials WHERE user_id = ? ORDER BY id').all(userId);

const adminHasPasskey = (userId) =>
  !!db.prepare('SELECT 1 AS x FROM webauthn_credentials WHERE user_id = ? LIMIT 1').get(userId);

// Has THIS session token passed the Face ID step-up?
function sessionPasskeyVerified(token) {
  if (!token) return false;
  const r = db.prepare('SELECT passkey_verified_at FROM sessions WHERE token = ?').get(token);
  return !!(r && r.passkey_verified_at);
}

/* Face ID enforcement for admin routes. Runs AFTER requireRole('admin')
   (req.user is the admin). If the admin has a passkey enrolled, the
   current session must have passed the step-up — otherwise 403
   { error: 'passkey_required' } and the Manager client shows the
   Face ID gate. No enrolled passkey → pass (bootstrap, no lockout). */
const requirePasskeyStepUp = (req, res, next) => {
  if (!req.user || !adminHasPasskey(req.user.id)) return next();
  const token = (req.headers.authorization || '').slice(7);
  if (sessionPasskeyVerified(token)) return next();
  return res.status(403).json({ error: 'passkey_required' });
};

function parseTransports(t) {
  try {
    const v = JSON.parse(t || '[]');
    return Array.isArray(v) && v.length ? v : undefined;
  } catch (e) { return undefined; }
}

// Shared assertion verification for passkey sign-in + Manager step-up.
// Returns { credRow, newCounter } on success, null on any failure.
async function verifyPasskeyAssertion(req, user, challengeKey, response) {
  if (!response || typeof response !== 'object' || !response.id) return null;
  const challenge = takeChallenge(challengeKey);
  if (!challenge) return null;
  const credRow = db.prepare('SELECT * FROM webauthn_credentials WHERE user_id = ? AND credential_id = ?')
    .get(user.id, String(response.id));
  if (!credRow) return null;
  const { rpID, origin } = webauthnRp(req);
  try {
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: credRow.credential_id,
        publicKey: new Uint8Array(Buffer.from(credRow.public_key, 'base64url')),
        counter: credRow.counter,
        transports: parseTransports(credRow.transports),
      },
    });
    if (!verification.verified) return null;
    return { credRow, newCounter: verification.authenticationInfo.newCounter };
  } catch (e) {
    return null;
  }
}

function touchCredential(credRow, newCounter) {
  db.prepare("UPDATE webauthn_credentials SET counter = ?, last_used_at = datetime('now') WHERE id = ?")
    .run(newCounter, credRow.id);
}

// --- Enrollment (any logged-in user): step 1, ceremony options ---
app.post('/api/auth/passkey/register-options', identMiddleware, requireUser, async (req, res) => {
  try {
    const { rpID } = webauthnRp(req);
    const options = await generateRegistrationOptions({
      rpName: WEBAUTHN_RP_NAME,
      rpID,
      userName: req.user.username,
      userID: new TextEncoder().encode('u' + req.user.id),
      userDisplayName: req.user.display_name || req.user.username,
      attestationType: 'none',
      excludeCredentials: credsOfUser(req.user.id).map((c) => ({
        id: c.credential_id,
        transports: parseTransports(c.transports),
      })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    });
    stashChallenge('reg:' + req.user.id, options.challenge);
    res.json(options);
  } catch (e) {
    console.log('[passkey] register-options failed:', e.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// --- Enrollment (any logged-in user): step 2, verify + store ---
app.post('/api/auth/passkey/register-verify', identMiddleware, requireUser, async (req, res) => {
  const response = (req.body && req.body.response) || req.body;
  const challenge = takeChallenge('reg:' + req.user.id);
  if (!challenge) return res.status(400).json({ error: 'challenge_expired' });
  const { rpID, origin } = webauthnRp(req);
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
    });
  } catch (e) {
    return res.status(400).json({ error: 'verification_failed' });
  }
  if (!verification.verified || !verification.registrationInfo)
    return res.status(400).json({ error: 'verification_failed' });
  const cred = verification.registrationInfo.credential;
  const existing = db.prepare('SELECT user_id FROM webauthn_credentials WHERE credential_id = ?').get(cred.id);
  if (existing && existing.user_id !== req.user.id)
    return res.status(409).json({ error: 'credential_in_use' });
  const label = (req.body && typeof req.body.label === 'string' && req.body.label.trim())
    ? req.body.label.trim().slice(0, 60) : 'Passkey';
  db.prepare(`INSERT INTO webauthn_credentials (user_id, credential_id, public_key, counter, transports, device_label)
              VALUES (?,?,?,?,?,?)
              ON CONFLICT(credential_id) DO UPDATE SET
                public_key = excluded.public_key,
                counter = excluded.counter,
                transports = excluded.transports`)
    .run(req.user.id, cred.id,
      Buffer.from(cred.publicKey).toString('base64url'),
      cred.counter || 0,
      JSON.stringify(cred.transports || []),
      label);
  res.json({ ok: true });
});

// --- Passwordless sign-in: step 1, ceremony options ---
app.post('/api/auth/passkey/login-options', async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (passkeyRateLimited('options', ip)) return res.status(429).json({ error: 'too_many_attempts' });
  const username = String((req.body || {}).username || '').trim();
  const user = db.prepare('SELECT * FROM users WHERE LOWER(username) = LOWER(?)').get(username);
  const creds = user ? credsOfUser(user.id) : [];
  if (!user || creds.length === 0) return res.status(400).json({ error: 'no_passkey' });
  try {
    const { rpID } = webauthnRp(req);
    const options = await generateAuthenticationOptions({
      rpID,
      allowCredentials: creds.map((c) => ({
        id: c.credential_id,
        transports: parseTransports(c.transports),
      })),
      userVerification: 'preferred',
    });
    stashChallenge('auth:' + user.username.toLowerCase(), options.challenge);
    res.json(options);
  } catch (e) {
    console.log('[passkey] login-options failed:', e.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// --- Passwordless sign-in: step 2, verify + issue a normal session ---
app.post('/api/auth/passkey/login-verify', async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (passkeyRateLimited('verify', ip)) return res.status(429).json({ error: 'too_many_attempts' });
  const { username, response } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE LOWER(username) = LOWER(?)')
    .get(String(username || '').trim());
  if (!user) return res.status(400).json({ error: 'verification_failed' });
  const result = await verifyPasskeyAssertion(req, user, 'auth:' + user.username.toLowerCase(), response);
  if (!result) return res.status(401).json({ error: 'verification_failed' });
  touchCredential(result.credRow, result.newCounter);
  // Same account-state checks as password login, in the same order.
  if (user.banned) return res.status(403).json({ error: 'banned' });
  if (user.status === 'frozen') return res.status(403).json({ error: 'account_frozen',
    message: 'Your account has been frozen due to a billing dispute. Contact support.' });
  const token = createSession(user.id);
  // TN periodic re-verification stamp (see password login). Dormant-safe.
  try { avSvc.stampReattestation(user.id); } catch (e) { /* never block a login */ }
  res.json({ token, user: getUserPublic(user), manager_account: user.role === 'admin' });
});

// --- Manager step-up: step 1 (admin session required) ---
app.post('/api/manager/passkey/stepup-options', identMiddleware, requireUser, requireRole('admin'), async (req, res) => {
  const creds = credsOfUser(req.user.id);
  if (creds.length === 0) return res.status(400).json({ error: 'no_passkey' });
  try {
    const { rpID } = webauthnRp(req);
    const options = await generateAuthenticationOptions({
      rpID,
      allowCredentials: creds.map((c) => ({
        id: c.credential_id,
        transports: parseTransports(c.transports),
      })),
      userVerification: 'preferred',
    });
    stashChallenge('stepup:' + req.user.id, options.challenge);
    res.json(options);
  } catch (e) {
    console.log('[passkey] stepup-options failed:', e.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// --- Manager step-up: step 2 — stamps the CURRENT session as passkey-verified ---
app.post('/api/manager/passkey/stepup-verify', identMiddleware, requireUser, requireRole('admin'), async (req, res) => {
  const response = (req.body || {}).response || req.body;
  const result = await verifyPasskeyAssertion(req, req.user, 'stepup:' + req.user.id, response);
  if (!result) return res.status(401).json({ error: 'verification_failed' });
  touchCredential(result.credRow, result.newCounter);
  const token = (req.headers.authorization || '').slice(7);
  db.prepare("UPDATE sessions SET passkey_verified_at = datetime('now') WHERE token = ?").run(token);
  res.json({ ok: true });
});

// --- Manager Face ID status for the CURRENT admin session ---
// enrolled: the admin has ≥1 passkey (so the step-up is enforced).
// verified: this session has already passed the step-up.
app.get('/api/manager/passkey/status', identMiddleware, requireUser, requireRole('admin'), (req, res) => {
  const token = (req.headers.authorization || '').slice(7);
  res.json({
    enrolled: adminHasPasskey(req.user.id),
    verified: sessionPasskeyVerified(token),
  });
});

// --- List my passkeys (never returns public keys) ---
app.get('/api/auth/passkey/list', identMiddleware, requireUser, (req, res) => {
  const rows = db.prepare('SELECT id, device_label, created_at, last_used_at FROM webauthn_credentials WHERE user_id = ? ORDER BY id')
    .all(req.user.id);
  res.json({ credentials: rows });
});

// --- Remove one of my passkeys (row id or credential id; owner only) ---
app.delete('/api/auth/passkey/:credId', identMiddleware, requireUser, (req, res) => {
  const r = db.prepare('DELETE FROM webauthn_credentials WHERE user_id = ? AND (id = ? OR credential_id = ?)')
    .run(req.user.id, req.params.credId, req.params.credId);
  if (!r.changes) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Admin auth — secret route only (#boss). Public /api/auth/login       */
/* rejects admins outright. SMS 2FA via Twilio.                         */
/* ------------------------------------------------------------------ */

function getAdminUser(username) {
  const u = db.prepare("SELECT * FROM users WHERE LOWER(username) = LOWER(?) AND role = 'admin'").get((username || '').trim());
  return u || null;
}

function checkAdminPassword(user, password) {
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) return false;
  if (user.banned) return false;
  return true;
}


// Step 1: password → full session (SMS 2FA disabled per Corry Oct 10, 2026)
app.post('/api/auth/admin-login', async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (adminRateLimited(ip)) return res.status(429).json({ error: 'too_many_attempts' });
  const { username, password } = req.body || {};
  const user = getAdminUser(username);
  if (!checkAdminPassword(user, password)) return res.status(401).json({ error: 'bad_login' });

  const token = createSession(user.id);
  res.json({ token, user: getUserPublic(user) });
});

/* ------------------------------------------------------------------ */
/* Slut Manager login — the ONLY login door for the Manager app.        */
/* Same account + password check as the admin login, but any valid      */
/* NON-admin account is refused with a plain-language error: this app   */
/* is for the manager account only. Issues the normal session token;    */
/* the manager client stores it in localStorage['wc_token'], the same   */
/* key the public app uses (same origin, shared session).               */
/* ------------------------------------------------------------------ */
app.post('/api/manager/login', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (adminRateLimited(ip)) return res.status(429).json({ error: 'too_many_attempts' });
  const { username, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE LOWER(username) = LOWER(?)')
    .get((username || '').trim());
  if (!user || !bcrypt.compareSync(password || '', user.password_hash))
    return res.status(401).json({ error: 'bad_login' });
  if (user.banned) return res.status(403).json({ error: 'banned' });
  if (user.role !== 'admin') return res.status(403).json({ error: 'not_manager',
    message: 'This app is for the SlutCamp manager account only' });

  const token = createSession(user.id);
  res.json({ token, user: getUserPublic(user), manager_account: true });
});

// Step 2: temp token + SMS code → full session
app.post('/api/auth/admin-2fa', (req, res) => {
  const { temp_token, code } = req.body || {};
  const tmp = adminTempTokens.get(temp_token);
  if (!tmp || Date.now() > tmp.expiresAt) {
    adminTempTokens.delete(temp_token);
    return res.status(401).json({ error: 'session_expired' });
  }
  const row = db.prepare('SELECT * FROM sms_codes WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(tmp.userId);
  if (!row) return res.status(401).json({ error: 'bad_code' });
  if (row.attempts >= 3) {
    db.prepare('DELETE FROM sms_codes WHERE user_id = ?').run(tmp.userId);
    adminTempTokens.delete(temp_token);
    return res.status(403).json({ error: 'too_many_attempts' });
  }
  if (Date.now() > row.expires_at) {
    db.prepare('DELETE FROM sms_codes WHERE id = ?').run(row.id);
    return res.status(401).json({ error: 'code_expired' });
  }
  if (String(code || '').trim() !== row.code) {
    db.prepare('UPDATE sms_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
    const left = 2 - row.attempts;
    return res.status(401).json({ error: 'bad_code', attempts_left: Math.max(0, left) });
  }
  // Success — single use
  db.prepare('DELETE FROM sms_codes WHERE user_id = ?').run(tmp.userId);
  adminTempTokens.delete(temp_token);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(tmp.userId);
  const token = createSession(user.id);
  res.json({ token, user: getUserPublic(user) });
});

// First-time setup: verify password, save phone, text a verification code
app.post('/api/auth/admin-setup-phone', async (req, res) => {
  const { username, password, phone } = req.body || {};
  const user = getAdminUser(username);
  if (!checkAdminPassword(user, password)) return res.status(401).json({ error: 'bad_login' });
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) return res.status(400).json({ error: 'bad_phone' });
  const e164 = '+' + digits;
  db.prepare('UPDATE platform_stats SET admin_phone = ? WHERE id = 1').run(e164);
  const code = issueSmsCode(user.id);
  const sent = await sendAdminSMS(e164, `SlutCamp admin code: ${code}. Expires in 5 min.`);
  if (!sent.ok) return res.status(500).json({ error: sent.error });
  res.json({ ok: true, sent: true, masked: maskPhone(e164) });
});

// Verify the setup code → enable 2FA, return full session
app.post('/api/auth/admin-verify-phone', (req, res) => {
  const { username, code } = req.body || {};
  const user = getAdminUser(username);
  if (!user) return res.status(401).json({ error: 'bad_login' });
  const row = db.prepare('SELECT * FROM sms_codes WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(user.id);
  if (!row || row.attempts >= 3) return res.status(401).json({ error: 'bad_code' });
  if (Date.now() > row.expires_at) {
    db.prepare('DELETE FROM sms_codes WHERE id = ?').run(row.id);
    return res.status(401).json({ error: 'code_expired' });
  }
  if (String(code || '').trim() !== row.code) {
    db.prepare('UPDATE sms_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
    return res.status(401).json({ error: 'bad_code' });
  }
  db.prepare('DELETE FROM sms_codes WHERE user_id = ?').run(user.id);
  db.prepare('UPDATE platform_stats SET admin_2fa_on = 1 WHERE id = 1').run();
  const token = createSession(user.id);
  res.json({ token, user: getUserPublic(user) });
});

// Admin settings: 2FA status + change/disable live below (after adminOnly is defined)

app.get('/api/me', identMiddleware, requireUser, (req, res) => {
  const wallet = getWallet(req.user.id);
  // email rides ONLY on the caller's own /api/me payload — getUserPublic
  // stays clean for everyone else's views (chat partners, directories).
  const out = { user: { ...getUserPublic(req.user), email: req.user.email || '' }, wallet };
  if (req.user.role === 'model')
    out.model = db.prepare('SELECT * FROM models WHERE user_id = ?').get(req.user.id);
  if (req.user.role === 'admin' || req.user.role === 'model') out.commission_pct = getCommission();
  res.json(out);
});

/* --- Display name changes ---
 * Fans: self-service, 1 change per 30 days.
 * Models: submit a request; admin approves/rejects.
 * Recruiters/admins: use admin endpoints.
 */
const NAME_CHANGE_DAYS = 30;
app.patch('/api/me/display-name', identMiddleware, requireUser, (req, res) => {
  if (req.user.role !== 'fan')
    return res.status(403).json({ error: 'fans_only', message: 'Models: submit a name change request instead.' });
  const name = String(req.body?.display_name || '').trim().slice(0, 40);
  if (!name || name.length < 2)
    return res.status(400).json({ error: 'invalid_name', message: 'Name must be at least 2 characters.' });
  const u = db.prepare('SELECT name_changed_at FROM users WHERE id = ?').get(req.user.id);
  if (u?.name_changed_at) {
    const days = (Date.now() - new Date(u.name_changed_at + 'Z').getTime()) / 86400000;
    if (days < NAME_CHANGE_DAYS)
      return res.status(429).json({ error: 'too_soon',
        message: `You can change your name again in ${Math.ceil(NAME_CHANGE_DAYS - days)} days.`,
        next_change_in_days: Math.ceil(NAME_CHANGE_DAYS - days) });
  }
  db.prepare(`UPDATE users SET display_name = ?, name_changed_at = datetime('now') WHERE id = ?`)
    .run(name, req.user.id);
  res.json({ ok: true, display_name: name });
});

// UI language preference — the in-app picker (EN / ES / PT-BR) saves here so
// the choice follows the user across devices; guests keep it in localStorage.
app.patch('/api/me/language', identMiddleware, requireUser, (req, res) => {
  const lang = String(req.body?.language || '').toLowerCase();
  if (!SUPPORTED_LANGS.includes(lang))
    return res.status(400).json({ error: 'bad_language', message: 'Supported languages: en, es, pt, fr, de, ru, ja, zh, ko, it, pl, nl, tr.' });
  db.prepare('UPDATE users SET language = ? WHERE id = ?').run(lang, req.user.id);
  res.json({ ok: true, language: lang });
});

// Optional contact email for update blasts (favorite models + deals).
// Owner rule (Oct 17 2026): NEVER forced — any logged-in user may set
// or clear theirs; an empty value clears to NULL, and NULL means "send
// me nothing". Collection only: no email provider exists yet.
app.patch('/api/me/contact', identMiddleware, requireUser, (req, res) => {
  const raw = req.body ? req.body.email : undefined;
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    db.prepare('UPDATE users SET email = NULL WHERE id = ?').run(req.user.id);
    return res.json({ ok: true, email: null });
  }
  const contact = optionalEmail(raw);
  if (contact.error)
    return res.status(400).json({ error: 'bad_email', message: "That email doesn't look right — check it, or clear it to skip." });
  db.prepare('UPDATE users SET email = ? WHERE id = ?').run(contact.email, req.user.id);
  res.json({ ok: true, email: contact.email });
});

/* --- Fan Suggestion Box ------------------------------------------------
 * Any logged-in user may drop an idea (the card itself lives in the
 * fan Wallet). Validation: non-empty after trim, ≤1000 chars, and a
 * rolling rate limit of 5 per user per 24h. The username is stored
 * as a snapshot. On success every admin gets a bell (title via SRV in
 * the admin's language, body = the suggestion, truncated) — wrapped
 * so a notify failure can never fail the submission itself. */
app.post('/api/suggestions', identMiddleware, requireUser, (req, res) => {
  const text = String((req.body && req.body.text) || '').trim();
  if (!text)
    return res.status(400).json({ error: 'suggest_empty', message: 'Write a suggestion first.' });
  if (text.length > 1000)
    return res.status(400).json({ error: 'suggest_too_long', message: 'Keep it under 1,000 characters.' });
  const recent = db.prepare(
    "SELECT COUNT(*) AS c FROM suggestions WHERE user_id = ? AND created_at > datetime('now', '-24 hours')"
  ).get(req.user.id).c;
  if (recent >= 5)
    return res.status(429).json({ error: 'suggest_rate', message: "You've sent 5 suggestions today — try again tomorrow." });
  db.prepare('INSERT INTO suggestions (user_id, username, body) VALUES (?,?,?)')
    .run(req.user.id, req.user.username, text);
  try {
    const admins = db.prepare("SELECT id, language FROM users WHERE role = 'admin'").all();
    const bellBody = text.length > 120 ? text.slice(0, 120) + '…' : text;
    for (const a of admins) {
      try {
        notifyUser(a.id, 'suggestion_admin',
          srv('suggest_admin_title', a.language, { username: req.user.username }), bellBody, '');
      } catch (e) { /* one admin's bell must not block the others */ }
    }
  } catch (e) { /* bells are a bonus; the stored suggestion is the deliverable */ }
  res.json({ ok: true });
});

/* Read-only Suggestion Box digest for Ms. Pink's triage watch. Auth is
 * ONLY the x-digest-token header against SUGGEST_DIGEST_TOKEN (timing-
 * safe compare) — no session, no Manager header, and it never mutates
 * anything. Env unset → 503 (the watch simply isn't configured). */
app.get('/api/internal/suggestions-digest', (req, res) => {
  const expected = process.env.SUGGEST_DIGEST_TOKEN;
  if (!expected) return res.status(503).json({ error: 'digest_unavailable' });
  const given = Buffer.from(String(req.headers['x-digest-token'] || ''), 'utf8');
  const want = Buffer.from(String(expected), 'utf8');
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want))
    return res.status(401).json({ error: 'unauthorized' });
  const suggestions = db.prepare(
    "SELECT id, username, body, status, created_at FROM suggestions WHERE status = 'new' ORDER BY id DESC LIMIT 200"
  ).all();
  res.json({ ok: true, suggestions });
});

/* --- Fan spending dashboard + optional monthly cap ---
 * GET returns the fan's net spend (this UTC month + lifetime), the
 * per-category breakdown, top models, and the current cap — all computed
 * read-only from the transactions ledger (see the spending block above
 * chargeFan for exactly what counts). PUT sets/clears the cap: null
 * clears it; otherwise $10–$100,000 in whole cents. Enforcement lives in
 * chargeFan, not here — this route only stores the fan's choice. */
app.get('/api/me/spending', identMiddleware, requireUser, requireRole('fan'), (req, res) => {
  res.json(getFanSpending(req.user.id));
});

app.put('/api/me/spending-cap', identMiddleware, requireUser, requireRole('fan'), (req, res) => {
  const raw = req.body ? req.body.cap_cents : undefined;
  if (raw === null) {
    db.prepare('UPDATE users SET spend_cap_cents = NULL WHERE id = ?').run(req.user.id);
    return res.json({ ok: true, cap_cents: null });
  }
  if (!Number.isInteger(raw) || raw < 1000 || raw > 10000000)
    return res.status(400).json({ error: 'bad_cap',
      message: 'Cap must be a whole-cent amount between $10 and $100,000, or null for no cap.' });
  db.prepare('UPDATE users SET spend_cap_cents = ? WHERE id = ?').run(raw, req.user.id);
  res.json({ ok: true, cap_cents: raw });
});

// Model welcome celebration — mark it seen so it shows exactly once.
app.post('/api/me/welcomed', identMiddleware, requireUser, (req, res) => {
  db.prepare("UPDATE users SET welcomed_at = datetime('now') WHERE id = ? AND welcomed_at IS NULL")
    .run(req.user.id);
  res.json({ ok: true });
});

/* --- Change password (self-service, every role) ---
 * The signed-in user rotates their OWN password: proof of the current
 * password (bcrypt), a policy-checked new one, and every OTHER session
 * for the account is revoked — a login left open anywhere else dies
 * the moment the owner rotates. The caller's own session survives, so
 * nobody is surprise-logged-out of the device in their hand. Guests
 * have no password to change (403 login_required, like reactions). */
const SEED_DEFAULT_PASSWORDS = ['admin123', 'model123', 'fan123', 'password', '12345678'];
app.post('/api/me/change-password', identMiddleware, (req, res) => {
  if (req.ident.kind !== 'user')
    return res.status(403).json({ error: 'login_required' });
  const user = req.ident.user;
  const { current_password, new_password } = req.body || {};
  if (!bcrypt.compareSync(current_password || '', user.password_hash))
    return res.status(401).json({ error: 'wrong_current' });
  const next = typeof new_password === 'string' ? new_password : '';
  // Seed defaults first: they are all shorter than the length floor, so
  // checking length first would make this distinct error unreachable.
  if (SEED_DEFAULT_PASSWORDS.includes(next.toLowerCase()))
    return res.status(400).json({ error: 'default_password' });
  if (next.length < 10 || next.length > 128)
    return res.status(400).json({ error: 'weak_password' });
  if (bcrypt.compareSync(next, user.password_hash))
    return res.status(400).json({ error: 'weak_password' }); // must differ from current
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .run(bcrypt.hashSync(next, 10), user.id);
  const myToken = (req.headers.authorization || '').slice(7);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?').run(user.id, myToken);
  res.json({ ok: true });
});

// Model submits a name change request for admin approval
app.post('/api/model/name-change-request', identMiddleware, requireUser, requireRole('model'), (req, res) => {
  const name = String(req.body?.requested_name || '').trim().slice(0, 40);
  if (!name || name.length < 2)
    return res.status(400).json({ error: 'invalid_name', message: 'Name must be at least 2 characters.' });
  const pending = db.prepare(`SELECT id FROM name_change_requests WHERE user_id = ? AND status = 'pending'`)
    .get(req.user.id);
  if (pending)
    return res.status(409).json({ error: 'already_pending', message: 'You already have a name change pending review.' });
  const id = db.prepare(`INSERT INTO name_change_requests (user_id, requested_name) VALUES (?, ?)`)
    .run(req.user.id, name).lastInsertRowid;
  pushToAdmins({ type: 'name_change:requested', request_id: id,
    user_id: req.user.id, current_name: req.user.display_name, requested_name: name });
  res.json({ ok: true, id });
});

/* ------------------------------------------------------------------ */
/* Conversations + messages (guests allowed, models free to reply)     */
/* ------------------------------------------------------------------ */

/* The ONE place a model's fan-visible online status is decided.
   presence_override 'on' → always online, 'off' → always offline,
   'auto' (default) → her own models.is_online toggle is the truth.
   Display/discovery only: call gates and her own app keep using the raw
   toggle, so an override can never block her from working. */
function effectiveOnline(presenceOverride, realOnline) {
  if (presenceOverride === 'on') return true;
  if (presenceOverride === 'off') return false;
  return !!realOnline;
}

function otherParty(conv, ident) {
  const meIsFanSide = ident.kind === 'user'
    ? conv.fan_id === ident.user.id
    : conv.guest_token === ident.token;
  const otherId = meIsFanSide ? conv.model_id : conv.fan_id;
  if (!otherId) { // guest on the other side (model viewing a guest chat)
    return { id: 0, display_name: 'Guest Fan', role: 'fan', is_online: true,
             per_message_cents: 0, per_minute_cents: 0, per_voice_cents: 0, is_guest: true };
  }
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(otherId);
  const m = u.role === 'model' ? db.prepare('SELECT * FROM models WHERE user_id = ?').get(otherId) : null;
  return { ...getUserPublic(u), is_online: m ? effectiveOnline(u.presence_override, m.is_online) : false,
           photo_url: m ? (m.photo_url || '') : '',
           per_message_cents: m ? m.per_message_cents : 0,
           per_minute_cents: m ? m.per_minute_cents : 0,
           per_voice_cents: m ? m.per_voice_cents : 0 };
}

function convWhere(ident) {
  return ident.kind === 'user'
    ? { sql: '(c.fan_id = ? OR c.model_id = ?)', params: [ident.user.id, ident.user.id] }
    : { sql: 'c.guest_token = ?', params: [ident.token] };
}

function freeRemaining(ident, modelId) {
  const row = db.prepare('SELECT free_used FROM free_trials WHERE subject_key = ? AND model_id = ?')
    .get(subjectKey(ident), modelId);
  return 3 - (row ? row.free_used : 0);
}

// GET /api/conversations — my chats
app.get('/api/conversations', identMiddleware, (req, res) => {
  const { sql, params } = convWhere(req.ident);
  let convs = db.prepare(
    `SELECT c.* FROM conversations c WHERE ${sql} ORDER BY c.updated_at DESC`).all(...params);
  // Fan-side lists never offer the official house account (owner, Oct
  // 17 2026): it is the app itself, not a model you can message. The
  // filter applies only when the requester sits on the FAN side (a fan
  // account or a guest) — the house account's own model inbox and the
  // admin's announcement threads keep it.
  if (req.ident.kind === 'guest' || (req.ident.kind === 'user' && req.ident.user.role === 'fan')) {
    const hid = houseAccountId();
    if (hid) convs = convs.filter((c) => c.model_id !== hid);
  }
  const meId = req.ident.kind === 'user' ? req.ident.user.id : null;
  const out = convs.map((c) => {
    const last = db.prepare(
      'SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1').get(c.id);
    const unread = meId
      ? db.prepare(`SELECT COUNT(*) AS n FROM messages
                    WHERE conversation_id = ? AND sender_id != ? AND is_read = 0`).get(c.id, meId).n
      : db.prepare(`SELECT COUNT(*) AS n FROM messages
                    WHERE conversation_id = ? AND guest_token != ? AND is_read = 0`)
          .get(c.id, req.ident.token).n;
    return { id: c.id, other: otherParty(c, req.ident), last_message: last || null,
             unread_count: unread, is_paused: !!c.is_paused,
             free_remaining: freeRemaining(req.ident, c.model_id),
             updated_at: c.updated_at };
  });
  res.json({ conversations: out });
});

app.get('/api/conversations/:id/messages', identMiddleware, (req, res) => {
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'not_found' });
  const mine = req.ident.kind === 'user'
    ? (conv.fan_id === req.ident.user.id || conv.model_id === req.ident.user.id ||
       req.ident.user.role === 'admin')
    : conv.guest_token === req.ident.token;
  if (!mine) return res.status(403).json({ error: 'forbidden' });
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const before = parseInt(req.query.before) || 0;
  const msgs = db.prepare(`
    SELECT m.*, u.display_name AS sender_name, u.role AS sender_role,
           mi.kind AS media_kind, mi.mime AS media_mime,
           mi.price_cents AS media_price_cents, mi.duration_sec AS media_duration_sec,
           mi.is_explicit AS media_is_explicit
    FROM messages m LEFT JOIN users u ON u.id = m.sender_id
    LEFT JOIN media_items mi ON mi.id = m.media_id
    WHERE m.conversation_id = ? ${before ? 'AND m.id < ?' : ''}
    ORDER BY m.id DESC LIMIT ?`)
    .all(...(before ? [conv.id, before, limit] : [conv.id, limit]));
  const meFanId = req.ident.kind === 'user' && req.ident.user.role === 'fan' ? req.ident.user.id : null;
  const meUid = req.ident.kind === 'user' ? req.ident.user.id : null;
  // Batch-load reactions for the whole page (one query, not N+1)
  const reactionsByMsg = {};
  if (msgs.length) {
    const ids = msgs.map((m) => m.id);
    const rrows = db.prepare(
      `SELECT message_id, user_id, emoji FROM message_reactions
       WHERE message_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`).all(...ids);
    for (const r of rrows) {
      (reactionsByMsg[r.message_id] = reactionsByMsg[r.message_id] || [])
        .push({ emoji: r.emoji, user_id: r.user_id, mine: r.user_id === meUid });
    }
  }
  const shieldViewer = shieldAppliesToIdent(req, req.ident);
  res.json({ messages: msgs.reverse().map((m) => {
    let media = null;
    if (m.media_id) {
      // Unlocked if: I'm the sender, I'm admin, it's free ($0 media is open
      // to everyone), I'm the model in this conversation (mirrors the file
      // routes, which let her play anything in her own thread — e.g. a fan's
      // voice note), or I (fan) unlocked it
      let unlocked = false;
      if (req.ident.kind === 'user') {
        const uid = req.ident.user.id;
        if (req.ident.user.role === 'admin' || m.sender_id === uid) unlocked = true;
        else if (m.media_price_cents === 0) unlocked = true;
        else if (req.ident.user.role === 'model' && conv.model_id === uid) unlocked = true;
        else if (meFanId) {
          unlocked = !!db.prepare('SELECT 1 FROM media_unlocks WHERE media_id = ? AND fan_id = ?')
            .get(m.media_id, meFanId);
        }
      }
      // Pre-purchase shield: FREE media the model flagged explicit is
      // the one chat surface reachable with no purchase at all — for a
      // shielded viewer it renders as a shield tile and its bytes stay
      // gated (file routes enforce the same rule). Priced media needs
      // no shield flag: its locked tile already shows nothing, and an
      // existing unlock record (bought before AV) stays honored.
      let shielded = false;
      if (unlocked && shieldViewer && m.media_price_cents === 0 && m.media_is_explicit &&
          (m.media_kind === 'ppv_image' || m.media_kind === 'ppv_video')) {
        unlocked = false;
        shielded = true;
      }
      media = { id: m.media_id, kind: m.media_kind, price_cents: m.media_price_cents,
                duration_sec: m.media_duration_sec, unlocked,
                is_explicit: !!m.media_is_explicit, shielded };
    }
    const { media_kind, media_mime, media_price_cents, media_duration_sec, media_is_explicit, ...rest } = m;
    return { ...rest, media,
      reactions: reactionsByMsg[m.id] || [],
      edited: !!m.edited_at,
      sender_name: m.sender_name || 'Guest Fan', sender_role: m.sender_role || 'fan' };
  }) });
});

app.post('/api/conversations/:id/read', identMiddleware, (req, res) => {
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'not_found' });
  if (req.ident.kind === 'user') {
    if (conv.fan_id !== req.ident.user.id && conv.model_id !== req.ident.user.id)
      return res.status(403).json({ error: 'forbidden' });
    db.prepare(`UPDATE messages SET is_read = 1
                WHERE conversation_id = ? AND sender_id != ? AND is_read = 0`)
      .run(conv.id, req.ident.user.id);
    const otherKey = conv.fan_id === req.ident.user.id
      ? `u:${conv.model_id}` : (conv.fan_id ? `u:${conv.fan_id}` : `g:${conv.guest_token}`);
    pushToSubject(otherKey, { type: 'chat:read', conversation_id: conv.id });
  } else {
    if (conv.guest_token !== req.ident.token) return res.status(403).json({ error: 'forbidden' });
    db.prepare(`UPDATE messages SET is_read = 1
                WHERE conversation_id = ? AND guest_token IS NULL AND is_read = 0`).run(conv.id);
    pushToSubject(`u:${conv.model_id}`, { type: 'chat:read', conversation_id: conv.id });
  }
  res.json({ ok: true });
});

// POST /api/conversations/start {model_id} — fan or guest opens a chat
app.post('/api/conversations/start', identMiddleware, (req, res) => {
  if (req.ident.kind === 'user' && req.ident.user.role !== 'fan')
    return res.status(403).json({ error: 'fans_only' });
  const model = db.prepare(`
    SELECT u.id FROM users u JOIN models m ON m.user_id = u.id
    WHERE u.id = ? AND u.role = 'model' AND u.banned = 0`).get(req.body.model_id);
  if (!model) return res.status(404).json({ error: 'model_not_found' });
  // The official house account is the app itself, not a model (owner,
  // Oct 17 2026): fans and guests can never open a chat with it. This
  // endpoint only ever serves the fan side of a thread (fans_only gate
  // above), so the block cannot touch admin announcement threads —
  // those are built directly by the broadcast code with the ADMIN as
  // the fan side and a real model as the model side.
  if (isHouseAccountId(model.id))
    return res.status(403).json({ error: 'cannot_message_official',
      message: 'SlutCamp is the app itself — you can\'t message it. Catch us on a live instead! 💋' });
  // Owner rule (Oct 15): a fan can ALWAYS open a chat with a model —
  // her online presence and ID-verification state never gate fan→model
  // texting (verification still gates HER going live + payouts). Region
  // blocks below still apply.
  if (modelRegionBlocked(model.id, geoOfReq(req))) return regionBlocked(res);

  let conv;
  if (req.ident.kind === 'user') {
    conv = db.prepare('SELECT * FROM conversations WHERE fan_id = ? AND model_id = ?')
      .get(req.ident.user.id, model.id);
    if (!conv) {
      const info = db.prepare('INSERT INTO conversations (fan_id, model_id) VALUES (?,?)')
        .run(req.ident.user.id, model.id);
      conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(info.lastInsertRowid);
    }
  } else {
    conv = db.prepare('SELECT * FROM conversations WHERE guest_token = ? AND model_id = ?')
      .get(req.ident.token, model.id);
    if (!conv) {
      const info = db.prepare('INSERT INTO conversations (guest_token, model_id) VALUES (?,?)')
        .run(req.ident.token, model.id);
      conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(info.lastInsertRowid);
    }
  }
  res.json({ conversation: { id: conv.id, other: otherParty(conv, req.ident),
    is_paused: !!maybeAutoUnpause(conv).is_paused, free_remaining: freeRemaining(req.ident, model.id) } });
});

/* --- Safety pause auto-lift: pauses expire 4 hours after they start --- */
const SAFETY_PAUSE_HOURS = 4;
function maybeAutoUnpause(conv) {
  if (!conv.is_paused) return conv;
  if (!conv.paused_at) {
    // Legacy pause with no timestamp — treat as expired so old stuck chats release
    db.prepare(`UPDATE conversations SET is_paused = 0, paused_at = NULL WHERE id = ?`).run(conv.id);
    return { ...conv, is_paused: 0, paused_at: null };
  }
  const pausedMs = new Date(conv.paused_at + 'Z').getTime();
  if (Date.now() - pausedMs >= SAFETY_PAUSE_HOURS * 3600 * 1000) {
    db.prepare(`UPDATE conversations SET is_paused = 0, paused_at = NULL WHERE id = ?`).run(conv.id);
    const keys = [`u:${conv.model_id}`, conv.fan_id ? `u:${conv.fan_id}` : `g:${conv.guest_token}`];
    keys.forEach((k) => pushToSubject(k, { type: 'chat:resumed', conversation_id: conv.id,
      note: 'Safety pause auto-lifted after 4 hours.' }));
    return { ...conv, is_paused: 0, paused_at: null };
  }
  return conv;
}

/*
 * POST /api/messages {conversation_id, body}
 * Flow: paused? → safety scan → free trial? → billing → save → realtime push.
 * Models replying never pay. Guests get 3 free msgs per model, then must sign up.
 */
app.post('/api/messages', identMiddleware, (req, res) => {
  const { conversation_id, body } = req.body || {};
  const text = (body || '').trim().slice(0, 2000);
  if (!text) return res.status(400).json({ error: 'empty_message' });
  if (req.ident.kind === 'user' && req.ident.user.role === 'admin')
    return res.status(403).json({ error: 'admins_cannot_chat' });

  let conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversation_id);
  if (!conv) return res.status(404).json({ error: 'not_found' });
  const mine = req.ident.kind === 'user'
    ? (conv.fan_id === req.ident.user.id || conv.model_id === req.ident.user.id)
    : conv.guest_token === req.ident.token;
  if (!mine) return res.status(403).json({ error: 'forbidden' });
  conv = maybeAutoUnpause(conv);
  if (conv.is_paused)
    return res.status(423).json({ error: 'chat_paused',
      message: '⚠️ This chat is paused by the safety monitor.' });
  // Owner rule (Oct 15): text messages ALWAYS land, whatever her presence
  // or ID-verification state — a fan is never blocked from texting a model
  // for being "offline" (safety pause above, region block below, the
  // safety scan and billing still apply exactly as before).

  const isModelSender = req.ident.kind === 'user' && req.ident.user.role === 'model';

  // Official house account (owner, Oct 17 2026): the fan/guest side of
  // a thread with the app itself can never write — the account is not a
  // model. Scoped to non-model senders only: the house account's own
  // replies in a thread still work (its logged-in experience is
  // unchanged), and admin announcement threads never have the house
  // account on the fan side writing through this endpoint (admins are
  // rejected above with admins_cannot_chat; broadcasts insert directly).
  if (!isModelSender && isHouseAccountId(conv.model_id))
    return res.status(403).json({ error: 'cannot_message_official',
      message: 'SlutCamp is the app itself — you can\'t message it. Catch us on a live instead! 💋' });

  // Region block: a fan/guest in a region the model blocked cannot write to her.
  // (The model herself is never blocked from her own threads.)
  if (!isModelSender && modelRegionBlocked(conv.model_id, geoOfReq(req)))
    return regionBlocked(res);

  /* --- 1. SAFETY SCAN (before billing — blocked messages are never charged) --- */
  const matched = safetyScan(text);
  if (matched) {
    const senderId = req.ident.kind === 'user' ? req.ident.user.id : null;
    const senderName = req.ident.kind === 'user' ? req.ident.user.display_name : 'Guest Fan';
    const senderRole = isModelSender ? 'model' : 'fan';
    const key = subjectKey(req.ident);

    const msgId = db.prepare(
      `INSERT INTO messages (conversation_id, sender_id, guest_token, body, cost_cents, is_flagged)
       VALUES (?,?,?,?,?,1)`).run(
      conv.id, senderId, req.ident.kind === 'guest' ? req.ident.token : null, text, 0
    ).lastInsertRowid;

    db.prepare(`UPDATE conversations SET is_paused = 1, paused_at = datetime('now') WHERE id = ?`).run(conv.id);
    db.prepare(`INSERT INTO safety_incidents
      (conversation_id, sender_id, guest_token, sender_role, sender_name, flagged_text, matched)
      VALUES (?,?,?,?,?,?,?)`).run(
      conv.id, senderId, req.ident.kind === 'guest' ? req.ident.token : null,
      senderRole, senderName, text, matched);

    const totalStrikes = addStrike(key);
    const incident = db.prepare('SELECT * FROM safety_incidents WHERE id = last_insert_rowid()').get();

    const warning = { type: 'chat:paused', conversation_id: conv.id,
      warning: '⚠️ Sharing personal contact info is not allowed. This chat is paused pending review.',
      matched, strikes: totalStrikes };
    // Warn both sides
    pushToSubject(key, warning);
    const otherKey = req.ident.kind === 'user'
      ? (isModelSender
          ? (conv.fan_id ? `u:${conv.fan_id}` : `g:${conv.guest_token}`)
          : `u:${conv.model_id}`)
      : `u:${conv.model_id}`;
    pushToSubject(otherKey, warning);
    // Alert admins
    pushToAdmins({ type: 'safety:incident', incident: { ...incident, total_strikes: totalStrikes } });

    return res.status(200).json({ flagged: true, matched, strikes: totalStrikes,
      auto_flagged: totalStrikes >= 3 });
  }

  /* --- 2. FREE TRIAL / BILLING (fans + guests; models always free) --- */
  let costCents = 0;
  let freeLeft = 0;
  if (!isModelSender) {
    const key = subjectKey(req.ident);
    const trial = db.prepare('SELECT free_used FROM free_trials WHERE subject_key = ? AND model_id = ?')
      .get(key, conv.model_id);
    const used = trial ? trial.free_used : 0;
    if (used < 3) {
      // FREE trial message
      db.prepare(`INSERT INTO free_trials (subject_key, model_id, free_used) VALUES (?,?,1)
                  ON CONFLICT(subject_key, model_id) DO UPDATE SET free_used = free_used + 1`)
        .run(key, conv.model_id);
      freeLeft = 3 - (used + 1);
    } else if (req.ident.kind === 'guest') {
      return res.status(402).json({ error: 'trial_over',
        message: 'Your 3 free messages are used up — sign up and buy credits to keep chatting!' });
    } else {
      const model = db.prepare('SELECT * FROM models WHERE user_id = ?').get(conv.model_id);
      costCents = model.per_message_cents;
      try {
        chargeFan(req.ident.user.id, conv.model_id, costCents, 'message', 'Chat message', clientIp(req));
      } catch (e) {
        return res.status(402).json(chargeErrorBody(e, costCents, req.ident.user.id));
      }
    }
  }

  const msgId = db.prepare(
    'INSERT INTO messages (conversation_id, sender_id, guest_token, body, cost_cents) VALUES (?,?,?,?,?)'
  ).run(conv.id,
        req.ident.kind === 'user' ? req.ident.user.id : null,
        req.ident.kind === 'guest' ? req.ident.token : null,
        text, costCents).lastInsertRowid;
  db.prepare(`UPDATE conversations SET updated_at = datetime('now') WHERE id = ?`).run(conv.id);

  const msg = db.prepare(`
    SELECT m.*, u.display_name AS sender_name, u.role AS sender_role
    FROM messages m LEFT JOIN users u ON u.id = m.sender_id WHERE m.id = ?`).get(msgId);
  const full = { ...msg, sender_name: msg.sender_name || 'Guest Fan',
                 sender_role: msg.sender_role || 'fan',
                 reactions: [], edited: false, edited_at: null };

  // Deliver to the other side
  const otherKey = req.ident.kind === 'user'
    ? (isModelSender
        ? (conv.fan_id ? `u:${conv.fan_id}` : `g:${conv.guest_token}`)
        : `u:${conv.model_id}`)
    : `u:${conv.model_id}`;
  pushToSubject(otherKey, { type: 'chat:new', conversation_id: conv.id, message: full });
  buzzChatRecipient(isModelSender ? conv.fan_id : conv.model_id,
    `💬 ${full.sender_name}`, text.slice(0, 120));

  res.json({ message: full, cost_cents: costCents, free_remaining: freeLeft,
    balance_cents: req.ident.kind === 'user' ? getWallet(req.ident.user.id).credits_cents : null });
});

/* ------------------------------------------------------------------ */
/* Message reactions + 5-minute edit                                    */
/* ------------------------------------------------------------------ */

// The only emojis a reaction can be (exactly these six).
const REACTION_EMOJIS = ['❤️', '😍', '🔥', '😈', '💦', '👏'];
// Clients occasionally drop the U+FE0F variation selector (❤️ → ❤) —
// compare selector-free and always store/return the canonical form.
const canonicalReaction = (e) => {
  if (typeof e !== 'string') return null;
  const bare = e.replace(/️/g, '');
  return REACTION_EMOJIS.find((x) => x.replace(/️/g, '') === bare) || null;
};

function reactionsFor(messageId) {
  return db.prepare(
    'SELECT emoji, user_id FROM message_reactions WHERE message_id = ? ORDER BY id')
    .all(messageId);
}

// WS subject keys for BOTH sides of a conversation (+ an optional extra,
// e.g. the actor, whose fan_id/model_id slot may not cover an admin).
function convPushKeys(conv, extraKey) {
  const keys = new Set([`u:${conv.model_id}`]);
  if (conv.fan_id) keys.add(`u:${conv.fan_id}`);
  else if (conv.guest_token) keys.add(`g:${conv.guest_token}`);
  if (extraKey) keys.add(extraKey);
  return [...keys];
}

/*
 * POST /api/messages/:id/react {emoji}
 * Participant-only (the conversation's fan/model, or an admin). Guests are
 * read-only. One reaction per person per message: same emoji again removes
 * it, a different emoji replaces it, none yet adds it.
 */
app.post('/api/messages/:id/react', identMiddleware, (req, res) => {
  if (req.ident.kind !== 'user')
    return res.status(403).json({ error: 'login_required' }); // guests: read-only
  const emoji = canonicalReaction((req.body || {}).emoji);
  if (!emoji) return res.status(400).json({ error: 'bad_emoji' });
  const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
  if (!msg) return res.status(404).json({ error: 'not_found' });
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(msg.conversation_id);
  const uid = req.ident.user.id;
  const participant = conv && (conv.fan_id === uid || conv.model_id === uid ||
    req.ident.user.role === 'admin');
  if (!participant) return res.status(403).json({ error: 'forbidden' });

  const existing = db.prepare(
    'SELECT * FROM message_reactions WHERE message_id = ? AND user_id = ?').get(msg.id, uid);
  if (existing && existing.emoji === emoji) {
    db.prepare('DELETE FROM message_reactions WHERE id = ?').run(existing.id);
  } else if (existing) {
    db.prepare(`UPDATE message_reactions SET emoji = ?, created_at = datetime('now') WHERE id = ?`)
      .run(emoji, existing.id);
  } else {
    db.prepare('INSERT INTO message_reactions (message_id, user_id, emoji) VALUES (?,?,?)')
      .run(msg.id, uid, emoji);
  }
  const reactions = reactionsFor(msg.id);
  const evt = { type: 'message:reaction', conversation_id: conv.id,
    message_id: msg.id, reactions };
  convPushKeys(conv, `u:${uid}`).forEach((k) => pushToSubject(k, evt));
  res.json({ ok: true,
    reactions: reactions.map((r) => ({ ...r, mine: r.user_id === uid })) });
});

/*
 * POST /api/messages/:id/edit {body}
 * The sender can fix a typo for 5 minutes after sending. Plain text only
 * (no media, no gift payload, no tip/system message, not safety-flagged).
 * Editing never re-charges, never touches read state or cost_cents; the
 * pre-edit body is preserved in message_edits as an audit trail.
 * The new body runs through safetyScan with the SAME consequences as a
 * fresh send: a hit diverts like a flagged send — the edit never lands
 * (original body stays), the chat pauses, an incident + strike are
 * recorded, both sides are warned, admins are alerted, and the client
 * gets the send path's 200 {flagged:true,...} payload. A rejected edit
 * writes no message_edits row: it changes nothing about the message
 * (the attempt itself lives in the incident's flagged_text, as with sends).
 */
const EDIT_WINDOW_MS = 5 * 60 * 1000;
app.post('/api/messages/:id/edit', identMiddleware, (req, res) => {
  if (req.ident.kind !== 'user')
    return res.status(403).json({ error: 'login_required' });
  const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
  if (!msg) return res.status(404).json({ error: 'not_found' });
  if (msg.sender_id !== req.ident.user.id)
    return res.status(403).json({ error: 'not_sender' });
  const isSystem = msg.is_flagged || (msg.body || '').startsWith('💸 Sent a ');
  if (msg.media_id || msg.gift_json || isSystem)
    return res.status(400).json({ error: 'not_editable' });
  const createdMs = new Date(String(msg.created_at).replace(' ', 'T') + 'Z').getTime();
  if (!Number.isFinite(createdMs) || Date.now() - createdMs > EDIT_WINDOW_MS)
    return res.status(403).json({ error: 'edit_window_closed' });
  const text = ((req.body || {}).body || '').trim().slice(0, 2000);
  if (!text) return res.status(400).json({ error: 'empty_message' });

  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(msg.conversation_id);

  /* --- SAFETY SCAN — same scan, same consequences as POST /api/messages.
     A hit diverts exactly like a flagged send (see header comment). --- */
  const matched = safetyScan(text);
  if (matched) {
    const senderRole = req.ident.user.role === 'model' ? 'model' : 'fan';
    const key = subjectKey(req.ident);

    if (conv)
      db.prepare(`UPDATE conversations SET is_paused = 1, paused_at = datetime('now') WHERE id = ?`).run(conv.id);
    db.prepare(`INSERT INTO safety_incidents
      (conversation_id, sender_id, guest_token, sender_role, sender_name, flagged_text, matched)
      VALUES (?,?,?,?,?,?,?)`).run(
      msg.conversation_id, req.ident.user.id, null,
      senderRole, req.ident.user.display_name, text, matched);

    const totalStrikes = addStrike(key);
    const incident = db.prepare('SELECT * FROM safety_incidents WHERE id = last_insert_rowid()').get();

    const warning = { type: 'chat:paused', conversation_id: msg.conversation_id,
      warning: '⚠️ Sharing personal contact info is not allowed. This chat is paused pending review.',
      matched, strikes: totalStrikes };
    pushToSubject(key, warning);
    if (conv) {
      const otherKey = senderRole === 'model'
        ? (conv.fan_id ? `u:${conv.fan_id}` : `g:${conv.guest_token}`)
        : `u:${conv.model_id}`;
      pushToSubject(otherKey, warning);
    }
    pushToAdmins({ type: 'safety:incident', incident: { ...incident, total_strikes: totalStrikes } });

    return res.status(200).json({ flagged: true, matched, strikes: totalStrikes,
      auto_flagged: totalStrikes >= 3 });
  }

  db.prepare('INSERT INTO message_edits (message_id, old_body) VALUES (?,?)')
    .run(msg.id, msg.body);
  db.prepare(`UPDATE messages SET body = ?, edited_at = datetime('now') WHERE id = ?`)
    .run(text, msg.id);
  const fresh = db.prepare('SELECT edited_at FROM messages WHERE id = ?').get(msg.id);

  if (conv) {
    const evt = { type: 'message:edited', conversation_id: conv.id,
      message_id: msg.id, body: text, edited_at: fresh.edited_at };
    convPushKeys(conv, `u:${req.ident.user.id}`).forEach((k) => pushToSubject(k, evt));
  }
  res.json({ ok: true, body: text, edited: true, edited_at: fresh.edited_at });
});

/* ------------------------------------------------------------------ */
/* PPV media + voice notes                                              */
/* ------------------------------------------------------------------ */

const MEDIA_LABELS = {
  ppv_image: '📸 Photo',
  ppv_video: '🎥 Video',
  voice: '🎤 Voice note',
};

// POST /api/media/send (multipart: file + fields conversation_id, kind, price_cents, duration_sec)
// Models attach PPV with a price; fans can send voice notes (billed at her per-voice rate).
app.post('/api/media/send', identMiddleware, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: 'bad_file', message: 'Upload a photo, video, or audio file under 200MB.' });
    if (!req.file) return res.status(400).json({ error: 'no_file' });
    if (req.ident.kind === 'user' && req.ident.user.role === 'admin')
      return res.status(403).json({ error: 'admins_cannot_chat' });

    const conversation_id = parseInt(req.body.conversation_id);
    const kind = req.body.kind;
    if (!['ppv_image', 'ppv_video', 'voice'].includes(kind)) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'bad_kind' });
    }
    const conv0 = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversation_id);
    if (!conv0) { fs.unlink(req.file.path, () => {}); return res.status(404).json({ error: 'not_found' }); }
    let conv = maybeAutoUnpause(conv0);
    const mine = req.ident.kind === 'user'
      ? (conv.fan_id === req.ident.user.id || conv.model_id === req.ident.user.id)
      : conv.guest_token === req.ident.token;
    if (!mine) { fs.unlink(req.file.path, () => {}); return res.status(403).json({ error: 'forbidden' }); }
    if (conv.is_paused) { fs.unlink(req.file.path, () => {}); return res.status(423).json({ error: 'chat_paused' }); }

    const isModelSender = req.ident.kind === 'user' && req.ident.user.role === 'model';
    const isFanSender = !isModelSender;

    // Fans can ONLY send voice notes — no picture/video uploads, ever.
    if (isFanSender && kind !== 'voice') {
      fs.unlink(req.file.path, () => {});
      return res.status(403).json({ error: 'fans_cannot_upload_media' });
    }

    // Price: models set whatever they want for PPV/voice. Fans' voice notes bill at her per-voice rate.
    let priceCents = 0;
    if (isModelSender && kind !== 'voice') {
      priceCents = parseInt(req.body.price_cents) || 0;
      // PPV price: $1–$100, or $0 for a free preview (unlocked for everyone)
      if (priceCents !== 0 && (priceCents < 100 || priceCents > 10000)) { fs.unlink(req.file.path, () => {}); return res.status(400).json({ error: 'bad_price', message: 'PPV price must be $1–$100 (or $0 for a free preview).' }); }
    } else if (isModelSender && kind === 'voice') {
      // Voice notes: pay to SEND, free to LISTEN (owner rule). A model's voice
      // note is stored at price 0 so the fan just plays it — no unlock charge.
      // (Her per_voice_cents is what FANS pay to send HER a voice note.)
      priceCents = 0;
    }
    const durationSec = Math.max(0, Math.min(3600, parseInt(req.body.duration_sec) || 0));
    // Explicit flag (pre-purchase shield): model-set at upload, visual
    // kinds only. Flagged FREE media is shielded for unverified fans in
    // regulated states once AV is configured; unflagged media and all
    // dormant behavior are untouched.
    const isExplicit = isModelSender && kind !== 'voice' &&
      ['1', 'true'].includes(String(req.body.is_explicit || '').toLowerCase()) ? 1 : 0;

    // Fan/guest billing for sending (models send free; a fan voice note bills
    // at the model's per-voice rate, auto-deducted exactly like a text charge)
    let costCents = 0;
    let freeLeft = 0;
    if (isFanSender) {
      const key = subjectKey(req.ident);
      const trial = db.prepare('SELECT free_used FROM free_trials WHERE subject_key = ? AND model_id = ?')
        .get(key, conv.model_id);
      const used = trial ? trial.free_used : 0;
      if (used < 3) {
        db.prepare(`INSERT INTO free_trials (subject_key, model_id, free_used) VALUES (?,?,1)
                    ON CONFLICT(subject_key, model_id) DO UPDATE SET free_used = free_used + 1`)
          .run(key, conv.model_id);
        freeLeft = 3 - (used + 1);
      } else if (req.ident.kind === 'guest') {
        fs.unlink(req.file.path, () => {});
        return res.status(402).json({ error: 'trial_over' });
      } else {
        // Registered fan: charge the model's per-voice rate for a voice note
        // (per_message_cents if the voice rate is somehow absent).
        const model = db.prepare('SELECT per_message_cents, per_voice_cents FROM models WHERE user_id = ?')
          .get(conv.model_id);
        costCents = model ? model.per_message_cents : 0;
        if (model && kind === 'voice' && Number.isInteger(model.per_voice_cents)) {
          costCents = model.per_voice_cents;
        }
        try {
          chargeFan(req.ident.user.id, conv.model_id, costCents, 'voice', 'Voice note', clientIp(req));
        } catch (e) {
          fs.unlink(req.file.path, () => {});
          return res.status(402).json(chargeErrorBody(e, costCents, req.ident.user.id));
        }
      }
    }

    const mediaId = db.prepare(
      `INSERT INTO media_items (conversation_id, sender_id, guest_token, kind, mime, file_path, price_cents, duration_sec, is_explicit)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(conv.id,
          req.ident.kind === 'user' ? req.ident.user.id : null,
          req.ident.kind === 'guest' ? req.ident.token : null,
          kind, req.file.mimetype, req.file.path, priceCents, durationSec, isExplicit).lastInsertRowid;

    const body = priceCents > 0
      ? `${MEDIA_LABELS[kind]} · unlock ${fmt$(priceCents)}`
      : MEDIA_LABELS[kind];
    const msgId = db.prepare(
      'INSERT INTO messages (conversation_id, sender_id, guest_token, body, cost_cents, media_id) VALUES (?,?,?,?,?,?)'
    ).run(conv.id,
          req.ident.kind === 'user' ? req.ident.user.id : null,
          req.ident.kind === 'guest' ? req.ident.token : null,
          body, costCents, mediaId).lastInsertRowid;
    db.prepare(`UPDATE conversations SET updated_at = datetime('now') WHERE id = ?`).run(conv.id);

    const msg = db.prepare(`
      SELECT m.*, u.display_name AS sender_name, u.role AS sender_role
      FROM messages m LEFT JOIN users u ON u.id = m.sender_id WHERE m.id = ?`).get(msgId);
    // The receiver hasn't unlocked priced media — mark it locked for them.
    // A shielded fan receiver (unverified, regulated/unknown state, AV
    // configured) also gets free explicit-flagged media as a shield
    // tile; her location resolves from her stored fan_state here (the
    // request geo is the SENDER's). Guests keep the long-standing push
    // shape — their bytes are login-gated regardless, and the messages
    // GET renders them locked.
    let receiverShielded = false;
    if (priceCents === 0 && isExplicit && conv.fan_id) {
      const fanRow = db.prepare('SELECT * FROM users WHERE id = ?').get(conv.fan_id);
      receiverShielded = shieldAppliesToUserRow(fanRow);
    }
    const receiverMedia = { id: mediaId, kind, price_cents: priceCents,
      duration_sec: durationSec, unlocked: priceCents === 0 && !receiverShielded,
      is_explicit: !!isExplicit, shielded: receiverShielded };
    const full = { ...msg, sender_name: msg.sender_name || 'Guest Fan',
                   sender_role: msg.sender_role || 'fan',
                   media: { ...receiverMedia, unlocked: true, shielded: false },
                   reactions: [], edited: false, edited_at: null }; // sender always sees own

    const otherKey = req.ident.kind === 'user'
      ? (isModelSender
          ? (conv.fan_id ? `u:${conv.fan_id}` : `g:${conv.guest_token}`)
          : `u:${conv.model_id}`)
      : `u:${conv.model_id}`;
    const receiverMsg = { ...full, media: receiverMedia };
    pushToSubject(otherKey, { type: 'chat:new', conversation_id: conv.id, message: receiverMsg });
    buzzChatRecipient(isModelSender ? conv.fan_id : conv.model_id,
      `💬 ${full.sender_name}`, MEDIA_LABELS[kind] || 'New message');

    res.json({ message: full, cost_cents: costCents, free_remaining: freeLeft,
      balance_cents: req.ident.kind === 'user' ? getWallet(req.ident.user.id).credits_cents : null });
  });
});

// POST /api/media/:id/unlock — fan pays the model's price to view/listen
app.post('/api/media/:id/unlock', identMiddleware, requireUser, requireRole('fan'), (req, res) => {
  const media = db.prepare('SELECT * FROM media_items WHERE id = ?').get(req.params.id);
  if (!media) return res.status(404).json({ error: 'not_found' });
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(media.conversation_id);
  if (!conv || conv.fan_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });
  if (modelRegionBlocked(conv.model_id, geoOfReq(req))) return regionBlocked(res);

  const already = db.prepare('SELECT 1 FROM media_unlocks WHERE media_id = ? AND fan_id = ?')
    .get(media.id, req.user.id);
  if (already || media.price_cents === 0)
    return res.json({ ok: true, already: true, file_url: `/api/media/${media.id}/file` });

  const type = media.kind === 'voice' ? 'voice' : 'ppv';
  try {
    chargeFan(req.user.id, conv.model_id, media.price_cents, type,
      `${MEDIA_LABELS[media.kind]} unlock`, clientIp(req));
  } catch (e) {
    return res.status(402).json(chargeErrorBody(e, media.price_cents, req.user.id));
  }
  db.prepare('INSERT OR IGNORE INTO media_unlocks (media_id, fan_id) VALUES (?,?)')
    .run(media.id, req.user.id);

  // Let the model know someone unlocked (nice dopamine hit + earnings update)
  pushToUser(conv.model_id, { type: 'media:unlocked', conversation_id: conv.id,
    media_id: media.id, kind: media.kind, amount_cents: media.price_cents });

  res.json({ ok: true, file_url: `/api/media/${media.id}/file`,
    balance_cents: getWallet(req.user.id).credits_cents });
});

// One-time file tokens: <img>/<video>/<audio> tags can't send Authorization
// headers, so the client fetches a short-lived token first, then uses ?t=
const fileTokens = new Map(); // token -> {mediaId, userId, expires}
setInterval(() => {
  const now = Date.now();
  for (const [t, v] of fileTokens) if (v.expires < now) fileTokens.delete(t);
}, 60 * 1000);

app.post('/api/media/:id/file-token', identMiddleware, (req, res) => {
  const media = db.prepare('SELECT * FROM media_items WHERE id = ?').get(req.params.id);
  if (!media) return res.status(404).json({ error: 'not_found' });
  if (req.ident.kind !== 'user') return res.status(401).json({ error: 'login_required' });
  const uid = req.ident.user.id;
  let allowed = false;
  if (req.ident.user.role === 'admin' || media.sender_id === uid) allowed = true;
  else if (req.ident.user.role === 'fan') {
    allowed = !!db.prepare('SELECT 1 FROM media_unlocks WHERE media_id = ? AND fan_id = ?')
      .get(media.id, uid) || media.price_cents === 0;
  } else if (req.ident.user.role === 'model') {
    const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(media.conversation_id);
    if (conv && conv.model_id === uid) allowed = true;
  }
  if (!allowed) return res.status(403).json({ error: 'locked' });
  // Shield byte-gate: free explicit-flagged media stays unservable to a
  // shielded fan even though its price is $0 (mirrors the payload rule).
  if (media.is_explicit && media.price_cents === 0 && media.sender_id !== uid &&
      shieldLib.fanShielded(req.ident.user, shieldLocForUser(req, req.ident.user)))
    return res.status(403).json({ error: 'av_required' });
  const token = crypto.randomBytes(24).toString('hex');
  // Media elements (esp. iOS AVFoundation) make MULTIPLE requests per playback
  // (probe + range fetches + play), so the token must stay valid until expiry —
  // single-use tokens made every phone playback fail with "Error" (Oct 14 bug).
  fileTokens.set(token, { mediaId: media.id, userId: uid, expires: Date.now() + 10 * 60 * 1000 });
  res.json({ token, url: `/api/media/${media.id}/file?t=${token}` });
});

// GET /api/media/:id/file — serve bytes only to: sender, unlocked fan, or admin
app.get('/api/media/:id/file', (req, res) => {
  const media = db.prepare('SELECT * FROM media_items WHERE id = ?').get(req.params.id);
  if (!media || !fs.existsSync(media.file_path)) return res.status(404).json({ error: 'not_found' });

  // Token path (for <img>/<video>/<audio> tags)
  if (req.query.t) {
    const ft = fileTokens.get(req.query.t);
    if (!ft || ft.mediaId !== media.id || ft.expires < Date.now())
      return res.status(403).json({ error: 'bad_token' });
    // NOT deleted on use: players re-request (ranges, seeks, retries) with the
    // same token until it expires. sendFile gives us 206 Range support, which
    // iOS audio/video playback requires.
    res.setHeader('Content-Type', media.mime);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    return res.sendFile(path.resolve(media.file_path));
  }

  // Header path (fetch API)
  const ident = getIdentity(req);
  if (!ident || ident.kind !== 'user') return res.status(401).json({ error: 'login_required' });
  const uid = ident.user.id;
  let allowed = false;
  if (ident.user.role === 'admin' || media.sender_id === uid) allowed = true;
  else if (ident.user.role === 'fan') {
    allowed = !!db.prepare('SELECT 1 FROM media_unlocks WHERE media_id = ? AND fan_id = ?')
      .get(media.id, uid) || media.price_cents === 0;
  } else if (ident.user.role === 'model') {
    const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(media.conversation_id);
    if (conv && conv.model_id === uid) allowed = true;
  }
  if (!allowed) return res.status(403).json({ error: 'locked',
    message: '🔒 Unlock this to view.' });
  // Shield byte-gate (same rule as the token route): free
  // explicit-flagged media is not served to a shielded fan.
  if (media.is_explicit && media.price_cents === 0 && media.sender_id !== uid &&
      shieldLib.fanShielded(ident.user, shieldLocForUser(req, ident.user)))
    return res.status(403).json({ error: 'av_required' });
  res.setHeader('Content-Type', media.mime);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  return res.sendFile(path.resolve(media.file_path));
});

// POST /api/media/:id/explicit — the model's media-manager control for
// the shield flag: she marks (or unmarks) her OWN sent photo/video as
// explicit. Flagged free media is shielded for unverified fans in
// regulated states once AV is configured.
app.post('/api/media/:id/explicit', identMiddleware, requireUser, requireRole('model'), (req, res) => {
  const media = db.prepare('SELECT * FROM media_items WHERE id = ?').get(req.params.id);
  if (!media) return res.status(404).json({ error: 'not_found' });
  if (media.sender_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });
  if (media.kind === 'voice') return res.status(400).json({ error: 'voice_not_visual' });
  const on = req.body && (req.body.explicit === true || req.body.explicit === 1 ||
    req.body.explicit === '1' || req.body.explicit === 'true') ? 1 : 0;
  db.prepare('UPDATE media_items SET is_explicit = ? WHERE id = ?').run(on, media.id);
  res.json({ ok: true, is_explicit: on });
});

/* ------------------------------------------------------------------ */
/* Tipping                                                               */
/* ------------------------------------------------------------------ */

// POST /api/tips {conversation_id, amount_cents} — fan tips the model, any amount
app.post('/api/tips', identMiddleware, requireUser, requireRole('fan'), (req, res) => {
  const amountCents = parseInt(req.body.amount_cents);
  if (!Number.isInteger(amountCents) || amountCents < 100 || amountCents > 100000)
    return res.status(400).json({ error: 'bad_amount',
      message: 'Tips must be between $1 and $1,000.' });
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.body.conversation_id);
  if (!conv || conv.fan_id !== req.user.id) return res.status(404).json({ error: 'not_found' });

  try {
    chargeFan(req.user.id, conv.model_id, amountCents, 'tip', 'Fan tip', clientIp(req));
  } catch (e) {
    return res.status(402).json(chargeErrorBody(e, amountCents, req.user.id));
  }

  // Drop a system message in the chat so both sides see it
  const msgId = db.prepare(
    `INSERT INTO messages (conversation_id, sender_id, body, cost_cents) VALUES (?,?,?,0)`
  ).run(conv.id, req.user.id, `💸 Sent a ${fmt$(amountCents)} tip! Thank you! 🙏`).lastInsertRowid;
  const msg = db.prepare(`
    SELECT m.*, u.display_name AS sender_name, u.role AS sender_role
    FROM messages m LEFT JOIN users u ON u.id = m.sender_id WHERE m.id = ?`).get(msgId);
  const full = { ...msg, sender_name: msg.sender_name, sender_role: msg.sender_role, is_tip: true };
  pushToSubject(`u:${conv.model_id}`, { type: 'chat:new', conversation_id: conv.id, message: full });
  pushToSubject(`u:${req.user.id}`, { type: 'chat:new', conversation_id: conv.id, message: full });

  res.json({ ok: true, amount_cents: amountCents,
    balance_cents: getWallet(req.user.id).credits_cents });
});

/* ------------------------------------------------------------------ */
/* Follows + notifications + tip menu                                 */
/* ------------------------------------------------------------------ */

// Web Push: public VAPID key (null until configured — see sendWebPush notes)
app.get('/api/push/vapid-key', (req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY || null });
});

// Fan: toggle follow on a model (for "she's live" notifications)
app.post('/api/follows/:modelId', identMiddleware, requireUser, requireRole('fan'), (req, res) => {
  const modelId = parseInt(req.params.modelId);
  const model = db.prepare('SELECT id FROM users WHERE id = ? AND role = ?').get(modelId, 'model');
  if (!model) return res.status(404).json({ error: 'model_not_found' });
  const existing = db.prepare('SELECT id FROM follows WHERE fan_id = ? AND model_id = ?')
    .get(req.user.id, modelId);
  if (existing) {
    db.prepare('DELETE FROM follows WHERE id = ?').run(existing.id);
    return res.json({ following: false });
  }
  db.prepare('INSERT INTO follows (fan_id, model_id) VALUES (?,?)').run(req.user.id, modelId);
  res.json({ following: true });
});

// Fan: list of model ids they follow
app.get('/api/follows', identMiddleware, requireUser, requireRole('fan'), (req, res) => {
  const rows = db.prepare('SELECT model_id FROM follows WHERE fan_id = ?').all(req.user.id);
  res.json({ following: rows.map((r) => r.model_id) });
});

// Notifications: list (newest first)
app.get('/api/notifications', identMiddleware, requireUser, (req, res) => {
  const rows = db.prepare(
    `SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50`).all(req.user.id);
  const unread = db.prepare(
    `SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read = 0`).get(req.user.id).c;
  res.json({ notifications: rows, unread });
});

// Notifications: mark read (all, or { ids: [...] })
app.post('/api/notifications/read', identMiddleware, requireUser, (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map((x) => parseInt(x)).filter(Number.isInteger) : null;
  if (ids && ids.length) {
    const ph = ids.map(() => '?').join(',');
    db.prepare(`UPDATE notifications SET read = 1 WHERE user_id = ? AND id IN (${ph})`)
      .run(req.user.id, ...ids);
  } else {
    db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ?').run(req.user.id);
  }
  res.json({ ok: true });
});

// Web Push: save a browser subscription (called from the frontend after permission)
app.post('/api/push/subscribe', identMiddleware, requireUser, (req, res) => {
  const { endpoint, p256dh, auth } = req.body || {};
  if (!endpoint || typeof endpoint !== 'string' || endpoint.length > 2000)
    return res.status(400).json({ error: 'bad_subscription' });
  db.prepare(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
              VALUES (?,?,?,?)
              ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id,
                p256dh = excluded.p256dh, auth = excluded.auth`)
    .run(req.user.id, endpoint, String(p256dh || '').slice(0, 500), String(auth || '').slice(0, 500));
  res.json({ ok: true, web_push_ready: !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) });
});

// Web Push: remove a subscription
app.post('/api/push/unsubscribe', identMiddleware, requireUser, (req, res) => {
  const { endpoint } = req.body || {};
  if (endpoint) db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?')
    .run(req.user.id, endpoint);
  res.json({ ok: true });
});

// Tip menu: public read (anyone can see a model's menu)
// Default tip menu for models who haven't set their own (Corry: "models are lazy")
const DEFAULT_TIP_MENU = [
  { emoji: '💋', label: 'Blow a kiss', price_cents: 500 },
  { emoji: '🎵', label: 'Song request', price_cents: 1000 },
  { emoji: '💃', label: 'Twerk for you', price_cents: 2500 },
  { emoji: '👙', label: 'Outfit change', price_cents: 3000 },
  { emoji: '🔥', label: 'Spicy pic', price_cents: 5000 },
];
app.get('/api/models/:id/tip-menu', (req, res) => {
  const modelId = parseInt(req.params.id);
  let items = db.prepare(
    `SELECT id, emoji, label, price_cents FROM tip_menus WHERE model_id = ? ORDER BY sort_order, id`)
    .all(modelId);
  if (!items.length) items = DEFAULT_TIP_MENU.map((t, i) => ({ id: 'default-' + i, ...t }));
  res.json({ items });
});

// Tip menu: model creates an item
app.post('/api/model/tip-menu', identMiddleware, requireUser, requireRole('model'), (req, res) => {
  const emoji = String(req.body.emoji || '💰').slice(0, 8);
  const label = String(req.body.label || '').trim().slice(0, 60);
  const priceCents = parseInt(req.body.price_cents);
  if (!label) return res.status(400).json({ error: 'bad_label' });
  if (!Number.isInteger(priceCents) || priceCents < 100 || priceCents > 100000)
    return res.status(400).json({ error: 'bad_price', message: 'Price must be $1–$1,000.' });
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM tip_menus WHERE model_id = ?')
    .get(req.user.id).m;
  const info = db.prepare(
    `INSERT INTO tip_menus (model_id, emoji, label, price_cents, sort_order) VALUES (?,?,?,?,?)`)
    .run(req.user.id, emoji, label, priceCents, maxOrder + 1);
  res.json({ ok: true, id: Number(info.lastInsertRowid) });
});

// Tip menu: model updates an item
app.put('/api/model/tip-menu/:id', identMiddleware, requireUser, requireRole('model'), (req, res) => {
  const item = db.prepare('SELECT * FROM tip_menus WHERE id = ? AND model_id = ?')
    .get(req.params.id, req.user.id);
  if (!item) return res.status(404).json({ error: 'not_found' });
  const emoji = req.body.emoji !== undefined ? String(req.body.emoji).slice(0, 8) : item.emoji;
  const label = req.body.label !== undefined ? String(req.body.label).trim().slice(0, 60) : item.label;
  const priceCents = req.body.price_cents !== undefined ? parseInt(req.body.price_cents) : item.price_cents;
  if (!label) return res.status(400).json({ error: 'bad_label' });
  if (!Number.isInteger(priceCents) || priceCents < 100 || priceCents > 100000)
    return res.status(400).json({ error: 'bad_price' });
  db.prepare('UPDATE tip_menus SET emoji = ?, label = ?, price_cents = ? WHERE id = ?')
    .run(emoji, label, priceCents, item.id);
  res.json({ ok: true });
});

// Tip menu: model deletes an item
app.delete('/api/model/tip-menu/:id', identMiddleware, requireUser, requireRole('model'), (req, res) => {
  const r = db.prepare('DELETE FROM tip_menus WHERE id = ? AND model_id = ?')
    .run(req.params.id, req.user.id);
  if (!r.changes) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

/* ---------------- Region blocker: options + model CRUD ---------------- */
// Option lists for the blocker UI (countries + US states always; counties/cities per pick)
app.get('/api/geo/options', identMiddleware, requireUser, requireRole('model', 'admin'), (req, res) => {
  const state = String(req.query.state || '').toUpperCase();
  const county = String(req.query.county || '');
  const out = {
    countries: geoLib.COUNTRIES.map(([code, name]) => ({ code, name })),
    states: Object.entries(geoLib.US_STATES).map(([code, name]) => ({ code, name })),
  };
  if (state && geoLib.US_STATES[state]) {
    out.counties = geoLib.countiesFor(state);
    out.cities = county && out.counties.includes(county)
      ? geoLib.citiesFor(state, county)
      : geoLib.citiesForState(state);
  }
  res.json(out);
});

app.get('/api/model/region-blocks', identMiddleware, requireUser, requireRole('model'), (req, res) => {
  const blocks = db.prepare('SELECT * FROM model_region_blocks WHERE model_id = ? ORDER BY id').all(req.user.id);
  res.json({ blocks });
});

app.post('/api/model/region-blocks', identMiddleware, requireUser, requireRole('model'), (req, res) => {
  const level = String(req.body.level || '');
  if (!['country', 'state', 'county', 'city'].includes(level))
    return res.status(400).json({ error: 'bad_level' });
  const country = String(req.body.country_code || 'US').toUpperCase().slice(0, 2);
  let state = req.body.state_code ? String(req.body.state_code).toUpperCase().slice(0, 2) : null;
  let county = req.body.county_name ? String(req.body.county_name).trim().slice(0, 80) : null;
  let city = req.body.city_name ? String(req.body.city_name).trim().slice(0, 80) : null;
  if (!geoLib.COUNTRY_NAMES[country]) return res.status(400).json({ error: 'bad_country' });
  if (level === 'country') { state = null; county = null; city = null; }
  else if (country === 'US') {
    if (!state || !geoLib.US_STATES[state]) return res.status(400).json({ error: 'bad_state' });
    if (level === 'county' && (!county || !geoLib.countiesFor(state).includes(county)))
      return res.status(400).json({ error: 'bad_county' });
  } else {
    // State/county granularity is US-only; other countries: city or whole country.
    if (level === 'state' || level === 'county')
      return res.status(400).json({ error: 'us_only_level',
        message: 'State and county blocking is for the United States. For other countries, block the city or the whole country.' });
    state = null; county = null;
  }
  if (level === 'state') { county = null; city = null; }
  if (level === 'county') city = null;
  if (level === 'city' && (!city || city.length < 2))
    return res.status(400).json({ error: 'bad_city' });
  if (level !== 'city') city = null;
  const count = db.prepare('SELECT COUNT(*) AS n FROM model_region_blocks WHERE model_id = ?').get(req.user.id).n;
  if (count >= 200) return res.status(400).json({ error: 'too_many', message: 'You can block up to 200 regions.' });
  const dup = db.prepare(`SELECT id FROM model_region_blocks WHERE model_id = ? AND level = ?
    AND country_code IS ? AND state_code IS ? AND county_name IS ? AND city_name IS ?`)
    .get(req.user.id, level, country, state, county, city);
  if (dup) return res.status(409).json({ error: 'already_blocked', message: 'That region is already blocked.' });
  const countryName = geoLib.COUNTRY_NAMES[country];
  const label = level === 'country' ? countryName
    : level === 'state' ? `${geoLib.US_STATES[state]}, USA`
    : level === 'county' ? `${county} ${state === 'LA' ? 'Parish' : 'County'}, ${state}`
    : country === 'US' ? `${city}, ${state}` : `${city}, ${countryName}`;
  const info = db.prepare(`INSERT INTO model_region_blocks
    (model_id, level, country_code, state_code, county_name, city_name, label)
    VALUES (?,?,?,?,?,?,?)`).run(req.user.id, level, country, state, county, city, label);
  res.json({ ok: true, id: Number(info.lastInsertRowid), label });
});

app.delete('/api/model/region-blocks/:id', identMiddleware, requireUser, requireRole('model'), (req, res) => {
  const r = db.prepare('DELETE FROM model_region_blocks WHERE id = ? AND model_id = ?')
    .run(req.params.id, req.user.id);
  if (!r.changes) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

// POST /api/models/:id/tip — fan buys a tip-menu item { menu_id, context: 'profile'|'live'|'chat' }
app.post('/api/models/:id/tip', identMiddleware, requireUser, requireRole('fan'), (req, res) => {
  const modelId = parseInt(req.params.id);
  const model = db.prepare('SELECT * FROM users WHERE id = ? AND role = ?').get(modelId, 'model');
  if (!model) return res.status(404).json({ error: 'model_not_found' });
  if (modelRegionBlocked(modelId, geoOfReq(req))) return regionBlocked(res);
  let item = db.prepare('SELECT * FROM tip_menus WHERE id = ? AND model_id = ?')
    .get(req.body.menu_id, modelId);
  if (!item && String(req.body.menu_id).startsWith('default-')) {
    const idx = parseInt(String(req.body.menu_id).replace('default-', ''));
    const d = DEFAULT_TIP_MENU[idx];
    if (d) item = { id: req.body.menu_id, model_id: modelId, ...d };
  }
  if (!item) return res.status(404).json({ error: 'menu_item_not_found' });
  const context = ['live', 'chat', 'profile'].includes(req.body.context) ? req.body.context : 'profile';

  try {
    chargeFan(req.user.id, modelId, item.price_cents, 'tip_menu',
      `💰 ${item.emoji} ${item.label}`, clientIp(req));
  } catch (e) {
    if (e.message === 'insufficient_credits' || e.message === 'spend_cap_reached')
      return res.status(402).json(chargeErrorBody(e, item.price_cents, req.user.id));
    throw e;
  }
  db.prepare(`INSERT INTO tip_sends (fan_id, model_id, menu_id, price_cents, context)
              VALUES (?,?,?,?,?)`)
    .run(req.user.id, modelId, item.id, item.price_cents, context);

  // Notify the model (in-app + WS). Fans don't need a row for their own tip.
  const tipLang = userLang(modelId);
  notifyUser(modelId, 'tip', srv('bell_tip_title', tipLang,
      { fan: req.user.display_name || 'A fan', emoji: item.emoji, label: item.label }),
    srv('bell_tip_body', tipLang, { amount: fmt$(item.price_cents) }), null);
  pushToUser(modelId, { type: 'tip:received', fan_id: req.user.id,
    fan_name: req.user.display_name || 'A fan',
    emoji: item.emoji, label: item.label, price_cents: item.price_cents, context });

  res.json({ ok: true, emoji: item.emoji, label: item.label, price_cents: item.price_cents,
    balance_cents: getWallet(req.user.id).credits_cents });
});

/* ------------------------------------------------------------------ */
/* Credits (STUBBED — CCBill/Segpay plugs in here later)               */
/* ------------------------------------------------------------------ */

const CREDIT_PACKAGES = [
  { id: 'p10',  credits_cents: 1000,  price_cents: 1000,  label: '$10',  descriptor: '10 credits for SlutCamp' },
  { id: 'p25',  credits_cents: 2500,  price_cents: 2500,  label: '$25',  descriptor: '25 credits for SlutCamp' },
  { id: 'p50',  credits_cents: 5000,  price_cents: 5000,  label: '$50',  descriptor: '50 credits for SlutCamp' },
  { id: 'p100', credits_cents: 10000, price_cents: 10000, label: '$100', descriptor: '100 credits for SlutCamp' },
];

/* ------------------------------------------------------------------ */
/* Fraud protection: purchase velocity checks                          */
/* ------------------------------------------------------------------ */

// Returns { ok:true } or { ok:false, error, message }. Every attempt (blocked
// or not) is logged to purchase_attempts by the caller.
function checkPurchaseVelocity(userId, amountCents, cardFingerprint) {
  // 1. More than 3 attempts in 10 minutes → block
  const recent = db.prepare(`SELECT COUNT(*) AS c FROM purchase_attempts
    WHERE user_id = ? AND created_at > datetime('now', '-10 minutes')`).get(userId).c;
  if (recent >= 3) return { ok: false, error: 'too_many_attempts',
    message: 'Too many purchase attempts. Please wait 10 minutes and try again.' };
  // 2. New accounts (< 7 days old): max $500 in completed purchases per 24h
  const u = db.prepare('SELECT created_at FROM users WHERE id = ?').get(userId);
  if (u) {
    const ageDays = (Date.now() - new Date(u.created_at + 'Z').getTime()) / 86400000;
    if (ageDays < 7) {
      const spent24 = db.prepare(`SELECT COALESCE(SUM(amount_cents), 0) AS s FROM purchase_attempts
        WHERE user_id = ? AND status = 'completed' AND created_at > datetime('now', '-1 day')`).get(userId).s;
      if (spent24 + amountCents > 50000) return { ok: false, error: 'new_account_limit',
        message: 'New accounts are limited to $500 in purchases per day.' };
    }
  }
  // 3. Same card failing 3x in an hour → 1-hour cooldown
  if (cardFingerprint) {
    const fails = db.prepare(`SELECT COUNT(*) AS c FROM purchase_attempts
      WHERE card_fingerprint = ? AND status = 'failed'
      AND created_at > datetime('now', '-1 hour')`).get(cardFingerprint).c;
    if (fails >= 3) return { ok: false, error: 'card_cooldown',
      message: 'This payment method has failed too many times. Please wait 1 hour and try again.' };
  }
  return { ok: true };
}

function logPurchaseAttempt(userId, pkg, amountCents, cardFingerprint, ip, status, note) {
  db.prepare(`INSERT INTO purchase_attempts
    (user_id, package_id, amount_cents, card_fingerprint, ip, status, note)
    VALUES (?,?,?,?,?,?,?)`)
    .run(userId, pkg ? pkg.id : null, amountCents, cardFingerprint, ip, status, note || null);
}

// Model independent-contractor agreement (served to models for signing)
const CONTRACT_VERSION = '1.4';
const MODEL_CONTRACT = {
  version: CONTRACT_VERSION,
  updated: 'October 16, 2026',
  sections: [
    {
      title: '1. Parties',
      body: 'This Model Agreement ("Agreement") is between you, the performer ("Performer"), and World of Godz Entertainment LLC ("Company"), doing business as SlutCamp ("SlutCamp"). By signing, you agree to everything below.',
    },
    {
      title: '2. Independent Contractor',
      body: 'You are an INDEPENDENT CONTRACTOR, not an employee of the Company. Nothing in this Agreement creates an employment, partnership, or agency relationship. You are responsible for your own taxes, insurance, and business expenses. The Company will not withhold taxes from your payouts, and you agree to report all income as required by law.',
    },
    {
      title: '3. Age & Identity Verification',
      body: 'You confirm you are at least 18 years old. You have completed (or will complete) government ID verification with SlutCamp before going live, as required for 18 U.S.C. §2257 recordkeeping compliance. If you cannot verify your age and identity, you may not perform on the platform.',
    },
    {
      title: '4. Revenue Split & Your Rates',
      body: 'You keep 60% of everything fans spend on you (chats, calls, gifts, live access, priority messages, stage joins, bookings). The Company keeps 40%. You set your own rates inside the app within the allowed ranges: per-message, per-minute video, per voice note, and your explicit stage-join rates ($5–$100). The Company may change the platform-wide defaults or allowed ranges at any time.',
    },
    {
      title: '5. Payouts',
      body: 'You add your bank details in the app and request withdrawals of your available balance at any time. Payouts are processed manually by SlutCamp on the Company\'s own schedule — there is no guaranteed payout date. Pending withdrawal requests may take several business days. Your available balance only includes earnings that have cleared the payout window described in section 13.',
    },
    {
      title: '6. Content Rights',
      body: 'You keep ownership of the content you create on the platform. By posting or streaming on SlutCamp, you grant the Company a worldwide, royalty-free license to use, display, reproduce, and promote that content on the platform and in Company marketing (including social media and ads). You confirm you have the right to grant this license and that your content does not infringe anyone else\'s rights.',
    },
    {
      title: '7. Conduct Rules',
      body: 'On the platform you must NOT: share contact information or payment handles with fans; attempt to take fans or transactions off-platform; use hate speech or slurs; post content featuring anyone under 18 or anyone who has not consented. Breaking these rules can get your messages blocked, your account suspended, or your account deactivated — and you may forfeit pending earnings at the Company\'s discretion.',
    },
    {
      title: '8. Account Access',
      body: 'Model accounts are invite-only. The Company may suspend or deactivate your account at any time, for any reason, with or without notice. If deactivated, any earned balance that has not been paid out remains available for you to withdraw.',
    },
    {
      title: '9. Confidentiality',
      body: 'You agree not to disclose the Company\'s business methods, commission structures, or internal operations, or any other model\'s personal information or any fan\'s personal data, to anyone outside the Company.',
    },
    {
      title: '10. Non-Circumvention',
      body: 'For 12 months after your account ends (for any reason), you agree not to directly solicit fans you met through SlutCamp to use a competing paid-chat or cam service instead of the platform. Normal public promotion of your own brand (social media, etc.) is fine — this only covers targeted poaching of SlutCamp fans.',
    },
    {
      title: '11. Termination',
      body: 'Either side can end this Agreement at any time. You can stop using the platform whenever you want. If the Company deactivates your account, this Agreement ends immediately, except the confidentiality, non-circumvention, and content-rights sections, which survive termination.',
    },
    {
      title: '12. Scheduled 1-on-1s & the FaceTime Waiting List',
      body: 'You control your own 1-on-1 schedule: you set the days and hours when you take private 1-on-1 bookings, and how many you accept per day and per week. A confirmed booking reserves your time for that fan. The platform will send you reminder notices before each booking — 3 days before, 3 hours before, and 15 minutes before. You must start a booked 1-on-1 within 5 minutes of its scheduled start time. If you do not start in time, the fan is automatically refunded in full and receives an apology from the platform, and that booking pays you nothing. If you start on time and the fan does not join within 3 minutes, that is a fan no-show: the fan receives no refund, and the booking is paid to you as earned. You may also get FaceTime requests while you are busy: when you accept a request during another call, the fan joins your waiting list and can see his place in line and his estimated wait. When your call ends, the next fan in line gets a 90-second window to join. By accepting a request, you commit to taking that fan\'s call when his turn comes.',
    },
    {
      title: '13. Payout Holds, Chargeback Reversals & Fraud',
      body: 'PAYOUT HOLD: Your earnings become eligible for withdrawal 7 days after they are earned — your money runs one week behind what you make. The app shows your available balance separately from earnings still inside their window. The Company publishes the current window in the app and may change it with notice in the app; earnings already inside their window keep the window they started with. CHARGEBACK REVERSALS: Fans pay with prepaid credits. If a fan\'s credit purchase is charged back, refunded, or otherwise reversed by their bank or card issuer, the Company may reverse the money in this order: (1) the fan\'s unspent credits from that purchase; (2) your unpaid earnings from that fan — earnings still inside their payout window first, then earnings that already cleared it; and (3) any amount left over becomes a negative adjustment on your account, which is taken out of your future earnings before anything new becomes withdrawable. Earnings you have already properly withdrawn are never collected back from you out of pocket. If a chargeback exceeds the unpaid earnings that can be reversed under (1) and (2) — including because you already withdrew the earnings it relates to — the difference becomes a balance you owe the Company. That balance is recovered automatically: the system deducts it from your future earnings before anything new becomes withdrawable, until it is repaid in full. You are never required to make a manual or out-of-pocket payment for a chargeback shortfall. This paragraph does not protect fraud — fraudulently obtained earnings are forfeited under the FRAUD rules that follow. FRAUD: Coordinated purchasing, self-dealing (buying from yourself or through accounts you control), chargeback schemes, or any other scheme to manufacture earnings or payouts is fraud, in addition to the conduct rules in section 7. For fraud, the Company may place payouts on hold or under review, reverse earnings, and terminate accounts; fraudulently obtained earnings are forfeited.',
    },
    {
      title: '14. Governing Law & Venue',
      body: 'This Agreement is governed by the laws of the State of Texas, without regard to its conflict-of-laws rules. Any dispute arising out of or relating to this Agreement must be brought in the state or federal courts located in Texas, and you and the Company consent to the personal jurisdiction and venue of those courts. Nothing in this section waives or limits any right your home state gives you that cannot legally be waived.',
    },
    {
      title: '15. Plain-Language Disclaimer',
      body: 'This is a plain-language summary written for clarity — it is NOT legal advice, and it has not been reviewed by an attorney. The Company strongly recommends you have your own attorney review this Agreement before signing. If any part of this Agreement is found unenforceable, the rest still applies.',
    },
  ],
};

/* Recruiter agreement — for models/partners who recruit other models */
const RECRUITER_CONTRACT_VERSION = 'R1.3';
const RECRUITER_CONTRACT = {
  version: RECRUITER_CONTRACT_VERSION,
  updated: 'October 16, 2026',
  sections: [
    {
      title: '1. Parties',
      body: 'This Recruiter Agreement ("Agreement") is between you ("Recruiter") and World of Godz Entertainment LLC ("Company"), doing business as SlutCamp ("SlutCamp"). By signing, you agree to everything below.',
    },
    {
      title: '2. Independent Contractor — Not a Partner',
      body: 'You are an INDEPENDENT CONTRACTOR, not an employee of the Company. Nothing in this Agreement creates an employment relationship, a legal business partnership, or an agency relationship — "partner" is just what we call the role in the app. You are responsible for your own taxes, insurance, and expenses. The Company will not withhold taxes from your payouts.',
    },
    {
      title: '3. What You Do',
      body: 'You recruit models to join SlutCamp using your personal referral link. You are responsible for your own recruiting methods. You must be honest about the platform — no false promises about earnings.',
    },
    {
      title: '4. Your Cut',
      body: 'You earn 20% of everything each model you recruit earns on the platform (their 60% share — your cut comes from the Company\'s portion, not from the model). The model keeps her full 60%. Payments are processed on the Company\'s payout schedule. Your earnings become eligible for payout 7 days after they are earned, under the same payout window the models see in the app.',
    },
    {
      title: '5. Termination — At Will',
      body: 'The Company may revoke your recruiter status AT ANY TIME, for any reason or no reason, with NO NOTICE required. When revoked, this Agreement ends immediately and you stop earning on all future revenue from your recruited models. Any balance already earned remains available for withdrawal.',
    },
    {
      title: '6. Conduct Rules',
      body: 'You must NOT: share contact info or payment handles with anyone on the platform; attempt to take models or fans off-platform; use hate speech or slurs. Breaking these rules can get your account suspended or deactivated immediately.',
    },
    {
      title: '7. Non-Circumvention',
      body: 'For 12 months after your recruiter status ends (for any reason), you agree not to recruit models you met through SlutCamp to a competing platform.',
    },
    {
      title: '8. Confidentiality',
      body: 'You agree not to disclose the Company\'s business methods, commission structures, or internal operations to anyone outside the Company.',
    },
    {
      title: '9. Governing Law & Venue',
      body: 'This Agreement is governed by the laws of the State of Texas, without regard to its conflict-of-laws rules. Any dispute arising out of or relating to this Agreement must be brought in the state or federal courts located in Texas, and you and the Company consent to the personal jurisdiction and venue of those courts. Nothing in this section waives or limits any right your home state gives you that cannot legally be waived.',
    },
    {
      title: '10. First-Year Quota — 10 Models in Your First Year',
      body: 'You have ONE YEAR from the date you sign up and accept this Agreement to onboard a minimum of 10 models. A model counts toward your quota only when she joins SlutCamp through your personal referral link and holds a model account. When your first year ends, the Company will review your account. If you have onboarded fewer than 10 models, the Company may revoke your recruiter status if deemed necessary, as described in Section 5. If the models you onboarded have made the Company a significant amount of money, the Company will extend your recruiter status until the quota is met, even if your first year has ended. This review is done by the Company — reaching the one-year mark does not by itself automatically end your status. Nothing in this section limits the Company\'s right under Section 5 to revoke your recruiter status and your referral link at any time, for any reason, without notice.',
    },
    {
      title: '11. Plain-Language Disclaimer',
      body: 'This is a plain-language summary written for clarity — it is NOT legal advice, and it has not been reviewed by an attorney. The Company strongly recommends you have your own attorney review this Agreement before signing. If any part of this Agreement is found unenforceable, the rest still applies.',
    },
  ],
};

/* Per-language presentations of the two signable agreements (Oct 17,
   2026 — 13-language expansion). EN stays the canonical text above;
   versions are UNCHANGED — these are the same terms in other languages,
   each carrying a "the English version governs" note the client renders
   above the sections. Unknown language → EN sections, no note. */
const MODEL_CONTRACT_I18N = {
 "es": {
  "governs": "Traducción por conveniencia — rige la versión en inglés.",
  "sections": [
   {
    "title": "1. Partes",
    "body": "Este Acuerdo de Modelo (\"Acuerdo\") se celebra entre tú, la artista (\"Artista\"), y World of Godz Entertainment LLC (\"Compañía\"), que opera como SlutCamp (\"SlutCamp\"). Al firmar, aceptas todo lo que se indica a continuación."
   },
   {
    "title": "2. Contratista independiente",
    "body": "Eres una CONTRATISTA INDEPENDIENTE, no una empleada de la Compañía. Nada en este Acuerdo crea una relación laboral, de sociedad o de agencia. Eres responsable de tus propios impuestos, seguros y gastos comerciales. La Compañía no retendrá impuestos de tus pagos, y aceptas declarar todos tus ingresos según lo exija la ley."
   },
   {
    "title": "3. Verificación de edad e identidad",
    "body": "Confirmas que tienes al menos 18 años. Has completado (o completarás) la verificación con una identificación oficial ante SlutCamp antes de salir en vivo, según lo requerido para el cumplimiento de los registros de 18 U.S.C. §2257. Si no puedes verificar tu edad e identidad, no podrás actuar en la plataforma."
   },
   {
    "title": "4. Reparto de ingresos y tus tarifas",
    "body": "Te quedas con el 60% de todo lo que los fans gastan en ti (chats, llamadas, regalos, acceso a en vivos, mensajes prioritarios, uniones al escenario, reservas). La Compañía se queda con el 40%. Tú fijas tus propias tarifas dentro de la app, dentro de los rangos permitidos: por mensaje, por minuto de video, por nota de voz y tus tarifas de unión explícita al escenario ($5–$100). La Compañía puede cambiar en cualquier momento las tarifas predeterminadas de toda la plataforma o los rangos permitidos."
   },
   {
    "title": "5. Pagos",
    "body": "Agregas tus datos bancarios en la app y solicitas retiros de tu saldo disponible en cualquier momento. Los pagos los procesa manualmente SlutCamp según el propio calendario de la Compañía — no hay una fecha de pago garantizada. Las solicitudes de retiro pendientes pueden tardar varios días hábiles. Tu saldo disponible solo incluye las ganancias que hayan superado el periodo de espera para pagos descrito en la sección 13."
   },
   {
    "title": "6. Derechos sobre el contenido",
    "body": "Conservas la propiedad del contenido que creas en la plataforma. Al publicar o transmitir en SlutCamp, otorgas a la Compañía una licencia mundial y libre de regalías para usar, mostrar, reproducir y promover ese contenido en la plataforma y en el marketing de la Compañía (incluidas redes sociales y anuncios). Confirmas que tienes derecho a otorgar esta licencia y que tu contenido no infringe los derechos de ninguna otra persona."
   },
   {
    "title": "7. Normas de conducta",
    "body": "En la plataforma NO debes: compartir datos de contacto ni identificadores de pago con los fans; intentar llevarte a los fans o las transacciones fuera de la plataforma; usar discurso de odio o insultos; publicar contenido que incluya a cualquier persona menor de 18 años o a cualquier persona que no haya dado su consentimiento. Incumplir estas normas puede hacer que tus mensajes sean bloqueados, tu cuenta suspendida o tu cuenta desactivada — y puedes perder las ganancias pendientes a discreción de la Compañía."
   },
   {
    "title": "8. Acceso a la cuenta",
    "body": "Las cuentas de modelo son solo por invitación. La Compañía puede suspender o desactivar tu cuenta en cualquier momento, por cualquier motivo, con o sin previo aviso. Si se desactiva, cualquier saldo ganado que no se haya pagado permanecerá disponible para que lo retires."
   },
   {
    "title": "9. Confidencialidad",
    "body": "Aceptas no divulgar los métodos comerciales, las estructuras de comisiones ni las operaciones internas de la Compañía, ni la información personal de ninguna otra modelo ni los datos personales de ningún fan, a ninguna persona ajena a la Compañía."
   },
   {
    "title": "10. No elusión",
    "body": "Durante 12 meses después de que tu cuenta termine (por cualquier motivo), aceptas no solicitar directamente a los fans que conociste a través de SlutCamp que usen un servicio competidor de chat pago o de cámara en lugar de la plataforma. La promoción pública normal de tu propia marca (redes sociales, etc.) está bien — esto solo cubre la captación dirigida de fans de SlutCamp."
   },
   {
    "title": "11. Terminación",
    "body": "Cualquiera de las partes puede terminar este Acuerdo en cualquier momento. Puedes dejar de usar la plataforma cuando quieras. Si la Compañía desactiva tu cuenta, este Acuerdo termina de inmediato, excepto las secciones de confidencialidad, no elusión y derechos sobre el contenido, que sobreviven a la terminación."
   },
   {
    "title": "12. 1 a 1 programados y la lista de espera de FaceTime",
    "body": "Tú controlas tu propio horario de 1 a 1: fijas los días y las horas en que aceptas reservas privadas de 1 a 1, y cuántas aceptas por día y por semana. Una reserva confirmada reserva tu tiempo para ese fan. La plataforma te enviará avisos recordatorios antes de cada reserva — 3 días antes, 3 horas antes y 15 minutos antes. Debes iniciar un 1 a 1 reservado dentro de los 5 minutos de su hora de inicio programada. Si no lo inicias a tiempo, al fan se le reembolsa automáticamente por completo y recibe una disculpa de la plataforma, y esa reserva no te paga nada. Si inicias a tiempo y el fan no se une dentro de los 3 minutos, eso es una ausencia del fan: el fan no recibe reembolso y la reserva se te paga como ganada. También puedes recibir solicitudes de FaceTime mientras estás ocupada: cuando aceptas una solicitud durante otra llamada, el fan se une a tu lista de espera y puede ver su lugar en la fila y su tiempo de espera estimado. Cuando tu llamada termina, el siguiente fan en la fila obtiene una ventana de 90 segundos para unirse. Al aceptar una solicitud, te comprometes a atender la llamada de ese fan cuando llegue su turno."
   },
   {
    "title": "13. Retenciones de pago, reversiones por contracargos y fraude",
    "body": "RETENCIÓN DE PAGO: Tus ganancias se vuelven elegibles para retiro 7 días después de generarse — tu dinero va una semana por detrás de lo que ganas. La app muestra tu saldo disponible por separado de las ganancias que aún están dentro de su periodo. La Compañía publica el periodo actual en la app y puede cambiarlo con aviso en la app; las ganancias que ya están dentro de su periodo conservan el periodo con el que comenzaron. REVERSIONES POR CONTRACARGOS: Los fans pagan con créditos prepagados. Si la compra de créditos de un fan es objeto de un contracargo, reembolso o cualquier otra reversión por parte de su banco o emisor de tarjeta, la Compañía puede revertir el dinero en este orden: (1) los créditos no gastados del fan provenientes de esa compra; (2) tus ganancias no pagadas provenientes de ese fan — primero las ganancias que aún están dentro de su periodo de espera para pagos, luego las ganancias que ya lo superaron; y (3) cualquier monto restante se convierte en un ajuste negativo en tu cuenta, que se descuenta de tus ganancias futuras antes de que cualquier monto nuevo se vuelva retirable. Las ganancias que ya retiraste correctamente nunca se te cobrarán de vuelta de tu bolsillo. Si un contracargo supera las ganancias no pagadas que pueden revertirse según (1) y (2) — incluso porque ya retiraste las ganancias a las que se relaciona — la diferencia se convierte en un saldo que le debes a la Compañía. Ese saldo se recupera automáticamente: el sistema lo deduce de tus ganancias futuras antes de que cualquier monto nuevo se vuelva retirable, hasta que se pague por completo. Nunca se te exige hacer un pago manual ni de tu bolsillo por un faltante por contracargo. Este párrafo no protege el fraude — las ganancias obtenidas fraudulentamente se pierden según las normas de FRAUDE que siguen. FRAUDE: Las compras coordinadas, la autooperación (comprarte a ti misma o a través de cuentas que controlas), los esquemas de contracargos o cualquier otro esquema para fabricar ganancias o pagos es fraude, además de las normas de conducta de la sección 7. En caso de fraude, la Compañía puede poner los pagos en retención o bajo revisión, revertir ganancias y terminar cuentas; las ganancias obtenidas fraudulentamente se pierden."
   },
   {
    "title": "14. Ley aplicable y jurisdicción",
    "body": "Este Acuerdo se rige por las leyes del Estado de Texas, sin tener en cuenta sus normas sobre conflicto de leyes. Cualquier disputa que surja de este Acuerdo o se relacione con él debe presentarse ante los tribunales estatales o federales ubicados en Texas, y tú y la Compañía aceptan la jurisdicción personal y la competencia de esos tribunales. Nada en esta sección renuncia ni limita ningún derecho que tu estado de residencia te otorgue y que legalmente no pueda renunciarse."
   },
   {
    "title": "15. Aviso sobre lenguaje sencillo",
    "body": "Este es un resumen en lenguaje sencillo redactado para mayor claridad — NO es asesoramiento legal y no ha sido revisado por un abogado. La Compañía te recomienda encarecidamente que tu propio abogado revise este Acuerdo antes de firmarlo. Si alguna parte de este Acuerdo se considera inaplicable, el resto seguirá vigente."
   }
  ]
 },
 "pt": {
  "governs": "Tradução apenas para conveniência — prevalece a versão em inglês.",
  "sections": [
   {
    "title": "1. Partes",
    "body": "Este Contrato de Modelo (\"Contrato\") é celebrado entre você, a artista (\"Artista\"), e a World of Godz Entertainment LLC (\"Empresa\"), operando sob o nome SlutCamp (\"SlutCamp\"). Ao assinar, você concorda com tudo o que está abaixo."
   },
   {
    "title": "2. Prestador Independente",
    "body": "Você é um PRESTADOR INDEPENDENTE, e não empregado da Empresa. Nada neste Contrato cria uma relação de emprego, sociedade ou representação. Você é responsável por seus próprios impostos, seguros e despesas do seu negócio. A Empresa não reterá impostos dos seus pagamentos, e você concorda em declarar toda a sua renda conforme exigido por lei."
   },
   {
    "title": "3. Verificação de Idade e Identidade",
    "body": "Você confirma que tem pelo menos 18 anos de idade. Você concluiu (ou concluirá) a verificação com documento oficial de identidade junto à SlutCamp antes de entrar ao vivo, conforme exigido para a conformidade com os registros de 18 U.S.C. §2257. Se você não puder verificar sua idade e identidade, você não poderá se apresentar na plataforma."
   },
   {
    "title": "4. Divisão de Receita e Suas Tarifas",
    "body": "Você fica com 60% de tudo o que os fãs gastam com você (conversas, chamadas, presentes, acesso a lives, mensagens prioritárias, subidas ao palco, reservas). A Empresa fica com 40%. Você define suas próprias tarifas dentro do app, dentro das faixas permitidas: por mensagem, por minuto de vídeo, por mensagem de voz e suas tarifas explícitas de subida ao palco ($5–$100). A Empresa pode alterar os padrões de toda a plataforma ou as faixas permitidas a qualquer momento."
   },
   {
    "title": "5. Pagamentos",
    "body": "Você adiciona seus dados bancários no app e solicita saques do seu saldo disponível a qualquer momento. Os pagamentos são processados manualmente pela SlutCamp conforme o cronograma da própria Empresa — não há data de pagamento garantida. Solicitações de saque pendentes podem levar vários dias úteis. Seu saldo disponível inclui apenas os ganhos que já passaram pelo prazo de liberação descrito na seção 13."
   },
   {
    "title": "6. Direitos sobre o Conteúdo",
    "body": "Você mantém a propriedade do conteúdo que cria na plataforma. Ao publicar ou transmitir na SlutCamp, você concede à Empresa uma licença mundial e gratuita para usar, exibir, reproduzir e promover esse conteúdo na plataforma e no marketing da Empresa (incluindo redes sociais e anúncios). Você confirma que tem o direito de conceder esta licença e que seu conteúdo não infringe os direitos de nenhuma outra pessoa."
   },
   {
    "title": "7. Regras de Conduta",
    "body": "Na plataforma, você NÃO deve: compartilhar informações de contato ou dados de pagamento com fãs; tentar levar fãs ou transações para fora da plataforma; usar discurso de ódio ou injúrias; publicar conteúdo com qualquer pessoa menor de 18 anos ou qualquer pessoa que não tenha consentido. Violar estas regras pode fazer suas mensagens serem bloqueadas, sua conta ser suspensa ou sua conta ser desativada — e você pode perder os ganhos pendentes, a critério da Empresa."
   },
   {
    "title": "8. Acesso à Conta",
    "body": "As contas de modelo são apenas por convite. A Empresa pode suspender ou desativar sua conta a qualquer momento, por qualquer motivo, com ou sem aviso. Se desativada, qualquer saldo já ganho que ainda não tenha sido pago permanecerá disponível para você sacar."
   },
   {
    "title": "9. Confidencialidade",
    "body": "Você concorda em não divulgar os métodos de negócio, as estruturas de comissão ou as operações internas da Empresa, nem as informações pessoais de qualquer outra modelo ou quaisquer dados pessoais de qualquer fã, a ninguém fora da Empresa."
   },
   {
    "title": "10. Não Desvio",
    "body": "Por 12 meses após o encerramento da sua conta (por qualquer motivo), você concorda em não abordar diretamente os fãs que conheceu por meio da SlutCamp para que usem um serviço concorrente de conversa paga ou de câmera em vez da plataforma. A promoção pública normal da sua própria marca (redes sociais etc.) é permitida — isto abrange apenas o aliciamento direcionado de fãs da SlutCamp."
   },
   {
    "title": "11. Rescisão",
    "body": "Qualquer uma das partes pode encerrar este Contrato a qualquer momento. Você pode parar de usar a plataforma quando quiser. Se a Empresa desativar sua conta, este Contrato se encerra imediatamente, exceto as seções de confidencialidade, não desvio e direitos sobre o conteúdo, que sobrevivem à rescisão."
   },
   {
    "title": "12. Sessões 1 a 1 Agendadas e a Lista de Espera do FaceTime",
    "body": "Você controla sua própria agenda de sessões 1 a 1: você define os dias e horários em que aceita reservas privadas 1 a 1 e quantas aceita por dia e por semana. Uma reserva confirmada reserva seu tempo para aquele fã. A plataforma enviará avisos de lembrete antes de cada reserva — 3 dias antes, 3 horas antes e 15 minutos antes. Você deve iniciar uma sessão 1 a 1 reservada dentro de 5 minutos do horário agendado de início. Se você não iniciar a tempo, o fã será reembolsado integralmente de forma automática e receberá um pedido de desculpas da plataforma, e essa reserva não lhe pagará nada. Se você iniciar no horário e o fã não entrar dentro de 3 minutos, isso é uma falta do fã: o fã não recebe reembolso, e a reserva é paga a você como ganho. Você também pode receber solicitações de FaceTime enquanto estiver ocupada: quando você aceita uma solicitação durante outra chamada, o fã entra na sua lista de espera e pode ver sua posição na fila e seu tempo estimado de espera. Quando sua chamada termina, o próximo fã da fila tem uma janela de 90 segundos para entrar. Ao aceitar uma solicitação, você se compromete a atender a chamada daquele fã quando chegar a vez dele."
   },
   {
    "title": "13. Retenções de Pagamento, Reversões por Estorno e Fraude",
    "body": "RETENÇÃO DE PAGAMENTO: Seus ganhos ficam disponíveis para saque 7 dias depois de gerados — seu dinheiro fica uma semana atrás do que você ganha. O app mostra seu saldo disponível separado dos ganhos ainda dentro do prazo. A Empresa publica o prazo atual no app e pode alterá-lo mediante aviso no app; os ganhos já dentro do prazo mantêm o prazo com que começaram. REVERSÕES POR ESTORNO: Os fãs pagam com créditos pré-pagos. Se a compra de créditos de um fã for estornada, reembolsada ou revertida de outra forma pelo banco ou emissor do cartão dele, a Empresa poderá reverter o dinheiro nesta ordem: (1) os créditos não gastos do fã provenientes daquela compra; (2) seus ganhos não pagos provenientes daquele fã — primeiro os ganhos ainda dentro do prazo de liberação, depois os ganhos que já passaram por ele; e (3) qualquer valor restante se torna um ajuste negativo na sua conta, que é descontado dos seus ganhos futuros antes que qualquer valor novo fique disponível para saque. Ganhos que você já sacou devidamente nunca serão cobrados de você do seu próprio bolso. Se um estorno exceder os ganhos não pagos que podem ser revertidos conforme (1) e (2) — inclusive porque você já sacou os ganhos a que ele se refere —, a diferença se torna um saldo que você deve à Empresa. Esse saldo é recuperado automaticamente: o sistema o deduz dos seus ganhos futuros antes que qualquer valor novo fique disponível para saque, até que ele seja quitado integralmente. Você nunca será obrigada a fazer um pagamento manual ou do seu próprio bolso por um déficit de estorno. Este parágrafo não protege fraude — ganhos obtidos de forma fraudulenta são perdidos conforme as regras de FRAUDE a seguir. FRAUDE: Compras coordenadas, autocontratação (comprar de si mesma ou por meio de contas que você controla), esquemas de estorno ou qualquer outro esquema para fabricar ganhos ou pagamentos constitui fraude, além das regras de conduta da seção 7. Em caso de fraude, a Empresa pode reter pagamentos ou colocá-los em análise, reverter ganhos e encerrar contas; ganhos obtidos de forma fraudulenta são perdidos."
   },
   {
    "title": "14. Lei Aplicável e Foro",
    "body": "Este Contrato é regido pelas leis do Estado do Texas, independentemente de suas regras de conflito de leis. Qualquer disputa decorrente deste Contrato ou a ele relacionada deve ser levada aos tribunais estaduais ou federais localizados no Texas, e você e a Empresa consentem com a jurisdição pessoal e o foro desses tribunais. Nada nesta seção renuncia ou limita qualquer direito que seu estado de origem lhe conceda e que não possa ser legalmente renunciado."
   },
   {
    "title": "15. Aviso de Linguagem Simples",
    "body": "Este é um resumo em linguagem simples, redigido para maior clareza — ele NÃO é aconselhamento jurídico e não foi revisado por um advogado. A Empresa recomenda enfaticamente que você peça ao seu próprio advogado para revisar este Contrato antes de assinar. Se qualquer parte deste Contrato for considerada inexequível, o restante continua válido."
   }
  ]
 },
 "fr": {
  "governs": "Traduction fournie à titre de commodité — la version anglaise prévaut.",
  "sections": [
   {
    "title": "1. Parties",
    "body": "Le présent Contrat de modèle (« Contrat ») est conclu entre vous, l'artiste (« Artiste »), et World of Godz Entertainment LLC (« Société »), exerçant sous le nom de SlutCamp (« SlutCamp »). En signant, vous acceptez tout ce qui suit."
   },
   {
    "title": "2. Contractant indépendant",
    "body": "Vous êtes un CONTRACTANT INDÉPENDANT, et non un employé de la Société. Rien dans le présent Contrat ne crée de relation d'emploi, de partenariat ou de mandat. Vous êtes responsable de vos propres impôts, assurances et frais professionnels. La Société ne retiendra pas d'impôts sur vos paiements, et vous acceptez de déclarer tous vos revenus conformément à la loi."
   },
   {
    "title": "3. Vérification de l'âge et de l'identité",
    "body": "Vous confirmez avoir au moins 18 ans. Vous avez effectué (ou effectuerez) une vérification d'identité au moyen d'une pièce d'identité officielle auprès de SlutCamp avant de passer en direct, comme l'exige la conformité en matière de tenue de registres au titre de 18 U.S.C. §2257. Si vous ne pouvez pas vérifier votre âge et votre identité, vous ne pouvez pas vous produire sur la plateforme."
   },
   {
    "title": "4. Répartition des revenus et vos tarifs",
    "body": "Vous gardez 60% de tout ce que les fans dépensent pour vous (discussions, appels, cadeaux, accès aux directs, messages prioritaires, participations à la scène, réservations). La Société garde 40%. Vous définissez vos propres tarifs dans l'application, dans les limites autorisées : par message, par minute de vidéo, par note vocale, ainsi que vos tarifs de participation explicite à la scène ($5–$100). La Société peut modifier à tout moment les valeurs par défaut à l'échelle de la plateforme ou les limites autorisées."
   },
   {
    "title": "5. Paiements",
    "body": "Vous ajoutez vos coordonnées bancaires dans l'application et demandez des retraits de votre solde disponible à tout moment. Les paiements sont traités manuellement par SlutCamp selon le propre calendrier de la Société — il n'y a aucune date de paiement garantie. Les demandes de retrait en attente peuvent prendre plusieurs jours ouvrables. Votre solde disponible ne comprend que les gains qui ont franchi le délai de paiement décrit à la section 13."
   },
   {
    "title": "6. Droits sur le contenu",
    "body": "Vous conservez la propriété du contenu que vous créez sur la plateforme. En publiant ou en diffusant sur SlutCamp, vous accordez à la Société une licence mondiale et libre de redevances pour utiliser, afficher, reproduire et promouvoir ce contenu sur la plateforme et dans le marketing de la Société (y compris les réseaux sociaux et les publicités). Vous confirmez avoir le droit d'accorder cette licence et que votre contenu ne porte atteinte aux droits de personne d'autre."
   },
   {
    "title": "7. Règles de conduite",
    "body": "Sur la plateforme, vous ne devez PAS : partager des coordonnées ou des identifiants de paiement avec les fans ; tenter de déplacer les fans ou les transactions hors plateforme ; utiliser des discours de haine ou des insultes ; publier du contenu mettant en scène une personne de moins de 18 ans ou une personne qui n'a pas consenti. Enfreindre ces règles peut entraîner le blocage de vos messages, la suspension de votre compte ou sa désactivation — et vous pouvez perdre vos gains en attente, à la discrétion de la Société."
   },
   {
    "title": "8. Accès au compte",
    "body": "Les comptes de modèles sont uniquement sur invitation. La Société peut suspendre ou désactiver votre compte à tout moment, pour n'importe quelle raison, avec ou sans préavis. En cas de désactivation, tout solde gagné qui n'a pas été payé reste disponible pour que vous le retiriez."
   },
   {
    "title": "9. Confidentialité",
    "body": "Vous acceptez de ne divulguer à personne en dehors de la Société ni les méthodes commerciales, les structures de commission ou le fonctionnement interne de la Société, ni les informations personnelles d'un autre modèle ou les données personnelles d'un fan."
   },
   {
    "title": "10. Non-contournement",
    "body": "Pendant 12 mois après la fin de votre compte (pour quelque raison que ce soit), vous acceptez de ne pas solliciter directement les fans que vous avez rencontrés via SlutCamp pour qu'ils utilisent un service concurrent de discussion payante ou de cam au lieu de la plateforme. La promotion publique normale de votre propre marque (réseaux sociaux, etc.) est autorisée — ceci ne couvre que le démarchage ciblé des fans de SlutCamp."
   },
   {
    "title": "11. Résiliation",
    "body": "Chaque partie peut mettre fin au présent Contrat à tout moment. Vous pouvez cesser d'utiliser la plateforme quand vous le souhaitez. Si la Société désactive votre compte, le présent Contrat prend fin immédiatement, à l'exception des sections relatives à la confidentialité, au non-contournement et aux droits sur le contenu, qui survivent à la résiliation."
   },
   {
    "title": "12. 1-à-1 programmés et liste d'attente FaceTime",
    "body": "Vous contrôlez votre propre programme de 1-à-1 : vous définissez les jours et les heures auxquels vous acceptez les réservations privées en 1-à-1, ainsi que le nombre que vous acceptez par jour et par semaine. Une réservation confirmée réserve votre temps pour ce fan. La plateforme vous enverra des avis de rappel avant chaque réservation — 3 jours avant, 3 heures avant et 15 minutes avant. Vous devez commencer un 1-à-1 réservé dans les 5 minutes suivant son heure de début programmée. Si vous ne commencez pas à temps, le fan est automatiquement remboursé intégralement et reçoit des excuses de la plateforme, et cette réservation ne vous rapporte rien. Si vous commencez à temps et que le fan ne rejoint pas dans les 3 minutes, il s'agit d'une absence du fan : le fan ne reçoit aucun remboursement, et la réservation vous est payée comme un gain. Vous pouvez également recevoir des demandes FaceTime pendant que vous êtes occupée : lorsque vous acceptez une demande pendant un autre appel, le fan rejoint votre liste d'attente et peut voir sa place dans la file et son temps d'attente estimé. Lorsque votre appel se termine, le fan suivant dans la file dispose d'un délai de 90 secondes pour rejoindre. En acceptant une demande, vous vous engagez à prendre l'appel de ce fan lorsque son tour viendra."
   },
   {
    "title": "13. Délais de paiement, annulations pour rejet de débit et fraude",
    "body": "DÉLAI DE PAIEMENT : Vos gains deviennent éligibles au retrait 7 jours après avoir été gagnés — votre argent a une semaine de retard sur ce que vous gagnez. L'application affiche votre solde disponible séparément des gains encore dans leur délai. La Société publie le délai actuel dans l'application et peut le modifier avec un avis dans l'application ; les gains déjà dans leur délai conservent le délai avec lequel ils ont commencé. ANNULATIONS POUR REJET DE DÉBIT : Les fans paient avec des crédits prépayés. Si l'achat de crédits d'un fan fait l'objet d'un rejet de débit, d'un remboursement ou d'une autre annulation par sa banque ou l'émetteur de sa carte, la Société peut annuler l'argent dans cet ordre : (1) les crédits non dépensés du fan provenant de cet achat ; (2) vos gains non payés provenant de ce fan — d'abord les gains encore dans leur délai de paiement, puis les gains qui l'ont déjà franchi ; et (3) tout montant restant devient un ajustement négatif sur votre compte, qui est prélevé sur vos gains futurs avant que quoi que ce soit de nouveau devienne retirable. Les gains que vous avez déjà correctement retirés ne vous sont jamais réclamés de votre poche. Si un rejet de débit dépasse les gains non payés qui peuvent être annulés au titre de (1) et (2) — y compris parce que vous avez déjà retiré les gains auxquels il se rapporte — la différence devient un solde que vous devez à la Société. Ce solde est récupéré automatiquement : le système le déduit de vos gains futurs avant que quoi que ce soit de nouveau devienne retirable, jusqu'à son remboursement intégral. Vous n'êtes jamais tenue d'effectuer un paiement manuel ou de votre poche pour un déficit lié à un rejet de débit. Ce paragraphe ne protège pas la fraude — les gains obtenus frauduleusement sont confisqués conformément aux règles relatives à la FRAUDE qui suivent. FRAUDE : Les achats coordonnés, les opérations pour son propre compte (acheter auprès de vous-même ou via des comptes que vous contrôlez), les stratagèmes de rejet de débit, ou tout autre stratagème visant à fabriquer des gains ou des paiements constituent une fraude, en plus des règles de conduite de la section 7. En cas de fraude, la Société peut mettre les paiements en attente ou en examen, annuler des gains et résilier des comptes ; les gains obtenus frauduleusement sont confisqués."
   },
   {
    "title": "14. Droit applicable et juridiction",
    "body": "Le présent Contrat est régi par les lois de l'État du Texas, sans égard à ses règles de conflit de lois. Tout litige découlant du présent Contrat ou s'y rapportant doit être porté devant les tribunaux d'État ou fédéraux situés au Texas, et vous et la Société consentez à la compétence personnelle et à la juridiction de ces tribunaux. Rien dans cette section ne renonce ni ne limite un droit que votre État d'origine vous accorde et qui ne peut légalement faire l'objet d'une renonciation."
   },
   {
    "title": "15. Avertissement en langage clair",
    "body": "Ceci est un résumé en langage clair rédigé pour plus de clarté — ce n'est PAS un avis juridique, et il n'a pas été examiné par un avocat. La Société vous recommande vivement de faire examiner le présent Contrat par votre propre avocat avant de signer. Si une partie du présent Contrat est jugée inapplicable, le reste continue de s'appliquer."
   }
  ]
 },
 "de": {
  "governs": "Übersetzung zur Erleichterung — die englische Version ist maßgebend.",
  "sections": [
   {
    "title": "1. Parteien",
    "body": "Diese Model-Vereinbarung („Vereinbarung\") ist zwischen Ihnen, der Darstellerin/dem Darsteller („Performer\"), und World of Godz Entertainment LLC („Unternehmen\"), die als SlutCamp („SlutCamp\") tätig ist. Mit Ihrer Unterschrift stimmen Sie allem Folgenden zu."
   },
   {
    "title": "2. Unabhängige Auftragnehmerin / Unabhängiger Auftragnehmer",
    "body": "Sie sind eine UNABHÄNGIGE AUFTRAGNEHMERIN / ein UNABHÄNGIGER AUFTRAGNEHMER, keine Angestellte / kein Angestellter des Unternehmens. Nichts in dieser Vereinbarung begründet ein Beschäftigungs-, Partnerschafts- oder Vertretungsverhältnis. Sie sind für Ihre eigenen Steuern, Versicherungen und Geschäftsausgaben verantwortlich. Das Unternehmen wird keine Steuern von Ihren Auszahlungen einbehalten, und Sie stimmen zu, alle Einkünfte wie gesetzlich vorgeschrieben zu melden."
   },
   {
    "title": "3. Alters- & Identitätsverifizierung",
    "body": "Sie bestätigen, dass Sie mindestens 18 Jahre alt sind. Sie haben die Verifizierung eines amtlichen Ausweises bei SlutCamp abgeschlossen (oder werden sie abschließen), bevor Sie live gehen, wie für die Compliance mit der Aufzeichnungspflicht nach 18 U.S.C. §2257 erforderlich. Wenn Sie Ihr Alter und Ihre Identität nicht verifizieren können, dürfen Sie auf der Plattform nicht auftreten."
   },
   {
    "title": "4. Umsatzaufteilung & Ihre Preise",
    "body": "Sie behalten 60% von allem, was Fans für Sie ausgeben (Chats, Anrufe, Geschenke, Live-Zugang, Prioritätsnachrichten, Bühnenbeitritte, Buchungen). Das Unternehmen behält 40%. Sie legen Ihre eigenen Preise in der App innerhalb der erlaubten Bereiche fest: pro Nachricht, pro Minute Video, pro Sprachnachricht und Ihre expliziten Preise für den Bühnenbeitritt ($5–$100). Das Unternehmen kann die plattformweiten Standardwerte oder erlaubten Bereiche jederzeit ändern."
   },
   {
    "title": "5. Auszahlungen",
    "body": "Sie fügen Ihre Bankdaten in der App hinzu und fordern jederzeit Abhebungen Ihres verfügbaren Guthabens an. Auszahlungen werden von SlutCamp manuell nach dem eigenen Zeitplan des Unternehmens bearbeitet — es gibt kein garantiertes Auszahlungsdatum. Ausstehende Abhebungsanfragen können mehrere Werktage dauern. Ihr verfügbares Guthaben umfasst nur Einnahmen, die das in Abschnitt 13 beschriebene Auszahlungsfenster durchlaufen haben."
   },
   {
    "title": "6. Inhaltsrechte",
    "body": "Sie behalten das Eigentum an den Inhalten, die Sie auf der Plattform erstellen. Indem Sie auf SlutCamp posten oder streamen, gewähren Sie dem Unternehmen eine weltweite, gebührenfreie Lizenz, diese Inhalte auf der Plattform und im Marketing des Unternehmens (einschließlich sozialer Medien und Werbung) zu nutzen, anzuzeigen, zu reproduzieren und zu bewerben. Sie bestätigen, dass Sie das Recht haben, diese Lizenz zu gewähren, und dass Ihre Inhalte die Rechte Dritter nicht verletzen."
   },
   {
    "title": "7. Verhaltensregeln",
    "body": "Auf der Plattform dürfen Sie NICHT: Kontaktdaten oder Zahlungs-Handles mit Fans teilen; versuchen, Fans oder Transaktionen außerhalb der Plattform zu bewegen; Hassrede oder Beleidigungen verwenden; Inhalte posten, die Personen unter 18 Jahren oder Personen zeigen, die nicht zugestimmt haben. Ein Verstoß gegen diese Regeln kann dazu führen, dass Ihre Nachrichten blockiert, Ihr Account ausgesetzt oder Ihr Account deaktiviert wird — und Sie können ausstehende Einnahmen nach Ermessen des Unternehmens verwirken."
   },
   {
    "title": "8. Account-Zugang",
    "body": "Model-Accounts sind nur auf Einladung. Das Unternehmen kann Ihren Account jederzeit, aus beliebigem Grund, mit oder ohne Vorankündigung aussetzen oder deaktivieren. Bei Deaktivierung bleibt jedes verdiente Guthaben, das noch nicht ausgezahlt wurde, für Sie zur Abhebung verfügbar."
   },
   {
    "title": "9. Vertraulichkeit",
    "body": "Sie stimmen zu, die Geschäftsmethoden, Provisionsstrukturen oder internen Abläufe des Unternehmens oder die persönlichen Informationen eines anderen Models oder die persönlichen Daten eines Fans gegenüber niemandem außerhalb des Unternehmens offenzulegen."
   },
   {
    "title": "10. Umgehungsverbot",
    "body": "Für 12 Monate nach Beendigung Ihres Accounts (aus beliebigem Grund) stimmen Sie zu, Fans, die Sie über SlutCamp kennengelernt haben, nicht direkt dazu aufzufordern, einen konkurrierenden bezahlten Chat- oder Cam-Dienst anstelle der Plattform zu nutzen. Normale öffentliche Werbung für Ihre eigene Marke (soziale Medien usw.) ist in Ordnung — dies betrifft nur gezieltes Abwerben von SlutCamp-Fans."
   },
   {
    "title": "11. Kündigung",
    "body": "Jede Seite kann diese Vereinbarung jederzeit beenden. Sie können die Nutzung der Plattform jederzeit einstellen. Wenn das Unternehmen Ihren Account deaktiviert, endet diese Vereinbarung sofort, mit Ausnahme der Abschnitte zu Vertraulichkeit, Umgehungsverbot und Inhaltsrechten, die über die Beendigung hinaus fortbestehen."
   },
   {
    "title": "12. Geplante 1-zu-1 & die FaceTime-Warteliste",
    "body": "Sie kontrollieren Ihren eigenen 1-zu-1-Zeitplan: Sie legen die Tage und Stunden fest, an denen Sie private 1-zu-1-Buchungen annehmen, und wie viele Sie pro Tag und pro Woche akzeptieren. Eine bestätigte Buchung reserviert Ihre Zeit für diesen Fan. Die Plattform sendet Ihnen Erinnerungsbenachrichtigungen vor jeder Buchung — 3 Tage vorher, 3 Stunden vorher und 15 Minuten vorher. Sie müssen ein gebuchtes 1-zu-1 innerhalb von 5 Minuten nach seiner geplanten Startzeit beginnen. Wenn Sie nicht rechtzeitig beginnen, wird der Fan automatisch vollständig erstattet und erhält eine Entschuldigung von der Plattform, und diese Buchung zahlt Ihnen nichts. Wenn Sie pünktlich beginnen und der Fan nicht innerhalb von 3 Minuten beitritt, ist das ein Fan-No-Show: Der Fan erhält keine Rückerstattung, und die Buchung wird Ihnen als verdient ausgezahlt. Sie können auch FaceTime-Anfragen erhalten, während Sie beschäftigt sind: Wenn Sie eine Anfrage während eines anderen Anrufs akzeptieren, tritt der Fan Ihrer Warteliste bei und kann seinen Platz in der Schlange und seine geschätzte Wartezeit sehen. Wenn Ihr Anruf endet, erhält der nächste Fan in der Schlange ein 90-Sekunden-Fenster, um beizutreten. Mit der Annahme einer Anfrage verpflichten Sie sich, den Anruf dieses Fans anzunehmen, wenn er an der Reihe ist."
   },
   {
    "title": "13. Auszahlungssperren, Rückbuchungsumkehrungen & Betrug",
    "body": "AUSZAHLUNGSSPERRE: Ihre Einnahmen werden 7 Tage nach dem Verdienen für die Abhebung berechtigt — Ihr Geld läuft eine Woche hinter dem, was Sie verdienen. Die App zeigt Ihr verfügbares Guthaben getrennt von Einnahmen, die sich noch in ihrem Fenster befinden. Das Unternehmen veröffentlicht das aktuelle Fenster in der App und kann es mit Benachrichtigung in der App ändern; Einnahmen, die sich bereits in ihrem Fenster befinden, behalten das Fenster, mit dem sie begonnen haben. RÜCKBUCHUNGSUMKEHRUNGEN: Fans zahlen mit Prepaid-Credits. Wenn ein Credit-Kauf eines Fans von seiner Bank oder seinem Kartenherausgeber zurückgebucht, erstattet oder anderweitig rückgängig gemacht wird, kann das Unternehmen das Geld in dieser Reihenfolge umkehren: (1) die nicht ausgegebenen Credits des Fans aus diesem Kauf; (2) Ihre unbezahlten Einnahmen von diesem Fan — Einnahmen, die sich noch in ihrem Auszahlungsfenster befinden, zuerst, dann Einnahmen, die es bereits durchlaufen haben; und (3) jeder verbleibende Betrag wird zu einer negativen Anpassung auf Ihrem Account, die von Ihren zukünftigen Einnahmen abgezogen wird, bevor etwas Neues abhebbar wird. Einnahmen, die Sie bereits ordnungsgemäß abgehoben haben, werden niemals aus eigener Tasche von Ihnen zurückgeholt. Wenn eine Rückbuchung die unbezahlten Einnahmen übersteigt, die unter (1) und (2) umgekehrt werden können — auch weil Sie die Einnahmen, auf die sie sich bezieht, bereits abgehoben haben — wird die Differenz zu einem Guthaben, das Sie dem Unternehmen schulden. Dieses Guthaben wird automatisch zurückgewonnen: Das System zieht es von Ihren zukünftigen Einnahmen ab, bevor etwas Neues abhebbar wird, bis es vollständig zurückgezahlt ist. Sie sind niemals verpflichtet, eine manuelle Zahlung oder Zahlung aus eigener Tasche für ein Rückbuchungsdefizit zu leisten. Dieser Absatz schützt keinen Betrug — betrügerisch erlangte Einnahmen werden gemäß den folgenden BETRUGS-Regeln verwirkt. BETRUG: Koordinierte Käufe, Selbstgeschäfte (Kauf von sich selbst oder über Accounts, die Sie kontrollieren), Rückbuchungssysteme oder jedes andere System zur Herstellung von Einnahmen oder Auszahlungen ist Betrug, zusätzlich zu den Verhaltensregeln in Abschnitt 7. Bei Betrug kann das Unternehmen Auszahlungen sperren oder einer Überprüfung unterziehen, Einnahmen umkehren und Accounts kündigen; betrügerisch erlangte Einnahmen werden verwirkt."
   },
   {
    "title": "14. Geltendes Recht & Gerichtsstand",
    "body": "Diese Vereinbarung unterliegt den Gesetzen des Bundesstaates Texas, ohne Rücksicht auf seine Kollisionsnormen. Jeder Streit, der aus dieser Vereinbarung entsteht oder damit zusammenhängt, muss vor den staatlichen oder bundesstaatlichen Gerichten in Texas gebracht werden, und Sie und das Unternehmen stimmen der persönlichen Gerichtsbarkeit und dem Gerichtsstand dieser Gerichte zu. Nichts in diesem Abschnitt verzichtet auf oder beschränkt ein Recht, das Ihnen Ihr Heimatstaat gibt und das gesetzlich nicht verzichtet werden kann."
   },
   {
    "title": "15. Haftungsausschluss in einfacher Sprache",
    "body": "Dies ist eine Zusammenfassung in einfacher Sprache, die der Klarheit dient — sie ist KEINE Rechtsberatung und wurde nicht von einem Anwalt überprüft. Das Unternehmen empfiehlt Ihnen dringend, diese Vereinbarung vor der Unterzeichnung von Ihrem eigenen Anwalt überprüfen zu lassen. Wenn ein Teil dieser Vereinbarung für nicht durchsetzbar befunden wird, gilt der Rest weiterhin."
   }
  ]
 },
 "ru": {
  "governs": "Перевод для удобства — преимущественную силу имеет английская версия.",
  "sections": [
   {
    "title": "1. Стороны",
    "body": "Настоящее Соглашение модели («Соглашение») заключается между вами, исполнителем («Исполнитель»), и World of Godz Entertainment LLC («Компания»), осуществляющей деятельность под названием SlutCamp («SlutCamp»). Подписывая, вы соглашаетесь со всем нижеизложенным."
   },
   {
    "title": "2. Независимый подрядчик",
    "body": "Вы являетесь НЕЗАВИСИМЫМ ПОДРЯДЧИКОМ, а не сотрудником Компании. Ничто в настоящем Соглашении не создаёт трудовых, партнёрских или агентских отношений. Вы несёте ответственность за свои собственные налоги, страхование и деловые расходы. Компания не будет удерживать налоги из ваших выплат, и вы соглашаетесь отчитываться о всех доходах в соответствии с требованиями закона."
   },
   {
    "title": "3. Подтверждение возраста и личности",
    "body": "Вы подтверждаете, что вам не менее 18 лет. Вы прошли (или пройдёте) проверку государственного удостоверения личности в SlutCamp, прежде чем выходить в эфир, как требуется для соблюдения требований ведения учёта по 18 U.S.C. §2257. Если вы не можете подтвердить ваш возраст и личность, вы не можете выступать на платформе."
   },
   {
    "title": "4. Разделение дохода и ваши тарифы",
    "body": "Вы сохраняете 60% от всего, что фанаты тратят на вас (чаты, звонки, подарки, доступ к эфирам, приоритетные сообщения, присоединения к сцене, бронирования). Компания сохраняет 40%. Вы устанавливаете свои собственные тарифы внутри приложения в разрешённых пределах: за сообщение, за минуту видео, за голосовое сообщение и ваши тарифы откровенного присоединения к сцене ($5–$100). Компания может изменить общеплатформенные значения по умолчанию или разрешённые диапазоны в любое время."
   },
   {
    "title": "5. Выплаты",
    "body": "Вы добавляете ваши банковские реквизиты в приложении и запрашиваете вывод вашего доступного баланса в любое время. Выплаты обрабатываются вручную SlutCamp по собственному расписанию Компании — гарантированной даты выплаты нет. Ожидающие запросы на вывод могут занять несколько рабочих дней. Ваш доступный баланс включает только доходы, прошедшие период выплаты, описанный в разделе 13."
   },
   {
    "title": "6. Права на контент",
    "body": "Вы сохраняете право собственности на контент, который вы создаёте на платформе. Размещая или транслируя контент на SlutCamp, вы предоставляете Компании всемирную, безвозмездную лицензию на использование, отображение, воспроизведение и продвижение этого контента на платформе и в маркетинге Компании (включая социальные сети и рекламу). Вы подтверждаете, что у вас есть право предоставлять эту лицензию и что ваш контент не нарушает чужих прав."
   },
   {
    "title": "7. Правила поведения",
    "body": "На платформе вы НЕ должны: делиться контактной информацией или платёжными реквизитами с фанатами; пытаться увести фанатов или транзакции за пределы платформы; использовать язык ненависти или оскорбления; публиковать контент с участием лиц младше 18 лет или лиц, не давших согласия. Нарушение этих правил может привести к блокировке ваших сообщений, приостановке вашего аккаунта или его деактивации — и вы можете лишиться ожидающих доходов по усмотрению Компании."
   },
   {
    "title": "8. Доступ к аккаунту",
    "body": "Аккаунты моделей только по приглашению. Компания может приостановить или деактивировать ваш аккаунт в любое время, по любой причине, с уведомлением или без него. В случае деактивации любой заработанный баланс, который не был выплачен, остаётся доступным для вашего вывода."
   },
   {
    "title": "9. Конфиденциальность",
    "body": "Вы соглашаетесь не раскрывать методы ведения бизнеса Компании, структуры комиссий или внутренние операции, а также личную информацию любой другой модели или личные данные любого фаната кому-либо за пределами Компании."
   },
   {
    "title": "10. Запрет обхода",
    "body": "В течение 12 месяцев после прекращения вашего аккаунта (по любой причине) вы соглашаетесь не переманивать напрямую фанатов, с которыми вы познакомились через SlutCamp, пользоваться конкурирующим платным чатом или кам-сервисом вместо платформы. Обычное публичное продвижение вашего собственного бренда (социальные сети и т.д.) допустимо — это касается только целенаправленного переманивания фанатов SlutCamp."
   },
   {
    "title": "11. Расторжение",
    "body": "Любая сторона может расторгнуть настоящее Соглашение в любое время. Вы можете прекратить пользоваться платформой, когда захотите. Если Компания деактивирует ваш аккаунт, настоящее Соглашение немедленно прекращается, за исключением разделов о конфиденциальности, запрете обхода и правах на контент, которые сохраняют силу после расторжения."
   },
   {
    "title": "12. Запланированные 1-на-1 и лист ожидания FaceTime",
    "body": "Вы контролируете ваше собственное расписание 1-на-1: вы устанавливаете дни и часы, когда вы принимаете приватные бронирования 1-на-1, и сколько вы принимаете в день и в неделю. Подтверждённое бронирование резервирует ваше время за этим фанатом. Платформа будет отправлять вам напоминания перед каждым бронированием — за 3 дня, за 3 часа и за 15 минут. Вы должны начать забронированный 1-на-1 в течение 5 минут от его запланированного времени начала. Если вы не начнёте вовремя, фанату автоматически возвращается полная сумма и он получает извинение от платформы, а это бронирование вам ничего не оплачивает. Если вы начнёте вовремя, а фанат не присоединится в течение 3 минут, это неявка фаната: фанат не получает возврата, а бронирование оплачивается вам как заработанное. Вы также можете получать запросы FaceTime, пока вы заняты: когда вы принимаете запрос во время другого звонка, фанат присоединяется к вашему листу ожидания и может видеть своё место в очереди и предполагаемое время ожидания. Когда ваш звонок заканчивается, следующий фанат в очереди получает 90-секундное окно для присоединения. Принимая запрос, вы обязуетесь принять звонок этого фаната, когда придёт его очередь."
   },
   {
    "title": "13. Удержание выплат, отмены по чарджбэкам и мошенничество",
    "body": "УДЕРЖАНИЕ ВЫПЛАТ: Ваши доходы становятся доступными для вывода через 7 дней после их получения — ваши деньги отстают на неделю от того, что вы зарабатываете. Приложение показывает ваш доступный баланс отдельно от доходов, всё ещё находящихся в их периоде. Компания публикует текущий период в приложении и может изменить его с уведомлением в приложении; доходы, уже находящиеся в их периоде, сохраняют период, с которым они начались. ОТМЕНЫ ПО ЧАРДЖБЭКАМ: Фанаты платят предоплаченными кредитами. Если покупка кредитов фаната будет оспорена, возвращена или иным образом отменена его банком или эмитентом карты, Компания может отменить деньги в следующем порядке: (1) непотраченные кредиты фаната от этой покупки; (2) ваши невыплаченные доходы от этого фаната — сначала доходы, всё ещё находящиеся в их периоде выплаты, затем доходы, уже прошедшие его; и (3) любая оставшаяся сумма становится отрицательной корректировкой на вашем аккаунте, которая вычитается из ваших будущих доходов, прежде чем что-либо новое станет доступным для вывода. Доходы, которые вы уже надлежащим образом вывели, никогда не взыскиваются с вас из вашего кармана. Если чарджбэк превышает невыплаченные доходы, которые могут быть отменены в соответствии с пунктами (1) и (2) — в том числе потому, что вы уже вывели доходы, к которым он относится, — разница становится балансом, который вы должны Компании. Этот баланс взыскивается автоматически: система вычитает его из ваших будущих доходов, прежде чем что-либо новое станет доступным для вывода, до полного погашения. От вас никогда не требуется производить ручной или личный платёж за недостачу по чарджбэку. Этот абзац не защищает мошенничество — мошеннически полученные доходы подлежат конфискации в соответствии с правилами о МОШЕННИЧЕСТВЕ, изложенными ниже. МОШЕННИЧЕСТВО: Скоординированные покупки, сделки с самим собой (покупка у себя или через аккаунты, которые вы контролируете), схемы чарджбэков или любая другая схема для искусственного создания доходов или выплат является мошенничеством, в дополнение к правилам поведения в разделе 7. За мошенничество Компания может приостановить выплаты или поставить их на проверку, отменить доходы и расторгнуть аккаунты; мошеннически полученные доходы подлежат конфискации."
   },
   {
    "title": "14. Применимое право и место рассмотрения",
    "body": "Настоящее Соглашение регулируется законами штата Техас, без учёта его коллизионных норм. Любой спор, возникающий из настоящего Соглашения или связанный с ним, должен подаваться в суды штата или федеральные суды, расположенные в Техасе, и вы и Компания соглашаетесь с персональной юрисдикцией и местом рассмотрения этих судов. Ничто в этом разделе не отменяет и не ограничивает какое-либо право, предоставляемое вам вашим родным штатом, которое не может быть юридически отменено."
   },
   {
    "title": "15. Отказ от ответственности, изложенный простым языком",
    "body": "Это краткое изложение простым языком, написанное для ясности — это НЕ юридическая консультация, и оно не было проверено адвокатом. Компания настоятельно рекомендует вам попросить вашего собственного адвоката проверить настоящее Соглашение перед подписанием. Если какая-либо часть настоящего Соглашения будет признана неисполнимой, остальная часть по-прежнему применяется."
   }
  ]
 },
 "ja": {
  "governs": "便宜上の翻訳です — 英語版が正式なものとなります。",
  "sections": [
   {
    "title": "1. 当事者",
    "body": "本モデル契約（以下「本契約」）は、あなたであるパフォーマー（以下「パフォーマー」）と、SlutCampとして事業を行う World of Godz Entertainment LLC（以下「当社」）との間で締結されます。署名することにより、あなたは以下のすべてに同意します。"
   },
   {
    "title": "2. 独立請負業者",
    "body": "あなたは当社の従業員ではなく、独立請負業者です。本契約のいかなる規定も、雇用、パートナーシップ、または代理関係を創設するものではありません。あなたは自身の税金、保険、および事業経費について責任を負います。当社はあなたの支払いから税金を源泉徴収せず、あなたは法律で要求されるすべての所得を申告することに同意します。"
   },
   {
    "title": "3. 年齢および本人確認",
    "body": "あなたは18歳以上であることを確認します。あなたは、合衆国法典第18編 §2257 の記録保持コンプライアンスのために必要なとおり、ライブ配信を開始する前にSlutCampによる政府発行身分証の確認を完了しています（または完了します）。年齢と身元を確認できない場合、プラットフォームでパフォーマンスを行うことはできません。"
   },
   {
    "title": "4. 収益分配とあなたの料金",
    "body": "あなたは、ファンがあなたに使う金額の60%を保持します（チャット、通話、ギフト、ライブアクセス、優先メッセージ、ステージ参加、予約）。当社は40%を保持します。あなたは、許容範囲内でアプリ内に独自の料金を設定します：メッセージ単価、ビデオ1分単価、ボイスノート単価、および露骨なステージ参加料金（$5–$100）です。当社は、プラットフォーム全体のデフォルトまたは許容範囲をいつでも変更できます。"
   },
   {
    "title": "5. 出金",
    "body": "あなたはアプリに銀行情報を追加し、いつでも利用可能残高の出金をリクエストできます。出金はSlutCampにより当社独自のスケジュールで手動処理されます。保証された出金日はありません。保留中の出金リクエストには数営業日かかる場合があります。あなたの利用可能残高には、第13条に記載された出金ウィンドウをクリアした収益のみが含まれます。"
   },
   {
    "title": "6. コンテンツの権利",
    "body": "あなたは、プラットフォーム上で作成したコンテンツの所有権を保持します。SlutCampに投稿または配信することにより、あなたは当社に対し、そのコンテンツをプラットフォーム上および当社のマーケティング（ソーシャルメディアおよび広告を含む）で使用、表示、複製、宣伝するための、世界的でロイヤルティフリーのライセンスを付与します。あなたは、このライセンスを付与する権利を有すること、およびあなたのコンテンツが他者の権利を侵害しないことを確認します。"
   },
   {
    "title": "7. 行動規範",
    "body": "プラットフォーム上で、あなたは以下を行ってはなりません：ファンと連絡先情報や支払いハンドルを共有すること、ファンや取引をプラットフォーム外に移そうとすること、ヘイトスピーチや中傷を使用すること、18歳未満の者または同意していない者をフィーチャーしたコンテンツを投稿すること。これらの規則に違反すると、メッセージがブロックされ、アカウントが停止または無効化され、当社の裁量により保留中の収益を没収される場合があります。"
   },
   {
    "title": "8. アカウントへのアクセス",
    "body": "モデルアカウントは招待制のみです。当社は、いつでも、理由を問わず、通知の有無にかかわらず、あなたのアカウントを停止または無効化できます。無効化された場合、まだ支払われていない獲得残高は引き続き出金できます。"
   },
   {
    "title": "9. 守秘義務",
    "body": "あなたは、当社の事業手法、手数料体系、内部運営、他のモデルの個人情報、またはファンの個人データを、当社外部のいかなる者にも開示しないことに同意します。"
   },
   {
    "title": "10. 迂回禁止",
    "body": "あなたのアカウントが終了してから（理由を問わず）12か月間、あなたは、SlutCampを通じて出会ったファンに対し、プラットフォームの代わりに競合する有料チャットまたはカムサービスを利用するよう直接勧誘しないことに同意します。あなた自身のブランドの通常の公開宣伝（ソーシャルメディア等）は問題ありません。本条はSlutCampのファンを対象とした引き抜きのみを対象とします。"
   },
   {
    "title": "11. 終了",
    "body": "どちらの当事者もいつでも本契約を終了できます。あなたはいつでもプラットフォームの使用を停止できます。当社があなたのアカウントを無効化した場合、本契約は直ちに終了します。ただし、守秘義務、迂回禁止、およびコンテンツの権利に関する条項は、終了後も存続します。"
   },
   {
    "title": "12. 予定された1対1とFaceTime待機リスト",
    "body": "あなたは自身の1対1スケジュールを管理します：プライベート1対1予約を受ける曜日と時間、および1日あたり・1週間あたりに受ける件数を設定します。確定した予約は、そのファンのためにあなたの時間を確保します。プラットフォームは各予約の前にリマインダー通知を送信します — 3日前、3時間前、15分前です。あなたは、予約された1対1を予定開始時刻から5分以内に開始しなければなりません。時間内に開始しない場合、ファンには自動的に全額返金され、プラットフォームから謝罪が送られ、その予約についてあなたへの支払いはありません。あなたが時間通りに開始し、ファンが3分以内に参加しない場合、それはファンのノーショーです：ファンは返金を受けず、予約分は獲得分としてあなたに支払われます。あなたは、忙しいときにFaceTimeリクエストを受け取ることもあります：別の通話中にリクエストを承諾すると、ファンはあなたの待機リストに参加し、順番と推定待ち時間を確認できます。あなたの通話が終了すると、列の次のファンは参加するための90秒の猶予が与えられます。リクエストを承諾することにより、あなたは、そのファンの番が来たときにその通話を受けることを約束します。"
   },
   {
    "title": "13. 出金保留、チャージバック取消し、および不正行為",
    "body": "出金保留：あなたの収益は、獲得してから7日後に出金可能となります — あなたのお金は、稼いだ金額より1週間遅れます。アプリでは、利用可能残高とまだウィンドウ内にある収益が別々に表示されます。当社は現在のウィンドウをアプリで公開し、アプリでの通知により変更できます。すでにウィンドウ内にある収益は、開始時のウィンドウを保持します。チャージバック取消し：ファンはプリペイドクレジットで支払います。ファンのクレジット購入がチャージバック、返金、または銀行やカード発行会社によってその他の方法で取り消された場合、当社は次の順序で金銭を取り消すことができます：（1）その購入分のファンの未使用クレジット、（2）そのファンからのあなたの未払い収益 — まずまだ出金ウィンドウ内にある収益、次にすでにウィンドウをクリアした収益、（3）残りの金額はあなたのアカウントに対するマイナス調整となり、将来の収益から差し引かれてから、新たな金額が出金可能となります。あなたがすでに適切に出金した収益が、あなたの自己負担で回収されることは決してありません。チャージバックが（1）および（2）に基づいて取り消し可能な未払い収益を超える場合 — あなたがすでに関連する収益を出金したためである場合を含みます — その差額はあなたが当社に負う残高となります。その残高は自動的に回収されます：システムは、全額返済されるまで、将来の収益から差し引いてから、新たな金額が出金可能となります。チャージバック不足分について、手動または自己負担での支払いを求められることは決してありません。本段落は不正行為を保護しません — 不正に取得した収益は、以下の不正行為規則に基づいて没収されます。不正行為：組織的な購入、自己取引（自分自身から、またはあなたが管理するアカウントを通じて購入すること）、チャージバックスキーム、または収益や支払いを捏造するためのその他のスキームは、第7条の行動規範に加えて、不正行為です。不正行為については、当社は支払いを保留または審査対象とし、収益を取り消し、アカウントを終了できます。不正に取得した収益は没収されます。"
   },
   {
    "title": "14. 準拠法および裁判地",
    "body": "本契約は、抵触法の規則にかかわらず、テキサス州の法律に準拠します。本契約に起因または関連する紛争は、テキサス州に所在する州裁判所または連邦裁判所に提起しなければならず、あなたと当社は、それらの裁判所の対人管轄権および裁判地に同意します。本条のいかなる規定も、法的に放棄できないあなたの居住州が与える権利を放棄または制限するものではありません。"
   },
   {
    "title": "15. 平易な言葉による免責事項",
    "body": "本書は、明確さのために書かれた平易な言葉による要約です。法的助言ではなく、弁護士によるレビューも受けていません。当社は、署名する前にあなた自身の弁護士に本契約をレビューしてもらうことを強く推奨します。本契約の一部が執行不能と判断された場合でも、残りの部分は引き続き適用されます。"
   }
  ]
 },
 "zh": {
  "governs": "此译文仅供方便参考 — 以英文版本为准。",
  "sections": [
   {
    "title": "1. 双方",
    "body": "本模特协议（“协议”）由你，即表演者（“表演者”），与 World of Godz Entertainment LLC（“公司”）订立，公司以 SlutCamp（“SlutCamp”）名义开展业务。签署即表示你同意以下所有内容。"
   },
   {
    "title": "2. 独立承包商",
    "body": "你是独立承包商，不是公司的雇员。本协议中的任何内容均不构成雇佣、合伙或代理关系。你负责自己的税款、保险和业务费用。公司不会从你的付款中预扣税款，你同意依法申报所有收入。"
   },
   {
    "title": "3. 年龄与身份验证",
    "body": "你确认你至少 18 岁。你已经完成（或将完成）SlutCamp 的政府身份证件验证，之后才能开播，这是 18 U.S.C. §2257 记录保存合规所要求的。如果你无法验证你的年龄和身份，你不得在平台上表演。"
   },
   {
    "title": "4. 收入分成与你的费率",
    "body": "你保留粉丝在你身上消费的全部金额的 60%（聊天、通话、礼物、直播访问、优先消息、舞台加入、预约）。公司保留 40%。你在应用内在允许的范围内设定自己的费率：每条消息、每分钟视频、每条语音消息，以及你的露骨舞台加入费率 ($5–$100)。公司可随时更改全平台的默认值或允许的范围。"
   },
   {
    "title": "5. 付款",
    "body": "你在应用中添加银行详细信息，并可随时申请提取你的可用余额。付款由 SlutCamp 按公司自己的时间表手动处理 — 不保证付款日期。待处理的提现请求可能需要几个工作日。你的可用余额仅包括已通过第 13 节所述付款窗口的收入。"
   },
   {
    "title": "6. 内容权利",
    "body": "你保留你在平台上创建的内容的所有权。通过在 SlutCamp 上发布或直播，你授予公司一项全球性、免版税的许可，允许其在平台上和公司营销中（包括社交媒体和广告）使用、展示、复制和推广该内容。你确认你有权授予此许可，且你的内容不侵犯任何其他人的权利。"
   },
   {
    "title": "7. 行为规则",
    "body": "在平台上，你不得：与粉丝分享联系信息或付款账号；试图将粉丝或交易转移到平台外；使用仇恨言论或侮辱性语言；发布涉及 18 岁以下任何人或任何未同意的人的内容。违反这些规则可能导致你的消息被屏蔽、你的账号被暂停或被停用 — 并且公司可酌情没收你待领取的收入。"
   },
   {
    "title": "8. 账号访问权限",
    "body": "模特账号仅限邀请。公司可随时以任何理由停用或暂停你的账号，无论是否通知。如果被停用，任何尚未支付的已赚取余额仍可供你提取。"
   },
   {
    "title": "9. 保密",
    "body": "你同意不向公司以外的任何人披露公司的业务方法、佣金结构或内部运营，或任何其他模特的个人信息或任何粉丝的个人数据。"
   },
   {
    "title": "10. 禁止规避",
    "body": "在你的账号结束（出于任何原因）后的 12 个月内，你同意不直接招揽你通过 SlutCamp 认识的粉丝，让他们使用竞争性的付费聊天或摄像头服务来代替本平台。对你自己品牌的正常公开推广（社交媒体等）是可以的 — 本条仅涵盖针对 SlutCamp 粉丝的定向挖角。"
   },
   {
    "title": "11. 终止",
    "body": "任何一方均可随时终止本协议。你可以随时停止使用本平台。如果公司停用你的账号，本协议立即终止，但保密、禁止规避和内容权利条款除外，这些条款在终止后继续有效。"
   },
   {
    "title": "12. 预约的一对一与 FaceTime 等候名单",
    "body": "你掌控自己的一对一日程：你设定接受一对一私密预约的日期和时间，以及你每天和每周接受的数量。已确认的预约会为该粉丝保留你的时间。平台会在每次预约前向你发送提醒通知 — 提前 3 天、提前 3 小时和提前 15 分钟。你必须在预定的开始时间后 5 分钟内开始已预约的一对一。如果你未及时开始，粉丝将自动获得全额退款，并收到平台的道歉，该预约不会向你支付任何费用。如果你按时开始，而粉丝未在 3 分钟内加入，则为粉丝爽约：粉丝不获得退款，该预约将作为已赚取收入支付给你。当你忙碌时，你也可能收到 FaceTime 请求：当你在另一次通话期间接受一个请求时，该粉丝会加入你的等候名单，并能看到他在队列中的位置和预计等候时间。当你的通话结束时，队列中的下一位粉丝有 90 秒的时间加入。接受请求即表示你承诺在轮到该粉丝时接听他的通话。"
   },
   {
    "title": "13. 付款暂扣、拒付逆转与欺诈",
    "body": "付款暂扣：你的收入在赚取 7 天后才有资格提现 — 你的钱比你赚取的时间晚一周。应用会将你的可用余额与仍在其窗口内的收入分开显示。公司在应用中公布当前的窗口，并可在应用中通知后更改它；已在窗口内的收入保留其开始时的窗口。拒付逆转：粉丝使用预付点数付款。如果粉丝的点数购买被其银行或发卡机构拒付、退款或以其他方式逆转，公司可按以下顺序逆转款项：(1) 该粉丝来自该购买的未消费点数；(2) 你来自该粉丝的未支付收入 — 先是仍在其付款窗口内的收入，然后是已通过该窗口的收入；以及 (3) 任何剩余金额将成为你账号的负调整，将从你未来的收入中扣除，然后才有任何新的收入可提现。你已正当提取的收入绝不会要求你自掏腰包收回。如果一笔拒付超过根据 (1) 和 (2) 可逆转的未支付收入 — 包括因为你已提取了与之相关的收入 — 差额将成为你欠公司的余额。该余额会自动收回：系统会从你未来的收入中扣除它，然后才有任何新的收入可提现，直到全额偿还为止。对于拒付差额，你绝不需要手动或自掏腰包付款。本段不保护欺诈 — 以欺诈方式获得的收入将根据下述欺诈规则被没收。欺诈：协同购买、自我交易（从你自己或通过你控制的账号购买）、拒付骗局，或任何其他制造收入或付款的骗局，均构成欺诈，此外还包括第 7 节的行为规则。对于欺诈，公司可将付款置于暂扣或审核状态、逆转收入并终止账号；以欺诈方式获得的收入将被没收。"
   },
   {
    "title": "14. 适用法律与审判地",
    "body": "本协议受德克萨斯州法律管辖，不考虑其法律冲突规则。因本协议引起或与之相关的任何争议必须提交位于德克萨斯州的州法院或联邦法院，你和公司同意接受这些法院的属人管辖权和审判地。本节中的任何内容均不放弃或限制你所在州依法不可放弃的任何权利。"
   },
   {
    "title": "15. 通俗语言免责声明",
    "body": "这是一份为清晰起见而编写的通俗语言摘要 — 它不是法律建议，也未经律师审查。公司强烈建议你在签署前请你自己的律师审查本协议。如果本协议的任何部分被认定不可执行，其余部分仍然适用。"
   }
  ]
 },
 "ko": {
  "governs": "편의를 위한 번역입니다 — 영어 버전이 우선합니다.",
  "sections": [
   {
    "title": "1. 당사자",
    "body": "본 모델 계약(\"계약\")은 출연자인 귀하(\"출연자\")와 SlutCamp(\"SlutCamp\")라는 상호로 사업을 영위하는 World of Godz Entertainment LLC(\"회사\") 사이에 체결됩니다. 서명함으로써 귀하는 아래의 모든 내용에 동의합니다."
   },
   {
    "title": "2. 독립 계약자",
    "body": "귀하는 회사의 직원이 아닌 독립 계약자입니다. 본 계약의 어떤 내용도 고용, 파트너십 또는 대리 관계를 만들지 않습니다. 귀하는 본인의 세금, 보험 및 사업 비용에 대해 책임을 집니다. 회사는 지급금에서 세금을 원천징수하지 않으며, 귀하는 법률에서 요구하는 대로 모든 소득을 신고하는 데 동의합니다."
   },
   {
    "title": "3. 연령 및 신원 인증",
    "body": "귀하는 최소 18세 이상임을 확인합니다. 귀하는 18 U.S.C. §2257 기록 보관 준수를 위해 요구되는 대로, 라이브를 시작하기 전에 SlutCamp에서 정부 발급 신분증 인증을 완료했거나 완료할 것입니다. 연령과 신원을 인증할 수 없으면 플랫폼에서 출연할 수 없습니다."
   },
   {
    "title": "4. 수익 배분 및 요금",
    "body": "귀하는 팬이 귀하에게 쓰는 모든 금액(채팅, 통화, 선물, 라이브 입장, 우선 메시지, 무대 참여, 예약)의 60%를 가져갑니다. 회사는 40%를 가져갑니다. 귀하는 허용 범위 내에서 앱 안에서 본인의 요금을 직접 정합니다: 메시지당, 영상 분당, 음성 메시지당, 그리고 선정적 무대 참여 요금 ($5–$100). 회사는 플랫폼 전체의 기본값이나 허용 범위를 언제든지 변경할 수 있습니다."
   },
   {
    "title": "5. 지급",
    "body": "귀하는 앱에 은행 정보를 추가하고 언제든지 사용 가능 잔액의 출금을 요청할 수 있습니다. 지급은 회사의 자체 일정에 따라 SlutCamp가 수동으로 처리합니다 — 보장된 지급일은 없습니다. 대기 중인 출금 요청은 영업일 기준 며칠이 걸릴 수 있습니다. 사용 가능 잔액에는 제13조에 설명된 지급 기간을 통과한 수익만 포함됩니다."
   },
   {
    "title": "6. 콘텐츠 권리",
    "body": "귀하는 플랫폼에서 만드는 콘텐츠의 소유권을 유지합니다. SlutCamp에 게시하거나 스트리밍함으로써 귀하는 회사에 해당 콘텐츠를 플랫폼과 회사 마케팅(소셜 미디어 및 광고 포함)에서 사용, 표시, 복제 및 홍보할 수 있는 전 세계적이고 로열티 없는 라이선스를 부여합니다. 귀하는 이 라이선스를 부여할 권리가 있으며 귀하의 콘텐츠가 타인의 권리를 침해하지 않음을 확인합니다."
   },
   {
    "title": "7. 행동 규칙",
    "body": "플랫폼에서 귀하는 다음을 해서는 안 됩니다: 팬과 연락처 정보나 결제 정보를 공유하는 행위; 팬이나 거래를 플랫폼 밖으로 가져가려고 시도하는 행위; 혐오 발언이나 비하 발언을 사용하는 행위; 18세 미만의 사람이나 동의하지 않은 사람이 등장하는 콘텐츠를 게시하는 행위. 이러한 규칙을 위반하면 메시지가 차단되거나, 계정이 정지되거나, 계정이 비활성화될 수 있습니다 — 그리고 회사의 재량에 따라 보류 중인 수익을 몰수당할 수 있습니다."
   },
   {
    "title": "8. 계정 접근",
    "body": "모델 계정은 초대 전용입니다. 회사는 언제든지, 어떤 이유로든, 통지 여부와 관계없이 귀하의 계정을 정지하거나 비활성화할 수 있습니다. 비활성화된 경우, 아직 지급되지 않은 벌어둔 잔액은 귀하가 출금할 수 있도록 유지됩니다."
   },
   {
    "title": "9. 비밀 유지",
    "body": "귀하는 회사의 사업 방법, 수수료 구조 또는 내부 운영, 또는 다른 모델의 개인정보나 팬의 개인 데이터를 회사 외부의 누구에게도 공개하지 않는 데 동의합니다."
   },
   {
    "title": "10. 우회 금지",
    "body": "귀하의 계정이 종료된 후(어떤 이유로든) 12개월 동안, 귀하는 SlutCamp를 통해 만난 팬들에게 플랫폼 대신 경쟁 유료 채팅 또는 캠 서비스를 이용하도록 직접 권유하지 않는 데 동의합니다. 본인 브랜드에 대한 일반적인 공개 홍보(소셜 미디어 등)는 괜찮습니다 — 본 조항은 SlutCamp 팬을 대상으로 한 빼가기에만 적용됩니다."
   },
   {
    "title": "11. 종료",
    "body": "어느 쪽이든 언제든지 본 계약을 종료할 수 있습니다. 귀하는 언제든지 플랫폼 이용을 중단할 수 있습니다. 회사가 귀하의 계정을 비활성화하면 본 계약은 즉시 종료됩니다. 단, 비밀 유지, 우회 금지 및 콘텐츠 권리 조항은 종료 후에도 존속합니다."
   },
   {
    "title": "12. 예약된 1:1 및 FaceTime 대기 목록",
    "body": "귀하는 본인의 1:1 일정을 직접 관리합니다: 프라이빗 1:1 예약을 받는 요일과 시간을 정하고, 하루와 일주일에 몇 건을 받을지도 정합니다. 확정된 예약은 해당 팬을 위해 귀하의 시간을 예약합니다. 플랫폼은 각 예약 전에 알림을 보냅니다 — 3일 전, 3시간 전, 15분 전. 귀하는 예약된 1:1을 예정된 시작 시간으로부터 5분 안에 시작해야 합니다. 제시간에 시작하지 않으면 팬에게 자동으로 전액 환불되고 플랫폼으로부터 사과를 받으며, 해당 예약은 귀하에게 아무것도 지급하지 않습니다. 귀하가 제시간에 시작하고 팬이 3분 안에 참여하지 않으면 그것은 팬 노쇼입니다: 팬은 환불받지 못하고, 예약 금액은 귀하에게 수익으로 지급됩니다. 귀하는 바쁠 때 FaceTime 요청을 받을 수도 있습니다: 다른 통화 중에 요청을 수락하면 팬은 대기 목록에 들어가고 자신의 순서와 예상 대기 시간을 볼 수 있습니다. 통화가 끝나면 다음 순서의 팬은 90초 안에 참여할 수 있는 시간이 주어집니다. 요청을 수락함으로써 귀하는 그 팬의 차례가 오면 그의 통화를 받는 데 동의합니다."
   },
   {
    "title": "13. 지급 보류, 차지백 취소 및 사기",
    "body": "지급 보류: 귀하의 수익은 발생한 지 7일 후에 출금할 수 있습니다 — 돈은 벌어들이는 것보다 1주일 뒤에 들어옵니다. 앱은 사용 가능 잔액을 아직 기간 안에 있는 수익과 별도로 표시합니다. 회사는 현재 기간을 앱에 게시하고 앱 내 통지로 변경할 수 있습니다; 이미 기간 안에 있는 수익은 시작할 때의 기간을 유지합니다. 차지백 취소: 팬은 선불 크레딧으로 결제합니다. 팬의 크레딧 구매가 은행이나 카드 발급사에 의해 차지백, 환불 또는 기타 방식으로 취소되면, 회사는 다음 순서로 금액을 취소할 수 있습니다: (1) 해당 구매로 인한 팬의 사용하지 않은 크레딧; (2) 해당 팬으로부터 발생한 귀하의 미지급 수익 — 아직 지급 기간 안에 있는 수익을 먼저, 그다음 이미 기간을 통과한 수익; 그리고 (3) 남은 금액은 귀하의 계정에 마이너스 조정이 되며, 새로 출금할 수 있는 금액이 생기기 전에 향후 수익에서 차감됩니다. 이미 정당하게 출금한 수익은 본인 부담으로 다시 회수되지 않습니다. 차지백이 (1)과 (2)에 따라 취소할 수 있는 미지급 수익을 초과하면 — 이미 관련 수익을 출금했기 때문인 경우를 포함하여 — 그 차액은 귀하가 회사에 빚진 잔액이 됩니다. 그 잔액은 자동으로 회수됩니다: 시스템은 새로 출금할 수 있는 금액이 생기기 전에 향후 수익에서 이를 차감하며, 전액 상환될 때까지 계속됩니다. 귀하는 차지백 부족분에 대해 수동으로 또는 본인 부담으로 지급해야 할 의무가 없습니다. 본 단락은 사기를 보호하지 않습니다 — 사기적으로 얻은 수익은 뒤에 나오는 사기 규칙에 따라 몰수됩니다. 사기: 조직적인 구매, 자기 거래(본인이 직접 또는 본인이 통제하는 계정을 통해 구매하는 행위), 차지백 사기, 또는 수익이나 지급을 만들어내기 위한 기타 모든 사기는 제7조의 행동 규칙에 더해 사기에 해당합니다. 사기의 경우, 회사는 지급을 보류하거나 검토 중으로 둘 수 있고, 수익을 취소하고, 계정을 종료할 수 있습니다; 사기적으로 얻은 수익은 몰수됩니다."
   },
   {
    "title": "14. 준거법 및 재판지",
    "body": "본 계약은 텍사스주 법률의 저촉법 규칙과 관계없이 텍사스주 법률에 따라 규율됩니다. 본 계약에서 발생하거나 본 계약과 관련된 모든 분쟁은 텍사스에 위치한 주 또는 연방 법원에 제기해야 하며, 귀하와 회사는 해당 법원의 대인 관할권과 재판지에 동의합니다. 본 조항의 어떤 내용도 법적으로 포기할 수 없는, 거주 주가 귀하에게 부여하는 권리를 포기하거나 제한하지 않습니다."
   },
   {
    "title": "15. 쉬운 말 면책 조항",
    "body": "이것은 명확성을 위해 쉬운 말로 쓴 요약입니다 — 법률 자문이 아니며, 변호사의 검토를 받지 않았습니다. 회사는 서명하기 전에 본인의 변호사에게 본 계약을 검토받으실 것을 강력히 권장합니다. 본 계약의 일부가 집행 불가능하다고 판정되더라도 나머지는 계속 적용됩니다."
   }
  ]
 },
 "it": {
  "governs": "Traduzione fornita per comodità — fa fede la versione inglese.",
  "sections": [
   {
    "title": "1. Parti",
    "body": "Il presente Contratto da Modella (\"Contratto\") è tra te, l'artista (\"Artista\"), e World of Godz Entertainment LLC (\"Società\"), operante come SlutCamp (\"SlutCamp\"). Firmando, accetti tutto quanto segue."
   },
   {
    "title": "2. Collaboratrice indipendente",
    "body": "Sei una COLLABORATRICE INDIPENDENTE, non una dipendente della Società. Nulla nel presente Contratto crea un rapporto di lavoro subordinato, di società o di agenzia. Sei responsabile delle tue tasse, assicurazioni e spese aziendali. La Società non tratterrà tasse dai tuoi pagamenti, e accetti di dichiarare tutti i redditi come richiesto dalla legge."
   },
   {
    "title": "3. Verifica di età e identità",
    "body": "Confermi di avere almeno 18 anni. Hai completato (o completerai) la verifica del documento d'identità governativo con SlutCamp prima di andare live, come richiesto per la conformità alla tenuta dei registri ai sensi del 18 U.S.C. §2257. Se non puoi verificare la tua età e identità, non puoi esibirti sulla piattaforma."
   },
   {
    "title": "4. Ripartizione dei ricavi e le tue tariffe",
    "body": "Trattieni il 60% di tutto ciò che i fan spendono per te (chat, chiamate, regali, accesso live, messaggi prioritari, accessi al palco, prenotazioni). La Società trattiene il 40%. Imposti le tue tariffe dentro l'app entro gli intervalli consentiti: per messaggio, per minuto video, per nota vocale e le tue tariffe esplicite di accesso al palco ($5–$100). La Società può modificare in qualsiasi momento le impostazioni predefinite a livello di piattaforma o gli intervalli consentiti."
   },
   {
    "title": "5. Pagamenti",
    "body": "Aggiungi i tuoi dati bancari nell'app e richiedi prelievi del tuo saldo disponibile in qualsiasi momento. I pagamenti sono elaborati manualmente da SlutCamp secondo il programma della Società — non c'è una data di pagamento garantita. Le richieste di prelievo in attesa possono richiedere diversi giorni lavorativi. Il tuo saldo disponibile include solo i guadagni che hanno superato la finestra di pagamento descritta nella sezione 13."
   },
   {
    "title": "6. Diritti sui contenuti",
    "body": "Mantieni la proprietà dei contenuti che crei sulla piattaforma. Pubblicando o trasmettendo in streaming su SlutCamp, concedi alla Società una licenza mondiale, gratuita, per usare, mostrare, riprodurre e promuovere tali contenuti sulla piattaforma e nel marketing della Società (inclusi social media e annunci). Confermi di avere il diritto di concedere questa licenza e che i tuoi contenuti non violano i diritti di nessun altro."
   },
   {
    "title": "7. Regole di condotta",
    "body": "Sulla piattaforma NON devi: condividere informazioni di contatto o coordinate di pagamento con i fan; tentare di portare fan o transazioni fuori piattaforma; usare discorsi d'odio o insulti; pubblicare contenuti che mostrano chiunque abbia meno di 18 anni o chiunque non abbia dato il consenso. Violare queste regole può far bloccare i tuoi messaggi, sospendere il tuo account o disattivarlo — e potresti perdere i guadagni in attesa a discrezione della Società."
   },
   {
    "title": "8. Accesso all'account",
    "body": "Gli account modella sono solo su invito. La Società può sospendere o disattivare il tuo account in qualsiasi momento, per qualsiasi motivo, con o senza preavviso. Se disattivato, qualsiasi saldo guadagnato che non è stato pagato resta disponibile per il tuo prelievo."
   },
   {
    "title": "9. Riservatezza",
    "body": "Accetti di non divulgare i metodi aziendali della Società, le strutture commissionali o le operazioni interne, né le informazioni personali di qualsiasi altra modella o i dati personali di qualsiasi fan, a chiunque al di fuori della Società."
   },
   {
    "title": "10. Non elusione",
    "body": "Per 12 mesi dopo la fine del tuo account (per qualsiasi motivo), accetti di non sollecitare direttamente i fan che hai conosciuto tramite SlutCamp a usare un servizio concorrente di chat a pagamento o cam invece della piattaforma. La normale promozione pubblica del tuo marchio (social media, ecc.) va bene — questo copre solo il furto mirato di fan di SlutCamp."
   },
   {
    "title": "11. Risoluzione",
    "body": "Entrambe le parti possono terminare il presente Contratto in qualsiasi momento. Puoi smettere di usare la piattaforma quando vuoi. Se la Società disattiva il tuo account, il presente Contratto termina immediatamente, ad eccezione delle sezioni su riservatezza, non elusione e diritti sui contenuti, che sopravvivono alla risoluzione."
   },
   {
    "title": "12. 1-a-1 programmati e lista d'attesa FaceTime",
    "body": "Controlli il tuo programma 1-a-1: imposti i giorni e gli orari in cui accetti prenotazioni private 1-a-1, e quante ne accetti al giorno e a settimana. Una prenotazione confermata riserva il tuo tempo per quel fan. La piattaforma ti manderà avvisi di promemoria prima di ogni prenotazione — 3 giorni prima, 3 ore prima e 15 minuti prima. Devi iniziare un 1-a-1 prenotato entro 5 minuti dall'orario di inizio programmato. Se non inizi in tempo, il fan viene automaticamente rimborsato per intero e riceve le scuse dalla piattaforma, e quella prenotazione non ti paga nulla. Se inizi in tempo e il fan non si unisce entro 3 minuti, è un'assenza del fan: il fan non riceve rimborso, e la prenotazione ti viene pagata come guadagnata. Puoi anche ricevere richieste FaceTime mentre sei occupata: quando accetti una richiesta durante un'altra chiamata, il fan si unisce alla tua lista d'attesa e può vedere il suo posto in fila e la sua attesa stimata. Quando la tua chiamata finisce, il prossimo fan in fila ha una finestra di 90 secondi per unirsi. Accettando una richiesta, ti impegni a prendere la chiamata di quel fan quando arriva il suo turno."
   },
   {
    "title": "13. Trattenute sui pagamenti, storni per chargeback e frode",
    "body": "TRATTENUTA SUI PAGAMENTI: I tuoi guadagni diventano idonei al prelievo 7 giorni dopo essere stati guadagnati — i tuoi soldi sono una settimana indietro rispetto a ciò che guadagni. L'app mostra il tuo saldo disponibile separatamente dai guadagni ancora dentro la loro finestra. La Società pubblica la finestra attuale nell'app e può modificarla con avviso nell'app; i guadagni già dentro la loro finestra mantengono la finestra con cui sono iniziati. STORNI PER CHARGEBACK: I fan pagano con crediti prepagati. Se un acquisto di crediti di un fan viene sottoposto a chargeback, rimborsato o altrimenti stornato dalla sua banca o dall'emittente della carta, la Società può stornare il denaro in questo ordine: (1) i crediti non spesi del fan da quell'acquisto; (2) i tuoi guadagni non pagati da quel fan — prima i guadagni ancora dentro la loro finestra di pagamento, poi i guadagni che l'hanno già superata; e (3) qualsiasi importo residuo diventa un adeguamento negativo sul tuo account, che viene detratto dai tuoi guadagni futuri prima che qualsiasi cosa nuova diventi prelevabile. I guadagni che hai già correttamente prelevato non ti vengono mai richiesti di tasca tua. Se un chargeback supera i guadagni non pagati che possono essere stornati ai sensi di (1) e (2) — incluso perché hai già prelevato i guadagni a cui si riferisce — la differenza diventa un saldo che devi alla Società. Tale saldo viene recuperato automaticamente: il sistema lo detrae dai tuoi guadagni futuri prima che qualsiasi cosa nuova diventi prelevabile, finché non è ripagato per intero. Non sei mai tenuta a effettuare un pagamento manuale o di tasca tua per un deficit da chargeback. Questo paragrafo non protegge la frode — i guadagni ottenuti fraudolentemente sono confiscati ai sensi delle regole sulla FRODE che seguono. FRODE: Acquisti coordinati, auto-negoziazione (comprare da te stessa o tramite account che controlli), schemi di chargeback o qualsiasi altro schema per fabbricare guadagni o pagamenti è frode, in aggiunta alle regole di condotta nella sezione 7. Per la frode, la Società può mettere i pagamenti in attesa o sotto revisione, stornare guadagni e terminare account; i guadagni ottenuti fraudolentemente sono confiscati."
   },
   {
    "title": "14. Legge applicabile e foro competente",
    "body": "Il presente Contratto è governato dalle leggi dello Stato del Texas, senza riguardo alle sue norme sul conflitto di leggi. Qualsiasi controversia derivante da o relativa al presente Contratto deve essere portata davanti ai tribunali statali o federali situati in Texas, e tu e la Società acconsentite alla giurisdizione personale e alla sede di quei tribunali. Nulla in questa sezione rinuncia o limita qualsiasi diritto che il tuo stato di residenza ti concede e che non può essere legalmente oggetto di rinuncia."
   },
   {
    "title": "15. Avvertenza in linguaggio semplice",
    "body": "Questo è un riepilogo in linguaggio semplice scritto per chiarezza — NON è una consulenza legale, e non è stato revisionato da un avvocato. La Società raccomanda vivamente di far revisionare il presente Contratto dal tuo avvocato prima di firmarlo. Se qualsiasi parte del presente Contratto viene ritenuta inapplicabile, il resto continua ad applicarsi."
   }
  ]
 },
 "pl": {
  "governs": "Tłumaczenie dla wygody — obowiązuje wersja angielska.",
  "sections": [
   {
    "title": "1. Strony",
    "body": "Niniejsza Umowa modelki („Umowa”) jest zawierana między Tobą, wykonawczynią („Wykonawczyni”), a World of Godz Entertainment LLC („Spółka”), prowadzącą działalność pod nazwą SlutCamp („SlutCamp”). Podpisując ją, wyrażasz zgodę na wszystko poniżej."
   },
   {
    "title": "2. Niezależny wykonawca",
    "body": "Jesteś NIEZALEŻNYM WYKONAWCĄ, a nie pracownikiem Spółki. Żadne postanowienie niniejszej Umowy nie tworzy stosunku pracy, spółki ani stosunku agencyjnego. Jesteś odpowiedzialna za własne podatki, ubezpieczenie i koszty działalności. Spółka nie będzie potrącać podatków z Twoich wypłat, a Ty zobowiązujesz się zgłaszać wszystkie dochody zgodnie z wymogami prawa."
   },
   {
    "title": "3. Weryfikacja wieku i tożsamości",
    "body": "Potwierdzasz, że masz co najmniej 18 lat. Ukończyłaś (lub ukończysz) weryfikację na podstawie dokumentu tożsamości wydanego przez organ państwowy w SlutCamp przed rozpoczęciem transmisji na żywo, zgodnie z wymogami prowadzenia dokumentacji według 18 U.S.C. §2257. Jeśli nie możesz zweryfikować swojego wieku i tożsamości, nie możesz występować na platformie."
   },
   {
    "title": "4. Podział przychodów i Twoje stawki",
    "body": "Zatrzymujesz 60% wszystkiego, co fani u Ciebie wydadzą (czaty, rozmowy, prezenty, dostęp do transmisji na żywo, wiadomości priorytetowe, dołączenia do sceny, rezerwacje). Spółka zatrzymuje 40%. Ustalasz własne stawki w aplikacji w dozwolonych zakresach: za wiadomość, za minutę wideo, za wiadomość głosową oraz swoje stawki za dołączenie do sceny erotycznej (5–100 $). Spółka może w każdej chwili zmienić ogólnopatformowe stawki domyślne lub dozwolone zakresy."
   },
   {
    "title": "5. Wypłaty",
    "body": "Dodajesz swoje dane bankowe w aplikacji i możesz w każdej chwili wnioskować o wypłatę dostępnego salda. Wypłaty są przetwarzane ręcznie przez SlutCamp według własnego harmonogramu Spółki — nie ma gwarantowanej daty wypłaty. Oczekujące wnioski o wypłatę mogą potrwać kilka dni roboczych. Twoje dostępne saldo obejmuje wyłącznie zarobki, które przeszły okres wypłaty opisany w sekcji 13."
   },
   {
    "title": "6. Prawa do treści",
    "body": "Zachowujesz własność treści, które tworzysz na platformie. Publikując lub streamując w SlutCamp, udzielasz Spółce ogólnoświatowej, wolnej od opłat licencyjnych licencji na używanie, wyświetlanie, powielanie i promowanie tych treści na platformie oraz w marketingu Spółki (w tym w mediach społecznościowych i reklamach). Potwierdzasz, że masz prawo udzielić tej licencji oraz że Twoje treści nie naruszają praw żadnej innej osoby."
   },
   {
    "title": "7. Zasady postępowania",
    "body": "Na platformie NIE wolno Ci: udostępniać fanom danych kontaktowych ani identyfikatorów płatności; podejmować prób przeniesienia fanów lub transakcji poza platformę; używać mowy nienawiści ani wyzwisk; publikować treści przedstawiających jakąkolwiek osobę poniżej 18 roku życia lub jakąkolwiek osobę, która nie wyraziła zgody. Złamanie tych zasad może spowodować zablokowanie Twoich wiadomości, zawieszenie Twojego konta lub jego dezaktywację — a Ty możesz utracić oczekujące zarobki według uznania Spółki."
   },
   {
    "title": "8. Dostęp do konta",
    "body": "Konta modelek są dostępne tylko na zaproszenie. Spółka może zawiesić lub dezaktywować Twoje konto w każdej chwili, z dowolnego powodu, za uprzedzeniem lub bez niego. W przypadku dezaktywacji wszelkie zarobione saldo, które nie zostało wypłacone, pozostaje dostępne do wypłaty przez Ciebie."
   },
   {
    "title": "9. Poufność",
    "body": "Zobowiązujesz się nie ujawniać metod biznesowych Spółki, struktur prowizji ani operacji wewnętrznych, ani też danych osobowych żadnej innej modelki ani żadnych danych osobowych żadnego fana, żadnej osobie spoza Spółki."
   },
   {
    "title": "10. Zakaz obchodzenia",
    "body": "Przez 12 miesięcy po zakończeniu Twojego konta (z dowolnego powodu) zobowiązujesz się nie nakłaniać bezpośrednio fanów, których poznałaś za pośrednictwem SlutCamp, do korzystania z konkurencyjnej płatnej usługi czatu lub cam zamiast platformy. Normalna publiczna promocja własnej marki (media społecznościowe itp.) jest w porządku — dotyczy to wyłącznie celowanego przejmowania fanów SlutCamp."
   },
   {
    "title": "11. Rozwiązanie",
    "body": "Każda ze stron może w każdej chwili rozwiązać niniejszą Umowę. Możesz przestać korzystać z platformy, kiedy tylko chcesz. Jeśli Spółka dezaktywuje Twoje konto, niniejsza Umowa kończy się natychmiast, z wyjątkiem sekcji dotyczących poufności, zakazu obchodzenia oraz praw do treści, które pozostają w mocy po rozwiązaniu."
   },
   {
    "title": "12. Zaplanowane 1 na 1 i lista oczekujących FaceTime",
    "body": "Kontrolujesz własny harmonogram 1 na 1: ustalasz dni i godziny, w których przyjmujesz prywatne rezerwacje 1 na 1, oraz ile przyjmujesz dziennie i tygodniowo. Potwierdzona rezerwacja rezerwuje Twój czas dla tego fana. Platforma wyśle Ci przypomnienia przed każdą rezerwacją — 3 dni wcześniej, 3 godziny wcześniej i 15 minut wcześniej. Musisz rozpocząć zarezerwowane 1 na 1 w ciągu 5 minut od zaplanowanego czasu rozpoczęcia. Jeśli nie rozpoczniesz na czas, fan automatycznie otrzyma pełny zwrot oraz przeprosiny od platformy, a ta rezerwacja nic Ci nie zapłaci. Jeśli rozpoczniesz na czas, a fan nie dołączy w ciągu 3 minut, jest to nieobecność fana: fan nie otrzymuje zwrotu, a rezerwacja jest Ci wypłacana jako zarobiona. Możesz również otrzymywać prośby o FaceTime, gdy jesteś zajęta: gdy zaakceptujesz prośbę podczas innej rozmowy, fan dołącza do Twojej listy oczekujących i może zobaczyć swoje miejsce w kolejce oraz szacowany czas oczekiwania. Gdy Twoja rozmowa się zakończy, następny fan w kolejce otrzymuje 90-sekundowe okno na dołączenie. Akceptując prośbę, zobowiązujesz się przyjąć rozmowę tego fana, gdy nadejdzie jego kolej."
   },
   {
    "title": "13. Wstrzymania wypłat, cofnięcia z tytułu obciążeń zwrotnych i oszustwa",
    "body": "WSTRZYMANIE WYPŁATY: Twoje zarobki stają się uprawnione do wypłaty 7 dni po ich zarobieniu — Twoje pieniądze są tydzień za tym, co zarabiasz. Aplikacja pokazuje Twoje dostępne saldo oddzielnie od zarobków nadal znajdujących się w ich okresie. Spółka publikuje aktualny okres w aplikacji i może go zmienić za powiadomieniem w aplikacji; zarobki już znajdujące się w ich okresie zachowują okres, z którym się rozpoczęły. COFNIĘCIA Z TYTUŁU OBCIĄŻEŃ ZWROTNYCH: Fani płacą przedpłaconymi kredytami. Jeśli zakup kredytów fana zostanie obciążony zwrotnie, zwrócony lub w inny sposób cofnięty przez jego bank lub wydawcę karty, Spółka może cofnąć pieniądze w tej kolejności: (1) niewydane kredyty fana z tego zakupu; (2) Twoje niewypłacone zarobki od tego fana — najpierw zarobki nadal znajdujące się w ich okresie wypłaty, potem zarobki, które już go przeszły; oraz (3) wszelka pozostała kwota staje się ujemną korektą na Twoim koncie, która jest potrącana z Twoich przyszłych zarobków, zanim cokolwiek nowego stanie się dostępne do wypłaty. Zarobki, które już prawidłowo wypłaciłaś, nigdy nie są od Ciebie pobierane z własnej kieszeni. Jeśli obciążenie zwrotne przekroczy niewypłacone zarobki, które mogą zostać cofnięte zgodnie z (1) i (2) — w tym dlatego, że już wypłaciłaś zarobki, których ono dotyczy — różnica staje się saldem, które jesteś winna Spółce. Saldo to jest odzyskiwane automatycznie: system potrąca je z Twoich przyszłych zarobków, zanim cokolwiek nowego stanie się dostępne do wypłaty, aż zostanie spłacone w całości. Nigdy nie jesteś zobowiązana do dokonywania ręcznej ani z własnej kieszeni płatności za niedobór z tytułu obciążenia zwrotnego. Niniejszy akapit nie chroni oszustwa — zarobki uzyskane w wyniku oszustwa przepadają zgodnie z zasadami dotyczącymi OSZUSTWA poniżej. OSZUSTWO: Skoordynowane zakupy, działanie na własną korzyść (kupowanie od siebie lub za pośrednictwem kont, które kontrolujesz), schematy obciążeń zwrotnych ani żaden inny schemat mający na celu wytworzenie zarobków lub wypłat jest oszustwem, niezależnie od zasad postępowania w sekcji 7. W przypadku oszustwa Spółka może wstrzymać wypłaty lub poddać je sprawdzeniu, cofnąć zarobki i rozwiązać konta; zarobki uzyskane w wyniku oszustwa przepadają."
   },
   {
    "title": "14. Prawo właściwe i miejsce postępowania",
    "body": "Niniejsza Umowa podlega prawu stanu Teksas, bez względu na jego przepisy kolizyjne. Wszelkie spory wynikające z niniejszej Umowy lub jej dotyczące muszą być wnoszone do sądów stanowych lub federalnych znajdujących się w Teksasie, a Ty i Spółka wyrażacie zgodę na właściwość osobistą i miejsce postępowania tych sądów. Żadne postanowienie niniejszej sekcji nie zrzeka się ani nie ogranicza żadnego prawa, które przyznaje Ci Twój stan zamieszkania, a którego nie można zgodnie z prawem się zrzec."
   },
   {
    "title": "15. Zastrzeżenie dotyczące prostego języka",
    "body": "Jest to streszczenie w prostym języku, napisane dla jasności — NIE jest to porada prawna i nie zostało sprawdzone przez prawnika. Spółka stanowczo zaleca, abyś przed podpisaniem zleciła własnemu prawnikowi sprawdzenie niniejszej Umowy. Jeśli jakakolwiek część niniejszej Umowy zostanie uznana za niewykonalną, pozostała część nadal obowiązuje."
   }
  ]
 },
 "nl": {
  "governs": "Vertaling voor het gemak — de Engelse versie is leidend.",
  "sections": [
   {
    "title": "1. Partijen",
    "body": "Deze Modellenovereenkomst (\"Overeenkomst\") is tussen jou, de performer (\"Performer\"), en World of Godz Entertainment LLC (\"Bedrijf\"), handelend onder de naam SlutCamp (\"SlutCamp\"). Door te ondertekenen ga je akkoord met alles hieronder."
   },
   {
    "title": "2. Onafhankelijke Contractant",
    "body": "Je bent een ONAFHANKELIJKE CONTRACTANT, geen werknemer van het Bedrijf. Niets in deze Overeenkomst creëert een arbeids-, partnerschaps- of vertegenwoordigingsrelatie. Je bent verantwoordelijk voor je eigen belastingen, verzekeringen en zakelijke kosten. Het Bedrijf zal geen belastingen inhouden op je uitbetalingen, en je stemt ermee in om alle inkomsten te rapporteren zoals vereist door de wet."
   },
   {
    "title": "3. Leeftijds- & Identiteitsverificatie",
    "body": "Je bevestigt dat je minstens 18 jaar oud bent. Je hebt overheids-ID-verificatie bij SlutCamp voltooid (of zult voltooien) voordat je live gaat, zoals vereist voor naleving van de administratieplicht onder 18 U.S.C. §2257. Als je je leeftijd en identiteit niet kunt verifiëren, mag je niet optreden op het platform."
   },
   {
    "title": "4. Inkomstenverdeling & Jouw Tarieven",
    "body": "Je houdt 60% van alles wat fans aan jou uitgeven (chats, gesprekken, cadeaus, live-toegang, prioriteitsberichten, podiumdeelnames, boekingen). Het Bedrijf houdt 40%. Je stelt je eigen tarieven in binnen de app binnen de toegestane bereiken: per bericht, per minuut video, per spraaknotitie, en je expliciete podiumdeelname-tarieven ($5–$100). Het Bedrijf kan de platformbrede standaarden of toegestane bereiken op elk moment wijzigen."
   },
   {
    "title": "5. Uitbetalingen",
    "body": "Je voegt je bankgegevens toe in de app en vraagt op elk moment opnames van je beschikbare saldo aan. Uitbetalingen worden handmatig verwerkt door SlutCamp volgens het eigen schema van het Bedrijf — er is geen gegarandeerde uitbetalingsdatum. Openstaande opnameverzoeken kunnen enkele werkdagen duren. Je beschikbare saldo omvat alleen inkomsten die het in sectie 13 beschreven uitbetalingsvenster hebben doorlopen."
   },
   {
    "title": "6. Contentrechten",
    "body": "Je behoudt het eigendom van de content die je op het platform creëert. Door te posten of te streamen op SlutCamp verleen je het Bedrijf een wereldwijde, royaltyvrije licentie om die content te gebruiken, weer te geven, te reproduceren en te promoten op het platform en in marketing van het Bedrijf (inclusief sociale media en advertenties). Je bevestigt dat je het recht hebt om deze licentie te verlenen en dat je content geen inbreuk maakt op de rechten van iemand anders."
   },
   {
    "title": "7. Gedragsregels",
    "body": "Op het platform mag je NIET: contactgegevens of betaalhandles delen met fans; proberen fans of transacties buiten het platform te brengen; haatspraak of beledigingen gebruiken; content plaatsen met iemand onder de 18 of iemand die geen toestemming heeft gegeven. Het overtreden van deze regels kan ertoe leiden dat je berichten worden geblokkeerd, je account wordt geschorst, of je account wordt gedeactiveerd — en je kunt openstaande inkomsten verliezen naar goeddunken van het Bedrijf."
   },
   {
    "title": "8. Accounttoegang",
    "body": "Modelaccounts zijn alleen op uitnodiging. Het Bedrijf kan je account op elk moment schorsen of deactiveren, om welke reden dan ook, met of zonder kennisgeving. Indien gedeactiveerd, blijft elk verdiend saldo dat nog niet is uitbetaald voor jou beschikbaar om op te nemen."
   },
   {
    "title": "9. Vertrouwelijkheid",
    "body": "Je stemt ermee in om de bedrijfsmethoden, commissiestructuren of interne bedrijfsvoering van het Bedrijf, of de persoonlijke informatie van een ander model of de persoonlijke gegevens van een fan, niet te openbaren aan iemand buiten het Bedrijf."
   },
   {
    "title": "10. Niet-omzeiling",
    "body": "Gedurende 12 maanden nadat je account eindigt (om welke reden dan ook), stem je ermee in om fans die je via SlutCamp hebt ontmoet niet direct te benaderen om een concurrerende betaalde chat- of camdienst te gebruiken in plaats van het platform. Normale openbare promotie van je eigen merk (sociale media, enz.) is prima — dit dekt alleen gerichte stroperij van SlutCamp-fans."
   },
   {
    "title": "11. Beëindiging",
    "body": "Beide partijen kunnen deze Overeenkomst op elk moment beëindigen. Je kunt op elk moment stoppen met het gebruik van het platform. Als het Bedrijf je account deactiveert, eindigt deze Overeenkomst onmiddellijk, behalve de secties over vertrouwelijkheid, niet-omzeiling en contentrechten, die na beëindiging blijven bestaan."
   },
   {
    "title": "12. Geplande 1-op-1's & de FaceTime-wachtlijst",
    "body": "Je beheert je eigen 1-op-1-schema: je stelt de dagen en uren in wanneer je privé 1-op-1-boekingen aanneemt, en hoeveel je er per dag en per week accepteert. Een bevestigde boeking reserveert je tijd voor die fan. Het platform stuurt je herinneringen vóór elke boeking — 3 dagen ervoor, 3 uur ervoor en 15 minuten ervoor. Je moet een geboekte 1-op-1 binnen 5 minuten na de geplande starttijd starten. Als je niet op tijd start, wordt de fan automatisch volledig terugbetaald en ontvangt hij een verontschuldiging van het platform, en die boeking betaalt je niets. Als je op tijd start en de fan neemt niet binnen 3 minuten deel, is dat een fan no-show: de fan ontvangt geen terugbetaling, en de boeking wordt aan jou uitbetaald als verdiend. Je kunt ook FaceTime-verzoeken krijgen terwijl je bezig bent: wanneer je een verzoek accepteert tijdens een ander gesprek, komt de fan op je wachtlijst en kan hij zijn plaats in de rij en zijn geschatte wachttijd zien. Wanneer je gesprek eindigt, krijgt de volgende fan in de rij een venster van 90 seconden om deel te nemen. Door een verzoek te accepteren, verplicht je je om het gesprek van die fan aan te nemen wanneer zijn beurt komt."
   },
   {
    "title": "13. Uitbetalingsblokkeringen, Chargeback-terugdraaiingen & Fraude",
    "body": "UITBETALINGSBLOKKERING: Je inkomsten komen in aanmerking voor opname 7 dagen nadat ze zijn verdiend — je geld loopt één week achter op wat je maakt. De app toont je beschikbare saldo apart van inkomsten die nog in hun venster zitten. Het Bedrijf publiceert het huidige venster in de app en kan het wijzigen met kennisgeving in de app; inkomsten die al in hun venster zitten, behouden het venster waarmee ze begonnen. CHARGEBACK-TERUGDRAAIINGEN: Fans betalen met vooraf betaalde credits. Als de creditaankoop van een fan wordt teruggeboekt, terugbetaald of anderszins teruggedraaid door zijn bank of kaartuitgever, kan het Bedrijf het geld in deze volgorde terugdraaien: (1) de niet-uitgegeven credits van de fan uit die aankoop; (2) je onbetaalde inkomsten van die fan — inkomsten die nog in hun uitbetalingsvenster zitten eerst, daarna inkomsten die het al hebben doorlopen; en (3) elk overblijvend bedrag wordt een negatieve aanpassing op je account, die wordt afgetrokken van je toekomstige inkomsten voordat iets nieuws opneembaar wordt. Inkomsten die je al correct hebt opgenomen, worden nooit uit eigen zak bij je teruggevorderd. Als een chargeback de onbetaalde inkomsten overschrijdt die onder (1) en (2) kunnen worden teruggedraaid — inclusief omdat je de inkomsten waarop het betrekking heeft al hebt opgenomen — wordt het verschil een saldo dat je aan het Bedrijf verschuldigd bent. Dat saldo wordt automatisch teruggevorderd: het systeem trekt het af van je toekomstige inkomsten voordat iets nieuws opneembaar wordt, totdat het volledig is terugbetaald. Je bent nooit verplicht om een handmatige of out-of-pocket betaling te doen voor een chargeback-tekort. Deze paragraaf beschermt fraude niet — frauduleus verkregen inkomsten worden verbeurd onder de FRAUDE-regels die volgen. FRAUDE: Gecoördineerd kopen, zelfdealing (kopen van jezelf of via accounts die je beheert), chargeback-schema's, of elk ander schema om inkomsten of uitbetalingen te fabriceren is fraude, naast de gedragsregels in sectie 7. Voor fraude kan het Bedrijf uitbetalingen blokkeren of in beoordeling plaatsen, inkomsten terugdraaien en accounts beëindigen; frauduleus verkregen inkomsten worden verbeurd."
   },
   {
    "title": "14. Toepasselijk Recht & Rechtsplaats",
    "body": "Deze Overeenkomst wordt beheerst door de wetten van de Staat Texas, zonder rekening te houden met haar regels inzake wetsconflicten. Elk geschil dat voortvloeit uit of verband houdt met deze Overeenkomst moet worden voorgelegd aan de staats- of federale rechtbanken in Texas, en jij en het Bedrijf stemmen in met de persoonlijke jurisdictie en rechtsplaats van die rechtbanken. Niets in deze sectie doet afstand van of beperkt enig recht dat je thuisstaat je geeft dat wettelijk niet kan worden opgegeven."
   },
   {
    "title": "15. Disclaimer in Begrijpelijke Taal",
    "body": "Dit is een samenvatting in begrijpelijke taal, geschreven voor duidelijkheid — het is GEEN juridisch advies, en het is niet beoordeeld door een advocaat. Het Bedrijf raadt je ten zeerste aan om je eigen advocaat deze Overeenkomst te laten beoordelen voordat je tekent. Als enig deel van deze Overeenkomst niet-afdwingbaar wordt bevonden, blijft de rest van toepassing."
   }
  ]
 },
 "tr": {
  "governs": "Kolaylık için çeviri — İngilizce sürüm geçerlidir.",
  "sections": [
   {
    "title": "1. Taraflar",
    "body": "Bu Model Sözleşmesi (\"Sözleşme\"), sen, performans gösteren kişi (\"Performans Gösteren\") ile SlutCamp (\"SlutCamp\") olarak faaliyet gösteren World of Godz Entertainment LLC (\"Şirket\") arasındadır. İmzalayarak, aşağıdaki her şeyi kabul edersin."
   },
   {
    "title": "2. Bağımsız Yüklenici",
    "body": "Sen bir BAĞIMSIZ YÜKLENİCİSİN, Şirketin bir çalışanı değilsin. Bu Sözleşmedeki hiçbir şey bir istihdam, ortaklık veya temsilcilik ilişkisi oluşturmaz. Kendi vergilerinden, sigortandan ve iş giderlerinden sorumlusun. Şirket, ödemelerinden vergi kesintisi yapmayacak ve tüm geliri yasaların gerektirdiği şekilde bildirmeyi kabul edersin."
   },
   {
    "title": "3. Yaş ve Kimlik Doğrulama",
    "body": "En az 18 yaşında olduğunu onaylarsın. 18 U.S.C. §2257 kayıt tutma uyumu için gerekli olduğu üzere, canlıya geçmeden önce SlutCamp ile resmi kimlik doğrulamasını tamamladın (veya tamamlayacaksın). Yaşını ve kimliğini doğrulayamazsan, platformda performans gösteremezsin."
   },
   {
    "title": "4. Gelir Paylaşımı ve Ücretlerin",
    "body": "Hayranların sana harcadığı her şeyin %60'ını sen alırsın (sohbetler, aramalar, hediyeler, canlı erişim, öncelikli mesajlar, sahne katılımları, rezervasyonlar). Şirket %40'ını alır. Kendi ücretlerini, izin verilen aralıklar içinde uygulama içinde belirlersin: mesaj başına, video dakikası başına, sesli not başına ve müstehcen sahne katılım ücretlerin (5$–100$). Şirket, platform genelindeki varsayılanları veya izin verilen aralıkları istediği zaman değiştirebilir."
   },
   {
    "title": "5. Ödemeler",
    "body": "Banka bilgilerini uygulamaya eklersin ve kullanılabilir bakiyenin para çekme talebini istediğin zaman yaparsın. Ödemeler, Şirketin kendi programına göre SlutCamp tarafından manuel olarak işlenir — garantili bir ödeme tarihi yoktur. Bekleyen para çekme talepleri birkaç iş günü sürebilir. Kullanılabilir bakiyen yalnızca bölüm 13'te açıklanan ödeme penceresini geçmiş kazançları içerir."
   },
   {
    "title": "6. İçerik Hakları",
    "body": "Platformda oluşturduğun içeriğin mülkiyetini korursun. SlutCamp'te paylaşarak veya yayın yaparak, Şirkete o içeriği platformda ve Şirket pazarlamasında (sosyal medya ve reklamlar dahil) kullanmak, sergilemek, çoğaltmak ve tanıtmak için dünya çapında, telifsiz bir lisans verirsin. Bu lisansı verme hakkına sahip olduğunu ve içeriğinin başka kimsenin haklarını ihlal etmediğini onaylarsın."
   },
   {
    "title": "7. Davranış Kuralları",
    "body": "Platformda şunları YAPMAMALISIN: hayranlarla iletişim bilgisi veya ödeme bilgileri paylaşmak; hayranları veya işlemleri platform dışına taşımaya çalışmak; nefret söylemi veya hakaret kullanmak; 18 yaşından küçük herhangi birini veya rıza göstermemiş herhangi birini içeren içerik paylaşmak. Bu kuralları ihlal etmek, mesajlarının engellenmesine, hesabının askıya alınmasına veya hesabının devre dışı bırakılmasına yol açabilir — ve Şirketin takdirine bağlı olarak bekleyen kazançlarını kaybedebilirsin."
   },
   {
    "title": "8. Hesap Erişimi",
    "body": "Model hesapları yalnızca davetiyeyle açılır. Şirket, hesabını istediği zaman, herhangi bir nedenle, bildirimli veya bildirimsiz olarak askıya alabilir veya devre dışı bırakabilir. Devre dışı bırakılırsa, ödenmemiş kazanılmış bakiyen çekmen için kullanılabilir kalır."
   },
   {
    "title": "9. Gizlilik",
    "body": "Şirketin iş yöntemlerini, komisyon yapılarını veya iç işleyişini ya da başka herhangi bir modelin kişisel bilgilerini veya herhangi bir hayranın kişisel verilerini, Şirket dışındaki herhangi birine açıklamamayı kabul edersin."
   },
   {
    "title": "10. Dolanmayı Önleme",
    "body": "Hesabın sona erdikten sonra (herhangi bir nedenle) 12 ay boyunca, SlutCamp aracılığıyla tanıştığın hayranları, platform yerine rakip bir ücretli sohbet veya kamera hizmetini kullanmaya doğrudan yönlendirmemeyi kabul edersin. Kendi markanın normal herkese açık tanıtımı (sosyal medya vb.) sorun değildir — bu yalnızca SlutCamp hayranlarının hedefli olarak çalınmasını kapsar."
   },
   {
    "title": "11. Fesih",
    "body": "Her iki taraf da bu Sözleşmeyi istediği zaman sona erdirebilir. Platformu kullanmayı istediğin zaman bırakabilirsin. Şirket hesabını devre dışı bırakırsa, bu Sözleşme derhal sona erer; gizlilik, dolanmayı önleme ve içerik hakları bölümleri hariç, bunlar fesihten sonra da geçerli kalır."
   },
   {
    "title": "12. Planlanmış Bire Birler ve FaceTime Bekleme Listesi",
    "body": "Kendi bire bir programını sen kontrol edersin: özel bire bir rezervasyonlarını hangi gün ve saatlerde aldığını ve günde ve haftada kaç tane kabul ettiğini sen belirlersin. Onaylanmış bir rezervasyon, zamanını o hayran için ayırır. Platform, her rezervasyondan önce sana hatırlatma bildirimleri gönderecek — 3 gün önce, 3 saat önce ve 15 dakika önce. Rezerve edilmiş bir bire bire, planlanan başlangıç saatinden itibaren 5 dakika içinde başlamalısın. Zamanında başlamazsan, hayrana otomatik olarak tam iade yapılır ve platformdan bir özür alır, ve o rezervasyon sana hiçbir şey ödemez. Zamanında başlarsan ve hayran 3 dakika içinde katılmazsa, bu bir hayran gelmemesidir: hayran iade almaz ve rezervasyon sana kazanılmış olarak ödenir. Meşgulken de FaceTime istekleri alabilirsin: başka bir arama sırasında bir isteği kabul ettiğinde, hayran bekleme listene katılır ve sıradaki yerini ve tahmini bekleme süresini görebilir. Araman bittiğinde, sıradaki hayrana katılmak için 90 saniyelik bir pencere verilir. Bir isteği kabul ederek, sırası geldiğinde o hayranın aramasını almayı taahhüt edersin."
   },
   {
    "title": "13. Ödeme Bekletmeleri, Ters İbraz İptalleri ve Dolandırıcılık",
    "body": "ÖDEME BEKLETMESİ: Kazançların, kazanıldıktan 7 gün sonra çekilmeye uygun hale gelir — paran, kazandığının bir hafta gerisinden gelir. Uygulama, kullanılabilir bakiyeni hâlâ penceresi içinde olan kazançlardan ayrı gösterir. Şirket, mevcut pencereyi uygulamada yayınlar ve uygulamada bildirimde bulunarak değiştirebilir; zaten penceresi içinde olan kazançlar, başladıkları pencereyi korur. TERS İBRAZ İPTALLERİ: Hayranlar ön ödemeli kredilerle öder. Bir hayranın kredi satın alımı ters ibraz edilir, iade edilir veya bankası ya da kart sağlayıcısı tarafından başka şekilde tersine çevrilirse, Şirket parayı şu sırayla tersine çevirebilir: (1) hayranın o satın alımdan harcanmamış kredileri; (2) o hayrandan ödenmemiş kazançların — önce hâlâ ödeme penceresi içinde olan kazançlar, sonra zaten geçmiş olan kazançlar; ve (3) kalan herhangi bir tutar, hesabında negatif bir düzeltme olur ve yeni bir şey çekilebilir hale gelmeden önce gelecek kazançlarından çıkarılır. Zaten düzgün şekilde çektiğin kazançlar, asla cebinden geri toplanmaz. Bir ters ibraz, (1) ve (2) kapsamında tersine çevrilebilecek ödenmemiş kazançları aşarsa — ilgili kazançları zaten çekmiş olman nedeniyle dahil — fark, Şirkete borçlu olduğun bir bakiye olur. Bu bakiye otomatik olarak tahsil edilir: sistem, tam olarak geri ödenene kadar, yeni bir şey çekilebilir hale gelmeden önce bunu gelecek kazançlarından düşer. Bir ters ibraz açığı için asla manuel veya cepten ödeme yapman gerekmez. Bu paragraf dolandırıcılığı korumaz — hileli olarak elde edilen kazançlar, izleyen DOLANDIRICILIK kuralları uyarınca kaybedilir. DOLANDIRICILIK: Koordineli satın alma, kendi kendine işlem (kendinden veya kontrol ettiğin hesaplar aracılığıyla satın alma), ters ibraz planları veya kazanç ya da ödeme üretmeye yönelik başka herhangi bir plan, bölüm 7'deki davranış kurallarına ek olarak dolandırıcılıktır. Dolandırıcılık için Şirket, ödemeleri bekletebilir veya incelemeye alabilir, kazançları tersine çevirebilir ve hesapları sonlandırabilir; hileli olarak elde edilen kazançlar kaybedilir."
   },
   {
    "title": "14. Uygulanacak Hukuk ve Yargı Yeri",
    "body": "Bu Sözleşme, kanunlar ihtilafı kurallarına bakılmaksızın, Teksas Eyaleti yasalarına tabidir. Bu Sözleşmeden doğan veya onunla ilgili herhangi bir uyuşmazlık, Teksas'ta bulunan eyalet veya federal mahkemelerde açılmalıdır ve sen ve Şirket, o mahkemelerin kişisel yargı yetkisini ve yerini kabul edersiniz. Bu bölümdeki hiçbir şey, kendi eyaletinin sana verdiği ve yasal olarak feragat edilemeyen herhangi bir hakkı feragat ettirmez veya sınırlamaz."
   },
   {
    "title": "15. Sade Dil Feragatnamesi",
    "body": "Bu, netlik için yazılmış sade dille bir özettir — hukuki tavsiye DEĞİLDİR ve bir avukat tarafından incelenmemiştir. Şirket, imzalamadan önce kendi avukatının bu Sözleşmeyi incelemesini şiddetle tavsiye eder. Bu Sözleşmenin herhangi bir kısmı uygulanamaz bulunursa, geri kalanı hâlâ geçerlidir."
   }
  ]
 }
};
const RECRUITER_CONTRACT_I18N = {
 "es": {
  "governs": "Traducción por conveniencia — rige la versión en inglés.",
  "sections": [
   {
    "title": "1. Partes",
    "body": "Este Acuerdo de Reclutador (\"Acuerdo\") se celebra entre tú (\"Reclutador\") y World of Godz Entertainment LLC (\"Compañía\"), que opera como SlutCamp (\"SlutCamp\"). Al firmar, aceptas todo lo que se indica a continuación."
   },
   {
    "title": "2. Contratista independiente — no socio",
    "body": "Eres un CONTRATISTA INDEPENDIENTE, no un empleado de la Compañía. Nada en este Acuerdo crea una relación laboral, una sociedad comercial legal ni una relación de agencia — \"socio\" es solo como llamamos al rol en la app. Eres responsable de tus propios impuestos, seguros y gastos. La Compañía no retendrá impuestos de tus pagos."
   },
   {
    "title": "3. Lo que haces",
    "body": "Reclutas modelos para que se unan a SlutCamp usando tu enlace de referido personal. Eres responsable de tus propios métodos de reclutamiento. Debes ser honesto sobre la plataforma — sin promesas falsas sobre ganancias."
   },
   {
    "title": "4. Tu parte",
    "body": "Ganas el 20% de todo lo que gane en la plataforma cada modelo que reclutes (su parte del 60% — tu parte proviene de la porción de la Compañía, no de la modelo). La modelo se queda con su 60% completo. Los pagos se procesan según el calendario de pagos de la Compañía. Tus ganancias se vuelven elegibles para pago 7 días después de generarse, bajo el mismo periodo de espera para pagos que las modelos ven en la app."
   },
   {
    "title": "5. Terminación — a voluntad",
    "body": "La Compañía puede revocar tu estatus de reclutador EN CUALQUIER MOMENTO, por cualquier motivo o sin motivo alguno, SIN que se requiera PREVIO AVISO. Cuando se revoca, este Acuerdo termina de inmediato y dejas de ganar sobre todos los ingresos futuros de tus modelos reclutadas. Cualquier saldo ya ganado permanece disponible para retiro."
   },
   {
    "title": "6. Normas de conducta",
    "body": "NO debes: compartir datos de contacto ni identificadores de pago con nadie en la plataforma; intentar llevarte a modelos o fans fuera de la plataforma; usar discurso de odio o insultos. Incumplir estas normas puede hacer que tu cuenta sea suspendida o desactivada de inmediato."
   },
   {
    "title": "7. No elusión",
    "body": "Durante 12 meses después de que tu estatus de reclutador termine (por cualquier motivo), aceptas no reclutar para una plataforma competidora a las modelos que conociste a través de SlutCamp."
   },
   {
    "title": "8. Confidencialidad",
    "body": "Aceptas no divulgar los métodos comerciales, las estructuras de comisiones ni las operaciones internas de la Compañía a ninguna persona ajena a la Compañía."
   },
   {
    "title": "9. Ley aplicable y jurisdicción",
    "body": "Este Acuerdo se rige por las leyes del Estado de Texas, sin tener en cuenta sus normas sobre conflicto de leyes. Cualquier disputa que surja de este Acuerdo o se relacione con él debe presentarse ante los tribunales estatales o federales ubicados en Texas, y tú y la Compañía aceptan la jurisdicción personal y la competencia de esos tribunales. Nada en esta sección renuncia ni limita ningún derecho que tu estado de residencia te otorgue y que legalmente no pueda renunciarse."
   },
   {
    "title": "10. Cuota del primer año — 10 modelos en tu primer año",
    "body": "Tienes UN AÑO desde la fecha en que te registras y aceptas este Acuerdo para incorporar un mínimo de 10 modelos. Una modelo cuenta para tu cuota solo cuando se une a SlutCamp a través de tu enlace de referido personal y tiene una cuenta de modelo. Cuando tu primer año termine, la Compañía revisará tu cuenta. Si has incorporado menos de 10 modelos, la Compañía puede revocar tu estatus de reclutador si lo considera necesario, como se describe en la Sección 5. Si las modelos que incorporaste le han generado a la Compañía una cantidad significativa de dinero, la Compañía extenderá tu estatus de reclutador hasta que se cumpla la cuota, incluso si tu primer año ya terminó. Esta revisión la hace la Compañía — llegar a la marca de un año no termina por sí solo automáticamente tu estatus. Nada en esta sección limita el derecho de la Compañía, según la Sección 5, de revocar tu estatus de reclutador y tu enlace de referido en cualquier momento, por cualquier motivo, sin previo aviso."
   },
   {
    "title": "11. Aviso sobre lenguaje sencillo",
    "body": "Este es un resumen en lenguaje sencillo redactado para mayor claridad — NO es asesoramiento legal y no ha sido revisado por un abogado. La Compañía te recomienda encarecidamente que tu propio abogado revise este Acuerdo antes de firmarlo. Si alguna parte de este Acuerdo se considera inaplicable, el resto seguirá vigente."
   }
  ]
 },
 "pt": {
  "governs": "Tradução apenas para conveniência — prevalece a versão em inglês.",
  "sections": [
   {
    "title": "1. Partes",
    "body": "Este Contrato de Recrutador (\"Contrato\") é celebrado entre você (\"Recrutador\") e a World of Godz Entertainment LLC (\"Empresa\"), operando sob o nome SlutCamp (\"SlutCamp\"). Ao assinar, você concorda com tudo o que está abaixo."
   },
   {
    "title": "2. Prestador Independente — Não é Sócio",
    "body": "Você é um PRESTADOR INDEPENDENTE, e não empregado da Empresa. Nada neste Contrato cria uma relação de emprego, uma sociedade comercial legal ou uma relação de representação — \"parceiro\" é apenas como chamamos a função no app. Você é responsável por seus próprios impostos, seguros e despesas. A Empresa não reterá impostos dos seus pagamentos."
   },
   {
    "title": "3. O Que Você Faz",
    "body": "Você recruta modelos para entrar na SlutCamp usando seu link pessoal de indicação. Você é responsável pelos seus próprios métodos de recrutamento. Você deve ser honesto sobre a plataforma — sem promessas falsas sobre ganhos."
   },
   {
    "title": "4. Sua Parte",
    "body": "Você ganha 20% de tudo o que cada modelo que você recruta ganha na plataforma (a parte de 60% dela — sua parte sai da porção da Empresa, não da modelo). A modelo mantém seus 60% integralmente. Os pagamentos são processados conforme o cronograma de pagamentos da Empresa. Seus ganhos ficam disponíveis para pagamento 7 dias depois de gerados, sob o mesmo prazo de liberação que as modelos veem no app."
   },
   {
    "title": "5. Rescisão — A Qualquer Momento",
    "body": "A Empresa pode revogar seu status de recrutador A QUALQUER MOMENTO, por qualquer motivo ou sem motivo, SEM NECESSIDADE DE AVISO. Quando revogado, este Contrato se encerra imediatamente e você para de ganhar sobre todas as receitas futuras das suas modelos recrutadas. Qualquer saldo já ganho permanece disponível para saque."
   },
   {
    "title": "6. Regras de Conduta",
    "body": "Você NÃO deve: compartilhar informações de contato ou dados de pagamento com ninguém na plataforma; tentar levar modelos ou fãs para fora da plataforma; usar discurso de ódio ou injúrias. Violar estas regras pode fazer sua conta ser suspensa ou desativada imediatamente."
   },
   {
    "title": "7. Não Desvio",
    "body": "Por 12 meses após o encerramento do seu status de recrutador (por qualquer motivo), você concorda em não recrutar modelos que conheceu por meio da SlutCamp para uma plataforma concorrente."
   },
   {
    "title": "8. Confidencialidade",
    "body": "Você concorda em não divulgar os métodos de negócio, as estruturas de comissão ou as operações internas da Empresa a ninguém fora da Empresa."
   },
   {
    "title": "9. Lei Aplicável e Foro",
    "body": "Este Contrato é regido pelas leis do Estado do Texas, independentemente de suas regras de conflito de leis. Qualquer disputa decorrente deste Contrato ou a ele relacionada deve ser levada aos tribunais estaduais ou federais localizados no Texas, e você e a Empresa consentem com a jurisdição pessoal e o foro desses tribunais. Nada nesta seção renuncia ou limita qualquer direito que seu estado de origem lhe conceda e que não possa ser legalmente renunciado."
   },
   {
    "title": "10. Cota do Primeiro Ano — 10 Modelos no Seu Primeiro Ano",
    "body": "Você tem UM ANO a partir da data em que se cadastra e aceita este Contrato para incorporar um mínimo de 10 modelos. Uma modelo conta para sua cota apenas quando ela entra na SlutCamp por meio do seu link pessoal de indicação e mantém uma conta de modelo. Quando seu primeiro ano terminar, a Empresa revisará sua conta. Se você tiver incorporado menos de 10 modelos, a Empresa poderá revogar seu status de recrutador se julgar necessário, conforme descrito na Seção 5. Se as modelos que você incorporou tiverem gerado uma quantia significativa de dinheiro para a Empresa, a Empresa estenderá seu status de recrutador até que a cota seja atingida, mesmo que seu primeiro ano já tenha terminado. Esta revisão é feita pela Empresa — atingir a marca de um ano não encerra, por si só, automaticamente o seu status. Nada nesta seção limita o direito da Empresa, conforme a Seção 5, de revogar seu status de recrutador e seu link de indicação a qualquer momento, por qualquer motivo, sem aviso."
   },
   {
    "title": "11. Aviso de Linguagem Simples",
    "body": "Este é um resumo em linguagem simples, redigido para maior clareza — ele NÃO é aconselhamento jurídico e não foi revisado por um advogado. A Empresa recomenda enfaticamente que você peça ao seu próprio advogado para revisar este Contrato antes de assinar. Se qualquer parte deste Contrato for considerada inexequível, o restante continua válido."
   }
  ]
 },
 "fr": {
  "governs": "Traduction fournie à titre de commodité — la version anglaise prévaut.",
  "sections": [
   {
    "title": "1. Parties",
    "body": "Le présent Contrat de recruteur (« Contrat ») est conclu entre vous (« Recruteur ») et World of Godz Entertainment LLC (« Société »), exerçant sous le nom de SlutCamp (« SlutCamp »). En signant, vous acceptez tout ce qui suit."
   },
   {
    "title": "2. Contractant indépendant — Pas un partenaire",
    "body": "Vous êtes un CONTRACTANT INDÉPENDANT, et non un employé de la Société. Rien dans le présent Contrat ne crée de relation d'emploi, de partenariat commercial légal ou de relation de mandat — « partenaire » est simplement le nom que nous donnons au rôle dans l'application. Vous êtes responsable de vos propres impôts, assurances et frais. La Société ne retiendra pas d'impôts sur vos paiements."
   },
   {
    "title": "3. Ce que vous faites",
    "body": "Vous recrutez des modèles pour qu'elles rejoignent SlutCamp à l'aide de votre lien de parrainage personnel. Vous êtes responsable de vos propres méthodes de recrutement. Vous devez être honnête au sujet de la plateforme — aucune fausse promesse concernant les gains."
   },
   {
    "title": "4. Votre part",
    "body": "Vous gagnez 20% de tout ce que chaque modèle que vous recrutez gagne sur la plateforme (sa part de 60% — votre part provient de la portion de la Société, et non du modèle). Le modèle conserve l'intégralité de ses 60%. Les paiements sont traités selon le calendrier de paiement de la Société. Vos gains deviennent éligibles au paiement 7 jours après avoir été gagnés, selon le même délai de paiement que les modèles voient dans l'application."
   },
   {
    "title": "5. Résiliation — À tout moment",
    "body": "La Société peut révoquer votre statut de recruteur À TOUT MOMENT, pour n'importe quelle raison ou sans raison, SANS AUCUN PRÉAVIS requis. En cas de révocation, le présent Contrat prend fin immédiatement et vous cessez de gagner sur tous les revenus futurs de vos modèles recrutées. Tout solde déjà gagné reste disponible au retrait."
   },
   {
    "title": "6. Règles de conduite",
    "body": "Vous ne devez PAS : partager des coordonnées ou des identifiants de paiement avec quiconque sur la plateforme ; tenter de déplacer des modèles ou des fans hors plateforme ; utiliser des discours de haine ou des insultes. Enfreindre ces règles peut entraîner la suspension ou la désactivation immédiate de votre compte."
   },
   {
    "title": "7. Non-contournement",
    "body": "Pendant 12 mois après la fin de votre statut de recruteur (pour quelque raison que ce soit), vous acceptez de ne pas recruter, pour une plateforme concurrente, des modèles que vous avez rencontrées via SlutCamp."
   },
   {
    "title": "8. Confidentialité",
    "body": "Vous acceptez de ne divulguer à personne en dehors de la Société ni les méthodes commerciales, les structures de commission ou le fonctionnement interne de la Société."
   },
   {
    "title": "9. Droit applicable et juridiction",
    "body": "Le présent Contrat est régi par les lois de l'État du Texas, sans égard à ses règles de conflit de lois. Tout litige découlant du présent Contrat ou s'y rapportant doit être porté devant les tribunaux d'État ou fédéraux situés au Texas, et vous et la Société consentez à la compétence personnelle et à la juridiction de ces tribunaux. Rien dans cette section ne renonce ni ne limite un droit que votre État d'origine vous accorde et qui ne peut légalement faire l'objet d'une renonciation."
   },
   {
    "title": "10. Quota de première année — 10 modèles au cours de votre première année",
    "body": "Vous avez UN AN à compter de la date à laquelle vous vous inscrivez et acceptez le présent Contrat pour intégrer un minimum de 10 modèles. Un modèle ne compte dans votre quota que lorsqu'elle rejoint SlutCamp via votre lien de parrainage personnel et détient un compte de modèle. À la fin de votre première année, la Société examinera votre compte. Si vous avez intégré moins de 10 modèles, la Société peut révoquer votre statut de recruteur si elle le juge nécessaire, comme décrit à la Section 5. Si les modèles que vous avez intégrées ont fait gagner à la Société une somme d'argent importante, la Société prolongera votre statut de recruteur jusqu'à ce que le quota soit atteint, même si votre première année est terminée. Cet examen est effectué par la Société — atteindre la marque d'un an ne met pas en soi automatiquement fin à votre statut. Rien dans cette section ne limite le droit de la Société, au titre de la Section 5, de révoquer votre statut de recruteur et votre lien de parrainage à tout moment, pour n'importe quelle raison, sans préavis."
   },
   {
    "title": "11. Avertissement en langage clair",
    "body": "Ceci est un résumé en langage clair rédigé pour plus de clarté — ce n'est PAS un avis juridique, et il n'a pas été examiné par un avocat. La Société vous recommande vivement de faire examiner le présent Contrat par votre propre avocat avant de signer. Si une partie du présent Contrat est jugée inapplicable, le reste continue de s'appliquer."
   }
  ]
 },
 "de": {
  "governs": "Übersetzung zur Erleichterung — die englische Version ist maßgebend.",
  "sections": [
   {
    "title": "1. Parteien",
    "body": "Diese Recruiter-Vereinbarung („Vereinbarung\") ist zwischen Ihnen („Recruiter\") und World of Godz Entertainment LLC („Unternehmen\"), die als SlutCamp („SlutCamp\") tätig ist. Mit Ihrer Unterschrift stimmen Sie allem Folgenden zu."
   },
   {
    "title": "2. Unabhängige Auftragnehmerin / Unabhängiger Auftragnehmer — Kein Partner",
    "body": "Sie sind eine UNABHÄNGIGE AUFTRAGNEHMERIN / ein UNABHÄNGIGER AUFTRAGNEHMER, keine Angestellte / kein Angestellter des Unternehmens. Nichts in dieser Vereinbarung begründet ein Beschäftigungsverhältnis, eine rechtliche Geschäftspartnerschaft oder ein Vertretungsverhältnis — „Partner\" ist nur, wie wir die Rolle in der App nennen. Sie sind für Ihre eigenen Steuern, Versicherungen und Ausgaben verantwortlich. Das Unternehmen wird keine Steuern von Ihren Auszahlungen einbehalten."
   },
   {
    "title": "3. Was Sie tun",
    "body": "Sie werben Modelle an, um SlutCamp über Ihren persönlichen Empfehlungslink beizutreten. Sie sind für Ihre eigenen Anwerbemethoden verantwortlich. Sie müssen ehrlich über die Plattform sein — keine falschen Versprechen über Einnahmen."
   },
   {
    "title": "4. Ihr Anteil",
    "body": "Sie verdienen 20% von allem, was jedes von Ihnen angeworbene Model auf der Plattform verdient (ihr 60%-Anteil — Ihr Anteil kommt aus dem Anteil des Unternehmens, nicht vom Model). Das Model behält ihre vollen 60%. Zahlungen werden nach dem Auszahlungszeitplan des Unternehmens bearbeitet. Ihre Einnahmen werden 7 Tage nach dem Verdienen für die Auszahlung berechtigt, unter demselben Auszahlungsfenster, das die Modelle in der App sehen."
   },
   {
    "title": "5. Kündigung — Jederzeit möglich",
    "body": "Das Unternehmen kann Ihren Recruiter-Status JEDERZEIT, aus beliebigem Grund oder ohne Grund, OHNE erforderliche VORANKÜNDIGUNG widerrufen. Bei Widerruf endet diese Vereinbarung sofort und Sie hören auf, an allen zukünftigen Einnahmen Ihrer angeworbenen Modelle zu verdienen. Jedes bereits verdiente Guthaben bleibt für die Abhebung verfügbar."
   },
   {
    "title": "6. Verhaltensregeln",
    "body": "Sie dürfen NICHT: Kontaktdaten oder Zahlungs-Handles mit jemandem auf der Plattform teilen; versuchen, Modelle oder Fans außerhalb der Plattform zu bewegen; Hassrede oder Beleidigungen verwenden. Ein Verstoß gegen diese Regeln kann dazu führen, dass Ihr Account sofort ausgesetzt oder deaktiviert wird."
   },
   {
    "title": "7. Umgehungsverbot",
    "body": "Für 12 Monate nach Beendigung Ihres Recruiter-Status (aus beliebigem Grund) stimmen Sie zu, Modelle, die Sie über SlutCamp kennengelernt haben, nicht für eine konkurrierende Plattform anzuwerben."
   },
   {
    "title": "8. Vertraulichkeit",
    "body": "Sie stimmen zu, die Geschäftsmethoden, Provisionsstrukturen oder internen Abläufe des Unternehmens gegenüber niemandem außerhalb des Unternehmens offenzulegen."
   },
   {
    "title": "9. Geltendes Recht & Gerichtsstand",
    "body": "Diese Vereinbarung unterliegt den Gesetzen des Bundesstaates Texas, ohne Rücksicht auf seine Kollisionsnormen. Jeder Streit, der aus dieser Vereinbarung entsteht oder damit zusammenhängt, muss vor den staatlichen oder bundesstaatlichen Gerichten in Texas gebracht werden, und Sie und das Unternehmen stimmen der persönlichen Gerichtsbarkeit und dem Gerichtsstand dieser Gerichte zu. Nichts in diesem Abschnitt verzichtet auf oder beschränkt ein Recht, das Ihnen Ihr Heimatstaat gibt und das gesetzlich nicht verzichtet werden kann."
   },
   {
    "title": "10. Quote im ersten Jahr — 10 Modelle in Ihrem ersten Jahr",
    "body": "Sie haben EIN JAHR ab dem Datum, an dem Sie sich registrieren und diese Vereinbarung akzeptieren, um mindestens 10 Modelle einzubinden. Ein Model zählt nur dann zu Ihrer Quote, wenn sie SlutCamp über Ihren persönlichen Empfehlungslink beitritt und einen Model-Account besitzt. Wenn Ihr erstes Jahr endet, wird das Unternehmen Ihren Account überprüfen. Wenn Sie weniger als 10 Modelle eingebunden haben, kann das Unternehmen Ihren Recruiter-Status widerrufen, wenn dies für notwendig erachtet wird, wie in Abschnitt 5 beschrieben. Wenn die von Ihnen eingebundenen Modelle dem Unternehmen einen beträchtlichen Geldbetrag eingebracht haben, wird das Unternehmen Ihren Recruiter-Status verlängern, bis die Quote erfüllt ist, auch wenn Ihr erstes Jahr beendet ist. Diese Überprüfung wird vom Unternehmen durchgeführt — das Erreichen der Ein-Jahres-Marke beendet Ihren Status nicht von selbst automatisch. Nichts in diesem Abschnitt beschränkt das Recht des Unternehmens gemäß Abschnitt 5, Ihren Recruiter-Status und Ihren Empfehlungslink jederzeit, aus beliebigem Grund, ohne Vorankündigung zu widerrufen."
   },
   {
    "title": "11. Haftungsausschluss in einfacher Sprache",
    "body": "Dies ist eine Zusammenfassung in einfacher Sprache, die der Klarheit dient — sie ist KEINE Rechtsberatung und wurde nicht von einem Anwalt überprüft. Das Unternehmen empfiehlt Ihnen dringend, diese Vereinbarung vor der Unterzeichnung von Ihrem eigenen Anwalt überprüfen zu lassen. Wenn ein Teil dieser Vereinbarung für nicht durchsetzbar befunden wird, gilt der Rest weiterhin."
   }
  ]
 },
 "ru": {
  "governs": "Перевод для удобства — преимущественную силу имеет английская версия.",
  "sections": [
   {
    "title": "1. Стороны",
    "body": "Настоящее Соглашение рекрутера («Соглашение») заключается между вами («Рекрутер») и World of Godz Entertainment LLC («Компания»), осуществляющей деятельность под названием SlutCamp («SlutCamp»). Подписывая, вы соглашаетесь со всем нижеизложенным."
   },
   {
    "title": "2. Независимый подрядчик — не партнёр",
    "body": "Вы являетесь НЕЗАВИСИМЫМ ПОДРЯДЧИКОМ, а не сотрудником Компании. Ничто в настоящем Соглашении не создаёт трудовых отношений, юридического делового партнёрства или агентских отношений — «партнёр» — это просто то, как мы называем эту роль в приложении. Вы несёте ответственность за свои собственные налоги, страхование и расходы. Компания не будет удерживать налоги из ваших выплат."
   },
   {
    "title": "3. Что вы делаете",
    "body": "Вы привлекаете моделей присоединяться к SlutCamp, используя вашу личную реферальную ссылку. Вы несёте ответственность за ваши собственные методы привлечения. Вы должны быть честны в отношении платформы — никаких ложных обещаний о доходах."
   },
   {
    "title": "4. Ваша доля",
    "body": "Вы зарабатываете 20% от всего, что каждая привлечённая вами модель зарабатывает на платформе (их доля 60% — ваша доля берётся из части Компании, а не от модели). Модель сохраняет свои полные 60%. Платежи обрабатываются по расписанию выплат Компании. Ваши доходы становятся доступными для выплаты через 7 дней после их получения, в соответствии с тем же периодом выплаты, который модели видят в приложении."
   },
   {
    "title": "5. Расторжение — по усмотрению сторон",
    "body": "Компания может отозвать ваш статус рекрутера В ЛЮБОЕ ВРЕМЯ, по любой причине или без причины, БЕЗ ТРЕБОВАНИЯ УВЕДОМЛЕНИЯ. При отзыве настоящее Соглашение немедленно прекращается, и вы перестаёте зарабатывать на всех будущих доходах от ваших привлечённых моделей. Любой уже заработанный баланс остаётся доступным для вывода."
   },
   {
    "title": "6. Правила поведения",
    "body": "Вы НЕ должны: делиться контактной информацией или платёжными реквизитами с кем-либо на платформе; пытаться увести моделей или фанатов за пределы платформы; использовать язык ненависти или оскорбления. Нарушение этих правил может привести к немедленной приостановке или деактивации вашего аккаунта."
   },
   {
    "title": "7. Запрет обхода",
    "body": "В течение 12 месяцев после прекращения вашего статуса рекрутера (по любой причине) вы соглашаетесь не привлекать моделей, с которыми вы познакомились через SlutCamp, на конкурирующую платформу."
   },
   {
    "title": "8. Конфиденциальность",
    "body": "Вы соглашаетесь не раскрывать методы ведения бизнеса Компании, структуры комиссий или внутренние операции кому-либо за пределами Компании."
   },
   {
    "title": "9. Применимое право и место рассмотрения",
    "body": "Настоящее Соглашение регулируется законами штата Техас, без учёта его коллизионных норм. Любой спор, возникающий из настоящего Соглашения или связанный с ним, должен подаваться в суды штата или федеральные суды, расположенные в Техасе, и вы и Компания соглашаетесь с персональной юрисдикцией и местом рассмотрения этих судов. Ничто в этом разделе не отменяет и не ограничивает какое-либо право, предоставляемое вам вашим родным штатом, которое не может быть юридически отменено."
   },
   {
    "title": "10. Квота первого года — 10 моделей в ваш первый год",
    "body": "У вас есть ОДИН ГОД с даты, когда вы регистрируетесь и принимаете настоящее Соглашение, чтобы подключить минимум 10 моделей. Модель засчитывается в вашу квоту только когда она присоединяется к SlutCamp по вашей личной реферальной ссылке и имеет аккаунт модели. Когда ваш первый год заканчивается, Компания рассмотрит ваш аккаунт. Если вы подключили менее 10 моделей, Компания может отозвать ваш статус рекрутера, если сочтёт это необходимым, как описано в Разделе 5. Если модели, которых вы подключили, принесли Компании значительную сумму денег, Компания продлит ваш статус рекрутера до выполнения квоты, даже если ваш первый год закончился. Эта проверка проводится Компанией — достижение отметки в один год само по себе не прекращает ваш статус автоматически. Ничто в этом разделе не ограничивает право Компании в соответствии с Разделом 5 отозвать ваш статус рекрутера и вашу реферальную ссылку в любое время, по любой причине, без уведомления."
   },
   {
    "title": "11. Отказ от ответственности, изложенный простым языком",
    "body": "Это краткое изложение простым языком, написанное для ясности — это НЕ юридическая консультация, и оно не было проверено адвокатом. Компания настоятельно рекомендует вам попросить вашего собственного адвоката проверить настоящее Соглашение перед подписанием. Если какая-либо часть настоящего Соглашения будет признана неисполнимой, остальная часть по-прежнему применяется."
   }
  ]
 },
 "ja": {
  "governs": "便宜上の翻訳です — 英語版が正式なものとなります。",
  "sections": [
   {
    "title": "1. 当事者",
    "body": "本リクルーター契約（以下「本契約」）は、あなた（以下「リクルーター」）と、SlutCampとして事業を行う World of Godz Entertainment LLC（以下「当社」）との間で締結されます。署名することにより、あなたは以下のすべてに同意します。"
   },
   {
    "title": "2. 独立請負業者 — パートナーではありません",
    "body": "あなたは当社の従業員ではなく、独立請負業者です。本契約のいかなる規定も、雇用関係、法的な事業パートナーシップ、または代理関係を創設するものではありません。「パートナー」はアプリ内でその役割を呼ぶ際の名称にすぎません。あなたは自身の税金、保険、および経費について責任を負います。当社はあなたの支払いから税金を源泉徴収しません。"
   },
   {
    "title": "3. あなたの役割",
    "body": "あなたは、あなた専用の紹介リンクを使用して、モデルをSlutCampに参加するよう募集します。あなたは自身の募集方法について責任を負います。プラットフォームについて正直でなければなりません — 収益に関する虚偽の約束をしてはなりません。"
   },
   {
    "title": "4. あなたの取り分",
    "body": "あなたは、あなたが募集した各モデルがプラットフォームで獲得する金額の20%を稼ぎます（彼女たちの60%の取り分 — あなたの取り分は当社の部分から支払われ、モデルからは支払われません）。モデルは完全な60%を保持します。支払いは当社の出金スケジュールで処理されます。あなたの収益は、モデルがアプリで見るのと同じ出金ウィンドウに基づいて、獲得してから7日後に出金可能となります。"
   },
   {
    "title": "5. 終了 — 任意",
    "body": "当社は、いつでも、理由の有無を問わず、通知を必要とせずに、あなたのリクルーター資格を取り消すことができます。取り消されると、本契約は直ちに終了し、あなたが募集したモデルからの将来のすべての収益に対する獲得は停止します。すでに獲得した残高は引き続き出金できます。"
   },
   {
    "title": "6. 行動規範",
    "body": "あなたは以下を行ってはなりません：プラットフォーム上のいかなる者とも連絡先情報や支払いハンドルを共有すること、モデルやファンをプラットフォーム外に移そうとすること、ヘイトスピーチや中傷を使用すること。これらの規則に違反すると、アカウントが直ちに停止または無効化される場合があります。"
   },
   {
    "title": "7. 迂回禁止",
    "body": "あなたのリクルーター資格が終了してから（理由を問わず）12か月間、あなたは、SlutCampを通じて出会ったモデルを競合プラットフォームに募集しないことに同意します。"
   },
   {
    "title": "8. 守秘義務",
    "body": "あなたは、当社の事業手法、手数料体系、または内部運営を、当社外部のいかなる者にも開示しないことに同意します。"
   },
   {
    "title": "9. 準拠法および裁判地",
    "body": "本契約は、抵触法の規則にかかわらず、テキサス州の法律に準拠します。本契約に起因または関連する紛争は、テキサス州に所在する州裁判所または連邦裁判所に提起しなければならず、あなたと当社は、それらの裁判所の対人管轄権および裁判地に同意します。本条のいかなる規定も、法的に放棄できないあなたの居住州が与える権利を放棄または制限するものではありません。"
   },
   {
    "title": "10. 初年度クォータ — 初年度に10人のモデル",
    "body": "あなたは、登録して本契約に同意した日から1年間で、最低10人のモデルをオンボーディングしなければなりません。モデルがあなたの個人紹介リンクを通じてSlutCampに参加し、モデルアカウントを保持する場合にのみ、あなたのクォータにカウントされます。初年度が終了すると、当社はあなたのアカウントを審査します。オンボーディングしたモデルが10人未満の場合、当社は必要と判断すれば、第5条に記載のとおり、あなたのリクルーター資格を取り消す場合があります。あなたがオンボーディングしたモデルが当社に多額の収益をもたらしている場合、当社は、初年度が終了していても、クォータが満たされるまであなたのリクルーター資格を延長します。この審査は当社が行います。1年の節目に到達しただけでは、自動的に資格が終了することはありません。本条のいかなる規定も、第5条に基づく当社の権利、すなわちいつでも、理由を問わず、通知なしにあなたのリクルーター資格と紹介リンクを取り消す権利を制限するものではありません。"
   },
   {
    "title": "11. 平易な言葉による免責事項",
    "body": "本書は、明確さのために書かれた平易な言葉による要約です。法的助言ではなく、弁護士によるレビューも受けていません。当社は、署名する前にあなた自身の弁護士に本契約をレビューしてもらうことを強く推奨します。本契約の一部が執行不能と判断された場合でも、残りの部分は引き続き適用されます。"
   }
  ]
 },
 "zh": {
  "governs": "此译文仅供方便参考 — 以英文版本为准。",
  "sections": [
   {
    "title": "1. 双方",
    "body": "本招募者协议（“协议”）由你（“招募者”）与 World of Godz Entertainment LLC（“公司”）订立，公司以 SlutCamp（“SlutCamp”）名义开展业务。签署即表示你同意以下所有内容。"
   },
   {
    "title": "2. 独立承包商 — 不是合伙人",
    "body": "你是独立承包商，不是公司的雇员。本协议中的任何内容均不构成雇佣关系、法律上的业务合伙关系或代理关系 — “合伙人”只是我们在应用中对该角色的称呼。你负责自己的税款、保险和费用。公司不会从你的付款中预扣税款。"
   },
   {
    "title": "3. 你的职责",
    "body": "你使用你的个人推荐链接招募模特加入 SlutCamp。你对自己的招募方法负责。你必须诚实介绍本平台 — 不得对收入作虚假承诺。"
   },
   {
    "title": "4. 你的分成",
    "body": "你赚取你招募的每位模特在平台上全部收入的 20%（她们的 60% 份额 — 你的分成来自公司的部分，而不是来自模特）。模特保留她完整的 60%。付款按公司的付款时间表处理。你的收入在赚取 7 天后才有资格付款，适用与模特在应用中看到的相同的付款窗口。"
   },
   {
    "title": "5. 终止 — 任意终止",
    "body": "公司可随时以任何理由或无理由撤销你的招募者身份，无需通知。被撤销时，本协议立即终止，你停止从你招募的模特的未来收入中获利。任何已赚取的余额仍可供提取。"
   },
   {
    "title": "6. 行为规则",
    "body": "你不得：在平台上与任何人分享联系信息或付款账号；试图将模特或粉丝转移到平台外；使用仇恨言论或侮辱性语言。违反这些规则可能导致你的账号立即被暂停或停用。"
   },
   {
    "title": "7. 禁止规避",
    "body": "在你的招募者身份结束（出于任何原因）后的 12 个月内，你同意不将你通过 SlutCamp 认识的模特招募到竞争平台。"
   },
   {
    "title": "8. 保密",
    "body": "你同意不向公司以外的任何人披露公司的业务方法、佣金结构或内部运营。"
   },
   {
    "title": "9. 适用法律与审判地",
    "body": "本协议受德克萨斯州法律管辖，不考虑其法律冲突规则。因本协议引起或与之相关的任何争议必须提交位于德克萨斯州的州法院或联邦法院，你和公司同意接受这些法院的属人管辖权和审判地。本节中的任何内容均不放弃或限制你所在州依法不可放弃的任何权利。"
   },
   {
    "title": "10. 第一年度配额 — 第一年度 10 位模特",
    "body": "你从签署并接受本协议之日起有一年时间，至少招募 10 位模特。只有当一位模特通过你的个人推荐链接加入 SlutCamp 并持有模特账号时，她才计入你的配额。当你的第一年结束时，公司将审查你的账号。如果你招募的模特少于 10 位，公司如认为有必要，可按第 5 节所述撤销你的招募者身份。如果你招募的模特已为公司赚取了可观的金额，公司将延长你的招募者身份，直到达到配额为止，即使你的第一年已结束。此审查由公司进行 — 仅达到一年期限本身并不会自动终止你的身份。本节中的任何内容均不限制公司根据第 5 节随时以任何理由、无需通知撤销你的招募者身份和推荐链接的权利。"
   },
   {
    "title": "11. 通俗语言免责声明",
    "body": "这是一份为清晰起见而编写的通俗语言摘要 — 它不是法律建议，也未经律师审查。公司强烈建议你在签署前请你自己的律师审查本协议。如果本协议的任何部分被认定不可执行，其余部分仍然适用。"
   }
  ]
 },
 "ko": {
  "governs": "편의를 위한 번역입니다 — 영어 버전이 우선합니다.",
  "sections": [
   {
    "title": "1. 당사자",
    "body": "본 리크루터 계약(\"계약\")은 귀하(\"리크루터\")와 SlutCamp(\"SlutCamp\")라는 상호로 사업을 영위하는 World of Godz Entertainment LLC(\"회사\") 사이에 체결됩니다. 서명함으로써 귀하는 아래의 모든 내용에 동의합니다."
   },
   {
    "title": "2. 독립 계약자 — 파트너가 아님",
    "body": "귀하는 회사의 직원이 아닌 독립 계약자입니다. 본 계약의 어떤 내용도 고용 관계, 법적 사업 파트너십 또는 대리 관계를 만들지 않습니다 — \"파트너\"는 앱에서 그 역할을 부르는 이름일 뿐입니다. 귀하는 본인의 세금, 보험 및 비용에 대해 책임을 집니다. 회사는 지급금에서 세금을 원천징수하지 않습니다."
   },
   {
    "title": "3. 귀하가 하는 일",
    "body": "귀하는 개인 추천 링크를 사용하여 모델들을 SlutCamp에 가입하도록 모집합니다. 귀하는 본인의 모집 방법에 대해 책임을 집니다. 플랫폼에 대해 정직해야 합니다 — 수익에 대해 거짓 약속을 해서는 안 됩니다."
   },
   {
    "title": "4. 귀하의 몫",
    "body": "귀하는 모집한 각 모델이 플랫폼에서 버는 모든 수익의 20%를 받습니다 (그들의 60% 몫 — 귀하의 몫은 모델이 아닌 회사의 부분에서 나옵니다). 모델은 자신의 60% 전액을 유지합니다. 지급은 회사의 지급 일정에 따라 처리됩니다. 귀하의 수익은 발생한 지 7일 후에 지급받을 수 있으며, 모델들이 앱에서 보는 것과 동일한 지급 기간이 적용됩니다."
   },
   {
    "title": "5. 종료 — 임의 종료 가능",
    "body": "회사는 언제든지, 어떤 이유로든 또는 이유 없이, 통지 없이 귀하의 리크루터 자격을 취소할 수 있습니다. 취소되면 본 계약은 즉시 종료되고 모집한 모델들의 향후 모든 수익에 대한 수익 창출이 중단됩니다. 이미 벌어둔 잔액은 출금할 수 있도록 유지됩니다."
   },
   {
    "title": "6. 행동 규칙",
    "body": "귀하는 다음을 해서는 안 됩니다: 플랫폼에서 누구와도 연락처 정보나 결제 정보를 공유하는 행위; 모델이나 팬을 플랫폼 밖으로 가져가려고 시도하는 행위; 혐오 발언이나 비하 발언을 사용하는 행위. 이러한 규칙을 위반하면 계정이 즉시 정지되거나 비활성화될 수 있습니다."
   },
   {
    "title": "7. 우회 금지",
    "body": "귀하의 리크루터 자격이 종료된 후(어떤 이유로든) 12개월 동안, 귀하는 SlutCamp를 통해 만난 모델들을 경쟁 플랫폼으로 모집하지 않는 데 동의합니다."
   },
   {
    "title": "8. 비밀 유지",
    "body": "귀하는 회사의 사업 방법, 수수료 구조 또는 내부 운영을 회사 외부의 누구에게도 공개하지 않는 데 동의합니다."
   },
   {
    "title": "9. 준거법 및 재판지",
    "body": "본 계약은 텍사스주 법률의 저촉법 규칙과 관계없이 텍사스주 법률에 따라 규율됩니다. 본 계약에서 발생하거나 본 계약과 관련된 모든 분쟁은 텍사스에 위치한 주 또는 연방 법원에 제기해야 하며, 귀하와 회사는 해당 법원의 대인 관할권과 재판지에 동의합니다. 본 조항의 어떤 내용도 법적으로 포기할 수 없는, 거주 주가 귀하에게 부여하는 권리를 포기하거나 제한하지 않습니다."
   },
   {
    "title": "10. 첫해 할당량 — 첫해에 10명의 모델",
    "body": "귀하는 가입하고 본 계약에 동의한 날로부터 1년 안에 최소 10명의 모델을 온보딩해야 합니다. 모델은 귀하의 개인 추천 링크를 통해 SlutCamp에 가입하고 모델 계정을 보유할 때만 할당량에 포함됩니다. 첫해가 끝나면 회사는 귀하의 계정을 검토합니다. 온보딩한 모델이 10명 미만이면 회사는 제5조에 설명된 대로 필요하다고 판단될 경우 리크루터 자격을 취소할 수 있습니다. 온보딩한 모델들이 회사에 상당한 금액을 벌어다 주었다면, 회사는 첫해가 끝났더라도 할당량을 충족할 때까지 리크루터 자격을 연장합니다. 이 검토는 회사가 수행합니다 — 1년이 되었다는 사실만으로 자격이 자동으로 종료되지 않습니다. 본 조항의 어떤 내용도 제5조에 따른, 언제든지 어떤 이유로든 통지 없이 리크루터 자격과 추천 링크를 취소할 수 있는 회사의 권리를 제한하지 않습니다."
   },
   {
    "title": "11. 쉬운 말 면책 조항",
    "body": "이것은 명확성을 위해 쉬운 말로 쓴 요약입니다 — 법률 자문이 아니며, 변호사의 검토를 받지 않았습니다. 회사는 서명하기 전에 본인의 변호사에게 본 계약을 검토받으실 것을 강력히 권장합니다. 본 계약의 일부가 집행 불가능하다고 판정되더라도 나머지는 계속 적용됩니다."
   }
  ]
 },
 "it": {
  "governs": "Traduzione fornita per comodità — fa fede la versione inglese.",
  "sections": [
   {
    "title": "1. Parti",
    "body": "Il presente Contratto Reclutatore (\"Contratto\") è tra te (\"Reclutatore\") e World of Godz Entertainment LLC (\"Società\"), operante come SlutCamp (\"SlutCamp\"). Firmando, accetti tutto quanto segue."
   },
   {
    "title": "2. Collaboratore indipendente — Non un socio",
    "body": "Sei un COLLABORATORE INDIPENDENTE, non un dipendente della Società. Nulla nel presente Contratto crea un rapporto di lavoro subordinato, una società commerciale legale o un rapporto di agenzia — \"partner\" è solo come chiamiamo il ruolo nell'app. Sei responsabile delle tue tasse, assicurazioni e spese. La Società non tratterrà tasse dai tuoi pagamenti."
   },
   {
    "title": "3. Cosa fai",
    "body": "Recluti modelle perché si uniscano a SlutCamp usando il tuo link di referral personale. Sei responsabile dei tuoi metodi di reclutamento. Devi essere onesto sulla piattaforma — nessuna falsa promessa sui guadagni."
   },
   {
    "title": "4. La tua quota",
    "body": "Guadagni il 20% di tutto ciò che ogni modella che recluti guadagna sulla piattaforma (la loro quota del 60% — la tua quota proviene dalla porzione della Società, non dalla modella). La modella trattiene il suo intero 60%. I pagamenti sono elaborati secondo il programma di pagamento della Società. I tuoi guadagni diventano idonei al pagamento 7 giorni dopo essere stati guadagnati, secondo la stessa finestra di pagamento che le modelle vedono nell'app."
   },
   {
    "title": "5. Risoluzione — A discrezione",
    "body": "La Società può revocare il tuo status di reclutatore IN QUALSIASI MOMENTO, per qualsiasi motivo o senza motivo, SENZA PREAVVISO richiesto. Quando revocato, il presente Contratto termina immediatamente e smetti di guadagnare su tutti i ricavi futuri dalle modelle che hai reclutato. Qualsiasi saldo già guadagnato resta disponibile per il prelievo."
   },
   {
    "title": "6. Regole di condotta",
    "body": "NON devi: condividere informazioni di contatto o coordinate di pagamento con chiunque sulla piattaforma; tentare di portare modelle o fan fuori piattaforma; usare discorsi d'odio o insulti. Violare queste regole può far sospendere o disattivare immediatamente il tuo account."
   },
   {
    "title": "7. Non elusione",
    "body": "Per 12 mesi dopo la fine del tuo status di reclutatore (per qualsiasi motivo), accetti di non reclutare modelle che hai conosciuto tramite SlutCamp verso una piattaforma concorrente."
   },
   {
    "title": "8. Riservatezza",
    "body": "Accetti di non divulgare i metodi aziendali della Società, le strutture commissionali o le operazioni interne a chiunque al di fuori della Società."
   },
   {
    "title": "9. Legge applicabile e foro competente",
    "body": "Il presente Contratto è governato dalle leggi dello Stato del Texas, senza riguardo alle sue norme sul conflitto di leggi. Qualsiasi controversia derivante da o relativa al presente Contratto deve essere portata davanti ai tribunali statali o federali situati in Texas, e tu e la Società acconsentite alla giurisdizione personale e alla sede di quei tribunali. Nulla in questa sezione rinuncia o limita qualsiasi diritto che il tuo stato di residenza ti concede e che non può essere legalmente oggetto di rinuncia."
   },
   {
    "title": "10. Quota del primo anno — 10 modelle nel tuo primo anno",
    "body": "Hai UN ANNO dalla data in cui ti registri e accetti il presente Contratto per inserire un minimo di 10 modelle. Una modella conta ai fini della tua quota solo quando si unisce a SlutCamp tramite il tuo link di referral personale e detiene un account modella. Quando il tuo primo anno finisce, la Società esaminerà il tuo account. Se hai inserito meno di 10 modelle, la Società potrà revocare il tuo status di reclutatore se ritenuto necessario, come descritto nella Sezione 5. Se le modelle che hai inserito hanno fatto guadagnare alla Società una somma significativa di denaro, la Società estenderà il tuo status di reclutatore finché la quota non è raggiunta, anche se il tuo primo anno è finito. Questa revisione è fatta dalla Società — raggiungere il traguardo di un anno non termina di per sé automaticamente il tuo status. Nulla in questa sezione limita il diritto della Società ai sensi della Sezione 5 di revocare il tuo status di reclutatore e il tuo link di referral in qualsiasi momento, per qualsiasi motivo, senza preavviso."
   },
   {
    "title": "11. Avvertenza in linguaggio semplice",
    "body": "Questo è un riepilogo in linguaggio semplice scritto per chiarezza — NON è una consulenza legale, e non è stato revisionato da un avvocato. La Società raccomanda vivamente di far revisionare il presente Contratto dal tuo avvocato prima di firmarlo. Se qualsiasi parte del presente Contratto viene ritenuta inapplicabile, il resto continua ad applicarsi."
   }
  ]
 },
 "pl": {
  "governs": "Tłumaczenie dla wygody — obowiązuje wersja angielska.",
  "sections": [
   {
    "title": "1. Strony",
    "body": "Niniejsza Umowa rekrutera („Umowa”) jest zawierana między Tobą („Rekruter”) a World of Godz Entertainment LLC („Spółka”), prowadzącą działalność pod nazwą SlutCamp („SlutCamp”). Podpisując ją, wyrażasz zgodę na wszystko poniżej."
   },
   {
    "title": "2. Niezależny wykonawca — nie partner",
    "body": "Jesteś NIEZALEŻNYM WYKONAWCĄ, a nie pracownikiem Spółki. Żadne postanowienie niniejszej Umowy nie tworzy stosunku pracy, prawnej spółki biznesowej ani stosunku agencyjnego — „partner” to tylko nazwa, którą nazywamy tę rolę w aplikacji. Jesteś odpowiedzialny za własne podatki, ubezpieczenie i wydatki. Spółka nie będzie potrącać podatków z Twoich wypłat."
   },
   {
    "title": "3. Co robisz",
    "body": "Rekrutujesz modelki do dołączenia do SlutCamp za pomocą swojego osobistego linku polecającego. Jesteś odpowiedzialny za własne metody rekrutacji. Musisz być uczciwy co do platformy — bez fałszywych obietnic dotyczących zarobków."
   },
   {
    "title": "4. Twoja część",
    "body": "Zarabiasz 20% wszystkiego, co każda zrekrutowana przez Ciebie modelka zarobi na platformie (jej udział 60% — Twoja część pochodzi z części Spółki, a nie od modelki). Modelka zachowuje swoje pełne 60%. Płatności są przetwarzane według harmonogramu wypłat Spółki. Twoje zarobki stają się uprawnione do wypłaty 7 dni po ich zarobieniu, w tym samym okresie wypłaty, który modelki widzą w aplikacji."
   },
   {
    "title": "5. Rozwiązanie — w dowolnym momencie",
    "body": "Spółka może unieważnić Twój status rekrutera W KAŻDEJ CHWILI, z dowolnego powodu lub bez powodu, BEZ WYMAGANEGO UPZEDZENIA. Po unieważnieniu niniejsza Umowa kończy się natychmiast, a Ty przestajesz zarabiać na wszystkich przyszłych przychodach od zrekrutowanych przez Ciebie modelek. Wszelkie już zarobione saldo pozostaje dostępne do wypłaty."
   },
   {
    "title": "6. Zasady postępowania",
    "body": "NIE wolno Ci: udostępniać danych kontaktowych ani identyfikatorów płatności nikomu na platformie; podejmować prób przeniesienia modelek lub fanów poza platformę; używać mowy nienawiści ani wyzwisk. Złamanie tych zasad może spowodować natychmiastowe zawieszenie lub dezaktywację Twojego konta."
   },
   {
    "title": "7. Zakaz obchodzenia",
    "body": "Przez 12 miesięcy po zakończeniu Twojego statusu rekrutera (z dowolnego powodu) zobowiązujesz się nie rekrutować modelek, które poznałeś za pośrednictwem SlutCamp, na konkurencyjną platformę."
   },
   {
    "title": "8. Poufność",
    "body": "Zobowiązujesz się nie ujawniać metod biznesowych Spółki, struktur prowizji ani operacji wewnętrznych żadnej osobie spoza Spółki."
   },
   {
    "title": "9. Prawo właściwe i miejsce postępowania",
    "body": "Niniejsza Umowa podlega prawu stanu Teksas, bez względu na jego przepisy kolizyjne. Wszelkie spory wynikające z niniejszej Umowy lub jej dotyczące muszą być wnoszone do sądów stanowych lub federalnych znajdujących się w Teksasie, a Ty i Spółka wyrażacie zgodę na właściwość osobistą i miejsce postępowania tych sądów. Żadne postanowienie niniejszej sekcji nie zrzeka się ani nie ogranicza żadnego prawa, które przyznaje Ci Twój stan zamieszkania, a którego nie można zgodnie z prawem się zrzec."
   },
   {
    "title": "10. Limit pierwszego roku — 10 modelek w pierwszym roku",
    "body": "Masz JEDEN ROK od daty rejestracji i akceptacji niniejszej Umowy na pozyskanie co najmniej 10 modelek. Modelka zalicza się do Twojego limitu tylko wtedy, gdy dołączy do SlutCamp za pośrednictwem Twojego osobistego linku polecającego i posiada konto modelki. Gdy Twój pierwszy rok się zakończy, Spółka sprawdzi Twoje konto. Jeśli pozyskałeś mniej niż 10 modelek, Spółka może unieważnić Twój status rekrutera, jeśli uzna to za konieczne, jak opisano w Sekcji 5. Jeśli modelki, które pozyskałeś, zarobiły dla Spółki znaczącą kwotę pieniędzy, Spółka przedłuży Twój status rekrutera, aż limit zostanie osiągnięty, nawet jeśli Twój pierwszy rok się zakończył. Przegląd ten jest dokonywany przez Spółkę — osiągnięcie rocznego terminu samo w sobie nie kończy automatycznie Twojego statusu. Żadne postanowienie niniejszej sekcji nie ogranicza prawa Spółki wynikającego z Sekcji 5 do unieważnienia Twojego statusu rekrutera i Twojego linku polecającego w każdej chwili, z dowolnego powodu, bez uprzedzenia."
   },
   {
    "title": "11. Zastrzeżenie dotyczące prostego języka",
    "body": "Jest to streszczenie w prostym języku, napisane dla jasności — NIE jest to porada prawna i nie zostało sprawdzone przez prawnika. Spółka stanowczo zaleca, abyś przed podpisaniem zlecił własnemu prawnikowi sprawdzenie niniejszej Umowy. Jeśli jakakolwiek część niniejszej Umowy zostanie uznana za niewykonalną, pozostała część nadal obowiązuje."
   }
  ]
 },
 "nl": {
  "governs": "Vertaling voor het gemak — de Engelse versie is leidend.",
  "sections": [
   {
    "title": "1. Partijen",
    "body": "Deze Recruiter-overeenkomst (\"Overeenkomst\") is tussen jou (\"Recruiter\") en World of Godz Entertainment LLC (\"Bedrijf\"), handelend onder de naam SlutCamp (\"SlutCamp\"). Door te ondertekenen ga je akkoord met alles hieronder."
   },
   {
    "title": "2. Onafhankelijke Contractant — Geen Partner",
    "body": "Je bent een ONAFHANKELIJKE CONTRACTANT, geen werknemer van het Bedrijf. Niets in deze Overeenkomst creëert een arbeidsrelatie, een juridisch zakelijk partnerschap of een vertegenwoordigingsrelatie — \"partner\" is gewoon hoe we de rol in de app noemen. Je bent verantwoordelijk voor je eigen belastingen, verzekeringen en kosten. Het Bedrijf zal geen belastingen inhouden op je uitbetalingen."
   },
   {
    "title": "3. Wat Je Doet",
    "body": "Je werft modellen om zich bij SlutCamp aan te sluiten met je persoonlijke verwijzingslink. Je bent verantwoordelijk voor je eigen werfmethoden. Je moet eerlijk zijn over het platform — geen valse beloften over inkomsten."
   },
   {
    "title": "4. Jouw Deel",
    "body": "Je verdient 20% van alles wat elk model dat je werft op het platform verdient (hun 60%-aandeel — jouw deel komt uit het deel van het Bedrijf, niet van het model). Het model houdt haar volledige 60%. Betalingen worden verwerkt volgens het uitbetalingsschema van het Bedrijf. Je inkomsten komen in aanmerking voor uitbetaling 7 dagen nadat ze zijn verdiend, onder hetzelfde uitbetalingsvenster dat de modellen in de app zien."
   },
   {
    "title": "5. Beëindiging — Naar Willekeur",
    "body": "Het Bedrijf kan je recruiter-status OP ELK MOMENT intrekken, om welke reden dan ook of zonder reden, met GEEN KENNISGEVING vereist. Wanneer ingetrokken, eindigt deze Overeenkomst onmiddellijk en stop je met verdienen aan alle toekomstige inkomsten van je geworven modellen. Elk al verdiend saldo blijft beschikbaar voor opname."
   },
   {
    "title": "6. Gedragsregels",
    "body": "Je mag NIET: contactgegevens of betaalhandles delen met iemand op het platform; proberen modellen of fans buiten het platform te brengen; haatspraak of beledigingen gebruiken. Het overtreden van deze regels kan ertoe leiden dat je account onmiddellijk wordt geschorst of gedeactiveerd."
   },
   {
    "title": "7. Niet-omzeiling",
    "body": "Gedurende 12 maanden nadat je recruiter-status eindigt (om welke reden dan ook), stem je ermee in om modellen die je via SlutCamp hebt ontmoet niet te werven voor een concurrerend platform."
   },
   {
    "title": "8. Vertrouwelijkheid",
    "body": "Je stemt ermee in om de bedrijfsmethoden, commissiestructuren of interne bedrijfsvoering van het Bedrijf niet te openbaren aan iemand buiten het Bedrijf."
   },
   {
    "title": "9. Toepasselijk Recht & Rechtsplaats",
    "body": "Deze Overeenkomst wordt beheerst door de wetten van de Staat Texas, zonder rekening te houden met haar regels inzake wetsconflicten. Elk geschil dat voortvloeit uit of verband houdt met deze Overeenkomst moet worden voorgelegd aan de staats- of federale rechtbanken in Texas, en jij en het Bedrijf stemmen in met de persoonlijke jurisdictie en rechtsplaats van die rechtbanken. Niets in deze sectie doet afstand van of beperkt enig recht dat je thuisstaat je geeft dat wettelijk niet kan worden opgegeven."
   },
   {
    "title": "10. Eerstejaarsquotum — 10 Modellen in Je Eerste Jaar",
    "body": "Je hebt ÉÉN JAAR vanaf de datum waarop je je aanmeldt en deze Overeenkomst accepteert om minimaal 10 modellen aan boord te brengen. Een model telt alleen mee voor je quotum wanneer zij zich via je persoonlijke verwijzingslink bij SlutCamp aansluit en een modelaccount heeft. Wanneer je eerste jaar eindigt, zal het Bedrijf je account beoordelen. Als je minder dan 10 modellen hebt aangebracht, kan het Bedrijf je recruiter-status intrekken indien nodig geacht, zoals beschreven in Sectie 5. Als de modellen die je hebt aangebracht het Bedrijf een aanzienlijk bedrag hebben opgeleverd, zal het Bedrijf je recruiter-status verlengen tot het quotum is gehaald, zelfs als je eerste jaar is geëindigd. Deze beoordeling wordt gedaan door het Bedrijf — het bereiken van de grens van één jaar beëindigt op zichzelf je status niet automatisch. Niets in deze sectie beperkt het recht van het Bedrijf onder Sectie 5 om je recruiter-status en je verwijzingslink op elk moment in te trekken, om welke reden dan ook, zonder kennisgeving."
   },
   {
    "title": "11. Disclaimer in Begrijpelijke Taal",
    "body": "Dit is een samenvatting in begrijpelijke taal, geschreven voor duidelijkheid — het is GEEN juridisch advies, en het is niet beoordeeld door een advocaat. Het Bedrijf raadt je ten zeerste aan om je eigen advocaat deze Overeenkomst te laten beoordelen voordat je tekent. Als enig deel van deze Overeenkomst niet-afdwingbaar wordt bevonden, blijft de rest van toepassing."
   }
  ]
 },
 "tr": {
  "governs": "Kolaylık için çeviri — İngilizce sürüm geçerlidir.",
  "sections": [
   {
    "title": "1. Taraflar",
    "body": "Bu İşe Alım Sözleşmesi (\"Sözleşme\"), sen (\"İşe Alan\") ile SlutCamp (\"SlutCamp\") olarak faaliyet gösteren World of Godz Entertainment LLC (\"Şirket\") arasındadır. İmzalayarak, aşağıdaki her şeyi kabul edersin."
   },
   {
    "title": "2. Bağımsız Yüklenici — Ortak Değil",
    "body": "Sen bir BAĞIMSIZ YÜKLENİCİSİN, Şirketin bir çalışanı değilsin. Bu Sözleşmedeki hiçbir şey bir istihdam ilişkisi, yasal bir iş ortaklığı veya bir temsilcilik ilişkisi oluşturmaz — \"ortak\" yalnızca uygulamada bu role verdiğimiz addır. Kendi vergilerinden, sigortandan ve giderlerinden sorumlusun. Şirket, ödemelerinden vergi kesintisi yapmayacak."
   },
   {
    "title": "3. Ne Yaparsın",
    "body": "Kişisel yönlendirme bağlantını kullanarak SlutCamp'e katılmaları için model getirirsin. Kendi işe alım yöntemlerinden sorumlusun. Platform hakkında dürüst olmalısın — kazançlar hakkında yanlış vaatler yok."
   },
   {
    "title": "4. Payın",
    "body": "Getirdiğin her modelin platformda kazandığı her şeyin %20'sini kazanırsın (onların %60'lık payı — payın modelden değil, Şirketin kısmından gelir). Model tam %60'ını korur. Ödemeler, Şirketin ödeme programına göre işlenir. Kazançların, modellerin uygulamada gördüğü aynı ödeme penceresi kapsamında, kazanıldıktan 7 gün sonra ödemeye uygun hale gelir."
   },
   {
    "title": "5. Fesih — İsteğe Bağlı",
    "body": "Şirket, işe alan durumunu İSTEDİĞİ ZAMAN, herhangi bir nedenle veya nedensiz olarak, BİLDİRİM GEREKMEDEN iptal edebilir. İptal edildiğinde, bu Sözleşme derhal sona erer ve getirdiğin modellerden gelecek tüm gelirler üzerinden kazanmayı bırakırsın. Zaten kazanılmış herhangi bir bakiye, çekmen için kullanılabilir kalır."
   },
   {
    "title": "6. Davranış Kuralları",
    "body": "Şunları YAPMAMALISIN: platformdaki herhangi biriyle iletişim bilgisi veya ödeme bilgileri paylaşmak; modelleri veya hayranları platform dışına taşımaya çalışmak; nefret söylemi veya hakaret kullanmak. Bu kuralları ihlal etmek, hesabının derhal askıya alınmasına veya devre dışı bırakılmasına yol açabilir."
   },
   {
    "title": "7. Dolanmayı Önleme",
    "body": "İşe alan durumun sona erdikten sonra (herhangi bir nedenle) 12 ay boyunca, SlutCamp aracılığıyla tanıştığın modelleri rakip bir platforma getirmemeyi kabul edersin."
   },
   {
    "title": "8. Gizlilik",
    "body": "Şirketin iş yöntemlerini, komisyon yapılarını veya iç işleyişini, Şirket dışındaki herhangi birine açıklamamayı kabul edersin."
   },
   {
    "title": "9. Uygulanacak Hukuk ve Yargı Yeri",
    "body": "Bu Sözleşme, kanunlar ihtilafı kurallarına bakılmaksızın, Teksas Eyaleti yasalarına tabidir. Bu Sözleşmeden doğan veya onunla ilgili herhangi bir uyuşmazlık, Teksas'ta bulunan eyalet veya federal mahkemelerde açılmalıdır ve sen ve Şirket, o mahkemelerin kişisel yargı yetkisini ve yerini kabul edersiniz. Bu bölümdeki hiçbir şey, kendi eyaletinin sana verdiği ve yasal olarak feragat edilemeyen herhangi bir hakkı feragat ettirmez veya sınırlamaz."
   },
   {
    "title": "10. İlk Yıl Kotası — İlk Yılında 10 Model",
    "body": "Bu Sözleşmeyi imzalayıp kabul ettiğin tarihten itibaren, en az 10 modeli bünyeye katmak için BİR YILIN var. Bir model, kotana yalnızca kişisel yönlendirme bağlantın aracılığıyla SlutCamp'e katıldığında ve bir model hesabına sahip olduğunda sayılır. İlk yılın sona erdiğinde, Şirket hesabını inceleyecek. 10'dan az model kattıysan, Şirket, Bölüm 5'te açıklandığı gibi, gerekli görürse işe alan durumunu iptal edebilir. Kattığın modeller Şirkete önemli miktarda para kazandırdıysa, Şirket, ilk yılın sona ermiş olsa bile, kota karşılanana kadar işe alan durumunu uzatacaktır. Bu inceleme Şirket tarafından yapılır — bir yıllık işarete ulaşmak, tek başına durumunu otomatik olarak sona erdirmez. Bu bölümdeki hiçbir şey, Şirketin Bölüm 5 kapsamındaki, işe alan durumunu ve yönlendirme bağlantını istediği zaman, herhangi bir nedenle, bildirimde bulunmadan iptal etme hakkını sınırlamaz."
   },
   {
    "title": "11. Sade Dil Feragatnamesi",
    "body": "Bu, netlik için yazılmış sade dille bir özettir — hukuki tavsiye DEĞİLDİR ve bir avukat tarafından incelenmemiştir. Şirket, imzalamadan önce kendi avukatının bu Sözleşmeyi incelemesini şiddetle tavsiye eder. Bu Sözleşmenin herhangi bir kısmı uygulanamaz bulunursa, geri kalanı hâlâ geçerlidir."
   }
  ]
 }
};

function localizedContract(contract, i18n, lang) {
  const t = lang && i18n[lang];
  if (!t) return { sections: contract.sections, governs_note: null };
  return { sections: t.sections, governs_note: t.governs };
}

app.get('/api/credits/packages', (req, res) => {
  res.json({ packages: CREDIT_PACKAGES, stubbed: true });
});

app.post('/api/credits/buy', identMiddleware, requireUser, requireRole('fan'), (req, res) => {
  const pkg = CREDIT_PACKAGES.find((p) => p.id === (req.body && req.body.package));
  if (!pkg) return res.status(400).json({ error: 'bad_package' });
  const ip = clientIp(req);
  const cardFingerprint = String((req.body && req.body.card_fingerprint) || '').slice(0, 64) || null;
  // Velocity check FIRST — blocks fraud before the processor is ever touched.
  const v = checkPurchaseVelocity(req.user.id, pkg.price_cents, cardFingerprint);
  if (!v.ok) {
    logPurchaseAttempt(req.user.id, pkg, pkg.price_cents, cardFingerprint, ip, 'blocked', v.error);
    return res.status(429).json({ error: v.error, message: v.message });
  }
  // Processor not connected yet — record the attempt so the audit trail is complete.
  // When CCBill/Segpay plugs in: run the real charge here, then set status to
  // 'completed' (and credit the wallet) or 'failed' (card declined).
  logPurchaseAttempt(req.user.id, pkg, pkg.price_cents, cardFingerprint, ip, 'pending', 'processor_not_connected');
  res.status(501).json({ error: 'payment_not_connected',
    message: 'Payment processor coming soon — CCBill/Segpay will plug in here.',
    descriptor: pkg.descriptor });
});

/* ------------------------------------------------------------------ */
/* Model: profile, rates, online toggle, earnings                       */
/* ------------------------------------------------------------------ */

app.put('/api/model/profile', identMiddleware, requireUser, requireRole('model'), (req, res) => {
  const { bio, per_message_cents, per_minute_cents, per_voice_cents, explicit_rate_cents,
          explicit_join_cents, explicit_mic_join_cents, join_cents, mic_join_cents,
          is_online, tags } = req.body || {};
  const updates = [], params = [];
  // Model-settable 1-on-1 rates (tighter ranges than the admin override)
  const rateRange = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  const badRate = (v, lo, hi) => v !== undefined && !rateRange(v, lo, hi);
  if (badRate(per_message_cents, 50, 1000) || badRate(per_minute_cents, 500, 100000) ||
      badRate(per_voice_cents, 50, 1000))
    return res.status(400).json({ error: 'bad_rate',
      message: 'Rates out of range.' });
  if (typeof bio === 'string') { updates.push('bio = ?'); params.push(bio.slice(0, 280)); }
  if (rateRange(per_message_cents, 50, 1000)) {
    updates.push('per_message_cents = ?'); params.push(per_message_cents);
  }
  if (rateRange(per_minute_cents, 500, 100000)) {
    updates.push('per_minute_cents = ?'); params.push(per_minute_cents);
  }
  if (rateRange(per_voice_cents, 50, 1000)) {
    updates.push('per_voice_cents = ?'); params.push(per_voice_cents);
  }
  if (Number.isInteger(explicit_rate_cents) && explicit_rate_cents >= 0 && explicit_rate_cents <= 20000) {
    updates.push('explicit_rate_cents = ?'); params.push(explicit_rate_cents);
  }
  if (Number.isInteger(explicit_join_cents) && explicit_join_cents >= 500 && explicit_join_cents <= 100000) {
    updates.push('explicit_join_cents = ?'); params.push(explicit_join_cents);
  }
  if (Number.isInteger(explicit_mic_join_cents) && explicit_mic_join_cents >= 500 && explicit_mic_join_cents <= 100000) {
    updates.push('explicit_mic_join_cents = ?'); params.push(explicit_mic_join_cents);
  }
  if (Number.isInteger(join_cents) && join_cents >= 500 && join_cents <= 100000) {
    updates.push('join_cents = ?'); params.push(join_cents);
  }
  if (Number.isInteger(mic_join_cents) && mic_join_cents >= 500 && mic_join_cents <= 100000) {
    updates.push('mic_join_cents = ?'); params.push(mic_join_cents);
  }
  if (is_online === 0 || is_online === 1) { updates.push('is_online = ?'); params.push(is_online); }
  // Discovery tags: must be an array of catalogue strings; unknown tags
  // are dropped, duplicates collapse, and the list caps at MAX_MODEL_TAGS.
  if (tags !== undefined) {
    const cleaned = cleanModelTags(tags);
    if (!cleaned) return res.status(400).json({ error: 'bad_tags',
      message: 'Tags must be a list of discovery tags.' });
    updates.push('tags = ?'); params.push(JSON.stringify(cleaned));
  }
  if (!updates.length) return res.status(400).json({ error: 'nothing_to_update' });
  params.push(req.user.id);
  db.prepare(`UPDATE models SET ${updates.join(', ')} WHERE user_id = ?`).run(...params);
  // Going offline empties her FaceTime line (refunded + notified).
  if (is_online === 0) ftCancelAll(req.user.id, 'she went offline');
  res.json({ model: db.prepare('SELECT * FROM models WHERE user_id = ?').get(req.user.id) });
});

// Swap a model's profile photo; deletes the old file so no orphans linger
function setModelPhoto(userId, file) {
  const old = db.prepare('SELECT photo_url FROM models WHERE user_id = ?').get(userId);
  if (old && old.photo_url) {
    const oldPath = path.join(UPLOAD_DIR, path.basename(old.photo_url));
    if (oldPath.startsWith(UPLOAD_DIR + path.sep)) {
      try { fs.unlinkSync(oldPath); } catch (e) { /* already gone */ }
    }
  }
  const photo_url = '/uploads/' + path.basename(file.path);
  db.prepare('UPDATE models SET photo_url = ? WHERE user_id = ?').run(photo_url, userId);
  return photo_url;
}

// Model uploads her own profile photo
app.post('/api/model/photo', identMiddleware, requireUser, requireRole('model'),
  photoUpload.single('photo'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'no_photo' });
    res.json({ ok: true, photo_url: setModelPhoto(req.user.id, req.file) });
  });

// Swap a model's PUBLIC photo — the clean one the Google-facing pages
// show. Fully separate from photo_url (owner rule, Oct 16 2026): her
// in-app storefront photo may be explicit and must never leak onto the
// public pages, which read ONLY public_photo_url. Own-model-only: the
// write always targets req.user.id. Deletes the old file like
// setModelPhoto does so no orphans linger.
function setModelPublicPhoto(userId, file) {
  const old = db.prepare('SELECT public_photo_url FROM models WHERE user_id = ?').get(userId);
  if (old && old.public_photo_url) {
    const oldPath = path.join(UPLOAD_DIR, path.basename(old.public_photo_url));
    if (oldPath.startsWith(UPLOAD_DIR + path.sep)) {
      try { fs.unlinkSync(oldPath); } catch (e) { /* already gone */ }
    }
  }
  const public_photo_url = '/uploads/' + path.basename(file.path);
  db.prepare('UPDATE models SET public_photo_url = ? WHERE user_id = ?').run(public_photo_url, userId);
  return public_photo_url;
}

// Model uploads her own public (clean) photo — the one Google shows
app.post('/api/model/public-photo', identMiddleware, requireUser, requireRole('model'),
  photoUpload.single('photo'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'no_photo' });
    res.json({ ok: true, public_photo_url: setModelPublicPhoto(req.user.id, req.file) });
  });

// Model clears her public photo — public pages fall back to the logo,
// never to her storefront photo
app.delete('/api/model/public-photo', identMiddleware, requireUser, requireRole('model'), (req, res) => {
  const old = db.prepare('SELECT public_photo_url FROM models WHERE user_id = ?').get(req.user.id);
  if (old && old.public_photo_url) {
    const oldPath = path.join(UPLOAD_DIR, path.basename(old.public_photo_url));
    if (oldPath.startsWith(UPLOAD_DIR + path.sep)) {
      try { fs.unlinkSync(oldPath); } catch (e) { /* already gone */ }
    }
  }
  db.prepare("UPDATE models SET public_photo_url = '' WHERE user_id = ?").run(req.user.id);
  res.json({ ok: true, public_photo_url: '' });
});

// Model uploads her home-screen preview video loop (few seconds, autoplays muted)
app.post('/api/model/preview-video', identMiddleware, requireUser, requireRole('model'),
  previewVideoUpload.single('video'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'no_video' });
    // Delete old preview if any
    const old = db.prepare('SELECT preview_video_url FROM models WHERE user_id = ?').get(req.user.id);
    if (old && old.preview_video_url) {
      const oldPath = path.join(UPLOAD_DIR, path.basename(old.preview_video_url));
      if (oldPath.startsWith(UPLOAD_DIR + path.sep)) {
        try { fs.unlinkSync(oldPath); } catch (e) { /* already gone */ }
      }
    }
    const preview_video_url = '/uploads/' + path.basename(req.file.path);
    db.prepare('UPDATE models SET preview_video_url = ? WHERE user_id = ?').run(preview_video_url, req.user.id);
    res.json({ ok: true, preview_video_url });
  });

// Model removes her preview video (falls back to photo)
app.delete('/api/model/preview-video', identMiddleware, requireUser, requireRole('model'), (req, res) => {
  const old = db.prepare('SELECT preview_video_url FROM models WHERE user_id = ?').get(req.user.id);
  if (old && old.preview_video_url) {
    const oldPath = path.join(UPLOAD_DIR, path.basename(old.preview_video_url));
    if (oldPath.startsWith(UPLOAD_DIR + path.sep)) {
      try { fs.unlinkSync(oldPath); } catch (e) { /* already gone */ }
    }
  }
  db.prepare('UPDATE models SET preview_video_url = ? WHERE user_id = ?').run('', req.user.id);
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Profile media expansion (owner, Oct 17 2026): Video 2 + gallery.   */
/* Exactly TWO main profile videos exist — Video 1 (preview_video_    */
/* url) and Video 2 below; there is deliberately no third slot. The  */
/* gallery holds the profile pictures beyond her main photo, and     */
/* the composed profile list (main + gallery) is capped at            */
/* MAX_PROFILE_PICS, enforced here on the server: the upload that     */
/* would make an 11th picture is rejected and its file removed.      */
/* ------------------------------------------------------------------ */

// Model uploads/replaces her SECOND main profile video (same 15MB flow)
app.post('/api/model/preview-video-2', identMiddleware, requireUser, requireRole('model'),
  previewVideoUpload.single('video'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'no_video' });
    // Delete old second video if any
    const old = db.prepare('SELECT preview_video_url_2 FROM models WHERE user_id = ?').get(req.user.id);
    if (old && old.preview_video_url_2) {
      const oldPath = path.join(UPLOAD_DIR, path.basename(old.preview_video_url_2));
      if (oldPath.startsWith(UPLOAD_DIR + path.sep)) {
        try { fs.unlinkSync(oldPath); } catch (e) { /* already gone */ }
      }
    }
    const preview_video_url_2 = '/uploads/' + path.basename(req.file.path);
    db.prepare('UPDATE models SET preview_video_url_2 = ? WHERE user_id = ?').run(preview_video_url_2, req.user.id);
    res.json({ ok: true, preview_video_url_2 });
  });

// Model removes her second profile video
app.delete('/api/model/preview-video-2', identMiddleware, requireUser, requireRole('model'), (req, res) => {
  const old = db.prepare('SELECT preview_video_url_2 FROM models WHERE user_id = ?').get(req.user.id);
  if (old && old.preview_video_url_2) {
    const oldPath = path.join(UPLOAD_DIR, path.basename(old.preview_video_url_2));
    if (oldPath.startsWith(UPLOAD_DIR + path.sep)) {
      try { fs.unlinkSync(oldPath); } catch (e) { /* already gone */ }
    }
  }
  db.prepare('UPDATE models SET preview_video_url_2 = ? WHERE user_id = ?').run('', req.user.id);
  res.json({ ok: true });
});

// Model adds ONE picture to her profile gallery. The composed profile
// list (her main photo + gallery) may never exceed MAX_PROFILE_PICS —
// the 11th picture is rejected with gallery_full and its file deleted,
// so no orphan is left behind.
app.post('/api/model/gallery-photo', identMiddleware, requireUser, requireRole('model'),
  photoUpload.single('photo'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'no_photo' });
    const row = db.prepare('SELECT photo_url, gallery_photos FROM models WHERE user_id = ?').get(req.user.id);
    const gallery = parseGalleryPhotos(row.gallery_photos);
    const composed = (row.photo_url ? 1 : 0) + gallery.length;
    if (composed >= MAX_PROFILE_PICS) {
      try { fs.unlinkSync(req.file.path); } catch (e) { /* already gone */ }
      return res.status(400).json({ error: 'gallery_full',
        message: `Your profile holds ${MAX_PROFILE_PICS} pictures max — remove one to add another.` });
    }
    const url = '/uploads/' + path.basename(req.file.path);
    gallery.push(url);
    db.prepare('UPDATE models SET gallery_photos = ? WHERE user_id = ?')
      .run(JSON.stringify(gallery), req.user.id);
    const updated = db.prepare('SELECT photo_url, gallery_photos FROM models WHERE user_id = ?').get(req.user.id);
    res.json({ ok: true, gallery_photos: parseGalleryPhotos(updated.gallery_photos),
      profile_pics: profilePicsList(updated), count: profilePicsList(updated).length });
  });

// Model removes ONE picture from her profile gallery (her main photo
// is managed by the main-photo control, never through here). The file
// is deleted like every other replaced profile asset.
app.delete('/api/model/gallery-photo', identMiddleware, requireUser, requireRole('model'), (req, res) => {
  const url = String((req.body && req.body.url) || '');
  const row = db.prepare('SELECT photo_url, gallery_photos FROM models WHERE user_id = ?').get(req.user.id);
  const gallery = parseGalleryPhotos(row.gallery_photos);
  if (!gallery.includes(url)) return res.status(404).json({ error: 'not_in_gallery' });
  const next = gallery.filter((u) => u !== url);
  db.prepare('UPDATE models SET gallery_photos = ? WHERE user_id = ?')
    .run(JSON.stringify(next), req.user.id);
  const filePath = path.join(UPLOAD_DIR, path.basename(url));
  if (filePath.startsWith(UPLOAD_DIR + path.sep)) {
    try { fs.unlinkSync(filePath); } catch (e) { /* already gone */ }
  }
  const updated = db.prepare('SELECT photo_url, gallery_photos FROM models WHERE user_id = ?').get(req.user.id);
  res.json({ ok: true, gallery_photos: parseGalleryPhotos(updated.gallery_photos),
    profile_pics: profilePicsList(updated), count: profilePicsList(updated).length });
});

/* ------------------------------------------------------------------ */
/* Model contract — independent-contractor agreement signing          */
/* ------------------------------------------------------------------ */

/* Signature reads are version-aware (v1.2, Oct 15 2026): signatures
   are history rows now — one per signing — so "signed" means the
   model's LATEST model-agreement signature is the CURRENT version.
   A model who signed 1.1 (or never signed) reads signed:false until
   she signs 1.2, and the app gate locks her to the signing screen
   exactly like an unsigned model. Her earlier signatures stay on
   file untouched. */
function latestModelSignature(userId) {
  return db.prepare(`SELECT contract_version, signed_at FROM contract_signatures
    WHERE user_id = ? AND contract_version NOT LIKE 'R%'
    ORDER BY id DESC LIMIT 1`).get(userId);
}
function latestRecruiterSignature(userId) {
  return db.prepare(`SELECT contract_version, signed_at FROM contract_signatures
    WHERE user_id = ? AND contract_version LIKE 'R%'
    ORDER BY id DESC LIMIT 1`).get(userId);
}

// Get the current contract + whether this model has signed it
app.get('/api/model/contract', identMiddleware, requireUser, requireRole('model'), (req, res) => {
  const sig = latestModelSignature(req.user.id);
  const loc = localizedContract(MODEL_CONTRACT, MODEL_CONTRACT_I18N, req.user.language);
  res.json({
    version: MODEL_CONTRACT.version,
    updated: MODEL_CONTRACT.updated,
    sections: loc.sections,
    governs_note: loc.governs_note,
    signed: !!sig && sig.contract_version === MODEL_CONTRACT.version,
    signed_version: sig ? sig.contract_version : null,
    signed_at: sig ? sig.signed_at : null,
  });
});

// Sign the contract (typed name = electronic signature).
// Re-signing a newer version appends a NEW history row; the previous
// version's record is never overwritten.
app.post('/api/model/contract/sign', identMiddleware, requireUser, requireRole('model'), (req, res) => {
  const name = String(req.body.display_name || '').trim().slice(0, 80);
  if (!name || name.length < 2) return res.status(400).json({ error: 'bad_name' });
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
  const sig = latestModelSignature(req.user.id);
  if (!sig || sig.contract_version !== MODEL_CONTRACT.version) {
    db.prepare(`INSERT INTO contract_signatures (user_id, contract_version, display_name, ip)
                VALUES (?, ?, ?, ?)`)
      .run(req.user.id, MODEL_CONTRACT.version, name, ip.slice(0, 60));
  }
  // Already on the current version — idempotent success, no duplicate row.
  res.json({ ok: true, version: MODEL_CONTRACT.version });
});

// Recruiter: get agreement status + text
app.get('/api/recruiter/contract', identMiddleware, requireUser, requireRole('recruiter'), (req, res) => {
  const sig = latestRecruiterSignature(req.user.id);
  const loc = localizedContract(RECRUITER_CONTRACT, RECRUITER_CONTRACT_I18N, req.user.language);
  res.json({
    version: RECRUITER_CONTRACT.version,
    updated: RECRUITER_CONTRACT.updated,
    sections: loc.sections,
    governs_note: loc.governs_note,
    signed: !!sig && String(sig.contract_version || '').startsWith('R'),
    signed_version: sig ? sig.contract_version : null,
    signed_at: sig ? sig.signed_at : null,
  });
});

// Recruiter: sign the agreement (typed name = electronic signature)
app.post('/api/recruiter/contract/sign', identMiddleware, requireUser, requireRole('recruiter'), (req, res) => {
  const name = String(req.body.display_name || '').trim().slice(0, 80);
  if (!name || name.length < 2) return res.status(400).json({ error: 'bad_name' });
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
  const sig = latestRecruiterSignature(req.user.id);
  if (!sig || sig.contract_version !== RECRUITER_CONTRACT.version) {
    db.prepare(`INSERT INTO contract_signatures (user_id, contract_version, display_name, ip)
                VALUES (?, ?, ?, ?)`)
      .run(req.user.id, RECRUITER_CONTRACT.version, name, ip.slice(0, 60));
  }
  res.json({ ok: true, version: RECRUITER_CONTRACT.version });
});

/* Shared recruiter-account creation — used by BOTH the Manager
 * affiliate invite signup below and the self-serve affiliate signup
 * (POST /api/affiliate/signup, the entry screen's Affiliate tab), so
 * the two paths can never drift: user row (attested 18+ at the
 * agreement — never a fake DOB), age attestation, wallet, recruiters
 * row with a unique personal referral code, and the recruiter
 * agreement auto-signed at the current version. */
function createRecruiterAccount(uname, dname, pwd, req) {
  const hash = bcrypt.hashSync(pwd, 10);
  const info = db.prepare(
    'INSERT INTO users (username, password_hash, role, display_name, dob) VALUES (?,?,?,?,?)'
  ).run(uname, hash, 'recruiter', dname, null); // attested 18+ at agreement — no fake DOB
  const userId = Number(info.lastInsertRowid);
  recordAgeAttestation(userId, req);
  db.prepare('INSERT INTO wallets (user_id) VALUES (?)').run(userId);
  // Recruiter record with her personal referral (partner) code
  let rcode;
  do { rcode = crypto.randomBytes(4).toString('hex'); }
  while (db.prepare('SELECT id FROM recruiters WHERE referral_code = ?').get(rcode));
  db.prepare('INSERT INTO recruiters (user_id, name, referral_code) VALUES (?,?,?)')
    .run(userId, dname, rcode);
  // Auto-sign the recruiter agreement (she agreed on the signup screen)
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
  db.prepare(`INSERT INTO contract_signatures (user_id, contract_version, display_name, ip)
              VALUES (?, ?, ?, ?)`)
    .run(userId, RECRUITER_CONTRACT.version, dname, ip.slice(0, 60));
  return userId;
}

// Public: validate an affiliate invite code
app.get('/api/affiliate-invite/:code', (req, res) => {
  const code = String(req.params.code || '').trim();
  const inv = db.prepare(`SELECT * FROM invite_links WHERE code = ? AND role = 'recruiter'`).get(code);
  if (!inv || inv.is_revoked || inv.used_by) return res.json({ valid: false });
  if (inv.expires_at && new Date(inv.expires_at) < new Date()) return res.json({ valid: false });
  res.json({ valid: true, label: inv.label });
});

// Public: affiliate signup via invite code
app.post('/api/affiliate-invite/:code/signup', (req, res) => {
  const code = String(req.params.code || '').trim();
  const inv = db.prepare(`SELECT * FROM invite_links WHERE code = ? AND role = 'recruiter'`).get(code);
  if (!inv || inv.is_revoked || inv.used_by) return res.status(400).json({ error: 'bad_invite' });
  if (inv.expires_at && new Date(inv.expires_at) < new Date()) return res.status(400).json({ error: 'expired' });
  const { username, password, display_name, agreed } = req.body || {};
  const uname = String(username || '').trim();
  const dname = String(display_name || '').trim().slice(0, 40);
  const pwd = String(password || '');
  if (!uname || !dname || pwd.length < 6) return res.status(400).json({ error: 'missing_fields' });
  if (!agreed) return res.status(400).json({ error: 'must_agree' });
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(uname))
    return res.status(409).json({ error: 'username_taken' });
  const userId = createRecruiterAccount(uname, dname, pwd, req);
  // Mark invite used
  db.prepare(`UPDATE invite_links SET used_by = ?, used_at = datetime('now') WHERE id = ?`)
    .run(userId, inv.id);
  const token = createSession(userId);
  res.json({ ok: true, token, user: { id: userId, username: uname, display_name: dname, role: 'recruiter' } });
});

// Public: self-serve affiliate signup (entry screen → Sign up →
// Affiliate tab). Same fields, validations and account creation as
// the invite path above — minus the invite code: anyone may join the
// affiliate program directly. Manager-issued one-time invite codes
// keep working untouched alongside this.
app.post('/api/affiliate/signup', (req, res) => {
  const { username, password, display_name, agreed } = req.body || {};
  const uname = String(username || '').trim();
  const dname = String(display_name || '').trim().slice(0, 40);
  const pwd = String(password || '');
  if (!uname || !dname || pwd.length < 6) return res.status(400).json({ error: 'missing_fields' });
  if (!agreed) return res.status(400).json({ error: 'must_agree' });
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(uname))
    return res.status(409).json({ error: 'username_taken' });
  const userId = createRecruiterAccount(uname, dname, pwd, req);
  const token = createSession(userId);
  res.json({ ok: true, token, user: { id: userId, username: uname, display_name: dname, role: 'recruiter' } });
});

// Admin: list all models with contract signature status
app.get('/api/admin/contracts', identMiddleware, requireUser, requireRole('admin'), (req, res) => {
  const rows = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.banned,
           cs.contract_version, cs.signed_at, cs.display_name AS signed_name
    FROM users u
    LEFT JOIN contract_signatures cs
      ON cs.id = (SELECT MAX(id) FROM contract_signatures WHERE user_id = u.id)
    WHERE u.role = 'model'
    ORDER BY u.display_name
  `).all();
  res.json({ contracts: rows, current_version: MODEL_CONTRACT.version });
});

/* ------------------------------------------------------------------ */
/* Model ID verification (2257) — sensitive PII, admin-only review      */
/* ------------------------------------------------------------------ */

// Model: check her own verification status
app.get('/api/model/id-verification', identMiddleware, requireUser, requireRole('model'), (req, res) => {
  const v = db.prepare(`SELECT status, submitted_at, reviewed_at, reviewer_note
                        FROM id_verifications WHERE model_id = ?`).get(req.user.id);
  res.json({ verification: v || null, verified: isIdVerified(req.user.id) });
});

// Model: submit ID front + ID back + selfie holding the ID
app.post('/api/model/id-verification', identMiddleware, requireUser, requireRole('model'),
  (req, res) => {
    idUpload.fields([
      { name: 'id_front', maxCount: 1 },
      { name: 'id_back', maxCount: 1 },
      { name: 'selfie', maxCount: 1 },
    ])(req, res, (err) => {
      if (err) return res.status(400).json({ error: 'bad_file',
        message: 'Use JPG/PNG photos under 8MB each.' });
      const f = req.files || {};
      const front = f.id_front && f.id_front[0];
      const back = f.id_back && f.id_back[0];
      const selfie = f.selfie && f.selfie[0];
      const cleanup = () => [front, back, selfie].forEach((x) => { if (x) fs.unlink(x.path, () => {}); });
      if (!front || !back || !selfie) {
        cleanup();
        return res.status(400).json({ error: 'missing_files',
          message: 'ID front, ID back, and a selfie holding your ID are all required.' });
      }
      // Resubmits replace the previous submission's files
      const prev = db.prepare(`SELECT id_front_path, id_back_path, selfie_path
                               FROM id_verifications WHERE model_id = ?`).get(req.user.id);
      if (prev) [prev.id_front_path, prev.id_back_path, prev.selfie_path]
        .forEach((p) => { if (p) fs.unlink(p, () => {}); });
      db.prepare(`INSERT INTO id_verifications (model_id, id_front_path, id_back_path, selfie_path,
                    status, submitted_at, reviewed_at, reviewer_note)
                  VALUES (?, ?, ?, ?, 'pending', datetime('now'), NULL, '')
                  ON CONFLICT(model_id) DO UPDATE SET
                    id_front_path = excluded.id_front_path,
                    id_back_path = excluded.id_back_path,
                    selfie_path = excluded.selfie_path,
                    status = 'pending',
                    submitted_at = excluded.submitted_at,
                    reviewed_at = NULL,
                    reviewer_note = ''`)
        .run(req.user.id, front.path, back.path, selfie.path);
      pushToAdmins({ type: 'id_verification:submitted', model_id: req.user.id,
        model_name: req.user.display_name });
      res.json({ ok: true, status: 'pending' });
    });
  });

// Admin: list all ID verifications (pending first)
app.get('/api/admin/id-verifications', identMiddleware, requireUser, requireRole('admin'), (req, res) => {
  const rows = db.prepare(`
    SELECT v.id, v.model_id, v.status, v.submitted_at, v.reviewed_at, v.reviewer_note,
           u.display_name, u.username
    FROM id_verifications v JOIN users u ON u.id = v.model_id
    ORDER BY CASE v.status WHEN 'pending' THEN 0 WHEN 'rejected' THEN 1 ELSE 2 END,
             v.submitted_at DESC
  `).all();
  res.json({ verifications: rows });
});

// Short-lived photo tokens so <img> tags can load ID photos without a Bearer
// header. One token covers all 3 photos of a single verification (front /
// back / selfie) for the issuing admin and dies at expiry (2 min) — the
// review screen needs all three images, so tokens are NOT single-use.
const idPhotoTokens = new Map(); // token -> { verificationId, adminId, expires }
app.post('/api/admin/id-verifications/:id/photo-token', identMiddleware, requireUser, requireRole('admin'), (req, res) => {
  const v = db.prepare('SELECT id FROM id_verifications WHERE id = ?').get(req.params.id);
  if (!v) return res.status(404).json({ error: 'not_found' });
  const now = Date.now();
  for (const [t, ft] of idPhotoTokens) if (ft.expires <= now) idPhotoTokens.delete(t);
  const token = crypto.randomBytes(24).toString('hex');
  idPhotoTokens.set(token, { verificationId: v.id, adminId: req.user.id,
    expires: now + 120 * 1000 });
  res.json({ token });
});

// Admin: view one ID photo (Bearer auth OR short-lived ?t= token). Sensitive PII — never cached.
app.get('/api/admin/id-verifications/:id/photo/:which', (req, res) => {
  const which = req.params.which;
  if (!['front', 'back', 'selfie'].includes(which))
    return res.status(400).json({ error: 'bad_which' });
  let adminId = null;
  if (req.query.t) {
    const ft = idPhotoTokens.get(req.query.t);
    if (ft && ft.verificationId === Number(req.params.id) && ft.expires > Date.now()) {
      adminId = ft.adminId;
    } else return res.status(403).json({ error: 'bad_token' });
  } else {
    const ident = getIdentity(req);
    if (!ident || ident.kind !== 'user' || ident.user.role !== 'admin')
      return res.status(401).json({ error: 'login_required' });
    adminId = ident.user.id;
  }
  if (!adminId) return res.status(403).json({ error: 'forbidden' });
  const v = db.prepare(`SELECT id_front_path, id_back_path, selfie_path
                        FROM id_verifications WHERE id = ?`).get(req.params.id);
  if (!v) return res.status(404).json({ error: 'not_found' });
  const p = which === 'front' ? v.id_front_path
    : which === 'back' ? v.id_back_path : v.selfie_path;
  if (!p || !p.startsWith(ID_DIR) || !fs.existsSync(p))
    return res.status(404).json({ error: 'not_found' });
  const ext = path.extname(p).toLowerCase();
  res.setHeader('Content-Type', ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg');
  res.setHeader('Cache-Control', 'private, no-store');
  fs.createReadStream(p).pipe(res);
});

// Admin: approve an ID verification
app.post('/api/admin/id-verifications/:id/approve', identMiddleware, requireUser, requireRole('admin'), (req, res) => {
  const v = db.prepare('SELECT * FROM id_verifications WHERE id = ?').get(req.params.id);
  if (!v) return res.status(404).json({ error: 'not_found' });
  db.prepare(`UPDATE id_verifications SET status = 'approved', reviewed_at = datetime('now'),
              reviewer_note = '' WHERE id = ?`).run(v.id);
  pushToSubject(`u:${v.model_id}`, { type: 'id_verified', status: 'approved' });
  res.json({ ok: true });
});

// Admin: reject an ID verification (with note so she knows what to fix)
app.post('/api/admin/id-verifications/:id/reject', identMiddleware, requireUser, requireRole('admin'), (req, res) => {
  const v = db.prepare('SELECT * FROM id_verifications WHERE id = ?').get(req.params.id);
  if (!v) return res.status(404).json({ error: 'not_found' });
  const note = String(req.body.note || '').trim().slice(0, 300);
  db.prepare(`UPDATE id_verifications SET status = 'rejected', reviewed_at = datetime('now'),
              reviewer_note = ? WHERE id = ?`).run(note, v.id);
  pushToSubject(`u:${v.model_id}`, { type: 'id_verified', status: 'rejected', note });
  res.json({ ok: true });
});

// Admin: download one performer's 2257 records packet (JSON). The ID images
// themselves stay in private storage, viewable only in the ID Checks tab;
// this packet is the index record tying the performer, her verification,
// and her signed agreement together for the records custodian.
app.get('/api/admin/id-verifications/:id/2257', identMiddleware, requireUser, requireRole('admin'), (req, res) => {
  const v = db.prepare('SELECT * FROM id_verifications WHERE id = ?').get(req.params.id);
  if (!v) return res.status(404).json({ error: 'not_found' });
  const u = db.prepare(`SELECT id, username, display_name, role, dob, created_at,
                               age_attested_at FROM users WHERE id = ?`).get(v.model_id);
  if (!u) return res.status(404).json({ error: 'not_found' });
  const sig = db.prepare(`SELECT contract_version, display_name AS signed_name,
                                  signed_at, ip FROM contract_signatures
                          WHERE user_id = ? ORDER BY id DESC LIMIT 1`).get(v.model_id);
  const base = (p) => p ? String(p).split('/').pop() : null;
  const packet = {
    record_type: 'Performer age/identity verification record — 18 U.S.C. §2257',
    generated_at: new Date().toISOString(),
    records_custodian: 'World of Godz Entertainment LLC dba SlutCamp',
    performer: {
      user_id: u.id, username: u.username, stage_name: u.display_name,
      role: u.role, date_of_birth_on_file: u.dob,
      dob_note: u.dob ? undefined
        : 'No DOB typed at signup — legal name and DOB are on the ID document images in this record.',
      account_created_at: u.created_at, age_attested_at: u.age_attested_at,
    },
    id_verification: {
      status: v.status, submitted_at: v.submitted_at,
      reviewed_at: v.reviewed_at, reviewer_note: v.reviewer_note || '',
      documents_on_file: {
        id_front: base(v.id_front_path), id_back: base(v.id_back_path),
        selfie_with_id: base(v.selfie_path),
      },
      documents_location: 'Private storage (id_verification) — admin ID Checks tab only, never public.',
    },
    agreement: sig ? {
      contract_version: sig.contract_version, signed_name: sig.signed_name,
      signed_at: sig.signed_at, signed_from_ip: sig.ip,
    } : null,
  };
  const fname = `2257-record-${u.username}-u${u.id}.json`;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
  res.send(JSON.stringify(packet, null, 2));
});

/* ------------------------------------------------------------------ */
/* Admin: W-9 / 1099 tax dashboard + CSV export (no tax IDs in export) */
/* ------------------------------------------------------------------ */

// Everyone who gets paid: models + partners. Paid-this-year = SUM of 'paid'
// withdrawals decided in the current calendar year. $600+ (60000¢) triggers 1099.
function taxDashboardRows() {
  return db.prepare(`
    SELECT u.id, u.username, u.display_name, u.role, u.banned,
           COALESCE(r.name, u.display_name) AS earner_name,
           r.city AS recruiter_city,
           tp.id AS has_tax, tp.legal_name, tp.business_name, tp.tax_id_type,
           tp.tax_id_last4, tp.city AS tax_city, tp.state AS tax_state, tp.submitted_at,
           COALESCE((
             SELECT SUM(w.amount_cents) FROM withdrawals w
             WHERE w.model_id = u.id AND w.status = 'paid'
               AND strftime('%Y', COALESCE(w.decided_at, w.requested_at)) = strftime('%Y', 'now')
           ), 0) AS paid_this_year_cents
    FROM users u
    LEFT JOIN recruiters r ON r.user_id = u.id
    LEFT JOIN tax_profiles tp ON tp.user_id = u.id
    WHERE u.role IN ('model', 'recruiter')
    ORDER BY paid_this_year_cents DESC, u.display_name
  `).all();
}

app.get('/api/admin/tax', identMiddleware, requireUser, requireRole('admin'), (req, res) => {
  const rows = taxDashboardRows().map((r) => ({
    id: r.id, username: r.username, display_name: r.display_name, role: r.role,
    earner_name: r.earner_name, recruiter_city: r.recruiter_city, banned: !!r.banned,
    has_tax: !!r.has_tax, legal_name: r.legal_name, business_name: r.business_name,
    tax_id_type: r.tax_id_type,
    tax_id_masked: r.has_tax
      ? (r.tax_id_type === 'ein' ? `XX-XXXX${r.tax_id_last4}` : `***-**-${r.tax_id_last4}`) : null,
    tax_city: r.tax_city, tax_state: r.tax_state, submitted_at: r.submitted_at,
    paid_this_year_cents: r.paid_this_year_cents,
    // IRS 1099-NEC threshold: $600 paid in the year
    needs_1099: r.paid_this_year_cents >= 60000,
    missing_tax: r.paid_this_year_cents >= 60000 && !r.has_tax,
  }));
  res.json({ earners: rows, year: new Date().getFullYear(), threshold_cents: 60000,
    key_ephemeral: taxKeyIsEphemeral() });
});

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// CSV for the accountant: legal names, addresses, totals — NO tax IDs.
app.get('/api/admin/tax/export', identMiddleware, requireUser, requireRole('admin'), (req, res) => {
  const year = new Date().getFullYear();
  const rows = db.prepare(`
    SELECT tp.legal_name, tp.business_name, tp.tax_id_type, tp.address_line1, tp.address_line2,
           tp.city, tp.state, tp.zip, u.display_name, u.username, u.role,
           COALESCE((
             SELECT SUM(w.amount_cents) FROM withdrawals w
             WHERE w.model_id = u.id AND w.status = 'paid'
               AND strftime('%Y', COALESCE(w.decided_at, w.requested_at)) = strftime('%Y', 'now')
           ), 0) AS paid_cents
    FROM tax_profiles tp JOIN users u ON u.id = tp.user_id
    WHERE u.role IN ('model', 'recruiter')
    ORDER BY tp.legal_name
  `).all();
  const header = ['legal_name', 'business_name', 'id_type', 'address_line1', 'address_line2',
    'city', 'state', 'zip', 'display_name', 'username', 'role', 'paid_year', 'paid_cents', 'paid_dollars'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([
      r.legal_name, r.business_name, r.tax_id_type === 'ein' ? 'EIN' : 'SSN',
      r.address_line1, r.address_line2, r.city, r.state, r.zip,
      r.display_name, r.username, r.role, year, r.paid_cents,
      (r.paid_cents / 100).toFixed(2),
    ].map(csvCell).join(','));
  }
  const csv = lines.join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="slutcamp-1099-export-${year}.csv"`);
  res.send('﻿' + csv); // BOM so Excel opens it as UTF-8
});

/* ------------------------------------------------------------------ */
/* Model payouts — bank account + withdrawal requests (manual by Asce) */
/* ------------------------------------------------------------------ */

// Save/replace her bank account for payouts
app.post('/api/model/payout-account', identMiddleware, requireUser, requireRole('model', 'recruiter'), (req, res) => {
  const holder = String(req.body.holder_name || '').trim().slice(0, 80);
  const routing = String(req.body.routing_number || '').replace(/\D/g, '');
  const account = String(req.body.account_number || '').replace(/\D/g, '');
  if (!holder) return res.status(400).json({ error: 'bad_holder' });
  if (!/^\d{9}$/.test(routing)) return res.status(400).json({ error: 'bad_routing' });
  if (!/^\d{4,17}$/.test(account)) return res.status(400).json({ error: 'bad_account' });
  db.prepare(`INSERT INTO payout_accounts (model_id, holder_name, routing_number, account_number)
              VALUES (?,?,?,?)
              ON CONFLICT(model_id) DO UPDATE SET holder_name = excluded.holder_name,
                routing_number = excluded.routing_number, account_number = excluded.account_number,
                created_at = datetime('now')`).run(req.user.id, holder, routing, account);
  res.json({ ok: true });
});

// Her saved account (masked — full number never leaves the server for models)
app.get('/api/model/payout-account', identMiddleware, requireUser, requireRole('model', 'recruiter'), (req, res) => {
  const a = db.prepare('SELECT * FROM payout_accounts WHERE model_id = ?').get(req.user.id);
  if (!a) return res.json({ account: null });
  res.json({ account: { holder_name: a.holder_name, routing_number: a.routing_number,
    account_last4: a.account_number.slice(-4) } });
});

// Her withdrawal history + available balance
app.get('/api/model/withdrawals', identMiddleware, requireUser, requireRole('model', 'recruiter'), (req, res) => {
  const rows = db.prepare(`SELECT id, amount_cents, status, requested_at, decided_at, note
                           FROM withdrawals WHERE model_id = ? ORDER BY id DESC`).all(req.user.id);
  const bd = getEarningsBreakdown(req.user.id);
  res.json({ withdrawals: rows, available_cents: getModelAvailable(req.user.id),
    holding_cents: bd.holding, negative_adjustment_cents: bd.debt, hold_days: getHoldDays() });
});

// Request a withdrawal (pending until Asce marks it paid)
app.post('/api/model/withdrawals', identMiddleware, requireUser, requireRole('model', 'recruiter'), (req, res) => {
  const amount = parseInt(req.body.amount_cents);
  const acct = db.prepare('SELECT id FROM payout_accounts WHERE model_id = ?').get(req.user.id);
  if (!acct) return res.status(400).json({ error: 'no_bank_account' });
  // IRS: W-9 info required before any payout can be issued
  const tax = db.prepare('SELECT id FROM tax_profiles WHERE user_id = ?').get(req.user.id);
  if (!tax) return res.status(400).json({ error: 'no_tax_info' });
  const available = getModelAvailable(req.user.id);
  if (!Number.isInteger(amount) || amount <= 0)
    return res.status(400).json({ error: 'bad_amount' });
  if (amount > available)
    return res.status(400).json({ error: 'insufficient_funds', available_cents: available });
  const info = db.prepare(`INSERT INTO withdrawals (model_id, amount_cents) VALUES (?,?)`)
    .run(req.user.id, amount);
  res.json({ ok: true, withdrawal: { id: Number(info.lastInsertRowid), amount_cents: amount,
    status: 'pending' }, available_cents: available - amount });
});

/* W-9 / 1099 tax profiles — models & partners (SSN/EIN encrypted at rest) */
/* ------------------------------------------------------------------ */

const US_STATES = new Set(('AL,AK,AZ,AR,CA,CO,CT,DE,DC,FL,GA,HI,ID,IL,IN,IA,KS,KY,LA,ME,MD,' +
  'MA,MI,MN,MS,MO,MT,NE,NV,NH,NJ,NM,NY,NC,ND,OH,OK,OR,PA,RI,SC,SD,TN,TX,UT,VT,' +
  'VA,WA,WV,WI,WY,PR,GU,VI,AS,MP').split(','));

function validateTaxProfile(body, existing) {
  const legal_name = String(body.legal_name || '').trim().slice(0, 120);
  const business_name = String(body.business_name || '').trim().slice(0, 120);
  const tax_id_type = body.tax_id_type === 'ein' ? 'ein' : 'ssn';
  const tax_id = String(body.tax_id || '').replace(/\D/g, '');
  const address_line1 = String(body.address_line1 || '').trim().slice(0, 120);
  const address_line2 = String(body.address_line2 || '').trim().slice(0, 120);
  const city = String(body.city || '').trim().slice(0, 80);
  const state = String(body.state || '').trim().toUpperCase().slice(0, 4);
  const zip = String(body.zip || '').trim().slice(0, 12);
  if (legal_name.length < 2) return { error: 'bad_legal_name' };
  // tax_id may be omitted when updating other fields (keeps the stored one)
  if (tax_id && !/^\d{9}$/.test(tax_id)) return { error: 'bad_tax_id' };
  if (!tax_id && !existing) return { error: 'bad_tax_id' };
  if (!address_line1) return { error: 'bad_address' };
  if (city.length < 2) return { error: 'bad_city' };
  if (!US_STATES.has(state)) return { error: 'bad_state' };
  if (!/^\d{5}(-\d{4})?$/.test(zip)) return { error: 'bad_zip' };
  return {
    ok: true, legal_name, business_name, tax_id_type, tax_id,
    address_line1, address_line2, city, state, zip,
  };
}

// Her/partner tax profile (masked — the full tax ID never leaves the server)
app.get('/api/tax-profile', identMiddleware, requireUser, requireRole('model', 'recruiter'), (req, res) => {
  const p = db.prepare('SELECT legal_name, business_name, tax_id_type, tax_id_last4, address_line1, address_line2, city, state, zip, submitted_at, updated_at, electronic_1099_consent, electronic_1099_consent_at FROM tax_profiles WHERE user_id = ?').get(req.user.id);
  if (!p) return res.json({ profile: null });
  const masked = p.tax_id_type === 'ein' ? `XX-XXXX${p.tax_id_last4}` : `***-**-${p.tax_id_last4}`;
  res.json({ profile: { ...p, tax_id_masked: masked, electronic_1099_consent: !!p.electronic_1099_consent }, key_ephemeral: taxKeyIsEphemeral() });
});

// Model downloads her 1099-NEC summary (digital delivery)
app.get('/api/tax-profile/1099/:year', identMiddleware, requireUser, requireRole('model', 'recruiter'), (req, res) => {
  const year = parseInt(req.params.year);
  if (!year || year < 2020 || year > 2100) return res.status(400).json({ error: 'bad_year' });
  const p = db.prepare('SELECT * FROM tax_profiles WHERE user_id = ?').get(req.user.id);
  if (!p) return res.status(404).json({ error: 'no_tax_profile' });
  if (!p.electronic_1099_consent) return res.status(403).json({ error: 'no_consent', message: 'You must consent to electronic delivery first.' });
  // Total paid out to this model in the year (payouts = what goes on the 1099)
  const paid = db.prepare(`SELECT COALESCE(SUM(amount_cents), 0) AS total FROM payouts
    WHERE user_id = ? AND status = 'paid' AND strftime('%Y', paid_at) = ?`)
    .get(req.user.id, String(year));
  const total = paid.total || 0;
  res.json({
    year, total_cents: total, total_dollars: (total / 100).toFixed(2),
    recipient: { legal_name: p.legal_name, address_line1: p.address_line1,
      address_line2: p.address_line2, city: p.city, state: p.state, zip: p.zip,
      tax_id_masked: p.tax_id_type === 'ein' ? `XX-XXXX${p.tax_id_last4}` : `***-**-${p.tax_id_last4}` },
    payer: { name: 'WORLD OF GODZ ENTERTAINMENT LLC' },
    note: total >= 60000
      ? 'You earned $600 or more. A 1099-NEC will be filed with the IRS.'
      : 'You earned under $600. No 1099-NEC filing required, but report this income on your taxes.',
  });
});

// Submit/update tax profile (W-9 info)
app.post('/api/tax-profile', identMiddleware, requireUser, requireRole('model', 'recruiter'), (req, res) => {
  const existing = db.prepare('SELECT * FROM tax_profiles WHERE user_id = ?').get(req.user.id);
  const v = validateTaxProfile(req.body, existing);
  if (v.error) return res.status(400).json({ error: v.error });
  let enc = existing ? existing.tax_id_encrypted : '';
  let last4 = existing ? existing.tax_id_last4 : '';
  let idType = existing ? existing.tax_id_type : v.tax_id_type;
  if (v.tax_id) {
    try { enc = encTax(v.tax_id); }
    catch (e) { return res.status(503).json({ error: 'tax_unavailable' }); }
    last4 = v.tax_id.slice(-4);
    idType = v.tax_id_type;
  }
  db.prepare(`INSERT INTO tax_profiles (user_id, legal_name, business_name, tax_id_type, tax_id_encrypted, tax_id_last4, address_line1, address_line2, city, state, zip, electronic_1099_consent, electronic_1099_consent_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?, ?, CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END)
              ON CONFLICT(user_id) DO UPDATE SET legal_name = excluded.legal_name,
                business_name = excluded.business_name, tax_id_type = excluded.tax_id_type,
                tax_id_encrypted = excluded.tax_id_encrypted, tax_id_last4 = excluded.tax_id_last4,
                address_line1 = excluded.address_line1, address_line2 = excluded.address_line2,
                city = excluded.city, state = excluded.state, zip = excluded.zip,
                electronic_1099_consent = excluded.electronic_1099_consent,
                electronic_1099_consent_at = excluded.electronic_1099_consent_at,
                updated_at = datetime('now')`).run(
    req.user.id, v.legal_name, v.business_name, idType, enc, last4,
    v.address_line1, v.address_line2, v.city, v.state, v.zip,
    req.body.electronic_1099_consent ? 1 : 0, req.body.electronic_1099_consent ? 1 : 0);
  res.json({ ok: true, tax_id_last4: last4, tax_id_type: idType });
});

// Model Fan Club: her top buyers ranked, with a Live / 1-on-1 / Chat split.
// Gross spend per fan (refunds net out — refund rows carry negative gross).
app.get('/api/model/fan-club', identMiddleware, requireUser, requireRole('model'), (req, res) => {
  const period = ['week', 'month'].includes(req.query.period) ? req.query.period : 'all';
  const since = period === 'week' ? `datetime('now','-7 days')`
              : period === 'month' ? `datetime('now','-30 days')` : null;
  const where = `t.model_id = ? AND t.is_test = 0 AND t.fan_id IS NOT NULL` +
    (since ? ` AND t.created_at >= ${since}` : '');
  const buyers = db.prepare(`
    SELECT t.fan_id, u.display_name AS fan_name,
      SUM(t.gross_cents) AS total_cents,
      SUM(CASE WHEN t.type LIKE 'live%' OR t.type LIKE 'priority%' THEN t.gross_cents ELSE 0 END) AS live_cents,
      SUM(CASE WHEN t.type LIKE 'booking%' OR t.type LIKE 'call%' THEN t.gross_cents ELSE 0 END) AS priv_cents,
      SUM(CASE WHEN t.type LIKE 'live%' OR t.type LIKE 'priority%' OR t.type LIKE 'booking%' OR t.type LIKE 'call%' THEN 0 ELSE t.gross_cents END) AS chat_cents,
      SUM(CASE WHEN t.gross_cents > 0 THEN 1 ELSE 0 END) AS payments,
      MAX(t.created_at) AS last_at
    FROM transactions t JOIN users u ON u.id = t.fan_id
    WHERE ${where}
    GROUP BY t.fan_id HAVING total_cents > 0
    ORDER BY total_cents DESC LIMIT 10`).all(req.user.id);
  const total = db.prepare(
    `SELECT COUNT(DISTINCT t.fan_id) AS n FROM transactions t WHERE ${where}`).get(req.user.id);
  res.json({ period, buyers, total_buyers: total.n });
});

app.get('/api/model/earnings', identMiddleware, requireUser, requireRole('model'), (req, res) => {
  const wallet = getWallet(req.user.id);
  const byFan = db.prepare(`
    SELECT COALESCE(u.display_name, 'Guest Fan') AS fan_name,
           SUM(t.model_cents) AS earned_cents, COUNT(*) AS payments
    FROM transactions t LEFT JOIN users u ON u.id = t.fan_id
    WHERE t.model_id = ? AND t.is_test = 0 AND t.type IN ('message','call','tip','ppv','voice','live_explicit','gift','game')
    GROUP BY t.fan_id ORDER BY earned_cents DESC`).all(req.user.id);
  const byType = db.prepare(`
    SELECT t.type, SUM(t.model_cents) AS earned_cents, COUNT(*) AS n
    FROM transactions t
    WHERE t.model_id = ? AND t.is_test = 0 AND t.type IN ('message','call','tip','ppv','voice','live_explicit','gift','game')
    GROUP BY t.type`).all(req.user.id);
  const gifts = db.prepare(`
    SELECT COALESCE(SUM(t.model_cents), 0) AS gifts_cents, COUNT(*) AS gift_count
    FROM transactions t WHERE t.model_id = ? AND t.is_test = 0 AND t.type = 'gift' AND t.model_cents > 0`).get(req.user.id);
  res.json({ earnings_cents: wallet.earnings_cents, paid_out_cents: wallet.paid_out_cents,
    pending_cents: wallet.earnings_cents - wallet.paid_out_cents, by_fan: byFan, by_type: byType,
    gifts_cents: gifts.gifts_cents, gift_count: gifts.gift_count });
});

/* ------------------------------------------------------------------ */
/* Video calls — WebRTC signaling + per-minute billing                  */
/* ------------------------------------------------------------------ */

const activeCallTimers = new Map();

function endCall(callId, reason) {
  const call = db.prepare('SELECT * FROM calls WHERE id = ?').get(callId);
  if (!call || call.status === 'ended') return;
  const timer = activeCallTimers.get(callId);
  if (timer) { clearInterval(timer); activeCallTimers.delete(callId); }
  db.prepare(`UPDATE calls SET status = 'ended', ended_at = datetime('now') WHERE id = ?`).run(callId);
  // A private booked session ending marks the booking completed
  if (call.booking_id) {
    db.prepare(`UPDATE bookings SET status = 'completed', decided_at = datetime('now')
                WHERE id = ? AND status = 'in_progress'`).run(call.booking_id);
    const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(call.booking_id);
    if (b && b.status === 'completed') {
      pushToUser(b.fan_id, { type: 'booking:completed', booking_id: b.id });
      pushToUser(b.model_id, { type: 'booking:completed', booking_id: b.id });
    }
  }
  pushToSubject(`u:${call.fan_id}`, { type: 'call:ended', call_id: callId, reason: reason || 'ended' });
  pushToSubject(`u:${call.model_id}`, { type: 'call:ended', call_id: callId, reason: reason || 'ended' });
  // FaceTime: close out the request and bring the next fan in line.
  if (call.facetime_req_id) {
    const fr = ftGet(call.facetime_req_id);
    if (fr && fr.status === 'in_call') {
      // Never actually started (she never accepted — e.g. her camera/mic
      // failed): the block "didn't happen", so it refunds in full, exactly
      // as the FaceTime sheet promises. Started calls finish as 'done'.
      if (!call.started_at) ftFinish(fr, 'cancelled', 'FaceTime never started — refunded');
      else ftFinish(fr, 'done', null);
    }
  }
  ftPromote(call.model_id);
}

function billCallMinute(callId) {
  const call = db.prepare('SELECT * FROM calls WHERE id = ?').get(callId);
  if (!call || call.status !== 'active') {
    const t = activeCallTimers.get(callId);
    if (t) { clearInterval(t); activeCallTimers.delete(callId); }
    return;
  }
  if (call.prepaid_min > 0) {
    // FaceTime block: already paid upfront — just count down to the cap.
    db.prepare('UPDATE calls SET minutes_billed = minutes_billed + 1 WHERE id = ?').run(callId);
    const upd = db.prepare('SELECT * FROM calls WHERE id = ?').get(callId);
    const remaining = Math.max(0, upd.prepaid_min - upd.minutes_billed);
    pushToSubject(`u:${call.fan_id}`, { type: 'call:tick', call_id: callId,
      minutes_billed: upd.minutes_billed, remaining_min: remaining, prepaid: true,
      balance_cents: getWallet(call.fan_id).credits_cents });
    pushToSubject(`u:${call.model_id}`, { type: 'call:tick', call_id: callId,
      minutes_billed: upd.minutes_billed, remaining_min: remaining, prepaid: true });
    ftRefreshQueueEtas(call.model_id);
    if (remaining <= 0) endCall(callId, 'time_up');
    return;
  }
  try {
    const rate = call.is_explicit ? call.rate_cents * 2 : call.rate_cents;
    chargeFan(call.fan_id, call.model_id, rate, 'call',
      `Video call minute ${call.minutes_billed + 1}${call.is_explicit ? ' (explicit)' : ''}`);
    db.prepare('UPDATE calls SET minutes_billed = minutes_billed + 1 WHERE id = ?').run(callId);
    const upd = db.prepare('SELECT * FROM calls WHERE id = ?').get(callId);
    pushToSubject(`u:${call.fan_id}`, { type: 'call:tick', call_id: callId,
      minutes_billed: upd.minutes_billed, balance_cents: getWallet(call.fan_id).credits_cents });
    pushToSubject(`u:${call.model_id}`, { type: 'call:tick', call_id: callId,
      minutes_billed: upd.minutes_billed });
  } catch (e) {
    endCall(callId, e.message === 'spend_cap_reached' ? 'spend_cap_reached' : 'insufficient_credits');
  }
}

// Fans only (guests must sign up first). Blocked if the chat is safety-paused.
app.post('/api/calls', identMiddleware, requireUser, requireRole('fan'), (req, res) => {
  const row = db.prepare(`
    SELECT u.id, m.is_online, m.per_minute_cents FROM users u
    JOIN models m ON m.user_id = u.id
    WHERE u.id = ? AND u.role = 'model' AND u.banned = 0`).get(req.body.model_id);
  if (!row) return res.status(404).json({ error: 'model_not_found' });
  if (modelRegionBlocked(row.id, geoOfReq(req))) return regionBlocked(res);
  if (!row.is_online) return res.status(409).json({ error: 'model_offline' });
  const liveNow = db.prepare(`SELECT id FROM live_sessions WHERE model_id = ? AND status = 'live'`).get(row.id);
  if (liveNow) return res.status(409).json({ error: 'model_live',
    message: "She's live right now — video calls are locked during lives. Join her stage or book a 1-on-1." });
  let conv = db.prepare('SELECT * FROM conversations WHERE fan_id = ? AND model_id = ?')
    .get(req.user.id, row.id);
  if (conv) conv = maybeAutoUnpause(conv);
  if (conv && conv.is_paused)
    return res.status(423).json({ error: 'chat_paused', message: 'Chat is paused by safety monitor.' });
  if (getWallet(req.user.id).credits_cents < row.per_minute_cents)
    return res.status(402).json({ error: 'insufficient_credits', needed_cents: row.per_minute_cents,
      balance_cents: getWallet(req.user.id).credits_cents });
  const info = db.prepare('INSERT INTO calls (fan_id, model_id, rate_cents) VALUES (?,?,?)')
    .run(req.user.id, row.id, row.per_minute_cents);
  res.json({ call_id: Number(info.lastInsertRowid), rate_cents: row.per_minute_cents });
});

app.post('/api/calls/:id/accept', identMiddleware, requireUser, (req, res) => {
  const call = db.prepare('SELECT * FROM calls WHERE id = ?').get(req.params.id);
  if (!call) return res.status(404).json({ error: 'not_found' });
  if (call.model_id !== req.user.id && call.fan_id !== req.user.id)
    return res.status(403).json({ error: 'forbidden' });
  if (call.status !== 'pending') return res.status(409).json({ error: 'call_not_pending' });
  db.prepare(`UPDATE calls SET status = 'active', started_at = datetime('now') WHERE id = ?`).run(call.id);
  activeCallTimers.set(call.id, setInterval(() => billCallMinute(call.id), 60 * 1000));
  res.json({ ok: true });
});

app.post('/api/calls/:id/end', identMiddleware, requireUser, (req, res) => {
  const call = db.prepare('SELECT * FROM calls WHERE id = ?').get(req.params.id);
  if (!call) return res.status(404).json({ error: 'not_found' });
  if (call.model_id !== req.user.id && call.fan_id !== req.user.id && req.user.role !== 'admin')
    return res.status(403).json({ error: 'forbidden' });
  endCall(call.id, 'hangup');
  res.json({ ok: true });
});

app.get('/api/calls/:id', identMiddleware, requireUser, (req, res) => {
  const call = db.prepare('SELECT * FROM calls WHERE id = ?').get(req.params.id);
  if (!call) return res.status(404).json({ error: 'not_found' });
  if (call.model_id !== req.user.id && call.fan_id !== req.user.id && req.user.role !== 'admin')
    return res.status(403).json({ error: 'forbidden' });
  res.json({ call });
});

/* ------------------------------------------------------------------ */
/* FaceTime: prepaid instant 1-on-1 requests + queue (Oct 13, 2026)    */
/* Fan prepays a block (10/15/30/45/60 min) from chat. The model       */
/* accepts -> his call starts now, or he queues behind her current     */
/* call with live position + ETA updates. Locked while she's LIVE      */
/* (book a 1-on-1 instead) or offline — requests need her "Online".    */
/* Mid-call, she can flip to explicit: remaining minutes cost double,  */
/* the fan pays the uplift to continue explicit.                       */
/* ------------------------------------------------------------------ */
const FACETIME_DURATIONS = [10, 15, 30, 45, 60];
const FT_INVITE_WINDOW_MS = 90 * 1000;

function ftGet(id) {
  return db.prepare('SELECT * FROM facetime_requests WHERE id = ?').get(id);
}
function ftActiveCall(modelId) {
  return db.prepare(`SELECT * FROM calls WHERE model_id = ? AND status = 'active'
                     ORDER BY id DESC LIMIT 1`).get(modelId);
}
function ftCallRemainingMin(call) {
  if (!call) return 0;
  if (call.prepaid_min > 0) return Math.max(0, call.prepaid_min - call.minutes_billed);
  return 10; // metered legacy call: rough ETA estimate only
}
function ftQueueState(modelId) {
  const queued = db.prepare(`SELECT * FROM facetime_requests
    WHERE model_id = ? AND status = 'queued' ORDER BY id`).all(modelId);
  const invited = db.prepare(`SELECT * FROM facetime_requests
    WHERE model_id = ? AND status = 'invited' ORDER BY id LIMIT 1`).get(modelId);
  return { queued, invited, active: ftActiveCall(modelId) };
}
function ftPositionEta(modelId, reqRow) {
  if (reqRow.status === 'invited') return { position: 0, eta_min: 0 };
  if (reqRow.status !== 'queued') return { position: null, eta_min: null };
  const { queued, invited, active } = ftQueueState(modelId);
  let eta = ftCallRemainingMin(active);
  let ahead = 0;
  if (invited) { eta += invited.duration_min; ahead += 1; }
  for (const q of queued) {
    if (q.id === reqRow.id) break;
    eta += q.duration_min; ahead += 1;
  }
  return { position: ahead + 1, eta_min: eta };
}
function ftPublic(reqRow) {
  const fan = db.prepare('SELECT display_name FROM users WHERE id = ?').get(reqRow.fan_id);
  const model = db.prepare('SELECT display_name FROM users WHERE id = ?').get(reqRow.model_id);
  const pe = ftPositionEta(reqRow.model_id, reqRow);
  return { id: reqRow.id, fan_id: reqRow.fan_id, fan_name: fan ? fan.display_name : 'Fan',
    model_id: reqRow.model_id, model_name: model ? model.display_name : '',
    duration_min: reqRow.duration_min, amount_cents: reqRow.amount_cents,
    status: reqRow.status, call_id: reqRow.call_id,
    position: pe.position, eta_min: pe.eta_min, created_at: reqRow.created_at };
}
function ftPushFan(reqRow, extra = {}) {
  const pub = ftPublic(reqRow);
  pushToSubject(`u:${reqRow.fan_id}`, { type: 'facetime:update',
    request: pub, ...extra });
  // Queue-shaped mirror event: the waiting card keys off this for
  // position/ETA refreshes (same payload as facetime:update).
  pushToSubject(`u:${reqRow.fan_id}`, { type: 'queue:update', request: pub });
}
/* Per-minute ETA refresh for everyone waiting on this model (called from
   the call billing tick; a no-op unless somebody is actually queued). */
function ftRefreshQueueEtas(modelId) {
  const any = db.prepare(`SELECT id FROM facetime_requests
    WHERE model_id = ? AND status = 'queued' LIMIT 1`).get(modelId);
  if (any) ftPushQueue(modelId);
}
function ftPushQueue(modelId) {
  const st = ftQueueState(modelId);
  for (const q of st.queued) ftPushFan(q);
  // Her live view of the line: invited head + everyone queued, in order.
  const line = [...(st.invited ? [st.invited] : []), ...st.queued];
  pushToSubject(`u:${modelId}`, { type: 'facetime:queue',
    requests: line.map(ftPublic) });
}
function ftFinish(reqRow, status, refundNote) {
  db.prepare(`UPDATE facetime_requests SET status = ?,
              ended_at = datetime('now') WHERE id = ?`).run(status, reqRow.id);
  if (refundNote)
    refundFan(reqRow.fan_id, reqRow.model_id, reqRow.amount_cents, 'call_refund', refundNote);
  const fresh = ftGet(reqRow.id);
  ftPushFan(fresh);
  pushToSubject(`u:${reqRow.model_id}`, { type: 'facetime:update', request: ftPublic(fresh) });
  ftPushQueue(reqRow.model_id);
  return fresh;
}
function ftPromote(modelId) {
  const { queued, invited, active } = ftQueueState(modelId);
  if (active || invited || !queued.length) return;
  const next = queued[0];
  db.prepare(`UPDATE facetime_requests SET status = 'invited',
              decided_at = datetime('now'), invite_expires_ms = ? WHERE id = ?`)
    .run(Date.now() + FT_INVITE_WINDOW_MS, next.id);
  const fresh = ftGet(next.id);
  ftPushFan(fresh);
  pushToSubject(`u:${fresh.fan_id}`, { type: 'queue:your_turn', request: ftPublic(fresh) });
  notifyUser(fresh.fan_id, 'facetime', srv('bell_ft_turn_title', userLang(fresh.fan_id)),
    srv('bell_ft_turn_body', userLang(fresh.fan_id), { model: fresh.model_name }),
    '/#chat');
  ftPushQueue(modelId);
}
function ftCancelAll(modelId, reason) {
  const rows = db.prepare(`SELECT * FROM facetime_requests WHERE model_id = ?
    AND status IN ('pending','queued','invited') ORDER BY id`).all(modelId);
  for (const r of rows) {
    db.prepare(`UPDATE facetime_requests SET status = 'cancelled',
                ended_at = datetime('now') WHERE id = ?`).run(r.id);
    refundFan(r.fan_id, r.model_id, r.amount_cents, 'call_refund', `FaceTime cancelled — ${reason}`);
    ftPushFan(ftGet(r.id), { reason });
  }
  if (rows.length) ftPushQueue(modelId);
}
function ftSweep() {
  // Pending requests do NOT expire (owner ruling, Oct 15): an unanswered
  // request lives in her notification box until she accepts/declines,
  // the fan cancels, or her session ends (ftCancelAll refunds). Only the
  // 90-second your-turn window still lapses here.
  const missed = db.prepare(`SELECT * FROM facetime_requests WHERE status = 'invited'
    AND invite_expires_ms IS NOT NULL AND invite_expires_ms < ?`).all(Date.now());
  const touched = new Set();
  for (const r of missed) {
    ftFinish(r, 'cancelled', 'FaceTime turn missed — refunded');
    touched.add(r.model_id);
  }
  for (const m of touched) ftPromote(m);
}
setInterval(ftSweep, 30 * 1000);

app.post('/api/facetime/request', identMiddleware, requireUser, requireRole('fan'), (req, res) => {
  const duration = Number(req.body.duration_min);
  if (!FACETIME_DURATIONS.includes(duration))
    return res.status(400).json({ error: 'bad_duration', allowed: FACETIME_DURATIONS });
  const row = db.prepare(`
    SELECT u.id, u.display_name, m.is_online, m.per_minute_cents FROM users u
    JOIN models m ON m.user_id = u.id
    WHERE u.id = ? AND u.role = 'model' AND u.banned = 0`).get(req.body.model_id);
  if (!row) return res.status(404).json({ error: 'model_not_found' });
  if (modelRegionBlocked(row.id, geoOfReq(req))) return regionBlocked(res);
  const live = db.prepare(`SELECT id FROM live_sessions WHERE model_id = ? AND status = 'live'`).get(row.id);
  if (live) return res.status(409).json({ error: 'model_live',
    message: "She's live right now — FaceTime is locked during lives. Join her stage or book a 1-on-1." });
  if (!row.is_online) return res.status(409).json({ error: 'model_offline' });
  let conv = db.prepare('SELECT * FROM conversations WHERE fan_id = ? AND model_id = ?')
    .get(req.user.id, row.id);
  if (conv) conv = maybeAutoUnpause(conv);
  if (conv && conv.is_paused)
    return res.status(423).json({ error: 'chat_paused', message: 'Chat is paused by safety monitor.' });
  const dup = db.prepare(`SELECT id FROM facetime_requests WHERE fan_id = ? AND model_id = ?
    AND status IN ('pending','queued','invited','in_call')`).get(req.user.id, row.id);
  if (dup) return res.status(409).json({ error: 'already_requested', request_id: dup.id });
  // One line at a time: a fan already waiting (or in a call) with another
  // model can't join a second queue until he finishes or cancels that one.
  const elsewhere = db.prepare(`SELECT fr.id, u.display_name AS mname
    FROM facetime_requests fr JOIN users u ON u.id = fr.model_id
    WHERE fr.fan_id = ? AND fr.model_id != ?
    AND fr.status IN ('pending','queued','invited','in_call') LIMIT 1`)
    .get(req.user.id, row.id);
  if (elsewhere) return res.status(409).json({ error: 'already_in_line',
    message: `You're already in line with ${elsewhere.mname} — finish or cancel that one first.` });
  const amount = duration * row.per_minute_cents;
  if (getWallet(req.user.id).credits_cents < amount)
    return res.status(402).json({ error: 'insufficient_credits', needed_cents: amount,
      balance_cents: getWallet(req.user.id).credits_cents });
  try {
    chargeFan(req.user.id, row.id, amount, 'call',
      `FaceTime ${duration} min with ${row.display_name}`, clientIp(req));
  } catch (e) {
    return res.status(402).json(chargeErrorBody(e, amount, req.user.id));
  }
  const info = db.prepare(`INSERT INTO facetime_requests (fan_id, model_id, duration_min, amount_cents)
    VALUES (?,?,?,?)`).run(req.user.id, row.id, duration, amount);
  const fresh = ftGet(Number(info.lastInsertRowid));
  pushToSubject(`u:${row.id}`, { type: 'facetime:request', request: ftPublic(fresh) });
  // The bell row is the request's persistent home: its link carries the
  // request id so her notification box can render live Accept/Decline
  // actions against it until she acts (owner ruling, Oct 15).
  notifyUser(row.id, 'facetime', srv('bell_ft_req_title', userLang(row.id)),
    srv('bell_ft_req_body', userLang(row.id),
      { fan: req.user.display_name, min: duration, amount: '$' + (amount / 100).toFixed(2) }),
    `/#ft/${fresh.id}`);
  res.json({ request: ftPublic(fresh) });
});

app.get('/api/facetime/mine', identMiddleware, requireUser, requireRole('fan'), (req, res) => {
  const r = db.prepare(`SELECT * FROM facetime_requests WHERE fan_id = ?
    AND status IN ('pending','queued','invited','in_call') ORDER BY id DESC LIMIT 1`).get(req.user.id);
  res.json({ request: r ? ftPublic(r) : null });
});

// The fan's waiting state, restorable after he browses away and returns:
// his request (with position + ETA) plus how much humanity is ahead of him.
app.get('/api/facetime/queue/me', identMiddleware, requireUser, requireRole('fan'), (req, res) => {
  const r = db.prepare(`SELECT * FROM facetime_requests WHERE fan_id = ?
    AND status IN ('pending','queued','invited','in_call') ORDER BY id DESC LIMIT 1`).get(req.user.id);
  if (!r) return res.json({ request: null, ahead_count: 0, ahead_minutes: 0,
    active_call_remaining_min: 0 });
  const pub = ftPublic(r);
  let aheadCount = 0, aheadMinutes = 0;
  if (r.status === 'queued') {
    const { queued, invited } = ftQueueState(r.model_id);
    if (invited) { aheadCount += 1; aheadMinutes += invited.duration_min; }
    for (const q of queued) {
      if (q.id === r.id) break;
      aheadCount += 1; aheadMinutes += q.duration_min;
    }
  }
  res.json({ request: pub, ahead_count: aheadCount, ahead_minutes: aheadMinutes,
    active_call_remaining_min: ftCallRemainingMin(ftActiveCall(r.model_id)) });
});

app.get('/api/facetime/incoming', identMiddleware, requireUser, requireRole('model'), (req, res) => {
  const rows = db.prepare(`SELECT * FROM facetime_requests WHERE model_id = ?
    AND status IN ('pending','queued','invited','in_call') ORDER BY id`).all(req.user.id);
  res.json({ requests: rows.map(ftPublic) });
});

app.post('/api/facetime/:id/accept', identMiddleware, requireUser, requireRole('model'), (req, res) => {
  const r = ftGet(req.params.id);
  if (!r || r.model_id !== req.user.id) return res.status(404).json({ error: 'not_found' });
  if (r.status !== 'pending') return res.status(409).json({ error: 'not_pending' });
  const { queued, invited, active } = ftQueueState(req.user.id);
  if (active || invited) {
    db.prepare(`UPDATE facetime_requests SET status = 'queued',
                decided_at = datetime('now') WHERE id = ?`).run(r.id);
    const fresh = ftGet(r.id);
    ftPushFan(fresh);
    ftPushQueue(req.user.id);
    return res.json({ request: ftPublic(fresh), queued: true });
  }
  db.prepare(`UPDATE facetime_requests SET status = 'invited',
              decided_at = datetime('now'), invite_expires_ms = ? WHERE id = ?`)
    .run(Date.now() + FT_INVITE_WINDOW_MS, r.id);
  const fresh = ftGet(r.id);
  ftPushFan(fresh);
  notifyUser(fresh.fan_id, 'facetime', srv('bell_ft_accepted_title', userLang(fresh.fan_id)),
    srv('bell_ft_accepted_body', userLang(fresh.fan_id), { model: fresh.model_name }), '/#chat');
  res.json({ request: ftPublic(fresh), queued: false });
});

app.post('/api/facetime/:id/decline', identMiddleware, requireUser, requireRole('model'), (req, res) => {
  const r = ftGet(req.params.id);
  if (!r || r.model_id !== req.user.id) return res.status(404).json({ error: 'not_found' });
  if (!['pending', 'queued'].includes(r.status))
    return res.status(409).json({ error: 'not_decidable' });
  ftFinish(r, 'declined', 'FaceTime declined — refunded');
  ftPushQueue(req.user.id);
  res.json({ ok: true });
});

app.post('/api/facetime/:id/cancel', identMiddleware, requireUser, requireRole('fan'), (req, res) => {
  const r = ftGet(req.params.id);
  if (!r || r.fan_id !== req.user.id) return res.status(404).json({ error: 'not_found' });
  if (!['pending', 'queued', 'invited'].includes(r.status))
    return res.status(409).json({ error: 'not_cancellable' });
  const wasInvited = r.status === 'invited';
  ftFinish(r, 'cancelled', 'FaceTime cancelled by fan — refunded');
  if (wasInvited) ftPromote(r.model_id); else ftPushQueue(r.model_id);
  res.json({ ok: true });
});

app.post('/api/facetime/:id/join', identMiddleware, requireUser, requireRole('fan'), (req, res) => {
  const r = ftGet(req.params.id);
  if (!r || r.fan_id !== req.user.id) return res.status(404).json({ error: 'not_found' });
  if (r.status !== 'invited') return res.status(409).json({ error: 'not_invited' });
  const m = db.prepare('SELECT per_minute_cents FROM models WHERE user_id = ?').get(r.model_id);
  const info = db.prepare(`INSERT INTO calls (fan_id, model_id, rate_cents, prepaid_min, facetime_req_id)
    VALUES (?,?,?,?,?)`).run(r.fan_id, r.model_id, m.per_minute_cents, r.duration_min, r.id);
  const callId = Number(info.lastInsertRowid);
  db.prepare(`UPDATE facetime_requests SET status = 'in_call', call_id = ? WHERE id = ?`)
    .run(callId, r.id);
  const fresh = ftGet(r.id);
  ftPushFan(fresh);
  pushToSubject(`u:${r.model_id}`, { type: 'facetime:update', request: ftPublic(fresh) });
  res.json({ call_id: callId, rate_cents: m.per_minute_cents, prepaid_min: r.duration_min });
});

/* Mid-call explicit switch: she offers, he pays the uplift (remaining     */
/* prepaid minutes at her rate again = double total), or per-minute       */
/* doubling on legacy metered calls.                                      */
app.post('/api/calls/:id/explicit-request', identMiddleware, requireUser, requireRole('model'), (req, res) => {
  const call = db.prepare('SELECT * FROM calls WHERE id = ?').get(req.params.id);
  if (!call || call.model_id !== req.user.id) return res.status(404).json({ error: 'not_found' });
  if (call.status !== 'active') return res.status(409).json({ error: 'call_not_active' });
  if (call.booking_id) return res.status(409).json({ error: 'not_for_bookings' });
  if (call.is_explicit) return res.status(409).json({ error: 'already_explicit' });
  if (call.explicit_pending) return res.status(409).json({ error: 'already_pending' });
  const remaining = call.prepaid_min > 0 ? call.prepaid_min - call.minutes_billed : null;
  if (remaining !== null && remaining <= 0) return res.status(409).json({ error: 'no_time_left' });
  const extra = remaining !== null ? remaining * call.rate_cents : 0;
  db.prepare('UPDATE calls SET explicit_pending = 1 WHERE id = ?').run(call.id);
  pushToSubject(`u:${call.fan_id}`, { type: 'call:explicit_offer', call_id: call.id,
    extra_cents: extra, remaining_min: remaining, per_min_cents: call.rate_cents });
  res.json({ ok: true, extra_cents: extra, remaining_min: remaining });
});

app.post('/api/calls/:id/explicit-accept', identMiddleware, requireUser, requireRole('fan'), (req, res) => {
  const call = db.prepare('SELECT * FROM calls WHERE id = ?').get(req.params.id);
  if (!call || call.fan_id !== req.user.id) return res.status(404).json({ error: 'not_found' });
  if (call.status !== 'active' || !call.explicit_pending)
    return res.status(409).json({ error: 'no_offer' });
  // Shield: accepting explicit mode is an explicit-content purchase —
  // refused for a shielded (unverified, regulated-state) fan, before
  // any charge.
  if (shieldAppliesToIdent(req, req.ident)) return avRequired(res);
  if (call.prepaid_min > 0) {
    const remaining = Math.max(0, call.prepaid_min - call.minutes_billed);
    const extra = remaining * call.rate_cents;
    if (extra > 0) {
      if (getWallet(req.user.id).credits_cents < extra)
        return res.status(402).json({ error: 'insufficient_credits', needed_cents: extra,
          balance_cents: getWallet(req.user.id).credits_cents });
      try {
        chargeFan(req.user.id, call.model_id, extra, 'call_explicit',
          `Explicit FaceTime — ${remaining} min`, clientIp(req));
      } catch (e) {
        return res.status(402).json(chargeErrorBody(e, extra, req.user.id));
      }
    }
  }
  db.prepare('UPDATE calls SET is_explicit = 1, explicit_pending = 0 WHERE id = ?').run(call.id);
  pushToSubject(`u:${call.fan_id}`, { type: 'call:explicit_on', call_id: call.id });
  pushToSubject(`u:${call.model_id}`, { type: 'call:explicit_on', call_id: call.id });
  res.json({ ok: true });
});

app.post('/api/calls/:id/explicit-decline', identMiddleware, requireUser, requireRole('fan'), (req, res) => {
  const call = db.prepare('SELECT * FROM calls WHERE id = ?').get(req.params.id);
  if (!call || call.fan_id !== req.user.id) return res.status(404).json({ error: 'not_found' });
  db.prepare('UPDATE calls SET explicit_pending = 0 WHERE id = ? AND explicit_pending = 1').run(call.id);
  pushToSubject(`u:${call.model_id}`, { type: 'call:explicit_declined', call_id: call.id });
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Admin SMS 2FA settings (Twilio)                                     */
/* ------------------------------------------------------------------ */

const adminOnly = [identMiddleware, requireUser, requireRole('admin'), requirePasskeyStepUp];

// --- Visitor analytics (Corry Oct 11, 2026): track visits + sources for growth ---
db.exec(`
CREATE TABLE IF NOT EXISTS visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip_hash TEXT,
  country TEXT,
  city TEXT,
  referrer TEXT,
  path TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_visits_created ON visits(created_at);`);

// In-memory geo cache (ip -> {country, city}) to avoid repeat lookups
const geoCache = new Map();
async function geoFor(ip) {
  if (!ip || ip === 'unknown' || ip.startsWith('127.') || ip === '::1') return {};
  if (geoCache.has(ip)) return geoCache.get(ip);
  const out = {};
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 2500);
    const r = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,city`, { signal: ctl.signal });
    clearTimeout(t);
    const j = await r.json().catch(() => ({}));
    if (j.status === 'success') { out.country = j.country || null; out.city = j.city || null; }
  } catch { /* geo is best-effort */ }
  geoCache.set(ip, out);
  if (geoCache.size > 5000) geoCache.clear();
  return out;
}
function hashIP(ip) {
  return crypto.createHash('sha256').update(String(ip) + '|visit-salt').digest('hex').slice(0, 32);
}

// Public: log a page visit (called once per session from the frontend)
app.post('/api/track/visit', async (req, res) => {
  try {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const { path, referrer } = req.body || {};
    const geo = await geoFor(ip);
    db.prepare(`INSERT INTO visits (ip_hash, country, city, referrer, path, user_agent)
      VALUES (?,?,?,?,?,?)`).run(
      hashIP(ip), geo.country || null, geo.city || null,
      String(referrer || '').slice(0, 500) || null,
      String(path || '/').slice(0, 200),
      String(req.headers['user-agent'] || '').slice(0, 300));
  } catch { /* never break the page for analytics */ }
  res.json({ ok: true });
});

// Admin: analytics summary
app.get('/api/admin/analytics', ...adminOnly, (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 365);
  const since = `datetime('now', '-${days} days')`;
  const total = db.prepare(`SELECT COUNT(*) AS n FROM visits WHERE created_at >= ${since}`).get().n;
  const unique = db.prepare(`SELECT COUNT(DISTINCT ip_hash) AS n FROM visits WHERE created_at >= ${since}`).get().n;
  const byDay = db.prepare(`
    SELECT date(created_at) AS d, COUNT(*) AS visits, COUNT(DISTINCT ip_hash) AS unique_visitors
    FROM visits WHERE created_at >= ${since} GROUP BY d ORDER BY d`).all();
  const referrers = db.prepare(`
    SELECT COALESCE(NULLIF(referrer,''), '(direct)') AS ref, COUNT(*) AS n
    FROM visits WHERE created_at >= ${since} GROUP BY ref ORDER BY n DESC LIMIT 20`).all();
  const countries = db.prepare(`
    SELECT COALESCE(country, '(unknown)') AS c, COUNT(*) AS n
    FROM visits WHERE created_at >= ${since} GROUP BY c ORDER BY n DESC LIMIT 20`).all();
  const pages = db.prepare(`
    SELECT path, COUNT(*) AS n FROM visits WHERE created_at >= ${since}
    GROUP BY path ORDER BY n DESC LIMIT 20`).all();
  res.json({ days, total, unique, byDay, referrers, countries, pages });
});

// 2FA status
app.get('/api/admin/2fa', ...adminOnly, (req, res) => {
  const { phone, on } = getAdmin2FAState();
  res.json({ on, phone_masked: maskPhone(phone) });
});

// Change number (password confirm → text verification code)
app.post('/api/admin/2fa/change-phone', ...adminOnly, async (req, res) => {
  const { password, phone } = req.body || {};
  if (!bcrypt.compareSync(password || '', req.user.password_hash))
    return res.status(401).json({ error: 'bad_login' });
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) return res.status(400).json({ error: 'bad_phone' });
  const e164 = '+' + digits;
  db.prepare('UPDATE platform_stats SET admin_phone = ? WHERE id = 1').run(e164);
  const code = issueSmsCode(req.user.id);
  const sent = await sendAdminSMS(e164, `SlutCamp admin code: ${code}. Expires in 5 min.`);
  if (!sent.ok) return res.status(500).json({ error: sent.error });
  res.json({ ok: true, sent: true, masked: maskPhone(e164) });
});

// Verify the new number → keep 2FA on
app.post('/api/admin/2fa/verify-phone-change', ...adminOnly, (req, res) => {
  const { code } = req.body || {};
  const row = db.prepare('SELECT * FROM sms_codes WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(req.user.id);
  if (!row || row.attempts >= 3) return res.status(401).json({ error: 'bad_code' });
  if (Date.now() > row.expires_at) {
    db.prepare('DELETE FROM sms_codes WHERE id = ?').run(row.id);
    return res.status(401).json({ error: 'code_expired' });
  }
  if (String(code || '').trim() !== row.code) {
    db.prepare('UPDATE sms_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
    return res.status(401).json({ error: 'bad_code' });
  }
  db.prepare('DELETE FROM sms_codes WHERE user_id = ?').run(req.user.id);
  db.prepare('UPDATE platform_stats SET admin_2fa_on = 1 WHERE id = 1').run();
  res.json({ ok: true });
});

// Turn 2FA off (password confirm + warning shown in UI)
app.post('/api/admin/2fa/disable', ...adminOnly, (req, res) => {
  const { password } = req.body || {};
  if (!bcrypt.compareSync(password || '', req.user.password_hash))
    return res.status(401).json({ error: 'bad_login' });
  db.prepare('UPDATE platform_stats SET admin_2fa_on = 0 WHERE id = 1').run();
  db.prepare('DELETE FROM sms_codes WHERE user_id = ?').run(req.user.id);
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* LIVE CAM — "pay to play" broadcast with AI nudity blur               */
/* Model broadcasts free SFW preview; NSFWJS on the fan's device blurs */
/* on nudity until the fan pays the explicit per-minute rate.           */
/* ------------------------------------------------------------------ */

const livePayTimers = new Map(); // "sessionId:fanId" -> interval

function liveTimerKey(sessionId, fanId) { return `${sessionId}:${fanId}`; }

function stopLivePayTimer(sessionId, fanId, clearDb = true) {
  const k = liveTimerKey(sessionId, fanId);
  const t = livePayTimers.get(k);
  if (t) { clearInterval(t); livePayTimers.delete(k); }
  if (clearDb) db.prepare('UPDATE live_viewers SET is_paying = 0 WHERE session_id = ? AND fan_id = ?')
    .run(sessionId, fanId);
}

function billLiveMinute(sessionId, fanId) {
  const sess = db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(sessionId);
  const viewer = db.prepare('SELECT * FROM live_viewers WHERE session_id = ? AND fan_id = ?')
    .get(sessionId, fanId);
  if (!sess || sess.status !== 'live' || !viewer || !viewer.is_paying) {
    stopLivePayTimer(sessionId, fanId);
    return;
  }
  try {
    chargeFan(fanId, sess.model_id, sess.explicit_rate_cents, 'live_explicit',
      `Live explicit minute`);
    pushToSubject(`u:${fanId}`, { type: 'live:tick', session_id: sessionId,
      balance_cents: getWallet(fanId).credits_cents });
  } catch (e) {
    // Out of credits (or the fan's own spend cap) → back to blurred free preview
    const reason = e.message === 'spend_cap_reached' ? 'spend_cap_reached' : 'insufficient_credits';
    stopLivePayTimer(sessionId, fanId);
    db.prepare(`INSERT INTO blur_events (session_id, fan_id, event, detail)
                VALUES (?,?,'pay_stopped',?)`).run(sessionId, fanId, reason);
    pushToSubject(`u:${fanId}`, { type: 'live:pay_stopped', session_id: sessionId,
      reason,
      balance_cents: getWallet(fanId).credits_cents });
  }
}

function pushLiveViewers(sessionId, event) {
  const viewers = db.prepare('SELECT fan_id FROM live_viewers WHERE session_id = ?').all(sessionId);
  for (const v of viewers) pushToSubject(`u:${v.fan_id}`, event);
}

// Push to every viewer AND the model (group stream chat, gifts, etc.)
function pushLiveAll(sessionId, event) {
  pushLiveViewers(sessionId, event);
  const sess = db.prepare('SELECT model_id FROM live_sessions WHERE id = ?').get(sessionId);
  if (sess) pushToUser(sess.model_id, event);
}

// Model: check if she has an active live session (for "Back to Live" button)
app.get('/api/live/my-session', identMiddleware, requireUser, requireRole('model'), (req, res) => {
  const sess = db.prepare(`SELECT id FROM live_sessions WHERE model_id = ? AND status = 'live'`)
    .get(req.user.id);
  res.json({ session_id: sess ? sess.id : null });
});

// Model starts a live cam session
app.post('/api/live/start', identMiddleware, requireUser, requireRole('model'), (req, res) => {
  if (!isIdVerified(req.user.id))
    return res.status(403).json({ error: 'id_verification_required',
      message: '🪪 ID verification required — upload your ID in Settings → ID Verification to go live.' });
  const existing = db.prepare(`SELECT id FROM live_sessions WHERE model_id = ? AND status = 'live'`)
    .get(req.user.id);
  if (existing) return res.status(409).json({ error: 'already_live', session_id: existing.id });
  // FaceTime locks while she's live: an active call must end first, and
  // everyone waiting in her FaceTime line is refunded + told why.
  if (ftActiveCall(req.user.id))
    return res.status(409).json({ error: 'in_facetime_call',
      message: 'End your FaceTime call before going live.' });
  ftCancelAll(req.user.id, 'she went live');
  const m = db.prepare('SELECT explicit_rate_cents FROM models WHERE user_id = ?').get(req.user.id);
  const explicit_rate_cents = Number.isInteger(req.body.explicit_rate_cents) &&
    req.body.explicit_rate_cents >= 0 ? req.body.explicit_rate_cents : (m ? m.explicit_rate_cents : 499);
  const title = String(req.body.title || '').trim().slice(0, 60);
  const info = db.prepare(
    'INSERT INTO live_sessions (model_id, explicit_rate_cents, title) VALUES (?,?,?)')
    .run(req.user.id, explicit_rate_cents, title);
  db.prepare('UPDATE models SET is_online = 1 WHERE user_id = ?').run(req.user.id);
  // Notify followers: "she's live!" — EXCEPT the official house account
  // (owner, Oct 17 2026): when the app itself goes live, EVERY fan is
  // notified, follower or not. Joining, tipping and in-live spending
  // are the regular live machinery, unchanged for everyone.
  const me = db.prepare('SELECT display_name FROM users WHERE id = ?').get(req.user.id);
  const followers = isHouseAccountId(req.user.id)
    ? db.prepare("SELECT id AS fan_id FROM users WHERE role = 'fan' AND banned = 0").all()
    : db.prepare('SELECT fan_id FROM follows WHERE model_id = ?').all(req.user.id);
  for (const f of followers) {
    const fanLang = userLang(f.fan_id);
    notifyUser(f.fan_id, 'live',
      srv('bell_live_title', fanLang, { model: me.display_name }),
      title ? srv('bell_live_body_titled', fanLang, { title }) : srv('bell_live_body', fanLang),
      '/#live');
  }
  res.json({ session_id: Number(info.lastInsertRowid), explicit_rate_cents, title });
});

// Fan leaves the live view (stops billing, closes model's peer connection)
app.post('/api/live/:id/leave', identMiddleware, requireUser, requireRole('fan'), (req, res) => {
  const sess = db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(req.params.id);
  if (!sess) return res.status(404).json({ error: 'not_found' });
  stopLivePayTimer(sess.id, req.user.id);
  db.prepare('DELETE FROM live_viewers WHERE session_id = ? AND fan_id = ?')
    .run(sess.id, req.user.id);
  // Leaving while on stage or waiting: drop stage (no refund), cancel pending (refund)
  const myStage = db.prepare(`SELECT * FROM live_join_requests
    WHERE session_id = ? AND fan_id = ? AND status = 'approved'`)
    .get(sess.id, req.user.id);
  if (myStage) dropStageFan(sess.id, 'fan_left');
  const myPending = db.prepare(`SELECT * FROM live_join_requests
    WHERE session_id = ? AND fan_id = ? AND status = 'pending'`)
    .get(sess.id, req.user.id);
  if (myPending) {
    const fee = stageJoinFee(!!myPending.is_explicit, myPending.mode || 'video',
      modelJoinRates(sess.model_id));
    db.prepare(`UPDATE live_join_requests SET status = 'declined' WHERE id = ?`).run(myPending.id);
    refundFan(req.user.id, sess.model_id, fee, 'live_join_refund',
      `🎥 Left stream — join request refunded`, clientIp(req));
    pushToUser(sess.model_id, { type: 'live:join-request-cancelled',
      session_id: sess.id, request_id: myPending.id });
  }
  pushToUser(sess.model_id, { type: 'live:viewer-left', session_id: sess.id, fan_id: req.user.id });
  res.json({ ok: true });
});

// Model (or admin) ends a session
// Model: get her live session details (for rejoining after disconnect)
app.get('/api/live/schedule', (req, res) => {
  const TZ = 'America/Chicago';
  const rows = db.prepare(`
    SELECT s.model_id, s.day_of_week, s.start_time, s.title,
           u.display_name AS model_name, m.photo_url
    FROM live_schedule s
    JOIN users u ON u.id = s.model_id
    JOIN models m ON m.user_id = u.id
    WHERE u.role = 'model' AND u.banned = 0 AND m.is_hidden = 0`).all();
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit',
    day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const p = Object.fromEntries(dtf.formatToParts(new Date()).map((x) => [x.type, x.value]));
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const chiWeekday = dayNames.indexOf(p.weekday);
  const zonedToUtc = (y, mo, d, h, mi) => {
    const guess = Date.UTC(y, mo - 1, d, h, mi);
    const pp = Object.fromEntries(dtf.formatToParts(new Date(guess)).map((x) => [x.type, x.value]));
    const asUtc = Date.UTC(+pp.year, +pp.month - 1, +pp.day, +pp.hour % 24, +pp.minute, +pp.second);
    return guess + (guess - asUtc);
  };
  const nowMs = Date.now();
  const upcoming = [];
  for (const r of rows) {
    const [hh, mm] = String(r.start_time).split(':').map((x) => parseInt(x, 10) || 0);
    for (let off = 0; off <= 7; off++) {
      if ((chiWeekday + off) % 7 !== r.day_of_week) continue;
      const base = new Date(Date.UTC(+p.year, +p.month - 1, +p.day + off));
      const starts = zonedToUtc(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), hh, mm);
      if (starts <= nowMs) continue;
      const h12 = ((hh + 11) % 12) + 1;
      upcoming.push({
        model_id: r.model_id, model_name: r.model_name, photo_url: r.photo_url || '',
        title: r.title || '', starts_at: starts,
        day_label: off === 0 ? 'Today' : off === 1 ? 'Tomorrow' : dayNames[r.day_of_week],
        time_label: `${h12}:${String(mm).padStart(2, '0')} ${hh >= 12 ? 'PM' : 'AM'}`,
      });
      break; // next occurrence only, per slot
    }
  }
  upcoming.sort((a, b) => a.starts_at - b.starts_at);
  const vRoleS = viewerRoleOf(req);
  let visUpcoming = upcoming;
  if (vRoleS !== 'model' && vRoleS !== 'admin') {
    const blockedS = blockedModelIds(geoOfReq(req));
    if (blockedS.size) visUpcoming = upcoming.filter((u) => !blockedS.has(u.model_id));
  }
  res.json({ upcoming: visUpcoming.slice(0, 20) });
});

app.get('/api/live/:id', identMiddleware, requireUser, (req, res) => {
  const sess = db.prepare(`SELECT ls.*, m.explicit_rate_cents FROM live_sessions ls
    LEFT JOIN models m ON m.user_id = ls.model_id WHERE ls.id = ?`).get(req.params.id);
  if (!sess) return res.status(404).json({ error: 'not_found' });
  if (req.user.role !== 'admin' && sess.model_id !== req.user.id)
    return res.status(403).json({ error: 'forbidden' });
  if (sess.status !== 'live') return res.status(410).json({ error: 'ended' });
  res.json({ session_id: sess.id, title: sess.title,
    explicit_rate_cents: sess.explicit_rate_cents, is_explicit: !!sess.is_explicit,
    brb: !!sess.brb });
});

// Admin: watch a live session as invisible moderator (not counted as viewer, no paywall)
app.post('/api/admin/live/:id/watch', ...adminOnly, (req, res) => {
  const sess = db.prepare(`SELECT * FROM live_sessions WHERE id = ? AND status = 'live'`)
    .get(req.params.id);
  if (!sess) return res.status(404).json({ error: 'not_live' });
  // Tell the model a moderator is watching (she opens a peer connection; not counted in live_viewers)
  pushToUser(sess.model_id, { type: 'live:viewer-joined', session_id: sess.id,
    fan_id: req.user.id, fan_name: '🛡️ Moderator', is_mod: true });
  const model = db.prepare('SELECT display_name FROM users WHERE id = ?').get(sess.model_id);
  res.json({ ok: true, session_id: sess.id, model_id: sess.model_id,
    model_name: model.display_name, title: sess.title || '',
    is_explicit: !!sess.is_explicit, brb: !!sess.brb, is_mod: true });
});

// Admin: leave a moderated watch (tell model to drop the peer connection)
app.post('/api/admin/live/:id/unwatch', ...adminOnly, (req, res) => {
  const sess = db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(req.params.id);
  if (sess) pushToUser(sess.model_id, { type: 'live:viewer-left', session_id: sess.id, fan_id: req.user.id });
  res.json({ ok: true });
});

app.post('/api/live/:id/end', identMiddleware, requireUser, (req, res) => {
  const sess = db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(req.params.id);
  if (!sess) return res.status(404).json({ error: 'not_found' });
  if (req.user.role !== 'admin' && sess.model_id !== req.user.id)
    return res.status(403).json({ error: 'forbidden' });
  db.prepare(`UPDATE live_sessions SET status = 'ended', ended_at = datetime('now') WHERE id = ?`)
    .run(sess.id);
  const viewers = db.prepare('SELECT fan_id FROM live_viewers WHERE session_id = ?').all(sess.id);
  for (const v of viewers) stopLivePayTimer(sess.id, v.fan_id);
  // Join-live cleanup: pending requests auto-declined + refunded; active stage dropped (no refund)
  for (const r of pendingStageReqs(sess.id)) {
    const fee = stageJoinFee(!!r.is_explicit, r.mode || 'video', modelJoinRates(sess.model_id));
    db.prepare(`UPDATE live_join_requests SET status = 'declined' WHERE id = ?`).run(r.id);
    refundFan(r.fan_id, sess.model_id, fee, 'live_join_refund',
      `🎥 Stream ended — join request refunded`, clientIp(req));
    pushToUser(r.fan_id, { type: 'live:join-declined', session_id: sess.id,
      request_id: r.id, refunded_cents: fee,
      balance_cents: getWallet(r.fan_id).credits_cents });
  }
  dropStageFan(sess.id, 'stream_ended');
  // Game Category: requests she never got to are refunded in full.
  refundPendingGameRequests(sess, clientIp(req));
  pushLiveViewers(sess.id, { type: 'live:ended', session_id: sess.id });
  pushToUser(sess.model_id, { type: 'live:ended', session_id: sess.id });
  res.json({ ok: true });
});

// Public: who's live right now
app.get('/api/live', (req, res) => {
  const rows = db.prepare(`
    SELECT ls.id AS session_id, ls.title, ls.explicit_rate_cents, ls.started_at, ls.brb,
           u.id AS model_id, u.display_name AS model_name, mo.photo_url AS model_photo_url,
           (SELECT COUNT(*) FROM live_viewers WHERE session_id = ls.id) AS viewers,
           (SELECT COALESCE(SUM(gross_cents),0) FROM gift_events WHERE session_id = ls.id) AS gift_cents
    FROM live_sessions ls JOIN users u ON u.id = ls.model_id
    LEFT JOIN models mo ON mo.user_id = u.id
    WHERE ls.status = 'live' AND u.banned = 0 AND COALESCE(mo.is_hidden, 0) = 0`).all();
  const vRole = viewerRoleOf(req);
  if (vRole !== 'model' && vRole !== 'admin') {
    const blocked = blockedModelIds(geoOfReq(req));
    if (blocked.size) return res.json({ live: rows.filter((r) => !blocked.has(r.model_id)) });
  }
  res.json({ live: rows });
});

// Fan joins as a free viewer (SFW preview)
app.post('/api/live/:id/join', identMiddleware, requireUser, requireRole('fan'), (req, res) => {
  const sess = db.prepare('SELECT * FROM live_sessions WHERE id = ? AND status = \'live\'')
    .get(req.params.id);
  if (!sess) return res.status(404).json({ error: 'not_live' });
  if (modelRegionBlocked(sess.model_id, geoOfReq(req))) return regionBlocked(res);
  db.prepare('INSERT OR IGNORE INTO live_viewers (session_id, fan_id) VALUES (?,?)')
    .run(sess.id, req.user.id);
  // Tell the model someone new is watching (she'll open a peer connection)
  pushToUser(sess.model_id, { type: 'live:viewer-joined', session_id: sess.id,
    fan_id: req.user.id, fan_name: req.user.display_name });
  const model = db.prepare('SELECT display_name FROM users WHERE id = ?').get(sess.model_id);
  const me = db.prepare('SELECT explicit_until, is_paying, explicit_paid FROM live_viewers WHERE session_id = ? AND fan_id = ?')
    .get(sess.id, req.user.id);
  const jr = modelJoinRates(sess.model_id);
  res.json({ ok: true, session_id: sess.id, model_id: sess.model_id,
    model_name: model.display_name, title: sess.title || '',
    explicit_rate_cents: sess.explicit_rate_cents, is_explicit: !!sess.is_explicit,
    brb: !!sess.brb,
    is_paying: !!(me && me.is_paying), explicit_until: me ? me.explicit_until : 0,
    explicit_paid: !!(me && me.explicit_paid),
    explicit_grace_sec: getGiftGraceSec(), explicit_entry_cents: getEntryCents(),
    explicit_join_cents: jr.explicit_join_cents,
    explicit_mic_join_cents: jr.explicit_mic_join_cents,
    join_cents: jr.join_cents,
    mic_join_cents: jr.mic_join_cents,
    priority: currentPriority(sess.id) });
});

// Fan starts paying the explicit per-minute rate (unblurs)
app.post('/api/live/:id/pay', identMiddleware, requireUser, requireRole('fan'), (req, res) => {
  const sess = db.prepare('SELECT * FROM live_sessions WHERE id = ? AND status = \'live\'')
    .get(req.params.id);
  if (!sess) return res.status(404).json({ error: 'not_live' });
  if (modelRegionBlocked(sess.model_id, geoOfReq(req))) return regionBlocked(res);
  // Shield: explicit unblur is an explicit-content purchase — a
  // shielded (unverified, regulated-state) fan cannot start it.
  if (shieldAppliesToIdent(req, req.ident)) return avRequired(res);
  const viewer = db.prepare('SELECT * FROM live_viewers WHERE session_id = ? AND fan_id = ?')
    .get(sess.id, req.user.id);
  if (!viewer) return res.status(403).json({ error: 'join_first' });
  if (getWallet(req.user.id).credits_cents < sess.explicit_rate_cents)
    return res.status(402).json({ error: 'insufficient_credits',
      needed_cents: sess.explicit_rate_cents,
      balance_cents: getWallet(req.user.id).credits_cents });
  db.prepare('UPDATE live_viewers SET is_paying = 1, explicit_paid = 1 WHERE session_id = ? AND fan_id = ?')
    .run(sess.id, req.user.id);
  db.prepare(`INSERT INTO blur_events (session_id, fan_id, event, detail)
              VALUES (?,?,'paid','explicit_unblur')`).run(sess.id, req.user.id);
  stopLivePayTimer(sess.id, req.user.id, false); // clear any stale timer (keep is_paying=1)
  livePayTimers.set(liveTimerKey(sess.id, req.user.id),
    setInterval(() => billLiveMinute(sess.id, req.user.id), 60 * 1000));
  res.json({ ok: true, rate_cents: sess.explicit_rate_cents,
    balance_cents: getWallet(req.user.id).credits_cents });
});

// STAGE 1 — Explicit entry fee: one-time per-viewer charge to unblur when she
// goes explicit. This is the gate; gifts are the upkeep (stage 2). Split via platform commission_pct.
app.post('/api/live/:id/explicit-entry', identMiddleware, requireUser, requireRole('fan'), (req, res) => {
  const sess = liveSessionOr404(req, res);
  if (!sess) return;
  if (modelRegionBlocked(sess.model_id, geoOfReq(req))) return regionBlocked(res);
  if (!sess.is_explicit) return res.status(400).json({ error: 'not_explicit' });
  // Shield: same rule as /pay — no explicit entry while unverified.
  if (shieldAppliesToIdent(req, req.ident)) return avRequired(res);
  const viewer = db.prepare('SELECT * FROM live_viewers WHERE session_id = ? AND fan_id = ?')
    .get(sess.id, req.user.id);
  if (!viewer) return res.status(403).json({ error: 'join_first' });
  if (viewer.explicit_paid) return res.status(409).json({ error: 'already_paid' });
  const entryCents = getEntryCents();
  try {
    chargeFan(req.user.id, sess.model_id, entryCents, 'live_explicit_entry',
      `Explicit entry on stream #${sess.id}`, clientIp(req));
    // Entry also starts the gift grace timer — upkeep begins immediately
    const explicitUntil = Date.now() + getGiftGraceSec() * 1000;
    db.prepare('UPDATE live_viewers SET explicit_paid = 1, explicit_until = ? WHERE session_id = ? AND fan_id = ?')
      .run(explicitUntil, sess.id, req.user.id);
    db.prepare(`INSERT INTO blur_events (session_id, fan_id, event, detail)
                VALUES (?,?,'paid','explicit_entry')`).run(sess.id, req.user.id);
    res.json({ ok: true, explicit_until: explicitUntil,
      explicit_grace_sec: getGiftGraceSec(),
      balance_cents: getWallet(req.user.id).credits_cents });
  } catch (e) {
    if (e.message === 'insufficient_credits' || e.message === 'spend_cap_reached')
      return res.status(402).json(chargeErrorBody(e, entryCents, req.user.id));
    throw e;
  }
});

// Fan stops paying (back to free blurred preview)
app.post('/api/live/:id/stop-pay', identMiddleware, requireUser, requireRole('fan'), (req, res) => {
  const sess = db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(req.params.id);
  if (!sess) return res.status(404).json({ error: 'not_found' });
  stopLivePayTimer(sess.id, req.user.id);
  res.json({ ok: true, balance_cents: getWallet(req.user.id).credits_cents });
});

// Model flips explicit mode manually (fallback when NSFWJS can't run)
app.post('/api/live/:id/mode', identMiddleware, requireUser, requireRole('model'), (req, res) => {
  const sess = db.prepare('SELECT * FROM live_sessions WHERE id = ? AND status = \'live\'')
    .get(req.params.id);
  if (!sess || sess.model_id !== req.user.id) return res.status(404).json({ error: 'not_found' });
  const isExplicit = req.body.is_explicit ? 1 : 0;
  db.prepare('UPDATE live_sessions SET is_explicit = ? WHERE id = ?').run(isExplicit, sess.id);
  if (isExplicit) {
    // Fresh explicit session — everyone must pay the entry fee again (entry is the gate).
    // Exception: active EXPLICIT stage fans already paid $25 covering viewing — keep them.
    db.prepare(`UPDATE live_viewers SET explicit_paid = 0, explicit_until = 0
      WHERE session_id = ? AND fan_id NOT IN
        (SELECT fan_id FROM live_join_requests
         WHERE session_id = ? AND status = 'approved' AND is_explicit = 1)`).run(sess.id, sess.id);
  } else {
    // Explicit over — everyone's gift grace expires immediately.
    // Exception: active EXPLICIT stage fans keep their coverage (they paid $25 for it).
    db.prepare(`UPDATE live_viewers SET explicit_paid = 0, explicit_until = 0
      WHERE session_id = ? AND fan_id NOT IN
        (SELECT fan_id FROM live_join_requests
         WHERE session_id = ? AND status = 'approved' AND is_explicit = 1)`).run(sess.id, sess.id);
  }
  db.prepare(`INSERT INTO blur_events (session_id, event, detail)
              VALUES (?,?,'manual_mode')`).run(sess.id, isExplicit ? 'explicit_on' : 'explicit_off');
  pushLiveViewers(sess.id, { type: 'live:explicit', session_id: sess.id, is_explicit: !!isExplicit,
    explicit_rate_cents: sess.explicit_rate_cents, explicit_grace_sec: getGiftGraceSec(),
    explicit_entry_cents: getEntryCents() });
  res.json({ ok: true, is_explicit: !!isExplicit });
});

// Model pauses her live ("be right back") — session stays open, viewers see
// the BRB card instead of her feed. Only she (or an admin) can toggle it.
app.post('/api/live/:id/brb', identMiddleware, requireUser, (req, res) => {
  const sess = db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(req.params.id);
  if (!sess) return res.status(404).json({ error: 'not_found' });
  if (req.user.role !== 'admin' && sess.model_id !== req.user.id)
    return res.status(403).json({ error: 'forbidden' });
  if (sess.status !== 'live') return res.status(410).json({ error: 'ended' });
  const brb = req.body.on ? 1 : 0;
  db.prepare('UPDATE live_sessions SET brb = ? WHERE id = ?').run(brb, sess.id);
  pushLiveAll(sess.id, { type: 'live:brb', session_id: sess.id, brb: !!brb });
  res.json({ ok: true, brb: !!brb });
});

/* ------------------------------------------------------------------ */
/* GAME CATEGORY — her priced request list on live. Fans buy from     */
/* three sections: regular (any time she's live), explicit (locked    */
/* until the session is explicit — server-enforced), special (rare;   */
/* she flips availability, a buy rests it again). Purchases splash    */
/* across both stages (game:request); she works a queue: start →      */
/* game:now countdown chip, done, or skip (full refund). Anything     */
/* still pending when the live ends auto-refunds in full.             */
/* ------------------------------------------------------------------ */

const GAME_PRESETS = [
  // [section, label, price_cents, duration_sec]
  ['regular', 'Twerk for 30 seconds', 1500, 30],
  ['regular', 'Blow a kiss + say my name', 500, null],
  ['regular', 'Spin & show my outfit', 500, null],
  ['regular', 'Dance to a song you pick', 1500, null],
  ['regular', 'Answer a personal question', 1000, null],
  ['regular', 'Show my feet', 1000, null],
  ['explicit', 'Flash', 2000, null],
  ['explicit', 'Strip one item off', 3500, null],
  ['explicit', 'Touch myself for 30 seconds', 4000, 30],
  ['explicit', 'Toy play for 30 seconds', 5000, 30],
  ['explicit', 'Sit on a toy for 10 seconds', 7500, 10],
  ['explicit', 'Rate my photo', 2500, null],
  ['special', 'Moan my name for 1 minute', 5000, 60],
  ['special', 'Pee on camera', 10000, null],
  ['special', 'Squirt', 10000, null],
  ['special', 'Finish on camera', 15000, null],
  ['special', 'Outfit change — you pick', 4000, null],
];

// First fetch with an empty list: the starter shelf is COPIED into her
// own rows so every preset is hers to edit, reprice, or delete.
function seedGamePresets(modelId) {
  const n = db.prepare('SELECT COUNT(*) AS c FROM game_items WHERE model_id = ?').get(modelId).c;
  if (n > 0) return;
  const ins = db.prepare(`INSERT INTO game_items
    (model_id, section, label, price_cents, duration_sec, active, special_ready, sort)
    VALUES (?,?,?,?,?,1,0,?)`);
  GAME_PRESETS.forEach((p, i) => ins.run(modelId, p[0], p[1], p[2], p[3], i));
}

const gameItemOut = (it) => ({
  id: it.id, section: it.section, label: it.label, price_cents: it.price_cents,
  duration_sec: it.duration_sec, active: !!it.active, special_ready: !!it.special_ready,
  sort: it.sort,
});

function validateGameItem(body) {
  const section = String(body.section || '');
  if (!['regular', 'explicit', 'special'].includes(section))
    return { error: 'bad_section' };
  const label = String(body.label || '').trim();
  if (label.length < 1 || label.length > 80) return { error: 'bad_label' };
  const matched = safetyScan(label);
  if (matched) return { error: 'label_not_allowed', matched };
  const price = parseInt(body.price_cents);
  if (!Number.isInteger(price) || price < 100 || price > 100000)
    return { error: 'bad_price' };
  let duration = null;
  if (body.duration_sec !== undefined && body.duration_sec !== null && body.duration_sec !== '' && body.duration_sec !== 0) {
    duration = parseInt(body.duration_sec);
    if (!Number.isInteger(duration) || duration < 5 || duration > 600)
      return { error: 'bad_duration' };
  }
  return { section, label, price_cents: price, duration_sec: duration };
}

/* ---- Model: her list (CRUD) ---- */

app.get('/api/game/items', identMiddleware, requireUser, requireRole('model'), (req, res) => {
  seedGamePresets(req.user.id);
  const items = db.prepare(
    'SELECT * FROM game_items WHERE model_id = ? ORDER BY section, sort, id').all(req.user.id);
  res.json({ items: items.map(gameItemOut) });
});

app.post('/api/game/items', identMiddleware, requireUser, requireRole('model'), (req, res) => {
  seedGamePresets(req.user.id);
  const v = validateGameItem(req.body || {});
  if (v.error) return res.status(400).json(v);
  const maxSort = db.prepare(
    'SELECT COALESCE(MAX(sort), -1) AS m FROM game_items WHERE model_id = ? AND section = ?')
    .get(req.user.id, v.section).m;
  const info = db.prepare(`INSERT INTO game_items
    (model_id, section, label, price_cents, duration_sec, active, special_ready, sort)
    VALUES (?,?,?,?,?,1,0,?)`)
    .run(req.user.id, v.section, v.label, v.price_cents, v.duration_sec, maxSort + 1);
  const item = db.prepare('SELECT * FROM game_items WHERE id = ?').get(Number(info.lastInsertRowid));
  res.json({ item: gameItemOut(item) });
});

app.put('/api/game/items/:id', identMiddleware, requireUser, requireRole('model'), (req, res) => {
  const item = db.prepare('SELECT * FROM game_items WHERE id = ? AND model_id = ?')
    .get(req.params.id, req.user.id);
  if (!item) return res.status(404).json({ error: 'not_found' });
  // Section is fixed at creation; the editor covers label/price/duration/active.
  const v = validateGameItem({ ...(req.body || {}), section: item.section });
  if (v.error) return res.status(400).json(v);
  const active = req.body.active === undefined ? item.active : (req.body.active ? 1 : 0);
  db.prepare(`UPDATE game_items SET label = ?, price_cents = ?, duration_sec = ?, active = ?
              WHERE id = ?`)
    .run(v.label, v.price_cents, v.duration_sec, active, item.id);
  res.json({ item: gameItemOut(db.prepare('SELECT * FROM game_items WHERE id = ?').get(item.id)) });
});

app.delete('/api/game/items/:id', identMiddleware, requireUser, requireRole('model'), (req, res) => {
  const item = db.prepare('SELECT * FROM game_items WHERE id = ? AND model_id = ?')
    .get(req.params.id, req.user.id);
  if (!item) return res.status(404).json({ error: 'not_found' });
  db.prepare('DELETE FROM game_items WHERE id = ?').run(item.id);
  res.json({ ok: true });
});

// Specials shelf: she decides when a rare item is available.
app.post('/api/game/items/:id/ready', identMiddleware, requireUser, requireRole('model'), (req, res) => {
  const item = db.prepare('SELECT * FROM game_items WHERE id = ? AND model_id = ?')
    .get(req.params.id, req.user.id);
  if (!item) return res.status(404).json({ error: 'not_found' });
  if (item.section !== 'special') return res.status(400).json({ error: 'not_special' });
  const ready = req.body.ready ? 1 : 0;
  db.prepare('UPDATE game_items SET special_ready = ? WHERE id = ?').run(ready, item.id);
  res.json({ ok: true, special_ready: !!ready });
});

/* ---- Live session wiring ---- */

// Model (or admin) flips the game on/off for her live.
app.post('/api/live/:id/game', identMiddleware, requireUser, (req, res) => {
  const sess = db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(req.params.id);
  if (!sess) return res.status(404).json({ error: 'not_found' });
  if (req.user.role !== 'admin' && sess.model_id !== req.user.id)
    return res.status(403).json({ error: 'forbidden' });
  if (sess.status !== 'live') return res.status(410).json({ error: 'ended' });
  const on = req.body.on ? 1 : 0;
  db.prepare('UPDATE live_sessions SET game_on = ? WHERE id = ?').run(on, sess.id);
  pushLiveAll(sess.id, { type: 'game:state', session_id: sess.id, game_on: !!on });
  res.json({ ok: true, game_on: !!on });
});

// Fan-facing menu for a live session (the model can read it too — it's
// exactly what her fans see, locks and all).
app.get('/api/live/:id/game-menu', identMiddleware, requireUser, (req, res) => {
  const sess = liveSessionOr404(req, res);
  if (!sess) return;
  if (!isLiveParticipant(sess, req.user)) return res.status(403).json({ error: 'join_first' });
  seedGamePresets(sess.model_id);
  const rows = db.prepare(
    'SELECT * FROM game_items WHERE model_id = ? AND active = 1 ORDER BY section, sort, id')
    .all(sess.model_id);
  const sections = { regular: [], explicit: [], special: [] };
  for (const it of rows) {
    sections[it.section].push({ id: it.id, label: it.label, price_cents: it.price_cents,
      duration_sec: it.duration_sec, special_ready: !!it.special_ready });
  }
  res.json({ game_on: !!sess.game_on, is_explicit: !!sess.is_explicit, sections });
});

// Fan buys a request. Gates in order: live → joined → game on → item
// active → explicit unlocked → special ready → balance (402 = top-up,
// the casino rule: the ONLY interruption money ever causes).
app.post('/api/live/:id/game-buy', identMiddleware, requireUser, requireRole('fan'), (req, res) => {
  const sess = liveSessionOr404(req, res);
  if (!sess) return;
  if (modelRegionBlocked(sess.model_id, geoOfReq(req))) return regionBlocked(res);
  const viewer = db.prepare('SELECT * FROM live_viewers WHERE session_id = ? AND fan_id = ?')
    .get(sess.id, req.user.id);
  if (!viewer) return res.status(403).json({ error: 'join_first' });
  if (!sess.game_on) return res.status(423).json({ error: 'game_off' });
  const item = db.prepare('SELECT * FROM game_items WHERE id = ? AND model_id = ? AND active = 1')
    .get(parseInt(req.body.item_id), sess.model_id);
  if (!item) return res.status(404).json({ error: 'item_not_found' });
  if (item.section === 'explicit' && !sess.is_explicit)
    return res.status(403).json({ error: 'explicit_locked' });
  if (item.section === 'special' && !item.special_ready)
    return res.status(409).json({ error: 'special_resting' });

  let charged;
  try {
    charged = chargeFan(req.user.id, sess.model_id, item.price_cents, 'game',
      `🎲 Game Category: ${item.label} on stream #${sess.id}`, clientIp(req));
  } catch (e) {
    if (e.message === 'insufficient_credits' || e.message === 'spend_cap_reached')
      return res.status(402).json(chargeErrorBody(e, item.price_cents, req.user.id));
    throw e;
  }
  const info = db.prepare(`INSERT INTO game_requests
    (session_id, model_id, fan_id, item_id, label, price_cents, status)
    VALUES (?,?,?,?,?,?, 'pending')`)
    .run(sess.id, sess.model_id, req.user.id, item.id, item.label, item.price_cents);
  const requestId = Number(info.lastInsertRowid);
  if (item.section === 'special')
    db.prepare('UPDATE game_items SET special_ready = 0 WHERE id = ?').run(item.id);
  const payload = { type: 'game:request', session_id: sess.id, request_id: requestId,
    fan_id: req.user.id, fan_name: req.user.display_name, label: item.label,
    price_cents: item.price_cents, duration_sec: item.duration_sec,
    section: item.section };
  pushLiveAll(sess.id, payload);
  pushToAdmins({ type: 'game:request_admin', session_id: sess.id, model_id: sess.model_id,
    fan_name: req.user.display_name, label: item.label, gross_cents: item.price_cents });
  res.json({ ok: true, request_id: requestId,
    balance_cents: getWallet(req.user.id).credits_cents });
});

// Her work queue for this session: what's current first, then pending
// in buy order, then what she already resolved.
app.get('/api/live/:id/game-queue', identMiddleware, requireUser, (req, res) => {
  const sess = db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(req.params.id);
  if (!sess) return res.status(404).json({ error: 'not_found' });
  if (req.user.role !== 'admin' && sess.model_id !== req.user.id)
    return res.status(403).json({ error: 'forbidden' });
  const rows = db.prepare(`
    SELECT gr.*, u.display_name AS fan_name FROM game_requests gr
    JOIN users u ON u.id = gr.fan_id
    WHERE gr.session_id = ?
    ORDER BY CASE gr.status WHEN 'current' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, gr.id`)
    .all(sess.id);
  res.json({ game_on: !!sess.game_on, requests: rows.map((r) => ({
    id: r.id, fan_id: r.fan_id, fan_name: r.fan_name, label: r.label,
    price_cents: r.price_cents, status: r.status,
    duration_sec: r.item_id
      ? (db.prepare('SELECT duration_sec FROM game_items WHERE id = ?').get(r.item_id) || {}).duration_sec ?? null
      : null,
    created_at: r.created_at, resolved_at: r.resolved_at })) });
});

// She works the queue: start (NOW chip everywhere) · done · skip (the
// fan is refunded in full — her prerogative, he's made whole).
app.post('/api/game/requests/:id/resolve', identMiddleware, requireUser, (req, res) => {
  const gr = db.prepare('SELECT * FROM game_requests WHERE id = ?').get(req.params.id);
  if (!gr) return res.status(404).json({ error: 'not_found' });
  if (req.user.role !== 'admin' && gr.model_id !== req.user.id)
    return res.status(403).json({ error: 'forbidden' });
  const action = String(req.body.action || '');
  if (!['start', 'done', 'skip'].includes(action))
    return res.status(400).json({ error: 'bad_action' });
  if (!['pending', 'current'].includes(gr.status))
    return res.status(409).json({ error: 'already_resolved', status: gr.status });

  if (action === 'start') {
    // One NOW at a time: a previously started request steps back to pending.
    db.prepare(`UPDATE game_requests SET status = 'pending'
                WHERE session_id = ? AND status = 'current' AND id != ?`).run(gr.session_id, gr.id);
    db.prepare(`UPDATE game_requests SET status = 'current' WHERE id = ?`).run(gr.id);
    const item = gr.item_id
      ? db.prepare('SELECT duration_sec FROM game_items WHERE id = ?').get(gr.item_id) : null;
    const fan = db.prepare('SELECT display_name FROM users WHERE id = ?').get(gr.fan_id);
    pushLiveAll(gr.session_id, { type: 'game:now', session_id: gr.session_id,
      request_id: gr.id, label: gr.label, fan_name: fan ? fan.display_name : '',
      duration_sec: item ? item.duration_sec : null });
    return res.json({ ok: true, status: 'current' });
  }
  if (action === 'done') {
    db.prepare(`UPDATE game_requests SET status = 'done', resolved_at = datetime('now')
                WHERE id = ?`).run(gr.id);
    pushLiveAll(gr.session_id, { type: 'game:update', session_id: gr.session_id,
      request_id: gr.id, status: 'done' });
    return res.json({ ok: true, status: 'done' });
  }
  // skip → full refund through the standard reversal path
  refundFan(gr.fan_id, gr.model_id, gr.price_cents, 'game_refund',
    `🎲 Game Category skipped by model — refunded: ${gr.label}`, clientIp(req));
  db.prepare(`UPDATE game_requests SET status = 'skipped', resolved_at = datetime('now')
              WHERE id = ?`).run(gr.id);
  pushLiveAll(gr.session_id, { type: 'game:update', session_id: gr.session_id,
    request_id: gr.id, status: 'skipped' });
  pushToUser(gr.fan_id, { type: 'game:refunded', session_id: gr.session_id,
    request_id: gr.id, label: gr.label, refunded_cents: gr.price_cents,
    balance_cents: getWallet(gr.fan_id).credits_cents });
  res.json({ ok: true, status: 'skipped', refunded_cents: gr.price_cents });
});

// Live ended (or was killed) with requests still open: every fan is
// refunded in full, automatically. Called from the end paths.
function refundPendingGameRequests(sess, ip) {
  const open = db.prepare(`SELECT * FROM game_requests
    WHERE session_id = ? AND status IN ('pending','current')`).all(sess.id);
  for (const gr of open) {
    refundFan(gr.fan_id, sess.model_id, gr.price_cents, 'game_refund',
      `🎲 Game Category — stream ended before: ${gr.label}`, ip || null);
    db.prepare(`UPDATE game_requests SET status = 'refunded', resolved_at = datetime('now')
                WHERE id = ?`).run(gr.id);
    pushToUser(gr.fan_id, { type: 'game:refunded', session_id: sess.id,
      request_id: gr.id, label: gr.label, refunded_cents: gr.price_cents,
      balance_cents: getWallet(gr.fan_id).credits_cents });
  }
  return open.length;
}

// Fan client reports an AI blur/pay event (server logs it for the admin)
app.post('/api/live/:id/blur-event', identMiddleware, requireUser, requireRole('fan'), (req, res) => {
  const sess = db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(req.params.id);
  if (!sess) return res.status(404).json({ error: 'not_found' });
  const event = String(req.body.event || '').slice(0, 40);
  if (!['auto_blur', 'timeout_kick', 'paywall_shown'].includes(event))
    return res.status(400).json({ error: 'bad_event' });
  db.prepare(`INSERT INTO blur_events (session_id, fan_id, event, detail)
              VALUES (?,?,?,?)`).run(sess.id, req.user.id, event,
    String(req.body.detail || '').slice(0, 200));
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* GROUP LIVE: free stream chat + virtual gifts + leaderboard           */
/* ------------------------------------------------------------------ */

function liveSessionOr404(req, res) {
  const sess = db.prepare('SELECT * FROM live_sessions WHERE id = ? AND status = \'live\'')
    .get(req.params.id);
  if (!sess) { res.status(404).json({ error: 'not_live' }); return null; }
  return sess;
}

function isLiveParticipant(sess, user) {
  if (user.role === 'admin') return true;
  if (sess.model_id === user.id) return true;
  return !!db.prepare('SELECT 1 FROM live_viewers WHERE session_id = ? AND fan_id = ?')
    .get(sess.id, user.id);
}

// GET recent group stream chat (last 50)
app.get('/api/live/:id/chat', identMiddleware, requireUser, (req, res) => {
  const sess = liveSessionOr404(req, res);
  if (!sess) return;
  if (!isLiveParticipant(sess, req.user)) return res.status(403).json({ error: 'join_first' });
  const msgs = db.prepare(`
    SELECT sc.*, u.display_name AS sender_name, u.role AS sender_role
    FROM stream_chat sc JOIN users u ON u.id = sc.sender_id
    WHERE sc.session_id = ? AND sc.is_flagged = 0
    ORDER BY sc.id DESC LIMIT 50`).all(sess.id);
  res.json({ messages: msgs.reverse() });
});

// Force-end a live session (safety kill — payment info shared on live)
function killLiveSession(sess, reason) {
  db.prepare(`UPDATE live_sessions SET status = 'ended', ended_at = datetime('now') WHERE id = ?`)
    .run(sess.id);
  const viewers = db.prepare('SELECT fan_id FROM live_viewers WHERE session_id = ?').all(sess.id);
  for (const v of viewers) stopLivePayTimer(sess.id, v.fan_id);
  for (const r of pendingStageReqs(sess.id)) {
    const fee = stageJoinFee(!!r.is_explicit, r.mode || 'video', modelJoinRates(sess.model_id));
    db.prepare(`UPDATE live_join_requests SET status = 'declined' WHERE id = ?`).run(r.id);
    refundFan(r.fan_id, sess.model_id, fee, 'live_join_refund',
      `🎥 Stream ended — join request refunded`, 'safety-kill');
    pushToUser(r.fan_id, { type: 'live:join-declined', session_id: sess.id,
      request_id: r.id, refunded_cents: fee,
      balance_cents: getWallet(r.fan_id).credits_cents });
  }
  dropStageFan(sess.id, 'stream_ended');
  refundPendingGameRequests(sess, 'safety-kill');
  pushLiveViewers(sess.id, { type: 'live:ended', session_id: sess.id, reason });
  pushToUser(sess.model_id, { type: 'live:ended', session_id: sess.id, reason });
}

// POST a group stream chat message — FREE, safety-scanned
app.post('/api/live/:id/chat', identMiddleware, requireUser, (req, res) => {
  const sess = liveSessionOr404(req, res);
  if (!sess) return;
  if (!isLiveParticipant(sess, req.user)) return res.status(403).json({ error: 'join_first' });
  const body = String(req.body.body || '').trim().slice(0, 500);
  if (!body) return res.status(400).json({ error: 'empty_message' });

  const matched = safetyScan(body);
  if (matched) {
    // Payment info on live = kill the stream immediately (protects models + platform)
    if (matched.startsWith('payment_')) {
      const key = `u:${req.user.id}`;
      const total = addStrike(key);
      db.prepare(`INSERT INTO stream_flags (session_id, sender_id, sender_name, flagged_text, matched)
                  VALUES (?,?,?,?,?)`)
        .run(sess.id, req.user.id, req.user.display_name, body.slice(0, 300), matched);
      pushToAdmins({ type: 'safety:stream_killed', session_id: sess.id,
        sender_name: req.user.display_name, matched, total_strikes: total,
        exact_words: body.slice(0, 300) });
      killLiveSession(sess, 'payment_info_shared');
      pushToUser(req.user.id, { type: 'live:killed',
        warning: `🛑 Stream ended — payment info is never allowed on live. (${total}/3 strikes)` });
      return res.status(423).json({ error: 'stream_killed', matched, strikes: total });
    }
    // Block the message, count a strike, log the flag — chat stays live for everyone else
    const key = `u:${req.user.id}`;
    const total = addStrike(key);
    db.prepare(`INSERT INTO stream_flags (session_id, sender_id, sender_name, flagged_text, matched)
                VALUES (?,?,?,?,?)`)
      .run(sess.id, req.user.id, req.user.display_name, body.slice(0, 300), matched);
    pushToAdmins({ type: 'safety:stream_flag', session_id: sess.id,
      sender_name: req.user.display_name, matched, total_strikes: total });
    pushToUser(req.user.id, { type: 'live:chat_blocked', session_id: sess.id,
      warning: `⚠️ Message blocked — "${matched}" is not allowed. (${total}/3 strikes)` });
    return res.status(423).json({ error: 'blocked', matched, strikes: total });
  }

  const info = db.prepare(
    'INSERT INTO stream_chat (session_id, sender_id, body) VALUES (?,?,?)')
    .run(sess.id, req.user.id, body);
  const msg = { id: Number(info.lastInsertRowid), session_id: sess.id,
    sender_id: req.user.id, sender_name: req.user.display_name,
    sender_role: req.user.role, body, created_at: new Date().toISOString() };
  pushLiveAll(sess.id, { type: 'live:chat', message: msg });
  res.json({ ok: true, message: msg });
});

// POST speech transcript from the model's safety bot — scanned same as chat
app.post('/api/live/:id/speech', identMiddleware, requireUser, (req, res) => {
  const sess = liveSessionOr404(req, res);
  if (!sess) return;
  // Only the broadcasting model can report her own speech
  if (sess.model_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });
  const text = String(req.body.text || '').trim().slice(0, 500);
  if (!text) return res.status(400).json({ error: 'empty' });
  const result = handleSpeechTranscript(sess, req.user, text, 'browser');
  if (!result) return res.json({ ok: true, clean: true });
  res.json({ ok: true, action: result.action, matched: result.matched, strikes: result.strikes });
});

// Audio chunk upload for the safety bot — temp storage, transcribed, deleted
const CHUNK_EXT_BY_MIME = {
  'audio/webm': '.webm', 'audio/mp4': '.mp4', 'audio/x-m4a': '.m4a',
  'audio/m4a': '.m4a', 'audio/ogg': '.ogg', 'audio/wav': '.wav',
  'audio/x-wav': '.wav', 'audio/mpeg': '.mp3',
};
const audioChunkUpload = multer({
  storage: multer.diskStorage({
    destination: '/tmp',
    filename: (req, file, cb) => {
      // Keep the real container extension — Whisper reads format from it,
      // and iPhone Safari records mp4, not webm.
      const fromName = (String(file.originalname || '').match(/\.(webm|mp4|m4a|ogg|wav|mp3)$/i) || [])[0];
      const ext = fromName ? '.' + fromName.slice(1).toLowerCase()
        : (CHUNK_EXT_BY_MIME[file.mimetype] || '.webm');
      cb(null, 'safetychunk-' + crypto.randomBytes(8).toString('hex') + ext);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 }, // 10s clips are tiny
  fileFilter: (req, file, cb) => {
    const ok = /^audio\//.test(file.mimetype);
    cb(ok ? null : new Error('bad_file_type'), ok);
  },
});

// POST 10s audio chunk from model's mic — Whisper transcribes, safety-scanned
app.post('/api/live/:id/audio-chunk', identMiddleware, requireUser,
  audioChunkUpload.single('audio'), (req, res) => {
  const sess = liveSessionOr404(req, res);
  if (!sess) { if (req.file) fs.unlink(req.file.path, () => {}); return; }
  if (sess.model_id !== req.user.id || !req.file) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(403).json({ error: 'forbidden' });
  }
  const chunkPath = req.file.path;
  const chunkUser = req.user;
  // Transcribe async so we don't block the response; outcomes reach the
  // model and admins over WebSocket (live:killed / live:speech_warning /
  // safety:* pushes inside handleSpeechTranscript).
  transcribeAudio(chunkPath)
    .then((raw) => {
      const text = String(raw || '').trim().slice(0, 500);
      if (text) handleSpeechTranscript(sess, chunkUser, text, 'whisper');
    })
    .catch((e) => console.error('[safety-bot] transcription failed:', e.message))
    .finally(() => fs.unlink(chunkPath, () => {})); // always delete the audio
  res.json({ ok: true, queued: true });
});

// Shared handler: scan a speech transcript, kill on payment, warn on info/socials
// Returns { action, matched, strikes } or null if clean / session ended.
function handleSpeechTranscript(sess, user, text, source) {
  const matched = safetyScan(text);
  if (!matched) return null;
  // Re-check the session is still live (may have ended while transcribing)
  const live = db.prepare("SELECT * FROM live_sessions WHERE id = ? AND status = 'live'").get(sess.id);
  if (!live) return null;
  const key = `u:${user.id}`;
  const total = addStrike(key);
  db.prepare(`INSERT INTO stream_flags (session_id, sender_id, sender_name, flagged_text, matched)
              VALUES (?,?,?,?,?)`)
    .run(sess.id, user.id, user.display_name, `[SPEECH:${source}] ` + text.slice(0, 270), matched);
  if (matched.startsWith('payment_')) {
    pushToAdmins({ type: 'safety:stream_killed', session_id: sess.id,
      sender_name: user.display_name, matched, total_strikes: total,
      exact_words: '[SPOKEN] ' + text.slice(0, 300) });
    killLiveSession(live, 'payment_info_spoken');
    pushToUser(user.id, { type: 'live:killed',
      warning: `🛑 Stream ended — payment info is never allowed on live, spoken or typed. (${total}/3 strikes)` });
    return { action: 'killed', matched, strikes: total };
  }
  pushToAdmins({ type: 'safety:speech_flag', session_id: sess.id,
    sender_name: user.display_name, matched, total_strikes: total,
    exact_words: text.slice(0, 300) });
  pushToUser(user.id, { type: 'live:speech_warning', session_id: sess.id,
    warning: `⚠️ Careful — "${matched}" detected in your speech. Keep personal info and socials off the stream. (${total}/3 strikes)` });
  return { action: 'warned', matched, strikes: total };
}

// GET the virtual gift catalog (public, enabled only)
app.get('/api/gifts', (req, res) => {
  res.json({ gifts: db.prepare(
    'SELECT id, emoji, name, price_cents FROM gifts WHERE enabled = 1 ORDER BY price_cents, sort_order'
  ).all() });
});

// Core: fan sends a virtual gift on a live stream. Charges via splitPayment
// (model 60%, platform/recruiter split), logs gift_events, refreshes the viewer's
// explicit grace timer, and broadcasts to all viewers + the model + admins.
function sendLiveGift(sess, fanId, gift, ip = null) {
  const { modelCents, platformCents } = chargeFan(
    fanId, sess.model_id, gift.price_cents, 'gift',
    `${gift.emoji} ${gift.name} on stream #${sess.id}`, ip);
  db.prepare(`INSERT INTO gift_events
    (session_id, fan_id, gift_id, gross_cents, model_cents, platform_cents)
    VALUES (?,?,?,?,?,?)`)
    .run(sess.id, fanId, gift.id, gift.price_cents, modelCents, platformCents);

  // Pay-to-play loop: ANY gift keeps this viewer's screen unblurred for the
  // grace period. Per-viewer — one fan's gifts never affect another fan.
  // (Set unconditionally; the client only honors it while the stream is explicit,
  // which also covers client-side AI-detected explicit.)
  const explicitUntil = Date.now() + getGiftGraceSec() * 1000;
  db.prepare('UPDATE live_viewers SET explicit_until = ? WHERE session_id = ? AND fan_id = ?')
    .run(explicitUntil, sess.id, fanId);
  db.prepare(`INSERT INTO blur_events (session_id, fan_id, event, detail)
              VALUES (?,?,'gift_unblur','explicit_grace')`).run(sess.id, fanId);

  const fanName = db.prepare('SELECT display_name FROM users WHERE id = ?').get(fanId).display_name;
  const payload = { type: 'live:gift', session_id: sess.id,
    gift: { emoji: gift.emoji, name: gift.name, price_cents: gift.price_cents },
    fan_id: fanId, fan_name: fanName,
    balance_cents: getWallet(fanId).credits_cents };
  pushLiveAll(sess.id, payload);
  pushToAdmins({ type: 'live:gift_admin', session_id: sess.id,
    model_id: sess.model_id, fan_name: fanName,
    gift: gift.emoji + ' ' + gift.name, gross_cents: gift.price_cents });
  return { explicitUntil, balanceCents: getWallet(fanId).credits_cents };
}

// POST send a virtual gift during a group stream
app.post('/api/live/:id/gift', identMiddleware, requireUser, requireRole('fan'), (req, res) => {
  const sess = liveSessionOr404(req, res);
  if (!sess) return;
  if (modelRegionBlocked(sess.model_id, geoOfReq(req))) return regionBlocked(res);
  const viewer = db.prepare('SELECT * FROM live_viewers WHERE session_id = ? AND fan_id = ?')
    .get(sess.id, req.user.id);
  if (!viewer) return res.status(403).json({ error: 'join_first' });
  const gift = db.prepare('SELECT * FROM gifts WHERE id = ? AND enabled = 1').get(req.body.gift_id);
  if (!gift) return res.status(404).json({ error: 'gift_not_found' });

  try {
    const { explicitUntil, balanceCents } = sendLiveGift(sess, req.user.id, gift, clientIp(req));
    db.prepare(`INSERT INTO gift_sends (fan_id, model_id, gift_id, price_cents, context, session_id)
      VALUES (?,?,?,?, 'live', ?)`)
      .run(req.user.id, sess.model_id, gift.id, gift.price_cents, sess.id);
    res.json({ ok: true, balance_cents: balanceCents,
      explicit_until: explicitUntil, explicit_grace_sec: getGiftGraceSec() });
  } catch (e) {
    if (e.message === 'insufficient_credits' || e.message === 'spend_cap_reached')
      return res.status(402).json(chargeErrorBody(e, gift.price_cents, req.user.id));
    throw e;
  }
});

// POST /api/gifts/send — unified TikTok-style gift endpoint.
// { model_id, gift_id, context: 'chat'|'live', conversation_id?, session_id? }
// Chat: drops a gift message in the conversation. Live: sends on the stream.
app.post('/api/gifts/send', identMiddleware, requireUser, requireRole('fan'), (req, res) => {
  const gift = db.prepare('SELECT * FROM gifts WHERE id = ? AND enabled = 1').get(req.body.gift_id);
  if (!gift) return res.status(404).json({ error: 'gift_not_found' });
  const modelId = parseInt(req.body.model_id);
  const model = db.prepare('SELECT * FROM users WHERE id = ? AND role = ?').get(modelId, 'model');
  if (!model) return res.status(404).json({ error: 'model_not_found' });
  if (modelRegionBlocked(modelId, geoOfReq(req))) return regionBlocked(res);
  const context = req.body.context === 'live' ? 'live' : 'chat';

  if (context === 'live') {
    const sess = db.prepare('SELECT * FROM live_sessions WHERE id = ? AND status = ?')
      .get(req.body.session_id, 'live');
    if (!sess || sess.model_id !== modelId)
      return res.status(404).json({ error: 'stream_not_found' });
    const viewer = db.prepare('SELECT * FROM live_viewers WHERE session_id = ? AND fan_id = ?')
      .get(sess.id, req.user.id);
    if (!viewer) return res.status(403).json({ error: 'join_first' });
    try {
      const { explicitUntil, balanceCents } = sendLiveGift(sess, req.user.id, gift, clientIp(req));
      db.prepare(`INSERT INTO gift_sends (fan_id, model_id, gift_id, price_cents, context, session_id)
        VALUES (?,?,?,?, 'live', ?)`)
        .run(req.user.id, modelId, gift.id, gift.price_cents, sess.id);
      res.json({ ok: true, context: 'live', balance_cents: balanceCents,
        explicit_until: explicitUntil, explicit_grace_sec: getGiftGraceSec() });
    } catch (e) {
      if (e.message === 'insufficient_credits' || e.message === 'spend_cap_reached')
        return res.status(402).json(chargeErrorBody(e, gift.price_cents, req.user.id));
      throw e;
    }
    return;
  }

  // context === 'chat'
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.body.conversation_id);
  if (!conv || conv.fan_id !== req.user.id || conv.model_id !== modelId)
    return res.status(404).json({ error: 'not_found' });

  try {
    chargeFan(req.user.id, modelId, gift.price_cents, 'gift',
      `🎁 ${gift.emoji} ${gift.name} in chat`, clientIp(req));
  } catch (e) {
    if (e.message === 'insufficient_credits' || e.message === 'spend_cap_reached')
      return res.status(402).json(chargeErrorBody(e, gift.price_cents, req.user.id));
    throw e;
  }
  db.prepare(`INSERT INTO gift_sends (fan_id, model_id, gift_id, price_cents, context, conversation_id)
    VALUES (?,?,?,?, 'chat', ?)`)
    .run(req.user.id, modelId, gift.id, gift.price_cents, conv.id);

  // Drop a gift message in the chat so both sides see the animation + history
  const giftPayload = { emoji: gift.emoji, name: gift.name, price_cents: gift.price_cents };
  const msgId = db.prepare(
    `INSERT INTO messages (conversation_id, sender_id, body, gift_json) VALUES (?,?,?,?)`
  ).run(conv.id, req.user.id, '🎁 sent a gift', JSON.stringify(giftPayload)).lastInsertRowid;
  db.prepare(`UPDATE conversations SET updated_at = datetime('now') WHERE id = ?`).run(conv.id);
  const msg = db.prepare(`
    SELECT m.*, u.display_name AS sender_name, u.role AS sender_role
    FROM messages m LEFT JOIN users u ON u.id = m.sender_id WHERE m.id = ?`).get(msgId);
  const full = { ...msg, sender_name: msg.sender_name, sender_role: msg.sender_role,
    gift: giftPayload };
  pushToSubject(`u:${conv.model_id}`, { type: 'chat:new', conversation_id: conv.id, message: full });
  pushToSubject(`u:${req.user.id}`, { type: 'chat:new', conversation_id: conv.id, message: full });

  res.json({ ok: true, context: 'chat', gift: giftPayload,
    fan_name: req.user.display_name,
    balance_cents: getWallet(req.user.id).credits_cents });
});

/* ---------------- PRIORITY MESSAGES (paid banner + TTS on group streams) ---------------- */

// Pricing tiers: more spend = longer on screen, max 30s
const PRIORITY_TIERS = [
  { price_cents: 200,  duration_sec: 5 },
  { price_cents: 500,  duration_sec: 10 },
  { price_cents: 1000, duration_sec: 15 },
  { price_cents: 2000, duration_sec: 20 },
  { price_cents: 3000, duration_sec: 30 },
];

// Paid add-on: speak the priority message out loud via TTS (cents)
const VOICE_FEE_CENTS = 300;

// Fan "join live": flat fee to request on-camera stage time (cents). Split via platform commission_pct.
// Model approves each request; decline = full refund. One fan on stage at a time.
const JOIN_FEE_CENTS = 1000;
// Explicit join: if the stream is explicit when the fan requests, the fee is higher.
// The explicit stage fee COVERS viewing — no separate explicit entry fee needed.
const EXPLICIT_JOIN_FEE_CENTS = 2500;
// Mic-only join: audio only, no camera. Cheaper than video (regular / explicit tiers).
const MIC_JOIN_FEE_CENTS = 500;
const EXPLICIT_MIC_JOIN_FEE_CENTS = 1500;
// Stage time limit: approved fan auto-kicked after this many minutes (no refund).
const STAGE_MINUTES = 3;

// Stage join price by explicit tier and mode ('video' | 'mic').
// Regular (non-explicit) prices are fixed platform-wide; explicit tiers come
// from the MODEL's own rates (she sets them in Settings).
function modelJoinRates(modelId) {
  const m = db.prepare(`SELECT explicit_join_cents, explicit_mic_join_cents,
                               join_cents, mic_join_cents FROM models WHERE user_id = ?`)
    .get(modelId);
  const pick = (v, dflt) => (m && Number.isInteger(v)) ? v : dflt;
  return {
    explicit_join_cents: pick(m && m.explicit_join_cents, 2500),
    explicit_mic_join_cents: pick(m && m.explicit_mic_join_cents, 1500),
    join_cents: pick(m && m.join_cents, JOIN_FEE_CENTS),
    mic_join_cents: pick(m && m.mic_join_cents, MIC_JOIN_FEE_CENTS),
  };
}
function stageJoinFee(isExplicit, mode, rates) {
  // All stage joins are model-priced ($5–$1,000, set in her Settings);
  // platform constants remain only as fallbacks when rates are unavailable.
  const r = rates || { explicit_join_cents: EXPLICIT_JOIN_FEE_CENTS,
                       explicit_mic_join_cents: EXPLICIT_MIC_JOIN_FEE_CENTS,
                       join_cents: JOIN_FEE_CENTS, mic_join_cents: MIC_JOIN_FEE_CENTS };
  if (isExplicit) return mode === 'mic' ? r.explicit_mic_join_cents : r.explicit_join_cents;
  return mode === 'mic' ? r.mic_join_cents : r.join_cents;
}

function priorityJSON(pm) {
  return { id: pm.id, fan_id: pm.fan_id, fan_name: pm.fan_name, message: pm.message,
           amount_cents: pm.amount_cents, duration_sec: pm.duration_sec,
           voice: !!pm.voice, ends_at: pm.ends_at };
}

// Returns the currently-showing priority message, advancing the FIFO queue as needed.
// Broadcasts live:priority over WS whenever a new message starts showing.
function currentPriority(sessionId) {
  const now = Date.now();
  let showing = db.prepare(
    `SELECT * FROM priority_messages WHERE session_id = ? AND status = 'showing' ORDER BY id LIMIT 1`)
    .get(sessionId);
  if (showing && showing.ends_at <= now) {
    db.prepare(`UPDATE priority_messages SET status = 'done' WHERE id = ?`).run(showing.id);
    showing = null;
  }
  if (!showing) {
    const next = db.prepare(
      `SELECT * FROM priority_messages WHERE session_id = ? AND status = 'queued' ORDER BY id LIMIT 1`)
      .get(sessionId);
    if (next) {
      const endsAt = Date.now() + next.duration_sec * 1000;
      db.prepare(`UPDATE priority_messages SET status = 'showing', ends_at = ? WHERE id = ?`)
        .run(endsAt, next.id);
      showing = { ...next, status: 'showing', ends_at: endsAt };
      pushLiveAll(sessionId, { type: 'live:priority', session_id: sessionId,
        priority: priorityJSON(showing) });
    }
  }
  return showing ? priorityJSON(showing) : null;
}

// POST send a priority message during a group stream (fan pays per tier)
app.post('/api/live/:id/priority', identMiddleware, requireUser, requireRole('fan'), (req, res) => {
  const sess = liveSessionOr404(req, res);
  if (!sess) return;
  const viewer = db.prepare('SELECT * FROM live_viewers WHERE session_id = ? AND fan_id = ?')
    .get(sess.id, req.user.id);
  if (!viewer) return res.status(403).json({ error: 'join_first' });
  const tier = PRIORITY_TIERS[req.body.tier_index];
  if (!tier) return res.status(400).json({ error: 'bad_tier' });
  const message = String(req.body.message || '').trim().slice(0, 120);
  if (!message) return res.status(400).json({ error: 'empty_message' });
  const wantVoice = req.body.voice === true || req.body.voice === 1;
  const totalCents = tier.price_cents + (wantVoice ? VOICE_FEE_CENTS : 0);

  // SAFETY FIRST — scan BEFORE charging. Blocked = 423 + strike, no charge.
  const matched = safetyScan(message);
  if (matched) {
    const key = `u:${req.user.id}`;
    const total = addStrike(key);
    db.prepare(`INSERT INTO stream_flags (session_id, sender_id, sender_name, flagged_text, matched)
                VALUES (?,?,?,?,?)`)
      .run(sess.id, req.user.id, req.user.display_name, message.slice(0, 300), matched);
    pushToAdmins({ type: 'safety:stream_flag', session_id: sess.id,
      sender_name: req.user.display_name, matched, total_strikes: total });
    pushToUser(req.user.id, { type: 'live:chat_blocked', session_id: sess.id,
      warning: `⚠️ Priority message blocked — "${matched}" is not allowed. (${total}/3 strikes)` });
    return res.status(423).json({ error: 'blocked', matched, strikes: total });
  }

  try {
    const { modelCents, platformCents } = chargeFan(
      req.user.id, sess.model_id, totalCents, 'priority',
      `📢 Priority message (${tier.duration_sec}s${wantVoice ? ' + voice' : ''}) on stream #${sess.id}`, clientIp(req));
    const info = db.prepare(`INSERT INTO priority_messages
      (session_id, fan_id, fan_name, message, amount_cents, duration_sec, voice, status)
      VALUES (?,?,?,?,?,?,?, 'queued')`)
      .run(sess.id, req.user.id, req.user.display_name, message,
           totalCents, tier.duration_sec, wantVoice ? 1 : 0);
    const mineId = Number(info.lastInsertRowid);
    // Promote immediately if nothing is showing (broadcasts live:priority)
    const current = currentPriority(sess.id);
    const showingNow = !!(current && current.id === mineId);
    // Queue position: 1 = showing now, otherwise count of active messages ahead + 1
    const ahead = db.prepare(
      `SELECT COUNT(*) AS n FROM priority_messages
       WHERE session_id = ? AND status IN ('queued','showing') AND id < ?`)
      .get(sess.id, mineId).n;
    pushToAdmins({ type: 'live:priority_admin', session_id: sess.id,
      model_id: sess.model_id, fan_name: req.user.display_name,
      amount_cents: totalCents, duration_sec: tier.duration_sec, voice: wantVoice });
    res.json({ ok: true, duration_sec: tier.duration_sec, voice: wantVoice,
      balance_cents: getWallet(req.user.id).credits_cents,
      showing_now: showingNow, position_in_queue: showingNow ? 1 : ahead + 1 });
  } catch (e) {
    if (e.message === 'insufficient_credits' || e.message === 'spend_cap_reached')
      return res.status(402).json(chargeErrorBody(e, totalCents, req.user.id));
    throw e;
  }
});

// GET current priority message state (advances the queue; client polls when its banner expires)
app.get('/api/live/:id/priority', identMiddleware, requireUser, (req, res) => {
  const sess = db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(req.params.id);
  if (!sess) return res.status(404).json({ error: 'not_found' });
  if (!isLiveParticipant(sess, req.user)) return res.status(403).json({ error: 'join_first' });
  res.json({ priority: currentPriority(sess.id) });
});

/* ---------------- FAN JOIN LIVE (pay to request, model approves) ----------------
   Fan pays to request stage time: VIDEO ($10/$25) or MIC-ONLY audio ($5/$15).
   Model approves each request; decline = full refund. One fan on stage at a time;
   stage time is capped at STAGE_MINUTES (auto-drop, no refund). Fan media goes
   to the MODEL only (peer-to-peer); other viewers see a stage indicator in chat. */

function stageJSON(r) {
  if (!r) return null;
  return { id: r.id, fan_id: r.fan_id, fan_name: r.fan_name, status: r.status,
           is_explicit: !!r.is_explicit, mode: r.mode || 'video',
           stage_ends_at: r.stage_started_at
             ? r.stage_started_at + STAGE_MINUTES * 60 * 1000 : 0 };
}

function activeStageReq(sessionId) {
  return db.prepare(`SELECT r.*, u.display_name AS fan_name FROM live_join_requests r
    JOIN users u ON u.id = r.fan_id
    WHERE r.session_id = ? AND r.status = 'approved' ORDER BY r.id DESC LIMIT 1`)
    .get(sessionId);
}

function pendingStageReqs(sessionId) {
  return db.prepare(`SELECT r.*, u.display_name AS fan_name FROM live_join_requests r
    JOIN users u ON u.id = r.fan_id
    WHERE r.session_id = ? AND r.status = 'pending' ORDER BY r.id`)
    .all(sessionId);
}

// Drop the active stage fan (model taps Drop, or stage timer expires — same path, no refund)
function dropStageFan(sessionId, reason) {
  const active = activeStageReq(sessionId);
  if (!active) return null;
  db.prepare(`UPDATE live_join_requests SET status = 'dropped' WHERE id = ?`).run(active.id);
  pushToUser(active.fan_id, { type: 'live:stage-ended', session_id: sessionId,
    request_id: active.id, reason: reason || 'dropped' });
  pushLiveAll(sessionId, { type: 'live:stage', session_id: sessionId, stage: null });
  return active;
}

// Fan requests stage time. Mode: 'video' ($10/$25) or 'mic' audio-only ($5/$15).
// If she's explicit right now it's the EXPLICIT tier. Charged immediately; refunded if declined.
app.post('/api/live/:id/join-request', identMiddleware, requireUser, requireRole('fan'), (req, res) => {
  const sess = db.prepare('SELECT * FROM live_sessions WHERE id = ? AND status = \'live\'')
    .get(req.params.id);
  if (!sess) return res.status(404).json({ error: 'not_live' });
  const viewer = db.prepare('SELECT 1 FROM live_viewers WHERE session_id = ? AND fan_id = ?')
    .get(sess.id, req.user.id);
  if (!viewer) return res.status(403).json({ error: 'join_first' });
  if (activeStageReq(sess.id))
    return res.status(409).json({ error: 'stage_busy',
      message: 'She\'s with someone right now — try again soon!' });
  const mine = db.prepare(`SELECT * FROM live_join_requests
    WHERE session_id = ? AND fan_id = ? AND status = 'pending'`)
    .get(sess.id, req.user.id);
  if (mine) return res.status(409).json({ error: 'already_pending', request_id: mine.id });
  const isExplicitJoin = !!sess.is_explicit;
  const mode = req.body && req.body.mode === 'mic' ? 'mic' : 'video';
  const rates = modelJoinRates(sess.model_id);
  const fee = stageJoinFee(isExplicitJoin, mode, rates);
  const modeLabel = mode === 'mic' ? 'mic-only 🎙️' : 'video 🎥';
  try {
    chargeFan(req.user.id, sess.model_id, fee, 'live_join_request',
      `${mode === 'mic' ? '🎙️' : '🎥'} Join-live request (${modeLabel}, ${isExplicitJoin ? 'explicit' : 'regular'}) on stream #${sess.id}`, clientIp(req));
  } catch (e) {
    if (e.message === 'insufficient_credits' || e.message === 'spend_cap_reached')
      return res.status(402).json(chargeErrorBody(e, fee, req.user.id));
    throw e;
  }
  const info = db.prepare(`INSERT INTO live_join_requests (session_id, fan_id, is_explicit, mode) VALUES (?,?,?,?)`)
    .run(sess.id, req.user.id, isExplicitJoin ? 1 : 0, mode);
  const rid = Number(info.lastInsertRowid);
  pushToUser(sess.model_id, { type: 'live:join-request', session_id: sess.id,
    request: { id: rid, fan_id: req.user.id, fan_name: req.user.display_name,
               is_explicit: isExplicitJoin, mode } });
  // Also create a persistent notification so it shows in the bell
  try {
    notifyUser(sess.model_id, 'stage_request',
      srv('bell_stage_title', userLang(sess.model_id), { fan: req.user.display_name }),
      srv('bell_stage_body', userLang(sess.model_id), { fee: fmt(fee) }),
      `/live/${sess.id}`);
  } catch (e) { /* notification failed, WS still sent */ }
  res.json({ ok: true, request_id: rid, is_explicit: isExplicitJoin, mode, fee_cents: fee,
    balance_cents: getWallet(req.user.id).credits_cents });
});

// Model approves a join request — fan's video comes to her (peer-to-peer)
app.post('/api/live/join-requests/:rid/approve', identMiddleware, requireUser, requireRole('model'), (req, res) => {
  const r = db.prepare('SELECT * FROM live_join_requests WHERE id = ?').get(req.params.rid);
  if (!r || r.status !== 'pending') return res.status(404).json({ error: 'not_found' });
  const sess = db.prepare('SELECT * FROM live_sessions WHERE id = ? AND status = \'live\'')
    .get(r.session_id);
  if (!sess || sess.model_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });
  if (activeStageReq(sess.id))
    return res.status(409).json({ error: 'stage_busy' });
  const now = Date.now();
  db.prepare(`UPDATE live_join_requests SET status = 'approved', stage_started_at = ? WHERE id = ?`)
    .run(now, r.id);
  // Explicit stage fee COVERS viewing — no separate explicit entry fee needed.
  if (r.is_explicit) {
    db.prepare(`UPDATE live_viewers SET explicit_paid = 1 WHERE session_id = ? AND fan_id = ?`)
      .run(sess.id, r.fan_id);
  }
  const fan = db.prepare('SELECT display_name FROM users WHERE id = ?').get(r.fan_id);
  const mode = r.mode || 'video';
  const stage = { id: r.id, fan_id: r.fan_id, fan_name: fan.display_name,
                  is_explicit: !!r.is_explicit, mode,
                  stage_ends_at: now + STAGE_MINUTES * 60 * 1000 };
  pushToUser(r.fan_id, { type: 'live:join-approved', session_id: sess.id,
    request_id: r.id, stage_ends_at: stage.stage_ends_at, is_explicit: !!r.is_explicit, mode });
  pushLiveAll(sess.id, { type: 'live:stage', session_id: sess.id, stage });
  pushToAdmins({ type: 'live:join_admin', session_id: sess.id, model_id: sess.model_id,
    fan_name: fan.display_name,
    amount_cents: stageJoinFee(!!r.is_explicit, mode, modelJoinRates(sess.model_id)) });
  res.json({ ok: true, stage });
});

// Model declines — fan refunded in full (whichever tier they paid)
app.post('/api/live/join-requests/:rid/decline', identMiddleware, requireUser, requireRole('model'), (req, res) => {
  const r = db.prepare('SELECT * FROM live_join_requests WHERE id = ?').get(req.params.rid);
  if (!r || r.status !== 'pending') return res.status(404).json({ error: 'not_found' });
  const sess = db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(r.session_id);
  if (!sess || sess.model_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });
  const fee = stageJoinFee(!!r.is_explicit, r.mode || 'video', modelJoinRates(sess.model_id));
  db.prepare(`UPDATE live_join_requests SET status = 'declined' WHERE id = ?`).run(r.id);
  refundFan(r.fan_id, sess.model_id, fee, 'live_join_refund',
    `${(r.mode || 'video') === 'mic' ? '🎙️' : '🎥'} Join-live declined on stream #${sess.id} — refunded`, clientIp(req));
  pushToUser(r.fan_id, { type: 'live:join-declined', session_id: sess.id,
    request_id: r.id, refunded_cents: fee,
    balance_cents: getWallet(r.fan_id).credits_cents });
  res.json({ ok: true, refunded_cents: fee });
});

// Model drops the active stage fan (or stage timer expires — same path, no refund)
app.post('/api/live/join-requests/:rid/drop', identMiddleware, requireUser, requireRole('model'), (req, res) => {
  const r = db.prepare('SELECT * FROM live_join_requests WHERE id = ?').get(req.params.rid);
  if (!r || r.status !== 'approved') return res.status(404).json({ error: 'not_found' });
  const sess = db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(r.session_id);
  if (!sess || sess.model_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });
  dropStageFan(sess.id, req.body && req.body.reason === 'timeout' ? 'timeout' : 'dropped');
  res.json({ ok: true });
});

// Stage state: pending requests + active stage fan (model view; fans see stage only)
app.get('/api/live/:id/stage', identMiddleware, requireUser, (req, res) => {
  const sess = db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(req.params.id);
  if (!sess) return res.status(404).json({ error: 'not_found' });
  if (!isLiveParticipant(sess, req.user)) return res.status(403).json({ error: 'join_first' });
  const out = { stage: stageJSON(activeStageReq(sess.id)) };
  if (req.user.role === 'model' && sess.model_id === req.user.id) {
    out.pending = pendingStageReqs(sess.id).map((r) =>
      ({ id: r.id, fan_id: r.fan_id, fan_name: r.fan_name, is_explicit: !!r.is_explicit,
         mode: r.mode || 'video' }));
  } else {
    const mine = db.prepare(`SELECT r.*, u.display_name AS fan_name FROM live_join_requests r
      JOIN users u ON u.id = r.fan_id
      WHERE r.session_id = ? AND r.fan_id = ? AND r.status = 'pending'`)
      .get(sess.id, req.user.id);
    out.my_pending = mine ? { id: mine.id, fan_name: mine.fan_name, mode: mine.mode || 'video',
      is_explicit: !!mine.is_explicit } : null;
    const myStage = db.prepare(`SELECT r.*, u.display_name AS fan_name FROM live_join_requests r
      JOIN users u ON u.id = r.fan_id
      WHERE r.session_id = ? AND r.fan_id = ? AND r.status = 'approved'`)
      .get(sess.id, req.user.id);
    out.my_stage = stageJSON(myStage);
  }
  res.json(out);
});

/* ------------------------------------------------------------------ */
/* BOOKINGS — private 1-on-1 scheduled lives (fan pays upfront)        */
/* ------------------------------------------------------------------ */

const BOOKING_DURATIONS = [15, 30, 60];
const BOOKING_MAX_DAYS = 7;
const BOOKING_NOSHOW_MIN = 5; // model no-show window (owner ruling Oct 15: was 15)
const FAN_JOIN_MIN = 3;       // fan's join window once the model activates
const BOOKING_FAN_CANCEL_HOURS = 1;

function bookingFor(b, userId) {
  const isFan = b.fan_id === userId;
  const otherId = isFan ? b.model_id : b.fan_id;
  const u = db.prepare('SELECT id, display_name, username FROM users WHERE id = ?').get(otherId);
  let photo_url = '';
  if (isFan) {
    const m = db.prepare('SELECT photo_url FROM models WHERE user_id = ?').get(b.model_id);
    if (m) photo_url = m.photo_url || '';
  }
  return {
    id: b.id, model_id: b.model_id, fan_id: b.fan_id,
    scheduled_at: b.scheduled_at, duration_min: b.duration_min,
    total_cents: b.total_cents, rate_cents: b.rate_cents,
    status: b.status, kind: b.kind || 'request',
    fan_join_deadline: b.fan_join_deadline || null,
    created_at: b.created_at, decided_at: b.decided_at,
    other_name: u ? u.display_name : '?', other_photo_url: photo_url,
    is_fan_side: isFan,
  };
}

/* ------------------------------------------------------------------ */
/* Slot bookings (Oct 15, 2026): the model publishes weekly 1-on-1     */
/* windows (America/Chicago) + optional per-day / per-week caps. Fans  */
/* see 30-min start slots for the next 14 days; first fan to pay owns  */
/* the slot (status 'booked' — confirmed instantly, no approve step).  */
/* Week convention: Sunday–Saturday (matches JS getDay() and the       */
/* app's Sun-first day lists). Money flows through the same 'booking'   */
/* charge / refundFan paths as the legacy request flow.                */
/* ------------------------------------------------------------------ */
const SLOT_DURATIONS = [10, 15, 30];
const SLOT_MAX_DAYS = 14;
const SLOT_LEAD_MIN = 60;
const SLOT_FAN_CANCEL_HOURS = 2;
const CONFIRMED_BOOKING = `('booked','approved','in_progress')`;

function httpErr(status, error, message) {
  const e = new Error(message || error);
  e.httpStatus = status; e.errCode = error;
  return e;
}

/* --- America/Chicago calendar helpers (DST-safe via Intl) --- */
const CHI_TZ = 'America/Chicago';
const _chiPartsFmt = new Intl.DateTimeFormat('en-US', { timeZone: CHI_TZ,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
function chiParts(ms) {
  const p = Object.fromEntries(_chiPartsFmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { year: +p.year, month: +p.month, day: +p.day,
           hour: (+p.hour) % 24, minute: +p.minute, second: +p.second };
}
function chiDateStr(ms) {
  const p = chiParts(ms);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}
function chiOffsetMs(ms) {
  const p = chiParts(ms);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
    - Math.floor(ms / 1000) * 1000;
}
function chiMidnightMs(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  let guess = Date.UTC(y, m - 1, d, 6, 0, 0);
  for (let i = 0; i < 3; i++) guess = Date.UTC(y, m - 1, d) - chiOffsetMs(guess);
  return guess;
}
function chiWeekdayOfDateStr(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
function dateStrAdd(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function chiWeekStartStr(dateStr) { // Sunday of this Chicago week
  return dateStrAdd(dateStr, -chiWeekdayOfDateStr(dateStr));
}
function chiWhenLabel(ms) {
  return new Intl.DateTimeFormat('en-US', { timeZone: CHI_TZ, weekday: 'long',
    hour: 'numeric', minute: '2-digit' }).format(new Date(ms)) + ' CT';
}

function confirmedBookings(modelId) {
  return db.prepare(`SELECT * FROM bookings WHERE model_id = ?
    AND status IN ${CONFIRMED_BOOKING}`).all(modelId);
}
function bookingsOverlap(modelId, startMs, endMs, excludeId = 0) {
  return db.prepare(`SELECT id FROM bookings WHERE model_id = ?
    AND status IN ${CONFIRMED_BOOKING} AND id != ?
    AND scheduled_at < ? AND (scheduled_at + duration_min * 60000) > ?
    LIMIT 1`).get(modelId, excludeId, endMs, startMs);
}
function bookingCounts(modelId) {
  const dayCounts = new Map(), weekCounts = new Map();
  for (const b of confirmedBookings(modelId)) {
    const ds = chiDateStr(b.scheduled_at);
    dayCounts.set(ds, (dayCounts.get(ds) || 0) + 1);
    const ws = chiWeekStartStr(ds);
    weekCounts.set(ws, (weekCounts.get(ws) || 0) + 1);
  }
  return { dayCounts, weekCounts };
}
function modelCaps(modelId) {
  const m = db.prepare('SELECT bookings_day_cap, bookings_week_cap FROM models WHERE user_id = ?')
    .get(modelId);
  return { day_cap: m && m.bookings_day_cap != null ? m.bookings_day_cap : null,
           week_cap: m && m.bookings_week_cap != null ? m.bookings_week_cap : null };
}

/* The 14-day fan-facing grid: per Chicago day, her window + 30-min start
   slots; a slot lists which durations still fit (window end + no overlap
   + caps not reached). taken = nothing fits anymore. */
function buildAvailability(modelId, days = SLOT_MAX_DAYS) {
  const wins = db.prepare('SELECT * FROM model_availability WHERE model_id = ?').all(modelId);
  const winByDay = new Map(wins.map((w) => [w.weekday, w]));
  const confirmed = confirmedBookings(modelId);
  const { dayCounts, weekCounts } = bookingCounts(modelId);
  const caps = modelCaps(modelId);
  const now = Date.now();
  const todayStr = chiDateStr(now);
  const out = [];
  for (let i = 0; i < days; i++) {
    const ds = dateStrAdd(todayStr, i);
    const wd = chiWeekdayOfDateStr(ds);
    const win = winByDay.get(wd) || null;
    const dayFull = caps.day_cap != null && (dayCounts.get(ds) || 0) >= caps.day_cap;
    const ws = chiWeekStartStr(ds);
    const weekFull = caps.week_cap != null && (weekCounts.get(ws) || 0) >= caps.week_cap;
    const slots = [];
    if (win) {
      const mid = chiMidnightMs(ds);
      for (let s = win.start_min; s + SLOT_DURATIONS[0] <= win.end_min; s += 30) {
        const startMs = mid + s * 60000;
        if (startMs < now + SLOT_LEAD_MIN * 60000) continue;
        const free_for = (dayFull || weekFull) ? [] : SLOT_DURATIONS.filter((d) =>
          s + d <= win.end_min &&
          !confirmed.some((b) => b.scheduled_at < startMs + d * 60000 &&
            (b.scheduled_at + b.duration_min * 60000) > startMs));
        slots.push({ starts_at: new Date(startMs).toISOString(), start_min: s,
                     free_for, taken: free_for.length === 0 });
      }
    }
    out.push({ date: ds, weekday: wd, has_window: !!win,
      window: win ? { start_min: win.start_min, end_min: win.end_min } : null,
      day_full: dayFull, week_full: weekFull,
      booked_out: !!win && (dayFull || weekFull || slots.every((s) => s.taken)),
      slots });
  }
  return { caps, days: out };
}

/* Apology DM to a fan from SlutCamp — the admin→fan thread (admin sits in
   the model seat of a normal conversation; NEVER a fake message from the
   model in her own thread). Same get-or-create shape as the admin→model
   inbox pattern. */
function sendAdminApologyDm(fanId, modelName, totalCents) {
  const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1").get();
  if (!admin || admin.id === fanId) return;
  let conv = db.prepare('SELECT id FROM conversations WHERE fan_id = ? AND model_id = ?')
    .get(fanId, admin.id);
  if (!conv) {
    const info = db.prepare('INSERT INTO conversations (fan_id, model_id) VALUES (?,?)')
      .run(fanId, admin.id);
    conv = { id: Number(info.lastInsertRowid) };
  }
  const amt = '$' + (totalCents / 100).toFixed(2);
  const body = srv('apology_dm_body', userLang(fanId), { model: modelName, amount: amt });
  db.prepare('INSERT INTO messages (conversation_id, sender_id, body) VALUES (?,?,?)')
    .run(conv.id, admin.id, body);
  db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?").run(conv.id);
  try { notifyUser(fanId, 'message', '💬 SlutCamp', body.slice(0, 90), `/#chat/${conv.id}`); } catch (e) { /* bell is a bonus */ }
}

function bookingCallStarted(b) {
  return !!db.prepare(`SELECT id FROM calls WHERE booking_id = ?
    AND started_at IS NOT NULL LIMIT 1`).get(b.id);
}

/* Session activation (owner ruling, Oct 15): when the model starts a
   booking — her Start tap, or opening the session herself — the fan's
   3-minute join clock starts. He is notified immediately (bell + push +
   WS) and the deadline lives on the booking row (fan_join_deadline, ms
   epoch), so every surface renders the same server-set countdown and the
   sweep — never a client clock — enforces it. */
function activateBookingSession(b) {
  if (!b) return null;
  if (b.fan_join_deadline) return b.fan_join_deadline;
  if (bookingCallStarted(b)) return null;
  const deadline = Date.now() + FAN_JOIN_MIN * 60 * 1000;
  db.prepare('UPDATE bookings SET fan_join_deadline = ? WHERE id = ?').run(deadline, b.id);
  b.fan_join_deadline = deadline;
  const model = db.prepare('SELECT display_name FROM users WHERE id = ?').get(b.model_id);
  const modelName = model ? model.display_name : 'Your model';
  const copy = srv('bell_booking_fan_active_body', userLang(b.fan_id), { model: modelName });
  pushToUser(b.fan_id, { type: 'booking:live', booking_id: b.id,
    fan_join_deadline: deadline, message: copy });
  try { notifyUser(b.fan_id, 'booking', srv('bell_booking_fan_active_title', userLang(b.fan_id)), copy, '/#bookings'); }
  catch (e) { /* bell is a bonus */ }
  return deadline;
}

/* Fan no-show (owner ruling, Oct 15): the model showed up and opened the
   room; the fan never got there inside his 3 minutes. NO refund — the
   slot was reserved for him and her time was held, so the charge stands
   and she keeps her earnings (no ledger movement at all). Her waiting
   call hangs up automatically and BOTH sides are told he never showed. */
function settleFanNoShow(b) {
  db.prepare(`UPDATE bookings SET status = 'fan_no_show', decided_at = datetime('now')
              WHERE id = ?`).run(b.id);
  // Hang up her waiting room via the normal end path (the booking is
  // already resolved, so endCall won't flip it to 'completed').
  const open = db.prepare(`SELECT id FROM calls WHERE booking_id = ? AND status != 'ended'`)
    .all(b.id);
  for (const c of open) endCall(c.id, 'fan_no_show');
  pushToUser(b.fan_id, { type: 'booking:fan_no_show', booking_id: b.id });
  pushToUser(b.model_id, { type: 'booking:fan_no_show', booking_id: b.id });
  const fan = db.prepare('SELECT display_name FROM users WHERE id = ?').get(b.fan_id);
  const model = db.prepare('SELECT display_name FROM users WHERE id = ?').get(b.model_id);
  const fanName = fan ? fan.display_name : 'A fan';
  const modelName = model ? model.display_name : 'Your model';
  try { notifyUser(b.model_id, 'booking', srv('bell_booking_fan_noshow_model_title', userLang(b.model_id)),
    srv('bell_booking_fan_noshow_model_body', userLang(b.model_id), { fan: fanName }), '/#bookings'); }
  catch (e) { /* bell is a bonus */ }
  try { notifyUser(b.fan_id, 'booking', srv('bell_booking_fan_noshow_fan_title', userLang(b.fan_id)),
    srv('bell_booking_fan_noshow_fan_body', userLang(b.fan_id), { model: modelName }), '/#bookings'); }
  catch (e) { /* bell is a bonus */ }
}

function checkFanJoinDeadline(b) {
  if (!b || b.status !== 'in_progress' || !b.fan_join_deadline) return b;
  if (Date.now() < b.fan_join_deadline) return b;
  if (bookingCallStarted(b)) return b;
  if (b.fan_present) return b; // he got to the call inside his window
  settleFanNoShow(b);
  return db.prepare('SELECT * FROM bookings WHERE id = ?').get(b.id);
}

/* Model no-show resolution: start + 5 min, she never opened the room and
   the call never started → full refund (the standing never-started
   rule), the SlutCamp apology DM to the fan, and her "you missed it"
   bell. (Her showing up moves the booking to the fan-deadline track
   above — this path is only for when she never arrives.) */
function settleBookingNoShow(b) {
  db.prepare(`UPDATE bookings SET status = 'no_show', decided_at = datetime('now') WHERE id = ?`)
    .run(b.id);
  refundFan(b.fan_id, b.model_id, b.total_cents, 'booking_no_show',
    `📅 Booking #${b.id} never started — refunded in full`);
  pushToUser(b.fan_id, { type: 'booking:no_show', booking_id: b.id,
    refunded_cents: b.total_cents,
    balance_cents: getWallet(b.fan_id).credits_cents });
  pushToUser(b.model_id, { type: 'booking:no_show', booking_id: b.id });
  const fan = db.prepare('SELECT display_name FROM users WHERE id = ?').get(b.fan_id);
  const model = db.prepare('SELECT display_name FROM users WHERE id = ?').get(b.model_id);
  const fanName = fan ? fan.display_name : 'A fan';
  const modelName = model ? model.display_name : 'Your model';
  sendAdminApologyDm(b.fan_id, modelName, b.total_cents);
  try { notifyUser(b.model_id, 'booking', srv('bell_booking_model_noshow_title', userLang(b.model_id)),
    srv('bell_booking_model_noshow_body', userLang(b.model_id), { fan: fanName }), '/#bookings'); }
  catch (e) { /* bell is a bonus */ }
}

function checkNoShow(b) {
  if (!b || !['approved', 'booked', 'in_progress'].includes(b.status)) return b;
  if (bookingCallStarted(b)) return b;
  // Once she has activated the session, the fan's 3-minute deadline owns
  // the booking — her no-show clock no longer applies to it.
  if (b.fan_join_deadline) return checkFanJoinDeadline(b);
  if (Date.now() <= b.scheduled_at + BOOKING_NOSHOW_MIN * 60 * 1000) return b;
  if (b.model_present) {
    // She opened the room but no deadline was stamped (activation stamps
    // it — this is only a safety net): start his 3-minute clock now.
    activateBookingSession(b);
    return db.prepare('SELECT * FROM bookings WHERE id = ?').get(b.id);
  }
  settleBookingNoShow(b);
  return db.prepare('SELECT * FROM bookings WHERE id = ?').get(b.id);
}

/* Model reminders at T-3 days / T-3 hours / T-15 minutes (status 'booked'
   only). Dedupe is structural: the reminded_* stamp is written when the
   threshold is evaluated, so each threshold can fire at most once per
   booking, ever. A booking created after a window already opened gets
   that threshold stamped-but-skipped (she booked late; a "3 days out"
   ping for a same-day booking would be noise). */
const BOOKING_REMINDERS = [
  { col: 'reminded_3d', ms: 3 * 24 * 60 * 60 * 1000, labelKey: 'reminder_label_3d', tailKey: null },
  { col: 'reminded_3h', ms: 3 * 60 * 60 * 1000, labelKey: 'reminder_label_3h', tailKey: null },
  { col: 'reminded_15m', ms: 15 * 60 * 1000, labelKey: 'reminder_label_15m', tailKey: 'reminder_tail_15m' },
];
function bookingRemindersSweep() {
  const now = Date.now();
  const rows = db.prepare(`SELECT * FROM bookings WHERE status = 'booked'
    AND scheduled_at > ? ORDER BY scheduled_at`).all(now - 60 * 1000);
  for (const b of rows) {
    const createdMs = Date.parse(String(b.created_at).replace(' ', 'T') + 'Z');
    const fan = db.prepare('SELECT display_name FROM users WHERE id = ?').get(b.fan_id);
    const fanName = fan ? fan.display_name : 'A fan';
    for (const r of BOOKING_REMINDERS) {
      if (b[r.col]) continue;
      const windowOpens = b.scheduled_at - r.ms;
      if (now < windowOpens) continue;
      db.prepare(`UPDATE bookings SET ${r.col} = datetime('now') WHERE id = ?`).run(b.id);
      b[r.col] = 'sent';
      if (Number.isFinite(createdMs) && createdMs > windowOpens) continue; // booked after this window opened
      try {
        const remLang = userLang(b.model_id);
        notifyUser(b.model_id, 'booking', srv('bell_booking_reminder_title', remLang),
          srv('bell_booking_reminder_body', remLang, {
            fan: fanName, label: srv(r.labelKey, remLang),
            when: chiWhenLabel(b.scheduled_at), min: b.duration_min,
            tail: r.tailKey ? srv(r.tailKey, remLang) : '',
          }), '/#bookings');
      } catch (e) { /* bell is a bonus */ }
    }
  }
}

/* At the booked start time, the model is told her 1-on-1 is now active
   and her 5-minute clock is running (owner ruling, Oct 15). Stamped via
   start_notified_at, so it fires exactly once; if her window has already
   closed, the stamp is written silently and the no-show sweep resolves
   the booking instead. */
function bookingStartNoticesSweep() {
  const now = Date.now();
  const rows = db.prepare(`SELECT * FROM bookings
    WHERE status IN ('booked','approved','in_progress')
      AND scheduled_at <= ? AND start_notified_at IS NULL AND model_present = 0`)
    .all(now);
  for (const b of rows) {
    db.prepare(`UPDATE bookings SET start_notified_at = datetime('now') WHERE id = ?`).run(b.id);
    if (bookingCallStarted(b)) continue;
    if (now > b.scheduled_at + BOOKING_NOSHOW_MIN * 60 * 1000) continue; // her window already closed
    const fan = db.prepare('SELECT display_name FROM users WHERE id = ?').get(b.fan_id);
    const fanName = fan ? fan.display_name : 'A fan';
    try {
      notifyUser(b.model_id, 'booking', srv('bell_booking_start_title', userLang(b.model_id)),
        srv('bell_booking_start_body', userLang(b.model_id), { fan: fanName }), '/#bookings');
    } catch (e) { /* bell is a bonus */ }
  }
}

/* One sweep entry for bookings: reminders → start notices → fan join
   deadlines → model no-shows → completions. Runs on a 15s interval (the
   3-minute fan window and 5-minute model window need the tight cadence)
   and lazily from GET /api/bookings. */
function runBookingSweeps() {
  try { bookingRemindersSweep(); } catch (e) { console.error('booking reminders', e); }
  try { bookingStartNoticesSweep(); } catch (e) { console.error('booking start notices', e); }
  try {
    const act = db.prepare(`SELECT * FROM bookings
      WHERE status = 'in_progress' AND fan_join_deadline IS NOT NULL AND fan_join_deadline < ?`)
      .all(Date.now());
    for (const b of act) checkFanJoinDeadline(b);
  } catch (e) { console.error('booking fan-deadline sweep', e); }
  try {
    const due = db.prepare(`SELECT * FROM bookings
      WHERE status IN ('booked','approved','in_progress') AND scheduled_at < ?`)
      .all(Date.now() - BOOKING_NOSHOW_MIN * 60 * 1000);
    for (const b of due) checkNoShow(b);
  } catch (e) { console.error('booking no-show sweep', e); }
  try { settleFinishedBookings(); } catch (e) { console.error('booking settle', e); }
}
setInterval(runBookingSweeps, 15 * 1000);

// Auto-complete in-progress bookings whose scheduled end has passed
function settleFinishedBookings() {
  const now = Date.now();
  const rows = db.prepare(`SELECT * FROM bookings WHERE status = 'in_progress'`).all();
  for (const b of rows) {
    if (now > b.scheduled_at + b.duration_min * 60 * 1000) {
      db.prepare(`UPDATE bookings SET status = 'completed', decided_at = datetime('now') WHERE id = ?`)
        .run(b.id);
      pushToUser(b.fan_id, { type: 'booking:completed', booking_id: b.id });
      pushToUser(b.model_id, { type: 'booking:completed', booking_id: b.id });
    }
  }
}

/* --- Model availability for 1-on-1 slot bookings --- */

// Model: read her weekly 1-on-1 windows + caps
app.get('/api/model/availability', identMiddleware, requireUser, requireRole('model'), (req, res) => {
  const windows = db.prepare(`SELECT weekday, start_min, end_min FROM model_availability
    WHERE model_id = ? ORDER BY weekday`).all(req.user.id);
  const caps = modelCaps(req.user.id);
  res.json({ windows, day_cap: caps.day_cap, week_cap: caps.week_cap });
});

// Model: replace her weekly 1-on-1 windows + caps (one window per weekday)
app.put('/api/model/availability', identMiddleware, requireUser, requireRole('model'), (req, res) => {
  const windows = Array.isArray(req.body.windows) ? req.body.windows : [];
  const seen = new Set();
  const clean = [];
  for (const w of windows) {
    const weekday = parseInt(w.weekday);
    const start_min = parseInt(w.start_min);
    const end_min = parseInt(w.end_min);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6 || seen.has(weekday))
      return res.status(400).json({ error: 'bad_window' });
    if (!Number.isInteger(start_min) || !Number.isInteger(end_min) ||
        start_min < 0 || end_min > 1440 || start_min >= end_min ||
        start_min % 30 !== 0 || end_min % 30 !== 0)
      return res.status(400).json({ error: 'bad_window',
        message: 'Windows run on the half hour (e.g. 12:00–16:00).' });
    seen.add(weekday);
    clean.push({ weekday, start_min, end_min });
  }
  const capOrNull = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = parseInt(v);
    return Number.isInteger(n) && n >= 0 && n <= 100 ? n : undefined;
  };
  const dayCap = capOrNull(req.body.day_cap);
  const weekCap = capOrNull(req.body.week_cap);
  if (dayCap === undefined || weekCap === undefined)
    return res.status(400).json({ error: 'bad_cap' });
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM model_availability WHERE model_id = ?').run(req.user.id);
    const ins = db.prepare(`INSERT INTO model_availability (model_id, weekday, start_min, end_min)
      VALUES (?,?,?,?)`);
    for (const w of clean) ins.run(req.user.id, w.weekday, w.start_min, w.end_min);
    db.prepare('UPDATE models SET bookings_day_cap = ?, bookings_week_cap = ? WHERE user_id = ?')
      .run(dayCap, weekCap, req.user.id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  res.json({ ok: true, windows: clean, day_cap: dayCap, week_cap: weekCap });
});

// Fan: her bookable grid for the next N days (Chicago), taken vs free
app.get('/api/models/:id/bookings-availability', identMiddleware, requireUser, (req, res) => {
  const modelId = parseInt(req.params.id);
  const model = db.prepare(`
    SELECT u.id, u.display_name, m.per_minute_cents FROM users u
    JOIN models m ON m.user_id = u.id
    WHERE u.id = ? AND u.role = 'model' AND u.banned = 0`).get(modelId);
  if (!model) return res.status(404).json({ error: 'model_not_found' });
  if (modelRegionBlocked(modelId, geoOfReq(req))) return regionBlocked(res);
  const days = Math.min(Math.max(parseInt(req.query.days) || SLOT_MAX_DAYS, 1), 14);
  const grid = buildAvailability(modelId, days);
  res.json({ model_id: modelId, model_name: model.display_name,
    rate_cents: model.per_minute_cents, durations: SLOT_DURATIONS,
    day_cap: grid.caps.day_cap, week_cap: grid.caps.week_cap, days: grid.days });
});

/* Slot booking create: first fan to pay owns the slot. The check-and-
   insert runs inside BEGIN IMMEDIATE (and this handler is fully
   synchronous, so no other request can interleave); the charge itself
   goes through chargeFan — the one money path — right after commit,
   and the just-created row is removed if the charge can't complete. */
function slotBookingCreate(req, res) {
  const modelId = parseInt(req.body.model_id);
  const minutes = parseInt(req.body.minutes != null ? req.body.minutes : req.body.duration_min);
  const startsAt = typeof req.body.starts_at === 'number'
    ? req.body.starts_at : Date.parse(req.body.starts_at);
  const model = db.prepare(`
    SELECT u.id, u.display_name, u.banned, m.per_minute_cents FROM users u
    JOIN models m ON m.user_id = u.id
    WHERE u.id = ? AND u.role = 'model'`).get(modelId);
  if (!model || model.banned) return res.status(404).json({ error: 'model_not_found' });
  if (modelRegionBlocked(modelId, geoOfReq(req))) return regionBlocked(res);
  if (!SLOT_DURATIONS.includes(minutes))
    return res.status(400).json({ error: 'bad_duration', allowed: SLOT_DURATIONS });
  const now = Date.now();
  if (!Number.isFinite(startsAt))
    return res.status(400).json({ error: 'bad_time' });
  if (startsAt < now + SLOT_LEAD_MIN * 60 * 1000)
    return res.status(400).json({ error: 'too_soon',
      message: 'Book at least 1 hour ahead.' });
  if (startsAt > now + SLOT_MAX_DAYS * 24 * 60 * 60 * 1000)
    return res.status(400).json({ error: 'too_far',
      message: 'Bookings open up to 14 days ahead.' });
  const ds = chiDateStr(startsAt);
  const startMin = Math.round((startsAt - chiMidnightMs(ds)) / 60000);
  if (startMin % 30 !== 0)
    return res.status(409).json({ error: 'slot_unavailable',
      message: 'That start time is not on her schedule.' });
  const win = db.prepare('SELECT * FROM model_availability WHERE model_id = ? AND weekday = ?')
    .get(modelId, chiWeekdayOfDateStr(ds));
  if (!win || startMin < win.start_min || startMin + minutes > win.end_min)
    return res.status(409).json({ error: 'slot_unavailable',
      message: 'She is not taking 1-on-1s then.' });
  const total = model.per_minute_cents * minutes;
  let bookingId = null;
  db.exec('BEGIN IMMEDIATE');
  try {
    if (bookingsOverlap(modelId, startsAt, startsAt + minutes * 60000, 0))
      throw httpErr(409, 'slot_taken', 'That slot just got booked.');
    const caps = modelCaps(modelId);
    const { dayCounts, weekCounts } = bookingCounts(modelId);
    if (caps.day_cap != null && (dayCounts.get(ds) || 0) >= caps.day_cap)
      throw httpErr(409, 'day_full', 'She is booked out that day.');
    const ws = chiWeekStartStr(ds);
    if (caps.week_cap != null && (weekCounts.get(ws) || 0) >= caps.week_cap)
      throw httpErr(409, 'week_full', 'She is booked out that week.');
    if (getWallet(req.user.id).credits_cents < total)
      throw httpErr(402, 'insufficient_credits');
    const info = db.prepare(`INSERT INTO bookings
      (model_id, fan_id, scheduled_at, duration_min, total_cents, rate_cents, status, kind)
      VALUES (?,?,?,?,?,?,'booked','slot')`)
      .run(modelId, req.user.id, startsAt, minutes, total, model.per_minute_cents);
    bookingId = Number(info.lastInsertRowid);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (err) { /* already closed */ }
    if (e.httpStatus) {
      const out = { error: e.errCode };
      if (e.message && e.message !== e.errCode) out.message = e.message;
      if (e.errCode === 'insufficient_credits') {
        out.needed_cents = total;
        out.balance_cents = getWallet(req.user.id).credits_cents;
      }
      return res.status(e.httpStatus).json(out);
    }
    throw e;
  }
  try {
    chargeFan(req.user.id, model.id, total, 'booking',
      `📅 Private ${minutes}min 1-on-1 with ${model.display_name}`, clientIp(req));
  } catch (e) {
    db.prepare('DELETE FROM bookings WHERE id = ?').run(bookingId);
    return res.status(402).json(chargeErrorBody(e, total, req.user.id));
  }
  pushToUser(model.id, { type: 'booking:booked', booking_id: bookingId,
    fan_id: req.user.id, fan_name: req.user.display_name,
    scheduled_at: startsAt, duration_min: minutes, total_cents: total });
  try {
    notifyUser(model.id, 'booking', srv('bell_booking_new_title', userLang(model.id)),
      srv('bell_booking_new_body', userLang(model.id),
        { fan: req.user.display_name, min: minutes, when: chiWhenLabel(startsAt) }),
      '/#bookings');
  } catch (e) { /* bell is a bonus */ }
  res.json({ ok: true, booking_id: bookingId, status: 'booked', total_cents: total,
    balance_cents: getWallet(req.user.id).credits_cents });
}

// Fan requests a private booked live — pays upfront
app.post('/api/bookings', identMiddleware, requireUser, requireRole('fan'), (req, res) => {
  if (req.body && req.body.starts_at != null) return slotBookingCreate(req, res);
  const modelId = parseInt(req.body.model_id);
  const scheduledAt = parseInt(req.body.scheduled_at);
  const durationMin = parseInt(req.body.duration_min);
  const model = db.prepare(`
    SELECT u.id, u.display_name, u.banned, m.per_minute_cents FROM users u
    JOIN models m ON m.user_id = u.id
    WHERE u.id = ? AND u.role = 'model'`).get(modelId);
  if (!model || model.banned) return res.status(404).json({ error: 'model_not_found' });
  if (modelRegionBlocked(modelId, geoOfReq(req))) return regionBlocked(res);
  if (!BOOKING_DURATIONS.includes(durationMin))
    return res.status(400).json({ error: 'bad_duration' });
  const now = Date.now();
  if (!Number.isInteger(scheduledAt) || scheduledAt < now + 60 * 60 * 1000)
    return res.status(400).json({ error: 'too_soon',
      message: 'Book at least 1 hour ahead.' });
  if (scheduledAt > now + BOOKING_MAX_DAYS * 24 * 60 * 60 * 1000)
    return res.status(400).json({ error: 'too_far',
      message: 'Bookings open up to 7 days ahead.' });
  const total = model.per_minute_cents * durationMin;
  try {
    chargeFan(req.user.id, model.id, total, 'booking',
      `📅 Private ${durationMin}min live with ${model.display_name}`, clientIp(req));
  } catch (e) {
    if (e.message === 'insufficient_credits' || e.message === 'spend_cap_reached')
      return res.status(402).json(chargeErrorBody(e, total, req.user.id));
    throw e;
  }
  const info = db.prepare(`INSERT INTO bookings
    (model_id, fan_id, scheduled_at, duration_min, total_cents, rate_cents)
    VALUES (?,?,?,?,?,?)`)
    .run(model.id, req.user.id, scheduledAt, durationMin, total, model.per_minute_cents);
  const bid = Number(info.lastInsertRowid);
  const when = new Date(scheduledAt);
  pushToUser(model.id, { type: 'booking:request', booking_id: bid,
    fan_id: req.user.id, fan_name: req.user.display_name,
    scheduled_at: scheduledAt, duration_min: durationMin, total_cents: total });
  res.json({ ok: true, booking_id: bid, total_cents: total,
    balance_cents: getWallet(req.user.id).credits_cents });
});

// Model approves a booking request
app.post('/api/bookings/:id/approve', identMiddleware, requireUser, requireRole('model'), (req, res) => {
  const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
  if (!b || b.status !== 'pending') return res.status(404).json({ error: 'not_found' });
  if (b.model_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });
  // Approving must never double-book her against a confirmed slot booking.
  if (bookingsOverlap(b.model_id, b.scheduled_at, b.scheduled_at + b.duration_min * 60000, b.id))
    return res.status(409).json({ error: 'slot_taken',
      message: 'That time is already booked — decline this one instead.' });
  db.prepare(`UPDATE bookings SET status = 'approved', decided_at = datetime('now') WHERE id = ?`)
    .run(b.id);
  pushToUser(b.fan_id, { type: 'booking:approved', booking_id: b.id,
    scheduled_at: b.scheduled_at, duration_min: b.duration_min });
  res.json({ ok: true });
});

// Model declines — instant full refund
app.post('/api/bookings/:id/decline', identMiddleware, requireUser, requireRole('model'), (req, res) => {
  const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
  if (!b || b.status !== 'pending') return res.status(404).json({ error: 'not_found' });
  if (b.model_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });
  db.prepare(`UPDATE bookings SET status = 'declined', decided_at = datetime('now') WHERE id = ?`)
    .run(b.id);
  refundFan(b.fan_id, b.model_id, b.total_cents, 'booking_refund',
    `📅 Booking #${b.id} declined — refunded`, clientIp(req));
  pushToUser(b.fan_id, { type: 'booking:declined', booking_id: b.id,
    refunded_cents: b.total_cents, balance_cents: getWallet(b.fan_id).credits_cents });
  res.json({ ok: true, refunded_cents: b.total_cents });
});

// Cancel: model → always full refund. Fan → full refund up to the cutoff
// (slot bookings: 2h before start; legacy requests: 1h), no refund inside it.
app.post('/api/bookings/:id/cancel', identMiddleware, requireUser, (req, res) => {
  const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
  if (!b) return res.status(404).json({ error: 'not_found' });
  if (!['pending', 'approved', 'booked'].includes(b.status))
    return res.status(409).json({ error: 'not_cancellable' });
  const isModel = req.user.role === 'model' && b.model_id === req.user.id;
  const isFan = req.user.role === 'fan' && b.fan_id === req.user.id;
  if (!isModel && !isFan) return res.status(403).json({ error: 'forbidden' });
  let refunded = 0;
  const fanCutoffH = b.kind === 'slot' ? SLOT_FAN_CANCEL_HOURS : BOOKING_FAN_CANCEL_HOURS;
  if (isModel || Date.now() < b.scheduled_at - fanCutoffH * 60 * 60 * 1000) {
    refunded = b.total_cents;
    refundFan(b.fan_id, b.model_id, b.total_cents, 'booking_refund',
      `📅 Booking #${b.id} cancelled by ${isModel ? 'model' : 'fan'} — refunded`, clientIp(req));
  }
  db.prepare(`UPDATE bookings SET status = 'cancelled', decided_at = datetime('now') WHERE id = ?`)
    .run(b.id);
  const otherId = isModel ? b.fan_id : b.model_id;
  pushToUser(otherId, { type: 'booking:cancelled', booking_id: b.id,
    refunded_cents: refunded, by: isModel ? 'model' : 'fan',
    balance_cents: isModel ? getWallet(b.fan_id).credits_cents : undefined });
  res.json({ ok: true, refunded_cents: refunded });
});

// Model starts the private session at (or near) the scheduled time.
// Tapping Start is her presence stamp for no-show resolution.
app.post('/api/bookings/:id/start', identMiddleware, requireUser, requireRole('model'), (req, res) => {
  const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
  if (!b || !['approved', 'booked'].includes(b.status)) return res.status(404).json({ error: 'not_found' });
  if (b.model_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });
  db.prepare(`UPDATE bookings SET status = 'in_progress', model_present = 1,
              decided_at = datetime('now') WHERE id = ?`)
    .run(b.id);
  // Activation: his 3-minute join clock starts now (bell + push + WS).
  const fresh = db.prepare('SELECT * FROM bookings WHERE id = ?').get(b.id);
  const deadline = activateBookingSession(fresh);
  res.json({ ok: true, fan_join_deadline: deadline });
});

// Either party opens the private video session (prepaid — rate 0, no per-minute billing)
app.post('/api/bookings/:id/call', identMiddleware, requireUser, (req, res) => {
  const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
  if (!b) return res.status(404).json({ error: 'not_found' });
  if (b.fan_id !== req.user.id && b.model_id !== req.user.id)
    return res.status(403).json({ error: 'forbidden' });
  if (!['approved', 'booked', 'in_progress'].includes(b.status))
    return res.status(409).json({ error: 'not_ready' });
  // Opening the session stamps presence for no-show resolution.
  if (req.user.id === b.model_id && !b.model_present)
    db.prepare('UPDATE bookings SET model_present = 1 WHERE id = ?').run(b.id);
  if (req.user.id === b.fan_id && !b.fan_present)
    db.prepare('UPDATE bookings SET fan_present = 1 WHERE id = ?').run(b.id);
  if (b.status === 'approved' || b.status === 'booked') {
    db.prepare(`UPDATE bookings SET status = 'in_progress', decided_at = datetime('now') WHERE id = ?`)
      .run(b.id);
  }
  // The model opening the session is activation too (same as her Start
  // tap): the fan's 3-minute join clock starts, once.
  if (req.user.id === b.model_id)
    activateBookingSession(db.prepare('SELECT * FROM bookings WHERE id = ?').get(b.id));
  const dlRow = db.prepare('SELECT fan_join_deadline FROM bookings WHERE id = ?').get(b.id);
  const fanJoinDeadline = dlRow ? dlRow.fan_join_deadline : null;
  const existing = db.prepare(`SELECT * FROM calls WHERE booking_id = ? AND status != 'ended'
    ORDER BY id DESC`).get(b.id);
  const otherId = req.user.id === b.fan_id ? b.model_id : b.fan_id;
  const other = db.prepare('SELECT display_name FROM users WHERE id = ?').get(otherId);
  if (existing) return res.json({ ok: true, call_id: existing.id, resumed: true,
    fan_join_deadline: fanJoinDeadline,
    other_id: otherId, other_name: other ? other.display_name : '?' });
  // Prepaid: the booked minutes ride the call as prepaid_min, so the call
  // counts down and ends at the cap — no per-minute charges on top.
  const info = db.prepare(`INSERT INTO calls (fan_id, model_id, rate_cents, booking_id, prepaid_min)
    VALUES (?,?,0,?,?)`)
    .run(b.fan_id, b.model_id, b.id, b.duration_min);
  res.json({ ok: true, call_id: Number(info.lastInsertRowid),
    fan_join_deadline: fanJoinDeadline,
    other_id: otherId, other_name: other ? other.display_name : '?' });
});

// Upcoming bookings for the logged-in user (both roles), with sweeps
app.get('/api/bookings', identMiddleware, requireUser, (req, res) => {
  runBookingSweeps();
  const col = req.user.role === 'model' ? 'model_id' : 'fan_id';
  const rows = db.prepare(`SELECT * FROM bookings WHERE ${col} = ?
    AND status IN ('pending','approved','booked','in_progress')
    ORDER BY scheduled_at ASC`).all(req.user.id);
  const out = rows.map((b) => bookingFor(checkNoShow(b), req.user.id));
  res.json({ bookings: out });
});

// Admin: all bookings
app.get('/api/admin/bookings', ...adminOnly, (req, res) => {
  const rows = db.prepare(`
    SELECT b.*, um.display_name AS model_name, uf.display_name AS fan_name
    FROM bookings b
    JOIN users um ON um.id = b.model_id
    JOIN users uf ON uf.id = b.fan_id
    ORDER BY b.scheduled_at DESC LIMIT 100`).all();
  res.json({ bookings: rows });
});

/* ------------------------------------------------------------------ */
/* PUBLIC LIVE SCHEDULE — model's recurring weekly slots               */
/* ------------------------------------------------------------------ */

// Next occurrences of a weekly slot within the next 7 days (unix ms)
function upcomingSlotTimes(dayOfWeek, startTime, daysOut) {
  const out = [];
  const [hh, mm] = String(startTime).split(':').map((x) => parseInt(x) || 0);
  const now = new Date();
  for (let d = 0; d <= (daysOut == null ? 7 : daysOut); d++) {
    const dt = new Date(now.getTime() + d * 24 * 60 * 60 * 1000);
    if (dt.getDay() === dayOfWeek) {
      dt.setHours(hh, mm, 0, 0);
      if (dt.getTime() > Date.now()) out.push(dt.getTime());
    }
  }
  return out;
}

// Model: list her weekly schedule slots
app.get('/api/model/schedule', identMiddleware, requireUser, requireRole('model'), (req, res) => {
  const slots = db.prepare('SELECT * FROM live_schedule WHERE model_id = ? ORDER BY day_of_week, start_time')
    .all(req.user.id);
  res.json({ slots });
});

// Model: add a weekly schedule slot
app.post('/api/model/schedule', identMiddleware, requireUser, requireRole('model'), (req, res) => {
  const day = parseInt(req.body.day_of_week);
  const time = String(req.body.start_time || '').slice(0, 5);
  const title = String(req.body.title || '').trim().slice(0, 60);
  if (!Number.isInteger(day) || day < 0 || day > 6)
    return res.status(400).json({ error: 'bad_day' });
  if (!/^\d{2}:\d{2}$/.test(time))
    return res.status(400).json({ error: 'bad_time' });
  const dup = db.prepare(`SELECT 1 FROM live_schedule
    WHERE model_id = ? AND day_of_week = ? AND start_time = ?`)
    .get(req.user.id, day, time);
  if (dup) return res.status(409).json({ error: 'duplicate' });
  const info = db.prepare(`INSERT INTO live_schedule (model_id, day_of_week, start_time, title)
    VALUES (?,?,?,?)`).run(req.user.id, day, time, title);
  res.json({ ok: true, id: Number(info.lastInsertRowid) });
});

// Model: delete a schedule slot
app.delete('/api/model/schedule/:id', identMiddleware, requireUser, requireRole('model'), (req, res) => {
  const s = db.prepare('SELECT * FROM live_schedule WHERE id = ?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not_found' });
  if (s.model_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });
  db.prepare('DELETE FROM live_schedule WHERE id = ?').run(s.id);
  res.json({ ok: true });
});

// Public: upcoming scheduled lives across models (next 7 days)
app.get('/api/live/schedule', (req, res) => {
  const slots = db.prepare(`
    SELECT ls.*, u.display_name AS model_name, m.photo_url, m.is_online
    FROM live_schedule ls
    JOIN users u ON u.id = ls.model_id
    JOIN models m ON m.user_id = ls.model_id
    WHERE u.banned = 0 AND u.role = 'model'`).all();
  const out = [];
  for (const s of slots) {
    for (const at of upcomingSlotTimes(s.day_of_week, s.start_time, 7)) {
      out.push({ model_id: s.model_id, model_name: s.model_name,
        photo_url: s.photo_url || '', is_online: !!s.is_online,
        title: s.title || '', starts_at: at,
        day_label: new Date(at).toLocaleDateString('en-US', { weekday: 'short' }),
        time_label: new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) });
    }
  }
  out.sort((a, b) => a.starts_at - b.starts_at);
  res.json({ upcoming: out.slice(0, 50) });
});

// GET the live crown race: top-3 spenders of THIS session. Everything a fan
// spends with her while the live runs counts — gifts, tips, stage joins,
// explicit minutes/entries, priority messages (windowed to the session).
app.get('/api/live/:id/leaderboard', identMiddleware, requireUser, (req, res) => {
  const sess = db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(req.params.id);
  if (!sess) return res.status(404).json({ error: 'not_found' });
  const top = db.prepare(`
    SELECT t.fan_id, u.display_name AS fan_name,
           SUM(t.gross_cents) AS total_cents,
           SUM(CASE WHEN t.gross_cents > 0 THEN 1 ELSE 0 END) AS gift_count
    FROM transactions t JOIN users u ON u.id = t.fan_id
    WHERE t.model_id = ? AND t.is_test = 0 AND t.fan_id IS NOT NULL
      AND t.created_at >= ?
      AND (t.type LIKE 'live%' OR t.type LIKE 'priority%'
           OR t.type IN ('gift', 'tip', 'tip_menu'))
    GROUP BY t.fan_id HAVING total_cents > 0
    ORDER BY total_cents DESC LIMIT 3`).all(sess.model_id, sess.started_at);
  const totals = db.prepare(`
    SELECT COALESCE(SUM(gross_cents),0) AS gift_cents, COUNT(*) AS gift_count
    FROM gift_events WHERE session_id = ?`).get(sess.id);
  res.json({ top, totals });
});

// Admin: live sessions + blur event log
app.get('/api/admin/live', ...adminOnly, (req, res) => {
  const sessions = db.prepare(`
    SELECT ls.*, u.display_name AS model_name,
           (SELECT COUNT(*) FROM live_viewers WHERE session_id = ls.id) AS viewers,
           (SELECT COUNT(*) FROM live_viewers WHERE session_id = ls.id AND is_paying = 1) AS paying_viewers,
           (SELECT COALESCE(SUM(gross_cents),0) FROM gift_events WHERE session_id = ls.id) AS gift_cents,
           (SELECT COUNT(*) FROM gift_events WHERE session_id = ls.id) AS gift_count,
           (SELECT COALESCE(SUM(amount_cents),0) FROM priority_messages WHERE session_id = ls.id) AS priority_cents,
           (SELECT COUNT(*) FROM priority_messages WHERE session_id = ls.id) AS priority_count,
           (SELECT COALESCE(SUM(CASE WHEN is_explicit = 1 THEN ${EXPLICIT_JOIN_FEE_CENTS} ELSE ${JOIN_FEE_CENTS} END),0)
              FROM live_join_requests WHERE session_id = ls.id
              AND status IN ('approved','dropped')) AS join_cents,
           (SELECT COUNT(*) FROM live_join_requests WHERE session_id = ls.id
              AND status IN ('approved','dropped')) AS join_count
    FROM live_sessions ls JOIN users u ON u.id = ls.model_id
    ORDER BY ls.id DESC LIMIT 50`).all();
  const events = db.prepare(`
    SELECT b.*, u.display_name AS fan_name, um.display_name AS model_name
    FROM blur_events b
    JOIN live_sessions ls ON ls.id = b.session_id
    JOIN users um ON um.id = ls.model_id
    LEFT JOIN users u ON u.id = b.fan_id
    ORDER BY b.id DESC LIMIT 100`).all();
  res.json({ sessions, events });
});

// Admin: group stream chat safety flags
app.get('/api/admin/safety/stream-flags', ...adminOnly, (req, res) => {
  const rows = db.prepare(`
    SELECT f.*, um.display_name AS model_name
    FROM stream_flags f JOIN live_sessions ls ON ls.id = f.session_id
    JOIN users um ON um.id = ls.model_id
    ORDER BY f.id DESC LIMIT 100`).all();
  res.json({ flags: rows });
});

/* ---- Virtual gift catalog (admin-editable) ---- */

/* Admin — fan Suggestion Box triage (Manager 💡 Suggestions screen) */
app.get('/api/admin/suggestions', ...adminOnly, (req, res) => {
  const suggestions = db.prepare(
    'SELECT id, user_id, username, body, status, created_at FROM suggestions ORDER BY id DESC LIMIT 100'
  ).all();
  res.json({ suggestions });
});

app.post('/api/admin/suggestions/:id/status', ...adminOnly, (req, res) => {
  const status = String((req.body && req.body.status) || '');
  if (!['new', 'read', 'done'].includes(status))
    return res.status(400).json({ error: 'bad_status', message: "Status must be 'new', 'read' or 'done'." });
  const info = db.prepare('UPDATE suggestions SET status = ? WHERE id = ?')
    .run(status, Number(req.params.id));
  if (!info.changes) return res.status(404).json({ error: 'not_found', message: 'No such suggestion.' });
  res.json({ ok: true, status });
});

app.get('/api/admin/gifts', ...adminOnly, (req, res) => {
  res.json({ gifts: db.prepare('SELECT * FROM gifts ORDER BY sort_order, price_cents').all() });
});

app.post('/api/admin/gifts', ...adminOnly, (req, res) => {
  const { emoji, name, price_cents } = req.body || {};
  if (!emoji || !name || !Number.isInteger(price_cents) || price_cents <= 0)
    return res.status(400).json({ error: 'bad_fields' });
  const maxSort = db.prepare('SELECT COALESCE(MAX(sort_order),-1) AS m FROM gifts').get().m;
  const info = db.prepare('INSERT INTO gifts (emoji, name, price_cents, sort_order) VALUES (?,?,?,?)')
    .run(String(emoji).slice(0, 8), String(name).slice(0, 30), price_cents, maxSort + 1);
  res.json({ ok: true, id: Number(info.lastInsertRowid) });
});

app.put('/api/admin/gifts/:id', ...adminOnly, (req, res) => {
  const g = db.prepare('SELECT * FROM gifts WHERE id = ?').get(req.params.id);
  if (!g) return res.status(404).json({ error: 'not_found' });
  const { emoji, name, price_cents, enabled, sort_order } = req.body || {};
  const upd = [], params = [];
  if (typeof emoji === 'string' && emoji.trim()) { upd.push('emoji = ?'); params.push(emoji.trim().slice(0, 8)); }
  if (typeof name === 'string' && name.trim()) { upd.push('name = ?'); params.push(name.trim().slice(0, 30)); }
  if (Number.isInteger(price_cents) && price_cents > 0) { upd.push('price_cents = ?'); params.push(price_cents); }
  if (enabled === 0 || enabled === 1) { upd.push('enabled = ?'); params.push(enabled); }
  if (Number.isInteger(sort_order)) { upd.push('sort_order = ?'); params.push(sort_order); }
  if (upd.length) { params.push(g.id); db.prepare(`UPDATE gifts SET ${upd.join(', ')} WHERE id = ?`).run(...params); }
  res.json({ ok: true });
});

app.delete('/api/admin/gifts/:id', ...adminOnly, (req, res) => {
  db.prepare('DELETE FROM gifts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

/* Admin — moderator dashboard + safety monitor (adminOnly defined above, before live section) */

/* Money on the Manager reads ONE ruler: the transactions ledger, with the
   same filters for every window, so the cards always reconcile —
   gross = model + platform + recruiter, per window, by construction.
   The platform_stats earnings counter is NOT used here (it's all-time,
   cumulative, and drifts from the ledger). */

/* Start of today in America/Chicago as a SQLite UTC timestamp string
   ('YYYY-MM-DD HH:MM:SS', the transactions.created_at format). The Chicago
   offset is resolved at the target date and iterated, so DST transition
   days stay correct. */
function chicagoStartOfDaySql(now = new Date()) {
  const tz = 'America/Chicago';
  const dayFmt = new Intl.DateTimeFormat('en-US',
    { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const dp = Object.fromEntries(dayFmt.formatToParts(now).map((p) => [p.type, p.value]));
  const y = +dp.year, m = +dp.month, d = +dp.day;
  const fullFmt = new Intl.DateTimeFormat('en-US',
    { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const offsetAt = (date) => {
    const p = Object.fromEntries(fullFmt.formatToParts(date).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second)
      - Math.floor(date.getTime() / 1000) * 1000;
  };
  let utcMs = Date.UTC(y, m - 1, d, 0, 0, 0);
  for (let i = 0; i < 3; i++) utcMs = Date.UTC(y, m - 1, d, 0, 0, 0) - offsetAt(new Date(utcMs));
  return new Date(utcMs).toISOString().slice(0, 19).replace('T', ' ');
}

/* Slut Manager — Overview aggregates for the Manager home screen */
app.get('/api/admin/overview', ...adminOnly, (req, res) => {
  const row = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM id_verifications WHERE status = 'pending') AS pending_id_reviews,
      (SELECT COUNT(*) FROM live_sessions WHERE status = 'live') AS live_now,
      (SELECT COUNT(*) FROM users WHERE role = 'fan' AND banned = 0) AS fans,
      (SELECT COUNT(*) FROM users WHERE role = 'model' AND banned = 0) AS models,
      (SELECT COUNT(*) FROM dmca_notices WHERE status IN ('received','under_review')) AS open_dmca,
      (SELECT COUNT(*) FROM safety_incidents WHERE status = 'open') AS open_incidents`).get();
  const LEDGER_SUM = `
    SELECT COALESCE(SUM(gross_cents),0) AS gross_cents,
           COALESCE(SUM(model_cents),0) AS model_cents,
           COALESCE(SUM(platform_cents),0) AS platform_cents,
           COALESCE(SUM(recruiter_cents),0) AS recruiter_cents
    FROM transactions
    WHERE is_test = 0 AND type IN ('message','call','tip','ppv','voice','live_explicit','gift','game')`;
  const today = db.prepare(LEDGER_SUM + ' AND created_at >= ?').get(chicagoStartOfDaySql());
  const allTime = db.prepare(LEDGER_SUM).get();
  res.json({ ...row, gross_today_cents: today.gross_cents, today, all_time: allTime });
});

app.get('/api/admin/stats', ...adminOnly, (req, res) => {
  const stats = db.prepare('SELECT * FROM platform_stats WHERE id = 1').get();
  const counts = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM users WHERE role = 'fan' AND banned = 0) AS fans,
      (SELECT COUNT(*) FROM users WHERE role = 'model' AND banned = 0) AS models,
      (SELECT COUNT(*) FROM models m JOIN users u ON u.id = m.user_id
        WHERE (CASE u.presence_override WHEN 'on' THEN 1 WHEN 'off' THEN 0 ELSE m.is_online END) = 1) AS models_online,
      (SELECT COUNT(*) FROM conversations) AS conversations,
      (SELECT COUNT(*) FROM calls WHERE status = 'active') AS active_calls,
      (SELECT COUNT(*) FROM safety_incidents WHERE status = 'open') AS open_incidents,
      (SELECT COUNT(*) FROM strikes WHERE flagged = 1) AS flagged_accounts,
      (SELECT COUNT(*) FROM dmca_notices WHERE status IN ('received','under_review')) AS open_dmca,
      (SELECT COALESCE(SUM(gross_cents),0) FROM transactions
        WHERE is_test = 0 AND type IN ('message','call','tip','ppv','voice','live_explicit','gift','game')) AS gross_volume_cents`).get();
  res.json({ ...stats, ...counts });
});

app.get('/api/admin/conversations', ...adminOnly, (req, res) => {
  const convs = db.prepare(`
    SELECT c.*, uf.display_name AS fan_name, um.display_name AS model_name
    FROM conversations c
    LEFT JOIN users uf ON uf.id = c.fan_id
    JOIN users um ON um.id = c.model_id
    ORDER BY c.updated_at DESC LIMIT 100`).all();
  res.json({ conversations: convs.map((c) => {
    const last = db.prepare(
      `SELECT m.*, COALESCE(u.display_name,'Guest Fan') AS sender_name
       FROM messages m LEFT JOIN users u ON u.id = m.sender_id
       WHERE m.conversation_id = ? ORDER BY m.id DESC LIMIT 1`).get(c.id);
    const n = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(c.id).n;
    return { id: c.id, fan_name: c.fan_name || 'Guest Fan', model_name: c.model_name,
             is_guest: !c.fan_id, is_paused: !!c.is_paused,
             message_count: n, last_message: last, updated_at: c.updated_at };
  }) });
});

// Manual pause / resume
app.post('/api/admin/conversations/:id/pause', ...adminOnly, (req, res) => {
  db.prepare('UPDATE conversations SET is_paused = 1 WHERE id = ?').run(req.params.id);
  const c = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id);
  const keys = [`u:${c.model_id}`, c.fan_id ? `u:${c.fan_id}` : `g:${c.guest_token}`];
  keys.forEach((k) => pushToSubject(k, { type: 'chat:paused', conversation_id: c.id,
    warning: '⚠️ This chat was paused by the moderator.' }));
  res.json({ ok: true });
});
app.post('/api/admin/conversations/:id/resume', ...adminOnly, (req, res) => {
  db.prepare('UPDATE conversations SET is_paused = 0 WHERE id = ?').run(req.params.id);
  const c = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id);
  const keys = [`u:${c.model_id}`, c.fan_id ? `u:${c.fan_id}` : `g:${c.guest_token}`];
  keys.forEach((k) => pushToSubject(k, { type: 'chat:resumed', conversation_id: c.id }));
  res.json({ ok: true });
});

/* ---- safety incidents ---- */

app.get('/api/admin/safety/incidents', ...adminOnly, (req, res) => {
  const status = req.query.status || 'open';
  const rows = db.prepare(`
    SELECT s.*, um.display_name AS model_name
    FROM safety_incidents s JOIN conversations c ON c.id = s.conversation_id
    JOIN users um ON um.id = c.model_id
    WHERE s.status = ? ORDER BY s.id DESC LIMIT 100`).all(status);
  const withStrikes = rows.map((r) => {
    const key = r.sender_id ? `u:${r.sender_id}` : `g:${r.guest_token}`;
    const st = db.prepare('SELECT strikes, flagged FROM strikes WHERE subject_key = ?').get(key);
    return { ...r, strikes: st ? st.strikes : 0, flagged: st ? !!st.flagged : false };
  });
  res.json({ incidents: withStrikes });
});

app.post('/api/admin/safety/incidents/:id/resolve', ...adminOnly, (req, res) => {
  // action: 'resume' (unpause chat + close) or 'dismiss' (close, chat stays paused)
  const { action } = req.body || {};
  const inc = db.prepare('SELECT * FROM safety_incidents WHERE id = ?').get(req.params.id);
  if (!inc) return res.status(404).json({ error: 'not_found' });
  db.prepare(`UPDATE safety_incidents SET status = 'resolved' WHERE id = ?`).run(inc.id);
  if (action === 'resume') {
    db.prepare('UPDATE conversations SET is_paused = 0 WHERE id = ?').run(inc.conversation_id);
    const c = db.prepare('SELECT * FROM conversations WHERE id = ?').get(inc.conversation_id);
    const keys = [`u:${c.model_id}`, c.fan_id ? `u:${c.fan_id}` : `g:${c.guest_token}`];
    keys.forEach((k) => pushToSubject(k, { type: 'chat:resumed', conversation_id: c.id }));
  }
  res.json({ ok: true });
});

app.get('/api/admin/safety/strikes', ...adminOnly, (req, res) => {
  const rows = db.prepare('SELECT * FROM strikes ORDER BY flagged DESC, strikes DESC LIMIT 100').all();
  res.json({ strikes: rows.map((r) => {
    let name = r.subject_key;
    if (r.subject_key.startsWith('u:')) {
      const u = db.prepare('SELECT display_name, role FROM users WHERE id = ?')
        .get(r.subject_key.slice(2));
      if (u) name = `${u.display_name} (${u.role})`;
    } else name = `Guest ${r.subject_key.slice(2, 10)}…`;
    return { ...r, name, flagged: !!r.flagged };
  }) });
});

// Keyword list management
app.get('/api/admin/safety/keywords', ...adminOnly, (req, res) => {
  res.json({ keywords: db.prepare('SELECT * FROM safety_keywords ORDER BY keyword').all() });
});
app.post('/api/admin/safety/keywords', ...adminOnly, (req, res) => {
  const kw = (req.body.keyword || '').trim().toLowerCase().slice(0, 60);
  if (!kw) return res.status(400).json({ error: 'empty_keyword' });
  try {
    const info = db.prepare('INSERT INTO safety_keywords (keyword) VALUES (?)').run(kw);
    res.json({ ok: true, id: Number(info.lastInsertRowid) });
  } catch { res.status(409).json({ error: 'duplicate' }); }
});
app.put('/api/admin/safety/keywords/:id', ...adminOnly, (req, res) => {
  const enabled = req.body.enabled ? 1 : 0;
  db.prepare('UPDATE safety_keywords SET enabled = ? WHERE id = ?').run(enabled, req.params.id);
  res.json({ ok: true });
});
app.delete('/api/admin/safety/keywords/:id', ...adminOnly, (req, res) => {
  db.prepare('DELETE FROM safety_keywords WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Ban a guest token outright
app.post('/api/admin/safety/ban-guest', ...adminOnly, (req, res) => {
  const t = req.body.guest_token;
  if (!t || !/^[a-f0-9]{32}$/.test(t)) return res.status(400).json({ error: 'bad_token' });
  bannedGuests.add(t);
  res.json({ ok: true });
});

/* ---- model / fan / payout / settings management (unchanged logic) ---- */

app.get('/api/admin/models', ...adminOnly, (req, res) => {
  res.json({ models: db.prepare(`
    SELECT u.id, u.username, u.display_name, u.banned, u.created_at, u.presence_override,
           m.bio, m.per_message_cents, m.per_minute_cents, m.is_online, m.photo_url, m.is_hidden, m.is_featured,
           r.name AS recruiter_name,
           w.earnings_cents, w.paid_out_cents,
           (w.earnings_cents - w.paid_out_cents) AS pending_cents
    FROM users u JOIN models m ON m.user_id = u.id JOIN wallets w ON w.user_id = u.id
    LEFT JOIN recruiters r ON r.id = m.recruiter_id
    WHERE u.role = 'model' ORDER BY u.display_name`).all() });
});


// Admin (moderator) → model inbox: read the mod thread with one model.
// The thread is the conversation where the admin is the fan-side party —
// the same one the automatic welcome message lands in.
app.get('/api/admin/models/:id/thread', ...adminOnly, (req, res) => {
  const m = db.prepare("SELECT id, display_name FROM users WHERE id = ? AND role = 'model'").get(req.params.id);
  if (!m) return res.status(404).json({ error: 'not_found' });
  const conv = db.prepare('SELECT id FROM conversations WHERE fan_id = ? AND model_id = ?').get(req.user.id, m.id);
  if (!conv) return res.json({ conversation_id: null, messages: [] });
  db.prepare('UPDATE messages SET is_read = 1 WHERE conversation_id = ? AND sender_id = ?').run(conv.id, m.id);
  const messages = db.prepare(`
    SELECT msg.id, msg.body, msg.created_at, msg.sender_id,
           CASE WHEN msg.sender_id = ? THEN 'You (Admin)' ELSE ? END AS sender_name
    FROM messages msg WHERE msg.conversation_id = ? ORDER BY msg.id ASC LIMIT 200`)
    .all(req.user.id, m.display_name, conv.id);
  res.json({ conversation_id: conv.id, messages });
});

// Admin (moderator) → model inbox: text a model as Asce (Admin).
// Lands in her app inbox with a bell notification. Always free.
app.post('/api/admin/models/:id/message', ...adminOnly, (req, res) => {
  const m = db.prepare("SELECT id, display_name FROM users WHERE id = ? AND role = 'model'").get(req.params.id);
  if (!m) return res.status(404).json({ error: 'not_found' });
  const body = String(req.body?.body || '').trim().slice(0, 2000);
  if (!body) return res.status(400).json({ error: 'empty', message: 'Write a message first.' });
  let conv = db.prepare('SELECT id FROM conversations WHERE fan_id = ? AND model_id = ?').get(req.user.id, m.id);
  if (!conv) {
    const info = db.prepare('INSERT INTO conversations (fan_id, model_id) VALUES (?,?)').run(req.user.id, m.id);
    conv = { id: Number(info.lastInsertRowid) };
  }
  const info = db.prepare('INSERT INTO messages (conversation_id, sender_id, body) VALUES (?,?,?)')
    .run(conv.id, req.user.id, body);
  db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?").run(conv.id);
  try { notifyUser(m.id, 'message', '💬 Asce (Admin)', body.slice(0, 90), `/#chat/${conv.id}`); } catch (e) { /* bell is a bonus */ }
  res.json({ ok: true, conversation_id: conv.id, message_id: Number(info.lastInsertRowid) });
});

// Admin: toggle featured (pinned to top) for a model
app.post('/api/admin/models/:id/feature', ...adminOnly, (req, res) => {
  const m = db.prepare("SELECT user_id FROM models WHERE user_id = ?").get(req.params.id);
  if (!m) return res.status(404).json({ error: 'not_found' });
  const val = req.body && req.body.featured === false ? 0 : 1;
  db.prepare('UPDATE models SET is_featured = ? WHERE user_id = ?').run(val, req.params.id);
  res.json({ ok: true, featured: !!val });
});

// Admin: per-model presence override — Auto (her own toggle decides) /
// Online (fans see her online even with her app closed) / Offline (fans see
// her offline even with her app open). DISPLAY ONLY: it never blocks her
// app, her messages, or going live; a live session stays listed as live.
app.post('/api/admin/models/:id/presence', ...adminOnly, (req, res) => {
  const mode = req.body && req.body.mode;
  if (!['auto', 'on', 'off'].includes(mode))
    return res.status(400).json({ error: 'bad_mode', message: "mode must be 'auto', 'on' or 'off'." });
  const u = db.prepare(`SELECT u.id, u.role, u.presence_override, m.is_online, m.is_featured
    FROM users u LEFT JOIN models m ON m.user_id = u.id WHERE u.id = ?`).get(req.params.id);
  if (!u || u.role !== 'model') return res.status(404).json({ error: 'not_found' });
  if (u.is_featured)
    return res.status(400).json({ error: 'featured_account', message: 'The featured system account has no presence control.' });
  db.prepare('UPDATE users SET presence_override = ? WHERE id = ?').run(mode, u.id);
  res.json({ id: u.id, presence_override: mode, online: effectiveOnline(mode, u.is_online) });
});

app.post('/api/admin/models', ...adminOnly, (req, res) => {
  const { username, password, display_name, bio, per_message_cents, per_minute_cents } = req.body || {};
  if (!username || !password || !display_name)
    return res.status(400).json({ error: 'missing_fields' });
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username.trim()))
    return res.status(409).json({ error: 'username_taken' });
  // Admin-added models skip the public age gate — Corry verifies ID in person
  // (2257). Real DOB lives on her ID verification record, never a placeholder.
  const id = createUser(username.trim(), password, 'model', display_name.trim().slice(0, 40), null, signupLanguage(req));
  db.prepare(`UPDATE models SET bio = ?, per_message_cents = ?, per_minute_cents = ? WHERE user_id = ?`)
    .run((bio || '').slice(0, 280),
         Number.isInteger(per_message_cents) ? per_message_cents : 149,
         Number.isInteger(per_minute_cents) ? per_minute_cents : 399, id);
  res.json({ ok: true, id });
});

app.put('/api/admin/models/:id', ...adminOnly, (req, res) => {
  const { display_name, bio, per_message_cents, per_minute_cents, is_online, banned, is_hidden } = req.body || {};
  const u = db.prepare(`SELECT * FROM users WHERE id = ? AND role = 'model'`).get(req.params.id);
  if (!u) return res.status(404).json({ error: 'not_found' });
  if (typeof display_name === 'string' && display_name.trim())
    db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(display_name.trim().slice(0, 40), u.id);
  if (banned === 0 || banned === 1)
    db.prepare('UPDATE users SET banned = ? WHERE id = ?').run(banned, u.id);
  const upd = [], params = [];
  if (typeof bio === 'string') { upd.push('bio = ?'); params.push(bio.slice(0, 280)); }
  if (Number.isInteger(per_message_cents) && per_message_cents >= 0) { upd.push('per_message_cents = ?'); params.push(per_message_cents); }
  if (Number.isInteger(per_minute_cents) && per_minute_cents >= 0) { upd.push('per_minute_cents = ?'); params.push(per_minute_cents); }
  if (is_online === 0 || is_online === 1) { upd.push('is_online = ?'); params.push(is_online); }
  if (is_hidden === 0 || is_hidden === 1) { upd.push('is_hidden = ?'); params.push(is_hidden); }
  if (upd.length) { params.push(u.id); db.prepare(`UPDATE models SET ${upd.join(', ')} WHERE user_id = ?`).run(...params); }
  res.json({ ok: true });
});

// Admin resets a model's password (Corry Oct 14, 2026): she forgot it →
// he types a new one, or sends none and gets a generated temp password to
// hand her. All her live sessions die with the old password.
app.post('/api/admin/models/:id/reset-password', ...adminOnly, (req, res) => {
  const u = db.prepare(`SELECT * FROM users WHERE id = ? AND role = 'model'`).get(req.params.id);
  if (!u) return res.status(404).json({ error: 'not_found' });
  let { password } = req.body || {};
  let generated = false;
  if (typeof password !== 'string' || !password.trim()) {
    const alpha = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
    password = Array.from(crypto.randomBytes(10)).map((n) => alpha[n % alpha.length]).join('');
    generated = true;
  }
  password = password.trim();
  if (password.length < 6) return res.status(400).json({ error: 'password_too_short' });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), u.id);
  deleteUserSessions(u.id);
  res.json({ ok: true, generated, ...(generated ? { password } : {}) });
});

app.delete('/api/admin/models/:id', ...adminOnly, (req, res) => {
  const u = db.prepare(`SELECT * FROM users WHERE id = ? AND role = 'model'`).get(req.params.id);
  if (!u) return res.status(404).json({ error: 'not_found' });
  const uid = u.id;
  const tableExists = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(t);
  const countWhere = (t, c, val) => tableExists(t)
    ? db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${c} = ?`).get(val).n : 0;
  try {
    // ---- MONEY IS SACRED (owner rule: "Never delete the money") ----
    // Any earnings/payment history refuses the removal WHOLE — the account
    // stays fully intact and the Manager steers the admin to Deactivate.
    const MONEY_REFS = [
      ['transactions', ['model_id', 'fan_id']],
      ['withdrawals', ['model_id']],
      ['refunds', ['model_id', 'user_id']],
      ['bookings', ['model_id', 'fan_id']],
      ['calls', ['model_id', 'fan_id']],
      ['facetime_requests', ['model_id', 'fan_id']],
      ['game_requests', ['model_id', 'fan_id']],
      ['gift_sends', ['model_id', 'fan_id']],
      ['tip_sends', ['model_id', 'fan_id']],
      ['purchase_attempts', ['user_id']],
      ['crypto_invoices', ['user_id']],
      ['ccbill_orders', ['user_id']],
    ];
    let moneyHits = 0;
    for (const [t, cols] of MONEY_REFS) for (const c of cols) moneyHits += countWhere(t, c, uid);
    // Her wallet's lifetime counters are money history too.
    if (tableExists('wallets')) {
      const w = db.prepare('SELECT credits_cents, earnings_cents, paid_out_cents FROM wallets WHERE user_id = ?').get(uid);
      if (w && (w.credits_cents || w.earnings_cents || w.paid_out_cents)) moneyHits++;
    }
    // Money hanging off her live sessions (gifts / paid priority messages).
    for (const t of ['gift_events', 'priority_messages']) {
      if (tableExists(t) && tableExists('live_sessions')) {
        moneyHits += db.prepare(
          `SELECT COUNT(*) AS n FROM ${t} WHERE session_id IN (SELECT id FROM live_sessions WHERE model_id = ?)`).get(uid).n;
      }
    }
    // Her recruiter commissions live on OTHER models' transactions.
    const rec = tableExists('recruiters') ? db.prepare('SELECT id FROM recruiters WHERE user_id = ?').get(uid) : null;
    if (rec) moneyHits += countWhere('transactions', 'recruiter_id', rec.id);
    if (moneyHits > 0) {
      return res.status(409).json({ error: 'has_money_history',
        message: `${u.display_name} has earnings/payment history, so she can't be removed — Deactivate her instead. Money records are never deleted.` });
    }

    // ---- Enumerate every column in the LIVE schema that points at users ----
    // Declared FKs (PRAGMA foreign_key_list) UNION legacy user columns that
    // predate FK declarations (notifications.user_id, follows.*, …), so the
    // list is drawn from the schema itself and can never rot. Money tables
    // are excluded from the sweep as defense-in-depth (the guard above has
    // already proven zero rows reference her there).
    const moneyTables = new Set(MONEY_REFS.map(([t]) => t));
    const pairs = new Map();
    const allTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'users'").all().map(r => r.name);
    for (const t of allTables) {
      if (moneyTables.has(t)) continue;
      for (const fk of db.prepare(`PRAGMA foreign_key_list(${t})`).all())
        if (fk.table === 'users') pairs.set(`${t}.${fk.from}`, { t, c: fk.from });
      for (const col of db.prepare(`PRAGMA table_info(${t})`).all())
        if (['user_id', 'model_id', 'fan_id', 'sender_id'].includes(col.name)) pairs.set(`${t}.${col.name}`, { t, c: col.name });
    }

    db.exec('BEGIN IMMEDIATE');
    try {
      // Cross-references BETWEEN her child rows (messages in her threads,
      // calls on her bookings, …) resolve at COMMIT, so sweep order is free.
      db.exec('PRAGMA defer_foreign_keys = ON');
      // Her conversation threads go entirely — including the OTHER side's
      // messages/media in them (a thread belongs to her account).
      const convIds = db.prepare('SELECT id FROM conversations WHERE fan_id = ? OR model_id = ?').all(uid, uid).map(r => r.id);
      if (convIds.length) {
        const ph = convIds.map(() => '?').join(',');
        for (const t of ['messages', 'media_items', 'safety_incidents'])
          if (tableExists(t)) db.prepare(`DELETE FROM ${t} WHERE conversation_id IN (${ph})`).run(...convIds);
      }
      for (const { t, c } of pairs.values())
        db.prepare(`DELETE FROM ${t} WHERE ${c} = ?`).run(uid);
      db.prepare('DELETE FROM users WHERE id = ?').run(uid);
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
      throw e;
    }
    deleteUserSessions(uid);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'delete_failed', message: 'Remove failed: ' + e.message });
  }
});

// Admin sets a model's profile photo
app.post('/api/admin/models/:id/photo', ...adminOnly, photoUpload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_photo' });
  const u = db.prepare(`SELECT * FROM users WHERE id = ? AND role = 'model'`).get(req.params.id);
  if (!u) {
    try { fs.unlinkSync(req.file.path); } catch (e) { /* ignore */ }
    return res.status(404).json({ error: 'not_found' });
  }
  res.json({ ok: true, photo_url: setModelPhoto(u.id, req.file) });
});

/* ---- Model invite links ---- */

// Public: validate an invite code (for the invite landing page)
app.get('/api/invite/:code', (req, res) => {
  const inv = db.prepare('SELECT code, label, is_revoked, used_by FROM invite_links WHERE code = ?')
    .get(req.params.code);
  if (!inv || inv.is_revoked || inv.used_by)
    return res.json({ valid: false });
  res.json({ valid: true, label: inv.label });
});

// Public: validate a partner referral code
app.get('/api/referral/:code', (req, res) => {
  const r = db.prepare(`SELECT r.referral_code, r.name AS recruiter_name, u.banned
                        FROM recruiters r JOIN users u ON u.id = r.user_id
                        WHERE r.referral_code = ?`).get(String(req.params.code).trim());
  if (!r || r.banned) return res.json({ valid: false });
  res.json({ valid: true, recruiter_name: r.recruiter_name });
});

// Admin: generate a new invite link
app.post('/api/admin/invites', ...adminOnly, (req, res) => {
  const label = (req.body.label || '').trim().slice(0, 60);
  const role = req.body.role === 'recruiter' ? 'recruiter' : 'model';
  const code = crypto.randomBytes(9).toString('hex'); // 18-char code
  const info = db.prepare(
    'INSERT INTO invite_links (code, label, role, created_by) VALUES (?,?,?,?)'
  ).run(code, label, role, req.user.id);
  const base = req.body.base_url ? String(req.body.base_url).replace(/\/$/, '') : '';
  const urlPath = role === 'recruiter' ? `/affiliate/${code}` : `/?invite=${code}`;
  res.json({ ok: true, id: Number(info.lastInsertRowid), code, label, role,
    url: base ? `${base}${urlPath}` : urlPath });
});

// Admin: list all invite links with usage status
app.get('/api/admin/invites', ...adminOnly, (req, res) => {
  const rows = db.prepare(`
    SELECT i.*, u.display_name AS used_by_name, u.username AS used_by_username,
           u.banned AS used_by_banned
    FROM invite_links i LEFT JOIN users u ON u.id = i.used_by
    ORDER BY i.id DESC`).all();
  const cleanupCount = db.prepare(
    `SELECT COUNT(*) AS n FROM invite_links
     WHERE used_at IS NULL OR expires_at < datetime('now')`).get().n;
  res.json({ cleanup_count: cleanupCount, invites: rows.map((r) => ({
    id: r.id, code: r.code, label: r.label, role: r.role || 'model',
    is_revoked: !!r.is_revoked, created_at: r.created_at, used_at: r.used_at,
    expires_at: r.expires_at,
    expired: !r.used_by && r.expires_at && new Date(r.expires_at + 'Z') < new Date(),
    used_by: r.used_by ? { id: r.used_by, display_name: r.used_by_name,
      username: r.used_by_username, banned: !!r.used_by_banned } : null,
  })) });
});

// Admin: revoke an invite link. If it was already used, optionally deactivate the model.
app.post('/api/admin/invites/:id/revoke', ...adminOnly, (req, res) => {
  const inv = db.prepare('SELECT * FROM invite_links WHERE id = ?').get(req.params.id);
  if (!inv) return res.status(404).json({ error: 'not_found' });
  db.prepare('UPDATE invite_links SET is_revoked = 1 WHERE id = ?').run(inv.id);
  let modelDeactivated = false;
  if (req.body.deactivate_model && inv.used_by) {
    db.prepare(`UPDATE users SET banned = 1 WHERE id = ? AND role = 'model'`).run(inv.used_by);
    modelDeactivated = true;
  }
  res.json({ ok: true, model_deactivated: modelDeactivated });
});

// Admin: refresh an invite link — SAME code, fresh 6-hour window.
// For when a model took too long to sign up and her link expired (or is about to).
// The link she already has keeps working; no new link needs to be sent.
app.post('/api/admin/invites/:id/refresh', ...adminOnly, (req, res) => {
  const inv = db.prepare('SELECT * FROM invite_links WHERE id = ?').get(req.params.id);
  if (!inv) return res.status(404).json({ error: 'not_found' });
  if (inv.is_revoked)
    return res.status(400).json({ error: 'revoked', message: 'This invite was revoked. Generate a new one instead.' });
  if (inv.used_by)
    return res.status(400).json({ error: 'already_used', message: 'This invite was already used to sign up.' });
  db.prepare(`UPDATE invite_links SET expires_at = datetime('now', '+6 hours') WHERE id = ?`).run(inv.id);
  const row = db.prepare('SELECT expires_at FROM invite_links WHERE id = ?').get(inv.id);
  res.json({ ok: true, id: inv.id, code: inv.code, expires_at: row.expires_at });
});

// Admin: bulk cleanup — delete every invite nobody used, plus every expired
// one (used or not), so dead links stop crowding the list. A used invite
// whose window is still open is kept (it's her signup history).
app.post('/api/admin/invites/cleanup', ...adminOnly, (req, res) => {
  const info = db.prepare(
    `DELETE FROM invite_links WHERE used_at IS NULL OR expires_at < datetime('now')`
  ).run();
  res.json({ ok: true, deleted: Number(info.changes) });
});

// Admin: delete one invite link outright. The link dies immediately — a
// signup attempt with its code afterwards fails as invalid. If she already
// signed up through it, only this history row goes; her account is untouched.
app.delete('/api/admin/invites/:id', ...adminOnly, (req, res) => {
  const inv = db.prepare('SELECT * FROM invite_links WHERE id = ?').get(req.params.id);
  if (!inv) return res.status(404).json({ error: 'not_found' });
  txn(() => db.prepare('DELETE FROM invite_links WHERE id = ?').run(inv.id));
  res.json({ ok: true, id: inv.id, was_used: !!inv.used_by });
});

/* ---------------- Recruiters / partners ---------------- */

// Admin: create a partner (recruiter) account + referral link
app.post('/api/admin/recruiters', ...adminOnly, (req, res) => {
  const { name, city, username, password } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'missing_fields' });
  const uname = (username || '').trim() || ('partner_' + crypto.randomBytes(3).toString('hex'));
  const pwd = (password && String(password).length >= 6) ? String(password) : crypto.randomBytes(6).toString('hex');
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(uname))
    return res.status(409).json({ error: 'username_taken' });
  const id = createUser(uname, pwd, 'recruiter', String(name).trim().slice(0, 40), null);
  let code;
  do { code = crypto.randomBytes(4).toString('hex'); }
  while (db.prepare('SELECT id FROM recruiters WHERE referral_code = ?').get(code));
  db.prepare('INSERT INTO recruiters (user_id, name, city, referral_code) VALUES (?,?,?,?)')
    .run(id, String(name).trim().slice(0, 40), String(city || '').trim().slice(0, 40), code);
  const rid = db.prepare('SELECT id FROM recruiters WHERE user_id = ?').get(id).id;
  const base = req.body.base_url ? String(req.body.base_url).replace(/\/$/, '') : '';
  res.json({ ok: true, id: rid, user_id: id, username: uname, password: pwd, referral_code: code,
    url: base ? `${base}/#join/${code}` : `/#join/${code}` });
});

// Admin: list partners with model counts and earnings
app.get('/api/admin/recruiters', ...adminOnly, (req, res) => {
  res.json({ recruiters: db.prepare(`
    SELECT r.id, r.name, r.city, r.referral_code, r.created_at,
           u.id AS user_id, u.username, u.display_name, u.banned,
           w.earnings_cents, w.paid_out_cents,
           (w.earnings_cents - w.paid_out_cents) AS pending_cents,
           (SELECT COUNT(*) FROM models m WHERE m.recruiter_id = r.id) AS model_count,
           (SELECT COALESCE(SUM(t.recruiter_cents), 0) FROM transactions t
             WHERE t.recruiter_id = r.id AND t.recruiter_cents > 0) AS total_earned_cents,
           (SELECT COALESCE(SUM(t.platform_cents), 0) FROM transactions t
             WHERE t.recruiter_id = r.id AND t.platform_cents > 0) AS corrys_cut_cents
    FROM recruiters r JOIN users u ON u.id = r.user_id JOIN wallets w ON w.user_id = u.id
    ORDER BY r.created_at DESC`).all() });
});

// Admin: remove a partner (their models stay; revenue reverts to Corry)
app.delete('/api/admin/recruiters/:id', ...adminOnly, (req, res) => {
  const r = db.prepare('SELECT * FROM recruiters WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'not_found' });
  db.prepare('DELETE FROM recruiters WHERE id = ?').run(r.id); // models.recruiter_id → NULL via FK
  db.prepare('UPDATE users SET banned = 1 WHERE id = ?').run(r.user_id);
  res.json({ ok: true });
});

// Admin: rename a recruiter (display name only — username/login unchanged)
// Accepts numeric id OR referral code as :id
app.patch('/api/admin/recruiters/:id', ...adminOnly, (req, res) => {
  let r = db.prepare('SELECT * FROM recruiters WHERE id = ?').get(req.params.id);
  if (!r) r = db.prepare('SELECT * FROM recruiters WHERE referral_code = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'not_found' });
  const name = String(req.body?.name || '').trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: 'missing_name' });
  db.prepare('UPDATE recruiters SET name = ? WHERE id = ?').run(name, r.id);
  db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(name, r.user_id);
  res.json({ ok: true, id: r.id, name });
});

// Admin: list name change requests
app.get('/api/admin/name-change-requests', ...adminOnly, (req, res) => {
  const status = req.query.status || 'pending';
  const rows = db.prepare(`
    SELECT r.*, u.display_name AS current_name, u.username, u.role
    FROM name_change_requests r JOIN users u ON u.id = r.user_id
    WHERE r.status = ? ORDER BY r.id DESC LIMIT 100`).all(status);
  res.json({ requests: rows });
});

// Admin: approve or reject a name change request
app.post('/api/admin/name-change-requests/:id', ...adminOnly, (req, res) => {
  const { action } = req.body || {};
  const r = db.prepare('SELECT * FROM name_change_requests WHERE id = ?').get(req.params.id);
  if (!r || r.status !== 'pending') return res.status(404).json({ error: 'not_found' });
  if (action === 'approve') {
    db.prepare(`UPDATE name_change_requests SET status = 'approved', resolved_at = datetime('now') WHERE id = ?`).run(r.id);
    db.prepare(`UPDATE users SET display_name = ?, name_changed_at = datetime('now') WHERE id = ?`)
      .run(r.requested_name, r.user_id);
    pushToSubject(`u:${r.user_id}`, { type: 'name_change:approved', new_name: r.requested_name });
  } else if (action === 'reject') {
    db.prepare(`UPDATE name_change_requests SET status = 'rejected', resolved_at = datetime('now') WHERE id = ?`).run(r.id);
    pushToSubject(`u:${r.user_id}`, { type: 'name_change:rejected', requested_name: r.requested_name });
  } else {
    return res.status(400).json({ error: 'bad_action' });
  }
  res.json({ ok: true, action });
});

// Recruiter: dashboard (own link, models, earnings)
app.get('/api/recruiter/dashboard', identMiddleware, requireUser, requireRole('recruiter'), (req, res) => {
  const r = db.prepare('SELECT * FROM recruiters WHERE user_id = ?').get(req.user.id);
  if (!r) return res.status(404).json({ error: 'not_found' });
  const models = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.created_at, u.banned, m.photo_url,
           w.earnings_cents AS model_earnings_cents,
           (SELECT COALESCE(SUM(t.gross_cents), 0) FROM transactions t
             WHERE t.model_id = u.id AND t.is_test = 0 AND t.gross_cents > 0) AS gross_generated_cents,
           (SELECT COALESCE(SUM(t.recruiter_cents), 0) FROM transactions t
             WHERE t.model_id = u.id AND t.is_test = 0 AND t.recruiter_cents > 0) AS my_cut_cents
    FROM users u JOIN models m ON m.user_id = u.id JOIN wallets w ON w.user_id = u.id
    WHERE m.recruiter_id = ? ORDER BY u.display_name`).all(r.id);
  const wallet = getWallet(req.user.id);
  const pending = db.prepare(`SELECT COALESCE(SUM(amount_cents), 0) AS s FROM withdrawals
                              WHERE model_id = ? AND status = 'pending'`).get(req.user.id).s;
  res.json({
    recruiter: { name: r.name, city: r.city, referral_code: r.referral_code },
    models,
    model_count: models.length,
    earnings_cents: wallet.earnings_cents,
    paid_out_cents: wallet.paid_out_cents,
    available_cents: getModelAvailable(req.user.id),
  });
});

/* ------------------------------------------------------------------ */
/* Crypto wallet loads (watch-only, see lib/crypto)                    */
/* Fan loads in USDT / BTC / ETH / SOL / XRP; watcher credits after    */
/* 1 confirmation. Admin: invoice list + manual mark-credited +        */
/* Crypto Treasury sweep.                                              */
/* ------------------------------------------------------------------ */
const { createCryptoService } = require('./lib/crypto');
const cryptoSvc = createCryptoService({ db, txn, notifyUser, packages: CREDIT_PACKAGES });

/* ---------------- CCBill card loads (FlexForms Dynamic Pricing) ---------------- */
const { createCcbillService } = require('./lib/ccbill');
const ccbillSvc = createCcbillService({ db, txn, notifyUser,
  // Payout protection hook: CCBill reversal events (chargeback / refund /
  // void) route into the clawback engine, idempotent on
  // (source, external_id). DORMANT until CCBill is integrated — the exact
  // live event names/fields must be confirmed against the real CCBill
  // account at integration time; until then the Manager's "Record
  // chargeback" action is the working entry point.
  onReversalEvent: ({ order, payload }) => applyChargeback({
    source: 'ccbill',
    external_id: payload.transactionId || payload.transaction_id
      || payload.subscriptionId || payload.subscription_id || `ccbill-order-${order.id}`,
    fan_id: order.user_id, load_ref: String(order.id),
    amount_cents: order.amount_cents,
    reason: `CCBill ${payload.eventType || payload.event_type || 'reversal'}`,
    recorded_by: null,
  }),
});

/* ---------------- Age verification (lib/av.js) ----------------
   Owner's design (Oct 16 2026): fans attest 18+ at the door as always;
   REAL verification fires exactly once, at the FIRST credit purchase,
   for fans in a regulated state (lib/av.js AV_STATES). Card buyers
   verify via the provider's transactional-data check; crypto buyers
   via its ID check. DORMANT unless AV_PROVIDER + AV_API_KEY are set —
   while dormant every purchase path behaves exactly as before (pinned
   by tests/av-gate.test.js) and the /api/av/* routes refuse. */
const avLib = require('./lib/av');
const avSvc = avLib.createAvService({ db });

/* The purchase gate. Returns a { status, body } to send when the
 * purchase must pause for verification, or null when it may proceed.
 * Runs BEFORE any order/invoice is created and before the fraud
 * velocity check (a verification pause is not a purchase attempt). */
function avPurchaseGate(req, method) {
  if (!avLib.enabled()) return null;
  const u = db.prepare('SELECT role, fan_state, av_verified_at FROM users WHERE id = ?')
    .get(req.user.id);
  if (!u) return null;
  const geo = geoOfReq(req);
  // Purchase-time state refresh: a US state resolved from THIS request
  // is the freshest fact we have — persist it over the signup value.
  if (geo && geo.country === 'US' && geo.state && geo.state !== u.fan_state) {
    db.prepare('UPDATE users SET fan_state = ? WHERE id = ?').run(geo.state, req.user.id);
    u.fan_state = geo.state;
  }
  const d = avLib.gateDecision({
    role: u.role, avVerifiedAt: u.av_verified_at,
    geoCountry: geo ? geo.country : null, geoState: geo ? geo.state : null,
    storedState: u.fan_state,
  });
  if (!d.gate) return null;
  return { status: 403, body: { error: 'av_required', method, state: d.state,
    message: "One quick age check before your first purchase — required by your state's law." } };
}

app.get('/api/av/status', identMiddleware, requireUser, (req, res) => {
  const u = db.prepare(`SELECT fan_state, av_verified_at, av_method, av_last_attested_at
                        FROM users WHERE id = ?`).get(req.user.id);
  res.json({
    enabled: avLib.enabled(),
    provider: avLib.providerName(),
    verified: !!(u && u.av_verified_at),
    verified_at: u ? u.av_verified_at : null,
    method: u ? u.av_method : null,
    state: u ? u.fan_state : null,
    last_attested_at: u ? u.av_last_attested_at : null,
  });
});

app.post('/api/av/start', identMiddleware, requireUser, requireRole('fan'), (req, res) => {
  if (!avLib.enabled()) return res.status(503).json({ error: 'av_not_configured' });
  const method = req.body && req.body.method === 'id' ? 'id' : 'transactional';
  try {
    const s = avSvc.createVerification({ userId: req.user.id, username: req.user.username, method });
    res.json(s);
  } catch (e) {
    if (e.code === 'av_not_configured') return res.status(503).json({ error: 'av_not_configured' });
    console.error('av: start failed —', e.message);
    res.status(500).json({ error: 'av_start_failed' });
  }
});

/* In-app completion step. The stub resolves here; a real provider's
 * result is resolved server-side by the adapter — a client's claim of
 * success is never trusted on its own. On a pass, the fan retries the
 * purchase that was gated. */
app.post('/api/av/complete', identMiddleware, requireUser, requireRole('fan'), (req, res) => {
  if (!avLib.enabled()) return res.status(503).json({ error: 'av_not_configured' });
  try {
    const r = avSvc.completeVerification({
      userId: req.user.id, username: req.user.username,
      sessionRef: req.body && req.body.session_ref,
    });
    if (!r.ok) return res.status(404).json({ error: r.error });
    res.json({ ok: true, passed: r.passed, verified: r.passed });
  } catch (e) {
    if (e.code === 'av_not_configured') return res.status(503).json({ error: 'av_not_configured' });
    console.error('av: complete failed —', e.message);
    res.status(500).json({ error: 'av_complete_failed' });
  }
});

/* Provider server-to-server result delivery (webhook). INERT until a
 * real provider is configured — see lib/av.js
 * verifyWebhookSignature, which must gain real HMAC verification at
 * activation time. Always 200 for well-formed posts so a provider
 * stops retrying; decisions are recorded on the session row. */
app.post('/api/av/webhook', (req, res) => {
  try {
    if (!avSvc.verifyWebhookSignature(req.body || {}, req.headers['x-av-signature'])) {
      return res.status(401).json({ error: 'bad_signature' });
    }
    const r = avSvc.handleWebhook(req.body || {});
    res.json({ ok: true, handled: r.handled });
  } catch (e) {
    console.error('av: webhook error —', e.message);
    res.json({ ok: true, handled: 'error' });
  }
});

app.get('/api/ccbill/config', (req, res) => {
  res.json({ configured: ccbillSvc.configured(), max_cents: ccbillSvc.maxCents() });
});

app.post('/api/ccbill/checkout', identMiddleware, requireUser, requireRole('fan'), (req, res) => {
  if (!ccbillSvc.configured()) {
    return res.status(503).json({ error: 'payment_not_connected', message: 'Card payments are launching soon.' });
  }
  let pkg = CREDIT_PACKAGES.find((p) => p.id === (req.body && req.body.package_id));
  let amount = pkg ? pkg.price_cents : null;
  if (!pkg) {
    const amt = req.body && req.body.amount_cents;
    if (Number.isInteger(amt) && amt % 100 === 0 && amt >= 1000 && amt <= 100000) {
      amount = amt; pkg = { id: 'custom' };
    }
  }
  if (!amount) return res.status(400).json({ error: 'bad_package' });
  if (amount > ccbillSvc.maxCents()) {
    return res.status(400).json({ error: 'over_limit',
      message: `Card loads are capped at $${ccbillSvc.maxCents() / 100} per transaction right now — crypto loads go up to $1,000.` });
  }
  // Age-verification gate (dormant unless AV is configured): a
  // regulated-state fan verifies ONCE, before her first card purchase,
  // via the provider's transactional-data check on this card.
  const avGate = avPurchaseGate(req, 'transactional');
  if (avGate) return res.status(avGate.status).json(avGate.body);
  // Same fraud velocity gate as every other purchase path.
  const v = checkPurchaseVelocity(req.user.id, amount, null);
  if (!v.ok) {
    logPurchaseAttempt(req.user.id, pkg, amount, null, clientIp(req), 'blocked', v.error);
    return res.status(429).json({ error: v.error, message: v.message });
  }
  try {
    const { url } = ccbillSvc.createCheckout(req.user.id, amount, pkg.id);
    logPurchaseAttempt(req.user.id, pkg, amount, null, clientIp(req), 'pending', 'ccbill_checkout');
    res.json({ url });
  } catch (e) {
    if (e.code === 'bad_amount') return res.status(400).json({ error: 'bad_amount' });
    console.error('ccbill: checkout failed —', e.message);
    res.status(500).json({ error: 'checkout_failed' });
  }
});

// CCBill server-to-server posts: Webhooks (JSON) + classic Approval Post
// (form-encoded). This endpoint is the ONLY place card credits are issued.
app.post('/api/ccbill/webhook', express.urlencoded({ extended: true }), (req, res) => {
  try {
    const r = ccbillSvc.handleEvent(req.body || {});
    res.json({ ok: true, handled: r.handled });
  } catch (e) {
    console.error('ccbill: webhook error —', e.message);
    res.json({ ok: true, handled: 'error' }); // still 200 — never invite a retry storm
  }
});

// Classic Denial Post gets its own URL so a denial can never be mistaken
// for an approval (it carries no eventType of its own).
app.post('/api/ccbill/denial', express.urlencoded({ extended: true }), (req, res) => {
  try { ccbillSvc.handleEvent({ ...(req.body || {}), eventType: 'NewSaleFailure' }); } catch (e) {}
  res.json({ ok: true });
});

// Browser return from CCBill's hosted form. NEVER credits — the webhook does.
app.get('/api/ccbill/return', (req, res) => {
  const ok = req.query.result === 'success' || req.query.mppResponse === 'CheckoutSuccess';
  res.redirect(302, `/?ccbill=${ok ? 'success' : 'fail'}`);
});

app.get('/api/admin/ccbill/orders', identMiddleware, requireUser, requireRole('admin'), (req, res) => {
  const rows = db.prepare(`SELECT o.*, u.username FROM ccbill_orders o
    JOIN users u ON u.id = o.user_id ORDER BY o.id DESC LIMIT 100`).all();
  res.json({ orders: rows });
});
app.post('/api/admin/ccbill/orders/:id/credit', identMiddleware, requireUser, requireRole('admin'), (req, res) => {
  const r = ccbillSvc.markCreditedAdmin(parseInt(req.params.id, 10), req.user.id);
  if (r.error) return res.status(400).json({ error: r.error });
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Payment-source visibility — Manager "Money in"                      */
/*                                                                     */
/* Every way a fan's credit balance can increase from OUTSIDE money:   */
/*   1. crypto invoice credited (watcher, or admin mark-credited)      */
/*      — crypto_invoices, credited_cents / coin / txid live there.    */
/*   2. CCBill card load credited (webhook, or admin release of a      */
/*      'review' hold) — ccbill_orders.                                */
/*   3. admin manual credit (Fans screen "+ Credits")                  */
/*      — transactions type 'credit_grant'.                            */
/*   4. admin refund re-credit — the refunds table (one row per        */
/*      issued refund; the endpoint deletes the row if money          */
/*      movement fails, so a row here means credits really landed).    */
/* Automatic spend reversals (refundFan: declined live joins,          */
/* never-started FaceTime cancels) are NOT loads — they hand back      */
/* money from a spend that already happened, recorded as negative      */
/* ledger rows of the original spend type, so they never appear here. */
/*                                                                     */
/* Provenance stops at the load on purpose: balances are fungible, so  */
/* an individual spend can NOT truthfully be traced to one load.       */
/* Spend rows keep their type/split labels and are never re-badged     */
/* with a rail.                                                        */
/* ------------------------------------------------------------------ */

// CCBill posts carry no standard card-brand field. If the stored webhook
// payload happens to name one, surface it; otherwise the load stays
// labeled plain "CCBill" — the brand is never guessed.
function ccbillCardBrand(rawEvent) {
  if (!rawEvent) return null;
  let o;
  try { o = JSON.parse(rawEvent); } catch (e) { return null; }
  if (!o || typeof o !== 'object') return null;
  const BRANDS = [['visa', 'VISA'], ['master', 'Mastercard'], ['amex', 'Amex'],
    ['american express', 'Amex'], ['discover', 'Discover'], ['jcb', 'JCB'], ['diner', 'Diners']];
  for (const [k, v] of Object.entries(o)) {
    const key = k.toLowerCase();
    if (!/(card|brand|payment).*(type|brand|method)?$/.test(key) && !key.includes('brand')) continue;
    if (typeof v !== 'string') continue;
    const val = v.toLowerCase();
    for (const [needle, label] of BRANDS) if (val.includes(needle)) return label;
  }
  return null;
}

function loadSourceLabel(source, coin, brand) {
  if (source === 'crypto') return `Crypto · ${coin}`;
  if (source === 'ccbill') return brand ? `${brand} · CCBill` : 'CCBill';
  if (source === 'admin') return 'Admin credit';
  if (source === 'refund') return 'Refund · re-credit';
  return source;
}

// By-source money-in totals for one window (sinceTs null = all time).
// Windows compare against each rail's own credit timestamp, all stored
// as UTC 'YYYY-MM-DD HH:MM:SS' — the same discipline as Overview.
function loadTotalsBySource(sinceTs) {
  const w = (col) => (sinceTs ? ` AND ${col} >= ?` : '');
  const p = sinceTs ? [sinceTs] : [];
  const cryptoRows = db.prepare(`SELECT coin, COALESCE(SUM(credited_cents),0) AS cents
    FROM crypto_invoices
    WHERE status IN ('credited','credited_partial') AND credited_cents > 0${w('credited_at')}
    GROUP BY coin`).all(...p);
  const crypto_by_coin = {};
  let crypto_cents = 0;
  for (const r of cryptoRows) { crypto_by_coin[r.coin] = r.cents; crypto_cents += r.cents; }
  const ccbill_cents = db.prepare(`SELECT COALESCE(SUM(amount_cents),0) AS cents
    FROM ccbill_orders WHERE status = 'credited'${w('credited_at')}`).get(...p).cents;
  const admin_cents = db.prepare(`SELECT COALESCE(SUM(gross_cents),0) AS cents
    FROM transactions WHERE type = 'credit_grant' AND is_test = 0${w('created_at')}`).get(...p).cents;
  const refund_cents = db.prepare(`SELECT COALESCE(SUM(amount_cents),0) AS cents
    FROM refunds WHERE 1 = 1${w('created_at')}`).get(...p).cents;
  return {
    ccbill_cents, crypto_by_coin, crypto_cents, admin_cents, refund_cents,
    total_cents: ccbill_cents + crypto_cents + admin_cents + refund_cents,
  };
}

// Per-fan lifetime loads grouped by source (whole fan base, merged onto
// the Fans list). Same source rules as /api/admin/loads.
function fanLoadsBySource() {
  const byFan = new Map();
  const entry = (uid) => {
    if (!byFan.has(uid)) byFan.set(uid, {
      ccbill_cents: 0, crypto_by_coin: {}, crypto_cents: 0,
      admin_cents: 0, refund_cents: 0, total_cents: 0,
    });
    return byFan.get(uid);
  };
  const finish = (e) => {
    e.total_cents = e.ccbill_cents + e.crypto_cents + e.admin_cents + e.refund_cents;
  };
  for (const r of db.prepare(`SELECT user_id, coin, SUM(credited_cents) AS cents
      FROM crypto_invoices
      WHERE status IN ('credited','credited_partial') AND credited_cents > 0
      GROUP BY user_id, coin`).all()) {
    const e = entry(r.user_id); e.crypto_by_coin[r.coin] = r.cents; e.crypto_cents += r.cents;
  }
  for (const r of db.prepare(`SELECT user_id, SUM(amount_cents) AS cents
      FROM ccbill_orders WHERE status = 'credited' GROUP BY user_id`).all()) {
    entry(r.user_id).ccbill_cents = r.cents;
  }
  for (const r of db.prepare(`SELECT fan_id, SUM(gross_cents) AS cents
      FROM transactions WHERE type = 'credit_grant' AND is_test = 0 GROUP BY fan_id`).all()) {
    entry(r.fan_id).admin_cents = r.cents;
  }
  for (const r of db.prepare(`SELECT user_id, SUM(amount_cents) AS cents
      FROM refunds GROUP BY user_id`).all()) {
    entry(r.user_id).refund_cents = r.cents;
  }
  for (const e of byFan.values()) finish(e);
  return byFan;
}

app.get('/api/admin/loads', ...adminOnly, (req, res) => {
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const fanId = parseInt(req.query.fan_id, 10);
  const fanParam = Number.isInteger(fanId) && fanId > 0 ? fanId : null;
  const rows = db.prepare(`
    SELECT source, coin, amount_cents, ts, fan_id, fan_username, fan_name,
           ref_id, txid, received_amount, partial, via, detail, raw_event FROM (
      SELECT 'crypto' AS source, ci.coin AS coin, ci.credited_cents AS amount_cents,
             ci.credited_at AS ts, ci.user_id AS fan_id, u.username AS fan_username,
             u.display_name AS fan_name, ci.id AS ref_id, ci.txid AS txid,
             ci.received_amount AS received_amount,
             CASE WHEN ci.status = 'credited_partial' THEN 1 ELSE 0 END AS partial,
             ci.credited_via AS via, NULL AS detail, NULL AS raw_event
      FROM crypto_invoices ci JOIN users u ON u.id = ci.user_id
      WHERE ci.status IN ('credited','credited_partial') AND ci.credited_cents > 0
        AND (? IS NULL OR ci.user_id = ?)
      UNION ALL
      SELECT 'ccbill', NULL, o.amount_cents, o.credited_at, o.user_id, u.username,
             u.display_name, o.id, o.ccbill_transaction_id, NULL, 0, NULL,
             CASE WHEN o.ccbill_subscription_id IS NOT NULL
                  THEN 'sub ' || o.ccbill_subscription_id ELSE NULL END,
             o.raw_event
      FROM ccbill_orders o JOIN users u ON u.id = o.user_id
      WHERE o.status = 'credited' AND (? IS NULL OR o.user_id = ?)
      UNION ALL
      SELECT 'admin', NULL, t.gross_cents, t.created_at, t.fan_id, u.username,
             u.display_name, t.id, NULL, NULL, 0, NULL, t.note, NULL
      FROM transactions t JOIN users u ON u.id = t.fan_id
      WHERE t.type = 'credit_grant' AND t.is_test = 0 AND (? IS NULL OR t.fan_id = ?)
      UNION ALL
      SELECT 'refund', NULL, r.amount_cents, r.created_at, r.user_id, u.username,
             u.display_name, r.id, NULL, NULL, 0, NULL, r.reason, NULL
      FROM refunds r JOIN users u ON u.id = r.user_id
      WHERE (? IS NULL OR r.user_id = ?)
    ) ORDER BY ts DESC, ref_id DESC LIMIT ?`)
    .all(fanParam, fanParam, fanParam, fanParam, fanParam, fanParam,
         fanParam, fanParam, limit);
  const loads = rows.map((r) => {
    const brand = r.source === 'ccbill' ? ccbillCardBrand(r.raw_event) : null;
    return {
      key: `${r.source}:${r.ref_id}`,
      source: r.source,
      label: loadSourceLabel(r.source, r.coin, brand),
      brand,
      coin: r.coin || null,
      amount_cents: r.amount_cents,
      ts: r.ts,
      fan_id: r.fan_id, fan_username: r.fan_username, fan_name: r.fan_name,
      ref_id: r.ref_id,
      txid: r.txid || null,
      txid_short: r.txid ? (r.txid.length > 14 ? r.txid.slice(0, 10) + '…' : r.txid) : null,
      received_amount: r.received_amount || null,
      partial: !!r.partial,
      via: r.via || null,
      detail: r.detail || null,
    };
  });
  res.json({
    loads,
    totals: {
      today: loadTotalsBySource(chicagoStartOfDaySql()),
      all_time: loadTotalsBySource(null),
    },
  });
});


app.get('/api/crypto/config', (req, res) => {
  // Fans only see coins with REAL receiving config — a coin still on a
  // placeholder/test address is not offered at all (see createInvoice).
  const ALL_COINS = [
    { coin: 'USDT', label: 'USDT (ERC-20)' }, { coin: 'BTC', label: 'Bitcoin (BTC)' },
    { coin: 'ETH', label: 'Ethereum (ETH)' }, { coin: 'SOL', label: 'Solana (SOL)' },
    { coin: 'XRP', label: 'XRP' },
  ];
  res.json({
    coins: ALL_COINS.filter((c) => !cryptoSvc.isPlaceholder(c.coin)),
    required_confirmations: cryptoSvc.REQUIRED_CONFS,
    ttl_minutes: cryptoSvc.TTL_MIN,
  });
});

app.post('/api/crypto/invoices', identMiddleware, requireUser, requireRole('fan'), async (req, res) => {
  let pkg = CREDIT_PACKAGES.find((p) => p.id === (req.body && req.body.package_id));
  if (!pkg) {
    // Custom load amount (the wallet's "Add more" slider): whole dollars, $100-$1,000.
    const amt = req.body && req.body.amount_cents;
    if (Number.isInteger(amt) && amt >= 10000 && amt <= 100000 && amt % 100 === 0) {
      pkg = { id: 'custom', credits_cents: amt, price_cents: amt, label: '$' + (amt / 100) };
    }
  }
  if (!pkg) return res.status(400).json({ error: 'bad_package' });
  // Age-verification gate (dormant unless AV is configured): crypto has
  // no card to lean on, so the provider's ID check is the method here.
  const avGate = avPurchaseGate(req, 'id');
  if (avGate) return res.status(avGate.status).json(avGate.body);
  try {
    const invoice = await cryptoSvc.createInvoice(req.user.id, pkg, String((req.body && req.body.coin) || 'USDT').toUpperCase());
    res.status(201).json({ invoice });
  } catch (e) {
    if (e.code === 'rate_unavailable') return res.status(503).json({ error: 'rate_unavailable' });
    if (e.code === 'coin_not_configured') return res.status(503).json({ error: 'coin_not_configured' });
    if (e.code === 'bad_coin') return res.status(400).json({ error: 'bad_coin' });
    console.error('crypto: invoice create failed —', e.message);
    res.status(500).json({ error: 'invoice_failed' });
  }
});

app.get('/api/crypto/invoices', identMiddleware, requireUser, async (req, res) => {
  const rows = cryptoSvc.listUserInvoices(req.user.id, 20);
  res.json({ invoices: await Promise.all(rows.map((r) => cryptoSvc.publicInvoice(r, false))) });
});

app.get('/api/crypto/invoices/:id', identMiddleware, requireUser, async (req, res) => {
  const inv = cryptoSvc.getInvoice(parseInt(req.params.id, 10));
  if (!inv || inv.user_id !== req.user.id) return res.status(404).json({ error: 'not_found' });
  res.json({ invoice: await cryptoSvc.publicInvoice(inv, true) });
});

app.get('/api/admin/crypto-invoices', ...adminOnly, (req, res) => {
  res.json({ invoices: cryptoSvc.listAllInvoices(200) });
});

app.post('/api/admin/crypto-invoices/:id/mark-credited', ...adminOnly, (req, res) => {
  const out = cryptoSvc.markCreditedAdmin(parseInt(req.params.id, 10), req.user.id);
  if (out.error === 'not_found') return res.status(404).json(out);
  if (out.error) return res.status(409).json(out);
  res.json(out);
});

app.get('/api/admin/crypto-treasury', ...adminOnly, async (req, res) => {
  res.json(await cryptoSvc.treasury());
});

app.post('/api/admin/crypto-settings', ...adminOnly, (req, res) => {
  res.json({ settings: cryptoSvc.saveSettings(req.body || {}) });
});

app.post('/api/admin/crypto-invoices/actions/sweep', ...adminOnly, (req, res) => {
  const out = cryptoSvc.sweep(String((req.body && req.body.coin) || '').toUpperCase());
  if (out.error) return res.status(400).json(out);
  res.json(out);
});

cryptoSvc.start();

/* ------------------------------------------------------------------ */
/* Live presence (COUNTS ONLY — see lib/presence)                      */
/* Clients ping every ~30s; the Moderator panel reads aggregate        */
/* counts. No names or identities are ever returned.                   */
/* ------------------------------------------------------------------ */
const { createPresenceService } = require('./lib/presence');
const presenceSvc = createPresenceService({ db });

app.post('/api/presence/ping', (req, res) => {
  // Tolerant identity resolution (no identMiddleware — a brand-new guest
  // with no token yet must still count). Anything unresolvable is simply
  // not counted; the ping always answers 204 and never errors.
  let key = null, role = null;
  const ident = getIdentity(req);
  if (ident && ident.kind === 'user') {
    key = 'u:' + ident.user.id;
    role = ident.user.role === 'fan' ? 'fan'
      : ident.user.role === 'model' ? 'model' : 'staff';
  } else if (ident && ident.kind === 'guest') {
    key = 'g:' + ident.token;
    role = 'guest';
  } else {
    const anon = req.body && typeof req.body.anon_id === 'string' ? req.body.anon_id : '';
    if (/^[a-f0-9]{32}$/.test(anon)) { key = 'g:' + anon; role = 'guest'; }
  }
  if (key) presenceSvc.ping(key, role);
  res.status(204).end();
});

/* Moderator-panel guard: admins only, everyone else (fans, models,
   guests) gets 403 — counts are staff information. */
const modOnly = (req, res, next) => {
  if (req.ident.kind !== 'user' || req.ident.user.role !== 'admin') {
    return res.status(403).json({ error: 'forbidden' });
  }
  req.user = req.ident.user;
  // Same Face ID step-up rule as /api/admin/* (no-op until a passkey exists).
  return requirePasskeyStepUp(req, res, next);
};

app.get('/api/mod/presence', identMiddleware, modOnly, (req, res) => {
  res.json(presenceSvc.snapshot());
});

presenceSvc.start();

app.get('/api/admin/fans', ...adminOnly, (req, res) => {
  const fans = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.banned, u.created_at, w.credits_cents,
           (SELECT COALESCE(SUM(gross_cents),0) FROM transactions t
             WHERE t.fan_id = u.id AND t.is_test = 0 AND t.type IN ('message','call','gift')) AS spent_cents
    FROM users u JOIN wallets w ON w.user_id = u.id
    WHERE u.role = 'fan' ORDER BY spent_cents DESC LIMIT 200`).all();
  // Lifetime money-in per fan, grouped by rail (payment-source visibility).
  const loadsByFan = fanLoadsBySource();
  for (const f of fans) {
    f.loads_by_source = loadsByFan.get(f.id) || {
      ccbill_cents: 0, crypto_by_coin: {}, crypto_cents: 0,
      admin_cents: 0, refund_cents: 0, total_cents: 0,
    };
  }
  res.json({ fans });
});

app.post('/api/admin/fans/:id/ban', ...adminOnly, (req, res) => {
  db.prepare(`UPDATE users SET banned = 1 WHERE id = ? AND role = 'fan'`).run(req.params.id);
  res.json({ ok: true });
});
app.post('/api/admin/fans/:id/unban', ...adminOnly, (req, res) => {
  db.prepare(`UPDATE users SET banned = 0 WHERE id = ? AND role = 'fan'`).run(req.params.id);
  res.json({ ok: true });
});
app.post('/api/admin/fans/:id/credits', ...adminOnly, (req, res) => {
  const amount = parseInt(req.body.amount_cents);
  if (!Number.isInteger(amount) || amount <= 0 || amount > 1000000)
    return res.status(400).json({ error: 'bad_amount' });
  const u = db.prepare(`SELECT id FROM users WHERE id = ? AND role = 'fan'`).get(req.params.id);
  if (!u) return res.status(404).json({ error: 'not_found' });
  db.prepare('UPDATE wallets SET credits_cents = credits_cents + ? WHERE user_id = ?').run(amount, u.id);
  db.prepare(`INSERT INTO transactions (fan_id, type, gross_cents, note, ip)
              VALUES (?, 'credit_grant', ?, 'Admin credit grant', ?)`).run(u.id, amount, clientIp(req));
  res.json({ ok: true, balance_cents: getWallet(u.id).credits_cents });
});

app.get('/api/admin/payouts', ...adminOnly, (req, res) => {
  const payouts = db.prepare(`
      SELECT u.id, u.display_name, w.earnings_cents, w.paid_out_cents,
             (w.earnings_cents - w.paid_out_cents) AS pending_cents
      FROM users u JOIN wallets w ON w.user_id = u.id
      WHERE u.role = 'model' ORDER BY pending_cents DESC`).all()
    .map((p) => {
      const bd = getEarningsBreakdown(p.id);
      return { ...p, withdrawable_cents: getModelAvailable(p.id), holding_cents: bd.holding,
        negative_adjustment_cents: bd.debt, flags: getModelFraudFlags(p.id) };
    });
  res.json({
    payouts,
    history: db.prepare(`
      SELECT t.*, u.display_name AS model_name FROM transactions t
      JOIN users u ON u.id = t.model_id
      WHERE t.type = 'payout' ORDER BY t.id DESC LIMIT 50`).all(),
  });
});

app.post('/api/admin/payouts/:id', ...adminOnly, (req, res) => {
  const amount = parseInt(req.body.amount_cents);
  const u = db.prepare(`SELECT * FROM users WHERE id = ? AND role = 'model'`).get(req.params.id);
  if (!u) return res.status(404).json({ error: 'not_found' });
  // Payout protection: a direct payout can never exceed the model's
  // WITHDRAWABLE balance (matured earnings − paid out − pending
  // withdrawals − negative adjustments) — same rule as withdrawal requests.
  const withdrawable = getModelAvailable(u.id);
  if (!Number.isInteger(amount) || amount <= 0)
    return res.status(400).json({ error: 'bad_amount', withdrawable_cents: withdrawable });
  if (amount > withdrawable)
    return res.status(400).json({ error: 'exceeds_withdrawable', withdrawable_cents: withdrawable });
  db.prepare('UPDATE wallets SET paid_out_cents = paid_out_cents + ? WHERE user_id = ?').run(amount, u.id);
  db.prepare(`INSERT INTO transactions (model_id, type, gross_cents, model_cents, note, ip)
              VALUES (?, 'payout', ?, ?, 'Paid out to model', ?)`).run(u.id, amount, amount, clientIp(req));
  res.json({ ok: true, pending_cents: withdrawable - amount });
});

// Admin: all withdrawal requests with full bank details (to send the money).
// Each row also carries the model's payout-protection state (withdrawable
// vs still-holding vs negative adjustment) and advisory fraud flags, so
// the owner sees them BEFORE approving. Flags never block approval.
app.get('/api/admin/withdrawals', ...adminOnly, (req, res) => {
  const rows = db.prepare(`
    SELECT w.id, w.model_id, w.amount_cents, w.status, w.requested_at, w.decided_at, w.note,
           u.display_name AS model_name, u.username AS model_username, u.role AS user_role,
           pa.holder_name, pa.routing_number, pa.account_number
    FROM withdrawals w JOIN users u ON u.id = w.model_id
    LEFT JOIN payout_accounts pa ON pa.model_id = w.model_id
    ORDER BY CASE w.status WHEN 'pending' THEN 0 WHEN 'paid' THEN 1 ELSE 2 END, w.id DESC`).all();
  const cache = new Map();
  const enrich = (modelId) => {
    if (!cache.has(modelId)) {
      const bd = getEarningsBreakdown(modelId);
      cache.set(modelId, { withdrawable_cents: getModelAvailable(modelId),
        holding_cents: bd.holding, negative_adjustment_cents: bd.debt,
        flags: getModelFraudFlags(modelId) });
    }
    return cache.get(modelId);
  };
  res.json({ withdrawals: rows.map((w) => ({ ...w, ...enrich(w.model_id) })) });
});

// Admin: mark a withdrawal paid (money sent manually outside the app)
app.post('/api/admin/withdrawals/:id/pay', ...adminOnly, (req, res) => {
  const w = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(req.params.id);
  if (!w) return res.status(404).json({ error: 'not_found' });
  if (w.status !== 'pending') return res.status(409).json({ error: 'not_pending' });
  // Payout protection: never pay out more than the model's withdrawable
  // balance (this request itself added back, since it is part of it —
  // computed on the UNCLAMPED balance so a clawback-created negative
  // adjustment correctly eats into the request first).
  const cap = Math.max(0, getModelAvailableRaw(w.model_id) + w.amount_cents);
  if (w.amount_cents > cap)
    return res.status(400).json({ error: 'exceeds_withdrawable', withdrawable_cents: cap });
  db.prepare(`UPDATE withdrawals SET status = 'paid', decided_at = datetime('now') WHERE id = ?`).run(w.id);
  db.prepare('UPDATE wallets SET paid_out_cents = paid_out_cents + ? WHERE user_id = ?').run(w.amount_cents, w.model_id);
  db.prepare(`INSERT INTO transactions (model_id, type, gross_cents, model_cents, note, ip)
              VALUES (?, 'payout', ?, ?, 'Withdrawal paid', ?)`).run(w.model_id, w.amount_cents, w.amount_cents, clientIp(req));
  pushToSubject(`u:${w.model_id}`, { type: 'withdrawal:decided', status: 'paid', amount_cents: w.amount_cents });
  res.json({ ok: true });
});

// Admin: reject a withdrawal (funds stay available to the model)
app.post('/api/admin/withdrawals/:id/reject', ...adminOnly, (req, res) => {
  const w = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(req.params.id);
  if (!w) return res.status(404).json({ error: 'not_found' });
  if (w.status !== 'pending') return res.status(409).json({ error: 'not_pending' });
  const note = String(req.body.note || '').slice(0, 200);
  db.prepare(`UPDATE withdrawals SET status = 'rejected', decided_at = datetime('now'), note = ? WHERE id = ?`).run(note, w.id);
  pushToSubject(`u:${w.model_id}`, { type: 'withdrawal:decided', status: 'rejected', amount_cents: w.amount_cents, note });
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Fraud/chargeback protection: refunds, disputes, account freeze       */
/* ------------------------------------------------------------------ */

// Admin: issue a refund to a fan.
// - With model_id: full clawback — fan gets credits back, model's (and
//   platform/recruiter's) earnings are reduced via the same split ratios.
// - Without model_id: pure credit grant reversal (fan gets credits, platform absorbs).
// Every refund is recorded in `refunds` so a later chargeback on the same
// purchase can be detected (refund + dispute = instant freeze).
app.post('/api/admin/refunds', ...adminOnly, (req, res) => {
  const userId = parseInt(req.body.user_id);
  const amountCents = parseInt(req.body.amount_cents);
  const reason = String(req.body.reason || '').slice(0, 300);
  const modelId = req.body.model_id ? parseInt(req.body.model_id) : null;
  const purchaseAttemptId = req.body.purchase_attempt_id ? parseInt(req.body.purchase_attempt_id) : null;
  if (!Number.isInteger(userId) || !Number.isInteger(amountCents) || amountCents <= 0 || amountCents > 1000000)
    return res.status(400).json({ error: 'bad_request', message: 'Invalid user or amount.' });
  if (!reason) return res.status(400).json({ error: 'bad_request', message: 'A reason is required.' });
  const fan = db.prepare(`SELECT id FROM users WHERE id = ? AND role = 'fan'`).get(userId);
  if (!fan) return res.status(404).json({ error: 'fan_not_found' });
  if (modelId) {
    const model = db.prepare(`SELECT id FROM users WHERE id = ? AND role = 'model'`).get(modelId);
    if (!model) return res.status(404).json({ error: 'model_not_found' });
    const { modelCents } = splitPayment(amountCents, modelId);
    if (getWallet(modelId).earnings_cents < modelCents)
      return res.status(400).json({ error: 'insufficient_model_earnings',
        message: 'Model has not earned enough to cover this clawback.' });
  }
  const ip = clientIp(req);
  // refundFan() runs its own txn — insert the refund record first, then apply
  // money movement. If money movement fails, the refund record is rolled back.
  const refundInfo = db.prepare(`INSERT INTO refunds
    (user_id, purchase_attempt_id, model_id, amount_cents, reason)
    VALUES (?,?,?,?,?)`).run(userId, purchaseAttemptId, modelId, amountCents, reason);
  const refundId = Number(refundInfo.lastInsertRowid);
  try {
    if (modelId) {
      refundFan(userId, modelId, amountCents, 'refund', `Admin refund: ${reason}`, ip);
    } else {
      txn(() => {
        db.prepare('UPDATE wallets SET credits_cents = credits_cents + ? WHERE user_id = ?')
          .run(amountCents, userId);
        db.prepare(`INSERT INTO transactions (fan_id, type, gross_cents, note, ip)
                    VALUES (?, 'refund', ?, ?, ?)`)
          .run(userId, amountCents, `Admin refund: ${reason}`, ip);
      });
    }
  } catch (e) {
    db.prepare(`DELETE FROM refunds WHERE id = ?`).run(refundId);
    return res.status(400).json({ error: 'refund_failed', message: e.message });
  }
  pushToSubject(`u:${userId}`, { type: 'refund:issued', amount_cents: amountCents, reason });
  res.json({ ok: true, refund_id: refundId, balance_cents: getWallet(userId).credits_cents });
});

// Admin: list all refunds
app.get('/api/admin/refunds', ...adminOnly, (req, res) => {
  const rows = db.prepare(`
    SELECT r.*, uf.display_name AS fan_name, uf.username AS fan_username,
           um.display_name AS model_name
    FROM refunds r
    JOIN users uf ON uf.id = r.user_id
    LEFT JOIN users um ON um.id = r.model_id
    ORDER BY r.id DESC LIMIT 200`).all();
  res.json({ refunds: rows });
});

// Admin: list disputes
app.get('/api/admin/disputes', ...adminOnly, (req, res) => {
  const rows = db.prepare(`
    SELECT d.*, u.display_name AS fan_name, u.username AS fan_username, u.status AS account_status
    FROM disputes d LEFT JOIN users u ON u.id = d.user_id
    ORDER BY CASE d.status WHEN 'open' THEN 0 ELSE 1 END, d.id DESC LIMIT 200`).all();
  res.json({ disputes: rows });
});

// Admin: file a dispute (chargeback). AUTO-FREEZE: if the fan already received
// a refund for this purchase and now disputes it too, the account is frozen
// instantly and all sessions are killed.
app.post('/api/admin/disputes', ...adminOnly, (req, res) => {
  const userId = parseInt(req.body.user_id);
  const amountCents = parseInt(req.body.amount_cents);
  const transactionRef = String(req.body.transaction_ref || '').slice(0, 120);
  const reason = String(req.body.reason || '').slice(0, 300);
  const purchaseAttemptId = req.body.purchase_attempt_id ? parseInt(req.body.purchase_attempt_id) : null;
  if (!Number.isInteger(userId) || !Number.isInteger(amountCents) || amountCents <= 0)
    return res.status(400).json({ error: 'bad_request' });
  const fan = db.prepare(`SELECT id FROM users WHERE id = ?`).get(userId);
  if (!fan) return res.status(404).json({ error: 'user_not_found' });
  const info = db.prepare(`INSERT INTO disputes
    (user_id, transaction_ref, amount_cents, reason, status) VALUES (?,?,?,?, 'open')`)
    .run(userId, transactionRef || null, amountCents, reason || null);
  const disputeId = Number(info.lastInsertRowid);
  // Double-dip check: refund already issued for this purchase?
  let doubleDip = false;
  if (purchaseAttemptId) {
    doubleDip = !!db.prepare(`SELECT id FROM refunds WHERE user_id = ? AND purchase_attempt_id = ?`)
      .get(userId, purchaseAttemptId);
  } else {
    doubleDip = !!db.prepare(`SELECT id FROM refunds WHERE user_id = ? AND amount_cents = ?`)
      .get(userId, amountCents);
  }
  let frozen = false;
  if (doubleDip) {
    db.prepare(`UPDATE users SET status = 'frozen' WHERE id = ?`).run(userId);
    deleteUserSessions(userId);
    frozen = true;
  }
  res.json({ ok: true, dispute_id: disputeId, auto_frozen: frozen });
});

// Admin: update dispute status
app.put('/api/admin/disputes/:id', ...adminOnly, (req, res) => {
  const status = String(req.body.status || '');
  if (!['open', 'won', 'lost'].includes(status)) return res.status(400).json({ error: 'bad_status' });
  const d = db.prepare('SELECT id FROM disputes WHERE id = ?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'not_found' });
  db.prepare(`UPDATE disputes SET status = ? WHERE id = ?`).run(status, req.params.id);
  res.json({ ok: true });
});

// Admin: freeze / unfreeze a fan account
app.post('/api/admin/fans/:id/freeze', ...adminOnly, (req, res) => {
  const u = db.prepare(`SELECT id FROM users WHERE id = ? AND role = 'fan'`).get(req.params.id);
  if (!u) return res.status(404).json({ error: 'not_found' });
  db.prepare(`UPDATE users SET status = 'frozen' WHERE id = ?`).run(u.id);
  deleteUserSessions(u.id);
  res.json({ ok: true });
});
app.post('/api/admin/fans/:id/unfreeze', ...adminOnly, (req, res) => {
  const u = db.prepare(`SELECT id FROM users WHERE id = ? AND role = 'fan'`).get(req.params.id);
  if (!u) return res.status(404).json({ error: 'not_found' });
  db.prepare(`UPDATE users SET status = 'active' WHERE id = ?`).run(u.id);
  res.json({ ok: true });
});

// Admin: recent purchase attempts (fraud review)
app.get('/api/admin/purchase-attempts', ...adminOnly, (req, res) => {
  const rows = db.prepare(`
    SELECT pa.*, u.display_name AS fan_name, u.username AS fan_username
    FROM purchase_attempts pa LEFT JOIN users u ON u.id = pa.user_id
    ORDER BY pa.id DESC LIMIT 200`).all();
  res.json({ attempts: rows });
});

/* ------------------------------------------------------------------ */
/* Payout protection: chargebacks (Manager)                             */
/* "Record chargeback" is the working entry point for the clawback      */
/* engine until CCBill is integrated; the CCBill webhook hook in        */
/* lib/ccbill.js calls the same engine when reversal events arrive.     */
/* ------------------------------------------------------------------ */

app.get('/api/admin/chargebacks', ...adminOnly, (req, res) => {
  const rows = db.prepare(`SELECT c.*, uf.display_name AS fan_name, uf.username AS fan_username,
      ur.display_name AS recorded_by_name
    FROM chargebacks c JOIN users uf ON uf.id = c.fan_id
    LEFT JOIN users ur ON ur.id = c.recorded_by
    ORDER BY c.id DESC LIMIT 100`).all();
  res.json({ chargebacks: rows.map((c) => ({ ...c,
    allocations: db.prepare(`SELECT a.*, u.display_name AS model_name
      FROM chargeback_allocations a LEFT JOIN users u ON u.id = a.model_id
      WHERE a.chargeback_id = ? ORDER BY a.id`).all(c.id) })) });
});

// Record a chargeback: reverses in the engine's strict order
// (fan's unspent credits → models' held-then-matured earnings →
// negative adjustment). Idempotent on (source, external_id).
app.post('/api/admin/chargebacks', ...adminOnly, (req, res) => {
  const fanId = parseInt(req.body.user_id || req.body.fan_id);
  const amount = parseInt(req.body.amount_cents);
  const externalId = String(req.body.external_id || '').trim();
  if (!Number.isInteger(fanId)) return res.status(400).json({ error: 'bad_fan' });
  if (!Number.isInteger(amount) || amount <= 0) return res.status(400).json({ error: 'bad_amount' });
  if (!externalId) return res.status(400).json({ error: 'missing_external_id' });
  const r = applyChargeback({ source: String(req.body.source || 'manual'), external_id: externalId,
    fan_id: fanId, load_ref: req.body.load_ref ?? null, amount_cents: amount,
    reason: req.body.reason || null, recorded_by: req.user.id });
  if (r.error) return res.status(400).json({ error: r.error });
  res.json(r);
});

app.put('/api/admin/settings', ...adminOnly, (req, res) => {
  const out = { ok: true };
  if (req.body.commission_pct !== undefined) {
    const pct = parseInt(req.body.commission_pct);
    if (!Number.isInteger(pct) || pct < 0 || pct > 90)
      return res.status(400).json({ error: 'bad_commission' });
    db.prepare('UPDATE platform_stats SET commission_pct = ? WHERE id = 1').run(pct);
    out.commission_pct = pct;
  }
  if (req.body.explicit_gift_grace_sec !== undefined) {
    const g = parseInt(req.body.explicit_gift_grace_sec);
    if (!Number.isInteger(g) || g < 30 || g > 3600)
      return res.status(400).json({ error: 'bad_grace' });
    db.prepare('UPDATE platform_stats SET explicit_gift_grace_sec = ? WHERE id = 1').run(g);
    out.explicit_gift_grace_sec = g;
  }
  if (req.body.explicit_entry_cents !== undefined) {
    const e = parseInt(req.body.explicit_entry_cents);
    if (!Number.isInteger(e) || e < 100 || e > 10000)
      return res.status(400).json({ error: 'bad_entry' });
    db.prepare('UPDATE platform_stats SET explicit_entry_cents = ? WHERE id = 1').run(e);
    out.explicit_entry_cents = e;
  }
  // Payout protection: earnings hold window + fraud-flag thresholds.
  const ppFields = [
    ['earnings_hold_days', 0, 60, 'bad_hold_days'],
    ['flag_concentration_pct', 1, 100, 'bad_flag_pct'],
    ['flag_concentration_min_cents', 0, 10000000, 'bad_flag_min'],
    ['flag_concentration_days', 1, 365, 'bad_flag_days'],
    ['flag_cb_escalate_count', 1, 100, 'bad_flag_cb_count'],
    ['flag_cb_escalate_rate_pct', 1, 100, 'bad_flag_cb_rate'],
  ];
  for (const [field, lo, hi, err] of ppFields) {
    if (req.body[field] !== undefined) {
      const v = parseInt(req.body[field]);
      if (!Number.isInteger(v) || v < lo || v > hi)
        return res.status(400).json({ error: err });
      db.prepare(`UPDATE platform_stats SET ${field} = ? WHERE id = 1`).run(v);
      out[field] = v;
    }
  }
  res.json(out);
});

/* ------------------------------------------------------------------ */
/* WebSocket — realtime chat, presence, call signaling                  */
/* ------------------------------------------------------------------ */

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token');
  const guestToken = url.searchParams.get('guest_token');
  let key = null;
  if (token) {
    const userId = getSessionUserId(token);
    const user = userId ? db.prepare('SELECT * FROM users WHERE id = ?').get(userId) : null;
    if (!user || user.banned) { ws.close(4401, 'unauthorized'); return; }
    key = `u:${userId}`;
  } else if (guestToken && /^[a-f0-9]{32}$/.test(guestToken) && !bannedGuests.has(guestToken)) {
    key = `g:${guestToken}`;
  } else { ws.close(4401, 'unauthorized'); return; }

  if (!socketsBySubject.has(key)) socketsBySubject.set(key, new Set());
  socketsBySubject.get(key).add(ws);
  ws.subjectKey = key;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const isUser = key.startsWith('u:');
    const userId = isUser ? parseInt(key.slice(2)) : null;
    if (isUser) {
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
      if (!user || user.banned) return;
    }

    if (msg.type === 'typing' && Number.isInteger(msg.conversation_id)) {
      const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(msg.conversation_id);
      if (!conv) return;
      const mine = isUser
        ? (conv.fan_id === userId || conv.model_id === userId)
        : conv.guest_token === key.slice(2);
      if (!mine) return;
      const otherKey = isUser
        ? (conv.model_id === userId
            ? (conv.fan_id ? `u:${conv.fan_id}` : `g:${conv.guest_token}`)
            : `u:${conv.model_id}`)
        : `u:${conv.model_id}`;
      pushToSubject(otherKey, { type: 'typing', conversation_id: conv.id, is_typing: !!msg.is_typing });
      return;
    }

    // Live broadcast signaling — model <-> viewers of a live session
    if (msg.type === 'live-signal' && Number.isInteger(msg.session_id) && Number.isInteger(msg.to) && msg.payload) {
      const sess = db.prepare('SELECT * FROM live_sessions WHERE id = ? AND status = \'live\'')
        .get(msg.session_id);
      if (!sess) return;
      const meId = isUser ? userId : null;
      if (!meId) return; // guests can't join live
      const isModel = sess.model_id === meId;
      const isViewer = !!db.prepare('SELECT 1 FROM live_viewers WHERE session_id = ? AND fan_id = ?')
        .get(msg.session_id, meId);
      if (!isModel && !isViewer) return;
      // Model may signal any viewer; viewers may only signal the model
      if (!isModel && msg.to !== sess.model_id) return;
      if (isModel) {
        const okViewer = db.prepare('SELECT 1 FROM live_viewers WHERE session_id = ? AND fan_id = ?')
          .get(msg.session_id, msg.to);
        if (!okViewer) return;
      }
      pushToSubject(`u:${msg.to}`, { type: 'live-signal', from: meId,
        session_id: msg.session_id, payload: msg.payload });
      return;
    }

    // WebRTC signaling relay — only between people who share a conversation/call
    if (msg.type === 'signal' && Number.isInteger(msg.to) && msg.payload) {
      const meFan = isUser ? userId : null;
      const meGuest = isUser ? null : key.slice(2);
      const ok = db.prepare(`
        SELECT 1 FROM conversations
        WHERE (fan_id = ? AND model_id = ?) OR (fan_id = ? AND model_id = ?)
           OR (guest_token = ? AND model_id = ?)
        UNION SELECT 1 FROM calls
        WHERE ((fan_id = ? AND model_id = ?) OR (fan_id = ? AND model_id = ?))
          AND status IN ('pending','active')`).get(
        meFan, msg.to, msg.to, meFan, meGuest, msg.to,
        meFan, msg.to, msg.to, meFan);
      if (!ok) return;
      pushToSubject(`u:${msg.to}`, { type: 'signal', from: userId, payload: msg.payload });
    }
  });

  ws.on('close', () => {
    const set = socketsBySubject.get(key);
    if (set) { set.delete(ws); if (!set.size) socketsBySubject.delete(key); }
  });
});

/* ------------------------------------------------------------------ */

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

/* Which build is deployed right now. The public app polls this (see
   startUpdateWatcher in public/js/app.js): when the answer differs from
   the build the page loaded under, the app reloads itself at the first
   idle moment — the client half of forced refresh on every deploy. */
app.get('/api/build-id', (req, res) => res.json({ build: BUILD_ID, cache: SW_CACHE_NAME, time: BUILD_TIME }));

app.get('/boss', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Slut Manager</title></head><body><script>location.replace('/manager');</script></body></html>`);
});

/* Slut Manager app shell (the static middleware also serves the folder;
   these explicit routes keep /manager deterministic). */
app.get(['/manager', '/manager/'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'manager', 'index.html'));
});

app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ------------------------------------------------------------------ */
/* Biweekly cleanup — every Saturday, delete chat content older than    */
/* 14 days (texts, photos, videos, voice notes) to save disk space.    */
/* Financial records (transactions, payouts) are NEVER touched.         */
/* ------------------------------------------------------------------ */

function runBiweeklyCleanup() {
  const cutoff = `datetime('now', '-14 days')`;
  let filesDeleted = 0, bytesFreed = 0;

  // 1. Delete old media files from disk
  const oldMedia = db.prepare(
    `SELECT id, file_path FROM media_items WHERE created_at < ${cutoff}`).all();
  for (const m of oldMedia) {
    try {
      const fp = path.isAbsolute(m.file_path) ? m.file_path : path.join(__dirname, m.file_path);
      if (fs.existsSync(fp)) {
        bytesFreed += fs.statSync(fp).size;
        fs.unlinkSync(fp);
        filesDeleted++;
      }
    } catch (e) { /* already gone */ }
  }
  // 2. Delete old model profile photos (photo-*.jpg in uploads, not current).
  // Public photos share the photo-* name space, so they count as current too.
  // Gallery pictures live in the same name space — every URL in a model's
  // gallery_photos list is current and must never be swept as an orphan.
  const currentPhotos = new Set([
    ...db.prepare(`SELECT photo_url FROM models WHERE photo_url != ''`).all().map((r) => r.photo_url),
    ...db.prepare(`SELECT public_photo_url FROM models WHERE public_photo_url != ''`).all().map((r) => r.public_photo_url),
    ...db.prepare(`SELECT gallery_photos FROM models WHERE gallery_photos != '' AND gallery_photos != '[]'`)
      .all().flatMap((r) => parseGalleryPhotos(r.gallery_photos)),
  ]);
  try {
    for (const f of fs.readdirSync(UPLOAD_DIR)) {
      if (!/^photo-[a-f0-9]+\.(jpg|png|webp)$/.test(f)) continue;
      const url = '/uploads/' + f;
      if (currentPhotos.has(url)) continue;
      const fp = path.join(UPLOAD_DIR, f);
      const stat = fs.statSync(fp);
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs > 14 * 24 * 3600 * 1000) {
        bytesFreed += stat.size;
        fs.unlinkSync(fp);
        filesDeleted++;
      }
    }
  } catch (e) { /* dir missing */ }

  // 3. Delete old chat messages + media records + stream chat
  const msgDel = db.prepare(`DELETE FROM messages WHERE created_at < ${cutoff}`).run();
  const mediaDel = db.prepare(`DELETE FROM media_items WHERE created_at < ${cutoff}`).run();
  const streamDel = db.prepare(`DELETE FROM stream_chat WHERE created_at < ${cutoff}`).run();
  // 4. Clean up orphaned unlock records for deleted media
  db.prepare(`DELETE FROM media_unlocks WHERE media_id NOT IN (SELECT id FROM media_items)`).run();

  const result = {
    ran_at: new Date().toISOString(),
    messages_deleted: msgDel.changes,
    media_records_deleted: mediaDel.changes,
    stream_messages_deleted: streamDel.changes,
    files_deleted: filesDeleted,
    mb_freed: Math.round(bytesFreed / 1024 / 1024 * 10) / 10,
  };
  db.prepare(`INSERT INTO platform_stats (id, earnings_cents, commission_pct) VALUES (1, 0, 40)
    ON CONFLICT(id) DO NOTHING`).run();
  // Store last cleanup result in a simple key-value spot
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS cleanup_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ran_at TEXT NOT NULL,
      messages_deleted INTEGER DEFAULT 0, media_records_deleted INTEGER DEFAULT 0,
      stream_messages_deleted INTEGER DEFAULT 0, files_deleted INTEGER DEFAULT 0,
      mb_freed REAL DEFAULT 0)`);
    db.prepare(`INSERT INTO cleanup_log (ran_at, messages_deleted, media_records_deleted,
      stream_messages_deleted, files_deleted, mb_freed) VALUES (?,?,?,?,?,?)`)
      .run(result.ran_at, result.messages_deleted, result.media_records_deleted,
           result.stream_messages_deleted, result.files_deleted, result.mb_freed);
  } catch (e) { /* log table failed, skip */ }
  console.log(`🧹 Biweekly cleanup: ${result.messages_deleted} msgs, ${result.files_deleted} files, ${result.mb_freed}MB freed`);
  // Notify admin
  try { pushToAdmins({ type: 'cleanup:done', ...result }); } catch (e) { /* ignore */ }
  return result;
}

// Check every hour: Saturday biweekly cleanup + emergency cleanup at 50% disk
let lastCleanupWeek = '';
setInterval(() => {
  const now = new Date();
  // Emergency: if disk is over 50% full, clean up NOW regardless of schedule
  try {
    const { execSync } = require('child_process');
    const out = execSync(`df -k "${DATA_DIR}" | tail -1`).toString();
    const parts = out.trim().split(/\s+/);
    const pct = parseInt(parts[4] ? parts[4].replace('%', '') : '0');
    if (pct >= 50) {
      console.log(`🧹 Emergency cleanup: disk at ${pct}%`);
      runBiweeklyCleanup();
      return;
    }
  } catch (e) { /* df failed, skip */ }
  // Regular schedule: every other Saturday
  if (now.getDay() !== 6) return; // Saturday only
  if (now.getDay() !== 6) return; // Saturday only
  const weekKey = `${now.getFullYear()}-W${Math.ceil(now.getDate() / 7)}-${now.getMonth()}`;
  // Only run every OTHER Saturday (biweekly)
  const weekNum = Math.floor(now.getTime() / (7 * 24 * 3600 * 1000));
  if (weekNum % 2 !== 0) return;
  if (lastCleanupWeek === weekKey) return;
  lastCleanupWeek = weekKey;
  runBiweeklyCleanup();
}, 3600 * 1000);

// Admin: trigger cleanup manually + view history
app.post('/api/admin/cleanup', ...adminOnly, (req, res) => {
  res.json(runBiweeklyCleanup());
});
app.get('/api/admin/cleanup', ...adminOnly, (req, res) => {
  try {
    const log = db.prepare('SELECT * FROM cleanup_log ORDER BY id DESC LIMIT 10').all();
    res.json({ log });
  } catch (e) { res.json({ log: [] }); }
});

server.listen(PORT, () => {
  console.log(`SlutCamp running → http://localhost:${PORT}`);
  console.log(process.env.SEED_DEMO === '1'
    ? 'Seeded logins (SEED_DEMO=1, local dev only): admin/admin123 · bunny|stacey|bella/model123 · fandemo/fan123'
    : 'Demo seeding OFF — no demo accounts created (set SEED_DEMO=1 for local dev).');
});

/* ------------------------------------------------------------------ */
/* DMCA takedown process                                                */
/* ------------------------------------------------------------------ */
db.exec(`
CREATE TABLE IF NOT EXISTS dmca_notices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_name TEXT NOT NULL DEFAULT '',
  reporter_email TEXT NOT NULL DEFAULT '',
  work_description TEXT NOT NULL DEFAULT '',
  urls TEXT NOT NULL DEFAULT '',
  statement_confirmed INTEGER NOT NULL DEFAULT 0,
  signature TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'received' CHECK(status IN ('received','under_review','actioned','rejected')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  admin_note TEXT NOT NULL DEFAULT ''
)`);

// Simple per-IP rate limit for the public DMCA form: 5/hour
const dmcaAttempts = new Map();
function dmcaRateOk(req) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().slice(0, 64);
  const now = Date.now(), rec = dmcaAttempts.get(ip);
  if (!rec || now - rec.resetAt > 3600_000) { dmcaAttempts.set(ip, { count: 1, resetAt: now }); return true; }
  if (rec.count >= 5) return false;
  rec.count++; return true;
}

// Public: file a takedown notice
app.post('/api/dmca/report', (req, res) => {
  if (!dmcaRateOk(req)) return res.status(429).json({ error: 'too_many' });
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 120);
  const email = String(b.email || '').trim().slice(0, 160);
  const work = String(b.work_description || '').trim().slice(0, 4000);
  const urls = String(b.urls || '').trim().slice(0, 4000);
  const signature = String(b.signature || '').trim().slice(0, 120);
  const confirmed = b.statement_confirmed === true || b.statement_confirmed === 1;
  if (!name || !email || !work || !urls || !signature || !confirmed)
    return res.status(400).json({ error: 'missing_fields' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'bad_email' });
  const id = db.prepare(`INSERT INTO dmca_notices
    (reporter_name, reporter_email, work_description, urls, statement_confirmed, signature)
    VALUES (?,?,?,?,1,?)`).run(name, email, work, urls, signature).lastInsertRowid;
  pushToAdmins({ type: 'dmca:new', id, reporter_name: name });
  res.json({ ok: true, id });
});

// Admin: list notices
app.get('/api/admin/dmca', ...adminOnly, (req, res) => {
  const notices = db.prepare('SELECT * FROM dmca_notices ORDER BY created_at DESC LIMIT 200').all();
  res.json({ notices });
});

// Admin: update status + note
app.post('/api/admin/dmca/:id/status', ...adminOnly, (req, res) => {
  const n = db.prepare('SELECT * FROM dmca_notices WHERE id = ?').get(req.params.id);
  if (!n) return res.status(404).json({ error: 'not_found' });
  const status = String((req.body || {}).status || '');
  if (!['received','under_review','actioned','rejected'].includes(status))
    return res.status(400).json({ error: 'bad_status' });
  const note = String((req.body || {}).admin_note || '').slice(0, 2000);
  db.prepare(`UPDATE dmca_notices SET status = ?, admin_note = ?,
    resolved_at = CASE WHEN ? IN ('actioned','rejected') THEN datetime('now') ELSE resolved_at END
    WHERE id = ?`).run(status, note, status, n.id);
  res.json({ ok: true });
});
