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
  role          TEXT NOT NULL CHECK(role IN ('fan','model','admin')),
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
  is_online        INTEGER NOT NULL DEFAULT 0
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

-- Gift send events (70/30 split like everything else)
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
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ljr_session ON live_join_requests(session_id, status);
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
addColumnIfMissing('priority_messages', 'voice', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('live_join_requests', 'is_explicit', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('platform_stats', 'explicit_entry_cents', 'INTEGER NOT NULL DEFAULT 499');

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

// Seed the virtual gift catalog (admin can edit prices/add/remove later)
const DEFAULT_GIFTS = [
  ['🌹', 'Rose', 100],
  ['💋', 'Kiss', 500],
  ['🔥', 'Fire', 1000],
  ['💎', 'Diamond', 2500],
  ['🚗', 'Sports Car', 5000],
  ['🚀', 'Rocket', 10000],
];
const giftCount = db.prepare('SELECT COUNT(*) AS c FROM gifts').get().c;
if (giftCount === 0) {
  const ins = db.prepare('INSERT INTO gifts (emoji, name, price_cents, sort_order) VALUES (?,?,?,?)');
  DEFAULT_GIFTS.forEach(([emoji, name, price], i) => ins.run(emoji, name, price, i));
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

const getUserPublic = (u) => ({
  id: u.id, username: u.username, role: u.role,
  display_name: u.display_name, banned: !!u.banned,
});

const fmt$ = (c) => '$' + (c / 100).toFixed(2); // server-side money formatter (cents → $x.xx)

function splitPayment(grossCents) {
  const commission = getCommission();
  const modelCents = Math.round(grossCents * (100 - commission) / 100);
  return { modelCents, platformCents: grossCents - modelCents, commission };
}

// Move money: fan pays grossCents. Throws Error('insufficient_credits') if short.
function chargeFan(fanId, modelId, grossCents, type, note) {
  const wallet = getWallet(fanId);
  if (!wallet || wallet.credits_cents < grossCents) throw new Error('insufficient_credits');
  const { modelCents, platformCents } = splitPayment(grossCents);
  txn(() => {
    db.prepare('UPDATE wallets SET credits_cents = credits_cents - ? WHERE user_id = ?')
      .run(grossCents, fanId);
    db.prepare('UPDATE wallets SET earnings_cents = earnings_cents + ? WHERE user_id = ?')
      .run(modelCents, modelId);
    db.prepare('UPDATE platform_stats SET earnings_cents = earnings_cents + ? WHERE id = 1')
      .run(platformCents);
    db.prepare(`INSERT INTO transactions
      (fan_id, model_id, type, gross_cents, model_cents, platform_cents, note)
      VALUES (?,?,?,?,?,?,?)`)
      .run(fanId, modelId, type, grossCents, modelCents, platformCents, note || null);
  });
  return { modelCents, platformCents };
}

/* Reverse a charge: fan gets grossCents back; model + platform earnings reduced.
   Used when the model declines a paid join-live request (full refund). */
function refundFan(fanId, modelId, grossCents, type, note) {
  const { modelCents, platformCents } = splitPayment(grossCents);
  txn(() => {
    db.prepare('UPDATE wallets SET credits_cents = credits_cents + ? WHERE user_id = ?')
      .run(grossCents, fanId);
    db.prepare('UPDATE wallets SET earnings_cents = earnings_cents - ? WHERE user_id = ?')
      .run(modelCents, modelId);
    db.prepare('UPDATE platform_stats SET earnings_cents = earnings_cents - ? WHERE id = 1')
      .run(platformCents);
    db.prepare(`INSERT INTO transactions
      (fan_id, model_id, type, gross_cents, model_cents, platform_cents, note)
      VALUES (?,?,?,?,?,?,?)`)
      .run(fanId, modelId, type, -grossCents, -modelCents, -platformCents, note || null);
  });
  return { modelCents, platformCents };
}

/* ---------------- identity: logged-in user OR guest ---------------- */

const sessions = new Map();      // token -> userId
const bannedGuests = new Set();  // guest tokens banned by admin (in-memory, MVP)
const socketsBySubject = new Map(); // 'u:123' | 'g:token' -> Set<ws>

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

  createUser('admin', 'admin123', 'admin', 'Corry (Admin)', '1990-01-01');

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
  res.json({ models: rows.map((r) => ({
    ...r,
    is_live: !!r.live_session_id,
  })) });
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

app.get('/api/me', identMiddleware, requireUser, (req, res) => {
  const wallet = getWallet(req.user.id);
  const out = { user: getUserPublic(req.user), wallet };
  if (req.user.role === 'model')
    out.model = db.prepare('SELECT * FROM models WHERE user_id = ?').get(req.user.id);
  if (req.user.role === 'admin') out.commission_pct = getCommission();
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
  const { bio, per_message_cents, per_minute_cents, per_voice_cents, explicit_rate_cents, is_online } = req.body || {};
  const updates = [], params = [];
  if (typeof bio === 'string') { updates.push('bio = ?'); params.push(bio.slice(0, 280)); }
  if (Number.isInteger(per_message_cents) && per_message_cents >= 0 && per_message_cents <= 5000) {
    updates.push('per_message_cents = ?'); params.push(per_message_cents);
  }
  if (Number.isInteger(per_minute_cents) && per_minute_cents >= 0 && per_minute_cents <= 10000) {
    updates.push('per_minute_cents = ?'); params.push(per_minute_cents);
  }
  if (Number.isInteger(per_voice_cents) && per_voice_cents >= 0 && per_voice_cents <= 5000) {
    updates.push('per_voice_cents = ?'); params.push(per_voice_cents);
  }
  if (Number.isInteger(explicit_rate_cents) && explicit_rate_cents >= 0 && explicit_rate_cents <= 20000) {
    updates.push('explicit_rate_cents = ?'); params.push(explicit_rate_cents);
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

app.get('/api/model/earnings', identMiddleware, requireUser, requireRole('model'), (req, res) => {
  const wallet = getWallet(req.user.id);
  const byFan = db.prepare(`
    SELECT COALESCE(u.display_name, 'Guest Fan') AS fan_name,
           SUM(t.model_cents) AS earned_cents, COUNT(*) AS payments
    FROM transactions t LEFT JOIN users u ON u.id = t.fan_id
    WHERE t.model_id = ? AND t.type IN ('message','call','tip','ppv','voice','live_explicit')
    GROUP BY t.fan_id ORDER BY earned_cents DESC`).all(req.user.id);
  const byType = db.prepare(`
    SELECT t.type, SUM(t.model_cents) AS earned_cents, COUNT(*) AS n
    FROM transactions t
    WHERE t.model_id = ? AND t.type IN ('message','call','tip','ppv','voice','live_explicit')
    GROUP BY t.type`).all(req.user.id);
  res.json({ earnings_cents: wallet.earnings_cents, paid_out_cents: wallet.paid_out_cents,
    pending_cents: wallet.earnings_cents - wallet.paid_out_cents, by_fan: byFan, by_type: byType });
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
    const fee = myPending.is_explicit ? EXPLICIT_JOIN_FEE_CENTS : JOIN_FEE_CENTS;
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
    const fee = r.is_explicit ? EXPLICIT_JOIN_FEE_CENTS : JOIN_FEE_CENTS;
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
  res.json({ ok: true, session_id: sess.id, model_id: sess.model_id,
    model_name: model.display_name, title: sess.title || '',
    explicit_rate_cents: sess.explicit_rate_cents, is_explicit: !!sess.is_explicit,
    is_paying: !!(me && me.is_paying), explicit_until: me ? me.explicit_until : 0,
    explicit_paid: !!(me && me.explicit_paid),
    explicit_grace_sec: getGiftGraceSec(), explicit_entry_cents: getEntryCents(),
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
// goes explicit. This is the gate; gifts are the upkeep (stage 2). 70/30 split.
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
    'SELECT id, emoji, name, price_cents FROM gifts WHERE enabled = 1 ORDER BY sort_order, price_cents'
  ).all() });
});

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
    const { modelCents, platformCents } = chargeFan(
      req.user.id, sess.model_id, gift.price_cents, 'gift',
      `${gift.emoji} ${gift.name} on stream #${sess.id}`);
    db.prepare(`INSERT INTO gift_events
      (session_id, fan_id, gift_id, gross_cents, model_cents, platform_cents)
      VALUES (?,?,?,?,?,?)`)
      .run(sess.id, req.user.id, gift.id, gift.price_cents, modelCents, platformCents);

    // Pay-to-play loop: ANY gift keeps this viewer's screen unblurred for the
    // grace period. Per-viewer — one fan's gifts never affect another fan.
    // (Set unconditionally; the client only honors it while the stream is explicit,
    // which also covers client-side AI-detected explicit.)
    const explicitUntil = Date.now() + getGiftGraceSec() * 1000;
    db.prepare('UPDATE live_viewers SET explicit_until = ? WHERE session_id = ? AND fan_id = ?')
      .run(explicitUntil, sess.id, req.user.id);
    db.prepare(`INSERT INTO blur_events (session_id, fan_id, event, detail)
                VALUES (?,?,'gift_unblur','explicit_grace')`).run(sess.id, req.user.id);

    const payload = { type: 'live:gift', session_id: sess.id,
      gift: { emoji: gift.emoji, name: gift.name, price_cents: gift.price_cents },
      fan_id: req.user.id, fan_name: req.user.display_name,
      balance_cents: getWallet(req.user.id).credits_cents };
    pushLiveAll(sess.id, payload);
    pushToAdmins({ type: 'live:gift_admin', session_id: sess.id,
      model_id: sess.model_id, fan_name: req.user.display_name,
      gift: gift.emoji + ' ' + gift.name, gross_cents: gift.price_cents });
    res.json({ ok: true, balance_cents: getWallet(req.user.id).credits_cents,
      explicit_until: explicitUntil, explicit_grace_sec: getGiftGraceSec() });
  } catch (e) {
    if (e.message === 'insufficient_credits')
      return res.status(402).json({ error: 'insufficient_credits',
        needed_cents: gift.price_cents, balance_cents: getWallet(req.user.id).credits_cents });
    throw e;
  }
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

// Fan "join live": flat fee to request on-camera stage time (cents), 70/30 split.
// Model approves each request; decline = full refund. One fan on stage at a time.
const JOIN_FEE_CENTS = 1000;
// Explicit join: if the stream is explicit when the fan requests, the fee is higher.
// The explicit stage fee COVERS viewing — no separate explicit entry fee needed.
const EXPLICIT_JOIN_FEE_CENTS = 2500;
// Stage time limit: approved fan auto-kicked after this many minutes (no refund).
const STAGE_MINUTES = 3;

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
   Fan pays JOIN_FEE_CENTS to request on-camera stage time. Model approves or
   declines (decline = full refund). One fan on stage at a time; stage time is
   capped at STAGE_MINUTES (auto-drop, no refund). Fan video goes to the MODEL
   only (peer-to-peer); other viewers see a stage indicator in chat. */

function stageJSON(r) {
  if (!r) return null;
  return { id: r.id, fan_id: r.fan_id, fan_name: r.fan_name, status: r.status,
           is_explicit: !!r.is_explicit,
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

// Fan requests stage time. If she's explicit right now it's the EXPLICIT tier ($25);
// otherwise the regular $10. Charged immediately; refunded if declined.
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
  const fee = isExplicitJoin ? EXPLICIT_JOIN_FEE_CENTS : JOIN_FEE_CENTS;
  try {
    chargeFan(req.user.id, sess.model_id, fee, 'live_join_request',
      `🎥 Join-live request (${isExplicitJoin ? 'explicit' : 'regular'}) on stream #${sess.id}`);
  } catch (e) {
    if (e.message === 'insufficient_credits')
      return res.status(402).json({ error: 'insufficient_credits',
        needed_cents: fee, balance_cents: getWallet(req.user.id).credits_cents });
    throw e;
  }
  const info = db.prepare(`INSERT INTO live_join_requests (session_id, fan_id, is_explicit) VALUES (?,?,?)`)
    .run(sess.id, req.user.id, isExplicitJoin ? 1 : 0);
  const rid = Number(info.lastInsertRowid);
  pushToUser(sess.model_id, { type: 'live:join-request', session_id: sess.id,
    request: { id: rid, fan_id: req.user.id, fan_name: req.user.display_name,
               is_explicit: isExplicitJoin } });
  res.json({ ok: true, request_id: rid, is_explicit: isExplicitJoin, fee_cents: fee,
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
  const stage = { id: r.id, fan_id: r.fan_id, fan_name: fan.display_name,
                  is_explicit: !!r.is_explicit,
                  stage_ends_at: now + STAGE_MINUTES * 60 * 1000 };
  pushToUser(r.fan_id, { type: 'live:join-approved', session_id: sess.id,
    request_id: r.id, stage_ends_at: stage.stage_ends_at, is_explicit: !!r.is_explicit });
  pushLiveAll(sess.id, { type: 'live:stage', session_id: sess.id, stage });
  pushToAdmins({ type: 'live:join_admin', session_id: sess.id, model_id: sess.model_id,
    fan_name: fan.display_name,
    amount_cents: r.is_explicit ? EXPLICIT_JOIN_FEE_CENTS : JOIN_FEE_CENTS });
  res.json({ ok: true, stage });
});

// Model declines — fan refunded in full (whichever tier they paid)
app.post('/api/live/join-requests/:rid/decline', identMiddleware, requireUser, requireRole('model'), (req, res) => {
  const r = db.prepare('SELECT * FROM live_join_requests WHERE id = ?').get(req.params.rid);
  if (!r || r.status !== 'pending') return res.status(404).json({ error: 'not_found' });
  const sess = db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(r.session_id);
  if (!sess || sess.model_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });
  const fee = r.is_explicit ? EXPLICIT_JOIN_FEE_CENTS : JOIN_FEE_CENTS;
  db.prepare(`UPDATE live_join_requests SET status = 'declined' WHERE id = ?`).run(r.id);
  refundFan(r.fan_id, sess.model_id, fee, 'live_join_refund',
    `🎥 Join-live declined on stream #${sess.id} — refunded`);
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
      ({ id: r.id, fan_id: r.fan_id, fan_name: r.fan_name, is_explicit: !!r.is_explicit }));
  } else {
    const mine = db.prepare(`SELECT r.*, u.display_name AS fan_name FROM live_join_requests r
      JOIN users u ON u.id = r.fan_id
      WHERE r.session_id = ? AND r.fan_id = ? AND r.status = 'pending'`)
      .get(sess.id, req.user.id);
    out.my_pending = mine ? { id: mine.id, fan_name: mine.fan_name } : null;
    const myStage = db.prepare(`SELECT r.*, u.display_name AS fan_name FROM live_join_requests r
      JOIN users u ON u.id = r.fan_id
      WHERE r.session_id = ? AND r.fan_id = ? AND r.status = 'approved'`)
      .get(sess.id, req.user.id);
    out.my_stage = stageJSON(myStage);
  }
  res.json(out);
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
        WHERE type IN ('message','call','tip','ppv','voice','live_explicit')) AS gross_volume_cents`).get();
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
           w.earnings_cents, w.paid_out_cents,
           (w.earnings_cents - w.paid_out_cents) AS pending_cents
    FROM users u JOIN models m ON m.user_id = u.id JOIN wallets w ON w.user_id = u.id
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

app.get('/api/admin/fans', ...adminOnly, (req, res) => {
  res.json({ fans: db.prepare(`
    SELECT u.id, u.username, u.display_name, u.banned, u.created_at, w.credits_cents,
           (SELECT COALESCE(SUM(gross_cents),0) FROM transactions t
             WHERE t.fan_id = u.id AND t.type IN ('message','call')) AS spent_cents
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
