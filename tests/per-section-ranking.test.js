'use strict';
/*
 * Per-section ranking (owner ruling, Oct 19 2026): "It's the same way
 * they rank up, but they both got their own ranking system. Don't make
 * them mix."
 *
 * The rank_score FORMULA is unchanged (likes + lifetime credited
 * earnings $, recomputeModelRank — proven by ranking.test.js). What
 * changed: rank_position is now a model's 1-based position WITHIN HER
 * OWN SECTION's ladder (female / male / couple), computed with the
 * same ordering chain (rank_score, likes, online, newest, name),
 * instead of one position over the whole roster. Every model carries
 * her own-section position on every surface: the /api/models payload
 * on every tab (including All), and her public /models/:username page.
 * The house account holds no position in any section and never shifts
 * anyone.
 *
 * Fixtures (scores set directly on the stored column, the
 * official-account.test.js pattern — no like/tip events fire, so
 * nothing recomputes them):
 *   house (female section) 99999 — must hold NO position, shift nobody
 *   psf1 female 50 → female #1      psf2 female 30 → female #2
 *   psm1 male   40 → male   #1      psm2 male    5 → male   #2
 *   psc1 couple 45 → couple #1     psc2 couple 10 → couple #2
 * Globally the order would be house, psf1, psc1, psm1, psf2, psc2,
 * psm2 — so psf2 at #2 and psm1/psc1 at #1 are ONLY possible if the
 * ladders are separate. Seeded demo models (female, score 0) sit below
 * psf2 on the female ladder and disturb nothing asserted here.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const REPO = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const server = read('server.js');
const app = read('public/js/app.js');
const css = read('public/css/styles.css');

/* ---------------- server harness (ranking.test.js pattern) ---------------- */

