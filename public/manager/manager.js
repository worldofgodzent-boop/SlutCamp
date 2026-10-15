/*
 * Slut Manager — the separate moderator app for SlutCamp.
 * Same origin + same session as the public app, but its own client:
 * every API call carries X-Manager: 1, and /api/admin/* refuses calls
 * without it. Screen bodies below are the platform's existing admin
 * screens, ported from the public app's former Moderator panel.
 */
'use strict';

/* ---------------- helpers (mirrored from the public app) ---------------- */
const $ = (sel) => document.querySelector(sel);
let app = null; // set to #mgr-content once the shell renders
const fmt = (c) => '$' + (c / 100).toFixed(2);
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

function toast(msg, ms) {
  const t = $('#toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.add('hidden'), ms || 2600);
}

/* Password field with show/hide toggle (same markup as the public app) */
function pwField(id, autocomplete) {
  return `<div class="pw-wrap"><input class="input" id="${id}" type="password" autocomplete="${autocomplete || 'current-password'}">` +
    `<button type="button" class="pw-eye" data-pw="${id}" aria-label="Show password">👁️</button></div>`;
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-pw]');
  if (!b) return;
  const inp = document.getElementById(b.dataset.pw);
  if (!inp) return;
  const showPw = inp.type === 'password';
  inp.type = showPw ? 'text' : 'password';
  b.textContent = showPw ? '🙈' : '👁️';
});

/* Tiny i18n shim — the Manager is English-only; covers the keys the
   ported screens look up. */
const T_SHIM = { wd_pending: '⏳ Pending', wd_paid: '✅ Paid', wd_rejected: '❌ Rejected' };
function t(k) { return T_SHIM[k] || k; }

function timeHM(iso) {
  const d = new Date((iso || '').replace(' ', 'T') + 'Z');
  if (isNaN(d)) return '';
  let h = d.getHours(); const m = String(d.getMinutes()).padStart(2, '0');
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m} ${ap}`;
}

/* ---------------- state + API ---------------- */
const M = {
  token: localStorage.getItem('wc_token') || null,
  user: null,
  screen: 'dash',
  peek: null,       // {id, title, messages} for the read-only chat peek
  live: null,       // mod-watch state
  ws: null,
  presenceTimer: null,
};

async function api(path, opts) {
  opts = opts || {};
  const headers = Object.assign(
    { 'Content-Type': 'application/json', 'X-Manager': '1' }, opts.headers || {});
  if (M.token) headers['Authorization'] = 'Bearer ' + M.token;
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch('/api' + path, Object.assign({}, opts, { headers, signal: ctrl.signal }));
    clearTimeout(timeout);
    let data = {};
    try { data = await r.json(); } catch (e) { /* non-JSON */ }
    return { status: r.status, data };
  } catch (e) {
    clearTimeout(timeout);
    return { status: 0, data: { error: 'network_error' } };
  }
}

/* POST a single file via multipart (same contract as the public app) */
async function apiUpload(path, file, field) {
  const fd = new FormData();
  fd.append(field || 'photo', file);
  const headers = { 'X-Manager': '1' };
  if (M.token) headers['Authorization'] = 'Bearer ' + M.token;
  try {
    const r = await fetch('/api' + path, { method: 'POST', headers, body: fd });
    let data = {};
    try { data = await r.json(); } catch (e) { /* non-JSON */ }
    return { status: r.status, data };
  } catch (e) {
    return { status: 0, data: { error: 'network_error' } };
  }
}


function openPhotoCropper(file, onCrop) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    const overlay = document.createElement('div');
    overlay.id = 'crop-overlay';
    overlay.innerHTML = `
      <div class="crop-box">
        <div class="crop-title">Crop your photo</div>
        <div class="crop-viewport" id="crop-viewport">
          <img id="crop-img" src="${url}" alt="">
          <div class="crop-grid"></div>
        </div>
        <div class="crop-hint">Drag to move · pinch or scroll to zoom</div>
        <div class="crop-actions">
          <button class="btn ghost" id="crop-cancel">Cancel</button>
          <button class="btn" id="crop-save">Crop &amp; Save</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const viewport = overlay.querySelector('#crop-viewport');
    const cimg = overlay.querySelector('#crop-img');
    let scale = 1, ox = 0, oy = 0;
    const minScale = 1;

    // Fit image to cover the square viewport initially
    const vw = viewport.clientWidth;
    const fitScale = Math.max(vw / img.naturalWidth, vw / img.naturalHeight);
    scale = fitScale;
    apply();

    function apply() {
      cimg.style.transform = `translate(-50%, -50%) translate(${ox}px, ${oy}px) scale(${scale})`;
    }
    function clamp() {
      const w = img.naturalWidth * scale, h = img.naturalHeight * scale;
      const maxX = Math.max(0, (w - vw) / 2), maxY = Math.max(0, (h - vw) / 2);
      ox = Math.min(maxX, Math.max(-maxX, ox));
      oy = Math.min(maxY, Math.max(-maxY, oy));
    }

    // Drag to pan
    let dragging = false, sx = 0, sy = 0;
    cimg.addEventListener('pointerdown', (e) => {
      dragging = true; sx = e.clientX - ox; sy = e.clientY - oy;
      cimg.setPointerCapture(e.pointerId);
    });
    cimg.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      ox = e.clientX - sx; oy = e.clientY - sy;
      clamp(); apply();
    });
    cimg.addEventListener('pointerup', () => { dragging = false; });
    cimg.addEventListener('pointercancel', () => { dragging = false; });

    // Pinch to zoom
    let pinchDist = 0;
    viewport.addEventListener('touchmove', (e) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX,
                              e.touches[0].clientY - e.touches[1].clientY);
        if (pinchDist) {
          scale = Math.max(fitScale, Math.min(fitScale * 5, scale * (d / pinchDist)));
          clamp(); apply();
        }
        pinchDist = d;
      }
    }, { passive: false });
    viewport.addEventListener('touchend', () => { pinchDist = 0; });

    // Scroll to zoom (desktop)
    viewport.addEventListener('wheel', (e) => {
      e.preventDefault();
      scale = Math.max(fitScale, Math.min(fitScale * 5, scale * (e.deltaY < 0 ? 1.1 : 0.9)));
      clamp(); apply();
    }, { passive: false });

    overlay.querySelector('#crop-cancel').onclick = () => {
      URL.revokeObjectURL(url);
      overlay.remove();
    };
    overlay.querySelector('#crop-save').onclick = () => {
      const size = 512;
      const canvas = document.createElement('canvas');
      canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext('2d');
      // Map viewport coords back to image coords
      const dispW = img.naturalWidth * scale, dispH = img.naturalHeight * scale;
      const sx0 = (dispW / 2 - vw / 2 - ox) / scale;
      const sy0 = (dispH / 2 - vw / 2 - oy) / scale;
      const sSize = vw / scale;
      ctx.drawImage(img, sx0, sy0, sSize, sSize, 0, 0, size, size);
      canvas.toBlob((blob) => {
        URL.revokeObjectURL(url);
        overlay.remove();
        if (blob) onCrop(new File([blob], 'photo.jpg', { type: 'image/jpeg' }));
      }, 'image/jpeg', 0.88);
    };
  };
  img.src = url;
}

function bookingWhen(at) {
  const d = new Date(at);
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) +
    ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

