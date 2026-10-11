/*
 * SlutCamp — frontend SPA (vanilla JS, no framework).
 * Mobile-first, WhatsApp-style. Three roles: fan, model, admin.
 * Guests can browse + get 3 free messages per model before the paywall.
 */
'use strict';

/* ---------------- helpers ---------------- */

const $ = (sel) => document.querySelector(sel);
const app = $('#app');
const tabbar = $('#tabbar');
const fmt = (c) => '$' + (c / 100).toFixed(2);
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

function toast(msg, ms) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.add('hidden'), ms || 2600);
}

/* Anti-copy for fans: blocks text selection/copy/cut in a container, and paste into an input */
function lockCopyForFans(container, input) {
  if (!container) return;
  container.classList.add('no-copy');
  ['copy', 'cut'].forEach((ev) => container.addEventListener(ev, (e) => e.preventDefault()));
  container.addEventListener('contextmenu', (e) => e.preventDefault());
  if (input) input.addEventListener('paste', (e) => { e.preventDefault(); toast('Pasting is disabled — type it out ✍️'); });
}

/* Password field with 👁️ show/hide toggle */
function pwField(id, autocomplete) {
  return `<div class="pw-wrap"><input class="input" id="${id}" type="password" autocomplete="${autocomplete || 'current-password'}">` +
    `<button type="button" class="pw-eye" data-pw="${id}" aria-label="Show password">👁️</button></div>`;
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-pw]');
  if (!b) return;
  const inp = document.getElementById(b.dataset.pw);
  if (!inp) return;
  const show = inp.type === 'password';
  inp.type = show ? 'text' : 'password';
  b.textContent = show ? '🙈' : '👁️';
  b.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
});

// Avatar: model photo if set, otherwise gradient initial
function avatarHTML(name, cls, photoUrl) {
  if (photoUrl) return `<div class="avatar ${cls || ''}"><img src="${esc(photoUrl)}" alt=""></div>`;
  const hues = [[265, 320], [300, 340], [220, 280], [280, 310]];
  const h = hues[(name || '?').length % hues.length];
  const initial = esc((name || '?').trim().charAt(0).toUpperCase());
  return `<div class="avatar ${cls || ''}" style="background:linear-gradient(135deg,hsl(${h[0]},70%,55%),hsl(${h[1]},65%,50%))">${initial}</div>`;
}

function timeHM(iso) {
  const d = new Date((iso || '').replace(' ', 'T') + 'Z');
  if (isNaN(d)) return '';
  let h = d.getHours(), m = String(d.getMinutes()).padStart(2, '0');
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m} ${ap}`;
}

/* ---------------- state ---------------- */

const S = {
  token: localStorage.getItem('wc_token') || null,
  guestToken: localStorage.getItem('wc_guest') || null,
  user: null,       // logged-in user (public fields)
  wallet: null,
  model: null,      // model profile if role=model
  ws: null,
  view: 'landing',
  conv: null,       // active conversation {id, other, is_paused, free_remaining}
  messages: [],
  call: null,       // active call state
  adminTab: 'dash',
  live: null,       // active live session state {sessionId, role, ...}
};

/* ---------------- AI nudity monitor (NSFWJS, client-side) ---------------- */
/* Loads lazily only when a fan opens a live view. If it fails (offline,    */
/* blocked CDN), the app falls back to the model's manual "Go Explicit".   */
const NSFW = {
  model: null,
  loading: false,
  failed: false,
  async ensure() {
    if (this.model) return this.model;
    if (this.failed || this.loading) return null;
    this.loading = true;
    try {
      // esm.sh bundles tfjs + deps; jsdelivr's dist is CJS-only and won't load via <script>
      const mod = await import(/* webpackIgnore: true */ 'https://esm.sh/nsfwjs@2.4.2');
      const loadFn = mod.load || (mod.default && mod.default.load);
      this.model = await loadFn();
      this.loading = false;
      return this.model;
    } catch (e) {
      console.warn('NSFWJS failed to load, using manual mode:', e);
      this.failed = true;
      this.loading = false;
      return null;
    }
  },
  // Classify a video element via canvas snapshot. Returns true if explicit.
  async isExplicit(videoEl) {
    const model = await this.ensure();
    if (!model || !videoEl || videoEl.readyState < 2 || videoEl.videoWidth === 0) return false;
    try {
      const c = NSFW._canvas || (NSFW._canvas = document.createElement('canvas'));
      c.width = 224; c.height = 224;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      // center-crop to square
      const vw = videoEl.videoWidth, vh = videoEl.videoHeight;
      const s = Math.min(vw, vh), sx = (vw - s) / 2, sy = (vh - s) / 2;
      ctx.drawImage(videoEl, sx, sy, s, s, 0, 0, 224, 224);
      const preds = await model.classify(c);
      for (const p of preds) {
        if ((p.className === 'Porn' || p.className === 'Hentai') && p.probability > 0.7) {
          console.log('[AI monitor] explicit detected:', p.className, p.probability.toFixed(2));
          return true;
        }
      }
      return false;
    } catch (e) {
      console.warn('NSFW classify failed:', e);
      return false;
    }
  },
};

async function api(path, opts) {
  opts = opts || {};
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  if (S.token) headers['Authorization'] = 'Bearer ' + S.token;
  else if (S.guestToken) headers['X-Guest-Token'] = S.guestToken;
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 15000); // 15s timeout
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

/* POST a single file via multipart (no JSON content-type — browser sets the boundary) */
async function apiUpload(path, file, field) {
  const fd = new FormData();
  fd.append(field || 'photo', file);
  const headers = {};
  if (S.token) headers['Authorization'] = 'Bearer ' + S.token;
  const r = await fetch('/api' + path, { method: 'POST', headers, body: fd });
  let data = {};
  try { data = await r.json(); } catch (e) { /* non-JSON */ }
  return { status: r.status, data };
}

async function ensureGuest() {
  if (S.guestToken) return S.guestToken;
  const { data } = await api('/guest/token', { method: 'POST' });
  if (data.guest_token) {
    S.guestToken = data.guest_token;
    localStorage.setItem('wc_guest', S.guestToken);
  }
  return S.guestToken;
}

/* ---------------- websocket ---------------- */

function wsConnect() {
  if (S.ws) { try { S.ws.close(); } catch (e) {} S.ws = null; }
  const q = S.token ? `token=${S.token}` : (S.guestToken ? `guest_token=${S.guestToken}` : null);
  if (!q) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws?${q}`);
  S.ws = ws;

  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    handleWS(m);
  };
  ws.onclose = () => {
    // Reconnect after 4s if we're still "logged in" somehow
    setTimeout(() => { if (S.token || S.guestToken) wsConnect(); }, 4000);
  };
}

function handleWS(m) {
  if (m.type && m.type.startsWith('booking:')) { handleBookingPush(m); return; }
  if (m.type === 'chat:new' && S.view === 'chat' && S.conv && m.conversation_id === S.conv.id) {
    S.messages.push(m.message);
    renderMessages();
    api(`/conversations/${S.conv.id}/read`, { method: 'POST' });
    // TikTok-style gift: emoji flies across the screen for both sides
    const gg = giftOf(m.message);
    if (gg) flyGiftAnim(gg.emoji, m.message.sender_name || 'Someone', gg.name);
  } else if (m.type === 'chat:new') {
    refreshTabBadges();
  } else if (m.type === 'chat:read' && S.view === 'chat' && S.conv && m.conversation_id === S.conv.id) {
    S.messages.forEach((x) => { x.is_read = 1; });
    renderMessages();
  } else if (m.type === 'typing' && S.view === 'chat' && S.conv && m.conversation_id === S.conv.id) {
    const el = $('#typing-ind');
    if (el) el.classList.toggle('hidden', !m.is_typing);
  } else if (m.type === 'chat:paused' && S.conv && m.conversation_id === S.conv.id) {
    S.conv.is_paused = true;
    show('chat', { conv: S.conv, keepMessages: true });
    toast(m.warning || '⚠️ Chat paused');
  } else if (m.type === 'chat:resumed' && S.conv && m.conversation_id === S.conv.id) {
    S.conv.is_paused = false;
    show('chat', { conv: S.conv, keepMessages: true });
    toast('✅ Chat resumed');
  } else if (m.type === 'signal') {
    handleSignal(m);
  } else if (m.type === 'call:tick' && S.call && m.call_id === S.call.id) {
    S.call.minutes = m.minutes_billed;
    updateCallHUD();
    if (m.balance_cents != null && S.wallet) { S.wallet.credits_cents = m.balance_cents; }
  } else if (m.type === 'call:ended' && S.call && m.call_id === S.call.id) {
    endCallUI(m.reason === 'insufficient_credits'
      ? 'Out of credits — call ended.' : 'Call ended.');
  } else if (m.type === 'safety:incident' && S.user && S.user.role === 'admin') {
    toast(`🚨 Safety flag: "${m.incident.matched}" (${m.incident.total_strikes} strikes)`, 4000);
    if (S.view === 'admin' && S.adminTab === 'safety') show('admin', {});
  } else if (m.type === 'notification:new' && m.notification) {
    refreshNotifBadge();
    toast(m.notification.title, 4000);
    if (m.notification.type === 'live' && S.view === 'notifications') show('notifications', {});
  } else if (m.type === 'tip:received' && S.user && S.user.role === 'model') {
    showGiftAnim(m.emoji, m.fan_name);
    toast(`💰 ${m.fan_name} tipped ${m.emoji} ${m.label} (${fmt(m.price_cents)})!`, 4000);
    if (typeof refreshMe === 'function') refreshMe();
  } else if (m.type === 'media:unlocked' && S.view === 'chat' && S.conv && m.conversation_id === S.conv.id) {
    toast(`💰 ${fmt(m.amount_cents)} unlock! Nice!`);
    if (S.user && S.user.role === 'model') refreshMe();
  } else if (m.type === 'live-signal') {
    handleLiveSignal(m);
  } else if (m.type === 'live:viewer-joined' && S.live && S.live.role === 'model' && m.session_id === S.live.sessionId) {
    liveModelAddViewer(m.fan_id);
  } else if (m.type === 'live:viewer-left' && S.live && S.live.role === 'model' && m.session_id === S.live.sessionId) {
    liveModelRemoveViewer(m.fan_id);
  } else if (m.type === 'live:explicit' && S.live && S.live.role === 'fan' && m.session_id === S.live.sessionId) {
    if (m.explicit_entry_cents) S.live.entryCents = m.explicit_entry_cents;
    onLiveExplicitSignal(m.is_explicit, m.explicit_rate_cents, 'manual');
  } else if (m.type === 'live:ended' && S.live && m.session_id === S.live.sessionId) {
    endLiveView('Stream ended.');
  } else if (m.type === 'live:tick' && S.live && S.live.role === 'fan' && m.session_id === S.live.sessionId) {
    S.live.paying = true;
    S.live.entryPaid = true; // per-minute billing implies entry-paid server-side
    if (m.balance_cents != null && S.wallet) S.wallet.credits_cents = m.balance_cents;
    updateLivePayHUD();
  } else if (m.type === 'live:pay_stopped' && S.live && S.live.role === 'fan' && m.session_id === S.live.sessionId) {
    S.live.paying = false;
    if (m.balance_cents != null && S.wallet) S.wallet.credits_cents = m.balance_cents;
    updateLivePayHUD();
    if (S.live.isExplicit && !isGiftClear(S.live)) {
      toast('Out of credits — back to free preview.');
      applyLiveBlur(true, S.live.explicitRate, 'manual');
    } else if (!S.live.isExplicit) {
      applyLiveBlur(false);
    }
    // else: gift grace still active → stays unblurred
  } else if (m.type === 'live:chat' && S.live && m.message && m.message.session_id === S.live.sessionId) {
    S.live.chat = S.live.chat || [];
    S.live.chat.push(m.message);
    renderStreamChat();
  } else if (m.type === 'live:chat_blocked' && S.live && m.session_id === S.live.sessionId) {
    toast(m.warning || '⚠️ Message blocked', 3500);
  } else if (m.type === 'live:gift' && S.live && m.session_id === S.live.sessionId) {
    // Animated gift overlay for everyone watching + stacked ticker
    showGiftAnim(m.gift.emoji, m.fan_name);
    pushGiftStack(m.gift.emoji, m.fan_name);
    pushGiftToChat(m.gift, m.fan_name);
    if (m.balance_cents != null && S.wallet &&
        S.user && S.user.role === 'fan' && S.user.id === m.fan_id) {
      S.wallet.credits_cents = m.balance_cents;
    }
    if (S.user && S.user.role === 'model') {
      toast(`🎁 ${m.fan_name} sent ${m.gift.emoji} ${m.gift.name} (${fmt(m.gift.price_cents)})!`);
      refreshMe();
    }
    loadLeaderboard();
  } else if (m.type === 'live:priority' && S.live && m.session_id === S.live.sessionId) {
    // Paid priority banner — one at a time, dedup by id (our own expiry-fetch may race this)
    if (m.priority && m.priority.id !== S.live.priorityId) showPriorityBanner(m.priority);
  } else if (m.type === 'live:stage' && S.live && m.session_id === S.live.sessionId) {
    // Someone joined/left the stage
    if (S.live.role === 'fan') {
      if (m.stage && m.stage.fan_id === S.user.id) {
        // Our own approval arrives via live:join-approved; ignore duplicate
      } else if (m.stage) {
        showStageNotice(m.stage.fan_name, m.stage.mode);
      } else {
        hideStageBanner();
      }
    }
  } else if (m.type === 'live:join-approved' && S.live && S.live.role === 'fan' && m.session_id === S.live.sessionId) {
    onStageApproved({ fan_id: S.user.id, stage_ends_at: m.stage_ends_at, mode: m.mode }, false);
  } else if (m.type === 'live:join-declined' && S.live && S.live.role === 'fan' && m.session_id === S.live.sessionId) {
    S.live.stagePending = false;
    if (m.balance_cents != null && S.wallet) S.wallet.credits_cents = m.balance_cents;
    hideStageBanner();
    toast(`She passed this time 😅 — ${fmt(m.refunded_cents || 0)} refunded to your wallet.`, 3500);
  } else if (m.type === 'live:stage-ended' && S.live && S.live.role === 'fan' && m.session_id === S.live.sessionId) {
    stopStageStream();
    showStageBanner('ended');
    if (m.reason === 'timeout') toast("⏰ Stage time's up! She loved it though 😏", 3500);
    else if (m.reason === 'dropped') toast('She moved on — thanks for the show! 🎥', 3000);
  } else if (m.type === 'live:join-request' && S.live && S.live.role === 'model' && m.session_id === S.live.sessionId) {
    renderStageRequests();
    const reqMode = (m.request && m.request.mode) || 'video';
    const fee = stageJoinFee(!!m.request.is_explicit, reqMode);
    toast(`${stageModeEmoji(reqMode)} ${m.request.fan_name} wants to join (${stageModeLabel(reqMode)} · ${fmt(fee)})!${m.request.is_explicit ? ' 🔞' : ''}`, 4000);
    // Fallback: if the API call fails, render from WS data directly
    setTimeout(() => {
      const box = $('#stage-requests');
      if (box && !box.innerHTML.trim() && m.request && m.request.id) {
        const r = m.request;
        const mode = r.mode || 'video';
        box.innerHTML = `
        <div class="stage-req-card">
          <span class="grow">${stageModeEmoji(mode)} <b>${esc(r.fan_name)}</b> wants to join (${stageModeLabel(mode)})${r.is_explicit ? ' 🔞' : ''}
            <span class="muted small">(${fmt(fee)})</span></span>
          <button class="btn small" data-approve="${r.id}">✅</button>
          <button class="btn small danger" data-decline="${r.id}">❌</button>
        </div>`;
        box.querySelectorAll('[data-approve]').forEach((b) => {
          b.onclick = () => stageApprove(parseInt(b.dataset.approve));
        });
        box.querySelectorAll('[data-decline]').forEach((b) => {
          b.onclick = () => stageDecline(parseInt(b.dataset.decline));
        });
      }
    }, 1000);
  } else if (m.type === 'live:join-request-cancelled' && S.live && S.live.role === 'model' && m.session_id === S.live.sessionId) {
    renderStageRequests();
  } else if (m.type === 'withdrawal:decided' && S.user && (S.user.role === 'model' || S.user.role === 'recruiter')) {
    if (m.status === 'paid') toast(`💸 ${fmt(m.amount_cents)} is on its way to your bank!`, 4000);
    else toast(`Withdrawal ${fmt(m.amount_cents)} was not approved${m.note ? ': ' + m.note : ''} — funds are still available.`, 4000);
    if (S.view === 'modelEarnings') show('modelEarnings', {});
    if (S.view === 'recruiter') show('recruiter', {});
  } else if (m.type === 'safety:stream_flag' && S.user && S.user.role === 'admin') {
    toast(`🚨 Stream flag: "${m.matched}" by ${m.sender_name} (${m.total_strikes} strikes)`, 4000);
  }
}

/* ---------------- router ---------------- */

const TABS = {
  fan: [
    { id: 'models', ico: '🔥', label: 'Models', view: 'fanModels' },
    { id: 'live', ico: '🔴', label: 'Live', view: 'fanLive' },
    { id: 'chats', ico: '💬', label: 'Chats', view: 'fanChats' },
    { id: 'book', ico: '📅', label: 'Bookings', view: 'bookings' },
    { id: 'wallet', ico: '💰', label: 'Wallet', view: 'wallet' },
  ],
  model: [
    { id: 'chats', ico: '💬', label: 'Chats', view: 'modelChats' },
    { id: 'book', ico: '📅', label: 'Bookings', view: 'bookings' },
    { id: 'earn', ico: '💵', label: 'Earnings', view: 'modelEarnings' },
    { id: 'settings', ico: '⚙️', label: 'Settings', view: 'modelSettings' },
  ],
  admin: [
    { id: 'dash', ico: '📊', label: 'Home', view: 'admin' },
    { id: 'chats', ico: '👀', label: 'Chats', view: 'admin' },
    { id: 'safe', ico: '🛡️', label: 'Safety', view: 'admin' },
    { id: 'more', ico: '⚙️', label: 'More', view: 'admin' },
  ],
  recruiter: [
    { id: 'dash', ico: '🤝', label: 'Home', view: 'recruiter' },
    { id: 'payout', ico: '💸', label: 'Payouts', view: 'recruiter' },
  ],
};

function renderTabbar() {
  if (!S.user) { tabbar.classList.add('hidden'); tabbar.innerHTML = ''; return; }
  const tabs = TABS[S.user.role] || [];
  tabbar.classList.remove('hidden');
  tabbar.innerHTML = tabs.map((t) =>
    `<button data-tab="${t.id}" class="${S.view === t.view && (S.user.role !== 'admin' || S.adminTab === t.id || (t.id === 'dash' && S.adminTab === 'dash')) ? 'active' : ''}">
       <span class="ico">${t.ico}</span>${t.label}<span class="badge hidden" id="badge-${t.id}"></span>
     </button>`).join('');
  tabbar.querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      const t = tabs.find((x) => x.id === b.dataset.tab);
      if (S.user.role === 'admin') S.adminTab = t.id === 'more' ? 'more' : t.id;
      show(t.view, {});
    };
  });
}

async function refreshTabBadges() {
  if (!S.user) return;
  try {
    const { data } = await api('/conversations');
    const total = (data.conversations || []).reduce((n, c) => n + (c.unread_count || 0), 0);
    ['chats'].forEach((id) => {
      const b = document.getElementById('badge-' + id);
      if (b) { b.textContent = total; b.classList.toggle('hidden', !total); }
    });
  } catch (e) { /* ignore */ }
}

const MODEL_VIEWS = ['modelChats', 'modelEarnings', 'modelSettings', 'bookings', 'liveBroadcast', 'chat'];

function show(view, params) {
  // Gate: unsigned models must sign the contract first
  if (S.user && S.user.role === 'model' && S.contractSigned === false
      && view !== 'modelContract' && MODEL_VIEWS.includes(view)) {
    view = 'modelContract';
  }
  S.view = view;
  renderTabbar();
  renderBell();
  window.scrollTo(0, 0);
  const VIEWS = {
    landing: vLanding, auth: vAuth,
    fanModels: vFanModels, fanLive: vFanLive, fanChats: vFanChats, wallet: vWallet,
    modelChats: vModelChats, modelEarnings: vModelEarnings, modelSettings: vModelSettings,
    admin: vAdmin, chat: vChat,
    liveBroadcast: vLiveBroadcast, liveWatch: vLiveWatch,
    bookings: vBookings, terms: vTerms,
    adminLogin: vAdminLogin, modelContract: vModelContract,
    recruiter: vRecruiter, notifications: vNotifications, dmca: vDmca,
  };
  (VIEWS[view] || vLanding)(params || {});
  if (view === 'liveBroadcast' || view === 'liveWatch') tabbar.classList.add('hidden');
  else if (S.user) refreshTabBadges();
}

/* ---------------- LANDING (public model grid) ---------------- */

async function vLanding() {
  const { data } = await api('/models');
  const models = data.models || [];
  app.innerHTML = `
    <div class="header">
      <h1>Slut<span class="logo">Camp</span> 💬</h1>
      <div class="sub">Chat & video call the models · 18+ only</div>
    </div>
    <div class="screen">
      <div class="card" style="text-align:center;background:linear-gradient(135deg,#3b1d6e,#1a0f2e)">
        <div style="font-size:20px;font-weight:800">🎁 First 3 messages FREE</div>
        <div class="muted small" style="margin-top:4px">with every model you try. No account needed to start.</div>
      </div>
      ${models.map((m) => `
        <button class="list-item" data-model="${m.id}" data-live="${m.live_session_id || ''}" style="background:var(--card);border-radius:14px;margin-bottom:10px;border:1px solid rgba(139,92,246,.18)">
          <span class="avatar-wrap">${avatarHTML(m.display_name, '', m.photo_url)}
            ${m.is_online ? '<span class="online-dot"></span>' : ''}</span>
          <span class="grow">
            <span class="title">${esc(m.display_name)}
              ${m.is_live ? ' <span class="live-badge">🔴 LIVE</span>' : ''}
              <span class="small" style="color:${m.is_online ? 'var(--green)' : 'var(--muted)'}">● ${m.is_online ? 'Online' : 'Offline'}</span>
            </span><br>
            <span class="preview">${esc(m.bio).slice(0, 70)}</span><br>
            <span class="small" style="color:var(--pink);font-weight:700">${fmt(m.per_message_cents)}/msg · ${fmt(m.per_minute_cents)}/min video</span>
            ${m.schedule_summary ? `<br><span class="small muted">📅 Usually live: ${esc(m.schedule_summary)}</span>` : ''}
            ${m.is_live ? `<br><span class="small" style="color:#f87171;font-weight:800">▶ Watch free preview — tap to join</span>` : ''}
          </span>
          <span style="font-size:22px">›</span>
        </button>`).join('') || '<div class="empty"><div class="big">😴</div>No models yet.</div>'}
      <div style="text-align:center;margin-top:14px">
        ${S.user ? '' : `<button class="btn ghost" id="go-login">Log in / Sign up</button>`}
      </div>
      <div style="text-align:center;margin-top:10px">
        <button class="btn ghost" id="share-app" style="border-color:var(--pink);color:var(--pink)">📤 Share SlutCamp</button>
      </div>
      <p class="muted small" style="text-align:center;margin-top:16px">18+ only. By chatting you agree to the <a href="javascript:void(0)" id="go-terms" style="color:var(--pink)">Terms</a> · <a href="javascript:void(0)" id="go-dmca" style="color:var(--pink)">DMCA</a>.</p>
    </div>`;
  app.querySelectorAll('[data-model]').forEach((b) => {
    b.onclick = () => {
      const liveId = b.dataset.live;
      if (liveId) return watchLive(parseInt(liveId));
      openChatWithModel(parseInt(b.dataset.model));
    };
  });
  const gl = $('#go-login');
  if (gl) gl.onclick = () => show('auth', {});
  const sh = $('#share-app');
  if (sh) sh.onclick = shareApp;
  const gt = $('#go-terms');
  if (gt) gt.onclick = () => show('terms', {});
  const gd = $('#go-dmca');
  if (gd) gd.onclick = () => show('dmca', {});
}

/* Share the app via native share sheet, fallback to copy link */
async function shareApp() {
  const url = location.origin;
  const data = { title: 'SlutCamp', text: 'Chat & video call the models on SlutCamp 🔥 18+ only', url };
  if (navigator.share) {
    try { await navigator.share(data); } catch (e) { /* user cancelled */ }
  } else if (navigator.clipboard) {
    try { await navigator.clipboard.writeText(url); toast('Link copied — send it to your boys 📤'); }
    catch (e) { toast(url); }
  } else {
    prompt('Copy your SlutCamp link:', url);
  }
}

async function openChatWithModel(modelId) {
  await ensureGuest();
  const { status, data } = await api('/conversations/start', {
    method: 'POST', body: JSON.stringify({ model_id: modelId }),
  });
  if (status === 200) show('chat', { conv: data.conversation });
  else if (data && data.error === 'id_verification_required')
    toast('This model is not available right now.');
  else toast('Could not open chat.');
}

/* ---------------- AUTH ---------------- */

function vAuth(params) {
  const mode = (params && params.mode) || 'login';
  const role = (params && params.role) || 'fan';
  app.innerHTML = `
    <div class="header"><h1>Slut<span class="logo">Camp</span></h1>
      <div class="sub">${mode === 'login' ? 'Welcome back 😈' : 'Create your account'}</div></div>
    <div class="screen">
      <div class="tabs">
        <button id="t-login" class="${mode === 'login' ? 'active' : ''}">Log in</button>
        <button id="t-signup" class="${mode === 'signup' ? 'active' : ''}">Sign up</button>
      </div>
      <div id="auth-body"></div>
      <button class="btn ghost" id="back-browse" style="margin-top:16px">← Keep browsing free</button>
    </div>`;
  $('#t-login').onclick = () => show('auth', { mode: 'login' });
  $('#t-signup').onclick = () => show('auth', { mode: 'signup', role });
  $('#back-browse').onclick = () => show('landing', {});
  renderAuthBody(mode, role);
}

function renderAuthBody(mode, role) {
  const body = $('#auth-body');
  if (mode === 'login') {
    body.innerHTML = `
      <label class="field">Username<input class="input" id="a-user" autocomplete="username"></label>
      <label class="field">Password${pwField('a-pass', 'current-password')}</label>
      <button class="btn" id="a-go">Log in</button>`;
    $('#a-go').onclick = doLogin;
  } else {
    body.innerHTML = `
      <div class="role-card ${role === 'fan' ? 'selected' : ''}" id="r-fan">
        <div class="emoji">😍</div><div class="t">I'm a Fan</div>
        <div class="d">Chat & video call the models</div></div>
      <div class="role-card ${role === 'model' ? 'selected' : ''}" id="r-model">
        <div class="emoji">💃</div><div class="t">I'm a Model</div>
        <div class="d">Get paid to chat (Asce verifies you)</div></div>
      <label class="field">Display name<input class="input" id="a-name" maxlength="40"></label>
      <label class="field">Username<input class="input" id="a-user" autocomplete="username"></label>
      <label class="field">Password (6+ characters)${pwField('a-pass', 'new-password')}</label>
      <label class="field">Date of birth<input class="input" id="a-dob" type="date"></label>
      <div class="age-box">🔞 <b>18+ only.</b> You must be 18 or older to use SlutCamp.
        ${role === 'model' ? 'Models must also complete ID verification with Asce (2257).' : 'Full ID verification is required before purchasing credits.'}</div>
      <label class="checkbox-row"><input type="checkbox" id="a-18">
        <span>I confirm I am <b>18 years or older</b>.</span></label>
      <button class="btn" id="a-go">Create account</button>`;
    let r = role;
    $('#r-fan').onclick = () => { r = 'fan'; $('#r-fan').classList.add('selected'); $('#r-model').classList.remove('selected'); };
    $('#r-model').onclick = () => { r = 'model'; $('#r-model').classList.add('selected'); $('#r-fan').classList.remove('selected'); };
    $('#a-go').onclick = () => doSignup(r);
  }
}

async function doLogin() {
  const username = $('#a-user').value.trim(), password = $('#a-pass').value;
  if (!username || !password) return toast('Enter username + password');
  const { status, data } = await api('/auth/login', {
    method: 'POST', body: JSON.stringify({ username, password, guest_token: S.guestToken }),
  });
  if (status === 200) return afterLogin(data);
  toast(data.error === 'banned' ? '⛔ This account is banned.' : 'Login failed — check your details.');
}

/* ---------------- SECRET ADMIN LOGIN (#boss) ---------------- */
/* Not linked anywhere in the UI. Password → SMS code → in.      */

let adminLoginState = {};