let tmpDir = null;
let child = null;
let base = null;
let childLog = '';

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function req(method, p, { body, token, headers } = {}) {
  const h = { ...(headers || {}) };
  if (body !== undefined) h['content-type'] = 'application/json';
  if (token) h.authorization = 'Bearer ' + token;
  const r = await fetch(base + p, {
    method,
    headers: h,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* HTML or empty */ }
  return { status: r.status, headers: r.headers, text, json };
}

async function waitForServer(deadlineMs = 60000) {
  const start = Date.now();
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early with code ${child.exitCode}\n--- server log ---\n${childLog}`);
    }
    try {
      const r = await fetch(base + '/api/credits/packages');
      if (r.status === 200) return;
    } catch (_) { /* not up yet */ }
    if (Date.now() - start > deadlineMs) {
      throw new Error(`server did not respond within ${deadlineMs}ms\n--- server log ---\n${childLog}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function boot() {
  let lastErr = null;
  for (let attempt = 1; attempt <= 3 && !base; attempt++) {
    const port = await freePort();
    const env = { ...process.env, PORT: String(port), CRYPTO_POLL_MS: '3600000', SEED_DEMO: '1' };
    for (const k of Object.keys(env)) {
      if (/^(CCBILL_|CRYPTO_|OPENAI_|TWILIO_|VAPID_)/.test(k)) delete env[k];
    }
    childLog = '';
    child = spawn(process.execPath, ['server.js'], { cwd: tmpDir, env });
    child.stdout.on('data', (d) => { childLog += d; });
    child.stderr.on('data', (d) => { childLog += d; });
    base = `http://127.0.0.1:${port}`;
    try {
      await waitForServer();
    } catch (e) {
      lastErr = e;
      base = null;
      if (child && child.exitCode === null) child.kill('SIGKILL');
      child = null;
    }
  }
  if (!base) throw lastErr || new Error('server failed to boot after 3 attempts');
}

function dbExec(sql, params = []) {
  // The server process holds this WAL database while this helper
  // writes from a SECOND connection: a bare write has zero lock
  // tolerance and throws SQLITE_BUSY the instant it collides with a
  // server write (gate triple3 run 3 lost every test in this file to
  // one collision in the before-hook's setScore calls). Wait for the
  // lock inside SQLite, and retry a few times across collisions,
  // before ever calling it a failure. Harness-only: no assertion in
  // this file depends on a write being instant or uncontended.
  let lastErr = null;
  for (let attempt = 1; attempt <= 6; attempt++) {
    const db = new DatabaseSync(path.join(tmpDir, 'wogent-chat.db'));
    try {
      db.exec('PRAGMA busy_timeout = 10000');
      db.prepare(sql).run(...params);
      return;
    } catch (e) {
      lastErr = e;
      if (!/locked|busy/i.test(String(e && e.message))) throw e;
    } finally { db.close(); }
    const until = Date.now() + 250 * attempt; // short sync backoff
    while (Date.now() < until) { /* hooks here are sync by design */ }
  }
  throw lastErr;
}

/* ---------------- scenario ---------------- */

const M = {}; // key → { id, username }

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slutcamp-sectionrank-'));
  for (const f of ['server.js', 'package.json']) {
    fs.copyFileSync(path.join(REPO, f), path.join(tmpDir, f));
  }
  for (const d of ['lib', 'public', 'data']) {
    fs.cpSync(path.join(REPO, d), path.join(tmpDir, d), { recursive: true });
  }
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(tmpDir, 'node_modules'), 'dir');
  await boot();

  const suffix = Math.random().toString(36).slice(2, 8);
  const signup = async (key, username, section, display) => {
    const s = await req('POST', '/api/auth/signup', {
      body: { username, password: 'sectionrank-pass-1', role: 'model', display_name: display, dob: '1996-04-12', agree18: true, section },
    });
    assert.equal(s.status, 200, `model signup (${username}/${section}) failed: ${s.text}`);
    M[key] = { id: s.json.user.id, username };
  };
  // The house account signs up under its EXACT production username.
  await signup('house', 'asceaaspade', 'female', 'SlutCamp');
  await signup('psf1', 'psf1' + suffix, 'female', 'PS F1');
  await signup('psf2', 'psf2' + suffix, 'female', 'PS F2');
  await signup('psm1', 'psm1' + suffix, 'male', 'PS M1');
  await signup('psm2', 'psm2' + suffix, 'male', 'PS M2');
  await signup('psc1', 'psc1' + suffix, 'couple', 'PS C1');
  await signup('psc2', 'psc2' + suffix, 'couple', 'PS C2');

  const setScore = (key, score) =>
    dbExec('UPDATE models SET rank_score = ? WHERE user_id = ?', [score, M[key].id]);
  setScore('house', 99999);
  setScore('psf1', 50);
  setScore('psf2', 30);
  setScore('psm1', 40);
  setScore('psm2', 5);
  setScore('psc1', 45);
  setScore('psc2', 10);
});

