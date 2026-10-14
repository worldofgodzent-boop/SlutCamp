'use strict';
/* ------------------------------------------------------------------ */
/* SlutCamp live presence — COUNTS ONLY.                               */
/*                                                                     */
/* The client pings POST /api/presence/ping every ~30s while the app   */
/* is open. Pings land in an in-memory map (identity -> {role,         */
/* lastSeen}); there is NO database write per ping. "Online" = seen    */
/* within the online window (default 120s). Roles: guest / fan /       */
/* model. Staff (admins, recruiters) are tracked in the map but are    */
/* NEVER included in the headline counts and are never exposed.        */
/* No names, no identities, no per-person data ever leaves this        */
/* module — only aggregate counts.                                     */
/*                                                                     */
/* Every sample interval (default 60s) one aggregate row is appended   */
/* to presence_samples (ts, day, guests, fans, models, total) so the   */
/* Moderator panel can show a 2-hour history strip and "peak today".   */
/* Rows older than 48h are pruned on write. `day` is the America/      */
/* Chicago calendar day (YYYY-MM-DD) so "today" matches Corry's day.  */
/*                                                                     */
/* Env (tests point these at short values):                            */
/*   PRESENCE_WINDOW_MS   online window (default 120000)               */
/*   PRESENCE_SAMPLE_MS   sampler interval (default 60000)             */
/* ------------------------------------------------------------------ */

const WINDOW_MS = Math.max(1000, parseInt(process.env.PRESENCE_WINDOW_MS || '120000', 10) || 120000);
const SAMPLE_MS = Math.max(500, parseInt(process.env.PRESENCE_SAMPLE_MS || '60000', 10) || 60000);
const RETENTION_MS = 48 * 60 * 60 * 1000;
const HISTORY_MS = 120 * 60 * 1000;

const dayFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
});

function chicagoDay(ts) {
  const p = {};
  for (const part of dayFmt.formatToParts(new Date(ts))) p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day}`;
}

function createPresenceService({ db }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS presence_samples (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      ts     INTEGER NOT NULL,
      day    TEXT NOT NULL,
      guests INTEGER NOT NULL,
      fans   INTEGER NOT NULL,
      models INTEGER NOT NULL,
      total  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_presence_samples_ts ON presence_samples (ts);
    CREATE INDEX IF NOT EXISTS idx_presence_samples_day ON presence_samples (day);
  `);

  /* identity key ('u:<id>' | 'g:<token>') -> { role, lastSeen } */
  const seen = new Map();

  function ping(key, role) {
    if (!key || !role) return;
    seen.set(key, { role, lastSeen: Date.now() });
  }

  /* Tallies who's inside the online window right now; stale entries are
     pruned as a side effect so the map stays bounded. Staff are skipped. */
  function counts(now = Date.now()) {
    const cutoff = now - WINDOW_MS;
    let guests = 0, fans = 0, models = 0;
    for (const [key, e] of seen) {
      if (e.lastSeen < cutoff) { seen.delete(key); continue; }
      if (e.role === 'guest') guests++;
      else if (e.role === 'fan') fans++;
      else if (e.role === 'model') models++;
    }
    return { guests, fans, models, total: guests + fans + models };
  }

  function sampleNow() {
    const now = Date.now();
    const c = counts(now);
    db.prepare(`INSERT INTO presence_samples (ts, day, guests, fans, models, total)
                VALUES (?, ?, ?, ?, ?, ?)`)
      .run(now, chicagoDay(now), c.guests, c.fans, c.models, c.total);
    db.prepare('DELETE FROM presence_samples WHERE ts < ?').run(now - RETENTION_MS);
  }

  function snapshot() {
    const now = Date.now();
    const nowCounts = counts(now);
    const row = db.prepare('SELECT MAX(total) AS peak FROM presence_samples WHERE day = ?')
      .get(chicagoDay(now));
    const peakToday = Math.max((row && row.peak) || 0, nowCounts.total);
    const samples = db.prepare(`SELECT ts, guests, fans, models, total FROM presence_samples
                                WHERE ts >= ? ORDER BY ts ASC`).all(now - HISTORY_MS);
    return { now: nowCounts, peakToday, samples };
  }

  function start() {
    setInterval(() => {
      try { sampleNow(); } catch (e) { console.error('presence: sample failed —', e.message); }
    }, SAMPLE_MS);
    setTimeout(() => { try { sampleNow(); } catch (e) { /* best effort */ } }, 5000);
    console.log(`🟢 presence sampler on (sample ${SAMPLE_MS}ms · online window ${WINDOW_MS}ms)`);
  }

  return { WINDOW_MS, SAMPLE_MS, ping, counts, sampleNow, snapshot, start, _seen: seen };
}

module.exports = { createPresenceService, chicagoDay };