async function adminDashBody(s, o) {
  // Money comes from the /admin/overview LEDGER sums (one ruler, matching
  // windows) — never the platform_stats counter or the commission setting.
  const t = (o && o.today) || {};
  const a = (o && o.all_time) || {};
  const eff = (part, whole) => (whole > 0 ? `${(part / whole * 100).toFixed(1)}%` : null);
  const tEff = eff(t.platform_cents, t.gross_cents);
  const aEff = eff(a.platform_cents, a.gross_cents);
  return `
    <div class="stat-grid">
      <div class="stat"><div class="n" style="color:var(--green)">${fmt(t.platform_cents || 0)}</div><div class="l">Platform earnings today</div>${tEff ? `<div class="l" style="font-size:11px">${tEff} of today's gross</div>` : ''}</div>
      <div class="stat"><div class="n">${fmt(t.model_cents || 0)}</div><div class="l">Models earned today</div></div>
      ${t.recruiter_cents > 0 ? `<div class="stat"><div class="n">${fmt(t.recruiter_cents)}</div><div class="l">Recruiters today</div></div>` : ''}
      <div class="stat"><div class="n">${fmt(a.gross_cents || 0)}</div><div class="l">Total fan spending · all-time</div></div>
      <div class="stat"><div class="n" style="color:var(--green)">${fmt(a.platform_cents || 0)}</div><div class="l">Platform earnings · all-time</div>${aEff ? `<div class="l" style="font-size:11px">${aEff} of all-time gross</div>` : ''}</div>
      <div class="stat"><div class="n">${s.models_online}/${s.models}</div><div class="l">Models online</div></div>
      <div class="stat"><div class="n">${s.active_calls}</div><div class="l">Live calls</div></div>
      <div class="stat"><div class="n" style="color:${s.open_incidents ? 'var(--red)' : 'inherit'}">${s.open_incidents}</div><div class="l">Open safety flags</div></div>
      <div class="stat"><div class="n">${s.flagged_accounts}</div><div class="l">Flagged accounts (3⚠️)</div></div>
    </div>
    ${s.open_incidents ? `<button class="btn danger" id="go-safety">🚨 ${s.open_incidents} safety incident${s.open_incidents > 1 ? 's' : ''} need review</button>` : ''}
    <button class="btn ghost" id="a-logout">Log out</button>`;
}

async function adminChatsBody() {
  const { data } = await api('/admin/conversations');
  const convs = data.conversations || [];
  return `
    <div class="muted small" style="margin-bottom:10px">Read-only monitor — you can watch every conversation. Pause any chat with ⏸.</div>
    ${convs.map((c) => `
      <div class="card" style="padding:12px">
        <div class="row">
          <span class="grow"><b>${esc(c.model_name)}</b> <span class="muted">↔</span> <b>${esc(c.fan_name)}</b>
            ${c.is_guest ? '<span class="small muted">(guest)</span>' : ''}
            ${c.is_paused ? '<span class="small" style="color:var(--red)">⏸ paused</span>' : ''}<br>
            <span class="small muted">${c.message_count} msgs · ${c.last_message ? esc(c.last_message.body).slice(0, 60) : '—'}</span></span>
          <button class="btn small ghost" data-viewchat="${c.id}">Open</button>
          ${c.is_paused
            ? `<button class="btn small success" data-resume="${c.id}">▶</button>`
            : `<button class="btn small ghost" data-pause="${c.id}">⏸</button>`}
        </div>
      </div>`).join('') || '<div class="empty">No conversations yet.</div>'}`;
}

async function adminSafetyBody() {
  const { data: inc } = await api('/admin/safety/incidents?status=open');
  const { data: kw } = await api('/admin/safety/keywords');
  const { data: st } = await api('/admin/safety/strikes');
  const incidents = inc.incidents || [], keywords = kw.keywords || [], strikes = st.strikes || [];
  return `
    <h3 style="margin:4px 0 10px">🚨 Open incidents (${incidents.length})</h3>
    ${incidents.map((i) => `
      <div class="card" style="border-color:rgba(248,113,113,.5);padding:12px">
        <div><b>${esc(i.sender_name)}</b> <span class="muted small">(${esc(i.sender_role)} → ${esc(i.model_name)})</span>
          <span class="small" style="color:var(--red)"> · ${i.strikes} strike${i.strikes === 1 ? '' : 's'}${i.flagged ? ' · 🚩FLAGGED' : ''}</span></div>
        <div class="small" style="margin:6px 0">Matched: <b style="color:var(--pink)">"${esc(i.matched)}"</b></div>
        <div class="card" style="background:var(--bg2);padding:10px;margin:6px 0"><i>"${esc(i.flagged_text)}"</i></div>
        <div class="row">
          <button class="btn small success" data-inc-resume="${i.id}">▶ Resume chat</button>
          <button class="btn small ghost" data-inc-dismiss="${i.id}">Dismiss</button>
        </div>
      </div>`).join('') || '<div class="muted" style="margin-bottom:14px">No open incidents. The monitor is watching 👀</div>'}

    <h3 style="margin:14px 0 10px">⚠️ Flagged accounts</h3>
    ${(strikes.filter((s) => s.flagged).map((s) => `
      <div class="row card" style="padding:10px 12px"><span class="grow"><b>${esc(s.name)}</b></span>
        <span class="small" style="color:var(--red)">${s.strikes} strikes 🚩</span></div>`).join('')
      || '<div class="muted" style="margin-bottom:14px">None.</div>')}

    <h3 style="margin:14px 0 10px">🔑 Blocked keywords/phrases</h3>
    <div class="card" style="padding:12px">
      ${(keywords.map((k) => `
        <div class="row" style="padding:6px 0;border-bottom:1px solid rgba(139,92,246,.1)">
          <span class="grow"><code>${esc(k.keyword)}</code></span>
          <button class="toggle ${k.enabled ? 'on' : ''}" data-kw-toggle="${k.id}" style="width:60px;height:32px" aria-label="toggle"></button>
          <button class="btn small danger" data-kw-del="${k.id}">✕</button>
        </div>`).join(''))}
      <div class="row" style="margin-top:10px">
        <input class="input" id="kw-new" placeholder="Add keyword…" style="margin-top:0">
        <button class="btn small" id="kw-add">Add</button>
      </div>
      <div class="muted small" style="margin-top:8px">Phone numbers (123-456-7890 etc.) are always blocked automatically.</div>
    </div>`;
}

async function adminLiveBody() {
  const { data } = await api('/admin/live');
  const sessions = data.sessions || [], events = data.events || [];
  const { data: gdata } = await api('/admin/gifts');
  const gifts = gdata.gifts || [];
  const evLabel = { auto_blur: '🤖 AI blur', manual_blur: '👆 manual', paid: '💰 paid unblur',
    timeout_kick: '⏱️ timed out', paywall_shown: '🔞 paywall shown', pay_stopped: '💳 pay stopped', manual_mode: '🎛️ mode' };
  return `
    <h3 style="margin:4px 0 10px">🔴 Live sessions</h3>
    ${sessions.map((s) => `
      <div class="card" style="padding:12px;${s.status === 'live' ? 'border-color:rgba(239,68,68,.6)' : ''}">
        <div class="row"><span class="grow"><b>${esc(s.model_name)}</b>
          ${s.status === 'live' ? '<span class="live-badge">🔴 LIVE</span>' : '<span class="small muted">ended</span>'}<br>
          ${s.title ? `<span class="small" style="font-weight:700">"${esc(s.title)}"</span><br>` : ''}
          <span class="small muted">${s.viewers} watching · ${s.paying_viewers} paying · ${fmt(s.explicit_rate_cents)}/min explicit</span><br>
          <span class="small" style="color:var(--pink);font-weight:700">🎁 ${fmt(s.gift_cents || 0)} in gifts (${s.gift_count || 0})</span><br>
          <span class="small muted">started ${timeHM(s.started_at)}</span></span>
          ${s.status === 'live' ? `<button class="btn small" data-live-watch="${s.id}" style="background:linear-gradient(135deg,#8b5cf6,#3b82f6)">👁️ Watch</button> <button class="btn small danger" data-live-end="${s.id}">End</button>` : ''}
        </div>
      </div>`).join('') || '<div class="muted">No live sessions yet.</div>'}
    <h3 style="margin:14px 0 10px">🎁 Gift catalog</h3>
    <div class="card" style="padding:12px">
      ${gifts.map((g) => `
        <div class="row" style="padding:6px 0;border-bottom:1px solid rgba(139,92,246,.1);${g.enabled ? '' : 'opacity:.45'}">
          <span style="font-size:22px">${g.emoji}</span>
          <span class="grow"><b>${esc(g.name)}</b> <span class="small muted">${fmt(g.price_cents)}</span>
            ${g.enabled ? '' : '<span class="small" style="color:var(--red)">disabled</span>'}</span>
          <button class="btn small ghost" data-gift-edit="${g.id}">✏️</button>
          <button class="btn small ghost" data-gift-toggle="${g.id}">${g.enabled ? '⏸️' : '▶️'}</button>
          <button class="btn small danger" data-gift-del="${g.id}">✕</button>
        </div>
        <div id="gedit-${g.id}"></div>`).join('')}
      <div style="font-weight:800;margin:10px 0 6px">➕ Add gift</div>
      <div class="row" style="gap:6px;flex-wrap:wrap">
        <input class="input" id="ng-emoji" placeholder="🚀" style="max-width:64px;text-align:center">
        <input class="input" id="ng-name" placeholder="Name" style="flex:1;min-width:90px">
        <input class="input" id="ng-price" placeholder="$" inputmode="decimal" style="max-width:90px">
        <button class="btn small" id="gift-add">Add</button>
      </div>
    </div>
    <h3 style="margin:14px 0 10px">📝 Blur / pay events</h3>
    ${events.map((e) => `
      <div class="row small" style="padding:7px 0;border-bottom:1px solid rgba(139,92,246,.1)">
        <span class="grow">${evLabel[e.event] || e.event} — <b>${esc(e.model_name)}</b>
          ${e.fan_name ? `→ ${esc(e.fan_name)}` : ''} <span class="muted">${esc(e.detail || '')}</span></span>
        <span class="muted">${timeHM(e.created_at)}</span>
      </div>`).join('') || '<div class="muted">No events logged.</div>'}`;
}

/* Presence override (Models tab): effective status = what fans actually
   see. 'auto' → her own is_online toggle; 'on'/'off' → admin-forced. */
function presEff(m) {
  const ovr = m.presence_override || 'auto';
  return ovr === 'on' ? true : ovr === 'off' ? false : !!m.is_online;
}
function presForced(m) {
  return !!m.presence_override && m.presence_override !== 'auto';
}

async function adminModelsBody() {
  const { data } = await api('/admin/models');
  const models = data.models || [];
  return `
    ${models.map((m) => `
      <div class="card model-article">
        ${m.photo_url
          ? `<div class="model-article-photo"><img src="${esc(m.photo_url)}" alt=""></div>`
          : `<div class="model-article-photo model-article-initial">${esc(m.display_name[0] || '?')}</div>`}
        <div class="model-article-body">
          <div><b>${esc(m.display_name)}</b> <span class="small muted">@${esc(m.username)}</span><br>
            <span class="small" id="pres-status-${m.id}" style="color:${presEff(m) ? 'var(--green)' : 'var(--muted)'}">${presEff(m) ? '●' : '○'} ${presEff(m) ? 'Online' : 'Offline'}${presForced(m) ? ' (forced)' : ''}</span>
            <span class="small muted"> · ${fmt(m.per_message_cents)}/msg · ${fmt(m.per_minute_cents)}/min</span><br>
            <span class="small" style="color:var(--green)">Owed: ${fmt(m.pending_cents)}</span>
            ${m.recruiter_name ? `<br><span class="small" style="color:var(--gold)">🤝 via ${esc(m.recruiter_name)}</span>` : ''}
            ${m.is_hidden ? `<br><span class="small" style="color:var(--peach)">👻 Hidden from the main screen</span>` : ''}</div>
          <div class="row" style="margin-top:8px;gap:6px;flex-wrap:wrap">
            <button class="btn small ghost" data-m-edit="${m.id}">✏️ Edit</button>
            <button class="btn small ghost" data-m-photo="${m.id}">📷 Photo</button>
            <button class="btn small ghost" data-m-msg="${m.id}">💬 Message</button>
            <button class="btn small ghost" data-m-pw="${m.id}">🔑 Password</button>
            <button class="btn small ghost" data-m-hide="${m.id}">${m.is_hidden ? '👀 Show' : '👻 Hide'}</button>
            <button class="btn small ghost" data-m-toggle="${m.id}">${m.banned ? "✅ Reactivate" : "⏸️ Deactivate"}</button>
            <button class="btn small danger" data-m-del="${m.id}">Remove</button>
          </div>
          ${m.is_featured ? '' : `<div class="row" style="margin-top:8px;gap:6px;flex-wrap:wrap;align-items:center">
            <span class="small muted">👁 Fans see her as:</span>
            <button class="btn small ${!presForced(m) ? '' : 'ghost'}" data-m-pres="${m.id}" data-mode="auto">Auto</button>
            <button class="btn small ${m.presence_override === 'on' ? '' : 'ghost'}" data-m-pres="${m.id}" data-mode="on">Online</button>
            <button class="btn small ${m.presence_override === 'off' ? '' : 'ghost'}" data-m-pres="${m.id}" data-mode="off">Offline</button>
          </div>`}
        </div>
        <div id="edit-${m.id}" style="flex-basis:100%"></div>
      </div>`).join('')}
    <div class="card"><div style="font-weight:800;margin-bottom:6px">➕ Add model</div>
      <label class="field">Display name<input class="input" id="nm-name"></label>
      <label class="field">Username<input class="input" id="nm-user"></label>
      <label class="field">Password${pwField('nm-pass', 'new-password')}</label>
      <label class="field">Bio<textarea class="input" id="nm-bio" rows="2"></textarea></label>
      <button class="btn" id="nm-add">Add model</button>
      <div class="muted small" style="margin-top:6px">Verify her ID in person (2257) before she goes live.</div>
    </div>`;
}

async function adminInvitesBody() {
  const { data } = await api('/admin/invites');
  const invites = data.invites || [];
  const baseUrl = window.location.origin;
  const modelInvites = invites.filter((i) => i.role !== 'recruiter');
  const affInvites = invites.filter((i) => i.role === 'recruiter');
  const cleanupCount = typeof data.cleanup_count === 'number' ? data.cleanup_count
    : invites.filter((i) => !i.used_by || (i.expires_at && new Date(i.expires_at + 'Z') < new Date())).length;
  const inviteCard = (inv, isAff) => {
    const url = isAff ? `${baseUrl}/#affiliate/${inv.code}` : `${baseUrl}/?invite=${inv.code}`;
    const status = inv.is_revoked ? '<span style="color:var(--red)">⛔ Revoked</span>'
      : inv.used_by ? `<span style="color:var(--green)">✅ Used by ${esc(inv.used_by.display_name)}${inv.used_by.banned ? ' (deactivated)' : ''}</span>`
      : inv.expired ? '<span style="color:var(--red)">⌛ Expired — hit Refresh to give her 6 more hours</span>'
      : `<span style="color:var(--yellow)">⏳ Waiting for signup</span>${inv.expires_at ? `<br><span class="small muted">Expires ${timeHM(inv.expires_at)}</span>` : ''}`;
    return `
      <div class="card" style="padding:12px">
        <div class="row"><span class="grow"><b>${esc(inv.label) || 'Untitled invite'}</b><br>
          <span class="small muted">${url}</span><br>${status}
          ${inv.used_at ? `<br><span class="small muted">Used ${timeHM(inv.used_at)}</span>` : ''}</span></div>
        <div class="row" style="margin-top:8px;gap:6px;flex-wrap:wrap">
          ${!inv.is_revoked ? `<button class="btn small" data-inv-copy="${inv.code}" data-aff="${isAff ? 1 : 0}">📋 Copy link</button>` : ''}
          ${!inv.is_revoked && !inv.used_by ? `<button class="btn small ghost" data-inv-refresh="${inv.id}">🔄 Refresh (6h)</button>` : ''}
          ${!inv.is_revoked ? `<button class="btn small danger" data-inv-revoke="${inv.id}" data-used="${inv.used_by ? 1 : 0}">Revoke</button>` : ''}
          <button class="btn small danger" data-inv-del="${inv.id}" data-used="${inv.used_by ? 1 : 0}">🗑 Delete</button>
        </div>
      </div>`;
  };
  return `
    <div class="card">
      <div style="font-weight:800;margin-bottom:6px">✉️ Generate model invite link</div>
      <div class="muted small">Send this link to a model — she signs up through it and gets a model account. Links expire in 6 hours; if she's slow, hit 🔄 Refresh on her link below — same link, 6 fresh hours, nothing to resend. You can revoke it anytime.</div>
      <label class="field">Label (e.g. her name)<input class="input" id="inv-label" placeholder="Bunny"></label>
      <button class="btn" id="inv-gen">Generate invite link</button>
    </div>
    <div class="card" style="border-color:var(--gold)">
      <div style="font-weight:800;margin-bottom:6px">🤝 Generate affiliate invite link</div>
      <div class="muted small">Send this to someone you want as an affiliate — they sign up, see the Affiliate Agreement, must accept to continue. They get their own referral link and earn 20%.</div>
      <label class="field">Label (e.g. their name)<input class="input" id="aff-label" placeholder="Name"></label>
      <button class="btn" id="aff-gen">Generate affiliate invite</button>
    </div>
    <div class="card" style="padding:12px">
      <div class="row"><span class="grow"><b>🧹 Clean up dead links</b><br>
        <span class="small muted">${cleanupCount} link${cleanupCount === 1 ? '' : 's'} unused or expired across both lists. Delete them so the screen stays tidy — used invites that are still in their window stay put.</span></span>
        <button class="btn small danger" id="inv-cleanup" data-count="${cleanupCount}"${cleanupCount ? '' : ' disabled'}>🧹 Delete unused & expired</button></div>
    </div>
    <h3>🤝 Affiliate invites (${affInvites.length})</h3>
    ${affInvites.map((inv) => inviteCard(inv, true)).join('') || '<div class="empty">No affiliate invites yet.</div>'}
    <h3>✉️ Model invites (${modelInvites.length})</h3>
    ${modelInvites.map((inv) => inviteCard(inv, false)).join('') || '<div class="empty">No invite links yet.</div>'}`;
}

