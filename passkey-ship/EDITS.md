# Web-editor edit script — feat/passkey-auth (Face ID)

Repo: **worldofgodzent-boop/SlutCamp**, branch: **feat/passkey-auth** (created from main @ b29aecd).
The small files (package.json, package-lock.json, TESTING.md, tests/passkey.test.js) are already
pushed to this branch and SHA-verified. The 3 files below are too large for the connector, so they
are applied by hand in GitHub's web editor on branch **feat/passkey-auth** (the editor starts from
main's content, which is what every anchor below is taken from).

How to apply, per file:
1. Open the file on branch `feat/passkey-auth` in the GitHub web editor (pencil icon).
2. Apply the edits IN ORDER (edit 1, then 2, ...). Every anchor/find text appears EXACTLY ONCE in
   the file as you go — if a find fails or matches twice, STOP and report it.
3. Block files (`blocks/*.txt`) hold the exact text to insert / the replacement text, byte for byte,
   including the trailing newline. Paste them exactly; do not retype.
4. Commit after each file with message: `Face ID (passkeys) — apply <file> from tested branch c3c04ed`.

Verified: this script was machine-applied to scratch copies of main's three files and the results
are BYTE-IDENTICAL to the triple-gated local tree (commit c3c04ed, 76/76 tests x3).

---

## File: `server.js` (5 edits)

### server.js — edit 1 of 5: INSERT_AFTER
Find this exact anchor text in the file (it appears exactly once). Insert the contents of `blocks/server-01.txt` immediately AFTER it (after its last line):
```text
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { DatabaseSync } = require('node:sqlite');
const { WebSocketServer } = require('ws');
const { transcribeAudio } = require('./lib/transcribe');
const geoLib = require('./lib/geo');
```

### server.js — edit 2 of 5: INSERT_AFTER
Find this exact anchor text in the file (it appears exactly once). Insert the contents of `blocks/server-02.txt` immediately AFTER it (after its last line):
```text
/* ---------------- identity: logged-in user OR guest ---------------- */

// Sessions stored in DB (on persistent disk) so logins survive deploys
db.exec(`CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
```

### server.js — edit 3 of 5: INSERT_AFTER
Find this exact anchor text in the file (it appears exactly once). Insert the contents of `blocks/server-03.txt` immediately AFTER it (after its last line):
```text

app.post('/api/auth/logout', identMiddleware, requireUser, (req, res) => {
  deleteSession((req.headers.authorization || '').slice(7));
  res.json({ ok: true });
});

```

### server.js — edit 4 of 5: REPLACE
Find this exact text in the file (it appears exactly once) and REPLACE it entirely with the contents of `blocks/server-04.txt`:
```text
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
```

### server.js — edit 5 of 5: REPLACE
Find this exact text in the file (it appears exactly once) and REPLACE it entirely with the contents of `blocks/server-05.txt`:
```text
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