function vAdminLogin() {
  tabbar.classList.add('hidden');
  if (S.user && S.user.role === 'admin') return show('admin', {});
  adminLoginState = { step: 'creds', tempToken: null, username: '' };
  app.innerHTML = `
    <div class="header"><h1>Slut<span class="logo">Camp</span> 🔐</h1>
      <div class="sub">Restricted area</div></div>
    <div class="screen">
      <div class="card" style="text-align:center">
        <div style="font-size:44px">🛡️</div>
        <div style="font-weight:800;font-size:18px;margin:8px 0">Boss entrance</div>
        <div class="muted small">Sign in with your admin password.</div>
      </div>
      <div id="al-body"></div>
    </div>`;
  renderAdminLoginStep();
}

function renderAdminLoginStep() {
  const body = $('#al-body');
  body.innerHTML = `
    <label class="field">Username<input class="input" id="al-user" autocomplete="username"></label>
    <label class="field">Password${pwField('al-pass', 'current-password')}</label>
    <button class="btn" id="al-go">Log in</button>`;
  $('#al-go').onclick = adminLoginStep1;
}

async function adminLoginStep1() {
  const username = $('#al-user').value.trim(), password = $('#al-pass').value;
  if (!username || !password) return toast('Enter username + password');
  const btn = $('#al-go');
  btn.disabled = true; btn.textContent = 'Logging in…';
  const { status, data } = await api('/auth/admin-login', {
    method: 'POST', body: JSON.stringify({ username, password }),
  });
  btn.disabled = false; btn.textContent = 'Log in';
  if (status === 200 && data.token) return adminLoginSuccess(data);
  if (status === 429) return toast('Too many tries — wait a minute ⏳');
  toast('Login failed — check your details.');
}

async function adminLoginSetupPhone() {
  const phone = $('#al-phone').value.trim();
  if (!phone) return toast('Enter your phone number');
  const st = adminLoginState;
  const btn = $('#al-go');
  btn.disabled = true; btn.textContent = 'Sending…';
  const { status, data } = await api('/auth/admin-setup-phone', {
    method: 'POST', body: JSON.stringify({ username: st.username, password: st.password, phone }),
  });
  btn.disabled = false; btn.textContent = 'Send verification code';
  if (status === 200 && data.sent) {
    st.step = 'verify_phone'; st.masked = data.masked;
    return renderAdminLoginStep();
  }
  if (data.error === 'bad_phone') return toast('That phone number looks wrong 📱');
  if (data.error === 'sms_not_configured') return toast('SMS is not set up yet — add Twilio keys on the server ⚠️');
  toast('Could not send the code — try again.');
}

async function adminLoginVerifyPhone() {
  const code = $('#al-code').value.trim();
  if (code.length < 6) return toast('Enter the 6-digit code');
  const st = adminLoginState;
  const { status, data } = await api('/auth/admin-verify-phone', {
    method: 'POST', body: JSON.stringify({ username: st.username, code }),
  });
  if (status === 200 && data.token) return adminLoginSuccess(data);
  if (data.error === 'code_expired') return toast('Code expired — start over 🔄');
  toast('Wrong code — check your texts and try again.');
}

async function adminLoginStep2() {
  const code = $('#al-code').value.trim();
  if (code.length < 6) return toast('Enter the 6-digit code');
  const st = adminLoginState;
  const btn = $('#al-go');
  btn.disabled = true; btn.textContent = 'Checking…';
  const { status, data } = await api('/auth/admin-2fa', {
    method: 'POST', body: JSON.stringify({ temp_token: st.tempToken, code }),
  });
  btn.disabled = false; btn.textContent = 'Enter admin';
  if (status === 200 && data.token) return adminLoginSuccess(data);
  if (data.error === 'code_expired') { toast('Code expired — start over 🔄'); st.step = 'creds'; return renderAdminLoginStep(); }
  if (data.error === 'session_expired') { toast('Session expired — start over 🔄'); st.step = 'creds'; return renderAdminLoginStep(); }
  if (data.error === 'too_many_attempts') { toast('Too many wrong codes — start over ⛔'); st.step = 'creds'; return renderAdminLoginStep(); }
  toast(data.attempts_left !== undefined ? `Wrong code — ${data.attempts_left} tries left.` : 'Wrong code — try again.');
}

function adminLoginSuccess(data) {
  try { window.history.replaceState({}, '', window.location.pathname); } catch (e) {}
  afterLogin(data);
}

async function doSignup(role) {
  const display_name = $('#a-name').value.trim();
  const username = $('#a-user').value.trim();
  const password = $('#a-pass').value;
  const dob = $('#a-dob').value;
  const agree18 = $('#a-18').checked;
  if (!display_name || !username || !password || !dob) return toast('Fill in every field');
  if (!agree18) return toast('You must confirm you are 18+');
  const { status, data } = await api('/auth/signup', {
    method: 'POST',
    body: JSON.stringify({ username, password, role, display_name, dob, agree18, guest_token: S.guestToken }),
  });
  if (status === 200) return afterLogin(data);
  const msgs = { username_taken: 'Username is taken 😕', must_be_18: 'You must be 18 or older.',
    password_too_short: 'Password needs 6+ characters.' };
  toast(msgs[data.error] || 'Signup failed.');
}

/* ---------------- MODEL INVITE SIGNUP (?invite=CODE) ---------------- */

async function vInviteSignup(code) {
  // Validate the code first
  let valid = false, label = '';
  try {
    const { status, data } = await api(`/invite/${encodeURIComponent(code)}`);
    valid = status === 200 && data.valid;
    label = data.label || '';
  } catch { valid = false; }

  if (!valid) {
    app.innerHTML = `
      <div class="header"><h1>Slut<span class="logo">Camp</span></h1></div>
      <div class="screen"><div class="card" style="text-align:center">
        <div style="font-size:40px">⛔</div>
        <div style="font-weight:800;margin:8px 0">This invite link is invalid,<br>already used, or revoked.</div>
        <div class="muted small">Ask Asce for a fresh invite link.</div>
        <button class="btn ghost" style="margin-top:12px" onclick="show('landing',{})">← Back to browsing</button>
      </div></div>`;
    return;
  }

  app.innerHTML = `
    <div class="header"><h1>Slut<span class="logo">Camp</span> 💃</h1>
      <div class="sub">You've been invited to join as a model${label ? ` · <b>${esc(label)}</b>` : ''}</div></div>
    <div class="screen">
      <div class="card" style="background:linear-gradient(135deg,#3b1d6e,#1a0f2e);text-align:center">
        <div style="font-size:18px;font-weight:800">💰 Get paid to chat with fans</div>
        <div class="muted small" style="margin-top:4px">$1.49 per text · $3.99/min video · tips & PPV unlocks<br>Weekly payouts from Asce</div>
      </div>
      <label class="field">Display name (your stage name)<input class="input" id="i-name" maxlength="40"></label>
      <label class="field">Username<input class="input" id="i-user" autocomplete="username"></label>
      <label class="field">Password (6+ characters)${pwField('i-pass', 'new-password')}</label>
      <label class="field">Date of birth<input class="input" id="i-dob" type="date"></label>
      <div class="age-box">🔞 <b>18+ only.</b> Asce will verify your ID in person (2257 compliance) before you go live.</div>
      <label class="checkbox-row"><input type="checkbox" id="i-18">
        <span>I confirm I am <b>18 years or older</b>.</span></label>
      <button class="btn" id="i-go">Create model account</button>
      <button class="btn ghost" id="i-back" style="margin-top:12px">← Back</button>
    </div>`;

  $('#i-back').onclick = () => show('landing', {});
  $('#i-go').onclick = async () => {
    const display_name = $('#i-name').value.trim();
    const username = $('#i-user').value.trim();
    const password = $('#i-pass').value;
    const dob = $('#i-dob').value;
    const agree18 = $('#i-18').checked;
    if (!display_name || !username || !password || !dob) return toast('Fill in every field');
    if (!agree18) return toast('You must confirm you are 18+');
    const { status, data } = await api('/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ username, password, role: 'model', display_name, dob, agree18,
        guest_token: S.guestToken, invite_code: code }),
    });
    if (status === 200) return afterLogin(data);
    const msgs = { username_taken: 'Username is taken 😕', must_be_18: 'You must be 18 or older.',
      password_too_short: 'Password needs 6+ characters.',
      bad_invite: 'Invite link is invalid or revoked.', invite_used: 'Invite link already used.' };
    toast(msgs[data.error] || data.message || 'Signup failed.');
  };
}

/* Partner referral signup: model joins through a recruiter's link */
async function vRecruiterSignup(code) {
  let valid = false, recruiterName = '';
  try {
    const { status, data } = await api(`/referral/${encodeURIComponent(code)}`);
    valid = status === 200 && data.valid;
    recruiterName = data.recruiter_name || '';
  } catch { valid = false; }

  if (!valid) {
    app.innerHTML = `
      <div class="header"><h1>Slut<span class="logo">Camp</span></h1></div>
      <div class="screen"><div class="card" style="text-align:center">
        <div style="font-size:40px">⛔</div>
        <div style="font-weight:800;margin:8px 0">This referral link is invalid.</div>
        <div class="muted small">Ask the person who sent it for a fresh link.</div>
        <button class="btn ghost" style="margin-top:12px" onclick="show('landing',{})">← Back to browsing</button>
      </div></div>`;
    return;
  }

  app.innerHTML = `
    <div class="header"><h1>Slut<span class="logo">Camp</span> 💃</h1>
      <div class="sub">Invited by <b>${esc(recruiterName)}</b> 🤝</div></div>
    <div class="screen">
      <div class="card" style="background:linear-gradient(135deg,#3b1d6e,#1a0f2e);text-align:center">
        <div style="font-size:18px;font-weight:800">💰 Get paid to chat with fans</div>
        <div class="muted small" style="margin-top:4px">You keep 60% of everything · $1.49 per text · $3.99/min video<br>Weekly payouts from Asce</div>
      </div>
      <label class="field">Display name (your stage name)<input class="input" id="i-name" maxlength="40"></label>
      <label class="field">Username<input class="input" id="i-user" autocomplete="username"></label>
      <label class="field">Password (6+ characters)${pwField('i-pass', 'new-password')}</label>
      <label class="field">Date of birth<input class="input" id="i-dob" type="date"></label>
      <div class="age-box">🔞 <b>18+ only.</b> Asce will verify your ID in person (2257 compliance) before you go live.</div>
      <label class="checkbox-row"><input type="checkbox" id="i-18">
        <span>I confirm I am <b>18 years or older</b>.</span></label>
      <button class="btn" id="i-go">Create model account</button>
      <button class="btn ghost" id="i-back" style="margin-top:12px">← Back</button>
    </div>`;

  $('#i-back').onclick = () => show('landing', {});
  $('#i-go').onclick = async () => {
    const display_name = $('#i-name').value.trim();
    const username = $('#i-user').value.trim();
    const password = $('#i-pass').value;
    const dob = $('#i-dob').value;
    const agree18 = $('#i-18').checked;
    if (!display_name || !username || !password || !dob) return toast('Fill in every field');
    if (!agree18) return toast('You must confirm you are 18+');
    const { status, data } = await api('/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ username, password, role: 'model', display_name, dob, agree18,
        guest_token: S.guestToken, referral_code: code }),
    });
    if (status === 200) return afterLogin(data);
    const msgs = { username_taken: 'Username is taken 😕', must_be_18: 'You must be 18 or older.',
      password_too_short: 'Password needs 6+ characters.',
      bad_referral: 'Referral link is invalid.' };
    toast(msgs[data.error] || data.message || 'Signup failed.');
  };
}

async function afterLogin(data) {
  S.token = data.token;
  localStorage.setItem('wc_token', S.token);
  S.user = data.user;
  wsConnect();
  await refreshMe();
  renderBell();
  subscribePush();
  if (S.user.role === 'admin') show('admin', {});
  else if (S.user.role === 'model') {
    await checkContractGate();
    show('modelChats', {});
  }
  else if (S.user.role === 'recruiter') show('recruiter', {});
  else show('fanModels', {});
  toast(`Welcome, ${S.user.display_name}! 🎉`);
}

/* Contract gate: unsigned models get redirected to sign before doing anything */
async function checkContractGate() {
  if (!S.user || S.user.role !== 'model') return;
  try {
    const { status, data } = await api('/model/contract');
    S.contractSigned = status === 200 && !!data.signed;
    S.contractVersion = status === 200 ? data.version : null;
  } catch (e) { S.contractSigned = true; /* fail open on network error */ }
}

async function refreshMe() {
  const { status, data } = await api('/me');
  if (status === 200) {
    S.user = data.user; S.wallet = data.wallet; S.model = data.model || null;
    if (data.commission_pct !== undefined) S.commissionPct = data.commission_pct;
  } else if (status === 401 || status === 403) {
    logout(false);
  }
}

function logout(msg) {
  if (S.token) api('/auth/logout', { method: 'POST' }).catch(() => {});
  S.token = null; S.user = null; S.wallet = null; S.model = null;
  localStorage.removeItem('wc_token');
  if (S.ws) { try { S.ws.close(); } catch (e) {} S.ws = null; }
  show('landing', {});
  if (msg !== false) toast('Logged out.');
}

/* ---------------- FAN: models / chats / wallet ---------------- */

async function vFanModels() {
  const { data } = await api('/models');
  const models = data.models || [];
  await refreshMe();
  let following = [];
  try { const f = await api('/follows'); following = f.data.following || []; } catch (e) {}
  app.innerHTML = `
    <div class="header"><h1>Slut<span class="logo">Camp</span></h1>
      <div><span class="balance-pill">💰 ${fmt(S.wallet ? S.wallet.credits_cents : 0)}</span></div></div>
    <div class="screen">
      ${models.map((m) => `
        <button class="list-item" data-model="${m.id}" data-live="${m.live_session_id || ''}" style="background:var(--card);border-radius:14px;margin-bottom:10px;border:1px solid rgba(139,92,246,.18)">
          <span class="avatar-wrap">${avatarHTML(m.display_name, '', m.photo_url)}
            ${m.is_online ? '<span class="online-dot"></span>' : ''}</span>
          <span class="grow">
            <span class="title">${esc(m.display_name)}
              ${m.is_live ? ' <span class="live-badge">🔴 LIVE</span>' : ''}
              <span class="small" style="color:${m.is_online ? 'var(--green)' : 'var(--muted)'}">● ${m.is_online ? 'Online now' : 'Offline'}</span></span><br>
            <span class="preview">${esc(m.bio).slice(0, 70)}</span><br>
            <span class="small" style="color:var(--pink);font-weight:700">${fmt(m.per_message_cents)}/msg · ${fmt(m.per_minute_cents)}/min video</span>
            ${m.schedule_summary ? `<br><span class="small muted">📅 Usually live: ${esc(m.schedule_summary)}</span>` : ''}
            ${m.is_live ? `<br><span class="small" style="color:#f87171;font-weight:800">▶ Watch free preview — tap to join</span>` : ''}
          </span>
          <span class="follow-btn ${following.includes(m.id) ? 'following' : ''}" data-follow="${m.id}" title="Follow for live notifications">${following.includes(m.id) ? '❤️' : '🤍'}</span>
          <span style="font-size:22px">›</span>
        </button>`).join('')}
    </div>`;
  app.querySelectorAll('[data-model]').forEach((b) => {
    b.onclick = () => {
      const liveId = b.dataset.live;
      if (liveId) return watchLive(parseInt(liveId));
      openChatWithModel(parseInt(b.dataset.model));
    };
  });
  app.querySelectorAll('[data-follow]').forEach((f) => {
    f.onclick = (e) => { e.stopPropagation(); toggleFollow(parseInt(f.dataset.follow), f); };
  });
}

async function vFanChats() { return vChatList('fan'); }
async function vModelChats() { return vChatList('model'); }

/* ---------------- FAN: group live streams listing ---------------- */

async function vFanLive() {
  await refreshMe();
  const { data } = await api('/live');
  const streams = data.live || [];
  const { data: schedData } = await api('/live/schedule');
  const upcoming = (schedData.upcoming || []).slice(0, 10);
  app.innerHTML = `
    <div class="header"><h1>🔴 Live now</h1>
      <div><span class="balance-pill">💰 ${fmt(S.wallet ? S.wallet.credits_cents : 0)}</span></div></div>
    <div class="screen">
      ${streams.map((s) => `
        <button class="list-item" data-stream="${s.session_id}" style="background:var(--card);border-radius:14px;margin-bottom:10px;border:1px solid rgba(239,68,68,.35)">
          <span class="avatar-wrap">${avatarHTML(s.model_name, '', s.model_photo_url)}<span class="online-dot"></span></span>
          <span class="grow">
            <span class="title">${esc(s.model_name)} <span class="live-badge">🔴 LIVE</span></span><br>
            ${s.title ? `<span class="preview" style="font-weight:700;color:#fff">${esc(s.title)}</span><br>` : ''}
            <span class="small muted">👁 ${s.viewers} watching · 🎁 ${fmt(s.gift_cents || 0)} in gifts</span><br>
            <span class="small" style="color:#f87171;font-weight:800">▶ Join free — chat is free, gifts get you noticed</span>
          </span><span style="font-size:22px">›</span>
        </button>`).join('') || `
        <div class="empty"><div class="big">📺</div>No one's live right now.<br>
          <span class="small">Check back soon — your favorite models go live without warning 😈</span></div>`}
      ${upcoming.length ? `
      <div style="font-weight:800;margin:18px 0 10px">📅 Coming up</div>
      ${upcoming.map((u) => `
        <div class="list-item" style="background:var(--card);border-radius:14px;margin-bottom:10px;border:1px solid rgba(139,92,246,.18);cursor:default">
          <span class="avatar-wrap">${avatarHTML(u.model_name, '', u.photo_url)}</span>
          <span class="grow">
            <span class="title">${esc(u.model_name)}</span><br>
            ${u.title ? `<span class="small" style="color:#fff;font-weight:700">${esc(u.title)}</span><br>` : ''}
            <span class="small muted">📅 ${u.day_label} ${u.time_label}</span><br>
            <span class="small" style="color:var(--gold);font-weight:700">⏱ ${bookingCountdown(u.starts_at)}</span>
          </span>
        </div>`).join('')}` : ''}
    </div>`;
  app.querySelectorAll('[data-stream]').forEach((b) => {
    b.onclick = () => watchLive(parseInt(b.dataset.stream));
  });
}

async function vChatList(role) {
  const { data } = await api('/conversations');
  const convs = data.conversations || [];
  const title = role === 'model' ? 'Your chats 💬' : 'Chats 💬';
  app.innerHTML = `
    <div class="header"><h1>${title}</h1>
      ${role === 'model' && S.model ? `
      <div class="row" style="margin-top:8px">
        <button class="toggle ${S.model.is_online ? 'on' : ''}" id="online-toggle" aria-label="Go online or offline"></button>
        <span style="font-weight:800;font-size:17px">${S.model.is_online ? '🟢 ONLINE' : '⚫ OFFLINE'}</span>
      </div>
      <button class="btn" id="go-live-btn" style="margin-top:10px;background:linear-gradient(135deg,#ef4444,#b91c1c)">🔴 Go Live</button>
      <button class="btn ghost hidden" id="back-live-btn" style="margin-top:8px">↩️ Back to Live</button>` : ''}
    </div>
    <div class="screen" style="padding:8px">
      ${convs.map((c) => `
        <button class="list-item" data-conv="${c.id}">
          ${avatarHTML(c.other.display_name, 'sm', c.other.photo_url)}
          <span class="grow">
            <span class="title">${esc(c.other.display_name)}
              ${c.is_paused ? ' <span class="small" style="color:var(--red)">⏸ paused</span>' : ''}</span><br>
            <span class="preview">${c.last_message ? esc(c.last_message.body).slice(0, 60) : '<i>No messages yet</i>'}</span>
          </span>
          ${c.unread_count ? `<span class="unread-badge">${c.unread_count}</span>` : ''}
        </button>`).join('') || '<div class="empty"><div class="big">💬</div>No chats yet.<br><span class="small">Tap a model to start chatting!</span></div>'}
    </div>`;
  const tgl = $('#online-toggle');
  if (tgl) tgl.onclick = async () => {
    const next = S.model.is_online ? 0 : 1;
    const { status } = await api('/model/profile', {
      method: 'PUT', body: JSON.stringify({ is_online: next }) });
    if (status === 200) { S.model.is_online = next; show('modelChats', {}); toast(next ? '🟢 You are ONLINE' : '⚫ You are offline'); }
  };
  const glb = $('#go-live-btn');
  if (glb) glb.onclick = () => startLiveBroadcast();
  // Show "Back to Live" if she has an active session (e.g. got disconnected)
  const blb = $('#back-live-btn');
  if (blb) {
    api('/live/my-session').then(({ status, data }) => {
      if (status === 200 && data.session_id) {
        blb.classList.remove('hidden');
        blb.onclick = () => rejoinLiveBroadcast(data.session_id);
      }
    }).catch(() => {});
  }
  app.querySelectorAll('[data-conv]').forEach((b) => {
    b.onclick = async () => {
      const c = convs.find((x) => x.id === parseInt(b.dataset.conv));
      show('chat', { conv: c });
    };
  });
}

async function vWallet() {
  await refreshMe();
  const { data } = await api('/credits/packages');
  const pkgs = data.packages || [];
  app.innerHTML = `
    <div class="header"><h1>Wallet 💰</h1>
      <div><span class="balance-pill">Balance: ${fmt(S.wallet.credits_cents)}</span></div></div>
    <div class="screen">
      <div class="card" style="text-align:center">
        <div class="muted small">1 credit = $1. Messages cost the model's rate.</div>
      </div>
      ${pkgs.map((p) => `
        <button class="pkg" data-pkg="${p.id}">
          <span style="font-size:28px">🪙</span>
          <span class="amt">${p.credits_cents / 100} credits</span>
          <span class="price">${p.label}</span>
          ${p.descriptor ? `<span class="muted small" style="width:100%">${esc(p.descriptor)}</span>` : ''}
        </button>`).join('')}
      <button class="btn ghost" id="w-logout">Log out</button>
    </div>`;
  app.querySelectorAll('[data-pkg]').forEach((b) => {
    b.onclick = async () => {
      const { status, data: d } = await api('/credits/buy', {
        method: 'POST', body: JSON.stringify({ package: b.dataset.pkg }) });
      toast(d.message || 'Payment processor coming soon.');
    };
  });
  $('#w-logout').onclick = () => logout();
}

/* ---------------- MODEL: earnings / settings ---------------- */

async function vModelEarnings() {
  const { data } = await api('/model/earnings');
  const { data: acctData } = await api('/model/payout-account');
  const { data: wdData } = await api('/model/withdrawals');
  const acct = acctData.account;
  const wds = wdData.withdrawals || [];
  const wdBadge = (s) => s === 'pending' ? '⏳ Pending' : s === 'paid' ? '✅ Paid' : '❌ Rejected';
  app.innerHTML = `
    <div class="header"><h1>Earnings 💵</h1><div class="sub">You keep ${100 - (S.commissionPct || 40)}% of everything</div></div>
    <div class="screen">
      <div class="stat-grid">
        <div class="stat"><div class="n" style="color:var(--green)">${fmt(data.pending_cents)}</div><div class="l">Available for payout</div></div>
        <div class="stat"><div class="n">${fmt(data.earnings_cents)}</div><div class="l">Total earned</div></div>
      </div>
      ${data.gift_count ? `
      <div class="card" style="margin-top:12px">
        <div style="font-weight:800;margin-bottom:8px">🎁 Gifts received</div>
        <div class="row"><span class="grow muted small">${data.gift_count} gift${data.gift_count === 1 ? '' : 's'} from fans</span>
          <b style="color:var(--green)">${fmt(data.gifts_cents)}</b></div>
        <div class="muted small" style="margin-top:4px">Your 60% cut of every gift 💰</div>
      </div>` : ''}
      <div class="card" style="margin-top:12px">
        <div style="font-weight:800;margin-bottom:8px">📊 Revenue breakdown</div>
        ${(() => {
          const byType = {};
          (data.by_type || []).forEach((r) => { byType[r.type] = r; });
          const gifts = byType.gift ? byType.gift.earned_cents : 0;
          const lives = (byType.live_explicit ? byType.live_explicit.earned_cents : 0) +
                        (byType.call ? byType.call.earned_cents : 0);
          const dms = (byType.message ? byType.message.earned_cents : 0) +
                      (byType.voice ? byType.voice.earned_cents : 0) +
                      (byType.ppv ? byType.ppv.earned_cents : 0) +
                      (byType.tip ? byType.tip.earned_cents : 0);
          return `
          <div class="row" style="padding:10px;background:rgba(139,92,246,.1);border-radius:10px;margin-bottom:8px">
            <span class="grow"><b>🎁 Gifts</b></span><b style="color:var(--green)">${fmt(gifts)}</b>
          </div>
          <div class="row" style="padding:10px;background:rgba(236,72,153,.1);border-radius:10px;margin-bottom:8px">
            <span class="grow"><b>🔴 Lives</b> <span class="muted small">· explicit + video calls</span></span><b style="color:var(--green)">${fmt(lives)}</b>
          </div>
          <div class="row" style="padding:10px;background:rgba(59,130,246,.1);border-radius:10px;margin-bottom:12px">
            <span class="grow"><b>💬 Private DMs</b> <span class="muted small">· messages + voice + PPV + tips</span></span><b style="color:var(--green)">${fmt(dms)}</b>
          </div>`;
        })()}
        <div style="font-weight:700;margin:8px 0 4px" class="small muted">All activity</div>
        ${(data.by_type || []).map((r) => {
          const labels = { message: '💬 Chat messages', call: '📹 Video calls', tip: '💸 Tips',
            ppv: '🔒 PPV unlocks', voice: '🎤 Voice notes', live_explicit: '🔥 Explicit live', gift: '🎁 Gifts' };
          return `
          <div class="row" style="padding:8px 0;border-top:1px solid rgba(139,92,246,.1)">
            <span class="grow"><b>${labels[r.type] || esc(r.type)}</b> <span class="muted small">· ${r.n} payment${r.n === 1 ? '' : 's'}</span></span>
            <b style="color:var(--green)">${fmt(r.earned_cents)}</b>
          </div>`; }).join('') || '<div class="muted">No earnings yet — go online and chat! 💬</div>'}
      </div>
      <div class="card" style="margin-top:12px">
        <div style="font-weight:800;margin-bottom:8px">💸 Payouts</div>
        <div class="row" style="margin-bottom:8px"><span class="grow muted small">Bank account</span>
          ${acct ? `<b class="small">•••• ${esc(acct.account_last4)}</b>` : '<span class="small" style="color:var(--pink)">Not set</span>'}</div>
        ${acct ? `
          <div class="muted small" style="margin-bottom:8px">${esc(acct.holder_name)} · Routing ${esc(acct.routing_number)}</div>
          <div class="row">
            <input class="input" id="wd-amount" type="number" step="0.01" min="0" placeholder="Amount $" style="margin-top:0">
            <button class="btn small success" id="wd-go">Withdraw</button>
          </div>
          <div class="muted small" style="margin-top:6px">Available to withdraw: <b style="color:var(--green)">${fmt(wdData.available_cents)}</b></div>
        ` : ''}
        <div id="bank-form" class="${acct ? 'hidden' : ''}" style="margin-top:8px">
          <div style="font-weight:700;margin-bottom:6px">${acct ? 'Update bank account' : 'Add bank account'}</div>
          <label class="field">Account holder name<input class="input" id="ba-holder" maxlength="80" value="${acct ? esc(acct.holder_name) : ''}"></label>
          <label class="field">Routing number (9 digits)<input class="input" id="ba-routing" inputmode="numeric" maxlength="9" value="${acct ? esc(acct.routing_number) : ''}"></label>
          <label class="field">Account number${pwField('ba-account', 'off')}</label>
          <button class="btn" id="ba-save" style="margin-top:8px">Save bank account</button>
          <div class="muted small" style="margin-top:6px">🔒 Only Asce sees your full account number, to send your money.</div>
        </div>
        ${acct ? `<button class="btn ghost small" id="ba-toggle" style="margin-top:8px">✏️ Update bank account</button>` : ''}
      </div>
      ${wds.length ? `
      <div class="card" style="margin-top:12px">
        <div style="font-weight:800;margin-bottom:8px">Withdrawal history</div>
        ${wds.map((w) => `
          <div class="row small" style="padding:6px 0;border-top:1px solid rgba(139,92,246,.1)">
            <span class="grow"><b>${fmt(w.amount_cents)}</b> <span class="muted">· ${timeHM(w.requested_at)}</span>
              ${w.note ? `<br><span class="muted">${esc(w.note)}</span>` : ''}</span>
            <span>${wdBadge(w.status)}</span>
          </div>`).join('')}
      </div>` : ''}
      <div class="card" style="margin-top:12px">
        <div style="font-weight:800;margin-bottom:8px">Per fan</div>
        ${(data.by_fan || []).map((r) => `
          <div class="row" style="padding:8px 0;border-top:1px solid rgba(139,92,246,.1)">
            <span class="grow"><b>${esc(r.fan_name)}</b> <span class="muted small">· ${r.payments} payments</span></span>
            <b style="color:var(--green)">${fmt(r.earned_cents)}</b>
          </div>`).join('') || '<div class="muted">No earnings yet — go online and chat! 💬</div>'}
      </div>
      <div class="muted small" style="text-align:center">Payouts are sent by Asce. Available balance updates after each message.</div>
    </div>`;

  const baSave = $('#ba-save');
  if (baSave) baSave.onclick = async () => {
    baSave.disabled = true;
    const body = { holder_name: $('#ba-holder').value.trim(),
      routing_number: $('#ba-routing').value.trim(), account_number: $('#ba-account').value.trim() };
    const { status } = await api('/model/payout-account', { method: 'POST', body: JSON.stringify(body) });
    if (status === 200) { toast('✅ Bank account saved'); show('modelEarnings', {}); }
    else { toast('Check the fields — routing needs 9 digits'); baSave.disabled = false; }
  };
  const baToggle = $('#ba-toggle');
  if (baToggle) baToggle.onclick = () => { $('#bank-form').classList.toggle('hidden'); };
  const wdGo = $('#wd-go');
  if (wdGo) wdGo.onclick = async () => {
    const amount_cents = Math.round(parseFloat($('#wd-amount').value || '0') * 100);
    if (!amount_cents || amount_cents <= 0) return toast('Enter an amount');
    wdGo.disabled = true;
    const { status, data: wd } = await api('/model/withdrawals', {
      method: 'POST', body: JSON.stringify({ amount_cents }) });
    if (status === 200) { toast('⏳ Withdrawal requested — Asce will send it soon'); show('modelEarnings', {}); }
    else {
      toast(status === 400 && wd.error === 'insufficient_funds'
        ? `Not enough available (${fmt(wd.available_cents || 0)})`
        : status === 400 && wd.error === 'no_tax_info'
        ? '🧾 Add your tax info in Settings to withdraw — required by the IRS for payouts.'
        : 'Could not request withdrawal');
      if (status === 400 && wd.error === 'no_tax_info') show('modelSettings', {});
      wdGo.disabled = false;
    }
  };
}