test.after(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((r) => child.once('exit', r)),
      new Promise((r) => setTimeout(r, 5000)),
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function payload(tab) {
  const r = await req('GET', '/api/models?tab=' + tab);
  assert.equal(r.status, 200, r.text);
  return r.json;
}
const posIn = (json, key) => {
  const row = json.models.find((m) => m.id === M[key].id);
  assert.ok(row, `${key} must be present in this payload`);
  return row.rank_position;
};

/* ---------------- the ladders are separate ---------------- */

test('male ladder: a mid-pack global score is #1 among males', async () => {
  const all = await payload('all');
  assert.equal(posIn(all, 'psm1'), 1,
    'psm1 (40) trails psf1 (50) and psc1 (45) globally but tops the MALE ladder');
  assert.equal(posIn(all, 'psm2'), 2, 'psm2 (5) is second on the male ladder');
});

test('female ladder: positions identical with or without high-scoring males/couples', async () => {
  const all = await payload('all');
  assert.equal(posIn(all, 'psf1'), 1, 'psf1 tops the female ladder');
  assert.equal(posIn(all, 'psf2'), 2,
    'psf2 (30) is female #2 — psc1 (45) and psm1 (40) outscore her but live on other ladders (globally she would be #4 among regular models)');
});

test('couple ladder: couples form their own ladder, never take a female/male position', async () => {
  const all = await payload('all');
  assert.equal(posIn(all, 'psc1'), 1, 'psc1 (45) tops the couple ladder, not female #2');
  assert.equal(posIn(all, 'psc2'), 2, 'psc2 (10) is second on the couple ladder');
  assert.equal(posIn(all, 'psf1'), 1, 'the couple did not displace the female #1');
  assert.equal(posIn(all, 'psm1'), 1, 'the couple did not displace the male #1');
});

test('every tab carries each model\u2019s own-section position', async () => {
  const male = await payload('male'); // Male tab = males + couples
  assert.equal(posIn(male, 'psm1'), 1, 'on the Male tab psm1 still shows his MALE-ladder #1');
  assert.equal(posIn(male, 'psc1'), 1, 'on the Male tab psc1 still shows her COUPLE-ladder #1 — same number as on All');
  const female = await payload('female'); // Female tab = females + couples
  assert.equal(posIn(female, 'psf2'), 2, 'on the Female tab psf2 still shows her FEMALE-ladder #2');
  assert.equal(posIn(female, 'psc1'), 1, 'on the Female tab psc1 still shows her COUPLE-ladder #1');
  const couples = await payload('couples');
  assert.equal(posIn(couples, 'psc1'), 1);
  assert.equal(posIn(couples, 'psc2'), 2);
});

/* ---------------- house: no position, shifts nobody ---------------- */

test('house excluded everywhere: no position, and a 99999 score shifts nobody', async () => {
  const all = await payload('all');
  assert.ok(all.official, 'official object travels with the payload');
  assert.equal(all.official.username, 'asceaaspade');
  assert.equal(all.official.rank_position, null, 'the house holds no rank position');
  assert.ok(!all.models.some((m) => m.id === M.house.id), 'house never appears in models[]');
  assert.equal(posIn(all, 'psf1'), 1,
    'female #1 is #1 even though the (female-section) house account outscores the whole roster');
});

/* ---------------- SEO / public pages ---------------- */

test('public profile pages print the per-section position', async () => {
  const page = async (key) => {
    const r = await req('GET', '/models/' + encodeURIComponent(M[key].username));
    assert.equal(r.status, 200, r.text.slice(0, 200));
    return r.text;
  };
  assert.ok((await page('psf2')).includes('Ranked #2 on SlutCamp'),
    'psf2\u2019s public page shows her FEMALE-ladder #2 (globally she would be #4)');
  assert.ok((await page('psc1')).includes('Ranked #1 on SlutCamp'),
    'psc1\u2019s public page shows her COUPLE-ladder #1');
  assert.ok((await page('psm1')).includes('Ranked #1 on SlutCamp'),
    'psm1\u2019s public page (individual pages serve for males) shows his MALE-ladder #1');
  const housePage = await page('house');
  assert.ok(!housePage.includes('Ranked #'),
    'the house account\u2019s public page carries no rank line at all');
});

/* ---------------- rank titles (owner, Oct 19 2026) ----------------
 * The top 3 of each ladder wear a TITLE on the badge instead of a
 * bare number; #4–#10 stay plain; a titled tile never also wears the
 * 👑 crown pill. Rendered by the REAL modelTileHTML extracted into a
 * vm with a stub translator carrying the EN words. */

const vm = require('node:vm');
function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  let depth = 0;
  let end = -1;
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (!depth) { end = j + 1; break; } }
  }
  assert.ok(end > start, `${name} braces must balance`);
  return src.slice(start, end);
}
function extractConst(src, name) {
  const start = src.indexOf(`const ${name} =`);
  assert.ok(start >= 0, `${name} must exist`);
  const end = src.indexOf('\n};', start);
  assert.ok(end > start, `${name} must terminate`);
  return src.slice(start, end + 3);
}
const titleLogic = {};
{
  const EN_WORDS = {
    rank_queen: 'Queen', rank_princess: 'Princess', rank_duchess: 'Duchess',
    rank_king: 'King', rank_prince: 'Prince', rank_duke: 'Duke',
    rank_royal_couple: 'Royal Couple', rank_prince_princess: 'Prince & Princess',
    rank_power_couple: 'Power Couple',
    top_model: '👑 Top Model', watch_free: 'Watch free', online_now: 'Online now',
    offline: 'Offline', featured: 'Featured', new_badge: 'NEW',
    watching: '{n} watching', per_msg_rate: '{price}/msg', per_min_rate: '{price}/min',
    usually_live: 'Usually live {s}',
  };
  const ctx = {
    esc: (s) => String(s),
    fmt: (c) => '$' + (c / 100).toFixed(2),
    t: (key, vars) => {
      let s = EN_WORDS[key] || key;
      if (vars) for (const k in vars) s = s.split('{' + k + '}').join(String(vars[k]));
      return s;
    },
  };
  vm.createContext(ctx);
  vm.runInContext(
    extractFn(app, 'tileGradient') + '\n'
    + extractFn(app, 'rankBadgeFor') + '\n'
    + extractConst(app, 'RANK_TITLES') + '\n'
    + extractFn(app, 'rankTitleSpec') + '\n'
    + extractFn(app, 'rankTitleText') + '\n'
    + extractFn(app, 'modelTileHTML')
    + '\n;globalThis.__x = { rankTitleSpec, rankTitleText, modelTileHTML };', ctx);
  Object.assign(titleLogic, ctx.__x);
}
const tileModel = (over) => Object.assign({
  id: 1, display_name: 'Title Tess', username: 'titletess', section: 'female',
  rank_position: 1, per_message_cents: 100, per_minute_cents: 200,
  is_online: false, is_live: false, is_featured: false, tags: [],
  photo_url: '', preview_video_url: '',
}, over);

