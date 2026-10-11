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

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Uploads dir for PPV media + voice notes (served only via authed /api/media/:id/file)
const UPLOAD_DIR = path.join(__dirname, 'uploads');
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
  limits: { fileSize: 30 * 1024 * 1024 }, // 30MB cap (short videos)
  fileFilter: (req, file, cb) => {
    const ok = /^(image\/(jpeg|png|webp)|video\/mp4|audio\/(mp4|mpeg|ogg|webm|wav|x-m4a))/.test(file.mimetype);
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

/* ------------------------------------------------------------------ */
/* Database                                                            */
/* ------------------------------------------------------------------ */

const db = new DatabaseSync(path.join(__dirname, 'wogent-chat.db'));
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
  explicit_mic_join_cents INTEGER NOT NULL DEFAULT 1500
);

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

-- A conversation is either fan<->model (fan_id set) or guest<->model (guest_token set)
CREATE TABLE IF NOT EXISTS conversations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  fan_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
  guest_token TEXT,
  model_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_paused   INTEGER NOT NULL DEFAULT 0,
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
  created_by INTEGER NOT NULL REFERENCES users(id),
  used_by    INTEGER REFERENCES users(id),
  is_revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  used_at    TEXT
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
addColumnIfMissing('models', 'per_voice_cents', 'INTEGER NOT NULL DEFAULT 299');
addColumnIfMissing('models', 'explicit_rate_cents', 'INTEGER NOT NULL DEFAULT 499');
addColumnIfMissing('models', 'photo_url', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('live_sessions', 'title', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('live_viewers', 'explicit_until', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('live_viewers', 'explicit_paid', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('platform_stats', 'explicit_gift_grace_sec', 'INTEGER NOT NULL DEFAULT 180');
addColumnIfMissing('messages', 'gift_json', 'TEXT'); // TikTok-style gift payload on chat gift messages
addColumnIfMissing('priority_messages', 'voice', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('live_join_requests', 'is_explicit', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('live_join_requests', 'mode', "TEXT NOT NULL DEFAULT 'video'");
addColumnIfMissing('models', 'explicit_join_cents', 'INTEGER NOT NULL DEFAULT 2500');
addColumnIfMissing('models', 'explicit_mic_join_cents', 'INTEGER NOT NULL DEFAULT 1500');
addColumnIfMissing('calls', 'booking_id', 'INTEGER REFERENCES bookings(id)');
addColumnIfMissing('platform_stats', 'explicit_entry_cents', 'INTEGER NOT NULL DEFAULT 499');
addColumnIfMissing('platform_stats', 'admin_phone', 'TEXT');
addColumnIfMissing('platform_stats', 'admin_2fa_on', 'INTEGER NOT NULL DEFAULT 0');

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

// Model contract signatures (independent-contractor agreement)
db.exec(`
CREATE TABLE IF NOT EXISTS contract_signatures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
  contract_version TEXT NOT NULL,
  signed_at TEXT NOT NULL DEFAULT (datetime('now')),
  display_name TEXT NOT NULL,
  ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_contract_signatures_user ON contract_signatures(user_id);
`);

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
function chargeFan(fanId, modelId, grossCents, type, note) {
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
      (fan_id, model_id, type, gross_cents, model_cents, platform_cents, recruiter_id, recruiter_cents, note)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(fanId, modelId, type, grossCents, modelCents, platformCents, recruiterId, recruiterCents, note || null);
  });
  return { modelCents, platformCents, recruiterCents };
}

/* Reverse a charge: fan gets grossCents back; model + platform earnings reduced.
   Used when the model declines a paid join-live request (full refund). */
function refundFan(fanId, modelId, grossCents, type, note) {
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
      (fan_id, model_id, type, gross_cents, model_cents, platform_cents, recruiter_id, recruiter_cents, note)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(fanId, modelId, type, -grossCents, -modelCents, -platformCents, recruiterId, -recruiterCents, note || null);
  });
  return { modelCents, platformCents, recruiterCents };
}

/* ---------------- identity: logged-in user OR guest ---------------- */

const sessions = new Map();      // token -> userId
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
  sessions.set(token, userId);
  return token;
}

// Returns {kind:'user',user} | {kind:'guest',token} | {kind:'banned'} | null
function getIdentity(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) {
    const userId = sessions.get(h.slice(7));
    if (!userId) return null;
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) return null;
    if (user.banned) return { kind: 'banned' };
    return { kind: 'user', user };
  }
  const g = req.headers['x-guest-token'] || (req.body && req.body.guest_token) || req.query.guest_token;
  if (g && typeof g === 'string' && /^[a-f0-9]{32}$/.test(g)) {
    if (bannedGuests.has(g)) return { kind: 'banned' };
    return { kind: 'guest', token: g };
  }
  return null;
}

const subjectKey = (ident) =>
  ident.kind === 'user' ? `u:${ident.user.id}` : `g:${ident.token}`;