/* ---------------- RECRUITER / PARTNER dashboard ---------------- */

async function vRecruiter() {
  const { data } = await api('/recruiter/dashboard');
  if (!data || !data.recruiter) { toast('Could not load dashboard'); return show('landing', {}); }
  const r = data.recruiter;
  const models = data.models || [];
  const link = `${window.location.origin}/#join/${r.referral_code}`;
  const { data: acctData } = await api('/model/payout-account');
  const { data: wdData } = await api('/model/withdrawals');
  const acct = acctData.account;
  const wds = wdData.withdrawals || [];
  const wdBadge = (s) => s === 'pending' ? '⏳ Pending' : s === 'paid' ? '✅ Paid' : '❌ Rejected';
  app.innerHTML = `
    <div class="header"><h1>Partner 🤝</h1><div class="sub">${esc(r.name)}${r.city ? ` · ${esc(r.city)}` : ''}</div></div>
    <div class="screen">
      <div class="card" style="background:linear-gradient(135deg,#3b1d6e,#1a0f2e)">
        <div style="font-weight:800;margin-bottom:6px">🔗 Your referral link</div>
        <div class="muted small" style="word-break:break-all;margin-bottom:8px">${esc(link)}</div>
        <button class="btn small" id="rc-copy">📋 Copy link</button>
        <div class="muted small" style="margin-top:8px">Send this to models — anyone who signs up through it is yours. You earn 20% of everything they make.</div>
      </div>
      <div class="stat-grid" style="margin-top:12px">
        <div class="stat"><div class="n">${data.model_count}</div><div class="l">Models recruited</div></div>
        <div class="stat"><div class="n" style="color:var(--green)">${fmt(data.earnings_cents)}</div><div class="l">Total earned (20%)</div></div>
        <div class="stat"><div class="n" style="color:var(--green)">${fmt(data.available_cents)}</div><div class="l">Available for payout</div></div>
      </div>
      <div class="card" style="margin-top:12px">
        <div style="font-weight:800;margin-bottom:8px">💃 Your models</div>
        ${models.map((m) => `
          <div class="row" style="padding:8px 0;border-top:1px solid rgba(139,92,246,.1);align-items:center">
            ${avatarHTML(m.display_name, 'sm', m.photo_url)}
            <span class="grow"><b>${esc(m.display_name)}</b> <span class="small muted">@${esc(m.username)}</span><br>
              <span class="small muted">Joined ${timeHM(m.created_at)}${m.banned ? ' · <span style="color:var(--red)">deactivated</span>' : ''}</span><br>
              <span class="small" style="color:var(--green)">Your cut: ${fmt(m.my_cut_cents)}</span>
              <span class="small muted"> · ${fmt(m.gross_generated_cents)} gross</span></span>
          </div>`).join('') || '<div class="muted">No models yet — share your link! 🔗</div>'}
      </div>
      <div class="card" style="margin-top:12px">
        <div style="font-weight:800;margin-bottom:8px">💸 Payouts</div>
        <div class="row" style="margin-bottom:8px"><span class="grow muted small">Bank account</span>
          ${acct ? `<b class="small">•••• ${esc(acct.account_last4)}</b>` : '<span class="small" style="color:var(--pink)">Not set</span>'}</div>
        ${acct ? `
          <div class="muted small" style="margin-bottom:8px">${esc(acct.holder_name)} · Routing ${esc(acct.routing_number)}</div>
          <div class="row">
            <input class="input" id="wd-amount" type="number" step="0.01" min="0" placeholder="Amount $" style="margin-top:0">
            <button class="btn small success" id="wd-go">Withdraw</button>
          </div>
          <div class="muted small" style="margin-top:6px">Available to withdraw: <b style="color:var(--green)">${fmt(wdData.available_cents)}</b></div>
        ` : ''}
        <div id="bank-form" class="${acct ? 'hidden' : ''}" style="margin-top:8px">
          <div style="font-weight:700;margin-bottom:6px">${acct ? 'Update bank account' : 'Add bank account'}</div>
          <label class="field">Account holder name<input class="input" id="ba-holder" maxlength="80" value="${acct ? esc(acct.holder_name) : ''}"></label>
          <label class="field">Routing number (9 digits)<input class="input" id="ba-routing" inputmode="numeric" maxlength="9" value="${acct ? esc(acct.routing_number) : ''}"></label>
          <label class="field">Account number${pwField('ba-account', 'off')}</label>
          <button class="btn" id="ba-save" style="margin-top:8px">Save bank account</button>
          <div class="muted small" style="margin-top:6px">🔒 Only Asce sees your full account number, to send your money.</div>
        </div>
        ${acct ? `<button class="btn ghost small" id="ba-toggle" style="margin-top:8px">✏️ Update bank account</button>` : ''}
      </div>
      ${wds.length ? `
      <div class="card" style="margin-top:12px">
        <div style="font-weight:800;margin-bottom:8px">Withdrawal history</div>
        ${wds.map((w) => `
          <div class="row small" style="padding:6px 0;border-top:1px solid rgba(139,92,246,.1)">
            <span class="grow"><b>${fmt(w.amount_cents)}</b> <span class="muted">· ${timeHM(w.requested_at)}</span>
              ${w.note ? `<br><span class="muted">${esc(w.note)}</span>` : ''}</span>
            <span>${wdBadge(w.status)}</span>
          </div>`).join('')}
      </div>` : ''}
      <div class="card" id="tax-card" style="margin-top:12px"><div class="muted small">Loading tax info…</div></div>
      <button class="btn ghost" id="r-logout" style="margin-top:12px">Log out</button>
    </div>`;

  $('#rc-copy').onclick = async () => {
    try { await navigator.clipboard.writeText(link); toast('Link copied 📋'); }
    catch { prompt('Copy your referral link:', link); }
  };
  $('#r-logout').onclick = () => logout();
  const baSave = $('#ba-save');
  if (baSave) baSave.onclick = async () => {
    baSave.disabled = true;
    const body = { holder_name: $('#ba-holder').value.trim(),
      routing_number: $('#ba-routing').value.trim(), account_number: $('#ba-account').value.trim() };
    const { status } = await api('/model/payout-account', { method: 'POST', body: JSON.stringify(body) });
    if (status === 200) { toast('✅ Bank account saved'); show('recruiter', {}); }
    else { toast('Check the fields — routing needs 9 digits'); baSave.disabled = false; }
  };
  const baToggle = $('#ba-toggle');
  if (baToggle) baToggle.onclick = () => { $('#bank-form').classList.toggle('hidden'); };
  const wdGo = $('#wd-go');
  if (wdGo) wdGo.onclick = async () => {
    const amount_cents = Math.round(parseFloat($('#wd-amount').value || '0') * 100);
    if (!amount_cents || amount_cents <= 0) return toast('Enter an amount');
    wdGo.disabled = true;
    const { status, data: wd } = await api('/model/withdrawals', {
      method: 'POST', body: JSON.stringify({ amount_cents }) });
    if (status === 200) { toast('⏳ Withdrawal requested — Asce will send it soon'); show('recruiter', {}); }
    else {
      toast(status === 400 && wd.error === 'insufficient_funds'
        ? `Not enough available (${fmt(wd.available_cents || 0)})`
        : status === 400 && wd.error === 'no_tax_info'
        ? '🧾 Add your tax info below to withdraw — required by the IRS for payouts.'
        : 'Could not request withdrawal');
      if (status === 400 && wd.error === 'no_tax_info') {
        const tc = $('#tax-card');
        if (tc) tc.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      wdGo.disabled = false;
    }
  };
  renderTaxCard('tax-card');
}

/* ---------------- BOOKINGS — private 1-on-1 scheduled lives ---------------- */

function bookingCountdown(at) {
  const ms = at - Date.now();
  if (ms <= 0) return 'now!';
  const m = Math.floor(ms / 60000);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `in ${h}h ${m % 60}m`;
  return `in ${Math.floor(h / 24)}d ${h % 24}h`;
}

function bookingWhen(at) {
  const d = new Date(at);
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) +
    ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

async function vBookings() {
  const { data } = await api('/bookings');
  const bookings = data.bookings || [];
  const isModel = S.user.role === 'model';
  const pending = bookings.filter((b) => b.status === 'pending');
  const upcoming = bookings.filter((b) => b.status === 'approved' || b.status === 'in_progress');
  app.innerHTML = `
    <div class="header"><h1>Bookings 📅</h1>
      <div class="sub">Private 1-on-1 lives — paid upfront</div></div>
    <div class="screen">
      ${isModel && pending.length ? `
      <div class="card" style="border-color:var(--gold)">
        <div style="font-weight:800;margin-bottom:8px">⏳ ${pending.length} request${pending.length > 1 ? 's' : ''} waiting</div>
        ${pending.map((b) => `
          <div class="row" style="margin-bottom:10px;align-items:center">
            <span class="grow"><b>${esc(b.other_name)}</b><br>
              <span class="small muted">${bookingWhen(b.scheduled_at)} · ${b.duration_min}min · <b style="color:var(--green)">${fmt(b.total_cents)}</b></span></span>
          </div>
          <div class="row" style="gap:8px;margin-bottom:12px">
            <button class="btn small" data-bk-approve="${b.id}">✅ Approve</button>
            <button class="btn small ghost" data-bk-decline="${b.id}">❌ Decline</button>
          </div>`).join('')}
      </div>` : ''}
      ${upcoming.length ? upcoming.map((b) => {
        const canGoLive = isModel && b.status === 'approved' &&
          Date.now() > b.scheduled_at - 15 * 60 * 1000;
        const canJoin = !isModel && b.status === 'in_progress';
        const waitingLive = !isModel && b.status === 'approved';
        return `
        <div class="card">
          <div class="row" style="align-items:center">
            ${b.other_photo_url ? `<div class="avatar sm"><img src="${esc(b.other_photo_url)}" alt=""></div>` : ''}
            <span class="grow"><b>${b.status === 'in_progress' ? '🔴 LIVE NOW' : '📅'} ${esc(b.other_name)}</b><br>
              <span class="small muted">${bookingWhen(b.scheduled_at)} · ${b.duration_min}min · ${fmt(b.total_cents)}</span><br>
              <span class="small" style="color:var(--gold);font-weight:700">${b.status === 'in_progress' ? 'In progress' : '⏱ ' + bookingCountdown(b.scheduled_at)}</span></span>
          </div>
          <div class="row" style="gap:8px;margin-top:10px">
            ${canGoLive ? `<button class="btn small" data-bk-start="${b.id}">🔴 Go Live Now</button>` : ''}
            ${canJoin ? `<button class="btn small" data-bk-join="${b.id}">📹 Join Private Session</button>` : ''}
            ${waitingLive ? `<span class="small muted">She'll go live at the scheduled time — you'll get a ping 📲</span>` : ''}
            ${['pending', 'approved'].includes(b.status) ? `<button class="btn small ghost" data-bk-cancel="${b.id}">Cancel</button>` : ''}
          </div>
        </div>`;
      }).join('') : (!pending.length ? `
      <div class="empty"><div class="big">📅</div>
        ${isModel ? 'No bookings yet. Fans can book you from chat — your per-minute rate × duration, paid upfront.' : 'No bookings yet. Tap 📅 on a model\'s chat to book a private live.'}
      </div>` : '')}
    </div>`;
  // Wire buttons
  app.querySelectorAll('[data-bk-approve]').forEach((b) => b.onclick = async () => {
    const { status } = await api(`/bookings/${b.dataset.bkApprove}/approve`, { method: 'POST' });
    toast(status === 200 ? '✅ Booking confirmed!' : 'Could not approve.');
    show('bookings', {});
  });
  app.querySelectorAll('[data-bk-decline]').forEach((b) => b.onclick = async () => {
    const { status, data } = await api(`/bookings/${b.dataset.bkDecline}/decline`, { method: 'POST' });
    toast(status === 200 ? `Declined — ${fmt(data.refunded_cents)} refunded to fan.` : 'Could not decline.');
    show('bookings', {});
  });
  app.querySelectorAll('[data-bk-cancel]').forEach((b) => b.onclick = async () => {
    if (!confirm('Cancel this booking?')) return;
    const { status, data } = await api(`/bookings/${b.dataset.bkCancel}/cancel`, { method: 'POST' });
    toast(status === 200
      ? (data.refunded_cents ? `Cancelled — ${fmt(data.refunded_cents)} refunded.` : 'Cancelled (no refund — inside 1 hour).')
      : 'Could not cancel.');
    show('bookings', {});
  });
  app.querySelectorAll('[data-bk-start]').forEach((b) => b.onclick = async () => {
    const { status } = await api(`/bookings/${b.dataset.bkStart}/start`, { method: 'POST' });
    if (status !== 200) return toast('Could not start.');
    startBookingCall(parseInt(b.dataset.bkStart), true);
  });
  app.querySelectorAll('[data-bk-join]').forEach((b) => b.onclick = () => {
    startBookingCall(parseInt(b.dataset.bkJoin), false);
  });
}

// Open the prepaid private video session for a booking (reuses 1-on-1 call UI)
async function startBookingCall(bookingId, isModel) {
  const { status, data } = await api(`/bookings/${bookingId}/call`, { method: 'POST' });
  if (status !== 200) return toast('Could not open session.');
  const callId = data.call_id;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (e) { return toast('Camera/mic permission needed 📹'); }
  pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
  pc.onicecandidate = (e) => {
    if (e.candidate && S.ws) S.ws.send(JSON.stringify({ type: 'signal', to: data.other_id,
      payload: { kind: 'ice', call_id: callId, candidate: e.candidate } }));
  };
  pc.ontrack = (e) => { $('#remote-video').srcObject = e.streams[0]; };
  if (!isModel) {
    // Fan initiates the WebRTC offer to the model
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    S.ws.send(JSON.stringify({ type: 'signal', to: data.other_id,
      payload: { kind: 'invite', call_id: callId, sdp: offer,
                 from_name: S.user.display_name, rate: 0, booking: true } }));
    S.call = { id: callId, rate: 0, seconds: 0, minutes: 0, role: 'fan', bookingId };
    toast('Calling… waiting for her to pick up 📞');
  } else {
    // Model waits for the fan's offer (or initiates if fan already waiting)
    S.call = { id: callId, rate: 0, seconds: 0, minutes: 0, role: 'model', bookingId,
               from: data.other_id, fromName: data.other_name };
    $('#call-name').textContent = data.other_name || 'Fan';
    $('#call-overlay').classList.remove('hidden');
    toast('Waiting for fan to join… 📹');
  }
  $('#active-call').classList.remove('hidden');
  $('#local-video').srcObject = localStream;
  $('#call-timer').textContent = 'Private session 💋';
  callTimerInt = setInterval(() => { S.call.seconds++; updateCallHUD(); }, 1000);
}

// Handle booking WS pushes
function handleBookingPush(m) {
  if (!S.user) return;
  if (m.type === 'booking:request' && S.user.role === 'model') {
    toast(`📅 ${m.fan_name} booked you!`, 4000);
    if (S.view === 'bookings') show('bookings', {});
  } else if (m.type === 'booking:approved' && S.user.role === 'fan') {
    toast('✅ She confirmed your booking!', 4000);
    if (S.view === 'bookings') show('bookings', {});
  } else if ((m.type === 'booking:declined' || m.type === 'booking:no_show' ||
              m.type === 'booking:cancelled') && S.user.role === 'fan') {
    toast(m.type === 'booking:cancelled' && !m.refunded_cents
      ? 'Booking cancelled (no refund — inside 1 hour).'
      : `Refunded ${fmt(m.refunded_cents || 0)}`, 4000);
    if (S.view === 'bookings') show('bookings', {});
  } else if (m.type === 'booking:live' && S.user.role === 'fan') {
    toast("🔴 She's live! Tap to join your private session.", 5000);
    if (S.view === 'bookings') show('bookings', {});
  } else if (m.type === 'booking:completed') {
    if (S.view === 'bookings') show('bookings', {});
  }
}

// Bottom sheet: book a private 1-on-1 live (date + time + duration, pay upfront)
function openBookingSheet(modelId, modelName, rateCents) {
  const rate = rateCents || 399;
  const today = new Date();
  const minDate = today.toISOString().slice(0, 10);
  const maxD = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);
  const maxDate = maxD.toISOString().slice(0, 10);
  const sheet = document.createElement('div');
  sheet.className = 'sheet-backdrop';
  sheet.innerHTML = `
    <div class="sheet">
      <div style="font-weight:800;font-size:18px;margin-bottom:4px">📅 Book ${esc(modelName)}</div>
      <div class="muted small" style="margin-bottom:12px">Private 1-on-1 live · ${fmt(rate)}/min · paid upfront</div>
      <label class="field">Date<input class="input" id="bk-date" type="date" min="${minDate}" max="${maxDate}" value="${minDate}"></label>
      <label class="field">Time<input class="input" id="bk-time" type="time" value="20:00"></label>
      <div class="field">Duration
        <div class="row" style="gap:8px;margin-top:6px" id="bk-durs">
          ${[15, 30, 60].map((d, i) => `
            <button class="btn ${i === 1 ? '' : 'ghost'} small" data-dur="${d}"
              style="flex:1">${d} min<br><span class="small">${fmt(rate * d)}</span></button>`).join('')}
        </div></div>
      <div class="row" style="margin:12px 0;align-items:center">
        <span class="grow" style="font-weight:800">Total</span>
        <b id="bk-total" style="font-size:20px;color:var(--green)">${fmt(rate * 30)}</b>
      </div>
      <button class="btn" id="bk-pay">Pay & Request</button>
      <button class="btn ghost" id="bk-cancel" style="margin-top:8px">Cancel</button>
    </div>`;
  document.body.appendChild(sheet);
  let dur = 30;
  const close = () => sheet.remove();
  sheet.querySelectorAll('[data-dur]').forEach((b) => b.onclick = () => {
    dur = parseInt(b.dataset.dur);
    sheet.querySelectorAll('[data-dur]').forEach((x) => x.classList.add('ghost'));
    b.classList.remove('ghost');
    sheet.querySelector('#bk-total').textContent = fmt(rate * dur);
  });
  sheet.querySelector('#bk-cancel').onclick = close;
  sheet.onclick = (e) => { if (e.target === sheet) close(); };
  sheet.querySelector('#bk-pay').onclick = async () => {
    const date = sheet.querySelector('#bk-date').value;
    const time = sheet.querySelector('#bk-time').value;
    if (!date || !time) return toast('Pick a date and time');
    const scheduled_at = new Date(`${date}T${time}`).getTime();
    if (!scheduled_at || scheduled_at < Date.now() + 60 * 60 * 1000)
      return toast('Book at least 1 hour ahead');
    const btn = sheet.querySelector('#bk-pay');
    btn.disabled = true;
    const { status, data } = await api('/bookings', {
      method: 'POST', body: JSON.stringify({ model_id: modelId, scheduled_at, duration_min: dur }) });
    if (status === 200) {
      close();
      toast(`⏳ Request sent! She'll confirm soon.`);
      show('bookings', {});
    } else {
      btn.disabled = false;
      toast(data.error === 'insufficient_credits'
        ? `Need ${fmt(data.needed_cents)} — top up first 💰`
        : (data.message || 'Could not book.'));
    }
  };
}

async function vModelSettings() {
  await refreshMe();
  const m = S.model;
  const { data: idvData } = await api('/model/id-verification');
  const idv = (idvData && idvData.verification) || null;
  const idvStatus = idv ? idv.status : 'none';
  const idvBanner = idvStatus === 'approved'
    ? `<div class="card" style="border-color:var(--green)"><div style="font-weight:800;color:var(--green)">✅ ID Verified</div><div class="small muted">Your identity is verified. You're cleared to chat and go live.</div></div>`
    : idvStatus === 'pending'
    ? `<div class="card" style="border-color:var(--yellow)"><div style="font-weight:800;color:var(--yellow)">⏳ ID Under Review</div><div class="small muted">Submitted ${esc(idv.submitted_at || '')}. Asce will review it soon — you can't chat or go live until it's approved.</div></div>`
    : `<div class="card" style="border-color:var(--red)">
        <div style="font-weight:800;margin-bottom:6px">🪪 ID Verification ${idvStatus === 'rejected' ? '<span style="color:var(--red)">— Action Needed</span>' : '<span style="color:var(--red)">— Required</span>'}</div>
        ${idvStatus === 'rejected' ? `<div class="small" style="color:var(--red);margin-bottom:8px">Rejected${idv.reviewer_note ? `: ${esc(idv.reviewer_note)}` : ''} — please resubmit.</div>` : ''}
        <div class="muted small" style="margin-bottom:10px">Federal law (18 U.S.C. §2257) requires us to verify your identity and age before you can chat with fans or go live. Upload a clear photo of:<br>1️⃣ Government ID — <b>front</b><br>2️⃣ Government ID — <b>back</b><br>3️⃣ A <b>selfie of you holding the ID</b> next to your face<br>Your documents are kept private and only reviewed by Asce.</div>
        <label class="field">ID front<input class="input" type="file" id="idv-front" accept="image/*"></label>
        <label class="field">ID back<input class="input" type="file" id="idv-back" accept="image/*"></label>
        <label class="field">Selfie holding ID<input class="input" type="file" id="idv-selfie" accept="image/*"></label>
        <button class="btn" id="idv-submit">Submit for verification</button>
      </div>`;
  app.innerHTML = `
    <div class="header"><h1>Settings ⚙️</h1></div>
    <div class="screen">
      ${idvBanner}
      <div class="card">
        <div style="font-weight:800;margin-bottom:6px">💵 My Rates</div>
        <div class="muted small" style="margin-bottom:10px">What fans pay for 1-on-1 with you. You set these — Asce can also adjust them.</div>
        <label class="field">💬 Per text: <b id="s-msg-label">${fmt(m.per_message_cents || 149)}</b>
          <input type="range" id="s-msg" min="50" max="1000" step="25" value="${m.per_message_cents || 149}" style="width:100%"></label>
        <label class="field">📹 Per minute video: <b id="s-min-label">${fmt(m.per_minute_cents || 399)}</b>
          <input type="range" id="s-min" min="100" max="2000" step="25" value="${m.per_minute_cents || 399}" style="width:100%"></label>
        <label class="field">🎙️ Per voice note: <b id="s-voice-label">${fmt(m.per_voice_cents || 299)}</b>
          <input type="range" id="s-voice" min="50" max="1000" step="25" value="${m.per_voice_cents || 299}" style="width:100%"></label>
        <label class="field">Live explicit rate — per minute ($)<input class="input" id="s-exp" type="number" step="0.01" min="0" value="${((m.explicit_rate_cents || 499) / 100).toFixed(2)}"></label>
        <div class="muted small" style="margin-top:6px">Fans watch your live stream free until the AI detects explicit content (or you tap "Go Explicit") — then they pay this rate per minute to keep watching unblurred.</div>
        <button class="btn" id="s-save">Save rates</button>
      </div>
      <div class="card">
        <div style="font-weight:800;margin-bottom:6px">🔞 Explicit stage rates</div>
        <div class="muted small" style="margin-bottom:10px">What fans pay to join you <b>on camera/mic while you're explicit</b>. Regular (non-explicit) joins stay $10 video+mic / $5 mic-only.</div>
        <label class="field">🎥 Explicit video + mic join: <b id="s-ejv-label">${fmt(m.explicit_join_cents || 2500)}</b>
          <input type="range" id="s-ejv" min="500" max="10000" step="100" value="${m.explicit_join_cents || 2500}" style="width:100%"></label>
        <label class="field">🎙️ Explicit mic join: <b id="s-ejm-label">${fmt(m.explicit_mic_join_cents || 1500)}</b>
          <input type="range" id="s-ejm" min="500" max="10000" step="100" value="${m.explicit_mic_join_cents || 1500}" style="width:100%"></label>
        <button class="btn" id="s-ej-save" style="margin-top:8px">Save stage rates</button>
      </div>
      <div class="card">
        <div style="font-weight:800;margin-bottom:6px">📅 My Live Schedule</div>
        <div class="muted small" style="margin-bottom:10px">Set regular weekly times, go live spontaneously anytime, or both. Fans see your schedule on the Live tab.</div>
        <div id="sched-list"><span class="muted small">Loading…</span></div>
        <div class="row" style="gap:8px;margin-top:10px">
          <select class="input" id="sched-day" style="flex:1">
            <option value="1">Monday</option><option value="2">Tuesday</option>
            <option value="3">Wednesday</option><option value="4">Thursday</option>
            <option value="5">Friday</option><option value="6">Saturday</option>
            <option value="0">Sunday</option>
          </select>
          <input class="input" id="sched-time" type="time" value="20:00" style="flex:1">
        </div>
        <input class="input" id="sched-title" placeholder="Title (optional) — e.g. Late night hangout" maxlength="60" style="margin-top:8px">
        <button class="btn" id="sched-add" style="margin-top:8px">Add slot</button>
      </div>
      <div class="card">
        <div style="font-weight:800;margin-bottom:6px">Bio</div>
        <textarea class="input" id="s-bio" rows="3" maxlength="280">${esc(m.bio)}</textarea>
        <button class="btn" id="s-bio-save">Save bio</button>
      </div>
      <div class="card">
        <div style="font-weight:800;margin-bottom:6px">My Photo</div>
        <div class="row" style="align-items:center">
          ${avatarHTML(m.display_name || (S.user && S.user.display_name) || '?', 'sm', m.photo_url)}
          <span class="grow muted small">Fans see this next to your name in chats and on the model grid.</span>
        </div>
        <button class="btn ghost" id="s-photo" style="margin-top:8px">📷 Change my photo</button>
      </div>
      <div class="card" id="tax-card"><div class="muted small">Loading tax info…</div></div>
      <button class="btn ghost" id="s-logout">Log out</button>
      <div class="card" id="tipmenu-card" style="margin-top:12px">
        <div style="font-weight:800;margin-bottom:6px">💰 Tip Menu</div>
        <div class="muted small" style="margin-bottom:10px">Fans pick from your menu and pay instantly — like TikTok gifts but your own custom list. You keep 60% of every tip.</div>
        <div id="tipmenu-list"><span class="muted small">Loading…</span></div>
        <div class="row" style="gap:8px;margin-top:10px">
          <input class="input" id="tm-emoji" placeholder="😈" maxlength="8" style="flex:0 0 52px;text-align:center;font-size:20px">
          <input class="input" id="tm-label" placeholder="e.g. Blow a kiss" maxlength="60" style="flex:2">
          <input class="input" id="tm-price" type="number" step="0.01" min="1" max="1000" placeholder="$" style="flex:1">
        </div>
        <button class="btn" id="tm-add" style="margin-top:8px">➕ Add tip item</button>
      </div>
    </div>`;
  $('#s-save').onclick = async () => {
    const per_message_cents = parseInt($('#s-msg').value);
    const per_minute_cents = parseInt($('#s-min').value);
    const per_voice_cents = parseInt($('#s-voice').value);
    const explicit_rate_cents = Math.round(parseFloat($('#s-exp').value || '0') * 100);
    const { status } = await api('/model/profile', {
      method: 'PUT', body: JSON.stringify({ per_message_cents, per_minute_cents, per_voice_cents, explicit_rate_cents }) });
    toast(status === 200 ? '✅ Rates saved!' : 'Could not save.');
    if (status === 200) refreshMe();
  };
  // My Rates sliders — live label updates
  const sMsg = $('#s-msg'), sMin = $('#s-min'), sVoice = $('#s-voice');
  if (sMsg) sMsg.oninput = () => { $('#s-msg-label').textContent = fmt(parseInt(sMsg.value)); };
  if (sMin) sMin.oninput = () => { $('#s-min-label').textContent = fmt(parseInt(sMin.value)); };
  if (sVoice) sVoice.oninput = () => { $('#s-voice-label').textContent = fmt(parseInt(sVoice.value)); };
  $('#s-bio-save').onclick = async () => {
    const { status } = await api('/model/profile', {
      method: 'PUT', body: JSON.stringify({ bio: $('#s-bio').value }) });
    toast(status === 200 ? '✅ Bio saved!' : 'Could not save.');
  };
  // Explicit stage rate sliders — live label updates
  const ejv = $('#s-ejv'), ejm = $('#s-ejm');
  if (ejv) ejv.oninput = () => { $('#s-ejv-label').textContent = fmt(parseInt(ejv.value)); };
  if (ejm) ejm.oninput = () => { $('#s-ejm-label').textContent = fmt(parseInt(ejm.value)); };
  const ejSave = $('#s-ej-save');
  if (ejSave) ejSave.onclick = async () => {
    const explicit_join_cents = parseInt(ejv.value);
    const explicit_mic_join_cents = parseInt(ejm.value);
    const { status } = await api('/model/profile', {
      method: 'PUT', body: JSON.stringify({ explicit_join_cents, explicit_mic_join_cents }) });
    toast(status === 200 ? '✅ Stage rates saved!' : 'Could not save.');
    if (status === 200) refreshMe();
  };
  // Live schedule slots
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  async function loadSched() {
    const { data } = await api('/model/schedule');
    const slots = data.slots || [];
    $('#sched-list').innerHTML = slots.length ? slots.map((s) => `
      <div class="row" style="align-items:center;margin-bottom:6px">
        <span class="grow">📅 <b>${DAYS[s.day_of_week]}</b> ${esc(s.start_time)}${s.title ? ` — ${esc(s.title)}` : ''}</span>
        <button class="btn small ghost" data-sched-del="${s.id}">✕</button>
      </div>`).join('') : '<span class="muted small">No regular slots — add one above, or just go live whenever.</span>';
    $('#sched-list').querySelectorAll('[data-sched-del]').forEach((b) => b.onclick = async () => {
      await api(`/model/schedule/${b.dataset.schedDel}`, { method: 'DELETE' });
      loadSched();
    });
  }
  loadSched();
  $('#sched-add').onclick = async () => {
    const { status, data } = await api('/model/schedule', { method: 'POST',
      body: JSON.stringify({ day_of_week: parseInt($('#sched-day').value),
        start_time: $('#sched-time').value, title: $('#sched-title').value }) });
    if (status === 200) { $('#sched-title').value = ''; loadSched(); toast('✅ Slot added!'); }
    else toast(data.error === 'duplicate' ? 'That slot already exists.' : 'Could not add slot.');
  };
  $('#s-photo').onclick = () => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*';
    inp.onchange = async () => {
      const file = inp.files[0];
      if (!file) return;
      toast('Uploading photo…');
      const { status, data } = await apiUpload('/model/photo', file);
      if (status === 200 && data.ok) {
        toast('📷 Photo updated!');
        await refreshMe();
        show('modelSettings', {});
      } else toast('Upload failed — use a JPG/PNG under 5MB.');
    };
    inp.click();
  };
  $('#s-logout').onclick = () => logout();
  renderTaxCard('tax-card');
  // 💰 Tip menu CRUD
  async function loadTipMenu() {
    const { data } = await api(`/models/${S.user.id}/tip-menu`);
    const items = data.items || [];
    const list = $('#tipmenu-list');
    if (!list) return;
    list.innerHTML = items.length ? items.map((t) => `
      <div class="row" style="align-items:center;margin-bottom:6px;gap:8px">
        <span style="font-size:22px">${t.emoji}</span>
        <span class="grow"><b>${esc(t.label)}</b> <span class="muted small">${fmt(t.price_cents)}</span></span>
        <button class="btn small ghost" data-tm-edit="${t.id}">✏️</button>
        <button class="btn small ghost" data-tm-del="${t.id}">✕</button>
      </div>`).join('')
      : '<span class="muted small">No tip items yet — add your first one above!</span>';
    list.querySelectorAll('[data-tm-del]').forEach((b) => b.onclick = async () => {
      if (!confirm('Delete this tip item?')) return;
      await api(`/model/tip-menu/${b.dataset.tmDel}`, { method: 'DELETE' });
      loadTipMenu();
    });
    list.querySelectorAll('[data-tm-edit]').forEach((b) => b.onclick = async () => {
      const item = items.find((x) => x.id == b.dataset.tmEdit);
      const label = prompt('Label:', item.label);
      if (label === null) return;
      const price = prompt('Price ($):', (item.price_cents / 100).toFixed(2));
      if (price === null) return;
      const emoji = prompt('Emoji:', item.emoji) || item.emoji;
      const { status } = await api(`/model/tip-menu/${item.id}`, { method: 'PUT',
        body: JSON.stringify({ emoji, label, price_cents: Math.round(parseFloat(price) * 100) }) });
      toast(status === 200 ? '✅ Updated!' : 'Could not update.');
      if (status === 200) loadTipMenu();
    });
  }
  loadTipMenu();
  const tmAdd = $('#tm-add');
  if (tmAdd) tmAdd.onclick = async () => {
    const emoji = $('#tm-emoji').value.trim() || '💰';
    const label = $('#tm-label').value.trim();
    const price = parseFloat($('#tm-price').value);
    if (!label) return toast('Give the tip item a name.');
    if (!price || price < 1 || price > 1000) return toast('Price must be $1–$1,000.');
    const { status } = await api('/model/tip-menu', { method: 'POST',
      body: JSON.stringify({ emoji, label, price_cents: Math.round(price * 100) }) });
    if (status === 200) {
      $('#tm-emoji').value = ''; $('#tm-label').value = ''; $('#tm-price').value = '';
      loadTipMenu();
      toast('✅ Tip item added!');
    } else toast('Could not add tip item.');
  };
  // 🪪 ID verification submit (3 files via multipart)
  const idvBtn = $('#idv-submit');
  if (idvBtn) idvBtn.onclick = async () => {
    const front = $('#idv-front').files[0], back = $('#idv-back').files[0], selfie = $('#idv-selfie').files[0];
    if (!front || !back || !selfie) return toast('Please attach all 3 photos.');
    for (const f of [front, back, selfie]) {
      if (!/^image\/(jpeg|png|webp)$/.test(f.type)) return toast('Photos must be JPG or PNG.');
      if (f.size > 8 * 1024 * 1024) return toast('Each photo must be under 8MB.');
    }
    toast('Uploading ID…');
    idvBtn.disabled = true;
    const fd = new FormData();
    fd.append('id_front', front); fd.append('id_back', back); fd.append('selfie', selfie);
    const headers = {};
    if (S.token) headers['Authorization'] = 'Bearer ' + S.token;
    let status = 0, data = {};
    try {
      const r = await fetch('/api/model/id-verification', { method: 'POST', headers, body: fd });
      status = r.status;
      try { data = await r.json(); } catch (e) { /* non-JSON */ }
    } catch (e) { /* network */ }
    idvBtn.disabled = false;
    if (status === 200 && data.ok) {
      toast('✅ Submitted! Asce will review your ID soon.');
      show('modelSettings', {});
    } else toast(data.message || 'Upload failed — try again.');
  };
}