async function adminPayoutsBody() {
  const { data } = await api('/admin/payouts');
  const { data: wdData } = await api('/admin/withdrawals');
  const { data: treasury } = await api('/admin/crypto-treasury');
  const { data: cInvData } = await api('/admin/crypto-invoices');
  const { data: loadsData } = await api('/admin/loads?limit=100');
  const loads = (loadsData && loadsData.loads) || [];
  const lt = (loadsData && loadsData.totals) || { today: {}, all_time: {} };
  const COIN_ORDER = ['USDT', 'BTC', 'ETH', 'SOL', 'XRP'];
  const coinRows = [...new Set([...COIN_ORDER,
    ...Object.keys(lt.today.crypto_by_coin || {}), ...Object.keys(lt.all_time.crypto_by_coin || {})])]
    .filter((c) => (lt.today.crypto_by_coin || {})[c] || (lt.all_time.crypto_by_coin || {})[c]);
  const totRow = (label, todayC, allC) => `
    <tr><td>${label}</td><td>${fmt(todayC || 0)}</td><td>${fmt(allC || 0)}</td></tr>`;
  const moneyInHTML = `
    <h3>💰 Money in — wallet loads by source</h3>
    <div class="card" style="padding:12px">
      <div class="small muted" style="margin-bottom:8px">Every credit a fan bought or was given, labeled by the rail it arrived on.
        Spends draw on one shared balance, so a spend can't be traced back to a single load — provenance lives here, at the load.</div>
      <table class="src-totals">
        <tr><th>Source</th><th>Today</th><th>All time</th></tr>
        ${totRow('💳 CCBill (card)', lt.today.ccbill_cents, lt.all_time.ccbill_cents)}
        ${coinRows.map((c) => totRow(`🪙 Crypto · ${c}`,
          (lt.today.crypto_by_coin || {})[c], (lt.all_time.crypto_by_coin || {})[c])).join('')}
        ${totRow('🛠️ Admin credits', lt.today.admin_cents, lt.all_time.admin_cents)}
        ${totRow('↩️ Refunds (re-credited)', lt.today.refund_cents, lt.all_time.refund_cents)}
        <tr class="src-grand"><td>Total in</td><td>${fmt(lt.today.total_cents || 0)}</td><td>${fmt(lt.all_time.total_cents || 0)}</td></tr>
      </table>
      ${loads.length ? `<h4 style="margin:14px 0 6px">Recent loads</h4>` : ''}
      ${loads.map((l) => `
        <div class="row small" style="padding:7px 0;border-top:1px solid rgba(255,255,255,.06);align-items:flex-start">
          <span class="grow"><span class="src-badge src-${esc(l.source)}">${esc(l.label)}</span>
            <b>${esc(l.fan_name || '')}</b> <span class="muted">@${esc(l.fan_username || '')}</span><br>
            <span class="muted">${esc(String(l.ts || '').slice(0, 10))} · ${timeHM(l.ts)}</span>
            ${l.source === 'crypto' ? `<br><span class="muted">recv ${esc(l.received_amount || '?')} ${esc(l.coin || '')}${l.partial ? ' · ⚠ partial load (underpaid)' : ''}${l.via === 'manual' ? ' · released by admin' : ' · auto-confirmed'}${l.txid_short ? ` · tx <span style="font-family:monospace;font-size:11px">${esc(l.txid_short)}</span>` : ''}</span>` : ''}
            ${l.source === 'ccbill' ? `<br><span class="muted">order #${l.ref_id}${l.detail ? ' · ' + esc(l.detail) : ''}${l.txid_short ? ` · txn <span style="font-family:monospace;font-size:11px">${esc(l.txid_short)}</span>` : ''}</span>` : ''}
            ${l.source === 'admin' ? `<br><span class="muted">${esc(l.detail || 'Admin credit grant')}</span>` : ''}
            ${l.source === 'refund' ? `<br><span class="muted">${esc(l.detail || 'Refund')}</span>` : ''}
          </span>
          <span style="text-align:right"><b style="color:var(--green)">${fmt(l.amount_cents)}</b></span>
        </div>`).join('') || '<div class="muted small">No wallet loads recorded yet.</div>'}
    </div>`;
  const cInvs = (cInvData && cInvData.invoices) || [];
  const tCoins = (treasury && treasury.coins) || [];
  const tSet = (treasury && treasury.settings) || {};
  const treasuryHTML = `
    <h3>₿ Crypto Treasury</h3>
    <div class="card" style="padding:12px">
      ${tCoins.map((c) => `
        <div class="row" style="padding:6px 0;border-bottom:1px solid rgba(255,255,255,.06)">
          <span class="grow"><b>${({ BTC: '₿ Bitcoin', USDT: '💵 USDT', ETH: 'Ξ Ethereum', SOL: '◎ Solana', XRP: '✕ XRP' })[c.coin] || c.coin}</b>
            <span class="small muted">awaiting sweep</span><br>
            <span class="small muted">${c.count} invoice${c.count === 1 ? '' : 's'}${c.placeholder ? ' · ⚠ test addresses' : ''}</span></span>
          <span style="text-align:right"><b>${c.amount_crypto} ${c.coin}</b><br>
            <span class="small muted">≈ ${fmt(c.usd_cents)}${c.spot_usd ? '' : ' (est.)'}</span></span>
          <button class="btn small ${c.worth_sweeping ? '' : 'ghost'}" data-sweep="${c.coin}" ${c.count ? '' : 'disabled'}>Mark swept</button>
        </div>
        ${c.worth_sweeping ? `<div class="small" style="color:var(--gold);padding:4px 0">💡 Worth sweeping — unswept is over the $${tSet.sweep_threshold_usd || 200} threshold.</div>` : ''}`).join('')}
      <div style="margin-top:10px;background:rgba(0,0,0,.25);border-radius:8px;padding:10px">
        <b class="small">Sweep helper — move funds to ${esc(tSet.exchange || 'Coinbase')}</b>
        <div class="small" style="margin:8px 0">
          1️⃣ Send from your wallet to the exchange deposit address below<br>
          2️⃣ Sell on ${esc(tSet.exchange || 'Coinbase')}<br>
          3️⃣ Withdraw USD to the business bank account<br>
          4️⃣ Come back here and tap <b>Mark swept</b>
        </div>
        <div class="small muted">BTC deposit address</div>
        <div class="row" style="gap:6px;margin:2px 0 8px">
          <input id="cs-btc-addr" value="${esc(tSet.sweep_btc_address || '')}" placeholder="Coinbase BTC deposit address" style="flex:1">
          <button class="btn small ghost" data-copy-val="${esc(tSet.sweep_btc_address || '')}">📋 Copy</button>
        </div>
        <div class="small muted">USDT deposit address</div>
        <div class="row" style="gap:6px;margin:2px 0 8px">
          <input id="cs-usdt-addr" value="${esc(tSet.sweep_usdt_address || '')}" placeholder="Coinbase USDT (ERC-20) deposit address" style="flex:1">
          <button class="btn small ghost" data-copy-val="${esc(tSet.sweep_usdt_address || '')}">📋 Copy</button>
        </div>
        <div class="small muted">ETH deposit address</div>
        <div class="row" style="gap:6px;margin:2px 0 8px">
          <input id="cs-eth-addr" value="${esc(tSet.sweep_eth_address || '')}" placeholder="Coinbase ETH deposit address" style="flex:1">
          <button class="btn small ghost" data-copy-val="${esc(tSet.sweep_eth_address || '')}">📋 Copy</button>
        </div>
        <div class="small muted">SOL deposit address</div>
        <div class="row" style="gap:6px;margin:2px 0 8px">
          <input id="cs-sol-addr" value="${esc(tSet.sweep_sol_address || '')}" placeholder="Coinbase SOL deposit address" style="flex:1">
          <button class="btn small ghost" data-copy-val="${esc(tSet.sweep_sol_address || '')}">📋 Copy</button>
        </div>
        <div class="small muted">XRP deposit address</div>
        <div class="row" style="gap:6px;margin:2px 0 8px">
          <input id="cs-xrp-addr" value="${esc(tSet.sweep_xrp_address || '')}" placeholder="Coinbase XRP deposit address" style="flex:1">
          <button class="btn small ghost" data-copy-val="${esc(tSet.sweep_xrp_address || '')}">📋 Copy</button>
        </div>
        <div class="row" style="gap:6px">
          <span class="small muted">Sweep hint at $</span>
          <input id="cs-threshold" type="number" min="0" value="${tSet.sweep_threshold_usd || 200}" style="width:90px">
          <button class="btn small" id="cs-save">Save</button>
        </div>
      </div>
      ${cInvs.length ? `<h4 style="margin:14px 0 6px">Crypto invoices</h4>` : ''}
      ${cInvs.slice(0, 50).map((inv) => `
        <div class="row small" style="padding:7px 0;border-top:1px solid rgba(255,255,255,.06);align-items:flex-start">
          <span class="grow"><b>${esc(inv.fan_name || '')}</b> <span class="muted">@${esc(inv.fan_username || '')}</span><br>
            <span class="muted">#${inv.id} · ${timeHM(inv.created_at)} · ${inv.coin} ${esc(inv.amount_crypto)} for ${fmt(inv.package_usd_cents)} pkg${inv.dest_tag ? ` · tag ${inv.dest_tag}` : ''}</span><br>
            <span class="muted">recv ${esc(inv.received_amount || '0')} ${inv.coin}${inv.confirmations ? ` · ${inv.confirmations} conf` : ''}${inv.excess_units > 0 ? ` · ⚠ excess on invoice` : ''}${inv.swept_at ? ' · swept ✓' : ''}${inv.credited_via ? ` · via ${esc(inv.credited_via)}` : ''}</span><br>
            <span class="muted" style="font-family:monospace;font-size:11px">${esc(inv.address)}</span>
            ${inv.txid ? `<br><span class="muted" style="font-family:monospace;font-size:11px">tx ${esc(String(inv.txid).slice(0, 24))}…</span>` : ''}
          </span>
          <span style="text-align:right"><b>${esc(inv.status)}</b><br>
          ${inv.status !== 'credited' && inv.status !== 'credited_partial'
            ? `<button class="btn small success" data-markcred="${inv.id}" style="margin-top:4px">Mark credited</button>` : ''}</span>
        </div>`).join('')}
    </div>`;
  const wds = (wdData && wdData.withdrawals) || [];
  const pending = wds.filter((w) => w.status === 'pending');
  const done = wds.filter((w) => w.status !== 'pending');
  const wdBadge = (s) => s === 'pending' ? t('wd_pending') : s === 'paid' ? t('wd_paid') : t('wd_rejected');
  return `
    ${moneyInHTML}
    ${treasuryHTML}
    ${pending.length ? `<h3>⏳ Withdrawal requests (${pending.length})</h3>` : ''}
    ${pending.map((w) => `
      <div class="card" style="padding:12px;border-color:var(--pink)">
        <div class="row"><span class="grow"><b>${esc(w.model_name)}</b> <span class="small muted">@${esc(w.model_username)}</span>
          ${w.user_role === 'recruiter' ? ' <span class="small" style="color:var(--gold)">🤝 partner</span>' : ''}<br>
          <span class="small muted">${timeHM(w.requested_at)}</span></span>
          <b style="color:var(--green);font-size:18px">${fmt(w.amount_cents)}</b></div>
        <div class="small" style="margin-top:8px;background:rgba(0,0,0,.25);border-radius:8px;padding:8px">
          🏦 <b>${esc(w.holder_name || '—')}</b><br>
          Routing: <b>${esc(w.routing_number || '—')}</b><br>
          Account: <b>${esc(w.account_number || '—')}</b>
        </div>
        <div class="row" style="margin-top:8px;gap:6px">
          <button class="btn small success" data-wd-pay="${w.id}">✅ Mark paid</button>
          <button class="btn small danger" data-wd-reject="${w.id}">Reject</button>
        </div>
      </div>`).join('')}
    <h3>Model balances</h3>
    ${(data.payouts || []).map((p) => `
      <div class="card" style="padding:12px">
        <div class="row"><span class="grow"><b>${esc(p.display_name)}</b><br>
          <span class="small muted">Earned ${fmt(p.earnings_cents)} · Paid ${fmt(p.paid_out_cents)}</span></span>
          <b style="color:var(--green)">${fmt(p.pending_cents)}</b></div>
        ${p.pending_cents > 0 ? `
          <div class="row" style="margin-top:8px">
            <input class="input" id="pay-${p.id}" type="number" step="0.01" placeholder="Amount $" style="margin-top:0">
            <button class="btn small success" data-pay="${p.id}">Mark paid</button>
          </div>` : ''}
      </div>`).join('')}
    ${done.length ? `<h3>Withdrawal history</h3>` : ''}
    ${done.map((w) => `
      <div class="row small" style="padding:6px 0"><span class="grow">${esc(w.model_name)} — <b>${fmt(w.amount_cents)}</b></span>
        <span>${wdBadge(w.status)}</span> <span class="muted">${timeHM(w.decided_at || w.requested_at)}</span></div>`).join('')}
    <h3>Payout history</h3>
    ${(data.history || []).map((h) => `
      <div class="row small" style="padding:6px 0"><span class="grow">${esc(h.model_name)} — ${fmt(h.gross_cents)}</span>
        <span class="muted">${timeHM(h.created_at)}</span></div>`).join('') || '<div class="muted">No payouts yet.</div>'}`;
}

async function adminFansBody() {
  const { data } = await api('/admin/fans');
  const fanLoadsLine = (f) => {
    const L = f.loads_by_source;
    if (!L || !L.total_cents) return '<br><span class="small muted">Loaded $0.00 — no loads recorded</span>';
    const parts = [];
    if (L.ccbill_cents) parts.push(`💳 CCBill ${fmt(L.ccbill_cents)}`);
    for (const c of ['USDT', 'BTC', 'ETH', 'SOL', 'XRP']) {
      if ((L.crypto_by_coin || {})[c]) parts.push(`🪙 ${c} ${fmt(L.crypto_by_coin[c])}`);
    }
    for (const c of Object.keys(L.crypto_by_coin || {})) {
      if (!['USDT', 'BTC', 'ETH', 'SOL', 'XRP'].includes(c)) parts.push(`🪙 ${c} ${fmt(L.crypto_by_coin[c])}`);
    }
    if (L.admin_cents) parts.push(`🛠️ Admin ${fmt(L.admin_cents)}`);
    if (L.refund_cents) parts.push(`↩️ Refunds ${fmt(L.refund_cents)}`);
    return `<br><span class="small">Loaded ${fmt(L.total_cents)} <span class="muted">(${parts.join(' · ')})</span></span>`;
  };
  return `
    ${(data.fans || []).map((f) => `
      <div class="card" style="padding:12px">
        <div class="row"><span class="grow"><b>${esc(f.display_name)}</b>
          <span class="small muted">@${esc(f.username)}</span><br>
          <span class="small">Balance ${fmt(f.credits_cents)} · Spent ${fmt(f.spent_cents)} <span class="muted">(msgs, calls, gifts)</span></span>
          ${fanLoadsLine(f)}
          ${f.banned ? ' <span class="small" style="color:var(--red)">⛔ banned</span>' : ''}</span></div>
        <div class="row" style="margin-top:8px">
          <input class="input" id="cr-${f.id}" type="number" step="0.01" placeholder="$ credits" style="margin-top:0;max-width:130px">
          <button class="btn small" data-credit="${f.id}">+ Credits</button>
          <button class="btn small ${f.banned ? 'success' : 'danger'}" data-ban="${f.id}">${f.banned ? 'Unban' : 'Ban'}</button>
        </div>
      </div>`).join('') || '<div class="empty">No fans yet.</div>'}`;
}

async function adminContractsBody() {
  const { data } = await api('/admin/contracts');
  const rows = (data && data.contracts) || [];
  const cur = (data && data.current_version) || '?';
  const signed = rows.filter((r) => r.signed_at);
  const unsigned = rows.filter((r) => !r.signed_at);
  return `
    <div style="font-weight:800;margin-bottom:10px">📝 Model agreements <span class="small muted">(current: v${esc(cur)})</span></div>
    ${unsigned.length ? `
      <h3 style="color:var(--red)">⚠️ Not signed (${unsigned.length})</h3>
      ${unsigned.map((r) => `
        <div class="card" style="padding:10px;margin-bottom:8px;border-color:var(--red)">
          <b>${esc(r.display_name)}</b> <span class="small muted">@${esc(r.username)}</span>
          ${r.banned ? ' <span class="small" style="color:var(--red)">(deactivated)</span>' : ''}
          <div class="small muted">Has not signed the agreement — gated from the app until she does.</div>
        </div>`).join('')}
    ` : ''}
    <h3 style="color:var(--green)">✅ Signed (${signed.length})</h3>
    ${signed.length ? signed.map((r) => `
      <div class="card" style="padding:10px;margin-bottom:8px">
        <b>${esc(r.display_name)}</b> <span class="small muted">@${esc(r.username)}</span>
        ${r.banned ? ' <span class="small" style="color:var(--red)">(deactivated)</span>' : ''}<br>
        <span class="small muted">Signed as "${esc(r.signed_name)}" · v${esc(r.contract_version)} · ${esc(r.signed_at)}</span>
      </div>`).join('') : '<div class="small muted">No signatures yet.</div>'}
  `;
}

async function adminIdChecksBody() {
  const { data } = await api('/admin/id-verifications');
  const rows = (data && data.verifications) || [];
  const pending = rows.filter((r) => r.status === 'pending');
  const decided = rows.filter((r) => r.status !== 'pending');
  // Fetch single-use photo tokens for pending reviews so <img> tags can load them
  for (const r of pending) {
    try {
      const { data: t } = await api(`/admin/id-verifications/${r.id}/photo-token`, { method: 'POST' });
      r._tok = t && t.token;
    } catch (e) { r._tok = null; }
  }
  const photoRow = (r, which, label) => r._tok
    ? `<div style="flex:1;min-width:120px"><div class="small muted" style="margin-bottom:4px">${label}</div>
       <img src="/api/admin/id-verifications/${r.id}/photo/${which}?t=${r._tok}"
            style="width:100%;border-radius:8px;border:1px solid var(--border)" loading="lazy"></div>`
    : `<div class="small muted" style="flex:1">Photo unavailable</div>`;
  const badge = (s) => ({ pending: '⏳ Pending', approved: '✅ Approved', rejected: '❌ Rejected' }[s] || s);
  return `
    <div style="font-weight:800;margin-bottom:10px">🪪 Model ID verification <span class="small muted">(18 U.S.C. §2257)</span></div>
    <div class="small muted" style="margin-bottom:12px">Models cannot chat with fans or go live until you approve their ID. Photos are private — only visible here.</div>
    ${pending.length ? `
      <h3 style="color:var(--yellow)">⏳ Awaiting review (${pending.length})</h3>
      ${pending.map((r) => `
        <div class="card" style="padding:12px;margin-bottom:10px;border-color:var(--yellow)">
          <div class="row" style="align-items:center;margin-bottom:8px">
            <span class="grow"><b>${esc(r.display_name)}</b> <span class="small muted">@${esc(r.username)}</span><br>
              <span class="small muted">Submitted ${esc(r.submitted_at || '')}</span></span>
          </div>
          <div class="row" style="gap:8px;margin-bottom:10px">
            ${photoRow(r, 'front', 'ID front')}
            ${photoRow(r, 'back', 'ID back')}
            ${photoRow(r, 'selfie', 'Selfie + ID')}
          </div>
          <div class="row" style="gap:8px">
            <button class="btn small" data-idv-approve="${r.id}" style="flex:1">✅ Approve</button>
            <button class="btn small danger" data-idv-reject="${r.id}" style="flex:1">❌ Reject</button>
            <button class="btn small ghost" data-idv-2257="${r.id}" style="flex:1">📄 2257</button>
          </div>
        </div>`).join('')}
    ` : '<div class="small muted" style="margin-bottom:12px">No pending verifications. 🎉</div>'}
    ${decided.length ? `
      <h3>Reviewed (${decided.length})</h3>
      ${decided.map((r) => `
        <div class="card" style="padding:10px;margin-bottom:8px">
          <b>${esc(r.display_name)}</b> <span class="small muted">@${esc(r.username)}</span><br>
          <span class="small">${badge(r.status)}</span>
          <span class="small muted"> · reviewed ${esc(r.reviewed_at || '')}</span>
          ${r.reviewer_note ? `<br><span class="small muted">Note: ${esc(r.reviewer_note)}</span>` : ''}
          ${r.status === 'rejected' ? ` <button class="btn small ghost" data-idv-approve="${r.id}">Approve anyway</button>` : ''}
          <button class="btn small ghost" data-idv-2257="${r.id}">📄 2257 record</button>
        </div>`).join('')}
    ` : ''}
  `;
}