function identMiddleware(req, res, next) {
  const ident = getIdentity(req);
  if (!ident) return res.status(401).json({ error: 'not_logged_in' });
  if (ident.kind === 'banned') return res.status(403).json({ error: 'banned' });
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

// Notify every online admin about something (safety incidents, etc.)
function pushToAdmins(event) {
  const admins = db.prepare(`SELECT id FROM users WHERE role = 'admin'`).all();
  for (const a of admins) pushToUser(a.id, event);
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

function createUser(username, password, role, displayName, dob) {
  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare(
    'INSERT INTO users (username, password_hash, role, display_name, dob) VALUES (?,?,?,?,?)'
  ).run(username, hash, role, displayName, dob);
  db.prepare('INSERT INTO wallets (user_id) VALUES (?)').run(info.lastInsertRowid);
  if (role === 'model') db.prepare('INSERT INTO models (user_id) VALUES (?)').run(info.lastInsertRowid);
  return Number(info.lastInsertRowid);
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

/* ------------------------------------------------------------------ */
/* Public: guest tokens + model browsing (no login needed)              */
/* ------------------------------------------------------------------ */

// POST /api/guest/token → {guest_token} — anonymous visitor identity
app.post('/api/guest/token', (req, res) => {
  const token = crypto.randomBytes(16).toString('hex');
  res.json({ guest_token: token });
});

// GET /api/models — PUBLIC so guests can browse before signing up
app.get('/api/models', (req, res) => {
  const rows = db.prepare(`
    SELECT u.id, u.display_name, m.bio, m.per_message_cents,
           m.per_minute_cents, m.per_voice_cents, m.is_online, m.photo_url,
           ls.id AS live_session_id, ls.explicit_rate_cents AS live_explicit_rate_cents
    FROM users u JOIN models m ON m.user_id = u.id
    LEFT JOIN live_sessions ls ON ls.model_id = u.id AND ls.status = 'live'
    WHERE u.role = 'model' AND u.banned = 0
    ORDER BY ls.id DESC, m.is_online DESC, u.display_name ASC
  `).all();
  res.json({ models: rows.map((r) => {
    const sched = db.prepare(`SELECT day_of_week, start_time FROM live_schedule
      WHERE model_id = ? ORDER BY day_of_week, start_time`).all(r.id);
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const summary = sched.length
      ? sched.map((s) => `${days[s.day_of_week]} ${s.start_time.replace(/^0/, '')}`).join(', ')
      : '';
    return { ...r, is_live: !!r.live_session_id, schedule_summary: summary };
  }) });
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

  const id = createUser(username.trim(), password, finalRole, display_name.trim().slice(0, 40), dob);

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
  if (guest_token && /^[a-f0-9]{32}$/.test(guest_token)) {
    const gk = `g:${guest_token}`, uk = `u:${id}`;
    db.prepare(`UPDATE conversations SET fan_id = ?, guest_token = NULL
                WHERE guest_token = ?`).run(id, guest_token);
    db.prepare(`UPDATE free_trials SET subject_key = ? WHERE subject_key = ?`).run(uk, gk);
    db.prepare(`UPDATE strikes SET subject_key = ? WHERE subject_key = ?`).run(uk, gk);
    db.prepare(`UPDATE messages SET guest_token = NULL WHERE guest_token = ?
                AND conversation_id IN (SELECT id FROM conversations WHERE fan_id = ?)`)
      .run(guest_token, id);
  }

  const token = createSession(id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  res.json({ token, user: getUserPublic(user) });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password, guest_token } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get((username || '').trim());
  if (!user || !bcrypt.compareSync(password || '', user.password_hash))
    return res.status(401).json({ error: 'bad_login' });
  if (user.banned) return res.status(403).json({ error: 'banned' });
  // Admin can ONLY log in via the secret admin route (#boss). Never here.
  if (user.role === 'admin') return res.status(403).json({ error: 'not_here' });

  if (guest_token && /^[a-f0-9]{32}$/.test(guest_token)) {
    const gk = `g:${guest_token}`, uk = `u:${user.id}`;
    db.prepare(`UPDATE conversations SET fan_id = ?, guest_token = NULL
                WHERE guest_token = ? AND fan_id IS NULL`).run(user.id, guest_token);
    db.prepare(`UPDATE free_trials SET subject_key = ? WHERE subject_key = ?`).run(uk, gk);
    db.prepare(`UPDATE strikes SET subject_key = ? WHERE subject_key = ?`).run(uk, gk);
  }

  const token = createSession(user.id);
  res.json({ token, user: getUserPublic(user) });
});

app.post('/api/auth/logout', identMiddleware, requireUser, (req, res) => {
  sessions.delete((req.headers.authorization || '').slice(7));
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Admin auth — secret route only (#boss). Public /api/auth/login       */
/* rejects admins outright. SMS 2FA via Twilio.                         */
/* ------------------------------------------------------------------ */

function getAdminUser(username) {
  const u = db.prepare("SELECT * FROM users WHERE username = ? AND role = 'admin'").get((username || '').trim());
  return u || null;
}

function checkAdminPassword(user, password) {
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) return false;
  if (user.banned) return false;
  return true;
}

// Step 1: password → (needs_phone | needs_2fa + temp token | full token if 2FA off)
app.post('/api/auth/admin-login', async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (adminRateLimited(ip)) return res.status(429).json({ error: 'too_many_attempts' });
  const { username, password } = req.body || {};
  const user = getAdminUser(username);
  if (!checkAdminPassword(user, password)) return res.status(401).json({ error: 'bad_login' });

  const { phone, on } = getAdmin2FAState();
  if (!phone) return res.json({ needs_phone: true });

  if (on) {
    const code = issueSmsCode(user.id);
    const sent = await sendAdminSMS(phone, `SlutCamp admin code: ${code}. Expires in 5 min.`);
    if (!sent.ok) return res.status(500).json({ error: sent.error });
    return res.json({ needs_2fa: true, temp_token: createAdminTempToken(user.id) });
  }
  // 2FA not on (shouldn't happen after setup, but don't lock out)
  const token = createSession(user.id);
  res.json({ token, user: getUserPublic(user) });
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

/* ------------------------------------------------------------------ */
/* Conversations + messages (guests allowed, models free to reply)     */
/* ------------------------------------------------------------------ */

function otherParty(conv, ident) {
  const meIsFanSide = ident.kind === 'user'
    ? conv.fan_id === ident.user.id
    : conv.guest_token === ident.token;
  const otherId = meIsFanSide ? conv.model_id : conv.fan_id;
  if (!otherId) { // guest on the other side (model viewing a guest chat)
    return { id: 0, display_name: 'Guest Fan', role: 'fan', is_online: true,
             per_message_cents: 0, per_minute_cents: 0, is_guest: true };
  }
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(otherId);
  const m = u.role === 'model' ? db.prepare('SELECT * FROM models WHERE user_id = ?').get(otherId) : null;
  return { ...getUserPublic(u), is_online: m ? !!m.is_online : false,
           photo_url: m ? (m.photo_url || '') : '',
           per_message_cents: m ? m.per_message_cents : 0,
           per_minute_cents: m ? m.per_minute_cents : 0 };
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
  res.json({ messages: msgs.reverse().map((m) => {
    let media = null;
    if (m.media_id) {
      // Unlocked if: I'm the sender, I'm admin, or I (fan) unlocked it
      let unlocked = false;
      if (req.ident.kind === 'user') {
        const uid = req.ident.user.id;
        if (req.ident.user.role === 'admin' || m.sender_id === uid) unlocked = true;
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
    is_paused: !!conv.is_paused, free_remaining: freeRemaining(req.ident, model.id) } });
});

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

  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversation_id);
  if (!conv) return res.status(404).json({ error: 'not_found' });
  const mine = req.ident.kind === 'user'
    ? (conv.fan_id === req.ident.user.id || conv.model_id === req.ident.user.id)
    : conv.guest_token === req.ident.token;
  if (!mine) return res.status(403).json({ error: 'forbidden' });
  if (conv.is_paused)
    return res.status(423).json({ error: 'chat_paused',
      message: '⚠️ This chat is paused by the safety monitor.' });

  const isModelSender = req.ident.kind === 'user' && req.ident.user.role === 'model';

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

    db.prepare('UPDATE conversations SET is_paused = 1 WHERE id = ?').run(conv.id);
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
        chargeFan(req.ident.user.id, conv.model_id, costCents, 'message', 'Chat message');
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
                 sender_role: msg.sender_role || 'fan' };

  // Deliver to the other side
  const otherKey = req.ident.kind === 'user'
    ? (isModelSender
        ? (conv.fan_id ? `u:${conv.fan_id}` : `g:${conv.guest_token}`)
        : `u:${conv.model_id}`)
    : `u:${conv.model_id}`;
  pushToSubject(otherKey, { type: 'chat:new', conversation_id: conv.id, message: full });

  res.json({ message: full, cost_cents: costCents, free_remaining: freeLeft,
    balance_cents: req.ident.kind === 'user' ? getWallet(req.ident.user.id).credits_cents : null });
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
// Models attach PPV with a price; fans can send voice notes (billed as normal message).
app.post('/api/media/send', identMiddleware, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: 'bad_file', message: 'Use JPG/PNG/MP4 or an audio file under 30MB.' });
    if (!req.file) return res.status(400).json({ error: 'no_file' });
    if (req.ident.kind === 'user' && req.ident.user.role === 'admin')
      return res.status(403).json({ error: 'admins_cannot_chat' });

    const conversation_id = parseInt(req.body.conversation_id);
    const kind = req.body.kind;
    if (!['ppv_image', 'ppv_video', 'voice'].includes(kind)) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'bad_kind' });
    }
    const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversation_id);
    if (!conv) { fs.unlink(req.file.path, () => {}); return res.status(404).json({ error: 'not_found' }); }
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

    // Price: models set whatever they want for PPV/voice. Fans' voice notes = normal message billing.
    let priceCents = 0;
    if (isModelSender && kind !== 'voice') {
      priceCents = parseInt(req.body.price_cents) || 0;
      if (priceCents < 0 || priceCents > 100000) { fs.unlink(req.file.path, () => {}); return res.status(400).json({ error: 'bad_price' }); }
    } else if (isModelSender && kind === 'voice') {
      const m = db.prepare('SELECT per_voice_cents FROM models WHERE user_id = ?').get(req.ident.user.id);
      priceCents = parseInt(req.body.price_cents);
      if (!Number.isInteger(priceCents) || priceCents < 0) priceCents = m ? m.per_voice_cents : 299;
    }
    const durationSec = Math.max(0, Math.min(3600, parseInt(req.body.duration_sec) || 0));

    // Fan/guest billing for sending (models send free; fan voice note = normal message rate)
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
        const model = db.prepare('SELECT * FROM models WHERE user_id = ?').get(conv.model_id);
        costCents = model.per_message_cents;
        try {
          chargeFan(req.ident.user.id, conv.model_id, costCents, 'message', 'Voice note message');
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
                   media: { ...receiverMedia, unlocked: true } }; // sender always sees own

    const otherKey = req.ident.kind === 'user'
      ? (isModelSender
          ? (conv.fan_id ? `u:${conv.fan_id}` : `g:${conv.guest_token}`)
          : `u:${conv.model_id}`)
      : `u:${conv.model_id}`;
    const receiverMsg = { ...full, media: receiverMedia };
    pushToSubject(otherKey, { type: 'chat:new', conversation_id: conv.id, message: receiverMsg });

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

  const already = db.prepare('SELECT 1 FROM media_unlocks WHERE media_id = ? AND fan_id = ?')
    .get(media.id, req.user.id);
  if (already || media.price_cents === 0)
    return res.json({ ok: true, already: true, file_url: `/api/media/${media.id}/file` });

  const type = media.kind === 'voice' ? 'voice' : 'ppv';
  try {
    chargeFan(req.user.id, conv.model_id, media.price_cents, type,
      `${MEDIA_LABELS[media.kind]} unlock`);
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
  fileTokens.set(token, { mediaId: media.id, userId: uid, expires: Date.now() + 90 * 1000 });
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
    fileTokens.delete(req.query.t); // single use
    res.setHeader('Content-Type', media.mime);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    return fs.createReadStream(media.file_path).pipe(res);
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
  fs.createReadStream(media.file_path).pipe(res);
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
    chargeFan(req.user.id, conv.model_id, amountCents, 'tip', 'Fan tip');
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
/* Credits (STUBBED — CCBill/Segpay plugs in here later)               */
/* ------------------------------------------------------------------ */

const CREDIT_PACKAGES = [
  { id: 'p10',  credits_cents: 1000,  price_cents: 1000,  label: '$10' },
  { id: 'p25',  credits_cents: 2500,  price_cents: 2500,  label: '$25' },
  { id: 'p50',  credits_cents: 5000,  price_cents: 5000,  label: '$50' },
  { id: 'p100', credits_cents: 10000, price_cents: 10000, label: '$100' },
];

// Model independent-contractor agreement (served to models for signing)
const CONTRACT_VERSION = '1.0';
const MODEL_CONTRACT = {
  version: CONTRACT_VERSION,
  updated: 'October 10, 2026',
  sections: [
    {
      title: '1. Parties',
      body: 'This Model Agreement ("Agreement") is between you, the performer ("Performer"), and World of Godz Entertainment LLC ("Company"), which operates the SlutCamp platform under the name Asce. By signing, you agree to everything below.',
    },
    {
      title: '2. Independent Contractor',
      body: 'You are an INDEPENDENT CONTRACTOR, not an employee of the Company. Nothing in this Agreement creates an employment, partnership, or agency relationship. You are responsible for your own taxes, insurance, and business expenses. The Company will not withhold taxes from your payouts, and you agree to report all income as required by law.',
    },
    {
      title: '3. Age & Identity Verification',
      body: 'You confirm you are at least 18 years old. You have completed (or will complete) government ID verification with Asce before going live, as required for 18 U.S.C. §2257 recordkeeping compliance. If you cannot verify your age and identity, you may not perform on the platform.',
    },
    {
      title: '4. Revenue Split & Your Rates',
      body: 'You keep 60% of everything fans spend on you (chats, calls, gifts, live access, priority messages, stage joins, bookings). The Company keeps 40%. You set your own rates inside the app within the allowed ranges: per-message, per-minute video, per voice note, and your explicit stage-join rates ($5–$100). The Company may change the platform-wide defaults or allowed ranges at any time.',
    },
    {
      title: '5. Payouts',
      body: 'You add your bank details in the app and request withdrawals of your available balance at any time. Payouts are processed manually by Asce on the Company\'s own schedule — there is no guaranteed payout date. Pending withdrawal requests may take several business days.',
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
      title: '12. Plain-Language Disclaimer',
      body: 'This is a plain-language summary written for clarity — it is NOT legal advice, and it has not been reviewed by an attorney. The Company strongly recommends you have your own attorney review this Agreement before signing. If any part of this Agreement is found unenforceable, the rest still applies.',
    },
  ],
};

app.get('/api/credits/packages', (req, res) => {
  res.json({ packages: CREDIT_PACKAGES, stubbed: true });
});

app.post('/api/credits/buy', identMiddleware, requireUser, requireRole('fan'), (req, res) => {
  res.status(501).json({ error: 'payment_not_connected',
    message: 'Payment processor coming soon — CCBill/Segpay will plug in here.' });
});

/* ------------------------------------------------------------------ */
/* Model: profile, rates, online toggle, earnings                       */
/* ------------------------------------------------------------------ */

app.put('/api/model/profile', identMiddleware, requireUser, requireRole('model'), (req, res) => {
  const { bio, per_message_cents, per_minute_cents, per_voice_cents, explicit_rate_cents,
          explicit_join_cents, explicit_mic_join_cents, is_online } = req.body || {};
  const updates = [], params = [];
  // Model-settable 1-on-1 rates (tighter ranges than the admin override)
  const rateRange = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  const badRate = (v, lo, hi) => v !== undefined && !rateRange(v, lo, hi);
  if (badRate(per_message_cents, 50, 1000) || badRate(per_minute_cents, 100, 2000) ||
      badRate(per_voice_cents, 50, 1000))
    return res.status(400).json({ error: 'bad_rate',
      message: 'Rates out of range.' });
  if (typeof bio === 'string') { updates.push('bio = ?'); params.push(bio.slice(0, 280)); }
  if (rateRange(per_message_cents, 50, 1000)) {
    updates.push('per_message_cents = ?'); params.push(per_message_cents);
  }
  if (rateRange(per_minute_cents, 100, 2000)) {
    updates.push('per_minute_cents = ?'); params.push(per_minute_cents);
  }
  if (rateRange(per_voice_cents, 50, 1000)) {
    updates.push('per_voice_cents = ?'); params.push(per_voice_cents);
  }
  if (Number.isInteger(explicit_rate_cents) && explicit_rate_cents >= 0 && explicit_rate_cents <= 20000) {
    updates.push('explicit_rate_cents = ?'); params.push(explicit_rate_cents);
  }
  if (Number.isInteger(explicit_join_cents) && explicit_join_cents >= 500 && explicit_join_cents <= 10000) {
    updates.push('explicit_join_cents = ?'); params.push(explicit_join_cents);
  }
  if (Number.isInteger(explicit_mic_join_cents) && explicit_mic_join_cents >= 500 && explicit_mic_join_cents <= 10000) {
    updates.push('explicit_mic_join_cents = ?'); params.push(explicit_mic_join_cents);
  }
  if (is_online === 0 || is_online === 1) { updates.push('is_online = ?'); params.push(is_online); }
  if (!updates.length) return res.status(400).json({ error: 'nothing_to_update' });
  params.push(req.user.id);
  db.prepare(`UPDATE models SET ${updates.join(', ')} WHERE user_id = ?`).run(...params);
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

/* ------------------------------------------------------------------ */
/* Model contract — independent-contractor agreement signing          */
/* ------------------------------------------------------------------ */

// Get the current contract + whether this model has signed it
app.get('/api/model/contract', identMiddleware, requireUser, requireRole('model'), (req, res) => {
  const sig = db.prepare('SELECT contract_version, signed_at FROM contract_signatures WHERE user_id = ?').get(req.user.id);
  res.json({
    version: MODEL_CONTRACT.version,
    updated: MODEL_CONTRACT.updated,
    sections: MODEL_CONTRACT.sections,
    signed: !!sig,
    signed_version: sig ? sig.contract_version : null,
    signed_at: sig ? sig.signed_at : null,
  });
});

// Sign the contract (typed name = electronic signature)
app.post('/api/model/contract/sign', identMiddleware, requireUser, requireRole('model'), (req, res) => {
  const name = String(req.body.display_name || '').trim().slice(0, 80);
  if (!name || name.length < 2) return res.status(400).json({ error: 'bad_name' });
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
  try {
    db.prepare(`INSERT INTO contract_signatures (user_id, contract_version, display_name, ip)
                VALUES (?, ?, ?, ?)`)
      .run(req.user.id, MODEL_CONTRACT.version, name, ip.slice(0, 60));
  } catch (e) {
    // Already signed — treat as idempotent success
    if (!String(e.message || '').includes('UNIQUE')) throw e;
  }
  res.json({ ok: true, version: MODEL_CONTRACT.version });
});

// Admin: list all models with contract signature status
app.get('/api/admin/contracts', identMiddleware, requireUser, requireRole('admin'), (req, res) => {
  const rows = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.banned,
           cs.contract_version, cs.signed_at, cs.display_name AS signed_name
    FROM users u
    LEFT JOIN contract_signatures cs ON cs.user_id = u.id
    WHERE u.role = 'model'
    ORDER BY u.display_name
  `).all();
  res.json({ contracts: rows, current_version: MODEL_CONTRACT.version });
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

app.get('/api/model/earnings', identMiddleware, requireUser, requireRole('model'), (req, res) => {
  const wallet = getWallet(req.user.id);
  const byFan = db.prepare(`
    SELECT COALESCE(u.display_name, 'Guest Fan') AS fan_name,
           SUM(t.model_cents) AS earned_cents, COUNT(*) AS payments
    FROM transactions t LEFT JOIN users u ON u.id = t.fan_id
    WHERE t.model_id = ? AND t.type IN ('message','call','tip','ppv','voice','live_explicit','gift')
    GROUP BY t.fan_id ORDER BY earned_cents DESC`).all(req.user.id);
  const byType = db.prepare(`
    SELECT t.type, SUM(t.model_cents) AS earned_cents, COUNT(*) AS n
    FROM transactions t
    WHERE t.model_id = ? AND t.type IN ('message','call','tip','ppv','voice','live_explicit','gift')
    GROUP BY t.type`).all(req.user.id);
  const gifts = db.prepare(`
    SELECT COALESCE(SUM(t.model_cents), 0) AS gifts_cents, COUNT(*) AS gift_count
    FROM transactions t WHERE t.model_id = ? AND t.type = 'gift' AND t.model_cents > 0`).get(req.user.id);
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
    if (b) {
      pushToUser(b.fan_id, { type: 'booking:completed', booking_id: b.id });
      pushToUser(b.model_id, { type: 'booking:completed', booking_id: b.id });
    }
  }
  pushToSubject(`u:${call.fan_id}`, { type: 'call:ended', call_id: callId, reason: reason || 'ended' });
  pushToSubject(`u:${call.model_id}`, { type: 'call:ended', call_id: callId, reason: reason || 'ended' });
}

function billCallMinute(callId) {
  const call = db.prepare('SELECT * FROM calls WHERE id = ?').get(callId);
  if (!call || call.status !== 'active') {
    const t = activeCallTimers.get(callId);
    if (t) { clearInterval(t); activeCallTimers.delete(callId); }
    return;
  }
  try {
    chargeFan(call.fan_id, call.model_id, call.rate_cents, 'call',
      `Video call minute ${call.minutes_billed + 1}`);
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
  if (!row.is_online) return res.status(409).json({ error: 'model_offline' });
  const conv = db.prepare('SELECT * FROM conversations WHERE fan_id = ? AND model_id = ?')
    .get(req.user.id, row.id);
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

const adminOnly = [identMiddleware, requireUser, requireRole('admin')];

/* ------------------------------------------------------------------ */
/* Admin SMS 2FA settings (Twilio)                                     */
/* ------------------------------------------------------------------ */

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

// Model starts a live cam session
app.post('/api/live/start', identMiddleware, requireUser, requireRole('model'), (req, res) => {
  const existing = db.prepare(`SELECT id FROM live_sessions WHERE model_id = ? AND status = 'live'`)
    .get(req.user.id);
  if (existing) return res.status(409).json({ error: 'already_live', session_id: existing.id });
  const m = db.prepare('SELECT explicit_rate_cents FROM models WHERE user_id = ?').get(req.user.id);
  const explicit_rate_cents = Number.isInteger(req.body.explicit_rate_cents) &&
    req.body.explicit_rate_cents >= 0 ? req.body.explicit_rate_cents : (m ? m.explicit_rate_cents : 499);
  const title = String(req.body.title || '').trim().slice(0, 60);
  const info = db.prepare(
    'INSERT INTO live_sessions (model_id, explicit_rate_cents, title) VALUES (?,?,?)')
    .run(req.user.id, explicit_rate_cents, title);
  db.prepare('UPDATE models SET is_online = 1 WHERE user_id = ?').run(req.user.id);
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
      `🎥 Left stream — join request refunded`);
    pushToUser(sess.model_id, { type: 'live:join-request-cancelled',
      session_id: sess.id, request_id: myPending.id });
  }
  pushToUser(sess.model_id, { type: 'live:viewer-left', session_id: sess.id, fan_id: req.user.id });
  res.json({ ok: true });
});

// Model (or admin) ends a session
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
      `🎥 Stream ended — join request refunded`);
    pushToUser(r.fan_id, { type: 'live:join-declined', session_id: sess.id,
      request_id: r.id, refunded_cents: fee,
      balance_cents: getWallet(r.fan_id).credits_cents });
  }
  dropStageFan(sess.id, 'stream_ended');
  pushLiveViewers(sess.id, { type: 'live:ended', session_id: sess.id });
  pushToUser(sess.model_id, { type: 'live:ended', session_id: sess.id });
  res.json({ ok: true });
});

// Public: who's live right now
app.get('/api/live', (req, res) => {
  const rows = db.prepare(`
    SELECT ls.id AS session_id, ls.title, ls.explicit_rate_cents, ls.started_at,
           u.id AS model_id, u.display_name AS model_name, mo.photo_url AS model_photo_url,
           (SELECT COUNT(*) FROM live_viewers WHERE session_id = ls.id) AS viewers,
           (SELECT COALESCE(SUM(gross_cents),0) FROM gift_events WHERE session_id = ls.id) AS gift_cents
    FROM live_sessions ls JOIN users u ON u.id = ls.model_id
    LEFT JOIN models mo ON mo.user_id = u.id
    WHERE ls.status = 'live' AND u.banned = 0`).all();
  res.json({ live: rows });
});

// Fan joins as a free viewer (SFW preview)
app.post('/api/live/:id/join', identMiddleware, requireUser, requireRole('fan'), (req, res) => {
  const sess = db.prepare('SELECT * FROM live_sessions WHERE id = ? AND status = \'live\'')
    .get(req.params.id);
  if (!sess) return res.status(404).json({ error: 'not_live' });
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
    is_paying: !!(me && me.is_paying), explicit_until: me ? me.explicit_until : 0,
    explicit_paid: !!(me && me.explicit_paid),
    explicit_grace_sec: getGiftGraceSec(), explicit_entry_cents: getEntryCents(),
    explicit_join_cents: jr.explicit_join_cents,
    explicit_mic_join_cents: jr.explicit_mic_join_cents,
    priority: currentPriority(sess.id) });
});

// Fan starts paying the explicit per-minute rate (unblurs)
app.post('/api/live/:id/pay', identMiddleware, requireUser, requireRole('fan'), (req, res) => {
  const sess = db.prepare('SELECT * FROM live_sessions WHERE id = ? AND status = \'live\'')
    .get(req.params.id);
  if (!sess) return res.status(404).json({ error: 'not_live' });
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
  if (!sess.is_explicit) return res.status(400).json({ error: 'not_explicit' });
  const viewer = db.prepare('SELECT * FROM live_viewers WHERE session_id = ? AND fan_id = ?')
    .get(sess.id, req.user.id);
  if (!viewer) return res.status(403).json({ error: 'join_first' });
  if (viewer.explicit_paid) return res.status(409).json({ error: 'already_paid' });
  const entryCents = getEntryCents();
  try {
    chargeFan(req.user.id, sess.model_id, entryCents, 'live_explicit_entry',
      `Explicit entry on stream #${sess.id}`);
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

// POST a group stream chat message — FREE, safety-scanned
app.post('/api/live/:id/chat', identMiddleware, requireUser, (req, res) => {
  const sess = liveSessionOr404(req, res);
  if (!sess) return;
  if (!isLiveParticipant(sess, req.user)) return res.status(403).json({ error: 'join_first' });
  const body = String(req.body.body || '').trim().slice(0, 500);
  if (!body) return res.status(400).json({ error: 'empty_message' });

  const matched = safetyScan(body);
  if (matched) {
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

// GET the virtual gift catalog (public, enabled only)
app.get('/api/gifts', (req, res) => {
  res.json({ gifts: db.prepare(
    'SELECT id, emoji, name, price_cents FROM gifts WHERE enabled = 1 ORDER BY price_cents, sort_order'
  ).all() });
});

// Core: fan sends a virtual gift on a live stream. Charges via splitPayment
// (model 60%, platform/recruiter split), logs gift_events, refreshes the viewer's
// explicit grace timer, and broadcasts to all viewers + the model + admins.
function sendLiveGift(sess, fanId, gift) {
  const { modelCents, platformCents } = chargeFan(
    fanId, sess.model_id, gift.price_cents, 'gift',
    `${gift.emoji} ${gift.name} on stream #${sess.id}`);
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
  const viewer = db.prepare('SELECT * FROM live_viewers WHERE session_id = ? AND fan_id = ?')
    .get(sess.id, req.user.id);
  if (!viewer) return res.status(403).json({ error: 'join_first' });
  const gift = db.prepare('SELECT * FROM gifts WHERE id = ? AND enabled = 1').get(req.body.gift_id);
  if (!gift) return res.status(404).json({ error: 'gift_not_found' });

  try {
    const { explicitUntil, balanceCents } = sendLiveGift(sess, req.user.id, gift);
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
      const { explicitUntil, balanceCents } = sendLiveGift(sess, req.user.id, gift);
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
      `🎁 ${gift.emoji} ${gift.name} in chat`);
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
  const m = db.prepare(`SELECT explicit_join_cents, explicit_mic_join_cents FROM models WHERE user_id = ?`)
    .get(modelId);
  return {
    explicit_join_cents: m && Number.isInteger(m.explicit_join_cents) ? m.explicit_join_cents : 2500,
    explicit_mic_join_cents: m && Number.isInteger(m.explicit_mic_join_cents) ? m.explicit_mic_join_cents : 1500,
  };
}
function stageJoinFee(isExplicit, mode, rates) {
  if (isExplicit) {
    const r = rates || { explicit_join_cents: EXPLICIT_JOIN_FEE_CENTS,
                         explicit_mic_join_cents: EXPLICIT_MIC_JOIN_FEE_CENTS };
    return mode === 'mic' ? r.explicit_mic_join_cents : r.explicit_join_cents;
  }
  return mode === 'mic' ? MIC_JOIN_FEE_CENTS : JOIN_FEE_CENTS;
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
      `📢 Priority message (${tier.duration_sec}s${wantVoice ? ' + voice' : ''}) on stream #${sess.id}`);
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
      `${mode === 'mic' ? '🎙️' : '🎥'} Join-live request (${modeLabel}, ${isExplicitJoin ? 'explicit' : 'regular'}) on stream #${sess.id}`);
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
    `${(r.mode || 'video') === 'mic' ? '🎙️' : '🎥'} Join-live declined on stream #${sess.id} — refunded`);
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
const BOOKING_NOSHOW_MIN = 15;
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
    status: b.status, created_at: b.created_at, decided_at: b.decided_at,
    other_name: u ? u.display_name : '?', other_photo_url: photo_url,
    is_fan_side: isFan,
  };
}

// No-show: approved booking, model never started within 15 min of scheduled time
function checkNoShow(b) {
  if (!b || b.status !== 'approved') return b;
  if (Date.now() > b.scheduled_at + BOOKING_NOSHOW_MIN * 60 * 1000) {
    db.prepare(`UPDATE bookings SET status = 'no_show', decided_at = datetime('now') WHERE id = ?`)
      .run(b.id);
    refundFan(b.fan_id, b.model_id, b.total_cents, 'booking_no_show',
      `📅 Booking #${b.id} no-show — model never started, refunded`);
    pushToUser(b.fan_id, { type: 'booking:no_show', booking_id: b.id,
      refunded_cents: b.total_cents,
      balance_cents: getWallet(b.fan_id).credits_cents });
    pushToUser(b.model_id, { type: 'booking:no_show', booking_id: b.id });
    return db.prepare('SELECT * FROM bookings WHERE id = ?').get(b.id);
  }
  return b;
}

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

// Fan requests a private booked live — pays upfront
app.post('/api/bookings', identMiddleware, requireUser, requireRole('fan'), (req, res) => {
  const modelId = parseInt(req.body.model_id);
  const scheduledAt = parseInt(req.body.scheduled_at);
  const durationMin = parseInt(req.body.duration_min);
  const model = db.prepare(`
    SELECT u.id, u.display_name, u.banned, m.per_minute_cents FROM users u
    JOIN models m ON m.user_id = u.id
    WHERE u.id = ? AND u.role = 'model'`).get(modelId);
  if (!model || model.banned) return res.status(404).json({ error: 'model_not_found' });
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
      `📅 Private ${durationMin}min live with ${model.display_name}`);
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
    `📅 Booking #${b.id} declined — refunded`);
  pushToUser(b.fan_id, { type: 'booking:declined', booking_id: b.id,
    refunded_cents: b.total_cents, balance_cents: getWallet(b.fan_id).credits_cents });
  res.json({ ok: true, refunded_cents: b.total_cents });
});

// Cancel: fan ≥1h before → refund; fan <1h → no refund; model → always refund
app.post('/api/bookings/:id/cancel', identMiddleware, requireUser, (req, res) => {
  const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
  if (!b) return res.status(404).json({ error: 'not_found' });
  if (!['pending', 'approved'].includes(b.status))
    return res.status(409).json({ error: 'not_cancellable' });
  const isModel = req.user.role === 'model' && b.model_id === req.user.id;
  const isFan = req.user.role === 'fan' && b.fan_id === req.user.id;
  if (!isModel && !isFan) return res.status(403).json({ error: 'forbidden' });
  let refunded = 0;
  if (isModel || Date.now() < b.scheduled_at - BOOKING_FAN_CANCEL_HOURS * 60 * 60 * 1000) {
    refunded = b.total_cents;
    refundFan(b.fan_id, b.model_id, b.total_cents, 'booking_refund',
      `📅 Booking #${b.id} cancelled by ${isModel ? 'model' : 'fan'} — refunded`);
  }
  db.prepare(`UPDATE bookings SET status = 'cancelled', decided_at = datetime('now') WHERE id = ?`)
    .run(b.id);
  const otherId = isModel ? b.fan_id : b.model_id;
  pushToUser(otherId, { type: 'booking:cancelled', booking_id: b.id,
    refunded_cents: refunded, by: isModel ? 'model' : 'fan',
    balance_cents: isModel ? getWallet(b.fan_id).credits_cents : undefined });
  res.json({ ok: true, refunded_cents: refunded });
});

// Model starts the private session at (or near) the scheduled time
app.post('/api/bookings/:id/start', identMiddleware, requireUser, requireRole('model'), (req, res) => {
  const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
  if (!b || b.status !== 'approved') return res.status(404).json({ error: 'not_found' });
  if (b.model_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });
  db.prepare(`UPDATE bookings SET status = 'in_progress', decided_at = datetime('now') WHERE id = ?`)
    .run(b.id);
  pushToUser(b.fan_id, { type: 'booking:live', booking_id: b.id,
    message: "🔴 She's live! Tap to join your private session." });
  res.json({ ok: true });
});

// Either party opens the private video session (prepaid — rate 0, no per-minute billing)
app.post('/api/bookings/:id/call', identMiddleware, requireUser, (req, res) => {
  const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
  if (!b) return res.status(404).json({ error: 'not_found' });
  if (b.fan_id !== req.user.id && b.model_id !== req.user.id)
    return res.status(403).json({ error: 'forbidden' });
  if (!['approved', 'in_progress'].includes(b.status))
    return res.status(409).json({ error: 'not_ready' });
  if (b.status === 'approved') {
    db.prepare(`UPDATE bookings SET status = 'in_progress', decided_at = datetime('now') WHERE id = ?`)
      .run(b.id);
  }
  const existing = db.prepare(`SELECT * FROM calls WHERE booking_id = ? AND status != 'ended'
    ORDER BY id DESC`).get(b.id);
  const otherId = req.user.id === b.fan_id ? b.model_id : b.fan_id;
  const other = db.prepare('SELECT display_name FROM users WHERE id = ?').get(otherId);
  if (existing) return res.json({ ok: true, call_id: existing.id, resumed: true,
    other_id: otherId, other_name: other ? other.display_name : '?' });
  const info = db.prepare('INSERT INTO calls (fan_id, model_id, rate_cents, booking_id) VALUES (?,?,0,?)')
    .run(b.fan_id, b.model_id, b.id);
  res.json({ ok: true, call_id: Number(info.lastInsertRowid),
    other_id: otherId, other_name: other ? other.display_name : '?' });
});

// Upcoming bookings for the logged-in user (both roles), with no-show settling
app.get('/api/bookings', identMiddleware, requireUser, (req, res) => {
  settleFinishedBookings();
  const col = req.user.role === 'model' ? 'model_id' : 'fan_id';
  const rows = db.prepare(`SELECT * FROM bookings WHERE ${col} = ?
    AND status IN ('pending','approved','in_progress')
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

// GET top-3 gifters leaderboard for a stream
app.get('/api/live/:id/leaderboard', identMiddleware, requireUser, (req, res) => {
  const sess = db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(req.params.id);
  if (!sess) return res.status(404).json({ error: 'not_found' });
  const top = db.prepare(`
    SELECT ge.fan_id, u.display_name AS fan_name,
           SUM(ge.gross_cents) AS total_cents, COUNT(*) AS gift_count
    FROM gift_events ge JOIN users u ON u.id = ge.fan_id
    WHERE ge.session_id = ?
    GROUP BY ge.fan_id ORDER BY total_cents DESC LIMIT 3`).all(sess.id);
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

app.get('/api/admin/stats', ...adminOnly, (req, res) => {
  const stats = db.prepare('SELECT * FROM platform_stats WHERE id = 1').get();
  const counts = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM users WHERE role = 'fan' AND banned = 0) AS fans,
      (SELECT COUNT(*) FROM users WHERE role = 'model' AND banned = 0) AS models,
      (SELECT COUNT(*) FROM models WHERE is_online = 1) AS models_online,
      (SELECT COUNT(*) FROM conversations) AS conversations,
      (SELECT COUNT(*) FROM calls WHERE status = 'active') AS active_calls,
      (SELECT COUNT(*) FROM safety_incidents WHERE status = 'open') AS open_incidents,
      (SELECT COUNT(*) FROM strikes WHERE flagged = 1) AS flagged_accounts,
      (SELECT COALESCE(SUM(gross_cents),0) FROM transactions
        WHERE type IN ('message','call','tip','ppv','voice','live_explicit','gift')) AS gross_volume_cents`).get();
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
    SELECT u.id, u.username, u.display_name, u.banned, u.created_at,
           m.bio, m.per_message_cents, m.per_minute_cents, m.is_online, m.photo_url,
           r.name AS recruiter_name,
           w.earnings_cents, w.paid_out_cents,
           (w.earnings_cents - w.paid_out_cents) AS pending_cents
    FROM users u JOIN models m ON m.user_id = u.id JOIN wallets w ON w.user_id = u.id
    LEFT JOIN recruiters r ON r.id = m.recruiter_id
    WHERE u.role = 'model' ORDER BY u.display_name`).all() });
});

app.post('/api/admin/models', ...adminOnly, (req, res) => {
  const { username, password, display_name, bio, per_message_cents, per_minute_cents } = req.body || {};
  if (!username || !password || !display_name)
    return res.status(400).json({ error: 'missing_fields' });
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username.trim()))
    return res.status(409).json({ error: 'username_taken' });
  // Admin-added models skip the public age gate — Corry verifies ID in person (2257).
  const id = createUser(username.trim(), password, 'model', display_name.trim().slice(0, 40), '1990-01-01');
  db.prepare(`UPDATE models SET bio = ?, per_message_cents = ?, per_minute_cents = ? WHERE user_id = ?`)
    .run((bio || '').slice(0, 280),
         Number.isInteger(per_message_cents) ? per_message_cents : 149,
         Number.isInteger(per_minute_cents) ? per_minute_cents : 399, id);
  res.json({ ok: true, id });
});

app.put('/api/admin/models/:id', ...adminOnly, (req, res) => {
  const { display_name, bio, per_message_cents, per_minute_cents, is_online, banned } = req.body || {};
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
  if (upd.length) { params.push(u.id); db.prepare(`UPDATE models SET ${upd.join(', ')} WHERE user_id = ?`).run(...params); }
  res.json({ ok: true });
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
  const code = crypto.randomBytes(9).toString('hex'); // 18-char code
  const info = db.prepare(
    'INSERT INTO invite_links (code, label, created_by) VALUES (?,?,?)'
  ).run(code, label, req.user.id);
  const base = req.body.base_url ? String(req.body.base_url).replace(/\/$/, '') : '';
  res.json({ ok: true, id: Number(info.lastInsertRowid), code, label,
    url: base ? `${base}/?invite=${code}` : `/?invite=${code}` });
});

// Admin: list all invite links with usage status
app.get('/api/admin/invites', ...adminOnly, (req, res) => {
  const rows = db.prepare(`
    SELECT i.*, u.display_name AS used_by_name, u.username AS used_by_username,
           u.banned AS used_by_banned
    FROM invite_links i LEFT JOIN users u ON u.id = i.used_by
    ORDER BY i.id DESC`).all();
  res.json({ invites: rows.map((r) => ({
    id: r.id, code: r.code, label: r.label,
    is_revoked: !!r.is_revoked, created_at: r.created_at, used_at: r.used_at,
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

/* ---------------- Recruiters / partners ---------------- */

// Admin: create a partner (recruiter) account + referral link
app.post('/api/admin/recruiters', ...adminOnly, (req, res) => {
  const { name, city, username, password } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'missing_fields' });
  const uname = (username || '').trim() || ('partner_' + crypto.randomBytes(3).toString('hex'));
  const pwd = (password && String(password).length >= 6) ? String(password) : crypto.randomBytes(6).toString('hex');
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(uname))
    return res.status(409).json({ error: 'username_taken' });
  const id = createUser(uname, pwd, 'recruiter', String(name).trim().slice(0, 40), '1990-01-01');
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

// Recruiter: dashboard (own link, models, earnings)
app.get('/api/recruiter/dashboard', identMiddleware, requireUser, requireRole('recruiter'), (req, res) => {
  const r = db.prepare('SELECT * FROM recruiters WHERE user_id = ?').get(req.user.id);
  if (!r) return res.status(404).json({ error: 'not_found' });
  const models = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.created_at, u.banned, m.photo_url,
           w.earnings_cents AS model_earnings_cents,
           (SELECT COALESCE(SUM(t.gross_cents), 0) FROM transactions t
             WHERE t.model_id = u.id AND t.gross_cents > 0) AS gross_generated_cents,
           (SELECT COALESCE(SUM(t.recruiter_cents), 0) FROM transactions t
             WHERE t.model_id = u.id AND t.recruiter_cents > 0) AS my_cut_cents
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

app.get('/api/admin/fans', ...adminOnly, (req, res) => {
  res.json({ fans: db.prepare(`
    SELECT u.id, u.username, u.display_name, u.banned, u.created_at, w.credits_cents,
           (SELECT COALESCE(SUM(gross_cents),0) FROM transactions t
             WHERE t.fan_id = u.id AND t.type IN ('message','call','gift')) AS spent_cents
    FROM users u JOIN wallets w ON w.user_id = u.id
    WHERE u.role = 'fan' ORDER BY spent_cents DESC LIMIT 200`).all() });
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
  db.prepare(`INSERT INTO transactions (fan_id, type, gross_cents, note)
              VALUES (?, 'credit_grant', ?, 'Admin credit grant')`).run(u.id, amount);
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
  db.prepare(`INSERT INTO transactions (model_id, type, gross_cents, model_cents, note)
              VALUES (?, 'payout', ?, ?, 'Paid out to model')`).run(u.id, amount, amount);
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
  db.prepare(`INSERT INTO transactions (model_id, type, gross_cents, model_cents, note)
              VALUES (?, 'payout', ?, ?, 'Withdrawal paid')`).run(w.model_id, w.amount_cents, w.amount_cents);
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
    const userId = sessions.get(token);
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

app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
  console.log(`SlutCamp running → http://localhost:${PORT}`);
  console.log('Seeded logins: admin/admin123 · bunny|stacey|bella/model123 · fandemo/fan123');
});