/* ---------------- W-9 TAX INFO (models + partners, shared) ---------------- */
// Renders the tax-info card into a container: masked "on file" view or the W-9 form.
const US_STATE_OPTS = ['AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'];

async function renderTaxCard(containerId) {
  const box = document.getElementById(containerId);
  if (!box) return;
  const { status, data } = await api('/tax-profile');
  if (status !== 200) { box.innerHTML = '<div class="muted small">Could not load tax info.</div>'; return; }
  const p = data.profile;
  if (p) {
    box.innerHTML = `
      <div style="font-weight:800;margin-bottom:6px">🧾 Tax Info <span style="color:var(--green);font-size:13px">✓ On file</span></div>
      <div class="small" style="margin-bottom:4px"><b>${esc(p.legal_name)}</b>${p.business_name ? ` <span class="muted">(${esc(p.business_name)})</span>` : ''}</div>
      <div class="small muted">${p.tax_id_type === 'ein' ? 'EIN' : 'SSN'}: <b>${esc(p.tax_id_masked)}</b></div>
      <div class="small muted">${esc(p.address_line1)}${p.address_line2 ? ', ' + esc(p.address_line2) : ''}<br>${esc(p.city)}, ${esc(p.state)} ${esc(p.zip)}</div>
      <div class="muted small" style="margin-top:6px">🔒 Your SSN/EIN is encrypted — only the last 4 are shown.</div>
      ${p.electronic_1099_consent
        ? `<div class="small" style="margin-top:8px;color:var(--green)">📧 Digital 1099 delivery: <b>ON</b></div>
           <button class="btn ghost small" id="tax-1099" style="margin-top:8px">📄 Download my 1099 summary</button>`
        : `<div class="small muted" style="margin-top:8px">📧 Digital 1099 delivery: <b>OFF</b> — update your info below to turn it on.</div>`}
      <button class="btn ghost small" id="tax-edit" style="margin-top:8px">✏️ Update tax info</button>`;
    $('#tax-edit').onclick = () => renderTaxForm(box, p);
    const b1099 = $('#tax-1099');
    if (b1099) b1099.onclick = async () => {
      const year = new Date().getFullYear();
      const { status, data } = await api(`/tax-profile/1099/${year}`);
      if (status !== 200) return toast(data.message || 'Could not load 1099');
      const w = window.open('', '_blank');
      w.document.write(`<html><head><title>1099 Summary ${year}</title><meta name="viewport" content="width=device-width,initial-scale=1">
        <style>body{font-family:sans-serif;max-width:600px;margin:20px auto;padding:20px}h1{font-size:22px}.row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #ddd}</style>
        </head><body>
        <h1>📄 Earnings Summary ${year} (1099-NEC)</h1>
        <p><b>Payer:</b> Phoenix WOG LLC</p>
        <p><b>Recipient:</b> ${data.recipient.legal_name}<br>
        ${data.recipient.address_line1}<br>${data.recipient.city}, ${data.recipient.state} ${data.recipient.zip}<br>
        Tax ID: ${data.recipient.tax_id_masked}</p>
        <div class="row"><span>Total paid out (${year}):</span><b>$${data.total_dollars}</b></div>
        <p style="margin-top:16px;font-size:14px;color:#555">${data.note}</p>
        <p style="font-size:12px;color:#888">This is a summary for your records. The official 1099-NEC is filed with the IRS.</p>
        <button onclick="window.print()" style="padding:12px 24px;font-size:16px;margin-top:12px">🖨️ Print / Save PDF</button>
        </body></html>`);
      w.document.close();
    };
    return;
  }
  renderTaxForm(box, null);
}

function renderTaxForm(box, p) {
  const v = (k) => p ? esc(p[k] || '') : '';
  box.innerHTML = `
    <div style="font-weight:800;margin-bottom:6px">🧾 Tax Info (W-9)</div>
    <div class="muted small" style="margin-bottom:10px">Required by the IRS before you can withdraw payouts. This is the info that goes on your 1099 at tax time.</div>
    <label class="field">Legal name (as on your tax return)<input class="input" id="tax-legal" maxlength="120" value="${v('legal_name')}" placeholder="Jane A. Doe"></label>
    <label class="field">Business name (optional)<input class="input" id="tax-biz" maxlength="120" value="${v('business_name')}" placeholder="Leave blank if none"></label>
    <div class="row" style="gap:8px">
      <label class="field" style="flex:1">ID type
        <select class="input" id="tax-idtype">
          <option value="ssn"${p && p.tax_id_type === 'ssn' ? ' selected' : ''}>SSN</option>
          <option value="ein"${p && p.tax_id_type === 'ein' ? ' selected' : ''}>EIN</option>
        </select></label>
      <label class="field" style="flex:2">${p ? 'Tax ID (leave blank to keep current)' : 'SSN or EIN (9 digits)'}<input class="input" id="tax-id" inputmode="numeric" maxlength="11" placeholder="${p ? '••••' : '123-45-6789'}"></label>
    </div>
    <label class="field">Street address<input class="input" id="tax-addr1" maxlength="120" value="${v('address_line1')}" placeholder="123 Main St"></label>
    <label class="field">Apt / Suite (optional)<input class="input" id="tax-addr2" maxlength="120" value="${v('address_line2')}"></label>
    <div class="row" style="gap:8px">
      <label class="field" style="flex:2">City<input class="input" id="tax-city" maxlength="80" value="${v('city')}"></label>
      <label class="field" style="flex:1">State
        <select class="input" id="tax-state">${US_STATE_OPTS.map((s) =>
          `<option value="${s}"${p && p.state === s ? ' selected' : ''}>${s}</option>`).join('')}</select></label>
      <label class="field" style="flex:1">ZIP<input class="input" id="tax-zip" inputmode="numeric" maxlength="10" value="${v('zip')}" placeholder="12345"></label>
    </div>
    <button class="btn" id="tax-save" style="margin-top:8px">💾 Save tax info</button>
    <label style="display:flex;gap:8px;align-items:flex-start;margin-top:12px;cursor:pointer">
      <input type="checkbox" id="tax-econsent" style="margin-top:4px" ${p && p.electronic_1099_consent ? 'checked' : ''}>
      <span class="small">📧 I agree to receive my 1099 tax form <b>digitally</b> (in the app) instead of by mail. I can download it anytime.</span>
    </label>
    <div class="muted small" style="margin-top:6px">🔒 Encrypted on our server. Only Asce can use this for your 1099 — it's never shown to fans.</div>`;
  $('#tax-save').onclick = async () => {
    const body = {
      legal_name: $('#tax-legal').value, business_name: $('#tax-biz').value,
      tax_id_type: $('#tax-idtype').value, tax_id: $('#tax-id').value,
      address_line1: $('#tax-addr1').value, address_line2: $('#tax-addr2').value,
      city: $('#tax-city').value, state: $('#tax-state').value, zip: $('#tax-zip').value,
      electronic_1099_consent: $('#tax-econsent').checked,
    };
    const btn = $('#tax-save');
    btn.disabled = true;
    const { status, data } = await api('/tax-profile', { method: 'POST', body: JSON.stringify(body) });
    if (status === 200) { toast('✅ Tax info saved'); return renderTaxCard(box.id); }
    btn.disabled = false;
    const errs = { bad_legal_name: 'Enter your legal name', bad_tax_id: 'Enter a valid 9-digit SSN or EIN',
      bad_address: 'Enter your street address', bad_city: 'Enter your city',
      bad_state: 'Pick your state', bad_zip: 'Enter a valid ZIP (12345)',
      tax_unavailable: 'Tax service is down — try again in a bit' };
    toast(errs[data.error] || 'Could not save — check the fields');
  };
}

/* ---------------- CHAT SCREEN (shared) ---------------- */

async function vChat(params) {
  let conv = params.conv;
  if (!conv) { show('landing', {}); return; }
  S.conv = conv;

  // Refresh conversation state (paused? free left?)
  const { data: cl } = await api('/conversations');
  const fresh = (cl.conversations || []).find((c) => c.id === conv.id);
  if (fresh) { S.conv = Object.assign(conv, fresh); conv = S.conv; }

  const isModel = S.user && S.user.role === 'model';
  const other = conv.other;
  const canVideo = S.user && S.user.role === 'fan' && other.is_online && !conv.is_paused;

  app.innerHTML = `
    <div class="chat-header">
      <button class="icon-btn" id="c-back">‹</button>
      ${avatarHTML(other.display_name, 'sm', other.photo_url)}
      <div class="grow">
        <div class="name">${esc(other.display_name)}</div>
        <div class="status">${conv.is_paused ? '⏸ Paused' : (other.is_online ? '🟢 online' : '⚫ offline')}</div>
      </div>
      ${!isModel && !S.user ? `<span class="small" style="color:var(--pink);font-weight:700">🎁 ${conv.free_remaining} free left</span>` : ''}
      ${canVideo ? `<button class="icon-btn" id="c-video" title="Video call">📹</button>` : ''}
      ${S.user && S.user.role === 'fan' ? `<button class="icon-btn" id="c-book" title="Book private live">📅</button>` : ''}
    </div>
    ${conv.is_paused ? `
      <div class="rate-hint" style="background:rgba(248,113,113,.12);color:#fca5a5;font-weight:700">
        ⚠️ This chat is paused by the safety monitor.<br><span class="small">Sharing contact info is not allowed.</span>
      </div>` : ''}
    ${!isModel && !conv.is_paused ? `
      <div class="rate-hint">${S.user
        ? `Messages cost ${fmt(other.per_message_cents)} each`
        : `🎁 ${conv.free_remaining} FREE messages left — then sign up to continue`}</div>` : ''}
    <div id="messages"></div>
    <div id="typing-ind" class="rate-hint hidden"><i>typing…</i></div>
    <div class="chat-input-bar">
      ${!conv.is_paused ? `<button class="icon-btn" id="c-plus" title="More">＋</button>` : ''}
      ${!conv.is_paused && S.user && S.user.role === 'fan' ? `<button class="icon-btn" id="c-gift" title="Send a gift">🎁</button>` : ''}
      ${!conv.is_paused && S.user && S.user.role === 'fan' ? `<button class="icon-btn" id="c-tipmenu" title="Tip menu">💰</button>` : ''}
      <input id="c-input" placeholder="${conv.is_paused ? 'Chat paused' : 'Message…'}" ${conv.is_paused ? 'disabled' : ''} autocomplete="off">
      <button class="send-btn" id="c-send" ${conv.is_paused ? 'disabled' : ''}>➤</button>
    </div>
    <div id="action-sheet" class="hidden"></div>
    <input type="file" id="ppv-file" class="hidden" accept="image/jpeg,image/png,image/webp,video/mp4">`;

  $('#c-back').onclick = () => {
    if (!S.user) show('landing', {});
    else if (isModel) show('modelChats', {});
    else show('fanChats', {});
  };
  // Anti-copy for fans: no selecting/copying messages, no pasting into chat
  if (!isModel) lockCopyForFans(app, $('#c-input'));
  const vb = $('#c-video');
  if (vb) vb.onclick = startCall;
  const bb = $('#c-book');
  if (bb) bb.onclick = () => openBookingSheet(conv.other.id, conv.other.display_name,
    conv.other.per_minute_cents || 399);
  const pb = $('#c-plus');
  if (pb) pb.onclick = openActionSheet;
  const gb = $('#c-gift');
  if (gb) gb.onclick = openChatGiftPanel;
  const tmb = $('#c-tipmenu');
  if (tmb) tmb.onclick = () => openTipMenuSheet(S.conv.other.id, S.conv.other.display_name, 'chat');

  $('#c-back').onclick = () => {
    if (!S.user) show('landing', {});
    else if (isModel) show('modelChats', {});
    else show('fanChats', {});
  };

  await loadMessages();
  api(`/conversations/${conv.id}/read`, { method: 'POST' });

  const input = $('#c-input');
  const send = () => sendMessage();
  $('#c-send').onclick = send;
  input.onkeydown = (e) => { if (e.key === 'Enter') send(); };
  let typingTimer = null;
  input.oninput = () => {
    if (S.ws && S.ws.readyState === 1)
      S.ws.send(JSON.stringify({ type: 'typing', conversation_id: conv.id, is_typing: true }));
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
      if (S.ws && S.ws.readyState === 1)
        S.ws.send(JSON.stringify({ type: 'typing', conversation_id: conv.id, is_typing: false }));
    }, 1500);
  };
}

async function loadMessages() {
  const { data } = await api(`/conversations/${S.conv.id}/messages?limit=50`);
  S.messages = data.messages || [];
  renderMessages();
}

function mediaHTML(m) {
  if (!m.media) return '';
  const md = m.media;
  if (md.unlocked) {
    if (md.kind === 'ppv_image')
      return `<img class="ppv-img" data-media-src="${md.id}" alt="photo">`;
    if (md.kind === 'ppv_video')
      return `<video class="ppv-vid" data-media-src="${md.id}" controls playsinline preload="none"></video>`;
    if (md.kind === 'voice')
      return `<audio class="ppv-audio" data-media-src="${md.id}" controls preload="none"></audio>`;
    return '';
  }
  // Locked: pretty blurred tile, no bytes leak until paid
  const icon = md.kind === 'voice' ? '🎤' : md.kind === 'ppv_video' ? '🎥' : '📸';
  const label = md.kind === 'voice'
    ? `Voice note${md.duration_sec ? ` (${md.duration_sec}s)` : ''}`
    : md.kind === 'ppv_video' ? 'Private video' : 'Private photo';
  const mine = S.user && m.sender_id === S.user.id;
  return `<button class="ppv-lock" data-unlock="${md.id}" ${mine ? 'disabled' : ''}>
    <span class="ppv-lock-bg">${icon}</span>
    <span class="ppv-lock-label">🔒 ${label}</span>
    ${mine ? `<span class="ppv-unlock-price">Priced at ${fmt(md.price_cents)}</span>`
           : `<span class="ppv-unlock-btn">Unlock for ${fmt(md.price_cents)}</span>`}
  </button>`;
}

async function hydrateMediaSrc(scope) {
  // Resolve authed file URLs for unlocked media (img/video/audio tags can't send headers)
  const els = (scope || document).querySelectorAll('[data-media-src]');
  for (const el of els) {
    if (el.dataset.hydrated) continue;
    el.dataset.hydrated = '1';
    try {
      const { status, data } = await api(`/media/${el.dataset.mediaSrc}/file-token`, { method: 'POST' });
      if (status === 200 && data.url) el.src = data.url;
    } catch (e) { /* leave broken, user can retry */ }
  }
}

function renderMessages() {
  const box = $('#messages');
  if (!box) return;
  const meId = S.user ? S.user.id : null;
  const meGuest = S.guestToken;
  box.innerHTML = S.messages.map((m) => {
    const mine = meId ? m.sender_id === meId : m.guest_token === meGuest;
    const ticks = mine && m.sender_id
      ? (m.is_read ? ' <span style="color:#7dd3fc">✓✓</span>' : ' <span>✓</span>') : '';
    const g = giftOf(m);
    const bodyHTML = g ? giftBubbleHTML(g) : `${m.is_tip ? '💸 ' : ''}${esc(m.body)}${mediaHTML(m)}`;
    return `<div class="msg ${mine ? 'out' : 'in'}${g ? ' gift-msg' : ''}">${bodyHTML}
      <div class="meta">${timeHM(m.created_at)}${m.cost_cents && !g ? ` · <span class="cost">-${fmt(m.cost_cents)}</span>` : ''}${ticks}</div>
    </div>`;
  }).join('');
  box.scrollTop = box.scrollHeight;
  // keep the input bar visible: scroll chat area to bottom
  app.scrollTop = app.scrollHeight;
  hydrateMediaSrc(box);
  box.querySelectorAll('[data-unlock]').forEach((b) => {
    if (!b.disabled) b.onclick = () => unlockMedia(parseInt(b.dataset.unlock));
  });
}

async function unlockMedia(mediaId) {
  const { status, data } = await api(`/media/${mediaId}/unlock`, { method: 'POST' });
  if (status === 200) {
    // Mark unlocked locally and re-render
    S.messages.forEach((m) => {
      if (m.media && m.media.id === mediaId) m.media.unlocked = true;
    });
    renderMessages();
    if (data.balance_cents != null && S.wallet) S.wallet.credits_cents = data.balance_cents;
    toast('🔓 Unlocked!');
  } else if (status === 402) {
    toast(`Need ${fmt(data.needed_cents)} — top up your wallet 💰`);
    if (S.user && S.user.role === 'fan') show('wallet', {});
  } else {
    toast('Could not unlock.');
  }
}

async function sendMessage() {
  const input = $('#c-input');
  const text = input.value.trim();
  if (!text || !S.conv) return;
  input.value = '';
  const { status, data } = await api('/messages', {
    method: 'POST', body: JSON.stringify({ conversation_id: S.conv.id, body: text }),
  });
  if (status === 200 && data.flagged) {
    // Safety monitor blocked it
    toast(`⚠️ ${data.strikes >= 3 ? 'FLAGGED FOR REVIEW — ' : ''}Contact sharing is not allowed. Chat paused.`);
    S.conv.is_paused = true;
    show('chat', { conv: S.conv, keepMessages: true });
    return;
  }
  if (status === 200) {
    S.messages.push(data.message);
    renderMessages();
    if (typeof data.free_remaining === 'number') {
      S.conv.free_remaining = data.free_remaining;
      if (!S.user && data.free_remaining === 0) showPaywall();
      else show('chat', { conv: S.conv, keepMessages: true });
    }
    if (data.balance_cents != null && S.wallet) S.wallet.credits_cents = data.balance_cents;
    return;
  }
  if (status === 402 && data.error === 'trial_over') return showPaywall();
  if (status === 402 && data.error === 'insufficient_credits') {
    input.value = text;
    return showBuyCredits(data.needed_cents);
  }
  if (status === 423) {
    S.conv.is_paused = true;
    show('chat', { conv: S.conv, keepMessages: true });
    return toast('⚠️ This chat is paused.');
  }
  if (status === 403 && data.error === 'id_verification_required')
    return toast('🪪 This model must complete ID verification before chatting.');
  if (status === 0 || data.error === 'network_error') {
    input.value = text; // restore the message
    return toast('Connection issue — check your signal and try again 📶');
  }
  toast('Could not send.');
}

function showPaywall() {
  const ov = document.createElement('div');
  ov.id = 'paywall';
  ov.style.cssText = 'position:fixed;inset:0;z-index:150;background:rgba(10,5,20,.97);display:flex;align-items:center;justify-content:center;padding:20px';
  ov.innerHTML = `
    <div class="card" style="max-width:380px;text-align:center">
      <div style="font-size:44px">🎁➡️💰</div>
      <h2 style="margin:10px 0">Free messages used up!</h2>
      <p class="muted">Sign up free and buy credits to keep chatting with <b>${esc(S.conv.other.display_name)}</b>.</p>
      <button class="btn" id="pw-signup">Sign up FREE</button>
      <button class="btn ghost" id="pw-login">I have an account</button>
      <button class="btn ghost" id="pw-close" style="margin-top:8px">Browse other models</button>
    </div>`;
  document.body.appendChild(ov);
  $('#pw-signup').onclick = () => { ov.remove(); show('auth', { mode: 'signup', role: 'fan' }); };
  $('#pw-login').onclick = () => { ov.remove(); show('auth', { mode: 'login' }); };
  $('#pw-close').onclick = () => { ov.remove(); show('landing', {}); };
}

function showBuyCredits(needed) {
  toast(`Need ${fmt(needed)} — payment processor coming soon.`);
  if (S.user && S.user.role === 'fan') show('wallet', {});
}

/* ---------------- CHAT ACTION SHEET: PPV / voice / tips ---------------- */

function openActionSheet() {
  const sheet = $('#action-sheet');
  const isModel = S.user && S.user.role === 'model';
  const isFan = S.user && S.user.role === 'fan';
  const voicePrice = isModel && S.model ? fmt(S.model.per_voice_cents) : null;
  sheet.innerHTML = `
    <div class="sheet-backdrop" id="sheet-bg"></div>
    <div class="sheet">
      <div class="sheet-title">Send…</div>
      ${isModel ? `
        <button class="sheet-btn" id="sh-photo">📸 Photo <span class="muted small">— set your price</span></button>
        <button class="sheet-btn" id="sh-video">🎥 Video <span class="muted small">— set your price</span></button>
        <button class="sheet-btn" id="sh-voice">🎤 Voice note <span class="muted small">— fan pays ${voicePrice}</span></button>
      ` : `
        <button class="sheet-btn" id="sh-voice">🎤 Voice note</button>
        ${isFan ? `<button class="sheet-btn" id="sh-tip">🎁 Send a tip</button>` : ''}
      `}
      <button class="sheet-btn cancel" id="sh-cancel">Cancel</button>
    </div>`;
  sheet.classList.remove('hidden');
  $('#sheet-bg').onclick = closeActionSheet;
  $('#sh-cancel').onclick = closeActionSheet;
  const bind = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
  bind('#sh-photo', () => { closeActionSheet(); pickPpvFile('ppv_image'); });
  bind('#sh-video', () => { closeActionSheet(); pickPpvFile('ppv_video'); });
  bind('#sh-voice', () => { closeActionSheet(); startVoiceRecord(); });
  bind('#sh-tip', () => { closeActionSheet(); openTipModal(); });
}

function closeActionSheet() {
  const sheet = $('#action-sheet');
  if (sheet) sheet.classList.add('hidden');
}

