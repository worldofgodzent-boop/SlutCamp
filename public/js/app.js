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
  const r = await fetch('/api' + path, Object.assign({}, opts, { headers }));
  let data = {};
  try { data = await r.json(); } catch (e) { /* non-JSON */ }
  return { status: r.status, data };
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
  if (m.type === 'chat:new' && S.view === 'chat' && S.conv && m.conversation_id === S.conv.id) {
    S.messages.push(m.message);
    renderMessages();
    api(`/conversations/${S.conv.id}/read`, { method: 'POST' });
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
    onLiveExplicitSignal(m.is_explicit, m.explicit_rate_cents, 'manual');
  } else if (m.type === 'live:ended' && S.live && m.session_id === S.live.sessionId) {
    endLiveView('Stream ended.');
  } else if (m.type === 'live:tick' && S.live && S.live.role === 'fan' && m.session_id === S.live.sessionId) {
    S.live.paying = true;
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
    // Animated gift overlay for everyone watching
    showGiftAnim(m.gift.emoji, m.fan_name);
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
    { id: 'wallet', ico: '💰', label: 'Wallet', view: 'wallet' },
  ],
  model: [
    { id: 'chats', ico: '💬', label: 'Chats', view: 'modelChats' },
    { id: 'earn', ico: '💵', label: 'Earnings', view: 'modelEarnings' },
    { id: 'settings', ico: '⚙️', label: 'Settings', view: 'modelSettings' },
  ],
  admin: [
    { id: 'dash', ico: '📊', label: 'Home', view: 'admin' },
    { id: 'chats', ico: '👀', label: 'Chats', view: 'admin' },
    { id: 'safe', ico: '🛡️', label: 'Safety', view: 'admin' },
    { id: 'more', ico: '⚙️', label: 'More', view: 'admin' },
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

function show(view, params) {
  S.view = view;
  renderTabbar();
  window.scrollTo(0, 0);
  const VIEWS = {
    landing: vLanding, auth: vAuth,
    fanModels: vFanModels, fanLive: vFanLive, fanChats: vFanChats, wallet: vWallet,
    modelChats: vModelChats, modelEarnings: vModelEarnings, modelSettings: vModelSettings,
    admin: vAdmin, chat: vChat,
    liveBroadcast: vLiveBroadcast, liveWatch: vLiveWatch,
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
      <p class="muted small" style="text-align:center;margin-top:16px">18+ only. By chatting you agree to the Terms.</p>
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
        <div class="d">Get paid to chat (Corry verifies you)</div></div>
      <label class="field">Display name<input class="input" id="a-name" maxlength="40"></label>
      <label class="field">Username<input class="input" id="a-user" autocomplete="username"></label>
      <label class="field">Password (6+ characters)${pwField('a-pass', 'new-password')}</label>
      <label class="field">Date of birth<input class="input" id="a-dob" type="date"></label>
      <div class="age-box">🔞 <b>18+ only.</b> You must be 18 or older to use SlutCamp.
        ${role === 'model' ? 'Models must also complete ID verification with Corry (2257).' : 'Full ID verification is required before purchasing credits.'}</div>
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
        <div class="muted small">Ask Corry for a fresh invite link.</div>
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
        <div class="muted small" style="margin-top:4px">$1.49 per text · $3.99/min video · tips & PPV unlocks<br>Weekly payouts from Corry</div>
      </div>
      <label class="field">Display name (your stage name)<input class="input" id="i-name" maxlength="40"></label>
      <label class="field">Username<input class="input" id="i-user" autocomplete="username"></label>
      <label class="field">Password (6+ characters)${pwField('i-pass', 'new-password')}</label>
      <label class="field">Date of birth<input class="input" id="i-dob" type="date"></label>
      <div class="age-box">🔞 <b>18+ only.</b> Corry will verify your ID in person (2257 compliance) before you go live.</div>
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

async function afterLogin(data) {
  S.token = data.token;
  localStorage.setItem('wc_token', S.token);
  S.user = data.user;
  wsConnect();
  await refreshMe();
  if (S.user.role === 'admin') show('admin', {});
  else if (S.user.role === 'model') show('modelChats', {});
  else show('fanModels', {});
  toast(`Welcome, ${S.user.display_name}! 🎉`);
}

async function refreshMe() {
  const { status, data } = await api('/me');
  if (status === 200) {
    S.user = data.user; S.wallet = data.wallet; S.model = data.model || null;
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
            ${m.is_live ? `<br><span class="small" style="color:#f87171;font-weight:800">▶ Watch free preview — tap to join</span>` : ''}
          </span><span style="font-size:22px">›</span>
        </button>`).join('')}
    </div>`;
  app.querySelectorAll('[data-model]').forEach((b) => {
    b.onclick = () => {
      const liveId = b.dataset.live;
      if (liveId) return watchLive(parseInt(liveId));
      openChatWithModel(parseInt(b.dataset.model));
    };
  });
}

async function vFanChats() { return vChatList('fan'); }
async function vModelChats() { return vChatList('model'); }

/* ---------------- FAN: group live streams listing ---------------- */

async function vFanLive() {
  await refreshMe();
  const { data } = await api('/live');
  const streams = data.live || [];
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
      <button class="btn" id="go-live-btn" style="margin-top:10px;background:linear-gradient(135deg,#ef4444,#b91c1c)">🔴 Go Live</button>` : ''}
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
  app.innerHTML = `
    <div class="header"><h1>Earnings 💵</h1><div class="sub">You keep ${100 - (S.commissionPct || 30)}% of everything</div></div>
    <div class="screen">
      <div class="stat-grid">
        <div class="stat"><div class="n" style="color:var(--green)">${fmt(data.pending_cents)}</div><div class="l">Available for payout</div></div>
        <div class="stat"><div class="n">${fmt(data.earnings_cents)}</div><div class="l">Total earned</div></div>
      </div>
      <div class="card" style="margin-top:12px">
        <div style="font-weight:800;margin-bottom:8px">Per fan</div>
        ${(data.by_fan || []).map((r) => `
          <div class="row" style="padding:8px 0;border-top:1px solid rgba(139,92,246,.1)">
            <span class="grow"><b>${esc(r.fan_name)}</b> <span class="muted small">· ${r.payments} payments</span></span>
            <b style="color:var(--green)">${fmt(r.earned_cents)}</b>
          </div>`).join('') || '<div class="muted">No earnings yet — go online and chat! 💬</div>'}
      </div>
      <div class="muted small" style="text-align:center">Payouts are sent by Corry. Available balance updates after each message.</div>
    </div>`;
}

async function vModelSettings() {
  await refreshMe();
  const m = S.model;
  app.innerHTML = `
    <div class="header"><h1>Settings ⚙️</h1></div>
    <div class="screen">
      <div class="card">
        <div style="font-weight:800;margin-bottom:6px">Your rates</div>
        <label class="field">Per text message ($)<input class="input" id="s-msg" type="number" step="0.01" min="0" value="${(m.per_message_cents / 100).toFixed(2)}"></label>
        <label class="field">Per minute video call ($)<input class="input" id="s-min" type="number" step="0.01" min="0" value="${(m.per_minute_cents / 100).toFixed(2)}"></label>
        <label class="field">Per voice note ($)<input class="input" id="s-voice" type="number" step="0.01" min="0" value="${((m.per_voice_cents || 299) / 100).toFixed(2)}"></label>
        <label class="field">Live explicit rate — per minute ($)<input class="input" id="s-exp" type="number" step="0.01" min="0" value="${((m.explicit_rate_cents || 499) / 100).toFixed(2)}"></label>
        <div class="muted small" style="margin-top:6px">Fans watch your live stream free until the AI detects explicit content (or you tap "Go Explicit") — then they pay this rate per minute to keep watching unblurred.</div>
        <button class="btn" id="s-save">Save rates</button>
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
      <button class="btn ghost" id="s-logout">Log out</button>
    </div>`;
  $('#s-save').onclick = async () => {
    const per_message_cents = Math.round(parseFloat($('#s-msg').value || '0') * 100);
    const per_minute_cents = Math.round(parseFloat($('#s-min').value || '0') * 100);
    const per_voice_cents = Math.round(parseFloat($('#s-voice').value || '0') * 100);
    const explicit_rate_cents = Math.round(parseFloat($('#s-exp').value || '0') * 100);
    const { status } = await api('/model/profile', {
      method: 'PUT', body: JSON.stringify({ per_message_cents, per_minute_cents, per_voice_cents, explicit_rate_cents }) });
    toast(status === 200 ? '✅ Rates saved!' : 'Could not save.');
    if (status === 200) refreshMe();
  };
  $('#s-bio-save').onclick = async () => {
    const { status } = await api('/model/profile', {
      method: 'PUT', body: JSON.stringify({ bio: $('#s-bio').value }) });
    toast(status === 200 ? '✅ Bio saved!' : 'Could not save.');
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
  const vb = $('#c-video');
  if (vb) vb.onclick = startCall;
  const pb = $('#c-plus');
  if (pb) pb.onclick = openActionSheet;

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
    return `<div class="msg ${mine ? 'out' : 'in'}">${m.is_tip ? '💸 ' : ''}${esc(m.body)}${mediaHTML(m)}
      <div class="meta">${timeHM(m.created_at)}${m.cost_cents ? ` · <span class="cost">-${fmt(m.cost_cents)}</span>` : ''}${ticks}</div>
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
  const input = $('#ppv-file');
  input.accept = kind === 'ppv_video' ? 'video/mp4' : 'image/jpeg,image/png,image/webp';
  input.onchange = () => {
    const f = input.files[0];
    input.value = '';
    if (!f) return;
    if (f.size > 30 * 1024 * 1024) return toast('File too big — 30MB max.');
    const def = kind === 'ppv_video' ? '9.99' : '4.99';
    const priceStr = prompt(`Set your unlock price for this ${kind === 'ppv_video' ? 'video' : 'photo'} ($):`, def);
    if (priceStr === null) return; // cancelled
    const price = Math.round(parseFloat(priceStr || '0') * 100);
    if (!Number.isFinite(price) || price < 0 || price > 100000) return toast('Enter a price like 4.99');
    uploadMedia(f, kind, price, 0);
  };
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
      toast(`Need ${fmt(data.needed_cents)} — top up 💰`);
      if (S.user && S.user.role === 'fan') show('wallet', {});
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

  navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
    const mime = MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4'
      : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
    voiceRec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
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
  }).catch(() => {
    ov.remove();
    toast('Mic permission needed 🎤');
  });

  $('#voice-stop').onclick = () => {
    const secs = Math.max(1, Math.round((Date.now() - voiceStartTs) / 1000));
    const rec = voiceRec;
    ov.remove();
    if (!rec) return;
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

async function startLiveBroadcast() {
  const title = prompt('Stream title (shown to fans):', 'Come hang out 😈💦');
  if (title === null) return; // cancelled
  const { status, data } = await api('/live/start', {
    method: 'POST', body: JSON.stringify({ title: (title || '').trim() }) });
  if (status !== 200) {
    if (data.error === 'already_live') return toast('You are already live!');
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

/* ---------------- PRIORITY MESSAGES (paid banner + TTS) ---------------- */

const PRIORITY_TIERS = [
  { price_cents: 200,  duration_sec: 5 },
  { price_cents: 500,  duration_sec: 10 },
  { price_cents: 1000, duration_sec: 15 },
  { price_cents: 2000, duration_sec: 20 },
  { price_cents: 3000, duration_sec: 30 },
];

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
      <div class="pm-head"><span>📢 PRIORITY</span><span id="priority-countdown"></span></div>
      <div class="pm-from">${esc(p.fan_name)}</div>
      <div class="pm-body">${esc(p.message)}</div>
    </div>`;
  speakPriority(p.fan_name, p.message);
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
      <div class="muted small" style="margin-bottom:8px">Your message shows across the stream for <b>everyone</b> + gets read out loud. More $ = longer on screen (max 30s).</div>
      <textarea class="input" id="pm-text" rows="2" maxlength="120" placeholder="Say it loud… 😈"></textarea>
      <div class="muted small" style="text-align:right"><span id="pm-count">0</span>/120</div>
      <div class="gift-grid">
        ${PRIORITY_TIERS.map((t, i) => `
          <button class="gift-item pm-tier" data-tier="${i}">
            <span class="gift-price">${fmt(t.price_cents)}</span>
            <span class="gift-name">→ ${t.duration_sec}s on screen</span>
          </button>`).join('')}
      </div>
      <button class="btn" id="pm-send" style="margin-top:10px">Send 📢 · <span id="pm-send-price">${fmt(PRIORITY_TIERS[1].price_cents)}</span></button>
      <button class="btn ghost" id="pm-close" style="margin-top:8px">Close</button>
    </div>`;
  document.body.appendChild(sheet);
  let picked = 1;
  const mark = () => {
    sheet.querySelectorAll('.pm-tier').forEach((b) =>
      b.classList.toggle('selected', parseInt(b.dataset.tier) === picked));
    const sp = $('#pm-send-price');
    if (sp) sp.textContent = fmt(PRIORITY_TIERS[picked].price_cents);
  };
  const ta = $('#pm-text');
  ta.oninput = () => { const c = $('#pm-count'); if (c) c.textContent = ta.value.length; };
  sheet.querySelectorAll('.pm-tier').forEach((b) => {
    b.onclick = () => { picked = parseInt(b.dataset.tier); mark(); };
  });
  mark();
  const close = () => sheet.remove();
  $('#pm-close').onclick = close;
  sheet.onclick = (e) => { if (e.target === sheet) close(); };
  $('#pm-send').onclick = () => sendPriority(picked, ta.value.trim());
  setTimeout(() => ta.focus(), 100);
}

async function sendPriority(tierIndex, message) {
  const L = S.live;
  if (!L) return;
  if (!message) return toast('Type your message first ✍️');
  const { status, data } = await api(`/live/${L.sessionId}/priority`, {
    method: 'POST', body: JSON.stringify({ tier_index: tierIndex, message }) });
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
      <div id="live-blur-overlay" class="hidden">
        <div style="font-size:52px">🔞</div>
        <div id="live-blur-title" style="font-weight:800;font-size:19px;margin:8px 0">She's getting explicit…</div>
        <button class="btn" id="live-pay-btn">Pay to keep watching</button>
        <button class="btn ghost" id="live-gift-btn" style="margin-top:8px">🎁 Send a gift to unblur</button>
        <div class="muted small" id="live-countdown" style="margin-top:8px"></div>
        <button class="btn ghost" id="live-stay-free" style="margin-top:8px">Keep watching free (blurred)</button>
      </div>
      <div id="gift-anim" class="hidden"></div>
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
        <button class="btn small" id="priority-open-btn" style="margin:0;background:linear-gradient(135deg,#f59e0b,#ef4444)" aria-label="Send priority message">📢</button>
      </div>
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
  $('#gift-open-btn').onclick = openGiftPanel;
  $('#priority-open-btn').onclick = openPriorityPanel;
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
    if (source === 'manual' && rateCents) L.explicitRate = rateCents;
    // Paying ($4.99/min) or gift grace still active → stay unblurred
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
      if (title) title.textContent = source === 'gift_expired'
        ? "😈 She's still going… send a gift to unblur!"
        : "She's getting explicit…";
      const pb = $('#live-pay-btn');
      pb.textContent = `🔓 Pay ${fmt(rateCents || L.explicitRate)}/min to keep watching`;
      pb.onclick = livePayExplicit;
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
      if (source === 'gift_expired') {
        // Grace ran out — no kick, they keep audio + chat blurred.
        // Any gift unblurs them again.
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
      }
    } else if (S.live.role === 'model') {
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
    try { speechSynthesis.cancel(); } catch (e) {}
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
    ['models', '💃 Models'], ['invites', '✉️ Invites'], ['payouts', '💸 Payouts'], ['fans', '🧑 Fans'], ['more', '⚙️ More'],
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
  else body = await adminMoreBody(stats);

  app.innerHTML = `
    <div class="header"><h1>Moderator 🛡️</h1><div class="sub">Hey Corry — everything at a glance</div></div>
    <div class="screen">
      <div class="tabs">${tabs.map(([id, l]) =>
        `<button data-atab="${id}" class="${tab === id ? 'active' : ''}">${l}${id === 'safety' && stats.open_incidents ? ` <span class="unread-badge">${stats.open_incidents}</span>` : ''}</button>`).join('')}
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
            <span class="small" style="color:var(--green)">Owed: ${fmt(m.pending_cents)}</span></span>
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
  return `
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
    <h3>History</h3>
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

async function adminMoreBody(s) {
  return `
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

function wireAdminBody(tab) {
  const go = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
  go('#go-safety', () => { S.adminTab = 'safety'; show('admin', {}); });
  go('#a-logout', () => logout());

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

/* ---------------- boot ---------------- */

(async function boot() {
  // Model invite link: ?invite=CODE → dedicated signup screen
  const inviteCode = new URLSearchParams(window.location.search).get('invite');
  if (inviteCode && /^[a-f0-9]{18}$/.test(inviteCode)) {
    await ensureGuest();
    wsConnect();
    // Clean the URL so refresh doesn't re-trigger (keep it simple — replace state)
    try { window.history.replaceState({}, '', window.location.pathname); } catch (e) {}
    return vInviteSignup(inviteCode);
  }
  if (S.token) {
    const { status } = await api('/me');
    if (status === 200) {
      await refreshMe();
      wsConnect();
      if (S.user.role === 'admin') return show('admin', {});
      if (S.user.role === 'model') { S.commissionPct = 30; return show('modelChats', {}); }
      return show('fanModels', {});
    }
    S.token = null;
    localStorage.removeItem('wc_token');
  }
  await ensureGuest();
  wsConnect();
  show('landing', {});
})();