async function adminBookingsBody() {
  const { data } = await api('/admin/bookings');
  const bookings = data.bookings || [];
  const badge = (s) => ({ pending: '⏳', approved: '✅', declined: '❌', cancelled: '🚫',
    completed: '🏁', in_progress: '🔴', no_show: '👻', refunded: '💸' }[s] || s);
  return `
    <div style="font-weight:800;margin-bottom:10px">📅 Private bookings (latest first)</div>
    ${bookings.map((b) => `
      <div class="card" style="padding:10px;margin-bottom:8px">
        <div class="row" style="align-items:center">
          <span class="grow"><b>${esc(b.fan_name)}</b> → <b>${esc(b.model_name)}</b><br>
            <span class="small muted">${bookingWhen(b.scheduled_at)} · ${b.duration_min}min · <b style="color:var(--green)">${fmt(b.total_cents)}</b></span></span>
          <span>${badge(b.status)} <span class="small muted">${b.status.replace('_', ' ')}</span></span>
        </div>
      </div>`).join('') || '<div class="empty">No bookings yet.</div>'}`;
}

async function adminPartnersBody() {
  const { data } = await api('/admin/recruiters');
  const partners = data.recruiters || [];
  const baseUrl = window.location.origin;
  return `
    <div class="card">
      <div style="font-weight:800;margin-bottom:6px">➕ Add partner</div>
      <div class="muted small" style="margin-bottom:8px">They get a login + a referral link. Models who join through it earn them 20% of the platform's cut (you keep the other 20%).</div>
      <label class="field">Name<input class="input" id="pt-name" maxlength="40" placeholder="Marcus"></label>
      <label class="field">City<input class="input" id="pt-city" maxlength="40" placeholder="New York"></label>
      <label class="field">Username (optional — auto if blank)<input class="input" id="pt-user" autocomplete="off"></label>
      <label class="field">Password (optional — auto if blank, 6+ chars)${pwField('pt-pass', 'new-password')}</label>
      <button class="btn" id="pt-add">Create partner</button>
      <div id="pt-result" style="margin-top:8px"></div>
    </div>
    ${partners.map((p) => {
      const url = `${baseUrl}/#join/${p.referral_code}`;
      return `
      <div class="card" style="padding:12px">
        <div class="row">
          <span class="grow"><b>${esc(p.name)}</b> ${p.city ? `<span class="small muted">· ${esc(p.city)}</span>` : ''}
            ${p.banned ? ' <span class="small" style="color:var(--red)">⛔ removed</span>' : ''}<br>
            <span class="small muted">@${esc(p.username)}</span><br>
            <span class="small muted">🔗 </span><span class="small" style="word-break:break-all">${esc(url)}</span><br>
            <span class="small" style="color:var(--green)">${p.model_count} model${p.model_count === 1 ? '' : 's'} · earned ${fmt(p.total_earned_cents)}</span>
            <span class="small muted"> · your cut ${fmt(p.corrys_cut_cents)} · owes ${fmt(p.pending_cents)}</span></span>
        </div>
        <div class="row" style="margin-top:8px;gap:6px;flex-wrap:wrap">
          <button class="btn small" data-pt-copy="${p.referral_code}">📋 Copy link</button>
          ${!p.banned ? `<button class="btn small danger" data-pt-del="${p.id}" data-pt-name="${esc(p.name)}">Remove</button>` : ''}
        </div>
      </div>`;
    }).join('') || '<div class="empty">No partners yet.</div>'}`;
}

async function adminTaxBody() {
  const { status, data } = await api('/admin/tax');
  if (status !== 200) return '<div class="muted">Could not load tax dashboard.</div>';
  const earners = data.earners || [];
  const missing = earners.filter((e) => e.missing_tax);
  const need1099 = earners.filter((e) => e.needs_1099);
  return `
    <h3 style="margin:4px 0 10px">🧾 Tax — W-9 / 1099 (${data.year})</h3>
    <div class="muted small" style="margin-bottom:10px">
      IRS rule: anyone paid <b>$600+</b> in the year needs a 1099-NEC. Filing itself happens with your accountant — this page tracks who's on file and exports the data they need.
      ${data.key_ephemeral ? '<br><span style="color:var(--red)">⚠️ TAX_ENC_KEY is not set — tax IDs are encrypted with a temporary key and will be unreadable after a server restart. Set the env var.</span>' : ''}
    </div>
    <div class="stat-grid" style="margin-bottom:12px">
      <div class="stat"><div class="n">${earners.length}</div><div class="l">Earners (models + partners)</div></div>
      <div class="stat"><div class="n">${earners.filter((e) => e.has_tax).length}</div><div class="l">W-9 on file</div></div>
      <div class="stat"><div class="n" style="color:${need1099.length ? 'var(--pink)' : 'inherit'}">${need1099.length}</div><div class="l">$600+ paid (need 1099)</div></div>
      <div class="stat"><div class="n" style="color:${missing.length ? 'var(--red)' : 'inherit'}">${missing.length}</div><div class="l">⚠️ $600+ but NO tax info</div></div>
    </div>
    ${missing.length ? `
    <div class="card" style="border-color:rgba(248,113,113,.5);padding:12px;margin-bottom:12px">
      <div style="font-weight:800;color:var(--red);margin-bottom:6px">⚠️ Action needed — paid $600+ with no W-9 on file</div>
      ${missing.map((e) => `<div class="small" style="padding:4px 0"><b>${esc(e.earner_name)}</b> <span class="muted">@${esc(e.username)} · ${e.role}</span> — paid <b style="color:var(--red)">${fmt(e.paid_this_year_cents)}</b> this year</div>`).join('')}
      <div class="muted small" style="margin-top:6px">They can't request more withdrawals until they add tax info. Tell them to fill it in under Settings → Tax Info.</div>
    </div>` : ''}
    <button class="btn" id="tax-export" style="margin-bottom:12px">📥 Export 1099 CSV for accountant</button>
    <div class="muted small" style="margin-bottom:10px">CSV has legal names, addresses, and totals — <b>no tax IDs</b> (those stay encrypted).</div>
    ${earners.map((e) => `
      <div class="card" style="padding:10px 12px;${e.missing_tax ? 'border-color:rgba(248,113,113,.5)' : ''}">
        <div class="row" style="align-items:center">
          <span class="grow">
            <b>${esc(e.earner_name)}</b> <span class="small muted">@${esc(e.username)} · ${e.role === 'recruiter' ? `🤝 partner${e.recruiter_city ? ' · ' + esc(e.recruiter_city) : ''}` : '💃 model'}</span>
            ${e.banned ? ' <span class="small" style="color:var(--red)">deactivated</span>' : ''}<br>
            <span class="small">Paid ${data.year}: <b style="color:${e.needs_1099 ? 'var(--pink)' : 'inherit'}">${fmt(e.paid_this_year_cents)}</b></span>
            ${e.needs_1099 ? ' <span class="small" style="color:var(--pink)">· needs 1099</span>' : ''}
          </span>
          ${e.has_tax
            ? `<span class="small" style="color:var(--green)">✓ W-9 on file<br><span class="muted">${e.tax_id_type === 'ein' ? 'EIN' : 'SSN'} ${esc(e.tax_id_masked)}${e.tax_city ? ` · ${esc(e.tax_city)}, ${esc(e.tax_state)}` : ''}</span></span>`
            : `<span class="small" style="color:${e.missing_tax ? 'var(--red)' : 'var(--pink)'}">${e.missing_tax ? '⚠️ NO TAX INFO' : 'No tax info yet'}</span>`}
        </div>
      </div>`).join('') || '<div class="empty">No earners yet.</div>'}`;
}

async function adminMoreBody(s) {
  const { data: tfa } = await api('/admin/2fa').catch(() => ({ data: {} }));
  const tfaOn = !!(tfa && tfa.on);
  return `
    <div class="card">
      <div style="font-weight:800;margin-bottom:6px">🔐 Two-Step Auth</div>
      <div class="muted small">Admin sign-in needs a code texted to your phone. Secret entrance: <b>#boss</b> (not linked anywhere).</div>
      <div class="row" style="margin-top:8px;align-items:center;gap:8px">
        <span class="small" style="font-weight:800;color:${tfaOn ? 'var(--green)' : 'var(--muted)'}">${tfaOn ? '✅ ON' : '⛔ OFF'}</span>
        ${tfa && tfa.phone_masked ? `<span class="small muted">📱 ${esc(tfa.phone_masked)}</span>` : ''}
      </div>
      <div id="tfa-body" style="margin-top:8px"></div>
      <div class="row" style="margin-top:8px;gap:8px;flex-wrap:wrap">
        <button class="btn small" id="tfa-change">${tfaOn ? 'Change number' : 'Set up'}</button>
        ${tfaOn ? '<button class="btn small ghost" id="tfa-off">Turn off</button>' : ''}
      </div>
    </div>
    <div class="card">
      <div style="font-weight:800;margin-bottom:6px">Platform commission</div>
      <div class="muted small">Base split on fan charges — your cut before any partner share (partners take half of your cut on their models). The real blended rate varies by type; the Overview shows it from the ledger.</div>
      <div class="row" style="margin-top:8px">
        <input class="input" id="set-comm" type="number" min="0" max="90" value="${s.commission_pct}" style="margin-top:0;max-width:100px">
        <span><b>%</b></span>
        <button class="btn small" id="set-comm-go">Save</button>
      </div>
    </div>
    <div class="card">
      <div style="font-weight:800;margin-bottom:6px">🎁 Gift grace period (explicit streams)</div>
      <div class="muted small">When she's explicit, ANY gift keeps a fan's view clear for this long. No gift in time → blurry again.</div>
      <div class="row" style="margin-top:8px">
        <input class="input" id="set-grace" type="number" min="1" max="60" value="${Math.round((s.explicit_gift_grace_sec || 180) / 60)}" style="margin-top:0;max-width:100px">
        <span><b>minutes</b></span>
        <button class="btn small" id="set-grace-go">Save</button>
      </div>
    </div>
    <div class="card">
      <div style="font-weight:800;margin-bottom:6px">🔞 Explicit entry fee</div>
      <div class="muted small">One-time charge per fan to unblur when she goes explicit. After entry, gifts keep them clear.</div>
      <div class="row" style="margin-top:8px">
        <span><b>$</b></span>
        <input class="input" id="set-entry" type="number" min="1" max="100" step="0.50" value="${((s.explicit_entry_cents || 499) / 100).toFixed(2)}" style="margin-top:0;max-width:100px">
        <button class="btn small" id="set-entry-go">Save</button>
      </div>
    </div>
    <div class="card">
      <div style="font-weight:800;margin-bottom:6px">Default pricing for new models</div>
      <div class="muted small">Text: $1.49 · Video: $3.99/min (models can adjust their own)</div>
    </div>
    <div class="card">
      <div style="font-weight:800;margin-bottom:6px">Before launch</div>
      <div class="small muted">• Connect CCBill/Segpay (see PAYMENT-PROCESSOR-GUIDE.md)<br>
        • Fan ID verification via Jumio/Veriff (see AGE-VERIFICATION-GUIDE.md)<br>
        • 2257 records for every model<br>
        • Terms, Privacy & Refund pages on the site</div>
    </div>
    <button class="btn ghost" id="a-logout">Log out</button>`;
}

async function adminRefundsBody() {
  const { data } = await api('/admin/refunds');
  const refunds = data.refunds || [];
  return `
    <div class="card">
      <div style="font-weight:800;margin-bottom:6px">💳 Issue refund</div>
      <div class="muted small" style="margin-bottom:8px">Fan gets credits back. Add the model to claw back her cut too (split reversed).</div>
      <label class="field">Fan user ID<input class="input" id="rf-user" type="number" min="1" placeholder="Fan's user ID"></label>
      <label class="field">Amount $<input class="input" id="rf-amount" type="number" step="0.01" min="0.01" placeholder="25.00"></label>
      <label class="field">Model user ID (optional — for clawback)<input class="input" id="rf-model" type="number" min="1" placeholder="Blank = credits only"></label>
      <label class="field">Reason (required)<input class="input" id="rf-reason" maxlength="300" placeholder="e.g. duplicate charge, fan complaint"></label>
      <button class="btn" id="rf-go">Issue refund</button>
    </div>
    <div class="card">
      <div style="font-weight:800;margin-bottom:8px">Refund history</div>
      ${refunds.length ? refunds.map((r) => `
        <div class="row" style="padding:8px 0;border-bottom:1px solid var(--line)">
          <span class="grow"><b>${esc(r.fan_name || r.fan_username || ('#' + r.user_id))}</b>
            <span class="small" style="color:var(--red)">−${fmt(r.amount_cents)}</span><br>
            <span class="small muted">${esc(r.reason || '')}${r.model_name ? ` · clawed back from ${esc(r.model_name)}` : ' · credits only'}</span><br>
            <span class="small muted">${esc(r.created_at || '')}</span></span>
        </div>`).join('') : '<div class="muted small">No refunds issued.</div>'}
    </div>`;
}

async function adminDisputesBody() {
  const { data } = await api('/admin/disputes');
  const { data: attData } = await api('/admin/purchase-attempts');
  const disputes = data.disputes || [];
  const attempts = (attData.attempts || []).slice(0, 50);
  const badge = (s) => s === 'open'
    ? '<span class="small" style="color:var(--red)">🔴 open</span>'
    : s === 'won' ? '<span class="small" style="color:var(--green)">✅ won</span>'
    : '<span class="small muted">❌ lost</span>';
  return `
    <div class="card">
      <div style="font-weight:800;margin-bottom:6px">⚠️ File dispute (chargeback)</div>
      <div class="muted small" style="margin-bottom:8px">If this fan already got a refund for the same purchase, their account freezes automatically.</div>
      <label class="field">Fan user ID<input class="input" id="dp-user" type="number" min="1"></label>
      <label class="field">Amount $<input class="input" id="dp-amount" type="number" step="0.01" min="0.01"></label>
      <label class="field">Processor reference<input class="input" id="dp-ref" maxlength="120" placeholder="Chargeback ID from processor"></label>
      <label class="field">Purchase attempt ID (optional)<input class="input" id="dp-purchase" type="number" min="1"></label>
      <label class="field">Reason<input class="input" id="dp-reason" maxlength="300"></label>
      <button class="btn" id="dp-go">File dispute</button>
    </div>
    <div class="card">
      <div style="font-weight:800;margin-bottom:8px">Disputes</div>
      ${disputes.length ? disputes.map((d) => `
        <div class="row" style="padding:8px 0;border-bottom:1px solid var(--line);flex-wrap:wrap;align-items:center">
          <span class="grow"><b>${esc(d.fan_name || d.fan_username || ('#' + d.user_id))}</b>
            ${d.account_status === 'frozen' ? ' <span class="small" style="color:var(--red)">🧊 FROZEN</span>' : ''}
            ${badge(d.status)}<br>
            <span class="small" style="color:var(--red)">${fmt(d.amount_cents)}</span>
            <span class="small muted"> · ${esc(d.transaction_ref || 'no ref')} · ${esc(d.reason || '')}</span><br>
            <span class="small muted">${esc(d.created_at || '')}</span></span>
          <span style="display:flex;gap:6px;margin-top:6px">
            ${d.status === 'open' ? `
              <button class="btn small success" data-dp-win="${d.id}">Won</button>
              <button class="btn small danger" data-dp-lose="${d.id}">Lost</button>` : ''}
            ${d.account_status !== 'frozen'
              ? `<button class="btn small danger" data-dp-freeze="${d.user_id}">Freeze</button>`
              : `<button class="btn small" data-dp-unfreeze="${d.user_id}">Unfreeze</button>`}
          </span>
        </div>`).join('') : '<div class="muted small">No disputes filed.</div>'}
    </div>
    <div class="card">
      <div style="font-weight:800;margin-bottom:8px">🕵️ Recent purchase attempts</div>
      ${attempts.length ? attempts.map((a) => `
        <div class="row" style="padding:6px 0;border-bottom:1px solid var(--line)">
          <span class="grow small"><b>${esc(a.fan_name || a.fan_username || ('#' + a.user_id))}</b>
            · ${fmt(a.amount_cents)} · <span class="muted">${esc(a.status)}</span>
            ${a.status === 'blocked' ? ' <span style="color:var(--red)">⛔</span>' : ''}<br>
            <span class="muted">${esc(a.ip || 'no ip')} · ${esc(a.created_at || '')}${a.note ? ' · ' + esc(a.note) : ''}</span></span>
        </div>`).join('') : '<div class="muted small">No attempts yet.</div>'}
    </div>`;
}

async function adminAnalyticsBody() {
  const { data: a } = await api('/admin/analytics?days=30');
  const maxDay = Math.max(1, ...a.byDay.map((d) => d.visits));
  const bar = (d) => {
    const h = Math.max(4, Math.round((d.visits / maxDay) * 80));
    return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px" title="${d.d}: ${d.visits} visits">
      <div style="width:100%;max-width:22px;height:${h}px;background:linear-gradient(180deg,var(--purple),var(--pink));border-radius:4px 4px 0 0"></div>
      <div class="small muted" style="font-size:9px">${d.d.slice(5)}</div></div>`;
  };
  const rows = (list, label) => (list || []).map((r) =>
    `<div class="row" style="padding:8px 0;border-bottom:1px solid rgba(139,92,246,.12)">
      <span class="grow small" style="word-break:break-all">${esc(r.ref || r.c || r.path || '')}</span>
      <b>${r.n}</b></div>`).join('') || `<div class="muted small">No ${label} yet.</div>`;
  return `
    <div class="stat-grid" style="margin-bottom:14px">
      <div class="stat"><div class="n">${a.total}</div><div class="l">Visits (30d)</div></div>
      <div class="stat"><div class="n">${a.unique}</div><div class="l">Unique visitors</div></div>
    </div>
    <h3 style="margin:4px 0 10px">📊 Daily visits</h3>
    <div class="card" style="padding:14px"><div style="display:flex;align-items:flex-end;gap:4px;min-height:110px">
      ${a.byDay.length ? a.byDay.map(bar).join('') : '<div class="muted">No visits yet — data starts collecting now.</div>'}
    </div></div>
    <h3 style="margin:14px 0 6px">🔗 Where they come from</h3>
    <div class="card" style="padding:6px 14px">${rows(a.referrers, 'referrers')}</div>
    <h3 style="margin:14px 0 6px">🌍 Countries</h3>
    <div class="card" style="padding:6px 14px">${rows(a.countries, 'countries')}</div>
    <h3 style="margin:14px 0 6px">📄 Top pages</h3>
    <div class="card" style="padding:6px 14px">${rows(a.pages, 'pages')}</div>`;
}