test('titles: spec maps (section, position) to the owner\u2019s titles; #4+ and unknown get none', () => {
  const spec = titleLogic.rankTitleSpec;
  // Field-wise compare: spec objects are born in the vm realm, whose
  // Object.prototype differs from this realm's (deepEqual would fail
  // on identical values).
  const specIs = (m, n, emoji, key) => {
    const s = spec(m);
    assert.ok(s, `spec expected for ${JSON.stringify(m)}`);
    assert.equal(s.n, n); assert.equal(s.emoji, emoji); assert.equal(s.key, key);
  };
  specIs({ section: 'female', rank_position: 1 }, 1, '👸', 'rank_queen');
  specIs({ section: 'female', rank_position: 2 }, 2, '👸', 'rank_princess');
  specIs({ section: 'female', rank_position: 3 }, 3, '🫅', 'rank_duchess');
  specIs({ section: 'male', rank_position: 1 }, 1, '🤴', 'rank_king');
  specIs({ section: 'male', rank_position: 2 }, 2, '🤴', 'rank_prince');
  specIs({ section: 'male', rank_position: 3 }, 3, '🫅', 'rank_duke');
  specIs({ section: 'couple', rank_position: 1 }, 1, '👸🤴', 'rank_royal_couple');
  specIs({ section: 'couple', rank_position: 2 }, 2, '🤴👸', 'rank_prince_princess');
  specIs({ section: 'couple', rank_position: 3 }, 3, '🫅', 'rank_power_couple');
  assert.equal(spec({ section: 'female', rank_position: 4 }), null, '#4 wears no title');
  assert.equal(spec({ section: 'male', rank_position: 10 }), null, '#10 wears no title');
  assert.equal(spec({ section: 'female', rank_position: null }), null);
  assert.equal(spec({}), null);
  assert.equal(spec({ rank_position: 1 }).key, 'rank_queen', 'a missing section falls back to the female ladder table');
  assert.equal(titleLogic.rankTitleText({ section: 'couple', rank_position: 1 }), '👸🤴 Royal Couple #1');
});