function pickPpvFile(kind) {
  // iOS Safari blocks clicks on display:none inputs — create a visible-but-offscreen one
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = kind === 'ppv_video' ? 'video/*' : 'image/*';
  input.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0.01;z-index:9999;';
  input.onchange = () => {
    const f = input.files[0];
    input.remove();
    if (!f) return;
    if (f.size > 30 * 1024 * 1024) return toast('File too big — 30MB max.');
    const def = kind === 'ppv_video' ? '9.99' : '4.99';
    const priceStr = prompt(`Set your unlock price for this ${kind === 'ppv_video' ? 'video' : 'photo'} ($1–$100, or 0 for free):`, def);
    if (priceStr === null) return; // cancelled
    const price = Math.round(parseFloat(priceStr || '0') * 100);
    if (!Number.isFinite(price) || (price !== 0 && (price < 100 || price > 10000))) return toast('Enter 0 for free, or $1–$100');
    uploadMedia(f, kind, price, 0);
  };
  document.body.appendChild(input);
  input.click();
}

async function uploadMedia(file, kind, priceCents, durationSec) {
  toast('Uploading… ⏳');
  const fd = new FormData();
  fd.append('file', file);
  fd.append('conversation_id', S.conv.id);
  fd.append('kind', kind);
  fd.append('price_cents', priceCents);
  fd.append('duration_sec', durationSec || 0);
  const headers = {};
  if (S.token) headers['Authorization'] = 'Bearer ' + S.token;
  else if (S.guestToken) headers['X-Guest-Token'] = S.guestToken;
  try {
    const r = await fetch('/api/media/send', { method: 'POST', headers, body: fd });
    const data = await r.json();
    if (r.status === 200) {
      S.messages.push(data.message);
      renderMessages();
      if (data.balance_cents != null && S.wallet) S.wallet.credits_cents = data.balance_cents;
      toast(kind === 'voice' ? '🎤 Voice note sent!' : '🔒 PPV sent!');
    } else if (r.status === 402 && data.error === 'trial_over') {
      showPaywall();
    } else if (r.status === 402) {
      const need = data.needed_cents != null ? fmt(data.needed_cents) : '';
      const bal = data.balance_cents != null ? fmt(data.balance_cents) : '';
      toast(`💰 Not enough credits — need ${need} (you have ${bal}). Top up to send!`, 4000);
      if (S.user && S.user.role === 'fan') {
        setTimeout(() => show('wallet', {}), 800);
      }
    } else {
      toast(data.message || 'Upload failed.');
    }
  } catch (e) {
    toast('Upload failed — check your connection.');
  }
}

/* --- Voice notes: MediaRecorder --- */

let voiceRec = null, voiceChunks = [], voiceStartTs = 0, voiceTimerInt = null;

function startVoiceRecord() {
  // Ask for mic FIRST, before showing any overlay (iOS blocks prompts behind overlays)
  toast('Requesting mic access… 🎤');
  navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
    startVoiceUI(stream);
  }).catch(() => {
    toast('Mic permission needed — allow mic access in your browser settings 🎤', 4000);
  });
}

function startVoiceUI(stream) {
  const ov = document.createElement('div');
  ov.id = 'voice-ov';
  ov.innerHTML = `
    <div class="card" style="max-width:340px;text-align:center">
      <div style="font-size:40px" id="voice-mic">🎤</div>
      <h3 style="margin:8px 0">Recording… <span id="voice-secs">0s</span></h3>
      <p class="muted small" id="voice-hint">${S.user && S.user.role === 'model'
        ? `Fan pays ${fmt(S.model.per_voice_cents)} to listen` : 'Sent as a message'}</p>
      <button class="btn" id="voice-stop">Send voice note</button>
      <button class="btn ghost" id="voice-cancel">Cancel</button>
    </div>`;
  ov.style.cssText = 'position:fixed;inset:0;z-index:150;background:rgba(10,5,20,.92);display:flex;align-items:center;justify-content:center;padding:20px';
  document.body.appendChild(ov);

  try {
    const mime = MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4'
      : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
    voiceRec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop());
    ov.remove();
    toast('Voice recording not supported on this device 🎤');
    return;
  }
    voiceChunks = [];
    voiceRec.ondataavailable = (e) => { if (e.data.size) voiceChunks.push(e.data); };
    voiceRec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      clearInterval(voiceTimerInt);
    };
    voiceRec.start();
    voiceStartTs = Date.now();
    voiceTimerInt = setInterval(() => {
      const s = Math.floor((Date.now() - voiceStartTs) / 1000);
      const el = $('#voice-secs');
      if (el) el.textContent = s + 's';
      if (s >= 120) $('#voice-stop').click(); // 2 min cap
    }, 500);
    // pulse the mic
    let on = false;
    const pulse = setInterval(() => {
      const m = $('#voice-mic');
      if (!m) { clearInterval(pulse); return; }
      m.style.transform = on ? 'scale(1)' : 'scale(1.25)';
      on = !on;
    }, 400);

  $('#voice-stop').onclick = () => {
    const secs = Math.max(1, Math.round((Date.now() - voiceStartTs) / 1000));
    const rec = voiceRec;
    ov.remove();
    if (!rec) {
      toast('Recording failed to start — try again 🎤');
      return;
    }
    rec.onstop = () => {
      const blob = new Blob(voiceChunks, { type: rec.mimeType || 'audio/webm' });
      const ext = (rec.mimeType || '').includes('mp4') ? 'm4a' : 'webm';
      const file = new File([blob], `voice.${ext}`, { type: blob.type });
      const isModel = S.user && S.user.role === 'model';
      const price = isModel ? S.model.per_voice_cents : 0;
      uploadMedia(file, 'voice', price, secs);
    };
    try { rec.stop(); } catch (e) { /* already stopped */ }
    voiceRec = null;
  };
  $('#voice-cancel').onclick = () => {
    try { voiceRec && voiceRec.stop(); } catch (e) {}
    voiceRec = null;
    ov.remove();
    toast('Cancelled.');
  };
}

/* --- Tipping --- */

function openTipModal() {
  const ov = document.createElement('div');
  ov.id = 'tip-ov';
  ov.style.cssText = 'position:fixed;inset:0;z-index:150;background:rgba(10,5,20,.92);display:flex;align-items:center;justify-content:center;padding:20px';
  ov.innerHTML = `
    <div class="card" style="max-width:340px;text-align:center">
      <div style="font-size:44px">🎁</div>
      <h3 style="margin:8px 0">Tip ${esc(S.conv.other.display_name)}</h3>
      <p class="muted small">She gets 70% instantly.</p>
      <div class="tip-grid">
        ${[5, 10, 25, 50].map((a) => `<button class="btn small" data-tip="${a * 100}">$${a}</button>`).join('')}
      </div>
      <div class="row" style="margin-top:10px">
        <input class="input" id="tip-custom" type="number" min="1" step="0.01" placeholder="Custom $" style="margin-top:0">
        <button class="btn small" id="tip-custom-go">Send</button>
      </div>
      <button class="btn ghost" id="tip-cancel" style="margin-top:10px">Cancel</button>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelectorAll('[data-tip]').forEach((b) => {
    b.onclick = () => { const c = parseInt(b.dataset.tip); ov.remove(); sendTip(c); };
  });
  $('#tip-custom-go').onclick = () => {
    const c = Math.round(parseFloat($('#tip-custom').value || '0') * 100);
    if (!c || c < 100) return toast('Minimum tip is $1');
    ov.remove();
    sendTip(c);
  };
  $('#tip-cancel').onclick = () => ov.remove();
}

async function sendTip(amountCents) {
  const { status, data } = await api('/tips', {
    method: 'POST',
    body: JSON.stringify({ conversation_id: S.conv.id, amount_cents: amountCents }),
  });
  if (status === 200) {
    toast(`🎁 Tipped ${fmt(amountCents)}!`);
    if (data.balance_cents != null && S.wallet) S.wallet.credits_cents = data.balance_cents;
  } else if (status === 402) {
    toast(`Need ${fmt(data.needed_cents)} — top up 💰`);
    show('wallet', {});
  } else {
    toast(data.message || 'Tip failed.');
  }
}

/* ---------------- VIDEO CALLS (WebRTC, STUN only) ---------------- */

let pc = null, localStream = null, callTimerInt = null;

function updateCallHUD() {
  if (!S.call) return;
  const s = S.call.seconds || 0;
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  const t = $('#call-timer'), c = $('#call-cost');
  if (t) t.textContent = `${mm}:${ss}`;
  if (c) c.textContent = `~${fmt((S.call.minutes || 0) * S.call.rate)}`;
}

async function startCall() {
  const modelId = S.conv.other.id;
  const { status, data } = await api('/calls', {
    method: 'POST', body: JSON.stringify({ model_id: modelId }) });
  if (status !== 200) {
    if (data.error === 'model_offline') return toast('She is offline right now.');
    if (data.error === 'insufficient_credits') return showBuyCredits(data.needed_cents);
    return toast('Could not start call.');
  }
  const callId = data.call_id;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (e) { return toast('Camera/mic permission needed 📹'); }

  pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
  pc.onicecandidate = (e) => {
    if (e.candidate && S.ws) S.ws.send(JSON.stringify({ type: 'signal', to: modelId,
      payload: { kind: 'ice', call_id: callId, candidate: e.candidate } }));
  };
  pc.ontrack = (e) => { $('#remote-video').srcObject = e.streams[0]; };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  S.ws.send(JSON.stringify({ type: 'signal', to: modelId,
    payload: { kind: 'invite', call_id: callId, sdp: offer,
               from_name: S.user.display_name, rate: data.rate_cents } }));

  S.call = { id: callId, rate: data.rate_cents, seconds: 0, minutes: 0, role: 'fan' };
  $('#active-call').classList.remove('hidden');
  $('#local-video').srcObject = localStream;
  $('#call-timer').textContent = 'Calling…';
  callTimerInt = setInterval(() => { S.call.seconds++; updateCallHUD(); }, 1000);
  toast('Calling… waiting for her to pick up 📞');
}

async function handleSignal(m) {
  const p = m.payload || {};
  if (p.kind === 'invite') {
    // Incoming call — only models get these (fans never receive invites in v1)
    if (!S.user || S.user.role !== 'model') return;
    S.call = { id: p.call_id, rate: p.rate, seconds: 0, minutes: 0, role: 'model',
               from: m.from, fromName: p.from_name, offer: p.sdp };
    $('#call-name').textContent = p.from_name || 'Fan';
    $('#call-avatar').outerHTML = avatarHTML(p.from_name || '?', 'xl').replace('class="avatar xl"', 'id="call-avatar" class="avatar xl"');
    $('#call-overlay').classList.remove('hidden');
    return;
  }
  if (!S.call || p.call_id !== S.call.id) return;
  try {
    if (p.kind === 'answer' && pc) await pc.setRemoteDescription(new RTCSessionDescription(p.sdp));
    else if (p.kind === 'ice' && pc) await pc.addIceCandidate(new RTCIceCandidate(p.candidate));
    else if (p.kind === 'hangup') endCallUI('Call ended.');
  } catch (e) { /* ignore stale signaling */ }
}

async function acceptCall() {
  $('#call-overlay').classList.add('hidden');
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (e) { return toast('Camera/mic permission needed 📹'); }
  pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
  const to = S.call.from;
  pc.onicecandidate = (e) => {
    if (e.candidate && S.ws) S.ws.send(JSON.stringify({ type: 'signal', to,
      payload: { kind: 'ice', call_id: S.call.id, candidate: e.candidate } }));
  };
  pc.ontrack = (e) => { $('#remote-video').srcObject = e.streams[0]; };
  await pc.setRemoteDescription(new RTCSessionDescription(S.call.offer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  S.ws.send(JSON.stringify({ type: 'signal', to, payload: { kind: 'answer', call_id: S.call.id, sdp: answer } }));
  await api(`/calls/${S.call.id}/accept`, { method: 'POST' }); // starts billing clock
  $('#active-call').classList.remove('hidden');
  $('#local-video').srcObject = localStream;
  callTimerInt = setInterval(() => { S.call.seconds++; updateCallHUD(); }, 1000);
}

function declineCall() {
  $('#call-overlay').classList.add('hidden');
  if (S.call) {
    if (S.ws) S.ws.send(JSON.stringify({ type: 'signal', to: S.call.from,
      payload: { kind: 'hangup', call_id: S.call.id } }));
    api(`/calls/${S.call.id}/end`, { method: 'POST' });
    S.call = null;
  }
}

async function hangupCall() {
  if (!S.call) return;
  const id = S.call.id, other = S.call.role === 'fan' ? S.conv?.other?.id : S.call.from;
  if (S.ws && other) S.ws.send(JSON.stringify({ type: 'signal', to: other,
    payload: { kind: 'hangup', call_id: id } }));
  await api(`/calls/${id}/end`, { method: 'POST' }).catch(() => {});
  endCallUI('Call ended.');
}

function endCallUI(msg) {
  $('#active-call').classList.add('hidden');
  $('#call-overlay').classList.add('hidden');
  clearInterval(callTimerInt);
  if (pc) { try { pc.close(); } catch (e) {} pc = null; }
  if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
  $('#remote-video').srcObject = null;
  S.call = null;
  if (msg) toast(msg);
  if (S.user && S.user.role === 'fan') refreshMe();
}

/* ---------------- LIVE CAM — broadcast + AI blur paywall ---------------- */

let livePCs = new Map(); // model side: fanId -> RTCPeerConnection
let liveMonitorInt = null;

function liveSignal(to, sessionId, payload) {
  if (S.ws && S.ws.readyState === 1)
    S.ws.send(JSON.stringify({ type: 'live-signal', to, session_id: sessionId, payload }));
}

/* --- MODEL: broadcast --- */

async function rejoinLiveBroadcast(sessionId) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: true });
  } catch (e) {
    return toast('Camera/mic permission needed 📹');
  }
  // Fetch session details
  const { status, data } = await api(`/live/${sessionId}`);
  if (status !== 200) return toast('Could not rejoin stream.');
  S.live = { sessionId, role: 'model', stream,
             explicitRate: data.explicit_rate_cents || 499, isExplicit: !!data.is_explicit,
             title: data.title || '', chat: [], gifts: [], leaderboard: [] };
  show('liveBroadcast', {});
  loadStreamChat();
  loadLeaderboard();
  toast('🔴 Back live! Welcome back 🎉');
}

async function startLiveBroadcast() {
  const title = prompt('Stream title (shown to fans):', 'Come hang out 😈💦');
  if (title === null) return; // cancelled
  const { status, data } = await api('/live/start', {
    method: 'POST', body: JSON.stringify({ title: (title || '').trim() }) });
  if (status !== 200) {
    if (data.error === 'already_live' && data.session_id) {
      // She got disconnected but the session is still live — offer to rejoin
      if (confirm('You have a live stream running. Rejoin it?')) {
        return rejoinLiveBroadcast(data.session_id);
      }
      return;
    }
    if (data.error === 'id_verification_required')
      return toast('🪪 ID verification required — upload your ID in Settings → ID Verification first.');
    return toast('Could not go live.');
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: true });
  } catch (e) {
    await api(`/live/${data.session_id}/end`, { method: 'POST' }).catch(() => {});
    return toast('Camera/mic permission needed 📹');
  }
  S.live = { sessionId: data.session_id, role: 'model', stream,
             explicitRate: data.explicit_rate_cents, isExplicit: false,
             title: data.title || '', chat: [], gifts: [], leaderboard: [] };
  show('liveBroadcast', {});
  loadStreamChat();
  loadLeaderboard();
  toast('🔴 You are LIVE! Chat is free for fans — gifts = money 💰');
}

function liveModelAddViewer(fanId) {
  if (!S.live || S.live.role !== 'model') return;
  liveModelRemoveViewer(fanId);
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  S.live.stream.getTracks().forEach((t) => pc.addTrack(t, S.live.stream));
  pc.onicecandidate = (e) => {
    if (e.candidate) liveSignal(fanId, S.live.sessionId, { kind: 'ice', candidate: e.candidate });
  };
  livePCs.set(fanId, pc);
  pc.createOffer().then((offer) => pc.setLocalDescription(offer)).then(() => {
    liveSignal(fanId, S.live.sessionId, { kind: 'offer', sdp: pc.localDescription });
  }).catch(() => liveModelRemoveViewer(fanId));
  updateLiveViewerCount();
}

function liveModelRemoveViewer(fanId) {
  const pc = livePCs.get(fanId);
  if (pc) { try { pc.close(); } catch (e) {} livePCs.delete(fanId); }
  updateLiveViewerCount();
}

function updateLiveViewerCount() {
  const el = $('#live-viewer-count');
  if (el) el.textContent = `${livePCs.size} watching`;
}

async function liveToggleExplicit() {
  const L = S.live;
  if (!L || L.role !== 'model') return;
  const next = !L.isExplicit;
  const { status } = await api(`/live/${L.sessionId}/mode`, {
    method: 'POST', body: JSON.stringify({ is_explicit: next }) });
  if (status === 200) {
    L.isExplicit = next;
    const b = $('#live-explicit-btn');
    if (b) {
      b.textContent = next ? '🔞 Explicit ON — tap for SFW' : 'Go Explicit 🔞';
      b.style.background = next
        ? 'linear-gradient(135deg,#10b981,#047857)'
        : 'linear-gradient(135deg,#8b5cf6,#6d28d9)';
    }
    toast(next ? '🔞 Explicit mode — fans see the paywall' : 'Back to SFW preview');
  }
}

function vLiveBroadcast() {
  const L = S.live;
  if (!L) return show('modelChats', {});
  app.innerHTML = `
    <div class="live-wrap">
      <video id="live-local" autoplay playsinline muted></video>
      <div class="live-top">
        <span class="live-badge">🔴 LIVE</span>
        <span id="live-viewer-count" class="live-viewers">0 watching</span>
      </div>
      ${L.title ? `<div class="live-title">${esc(L.title)}</div>` : ''}
      <div id="priority-banner" class="hidden"></div>
      <div id="gift-stack"></div>
      <div id="stage-pip" class="hidden">
        <video id="stage-video" autoplay playsinline class="hidden"></video>
        <div id="stage-mic" class="hidden"><span class="stage-mic-emoji">🎙️</span><span class="stage-mic-pulse"></span></div>
        <div id="stage-info" class="stage-info"></div>
        <button class="btn small danger" id="stage-drop-btn">Drop ⏏️</button>
      </div>
      <div id="stage-requests"></div>
      <div id="live-leaderboard" class="live-leaderboard hidden"></div>
      <div id="stream-chat" class="stream-chat"></div>
      <div class="stream-chat-input">
        <input id="stream-chat-box" class="input" placeholder="Say something to your fans…" maxlength="500" autocomplete="off">
        <button class="btn small" id="stream-chat-send" style="margin:0">➤</button>
      </div>
      <div class="live-controls">
        <button class="btn" id="live-explicit-btn" style="background:linear-gradient(135deg,#8b5cf6,#6d28d9)">Go Explicit 🔞</button>
        <div class="muted small" style="text-align:center;margin-top:6px">Explicit rate: ${fmt(L.explicitRate)}/min · Your preview is never blurred</div>
        <button class="btn danger" id="live-end-btn" style="margin-top:10px">End Stream</button>
      </div>
    </div>`;
  $('#live-local').srcObject = L.stream;
  $('#live-explicit-btn').onclick = liveToggleExplicit;
  $('#live-end-btn').onclick = () => { if (confirm('End your live stream?')) endLiveView('Stream ended.'); };
  const sendBox = $('#stream-chat-box');
  const sendIt = () => {
    const v = sendBox.value.trim();
    if (v) { sendStreamChat(v); sendBox.value = ''; }
  };
  $('#stream-chat-send').onclick = sendIt;
  sendBox.onkeydown = (e) => { if (e.key === 'Enter') sendIt(); };
  renderStreamChat();
  renderLeaderboard();
  renderStageRequests();
  // Poll stage requests every 5s as backup (in case WS events are missed)
  if (S.live.stagePoll) clearInterval(S.live.stagePoll);
  S.live.stagePoll = setInterval(() => {
    if (S.live && S.live.role === 'model') renderStageRequests();
    else clearInterval(S.live.stagePoll);
  }, 5000);
}

/* --- MODEL: stage requests + active stage fan (3-min limit) --- */

async function renderStageRequests() {
  const L = S.live;
  if (!L || L.role !== 'model') return;
  const box = $('#stage-requests');
  if (!box) return;
  try {
    const { status, data } = await api(`/live/${L.sessionId}/stage`);
    if (status !== 200 || !data || !S.live || S.live.sessionId !== L.sessionId) return;
    const pend = data.pending || [];
    box.innerHTML = pend.map((r) => {
      const mode = r.mode || 'video';
      return `
      <div class="stage-req-card">
        <span class="grow">${stageModeEmoji(mode)} <b>${esc(r.fan_name)}</b> wants to join (${stageModeLabel(mode)})${r.is_explicit ? ' 🔞' : ''}
          <span class="muted small">(${fmt(stageJoinFee(!!r.is_explicit, mode))})</span></span>
        <button class="btn small" data-approve="${r.id}">✅</button>
        <button class="btn small danger" data-decline="${r.id}">❌</button>
      </div>`; }).join('');
    box.querySelectorAll('[data-approve]').forEach((b) => {
      b.onclick = () => stageApprove(parseInt(b.dataset.approve));
    });
    box.querySelectorAll('[data-decline]').forEach((b) => {
      b.onclick = () => stageDecline(parseInt(b.dataset.decline));
    });
    if (data.stage) showStagePip(data.stage);
    else hideStagePip();
  } catch (e) { /* ignore */ }
}

async function stageApprove(rid) {
  const L = S.live;
  if (!L) return;
  const { status, data } = await api(`/live/join-requests/${rid}/approve`, { method: 'POST' });
  if (status === 200 && data.stage) {
    showStagePip(data.stage);
    renderStageRequests();
    const mode = data.stage.mode || 'video';
    toast(`${stageModeEmoji(mode)} ${data.stage.fan_name} is on ${mode === 'mic' ? 'mic' : 'stage'}!`, 3000);
  } else if (status === 409) {
    toast('Someone is already on stage!');
    renderStageRequests();
  } else toast('Could not approve.');
}

async function stageDecline(rid) {
  const { status, data } = await api(`/live/join-requests/${rid}/decline`, { method: 'POST' });
  if (status === 200) { toast(`Declined — ${fmt(data.refunded_cents || 0)} refunded to them.`); renderStageRequests(); }
  else toast('Could not decline.');
}

async function stageDrop(reason) {
  const L = S.live;
  if (!L || !L.stageReqId) return;
  const { status } = await api(`/live/join-requests/${L.stageReqId}/drop`, {
    method: 'POST', body: JSON.stringify({ reason: reason || 'dropped' }) });
  if (status === 200) hideStagePip();
}

function showStagePip(stage) {
  const L = S.live;
  if (!L) return;
  L.stageReqId = stage.id;
  const mode = stage.mode || 'video';
  L.stageMode = mode;
  const wrap = $('#stage-pip');
  const info = $('#stage-info');
  if (wrap) wrap.classList.remove('hidden');
  // Mic mode: show speaking indicator, hide video element
  const v = $('#stage-video');
  const mic = $('#stage-mic');
  if (mode === 'mic') {
    if (v) { v.srcObject = null; v.classList.add('hidden'); }
    if (mic) mic.classList.remove('hidden');
  } else {
    if (mic) mic.classList.add('hidden');
  }
  const dropBtn = $('#stage-drop-btn');
  if (dropBtn) dropBtn.onclick = () => stageDrop('dropped');
  // Countdown to auto-drop (3-min stage limit)
  if (L.stageCountdownInt) clearInterval(L.stageCountdownInt);
  const tick = () => {
    if (!S.live || S.live.sessionId !== L.sessionId || S.live.stageReqId !== stage.id) {
      clearInterval(L.stageCountdownInt); L.stageCountdownInt = null; return;
    }
    const ms = stage.stage_ends_at - Date.now();
    if (ms <= 0) {
      clearInterval(L.stageCountdownInt); L.stageCountdownInt = null;
      api(`/live/join-requests/${stage.id}/drop`, {
        method: 'POST', body: JSON.stringify({ reason: 'timeout' }) }).catch(() => {});
      hideStagePip();
      toast(`⏰ ${stage.fan_name}'s stage time is up!`, 3500);
      return;
    }
    const s = Math.ceil(ms / 1000);
    if (info) info.innerHTML =
      `${stageModeEmoji(mode)} <b>${esc(stage.fan_name)}</b> on ${mode === 'mic' ? 'mic' : 'stage'} — ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} left`;
  };
  tick();
  L.stageCountdownInt = setInterval(tick, 1000);
}

function hideStagePip() {
  const L = S.live;
  if (L) {
    if (L.stageCountdownInt) { clearInterval(L.stageCountdownInt); L.stageCountdownInt = null; }
    L.stageReqId = null;
    if (L.stagePC) { try { L.stagePC.close(); } catch (e) {} L.stagePC = null; }
    L.stageFanId = null;
    L.stageMode = null;
  }
  const wrap = $('#stage-pip');
  if (wrap) wrap.classList.add('hidden');
  const v = $('#stage-video');
  if (v) { v.srcObject = null; v.classList.add('hidden'); }
  const mic = $('#stage-mic');
  if (mic) mic.classList.add('hidden');
  const a = $('#stage-audio');
  if (a) { a.srcObject = null; a.remove(); }
}

/* ---------------- GROUP STREAM: chat, gifts, leaderboard (shared) ---------------- */

async function loadStreamChat() {
  const L = S.live;
  if (!L) return;
  try {
    const { data } = await api(`/live/${L.sessionId}/chat`);
    L.chat = data.messages || [];
    renderStreamChat();
  } catch (e) { /* ignore */ }
}

function renderStreamChat() {
  const el = $('#stream-chat');
  const L = S.live;
  if (!el || !L) return;
  el.innerHTML = (L.chat || []).slice(-30).map((m) => `
    <div class="stream-msg${m.sender_role === 'model' ? ' from-model' : ''}">
      <b>${esc(m.sender_name)}</b> ${esc(m.body)}
    </div>`).join('');
  el.scrollTop = el.scrollHeight;
}

async function sendStreamChat(body) {
  const L = S.live;
  if (!L) return;
  const { status, data } = await api(`/live/${L.sessionId}/chat`, {
    method: 'POST', body: JSON.stringify({ body }) });
  if (status === 423) {
    toast(data.warning || `⚠️ Blocked (${data.strikes || 0}/3 strikes)`, 3500);
  } else if (status !== 200) {
    toast('Could not send.');
  }
  // On success the server broadcasts live:chat back to everyone including us
}

async function loadLeaderboard() {
  const L = S.live;
  if (!L) return;
  try {
    const { data } = await api(`/live/${L.sessionId}/leaderboard`);
    L.leaderboard = data.top || [];
    L.giftTotals = data.totals || { gift_cents: 0, gift_count: 0 };
    renderLeaderboard();
  } catch (e) { /* ignore */ }
}

function renderLeaderboard() {
  const el = $('#live-leaderboard');
  const L = S.live;
  if (!el || !L) return;
  const top = L.leaderboard || [];
  if (!top.length) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  const medals = ['🥇', '🥈', '🥉'];
  el.innerHTML = `<div class="lb-title">🏆 Top gifters</div>` + top.map((t, i) => `
    <div class="lb-row"><span>${medals[i]} ${esc(t.fan_name)}</span>
      <span class="lb-amt">${fmt(t.total_cents)}</span></div>`).join('');
}

function showGiftAnim(emoji, fanName) {
  const ov = $('#gift-anim');
  if (!ov) return;
  ov.innerHTML = `<div class="gift-burst">${emoji}</div>
    <div class="gift-from">${esc(fanName)} sent ${emoji}!</div>`;
  ov.classList.remove('hidden');
  clearTimeout(showGiftAnim._t);
  showGiftAnim._t = setTimeout(() => ov.classList.add('hidden'), 2200);
}

/* ---------------- NOTIFICATIONS (bell + follows) ---------------- */

// Floating bell — rendered once, badge updates on login and WS pushes
function renderBell() {
  let bell = $('#notif-bell');
  if (!S.user) { if (bell) bell.remove(); return; }
  if (!bell) {
    bell = document.createElement('button');
    bell.id = 'notif-bell';
    bell.className = 'notif-bell';
    bell.title = 'Notifications';
    bell.innerHTML = '🔔<span class="notif-badge hidden" id="notif-badge"></span>';
    bell.onclick = () => show('notifications', {});
    document.body.appendChild(bell);
  }
  refreshNotifBadge();
}

async function refreshNotifBadge() {
  const badge = $('#notif-badge');
  if (!badge || !S.user) return;
  try {
    const { data } = await api('/notifications');
    const n = data.unread || 0;
    badge.textContent = n > 99 ? '99+' : n;
    badge.classList.toggle('hidden', !n);
  } catch (e) { /* ignore */ }
}