async function adminDmcaBody() {
  const { data } = await api('/admin/dmca');
  const notices = data.notices || [];
  const statusLabel = { received: '📥 Received', under_review: '👀 Under review', actioned: '✅ Actioned', rejected: '⛔ Rejected' };
  return `
    <div class="card">
      <div style="font-weight:800;margin-bottom:6px">⚖️ Takedown notices</div>
      <div class="muted small">${notices.filter((n) => n.status === 'received' || n.status === 'under_review').length} open · ${notices.length} total</div>
    </div>
    ${notices.map((n) => `
      <div class="card" style="padding:12px">
        <div class="row" style="align-items:center">
          <span class="grow"><b>${esc(n.reporter_name)}</b> <span class="small muted">&lt;${esc(n.reporter_email)}&gt;</span><br>
          <span class="small muted">Filed ${esc(n.created_at)}${n.resolved_at ? ` · resolved ${esc(n.resolved_at)}` : ''}</span></span>
          <span class="small" style="font-weight:800">${statusLabel[n.status] || n.status}</span>
        </div>
        <div class="small" style="margin-top:8px"><b>Work:</b> ${esc(n.work_description)}</div>
        <div class="small" style="margin-top:6px;word-break:break-all"><b>URLs:</b><br>${esc(n.urls).replace(/\n/g, '<br>')}</div>
        <div class="small muted" style="margin-top:6px"><b>Signature:</b> ${esc(n.signature)} · ✅ good-faith statement confirmed</div>
        <div class="row" style="margin-top:10px;gap:6px;flex-wrap:wrap">
          <label class="field" style="flex:1;min-width:140px;margin:0">Status
            <select class="input" id="dmca-status-${n.id}">
              ${['received','under_review','actioned','rejected'].map((s) => `<option value="${s}"${n.status === s ? ' selected' : ''}>${statusLabel[s]}</option>`).join('')}
            </select>
          </label>
        </div>
        <label class="field">Admin note<textarea class="input" id="dmca-note-${n.id}" rows="2" maxlength="2000" placeholder="What you did / decided…">${esc(n.admin_note)}</textarea></label>
        <button class="btn small" data-dmca-save="${n.id}">💾 Save status</button>
      </div>`).join('') || '<div class="empty"><div class="big">⚖️</div>No takedown notices.</div>'}`;
}

async function refreshPresenceCard() {
  if (!document.getElementById('presence-card')) return;
  const { data } = await api('/mod/presence');
  if (!data || !data.now) return;
  const totalEl = document.getElementById('presence-total');
  if (!totalEl) return; // view changed mid-flight
  totalEl.textContent = `🟢 ${data.now.total} on the app now`;
  document.getElementById('presence-split').textContent =
    `${data.now.guests} guests · ${data.now.fans} fans · ${data.now.models} models`;
  document.getElementById('presence-peak').textContent = data.peakToday;
  const strip = document.getElementById('presence-strip');
  const samples = data.samples || [];
  if (!samples.length) {
    strip.innerHTML = '<div class="muted small">Collecting data — bars appear as the minutes pass.</div>';
    return;
  }
  const buckets = presenceBuckets(samples, 48);
  const max = Math.max(1, ...buckets);
  strip.innerHTML = buckets.map((total) => {
    const h = Math.max(2, Math.round((total / max) * 44));
    return `<div style="flex:1 1 0;min-width:0;height:${h}px;background:linear-gradient(180deg,var(--purple),var(--pink));border-radius:2px 2px 0 0" title="${total} on the app"></div>`;
  }).join('');
}

function presenceBuckets(samples, n) {
  const sorted = [...samples].sort((a, b) => a.ts - b.ts);
  const buckets = new Array(n).fill(0);
  if (!sorted.length) return buckets;
  const minTs = sorted[0].ts;
  const span = Math.max(1, sorted[sorted.length - 1].ts - minTs);
  for (const sm of sorted) {
    const idx = Math.min(n - 1, Math.floor(((sm.ts - minTs) / span) * n));
    if (sm.total > buckets[idx]) buckets[idx] = sm.total;
  }
  return buckets;
}