test('titles: the tile pill carries the title; the crown steps aside on titled tiles only', () => {
  const html = titleLogic.modelTileHTML;
  const queen = html(tileModel({}), { crown: true, rankBadge: 1 });
  assert.ok(queen.includes('👸 Queen #1'), 'female #1 pill reads 👸 Queen #1');
  assert.ok(queen.includes('rank-title'), 'title pill carries the title styling class');
  assert.ok(!queen.includes('tile-top-pill'), 'the 👑 Top Model crown pill is NOT stacked on the Queen tile');
  assert.ok(html(tileModel({ rank_position: 2 }), { rankBadge: 2 }).includes('👸 Princess #2'));
  assert.ok(html(tileModel({ rank_position: 3 }), { rankBadge: 3 }).includes('🫅 Duchess #3'));
  const king = html(tileModel({ section: 'male' }), { crown: true, rankBadge: 1 });
  assert.ok(king.includes('🤴 King #1'), 'male #1 pill reads 🤴 King #1');
  assert.ok(!king.includes('tile-top-pill'), 'no crown stacked on the King tile either');
  assert.ok(html(tileModel({ section: 'male', rank_position: 2 }), { rankBadge: 2 }).includes('🤴 Prince #2'));
  assert.ok(html(tileModel({ section: 'male', rank_position: 3 }), { rankBadge: 3 }).includes('🫅 Duke #3'));
  assert.ok(html(tileModel({ section: 'couple' }), { rankBadge: 1 }).includes('👸🤴 Royal Couple #1'));
  assert.ok(html(tileModel({ section: 'couple', rank_position: 2 }), { rankBadge: 2 }).includes('🤴👸 Prince & Princess #2'));
  assert.ok(html(tileModel({ section: 'couple', rank_position: 3 }), { rankBadge: 3 }).includes('🫅 Power Couple #3'));
  const fourth = html(tileModel({ rank_position: 4 }), { crown: true, rankBadge: 4 });
  assert.ok(fourth.includes('>#4<'), '#4 keeps the plain number badge');
  assert.ok(!fourth.includes('Queen') && !fourth.includes('rank-title'), '#4 carries no title');
  assert.ok(fourth.includes('tile-top-pill'), 'the crown still applies on an untitled first tile');
  const suppressed = html(tileModel({}), { rankBadge: 0 });
  assert.ok(!suppressed.includes('Queen') && !suppressed.includes('tile-rank-badge'),
    'badges suppressed (discovery active) → no title either: the title IS the badge');
});

test('titles: STR keys exist in all 13 languages; peek line + gold title style pinned', () => {
  for (const k of ['rank_queen', 'rank_princess', 'rank_duchess', 'rank_king', 'rank_prince',
    'rank_duke', 'rank_royal_couple', 'rank_prince_princess', 'rank_power_couple', 'ranked_title_line']) {
    assert.equal(app.split(`${k}:`).length - 1, 13, `${k} exists in all 13 language tables`);
  }
  assert.ok(app.includes("t('ranked_title_line'"), 'the peek rank line uses the titled format for top-3');
  assert.ok(app.includes("t('ranked_n'"), 'positions 4–10 keep the plain ranked_n peek line');
  assert.ok(css.includes('.tile-rank-badge.rank-title'), 'title badge styling exists');
});

/* ---------------- source pins ---------------- */

test('pins: one shared per-section derivation feeds both producers; the global counter is gone', () => {
  assert.ok(server.includes('function computeSectionRankPositions()'),
    'the shared per-section position derivation exists');
  assert.equal(server.split('ladderCounts[sec] = (ladderCounts[sec] || 0) + 1;').length - 1, 1,
    'positions are counted within the section ladder in exactly ONE place — the helper');
  assert.equal(server.split('const rankPos = computeSectionRankPositions();').length - 1, 3,
    'GET /api/models, seoPublicModels AND the rank-congrats evaluation all take positions from the helper (pin corrected when the congrats evaluator became the third consumer, Oct 19 2026)');
  assert.ok(!server.includes('new Map(rankOrder.map((r, i) => [r.id, i + 1]))'),
    'the old whole-roster position map (GET /api/models) is gone');
  assert.ok(!server.includes('new Map(rankOrder.filter((r) => r.id !== houseId)'),
    'the old whole-roster position map (house-filtered variant) is gone');
  assert.ok(server.includes('rank_position: rankPos.get(r.id)'),
    'payloads still carry rank_position from the position map');
  assert.ok(server.includes('function recomputeModelRank('),
    'the rank_score derivation itself is untouched — only positions went per-section');
  assert.ok(server.includes('ON HER OWN') || server.includes("HER OWN SECTION's ladder"),
    'the per-section intent is stated at the producers');
});