async function vNotifications() {
  const { data } = await api('/notifications');
  const notifs = data.notifications || [];
  app.innerHTML = `
    <div class="header"><h1>🔔 Notifications</h1>
      <div><button class="btn ghost small" id="notif-read-all">Mark all read</button></div></div>
    <div class="screen">
      ${notifs.map((n) => `
        <button class="list-item ${n.read ? '' : 'unread'}" data-notif="${n.id}" data-link="${esc(n.link || '')}">
          <span class="grow">
            <span class="title">${esc(n.title)}</span><br>
            ${n.body ? `<span class="preview">${esc(n.body)}</span><br>` : ''}
            <span class="small muted">${new Date((n.created_at || '').replace(' ', 'T') + 'Z').toLocaleString()}</span>
          </span>${n.read ? '' : '<span class="unread-dot"></span>'}
        </button>`).join('') || '<div class="empty"><div class="big">🔔</div>Nothing yet.<br><span class="small">Follow models to get notified when they go live.</span></div>'}
    </div>`;
  $('#notif-read-all').onclick = async () => {
    await api('/notifications/read', { method: 'POST' });
    refreshNotifBadge();
    show('notifications', {});
  };
  app.querySelectorAll('[data-notif]').forEach((b) => {
    b.onclick = async () => {
      await api('/notifications/read', { method: 'POST',
        body: JSON.stringify({ ids: [parseInt(b.dataset.notif)] }) });
      refreshNotifBadge();
      const link = b.dataset.link;
      if (link === '/#live' && S.user && S.user.role === 'fan') show('fanLive', {});
      else show('notifications', {});
    };
  });
}

// Fan: follow/unfollow a model (enables "she's live" notifications)
async function toggleFollow(modelId, btn) {
  const { data } = await api(`/follows/${modelId}`, { method: 'POST' });
  if (btn) {
    btn.textContent = data.following ? '❤️' : '🤍';
    btn.classList.toggle('following', data.following);
    toast(data.following
      ? "❤️ Following — you'll be notified when she goes live!"
      : '🤍 Unfollowed');
  }
  return data.following;
}

// Web Push: subscribe this browser (needs VAPID keys server-side to actually deliver)
async function subscribePush() {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    if (!('Notification' in window)) return;
    const { data } = await api('/push/vapid-key');
    if (!data.key) return; // VAPID not configured — in-app notifications still work
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return;
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const key = Uint8Array.from(atob(data.key.replace(/-/g, '+').replace(/_/g, '/')),
        (c) => c.charCodeAt(0));
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    }
    const j = sub.toJSON();
    await api('/push/subscribe', { method: 'POST',
      body: JSON.stringify({ endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth }) });
  } catch (e) { /* push is best-effort — in-app notifications still work */ }
}

/* ---------------- TIP MENU (fan-facing) ---------------- */

async function openTipMenuSheet(modelId, modelName, context) {
  const { data } = await api(`/models/${modelId}/tip-menu`);
  const items = data.items || [];
  const balance = S.wallet ? S.wallet.credits_cents : 0;
  let sheet = $('#tip-sheet');
  if (sheet) sheet.remove();
  sheet = document.createElement('div');
  sheet.id = 'tip-sheet';
  sheet.className = 'sheet-backdrop';
  sheet.innerHTML = `
    <div class="sheet">
      <div class="sheet-title">💰 ${esc(modelName)}'s Tip Menu
        <span class="muted small">· ${fmt(balance)}</span></div>
      <div class="muted small" style="margin-bottom:10px">Pick something fun — she'll do it for you 😈</div>
      <div class="tip-list">
        ${items.map((t) => `
          <button class="tip-item" data-tip="${t.id}">
            <span class="tip-emoji">${t.emoji}</span>
            <span class="grow"><span class="title">${esc(t.label)}</span></span>
            <span class="tip-price">${fmt(t.price_cents)}</span>
          </button>`).join('') || '<div class="muted">No tip menu yet — check back soon!</div>'}
      </div>
      <button class="btn ghost" id="tip-close" style="margin-top:10px">Close</button>
    </div>`;
  document.body.appendChild(sheet);
  const close = () => sheet.remove();
  $('#tip-close').onclick = close;
  sheet.onclick = (e) => { if (e.target === sheet) close(); };
  sheet.querySelectorAll('[data-tip]').forEach((b) => {
    b.onclick = () => sendTip(parseInt(b.dataset.tip), modelId, modelName, context);
  });
}

async function sendTip(menuId, modelId, modelName, context) {
  const sheet = $('#tip-sheet');
  if (sheet) sheet.remove();
  const { status, data } = await api(`/models/${modelId}/tip`, {
    method: 'POST',
    body: JSON.stringify({ menu_id: menuId, context: context || 'profile' }),
  });
  if (status === 402) {
    toast(`Not enough credits — you need ${fmt(data.needed_cents)}.`);
    if (typeof showBuyCredits === 'function') showBuyCredits(data.needed_cents);
    return;
  }
  if (status === 200) {
    if (data.balance_cents != null && S.wallet) S.wallet.credits_cents = data.balance_cents;
    showGiftAnim(data.emoji, `You tipped ${data.label}`);
    toast(`💰 ${data.emoji} ${data.label} sent to ${modelName}!`);
  }
}

// Stacked gift ticker: recent gifts float up the side, TikTok-style
function pushGiftStack(emoji, fanName) {
  const rail = $('#gift-stack');
  if (!rail) return;
  const el = document.createElement('div');
  el.className = 'gift-stack-item';
  el.innerHTML = `<span class="gift-stack-emoji">${emoji}</span><span class="gift-stack-from">${esc(fanName)}</span>`;
  rail.appendChild(el);
  while (rail.children.length > 6) rail.firstChild.remove();
  setTimeout(() => { el.classList.add('fade'); setTimeout(() => el.remove(), 900); }, 4200);
}

function pushGiftToChat(gift, fanName) {
  const L = S.live;
  if (!L) return;
  L.chat = L.chat || [];
  L.chat.push({ sender_name: '🎁', sender_role: 'system',
    body: `${fanName} sent ${gift.emoji} ${gift.name}!`, created_at: new Date().toISOString() });
  renderStreamChat();
}

async function openGiftPanel(onClose) {
  const L = S.live;
  if (!L || L.role !== 'fan') return;
  const { data } = await api('/gifts');
  const gifts = data.gifts || [];
  const explicitHint = L.isExplicit
    ? `<div class="muted small" style="margin-top:4px">🎁 Any gift keeps your view clear while she's explicit 🔓</div>` : '';
  // Reuse the action-sheet pattern
  let sheet = $('#gift-sheet');
  if (sheet) sheet.remove();
  sheet = document.createElement('div');
  sheet.id = 'gift-sheet';
  sheet.className = 'sheet-backdrop';
  sheet.innerHTML = `
    <div class="sheet">
      <div class="sheet-title">🎁 Send a gift <span class="muted small">· ${fmt(S.wallet ? S.wallet.credits_cents : 0)}</span>${explicitHint}</div>
      <div class="gift-grid">
        ${gifts.map((g) => `
          <button class="gift-item" data-gift="${g.id}">
            <span class="gift-emoji">${g.emoji}</span>
            <span class="gift-name">${esc(g.name)}</span>
            <span class="gift-price">${fmt(g.price_cents)}</span>
          </button>`).join('') || '<div class="muted">No gifts available.</div>'}
      </div>
      <button class="btn ghost" id="gift-close" style="margin-top:10px">Close</button>
    </div>`;
  document.body.appendChild(sheet);
  const close = () => { sheet.remove(); if (onClose) onClose(); };
  $('#gift-close').onclick = close;
  sheet.onclick = (e) => { if (e.target === sheet) close(); };
  sheet.querySelectorAll('[data-gift]').forEach((b) => {
    b.onclick = () => sendGift(parseInt(b.dataset.gift), sheet);
  });
}

async function sendGift(giftId, sheet) {
  const L = S.live;
  if (!L) return;
  const { status, data } = await api(`/live/${L.sessionId}/gift`, {
    method: 'POST', body: JSON.stringify({ gift_id: giftId }) });
  if (sheet) sheet.remove();
  if (status === 200) {
    if (data.balance_cents != null && S.wallet) S.wallet.credits_cents = data.balance_cents;
    // Server broadcasts live:gift to everyone; our own animation comes via WS.
    // Fallback: if WS is slow, the broadcast will still arrive.
    // Pay-to-play: any gift unblurs THIS viewer for the grace period.
    if (data.explicit_until && L.isExplicit && S.live && S.live.sessionId === L.sessionId) {
      L.explicitUntil = data.explicit_until;
      // AI-detected explicit is client-side only — the server never enforced an
      // entry fee there, so the first gift counts as entry too.
      // Manual explicit keeps the strict gate: gifts never bypass entry.
      if (!L.entryPaid && L.explicitSource !== 'manual') L.entryPaid = true;
      applyLiveBlur(false);
      startGiftCountdown();
      toast('🎁 Gift sent — your view stays clear! 🔓');
    }
  } else if (status === 402) {
    toast(`Need ${fmt(data.needed_cents)} — top up your wallet 💰`, 3500);
    showBuyCredits(data.needed_cents);
  } else {
    toast('Gift failed.');
  }
}

/* ---------------- CHAT GIFTS (TikTok-style emoji gifts in 1:1 chat) ---------------- */

// Parse the gift payload off a message (live WS attach or persisted gift_json)
function giftOf(m) {
  if (m && m.gift && m.gift.emoji) return m.gift;
  if (m && m.gift_json) {
    try { const g = JSON.parse(m.gift_json); if (g && g.emoji) return g; } catch (e) { /* ignore */ }
  }
  return null;
}

function giftBubbleHTML(g) {
  return `<div class="chat-gift">
    <div class="chat-gift-emoji">${g.emoji}</div>
    <div class="chat-gift-name">🎁 ${esc(g.name)}</div>
    <div class="chat-gift-price">${fmt(g.price_cents)}</div>
  </div>`;
}

// Full-screen fly-across animation: the emoji soars across with the fan's name
function flyGiftAnim(emoji, fanName, giftName) {
  const ov = document.createElement('div');
  ov.className = 'gift-fly';
  ov.innerHTML = `<div class="gift-fly-emoji">${emoji}</div>
    <div class="gift-fly-from">${esc(fanName)} sent ${emoji} ${esc(giftName || '')}!</div>`;
  document.body.appendChild(ov);
  setTimeout(() => ov.remove(), 2800);
}

async function openChatGiftPanel() {
  if (!S.conv || !S.user || S.user.role !== 'fan') return;
  const { data } = await api('/gifts');
  const gifts = data.gifts || [];
  const balance = S.wallet ? S.wallet.credits_cents : 0;
  let sheet = $('#gift-sheet');
  if (sheet) sheet.remove();
  sheet = document.createElement('div');
  sheet.id = 'gift-sheet';
  sheet.className = 'sheet-backdrop';
  sheet.innerHTML = `
    <div class="sheet">
      <div class="sheet-title">🎁 Send ${esc(S.conv.other.display_name)} a gift
        <span class="muted small">· ${fmt(balance)}</span></div>
      <div class="gift-grid">
        ${gifts.map((g) => `
          <button class="gift-item" data-gift="${g.id}">
            <span class="gift-emoji">${g.emoji}</span>
            <span class="gift-name">${esc(g.name)}</span>
            <span class="gift-price">${fmt(g.price_cents)}</span>
          </button>`).join('') || '<div class="muted">No gifts available.</div>'}
      </div>
      <button class="btn ghost" id="gift-close" style="margin-top:10px">Close</button>
    </div>`;
  document.body.appendChild(sheet);
  const close = () => sheet.remove();
  $('#gift-close').onclick = close;
  sheet.onclick = (e) => { if (e.target === sheet) close(); };
  sheet.querySelectorAll('[data-gift]').forEach((b) => {
    b.onclick = () => sendChatGift(parseInt(b.dataset.gift));
  });
}

async function sendChatGift(giftId) {
  const sheet = $('#gift-sheet');
  if (sheet) sheet.remove();
  if (!S.conv) return;
  const { status, data } = await api('/gifts/send', {
    method: 'POST',
    body: JSON.stringify({ model_id: S.conv.other.id, gift_id: giftId,
      context: 'chat', conversation_id: S.conv.id }),
  });
  if (status === 200) {
    if (data.balance_cents != null && S.wallet) S.wallet.credits_cents = data.balance_cents;
    toast(`🎁 Gift sent — she'll love it!`);
    // The gift message + fly animation arrive via the chat:new WS push.
  } else if (status === 402) {
    toast(`Need ${fmt(data.needed_cents)} — top up your wallet 💰`, 3500);
    showBuyCredits(data.needed_cents);
  } else {
    toast('Gift failed.');
  }
}

/* ---------------- PRIORITY MESSAGES (paid banner + TTS) ---------------- */

const PRIORITY_TIERS = [
  { price_cents: 200,  duration_sec: 5 },
  { price_cents: 500,  duration_sec: 10 },
  { price_cents: 1000, duration_sec: 15 },
  { price_cents: 2000, duration_sec: 20 },
  { price_cents: 3000, duration_sec: 30 },
];

// Paid add-on: speak the priority message out loud (cents) — mirrors server VOICE_FEE_CENTS
const VOICE_FEE_CENTS = 300;

function ttsMuted() {
  try { return localStorage.getItem('slutcamp_tts_muted') === '1'; } catch (e) { return false; }
}

function speakPriority(fanName, message) {
  if (ttsMuted()) return;
  if (!('speechSynthesis' in window)) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(fanName + ' says: ' + message);
    u.rate = 1;
    speechSynthesis.speak(u);
  } catch (e) { /* TTS unavailable — banner still shows */ }
}

function stopPriorityBanner() {
  const L = S.live;
  if (L && L.priorityTimerInt) { clearInterval(L.priorityTimerInt); L.priorityTimerInt = null; }
  const el = $('#priority-banner');
  if (el) { el.classList.add('hidden'); el.innerHTML = ''; }
  try { speechSynthesis.cancel(); } catch (e) {}
}

function showPriorityBanner(p) {
  const L = S.live;
  if (!L || !p) return;
  stopPriorityBanner();
  const el = $('#priority-banner');
  if (!el) return;
  L.priorityId = p.id;
  el.classList.remove('hidden');
  el.innerHTML = `
    <div class="pm-banner">
      <div class="pm-head"><span>📢 PRIORITY${p.voice ? ' 🔊' : ''}</span><span id="priority-countdown"></span></div>
      <div class="pm-from">${esc(p.fan_name)}</div>
      <div class="pm-body">${esc(p.message)}</div>
    </div>`;
  if (p.voice) speakPriority(p.fan_name, p.message);
  const tick = () => {
    if (!S.live || S.live.sessionId !== L.sessionId) { stopPriorityBanner(); return; }
    const ms = p.ends_at - Date.now();
    if (ms <= 0) {
      stopPriorityBanner();
      // Ask the server for the next queued message (it advances the queue and
      // broadcasts the next banner via WS; this fetch is the fallback path)
      api(`/live/${L.sessionId}/priority`).then(({ status, data }) => {
        if (status === 200 && data && data.priority && S.live &&
            S.live.sessionId === L.sessionId && data.priority.id !== L.priorityId)
          showPriorityBanner(data.priority);
      }).catch(() => {});
      return;
    }
    const s = Math.ceil(ms / 1000);
    const cd = $('#priority-countdown');
    if (cd) cd.textContent = `📢 0:${String(Math.min(s, 99)).padStart(2, '0')}`;
  };
  tick();
  L.priorityTimerInt = setInterval(tick, 500);
}

function openPriorityPanel() {
  const L = S.live;
  if (!L || L.role !== 'fan') return;
  let sheet = $('#priority-sheet');
  if (sheet) sheet.remove();
  sheet = document.createElement('div');
  sheet.id = 'priority-sheet';
  sheet.className = 'sheet-backdrop';
  sheet.innerHTML = `
    <div class="sheet">
      <div class="sheet-title">📢 Priority Message <span class="muted small">· ${fmt(S.wallet ? S.wallet.credits_cents : 0)}</span></div>
      <div class="muted small" style="margin-bottom:8px">Your message shows across the stream for <b>everyone</b>. More $ = longer on screen (max 30s).</div>
      <textarea class="input" id="pm-text" rows="2" maxlength="120" placeholder="Say it loud… 😈"></textarea>
      <div class="muted small" style="text-align:right"><span id="pm-count">0</span>/120</div>
      <div class="gift-grid">
        ${PRIORITY_TIERS.map((t, i) => `
          <button class="gift-item pm-tier" data-tier="${i}">
            <span class="gift-price">${fmt(t.price_cents)}</span>
            <span class="gift-name">→ ${t.duration_sec}s on screen</span>
          </button>`).join('')}
      </div>
      <label class="checkbox-row" style="margin-top:10px">
        <input type="checkbox" id="pm-voice">
        <span>🔊 Speak my message out loud <b>(+${fmt(VOICE_FEE_CENTS)})</b></span>
      </label>
      <button class="btn" id="pm-send" style="margin-top:10px">Send 📢 · <span id="pm-send-price">${fmt(PRIORITY_TIERS[1].price_cents)}</span></button>
      <button class="btn ghost" id="pm-close" style="margin-top:8px">Close</button>
    </div>`;
  document.body.appendChild(sheet);
  let picked = 1;
  const voiceFee = () => ($('#pm-voice') && $('#pm-voice').checked) ? VOICE_FEE_CENTS : 0;
  const mark = () => {
    sheet.querySelectorAll('.pm-tier').forEach((b) =>
      b.classList.toggle('selected', parseInt(b.dataset.tier) === picked));
    const sp = $('#pm-send-price');
    if (sp) sp.textContent = fmt(PRIORITY_TIERS[picked].price_cents + voiceFee());
  };
  const ta = $('#pm-text');
  ta.oninput = () => { const c = $('#pm-count'); if (c) c.textContent = ta.value.length; };
  sheet.querySelectorAll('.pm-tier').forEach((b) => {
    b.onclick = () => { picked = parseInt(b.dataset.tier); mark(); };
  });
  mark();
  const vcb = $('#pm-voice');
  if (vcb) vcb.onchange = mark;
  const close = () => sheet.remove();
  $('#pm-close').onclick = close;
  sheet.onclick = (e) => { if (e.target === sheet) close(); };
  $('#pm-send').onclick = () => sendPriority(picked, ta.value.trim(),
    !!($('#pm-voice') && $('#pm-voice').checked));
  setTimeout(() => ta.focus(), 100);
}

async function sendPriority(tierIndex, message, voice) {
  const L = S.live;
  if (!L) return;
  if (!message) return toast('Type your message first ✍️');
  const { status, data } = await api(`/live/${L.sessionId}/priority`, {
    method: 'POST', body: JSON.stringify({ tier_index: tierIndex, message, voice: !!voice }) });
  const sheet = $('#priority-sheet');
  if (sheet) sheet.remove();
  if (status === 200) {
    if (data.balance_cents != null && S.wallet) S.wallet.credits_cents = data.balance_cents;
    // The banner itself arrives via WS broadcast (live:priority) for everyone
    toast(data.showing_now
      ? `📢 You're LIVE for ${data.duration_sec}s!`
      : `📢 Priority sent! You're #${data.position_in_queue} in queue`, 3000);
  } else if (status === 423) {
    toast(`⚠️ Priority blocked — not allowed. (${data.strikes || 0}/3 strikes)`, 3500);
  } else if (status === 402) {
    toast(`Need ${fmt(data.needed_cents)} — top up your wallet 💰`, 3500);
    showBuyCredits(data.needed_cents);
  } else {
    toast('Priority message failed.');
  }
}

/* ---------------- FAN JOIN LIVE (pay to request, model approves, 3-min stage) ---------------- */

// Mirrors server JOIN_FEE_CENTS / EXPLICIT_JOIN_FEE_CENTS / MIC_JOIN_FEE_CENTS /
// EXPLICIT_MIC_JOIN_FEE_CENTS / STAGE_MINUTES
const JOIN_FEE_CENTS = 1000;
const EXPLICIT_JOIN_FEE_CENTS = 2500;
const MIC_JOIN_FEE_CENTS = 500;
const EXPLICIT_MIC_JOIN_FEE_CENTS = 1500;
const STAGE_MINUTES = 3;

function stageJoinFee(explicit, mode) {
  const L = S.live;
  if (explicit) {
    // Fan watch view: rates from the join response
    if (L && Number.isInteger(L.explicitJoinCents) && Number.isInteger(L.explicitMicJoinCents)) {
      return mode === 'mic' ? L.explicitMicJoinCents : L.explicitJoinCents;
    }
    // Model broadcast view: her own rates from S.model
    if (S.model && Number.isInteger(S.model.explicit_join_cents)) {
      return mode === 'mic'
        ? (S.model.explicit_mic_join_cents || 1500)
        : S.model.explicit_join_cents;
    }
    return mode === 'mic' ? EXPLICIT_MIC_JOIN_FEE_CENTS : EXPLICIT_JOIN_FEE_CENTS;
  }
  return mode === 'mic' ? MIC_JOIN_FEE_CENTS : JOIN_FEE_CENTS;
}
const stageModeEmoji = (mode) => mode === 'mic' ? '🎙️' : '🎥';
const stageModeLabel = (mode) => mode === 'mic' ? 'Mic only' : 'Video + Mic';

async function loadStageState() {
  const L = S.live;
  if (!L) return;
  try {
    const { status, data } = await api(`/live/${L.sessionId}/stage`);
    if (status !== 200 || !data || !S.live || S.live.sessionId !== L.sessionId) return;
    if (data.stage && L.role === 'fan' && data.stage.fan_id !== S.user.id)
      showStageNotice(data.stage.fan_name);
    if (L.role === 'fan') {
      if (data.my_stage) onStageApproved(data.my_stage, true);
      else if (data.my_pending) { L.stagePending = true; showStageBanner('pending', data.my_pending.mode); }
      else hideStageBanner();
    }
  } catch (e) { /* ignore */ }
}

function showStageNotice(fanName, mode) {
  const el = $('#stage-banner');
  if (!el) return;
  el.classList.remove('hidden');
  const m = mode || 'video';
  el.innerHTML = `<div class="stage-notice">${stageModeEmoji(m)} <b>${esc(fanName)}</b> is on ${m === 'mic' ? 'mic' : 'stage'} with her!</div>`;
}

function showStageBanner(state, extra) {
  const el = $('#stage-banner');
  if (!el) return;
  el.classList.remove('hidden');
  const L = S.live;
  if (state === 'pending') {
    const mode = extra || 'video';
    const fee = L ? stageJoinFee(!!L.isExplicit, mode) : 0;
    el.innerHTML = `<div class="stage-notice">${stageModeEmoji(mode)} Request sent — waiting for her… 👀<br><span class="muted small">${fmt(fee)} held until she decides</span></div>`;
  } else if (state === 'onstage') {
    const mode = extra || 'video';
    el.innerHTML = mode === 'mic'
      ? `<div class="stage-notice stage-live">🎙️ <b>YOU'RE ON MIC!</b> She's hearing you live 🔥</div>`
      : `<div class="stage-notice stage-live">📹 <b>YOU'RE ON STAGE!</b> She's seeing you live 🔥</div>`;
  } else if (state === 'ended') {
    const L = S.live;
    const fee = (L && L.isExplicit) ? EXPLICIT_JOIN_FEE_CENTS : JOIN_FEE_CENTS;
    el.innerHTML = `<div class="stage-notice">⏰ Your stage time ended!<br><button class="btn small" id="stage-again-btn" style="margin-top:6px">🎥 Go again — ${fmt(fee)}</button></div>`;
    const b = $('#stage-again-btn');
    if (b) b.onclick = requestStageJoin;
  }
}

function hideStageBanner() {
  const el = $('#stage-banner');
  if (el) { el.classList.add('hidden'); el.innerHTML = ''; }
}

async function requestStageJoin() {
  const L = S.live;
  if (!L || L.role !== 'fan') return;
  if (L.stagePending || L.stagePC) return;
  openStageModeSheet();
}

// Fan picks Video or Mic-only, then confirms the request
function openStageModeSheet() {
  const L = S.live;
  if (!L) return;
  const explicit = !!L.isExplicit;
  const vFee = stageJoinFee(explicit, 'video');
  const mFee = stageJoinFee(explicit, 'mic');
  let sheet = $('#stage-mode-sheet');
  if (sheet) sheet.remove();
  sheet = document.createElement('div');
  sheet.id = 'stage-mode-sheet';
  sheet.className = 'sheet-backdrop';
  sheet.innerHTML = `
    <div class="sheet">
      <div class="sheet-title">🎙️ Join her live ${explicit ? '🔞' : ''}</div>
      <div class="muted small" style="margin-bottom:10px">She approves each request. ${STAGE_MINUTES} minutes on stage. Declined = full refund.${explicit ? ' Explicit fee covers your viewing too.' : ''}</div>
      <button class="sheet-btn" id="sm-video">🎥 Video — <b>${fmt(vFee)}</b><br><span class="muted small">She sees you on camera</span></button>
      <button class="sheet-btn" id="sm-mic">🎙️ Mic only — <b>${fmt(mFee)}</b><br><span class="muted small">She hears you, no camera</span></button>
      <button class="sheet-btn cancel" id="sm-cancel">Cancel</button>
    </div>`;
  document.body.appendChild(sheet);
  const close = () => sheet.remove();
  $('#sm-cancel').onclick = close;
  sheet.onclick = (e) => { if (e.target === sheet) close(); };
  $('#sm-video').onclick = () => { close(); sendStageRequest('video'); };
  $('#sm-mic').onclick = () => { close(); sendStageRequest('mic'); };
}

async function sendStageRequest(mode) {
  const L = S.live;
  if (!L || L.role !== 'fan') return;
  if (L.stagePending || L.stagePC) return;
  const explicit = !!L.isExplicit;
  const fee = stageJoinFee(explicit, mode);
  const { status, data } = await api(`/live/${L.sessionId}/join-request`, {
    method: 'POST', body: JSON.stringify({ mode }) });
  if (status === 200) {
    L.stagePending = true;
    if (data.balance_cents != null && S.wallet) S.wallet.credits_cents = data.balance_cents;
    showStageBanner('pending', mode);
    toast(`${stageModeEmoji(mode)} Request sent (${fmt(data.fee_cents)})! Waiting for her… 👀`, 3000);
  } else if (status === 402) {
    toast(`Need ${fmt(data.needed_cents)} — top up your wallet 💰`, 3500);
    showBuyCredits(data.needed_cents);
  } else if (status === 409 && data.error === 'stage_busy') {
    toast("She's with someone right now — try again soon! 👀", 3000);
  } else if (status === 409 && data.error === 'already_pending') {
    L.stagePending = true;
    showStageBanner('pending', mode);
  } else {
    toast('Could not send request.');
  }
}

async function onStageApproved(stage, silent) {
  const L = S.live;
  if (!L || L.role !== 'fan') return;
  L.stagePending = false;
  const mode = stage.mode || 'video';
  L.stageMode = mode;
  hideStageBanner();
  showStageBanner('onstage', mode);
  // Publish to the model (peer-to-peer; she sees/hears you, viewers see a notice)
  try {
    const constraints = mode === 'mic'
      ? { audio: true, video: false }
      : { video: { facingMode: 'user' }, audio: true };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    L.stageStream = stream;
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    stream.getTracks().forEach((t) => pc.addTrack(t, stream));
    pc.onicecandidate = (e) => {
      if (e.candidate && S.live === L) liveSignal(L.modelId, L.sessionId, { kind: 'stage-ice', candidate: e.candidate });
    };
    L.stagePC = pc;
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    liveSignal(L.modelId, L.sessionId, { kind: 'stage-offer', sdp: offer, mode });
    if (!silent) toast(mode === 'mic' ? "You're ON! 🎙️ She's hearing you live!" : "You're ON! 📹 She's seeing you live!", 3000);
  } catch (e) {
    toast(mode === 'mic' ? 'Mic permission needed for stage 🎙️' : 'Camera/mic permission needed for stage 📹');
    stopStageStream();
  }
}

function stopStageStream() {
  const L = S.live;
  if (L) {
    if (L.stagePC) { try { L.stagePC.close(); } catch (e) {} L.stagePC = null; }
    if (L.stageStream) { L.stageStream.getTracks().forEach((t) => { try { t.stop(); } catch (e) {} }); L.stageStream = null; }
    L.stagePending = false;
  }
  hideStageBanner();
}

/* --- FAN: watch (group stream) --- */