function wireAdminBody(tab) {
  const go = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
  go('#go-safety', () => M.go('safety'));
  go('#a-logout', () => M.logout());

  // 🧾 Tax — CSV export for the accountant (download via fetch → blob)
  go('#tax-export', async () => {
    toast('Preparing CSV…');
    try {
      const headers = {};
      if (M.token) headers['Authorization'] = 'Bearer ' + M.token;
      const r = await fetch('/api/admin/tax/export', { headers });
      if (!r.ok) throw new Error('bad');
      const blob = await r.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `slutcamp-1099-export-${new Date().getFullYear()}.csv`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
      toast('📥 CSV downloaded');
    } catch (e) { toast('Could not export CSV'); }
  });

  // 🔐 Two-Step Auth card
  go('#tfa-change', () => {
    const box = $('#tfa-body');
    if (!box) return;
    box.innerHTML = `
      <label class="field">Confirm password${pwField('tfa-pass', 'current-password')}</label>
      <label class="field">New phone number<input class="input" id="tfa-phone" type="tel" placeholder="+1 555 123 4567"></label>
      <button class="btn small" id="tfa-send">Send verification code</button>
      <div id="tfa-verify" style="margin-top:8px"></div>`;
    $('#tfa-send').onclick = async () => {
      const password = $('#tfa-pass').value, phone = $('#tfa-phone').value.trim();
      if (!password || !phone) return toast('Enter password + phone number');
      const { status, data } = await api('/admin/2fa/change-phone', {
        method: 'POST', body: JSON.stringify({ password, phone }),
      });
      if (status === 200 && data.sent) {
        $('#tfa-verify').innerHTML = `
          <div class="muted small" style="margin:6px 0">Code sent to ${esc(data.masked)} — expires in 5 min.</div>
          <div class="row" style="gap:8px">
            <input class="input" id="tfa-code" inputmode="numeric" maxlength="6" placeholder="123456" style="max-width:140px">
            <button class="btn small" id="tfa-confirm">Verify</button>
          </div>`;
        $('#tfa-confirm').onclick = async () => {
          const code = $('#tfa-code').value.trim();
          const r2 = await api('/admin/2fa/verify-phone-change', {
            method: 'POST', body: JSON.stringify({ code }),
          });
          if (r2.status === 200) { toast('✅ Number updated — 2FA stays on'); return M.reload(); }
          toast(r2.data.error === 'code_expired' ? 'Code expired — try again.' : 'Wrong code — try again.');
        };
        return;
      }
      if (data.error === 'bad_phone') return toast('That phone number looks wrong 📱');
      if (data.error === 'sms_not_configured') return toast('SMS is not set up yet — add Twilio keys on the server ⚠️');
      toast('Wrong password.');
    };
  });
  go('#tfa-off', async () => {
    if (!confirm('Turn OFF two-step auth? Admin login will only need a password.')) return;
    const password = prompt('Enter your admin password to confirm:');
    if (!password) return;
    const { status, data } = await api('/admin/2fa/disable', {
      method: 'POST', body: JSON.stringify({ password }),
    });
    if (status === 200) { toast('⛔ Two-step auth is OFF'); return M.reload(); }
    toast('Wrong password.');
  });

  document.querySelectorAll('[data-viewchat]').forEach((b) => {
    b.onclick = () => M.openPeek(parseInt(b.dataset.viewchat));
  });
  document.querySelectorAll('[data-pause]').forEach((b) => {
    b.onclick = async () => { await api(`/admin/conversations/${b.dataset.pause}/pause`, { method: 'POST' }); M.reload(); };
  });
  document.querySelectorAll('[data-resume]').forEach((b) => {
    b.onclick = async () => { await api(`/admin/conversations/${b.dataset.resume}/resume`, { method: 'POST' }); M.reload(); };
  });
  document.querySelectorAll('[data-live-end]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('End this live stream?')) return;
      await api(`/live/${b.dataset.liveEnd}/end`, { method: 'POST' });
      toast('Stream ended.');
      M.reload();
    };
  });
  document.querySelectorAll('[data-live-watch]').forEach((b) => {
    b.onclick = () => M.watchLive(b.dataset.liveWatch);
  });

  // Gift catalog management
  document.querySelectorAll('[data-gift-toggle]').forEach((b) => {
    b.onclick = async () => {
      const id = b.dataset.giftToggle;
      const cur = b.textContent.includes('⏸️');
      await api(`/admin/gifts/${id}`, {
        method: 'PUT', body: JSON.stringify({ enabled: cur ? 0 : 1 }) });
      M.reload();
    };
  });
  document.querySelectorAll('[data-gift-del]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Delete this gift from the catalog?')) return;
      await api(`/admin/gifts/${b.dataset.giftDel}`, { method: 'DELETE' });
      M.reload();
    };
  });
  document.querySelectorAll('[data-gift-edit]').forEach((b) => {
    b.onclick = () => {
      const id = b.dataset.giftEdit;
      const box = $('#gedit-' + id);
      box.innerHTML = `
        <div class="row" style="margin:6px 0;gap:6px;flex-wrap:wrap">
          <input class="input" id="ge-price-${id}" placeholder="New price $" inputmode="decimal" style="max-width:120px">
          <button class="btn small" id="ge-save-${id}">Save</button>
        </div>`;
      $('#ge-save-' + id).onclick = async () => {
        const dollars = parseFloat($('#ge-price-' + id).value);
        if (!dollars || dollars <= 0) return toast('Enter a valid price.');
        await api(`/admin/gifts/${id}`, {
          method: 'PUT', body: JSON.stringify({ price_cents: Math.round(dollars * 100) }) });
        toast('✅ Price updated'); M.reload();
      };
    };
  });
  go('#gift-add', async () => {
    const emoji = $('#ng-emoji').value.trim();
    const name = $('#ng-name').value.trim();
    const dollars = parseFloat($('#ng-price').value);
    if (!emoji || !name || !dollars || dollars <= 0) return toast('Fill in emoji, name, and price.');
    const { status } = await api('/admin/gifts', {
      method: 'POST', body: JSON.stringify({ emoji, name, price_cents: Math.round(dollars * 100) }) });
    toast(status === 200 ? '✅ Gift added' : 'Could not add gift.');
    M.reload();
  });

  // Safety
  document.querySelectorAll('[data-inc-resume]').forEach((b) => {
    b.onclick = async () => {
      await api(`/admin/safety/incidents/${b.dataset.incResume}/resolve`, {
        method: 'POST', body: JSON.stringify({ action: 'resume' }) });
      toast('✅ Chat resumed'); M.reload();
    };
  });
  document.querySelectorAll('[data-inc-dismiss]').forEach((b) => {
    b.onclick = async () => {
      await api(`/admin/safety/incidents/${b.dataset.incDismiss}/resolve`, {
        method: 'POST', body: JSON.stringify({ action: 'dismiss' }) });
      M.reload();
    };
  });
  document.querySelectorAll('[data-kw-toggle]').forEach((b) => {
    b.onclick = async () => {
      const on = b.classList.contains('on');
      await api(`/admin/safety/keywords/${b.dataset.kwToggle}`, {
        method: 'PUT', body: JSON.stringify({ enabled: !on }) });
      M.reload();
    };
  });
  document.querySelectorAll('[data-kw-del]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Delete this keyword?')) return;
      await api(`/admin/safety/keywords/${b.dataset.kwDel}`, { method: 'DELETE' });
      M.reload();
    };
  });
  go('#kw-add', async () => {
    const kw = $('#kw-new').value.trim();
    if (!kw) return;
    const { status } = await api('/admin/safety/keywords', {
      method: 'POST', body: JSON.stringify({ keyword: kw }) });
    toast(status === 200 ? '✅ Keyword added' : 'Already exists');
    M.reload();
  });

  // Invite links
  go('#inv-gen', async () => {
    const label = $('#inv-label').value.trim();
    const { status, data } = await api('/admin/invites', {
      method: 'POST', body: JSON.stringify({ label, base_url: window.location.origin }) });
    if (status === 200) {
      const url = `${window.location.origin}/?invite=${data.code}`;
      try { await navigator.clipboard.writeText(url); toast('✅ Invite link copied! Send it to her.'); }
      catch { toast('✅ Invite created — copy it from the list below.'); }
    } else toast('Could not create invite.');
    M.reload();
  });
  go('#aff-gen', async () => {
    const label = $('#aff-label').value.trim();
    const { status, data } = await api('/admin/invites', {
      method: 'POST', body: JSON.stringify({ label, role: 'recruiter', base_url: window.location.origin }) });
    if (status === 200) {
      const url = `${window.location.origin}/#affiliate/${data.code}`;
      try { await navigator.clipboard.writeText(url); toast('✅ Affiliate invite copied! Send it to them.'); }
      catch { toast('✅ Affiliate invite created — copy it from the list below.'); }
    } else toast('Could not create invite.');
    M.reload();
  });
  document.querySelectorAll('[data-inv-copy]').forEach((b) => {
    b.onclick = async () => {
      const isAff = b.dataset.aff === '1';
      const url = isAff ? `${window.location.origin}/#affiliate/${b.dataset.invCopy}`
                        : `${window.location.origin}/?invite=${b.dataset.invCopy}`;
      try { await navigator.clipboard.writeText(url); toast('📋 Link copied!'); }
      catch { prompt('Copy this link:', url); }
    };
  });
  document.querySelectorAll('[data-inv-revoke]').forEach((b) => {
    b.onclick = async () => {
      const used = b.dataset.used === '1';
      let deactivate = false;
      if (used) {
        deactivate = confirm('This invite was already used.\n\nOK = revoke link AND deactivate the model account\nCancel = revoke link only (model keeps access)');
      } else if (!confirm('Revoke this invite link? She won\'t be able to sign up with it.')) {
        return;
      }
      await api(`/admin/invites/${b.dataset.invRevoke}/revoke`, {
        method: 'POST', body: JSON.stringify({ deactivate_model: deactivate }) });
      toast('⛔ Invite revoked' + (deactivate ? ' + model deactivated' : ''));
      M.reload();
    };
  });

  document.querySelectorAll('[data-inv-refresh]').forEach((b) => {
    b.onclick = async () => {
      const { status } = await api(`/admin/invites/${b.dataset.invRefresh}/refresh`, {
        method: 'POST', body: JSON.stringify({}) });
      toast(status === 200 ? '🔄 Link refreshed — same link, good for 6 more hours.' : 'Could not refresh that link.');
      M.reload();
    };
  });
  document.querySelectorAll('[data-inv-del]').forEach((b) => {
    b.onclick = async () => {
      const used = b.dataset.used === '1';
      const msg = used
        ? 'Delete this used invite from your list?\n\nShe keeps her account — this only removes the link from your list.'
        : 'Delete this invite link?\n\nIt stops working right away and disappears from your list. This can\'t be undone.';
      if (!confirm(msg)) return;
      const { status } = await api(`/admin/invites/${b.dataset.invDel}`, { method: 'DELETE' });
      toast(status === 200 ? '🗑 Invite deleted' : 'Could not delete that invite.');
      M.reload();
    };
  });
  const invCleanup = $('#inv-cleanup');
  if (invCleanup) invCleanup.onclick = async () => {
    const n = Number(invCleanup.dataset.count || 0);
    if (!n) { toast('Nothing to clean up 🧹'); return; }
    if (!confirm(`Delete ${n} links? Every unused or expired link goes; live links nobody used yet will stop working.`)) return;
    const { status, data } = await api('/admin/invites/cleanup', {
      method: 'POST', body: JSON.stringify({}) });
    toast(status === 200 ? `Cleared ${data.deleted} links 🧹` : 'Cleanup failed.');
    M.reload();
  };

  // Partners
  const ptAdd = $('#pt-add');
  if (ptAdd) ptAdd.onclick = async () => {
    ptAdd.disabled = true;
    const body = { name: $('#pt-name').value.trim(), city: $('#pt-city').value.trim(),
      username: $('#pt-user').value.trim(), password: $('#pt-pass').value };
    const { status, data } = await api('/admin/recruiters', {
      method: 'POST', body: JSON.stringify({ ...body, base_url: window.location.origin }) });
    if (status === 200) {
      $('#pt-result').innerHTML = `
        <div class="card" style="border-color:var(--green);margin-top:8px">
          <div style="font-weight:800;color:var(--green)">✅ Partner created</div>
          <div class="small" style="margin-top:6px">Login: <b>${esc(data.username)}</b> / <b>${esc(data.password)}</b></div>
          <div class="small" style="margin-top:4px;word-break:break-all">Link: ${esc(data.url)}</div>
          <div class="muted small" style="margin-top:4px">Save that password — it won't be shown again.</div>
        </div>`;
      toast('✅ Partner created');
    } else {
      toast(data.error === 'username_taken' ? 'Username is taken 😕' : 'Fill in the name');
      ptAdd.disabled = false;
    }
  };
  document.querySelectorAll('[data-pt-copy]').forEach((b) => {
    b.onclick = async () => {
      const url = `${window.location.origin}/#join/${b.dataset.ptCopy}`;
      try { await navigator.clipboard.writeText(url); toast('📋 Link copied!'); }
      catch { prompt('Copy this link:', url); }
    };
  });
  document.querySelectorAll('[data-pt-del]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm(`Remove partner ${b.dataset.ptName}?\n\nTheir models stay on the app — their 20% cut reverts to you. The partner's login stops working.`)) return;
      await api(`/admin/recruiters/${b.dataset.ptDel}`, { method: 'DELETE' });
      toast('Partner removed');
      M.reload();
    };
  });

  // Models
  document.querySelectorAll('[data-m-edit]').forEach((b) => {
    b.onclick = async () => {
      const id = b.dataset.mEdit;
      const box = $('#edit-' + id);
      const { data } = await api('/admin/models');
      const m = (data.models || []).find((x) => x.id === parseInt(id));
      const bio = (m && m.bio) || '';
      box.innerHTML = `
        <div class="row" style="margin-top:8px">
          <input class="input" id="em-${id}" type="number" step="0.01" placeholder="$/msg" style="margin-top:0" value="${m ? (m.per_message_cents / 100).toFixed(2) : ''}">
          <input class="input" id="ev-${id}" type="number" step="0.01" placeholder="$/min" style="margin-top:0" value="${m ? (m.per_minute_cents / 100).toFixed(2) : ''}">
          <button class="btn small" id="es-${id}">Save</button>
        </div>
        <label class="field" style="margin-top:8px">Bio<textarea class="input" id="eb-${id}" rows="3" maxlength="280" placeholder="Her bio — fans see it on her card">${esc(bio)}</textarea></label>
        <div class="small muted" style="text-align:right"><span id="ebc-${id}">${bio.length}</span>/280</div>`;
      const bioBox = $('#eb-' + id);
      bioBox.oninput = () => { $('#ebc-' + id).textContent = bioBox.value.length; };
      $('#es-' + id).onclick = async () => {
        const per_message_cents = Math.round(parseFloat($('#em-' + id).value || '0') * 100);
        const per_minute_cents = Math.round(parseFloat($('#ev-' + id).value || '0') * 100);
        const payload = { per_message_cents, per_minute_cents };
        const bioEl = $('#eb-' + id);
        if (bioEl) payload.bio = bioEl.value;
        await api(`/admin/models/${id}`, { method: 'PUT',
          body: JSON.stringify(payload) });
        toast('✅ Saved'); M.reload();
      };
    };
  });
  document.querySelectorAll('[data-m-toggle]').forEach((b) => {
    b.onclick = async () => {
      const id = b.dataset.mToggle;
      const { data } = await api('/admin/models');
      const m = (data.models || []).find((x) => x.id === parseInt(id));
      await api(`/admin/models/${id}`, { method: 'PUT',
        body: JSON.stringify({ banned: m.banned ? 0 : 1 }) });
      M.reload();
    };
  });
  document.querySelectorAll('[data-m-pres]').forEach((b) => {
    b.onclick = async () => {
      const id = b.dataset.mPres;
      const mode = b.dataset.mode;
      const { status, data } = await api(`/admin/models/${id}/presence`, {
        method: 'POST', body: JSON.stringify({ mode }) });
      if (status !== 200 || !data || data.error) {
        toast('⚠️ ' + ((data && data.message) || 'Could not update presence'));
        return;
      }
      // Update this row in place: status dot/word + which segment is active.
      const st = $('#pres-status-' + id);
      if (st) {
        st.style.color = data.online ? 'var(--green)' : 'var(--muted)';
        st.textContent = `${data.online ? '●' : '○'} ${data.online ? 'Online' : 'Offline'}${data.presence_override !== 'auto' ? ' (forced)' : ''}`;
      }
      document.querySelectorAll(`[data-m-pres="${id}"]`).forEach((x) => {
        x.classList.toggle('ghost', x.dataset.mode !== data.presence_override);
      });
      toast(data.presence_override === 'auto' ? '👁 Presence: Auto — her app decides'
        : data.presence_override === 'on' ? '👁 Fans now see her Online' : '👁 Fans now see her Offline');
    };
  });
  document.querySelectorAll('[data-m-del]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Remove this model permanently?')) return;
      await api(`/admin/models/${b.dataset.mDel}`, { method: 'DELETE' });
      M.reload();
    };
  });
  document.querySelectorAll('[data-m-photo]').forEach((b) => {
    b.onclick = () => {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = 'image/*';
      inp.style.display = 'none';
      document.body.appendChild(inp);
      inp.onchange = async () => {
        const file = inp.files[0];
        inp.remove();
        if (!file) return;
        openPhotoCropper(file, async (cropped) => {
          toast('Uploading photo…');
          const { status, data } = await apiUpload(`/admin/models/${b.dataset.mPhoto}/photo`, cropped);
          if (status === 200 && data.ok) { toast('📷 Photo updated!'); M.reload(); }
          else toast('Upload failed — use a JPG/PNG under 5MB.');
        });
      };
      inp.click();
    };
  });
  document.querySelectorAll('[data-m-msg]').forEach((b) => {
    b.onclick = async () => {
      const id = b.dataset.mMsg;
      const box = $('#edit-' + id);
      const renderThread = async () => {
        const { data } = await api(`/admin/models/${id}/thread`);
        const msgs = (data && data.messages) || [];
        box.innerHTML = `
          <div style="margin-top:10px">
            <div class="small muted" style="margin-bottom:6px">💬 Her inbox thread — she sees “Asce (Admin)”. Her replies land here too.</div>
            <div style="max-height:260px;overflow-y:auto;display:flex;flex-direction:column;gap:6px;margin-bottom:8px">
              ${msgs.length ? msgs.map((x) => `<div style="background:rgba(0,0,0,.25);border-radius:10px;padding:7px 9px">
                <b class="small">${esc(x.sender_name)}</b> <span class="small muted">${timeHM(x.created_at)}</span>
                <div style="white-space:pre-wrap;font-size:14px">${esc(x.body)}</div></div>`).join('') : '<div class="small muted">No messages yet — say the first word.</div>'}
            </div>
            <textarea class="input" id="mm-${id}" rows="2" placeholder="Text her as moderator…"></textarea>
            <div class="row" style="margin-top:6px;gap:6px">
              <button class="btn small" id="mm-send-${id}">Send to her inbox</button>
              <button class="btn small ghost" id="mm-refresh-${id}">↻ Refresh</button>
            </div>
          </div>`;
        $('#mm-send-' + id).onclick = async () => {
          const body = $('#mm-' + id).value.trim();
          if (!body) return;
          const { status } = await api(`/admin/models/${id}/message`, {
            method: 'POST', body: JSON.stringify({ body }) });
          if (status === 200) { toast('💬 Sent to her inbox'); renderThread(); }
          else toast('Could not send.');
        };
        $('#mm-refresh-' + id).onclick = renderThread;
      };
      renderThread();
    };
  });
  document.querySelectorAll('[data-m-hide]').forEach((b) => {
    b.onclick = async () => {
      const id = b.dataset.mHide;
      const { data } = await api('/admin/models');
      const m = (data.models || []).find((x) => x.id === parseInt(id));
      await api(`/admin/models/${id}`, { method: 'PUT',
        body: JSON.stringify({ is_hidden: m.is_hidden ? 0 : 1 }) });
      toast(m.is_hidden ? '👀 She\'s back on the main screen' : '👻 Hidden — she vanished from the main screen');
      M.reload();
    };
  });
  document.querySelectorAll('[data-m-pw]').forEach((b) => {
    b.onclick = async () => {
      const id = b.dataset.mPw;
      const box = $('#edit-' + id);
      const { data } = await api('/admin/models');
      const m = (data.models || []).find((x) => x.id === parseInt(id));
      const name = m ? (m.display_name || m.username) : 'her';
      box.innerHTML = `
        <div style="margin-top:10px">
          <div class="small muted" style="margin-bottom:6px">🔑 Reset ${esc(name)}'s password — she gets signed out everywhere and logs back in with the new one. Then send it to her (💬 Message works).</div>
          <div class="row" style="gap:6px;flex-wrap:wrap">
            <input class="input" id="mpw-${id}" type="text" autocomplete="off" placeholder="New password (min 6 characters)" style="margin-top:0;flex:1;min-width:180px">
            <button class="btn small" id="mpw-set-${id}">Set password</button>
            <button class="btn small ghost" id="mpw-gen-${id}">🎲 Generate one</button>
          </div>
          <div class="small" id="mpw-out-${id}" style="margin-top:6px"></div>
        </div>`;
      const out = $('#mpw-out-' + id);
      const submit = async (password) => {
        const { status, data: r } = await api(`/admin/models/${id}/reset-password`, {
          method: 'POST', body: JSON.stringify({ password }) });
        if (status === 200 && r && r.ok) {
          if (r.generated) {
            out.innerHTML = `✅ Done — her temporary password is <b style="user-select:all">${esc(r.password)}</b><br>Send it to her now; it's what she'll log in with.`;
          } else {
            out.innerHTML = '✅ Password updated — send her the new password so she can log in.';
          }
        } else if (status === 400) out.textContent = 'Too short — use at least 6 characters.';
        else out.textContent = 'Could not reset it — try again.';
      };
      $('#mpw-set-' + id).onclick = () => {
        const v = $('#mpw-' + id).value.trim();
        if (v.length < 6) { out.textContent = 'Too short — use at least 6 characters.'; return; }
        if (!confirm(`Set a new password for ${name}? She'll be signed out everywhere.`)) return;
        submit(v);
      };
      $('#mpw-gen-' + id).onclick = () => {
        if (!confirm(`Generate a new temporary password for ${name}? She'll be signed out everywhere.`)) return;
        submit('');
      };
    };
  });
  go('#nm-add', async () => {
    const display_name = $('#nm-name').value.trim();
    const username = $('#nm-user').value.trim();
    const password = $('#nm-pass').value;
    const bio = $('#nm-bio').value.trim();
    if (!display_name || !username || !password) return toast('Name, username + password required');
    const { status, data } = await api('/admin/models', {
      method: 'POST', body: JSON.stringify({ username, password, display_name, bio }) });
    toast(status === 200 ? '✅ Model added!' : (data.error === 'username_taken' ? 'Username taken' : 'Failed'));
    if (status === 200) M.reload();
  });

  // Crypto Treasury (in Payouts view)
  document.querySelectorAll('[data-markcred]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Credit this fan the full package value now? Use only if you verified the payment yourself.')) return;
      b.disabled = true;
      const { status, data } = await api(`/admin/crypto-invoices/${b.dataset.markcred}/mark-credited`, { method: 'POST' });
      toast(status === 200 ? '✅ Invoice credited' : data.error === 'already_credited' ? 'Already credited' : 'Could not credit');
      if (status === 200) M.reload(); else b.disabled = false;
    };
  });
  document.querySelectorAll('[data-sweep]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm(`Mark all unswept ${b.dataset.sweep} invoices as swept? Do this AFTER the funds reach the exchange.`)) return;
      b.disabled = true;
      const { status, data } = await api('/admin/crypto-invoices/actions/sweep', {
        method: 'POST', body: JSON.stringify({ coin: b.dataset.sweep }) });
      toast(status === 200 ? `✅ Swept ${data.swept} invoice(s)` : 'Sweep failed');
      if (status === 200) M.reload(); else b.disabled = false;
    };
  });
  document.querySelectorAll('[data-copy-val]').forEach((b) => {
    b.onclick = async () => {
      const v = b.dataset.copyVal || '';
      if (!v) return toast('Nothing saved yet');
      try { await navigator.clipboard.writeText(v); toast('📋 Copied'); } catch (e) { toast(v); }
    };
  });
  go('#cs-save', async () => {
    const { status } = await api('/admin/crypto-settings', {
      method: 'POST', body: JSON.stringify({
        sweep_btc_address: $('#cs-btc-addr').value,
        sweep_usdt_address: $('#cs-usdt-addr').value,
        sweep_eth_address: $('#cs-eth-addr').value,
        sweep_sol_address: $('#cs-sol-addr').value,
        sweep_xrp_address: $('#cs-xrp-addr').value,
        sweep_threshold_usd: parseInt($('#cs-threshold').value || '200', 10),
      }) });
    toast(status === 200 ? '✅ Treasury settings saved' : 'Save failed');
    if (status === 200) M.reload();
  });

  // Payouts
  document.querySelectorAll('[data-pay]').forEach((b) => {    b.onclick = async () => {
      const id = b.dataset.pay;
      const amount_cents = Math.round(parseFloat($('#pay-' + id).value || '0') * 100);
      if (!amount_cents) return toast('Enter an amount');
      const { status, data } = await api(`/admin/payouts/${id}`, {
        method: 'POST', body: JSON.stringify({ amount_cents }) });
      toast(status === 200 ? '✅ Marked as paid' : `Too much — pending is ${fmt(data.pending_cents || 0)}`);
      if (status === 200) M.reload();
    };
  });

  // Withdrawal requests
  document.querySelectorAll('[data-wd-pay]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      const { status } = await api(`/admin/withdrawals/${b.dataset.wdPay}/pay`, { method: 'POST' });
      toast(status === 200 ? '✅ Withdrawal marked as paid' : 'Could not mark paid');
      if (status === 200) M.reload(); else b.disabled = false;
    };
  });
  document.querySelectorAll('[data-wd-reject]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Reject this withdrawal? The funds stay available to her.')) return;
      b.disabled = true;
      const { status } = await api(`/admin/withdrawals/${b.dataset.wdReject}/reject`, { method: 'POST' });
      toast(status === 200 ? 'Withdrawal rejected' : 'Could not reject');
      if (status === 200) M.reload(); else b.disabled = false;
    };
  });

  // Fans
  document.querySelectorAll('[data-credit]').forEach((b) => {
    b.onclick = async () => {
      const id = b.dataset.credit;
      const amount_cents = Math.round(parseFloat($('#cr-' + id).value || '0') * 100);
      if (!amount_cents) return toast('Enter an amount');
      await api(`/admin/fans/${id}/credits`, { method: 'POST', body: JSON.stringify({ amount_cents }) });
      toast('✅ Credits added'); M.reload();
    };
  });
  document.querySelectorAll('[data-ban]').forEach((b) => {
    b.onclick = async () => {
      const id = b.dataset.ban;
      const { data } = await api('/admin/fans');
      const f = (data.fans || []).find((x) => x.id === parseInt(id));
      await api(`/admin/fans/${id}/${f.banned ? 'unban' : 'ban'}`, { method: 'POST' });
      M.reload();
    };
  });

  // Settings
  go('#set-comm-go', async () => {
    const commission_pct = parseInt($('#set-comm').value);
    const { status } = await api('/admin/settings', {
      method: 'PUT', body: JSON.stringify({ commission_pct }) });
    toast(status === 200 ? `✅ Commission set to ${commission_pct}%` : 'Use 0–90');
    if (status === 200) M.reload();
  });
  go('#set-grace-go', async () => {
    const mins = parseInt($('#set-grace').value);
    const explicit_gift_grace_sec = mins * 60;
    const { status } = await api('/admin/settings', {
      method: 'PUT', body: JSON.stringify({ explicit_gift_grace_sec }) });
    toast(status === 200 ? `✅ Gift grace set to ${mins} min` : 'Use 1–60 minutes');
    if (status === 200) M.reload();
  });
  go('#set-entry-go', async () => {
    const dollars = parseFloat($('#set-entry').value);
    const explicit_entry_cents = Math.round(dollars * 100);
    const { status } = await api('/admin/settings', {
      method: 'PUT', body: JSON.stringify({ explicit_entry_cents }) });
    toast(status === 200 ? `✅ Entry fee set to $${dollars.toFixed(2)}` : 'Use $1.00–$100.00');
    if (status === 200) M.reload();
  });

  // ⚖️ DMCA notices
  document.querySelectorAll('[data-dmca-save]').forEach((b) => {
    b.onclick = async () => {
      const id = b.dataset.dmcaSave;
      const status = $('#dmca-status-' + id).value;
      const admin_note = $('#dmca-note-' + id).value;
      b.disabled = true;
      const { status: http } = await api(`/admin/dmca/${id}/status`, {
        method: 'POST', body: JSON.stringify({ status, admin_note }) });
      toast(http === 200 ? '✅ Notice updated' : 'Something went wrong');
      if (http === 200) M.reload();
      else b.disabled = false;
    };
  });

  // 🪪 ID Checks — approve / reject with note
  if (tab === 'idchecks') {
    app.querySelectorAll('[data-idv-approve]').forEach((b) => b.onclick = async () => {
      const id = b.dataset.idvApprove;
      if (!confirm('Approve this ID verification?')) return;
      const { status } = await api(`/admin/id-verifications/${id}/approve`, { method: 'POST' });
      toast(status === 200 ? '✅ ID approved — she can now chat and go live.' : 'Could not approve.');
      if (status === 200) M.reload();
    });
    app.querySelectorAll('[data-idv-reject]').forEach((b) => b.onclick = async () => {
      const id = b.dataset.idvReject;
      const note = prompt('Rejection reason (shown to her so she knows what to fix):', 'Photo unclear — please retake');
      if (note === null) return; // cancelled
      const { status } = await api(`/admin/id-verifications/${id}/reject`, {
        method: 'POST', body: JSON.stringify({ note }) });
      toast(status === 200 ? 'ID rejected — she can resubmit.' : 'Could not reject.');
      if (status === 200) M.reload();
    });
    // 📄 2257 records packet — download via fetch → blob (needs auth header)
    app.querySelectorAll('[data-idv-2257]').forEach((b) => b.onclick = async () => {
      const id = b.dataset.idv2257;
      try {
        const headers = {};
        if (M.token) headers['Authorization'] = 'Bearer ' + M.token;
        const r = await fetch(`/api/admin/id-verifications/${id}/2257`, { headers });
        if (!r.ok) throw new Error('bad');
        const blob = await r.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `2257-record-${id}.json`;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
        toast('📥 2257 record downloaded');
      } catch (e) { toast('Could not download the 2257 record'); }
    });
  }

  // 💳 Refunds — issue
  go('#rf-go', async () => {
    const userId = parseInt($('#rf-user').value);
    const amount = parseFloat($('#rf-amount').value);
    const modelVal = $('#rf-model').value.trim();
    const reason = $('#rf-reason').value.trim();
    if (!userId || !(amount > 0) || !reason) return toast('Fill in fan, amount, and reason.');
    if (!confirm(`Refund $${amount.toFixed(2)} in credits to fan #${userId}?${modelVal ? ` Model #${modelVal} will be clawed back.` : ''}`)) return;
    const { status, data } = await api('/admin/refunds', { method: 'POST',
      body: JSON.stringify({ user_id: userId, amount_cents: Math.round(amount * 100),
        model_id: modelVal ? parseInt(modelVal) : null, reason }) });
    toast(status === 200 ? '✅ Refund issued' : (data.message || data.error || 'Refund failed.'));
    if (status === 200) M.reload();
  });

  // ⚠️ Disputes — file, resolve, freeze/unfreeze
  go('#dp-go', async () => {
    const userId = parseInt($('#dp-user').value);
    const amount = parseFloat($('#dp-amount').value);
    if (!userId || !(amount > 0)) return toast('Fill in fan and amount.');
    const body = { user_id: userId, amount_cents: Math.round(amount * 100),
      transaction_ref: $('#dp-ref').value.trim(), reason: $('#dp-reason').value.trim() };
    const pVal = $('#dp-purchase').value.trim();
    if (pVal) body.purchase_attempt_id = parseInt(pVal);
    const { status, data } = await api('/admin/disputes', { method: 'POST', body: JSON.stringify(body) });
    if (status === 200) {
      toast(data.auto_frozen ? '🧊 Dispute filed — account FROZEN (refund + dispute double-dip)' : '⚠️ Dispute filed');
      M.reload();
    } else toast('Could not file dispute.');
  });
  app.querySelectorAll('[data-dp-win]').forEach((b) => b.onclick = async () => {
    const { status } = await api(`/admin/disputes/${b.dataset.dpWin}`,
      { method: 'PUT', body: JSON.stringify({ status: 'won' }) });
    if (status === 200) M.reload();
  });
  app.querySelectorAll('[data-dp-lose]').forEach((b) => b.onclick = async () => {
    const { status } = await api(`/admin/disputes/${b.dataset.dpLose}`,
      { method: 'PUT', body: JSON.stringify({ status: 'lost' }) });
    if (status === 200) M.reload();
  });
  app.querySelectorAll('[data-dp-freeze]').forEach((b) => b.onclick = async () => {
    if (!confirm('Freeze this account? They will be logged out immediately.')) return;
    const { status } = await api(`/admin/fans/${b.dataset.dpFreeze}/freeze`, { method: 'POST' });
    toast(status === 200 ? '🧊 Account frozen' : 'Could not freeze.');
    if (status === 200) M.reload();
  });
  app.querySelectorAll('[data-dp-unfreeze]').forEach((b) => b.onclick = async () => {
    const { status } = await api(`/admin/fans/${b.dataset.dpUnfreeze}/unfreeze`, { method: 'POST' });
    toast(status === 200 ? '✅ Account unfrozen' : 'Could not unfreeze.');
    if (status === 200) M.reload();
  });
}

/* ---------------- Slut Manager shell ---------------- */
const NAV = [
  ['dash', '📊 Overview'], ['models', '💃 Models'], ['idchecks', '🪪 ID Checks'],
  ['invites', '✉️ Invites'], ['chats', '👀 Chats'], ['safety', '🛡️ Safety'],
  ['live', '🔴 Live'], ['payouts', '💸 Payouts'], ['tax', '🧾 Tax'],
  ['dmca', '⚖️ DMCA'], ['fans', '🧑 Fans'], ['bookings', '📅 Bookings'],
  ['contracts', '📝 Contracts'], ['partners', '🤝 Partners'],
  ['refunds', '💳 Refunds'], ['disputes', '⚠️ Disputes'],
  ['analytics', '📈 Analytics'], ['more', '⚙️ Settings'],
];

/* Sidebar grouping for the same screens (NAV above stays the flat
   source of labels/titles). '' heading = no heading row. */
const NAV_GROUPS = [
  ['', ['dash']],
  ['People', ['models', 'idchecks', 'fans', 'partners']],
  ['Money', ['payouts', 'tax', 'refunds', 'disputes']],
  ['Safety & Content', ['chats', 'live', 'safety', 'dmca']],
  ['Growth', ['invites', 'bookings', 'contracts', 'analytics']],
  ['Settings', ['more']],
];

const PRESENCE_CARD = `
  <div class="card" id="presence-card" style="padding:14px;margin-bottom:12px;overflow:hidden;box-sizing:border-box;max-width:100%">
    <div class="row" style="align-items:flex-start;min-width:0">
      <span class="grow" style="min-width:0">
        <span id="presence-total" style="font-size:clamp(19px,5.6vw,22px);font-weight:800">🟢 — on the app now</span><br>
        <span class="small muted" id="presence-split">Counting…</span>
      </span>
      <span style="text-align:right;flex-shrink:0">
        <div id="presence-peak" style="font-size:clamp(19px,5.6vw,22px);font-weight:800">—</div>
        <div class="small muted">peak today</div>
      </span>
    </div>
    <div id="presence-strip" style="display:flex;align-items:flex-end;gap:2px;height:44px;margin-top:10px;width:100%;overflow:hidden;box-sizing:border-box"></div>
    <div class="small muted" style="margin-top:6px">Last 2 hours · refreshes every 10s</div>
  </div>`;

async function overviewBody(stats) {
  const { data: ov } = await api('/admin/overview');
  const o = ov || {};
  const tiles = `
    <div class="stat-grid" style="margin-bottom:12px">
      <div class="stat"><div class="n" style="color:${o.pending_id_reviews ? 'var(--yellow, #fbbf24)' : 'inherit'}">${o.pending_id_reviews ?? '—'}</div><div class="l">Models pending ID review</div></div>
      <div class="stat"><div class="n">${o.live_now ?? '—'}</div><div class="l">Live now</div></div>
      <div class="stat"><div class="n">${o.fans ?? '—'}</div><div class="l">Fans</div></div>
      <div class="stat"><div class="n">${o.models ?? '—'}</div><div class="l">Models</div></div>
      <div class="stat"><div class="n" style="color:${o.open_dmca ? 'var(--red)' : 'inherit'}">${o.open_dmca ?? '—'}</div><div class="l">Open DMCA</div></div>
      <div class="stat"><div class="n" style="color:var(--green)">${fmt(o.gross_today_cents || 0)}</div><div class="l">Gross today</div></div>
    </div>`;
  return PRESENCE_CARD + tiles + (await adminDashBody(stats, o));
}

const SCREENS = {
  dash: overviewBody,
  chats: adminChatsBody, safety: adminSafetyBody, live: adminLiveBody,
  models: adminModelsBody, invites: adminInvitesBody, payouts: adminPayoutsBody,
  fans: adminFansBody, bookings: adminBookingsBody, contracts: adminContractsBody,
  idchecks: adminIdChecksBody, partners: adminPartnersBody, refunds: adminRefundsBody,
  disputes: adminDisputesBody, tax: adminTaxBody, dmca: adminDmcaBody,
  analytics: adminAnalyticsBody, more: adminMoreBody,
  peek: peekBody, watch: watchBody,
};

async function peekBody() {
  const p = M.peek;
  if (!p) return '<div class="empty">Nothing to peek at.</div>';
  return `
    <button class="btn ghost" id="mgr-peek-back" style="margin-bottom:10px">← Back to Chats</button>
    <div style="font-weight:800;margin-bottom:10px">👀 ${esc(p.title)} <span class="small muted">(read-only monitor)</span></div>
    ${(p.messages || []).map((m) => `
      <div class="card" style="padding:9px 12px;margin-bottom:6px">
        <b class="small">${esc(m.sender_name || '')}</b>
        <span class="small muted">${timeHM(m.created_at)}</span>
        <div style="white-space:pre-wrap;font-size:14px">${m.body ? esc(m.body) : `<i class="muted">📎 ${(m.media && m.media.kind) || m.media_kind || 'media'}</i>`}</div>
      </div>`).join('') || '<div class="empty">No messages yet.</div>'}`;
}

function watchBody() {
  const L = M.live;
  if (!L) return '<div class="empty">No stream selected.</div>';
  return `
    <div class="live-wrap" style="position:relative;max-width:860px">
      <video id="mgr-remote" autoplay playsinline muted style="width:100%;border-radius:14px;background:#000;aspect-ratio:16/9"></video>
      <button id="mgr-unmute" class="hidden" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);z-index:10;padding:12px 24px;border-radius:999px;border:none;background:rgba(0,0,0,.7);color:#fff;font-size:16px;font-weight:700;cursor:pointer">🔊 Tap for sound</button>
      <div class="live-top" style="position:absolute;top:10px;left:10px;display:flex;gap:8px;align-items:center">
        <span class="live-badge" style="background:linear-gradient(135deg,#8b5cf6,#3b82f6)">🛡️ MOD WATCH</span>
        <span class="live-viewers">${esc(L.modelName || '')}</span>
        ${L.isExplicit ? '<span class="live-badge">🔞 Explicit</span>' : ''}
        ${L.brb ? '<span class="live-badge" style="background:#8a5a00">⏸ BRB</span>' : ''}
      </div>
      ${L.title ? `<div class="live-title" style="margin-top:8px">${esc(L.title)}</div>` : ''}
      <div class="mod-watch-note">Invisible to viewers · not counted · no paywall</div>
      <div id="stream-chat" class="stream-chat mod"></div>
      <div class="live-controls" style="display:flex;gap:8px;margin-top:10px">
        <button class="btn ghost" id="mgr-leave-btn">← Back to Live</button>
        <button class="btn danger" id="mgr-end-btn">End stream</button>
      </div>
    </div>`;
}

/* Screen render — fetches stats (badges + dash/more bodies) like the old panel did */
M.go = (screen) => { M.screen = screen; M.render(); };
M.reload = () => M.render();

M.render = async () => {
  if (!app) return;
  stopPresence();
  document.querySelectorAll('#mgr-nav [data-screen]').forEach((b) =>
    b.classList.toggle('active', b.dataset.screen === M.screen));
  const { data: stats } = await api('/admin/stats');
  const s = stats || {};
  const sb = document.getElementById('badge-safety');
  if (sb) { sb.textContent = s.open_incidents || ''; sb.classList.toggle('hidden', !s.open_incidents); }
  const db = document.getElementById('badge-dmca');
  if (db) { db.textContent = s.open_dmca || ''; db.classList.toggle('hidden', !s.open_dmca); }
  const bodyFn = SCREENS[M.screen] || overviewBody;
  app.innerHTML = `<div class="mgr-h">${NAV.find((n) => n[0] === M.screen)?.[1] || ''}</div>` + (await bodyFn(s));
  wireAdminBody(M.screen);
  if (M.screen === 'dash') startPresence();
  if (M.screen === 'peek') wirePeek();
  if (M.screen === 'watch') wireWatch();
};

function startPresence() {
  refreshPresenceCard();
  M.presenceTimer = setInterval(() => {
    if (M.screen !== 'dash' || !document.getElementById('presence-card')) { stopPresence(); return; }
    refreshPresenceCard();
  }, 10000);
}
function stopPresence() {
  if (M.presenceTimer) { clearInterval(M.presenceTimer); M.presenceTimer = null; }
}

/* Read-only conversation peek (Chats screen → Open) */
M.openPeek = async (id) => {
  const { data } = await api('/admin/conversations');
  const c = (data.conversations || []).find((x) => x.id === id);
  if (!c) return;
  const { data: m } = await api(`/conversations/${id}/messages?limit=50`);
  M.peek = { id, title: `${c.model_name} ↔ ${c.fan_name}`, messages: (m && m.messages) || [] };
  M.go('peek');
};
function wirePeek() {
  const back = document.getElementById('mgr-peek-back');
  if (back) back.onclick = () => M.go('chats');
}

/* ---------------- Mod watch (Live screen → 👁️ Watch) ---------------- */
function liveSignal(to, sessionId, payload) {
  if (M.ws && M.ws.readyState === 1)
    M.ws.send(JSON.stringify({ type: 'live-signal', to, session_id: sessionId, payload }));
}

M.watchLive = async (sessionId) => {
  const { status, data } = await api(`/admin/live/${sessionId}/watch`, { method: 'POST' });
  if (status !== 200) return toast('Stream is offline.');
  M.live = { sessionId: parseInt(sessionId), pc: null, modelId: data.model_id,
             modelName: data.model_name, title: data.title || '',
             isExplicit: !!data.is_explicit, brb: !!data.brb, chat: [], chatIds: new Set() };
  M.go('watch');
};

function wireWatch() {
  const L = M.live;
  if (!L) return;
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  L.pc = pc;
  pc.onicecandidate = (e) => {
    if (e.candidate) liveSignal(L.modelId, L.sessionId, { kind: 'ice', candidate: e.candidate });
  };
  pc.ontrack = (e) => {
    const v = $('#mgr-remote');
    if (!v) return;
    v.srcObject = e.streams[0];
    e.streams[0].getAudioTracks().forEach((tr) => { tr.enabled = true; });
    const tryPlay = () => v.play().catch(() => {
      const btn = $('#mgr-unmute');
      if (btn) { btn.classList.remove('hidden'); btn.onclick = () => {
        v.muted = false; v.removeAttribute('muted');
        e.streams[0].getAudioTracks().forEach((tr) => { tr.enabled = true; });
        v.play().catch(() => {}); btn.classList.add('hidden'); }; }
    });
    tryPlay();
    const ub = $('#mgr-unmute');
    if (ub) ub.onclick = () => {
      v.muted = false; v.removeAttribute('muted');
      e.streams[0].getAudioTracks().forEach((tr) => { tr.enabled = true; });
      v.play().catch(() => {}); ub.classList.add('hidden');
    };
  };
  loadMgrStreamChat();
  L.chatPoll = setInterval(() => { if (M.screen === 'watch' && M.live === L) loadMgrStreamChat(); }, 5000);
  $('#mgr-leave-btn').onclick = () => leaveWatch(true);
  $('#mgr-end-btn').onclick = async () => {
    if (!confirm('End this live stream?')) return;
    await api(`/live/${L.sessionId}/end`, { method: 'POST' });
    toast('Stream ended.');
    leaveWatch(true);
  };
}

async function leaveWatch(unwatch) {
  const L = M.live;
  if (!L) return;
  if (L.chatPoll) clearInterval(L.chatPoll);
  if (unwatch) { try { await api(`/admin/live/${L.sessionId}/unwatch`, { method: 'POST' }); } catch (e) {} }
  if (L.pc) { try { L.pc.close(); } catch (e) {} }
  M.live = null;
  M.go('live');
}

async function loadMgrStreamChat() {
  const L = M.live;
  if (!L) return;
  try {
    const { data } = await api(`/live/${L.sessionId}/chat`);
    L.chat = (data && data.messages) || L.chat;
    renderMgrStreamChat();
  } catch (e) { /* ignore */ }
}
function renderMgrStreamChat() {
  const el = $('#stream-chat');
  const L = M.live;
  if (!el || !L) return;
  el.innerHTML = (L.chat || []).slice(-30).map((m) => `
    <div class="stream-msg${m.sender_role === 'model' ? ' from-model' : ''}">
      <b>${esc(m.sender_name)}</b> ${esc(m.body)}
    </div>`).join('');
  el.scrollTop = el.scrollHeight;
}

async function handleMgrLiveSignal(m) {
  const L = M.live;
  if (!L || m.session_id !== L.sessionId || !L.pc) return;
  const p = m.payload || {};
  try {
    if (p.kind === 'offer') {
      await L.pc.setRemoteDescription(new RTCSessionDescription(p.sdp));
      const answer = await L.pc.createAnswer();
      await L.pc.setLocalDescription(answer);
      liveSignal(m.from, L.sessionId, { kind: 'answer', sdp: answer });
    } else if (p.kind === 'ice') {
      await L.pc.addIceCandidate(new RTCIceCandidate(p.candidate));
    }
  } catch (e) { /* stale signaling */ }
}

/* ---------------- realtime (signaling + safety toasts) ---------------- */
M.wsConnect = () => {
  if (M.ws) { try { M.ws.close(); } catch (e) {} M.ws = null; }
  if (!M.token) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws?token=<REDACTED_SECRET>)}`);
  M.ws = ws;
  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.type === 'live-signal') handleMgrLiveSignal(m);
    else if (m.type === 'live:chat' && M.live && m.message && m.message.session_id === M.live.sessionId) {
      if (!M.live.chatIds.has(m.message.id)) {
        M.live.chatIds.add(m.message.id);
        M.live.chat.push(m.message);
        renderMgrStreamChat();
      }
    } else if (m.type === 'live:brb' && M.live && m.session_id === M.live.sessionId) {
      M.live.brb = !!m.brb;
      if (M.screen === 'watch') M.render();
    } else if (m.type === 'live:ended' && M.live && m.session_id === M.live.sessionId) {
      toast('Stream ended.');
      leaveWatch(false);
    } else if (m.type === 'safety:incident' && m.incident) {
      toast(`🚨 Safety flag: "${m.incident.matched}" (${m.incident.total_strikes} strikes)`, 4000);
    } else if (m.type === 'safety:stream_flag') {
      toast(`🚨 Stream flag: "${m.matched}" by ${m.sender_name} (${m.total_strikes} strikes)`, 4000);
    }
  };
  ws.onclose = () => { setTimeout(() => { if (M.token) M.wsConnect(); }, 4000); };
};

/* ---------------- login / shell / boot ---------------- */
M.logout = async () => {
  if (M.token) { try { await api('/auth/logout', { method: 'POST' }); } catch (e) {} }
  M.token = null; M.user = null; M.live = null;
  stopPresence();
  localStorage.removeItem('wc_token');
  if (M.ws) { try { M.ws.close(); } catch (e) {} M.ws = null; }
  renderLogin();
};

function renderLogin(err) {
  stopPresence();
  document.getElementById('mgr-root').innerHTML = `
    <div class="mgr-login-wrap">
      <form class="mgr-login card" id="mgr-login-form">
        <img src="/img/lips-logo.png" alt="" class="mgr-login-logo">
        <div class="mgr-login-title">Slut Manager</div>
        <div class="mgr-login-sub">Management only — fans &amp; models use the SlutCamp app</div>
        ${err ? `<div class="mgr-login-err">${esc(err)}</div>` : ''}
        <label class="field">Username<input class="input" id="ml-user" autocomplete="username"></label>
        <label class="field">Password<span id="ml-pass-slot"></span></label>
        <button class="btn" id="ml-go" type="submit" style="width:100%">Log in</button>
      </form>
    </div>`;
  document.getElementById('ml-pass-slot').innerHTML = pwField('ml-pass', 'current-password');
  document.getElementById('mgr-login-form').onsubmit = async (e) => {
    e.preventDefault();
    const username = $('#ml-user').value.trim(), password = $('#ml-pass').value;
    if (!username || !password) return renderLogin('Enter your username and password.');
    const btn = $('#ml-go');
    btn.disabled = true; btn.textContent = 'Logging in…';
    let r;
    try {
      r = await fetch('/api/manager/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
    } catch (err2) { return renderLogin('Network error — try again.'); }
    const data = await r.json().catch(() => ({}));
    if (r.status === 200 && data.token) {
      M.token = data.token;
      M.user = data.user;
      localStorage.setItem('wc_token', M.token);
      M.wsConnect();
      renderShell();
      M.render();
      return;
    }
    if (r.status === 429) return renderLogin('Too many tries — wait a minute ⏳');
    if (r.status === 403 && data.error === 'not_manager')
      return renderLogin(data.message || 'This app is for the SlutCamp manager account only');
    if (r.status === 403 && data.error === 'banned') return renderLogin('This account is banned.');
    return renderLogin('Login failed — check your details.');
  };
}

function renderShell() {
  const labelOf = (id) => (NAV.find((n) => n[0] === id) || [])[1] || id;
  const navBtn = (id) => {
    const label = labelOf(id);
    const sp = label.indexOf(' ');
    const ic = sp > 0 ? label.slice(0, sp) : '';
    const tx = sp > 0 ? label.slice(sp + 1) : label;
    const badge = id === 'safety' ? ' <span class="unread-badge hidden" id="badge-safety"></span>'
      : id === 'dmca' ? ' <span class="unread-badge hidden" id="badge-dmca"></span>' : '';
    return `<button data-screen="${id}"><span class="nav-ic">${ic}</span><span class="nav-tx">${tx}</span>${badge}</button>`;
  };
  document.getElementById('mgr-root').innerHTML = `
    <div class="mgr-topbar">
      <div class="mgr-top-brand">
        <img src="/img/lips-logo.png" alt="">
        <b>Slut Manager</b>
      </div>
      <div class="mgr-top-actions">
        <button class="mgr-top-btn" id="mgr-preview">👁 Preview</button>
        <button class="mgr-top-btn ghost" id="mgr-logout2">Log out</button>
      </div>
    </div>
    <div class="mgr-shell">
      <aside class="mgr-side">
        <div class="mgr-side-user">Signed in as <b id="mgr-user">${esc(M.user ? M.user.display_name : '')}</b></div>
        <nav id="mgr-nav">
          ${NAV_GROUPS.map(([heading, ids]) => `
            <div class="mgr-nav-group">
              ${heading ? `<div class="mgr-nav-h">${heading}</div>` : ''}
              ${ids.map(navBtn).join('')}
            </div>`).join('')}
        </nav>
      </aside>
      <main class="mgr-main"><div id="mgr-content"></div></main>
    </div>`;
  app = document.getElementById('mgr-content');
  document.querySelectorAll('#mgr-nav [data-screen]').forEach((b) => {
    b.onclick = () => M.go(b.dataset.screen);
  });
  document.getElementById('mgr-preview').onclick = () => {
    // Hand-off: the public app (same origin, same stored session) boots in
    // fan-preview mode when this one-shot flag is set. Preview controls
    // exist only here — never inside the public app.
    try { localStorage.setItem('sc_manager_preview', '1'); } catch (e) {}
    window.open('/', '_blank');
  };
  document.getElementById('mgr-logout2').onclick = () => M.logout();
}

(async function boot() {
  if (M.token) {
    const { status, data } = await api('/me');
    if (status === 200 && data.user && data.user.role === 'admin') {
      M.user = data.user;
      M.wsConnect();
      renderShell();
      M.render();
      return;
    }
    M.token = null;
    localStorage.removeItem('wc_token');
  }
  renderLogin();
})();
