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

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 3000;

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
  commission_pct  INTEGER NOT NULL DEFAULT 30
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
`);

db.prepare(`INSERT OR IGNORE INTO platform_stats (id, earnings_cents, commission_pct)
            VALUES (1, 0, 30)`).run();

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
addColumnIfMissing('live_sessions', 'title', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('live_sessions', 'brb', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('live_sessions', 'game_on', 'INTEGER NOT NULL DEFAULT 0'); // Game Category live this session
addColumnIfMissing('platform_stats', 'game_category_announced_at', 'TEXT'); // one-time model broadcast stamp
addColumnIfMissing('platform_stats', 'agreement_12_announced_at', 'TEXT'); // one-time v1.2 agreement broadcast stamp
addColumnIfMissing('live_viewers', 'explicit_until', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('live_viewers', 'explicit_paid', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('platform_stats', 'explicit_gift_grace_sec', 'INTEGER NOT NULL DEFAULT 180');
addColumnIfMissing('conversations', 'paused_at', 'TEXT');
addColumnIfMissing('messages', 'gift_json', 'TEXT'); // TikTok-style gift payload on chat gift messages
addColumnIfMissing('models', 'preview_video_url', "TEXT NOT NULL DEFAULT ''"); // Loop preview on home screen
addColumnIfMissing('invite_links', 'expires_at', "TEXT NOT NULL DEFAULT (datetime('now', '+6 hours'))");
addColumnIfMissing('invite_links', 'role', "TEXT NOT NULL DEFAULT 'model'");
addColumnIfMissing('tax_profiles', 'electronic_1099_consent', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('tax_profiles', 'electronic_1099_consent_at', 'TEXT');
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
addColumnIfMissing('transactions', 'is_test', 'INTEGER NOT NULL DEFAULT 0');
// Admin visibility switch: hidden models vanish from the public listings
// (home grid, Lives) without touching their account (Corry, Oct 12 2026).
addColumnIfMissing('models', 'is_hidden', 'INTEGER NOT NULL DEFAULT 0');
// Fraud protection: account status ('active' | 'frozen') + ledger IP on every money row
addColumnIfMissing('users', 'status', "TEXT NOT NULL DEFAULT 'active'");
addColumnIfMissing('transactions', 'ip', 'TEXT');

// Display name changes: fans get 1 per 30 days (self-service); models submit requests for admin approval
addColumnIfMissing('users', 'name_changed_at', 'TEXT');

// UI language preference ('en' | 'es' | 'pt') — set from the in-app language
// picker, returned by /api/me so it follows the user across devices
addColumnIfMissing('users', 'language', "TEXT NOT NULL DEFAULT 'en'");

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

// Model's withdrawable balance: earnings minus paid out minus pending requests
const getModelAvailable = (userId) => {
  const w = getWallet(userId);
  if (!w) return 0;
  const pending = db.prepare(
    `SELECT COALESCE(SUM(amount_cents), 0) AS s FROM withdrawals WHERE model_id = ? AND status = 'pending'`
  ).get(userId).s;
  return w.earnings_cents - w.paid_out_cents - pending;
};

const getUserPublic = (u) => ({
  id: u.id, username: u.username, role: u.role,
  display_name: u.display_name, banned: !!u.banned,
  status: u.status || 'active',
  language: u.language || 'en',
  welcomed: !!u.welcomed_at,
});

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

// Move money: fan pays grossCents. Throws Error('insufficient_credits') if short.
// ip is recorded on the ledger row for fraud/chargeback evidence.
function chargeFan(fanId, modelId, grossCents, type, note, ip = null) {
  const wallet = getWallet(fanId);
  if (!wallet || wallet.credits_cents < grossCents) throw new Error('insufficient_credits');
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
      (fan_id, model_id, type, gross_cents, model_cents, platform_cents, recruiter_id, recruiter_cents, note, ip)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(fanId, modelId, type, grossCents, modelCents, platformCents, recruiterId, recruiterCents, note || null, ip);
  });
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
  return { modelCents, platformCents, recruiterCents };
}

/* ---------------- identity: logged-in user OR guest ---------------- */

// Sessions stored in DB (on persistent disk) so logins survive deploys
db.exec(`CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
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
// first visit); only en/es/pt are honored, anything else falls back to 'en'.
// Stored on the user row at creation so her welcome DM lands in her language.
function signupLanguage(req) {
  const l = String((req.body && req.body.language) || '').toLowerCase();
  return ['en', 'es', 'pt'].includes(l) ? l : 'en';
}