async function watchLive(sessionId) {
  if (!S.user) {
    toast('Sign up free to watch live 🔴');
    return show('auth', { mode: 'signup', role: 'fan' });
  }
  if (S.user.role !== 'fan') return toast('Fans only.');
  const { status, data } = await api(`/live/${sessionId}/join`, { method: 'POST' });
  if (status !== 200) return toast('Stream is offline.');

  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  pc.onicecandidate = (e) => {
    if (e.candidate) liveSignal(data.model_id, sessionId, { kind: 'ice', candidate: e.candidate });
  };
  pc.ontrack = (e) => {
    const v = $('#live-remote');
    if (v) v.srcObject = e.streams[0];
    startLiveMonitor();
  };

  S.live = { sessionId, role: 'fan', pc, modelId: data.model_id,
             modelName: data.model_name, explicitRate: data.explicit_rate_cents,
             paying: !!data.is_paying, blurred: false, monitorOn: false, aiReady: false,
             countdownInt: null, giftCountdownInt: null, title: data.title || '',
             isExplicit: !!data.is_explicit, explicitUntil: data.explicit_until || 0,
             entryPaid: !!data.explicit_paid, entryCents: data.explicit_entry_cents || 499,
             explicitJoinCents: data.explicit_join_cents || 2500,
             explicitMicJoinCents: data.explicit_mic_join_cents || 1500,
             explicitSource: data.is_explicit ? 'manual' : null,
             graceSec: data.explicit_grace_sec || 180,
             chat: [], gifts: [], leaderboard: [] };
  show('liveWatch', {});
  loadStreamChat();
  loadLeaderboard();
  updateLivePayHUD();
  if (data.priority) showPriorityBanner(data.priority);

  if (data.is_explicit) {
    $('#live-ai-status').textContent = '🔞 Model is explicit right now';
    if (!S.live.paying && !(S.live.explicitUntil > Date.now())) {
      applyLiveBlur(true, data.explicit_rate_cents, 'manual');
    } else if (S.live.explicitUntil > Date.now()) {
      startGiftCountdown();
    }
  } else {
    NSFW.ensure().then((ok) => {
      const s2 = $('#live-ai-status');
      if (!s2 || !S.live || S.live.sessionId !== sessionId) return;
      if (ok) { s2.textContent = '🛡️ AI monitor active'; S.live.aiReady = true; }
      else { s2.textContent = '🛡️ Manual mode — she controls explicit'; }
    });
  }
}

function vLiveWatch() {
  const L = S.live;
  if (!L) return show('fanModels', {});
  app.innerHTML = `
    <div class="live-wrap">
      <video id="live-remote" autoplay playsinline></video>
      <div id="fan-watermark" class="fan-watermark"></div>
      <div id="live-blur-overlay" class="hidden">
        <div style="font-size:52px">🔞</div>
        <div id="live-blur-title" style="font-weight:800;font-size:19px;margin:8px 0">She's getting explicit…</div>
        <button class="btn" id="live-pay-btn">Pay to keep watching</button>
        <button class="btn ghost" id="live-gift-btn" style="margin-top:8px">🎁 Send a gift to unblur</button>
        <div class="muted small" id="live-countdown" style="margin-top:8px"></div>
        <button class="btn ghost" id="live-stay-free" style="margin-top:8px">Keep watching free (blurred)</button>
      </div>
      <div id="gift-anim" class="hidden"></div>
      <div id="gift-stack"></div>
      <div class="live-top">
        <span class="live-badge">🔴 LIVE</span>
        <span class="live-viewers">${esc(L.modelName || '')}</span>
        <span id="live-ai-status" class="live-viewers">🛡️ AI monitor starting…</span>
        <button id="tts-mute-btn" class="icon-btn" style="margin-left:auto" aria-label="Toggle voice">🔊</button>
      </div>
      ${L.title ? `<div class="live-title">${esc(L.title)}</div>` : ''}
      <div id="priority-banner" class="hidden"></div>
      <div id="live-leaderboard" class="live-leaderboard hidden"></div>
      <div id="live-pay-hud" class="hidden"></div>
      <div id="live-gift-hud" class="hidden"></div>
      <div id="stream-chat" class="stream-chat fan"></div>
      <div class="stream-chat-input fan">
        <input id="stream-chat-box" class="input" placeholder="Chat is FREE — say hi! 💬" maxlength="500" autocomplete="off">
        <button class="btn small" id="stream-chat-send" style="margin:0">➤</button>
        <button class="btn small" id="gift-open-btn" style="margin:0;background:linear-gradient(135deg,#ec4899,#8b5cf6)">🎁</button>
        <button class="btn small" id="tipmenu-open-btn" style="margin:0;background:linear-gradient(135deg,#f59e0b,#f97316)" aria-label="Tip menu">💰</button>
        <button class="btn small" id="priority-open-btn" style="margin:0;background:linear-gradient(135deg,#f59e0b,#ef4444)" aria-label="Send priority message">📢</button>
        <button class="btn small" id="stage-join-btn" style="margin:0;background:linear-gradient(135deg,#8b5cf6,#3b82f6)" aria-label="Join live on camera">🎥</button>
      </div>
      <div id="stage-banner" class="hidden"></div>
      <div class="live-controls">
        <button class="btn ghost" id="live-leave-btn">Leave stream</button>
      </div>
    </div>`;
  $('#live-leave-btn').onclick = () => endLiveView();
  const sf = $('#live-stay-free');
  if (sf) sf.onclick = () => { clearInterval(S.live.countdownInt); $('#live-blur-overlay').classList.add('hidden'); };
  const sendBox = $('#stream-chat-box');
  const sendIt = () => {
    const v = sendBox.value.trim();
    if (v) { sendStreamChat(v); sendBox.value = ''; }
  };
  $('#stream-chat-send').onclick = sendIt;
  sendBox.onkeydown = (e) => { if (e.key === 'Enter') sendIt(); };
  lockCopyForFans($('#stream-chat'), sendBox);
  $('#gift-open-btn').onclick = openGiftPanel;
  const tmob = $('#tipmenu-open-btn');
  if (tmob && S.live) tmob.onclick = () => openTipMenuSheet(S.live.modelId, S.live.modelName || 'her', 'live');
  $('#priority-open-btn').onclick = openPriorityPanel;
  $('#stage-join-btn').onclick = requestStageJoin;
  loadStageState();
  // Watermark this fan's username across the stream (screenshot deterrent)
  const wm = $('#fan-watermark');
  if (wm && S.user) {
    const tag = '@' + S.user.username;
    wm.innerHTML = `<span>${esc(tag)} · ${esc(tag)} · ${esc(tag)}</span>`;
  }
  const ttsBtn = $('#tts-mute-btn');
  const syncTtsBtn = () => { if (ttsBtn) ttsBtn.textContent = ttsMuted() ? '🔇' : '🔊'; };
  syncTtsBtn();
  if (ttsBtn) ttsBtn.onclick = () => {
    const m = !ttsMuted();
    try { localStorage.setItem('slutcamp_tts_muted', m ? '1' : '0'); } catch (e) {}
    if (m) { try { speechSynthesis.cancel(); } catch (e) {} }
    syncTtsBtn();
    toast(m ? '🔇 Priority voice muted' : '🔊 Priority voice on');
  };
  renderStreamChat();
  renderLeaderboard();
}

// AI frame sampling: every 2s while watching free & unblurred
function startLiveMonitor() {
  if (!S.live || S.live.role !== 'fan' || S.live.monitorOn) return;
  S.live.monitorOn = true;
  liveMonitorInt = setInterval(async () => {
    const L = S.live;
    if (!L || L.role !== 'fan' || L.paying || L.blurred) return;
    const v = $('#live-remote');
    if (!v || v.readyState < 2) return;
    if (await NSFW.isExplicit(v)) onLiveExplicitSignal(true, L.explicitRate, 'ai');
  }, 2000);
}

/* Gift grace: ANY gift keeps this viewer's screen unblurred for graceSec.
   Per-viewer — one fan's gifts never affect another fan's blur state. */
function isGiftClear(L) { return !!(L && L.explicitUntil && L.explicitUntil > Date.now()); }

function stopGiftCountdown() {
  const L = S.live;
  if (L && L.giftCountdownInt) { clearInterval(L.giftCountdownInt); L.giftCountdownInt = null; }
  const el = $('#live-gift-hud');
  if (el) el.classList.add('hidden');
}

function startGiftCountdown() {
  const L = S.live;
  if (!L || L.role !== 'fan') return;
  stopGiftCountdown();
  const el = $('#live-gift-hud');
  const tick = () => {
    if (!S.live || S.live.sessionId !== L.sessionId) { stopGiftCountdown(); return; }
    const ms = L.explicitUntil - Date.now();
    if (ms <= 0) {
      stopGiftCountdown();
      // Grace expired — screen goes blurry again (audio + chat keep working).
      // Send another gift any time to unblur.
      if (L.isExplicit && !L.paying) applyLiveBlur(true, L.explicitRate, 'gift_expired');
      return;
    }
    const s = Math.ceil(ms / 1000);
    const mm = Math.floor(s / 60), ss = String(s % 60).padStart(2, '0');
    if (el) {
      el.classList.remove('hidden');
      el.innerHTML = s <= 30
        ? `<span class="gift-warn">⏳ Almost blurry! Send any gift to keep watching 👀 — ${mm}:${ss}</span>`
        : `<span>🔓 Clear for ${mm}:${ss} — send a gift to stay clear! 🎁</span>`;
    }
  };
  tick();
  L.giftCountdownInt = setInterval(tick, 1000);
}

function onLiveExplicitSignal(isExplicit, rateCents, source) {
  const L = S.live;
  if (!L || L.role !== 'fan') return;
  if (isExplicit) {
    L.isExplicit = true;
    // Manual toggle = fresh explicit session: server reset everyone's entry,
    // so this viewer must pay the entry fee again (stage 1 gate).
    // AI-detected explicit: server doesn't track it, keep existing entryPaid.
    // Once manual, AI signals can't downgrade the strict gate.
    if (source === 'manual') {
      L.entryPaid = false;
      L.explicitSource = 'manual';
    } else if (!L.explicitSource) {
      L.explicitSource = 'ai';
    }
    if (source === 'manual' && rateCents) L.explicitRate = rateCents;
    // Paying ($/min) or gift grace still active → stay unblurred
    if (L.paying || isGiftClear(L)) return;
    if (source === 'ai') {
      api(`/live/${L.sessionId}/blur-event`, { method: 'POST',
        body: JSON.stringify({ event: 'auto_blur', detail: 'nsfwjs Porn/Hentai>0.7' }) }).catch(() => {});
    }
    applyLiveBlur(true, rateCents, source);
  } else {
    // Explicit over — grace expires for everyone, back to clear
    L.isExplicit = false;
    L.explicitUntil = 0;
    L.entryPaid = false;
    L.explicitSource = null;
    stopGiftCountdown();
    applyLiveBlur(false);
  }
}

function applyLiveBlur(on, rateCents, source) {
  const L = S.live;
  if (!L || L.role !== 'fan') return;
  const v = $('#live-remote');
  const ov = $('#live-blur-overlay');
  if (on) {
    L.blurred = true;
    if (v) v.classList.add('blurred');
    if (ov) {
      ov.classList.remove('hidden');
      const title = $('#live-blur-title');
      const pb = $('#live-pay-btn');
      // STAGE 1 — entry fee gate: never paid entry and not on per-minute pay
      const entryWall = !L.entryPaid && !L.paying;
      if (entryWall) {
        if (title) title.textContent = "🔞 She's explicit! Pay the entry fee to unblur";
        pb.textContent = `🔓 Pay ${fmt(L.entryCents || 499)} to unblur`;
        pb.onclick = payExplicitEntry;
      } else {
        if (title) title.textContent = source === 'gift_expired'
          ? "😈 She's still going… send a gift to unblur!"
          : "She's getting explicit…";
        pb.textContent = `🔓 Pay ${fmt(rateCents || L.explicitRate)}/min to keep watching`;
        pb.onclick = livePayExplicit;
      }
      const gb = $('#live-gift-btn');
      if (gb) gb.onclick = () => {
        ov.classList.add('hidden');
        openGiftPanel(() => {
          // Closed without gifting and still blurred → bring the prompt back
          if (S.live && S.live.sessionId === L.sessionId &&
              S.live.blurred && !S.live.paying && !isGiftClear(S.live)) {
            ov.classList.remove('hidden');
          }
        });
      };
      const cd = $('#live-countdown');
      clearInterval(L.countdownInt);
      if (source === 'gift_expired' || entryWall) {
        // Grace ran out or entry not paid — no kick, they keep audio + chat blurred.
        // Pay the entry fee (stage 1) or send any gift (stage 2) to unblur.
        if (cd) cd.textContent = '';
      } else {
        let secs = 30;
        const tick = () => {
          if (!S.live || S.live.sessionId !== L.sessionId) { clearInterval(L.countdownInt); return; }
          if (cd) cd.textContent = secs > 0 ? `Free preview ends in ${secs}s` : '';
          if (secs-- <= 0) {
            clearInterval(L.countdownInt);
            api(`/live/${L.sessionId}/blur-event`, { method: 'POST',
              body: JSON.stringify({ event: 'timeout_kick', detail: source || 'ai' }) }).catch(() => {});
            endLiveView('Preview over — pay to keep watching!');
          }
        };
        tick();
        L.countdownInt = setInterval(tick, 1000);
        api(`/live/${L.sessionId}/blur-event`, { method: 'POST',
          body: JSON.stringify({ event: 'paywall_shown', detail: source || 'ai' }) }).catch(() => {});
      }
    }
  } else {
    L.blurred = false;
    clearInterval(L.countdownInt);
    if (v) v.classList.remove('blurred');
    if (ov) ov.classList.add('hidden');
  }
}

async function livePayExplicit() {
  const L = S.live;
  if (!L) return;
  const { status, data } = await api(`/live/${L.sessionId}/pay`, { method: 'POST' });
  if (status === 200) {
    L.paying = true;
    L.entryPaid = true; // per-minute pay counts as entry-paid: stopping drops to gift loop, not entry wall
    stopGiftCountdown();
    applyLiveBlur(false);
    if (data.balance_cents != null && S.wallet) S.wallet.credits_cents = data.balance_cents;
    updateLivePayHUD();
    toast(`🔓 Unblurred — ${fmt(data.rate_cents)}/min`);
  } else if (status === 402) {
    toast(`Need ${fmt(data.needed_cents)} — top up 💰`);
  } else {
    toast('Payment failed.');
  }
}

// STAGE 1 — pay the one-time explicit entry fee. On success the gift grace
// timer (stage 2 upkeep) starts immediately.
async function payExplicitEntry() {
  const L = S.live;
  if (!L) return;
  const { status, data } = await api(`/live/${L.sessionId}/explicit-entry`, { method: 'POST' });
  if (status === 200) {
    L.entryPaid = true;
    L.explicitUntil = data.explicit_until || 0;
    if (data.explicit_grace_sec) L.graceSec = data.explicit_grace_sec;
    if (data.balance_cents != null && S.wallet) S.wallet.credits_cents = data.balance_cents;
    applyLiveBlur(false);
    startGiftCountdown();
    toast(`🔓 You're in! Keep sending gifts to stay clear 🎁`);
  } else if (status === 402) {
    toast(`Need ${fmt(data.needed_cents)} — top up 💰`);
    showBuyCredits(data.needed_cents);
  } else if (status === 409) {
    // Server says already paid (e.g. paid on another device) — sync up
    L.entryPaid = true;
    applyLiveBlur(false);
    toast('Already paid — enjoy the show 🔓');
  } else {
    toast('Payment failed.');
  }
}

function updateLivePayHUD() {
  const el = $('#live-pay-hud');
  if (!el || !S.live) return;
  el.classList.toggle('hidden', !S.live.paying);
  if (S.live.paying) {
    el.innerHTML = `<span>🔞 Paying ${fmt(S.live.explicitRate)}/min</span>
      <button class="btn small ghost" id="live-stop-pay">Stop</button>`;
    $('#live-stop-pay').onclick = async () => {
      await api(`/live/${S.live.sessionId}/stop-pay`, { method: 'POST' }).catch(() => {});
      S.live.paying = false;
      updateLivePayHUD();
      applyLiveBlur(true, S.live.explicitRate, 'manual');
    };
  }
}

async function handleLiveSignal(m) {
  const p = m.payload || {};
  if (!S.live || m.session_id !== S.live.sessionId) return;
  try {
    if (S.live.role === 'fan') {
      if (p.kind === 'offer') {
        await S.live.pc.setRemoteDescription(new RTCSessionDescription(p.sdp));
        const answer = await S.live.pc.createAnswer();
        await S.live.pc.setLocalDescription(answer);
        liveSignal(m.from, S.live.sessionId, { kind: 'answer', sdp: answer });
      } else if (p.kind === 'ice') {
        await S.live.pc.addIceCandidate(new RTCIceCandidate(p.candidate));
      } else if (p.kind === 'stage-answer' && S.live.stagePC) {
        await S.live.stagePC.setRemoteDescription(new RTCSessionDescription(p.sdp));
      } else if (p.kind === 'stage-ice' && S.live.stagePC) {
        await S.live.stagePC.addIceCandidate(new RTCIceCandidate(p.candidate));
      }
    } else if (S.live.role === 'model') {
      if (p.kind === 'stage-offer') {
        // Incoming stage media from an approved fan (peer-to-peer, model sees/hears them)
        if (p.mode) S.live.stageMode = p.mode;
        if (S.live.stagePC) { try { S.live.stagePC.close(); } catch (e) {} }
        const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
        S.live.stagePC = pc;
        S.live.stageFanId = m.from;
        pc.ontrack = (e) => {
          const isMic = (S.live && S.live.stageMode) === 'mic';
          if (isMic) {
            // Audio-only: play through a hidden audio element, show mic indicator
            let a = $('#stage-audio');
            if (!a) {
              a = document.createElement('audio');
              a.id = 'stage-audio'; a.autoplay = true; a.playsInline = true;
              $('#stage-pip').appendChild(a);
            }
            a.srcObject = e.streams[0];
            // iOS Safari blocks autoplay — explicitly play on user gesture context
            a.play().catch(() => {
              // If blocked, add a tap-to-hear button
              if (!$('#stage-unmute-btn')) {
                const btn = document.createElement('button');
                btn.id = 'stage-unmute-btn';
                btn.className = 'btn small';
                btn.textContent = '🔊 Tap to hear them';
                btn.onclick = () => { a.play().then(() => btn.remove()).catch(() => {}); };
                $('#stage-pip').appendChild(btn);
              }
            });
            const mic = $('#stage-mic');
            if (mic) mic.classList.remove('hidden');
          } else {
            const v = $('#stage-video');
            if (v) { v.srcObject = e.streams[0]; v.classList.remove('hidden'); v.play().catch(() => {}); }
          }
          const wrap = $('#stage-pip');
          if (wrap) wrap.classList.remove('hidden');
        };
        pc.onicecandidate = (e) => {
          if (e.candidate && S.live) liveSignal(m.from, S.live.sessionId, { kind: 'stage-ice', candidate: e.candidate });
        };
        await pc.setRemoteDescription(new RTCSessionDescription(p.sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        liveSignal(m.from, S.live.sessionId, { kind: 'stage-answer', sdp: answer });
        return;
      }
      if (p.kind === 'stage-ice' && S.live.stagePC && m.from === S.live.stageFanId) {
        await S.live.stagePC.addIceCandidate(new RTCIceCandidate(p.candidate));
        return;
      }
      const pc = livePCs.get(m.from);
      if (!pc) return;
      if (p.kind === 'answer') await pc.setRemoteDescription(new RTCSessionDescription(p.sdp));
      else if (p.kind === 'ice') await pc.addIceCandidate(new RTCIceCandidate(p.candidate));
    }
  } catch (e) { /* stale signaling */ }
}

function endLiveView(msg) {
  const L = S.live;
  if (L) {
    clearInterval(liveMonitorInt);
    clearInterval(L.countdownInt);
    clearInterval(L.giftCountdownInt);
    L.giftCountdownInt = null;
    clearInterval(L.priorityTimerInt);
    L.priorityTimerInt = null;
    L.priorityId = null;
    clearInterval(L.stageCountdownInt);
    L.stageCountdownInt = null;
    L.stageReqId = null;
    L.stagePending = false;
    clearInterval(L.stagePoll);
    L.stagePoll = null;
    try { speechSynthesis.cancel(); } catch (e) {}
    if (L.stagePC) { try { L.stagePC.close(); } catch (e) {} }
    if (L.stageStream) { L.stageStream.getTracks().forEach((t) => { try { t.stop(); } catch (e) {} }); }
    if (L.role === 'fan') {
      api(`/live/${L.sessionId}/leave`, { method: 'POST' }).catch(() => {});
      if (L.pc) { try { L.pc.close(); } catch (e) {} }
    } else if (L.role === 'model') {
      api(`/live/${L.sessionId}/end`, { method: 'POST' }).catch(() => {});
      for (const [, pc] of livePCs) { try { pc.close(); } catch (e) {} }
      livePCs.clear();
      if (L.stream) L.stream.getTracks().forEach((t) => t.stop());
    }
    S.live = null;
  }
  tabbar.classList.remove('hidden');
  if (msg) toast(msg);
  if (S.user && S.user.role === 'model') show('modelChats', {});
  else if (S.user) show('fanModels', {});
  else show('landing', {});
}

/* ---------------- ADMIN (continued) ---------------- */

async function vAdmin() {
  const tab = S.adminTab || 'dash';
  const { data: stats } = await api('/admin/stats');
  const tabs = [
    ['dash', '📊 Home'], ['chats', '👀 Chats'], ['safety', '🛡️ Safety'], ['live', '🔴 Live'],
    ['models', '💃 Models'], ['invites', '✉️ Invites'], ['payouts', '💸 Payouts'], ['fans', '🧑 Fans'],
    ['bookings', '📅 Bookings'], ['contracts', '📝 Contracts'], ['idchecks', '🪪 ID Checks'], ['partners', '🤝 Partners'],
    ['refunds', '💳 Refunds'], ['disputes', '⚠️ Disputes'], ['tax', '🧾 Tax'], ['dmca', '⚖️ DMCA'], ['more', '⚙️ More'],
  ];
  let body = '';
  if (tab === 'dash') body = await adminDashBody(stats);
  else if (tab === 'chats') body = await adminChatsBody();
  else if (tab === 'safety') body = await adminSafetyBody();
  else if (tab === 'live') body = await adminLiveBody();
  else if (tab === 'models') body = await adminModelsBody();
  else if (tab === 'invites') body = await adminInvitesBody();
  else if (tab === 'payouts') body = await adminPayoutsBody();
  else if (tab === 'fans') body = await adminFansBody();
  else if (tab === 'bookings') body = await adminBookingsBody();
  else if (tab === 'contracts') body = await adminContractsBody();
  else if (tab === 'idchecks') body = await adminIdChecksBody();
  else if (tab === 'partners') body = await adminPartnersBody();
  else if (tab === 'refunds') body = await adminRefundsBody();
  else if (tab === 'disputes') body = await adminDisputesBody();
  else if (tab === 'tax') body = await adminTaxBody();
  else if (tab === 'dmca') body = await adminDmcaBody();
  else body = await adminMoreBody(stats);

  app.innerHTML = `
    <div class="header"><h1>Moderator 🛡️</h1><div class="sub">Hey Corry — everything at a glance</div></div>
    <div class="screen">
      <div class="tabs">${tabs.map(([id, l]) =>
        `<button data-atab="${id}" class="${tab === id ? 'active' : ''}">${l}${id === 'safety' && stats.open_incidents ? ` <span class="unread-badge">${stats.open_incidents}</span>` : ''}${id === 'dmca' && stats.open_dmca ? ` <span class="unread-badge">${stats.open_dmca}</span>` : ''}</button>`).join('')}
      </div>
      <div id="admin-body">${body}</div>
    </div>`;
  app.querySelectorAll('[data-atab]').forEach((b) => {
    b.onclick = () => { S.adminTab = b.dataset.atab; show('admin', {}); };
  });
  wireAdminBody(tab);
}

async function adminDashBody(s) {
  return `
    <div class="stat-grid">
      <div class="stat"><div class="n" style="color:var(--green)">${fmt(s.earnings_cents)}</div><div class="l">Platform earnings (${s.commission_pct}%)</div></div>
      <div class="stat"><div class="n">${fmt(s.gross_volume_cents)}</div><div class="l">Total fan spending</div></div>
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
          ${s.status === 'live' ? `<button class="btn small danger" data-live-end="${s.id}">End</button>` : ''}
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

async function adminModelsBody() {
  const { data } = await api('/admin/models');
  const models = data.models || [];
  return `
    ${models.map((m) => `
      <div class="card" style="padding:12px">
        <div class="row">
          ${avatarHTML(m.display_name, 'sm', m.photo_url)}
          <span class="grow"><b>${esc(m.display_name)}</b> <span class="small muted">@${esc(m.username)}</span><br>
            <span class="small" style="color:${m.is_online ? 'var(--green)' : 'var(--muted)'}">● ${m.is_online ? 'Online' : 'Offline'}</span>
            <span class="small muted"> · ${fmt(m.per_message_cents)}/msg · ${fmt(m.per_minute_cents)}/min</span><br>
            <span class="small" style="color:var(--green)">Owed: ${fmt(m.pending_cents)}</span>
            ${m.recruiter_name ? `<br><span class="small" style="color:var(--gold)">🤝 via ${esc(m.recruiter_name)}</span>` : ''}</span>
        </div>
        <div class="row" style="margin-top:8px;gap:6px;flex-wrap:wrap">
          <button class="btn small ghost" data-m-edit="${m.id}">✏️ Rates</button>
          <button class="btn small ghost" data-m-photo="${m.id}">📷 Photo</button>
          <button class="btn small ghost" data-m-toggle="${m.id}">${m.banned ? "✅ Reactivate" : "⏸️ Deactivate"}</button>
          <button class="btn small danger" data-m-del="${m.id}">Remove</button>
        </div>
        <div id="edit-${m.id}"></div>
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
  return `
    <div class="card">
      <div style="font-weight:800;margin-bottom:6px">✉️ Generate model invite link</div>
      <div class="muted small">Send this link to a model — she signs up through it and gets a model account. You can revoke it anytime.</div>
      <label class="field">Label (e.g. her name)<input class="input" id="inv-label" placeholder="Bunny"></label>
      <button class="btn" id="inv-gen">Generate invite link</button>
    </div>
    ${invites.map((inv) => {
      const url = `${baseUrl}/?invite=${inv.code}`;
      const status = inv.is_revoked ? '<span style="color:var(--red)">⛔ Revoked</span>'
        : inv.used_by ? `<span style="color:var(--green)">✅ Used by ${esc(inv.used_by.display_name)}${inv.used_by.banned ? ' (deactivated)' : ''}</span>`
        : '<span style="color:var(--yellow)">⏳ Waiting for signup</span>';
      return `
      <div class="card" style="padding:12px">
        <div class="row"><span class="grow"><b>${esc(inv.label) || 'Untitled invite'}</b><br>
          <span class="small muted">${url}</span><br>${status}
          ${inv.used_at ? `<br><span class="small muted">Used ${timeHM(inv.used_at)}</span>` : ''}</span></div>
        <div class="row" style="margin-top:8px;gap:6px;flex-wrap:wrap">
          ${!inv.is_revoked ? `<button class="btn small" data-inv-copy="${inv.code}">📋 Copy link</button>` : ''}
          ${!inv.is_revoked ? `<button class="btn small danger" data-inv-revoke="${inv.id}" data-used="${inv.used_by ? 1 : 0}">Revoke</button>` : ''}
        </div>
      </div>`;
    }).join('') || '<div class="empty">No invite links yet.</div>'}`;
}

async function adminPayoutsBody() {
  const { data } = await api('/admin/payouts');
  const { data: wdData } = await api('/admin/withdrawals');
  const wds = (wdData && wdData.withdrawals) || [];
  const pending = wds.filter((w) => w.status === 'pending');
  const done = wds.filter((w) => w.status !== 'pending');
  const wdBadge = (s) => s === 'pending' ? '⏳ Pending' : s === 'paid' ? '✅ Paid' : '❌ Rejected';
  return `
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
  return `
    ${(data.fans || []).map((f) => `
      <div class="card" style="padding:12px">
        <div class="row"><span class="grow"><b>${esc(f.display_name)}</b>
          <span class="small muted">@${esc(f.username)}</span><br>
          <span class="small">Balance ${fmt(f.credits_cents)} · Spent ${fmt(f.spent_cents)}</span>
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
      <div class="muted small">You keep this % of every payment. Models get the rest.</div>
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

/* ---------------- ADMIN: 💳 Refunds ---------------- */
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

/* ---------------- ADMIN: ⚠️ Disputes ---------------- */
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

function wireAdminBody(tab) {
  const go = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
  go('#go-safety', () => { S.adminTab = 'safety'; show('admin', {}); });
  go('#a-logout', () => logout());

  // 🧾 Tax — CSV export for the accountant (download via fetch → blob)
  go('#tax-export', async () => {
    toast('Preparing CSV…');
    try {
      const headers = {};
      if (S.token) headers['Authorization'] = 'Bearer ' + S.token;
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
          if (r2.status === 200) { toast('✅ Number updated — 2FA stays on'); return show('admin', {}); }
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
    if (status === 200) { toast('⛔ Two-step auth is OFF'); return show('admin', {}); }
    toast('Wrong password.');
  });

  document.querySelectorAll('[data-viewchat]').forEach((b) => {
    b.onclick = async () => {
      const id = parseInt(b.dataset.viewchat);
      const { data } = await api('/admin/conversations');
      const c = (data.conversations || []).find((x) => x.id === id);
      if (!c) return;
      // Admin read-only peek: reuse chat screen in read-only mode
      const { data: m } = await api(`/conversations/${id}/messages?limit=50`);
      S.conv = { id, other: { display_name: `${c.model_name} ↔ ${c.fan_name}` }, is_paused: true, readonly: true };
      S.messages = m.messages || [];
      app.innerHTML = `
        <div class="chat-header"><button class="icon-btn" id="c-back">‹</button>
          <div class="grow"><div class="name">👀 ${esc(c.model_name)} ↔ ${esc(c.fan_name)}</div>
          <div class="status">Read-only monitor</div></div></div>
        <div id="messages"></div><div style="height:20px"></div>`;
      $('#c-back').onclick = () => show('admin', {});
      renderMessages();
    };
  });
  document.querySelectorAll('[data-pause]').forEach((b) => {
    b.onclick = async () => { await api(`/admin/conversations/${b.dataset.pause}/pause`, { method: 'POST' }); show('admin', {}); };
  });
  document.querySelectorAll('[data-resume]').forEach((b) => {
    b.onclick = async () => { await api(`/admin/conversations/${b.dataset.resume}/resume`, { method: 'POST' }); show('admin', {}); };
  });
  document.querySelectorAll('[data-live-end]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('End this live stream?')) return;
      await api(`/live/${b.dataset.liveEnd}/end`, { method: 'POST' });
      toast('Stream ended.');
      show('admin', {});
    };
  });

  // Gift catalog management
  document.querySelectorAll('[data-gift-toggle]').forEach((b) => {
    b.onclick = async () => {
      const id = b.dataset.giftToggle;
      const cur = b.textContent.includes('⏸️');
      await api(`/admin/gifts/${id}`, {
        method: 'PUT', body: JSON.stringify({ enabled: cur ? 0 : 1 }) });
      show('admin', {});
    };
  });
  document.querySelectorAll('[data-gift-del]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Delete this gift from the catalog?')) return;
      await api(`/admin/gifts/${b.dataset.giftDel}`, { method: 'DELETE' });
      show('admin', {});
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
        toast('✅ Price updated'); show('admin', {});
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
    show('admin', {});
  });

  // Safety
  document.querySelectorAll('[data-inc-resume]').forEach((b) => {
    b.onclick = async () => {
      await api(`/admin/safety/incidents/${b.dataset.incResume}/resolve`, {
        method: 'POST', body: JSON.stringify({ action: 'resume' }) });
      toast('✅ Chat resumed'); show('admin', {});
    };
  });
  document.querySelectorAll('[data-inc-dismiss]').forEach((b) => {
    b.onclick = async () => {
      await api(`/admin/safety/incidents/${b.dataset.incDismiss}/resolve`, {
        method: 'POST', body: JSON.stringify({ action: 'dismiss' }) });
      show('admin', {});
    };
  });
  document.querySelectorAll('[data-kw-toggle]').forEach((b) => {
    b.onclick = async () => {
      const on = b.classList.contains('on');
      await api(`/admin/safety/keywords/${b.dataset.kwToggle}`, {
        method: 'PUT', body: JSON.stringify({ enabled: !on }) });
      show('admin', {});
    };
  });
  document.querySelectorAll('[data-kw-del]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Delete this keyword?')) return;
      await api(`/admin/safety/keywords/${b.dataset.kwDel}`, { method: 'DELETE' });
      show('admin', {});
    };
  });
  go('#kw-add', async () => {
    const kw = $('#kw-new').value.trim();
    if (!kw) return;
    const { status } = await api('/admin/safety/keywords', {
      method: 'POST', body: JSON.stringify({ keyword: kw }) });
    toast(status === 200 ? '✅ Keyword added' : 'Already exists');
    show('admin', {});
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
    show('admin', {});
  });
  document.querySelectorAll('[data-inv-copy]').forEach((b) => {
    b.onclick = async () => {
      const url = `${window.location.origin}/?invite=${b.dataset.invCopy}`;
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
      show('admin', {});
    };
  });

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
      show('admin', {});
    };
  });

  // Models
  document.querySelectorAll('[data-m-edit]').forEach((b) => {
    b.onclick = () => {
      const id = b.dataset.mEdit;
      const box = $('#edit-' + id);
      box.innerHTML = `
        <div class="row" style="margin-top:8px">
          <input class="input" id="em-${id}" type="number" step="0.01" placeholder="$/msg" style="margin-top:0">
          <input class="input" id="ev-${id}" type="number" step="0.01" placeholder="$/min" style="margin-top:0">
          <button class="btn small" id="es-${id}">Save</button>
        </div>`;
      $('#es-' + id).onclick = async () => {
        const per_message_cents = Math.round(parseFloat($('#em-' + id).value || '0') * 100);
        const per_minute_cents = Math.round(parseFloat($('#ev-' + id).value || '0') * 100);
        await api(`/admin/models/${id}`, { method: 'PUT',
          body: JSON.stringify({ per_message_cents, per_minute_cents }) });
        toast('✅ Rates updated'); show('admin', {});
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
      show('admin', {});
    };
  });
  document.querySelectorAll('[data-m-del]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Remove this model permanently?')) return;
      await api(`/admin/models/${b.dataset.mDel}`, { method: 'DELETE' });
      show('admin', {});
    };
  });
  document.querySelectorAll('[data-m-photo]').forEach((b) => {
    b.onclick = () => {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = 'image/*';
      inp.onchange = async () => {
        const file = inp.files[0];
        if (!file) return;
        toast('Uploading photo…');
        const { status, data } = await apiUpload(`/admin/models/${b.dataset.mPhoto}/photo`, file);
        if (status === 200 && data.ok) { toast('📷 Photo updated!'); show('admin', {}); }
        else toast('Upload failed — use a JPG/PNG under 5MB.');
      };
      inp.click();
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
    if (status === 200) show('admin', {});
  });

  // Payouts
  document.querySelectorAll('[data-pay]').forEach((b) => {
    b.onclick = async () => {
      const id = b.dataset.pay;
      const amount_cents = Math.round(parseFloat($('#pay-' + id).value || '0') * 100);
      if (!amount_cents) return toast('Enter an amount');
      const { status, data } = await api(`/admin/payouts/${id}`, {
        method: 'POST', body: JSON.stringify({ amount_cents }) });
      toast(status === 200 ? '✅ Marked as paid' : `Too much — pending is ${fmt(data.pending_cents || 0)}`);
      if (status === 200) show('admin', {});
    };
  });

  // Withdrawal requests
  document.querySelectorAll('[data-wd-pay]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      const { status } = await api(`/admin/withdrawals/${b.dataset.wdPay}/pay`, { method: 'POST' });
      toast(status === 200 ? '✅ Withdrawal marked as paid' : 'Could not mark paid');
      if (status === 200) show('admin', {}); else b.disabled = false;
    };
  });
  document.querySelectorAll('[data-wd-reject]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Reject this withdrawal? The funds stay available to her.')) return;
      b.disabled = true;
      const { status } = await api(`/admin/withdrawals/${b.dataset.wdReject}/reject`, { method: 'POST' });
      toast(status === 200 ? 'Withdrawal rejected' : 'Could not reject');
      if (status === 200) show('admin', {}); else b.disabled = false;
    };
  });

  // Fans
  document.querySelectorAll('[data-credit]').forEach((b) => {
    b.onclick = async () => {
      const id = b.dataset.credit;
      const amount_cents = Math.round(parseFloat($('#cr-' + id).value || '0') * 100);
      if (!amount_cents) return toast('Enter an amount');
      await api(`/admin/fans/${id}/credits`, { method: 'POST', body: JSON.stringify({ amount_cents }) });
      toast('✅ Credits added'); show('admin', {});
    };
  });
  document.querySelectorAll('[data-ban]').forEach((b) => {
    b.onclick = async () => {
      const id = b.dataset.ban;
      const { data } = await api('/admin/fans');
      const f = (data.fans || []).find((x) => x.id === parseInt(id));
      await api(`/admin/fans/${id}/${f.banned ? 'unban' : 'ban'}`, { method: 'POST' });
      show('admin', {});
    };
  });

  // Settings
  go('#set-comm-go', async () => {
    const commission_pct = parseInt($('#set-comm').value);
    const { status } = await api('/admin/settings', {
      method: 'PUT', body: JSON.stringify({ commission_pct }) });
    toast(status === 200 ? `✅ Commission set to ${commission_pct}%` : 'Use 0–90');
    if (status === 200) show('admin', {});
  });
  go('#set-grace-go', async () => {
    const mins = parseInt($('#set-grace').value);
    const explicit_gift_grace_sec = mins * 60;
    const { status } = await api('/admin/settings', {
      method: 'PUT', body: JSON.stringify({ explicit_gift_grace_sec }) });
    toast(status === 200 ? `✅ Gift grace set to ${mins} min` : 'Use 1–60 minutes');
    if (status === 200) show('admin', {});
  });
  go('#set-entry-go', async () => {
    const dollars = parseFloat($('#set-entry').value);
    const explicit_entry_cents = Math.round(dollars * 100);
    const { status } = await api('/admin/settings', {
      method: 'PUT', body: JSON.stringify({ explicit_entry_cents }) });
    toast(status === 200 ? `✅ Entry fee set to $${dollars.toFixed(2)}` : 'Use $1.00–$100.00');
    if (status === 200) show('admin', {});
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
      if (http === 200) show('admin', {});
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
      if (status === 200) show('admin', {});
    });
    app.querySelectorAll('[data-idv-reject]').forEach((b) => b.onclick = async () => {
      const id = b.dataset.idvReject;
      const note = prompt('Rejection reason (shown to her so she knows what to fix):', 'Photo unclear — please retake');
      if (note === null) return; // cancelled
      const { status } = await api(`/admin/id-verifications/${id}/reject`, {
        method: 'POST', body: JSON.stringify({ note }) });
      toast(status === 200 ? 'ID rejected — she can resubmit.' : 'Could not reject.');
      if (status === 200) show('admin', {});
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
    if (status === 200) show('admin', {});
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
      show('admin', {});
    } else toast('Could not file dispute.');
  });
  app.querySelectorAll('[data-dp-win]').forEach((b) => b.onclick = async () => {
    const { status } = await api(`/admin/disputes/${b.dataset.dpWin}`,
      { method: 'PUT', body: JSON.stringify({ status: 'won' }) });
    if (status === 200) show('admin', {});
  });
  app.querySelectorAll('[data-dp-lose]').forEach((b) => b.onclick = async () => {
    const { status } = await api(`/admin/disputes/${b.dataset.dpLose}`,
      { method: 'PUT', body: JSON.stringify({ status: 'lost' }) });
    if (status === 200) show('admin', {});
  });
  app.querySelectorAll('[data-dp-freeze]').forEach((b) => b.onclick = async () => {
    if (!confirm('Freeze this account? They will be logged out immediately.')) return;
    const { status } = await api(`/admin/fans/${b.dataset.dpFreeze}/freeze`, { method: 'POST' });
    toast(status === 200 ? '🧊 Account frozen' : 'Could not freeze.');
    if (status === 200) show('admin', {});
  });
  app.querySelectorAll('[data-dp-unfreeze]').forEach((b) => b.onclick = async () => {
    const { status } = await api(`/admin/fans/${b.dataset.dpUnfreeze}/unfreeze`, { method: 'POST' });
    toast(status === 200 ? '✅ Account unfrozen' : 'Could not unfreeze.');
    if (status === 200) show('admin', {});
  });
}