```

---

## File: `public/js/app.js` (6 edits)

### public/js/app.js — edit 1 of 6: REPLACE
Find this exact text in the file (it appears exactly once) and REPLACE it entirely with the contents of `blocks/app-01.txt`:
```text
    body.innerHTML = `
      <label class="field">${t('username')}<input class="input" id="a-user" autocomplete="username"></label>
      <label class="field">${t('password')}${pwField('a-pass', 'current-password')}</label>
      <button class="btn" id="a-go">${t('log_in')}</button>`;
    $('#a-go').onclick = doLogin;
  } else {
    body.innerHTML = `
      <div class="role-card ${role === 'fan' ? 'selected' : ''}" id="r-fan">
```

### public/js/app.js — edit 2 of 6: INSERT_AFTER
Find this exact anchor text in the file (it appears exactly once). Insert the contents of `blocks/app-02.txt` immediately AFTER it (after its last line):
```text
  toast(msgs[data.error] || t('err_signup_failed'));
}

```

### public/js/app.js — edit 3 of 6: INSERT_AFTER
Find this exact anchor text in the file (it appears exactly once). Insert the contents of `blocks/app-03.txt` immediately AFTER it (after its last line):
```text
        <div id="crypto-recent"></div>
      </div>
      <button class="btn ghost" id="w-ath" style="width:100%;margin-bottom:10px">${t('ath_wallet_row')}</button>
```

### public/js/app.js — edit 4 of 6: INSERT_AFTER
Find this exact anchor text in the file (it appears exactly once). Insert the contents of `blocks/app-04.txt` immediately AFTER it (after its last line):
```text
  }
  const wth = $('#w-ath');
  if (wth) wth.onclick = openAthSheet;
```

### public/js/app.js — edit 5 of 6: INSERT_AFTER
Find this exact anchor text in the file (it appears exactly once). Insert the contents of `blocks/app-05.txt` immediately AFTER it (after its last line):
```text
        </div>
      </div>
      <div class="card" id="tax-card"><div class="muted small">Loading tax info…</div></div>
```

### public/js/app.js — edit 6 of 6: INSERT_AFTER
Find this exact anchor text in the file (it appears exactly once). Insert the contents of `blocks/app-06.txt` immediately AFTER it (after its last line):
```text
    inp.click();
  };
  $('#s-logout').onclick = () => logout();
```

---

## File: `public/manager/manager.js` (9 edits)

### public/manager/manager.js — edit 1 of 9: INSERT_AFTER
Find this exact anchor text in the file (it appears exactly once). Insert the contents of `blocks/manager-01.txt` immediately AFTER it (after its last line):
```text
  presenceTimer: null,
};

```

### public/manager/manager.js — edit 2 of 9: REPLACE
Find this exact text in the file (it appears exactly once) and REPLACE it entirely with the contents of `blocks/manager-02.txt`:
```text
    clearTimeout(timeout);
    let data = {};
    try { data = await r.json(); } catch (e) { /* non-JSON */ }
    return { status: r.status, data };
  } catch (e) {
    clearTimeout(timeout);
    return { status: 0, data: { error: 'network_error' } };
```

### public/manager/manager.js — edit 3 of 9: REPLACE
Find this exact text in the file (it appears exactly once) and REPLACE it entirely with the contents of `blocks/manager-03.txt`:
```text
    const r = await fetch('/api' + path, { method: 'POST', headers, body: fd });
    let data = {};
    try { data = await r.json(); } catch (e) { /* non-JSON */ }
    return { status: r.status, data };
  } catch (e) {
    return { status: 0, data: { error: 'network_error' } };
  }
```

### public/manager/manager.js — edit 4 of 9: INSERT_AFTER
Find this exact anchor text in the file (it appears exactly once). Insert the contents of `blocks/manager-04.txt` immediately AFTER it (after its last line):
```text
async function adminMoreBody(s) {
  const { data: tfa } = await api('/admin/2fa').catch(() => ({ data: {} }));
  const tfaOn = !!(tfa && tfa.on);
```

### public/manager/manager.js — edit 5 of 9: INSERT_AFTER
Find this exact anchor text in the file (it appears exactly once). Insert the contents of `blocks/manager-05.txt` immediately AFTER it (after its last line):
```text
        ${tfaOn ? '<button class="btn small ghost" id="tfa-off">Turn off</button>' : ''}
      </div>
    </div>
```

### public/manager/manager.js — edit 6 of 9: INSERT_AFTER
Find this exact anchor text in the file (it appears exactly once). Insert the contents of `blocks/manager-06.txt` immediately AFTER it (after its last line):
```text
    toast('Wrong password.');
  });

```

### public/manager/manager.js — edit 7 of 9: INSERT_AFTER
Find this exact anchor text in the file (it appears exactly once). Insert the contents of `blocks/manager-07.txt` immediately AFTER it (after its last line):
```text
  ws.onclose = () => { setTimeout(() => { if (M.token) M.wsConnect(); }, 4000); };
};

```

### public/manager/manager.js — edit 8 of 9: REPLACE
Find this exact text in the file (it appears exactly once) and REPLACE it entirely with the contents of `blocks/manager-08.txt`:
```text
      M.token = data.token;
      M.user = data.user;
      localStorage.setItem('wc_token', M.token);
      M.wsConnect();
      renderShell();
      M.render();
      return;
    }
    if (r.status === 429) return renderLogin('Too many tries — wait a minute ⏳');
```

### public/manager/manager.js — edit 9 of 9: REPLACE
Find this exact text in the file (it appears exactly once) and REPLACE it entirely with the contents of `blocks/manager-09.txt`:
```text
    const { status, data } = await api('/me');
    if (status === 200 && data.user && data.user.role === 'admin') {
      M.user = data.user;
      M.wsConnect();
      renderShell();
      M.render();
      return;
    }
    M.token = null;
```