function createUser(username, password, role, displayName, dob, language) {
  const lang = ['en', 'es', 'pt'].includes(language) ? language : 'en';
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
    notifyUser(m.id, 'welcome', '🎉 Welcome to SlutCamp!',
      'Congratulations — Asce sent you a message in your inbox 💋', '');
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
    notifyUser(m.id, 'guide', '💋 How SlutCamp works',
      'Asce sent you the playbook — how the app works and how you get paid 💰', '');
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
const GUIDE_VIDEO_TEXT = '🎬 Watch your 1-minute tour: https://slutcamp.app/video/model-guide.mp4';

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
    .run(conv.id, admin.id, GUIDE_VIDEO_TEXT);
  db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?").run(conv.id);
  db.prepare("UPDATE users SET guide_video_sent_at = datetime('now') WHERE id = ?").run(m.id);
  try {
    notifyUser(m.id, 'guide_video', '🎬 Your 1-minute tour is here',
      'Asce sent you a quick video tour of how SlutCamp works 💋', '');
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
const ATH_VIDEO_TEXT = '📲 Put SlutCamp on your home screen — watch this, takes 30 seconds: https://slutcamp.app/video/add-to-home-screen.mp4';

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
    .run(conv.id, admin.id, ATH_VIDEO_TEXT);
  db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?").run(conv.id);
  db.prepare("UPDATE users SET ath_video_sent_at = datetime('now') WHERE id = ?").run(m.id);
  try {
    notifyUser(m.id, 'home_screen_video', '📲 Put SlutCamp on your home screen',
      'Asce sent you a 30-second video showing how to add SlutCamp to your home screen 💋', '');
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
    notifyUser(m.id, 'id_verify', '🪪 One last step: verify your ID',
      'It unlocks going live and getting paid — 2 minutes in Settings 💋', '');
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
    notifyUser(m.id, 'affiliate_program', '💰 Make money bringing models',
      'Earn 20% of everything your recruited models make — reply here for your link 💋', '');
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
          'Fans can now buy requests from YOUR list on live — build it in your live controls 💋', '');
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
          'Agreement v1.2 is ready — open the app to read and sign 💋', '');
      } catch (e) { /* the bell is a bonus; the message is the deliverable */ }
      sent++;
    } catch (e) { /* one bad thread must not block the rest */ }
  }
  if (sent > 0 || models.length === 0) {
    db.prepare("UPDATE platform_stats SET agreement_12_announced_at = datetime('now') WHERE id = 1").run();
  }
  return sent;
}