/* ---------------- PWA install ---------------- */

let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  if (!localStorage.getItem('wc_install_dismissed')) $('#install-banner').classList.remove('hidden');
});
$('#install-btn').onclick = async () => {
  if (deferredPrompt) { deferredPrompt.prompt(); deferredPrompt = null; }
  $('#install-banner').classList.add('hidden');
};
$('#install-dismiss').onclick = () => {
  localStorage.setItem('wc_install_dismissed', '1');
  $('#install-banner').classList.add('hidden');
};
// iOS Safari: no beforeinstallprompt — show manual hint once
if (/iphone|ipad|ipod/i.test(navigator.userAgent) && !navigator.standalone &&
    !localStorage.getItem('wc_install_dismissed')) {
  setTimeout(() => {
    const b = $('#install-banner');
    b.querySelector('span').textContent = '📲 Tap Share → "Add to Home Screen" to install';
    b.querySelector('#install-btn').style.display = 'none';
    b.classList.remove('hidden');
  }, 3000);
}

/* ---------------- call overlay buttons ---------------- */

$('#call-accept').onclick = acceptCall;
$('#call-decline').onclick = declineCall;
$('#call-hangup').onclick = hangupCall;

/* ---------------- 18+ age gate ---------------- */
// Resolves when the visitor has verified they are 18+. Shows a full-screen
// date-of-birth gate on every load where the localStorage flag is missing.
function checkAgeGate() {
  return new Promise((resolve) => {
    if (localStorage.getItem('slutcamp_age_ok') === '1') return resolve();
    const gate = $('#age-gate');
    gate.classList.remove('hidden');
    // Set max to today so future dates can't be picked
    const dob = $('#age-dob');
    dob.max = new Date().toISOString().slice(0, 10);
    $('#age-form').onsubmit = (e) => {
      e.preventDefault();
      const err = $('#age-error');
      err.classList.add('hidden');
      const val = dob.value;
      if (!val) {
        err.textContent = 'Please enter your date of birth.';
        err.classList.remove('hidden');
        return;
      }
      const parts = val.split('-').map(Number);
      const birth = new Date(parts[0], parts[1] - 1, parts[2]);
      const now = new Date();
      // Validate the date is real (catches Feb 30 etc.) and in a sane range
      if (isNaN(birth.getTime()) ||
          birth.getFullYear() !== parts[0] ||
          birth.getMonth() !== parts[1] - 1 ||
          birth.getDate() !== parts[2] ||
          birth > now || parts[0] < 1900) {
        err.textContent = 'Please enter a valid date of birth.';
        err.classList.remove('hidden');
        return;
      }
      let age = now.getFullYear() - birth.getFullYear();
      const hadBirthday = now.getMonth() > birth.getMonth() ||
        (now.getMonth() === birth.getMonth() && now.getDate() >= birth.getDate());
      if (!hadBirthday) age--;
      if (age >= 18) {
        localStorage.setItem('slutcamp_age_ok', '1');
        gate.classList.add('hidden');
        resolve();
      } else {
        gate.querySelector('.age-gate-card').innerHTML =
          '<h1 class="age-gate-logo">SLUT<span>CAMP</span></h1>' +
          '<div class="age-gate-denied">You must be 18 or older to enter SlutCamp.</div>' +
          '<p><a href="https://www.google.com">← Back to Google</a></p>';
      }
    };
  });
}

/* ---------------- boot ---------------- */

(async function boot() {
  // Age gate first — nothing else renders until confirmed 18+
  await checkAgeGate();
  // Secret admin route: #boss → dedicated admin login (not linked anywhere in UI)
  if (window.location.hash === '#boss') {
    await ensureGuest();
    wsConnect();
    return show('adminLogin', {});
  }
  // Model invite link: ?invite=CODE → dedicated signup screen
  const inviteCode = new URLSearchParams(window.location.search).get('invite');
  if (inviteCode && /^[a-f0-9]{18}$/.test(inviteCode)) {
    await ensureGuest();
    wsConnect();
    // Clean the URL so refresh doesn't re-trigger (keep it simple — replace state)
    try { window.history.replaceState({}, '', window.location.pathname); } catch (e) {}
    return vInviteSignup(inviteCode);
  }
  // Partner referral link: #join/CODE → model signup attributed to that recruiter
  const joinMatch = window.location.hash.match(/^#join\/([a-f0-9]{8})$/);
  if (joinMatch) {
    await ensureGuest();
    wsConnect();
    try { window.history.replaceState({}, '', window.location.pathname); } catch (e) {}
    return vRecruiterSignup(joinMatch[1]);
  }
  if (S.token) {
    const { status } = await api('/me');
    if (status === 200) {
      await refreshMe();
      wsConnect();
      if (S.user.role === 'admin') return show('admin', {});
      if (S.user.role === 'model') {
        await checkContractGate();
        return show('modelChats', {});
      }
      if (S.user.role === 'recruiter') return show('recruiter', {});
      return show('fanModels', {});
    }
    S.token = null;
    localStorage.removeItem('wc_token');
  }
  await ensureGuest();
  wsConnect();
  show('landing', {});
})();

// Secret admin route on hash change (after initial load)
window.addEventListener('hashchange', () => {
  if (window.location.hash === '#boss') show('adminLogin', {});
});

/* ---------------- TERMS OF SERVICE ---------------- */

function vTerms() {
  tabbar.classList.add('hidden');
  app.innerHTML = `
    <div class="header">
      <h1>Slut<span class="logo">Camp</span> 📜</h1>
      <div class="sub">Terms of Service · Last updated October 10, 2026</div>
    </div>
    <div class="screen">
      <div class="card">
        <div style="font-weight:800;margin-bottom:8px">1. 18+ Only</div>
        <div class="small muted">SlutCamp is strictly for adults 18 and older. By using this app you confirm you are at least 18. Models must complete ID verification with Asce before going live (18 U.S.C. §2257 compliance).</div>
      </div>
      <div class="card">
        <div style="font-weight:800;margin-bottom:8px">2. How Fans Pay</div>
        <div class="small muted">Fans buy credits and spend them on chats, calls, gifts, live access, priority messages, stage joins, and bookings. Your first 3 messages with each model are free — after that, texts cost $1.49 each (or the model's own rate). Unused credits stay in your wallet. <b>Spent credits are non-refundable.</b></div>
      </div>
      <div class="card">
        <div style="font-weight:800;margin-bottom:8px">3. Model Rates</div>
        <div class="small muted">Models set their own rates: per-message, per-minute video, per voice note, and their explicit stage-join rates ($5–$100). Rates are shown before you pay. The platform may set default rates which models can adjust within the allowed ranges.</div>
      </div>
      <div class="card">
        <div style="font-weight:800;margin-bottom:8px">4. Revenue Split & Payouts</div>
        <div class="small muted">Models keep <b>60%</b> of everything fans spend on them; the platform keeps 40%. Payouts are sent by Asce (currently processed manually). Models add their bank details in the app and request withdrawals anytime; pending requests are paid out on Asce's schedule.</div>
      </div>
      <div class="card">
        <div style="font-weight:800;margin-bottom:8px">5. Live Streams & Explicit Content</div>
        <div class="small muted">Group streams are free to watch; explicit viewing requires a paid entry fee plus ongoing gifts to stay unblurred. Stage joins (video or mic) are 3 minutes, then timed out — re-pay to return. The model approves every stage join; declined requests are refunded in full. Priority messages are paid banners with optional paid voice.</div>
      </div>
      <div class="card">
        <div style="font-weight:800;margin-bottom:8px">6. Bookings</div>
        <div class="small muted">Private 1-on-1 lives are booked in advance and paid upfront. The model must accept. Fan cancellation 1+ hour before = full refund; inside 1 hour = no refund. Model cancellation or no-show (15 min late) = full refund to the fan.</div>
      </div>
      <div class="card">
        <div style="font-weight:800;margin-bottom:8px">7. Model Access</div>
        <div class="small muted">Model accounts are invite-only. Asce may deactivate or remove any model account at any time, for any reason. Deactivated models keep earned balances available for withdrawal.</div>
      </div>
      <div class="card">
        <div style="font-weight:800;margin-bottom:8px">8. Safety & Conduct</div>
        <div class="small muted">Sharing contact info, payment handles, or attempting to take transactions off-platform will get your messages blocked and may get your account banned. Racial slurs and hate speech are blocked. All chats and streams are monitored for safety.</div>
      </div>
      <div class="card">
        <div style="font-weight:800;margin-bottom:8px">9. No Refunds on Spent Credits</div>
        <div class="small muted">Once credits are spent on messages, calls, gifts, entries, priorities, joins, or bookings, they are gone — no refunds, no chargebacks through the app. Unused wallet credits are not redeemable for cash (fans).</div>
      </div>
      <div class="card">
        <div style="font-weight:800;margin-bottom:8px">10. Changes</div>
        <div class="small muted">Features, prices, rates, and these terms may change at any time. Continued use means you accept the current terms.</div>
      </div>
      <p class="muted small" style="text-align:center;margin:16px 0">These terms are a plain-language summary, not legal advice.<br>Operated by World of Godz Entertainment LLC.<br><a href="javascript:void(0)" id="t-dmca" style="color:var(--pink)">DMCA / Copyright takedown →</a></p>
      <button class="btn ghost" id="t-back">← Back</button>
    </div>`;
  $('#t-back').onclick = () => history.length > 1 ? history.back() : show('landing', {});
  $('#t-dmca').onclick = () => show('dmca', {});
}

/* ---------------- MODEL CONTRACT (sign before first use) ---------------- */

async function vModelContract() {
  tabbar.classList.add('hidden');
  app.innerHTML = `
    <div class="header"><h1>Slut<span class="logo">Camp</span> 📝</h1>
      <div class="sub">Model Agreement</div></div>
    <div class="screen">
      <div id="mc-body"><div class="card" style="text-align:center">Loading contract…</div></div>
    </div>`;
  const { status, data } = await api('/model/contract');
  if (status !== 200) { toast('Could not load the contract — try again'); return show('landing', {}); }
  if (data.signed) { S.contractSigned = true; return show('modelChats', {}); }

  app.querySelector('#mc-body').innerHTML = `
    <div class="card" style="border:2px solid var(--pink);text-align:center">
      <div style="font-size:15px;font-weight:800">MODEL AGREEMENT — v${esc(data.version)} (${esc(data.updated)})</div>
      <div class="small muted" style="margin-top:6px">This is a plain-language draft, not legal advice.<br>Please have an attorney review it.</div>
    </div>
    <div class="card">
      <div style="font-weight:800;margin-bottom:8px">✍️ Read before you sign</div>
      <div class="small muted">Scroll through the full agreement below. The checkbox unlocks once you've reached the bottom — you don't have to read every word, but signing means you agree to all of it.</div>
    </div>
    <div id="mc-scroll" style="max-height:45vh;overflow-y:auto;border:1px solid rgba(255,255,255,.15);border-radius:12px;padding:4px">
      ${data.sections.map((s) => `
        <div class="card" style="margin:8px">
          <div style="font-weight:800;margin-bottom:6px">${esc(s.title)}</div>
          <div class="small muted">${esc(s.body)}</div>
        </div>`).join('')}
      <div style="text-align:center;padding:12px" class="small muted" id="mc-end">— end of agreement —</div>
    </div>
    <div class="card" style="margin-top:12px">
      <label class="checkbox-row" style="opacity:.4" id="mc-agree-row">
        <input type="checkbox" id="mc-agree" disabled>
        <span>I have read and agree to the Model Agreement v${esc(data.version)}.</span>
      </label>
      <label class="field" style="margin-top:12px">Type your full legal name to sign
        <input class="input" id="mc-name" placeholder="Full legal name" autocomplete="name" maxlength="80">
      </label>
      <button class="btn" id="mc-sign" disabled style="opacity:.4;margin-top:12px">Sign & Continue</button>
      <div class="small muted" style="text-align:center;margin-top:8px">Your typed name is your electronic signature, recorded with the date and time.</div>
    </div>`;

  const scroller = $('#mc-scroll'), agree = $('#mc-agree'), agreeRow = $('#mc-agree-row'),
        nameInput = $('#mc-name'), signBtn = $('#mc-sign');
  const refresh = () => {
    const ok = agree.checked && nameInput.value.trim().length >= 2;
    signBtn.disabled = !ok;
    signBtn.style.opacity = ok ? 1 : .4;
  };
  scroller.addEventListener('scroll', () => {
    if (agree.disabled && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 24) {
      agree.disabled = false;
      agreeRow.style.opacity = 1;
      toast('You reached the bottom — you can now agree ✅');
    }
  });
  agree.onchange = refresh;
  nameInput.oninput = refresh;
  signBtn.onclick = async () => {
    signBtn.disabled = true;
    const { status: st, data: d } = await api('/model/contract/sign', {
      method: 'POST', body: JSON.stringify({ display_name: nameInput.value.trim() }),
    });
    if (st === 200 && d.ok) {
      S.contractSigned = true;
      toast('✅ Agreement signed — welcome to SlutCamp!');
      show('modelChats', {});
    } else {
      toast('Signing failed — try again');
      signBtn.disabled = false;
      refresh();
    }
  };
}

/* Blur app content when backgrounded (screen-record deterrent) */
document.addEventListener('visibilitychange', () => {
  document.body.classList.toggle('bg-blur', document.hidden);
});
window.addEventListener('blur', () => document.body.classList.add('bg-blur'));
window.addEventListener('focus', () => document.body.classList.remove('bg-blur'));

/* ---------------- DMCA: public takedown page ---------------- */

function vDmca() {
  tabbar.classList.add('hidden');
  app.innerHTML = `
    <div class="header">
      <h1>Slut<span class="logo">Camp</span> ⚖️</h1>
      <div class="sub">DMCA / Copyright</div>
    </div>
    <div class="screen">
      <div class="card">
        <div style="font-weight:800;margin-bottom:8px">What is this?</div>
        <div class="small muted">If you believe content on SlutCamp infringes your copyright, you can file a takedown notice under the Digital Millennium Copyright Act (DMCA). We review every notice and remove infringing content promptly.</div>
      </div>
      <div class="card">
        <div style="font-weight:800;margin-bottom:8px">📮 Designated copyright agent</div>
        <div class="small muted">DMCA Agent, World of Godz Entertainment LLC<br>
        Email: <b>dmca@slutcamp.app</b><br>
        <span class="small" style="opacity:.7">(Mailing address: to be provided)</span></div>
      </div>
      <div class="card">
        <div style="font-weight:800;margin-bottom:10px">📝 File a takedown notice</div>
        <div class="small muted" style="margin-bottom:10px">Fill this out completely. False claims carry penalties under 17 U.S.C. §512(f).</div>
        <label class="field">Your full name<input class="input" id="dm-name" maxlength="120" placeholder="Jane Doe"></label>
        <label class="field">Your email<input class="input" id="dm-email" type="email" maxlength="160" placeholder="you@example.com"></label>
        <label class="field">Describe the copyrighted work<input class="input" id="dm-work" maxlength="4000" placeholder="e.g. my photo series 'Summer 2026', published at…"></label>
        <label class="field">SlutCamp URL(s) where it appears (one per line)<textarea class="input" id="dm-urls" rows="3" maxlength="4000" placeholder="https://slutcamp.onrender.com/…"></textarea></label>
        <label class="small" style="display:flex;gap:8px;align-items:flex-start;margin:10px 0">
          <input type="checkbox" id="dm-goodfaith" style="margin-top:3px">
          <span class="muted">I have a good-faith belief that the use of the material above is not authorized by the copyright owner, its agent, or the law. I swear under penalty of perjury that the information in this notice is accurate and that I am the copyright owner or authorized to act on the owner's behalf.</span>
        </label>
        <label class="field">Electronic signature (type your full name)<input class="input" id="dm-sig" maxlength="120" placeholder="Jane Doe"></label>
        <button class="btn" id="dm-submit">Submit takedown notice</button>
        <div id="dm-result" style="margin-top:10px"></div>
      </div>
      <div class="card">
        <div style="font-weight:800;margin-bottom:8px">↩️ Counter-notice (for models)</div>
        <div class="small muted">If your content was removed and you believe it was a mistake or misidentification, you may file a counter-notice. Email <b>dmca@slutcamp.app</b> with: your name and contact info, the URL(s) removed, a statement under penalty of perjury that you have a good-faith belief the material was removed by mistake, and your typed signature. If the original complainant doesn't file a court action within 10–14 business days, we may restore the content.</div>
      </div>
      <p class="muted small" style="text-align:center;margin:16px 0">This page is a plain-language summary, not legal advice.<br>Operated by World of Godz Entertainment LLC.</p>
      <button class="btn ghost" id="dm-back">← Back</button>
    </div>`;
  $('#dm-back').onclick = () => history.length > 1 ? history.back() : show('landing', {});
  $('#dm-submit').onclick = async () => {
    const btn = $('#dm-submit');
    const body = {
      name: $('#dm-name').value.trim(),
      email: $('#dm-email').value.trim(),
      work_description: $('#dm-work').value.trim(),
      urls: $('#dm-urls').value.trim(),
      signature: $('#dm-sig').value.trim(),
      statement_confirmed: $('#dm-goodfaith').checked,
    };
    if (!body.name || !body.email || !body.work_description || !body.urls || !body.signature)
      return toast('Fill in every field');
    if (!body.statement_confirmed) return toast('Check the good-faith statement');
    btn.disabled = true;
    const { status, data } = await api('/dmca/report', { method: 'POST', body: JSON.stringify(body) });
    if (status === 200) {
      $('#dm-result').innerHTML = `<div class="card" style="border-color:var(--green)"><div style="font-weight:800;color:var(--green)">✅ Notice received (ref #${data.id})</div><div class="small muted" style="margin-top:4px">We'll review it and respond to ${esc(body.email)}.</div></div>`;
      ['dm-name','dm-email','dm-work','dm-urls','dm-sig'].forEach((id) => { $('#' + id).value = ''; });
      $('#dm-goodfaith').checked = false;
    } else if (status === 429) toast('Too many reports — try again later');
    else toast(data.error === 'bad_email' ? 'Check your email address' : 'Something went wrong — try again');
    btn.disabled = false;
  };
}

/* ---------------- DMCA: admin queue ---------------- */

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