function seed() {
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

/* ------------------------------------------------------------------ */
/* Public: guest tokens + model browsing (no login needed)              */
/* ------------------------------------------------------------------ */

// POST /api/guest/token → {guest_token} — anonymous visitor identity
app.post('/api/guest/token', (req, res) => {
  const token = crypto.randomBytes(16).toString('hex');
  res.json({ guest_token: token });
});

// GET /api/models — PUBLIC so guests can browse before signing up.
// Ranking: featured (SlutCamp Live) pinned first; regular models ordered by
// rank_score = total_sales ($) + likes_count (1 like = $1 sold = 1 point).
// total_sales = lifetime gross fan spend from transactions attributed to the
// model, excluding 'payout' rows (money OUT to the model, not sales);
// refund rows are negative and net against sales automatically.
app.get('/api/models', (req, res) => {
  const rows = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.presence_override, m.bio, m.per_message_cents,
           m.per_minute_cents, m.per_voice_cents, m.is_online, m.photo_url,
           m.preview_video_url, m.is_featured,
           ls.id AS live_session_id, ls.explicit_rate_cents AS live_explicit_rate_cents,
           (SELECT COUNT(*) FROM live_viewers WHERE session_id = ls.id) AS live_viewers,
           (SELECT COUNT(*) FROM model_likes WHERE model_id = u.id) AS like_count,
           (SELECT COALESCE(SUM(gross_cents), 0) FROM transactions
             WHERE model_id = u.id AND type <> 'payout' AND is_test = 0) AS total_sales_cents
    FROM users u JOIN models m ON m.user_id = u.id
    LEFT JOIN live_sessions ls ON ls.model_id = u.id AND ls.status = 'live'
    WHERE u.role = 'model' AND u.banned = 0 AND m.is_hidden = 0
    ORDER BY m.is_featured DESC,
             (total_sales_cents / 100.0 + like_count) DESC,
             like_count DESC,
             (CASE u.presence_override WHEN 'on' THEN 1 WHEN 'off' THEN 0 ELSE m.is_online END) DESC,
             u.created_at DESC, u.display_name ASC
  `).all();
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
  res.json({ models: visible.map((r) => {
    const sched = db.prepare(`SELECT day_of_week, start_time FROM live_schedule
      WHERE model_id = ? ORDER BY day_of_week, start_time`).all(r.id);
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const summary = sched.length
      ? sched.map((s) => `${days[s.day_of_week]} ${s.start_time.replace(/^0/, '')}`).join(', ')
      : '';
    const { presence_override, ...pub } = r;
    return { ...pub, is_online: effectiveOnline(presence_override, r.is_online),
      is_live: !!r.live_session_id, is_featured: !!r.is_featured,
      live_viewers: r.live_viewers || 0, schedule_summary: summary, liked: likedSet.has(r.id),
      likes_count: r.like_count || 0,
      total_sales: Math.round(r.total_sales_cents || 0) / 100,
      rank_score: Math.round(((r.total_sales_cents || 0) / 100 + (r.like_count || 0)) * 100) / 100 };
  }) });
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

  const id = createUser(username.trim(), password, finalRole, display_name.trim().slice(0, 40), dob, signupLanguage(req));
  recordAgeAttestation(id, req);

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
  const out = { user: getUserPublic(req.user), wallet };
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
  if (!['en', 'es', 'pt'].includes(lang))
    return res.status(400).json({ error: 'bad_language', message: 'Supported languages: en, es, pt.' });
  db.prepare('UPDATE users SET language = ? WHERE id = ?').run(lang, req.user.id);
  res.json({ ok: true, language: lang });
});

// Model welcome celebration — mark it seen so it shows exactly once.
app.post('/api/me/welcomed', identMiddleware, requireUser, (req, res) => {
  db.prepare("UPDATE users SET welcomed_at = datetime('now') WHERE id = ? AND welcomed_at IS NULL")
    .run(req.user.id);
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
  const convs = db.prepare(
    `SELECT c.* FROM conversations c WHERE ${sql} ORDER BY c.updated_at DESC`).all(...params);
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
           mi.price_cents AS media_price_cents, mi.duration_sec AS media_duration_sec
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
      media = { id: m.media_id, kind: m.media_kind, price_cents: m.media_price_cents,
                duration_sec: m.media_duration_sec, unlocked };
    }
    const { media_kind, media_mime, media_price_cents, media_duration_sec, ...rest } = m;
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
        return res.status(402).json({ error: 'insufficient_credits', needed_cents: costCents,
          balance_cents: getWallet(req.ident.user.id).credits_cents });
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
          return res.status(402).json({ error: 'insufficient_credits', needed_cents: costCents,
            balance_cents: getWallet(req.ident.user.id).credits_cents });
        }
      }
    }

    const mediaId = db.prepare(
      `INSERT INTO media_items (conversation_id, sender_id, guest_token, kind, mime, file_path, price_cents, duration_sec)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(conv.id,
          req.ident.kind === 'user' ? req.ident.user.id : null,
          req.ident.kind === 'guest' ? req.ident.token : null,
          kind, req.file.mimetype, req.file.path, priceCents, durationSec).lastInsertRowid;

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
    const receiverMedia = { id: mediaId, kind, price_cents: priceCents,
      duration_sec: durationSec, unlocked: priceCents === 0 };
    const full = { ...msg, sender_name: msg.sender_name || 'Guest Fan',
                   sender_role: msg.sender_role || 'fan',
                   media: { ...receiverMedia, unlocked: true },
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
    return res.status(402).json({ error: 'insufficient_credits', needed_cents: media.price_cents,
      balance_cents: getWallet(req.user.id).credits_cents });
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
  res.setHeader('Content-Type', media.mime);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  return res.sendFile(path.resolve(media.file_path));
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
    return res.status(402).json({ error: 'insufficient_credits', needed_cents: amountCents,
      balance_cents: getWallet(req.user.id).credits_cents });
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
    if (e.message === 'insufficient_credits')
      return res.status(402).json({ error: 'insufficient_credits', needed_cents: item.price_cents,
        balance_cents: getWallet(req.user.id).credits_cents });
    throw e;
  }
  db.prepare(`INSERT INTO tip_sends (fan_id, model_id, menu_id, price_cents, context)
              VALUES (?,?,?,?,?)`)
    .run(req.user.id, modelId, item.id, item.price_cents, context);

  // Notify the model (in-app + WS). Fans don't need a row for their own tip.
  notifyUser(modelId, 'tip', `💰 ${req.user.display_name || 'A fan'} tipped ${item.emoji} ${item.label}!`,
    `${fmt$(item.price_cents)} tip received`, null);
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
const CONTRACT_VERSION = '1.2';
const MODEL_CONTRACT = {
  version: CONTRACT_VERSION,
  updated: 'October 15, 2026',
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
      body: 'You add your bank details in the app and request withdrawals of your available balance at any time. Payouts are processed manually by SlutCamp on the Company\'s own schedule — there is no guaranteed payout date. Pending withdrawal requests may take several business days.',
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
      title: '13. Plain-Language Disclaimer',
      body: 'This is a plain-language summary written for clarity — it is NOT legal advice, and it has not been reviewed by an attorney. The Company strongly recommends you have your own attorney review this Agreement before signing. If any part of this Agreement is found unenforceable, the rest still applies.',
    },
  ],
};

/* Recruiter agreement — for models/partners who recruit other models */
const RECRUITER_CONTRACT_VERSION = 'R1.0';
const RECRUITER_CONTRACT = {
  version: RECRUITER_CONTRACT_VERSION,
  updated: 'October 12, 2026',
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
      body: 'You earn 20% of everything each model you recruit earns on the platform (their 60% share — your cut comes from the Company\'s portion, not from the model). The model keeps her full 60%. Payments are processed on the Company\'s payout schedule.',
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
      title: '9. Plain-Language Disclaimer',
      body: 'This is a plain-language summary written for clarity — it is NOT legal advice, and it has not been reviewed by an attorney. The Company strongly recommends you have your own attorney review this Agreement before signing. If any part of this Agreement is found unenforceable, the rest still applies.',
    },
  ],
};

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
          is_online } = req.body || {};
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
  res.json({
    version: MODEL_CONTRACT.version,
    updated: MODEL_CONTRACT.updated,
    sections: MODEL_CONTRACT.sections,
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
  res.json({
    version: RECRUITER_CONTRACT.version,
    updated: RECRUITER_CONTRACT.updated,
    sections: RECRUITER_CONTRACT.sections,
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
  const hash = bcrypt.hashSync(pwd, 10);
  const info = db.prepare(
    'INSERT INTO users (username, password_hash, role, display_name, dob) VALUES (?,?,?,?,?)'
  ).run(uname, hash, 'recruiter', dname, null); // attested 18+ at agreement — no fake DOB
  const userId = Number(info.lastInsertRowid);
  recordAgeAttestation(userId, req);
  db.prepare('INSERT INTO wallets (user_id) VALUES (?)').run(userId);
  // Create recruiter record with referral code
  let rcode;
  do { rcode = crypto.randomBytes(4).toString('hex'); }
  while (db.prepare('SELECT id FROM recruiters WHERE referral_code = ?').get(rcode));
  db.prepare('INSERT INTO recruiters (user_id, name, referral_code) VALUES (?,?,?)')
    .run(userId, dname, rcode);
  // Mark invite used
  db.prepare(`UPDATE invite_links SET used_by = ?, used_at = datetime('now') WHERE id = ?`)
    .run(userId, inv.id);
  // Auto-sign the recruiter agreement (they agreed on the signup screen)
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
  db.prepare(`INSERT INTO contract_signatures (user_id, contract_version, display_name, ip)
              VALUES (?, ?, ?, ?)`)
    .run(userId, RECRUITER_CONTRACT.version, dname, ip.slice(0, 60));
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
  res.json({ withdrawals: rows, available_cents: getModelAvailable(req.user.id) });
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
    endCall(callId, 'insufficient_credits');
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
  notifyUser(fresh.fan_id, 'facetime', '📹 Your turn!',
    `${fresh.model_name} is ready for your FaceTime — join in the next 90 seconds or the spot passes on.`,
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
    return res.status(402).json({ error: 'insufficient_credits', needed_cents: amount });
  }
  const info = db.prepare(`INSERT INTO facetime_requests (fan_id, model_id, duration_min, amount_cents)
    VALUES (?,?,?,?)`).run(req.user.id, row.id, duration, amount);
  const fresh = ftGet(Number(info.lastInsertRowid));
  pushToSubject(`u:${row.id}`, { type: 'facetime:request', request: ftPublic(fresh) });
  // The bell row is the request's persistent home: its link carries the
  // request id so her notification box can render live Accept/Decline
  // actions against it until she acts (owner ruling, Oct 15).
  notifyUser(row.id, 'facetime', '📹 FaceTime request',
    `${req.user.display_name} wants a ${duration}-min FaceTime with you — $${(amount / 100).toFixed(2)}.`,
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
  notifyUser(fresh.fan_id, 'facetime', '📹 She accepted!',
    `${fresh.model_name} accepted your FaceTime — join in the next 90 seconds.`, '/#chat');
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
        return res.status(402).json({ error: 'insufficient_credits', needed_cents: extra });
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

const adminOnly = [identMiddleware, requireUser, requireRole('admin')];

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
    // Out of credits → back to blurred free preview
    stopLivePayTimer(sessionId, fanId);
    db.prepare(`INSERT INTO blur_events (session_id, fan_id, event, detail)
                VALUES (?,?,'pay_stopped','insufficient_credits')`).run(sessionId, fanId);
    pushToSubject(`u:${fanId}`, { type: 'live:pay_stopped', session_id: sessionId,
      reason: 'insufficient_credits',
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
  // Notify followers: "she's live!"
  const me = db.prepare('SELECT display_name FROM users WHERE id = ?').get(req.user.id);
  const followers = db.prepare('SELECT fan_id FROM follows WHERE model_id = ?').all(req.user.id);
  for (const f of followers) {
    notifyUser(f.fan_id, 'live',
      `🔴 ${me.display_name} just went live!`,
      title ? `“${title}” — tap to watch.` : 'Tap to watch her now.',
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
    if (e.message === 'insufficient_credits')
      return res.status(402).json({ error: 'insufficient_credits',
        needed_cents: entryCents, balance_cents: getWallet(req.user.id).credits_cents });
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
    if (e.message === 'insufficient_credits')
      return res.status(402).json({ error: 'insufficient_credits',
        needed_cents: item.price_cents, balance_cents: getWallet(req.user.id).credits_cents });
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
    if (e.message === 'insufficient_credits')
      return res.status(402).json({ error: 'insufficient_credits',
        needed_cents: gift.price_cents, balance_cents: getWallet(req.user.id).credits_cents });
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
      if (e.message === 'insufficient_credits')
        return res.status(402).json({ error: 'insufficient_credits',
          needed_cents: gift.price_cents, balance_cents: getWallet(req.user.id).credits_cents });
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
    if (e.message === 'insufficient_credits')
      return res.status(402).json({ error: 'insufficient_credits',
        needed_cents: gift.price_cents, balance_cents: getWallet(req.user.id).credits_cents });
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
    if (e.message === 'insufficient_credits')
      return res.status(402).json({ error: 'insufficient_credits',
        needed_cents: totalCents, balance_cents: getWallet(req.user.id).credits_cents });
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
    if (e.message === 'insufficient_credits')
      return res.status(402).json({ error: 'insufficient_credits',
        needed_cents: fee, balance_cents: getWallet(req.user.id).credits_cents });
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
      `🎥 ${req.user.display_name} wants to join your live!`,
      `Tap to review and approve (paid ${fmt(fee)})`,
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
  const body = `We're so sorry 💔 ${modelName} couldn't make your 1-on-1 today — that's on us. ` +
    `Your ${amt} has been refunded in full to your balance. She'd love to make it up to you — ` +
    `her latest openings are on her booking calendar 💋`;
  db.prepare('INSERT INTO messages (conversation_id, sender_id, body) VALUES (?,?,?)')
    .run(conv.id, admin.id, body);
  db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?").run(conv.id);
  try { notifyUser(fanId, 'message', '💬 SlutCamp', body.slice(0, 90), ''); } catch (e) { /* bell is a bonus */ }
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
  const copy = `📹 Your FaceTime call with ${modelName} is now active — you have 3 minutes to get to the call.`;
  pushToUser(b.fan_id, { type: 'booking:live', booking_id: b.id,
    fan_join_deadline: deadline, message: copy });
  try { notifyUser(b.fan_id, 'booking', '📹 Your 1-on-1 is now active', copy, '/#bookings'); }
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
  try { notifyUser(b.model_id, 'booking', '💔 Fan no-show',
    `💔 ${fanName} never showed up for your 1-on-1 — the booking is paid, you keep it.`, '/#bookings'); }
  catch (e) { /* bell is a bonus */ }
  try { notifyUser(b.fan_id, 'booking', '📅 You missed your 1-on-1',
    `You missed your 1-on-1 with ${modelName} — no-show bookings aren't refunded (your slot was reserved for you).`, '/#bookings'); }
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
  try { notifyUser(b.model_id, 'booking', '📅 You missed a 1-on-1',
    `You missed your 1-on-1 with ${fanName} — he was refunded in full.`, '/#bookings'); }
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
  { col: 'reminded_3d', ms: 3 * 24 * 60 * 60 * 1000, label: 'in 3 days', tail: '' },
  { col: 'reminded_3h', ms: 3 * 60 * 60 * 1000, label: 'in 3 hours', tail: '' },
  { col: 'reminded_15m', ms: 15 * 60 * 1000, label: 'in 15 minutes', tail: ' — get ready!' },
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
        notifyUser(b.model_id, 'booking', '📅 1-on-1 reminder',
          `📅 Reminder: your 1-on-1 with ${fanName} is ${r.label} — ` +
          `${chiWhenLabel(b.scheduled_at)}, ${b.duration_min} min${r.tail} 💋`, '/#bookings');
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
      notifyUser(b.model_id, 'booking', '📅 Your 1-on-1 is now active',
        `📅 Your 1-on-1 with ${fanName} is now active — you have 5 minutes to get to the call or their money will be fully refunded.`, '/#bookings');
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
    return res.status(402).json({ error: 'insufficient_credits',
      needed_cents: total, balance_cents: getWallet(req.user.id).credits_cents });
  }
  pushToUser(model.id, { type: 'booking:booked', booking_id: bookingId,
    fan_id: req.user.id, fan_name: req.user.display_name,
    scheduled_at: startsAt, duration_min: minutes, total_cents: total });
  try {
    notifyUser(model.id, 'booking', '📅 New 1-on-1 booked',
      `${req.user.display_name} booked a ${minutes}-min 1-on-1 — ${chiWhenLabel(startsAt)}.`,
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
    if (e.message === 'insufficient_credits')
      return res.status(402).json({ error: 'insufficient_credits',
        needed_cents: total, balance_cents: getWallet(req.user.id).credits_cents });
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
  try { notifyUser(m.id, 'message', '💬 Asce (Admin)', body.slice(0, 90), ''); } catch (e) { /* bell is a bonus */ }
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
  db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
  res.json({ ok: true });
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
    available_cents: wallet.earnings_cents - wallet.paid_out_cents - pending,
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
const ccbillSvc = createCcbillService({ db, txn, notifyUser });

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
  next();
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
  res.json({
    payouts: db.prepare(`
      SELECT u.id, u.display_name, w.earnings_cents, w.paid_out_cents,
             (w.earnings_cents - w.paid_out_cents) AS pending_cents
      FROM users u JOIN wallets w ON w.user_id = u.id
      WHERE u.role = 'model' ORDER BY pending_cents DESC`).all(),
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
  const wallet = getWallet(u.id);
  const pending = wallet.earnings_cents - wallet.paid_out_cents;
  if (!Number.isInteger(amount) || amount <= 0 || amount > pending)
    return res.status(400).json({ error: 'bad_amount', pending_cents: pending });
  db.prepare('UPDATE wallets SET paid_out_cents = paid_out_cents + ? WHERE user_id = ?').run(amount, u.id);
  db.prepare(`INSERT INTO transactions (model_id, type, gross_cents, model_cents, note, ip)
              VALUES (?, 'payout', ?, ?, 'Paid out to model', ?)`).run(u.id, amount, amount, clientIp(req));
  res.json({ ok: true, pending_cents: pending - amount });
});

// Admin: all withdrawal requests with full bank details (to send the money)
app.get('/api/admin/withdrawals', ...adminOnly, (req, res) => {
  res.json({ withdrawals: db.prepare(`
    SELECT w.id, w.model_id, w.amount_cents, w.status, w.requested_at, w.decided_at, w.note,
           u.display_name AS model_name, u.username AS model_username, u.role AS user_role,
           pa.holder_name, pa.routing_number, pa.account_number
    FROM withdrawals w JOIN users u ON u.id = w.model_id
    LEFT JOIN payout_accounts pa ON pa.model_id = w.model_id
    ORDER BY CASE w.status WHEN 'pending' THEN 0 WHEN 'paid' THEN 1 ELSE 2 END, w.id DESC`).all() });
});

// Admin: mark a withdrawal paid (money sent manually outside the app)
app.post('/api/admin/withdrawals/:id/pay', ...adminOnly, (req, res) => {
  const w = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(req.params.id);
  if (!w) return res.status(404).json({ error: 'not_found' });
  if (w.status !== 'pending') return res.status(409).json({ error: 'not_pending' });
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
  // 2. Delete old model profile photos (photo-*.jpg in uploads, not current)
  const currentPhotos = new Set(
    db.prepare(`SELECT photo_url FROM models WHERE photo_url != ''`).all().map((r) => r.photo_url));
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
  db.prepare(`INSERT INTO platform_stats (id, earnings_cents, commission_pct) VALUES (1, 0, 30)
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
  console.log('Seeded logins: admin/admin123 · bunny|stacey|bella/model123 · fandemo/fan123');
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
