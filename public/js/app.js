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

/* ---------------- i18n — English / Español / Português (BR) ----------------
   Core UI strings in v1: nav tabs, home, Lives, chat basics, auth, wallet,
   model settings + earnings labels, splash. Long-tail admin/legal copy
   stays English for now. LANG loads from localStorage BEFORE first render;
   when logged in, the account copy (users.language, via /api/me) is the
   fallback and device choices are pushed up to it — see syncLangFromUser. */
const LANGS = [
  { code: 'en', label: 'English', flag: '🇺🇸' },
  { code: 'es', label: 'Español', flag: '🇪🇸' },
  { code: 'pt', label: 'Português', flag: '🇧🇷' },
];
const I18N = {
  en: {
    tab_models: 'Models', tab_live: 'Live', tab_chats: 'Chats', tab_bookings: 'Bookings',
    tab_wallet: 'Wallet', tab_earnings: 'Earnings', tab_settings: 'Settings',
    tab_home: 'Home', tab_safety: 'Safety', tab_more: 'More',
    language: 'Language', language_note: 'Choose the language for your app.',
    language_set: '🌐 Language updated!',
    language_search_ph: 'Type your language…', cancel: 'Cancel',
    wm_title: 'Congratulations, {name}! 🎉', wm_welcome: 'Welcome to SlutCamp 💋',
    wm_body: "You're officially a SlutCamp model — and you're in early. Early models get seen first, and the fans are already waiting.",
    wm_money: '💰 You keep 60% of everything: paid messages, live streams + video calls paid per minute at YOUR prices, tips and paid content.',
    wm_steps_h: 'To start earning:',
    wm_step1: '✍️ Sign your model agreement', wm_step2: '🪪 Verify your ID (2257 — keeps you legal and paid)', wm_step3: '📸 Add your photo, set your prices, and go live',
    wm_btn: "Let's set me up 🔥",
    home_sub: 'Chat & video call the models · 18+ only',
    free3_title: '🎁 First 3 messages FREE',
    free3_sub: 'with every model you try. No account needed to start.',
    login_signup: 'Log in / Sign up', share_app: '📤 Share SlutCamp',
    ath_card_t: 'Put SlutCamp on your home screen', ath_card_sub: 'Opens like a real app, one tap.',
    ath_btn: 'Add the app', ath_sheet_t: '📲 Add SlutCamp to your home screen',
    ath_install_btn: 'Install the app', ath_installed: 'Added — find SlutCamp on your home screen 💋',
    ath_step1: '1. Tap the Share button ⬆ in your browser bar',
    ath_step2: "2. Tap 'Add to Home Screen'",
    ath_step3: "3. Tap 'Add' — done, she's on your home screen",
    ath_astep1: '1. Tap the ⋮ menu in your browser',
    ath_astep2: "2. Tap 'Install app' (or 'Add to Home screen')",
    ath_astep3: "3. Tap 'Install' — done, she's on your home screen",
    ath_wallet_row: '📲 Add to Home Screen',
    no_models: 'No models yet.',
    pager_prev: '← Prev', pager_next: 'Next →', pager_page: 'Page {x} of {y}',
    terms_line: '18+ only. By chatting you agree to the', terms: 'Terms',
    like_need_fan: 'Log in as a fan to like models 💜',
    link_copied: 'Link copied — send it to your boys 📤',
    watch_free: '▶ Watch free — tap to join', online_now: '● Online now', offline: '● Offline',
    watching: '{n} watching', featured: '⭐ Featured', top_model: '👑 Top Model',
    per_msg_rate: '{price}/msg', per_min_rate: '{price}/min video',
    usually_live: '📅 Usually live: {s}',
    lives_btn: '🔴 Lives', lives_count: '{n} live now', lives_word: '🔴 Lives',
    follow_title: 'Follow for live notifications',
    live_now_h: '🔴 Live Now', fanlive_h: '🔴 Live now',
    live_now_sub: 'Everyone streaming right now — tap to jump in 💋',
    nobody_live: "Nobody's live right now 💤",
    models_pop_in: 'Models pop in all day — check back soon 💋',
    online_say_hi: '💬 Online now — say hi', back_models: '← Back to models',
    watching_gifts: '👁 {v} watching · 🎁 {g} in gifts',
    join_free_line: '▶ Join free — chat is free, gifts get you noticed',
    noone_live: "No one's live right now.",
    check_back: 'Check back soon — your favorite models go live without warning 😈',
    coming_up: '📅 Coming up',
    your_chats: 'Your chats 💬', chats_title: 'Chats 💬',
    online_caps: '🟢 ONLINE', offline_caps: '⚫ OFFLINE',
    go_live: '🔴 Go Live', back_live: '↩️ Back to Live',
    paused_tag: '⏸ paused', no_messages_yet: 'No messages yet',
    no_chats: 'No chats yet.', tap_model_start: 'Tap a model to start chatting!',
    you_online: '🟢 You are ONLINE', you_offline: '⚫ You are offline',
    st_online: '🟢 online', st_offline: '⚫ offline', st_paused: '⏸ Paused',
    free_left: '🎁 {n} free left', book_1on1: '📅 Book 1-on-1',
    book_title: 'Book a private 1-on-1 live',
    chat_paused_banner: '⚠️ This chat is paused by the safety monitor.',
    sharing_not_allowed: 'Sharing contact info is not allowed.',
    msgs_cost: 'Messages cost {price} each',
    free_msgs_left: '🎁 {n} FREE messages left — then sign up to continue',
    msg_placeholder: 'Message…', chat_paused_ph: 'Chat paused', typing: 'typing…', edited: 'edited',
    welcome_back: 'Welcome back 😈', create_account_h: 'Create your account',
    log_in: 'Log in', sign_up: 'Sign up', log_out: 'Log out',
    username: 'Username', password: 'Password', password_hint: 'Password (6+ characters)',
    display_name: 'Display name', dob: 'Date of birth',
    im_fan: "I'm a Fan", fan_desc: 'Chat & video call the models',
    im_model: "I'm a Model", model_desc: 'Get paid to chat (SlutCamp verifies you)',
    age18_only: '18+ only.', age18_line: 'You must be 18 or older to use SlutCamp.',
    fan_age_line: "Fans confirm 18+ here — that's all we ask. Simple.",
    confirm18: 'I confirm I am <b>18 years or older</b>.',
    create_account_btn: 'Create account', keep_browsing: '← Keep browsing free',
    enter_user_pass: 'Enter username + password',
    login_failed: 'Login failed — check your details.',
    account_banned: '⛔ This account is banned.',
    model_age_id_note: 'Models must also complete ID verification with SlutCamp (2257).',
    stage_name_label: 'Display name (your stage name)',
    invited_model_sub: "You've been invited to join as a model",
    paid_chat_h: '💰 Get paid to chat with fans',
    invite_earn_sub: '$1.49 per text · $3.99/min video · tips & PPV unlocks<br>Weekly payouts from SlutCamp',
    rec_earn_sub: 'You keep 60% of everything · $1.49 per text · $3.99/min video<br>Weekly payouts from SlutCamp',
    invited_by: 'Invited by <b>{name}</b> 🤝',
    age_id_note: 'SlutCamp will verify your ID in person (2257 compliance) before you go live.',
    create_model_btn: 'Create model account',
    fill_all_fields: 'Fill in every field',
    must_confirm_18: 'You must confirm you are 18+',
    err_username_taken: 'Username is taken 😕',
    err_must_be_18: 'You must be 18 or older.',
    err_password_short: 'Password needs 6+ characters.',
    err_signup_failed: 'Signup failed.',
    err_bad_invite: 'Invite link is invalid or revoked.',
    err_invite_used: 'Invite link already used.',
    err_bad_referral: 'Referral link is invalid.',
    invalid_invite_h: 'This invite link is invalid,<br>already used, or revoked.',
    invalid_invite_sub: 'Ask SlutCamp for a fresh invite link.',
    invalid_ref_h: 'This referral link is invalid.',
    invalid_ref_sub: 'Ask the person who sent it for a fresh link.',
    back_browsing: '← Back to browsing',
    aff_invite_sub: 'Affiliate invite',
    aff_become_h: '🤝 Become a SlutCamp Affiliate',
    aff_become_sub: 'Recruit models · Earn 20% of everything they make<br>Your own referral link · Recruiter dashboard',
    your_name: 'Your name',
    aff_agreement_h: '📋 Affiliate Agreement (vR1.0)',
    aff_agree: 'I have read the Affiliate Agreement above and I <b>agree</b> to all terms.',
    aff_accept_btn: 'Accept & Create Affiliate Account',
    aff_must_agree: 'You must accept the Affiliate Agreement to continue.',
    aff_invalid_h: 'This invite link is invalid or expired.',
    aff_invalid_sub: 'Ask Corry for a fresh invite link.',
    err_invite_invalid: 'Invite link is invalid.',
    err_invite_expired: 'Invite link expired.',
    gate_verify_h: 'VERIFY YOUR AGE',
    gate_sub: 'Enter your date of birth. You must be 18 or older to enter.',
    gate_btn: 'VERIFY & ENTER',
    gate_err_empty: 'Please enter your date of birth.',
    gate_err_invalid: 'Please enter a valid date of birth.',
    gate_denied: 'You must be 18 or older to enter SlutCamp.',
    gate_back_google: '← Back to Google',
    welcome_user: 'Welcome, {name}! 🎉', logged_out: 'Logged out.',
    qs_sub: 'Create your account — 30 seconds', your_account: '👤 Your account',
    pick_username_ph: 'pick a username',
    payment_info: '💳 Payment info',
    payment_note: "Add your payment method now so you can buy credits instantly. You won't be charged until you buy.",
    full_name_card: 'Full name (on card)', payment_method: 'Payment method',
    card_word: '💳 Card', card_number: 'Card number', expiry: 'Expiry',
    create_continue: 'Create account & continue →', back: '← Back',
    wallet_h: 'Wallet 💰', balance: 'Balance: {amt}',
    credit_note: "1 credit = $1. Messages cost the model's rate.",
    credits_word: 'credits',
    guest_wallet_title: 'Create your free account to add funds',
    guest_wallet_sub: "You're browsing as a guest. Sign up free to buy credits and unlock chats, live streams, gifts, and more.",
    create_free_account: '✨ Create free account',
    have_account_login: 'Already have an account? Log in',
    crypto_h: 'Load with Crypto',
    crypto_note: 'Pay from your own wallet app. Credits land automatically after 1 network confirmation.',
    crypto_dollars: 'in dollars',
    crypto_send_exact: 'Send exactly',
    crypto_to: 'to',
    crypto_copy: 'Copy', crypto_copied: 'Copied!',
    crypto_open_wallet: 'Open in wallet app', crypto_add_more: 'Add more', ccbill_redirect: 'Taking you to the secure checkout…', ccbill_secure_note: 'Secure checkout by CCBill — you finish on their payment page, then your credits land right here.', ccbill_success: '💳 Payment approved! Your credits land as soon as CCBill confirms — usually just a few seconds.', ccbill_fail: 'That card payment didn\'t go through — no charge was made. Try again, or load with crypto instead.', crypto_load: 'Load', crypto_pay_with: 'Pay with your wallet', crypto_connect_pay: 'Connect wallet & pay', crypto_sent: 'Payment sent — your credits are on the way', crypto_in_wallet: 'You are in your wallet\'s browser — Connect pays right from this wallet.', crypto_phantom_fail: 'Phantom payment didn\'t complete — nothing was sent.', crypto_no_wallet: 'No wallet found in this browser — scan the QR or use Open in wallet app',
    crypto_scan: 'Scan with your wallet app',
    crypto_waiting: 'Waiting for payment…',
    crypto_detected: 'Payment detected — confirming ({n}/{m})…',
    crypto_confirming: 'Confirming ({n}/{m})…',
    crypto_credited: '✅ Credits added to your wallet!',
    crypto_credited_partial: '✅ Partial payment — {amt} credits added.',
    crypto_expired: 'This quote expired.',
    crypto_new_quote: '🔄 New quote',
    crypto_time_left: 'Price locked — {t} left',
    crypto_underpaid: 'Payment needs review — please contact support.',
    crypto_recent: 'Recent crypto loads',
    crypto_failed: 'Could not create the invoice — try again in a moment.',
    crypto_status_pending: 'Waiting', crypto_status_confirming: 'Confirming', crypto_status_credited: 'Credited',
    crypto_status_credited_partial: 'Partial', crypto_status_expired: 'Expired', crypto_status_underpaid: 'Review',
    crypto_dest_tag: 'Destination tag — REQUIRED',
    crypto_tag_note: 'Enter this tag in your wallet app exactly as shown — without it, your payment cannot be matched to your account.',
    crypto_exact_note: 'Send this exact amount — the amount itself is how your payment gets matched to your account.',
    crypto_shared_note: 'This is our shared deposit address — every fan sends here; your payment is matched by the details on this screen.',
    splash_welcome: 'Welcome to SlutCamp,', splash_paradise: 'sluts paradise 😈',
    splash_nutt: 'We hope you enjoy your Nutt 💦', enter: 'Enter 🔥',
    settings_h: 'Settings ⚙️',
    id_verified: '✅ ID Verified',
    id_verified_sub: "Your identity is verified. You're cleared to chat and go live.",
    id_pending: '⏳ ID Under Review',
    my_rates: '💵 My Rates',
    rates_note: 'What fans pay for 1-on-1 with you. You set these — SlutCamp can also adjust them.',
    per_text: '💬 Per text:', per_min_video_l: '📹 Per minute video:', per_voice: '🎙️ Per voice note:',
    explicit_rate_l: 'Live explicit rate — per minute ($)',
    save_rates: 'Save rates',
    stage_rates_h: '🔞 Explicit stage rates',
    ejv_l: '🎥 Explicit video + mic join:', ejm_l: '🎙️ Explicit mic join:',
    jv_l: '🎥 Video + mic join:', jm_l: '🎙️ Mic join:',
    save_stage_rates: 'Save stage rates',
    schedule_h: '📅 My Live Schedule', add_slot: 'Add slot',
    slot_title_ph: 'Title (optional) — e.g. Late night hangout',
    days_short: 'Sun,Mon,Tue,Wed,Thu,Fri,Sat',
    day_names: 'Monday,Tuesday,Wednesday,Thursday,Friday,Saturday,Sunday',
    bio: 'Bio', save_bio: 'Save bio',
    my_photo: 'My Photo',
    photo_note: 'Fans see this next to your name in chats and on the model grid.',
    change_photo: '📷 Change my photo',
    tip_menu: '💰 Tip Menu', add_tip_item: '➕ Add tip item',
    rb_h: '🚫 Region Blocker',
    rb_note: 'Hide yourself from the places you pick. Fans there will not see you anywhere on SlutCamp — no profile, no chat, no lives, no calls. Perfect for keeping your hometown, your state, or a whole country from finding you.',
    rb_country: 'Country', rb_state: 'State', rb_county: 'County', rb_city: 'City',
    rb_city_ph: 'Type a city name', rb_add: '🚫 Block this region',
    rb_none: 'No regions blocked — you are visible everywhere.',
    rb_remove: 'Remove', rb_added: 'Blocked', rb_removed: 'Region unblocked',
    rates_saved: '✅ Rates saved!', bio_saved: '✅ Bio saved!', stage_saved: '✅ Stage rates saved!',
    couldnt_save: 'Could not save.',
    earnings_h: 'Earnings 💵', you_keep: 'You keep {pct}% of everything',
    fc_h: '🏆 Fan Club', fc_sub: 'Your top buyers — who spends the most on you',
    fc_all: 'All time', fc_month: '30 days', fc_week: '7 days',
    fc_empty: 'No buyers yet — your fan club is waiting 💋',
    fc_live: 'Live', fc_1on1: '1-on-1', fc_chat: 'Chat',
    avail_payout: 'Available for payout', total_earned: 'Total earned',
    gifts_received: '🎁 Gifts received', gifts_from_fans_1: '{n} gift from fans',
    gifts_from_fans_n: '{n} gifts from fans', gifts_cut_note: 'Your 60% cut of every gift 💰',
    revenue_breakdown: '📊 Revenue breakdown', gifts_word: '🎁 Gifts',
    rb_lives_sub: '· explicit + video calls',
    rb_dms: '💬 Private DMs', rb_dms_sub: '· messages + voice + PPV + tips',
    all_activity: 'All activity',
    ty_message: '💬 Chat messages', ty_call: '📹 Video calls', ty_tip: '💸 Tips',
    ty_ppv: '🔒 PPV unlocks', ty_voice: '🎤 Voice notes', ty_live_explicit: '🔥 Explicit live',
    ty_gift: '🎁 Gifts',
    payment_1: '{n} payment', payment_n: '{n} payments',
    payments_1: '{n} payment', payments_n: '{n} payments',
    payouts_h: '💸 Payouts', bank_account: 'Bank account', not_set: 'Not set',
    withdraw: 'Withdraw', avail_withdraw: 'Available to withdraw:',
    add_bank: 'Add bank account', update_bank: 'Update bank account',
    update_bank_btn: '✏️ Update bank account',
    holder_name: 'Account holder name', routing: 'Routing number (9 digits)',
    account_number: 'Account number', save_bank: 'Save bank account',
    bank_note: '🔒 Only SlutCamp sees your full account number, to send your money.',
    amount_ph: 'Amount $',
    wd_history: 'Withdrawal history',
    wd_pending: '⏳ Pending', wd_paid: '✅ Paid', wd_rejected: '❌ Rejected',
    per_fan: 'Per fan',
    no_earnings: 'No earnings yet — go online and chat! 💬',
    payouts_note: 'Payouts are sent by SlutCamp. Available balance updates after each message.',
    bookings_h: 'Bookings 📅', bookings_sub: 'Private 1-on-1 lives — paid upfront',
    bk1_h: '📅 1-on-1 Bookings', bk1_sub: 'Your private 1-on-1 hours — fans book and pay upfront, first come first served. Times are Central (CT). Start within 5 minutes of the booked time or the fan is auto-refunded in full. If he doesn\'t join within 3 minutes of your start, you keep the booking — no-shows aren\'t refunded to him.',
    bk_day_cap: 'Max 1-on-1s per day', bk_week_cap: 'Max per week', bk_no_limit: 'No limit',
    bk_save_avail: 'Save availability', bk_avail_saved: '✅ Availability saved',
    bk_upcoming: 'Upcoming 1-on-1s', bk_none_up: 'No upcoming 1-on-1s yet.',
    bk_off: 'Off', bk_booked_out: '💔 Booked out', bk_slot_booked: 'Booked',
    bk_youre_booked: "You're booked", bk_no_slots: 'No openings this day — try another.',
    bk_start_now: 'Start now 📹', bk_remove: 'Remove',
    bk_in_line: "You're in line for", bk_turn_in: 'Your turn in about', bk_min_wait: 'min',
    bk_leave_line: 'Leave line & refund', bk_waiting_line: 'In line',
    approve: '✅ Approve', decline: '❌ Decline',
    req_waiting_1: '{n} request waiting', req_waiting_n: '{n} requests waiting',
    mic_on: '🎤 Mic on', muted: '🔇 Muted', cam_on: '📹 Cam on', cam_off: '📷 Cam off',
    go_explicit: 'Go Explicit 🔞', end_stream: 'End Stream',
    pause_live: '⏸ Pause', resume_live: '▶ Resume',
    brb_title: 'Hold your nutt 💦', brb_sub: "We'll be right back",
    brb_name: '{name} will be right back',
    say_fans_ph: 'Say something to your fans…',
    explicit_rate_note: 'Explicit rate: {price}/min · Your preview is never blurred',
    game_category: 'Game Category', game_btn: '🎲 Game',
    game_regular: 'Regular', game_explicit: 'Explicit 🔞', game_specials: 'Specials 💦',
    game_unlocks_explicit: 'Unlocks when she goes explicit',
    game_resting: 'Resting 💤', game_ready: 'Ready ✅',
    game_off_msg: 'The game is off right now — hang tight 🎲',
    game_on: 'Game ON', game_off: 'Game OFF',
    game_add_own: '＋ Add your own',
    game_label_ph: 'What will you do?', game_price_ph: 'Price $',
    game_duration_ph: 'Secs (optional)',
    game_save: 'Save', game_delete: 'Delete',
    game_queue: 'Requests', game_no_requests: 'No requests yet — they land here the second a fan buys 🎲',
    game_start: '▶ Start', game_done: '✓ Done', game_skip: '✕ Skip',
    game_now: 'NOW', game_bought: 'bought',
    game_your_turn: 'Fans see this exact list. Tap an item to edit it.',
    game_active: 'On menu', game_refunded_toast: '🎲 {label} was refunded to your wallet.',
    notifications_h: '🔔 Notifications', notifications_word: 'Notifications',
    mark_all_read: 'Mark all read',
  },
  es: {
    tab_models: 'Modelos', tab_live: 'En vivo', tab_chats: 'Chats', tab_bookings: 'Reservas',
    tab_wallet: 'Billetera', tab_earnings: 'Ganancias', tab_settings: 'Ajustes',
    tab_home: 'Inicio', tab_safety: 'Seguridad', tab_more: 'Más',
    language: 'Idioma', language_note: 'Elige el idioma de tu app.',
    language_set: '🌐 ¡Idioma actualizado!',
    language_search_ph: 'Escribe tu idioma…', cancel: 'Cancelar',
    wm_title: '¡Felicidades, {name}! 🎉', wm_welcome: 'Bienvenida a SlutCamp 💋',
    wm_body: 'Ya eres oficialmente una modelo de SlutCamp — y llegaste temprano. Las primeras modelos se ven primero, y los fans ya están esperando.',
    wm_money: '💰 Te quedas con el 60% de todo: mensajes pagos, lives y videollamadas pagadas por minuto a TUS precios, propinas y contenido pago.',
    wm_steps_h: 'Para empezar a ganar:',
    wm_step1: '✍️ Firma tu acuerdo de modelo', wm_step2: '🪪 Verifica tu ID (2257 — te mantiene legal y cobrando)', wm_step3: '📸 Sube tu foto, pon tus precios y sal en vivo',
    wm_btn: 'Vamos a configurar todo 🔥',
    home_sub: 'Chatea y haz videollamadas con las modelos · Solo 18+',
    free3_title: '🎁 Primeros 3 mensajes GRATIS',
    free3_sub: 'con cada modelo que pruebes. No necesitas cuenta para empezar.',
    login_signup: 'Iniciar sesión / Registrarse', share_app: '📤 Compartir SlutCamp',
    ath_card_t: 'Pon SlutCamp en tu pantalla de inicio', ath_card_sub: 'Se abre como una app real, con un toque.',
    ath_btn: 'Añadir la app', ath_sheet_t: '📲 Añade SlutCamp a tu pantalla de inicio',
    ath_install_btn: 'Instalar la app', ath_installed: 'Agregado — busca SlutCamp en tu pantalla de inicio 💋',
    ath_step1: '1. Toca el botón Compartir ⬆ en la barra de tu navegador',
    ath_step2: "2. Toca 'Añadir a pantalla de inicio'",
    ath_step3: "3. Toca 'Añadir' — listo, ya está en tu pantalla de inicio",
    ath_astep1: '1. Toca el menú ⋮ en tu navegador',
    ath_astep2: "2. Toca 'Instalar app' (o 'Añadir a pantalla de inicio')",
    ath_astep3: "3. Toca 'Instalar' — listo, ya está en tu pantalla de inicio",
    ath_wallet_row: '📲 Añadir a pantalla de inicio',
    no_models: 'Aún no hay modelos.',
    pager_prev: '← Anterior', pager_next: 'Siguiente →', pager_page: 'Página {x} de {y}',
    terms_line: 'Solo 18+. Al chatear aceptas los', terms: 'Términos',
    like_need_fan: 'Inicia sesión como fan para dar me gusta 💜',
    link_copied: 'Enlace copiado — envíaselo a tus amigos 📤',
    watch_free: '▶ Mira gratis — toca para entrar', online_now: '● En línea ahora', offline: '● Desconectada',
    watching: '{n} mirando', featured: '⭐ Destacada', top_model: '👑 Modelo Top',
    per_msg_rate: '{price}/msj', per_min_rate: '{price}/min de video',
    usually_live: '📅 Suele estar en vivo: {s}',
    lives_btn: '🔴 En vivo', lives_count: '{n} en vivo ahora', lives_word: '🔴 En vivo',
    follow_title: 'Seguir para avisos de en vivo',
    live_now_h: '🔴 En Vivo Ahora', fanlive_h: '🔴 En vivo ahora',
    live_now_sub: 'Todas transmitiendo ahora — toca para entrar 💋',
    nobody_live: 'Nadie está en vivo ahora 💤',
    models_pop_in: 'Las modelos entran todo el día — vuelve pronto 💋',
    online_say_hi: '💬 En línea ahora — saluda', back_models: '← Volver a las modelos',
    watching_gifts: '👁 {v} mirando · 🎁 {g} en regalos',
    join_free_line: '▶ Entra gratis — el chat es gratis, los regalos te hacen notar',
    noone_live: 'Nadie está en vivo ahora.',
    check_back: 'Vuelve pronto — tus modelos favoritas entran en vivo sin avisar 😈',
    coming_up: '📅 Próximamente',
    your_chats: 'Tus chats 💬', chats_title: 'Chats 💬',
    online_caps: '🟢 EN LÍNEA', offline_caps: '⚫ DESCONECTADA',
    go_live: '🔴 Transmitir en vivo', back_live: '↩️ Volver al en vivo',
    paused_tag: '⏸ pausado', no_messages_yet: 'Sin mensajes aún',
    no_chats: 'Aún no tienes chats.', tap_model_start: '¡Toca una modelo para empezar a chatear!',
    you_online: '🟢 Estás EN LÍNEA', you_offline: '⚫ Estás desconectada',
    st_online: '🟢 en línea', st_offline: '⚫ desconectada', st_paused: '⏸ Pausado',
    free_left: '🎁 {n} gratis restantes', book_1on1: '📅 Reservar 1 a 1',
    book_title: 'Reserva un en vivo privado 1 a 1',
    chat_paused_banner: '⚠️ Este chat fue pausado por el monitor de seguridad.',
    sharing_not_allowed: 'No está permitido compartir datos de contacto.',
    msgs_cost: 'Cada mensaje cuesta {price}',
    free_msgs_left: '🎁 Te quedan {n} mensajes GRATIS — luego regístrate para seguir',
    msg_placeholder: 'Mensaje…', chat_paused_ph: 'Chat pausado', typing: 'escribiendo…', edited: 'editado',
    welcome_back: 'Bienvenido de nuevo 😈', create_account_h: 'Crea tu cuenta',
    log_in: 'Iniciar sesión', sign_up: 'Registrarse', log_out: 'Cerrar sesión',
    username: 'Usuario', password: 'Contraseña', password_hint: 'Contraseña (6+ caracteres)',
    display_name: 'Nombre visible', dob: 'Fecha de nacimiento',
    im_fan: 'Soy Fan', fan_desc: 'Chatea y haz videollamadas con las modelos',
    im_model: 'Soy Modelo', model_desc: 'Gana dinero chateando (SlutCamp te verifica)',
    age18_only: 'Solo 18+.', age18_line: 'Debes tener 18 años o más para usar SlutCamp.',
    fan_age_line: 'Los fans confirman aquí que tienen 18+ — es todo lo que pedimos. Simple.',
    confirm18: 'Confirmo que tengo <b>18 años o más</b>.',
    create_account_btn: 'Crear cuenta', keep_browsing: '← Seguir explorando gratis',
    enter_user_pass: 'Ingresa usuario y contraseña',
    login_failed: 'Error al iniciar sesión — revisa tus datos.',
    account_banned: '⛔ Esta cuenta está suspendida.',
    model_age_id_note: 'Las modelos también deben completar la verificación de identidad con SlutCamp (2257).',
    stage_name_label: 'Nombre visible (tu nombre artístico)',
    invited_model_sub: 'Te invitaron a unirte como modelo',
    paid_chat_h: '💰 Gana dinero chateando con fans',
    invite_earn_sub: '$1.49 por mensaje · $3.99/min de video · propinas y contenido pago<br>Pagos semanales de SlutCamp',
    rec_earn_sub: 'Te quedas con el 60% de todo · $1.49 por mensaje · $3.99/min de video<br>Pagos semanales de SlutCamp',
    invited_by: 'Invitada por <b>{name}</b> 🤝',
    age_id_note: 'SlutCamp verificará tu identificación en persona (cumplimiento 2257) antes de que puedas salir en vivo.',
    create_model_btn: 'Crear cuenta de modelo',
    fill_all_fields: 'Completa todos los campos',
    must_confirm_18: 'Debes confirmar que tienes 18 años o más',
    err_username_taken: 'Ese nombre de usuario ya está en uso 😕',
    err_must_be_18: 'Debes tener 18 años o más.',
    err_password_short: 'La contraseña necesita 6+ caracteres.',
    err_signup_failed: 'El registro falló.',
    err_bad_invite: 'El enlace de invitación no es válido o fue revocado.',
    err_invite_used: 'Este enlace de invitación ya fue usado.',
    err_bad_referral: 'El enlace de referido no es válido.',
    invalid_invite_h: 'Este enlace de invitación no es válido,<br>ya fue usado o fue revocado.',
    invalid_invite_sub: 'Pide a SlutCamp un enlace de invitación nuevo.',
    invalid_ref_h: 'Este enlace de referido no es válido.',
    invalid_ref_sub: 'Pide un enlace nuevo a la persona que te lo envió.',
    back_browsing: '← Volver a explorar',
    aff_invite_sub: 'Invitación de afiliado',
    aff_become_h: '🤝 Conviértete en afiliado de SlutCamp',
    aff_become_sub: 'Recluta modelos · Gana el 20% de todo lo que ellas ganen<br>Tu propio enlace de referido · Panel de reclutador',
    your_name: 'Tu nombre',
    aff_agreement_h: '📋 Acuerdo de Afiliado (vR1.0)',
    aff_agree: 'He leído el Acuerdo de Afiliado anterior y <b>acepto</b> todos sus términos.',
    aff_accept_btn: 'Aceptar y crear cuenta de afiliado',
    aff_must_agree: 'Debes aceptar el Acuerdo de Afiliado para continuar.',
    aff_invalid_h: 'Este enlace de invitación no es válido o ya expiró.',
    aff_invalid_sub: 'Pide a Corry un enlace de invitación nuevo.',
    err_invite_invalid: 'El enlace de invitación no es válido.',
    err_invite_expired: 'El enlace de invitación expiró.',
    gate_verify_h: 'VERIFICA TU EDAD',
    gate_sub: 'Ingresa tu fecha de nacimiento. Debes tener 18 años o más para entrar.',
    gate_btn: 'VERIFICAR Y ENTRAR',
    gate_err_empty: 'Por favor ingresa tu fecha de nacimiento.',
    gate_err_invalid: 'Por favor ingresa una fecha de nacimiento válida.',
    gate_denied: 'Debes tener 18 años o más para entrar a SlutCamp.',
    gate_back_google: '← Volver a Google',
    welcome_user: '¡Bienvenido, {name}! 🎉', logged_out: 'Sesión cerrada.',
    qs_sub: 'Crea tu cuenta — 30 segundos', your_account: '👤 Tu cuenta',
    pick_username_ph: 'elige un usuario',
    payment_info: '💳 Pago',
    payment_note: 'Agrega tu método de pago ahora para comprar créditos al instante. No se te cobrará hasta que compres.',
    full_name_card: 'Nombre completo (en la tarjeta)', payment_method: 'Método de pago',
    card_word: '💳 Tarjeta', card_number: 'Número de tarjeta', expiry: 'Vencimiento',
    create_continue: 'Crear cuenta y continuar →', back: '← Atrás',
    wallet_h: 'Billetera 💰', balance: 'Saldo: {amt}',
    credit_note: '1 crédito = $1. Los mensajes cuestan la tarifa de la modelo.',
    credits_word: 'créditos',
    guest_wallet_title: 'Crea tu cuenta gratis para agregar fondos',
    guest_wallet_sub: 'Estás explorando como invitado. Regístrate gratis para comprar créditos y desbloquear chats, transmisiones en vivo, regalos y más.',
    create_free_account: '✨ Crear cuenta gratis',
    have_account_login: '¿Ya tienes cuenta? Inicia sesión',
    crypto_h: 'Cargar con cripto',
    crypto_note: 'Paga desde tu billetera. Los créditos llegan automáticamente tras 1 confirmación de red.',
    crypto_dollars: 'en dólares',
    crypto_send_exact: 'Envía exactamente',
    crypto_to: 'a',
    crypto_copy: 'Copiar', crypto_copied: '¡Copiado!',
    crypto_open_wallet: 'Abrir en la billetera', crypto_add_more: 'Agregar más', ccbill_redirect: 'Llevándote al pago seguro…', ccbill_secure_note: 'Pago seguro con CCBill — terminas en su página de pago y tus créditos llegan aquí.', ccbill_success: '💳 ¡Pago aprobado! Tus créditos llegan en cuanto CCBill confirma — normalmente unos segundos.', ccbill_fail: 'Ese pago con tarjeta no pasó — no se hizo ningún cargo. Inténtalo de nuevo o carga con cripto.', crypto_load: 'Cargar', crypto_pay_with: 'Paga con tu billetera', crypto_connect_pay: 'Conectar billetera y pagar', crypto_sent: 'Pago enviado — tus créditos van en camino', crypto_in_wallet: 'Estás en el navegador de tu billetera — Conectar paga desde esta billetera.', crypto_phantom_fail: 'El pago con Phantom no se completó — no se envió nada.', crypto_no_wallet: 'No se encontró billetera en este navegador — escanea el QR o usa Abrir en la billetera',
    crypto_scan: 'Escanea con tu billetera',
    crypto_waiting: 'Esperando el pago…',
    crypto_detected: 'Pago detectado — confirmando ({n}/{m})…',
    crypto_confirming: 'Confirmando ({n}/{m})…',
    crypto_credited: '✅ ¡Créditos agregados a tu billetera!',
    crypto_credited_partial: '✅ Pago parcial — {amt} créditos agregados.',
    crypto_expired: 'Esta cotización venció.',
    crypto_new_quote: '🔄 Nueva cotización',
    crypto_time_left: 'Precio bloqueado — quedan {t}',
    crypto_underpaid: 'El pago necesita revisión — contacta a soporte.',
    crypto_recent: 'Cargas cripto recientes',
    crypto_failed: 'No se pudo crear la factura — inténtalo en un momento.',
    crypto_status_pending: 'Esperando', crypto_status_confirming: 'Confirmando', crypto_status_credited: 'Acreditado',
    crypto_status_credited_partial: 'Parcial', crypto_status_expired: 'Vencida', crypto_status_underpaid: 'Revisión',
    crypto_dest_tag: 'Etiqueta de destino — OBLIGATORIA',
    crypto_tag_note: 'Ingresa esta etiqueta en tu billetera exactamente como se muestra — sin ella, tu pago no puede vincularse a tu cuenta.',
    crypto_exact_note: 'Envía este monto exacto — el monto en sí es cómo tu pago se vincula a tu cuenta.',
    crypto_shared_note: 'Esta es nuestra dirección de depósito compartida — todos los fans envían aquí; tu pago se vincula por los datos de esta pantalla.',
    splash_welcome: 'Bienvenido a SlutCamp,', splash_paradise: 'el paraíso travieso 😈',
    splash_nutt: 'Esperamos que disfrutes tu Nutt 💦', enter: 'Entrar 🔥',
    settings_h: 'Ajustes ⚙️',
    id_verified: '✅ Identidad verificada',
    id_verified_sub: 'Tu identidad está verificada. Ya puedes chatear y transmitir en vivo.',
    id_pending: '⏳ Identidad en revisión',
    my_rates: '💵 Mis tarifas',
    rates_note: 'Lo que pagan los fans por el 1 a 1 contigo. Tú las fijas — SlutCamp también puede ajustarlas.',
    per_text: '💬 Por mensaje:', per_min_video_l: '📹 Por minuto de video:', per_voice: '🎙️ Por nota de voz:',
    explicit_rate_l: 'Tarifa explícita en vivo — por minuto ($)',
    save_rates: 'Guardar tarifas',
    stage_rates_h: '🔞 Tarifas de escenario explícito',
    ejv_l: '🎥 Unión explícita con video + micrófono:', ejm_l: '🎙️ Unión explícita solo micrófono:',
    jv_l: '🎥 Unión con video + micrófono:', jm_l: '🎙️ Unión solo micrófono:',
    save_stage_rates: 'Guardar tarifas de escenario',
    schedule_h: '📅 Mi horario en vivo', add_slot: 'Agregar horario',
    slot_title_ph: 'Título (opcional) — ej. Charla nocturna',
    days_short: 'dom,lun,mar,mié,jue,vie,sáb',
    day_names: 'lunes,martes,miércoles,jueves,viernes,sábado,domingo',
    bio: 'Bio', save_bio: 'Guardar bio',
    my_photo: 'Mi foto',
    photo_note: 'Los fans ven esto junto a tu nombre en los chats y en la lista de modelos.',
    change_photo: '📷 Cambiar mi foto',
    tip_menu: '💰 Menú de propinas', add_tip_item: '➕ Agregar propina',
    rb_h: '🚫 Bloqueo por región',
    rb_note: 'Escóndete de los lugares que elijas. Los fans allí no te verán en ningún lugar de SlutCamp: ni perfil, ni chat, ni en vivo, ni llamadas. Perfecto para que tu ciudad, tu estado o un país entero no te encuentre.',
    rb_country: 'País', rb_state: 'Estado', rb_county: 'Condado', rb_city: 'Ciudad',
    rb_city_ph: 'Escribe una ciudad', rb_add: '🚫 Bloquear esta región',
    rb_none: 'Sin regiones bloqueadas: eres visible en todas partes.',
    rb_remove: 'Quitar', rb_added: 'Bloqueado', rb_removed: 'Región desbloqueada',
    rates_saved: '✅ ¡Tarifas guardadas!', bio_saved: '✅ ¡Bio guardada!', stage_saved: '✅ ¡Tarifas de escenario guardadas!',
    couldnt_save: 'No se pudo guardar.',
    earnings_h: 'Ganancias 💵', you_keep: 'Te quedas con el {pct}% de todo',
    fc_h: '🏆 Club de Fans', fc_sub: 'Tus mayores compradores — quién gasta más en ti',
    fc_all: 'Todo', fc_month: '30 días', fc_week: '7 días',
    fc_empty: 'Aún no hay compradores — tu club de fans te espera 💋',
    fc_live: 'En vivo', fc_1on1: '1 a 1', fc_chat: 'Chat',
    avail_payout: 'Disponible para retirar', total_earned: 'Total ganado',
    gifts_received: '🎁 Regalos recibidos', gifts_from_fans_1: '{n} regalo de fans',
    gifts_from_fans_n: '{n} regalos de fans', gifts_cut_note: 'Tu 60% de cada regalo 💰',
    revenue_breakdown: '📊 Desglose de ingresos', gifts_word: '🎁 Regalos',
    rb_lives_sub: '· explícito + videollamadas',
    rb_dms: '💬 Mensajes privados', rb_dms_sub: '· mensajes + voz + PPV + propinas',
    all_activity: 'Toda la actividad',
    ty_message: '💬 Mensajes de chat', ty_call: '📹 Videollamadas', ty_tip: '💸 Propinas',
    ty_ppv: '🔒 Desbloqueos PPV', ty_voice: '🎤 Notas de voz', ty_live_explicit: '🔥 En vivo explícito',
    ty_gift: '🎁 Regalos',
    payment_1: '{n} pago', payment_n: '{n} pagos',
    payments_1: '{n} pago', payments_n: '{n} pagos',
    payouts_h: '💸 Retiros', bank_account: 'Cuenta bancaria', not_set: 'Sin configurar',
    withdraw: 'Retirar', avail_withdraw: 'Disponible para retirar:',
    add_bank: 'Agregar cuenta bancaria', update_bank: 'Actualizar cuenta bancaria',
    update_bank_btn: '✏️ Actualizar cuenta bancaria',
    holder_name: 'Nombre del titular', routing: 'Número de ruta (9 dígitos)',
    account_number: 'Número de cuenta', save_bank: 'Guardar cuenta bancaria',
    bank_note: '🔒 Solo SlutCamp ve tu número de cuenta completo, para enviarte tu dinero.',
    amount_ph: 'Cantidad $',
    wd_history: 'Historial de retiros',
    wd_pending: '⏳ Pendiente', wd_paid: '✅ Pagado', wd_rejected: '❌ Rechazado',
    per_fan: 'Por fan',
    no_earnings: 'Aún no tienes ganancias — ¡ponte en línea y chatea! 💬',
    payouts_note: 'Los retiros los envía SlutCamp. Tu saldo disponible se actualiza tras cada mensaje.',
    bookings_h: 'Reservas 📅', bookings_sub: 'En vivos privados 1 a 1 — pagados por adelantado',
    bk1_h: '📅 Reservas 1 a 1', bk1_sub: 'Tus horas privadas 1 a 1 — los fans reservan y pagan por adelantado, en orden de llegada. Horarios en hora central (CT). Comienza dentro de los 5 minutos de la hora reservada o el fan recibe un reembolso completo automático. Si él no entra dentro de los 3 minutos de tu inicio, la reserva es tuya — los que no se presentan no reciben reembolso.',
    bk_day_cap: 'Máx. de 1 a 1 por día', bk_week_cap: 'Máx. por semana', bk_no_limit: 'Sin límite',
    bk_save_avail: 'Guardar disponibilidad', bk_avail_saved: '✅ Disponibilidad guardada',
    bk_upcoming: 'Próximos 1 a 1', bk_none_up: 'Aún no tienes 1 a 1 próximos.',
    bk_off: 'Libre', bk_booked_out: '💔 Agotado', bk_slot_booked: 'Reservado',
    bk_youre_booked: 'Tu reserva está lista', bk_no_slots: 'Sin espacios este día — prueba otro.',
    bk_start_now: 'Empezar ahora 📹', bk_remove: 'Quitar',
    bk_in_line: 'Estás en la fila para', bk_turn_in: 'Tu turno en unos', bk_min_wait: 'min',
    bk_leave_line: 'Salir de la fila y reembolso', bk_waiting_line: 'En la fila',
    approve: '✅ Aprobar', decline: '❌ Rechazar',
    req_waiting_1: '{n} solicitud en espera', req_waiting_n: '{n} solicitudes en espera',
    mic_on: '🎤 Micrófono activado', muted: '🔇 Silenciado', cam_on: '📹 Cámara activada', cam_off: '📷 Cámara apagada',
    go_explicit: 'Pasar a explícito 🔞', end_stream: 'Terminar transmisión',
    say_fans_ph: 'Di algo a tus fans…',
    game_category: 'Game Category', game_btn: '🎲 Juego',
    game_regular: 'Regular', game_explicit: 'Explícito 🔞', game_specials: 'Especiales 💦',
    game_unlocks_explicit: 'Se desbloquea cuando ella se ponga explícita',
    game_resting: 'Descansando 💤', game_ready: 'Listo ✅',
    game_off_msg: 'El juego está apagado ahora — espera un momento 🎲',
    game_on: 'Juego ON', game_off: 'Juego OFF',
    game_add_own: '＋ Agrega el tuyo',
    game_label_ph: '¿Qué harás?', game_price_ph: 'Precio $',
    game_duration_ph: 'Segs (opcional)',
    game_save: 'Guardar', game_delete: 'Eliminar',
    game_queue: 'Solicitudes', game_no_requests: 'Aún no hay solicitudes — llegan aquí en cuanto un fan compre 🎲',
    game_start: '▶ Empezar', game_done: '✓ Hecho', game_skip: '✕ Saltar',
    game_now: 'AHORA', game_bought: 'compró',
    game_your_turn: 'Los fans ven esta misma lista. Toca un ítem para editarlo.',
    game_active: 'En el menú', game_refunded_toast: '🎲 {label} fue reembolsado a tu billetera.',
    explicit_rate_note: 'Tarifa explícita: {price}/min · Tu vista previa nunca se difumina',
    notifications_h: '🔔 Notificaciones', notifications_word: 'Notificaciones',
    mark_all_read: 'Marcar todo leído',
  },
  pt: {
    tab_models: 'Modelos', tab_live: 'Ao vivo', tab_chats: 'Conversas', tab_bookings: 'Reservas',
    tab_wallet: 'Carteira', tab_earnings: 'Ganhos', tab_settings: 'Configurações',
    tab_home: 'Início', tab_safety: 'Segurança', tab_more: 'Mais',
    language: 'Idioma', language_note: 'Escolha o idioma do seu app.',
    language_set: '🌐 Idioma atualizado!',
    language_search_ph: 'Digite seu idioma…', cancel: 'Cancelar',
    wm_title: 'Parabéns, {name}! 🎉', wm_welcome: 'Bem-vinda à SlutCamp 💋',
    wm_body: 'Você agora é oficialmente uma modelo da SlutCamp — e chegou cedo. As primeiras modelos são vistas primeiro, e os fãs já estão esperando.',
    wm_money: '💰 Você fica com 60% de tudo: mensagens pagas, lives e videochamadas pagas por minuto nos SEUS preços, gorjetas e conteúdo pago.',
    wm_steps_h: 'Para começar a ganhar:',
    wm_step1: '✍️ Assine seu contrato de modelo', wm_step2: '🪪 Verifique seu documento (2257 — mantém você legal e recebendo)', wm_step3: '📸 Adicione sua foto, defina seus preços e entre ao vivo',
    wm_btn: 'Vamos montar meu perfil 🔥',
    home_sub: 'Converse e faça videochamadas com as modelos · Somente 18+',
    free3_title: '🎁 Primeiras 3 mensagens GRÁTIS',
    free3_sub: 'com cada modelo que você testar. Não precisa de conta para começar.',
    login_signup: 'Entrar / Cadastrar', share_app: '📤 Compartilhar o SlutCamp',
    ath_card_t: 'Coloque o SlutCamp na sua tela inicial', ath_card_sub: 'Abre como um app de verdade, com um toque.',
    ath_btn: 'Adicionar o app', ath_sheet_t: '📲 Adicionar o SlutCamp à tela inicial',
    ath_install_btn: 'Instalar o app', ath_installed: 'Adicionado — encontre o SlutCamp na sua tela inicial 💋',
    ath_step1: '1. Toque no botão Compartilhar ⬆ na barra do navegador',
    ath_step2: "2. Toque em 'Adicionar à Tela de Início'",
    ath_step3: "3. Toque em 'Adicionar' — pronto, já está na sua tela inicial",
    ath_astep1: '1. Toque no menu ⋮ do navegador',
    ath_astep2: "2. Toque em 'Instalar app' (ou 'Adicionar à tela inicial')",
    ath_astep3: "3. Toque em 'Instalar' — pronto, já está na sua tela inicial",
    ath_wallet_row: '📲 Adicionar à tela inicial',
    no_models: 'Ainda não há modelos.',
    pager_prev: '← Anterior', pager_next: 'Próxima →', pager_page: 'Página {x} de {y}',
    terms_line: 'Somente 18+. Ao conversar, você concorda com os', terms: 'Termos',
    like_need_fan: 'Entre como fã para curtir as modelos 💜',
    link_copied: 'Link copiado — manda pros seus amigos 📤',
    watch_free: '▶ Assista grátis — toque para entrar', online_now: '● Online agora', offline: '● Offline',
    watching: '{n} assistindo', featured: '⭐ Destaque', top_model: '👑 Modelo Top',
    per_msg_rate: '{price}/msg', per_min_rate: '{price}/min de vídeo',
    usually_live: '📅 Costuma entrar ao vivo: {s}',
    lives_btn: '🔴 Ao vivo', lives_count: '{n} ao vivo agora', lives_word: '🔴 Ao vivo',
    follow_title: 'Seguir para avisos de live',
    live_now_h: '🔴 Ao Vivo Agora', fanlive_h: '🔴 Ao vivo agora',
    live_now_sub: 'Todas transmitindo agora — toque para entrar 💋',
    nobody_live: 'Ninguém está ao vivo agora 💤',
    models_pop_in: 'As modelos entram o dia todo — volte logo 💋',
    online_say_hi: '💬 Online agora — diga oi', back_models: '← Voltar às modelos',
    watching_gifts: '👁 {v} assistindo · 🎁 {g} em presentes',
    join_free_line: '▶ Entre grátis — o chat é grátis, presentes te destacam',
    noone_live: 'Ninguém está ao vivo agora.',
    check_back: 'Volte logo — suas modelos favoritas entram ao vivo sem avisar 😈',
    coming_up: '📅 Em breve',
    your_chats: 'Suas conversas 💬', chats_title: 'Conversas 💬',
    online_caps: '🟢 ONLINE', offline_caps: '⚫ OFFLINE',
    go_live: '🔴 Entrar ao vivo', back_live: '↩️ Voltar à live',
    paused_tag: '⏸ pausada', no_messages_yet: 'Sem mensagens ainda',
    no_chats: 'Você ainda não tem conversas.', tap_model_start: 'Toque em uma modelo para começar a conversar!',
    you_online: '🟢 Você está ONLINE', you_offline: '⚫ Você está offline',
    st_online: '🟢 online', st_offline: '⚫ offline', st_paused: '⏸ Pausada',
    free_left: '🎁 {n} grátis restantes', book_1on1: '📅 Reservar 1 a 1',
    book_title: 'Reserve uma live privada 1 a 1',
    chat_paused_banner: '⚠️ Esta conversa foi pausada pelo monitor de segurança.',
    sharing_not_allowed: 'Não é permitido compartilhar informações de contato.',
    msgs_cost: 'Cada mensagem custa {price}',
    free_msgs_left: '🎁 Restam {n} mensagens GRÁTIS — depois cadastre-se para continuar',
    msg_placeholder: 'Mensagem…', chat_paused_ph: 'Conversa pausada', typing: 'digitando…', edited: 'editado',
    welcome_back: 'Bem-vindo de volta 😈', create_account_h: 'Crie sua conta',
    log_in: 'Entrar', sign_up: 'Cadastrar', log_out: 'Sair',
    username: 'Nome de usuário', password: 'Senha', password_hint: 'Senha (6+ caracteres)',
    display_name: 'Nome de exibição', dob: 'Data de nascimento',
    im_fan: 'Sou Fã', fan_desc: 'Converse e faça videochamadas com as modelos',
    im_model: 'Sou Modelo', model_desc: 'Ganhe dinheiro conversando (a SlutCamp verifica você)',
    age18_only: 'Somente 18+.', age18_line: 'Você deve ter 18 anos ou mais para usar o SlutCamp.',
    fan_age_line: 'Fãs confirmam aqui que têm 18+ — é tudo o que pedimos. Simples.',
    confirm18: 'Confirmo que tenho <b>18 anos ou mais</b>.',
    create_account_btn: 'Criar conta', keep_browsing: '← Continuar explorando grátis',
    enter_user_pass: 'Digite usuário e senha',
    login_failed: 'Falha no login — verifique seus dados.',
    account_banned: '⛔ Esta conta está banida.',
    model_age_id_note: 'As modelos também devem concluir a verificação de identidade com a SlutCamp (2257).',
    stage_name_label: 'Nome de exibição (seu nome artístico)',
    invited_model_sub: 'Você foi convidada para entrar como modelo',
    paid_chat_h: '💰 Ganhe dinheiro conversando com fãs',
    invite_earn_sub: '$1.49 por mensagem · $3.99/min de vídeo · gorjetas e conteúdo pago<br>Pagamentos semanais da SlutCamp',
    rec_earn_sub: 'Você fica com 60% de tudo · $1.49 por mensagem · $3.99/min de vídeo<br>Pagamentos semanais da SlutCamp',
    invited_by: 'Convidada por <b>{name}</b> 🤝',
    age_id_note: 'A SlutCamp verificará seu documento de identidade pessoalmente (conformidade 2257) antes de você entrar ao vivo.',
    create_model_btn: 'Criar conta de modelo',
    fill_all_fields: 'Preencha todos os campos',
    must_confirm_18: 'Você deve confirmar que tem 18 anos ou mais',
    err_username_taken: 'Esse nome de usuário já está em uso 😕',
    err_must_be_18: 'Você deve ter 18 anos ou mais.',
    err_password_short: 'A senha precisa de 6+ caracteres.',
    err_signup_failed: 'O cadastro falhou.',
    err_bad_invite: 'O link de convite é inválido ou foi revogado.',
    err_invite_used: 'Este link de convite já foi usado.',
    err_bad_referral: 'O link de indicação é inválido.',
    invalid_invite_h: 'Este link de convite é inválido,<br>já foi usado ou foi revogado.',
    invalid_invite_sub: 'Peça à SlutCamp um novo link de convite.',
    invalid_ref_h: 'Este link de indicação é inválido.',
    invalid_ref_sub: 'Peça um link novo para a pessoa que enviou.',
    back_browsing: '← Voltar a explorar',
    aff_invite_sub: 'Convite de afiliado',
    aff_become_h: '🤝 Torne-se um afiliado SlutCamp',
    aff_become_sub: 'Recrute modelos · Ganhe 20% de tudo o que elas ganharem<br>Seu próprio link de indicação · Painel de recrutador',
    your_name: 'Seu nome',
    aff_agreement_h: '📋 Acordo de Afiliado (vR1.0)',
    aff_agree: 'Li o Acordo de Afiliado acima e <b>concordo</b> com todos os termos.',
    aff_accept_btn: 'Aceitar e criar conta de afiliado',
    aff_must_agree: 'Você deve aceitar o Acordo de Afiliado para continuar.',
    aff_invalid_h: 'Este link de convite é inválido ou expirou.',
    aff_invalid_sub: 'Peça ao Corry um novo link de convite.',
    err_invite_invalid: 'O link de convite é inválido.',
    err_invite_expired: 'O link de convite expirou.',
    gate_verify_h: 'VERIFIQUE SUA IDADE',
    gate_sub: 'Digite sua data de nascimento. Você deve ter 18 anos ou mais para entrar.',
    gate_btn: 'VERIFICAR E ENTRAR',
    gate_err_empty: 'Por favor, digite sua data de nascimento.',
    gate_err_invalid: 'Por favor, digite uma data de nascimento válida.',
    gate_denied: 'Você deve ter 18 anos ou mais para entrar no SlutCamp.',
    gate_back_google: '← Voltar ao Google',
    welcome_user: 'Bem-vindo, {name}! 🎉', logged_out: 'Você saiu.',
    qs_sub: 'Crie sua conta — 30 segundos', your_account: '👤 Sua conta',
    pick_username_ph: 'escolha um usuário',
    payment_info: '💳 Pagamento',
    payment_note: 'Adicione seu método de pagamento agora para comprar créditos na hora. Você só será cobrado quando comprar.',
    full_name_card: 'Nome completo (no cartão)', payment_method: 'Método de pagamento',
    card_word: '💳 Cartão', card_number: 'Número do cartão', expiry: 'Validade',
    create_continue: 'Criar conta e continuar →', back: '← Voltar',
    wallet_h: 'Carteira 💰', balance: 'Saldo: {amt}',
    credit_note: '1 crédito = $1. As mensagens custam a tarifa da modelo.',
    credits_word: 'créditos',
    guest_wallet_title: 'Crie sua conta grátis para adicionar fundos',
    guest_wallet_sub: 'Você está navegando como visitante. Cadastre-se grátis para comprar créditos e liberar conversas, lives, presentes e muito mais.',
    create_free_account: '✨ Criar conta grátis',
    have_account_login: 'Já tem conta? Entrar',
    crypto_h: 'Carregar com cripto',
    crypto_note: 'Pague do seu app de carteira. Os créditos caem automaticamente após 1 confirmação da rede.',
    crypto_dollars: 'em dólares',
    crypto_send_exact: 'Envie exatamente',
    crypto_to: 'para',
    crypto_copy: 'Copiar', crypto_copied: 'Copiado!',
    crypto_open_wallet: 'Abrir na carteira', crypto_add_more: 'Adicionar mais', ccbill_redirect: 'Levando você ao pagamento seguro…', ccbill_secure_note: 'Pagamento seguro pela CCBill — você finaliza na página de pagamento deles e seus créditos chegam aqui.', ccbill_success: '💳 Pagamento aprovado! Seus créditos chegam assim que a CCBill confirmar — normalmente alguns segundos.', ccbill_fail: 'Esse pagamento no cartão não passou — nenhuma cobrança foi feita. Tente de novo ou carregue com cripto.', crypto_load: 'Carregar', crypto_pay_with: 'Pague com sua carteira', crypto_connect_pay: 'Conectar carteira e pagar', crypto_sent: 'Pagamento enviado — seus créditos estão a caminho', crypto_in_wallet: 'Você está no navegador da sua carteira — Conectar paga direto desta carteira.', crypto_phantom_fail: 'O pagamento com Phantom não foi concluído — nada foi enviado.', crypto_no_wallet: 'Nenhuma carteira encontrada neste navegador — escaneie o QR ou use Abrir na carteira',
    crypto_scan: 'Escaneie com sua carteira',
    crypto_waiting: 'Aguardando pagamento…',
    crypto_detected: 'Pagamento detectado — confirmando ({n}/{m})…',
    crypto_confirming: 'Confirmando ({n}/{m})…',
    crypto_credited: '✅ Créditos adicionados à sua carteira!',
    crypto_credited_partial: '✅ Pagamento parcial — {amt} créditos adicionados.',
    crypto_expired: 'Esta cotação expirou.',
    crypto_new_quote: '🔄 Nova cotação',
    crypto_time_left: 'Preço travado — restam {t}',
    crypto_underpaid: 'O pagamento precisa de revisão — fale com o suporte.',
    crypto_recent: 'Recargas cripto recentes',
    crypto_failed: 'Não foi possível criar a fatura — tente em instantes.',
    crypto_status_pending: 'Aguardando', crypto_status_confirming: 'Confirmando', crypto_status_credited: 'Creditado',
    crypto_status_credited_partial: 'Parcial', crypto_status_expired: 'Expirada', crypto_status_underpaid: 'Revisão',
    crypto_dest_tag: 'Tag de destino — OBRIGATÓRIA',
    crypto_tag_note: 'Digite esta tag no seu app de carteira exatamente como mostrado — sem ela, seu pagamento não pode ser vinculado à sua conta.',
    crypto_exact_note: 'Envie este valor exato — o próprio valor é como seu pagamento é vinculado à sua conta.',
    crypto_shared_note: 'Este é nosso endereço de depósito compartilhado — todos os fãs enviam para cá; seu pagamento é vinculado pelos dados desta tela.',
    splash_welcome: 'Bem-vindo ao SlutCamp,', splash_paradise: 'o paraíso das safadas 😈',
    splash_nutt: 'Esperamos que você aproveite seu Nutt 💦', enter: 'Entrar 🔥',
    settings_h: 'Configurações ⚙️',
    id_verified: '✅ Identidade verificada',
    id_verified_sub: 'Sua identidade está verificada. Você já pode conversar e entrar ao vivo.',
    id_pending: '⏳ Identidade em análise',
    my_rates: '💵 Minhas tarifas',
    rates_note: 'O que os fãs pagam pelo 1 a 1 com você. Você define — a SlutCamp também pode ajustar.',
    per_text: '💬 Por mensagem:', per_min_video_l: '📹 Por minuto de vídeo:', per_voice: '🎙️ Por mensagem de voz:',
    explicit_rate_l: 'Tarifa explícita ao vivo — por minuto ($)',
    save_rates: 'Salvar tarifas',
    stage_rates_h: '🔞 Tarifas de palco explícito',
    ejv_l: '🎥 Entrada explícita com vídeo + microfone:', ejm_l: '🎙️ Entrada explícita só com microfone:',
    jv_l: '🎥 Entrada com vídeo + microfone:', jm_l: '🎙️ Entrada só com microfone:',
    save_stage_rates: 'Salvar tarifas de palco',
    schedule_h: '📅 Minha agenda de lives', add_slot: 'Adicionar horário',
    slot_title_ph: 'Título (opcional) — ex. Bate-papo da noite',
    days_short: 'dom,seg,ter,qua,qui,sex,sáb',
    day_names: 'segunda,terça,quarta,quinta,sexta,sábado,domingo',
    bio: 'Bio', save_bio: 'Salvar bio',
    my_photo: 'Minha foto',
    photo_note: 'Os fãs veem isso ao lado do seu nome nas conversas e na lista de modelos.',
    change_photo: '📷 Trocar minha foto',
    tip_menu: '💰 Menu de gorjetas', add_tip_item: '➕ Adicionar item',
    rb_h: '🚫 Bloqueio por região',
    rb_note: 'Esconda-se dos lugares que você escolher. Os fãs de lá não vão te ver em nenhum lugar do SlutCamp: sem perfil, sem chat, sem lives, sem chamadas. Perfeito para a sua cidade, seu estado ou um país inteiro não te encontrar.',
    rb_country: 'País', rb_state: 'Estado', rb_county: 'Condado', rb_city: 'Cidade',
    rb_city_ph: 'Digite uma cidade', rb_add: '🚫 Bloquear esta região',
    rb_none: 'Nenhuma região bloqueada — você está visível em todo lugar.',
    rb_remove: 'Remover', rb_added: 'Bloqueado', rb_removed: 'Região desbloqueada',
    rates_saved: '✅ Tarifas salvas!', bio_saved: '✅ Bio salva!', stage_saved: '✅ Tarifas de palco salvas!',
    couldnt_save: 'Não foi possível salvar.',
    earnings_h: 'Ganhos 💵', you_keep: 'Você fica com {pct}% de tudo',
    fc_h: '🏆 Fã-Clube', fc_sub: 'Seus maiores compradores — quem mais gasta com você',
    fc_all: 'Tudo', fc_month: '30 dias', fc_week: '7 dias',
    fc_empty: 'Ainda não há compradores — seu fã-clube está esperando 💋',
    fc_live: 'Ao vivo', fc_1on1: '1 a 1', fc_chat: 'Chat',
    avail_payout: 'Disponível para saque', total_earned: 'Total ganho',
    gifts_received: '🎁 Presentes recebidos', gifts_from_fans_1: '{n} presente de fãs',
    gifts_from_fans_n: '{n} presentes de fãs', gifts_cut_note: 'Seus 60% de cada presente 💰',
    revenue_breakdown: '📊 Detalhes da receita', gifts_word: '🎁 Presentes',
    rb_lives_sub: '· explícito + videochamadas',
    rb_dms: '💬 Mensagens privadas', rb_dms_sub: '· mensagens + voz + PPV + gorjetas',
    all_activity: 'Toda a atividade',
    ty_message: '💬 Mensagens de chat', ty_call: '📹 Videochamadas', ty_tip: '💸 Gorjetas',
    ty_ppv: '🔒 Desbloqueios PPV', ty_voice: '🎤 Mensagens de voz', ty_live_explicit: '🔥 Live explícita',
    ty_gift: '🎁 Presentes',
    payment_1: '{n} pagamento', payment_n: '{n} pagamentos',
    payments_1: '{n} pagamento', payments_n: '{n} pagamentos',
    payouts_h: '💸 Saques', bank_account: 'Conta bancária', not_set: 'Não configurada',
    withdraw: 'Sacar', avail_withdraw: 'Disponível para sacar:',
    add_bank: 'Adicionar conta bancária', update_bank: 'Atualizar conta bancária',
    update_bank_btn: '✏️ Atualizar conta bancária',
    holder_name: 'Nome do titular', routing: 'Número de roteamento (9 dígitos)',
    account_number: 'Número da conta', save_bank: 'Salvar conta bancária',
    bank_note: '🔒 Só a SlutCamp vê o número completo da sua conta, para enviar seu dinheiro.',
    amount_ph: 'Valor $',
    wd_history: 'Histórico de saques',
    wd_pending: '⏳ Pendente', wd_paid: '✅ Pago', wd_rejected: '❌ Rejeitado',
    per_fan: 'Por fã',
    no_earnings: 'Ainda sem ganhos — fique online e converse! 💬',
    payouts_note: 'Os saques são enviados pela SlutCamp. O saldo disponível atualiza a cada mensagem.',
    bookings_h: 'Reservas 📅', bookings_sub: 'Lives privadas 1 a 1 — pagas adiantado',
    bk1_h: '📅 Reservas 1 a 1', bk1_sub: 'Seus horários privados 1 a 1 — os fãs reservam e pagam adiantado, por ordem de chegada. Horários no horário central (CT). Comece dentro de 5 minutos do horário reservado ou o fã recebe reembolso total automático. Se ele não entrar dentro de 3 minutos do seu início, a reserva é sua — faltas não são reembolsadas.',
    bk_day_cap: 'Máx. de 1 a 1 por dia', bk_week_cap: 'Máx. por semana', bk_no_limit: 'Sem limite',
    bk_save_avail: 'Salvar disponibilidade', bk_avail_saved: '✅ Disponibilidade salva',
    bk_upcoming: 'Próximos 1 a 1', bk_none_up: 'Nenhum 1 a 1 próximo ainda.',
    bk_off: 'Folga', bk_booked_out: '💔 Esgotado', bk_slot_booked: 'Reservado',
    bk_youre_booked: 'Reserva confirmada', bk_no_slots: 'Sem vagas neste dia — tente outro.',
    bk_start_now: 'Começar agora 📹', bk_remove: 'Remover',
    bk_in_line: 'Você está na fila para', bk_turn_in: 'Sua vez em cerca de', bk_min_wait: 'min',
    bk_leave_line: 'Sair da fila e reembolso', bk_waiting_line: 'Na fila',
    approve: '✅ Aprovar', decline: '❌ Recusar',
    req_waiting_1: '{n} solicitação aguardando', req_waiting_n: '{n} solicitações aguardando',
    mic_on: '🎤 Microfone ligado', muted: '🔇 Silenciado', cam_on: '📹 Câmera ligada', cam_off: '📷 Câmera desligada',
    go_explicit: 'Ficar explícita 🔞', end_stream: 'Encerrar live',
    say_fans_ph: 'Diga algo aos seus fãs…',
    game_category: 'Game Category', game_btn: '🎲 Jogo',
    game_regular: 'Regular', game_explicit: 'Explícito 🔞', game_specials: 'Especiais 💦',
    game_unlocks_explicit: 'Desbloqueia quando ela ficar explícita',
    game_resting: 'Descansando 💤', game_ready: 'Pronto ✅',
    game_off_msg: 'O jogo está desligado agora — aguenta aí 🎲',
    game_on: 'Jogo ON', game_off: 'Jogo OFF',
    game_add_own: '＋ Adicione o seu',
    game_label_ph: 'O que você vai fazer?', game_price_ph: 'Preço $',
    game_duration_ph: 'Segs (opcional)',
    game_save: 'Salvar', game_delete: 'Excluir',
    game_queue: 'Pedidos', game_no_requests: 'Ainda sem pedidos — eles chegam aqui assim que um fã comprar 🎲',
    game_start: '▶ Começar', game_done: '✓ Feito', game_skip: '✕ Pular',
    game_now: 'AGORA', game_bought: 'comprou',
    game_your_turn: 'Os fãs veem exatamente esta lista. Toque em um item para editá-lo.',
    game_active: 'No menu', game_refunded_toast: '🎲 {label} foi reembolsado para sua carteira.',
    explicit_rate_note: 'Tarifa explícita: {price}/min · Sua prévia nunca fica borrada',
    notifications_h: '🔔 Notificações', notifications_word: 'Notificações',
    mark_all_read: 'Marcar tudo como lido',
  },
};

let LANG = (() => {
  try {
    const saved = localStorage.getItem('wc_lang');
    if (LANGS.some((x) => x.code === saved)) return saved;
  } catch (e) { /* fall through to browser-language detection */ }
  // First visit: greet her in her own browser language (pt-BR phone -> pt).
  const nav = String((typeof navigator !== 'undefined' && navigator.language) || '').toLowerCase();
  if (nav.startsWith('pt')) return 'pt';
  if (nav.startsWith('es')) return 'es';
  return 'en';
})();

function t(key, vars) {
  let s = (I18N[LANG] && I18N[LANG][key]) || I18N.en[key] || key;
  if (vars) for (const k in vars) s = s.split('{' + k + '}').join(String(vars[k]));
  return s;
}

/* Pre-login entry surfaces that live OUTSIDE the show() view map — the
   static age gate, the welcome splash, and the invite / referral /
   affiliate signup forms — register a re-render hook here so a
   language switch redraws THAT screen in the new language instead of
   dumping the visitor onto the landing view mid-signup. show() clears
   entryRerender (any in-app navigation means the entry form was
   left); routeInitial clears splashLangRefresh (the splash handed off
   to the real destination); checkAgeGate clears its own hook when the
   visitor passes or is denied. */
let entryRerender = null;
let splashLangRefresh = null;
let gateLangRefresh = null;

/* Language picker — ONE compact link. Tapping it opens a sheet with a
   scrollable list of languages; she can scroll and tap, or TYPE to filter. */
function langPillsHTML() {
  const cur = LANGS.find((l) => l.code === LANG) || LANGS[0];
  return `<button type="button" class="lang-link" data-langtoggle>${cur.flag} ${cur.label} <span class="lang-caret">▾</span></button>`;
}
function openLangSheet() {
  let sheet = document.getElementById('langSheet');
  if (!sheet) {
    sheet = document.createElement('div');
    sheet.id = 'langSheet';
    sheet.className = 'lang-sheet';
    document.body.appendChild(sheet);
    sheet.addEventListener('click', (e) => { if (e.target === sheet) closeLangSheet(); });
  }
  sheet.innerHTML = `
    <div class="lang-sheet-card">
      <div class="lang-sheet-title">🌐 ${t('language')}</div>
      <input class="input lang-search" type="text" placeholder="${t('language_search_ph')}" autocomplete="off">
      <div class="lang-list">${LANGS.map((l) =>
        `<button type="button" class="lang-opt${LANG === l.code ? ' on' : ''}" data-setlang="${l.code}"><span>${l.flag} ${l.label}</span>${LANG === l.code ? '<span class="lang-check">✓</span>' : ''}</button>`).join('')}</div>
      <button type="button" class="btn ghost" data-langclose style="width:100%">${t('cancel')}</button>
    </div>`;
  // The age gate and the welcome splash sit at z-index 9999 — while
  // either is up, the sheet must ride above it or the language options
  // hide behind the door.
  sheet.classList.toggle('over-splash', !!splashLangRefresh || !!gateLangRefresh);
  sheet.hidden = false;
  const input = sheet.querySelector('.lang-search');
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    sheet.querySelectorAll('.lang-opt').forEach((b) => {
      b.style.display = b.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  });
  setTimeout(() => { try { input.focus(); } catch (e) { /* noop */ } }, 60);
}
function closeLangSheet() {
  const sheet = document.getElementById('langSheet');
  if (sheet) sheet.hidden = true;
}
function langCardHTML() {
  return `<div class="card">
      <div style="font-weight:800;margin-bottom:6px">🌐 ${t('language')}</div>
      <div class="muted small" style="margin-bottom:10px">${t('language_note')}</div>
      ${langPillsHTML()}
    </div>`;
}
function applyLang(code) {
  if (!LANGS.some((x) => x.code === code)) return false;
  LANG = code;
  try { localStorage.setItem('wc_lang', code); } catch (e) { /* private mode */ }
  document.documentElement.lang = code === 'pt' ? 'pt-BR' : code;
  return true;
}
/* Account language is the cross-device copy: adopt it when this device has
   no explicit choice; if the device choice differs, push the device's up. */
function syncLangFromUser(u) {
  if (!u || !LANGS.some((x) => x.code === u.language) || u.language === LANG) return;
  let local = null;
  try { local = localStorage.getItem('wc_lang'); } catch (e) { /* ignore */ }
  if (!local) applyLang(u.language);
  else if (S.token) api('/me/language', { method: 'PATCH', body: JSON.stringify({ language: local }) }).catch(() => {});
}
async function setLang(code) {
  if (code === LANG || !applyLang(code)) return;
  if (S.token) api('/me/language', { method: 'PATCH', body: JSON.stringify({ language: code }) }).catch(() => {});
  toast(t('language_set'));
  // At the age gate there is nothing else on screen — just re-label
  // the gate in place; the boot sequence is still waiting on it.
  if (gateLangRefresh) { gateLangRefresh(); return; }
  // On the welcome splash there is no view to re-render yet — just swap
  // the splash's own lines in place (routing happens on Enter).
  if (splashLangRefresh) { splashLangRefresh(); return; }
  // Re-render the current view in place. Never tear down a live stream —
  // its labels pick the new language up on the next navigation.
  if (['liveBroadcast', 'liveWatch'].includes(S.view)) { renderTabbar(); return; }
  // Entry forms (invite / referral / affiliate signup) aren't show()
  // views — redraw the form itself so she keeps her place at the door.
  if (entryRerender) { entryRerender(); return; }
  show(S.view, S.viewParams || {});
}
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-langtoggle]')) { openLangSheet(); return; }
  if (e.target.closest('[data-langclose]')) { closeLangSheet(); return; }
  const b = e.target.closest('[data-setlang]');
  if (b) { closeLangSheet(); setLang(b.dataset.setlang); }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLangSheet(); });
document.documentElement.lang = LANG === 'pt' ? 'pt-BR' : LANG;

/* ---------------- state ---------------- */

const S = {
  token: localStorage.getItem('wc_token') || null,
  guestToken: localStorage.getItem('wc_guest') || null,
  user: null,       // logged-in user (public fields)
  wallet: null,
  model: null,      // model profile if role=model
  ws: null,
  view: 'landing',
  viewParams: {},   // last params passed to show() — lets setLang re-render in place
  conv: null,       // active conversation {id, other, is_paused, free_remaining}
  messages: [],
  call: null,       // active call state
  previewFan: false, // admin-only: browsing the app as a fan, no sign-out needed
  live: null,       // active live session state {sessionId, role, ...}
};

/* ---------------- AI nudity monitor (NSFWJS, client-side) ---------------- */
/* Loads lazily only when a fan opens a live view. If it fails (offline,    */
/* blocked CDN), the app falls back to the model's manual "Go Explicit".   */
const NSFW = {
  model: null,
  loading: false,
  failed: false,
  failCount: 0,
  async ensure() {
    if (this.model) return this.model;
    if (this.loading) return null;
    // Don't permanently give up — retry with backoff (max 5 attempts)
    if (this.failed && this.failCount >= 5) return null;
    this.loading = true;
    try {
      // esm.sh bundles tfjs + deps; jsdelivr's dist is CJS-only and won't load via <script>
      const mod = await import(/* webpackIgnore: true */ 'https://esm.sh/nsfwjs@2.4.2');
      const loadFn = mod.load || (mod.default && mod.default.load);
      this.model = await loadFn();
      this.loading = false;
      this.failed = false;
      this.failCount = 0;
      // Notify any waiting UI that AI is now active
      if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('nsfw-ready'));
      return this.model;
    } catch (e) {
      console.warn('NSFWJS failed to load, using manual mode:', e);
      this.failed = true;
      this.failCount++;
      this.loading = false;
      // Auto-retry in 30s (up to 5 attempts)
      if (this.failCount < 5) {
        setTimeout(() => { this.failed = false; this.ensure(); }, 30000);
      }
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

/* ---------- Photo cropper: square crop before upload (admin + models) ---------- */
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
    // Incremental: append the one bubble; scroll only if he was already
    // at the bottom (never yank him out of history he's reading).
    const nearBottom = chatNearBottom();
    if (!S.messages.find((x) => x.id === m.message.id)) S.messages.push(m.message);
    appendMessageBubble(m.message);
    if (nearBottom) pinChatScroll();
    api(`/conversations/${S.conv.id}/read`, { method: 'POST' })
      .then(() => refreshTabBadges()).catch(() => {});
    // TikTok-style gift: emoji flies across the screen for both sides
    const gg = giftOf(m.message);
    if (gg) flyGiftAnim(gg.emoji, m.message.sender_name || 'Someone', gg.name);
  } else if (m.type === 'chat:new') {
    refreshTabBadges();
  } else if (m.type === 'chat:read' && S.view === 'chat' && S.conv && m.conversation_id === S.conv.id) {
    // Read receipts flip in place — a full rebuild just to turn ✓ blue
    // was part of the send/receive glitch.
    S.messages.forEach((x) => {
      if (!x.is_read) {
        x.is_read = 1;
        if (S.user && x.sender_id === S.user.id) updateMessageBubble(x);
      }
    });
  } else if (m.type === 'message:reaction' && S.view === 'chat' && S.conv && m.conversation_id === S.conv.id) {
    // Targeted bubble update — never a full re-render, never a scroll yank.
    const msg = S.messages.find((x) => x.id === m.message_id);
    if (msg) {
      msg.reactions = (m.reactions || []).map((r) => ({
        emoji: r.emoji, user_id: r.user_id, mine: S.user ? r.user_id === S.user.id : false,
      }));
      updateMessageBubble(msg);
    }
  } else if (m.type === 'message:edited' && S.view === 'chat' && S.conv && m.conversation_id === S.conv.id) {
    const msg = S.messages.find((x) => x.id === m.message_id);
    if (msg) {
      msg.body = m.body;
      msg.edited = true;
      msg.edited_at = m.edited_at;
      if (editingMsgId !== msg.id) updateMessageBubble(msg);
    }
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
    if (m.remaining_min != null) S.call.remainingMin = m.remaining_min;
    updateCallHUD();
    if (m.balance_cents != null && S.wallet) { S.wallet.credits_cents = m.balance_cents; }
  } else if (m.type === 'call:ended' && S.call && m.call_id === S.call.id) {
    endCallUI(m.reason === 'insufficient_credits'
      ? 'Out of credits — call ended.'
      : m.reason === 'fan_no_show'
        ? (S.call.role === 'model'
          ? '💔 He never showed up — the booking is paid, you keep it.'
          : "💔 You missed the 1-on-1 — no-shows aren't refunded.")
      : m.reason === 'time_up' ? "⏰ Time's up — FaceTime over!" : 'Call ended.');
  } else if (m.type === 'facetime:request') {
    if (S.user && S.user.role === 'model') showFtRequestCard(m.request);
  } else if (m.type === 'facetime:update') {
    if (S.user && S.user.role === 'fan') updateFtPanel(m.request, m.reason);
    if (S.user && S.user.role === 'model') refreshFtCard();
  } else if (m.type === 'queue:update') {
    if (S.user && S.user.role === 'fan') updateFtPanel(m.request, m.reason);
  } else if (m.type === 'queue:your_turn') {
    if (S.user && S.user.role === 'fan') {
      updateFtPanel(m.request, m.reason);
      toast(`💚 Your turn! ${m.request.model_name} is ready — tap ${t('bk_start_now')}`, 5000);
    }
  } else if (m.type === 'facetime:queue') {
    if (S.user && S.user.role === 'model') updateModelFtQueue(m.requests || []);
  } else if (m.type === 'call:explicit_offer' && S.call && m.call_id === S.call.id) {
    showExplicitOffer(m);
  } else if (m.type === 'call:explicit_on' && S.call && m.call_id === S.call.id) {
    S.call.explicit = true;
    S.call.explicitPending = false;
    syncExplicitBtn();
    toast('🔞 Explicit mode ON');
  } else if (m.type === 'call:explicit_declined') {
    if (S.call) S.call.explicitPending = false;
    syncExplicitBtn();
    toast('He passed on explicit — keeping it normal.');
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
    // Game Category: explicit rows unlock/lock live with her mode
    if ($('#game-sheet')) renderGameSheetBody();
  } else if (m.type === 'live:brb' && S.live && m.session_id === S.live.sessionId) {
    applyLiveBrb(!!m.brb);
  } else if (m.type === 'live:ended' && S.live && m.session_id === S.live.sessionId) {
    endLiveView('Stream ended.');
  } else if (m.type === 'live:killed') {
    // Safety bot ended the stream — say why (live:ended handles teardown)
    toast(m.warning || '🛑 Stream ended by the safety bot.', 6000);
  } else if (m.type === 'live:speech_warning') {
    toast(m.warning || '⚠️ Watch what you say on live.', 5000);
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
    // Show a dedicated modal with big buttons — impossible to miss or block
    showStageRequestModal(m.request, fee);
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
  } else if (m.type === 'game:request' && S.live && m.session_id === S.live.sessionId) {
    // His name + his request splash across BOTH stages
    showGameSplash(m);
    if (S.live.role === 'model') {
      refreshGameBadge();
      if ($('#game-sheet') && gameEditId == null) renderGamePanelBody();
      if (typeof refreshMe === 'function') refreshMe();
    }
  } else if (m.type === 'game:now' && S.live && m.session_id === S.live.sessionId) {
    showGameNow(m);
  } else if (m.type === 'game:update' && S.live && m.session_id === S.live.sessionId) {
    if (S.live.gameNowId === m.request_id) clearGameNow();
    if (S.live.role === 'model') {
      refreshGameBadge();
      if ($('#game-sheet') && gameEditId == null) renderGamePanelBody();
    }
  } else if (m.type === 'game:state' && S.live && m.session_id === S.live.sessionId) {
    S.live.gameOn = !!m.game_on;
    if ($('#game-sheet') && S.live.role === 'fan') renderGameSheetBody();
  } else if (m.type === 'game:refunded' && S.live && m.session_id === S.live.sessionId) {
    if (m.balance_cents != null && S.wallet) S.wallet.credits_cents = m.balance_cents;
    toast(t('game_refunded_toast', { label: m.label || '' }), 4000);
  } else if (m.type === 'withdrawal:decided' && S.user && (S.user.role === 'model' || S.user.role === 'recruiter')) {
    if (m.status === 'paid') toast(`💸 ${fmt(m.amount_cents)} is on its way to your bank!`, 4000);
    else toast(`Withdrawal ${fmt(m.amount_cents)} was not approved${m.note ? ': ' + m.note : ''} — funds are still available.`, 4000);
    if (S.view === 'modelEarnings') show('modelEarnings', {});
    if (S.view === 'recruiter') show('recruiter', {});
  }
}

/* ---------------- router ---------------- */

const TABS = {
  fan: [
    { id: 'models', ico: '🔥', lk: 'tab_models', view: 'fanModels' },
    { id: 'live', ico: '🔴', lk: 'tab_live', view: 'fanLive' },
    { id: 'chats', ico: '💬', lk: 'tab_chats', view: 'fanChats' },
    { id: 'book', ico: '📅', lk: 'tab_bookings', view: 'bookings' },
    { id: 'wallet', ico: '💰', lk: 'tab_wallet', view: 'wallet' },
  ],
  model: [
    { id: 'home', ico: '🏠', lk: 'tab_home', view: 'fanModels' },
    { id: 'chats', ico: '💬', lk: 'tab_chats', view: 'modelChats' },
    { id: 'book', ico: '📅', lk: 'tab_bookings', view: 'bookings' },
    { id: 'earn', ico: '💵', lk: 'tab_earnings', view: 'modelEarnings' },
    { id: 'settings', ico: '⚙️', lk: 'tab_settings', view: 'modelSettings' },
  ],
  recruiter: [], // Affiliates get a single-page dashboard — no tabs
};

function renderTabbar() {
  if (!S.user) { tabbar.classList.add('hidden'); tabbar.innerHTML = ''; return; }
  const inPreview = isFanPreview();
  const tabs = inPreview ? TABS.fan : (TABS[S.user.role] || []);
  tabbar.classList.remove('hidden');
  tabbar.innerHTML = tabs.map((tab) =>
    `<button data-tab="${tab.id}" class="${S.view === tab.view ? 'active' : ''}">
       <span class="ico">${tab.ico}</span>${t(tab.lk)}<span class="badge hidden" id="badge-${tab.id}"></span>
     </button>`).join('');
  tabbar.querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      const tab = tabs.find((x) => x.id === b.dataset.tab);
      show(tab.view, {});
    };
  });
}

/* ---------------- Admin: preview the app as a fan ----------------
   Corry checks how the fan pages look after every update WITHOUT signing
   out of the moderator account (no more fandemo round-trip). Browse-only:
   fan actions (follow / join / chat / buy) are server-gated to real fans,
   so tiles open the same look-only peek card models get, and the account
   pages (chats / bookings / wallet) show a placeholder instead of 403s. */
function isFanPreview() {
  return !!(S.user && S.user.role === 'admin' && S.previewFan);
}
function enterFanPreview() {
  if (!S.user || S.user.role !== 'admin') return;
  S.previewFan = true;
  show('fanModels', {});
}
function exitFanPreview() {
  // The moderator panel no longer lives in this app — it's Slut Manager.
  location.href = '/manager';
}
/* Pinned strip at the very top of the phone column — rendered on every
   show() while previewing, so there's always a one-tap way back. */
function renderPreviewBanner() {
  const phone = document.getElementById('phone');
  let bar = document.getElementById('preview-banner');
  if (isFanPreview()) {
    if (!bar && phone) {
      bar = document.createElement('div');
      bar.id = 'preview-banner';
      bar.className = 'preview-banner';
      bar.textContent = '👁 You\'re previewing the fan view — tap to return to Slut Manager';
      bar.onclick = exitFanPreview;
      phone.insertBefore(bar, phone.firstChild);
    }
  } else if (bar) {
    bar.remove();
  }
}
function vPreviewPlaceholder() {
  const label = { fanChats: '💬 Chats', bookings: '📅 Bookings', wallet: '💰 Wallet' }[S.view] || 'This page';
  app.innerHTML = `
    <div class="header"><h1>${label}</h1></div>
    <div class="screen">
      <div class="empty"><div class="big">👁</div>Preview mode — switch back to Slut Manager to use your admin tools.<br>
        <span class="small">This page runs on a fan's own account, so there's nothing to show while you preview. The home grid and Live pages up top are fully browsable.</span></div>
      <button class="btn" id="preview-exit" style="width:100%;margin-top:14px">🛡️ Back to Slut Manager</button>
    </div>`;
  const b = $('#preview-exit');
  if (b) b.onclick = exitFanPreview;
}

/* Manager-account interstitial: signing in to the PUBLIC app with the
   manager account lands here — never silently inside the app. "Open Slut
   Manager" is the big deliberate action; "Continue" drops into the fan
   preview on purpose. */
function vManagerGate() {
  tabbar.classList.add('hidden');
  app.innerHTML = `
    <div class="header"><h1>Slut<span class="logo">Camp</span></h1>
      <div class="sub">Manager account</div></div>
    <div class="screen">
      <div class="card" style="text-align:center;padding:22px 16px">
        <img src="/img/lips-logo.png" alt="" style="width:72px;height:72px;border-radius:50%;border:2px solid var(--pink);box-shadow:0 0 18px rgba(255,92,158,.45)">
        <div style="font-weight:800;font-size:19px;margin:12px 0 6px">You're signed in with the manager account</div>
        <div class="muted small">Management lives in its own app now — Slut Manager — so it never mixes with the fan side.</div>
        <button class="btn" id="mg-open" style="width:100%;margin-top:16px;padding:15px;font-size:16px;font-weight:800">Open Slut Manager</button>
        <button class="btn ghost" id="mg-continue" style="width:100%;margin-top:10px">Continue to the app</button>
        <button class="btn ghost" id="mg-logout" style="width:100%;margin-top:6px">Log out</button>
      </div>
    </div>`;
  $('#mg-open').onclick = () => { location.href = '/manager'; };
  $('#mg-continue').onclick = () => enterFanPreview();
  $('#mg-logout').onclick = () => logout();
}

/* Home-screen icon badge (Badging API): mirrors the in-app unread total
   onto the installed app's icon. Feature-detected — where the API does
   not exist this is a silent no-op. Best-effort only, never throws. */
function updateAppBadge(n) {
  try {
    if (!('setAppBadge' in navigator)) return;
    let p = null;
    if (n > 0) p = navigator.setAppBadge(n);
    else if ('clearAppBadge' in navigator) p = navigator.clearAppBadge();
    else p = navigator.setAppBadge(0);
    if (p && p.catch) p.catch(() => {});
  } catch (e) { /* badge is best-effort */ }
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
    updateAppBadge(total);
  } catch (e) { /* ignore */ }
}

const MODEL_VIEWS = ['modelChats', 'modelEarnings', 'modelSettings', 'bookings', 'liveBroadcast', 'chat'];

function show(view, params) {
  // Any show() navigation means a pre-login entry form was left behind.
  entryRerender = null;
  // Gate: unsigned models must sign the contract first
  if (S.user && S.user.role === 'model' && S.contractSigned === false
      && view !== 'modelContract' && MODEL_VIEWS.includes(view)) {
    view = 'modelContract';
  }
  S.view = view;
  S.viewParams = params || {};
  // Inside a DM conversation the bottom tab bar vanishes for the WHOLE
  // visit (owner: "too crowded when I'm in the chat") — driven off the
  // view itself, so every exit path (‹ back, tab switch, logout, any
  // programmatic show()) restores it. CSS unions this with body.sheet-open:
  // the bar is hidden when EITHER state holds, so a sheet closing inside
  // a chat can never resurrect it, and leaving a chat with a sheet open
  // keeps it hidden only until the sheet closes.
  document.body.classList.toggle('in-chat', view === 'chat');
  document.body.classList.toggle('in-live', view === 'liveBroadcast' || view === 'liveWatch');
  // Every view change passes through here: drop any live-band keyboard
  // tracking (and its transform) before the old band leaves the DOM.
  untrackLiveBand();
  renderTabbar();
  renderPreviewBanner();
  renderBell();
  window.scrollTo(0, 0);
  const VIEWS = {
    landing: vLanding, auth: vAuth,
    fanModels: vFanModels, fanLive: vFanLive, lives: vLives, fanChats: vFanChats, wallet: vWallet, quickSignup: vQuickSignup,
    modelChats: vModelChats, modelEarnings: vModelEarnings, modelSettings: vModelSettings,
    chat: vChat,
    liveBroadcast: vLiveBroadcast, liveWatch: vLiveWatch,
    bookings: vBookings, terms: vTerms, privacy: vPrivacy, billing: vBilling, statement2257: vStatement2257,
    managerGate: vManagerGate, modelContract: vModelContract,
    recruiter: vRecruiter, notifications: vNotifications, dmca: vDmca,
  };
  // Fan-preview placeholders: chats/bookings/wallet run on a fan's own data
  // and would 403 for an admin token — show the friendly note instead.
  const viewFn = (isFanPreview() && ['fanChats', 'bookings', 'wallet'].includes(view))
    ? vPreviewPlaceholder
    : (VIEWS[view] || vLanding);
  viewFn(params || {});
  if (view === 'liveBroadcast' || view === 'liveWatch') tabbar.classList.add('hidden');
  else if (S.user) refreshTabBadges();
}

/* ---------------- Home tiles — promo-style "who's live" video tiles ----------------
   Media fills the tile: her loop video when she has one, else her photo, else a
   gradient initial. LIVE pill + viewer count are REAL data from /api/models
   (live_session_id + live_viewers counted from live_viewers rows) — never faked. */
function tileGradient(name) {
  const hues = [[265, 320], [300, 340], [220, 280], [280, 310]];
  const h = hues[(name || '?').length % hues.length];
  return `linear-gradient(135deg,hsl(${h[0]},70%,55%),hsl(${h[1]},65%,50%))`;
}

function modelTileHTML(m, opts) {
  opts = opts || {};
  const media = m.preview_video_url
    ? `<video class="tile-media" src="${esc(m.preview_video_url)}" autoplay muted loop playsinline></video>`
    : m.photo_url
      ? `<img class="tile-media" src="${esc(m.photo_url)}" alt="" loading="lazy">`
      : `<span class="tile-media tile-letter" style="background:${tileGradient(m.display_name)}">${esc((m.display_name || '?').trim().charAt(0).toUpperCase())}</span>`;
  const status = m.is_live
    ? `<span style="color:#fda4af;font-weight:800">${t('watch_free')}</span>`
    : m.is_online
      ? `<span style="color:#6ee7b7;font-weight:700">${t('online_now')}</span>`
      : `<span style="color:rgba(255,245,247,.6)">${t('offline')}</span>`;
  return `
    <button class="model-tile${opts.hero ? ' hero' : ''}" data-model="${m.id}" data-live="${m.live_session_id || ''}">
      ${media}
      <span class="tile-shade"></span>
      ${m.is_live
        ? `<span class="tile-live-pill">● LIVE</span><span class="tile-viewers">👁 ${t('watching', { n: m.live_viewers || 0 })}</span>`
        : m.is_featured ? `<span class="tile-featured-pill">${t('featured')}</span>` : ''}
      ${opts.crown ? `<span class="tile-top-pill${m.is_live ? ' below-live' : ''}">${t('top_model')}</span>` : ''}
      ${opts.heartHTML || ''}
      <span class="tile-info">
        <span class="tile-name">${esc(m.display_name)}</span>
        <span class="tile-sub">@${esc(m.username)} · ${status}</span>
        ${opts.hero && m.bio ? `<span class="tile-sub">${esc(m.bio).slice(0, 80)}</span>` : ''}
        <span class="tile-sub" style="color:var(--peach);font-weight:700">${t('per_msg_rate', { price: fmt(m.per_message_cents) })} · ${t('per_min_rate', { price: fmt(m.per_minute_cents) })}</span>
        ${opts.hero && m.schedule_summary ? `<span class="tile-sub">${t('usually_live', { s: esc(m.schedule_summary) })}</span>` : ''}
      </span>
    </button>`;
}

/* Featured model gets the big hero tile on top; everyone else fills the grid
   in the ranked order /api/models returns (likes + sales). #1 regular wears
   the 👑 Top Model crown — the featured headliner doesn't compete. */
/* Home grid pagination (Corry, Oct 12 2026): the ranked girls chart runs
   10 to a page — Top 10 on page 1, next 10 on page 2, and so on. The
   featured headliner (hero) stays pinned above the chart on every page. */
let homePage = 1;
const HOME_PAGE_SIZE = 10;

function homeTilesHTML(models, heartFor) {
  const featured = models.find((m) => m.is_featured);
  const rest = featured ? models.filter((m) => m.id !== featured.id) : models;
  const heart = (m) => (heartFor ? heartFor(m) : '');
  const pages = Math.max(1, Math.ceil(rest.length / HOME_PAGE_SIZE));
  if (homePage > pages) homePage = pages;
  if (homePage < 1) homePage = 1;
  const start = (homePage - 1) * HOME_PAGE_SIZE;
  const slice = rest.slice(start, start + HOME_PAGE_SIZE);
  return `
    ${featured ? modelTileHTML(featured, { hero: true, heartHTML: heart(featured) }) : ''}
    <div class="tile-grid">
      ${slice.map((m, i) => modelTileHTML(m, { crown: start + i === 0, heartHTML: heart(m) })).join('')}
    </div>
    ${pages > 1 ? `
    <div class="row" style="justify-content:center;align-items:center;gap:10px;margin-top:16px">
      <button class="btn small ghost pg-btn" data-pg="${homePage - 1}" ${homePage <= 1 ? 'disabled style="opacity:.4"' : ''}>${t('pager_prev')}</button>
      <span class="small muted">${t('pager_page', { x: homePage, y: pages })}</span>
      <button class="btn small ghost pg-btn" data-pg="${homePage + 1}" ${homePage >= pages ? 'disabled style="opacity:.4"' : ''}>${t('pager_next')}</button>
    </div>` : ''}`;
}

// Pager clicks (one delegated listener for both the guest + fan home grids)
document.addEventListener('click', (e) => {
  const b = e.target.closest('.pg-btn');
  if (!b || b.disabled) return;
  homePage = parseInt(b.dataset.pg) || 1;
  show(S.view, {});
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

/* "🔴 Lives" home button — opens the Live Now grid. The count is REAL data
   from /api/models (is_live flags) — only shown when someone is truly live. */
function livesBtnHTML(models) {
  const n = (models || []).filter((m) => m.is_live).length;
  return `<button class="btn-lives${n ? ' has-live' : ''}" id="go-lives">${t('lives_btn')}${n ? `<span class="lives-count">${t('lives_count', { n })}</span>` : ''}</button>`;
}

/* ---------------- LANDING (public model grid) ---------------- */

async function vLanding() {
  const { data } = await api('/models');
  const models = data.models || [];
  app.innerHTML = `
    <div class="header">
      <h1>Slut<span class="logo">Camp</span> 💬</h1>
      <div class="sub">${t('home_sub')}</div>
    </div>
    <div class="screen">
      ${livesBtnHTML(models)}
      <div class="card" style="text-align:center;background:linear-gradient(135deg,#3b1d6e,#1a0f2e)">
        <div style="font-size:20px;font-weight:800">${t('free3_title')}</div>
        <div class="muted small" style="margin-top:4px">${t('free3_sub')}</div>
      </div>
      ${models.length ? homeTilesHTML(models, (m) => `
            <span class="model-likes tile-heart" data-like="${m.id}">
              <span class="like-heart">${m.liked ? '❤️' : '🤍'}</span>
              <span class="like-count">${m.like_count || 0}</span>
            </span>`) : `<div class="empty"><div class="big">😴</div>${t('no_models')}</div>`}
      <div style="text-align:center;margin-top:14px">
        ${S.user ? '' : `<button class="btn ghost" id="go-login">${t('login_signup')}</button>`}
      </div>
      <div style="text-align:center;margin-top:10px">
        <button class="btn ghost" id="share-app" style="border-color:var(--pink);color:var(--pink)">${t('share_app')}</button>
      </div>
      <div class="lang-row">${langPillsHTML()}</div>
      <p class="muted small" style="text-align:center;margin-top:16px">${t('terms_line')} <a href="javascript:void(0)" id="go-terms" style="color:var(--pink)">${t('terms')}</a> · <a href="javascript:void(0)" id="go-privacy" style="color:var(--pink)">Privacy</a> · <a href="javascript:void(0)" id="go-billing" style="color:var(--pink)">Billing & Refunds</a> · <a href="javascript:void(0)" id="go-2257" style="color:var(--pink)">2257 Statement</a> · <a href="javascript:void(0)" id="go-dmca" style="color:var(--pink)">DMCA</a>.</p>
    </div>`;
  app.querySelectorAll('[data-model]').forEach((b) => {
    b.onclick = () => {
      const liveId = b.dataset.live;
      if (liveId) return watchLive(parseInt(liveId));
      openChatWithModel(parseInt(b.dataset.model));
    };
  });
  // Heart likes — tap without opening chat
  app.querySelectorAll('[data-like]').forEach((h) => {
    h.onclick = async (e) => {
      e.stopPropagation();
      if (!S.user || S.user.role !== 'fan') return toast(t('like_need_fan'));
      const modelId = parseInt(h.dataset.like);
      const { status, data } = await api(`/models/${modelId}/like`, { method: 'POST' });
      if (status === 200) {
        h.querySelector('.like-heart').textContent = data.liked ? '❤️' : '🤍';
        h.querySelector('.like-count').textContent = data.like_count;
      }
    };
  });
  const gl = $('#go-login');
  if (gl) gl.onclick = () => show('auth', {});
  const lv = $('#go-lives');
  if (lv) lv.onclick = () => show('lives', {});
  const sh = $('#share-app');
  if (sh) sh.onclick = shareApp;
  const gt = $('#go-terms');
  if (gt) gt.onclick = () => show('terms', {});
  const gp = $('#go-privacy');
  if (gp) gp.onclick = () => show('privacy', {});
  const gb = $('#go-billing');
  if (gb) gb.onclick = () => show('billing', {});
  const g7 = $('#go-2257');
  if (g7) g7.onclick = () => show('statement2257', {});
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
    try { await navigator.clipboard.writeText(url); toast(t('link_copied')); }
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
  else if (data && data.error === 'region_blocked')
    toast('This model is not available in your region.');
  else toast('Could not open chat.');
}

/* ---------------- AUTH ---------------- */

function vAuth(params) {
  const mode = (params && params.mode) || 'login';
  const role = (params && params.role) || 'fan';
  app.innerHTML = `
    <div class="header"><h1>Slut<span class="logo">Camp</span></h1>
      <div class="sub">${mode === 'login' ? t('welcome_back') : t('create_account_h')}</div></div>
    <div class="screen">
      <div class="tabs">
        <button id="t-login" class="${mode === 'login' ? 'active' : ''}">${t('log_in')}</button>
        <button id="t-signup" class="${mode === 'signup' ? 'active' : ''}">${t('sign_up')}</button>
      </div>
      <div id="auth-body"></div>
      ${mode === 'login' ? `<div class="lang-row" style="margin-top:14px">${langPillsHTML()}</div>` : ''}
      <button class="btn ghost" id="back-browse" style="margin-top:16px">${t('keep_browsing')}</button>
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
      <label class="field">${t('username')}<input class="input" id="a-user" autocomplete="username"></label>
      <label class="field">${t('password')}${pwField('a-pass', 'current-password')}</label>
      <button class="btn" id="a-go">${t('log_in')}</button>
      ${pkSupported() ? `
      <button class="btn ghost" id="a-faceid" style="width:100%;margin-top:10px">🔐 Sign in with Face ID</button>
      <div class="small muted" id="pk-login-msg" style="margin-top:8px;text-align:center"></div>` : ''}`;
    $('#a-go').onclick = doLogin;
    const fidBtn = $('#a-faceid');
    if (fidBtn) fidBtn.onclick = doPasskeyLogin;
  } else {
    body.innerHTML = `
      <div class="role-card ${role === 'fan' ? 'selected' : ''}" id="r-fan">
        <div class="emoji">😍</div><div class="t">${t('im_fan')}</div>
        <div class="d">${t('fan_desc')}</div></div>
      <div class="role-card ${role === 'model' ? 'selected' : ''}" id="r-model">
        <div class="emoji">💃</div><div class="t">${t('im_model')}</div>
        <div class="d">${t('model_desc')}</div></div>
      <label class="field">${t('display_name')}<input class="input" id="a-name" maxlength="40"></label>
      <label class="field">${t('username')}<input class="input" id="a-user" autocomplete="username"></label>
      <label class="field">${t('password_hint')}${pwField('a-pass', 'new-password')}</label>
      <label class="field">${t('dob')}<input class="input" id="a-dob" type="date"></label>
      <div class="age-box">🔞 <b>${t('age18_only')}</b> ${t('age18_line')}
        ${role === 'model' ? t('model_age_id_note') : t('fan_age_line')}</div>
      <label class="checkbox-row"><input type="checkbox" id="a-18">
        <span>${t('confirm18')}</span></label>
      <div class="lang-row">${langPillsHTML()}</div>
      <button class="btn" id="a-go">${t('create_account_btn')}</button>`;
    let r = role;
    $('#r-fan').onclick = () => { r = 'fan'; $('#r-fan').classList.add('selected'); $('#r-model').classList.remove('selected'); };
    $('#r-model').onclick = () => { r = 'model'; $('#r-model').classList.add('selected'); $('#r-fan').classList.remove('selected'); };
    $('#a-go').onclick = () => doSignup(r);
  }
}

async function doLogin() {
  const username = $('#a-user').value.trim(), password = $('#a-pass').value;
  if (!username || !password) return toast(t('enter_user_pass'));
  const { status, data } = await api('/auth/login', {
    method: 'POST', body: JSON.stringify({ username, password, guest_token: S.guestToken }),
  });
  if (status === 200) return afterLogin(data);
  toast(data.error === 'banned' ? t('account_banned') : t('login_failed'));
}

async function doSignup(role) {
  const display_name = $('#a-name').value.trim();
  const username = $('#a-user').value.trim();
  const password = $('#a-pass').value;
  const dob = $('#a-dob').value;
  const agree18 = $('#a-18').checked;
  if (!display_name || !username || !password || !dob) return toast(t('fill_all_fields'));
  if (!agree18) return toast(t('must_confirm_18'));
  const { status, data } = await api('/auth/signup', {
    method: 'POST',
    body: JSON.stringify({ username, password, role, display_name, dob, agree18, guest_token: S.guestToken, language: LANG }),
  });
  if (status === 200) return afterLogin(data);
  const msgs = { username_taken: t('err_username_taken'), must_be_18: t('err_must_be_18'),
    password_too_short: t('err_password_short') };
  toast(msgs[data.error] || t('err_signup_failed'));
}

/* ---------------- Face ID (passkey) sign-in — optional for everyone ---------
 * Hand-rolled WebAuthn client (no dependencies): converts the server's
 * JSON options into PublicKeyCredential options and the credential back
 * into the standard JSON @simplewebauthn/server accepts. The biometric
 * never leaves the device; the server only verifies a signature. */
function pkSupported() {
  return !!(window.PublicKeyCredential && navigator.credentials && window.isSecureContext);
}
function pkB64uToBuf(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}
function pkBufToB64u(buf) {
  const bytes = new Uint8Array(buf || new ArrayBuffer(0));
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function pkCreateOptions(o) {
  const pk = Object.assign({}, o);
  pk.challenge = pkB64uToBuf(o.challenge);
  pk.user = Object.assign({}, o.user, { id: pkB64uToBuf(o.user.id) });
  if (o.excludeCredentials) {
    pk.excludeCredentials = o.excludeCredentials.map((c) =>
      Object.assign({}, c, { id: pkB64uToBuf(c.id) }));
  }
  return pk;
}
function pkRequestOptions(o) {
  const pk = Object.assign({}, o);
  pk.challenge = pkB64uToBuf(o.challenge);
  if (o.allowCredentials) {
    pk.allowCredentials = o.allowCredentials.map((c) =>
      Object.assign({}, c, { id: pkB64uToBuf(c.id) }));
  }
  return pk;
}
function pkCredJson(cred) {
  const r = cred.response;
  const json = {
    id: cred.id,
    rawId: pkBufToB64u(cred.rawId),
    type: cred.type,
    authenticatorAttachment: cred.authenticatorAttachment || null,
    clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
    response: { clientDataJSON: pkBufToB64u(r.clientDataJSON) },
  };
  if (r.attestationObject !== undefined) {
    json.response.attestationObject = pkBufToB64u(r.attestationObject);
    if (r.getTransports) { try { json.response.transports = r.getTransports(); } catch (e) {} }
    if (r.getPublicKeyAlgorithm) { try { json.response.publicKeyAlgorithm = r.getPublicKeyAlgorithm(); } catch (e) {} }
    if (r.getAuthenticatorData) { try { json.response.authenticatorData = pkBufToB64u(r.getAuthenticatorData()); } catch (e) {} }
  } else {
    json.response.authenticatorData = pkBufToB64u(r.authenticatorData);
    json.response.signature = pkBufToB64u(r.signature);
    json.response.userHandle = r.userHandle ? pkBufToB64u(r.userHandle) : null;
  }
  return json;
}
function pkDeviceLabel() {
  const ua = navigator.userAgent || '';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  return 'This device';
}
function pkErrText(e) {
  if (e && e.name === 'NotAllowedError') return 'Face ID was cancelled or timed out — try again, or use your password.';
  if (e && e.name === 'InvalidStateError') return 'This device already has a passkey for your account.';
  return "Face ID didn't work — try again, or use your password.";
}

/* Login screen: Face ID sign-in with the username typed in the form. */
async function doPasskeyLogin() {
  const msg = $('#pk-login-msg');
  const say = (txt) => { if (msg) msg.textContent = txt; };
  const userEl = $('#a-user');
  const username = userEl ? userEl.value.trim() : '';
  if (!username) {
    say('Type your username above first, then tap Face ID.');
    if (userEl) userEl.focus();
    return;
  }
  say('');
  try {
    const { status, data } = await api('/auth/passkey/login-options', {
      method: 'POST', body: JSON.stringify({ username }),
    });
    if (status !== 200) {
      say(data.error === 'no_passkey'
        ? 'No Face ID set up for that username yet — sign in with your password first, then turn it on in Settings.'
        : data.error === 'too_many_attempts'
          ? 'Too many tries — wait a minute and try again.'
          : 'Face ID sign-in is not available right now — use your password.');
      return;
    }
    const cred = await navigator.credentials.get({ publicKey: pkRequestOptions(data) });
    if (!cred) { say('Face ID was cancelled.'); return; }
    const v = await api('/auth/passkey/login-verify', {
      method: 'POST', body: JSON.stringify({ username, response: pkCredJson(cred) }),
    });
    if (v.status === 200) return afterLogin(v.data); // same flow as password login
    say(v.data.error === 'banned' ? 'This account is banned.'
      : "Face ID didn't match — try again, or use your password.");
  } catch (e) {
    say(pkErrText(e));
  }
}

/* Settings card (fan wallet + model settings): enroll / list / remove. */
async function renderPkSettingsCard() {
  const host = document.getElementById('pk-card');
  if (!host) return;
  if (!pkSupported()) {
    host.innerHTML = `
      <div class="card">
        <div style="font-weight:800;margin-bottom:6px">🔐 Face ID sign-in</div>
        <div class="muted small">This device or browser doesn't support Face ID sign-in — it needs Safari or Chrome over HTTPS on a device with Face ID / a fingerprint reader. Your password works as always.</div>
      </div>`;
    return;
  }
  const { data } = await api('/auth/passkey/list').catch(() => ({ data: {} }));
  const creds = (data && data.credentials) || [];
  host.innerHTML = `
    <div class="card">
      <div style="font-weight:800;margin-bottom:6px">🔐 Face ID sign-in</div>
      <div class="muted small" style="margin-bottom:10px">Sign in with your face or fingerprint instead of typing your password. Your password still works as a backup.</div>
      ${creds.map((c) => `
      <div class="row" style="align-items:center;gap:8px;padding:5px 0">
        <span class="small" style="flex:1">📱 ${esc(c.device_label || 'Passkey')} <span class="muted">· added ${esc(String(c.created_at || '').slice(0, 10))}</span></span>
        <button class="btn small ghost" data-pk-del="${c.id}">Remove</button>
      </div>`).join('')}
      <button class="btn" id="pk-setup" style="width:100%;margin-top:6px">Set up Face ID on this device</button>
      <div class="muted small" id="pk-msg" style="margin-top:6px"></div>
    </div>`;
  $('#pk-setup').onclick = async () => {
    const m = $('#pk-msg');
    try {
      const { status, data } = await api('/auth/passkey/register-options', { method: 'POST', body: '{}' });
      if (status !== 200) throw new Error(data.error || 'options_failed');
      const cred = await navigator.credentials.create({ publicKey: pkCreateOptions(data) });
      if (!cred) throw new Error('cancelled');
      const v = await api('/auth/passkey/register-verify', {
        method: 'POST',
        body: JSON.stringify({ response: pkCredJson(cred), label: pkDeviceLabel() }),
      });
      if (v.status !== 200) throw new Error(v.data.error || 'verify_failed');
      toast('✅ Face ID is on for this device');
      renderPkSettingsCard();
    } catch (e) {
      if (m) m.textContent = pkErrText(e);
    }
  };
  host.querySelectorAll('[data-pk-del]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Remove Face ID for this device? You can set it up again anytime.')) return;
      const { status } = await api(`/auth/passkey/${b.dataset.pkDel}`, { method: 'DELETE' });
      if (status === 200) { toast('Face ID removed'); renderPkSettingsCard(); }
      else toast('Remove failed');
    };
  });
}

/* Settings card (fan wallet + model settings): change your password.
   The server verifies the current password, enforces the policy and
   revokes every other session; this card mirrors the checks so the
   feedback is instant. */
function renderPwSettingsCard() {
  const host = document.getElementById('pw-card');
  if (!host) return;
  host.innerHTML = `
    <div class="card">
      <div style="font-weight:800;margin-bottom:6px">🔑 Change password</div>
      <div class="muted small" style="margin-bottom:10px">Pick a new password — at least 10 characters, and different from your current one. You stay signed in on this device; every other device is signed out.</div>
      <label class="field">Current password${pwField('pw-cur', 'current-password')}</label>
      <label class="field">New password${pwField('pw-new', 'new-password')}</label>
      <label class="field">Confirm new password${pwField('pw-confirm', 'new-password')}</label>
      <button class="btn" id="pw-go" style="width:100%;margin-top:6px">Change password</button>
      <div class="muted small" id="pw-msg" style="margin-top:6px"></div>
    </div>`;
  $('#pw-go').onclick = async () => {
    const cur = $('#pw-cur').value, nw = $('#pw-new').value, cf = $('#pw-confirm').value;
    if (!cur || !nw || !cf) return toast('Fill in all three password fields');
    if (nw !== cf) return toast("New passwords don't match");
    if (nw.length < 10) return toast('New password needs at least 10 characters');
    if (nw === cur) return toast('New password must be different from your current one');
    const { status, data } = await api('/me/change-password', {
      method: 'POST', body: JSON.stringify({ current_password: cur, new_password: nw }),
    });
    if (status === 200) {
      $('#pw-cur').value = ''; $('#pw-new').value = ''; $('#pw-confirm').value = '';
      const m = $('#pw-msg'); if (m) m.textContent = '✅ Password changed — other devices were signed out.';
      toast('✅ Password changed');
    } else if (status === 401) {
      toast('Current password is wrong');
    } else if (data && data.error === 'default_password') {
      toast("That's a well-known default password — pick something only you know");
    } else if (data && data.error === 'weak_password') {
      toast('New password is too weak — at least 10 characters, and different from your current one');
    } else {
      toast('Could not change password — try again');
    }
  };
}

/* ---------------- MODEL INVITE SIGNUP (?invite=CODE) ---------------- */

async function vInviteSignup(code) {
  // Language switches redraw this form (it isn't a show() view).
  entryRerender = () => vInviteSignup(code);
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
        <div style="font-weight:800;margin:8px 0">${t('invalid_invite_h')}</div>
        <div class="muted small">${t('invalid_invite_sub')}</div>
        <div class="lang-row">${langPillsHTML()}</div>
        <button class="btn ghost" style="margin-top:12px" onclick="show('landing',{})">${t('back_browsing')}</button>
      </div></div>`;
    return;
  }

  app.innerHTML = `
    <div class="header"><h1>Slut<span class="logo">Camp</span> 💃</h1>
      <div class="sub">${t('invited_model_sub')}${label ? ` · <b>${esc(label)}</b>` : ''}</div></div>
    <div class="screen">
      <div class="card" style="background:linear-gradient(135deg,#3b1d6e,#1a0f2e);text-align:center">
        <div style="font-size:18px;font-weight:800">${t('paid_chat_h')}</div>
        <div class="muted small" style="margin-top:4px">${t('invite_earn_sub')}</div>
      </div>
      <label class="field">${t('stage_name_label')}<input class="input" id="i-name" maxlength="40"></label>
      <label class="field">${t('username')}<input class="input" id="i-user" autocomplete="username"></label>
      <label class="field">${t('password_hint')}${pwField('i-pass', 'new-password')}</label>
      <label class="field">${t('dob')}<input class="input" id="i-dob" type="date"></label>
      <div class="age-box">🔞 <b>${t('age18_only')}</b> ${t('age_id_note')}</div>
      <label class="checkbox-row"><input type="checkbox" id="i-18">
        <span>${t('confirm18')}</span></label>
      <div class="lang-row">${langPillsHTML()}</div>
      <button class="btn" id="i-go">${t('create_model_btn')}</button>
      <button class="btn ghost" id="i-back" style="margin-top:12px">${t('back')}</button>
    </div>`;

  $('#i-back').onclick = () => show('landing', {});
  $('#i-go').onclick = async () => {
    const display_name = $('#i-name').value.trim();
    const username = $('#i-user').value.trim();
    const password = $('#i-pass').value;
    const dob = $('#i-dob').value;
    const agree18 = $('#i-18').checked;
    if (!display_name || !username || !password || !dob) return toast(t('fill_all_fields'));
    if (!agree18) return toast(t('must_confirm_18'));
    const { status, data } = await api('/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ username, password, role: 'model', display_name, dob, agree18,
        guest_token: S.guestToken, invite_code: code, language: LANG }),
    });
    if (status === 200) return afterLogin(data);
    const msgs = { username_taken: t('err_username_taken'), must_be_18: t('err_must_be_18'),
      password_too_short: t('err_password_short'),
      bad_invite: t('err_bad_invite'), invite_used: t('err_invite_used') };
    toast(msgs[data.error] || data.message || t('err_signup_failed'));
  };
}

/* Partner referral signup: model joins through a recruiter's link */
async function vRecruiterSignup(code) {
  // Language switches redraw this form (it isn't a show() view).
  entryRerender = () => vRecruiterSignup(code);
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
        <div style="font-weight:800;margin:8px 0">${t('invalid_ref_h')}</div>
        <div class="muted small">${t('invalid_ref_sub')}</div>
        <div class="lang-row">${langPillsHTML()}</div>
        <button class="btn ghost" style="margin-top:12px" onclick="show('landing',{})">${t('back_browsing')}</button>
      </div></div>`;
    return;
  }

  app.innerHTML = `
    <div class="header"><h1>Slut<span class="logo">Camp</span> 💃</h1>
      <div class="sub">${t('invited_by', { name: esc(recruiterName) })}</div></div>
    <div class="screen">
      <div class="card" style="background:linear-gradient(135deg,#3b1d6e,#1a0f2e);text-align:center">
        <div style="font-size:18px;font-weight:800">${t('paid_chat_h')}</div>
        <div class="muted small" style="margin-top:4px">${t('rec_earn_sub')}</div>
      </div>
      <label class="field">${t('stage_name_label')}<input class="input" id="i-name" maxlength="40"></label>
      <label class="field">${t('username')}<input class="input" id="i-user" autocomplete="username"></label>
      <label class="field">${t('password_hint')}${pwField('i-pass', 'new-password')}</label>
      <label class="field">${t('dob')}<input class="input" id="i-dob" type="date"></label>
      <div class="age-box">🔞 <b>${t('age18_only')}</b> ${t('age_id_note')}</div>
      <label class="checkbox-row"><input type="checkbox" id="i-18">
        <span>${t('confirm18')}</span></label>
      <div class="lang-row">${langPillsHTML()}</div>
      <button class="btn" id="i-go">${t('create_model_btn')}</button>
      <button class="btn ghost" id="i-back" style="margin-top:12px">${t('back')}</button>
    </div>`;

  $('#i-back').onclick = () => show('landing', {});
  $('#i-go').onclick = async () => {
    const display_name = $('#i-name').value.trim();
    const username = $('#i-user').value.trim();
    const password = $('#i-pass').value;
    const dob = $('#i-dob').value;
    const agree18 = $('#i-18').checked;
    if (!display_name || !username || !password || !dob) return toast(t('fill_all_fields'));
    if (!agree18) return toast(t('must_confirm_18'));
    const { status, data } = await api('/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ username, password, role: 'model', display_name, dob, agree18,
        guest_token: S.guestToken, referral_code: code, language: LANG }),
    });
    if (status === 200) return afterLogin(data);
    const msgs = { username_taken: t('err_username_taken'), must_be_18: t('err_must_be_18'),
      password_too_short: t('err_password_short'),
      bad_referral: t('err_bad_referral') };
    toast(msgs[data.error] || data.message || t('err_signup_failed'));
  };
}

/* Affiliate signup via Corry's invite link — agreement popup required */
async function vAffiliateSignup(code) {
  // Language switches redraw this form (it isn't a show() view). The
  // agreement text itself stays English — legal copy, like the rest of
  // the app's long-tail legal strings; only the form chrome translates.
  entryRerender = () => vAffiliateSignup(code);
  let valid = false, label = '';
  try {
    const { status, data } = await api(`/affiliate-invite/${encodeURIComponent(code)}`);
    valid = status === 200 && data.valid;
    label = data.label || '';
  } catch { valid = false; }

  if (!valid) {
    app.innerHTML = `
      <div class="header"><h1>Slut<span class="logo">Camp</span></h1></div>
      <div class="screen"><div class="card" style="text-align:center">
        <div style="font-size:40px">⛔</div>
        <div style="font-weight:800;margin:8px 0">${t('aff_invalid_h')}</div>
        <div class="muted small">${t('aff_invalid_sub')}</div>
        <div class="lang-row">${langPillsHTML()}</div>
        <button class="btn ghost" style="margin-top:12px" onclick="show('landing',{})">${t('back_browsing')}</button>
      </div></div>`;
    return;
  }

  // Recruiter agreement text (matches server RECRUITER_CONTRACT vR1.0)
  const AGREEMENT = [
    ['1. Parties', 'This Recruiter Agreement is between you ("Recruiter") and World of Godz Entertainment LLC, doing business as SlutCamp. By signing, you agree to everything below.'],
    ['2. Independent Contractor — Not a Partner', 'You are an INDEPENDENT CONTRACTOR, not an employee. Nothing here creates an employment relationship, a legal business partnership, or agency — "partner" is just what we call the role in the app. You handle your own taxes.'],
    ['3. What You Do', 'You recruit models to join SlutCamp using your personal referral link. Be honest about the platform — no false promises about earnings.'],
    ['4. Your Cut', 'You earn 20% of everything each model you recruit earns. The model keeps her full 60% — your cut comes from the Company\'s portion.'],
    ['5. Termination — At Will', 'SlutCamp may revoke your recruiter status AT ANY TIME, for any reason or no reason, with NO NOTICE. When revoked, you stop earning on all future revenue immediately.'],
    ['6. Conduct Rules', 'You must NOT: share contact info or payment handles; try to take models or fans off-platform; use hate speech. Breaking these rules can get you deactivated immediately.'],
    ['7. Non-Solicitation — Permanent', 'If your recruiter status ends for any reason, you may NEVER recruit or solicit any model you met through SlutCamp to a competing platform. No time limit.'],
    ['8. Confidentiality', 'Do not disclose SlutCamp\'s business methods, commission structures, or internal operations to anyone outside the Company.'],
    ['9. Disclaimer', 'This is a plain-language summary — NOT legal advice and NOT attorney-reviewed. You are encouraged to have your own attorney review before signing.'],
  ];

  app.innerHTML = `
    <div class="header"><h1>Slut<span class="logo">Camp</span> 🤝</h1>
      <div class="sub">${t('aff_invite_sub')}${label ? ` · ${esc(label)}` : ''}</div></div>
    <div class="screen">
      <div class="card" style="background:linear-gradient(135deg,#3b1d6e,#1a0f2e);text-align:center">
        <div style="font-size:18px;font-weight:800">${t('aff_become_h')}</div>
        <div class="muted small" style="margin-top:4px">${t('aff_become_sub')}</div>
      </div>
      <label class="field">${t('your_name')}<input class="input" id="a-name" maxlength="40"></label>
      <label class="field">${t('username')}<input class="input" id="a-user" autocomplete="username"></label>
      <label class="field">${t('password_hint')}${pwField('a-pass', 'new-password')}</label>
      <div class="card" style="margin-top:12px;max-height:280px;overflow-y:auto;text-align:left">
        <div style="font-weight:800;margin-bottom:8px">${t('aff_agreement_h')}</div>
        ${AGREEMENT.map(([t, b]) => `<div style="margin-bottom:10px"><div style="font-weight:700">${esc(t)}</div><div class="small muted">${esc(b)}</div></div>`).join('')}
      </div>
      <label class="checkbox-row" style="margin-top:12px"><input type="checkbox" id="a-agree">
        <span>${t('aff_agree')}</span></label>
      <div class="lang-row">${langPillsHTML()}</div>
      <button class="btn" id="a-go">${t('aff_accept_btn')}</button>
      <button class="btn ghost" id="a-back" style="margin-top:12px">${t('back')}</button>
    </div>`;

  $('#a-back').onclick = () => show('landing', {});
  $('#a-go').onclick = async () => {
    const display_name = $('#a-name').value.trim();
    const username = $('#a-user').value.trim();
    const password = $('#a-pass').value;
    const agreed = $('#a-agree').checked;
    if (!display_name || !username || !password) return toast(t('fill_all_fields'));
    if (password.length < 6) return toast(t('err_password_short'));
    if (!agreed) return toast(t('aff_must_agree'));
    const { status, data } = await api(`/affiliate-invite/${encodeURIComponent(code)}/signup`, {
      method: 'POST',
      body: JSON.stringify({ username, password, display_name, agreed: true }),
    });
    if (status === 200) return afterLogin(data);
    const msgs = { username_taken: t('err_username_taken'), bad_invite: t('err_invite_invalid'),
      expired: t('err_invite_expired'), must_agree: t('aff_must_agree'), missing_fields: t('fill_all_fields') };
    toast(msgs[data.error] || t('err_signup_failed'));
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
  if (S.user.role === 'admin') show('managerGate', {});
  else if (S.user.role === 'model') {
    await checkContractGate();
    show('modelChats', {});
  }
  else if (S.user.role === 'recruiter') show('recruiter', {});
  else show('fanModels', {});
  toast(t('welcome_user', { name: S.user.display_name }));
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

/* One-time congratulations for NEW models — fires after signup/login when
   the account has never been welcomed (users.welcomed_at). Existing models
   were backfilled server-side, so this only greets fresh signups. */
let welcomeShownThisSession = false;
function maybeShowModelWelcome() {
  if (welcomeShownThisSession) return;
  const u = S.user;
  if (!u || u.role !== 'model' || u.welcomed) return;
  if (['liveBroadcast', 'liveWatch'].includes(S.view)) return;
  welcomeShownThisSession = true;
  u.welcomed = true; // optimistic — server stamps it below
  api('/me/welcomed', { method: 'POST', body: JSON.stringify({}) }).catch(() => {});
  let el = document.getElementById('modelWelcome');
  if (!el) {
    el = document.createElement('div');
    el.id = 'modelWelcome';
    el.className = 'model-welcome';
    document.body.appendChild(el);
  }
  el.innerHTML = `
    <div class="mw-card">
      <img class="mw-lips" src="/img/lips-logo.png" alt="">
      <div class="mw-confetti">🎉 💋 🔥</div>
      <div class="mw-title">${t('wm_title', { name: esc(u.display_name) })}</div>
      <div class="mw-welcome">${t('wm_welcome')}</div>
      <p class="mw-body">${t('wm_body')}</p>
      <p class="mw-money">${t('wm_money')}</p>
      <div class="mw-steps-h">${t('wm_steps_h')}</div>
      <div class="mw-steps"><div>${t('wm_step1')}</div><div>${t('wm_step2')}</div><div>${t('wm_step3')}</div></div>
      <button class="btn mw-btn" id="mw-go">${t('wm_btn')}</button>
    </div>`;
  el.hidden = false;
  el.querySelector('#mw-go').onclick = () => { el.hidden = true; };
}

async function refreshMe() {
  const { status, data } = await api('/me');
  if (status === 200) {
    S.user = data.user; S.wallet = data.wallet; S.model = data.model || null;
    syncLangFromUser(data.user);
    maybeShowModelWelcome();
    if (data.commission_pct !== undefined) S.commissionPct = data.commission_pct;
  } else if (status === 401 || status === 403) {
    logout(false);
  }
}

function logout(msg) {
  if (S.token) api('/auth/logout', { method: 'POST' }).catch(() => {});
  S.token = null; S.user = null; S.wallet = null; S.model = null; S.previewFan = false;
  localStorage.removeItem('wc_token');
  if (S.ws) { try { S.ws.close(); } catch (e) {} S.ws = null; }
  show('landing', {});
  if (msg !== false) toast(t('logged_out'));
}

/* ---------------- FAN: models / chats / wallet ---------------- */

/* Model browsing the home screen: tap a sister's tile for her public card
   (status, home rank, rates) — look-only, no fan actions. */
function openModelPeek(m, models) {
  const featured = models.find((x) => x.is_featured);
  const rest = featured ? models.filter((x) => x.id !== featured.id) : models;
  const rankIdx = rest.findIndex((x) => x.id === m.id);
  const isMe = !!(S.user && S.user.id === m.id);
  const rankLine = m.is_featured
    ? '⭐ Featured — pinned at the top'
    : rankIdx === 0 ? '👑 #1 on the home screen'
    : rankIdx > 0 ? `#${rankIdx + 1} on the home screen` : '';
  const status = m.is_live
    ? `🔴 LIVE now — ${m.live_viewers || 0} watching`
    : m.is_online ? '🟢 Online now' : '⚫ Offline';
  ftSheet(`
    <div style="text-align:center">
      ${avatarHTML(m.display_name, 'xl', m.photo_url)}
      <div class="sheet-title" style="margin-top:8px">${esc(m.display_name)}${isMe ? ' (that\'s you! 💅)' : ''}</div>
      <div class="muted small">@${esc(m.username)}</div>
    </div>
    <div class="peek-rows">
      <div class="peek-row"><span>Status</span><b>${status}</b></div>
      ${rankLine ? `<div class="peek-row"><span>Home rank</span><b>${rankLine}</b></div>` : ''}
      <div class="peek-row"><span>Messages</span><b>${fmt(m.per_message_cents)} / msg</b></div>
      <div class="peek-row"><span>Video calls</span><b>${fmt(m.per_minute_cents)} / min</b></div>
      ${m.schedule_summary ? `<div class="peek-row"><span>Usually live</span><b>${esc(m.schedule_summary)}</b></div>` : ''}
    </div>
    ${m.bio ? `<div class="muted small" style="margin-top:10px">${esc(m.bio)}</div>` : ''}
    <button class="sheet-btn" style="margin-top:12px" onclick="document.getElementById('ft-sheet').remove()">Close</button>`);
}

async function vFanModels() {
  const { data } = await api('/models');
  const models = data.models || [];
  await refreshMe();
  const inPreview = isFanPreview();
  const isModelViewer = !!(S.user && (S.user.role === 'model' || inPreview));
  let following = [];
  if (!isModelViewer) {
    try { const f = await api('/follows'); following = f.data.following || []; } catch (e) {}
  }
  const isFanUser = !!(S.user && S.user.role === 'fan');
  app.innerHTML = `
    <div class="header"><div class="home-head-row"><h1>Slut<span class="logo">Camp</span></h1>
      ${isFanUser ? `<button class="btn small ghost home-logout-btn" id="home-logout">${t('log_out')}</button>` : ''}</div>
      <div>${inPreview
        ? '<span class="balance-pill">👁 Previewing as fan</span>'
        : isModelViewer
        ? '<span class="balance-pill">👀 Browsing the home screen</span>'
        : `<span class="balance-pill">💰 ${fmt(S.wallet ? S.wallet.credits_cents : 0)}</span>`}</div></div>
    <div class="screen">
      ${athCardHTML()}
      ${livesBtnHTML(models)}
      ${models.length ? homeTilesHTML(models, isModelViewer ? null : (m) => `
            <span class="follow-btn tile-heart ${following.includes(m.id) ? 'following' : ''}" data-follow="${m.id}" title="${t('follow_title')}">${following.includes(m.id) ? '❤️' : '🤍'}</span>`)
        : `<div class="empty"><div class="big">😴</div>${t('no_models')}</div>`}
    </div>`;
  wireAthCard();
  const lv = $('#go-lives');
  if (lv) lv.onclick = () => show('lives', {});
  const hlo = $('#home-logout');
  if (hlo) hlo.onclick = () => { if (confirm('Log out of SlutCamp?')) logout(); };
  app.querySelectorAll('[data-model]').forEach((b) => {
    b.onclick = () => {
      if (isModelViewer) {
        const m = models.find((x) => x.id === parseInt(b.dataset.model));
        if (m) openModelPeek(m, models);
        return;
      }
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
  const inPreview = isFanPreview();
  const { data } = await api('/live');
  const streams = data.live || [];
  // Preview: stream rows open the model's peek card instead of joining.
  let previewModels = [];
  if (inPreview) {
    try { const md = await api('/models'); previewModels = md.data.models || []; } catch (e) {}
  }
  const { data: schedData } = await api('/live/schedule');
  const upcoming = (schedData.upcoming || []).slice(0, 10);
  app.innerHTML = `
    <div class="header"><h1>${t('fanlive_h')}</h1>
      <div>${inPreview
        ? '<span class="balance-pill">👁 Previewing as fan</span>'
        : `<span class="balance-pill">💰 ${fmt(S.wallet ? S.wallet.credits_cents : 0)}</span>`}</div></div>
    <div class="screen">
      ${streams.map((s) => `
        <button class="list-item" data-stream="${s.session_id}" data-model="${s.model_id}" style="background:var(--card);border-radius:14px;margin-bottom:10px;border:1px solid rgba(239,68,68,.35)">
          <span class="avatar-wrap">${avatarHTML(s.model_name, '', s.model_photo_url)}<span class="online-dot"></span></span>
          <span class="grow">
            <span class="title">${esc(s.model_name)} <span class="live-badge">🔴 LIVE</span></span><br>
            ${s.title ? `<span class="preview" style="font-weight:700;color:#fff">${esc(s.title)}</span><br>` : ''}
            <span class="small muted">${t('watching_gifts', { v: s.viewers, g: fmt(s.gift_cents || 0) })}</span><br>
            <span class="small" style="color:#f87171;font-weight:800">${t('join_free_line')}</span>
          </span><span style="font-size:22px">›</span>
        </button>`).join('') || `
        <div class="empty"><div class="big">📺</div>${t('noone_live')}<br>
          <span class="small">${t('check_back')}</span></div>`}
      ${upcoming.length ? `
      <div style="font-weight:800;margin:18px 0 10px">${t('coming_up')}</div>
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
    b.onclick = () => {
      if (inPreview) {
        const m = previewModels.find((x) => x.id === parseInt(b.dataset.model));
        if (m) openModelPeek(m, previewModels);
        else toast('👁 Preview mode — joining a live is fan-only');
        return;
      }
      watchLive(parseInt(b.dataset.stream));
    };
  });
}

/* ---------------- LIVE NOW — promo-style grid of everyone live ----------------
   Live list + viewer counts come only from /api/models fields (is_live,
   live_session_id, live_viewers) — nothing here is faked. Tapping a live
   tile goes straight into her stream via watchLive(). */

async function vLives() {
  if (S.user && S.user.role === 'fan') await refreshMe();
  const { data } = await api('/models');
  const models = data.models || [];
  const live = models.filter((m) => m.is_live);
  const online = models.filter((m) => !m.is_live && m.is_online);
  const backView = S.user && (S.user.role === 'fan' || S.user.role === 'model' || isFanPreview()) ? 'fanModels' : 'landing';
  app.innerHTML = `
    <div class="header"><h1>${t('live_now_h')}</h1>
      ${S.user && S.user.role === 'fan'
        ? `<div><span class="balance-pill">💰 ${fmt(S.wallet ? S.wallet.credits_cents : 0)}</span></div>`
        : `<div class="sub">${t('live_now_sub')}</div>`}</div>
    <div class="screen">
      ${live.length ? `<div class="tile-grid">
        ${live.map((m) => modelTileHTML(m)).join('')}
      </div>` : `
        <div class="empty"><div class="big">💤</div>${t('nobody_live')}<br>
          <span class="small">${t('models_pop_in')}</span></div>`}
      ${online.length ? `
      <div style="font-weight:800;margin:18px 0 10px">${t('online_say_hi')}</div>
      <div class="tile-grid">
        ${online.map((m) => modelTileHTML(m)).join('')}
      </div>` : ''}
      <button class="btn ghost" id="lives-back" style="width:100%;margin-top:14px">${t('back_models')}</button>
    </div>`;
  app.querySelectorAll('[data-model]').forEach((b) => {
    b.onclick = () => {
      if ((S.user && S.user.role === 'model') || isFanPreview()) {
        const m = models.find((x) => x.id === parseInt(b.dataset.model));
        if (m) openModelPeek(m, models);
        return;
      }
      const liveId = b.dataset.live;
      if (liveId) return watchLive(parseInt(liveId));
      openChatWithModel(parseInt(b.dataset.model));
    };
  });
  $('#lives-back').onclick = () => show(backView, {});
}

async function vChatList(role) {
  const { data } = await api('/conversations');
  const convs = data.conversations || [];
  const title = role === 'model' ? t('your_chats') : t('chats_title');
  app.innerHTML = `
    <div class="header"><h1>${title}</h1>
      ${role === 'model' && S.model ? `
      <div class="row" style="margin-top:8px">
        <button class="toggle ${S.model.is_online ? 'on' : ''}" id="online-toggle" aria-label="Go online or offline"></button>
        <span style="font-weight:800;font-size:17px">${S.model.is_online ? t('online_caps') : t('offline_caps')}</span>
      </div>
      <button class="btn-live" id="go-live-btn">${t('go_live')}</button>
      <button class="btn ghost hidden" id="back-live-btn" style="margin-top:8px">${t('back_live')}</button>` : ''}
    </div>
    <div class="screen" style="padding:8px">
      ${convs.map((c) => `
        <button class="list-item" data-conv="${c.id}">
          ${avatarHTML(c.other.display_name, 'sm', c.other.photo_url)}
          <span class="grow">
            <span class="title">${esc(c.other.display_name)}
              ${c.is_paused ? ` <span class="small" style="color:var(--red)">${t('paused_tag')}</span>` : ''}</span><br>
            <span class="preview">${c.last_message ? esc(c.last_message.body).slice(0, 60) : `<i>${t('no_messages_yet')}</i>`}</span>
          </span>
          ${c.unread_count ? `<span class="unread-badge">${c.unread_count}</span>` : ''}
        </button>`).join('') || `<div class="empty"><div class="big">💬</div>${t('no_chats')}<br><span class="small">${t('tap_model_start')}</span></div>`}
    </div>`;
  const tgl = $('#online-toggle');
  if (tgl) tgl.onclick = async () => {
    const next = S.model.is_online ? 0 : 1;
    const { status } = await api('/model/profile', {
      method: 'PUT', body: JSON.stringify({ is_online: next }) });
    if (status === 200) { S.model.is_online = next; show('modelChats', {}); toast(next ? t('you_online') : t('you_offline')); }
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

/* ---------------- FAN: quick signup (username + payment, nothing else) ---------------- */

function vQuickSignup() {
  app.innerHTML = `
    <div class="header"><h1>Slut<span class="logo">Camp</span></h1>
      <div class="sub">${t('qs_sub')}</div></div>
    <div class="screen">
      <div class="card">
        <div style="font-weight:800;margin-bottom:10px">${t('your_account')}</div>
        <label class="field">${t('username')}<input class="input" id="q-user" autocomplete="username" placeholder="${t('pick_username_ph')}"></label>
        <label class="field">${t('password_hint')}${pwField('q-pass', 'new-password')}</label>
        <label class="checkbox-row"><input type="checkbox" id="q-18">
          <span>${t('confirm18')}</span></label>
        <div class="lang-row">${langPillsHTML()}</div>
      </div>
      <div class="card">
        <div style="font-weight:800;margin-bottom:10px">${t('payment_info')}</div>
        <div class="muted small" style="margin-bottom:10px">${t('payment_note')}</div>
        <label class="field">${t('full_name_card')}<input class="input" id="q-fullname" autocomplete="cc-name" placeholder="John Smith"></label>
        <label class="field">${t('payment_method')}</label>
        <div class="row" style="gap:8px;margin-bottom:12px" id="q-paymethods">
          <button class="btn ghost payopt selected" data-pay="card" style="flex:1">${t('card_word')}</button>
          <button class="btn ghost payopt" data-pay="cashapp" style="flex:1">💵 Cash App</button>
        </div>
        <div id="q-card-fields">
          <label class="field">${t('card_number')}<input class="input" id="q-cardnum" inputmode="numeric" autocomplete="cc-number" placeholder="4242 4242 4242 4242"></label>
          <div class="row" style="gap:8px">
            <label class="field" style="flex:1">${t('expiry')}<input class="input" id="q-exp" placeholder="MM/YY" autocomplete="cc-exp"></label>
            <label class="field" style="flex:1">CVC<input class="input" id="q-cvc" inputmode="numeric" placeholder="123" autocomplete="cc-csc"></label>
          </div>
        </div>
        <div id="q-cashapp-fields" class="hidden">
          <label class="field">Cash App $cashtag<input class="input" id="q-cashtag" placeholder="$yourtag"></label>
        </div>
      </div>
      <button class="btn" id="q-go" style="width:100%;margin-top:4px">${t('create_continue')}</button>
      <button class="btn ghost" id="q-back" style="width:100%;margin-top:8px">${t('back')}</button>
    </div>`;
  let payMethod = 'card';
  document.querySelectorAll('#q-paymethods .payopt').forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll('#q-paymethods .payopt').forEach((x) => x.classList.remove('selected'));
      b.classList.add('selected');
      payMethod = b.dataset.pay;
      $('#q-card-fields').classList.toggle('hidden', payMethod !== 'card');
      $('#q-cashapp-fields').classList.toggle('hidden', payMethod !== 'cashapp');
    };
  });
  $('#q-back').onclick = () => show('wallet', {});
  $('#q-go').onclick = () => doQuickSignup(payMethod);
}

async function doQuickSignup(payMethod) {
  const username = $('#q-user').value.trim();
  const password = $('#q-pass').value;
  const is18 = $('#q-18').checked;
  const fullName = $('#q-fullname').value.trim();
  if (!username) return toast('Pick a username');
  if (!password || password.length < 6) return toast('Password needs 6+ characters');
  if (!is18) return toast('You must confirm you are 18 or older');
  if (!fullName) return toast('Enter the full name on your payment method');
  if (payMethod === 'card') {
    if (!$('#q-cardnum').value.replace(/\s/g, '')) return toast('Enter your card number');
    if (!$('#q-exp').value.trim()) return toast('Enter card expiry');
    if (!$('#q-cvc').value.trim()) return toast('Enter card CVC');
  } else {
    if (!$('#q-cashtag').value.trim()) return toast('Enter your Cash App tag');
  }
  // Create the fan account (payment details are stored for checkout, not charged yet)
  const { status, data } = await api('/auth/quick-signup', {
    method: 'POST',
    body: JSON.stringify({
      username, password, full_name: fullName, pay_method: payMethod, agree18: is18,
      card_last4: payMethod === 'card' ? $('#q-cardnum').value.replace(/\s/g, '').slice(-4) : null,
      cashtag: payMethod === 'cashapp' ? $('#q-cashtag').value.trim() : null,
      guest_token: S.guestToken,
      language: LANG,
    }),
  });
  if (status === 200 && data.token) {
    S.token = data.token;
    localStorage.setItem('wc_token', data.token);
    await refreshMe();
    wsConnect();
    toast('✅ Account created!');
    return show('wallet', {});
  }
  toast(data.error === 'username_taken' ? 'That username is taken — try another' : 'Signup failed — try again');
}

async function vWallet() {
  // Guests can browse but must create an account to add money
  if (!S.token || !S.user || S.user.role !== 'fan') {
    app.innerHTML = `
      <div class="header"><h1>${t('wallet_h')}</h1></div>
      <div class="screen">
        <div class="card" style="text-align:center;padding:32px 20px">
          <div style="font-size:48px;margin-bottom:12px">💰</div>
          <div style="font-weight:800;font-size:18px;margin-bottom:8px">${t('guest_wallet_title')}</div>
          <div class="muted" style="margin-bottom:20px">${t('guest_wallet_sub')}</div>
          <button class="btn" id="w-signup" style="width:100%;margin-bottom:10px">${t('create_free_account')}</button>
          <button class="btn ghost" id="w-login" style="width:100%">${t('have_account_login')}</button>
        </div>
        ${langCardHTML()}
      </div>`;
    $('#w-signup').onclick = () => show('quickSignup', {});
    $('#w-login').onclick = () => show('auth', { mode: 'login', role: 'fan' });
    return;
  }
  await refreshMe();
  const { data } = await api('/credits/packages');
  const pkgs = data.packages || [];
  let ccbCfg = { configured: false, max_cents: 10000 };
  try { const cc = await api('/ccbill/config'); if (cc.data) ccbCfg = cc.data; } catch (e) {}
  const cardMax = Math.floor((ccbCfg.max_cents || 10000) / 100);
  const cardExtra = !ccbCfg.configured ? '' : `
      <div class="small muted" style="text-align:center;margin:0 0 10px">${t('ccbill_secure_note')}</div>
      ${cardMax > 100 ? `
      <button class="btn ghost" id="card-more-toggle" style="width:100%;margin-top:2px">➕ ${t('crypto_add_more')} <span id="cd-chev" style="display:inline-block;transition:transform .2s">›</span></button>
      <div id="card-more" style="display:none;margin:14px 0 6px">
        <div class="row" style="justify-content:center;gap:14px">
          <button class="btn small ghost" id="cd-minus" style="padding:8px 14px">−</button>
          <div style="text-align:center;min-width:110px">
            <div id="cd-amt" style="font-size:32px;font-weight:900;line-height:1">$${Math.min(250, cardMax)}</div>
            <div class="muted small" id="cd-credits">${Math.min(250, cardMax)} ${t('credits_word')}</div>
          </div>
          <button class="btn small ghost" id="cd-plus" style="padding:8px 14px">+</button>
        </div>
        <input type="range" id="cd-range" class="load-slider" min="100" max="${cardMax}" step="25" value="${Math.min(250, cardMax)}">
        <div class="row" style="justify-content:space-between"><span class="muted small">$100</span><span class="muted small">$${cardMax}</span></div>
        <button class="btn" id="cd-go" style="width:100%;margin-top:10px">${t('crypto_load')} $${Math.min(250, cardMax)}</button>
      </div>` : ''}`;
  app.innerHTML = `
    <div class="header"><h1>${t('wallet_h')}</h1>
      <div><span class="balance-pill">${t('balance', { amt: fmt(S.wallet.credits_cents) })}</span></div></div>
    <div class="screen">
      <div class="card" style="text-align:center">
        <div class="muted small">${t('credit_note')}</div>
      </div>
      ${pkgs.map((p) => `
        <button class="pkg" data-pkg="${p.id}">
          <span class="pkg-coin">🪙</span>
          <span class="amt">${p.credits_cents / 100} ${t('credits_word')}</span>
          <span class="price">${p.label}</span>
          ${p.descriptor ? `<span class="muted small" style="width:100%">${esc(p.descriptor)}</span>` : ''}
        </button>`).join('')}
      ${cardExtra}
      <div class="card" id="crypto-card">
        <div style="font-weight:800;font-size:17px;letter-spacing:.2px">${t('crypto_h')}</div>
        <div class="muted small" style="margin:4px 0 12px">${t('crypto_note')}</div>
        <div class="coin-grid" id="crypto-coins"></div>
        <div id="crypto-pkgs">
          ${pkgs.map((p) => `
          <button class="pkg" data-cpkg="${p.id}">
            <span class="pkg-coin">🪙</span>
            <span class="amt">${p.credits_cents / 100} ${t('credits_word')}</span>
            <span class="price">${p.label}</span>
          </button>`).join('')}
        </div>
        <button class="btn ghost" id="crypto-more-toggle" style="width:100%;margin-top:2px">➕ ${t('crypto_add_more')} <span id="cm-chev" style="display:inline-block;transition:transform .2s">›</span></button>
        <div id="crypto-more" style="display:none;margin-top:14px">
          <div class="row" style="justify-content:center;gap:14px">
            <button class="btn small ghost" id="cm-minus" style="padding:8px 14px">−</button>
            <div style="text-align:center;min-width:110px">
              <div id="cm-amt" style="font-size:32px;font-weight:900;line-height:1">$250</div>
              <div class="muted small" id="cm-credits">250 ${t('credits_word')}</div>
            </div>
            <button class="btn small ghost" id="cm-plus" style="padding:8px 14px">+</button>
          </div>
          <input type="range" id="cm-range" class="load-slider" min="100" max="1000" step="25" value="250">
          <div class="row" style="justify-content:space-between"><span class="muted small">$100</span><span class="muted small">$1,000</span></div>
          <button class="btn" id="cm-go" style="width:100%;margin-top:10px">${t('crypto_load')} $250</button>
        </div>
        <div id="crypto-invoice"></div>
        <div id="crypto-recent"></div>
      </div>
      <button class="btn ghost" id="w-ath" style="width:100%;margin-bottom:10px">${t('ath_wallet_row')}</button>
      <div id="pk-card"></div>
      <div id="pw-card"></div>
      ${langCardHTML()}
      <button class="btn ghost" id="w-logout">${t('log_out')}</button>
    </div>`;
  app.querySelectorAll('[data-pkg]').forEach((b) => {
    b.onclick = async () => {
      if (ccbCfg.configured) {
        const { status, data: d } = await api('/ccbill/checkout', {
          method: 'POST', body: JSON.stringify({ package_id: b.dataset.pkg }) });
        if (status === 200 && d.url) { toast(t('ccbill_redirect')); window.location.href = d.url; return; }
        toast((d && d.message) || t('crypto_failed'));
        return;
      }
      const { data: d } = await api('/credits/buy', {
        method: 'POST', body: JSON.stringify({ package: b.dataset.pkg }) });
      toast(d.message || 'Payment processor coming soon.');
    };
  });
  // Card "Add more" slider (appears once CCBill approves a cap above $100)
  const cdT = $('#card-more-toggle'), cdBox = $('#card-more');
  if (cdT && cdBox) {
    const range = $('#cd-range'), amtEl = $('#cd-amt'), credEl = $('#cd-credits'), go = $('#cd-go');
    const sync = () => {
      const v = Number(range.value);
      amtEl.textContent = '$' + v;
      credEl.textContent = v + ' ' + t('credits_word');
      go.textContent = t('crypto_load') + ' $' + v;
    };
    cdT.onclick = () => {
      const opening = cdBox.style.display === 'none';
      cdBox.style.display = opening ? '' : 'none';
      const ch = $('#cd-chev'); if (ch) ch.style.transform = opening ? 'rotate(90deg)' : '';
      if (opening) sync();
    };
    range.oninput = sync;
    $('#cd-minus').onclick = () => { range.value = Math.max(100, Number(range.value) - 25); sync(); };
    $('#cd-plus').onclick = () => { range.value = Math.min(cardMax, Number(range.value) + 25); sync(); };
    go.onclick = async () => {
      const { status, data: d } = await api('/ccbill/checkout', {
        method: 'POST', body: JSON.stringify({ amount_cents: Number(range.value) * 100 }) });
      if (status === 200 && d.url) { toast(t('ccbill_redirect')); window.location.href = d.url; return; }
      toast((d && d.message) || t('crypto_failed'));
    };
    sync();
  }
  // Crypto loads (single-screen flow: coin -> package -> pay screen)
  stopCryptoTimers();
  // Coin chips render from the live /crypto/config — only coins whose receiving
  // is actually set up appear (unconfigured coins like XRP never render).
  (async () => {
    const grid = $('#crypto-coins');
    if (!grid) return;
    const META = {
      USDT: { g: '₮', label: 'USDT', color: '#2bb673' },
      BTC: { g: '₿', label: 'Bitcoin', color: '#f7931a' },
      ETH: { g: 'Ξ', label: 'Ethereum', color: '#a9b7f0' },
      SOL: { g: '◎', label: 'Solana', color: '#14f195' },
      XRP: { g: '✕', label: 'XRP', color: '#c0c6ce' },
    };
    const { data: cfg } = await api('/crypto/config');
    const coins = ((cfg && cfg.coins) || []).map((c) => c.coin).filter((c) => META[c]);
    if (!coins.length) { const card = $('#crypto-card'); if (card) card.style.display = 'none'; return; }
    if (!coins.includes(cryptoCoinSel)) cryptoCoinSel = coins[0];
    if (coins.length < 4) grid.style.gridTemplateColumns = `repeat(${coins.length}, 1fr)`;
    grid.innerHTML = coins.map((c) => `
      <button class="coin-chip${c === cryptoCoinSel ? ' on' : ''}" data-coin="${c}">
        <span class="cs" style="color:${META[c].color}">${META[c].g}</span>
        <span class="cl">${META[c].label}</span>
      </button>`).join('');
    grid.querySelectorAll('[data-coin]').forEach((b) => {
      b.onclick = () => {
        if (b.dataset.coin === cryptoCoinSel) return;
        cryptoCoinSel = b.dataset.coin;
        syncCoinChips();
        // A pay screen is open: rebuild it for the new coin (same package) so
        // the QR a fan scans always matches the coin highlighted above it.
        if ($('#ci-status')) {
          if (cryptoOpenAmt) startCryptoInvoiceCustom(cryptoOpenAmt);
          else if (cryptoOpenPkg && cryptoOpenPkg !== 'custom') startCryptoInvoice(cryptoOpenPkg);
        }
      };
    });
  })();
  app.querySelectorAll('[data-cpkg]').forEach((b) => {
    b.onclick = () => startCryptoInvoice(b.dataset.cpkg);
  });
  // "Add more" slider: custom loads from $100 to $1,000 in $25 steps.
  const cmT = $('#crypto-more-toggle'), cmBox = $('#crypto-more');
  if (cmT && cmBox) {
    const range = $('#cm-range'), amtEl = $('#cm-amt'), credEl = $('#cm-credits'), go = $('#cm-go');
    const sync = () => {
      const v = Number(range.value);
      amtEl.textContent = '$' + v;
      credEl.textContent = v + ' ' + t('credits_word');
      go.textContent = t('crypto_load') + ' $' + v;
    };
    cmT.onclick = () => {
      const opening = cmBox.style.display === 'none';
      cmBox.style.display = opening ? '' : 'none';
      const ch = $('#cm-chev'); if (ch) ch.style.transform = opening ? 'rotate(90deg)' : '';
      if (opening) sync();
    };
    range.oninput = sync;
    $('#cm-minus').onclick = () => { range.value = Math.max(100, Number(range.value) - 25); sync(); };
    $('#cm-plus').onclick = () => { range.value = Math.min(1000, Number(range.value) + 25); sync(); };
    go.onclick = () => startCryptoInvoiceCustom(Number(range.value) * 100);
    sync();
  }
  loadCryptoRecent();
  // Arrived from a wallet app (the Phantom button) to pay one specific
  // invoice: open THAT pay screen — inside the wallet's browser its own
  // Connect & pay button completes the payment with that wallet.
  if (window.__payInvoice) {
    const pid = window.__payInvoice;
    window.__payInvoice = null;
    try { localStorage.removeItem('sc_pay_invoice'); } catch (e) {}
    (async () => {
      const { status, data } = await api('/crypto/invoices/' + pid);
      if (status === 200 && data.invoice &&
          (data.invoice.status === 'pending' || data.invoice.status === 'confirming')) {
        renderCryptoInvoice(data.invoice);
        watchCryptoInvoice(data.invoice.id);
      }
    })();
  }
  const wth = $('#w-ath');
  if (wth) wth.onclick = openAthSheet;
  renderPkSettingsCard();
  renderPwSettingsCard();
  $('#w-logout').onclick = () => logout();
}

/* ---------------- CRYPTO LOADS (fan) ---------------- */
let cryptoCoinSel = 'USDT';
let cryptoOpenPkg = null;
let cryptoOpenAmt = null;
let cryptoTimers = [];

function syncCoinChips() {
  const grid = $('#crypto-coins');
  if (!grid) return;
  grid.querySelectorAll('[data-coin]').forEach((x) => x.classList.toggle('on', x.dataset.coin === cryptoCoinSel));
}
let cryptoExpiresAt = 0;

function stopCryptoTimers() { cryptoTimers.forEach(clearInterval); cryptoTimers = []; }

function cryptoStatusText(inv) {
  const m = inv.required_confirmations || 1;
  const n = inv.confirmations || 0;
  if (inv.status === 'credited') return t('crypto_credited');
  if (inv.status === 'credited_partial') return t('crypto_credited_partial', { amt: String(Math.round(inv.credited_cents) / 100) });
  if (inv.status === 'expired') return t('crypto_expired');
  if (inv.status === 'underpaid') return t('crypto_underpaid');
  if ((inv.received_units || 0) > 0) return n > 0 ? t('crypto_confirming', { n, m }) : t('crypto_detected', { n, m });
  return t('crypto_waiting');
}

const USDT_CONTRACT_CLIENT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';

// Named wallet-app buttons. Fans tap the wallet they actually have instead
// of one generic link whose coin URI may have no handler on their device
// (USDT's EIP-681 contract-call form and bitcoin: often claim nothing).
function metamaskHref(inv) {
  if (inv.coin === 'USDT') return `https://metamask.app.link/send/${USDT_CONTRACT_CLIENT}@1/transfer?address=${inv.address}&uint256=${inv.amount_units}`;
  if (inv.coin === 'ETH') {
    const wei = (BigInt(Math.trunc(inv.amount_units)) * 1000000000n).toString();
    return `https://metamask.app.link/send/${inv.address}?value=${wei}`;
  }
  return null;
}

// Trust Wallet's documented payment-link format (SLIP-44 coin ids; the fan's
// own wallet choice — platform funds never touch it).
function trustHref(inv) {
  const slip = { BTC: 0, ETH: 60, SOL: 501 }[inv.coin];
  if (inv.coin === 'USDT') return `https://link.trustwallet.com/send?coin=60&token_id=${USDT_CONTRACT_CLIENT}&address=${encodeURIComponent(inv.address)}&amount=${inv.amount_crypto}`;
  if (slip === undefined) return null;
  return `https://link.trustwallet.com/send?coin=${slip}&address=${encodeURIComponent(inv.address)}&amount=${inv.amount_crypto}`;
}

/* Phantom deep-link payments (SOL). Phantom publishes NO plain payment
   link: the coin URI schemes go to whichever wallet registered them
   (Coinbase on most iPhones), and its phantom.app/ul "browse" link dead-ends
   on an App Store page from our context (Corry's test, Oct 14). The one real
   door is Phantom's documented deep-link protocol — connect, then
   signAndSendTransaction, X25519-encrypted payloads over phantom.app/ul/v1
   redirects. Solana-scoped by design; other coins simply have no Phantom
   door from a web page. The server's on-chain watcher credits by amount no
   matter how the fan gets back, so a lost return redirect never loses a
   completed payment — the return handling is confirmation UX only. */
const B58_ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58encode(bytes) {
  if (!bytes.length) return '';
  let zeros = 0; while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits = [0];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let k = 0; k < digits.length; k++) { carry += digits[k] << 8; digits[k] = carry % 58; carry = (carry / 58) | 0; }
    while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += B58_ALPHA[digits[i]];
  return out;
}
function b58decode(str) {
  if (!str) return new Uint8Array(0);
  let zeros = 0; while (zeros < str.length && str[zeros] === '1') zeros++;
  const bytes = [0];
  for (let i = zeros; i < str.length; i++) {
    const idx = B58_ALPHA.indexOf(str[i]);
    if (idx < 0) return new Uint8Array(0);
    let carry = idx;
    for (let k = 0; k < bytes.length; k++) { carry += bytes[k] * 58; bytes[k] = carry & 0xff; carry >>= 8; }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[zeros + i] = bytes[bytes.length - 1 - i];
  return out;
}
let naclLoadPromise = null;
function loadNacl() {
  if (typeof nacl !== 'undefined') return Promise.resolve(true);
  if (!naclLoadPromise) {
    naclLoadPromise = new Promise((resolve) => {
      const sc = document.createElement('script');
      sc.src = 'https://cdn.jsdelivr.net/npm/tweetnacl@1.0.3/nacl-fast.min.js';
      sc.onload = () => resolve(typeof nacl !== 'undefined');
      sc.onerror = () => resolve(false);
      document.head.appendChild(sc);
    });
  }
  return naclLoadPromise;
}
function phStore() { try { return JSON.parse(localStorage.getItem('sc_ph_dapp') || '{}'); } catch (e) { return {}; } }
function phSave(o) { try { localStorage.setItem('sc_ph_dapp', JSON.stringify(o)); } catch (e) {} }

async function phantomPaySOL(inv) {
  if (!(await loadNacl())) { toast(t('crypto_failed')); return; }
  try { localStorage.setItem('sc_pay_invoice', String(inv.id)); } catch (e) {}
  let st = phStore();
  if (!st.secret) {
    const kp = nacl.box.keyPair();
    st = { secret: b58encode(kp.secretKey), pub: b58encode(kp.publicKey) };
    phSave(st);
  }
  if (!st.session || !st.walletPub || !st.shared) { phantomConnectRedirect(); return; }
  phantomSendRedirect(inv, st);
}
function phantomConnectRedirect() {
  const st = phStore();
  const origin = window.location.origin;
  const q = new URLSearchParams({
    app_url: origin,
    dapp_encryption_public_key: st.pub,
    redirect_link: origin + '/?phantom=connect',
    cluster: 'mainnet-beta',
  });
  window.location.href = 'https://phantom.app/ul/v1/connect?' + q.toString();
}
async function phantomSendRedirect(inv, st) {
  if (!(await loadSolanaWeb3())) { toast(t('crypto_failed')); return; }
  try {
    const conn = new solanaWeb3.Connection('https://api.mainnet-beta.solana.com', 'confirmed');
    const fromPub = new solanaWeb3.PublicKey(st.walletPub);
    const tx = new solanaWeb3.Transaction().add(solanaWeb3.SystemProgram.transfer({
      fromPubkey: fromPub, toPubkey: new solanaWeb3.PublicKey(inv.address),
      lamports: Math.trunc(inv.amount_units) }));
    const { blockhash } = await conn.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash; tx.feePayer = fromPub;
    const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    const payload = { session: st.session, transaction: b58encode(serialized) };
    const nonce = nacl.randomBytes(24);
    const encrypted = nacl.box.after(new TextEncoder().encode(JSON.stringify(payload)), nonce, b58decode(st.shared));
    const origin = window.location.origin;
    const q = new URLSearchParams({
      dapp_encryption_public_key: st.pub,
      nonce: b58encode(nonce),
      redirect_link: origin + '/?phantom=sent',
      payload: b58encode(encrypted),
    });
    window.location.href = 'https://phantom.app/ul/v1/signAndSendTransaction?' + q.toString();
  } catch (e) { toast(t('crypto_failed')); }
}
// Boot-time: consume Phantom's redirect returns. True = this URL was one.
async function phantomHandleReturn(qs) {
  const kind = qs.get('phantom');
  if (kind !== 'connect' && kind !== 'sent') return false;
  try {
    const invId = localStorage.getItem('sc_pay_invoice');
    if (invId && /^\d+$/.test(invId)) window.__payInvoice = parseInt(invId, 10);
    if (qs.get('errorCode')) { toast(t('crypto_phantom_fail')); return true; }
    if (!(await loadNacl())) return true;
    const st = phStore();
    if (!st.secret) return true; // keys lost across the switch — watcher still credits any send
    const nonce = b58decode(qs.get('nonce') || '');
    const data = b58decode(qs.get('data') || '');
    if (kind === 'connect') {
      const phantomPub = b58decode(qs.get('phantom_encryption_public_key') || '');
      if (!phantomPub.length || !data.length) return true;
      const shared = nacl.box.before(phantomPub, b58decode(st.secret));
      const opened = nacl.box.open.after(data, nonce, shared);
      if (!opened) return true;
      const info = JSON.parse(new TextDecoder().decode(opened));
      const st2 = { ...st, shared: b58encode(shared), session: info.session, walletPub: info.public_key };
      phSave(st2);
      // Continue straight into the payment the fan came for.
      if (window.__payInvoice) {
        const { status, data: d } = await api('/crypto/invoices/' + window.__payInvoice);
        if (status === 200 && d.invoice && d.invoice.status === 'pending') phantomSendRedirect(d.invoice, st2);
      }
      return true;
    }
    // kind === 'sent'
    if (st.shared && data.length) {
      const opened = nacl.box.open.after(data, nonce, b58decode(st.shared));
      if (opened) toast(t('crypto_sent'));
    } else toast(t('crypto_sent'));
    return true;
  } catch (e) { return true; }
}
function inWalletBrowser(inv) {
  // Already inside a wallet's own browser/extension: the app buttons would
  // bounce the fan around (or loop) — Connect pays right here instead.
  if (inv.coin === 'ETH' || inv.coin === 'USDT') return typeof window !== 'undefined' && !!window.ethereum;
  if (inv.coin === 'SOL') return typeof window !== 'undefined' && !!((window.phantom && window.phantom.solana) || window.solana);
  return false;
}

function wbtn(href, label) {
  return `<a class="btn small ghost wbtn" href="${href}" target="_blank" rel="noopener" style="text-decoration:none;display:flex;align-items:center;justify-content:center">${label}</a>`;
}

// MetaMask publishes no Solana send link, but its /dapp/ universal link is
// real: it opens MetaMask's own browser on our pay screen (the pay_invoice
// flag reopens this exact invoice; MetaMask's provider then powers Connect).
function mmDappHref(inv) {
  return `https://metamask.app.link/dapp/${window.location.host}/?pay_invoice=${inv.id}`;
}

function walletButtonsHtml(inv) {
  const btns = [];
  const mm = metamaskHref(inv);
  if (mm) btns.push(wbtn(mm, '🦊 MetaMask'));
  if (inv.coin === 'SOL') {
    btns.push(wbtn(mmDappHref(inv), '🦊 MetaMask'));
    btns.push('<button class="btn small ghost wbtn" id="ci-phantom" style="width:100%">👻 Phantom</button>');
  }
  if (inv.coin === 'BTC') {
    // MetaMask carries Bitcoin accounts but publishes no BTC send link; the
    // /dapp/ link opens the real app on this invoice like it does for SOL.
    btns.push(wbtn(mmDappHref(inv), '🦊 MetaMask'));
  }
  btns.push(wbtn(esc(inv.payment_uri), '🔵 Coinbase Wallet'));
  const tw = trustHref(inv);
  if (tw) btns.push(wbtn(tw, '🛡️ Trust Wallet'));
  return btns.join('');
}

let solWeb3LoadPromise = null;
function loadSolanaWeb3() {
  if (typeof solanaWeb3 !== 'undefined') return Promise.resolve(true);
  if (!solWeb3LoadPromise) {
    solWeb3LoadPromise = new Promise((resolve) => {
      const sc = document.createElement('script');
      sc.src = 'https://cdn.jsdelivr.net/npm/@solana/web3.js@1.95.3/lib/index.iife.min.js';
      sc.onload = () => resolve(typeof solanaWeb3 !== 'undefined');
      sc.onerror = () => resolve(false);
      document.head.appendChild(sc);
    });
  }
  return solWeb3LoadPromise;
}

// Connect-and-pay through the wallet the fan already has in this browser
// (MetaMask / Coinbase Wallet extension, Phantom). The server watches the
// receiving address, so a send from any wallet credits exactly the same way.
async function payWithConnectedWallet(inv) {
  try {
    if (inv.coin === 'ETH' || inv.coin === 'USDT') {
      const provider = window.ethereum;
      if (!provider) { toast(t('crypto_no_wallet')); return; }
      const accounts = await provider.request({ method: 'eth_requestAccounts' });
      const from = accounts && accounts[0];
      if (!from) { toast(t('crypto_no_wallet')); return; }
      let tx;
      if (inv.coin === 'ETH') {
        const wei = BigInt(Math.trunc(inv.amount_units)) * 1000000000n;
        tx = { from, to: inv.address, value: '0x' + wei.toString(16) };
      } else {
        const data = '0xa9059cbb' +
          inv.address.slice(2).padStart(64, '0') +
          BigInt(Math.trunc(inv.amount_units)).toString(16).padStart(64, '0');
        tx = { from, to: USDT_CONTRACT_CLIENT, data };
      }
      await provider.request({ method: 'eth_sendTransaction', params: [tx] });
      toast(t('crypto_sent'));
    } else if (inv.coin === 'SOL') {
      const provider = (window.phantom && window.phantom.solana) || window.solana;
      if (!provider) { toast(t('crypto_no_wallet')); return; }
      if (!(await loadSolanaWeb3())) { toast(t('crypto_no_wallet')); return; }
      const resp = await provider.connect();
      const fromPub = (resp && resp.publicKey) || provider.publicKey;
      const conn = new solanaWeb3.Connection('https://api.mainnet-beta.solana.com', 'confirmed');
      const tx = new solanaWeb3.Transaction().add(solanaWeb3.SystemProgram.transfer({
        fromPubkey: fromPub, toPubkey: new solanaWeb3.PublicKey(inv.address),
        lamports: Math.trunc(inv.amount_units),
      }));
      const { blockhash } = await conn.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash; tx.feePayer = fromPub;
      if (provider.signAndSendTransaction) await provider.signAndSendTransaction(tx);
      else { const signed = await provider.signTransaction(tx); await conn.sendRawTransaction(signed.serialize()); }
      toast(t('crypto_sent'));
    }
  } catch (e) { /* declined in the wallet — QR / copy / deep-link paths remain */ }
}

function renderCryptoInvoice(inv) {
  const box = $('#crypto-invoice');
  if (!box) return;
  cryptoCoinSel = inv.coin;
  cryptoOpenPkg = inv.package_id;
  cryptoOpenAmt = inv.package_id === 'custom' ? inv.package_usd_cents : null;
  syncCoinChips();
  cryptoExpiresAt = Date.parse(String(inv.expires_at).replace(' ', 'T') + 'Z') || 0;
  const left = Math.max(0, Math.round((cryptoExpiresAt - Date.now()) / 1000));
  const mm = String(Math.floor(left / 60)).padStart(2, '0');
  const ss = String(left % 60).padStart(2, '0');
  const terminal = ['credited', 'credited_partial', 'expired', 'underpaid'].includes(inv.status);
  box.innerHTML = `
    <div style="text-align:center;padding-top:8px;border-top:1px solid rgba(255,255,255,.08);margin-top:6px">
      <div class="muted small">${t('crypto_scan')}</div>
      <div style="background:#fff;border-radius:14px;padding:10px;width:min(252px,100%);box-sizing:border-box;margin:10px auto;line-height:0">${inv.qr_svg || ''}</div>
      <div class="muted small">${t('crypto_send_exact')}</div>
      <div style="font-size:clamp(21px,6.4vw,30px);font-weight:900;letter-spacing:-.3px;padding:0 4px">${inv.amount_crypto} ${inv.coin}</div>
      <div class="muted small" style="margin-bottom:8px">≈ ${fmt(inv.package_usd_cents)} USD</div>
      ${inv.coin === 'SOL' ? `<div class="small" style="color:var(--gold);margin:0 auto 8px;max-width:300px">${t('crypto_exact_note')}</div>` : ''}
      <div class="muted small">${t('crypto_to')}</div>
      <div style="font-family:monospace;font-size:12px;word-break:break-all;background:rgba(0,0,0,.25);border-radius:8px;padding:8px">${esc(inv.address)}</div>
      ${inv.shared_address ? `<div class="muted small" style="margin:6px auto 0;max-width:300px">${t('crypto_shared_note')}</div>` : ''}
      ${inv.dest_tag ? `
      <div style="margin-top:12px">
        <div class="small" style="color:var(--gold);font-weight:800">${t('crypto_dest_tag')}</div>
        <div style="font-size:30px;font-weight:900;letter-spacing:2px">${inv.dest_tag}</div>
        <div class="small" style="color:var(--gold);margin:2px auto 0;max-width:300px">${t('crypto_tag_note')}</div>
        <button class="btn small ghost" id="ci-copy-tag" style="margin-top:6px">📋 ${t('crypto_copy')} tag</button>
      </div>` : ''}
      <div style="margin-top:14px">
        <div class="muted small" style="font-weight:700;margin-bottom:8px">👛 ${t('crypto_pay_with')}</div>
        <button class="btn" id="ci-connect" style="display:none;width:100%;margin-bottom:8px">🔗 ${t('crypto_connect_pay')}</button>
        ${inWalletBrowser(inv)
          ? `<div class="muted small">${t('crypto_in_wallet')}</div>`
          : `<div class="wallet-grid">${walletButtonsHtml(inv)}</div>`}
      </div>
      <div class="row" style="gap:8px;margin-top:8px;flex-wrap:wrap">
        <button class="btn small ghost grow" id="ci-copy">📋 ${t('crypto_copy')}</button>
      </div>
      <div id="ci-status" style="margin-top:12px;font-weight:700">${cryptoStatusText(inv)}</div>
      ${terminal ? '' : `<div id="ci-count" class="muted small" style="margin-top:4px">${t('crypto_time_left', { t: mm + ':' + ss })}</div>`}
      ${inv.status === 'expired' ? `<button class="btn" id="ci-newquote" style="width:100%;margin-top:10px">${t('crypto_new_quote')}</button>` : ''}
      ${inv.address_placeholder ? `<div class="small" style="color:var(--gold);margin-top:8px">⚠ Test address — crypto is in setup mode</div>` : ''}
    </div>`;
  const cn = $('#ci-connect');
  if (cn) {
    const isEvm = inv.coin === 'ETH' || inv.coin === 'USDT';
    const hasProvider = (isEvm && typeof window !== 'undefined' && !!window.ethereum) ||
      (inv.coin === 'SOL' && typeof window !== 'undefined' && !!((window.phantom && window.phantom.solana) || window.solana));
    if (hasProvider) { cn.style.display = ''; cn.onclick = () => payWithConnectedWallet(inv); }
  }
  const ph = $('#ci-phantom');
  if (ph) ph.onclick = () => phantomPaySOL(inv);
  const cp = $('#ci-copy');
  if (cp) cp.onclick = async () => {
    try { await navigator.clipboard.writeText(inv.address); toast(t('crypto_copied')); }
    catch (e) { toast(inv.address); }
  };
  const cpt = $('#ci-copy-tag');
  if (cpt) cpt.onclick = async () => {
    try { await navigator.clipboard.writeText(String(inv.dest_tag)); toast(t('crypto_copied')); }
    catch (e) { toast(String(inv.dest_tag)); }
  };
  const nq = $('#ci-newquote');
  if (nq) nq.onclick = () => { if (inv.package_id === 'custom') startCryptoInvoiceCustom(inv.package_usd_cents); else startCryptoInvoice(inv.package_id); };
}

function watchCryptoInvoice(id) {
  stopCryptoTimers();
  const tick = async () => {
    if (!$('#crypto-invoice')) { stopCryptoTimers(); return; }
    const { status, data } = await api('/crypto/invoices/' + id);
    if (status !== 200 || !data.invoice) return;
    renderCryptoInvoice(data.invoice);
    if (data.invoice.status === 'credited' || data.invoice.status === 'credited_partial') {
      stopCryptoTimers();
      toast(cryptoStatusText(data.invoice));
      refreshMe();
      setTimeout(() => { if ($('#crypto-invoice')) show('wallet', {}); }, 3500);
    } else if (data.invoice.status === 'expired' || data.invoice.status === 'underpaid') {
      stopCryptoTimers();
    }
  };
  cryptoTimers.push(setInterval(tick, 8000));
  cryptoTimers.push(setInterval(() => {
    const el = $('#ci-count');
    if (!el || !cryptoExpiresAt) return;
    const left = Math.max(0, Math.round((cryptoExpiresAt - Date.now()) / 1000));
    el.textContent = t('crypto_time_left', { t: String(Math.floor(left / 60)).padStart(2, '0') + ':' + String(left % 60).padStart(2, '0') });
    if (left <= 0) tick();
  }, 1000));
}

async function startCryptoInvoice(packageId) {
  const box = $('#crypto-invoice');
  if (!box) return;
  stopCryptoTimers();
  box.innerHTML = `<div class="muted small" style="text-align:center;padding:12px">…</div>`;
  const { status, data } = await api('/crypto/invoices', {
    method: 'POST', body: JSON.stringify({ package_id: packageId, coin: cryptoCoinSel }) });
  if (status !== 201 || !data.invoice) { toast(t('crypto_failed')); box.innerHTML = ''; return; }
  renderCryptoInvoice(data.invoice);
  watchCryptoInvoice(data.invoice.id);
  loadCryptoRecent();
}

async function startCryptoInvoiceCustom(amountCents) {
  const box = $('#crypto-invoice');
  if (!box) return;
  stopCryptoTimers();
  box.innerHTML = `<div class="muted small" style="text-align:center;padding:12px">…</div>`;
  const { status, data } = await api('/crypto/invoices', {
    method: 'POST', body: JSON.stringify({ amount_cents: amountCents, coin: cryptoCoinSel }) });
  if (status !== 201 || !data.invoice) { toast(t('crypto_failed')); box.innerHTML = ''; return; }
  renderCryptoInvoice(data.invoice);
  watchCryptoInvoice(data.invoice.id);
  loadCryptoRecent();
}

async function loadCryptoRecent() {
  const box = $('#crypto-recent');
  if (!box) return;
  const { status, data } = await api('/crypto/invoices');
  if (status !== 200 || !data.invoices) return;
  const rows = data.invoices;
  if (!rows.length) { box.innerHTML = ''; return; }
  box.innerHTML = `
    <div class="muted small" style="margin:14px 0 6px;font-weight:700">${t('crypto_recent')}</div>
    ${rows.slice(0, 5).map((inv) => `
      <div class="row small" style="padding:6px 0;border-top:1px solid rgba(255,255,255,.06);flex-wrap:wrap;row-gap:2px">
        <span class="grow">${({ BTC: '₿', USDT: '💵', ETH: 'Ξ', SOL: '◎', XRP: '✕' })[inv.coin] || '🪙'} ${inv.amount_crypto} ${inv.coin} <span class="muted">· ${fmt(inv.package_usd_cents)}</span></span>
        <span class="muted">${t('crypto_status_' + inv.status)}</span>
      </div>`).join('')}`;
  // If the newest invoice is still open, reopen its pay screen so the fan never loses it.
  const open = rows.find((inv) => (inv.status === 'pending' || inv.status === 'confirming') && inv.seconds_left > 0);
  if (open && !$('#ci-status')) {
    const { data: d2 } = await api('/crypto/invoices/' + open.id);
    if (d2 && d2.invoice) { renderCryptoInvoice(d2.invoice); watchCryptoInvoice(d2.invoice.id); }
  }
}

/* ---------------- MODEL: earnings / settings ---------------- */

async function loadFanClub(period) {
  const box = $('#fan-club-body');
  if (!box) return;
  document.querySelectorAll('[data-fc]').forEach((b) => {
    const on = b.dataset.fc === period;
    b.style.background = on ? 'var(--pink)' : '';
    b.style.color = on ? '#fff' : '';
    b.style.borderColor = on ? 'var(--pink)' : '';
  });
  const { data } = await api('/model/fan-club?period=' + period);
  if (!data || !$('#fan-club-body')) return;
  const medal = ['🥇', '🥈', '🥉'];
  box.innerHTML = (data.buyers || []).length ? data.buyers.map((r, i) => {
    const parts = [];
    if (r.live_cents > 0) parts.push(`🔴 ${t('fc_live')} ${fmt(r.live_cents)}`);
    if (r.priv_cents > 0) parts.push(`📅 ${t('fc_1on1')} ${fmt(r.priv_cents)}`);
    if (r.chat_cents > 0) parts.push(`💬 ${t('fc_chat')} ${fmt(r.chat_cents)}`);
    return `
    <div class="row" style="padding:9px 0;border-top:1px solid rgba(139,92,246,.1);align-items:center">
      <span style="font-size:19px;width:32px;text-align:center;flex:none">${medal[i] || (i + 1)}</span>
      ${avatarHTML(r.fan_name, 'sm')}
      <span class="grow" style="margin-left:8px"><b>${esc(r.fan_name)}</b>
        <br><span class="muted small">${parts.join(' · ')} · ${t(r.payments === 1 ? 'payment_1' : 'payment_n', { n: r.payments })}</span></span>
      <b style="color:var(--green)">${fmt(r.total_cents)}</b>
    </div>`;
  }).join('') : `<div class="muted">${t('fc_empty')}</div>`;
}

async function vModelEarnings() {
  const { data } = await api('/model/earnings');
  const { data: acctData } = await api('/model/payout-account');
  const { data: wdData } = await api('/model/withdrawals');
  const acct = acctData.account;
  const wds = wdData.withdrawals || [];
  const wdBadge = (s) => s === 'pending' ? t('wd_pending') : s === 'paid' ? t('wd_paid') : t('wd_rejected');
  app.innerHTML = `
    <div class="header"><h1>${t('earnings_h')}</h1><div class="sub">${t('you_keep', { pct: 100 - (S.commissionPct || 40) })}</div></div>
    <div class="screen">
      <div class="stat-grid">
        <div class="stat"><div class="n" style="color:var(--green)">${fmt(data.pending_cents)}</div><div class="l">${t('avail_payout')}</div></div>
        <div class="stat"><div class="n">${fmt(data.earnings_cents)}</div><div class="l">${t('total_earned')}</div></div>
      </div>
      ${data.gift_count ? `
      <div class="card" style="margin-top:12px">
        <div style="font-weight:800;margin-bottom:8px">${t('gifts_received')}</div>
        <div class="row"><span class="grow muted small">${t(data.gift_count === 1 ? 'gifts_from_fans_1' : 'gifts_from_fans_n', { n: data.gift_count })}</span>
          <b style="color:var(--green)">${fmt(data.gifts_cents)}</b></div>
        <div class="muted small" style="margin-top:4px">${t('gifts_cut_note')}</div>
      </div>` : ''}
      <div class="card" style="margin-top:12px">
        <div style="font-weight:800;margin-bottom:8px">${t('revenue_breakdown')}</div>
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
            <span class="grow"><b>${t('gifts_word')}</b></span><b style="color:var(--green)">${fmt(gifts)}</b>
          </div>
          <div class="row" style="padding:10px;background:rgba(236,72,153,.1);border-radius:10px;margin-bottom:8px">
            <span class="grow"><b>${t('lives_word')}</b> <span class="muted small">${t('rb_lives_sub')}</span></span><b style="color:var(--green)">${fmt(lives)}</b>
          </div>
          <div class="row" style="padding:10px;background:rgba(59,130,246,.1);border-radius:10px;margin-bottom:12px">
            <span class="grow"><b>${t('rb_dms')}</b> <span class="muted small">${t('rb_dms_sub')}</span></span><b style="color:var(--green)">${fmt(dms)}</b>
          </div>`;
        })()}
        <div style="font-weight:700;margin:8px 0 4px" class="small muted">${t('all_activity')}</div>
        ${(data.by_type || []).map((r) => {
          const labels = { message: t('ty_message'), call: t('ty_call'), tip: t('ty_tip'),
            ppv: t('ty_ppv'), voice: t('ty_voice'), live_explicit: t('ty_live_explicit'), gift: t('ty_gift') };
          return `
          <div class="row" style="padding:8px 0;border-top:1px solid rgba(139,92,246,.1)">
            <span class="grow"><b>${labels[r.type] || esc(r.type)}</b> <span class="muted small">· ${t(r.n === 1 ? 'payment_1' : 'payment_n', { n: r.n })}</span></span>
            <b style="color:var(--green)">${fmt(r.earned_cents)}</b>
          </div>`; }).join('') || `<div class="muted">${t('no_earnings')}</div>`}
      </div>
      <div class="card" style="margin-top:12px">
        <div style="font-weight:800;margin-bottom:4px">${t('fc_h')}</div>
        <div class="muted small" style="margin-bottom:10px">${t('fc_sub')}</div>
        <div class="row" style="gap:8px;margin-bottom:6px">
          <button class="btn small ghost" data-fc="all">${t('fc_all')}</button>
          <button class="btn small ghost" data-fc="month">${t('fc_month')}</button>
          <button class="btn small ghost" data-fc="week">${t('fc_week')}</button>
        </div>
        <div id="fan-club-body"><div class="muted small">…</div></div>
      </div>
      <div class="card" style="margin-top:12px">
        <div style="font-weight:800;margin-bottom:8px">${t('payouts_h')}</div>
        <div class="row" style="margin-bottom:8px"><span class="grow muted small">${t('bank_account')}</span>
          ${acct ? `<b class="small">•••• ${esc(acct.account_last4)}</b>` : `<span class="small" style="color:var(--pink)">${t('not_set')}</span>`}</div>
        ${acct ? `
          <div class="muted small" style="margin-bottom:8px">${esc(acct.holder_name)} · Routing ${esc(acct.routing_number)}</div>
          <div class="row">
            <input class="input" id="wd-amount" type="number" step="0.01" min="0" placeholder="${t('amount_ph')}" style="margin-top:0">
            <button class="btn small success" id="wd-go">${t('withdraw')}</button>
          </div>
          <div class="muted small" style="margin-top:6px">${t('avail_withdraw')} <b style="color:var(--green)">${fmt(wdData.available_cents)}</b></div>
        ` : ''}
        <div id="bank-form" class="${acct ? 'hidden' : ''}" style="margin-top:8px">
          <div style="font-weight:700;margin-bottom:6px">${acct ? t('update_bank') : t('add_bank')}</div>
          <label class="field">${t('holder_name')}<input class="input" id="ba-holder" maxlength="80" value="${acct ? esc(acct.holder_name) : ''}"></label>
          <label class="field">${t('routing')}<input class="input" id="ba-routing" inputmode="numeric" maxlength="9" value="${acct ? esc(acct.routing_number) : ''}"></label>
          <label class="field">${t('account_number')}${pwField('ba-account', 'off')}</label>
          <button class="btn" id="ba-save" style="margin-top:8px">${t('save_bank')}</button>
          <div class="muted small" style="margin-top:6px">${t('bank_note')}</div>
        </div>
        ${acct ? `<button class="btn ghost small" id="ba-toggle" style="margin-top:8px">${t('update_bank_btn')}</button>` : ''}
      </div>
      ${wds.length ? `
      <div class="card" style="margin-top:12px">
        <div style="font-weight:800;margin-bottom:8px">${t('wd_history')}</div>
        ${wds.map((w) => `
          <div class="row small" style="padding:6px 0;border-top:1px solid rgba(139,92,246,.1)">
            <span class="grow"><b>${fmt(w.amount_cents)}</b> <span class="muted">· ${timeHM(w.requested_at)}</span>
              ${w.note ? `<br><span class="muted">${esc(w.note)}</span>` : ''}</span>
            <span>${wdBadge(w.status)}</span>
          </div>`).join('')}
      </div>` : ''}
      <div class="muted small" style="text-align:center">${t('payouts_note')}</div>
    </div>`;

  document.querySelectorAll('[data-fc]').forEach((b) => {
    b.onclick = () => loadFanClub(b.dataset.fc);
  });
  loadFanClub('all');

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
    if (status === 200) { toast('⏳ Withdrawal requested — SlutCamp will send it soon'); show('modelEarnings', {}); }
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

/* Affiliate agreement gate — full-screen, must sign to enter */
async function vAffiliateAgreement(contract) {
  const sections = contract.sections || [];
  // Hide tab bar — they get nothing until they sign
  tabbar.classList.add('hidden'); tabbar.innerHTML = '';
  app.innerHTML = `
    <div class="header" style="background:linear-gradient(135deg,#3b2f0b,#1a1405)">
      <h1 style="color:var(--gold)">Slut<span style="color:#fff">Camp</span> <span style="font-size:14px">AFFILIATE</span></h1>
    </div>
    <div class="screen">
      <div class="card" style="border-color:var(--gold);text-align:center">
        <div style="font-size:40px">🤝</div>
        <div style="font-weight:800;font-size:18px;margin:8px 0">Affiliate Agreement</div>
        <div class="muted small">You must accept this agreement to access your affiliate dashboard.</div>
      </div>
      <div class="card" style="max-height:50vh;overflow-y:auto;text-align:left">
        ${sections.map((s) => `<div style="margin-bottom:12px"><div style="font-weight:700;color:var(--gold)">${esc(s.title)}</div><div class="small" style="margin-top:4px">${esc(s.body)}</div></div>`).join('')}
      </div>
      <label class="field">Type your full name to sign<input class="input" id="aff-sign-name" maxlength="80" placeholder="Your full legal name"></label>
      <label class="checkbox-row"><input type="checkbox" id="aff-sign-agree">
        <span>I have read this agreement and I <b>agree</b> to all terms.</span></label>
      <button class="btn" id="aff-sign-go" style="background:linear-gradient(135deg,#b8860b,#8b6914)">✍️ Sign & Enter Dashboard</button>
      <button class="btn ghost" id="aff-sign-out" style="margin-top:12px">Decline & Log out</button>
    </div>`;
  $('#aff-sign-out').onclick = () => logout(false);
  $('#aff-sign-go').onclick = async () => {
    const name = $('#aff-sign-name').value.trim();
    if (!name || name.length < 2) return toast('Type your full name to sign.');
    if (!$('#aff-sign-agree').checked) return toast('You must agree to the terms.');
    const { status } = await api('/recruiter/contract/sign', {
      method: 'POST', body: JSON.stringify({ display_name: name }) });
    if (status === 200) { toast('✅ Agreement signed — welcome!'); return vRecruiter(); }
    toast('Could not sign. Try again.');
  };
}

async function vRecruiter() {
  // Agreement gate: unsigned affiliates see ONLY the agreement
  try {
    const { status, data } = await api('/recruiter/contract');
    if (status === 200 && !data.signed) return vAffiliateAgreement(data);
  } catch (e) { /* fail open */ }

  const { data } = await api('/recruiter/dashboard');
  if (!data || !data.recruiter) { toast('Could not load dashboard'); return show('landing', {}); }
  const r = data.recruiter;
  const models = data.models || [];
  const link = `${window.location.origin}/#join/${r.referral_code}`;
  const { data: acctData } = await api('/model/payout-account');
  const { data: wdData } = await api('/model/withdrawals');
  const acct = acctData.account;
  const wds = wdData.withdrawals || [];
  const wdBadge = (s) => s === 'pending' ? t('wd_pending') : s === 'paid' ? t('wd_paid') : t('wd_rejected');
  app.innerHTML = `
    <div class="header" style="background:linear-gradient(135deg,#3b2f0b,#1a1405)">
      <h1 style="color:var(--gold)">Slut<span style="color:#fff">Camp</span> <span style="font-size:14px">AFFILIATE</span></h1>
      <div class="sub" style="color:#d4a843">${esc(r.name)}${r.city ? ` · ${esc(r.city)}` : ''}</div>
    </div>
    <div class="screen">
      <div class="card" style="background:linear-gradient(135deg,#2a2208,#1a1405);border-color:var(--gold);text-align:center">
        <div style="font-size:13px;color:#d4a843;font-weight:700;letter-spacing:1px">YOUR EARNINGS</div>
        <div style="font-size:42px;font-weight:800;color:var(--green);margin:4px 0">${fmt(data.available_cents)}</div>
        <div class="small muted">Available for payout · ${fmt(data.earnings_cents)} total earned (20%)</div>
      </div>
      <div class="lang-row">${langPillsHTML()}</div>
      <div class="card" style="border-color:var(--gold)">
        <div style="font-weight:800;margin-bottom:6px;color:var(--gold)">🔗 Your recruiting link</div>
        <div class="muted small" style="word-break:break-all;margin-bottom:8px">${esc(link)}</div>
        <button class="btn small" id="rc-copy" style="background:linear-gradient(135deg,#b8860b,#8b6914)">📋 Copy link</button>
        <div class="muted small" style="margin-top:8px">Send this to models — anyone who signs up through it is yours. You earn 20% of everything they make.</div>
      </div>
      <div class="stat-grid" style="margin-top:12px">
        <div class="stat"><div class="n">${data.model_count}</div><div class="l">Models recruited</div></div>
        <div class="stat"><div class="n" style="color:var(--green)">${fmt(data.earnings_cents)}</div><div class="l">Total earned</div></div>
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
        <div style="font-weight:800;margin-bottom:8px">${t('payouts_h')}</div>
        <div class="row" style="margin-bottom:8px"><span class="grow muted small">${t('bank_account')}</span>
          ${acct ? `<b class="small">•••• ${esc(acct.account_last4)}</b>` : `<span class="small" style="color:var(--pink)">${t('not_set')}</span>`}</div>
        ${acct ? `
          <div class="muted small" style="margin-bottom:8px">${esc(acct.holder_name)} · Routing ${esc(acct.routing_number)}</div>
          <div class="row">
            <input class="input" id="wd-amount" type="number" step="0.01" min="0" placeholder="${t('amount_ph')}" style="margin-top:0">
            <button class="btn small success" id="wd-go">${t('withdraw')}</button>
          </div>
          <div class="muted small" style="margin-top:6px">${t('avail_withdraw')} <b style="color:var(--green)">${fmt(wdData.available_cents)}</b></div>
        ` : ''}
        <div id="bank-form" class="${acct ? 'hidden' : ''}" style="margin-top:8px">
          <div style="font-weight:700;margin-bottom:6px">${acct ? t('update_bank') : t('add_bank')}</div>
          <label class="field">${t('holder_name')}<input class="input" id="ba-holder" maxlength="80" value="${acct ? esc(acct.holder_name) : ''}"></label>
          <label class="field">${t('routing')}<input class="input" id="ba-routing" inputmode="numeric" maxlength="9" value="${acct ? esc(acct.routing_number) : ''}"></label>
          <label class="field">${t('account_number')}${pwField('ba-account', 'off')}</label>
          <button class="btn" id="ba-save" style="margin-top:8px">${t('save_bank')}</button>
          <div class="muted small" style="margin-top:6px">${t('bank_note')}</div>
        </div>
        ${acct ? `<button class="btn ghost small" id="ba-toggle" style="margin-top:8px">${t('update_bank_btn')}</button>` : ''}
      </div>
      ${wds.length ? `
      <div class="card" style="margin-top:12px">
        <div style="font-weight:800;margin-bottom:8px">${t('wd_history')}</div>
        ${wds.map((w) => `
          <div class="row small" style="padding:6px 0;border-top:1px solid rgba(139,92,246,.1)">
            <span class="grow"><b>${fmt(w.amount_cents)}</b> <span class="muted">· ${timeHM(w.requested_at)}</span>
              ${w.note ? `<br><span class="muted">${esc(w.note)}</span>` : ''}</span>
            <span>${wdBadge(w.status)}</span>
          </div>`).join('')}
      </div>` : ''}
      <div class="card" id="tax-card" style="margin-top:12px"><div class="muted small">Loading tax info…</div></div>
      <button class="btn ghost" id="r-logout" style="margin-top:12px">${t('log_out')}</button>
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
    if (status === 200) { toast('⏳ Withdrawal requested — SlutCamp will send it soon'); show('recruiter', {}); }
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

/* Slot bookings live on Central time — always label them in CT so the
   model and the fan are looking at the same clock. */
function bookingWhenCT(at) {
  const d = new Date(at);
  return d.toLocaleDateString('en-US', { timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric' }) +
    ' ' + d.toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' }) + ' CT';
}
function chiTimeLabel(iso) {
  return new Date(iso).toLocaleTimeString('en-US',
    { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' });
}
function chiDayLabel(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  return { dow: dt.toLocaleDateString('en-US', { timeZone: 'America/Chicago', weekday: 'short' }),
           md: dt.toLocaleDateString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric' }) };
}

async function vBookings() {
  const { data } = await api('/bookings');
  const bookings = data.bookings || [];
  const isModel = S.user.role === 'model';
  const pending = bookings.filter((b) => b.status === 'pending');
  const upcoming = bookings.filter((b) => ['booked', 'approved', 'in_progress'].includes(b.status));
  app.innerHTML = `
    <div class="header"><h1>${t('bookings_h')}</h1>
      <div class="sub">${t('bookings_sub')}</div></div>
    <div class="screen">
      ${isModel && pending.length ? `
      <div class="card" style="border-color:var(--gold)">
        <div style="font-weight:800;margin-bottom:8px">⏳ ${t(pending.length === 1 ? 'req_waiting_1' : 'req_waiting_n', { n: pending.length })}</div>
        ${pending.map((b) => `
          <div class="row" style="margin-bottom:10px;align-items:center">
            <span class="grow"><b>${esc(b.other_name)}</b><br>
              <span class="small muted">${bookingWhen(b.scheduled_at)} · ${b.duration_min}min · <b style="color:var(--green)">${fmt(b.total_cents)}</b></span></span>
          </div>
          <div class="row" style="gap:8px;margin-bottom:12px">
            <button class="btn small" data-bk-approve="${b.id}">${t('approve')}</button>
            <button class="btn small ghost" data-bk-decline="${b.id}">${t('decline')}</button>
          </div>`).join('')}
      </div>` : ''}
      ${upcoming.length ? upcoming.map((b) => {
        const confirmed = b.status === 'approved' || b.status === 'booked';
        const canGoLive = isModel && confirmed &&
          Date.now() > b.scheduled_at - 15 * 60 * 1000;
        const canJoin = !isModel && b.status === 'in_progress';
        const canFanOpen = !isModel && confirmed &&
          Date.now() > b.scheduled_at - 5 * 60 * 1000;
        const waitingLive = !isModel && confirmed && !canFanOpen;
        return `
        <div class="card">
          <div class="row" style="align-items:center">
            ${b.other_photo_url ? `<div class="avatar sm"><img src="${esc(b.other_photo_url)}" alt=""></div>` : ''}
            <span class="grow"><b>${b.status === 'in_progress' ? '🔴 LIVE NOW' : '📅'} ${esc(b.other_name)}</b>${b.status === 'booked' ? ' <span class="small" style="color:var(--green);font-weight:800">✅ Booked</span>' : ''}<br>
              <span class="small muted">${b.kind === 'slot' ? bookingWhenCT(b.scheduled_at) : bookingWhen(b.scheduled_at)} · ${b.duration_min}min · ${fmt(b.total_cents)}</span><br>
              <span class="small" style="color:var(--gold);font-weight:700">${b.status === 'in_progress' ? 'In progress' : '⏱ ' + bookingCountdown(b.scheduled_at)}</span></span>
          </div>
          ${b.status === 'in_progress' && b.fan_join_deadline ? `
          <div class="small" style="color:#ff8fa5;font-weight:700;margin-top:8px">${isModel
            ? `⏳ He has <span data-join-cd="${b.fan_join_deadline}">3:00</span> to join — a no-show keeps the booking paid to you`
            : `⏳ She's waiting — join within <span data-join-cd="${b.fan_join_deadline}">3:00</span> or it's a no-show (no refund)`}</div>` : ''}
          <div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap">
            ${canGoLive ? `<button class="btn small" data-bk-start="${b.id}">🔴 Go Live Now</button>` : ''}
            ${canJoin ? `<button class="btn small" data-bk-join="${b.id}">📹 Join Private Session</button>` : ''}
            ${canFanOpen ? `<button class="btn small" data-bk-join="${b.id}">💚 Your 1-on-1 is ready — Join 📹</button>` : ''}
            ${waitingLive ? `<span class="small muted">She'll go live at the scheduled time — you'll get a ping 📲</span>` : ''}
            ${['pending', 'approved', 'booked'].includes(b.status) ? `<button class="btn small ghost" data-bk-cancel="${b.id}">Cancel</button>` : ''}
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
      ? (data.refunded_cents ? `Cancelled — ${fmt(data.refunded_cents)} refunded.` : 'Cancelled (no refund — inside the cancellation window).')
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
  wireRemoteVideo(pc);
  if (!isModel) {
    // Fan initiates the WebRTC offer to the model
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    S.ws.send(JSON.stringify({ type: 'signal', to: data.other_id,
      payload: { kind: 'invite', call_id: callId, sdp: offer,
                 from_name: S.user.display_name, rate: 0, booking: true } }));
    S.call = { id: callId, rate: 0, seconds: 0, minutes: 0, role: 'fan', bookingId,
               joinDeadline: data.fan_join_deadline || null };
    toast('Calling… waiting for her to pick up 📞');
  } else {
    // Model waits for the fan's offer (or initiates if fan already waiting)
    S.call = { id: callId, rate: 0, seconds: 0, minutes: 0, role: 'model', bookingId,
               joinDeadline: data.fan_join_deadline || null,
               from: data.other_id, fromName: data.other_name };
    $('#call-name').textContent = data.other_name || 'Fan';
    $('#call-overlay').classList.remove('hidden');
    toast('Waiting for fan to join… 📹');
  }
  $('#active-call').classList.remove('hidden');
  $('#local-video').srcObject = localStream;
  $('#call-timer').textContent = 'Private session 💋';
  armCallWaiting();
  callTimerInt = setInterval(() => { S.call.seconds++; updateCallHUD(); }, 1000);
}

// Handle booking WS pushes
function handleBookingPush(m) {
  if (!S.user) return;
  if (m.type === 'booking:booked' && S.user.role === 'model') {
    toast(`📅 New 1-on-1 booked — ${bookingWhenCT(m.scheduled_at)} · ${m.duration_min}min · ${fmt(m.total_cents)}`, 4000);
    if (S.view === 'bookings') show('bookings', {});
  } else if (m.type === 'booking:request' && S.user.role === 'model') {
    toast(`📅 ${m.fan_name} booked you!`, 4000);
    if (S.view === 'bookings') show('bookings', {});
  } else if (m.type === 'booking:approved' && S.user.role === 'fan') {
    toast('✅ She confirmed your booking!', 4000);
    if (S.view === 'bookings') show('bookings', {});
  } else if ((m.type === 'booking:declined' || m.type === 'booking:no_show' ||
              m.type === 'booking:cancelled') && S.user.role === 'fan') {
    toast(m.type === 'booking:cancelled' && !m.refunded_cents
      ? 'Booking cancelled (no refund — inside the cancellation window).'
      : `Refunded ${fmt(m.refunded_cents || 0)}`, 4000);
    if (S.view === 'bookings') show('bookings', {});
  } else if (m.type === 'booking:live' && S.user.role === 'fan') {
    toast('📹 Your 1-on-1 is now active — you have 3 minutes to get to the call ⏰', 6000);
    if (S.view === 'bookings') show('bookings', {});
  } else if (m.type === 'booking:fan_no_show') {
    toast(S.user.role === 'model'
      ? '💔 He never showed up — the booking is paid, you keep it.'
      : "💔 You missed your 1-on-1 — no-show bookings aren't refunded.", 6000);
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
      <div class="small" style="border:1px solid var(--pink);border-radius:10px;padding:10px 12px;margin:0 0 12px;line-height:1.5">⏰ <b>Show up on time:</b> when your 1-on-1 goes active, you have <b>3 minutes</b> to join the call. If you're a no-show, <b>there will be no refund</b> — you booked a slot another fan could have taken, and her time was reserved just for you. (Plans change? Cancel 1+ hour ahead for a full refund.)</div>
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

/* Slot booking sheet: her real calendar — days, 30-min start chips,
   durations, price up front. First fan to pay owns the slot. Falls back
   to the legacy request sheet when she hasn't set any 1-on-1 hours. */
async function openSlotBookingSheet(modelId, modelName, rateCents) {
  const first = await api(`/models/${modelId}/bookings-availability?days=14`);
  if (first.status !== 200 || !first.data || !(first.data.days || []).some((d) => d.has_window)) {
    openBookingSheet(modelId, modelName, rateCents);
    return;
  }
  let grid = first.data;
  const rate = grid.rate_cents || rateCents || 399;
  let selDay = Math.max(0, grid.days.findIndex((d) => d.slots.some((s) => !s.taken)));
  let selSlot = null;
  let selDur = 15;
  const sheet = document.createElement('div');
  sheet.className = 'sheet-backdrop';
  document.body.appendChild(sheet);
  const close = () => sheet.remove();
  sheet.onclick = (e) => { if (e.target === sheet) close(); };

  function render() {
    const day = grid.days[selDay];
    const price = selSlot ? rate * selDur : rate * selDur;
    sheet.innerHTML = `
    <div class="sheet">
      <div style="font-weight:800;font-size:18px;margin-bottom:4px">📅 Book a 1-on-1 — ${esc(modelName)}</div>
      <div class="muted small" style="margin-bottom:12px">Her openings, Central time · pay upfront, the slot is yours · full refund if SHE doesn't show</div>
      <div class="bk-day-strip">
        ${grid.days.map((d, i) => { const L = chiDayLabel(d.date); return `
          <button class="bk-day ${i === selDay ? 'on' : ''}" data-day="${i}">
            <span class="bk-dow">${L.dow}</span><span class="bk-md">${L.md}</span>
            ${d.booked_out ? `<span class="bk-out">${t('bk_booked_out')}</span>` : ''}
          </button>`; }).join('')}
      </div>
      ${day && day.slots.length ? `
      <div class="bk-slots">
        ${day.slots.map((s) => `
          <button class="bk-slot ${s.taken ? 'taken' : ''} ${selSlot && selSlot.starts_at === s.starts_at ? 'on' : ''}"
            data-slot="${s.starts_at}" ${s.taken ? 'disabled' : ''}>
            ${chiTimeLabel(s.starts_at)}${s.taken ? `<span class="bk-slot-sub">${t('bk_slot_booked')}</span>` : ''}
          </button>`).join('')}
      </div>` : `<div class="muted small" style="margin:10px 0">${day && day.booked_out ? t('bk_booked_out') : t('bk_no_slots')}</div>`}
      <div class="field" style="margin-top:12px">Duration
        <div class="row" style="gap:8px;margin-top:6px">
          ${grid.durations.map((d) => {
            const ok = !selSlot || selSlot.free_for.includes(d);
            return `<button class="btn ${selDur === d ? '' : 'ghost'} small bk-dur" data-dur="${d}" ${ok ? '' : 'disabled'} style="flex:1${ok ? '' : ';opacity:.35'}">${d} min<br><span class="small">${fmt(rate * d)}</span></button>`;
          }).join('')}
        </div></div>
      <div class="row" style="margin:12px 0;align-items:center">
        <span class="grow" style="font-weight:800">${selSlot ? `${chiDayLabel(day.date).dow} ${chiTimeLabel(selSlot.starts_at)} CT · ${selDur} min` : 'Pick a time'}</span>
        <b style="font-size:20px;color:var(--green)">${fmt(price)}</b>
      </div>
      <div class="small" style="border:1px solid var(--pink);border-radius:10px;padding:10px 12px;margin:0 0 12px;line-height:1.5">⏰ <b>Show up on time:</b> when your 1-on-1 goes active, you have <b>3 minutes</b> to join the call. If you're a no-show, <b>there will be no refund</b> — you booked a slot another fan could have taken, and her time was reserved just for you. (Plans change? Cancel 2+ hours ahead for a full refund.)</div>
      <button class="btn" id="bk2-pay" ${selSlot ? '' : 'disabled style="opacity:.45"'}>Confirm &amp; pay ${fmt(price)}</button>
      <button class="btn ghost" id="bk2-cancel" style="margin-top:8px">Cancel</button>
    </div>`;
    sheet.querySelectorAll('[data-day]').forEach((b) => b.onclick = () => {
      selDay = parseInt(b.dataset.day); selSlot = null; render();
    });
    sheet.querySelectorAll('[data-slot]').forEach((b) => b.onclick = () => {
      selSlot = day.slots.find((s) => s.starts_at === b.dataset.slot) || null;
      if (selSlot && !selSlot.free_for.includes(selDur))
        selDur = selSlot.free_for[selSlot.free_for.length - 1] || 10;
      render();
    });
    sheet.querySelectorAll('.bk-dur').forEach((b) => b.onclick = () => {
      selDur = parseInt(b.dataset.dur); render();
    });
    sheet.querySelector('#bk2-cancel').onclick = close;
    const pay = sheet.querySelector('#bk2-pay');
    if (pay) pay.onclick = async () => {
      pay.disabled = true;
      const { status, data } = await api('/bookings', { method: 'POST',
        body: JSON.stringify({ model_id: modelId, starts_at: selSlot.starts_at, minutes: selDur }) });
      if (status === 200) {
        sheet.innerHTML = `
        <div class="sheet" style="text-align:center">
          <div style="font-size:40px">💋</div>
          <div style="font-weight:800;font-size:19px;margin:6px 0">${t('bk_youre_booked')}!</div>
          <div class="muted">${esc(modelName)} · ${bookingWhenCT(Date.parse(selSlot.starts_at))} · ${selDur} min</div>
          <div class="small muted" style="margin:10px 0">She'll get a reminder before your time. Be here a couple minutes early — your session opens right from your Bookings tab. Join within 3 minutes of her going live, or it's a no-show with no refund.</div>
          <button class="btn" id="bk2-view">View my bookings</button>
          <button class="btn ghost" id="bk2-done" style="margin-top:8px">Done</button>
        </div>`;
        sheet.querySelector('#bk2-view').onclick = () => { close(); show('bookings', {}); };
        sheet.querySelector('#bk2-done').onclick = close;
        if (S.wallet) refreshMe();
        return;
      }
      if (status === 402 || (data && data.error === 'insufficient_credits')) {
        close();
        return showBuyCredits(data.needed_cents);
      }
      toast(data.message || (data.error === 'slot_taken' ? 'That slot just got booked — pick another.'
        : data.error === 'day_full' ? '💔 She\'s booked out that day.'
        : data.error === 'week_full' ? '💔 She\'s booked out that week.'
        : 'Could not book.'));
      const again = await api(`/models/${modelId}/bookings-availability?days=14`);
      if (again.status === 200 && again.data) { grid = again.data; selSlot = null; render(); }
      else close();
    };
  }
  render();
}

async function vModelSettings() {
  await refreshMe();
  const m = S.model;
  const { data: idvData } = await api('/model/id-verification');
  const idv = (idvData && idvData.verification) || null;
  const idvStatus = idv ? idv.status : 'none';
  const idvBanner = idvStatus === 'approved'
    ? `<div class="card" style="border-color:var(--green)"><div style="font-weight:800;color:var(--green)">${t('id_verified')}</div><div class="small muted">${t('id_verified_sub')}</div></div>`
    : idvStatus === 'pending'
    ? `<div class="card" style="border-color:var(--yellow)"><div style="font-weight:800;color:var(--yellow)">${t('id_pending')}</div><div class="small muted">Submitted ${esc(idv.submitted_at || '')}. SlutCamp will review it soon — you can't chat or go live until it's approved.</div></div>`
    : `<div class="card" style="border-color:var(--red)">
        <div style="font-weight:800;margin-bottom:6px">🪪 ID Verification ${idvStatus === 'rejected' ? '<span style="color:var(--red)">— Action Needed</span>' : '<span style="color:var(--red)">— Required</span>'}</div>
        ${idvStatus === 'rejected' ? `<div class="small" style="color:var(--red);margin-bottom:8px">Rejected${idv.reviewer_note ? `: ${esc(idv.reviewer_note)}` : ''} — please resubmit.</div>` : ''}
        <div class="muted small" style="margin-bottom:10px">Federal law (18 U.S.C. §2257) requires us to verify your identity and age before you can chat with fans or go live. Upload a clear photo of:<br>1️⃣ Government ID — <b>front</b><br>2️⃣ Government ID — <b>back</b><br>3️⃣ A <b>selfie of you holding the ID</b> next to your face<br>Your documents are kept private and only reviewed by SlutCamp.</div>
        <label class="field">ID front<input class="input" type="file" id="idv-front" accept="image/*"></label>
        <label class="field">ID back<input class="input" type="file" id="idv-back" accept="image/*"></label>
        <label class="field">Selfie holding ID<input class="input" type="file" id="idv-selfie" accept="image/*"></label>
        <button class="btn" id="idv-submit">Submit for verification</button>
      </div>`;
  app.innerHTML = `
    <div class="header"><h1>${t('settings_h')}</h1></div>
    <div class="screen">
      ${idvBanner}
      <button class="btn" id="goto-home" style="width:100%;padding:16px;font-size:17px;font-weight:800;margin-bottom:12px;background:linear-gradient(135deg,var(--pink),#ff8fab);box-shadow:0 6px 22px rgba(255,92,158,.35)">🏠 Home Screen — see the girls 🔥</button>
      ${langCardHTML()}
      <div class="card">
        <div style="font-weight:800;margin-bottom:6px">${t('my_rates')}</div>
        <div class="muted small" style="margin-bottom:10px">${t('rates_note')}</div>
        <label class="field">${t('per_text')} <b id="s-msg-label">${fmt(m.per_message_cents || 149)}</b>
          <input type="range" id="s-msg" min="50" max="1000" step="25" value="${m.per_message_cents || 149}" style="width:100%"></label>
        <label class="field">${t('per_min_video_l')} <b id="s-min-label">${fmt(Math.max(500, m.per_minute_cents || 500))}</b>
          <input type="range" id="s-min" min="500" max="100000" step="100" value="${Math.max(500, m.per_minute_cents || 500)}" style="width:100%"></label>
        <label class="field">${t('per_voice')} <b id="s-voice-label">${fmt(m.per_voice_cents || 299)}</b>
          <input type="range" id="s-voice" min="50" max="1000" step="25" value="${m.per_voice_cents || 299}" style="width:100%"></label>
        <label class="field">${t('explicit_rate_l')}<input class="input" id="s-exp" type="number" step="0.01" min="0" value="${((m.explicit_rate_cents || 499) / 100).toFixed(2)}"></label>
        <div class="muted small" style="margin-top:6px">Fans watch your live stream free until the AI detects explicit content (or you tap "Go Explicit") — then they pay this rate per minute to keep watching unblurred.</div>
        <button class="btn" id="s-save">${t('save_rates')}</button>
      </div>
      <div class="card">
        <div style="font-weight:800;margin-bottom:6px">${t('stage_rates_h')}</div>
        <div class="muted small" style="margin-bottom:10px">You set what fans pay to join you <b>on camera/mic on stage</b> — regular and explicit. Every stage rate runs <b>$5–$1,000</b>, your call.</div>
        <label class="field">${t('jv_l')} <b id="s-rjv-label">${fmt(m.join_cents || 1000)}</b>
          <input type="range" id="s-rjv" min="500" max="100000" step="100" value="${m.join_cents || 1000}" style="width:100%"></label>
        <label class="field">${t('jm_l')} <b id="s-rjm-label">${fmt(m.mic_join_cents || 500)}</b>
          <input type="range" id="s-rjm" min="500" max="100000" step="100" value="${m.mic_join_cents || 500}" style="width:100%"></label>
        <label class="field">${t('ejv_l')} <b id="s-ejv-label">${fmt(m.explicit_join_cents || 2500)}</b>
          <input type="range" id="s-ejv" min="500" max="100000" step="100" value="${m.explicit_join_cents || 2500}" style="width:100%"></label>
        <label class="field">${t('ejm_l')} <b id="s-ejm-label">${fmt(m.explicit_mic_join_cents || 1500)}</b>
          <input type="range" id="s-ejm" min="500" max="100000" step="100" value="${m.explicit_mic_join_cents || 1500}" style="width:100%"></label>
        <button class="btn" id="s-ej-save" style="margin-top:8px">${t('save_stage_rates')}</button>
      </div>
      <div class="card">
        <div style="font-weight:800;margin-bottom:6px">${t('schedule_h')}</div>
        <div class="muted small" style="margin-bottom:10px">Set regular weekly times, go live spontaneously anytime, or both. Fans see your schedule on the Live tab.</div>
        <div id="sched-list"><span class="muted small">Loading…</span></div>
        <div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap">
          <select class="input" id="sched-day" style="flex:1">
            ${t('day_names').split(',').map((d, i) => `<option value="${(i + 1) % 7}">${d}</option>`).join('')}
          </select>
          <input class="input" id="sched-time" type="time" value="20:00" style="flex:1">
        </div>
        <input class="input" id="sched-title" placeholder="${t('slot_title_ph')}" maxlength="60" style="margin-top:8px">
        <button class="btn" id="sched-add" style="margin-top:8px">${t('add_slot')}</button>
      </div>
      <div class="card">
        <div style="font-weight:800;margin-bottom:6px">${t('bk1_h')}</div>
        <div class="muted small" style="margin-bottom:10px">${t('bk1_sub')}</div>
        <div id="avail-rows">
          ${t('days_short').split(',').map((d, wd) => `
          <div class="row avail-row" data-avail-wd="${wd}" style="align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap">
            <label class="row" style="align-items:center;gap:6px;min-width:118px">
              <input type="checkbox" class="avail-on" style="width:20px;height:20px;accent-color:var(--pink)">
              <b>${d}</b></label>
            <input class="input avail-start" type="time" value="12:00" step="1800" style="flex:1;min-width:104px">
            <span class="muted">→</span>
            <input class="input avail-end" type="time" value="16:00" step="1800" style="flex:1;min-width:104px">
          </div>`).join('')}
        </div>
        <div class="row" style="gap:8px;flex-wrap:wrap">
          <label class="field" style="flex:1;min-width:130px">${t('bk_day_cap')}
            <input class="input" id="avail-day-cap" type="number" min="0" max="100" placeholder="${t('bk_no_limit')}"></label>
          <label class="field" style="flex:1;min-width:130px">${t('bk_week_cap')}
            <input class="input" id="avail-week-cap" type="number" min="0" max="100" placeholder="${t('bk_no_limit')}"></label>
        </div>
        <button class="btn" id="avail-save" style="margin-top:6px">${t('bk_save_avail')}</button>
        <div style="font-weight:800;margin:16px 0 8px">${t('bk_upcoming')}</div>
        <div id="avail-upcoming"><span class="muted small">Loading…</span></div>
      </div>
      <div class="card">
        <div style="font-weight:800;margin-bottom:6px">${t('bio')}</div>
        <textarea class="input" id="s-bio" rows="3" maxlength="280">${esc(m.bio)}</textarea>
        <button class="btn" id="s-bio-save">${t('save_bio')}</button>
      </div>
      <div class="card">
        <div style="font-weight:800;margin-bottom:6px">${t('my_photo')}</div>
        <div class="row" style="align-items:center">
          ${avatarHTML(m.display_name || (S.user && S.user.display_name) || '?', 'sm', m.photo_url)}
          <span class="grow muted small">${t('photo_note')}</span>
        </div>
        <button class="btn ghost" id="s-photo" style="margin-top:8px">${t('change_photo')}</button>
        <div style="margin-top:12px;padding:12px;background:rgba(139,92,246,.08);border-radius:12px;border:1px solid rgba(139,92,246,.25)">
          <div style="font-weight:800;margin-bottom:4px">🔗 My promo link</div>
          <div class="muted small" style="margin-bottom:8px">Share this anywhere — fans who tap it land straight on your chat. It works the moment your account is created.</div>
          <div class="row" style="gap:8px">
            <input class="input" id="s-promo-link" readonly value="${esc(location.origin + '/#m/' + (S.user.username || ''))}" style="flex:1" onclick="this.select()">
            <button class="btn" id="s-promo-copy" style="white-space:nowrap">📋 Copy</button>
          </div>
        </div>
        <div style="margin-top:12px">
          <div class="muted small" style="margin-bottom:6px">🎬 <b>Preview video loop</b> — a few seconds that plays on the home screen instead of your photo. Keep it SFW and under 15MB.</div>
          ${m.preview_video_url ? `<video src="${esc(m.preview_video_url)}" autoplay muted loop playsinline style="width:120px;height:120px;border-radius:50%;object-fit:cover;border:2px solid var(--purple)"></video><br>` : ''}
          <button class="btn ghost small" id="s-preview-video" style="margin-top:6px">🎬 ${m.preview_video_url ? 'Change' : 'Upload'} preview video</button>
          ${m.preview_video_url ? `<button class="btn ghost small danger" id="s-preview-remove" style="margin-top:6px;margin-left:6px">Remove</button>` : ''}
        </div>
      </div>
      <div class="card" id="tax-card"><div class="muted small">Loading tax info…</div></div>
      <div id="pk-card"></div>
      <div id="pw-card"></div>
      <button class="btn ghost" id="s-ath" style="width:100%;margin-bottom:10px">${t('ath_wallet_row')}</button>
      <button class="btn ghost" id="s-logout">${t('log_out')}</button>
      <div class="card" id="tipmenu-card" style="margin-top:12px">
        <div style="font-weight:800;margin-bottom:6px">${t('tip_menu')}</div>
        <div class="muted small" style="margin-bottom:10px">Fans pick from your menu and pay instantly — like TikTok gifts but your own custom list. You keep 60% of every tip.</div>
        <div id="tipmenu-list"><span class="muted small">Loading…</span></div>
        <div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap">
          <input class="input" id="tm-emoji" placeholder="😈" maxlength="8" style="flex:0 0 52px;text-align:center;font-size:20px">
          <input class="input" id="tm-label" placeholder="e.g. Blow a kiss" maxlength="60" style="flex:2">
          <input class="input" id="tm-price" type="number" step="0.01" min="1" max="1000" placeholder="$" style="flex:1">
        </div>
        <button class="btn" id="tm-add" style="margin-top:8px">${t('add_tip_item')}</button>
      </div>
      <div class="card" id="regionblock-card" style="margin-top:12px">
        <div style="font-weight:800;margin-bottom:6px">${t('rb_h')}</div>
        <div class="muted small" style="margin-bottom:10px">${t('rb_note')}</div>
        <div id="rb-list"><span class="muted small">Loading…</span></div>
        <div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap">
          <select class="input" id="rb-level" style="flex:1">
            <option value="country">${t('rb_country')}</option>
            <option value="state">${t('rb_state')}</option>
            <option value="county">${t('rb_county')}</option>
            <option value="city">${t('rb_city')}</option>
          </select>
          <select class="input" id="rb-country" style="flex:1"></select>
        </div>
        <div class="row" style="gap:8px;margin-top:8px;flex-wrap:wrap" id="rb-us-row" hidden>
          <select class="input" id="rb-state" style="flex:1"></select>
          <select class="input" id="rb-county" style="flex:1" hidden></select>
        </div>
        <input class="input" id="rb-city" list="rb-city-list" placeholder="${t('rb_city_ph')}" maxlength="80" style="margin-top:8px" hidden>
        <datalist id="rb-city-list"></datalist>
        <button class="btn" id="rb-add" style="margin-top:8px">${t('rb_add')}</button>
      </div>
    </div>`;
  $('#s-save').onclick = async () => {
    const per_message_cents = parseInt($('#s-msg').value);
    const per_minute_cents = parseInt($('#s-min').value);
    const per_voice_cents = parseInt($('#s-voice').value);
    const explicit_rate_cents = Math.round(parseFloat($('#s-exp').value || '0') * 100);
    const { status } = await api('/model/profile', {
      method: 'PUT', body: JSON.stringify({ per_message_cents, per_minute_cents, per_voice_cents, explicit_rate_cents }) });
    toast(status === 200 ? t('rates_saved') : t('couldnt_save'));
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
    toast(status === 200 ? t('bio_saved') : t('couldnt_save'));
  };
  // Explicit stage rate sliders — live label updates
  const ejv = $('#s-ejv'), ejm = $('#s-ejm'), rjv = $('#s-rjv'), rjm = $('#s-rjm');
  if (ejv) ejv.oninput = () => { $('#s-ejv-label').textContent = fmt(parseInt(ejv.value)); };
  if (ejm) ejm.oninput = () => { $('#s-ejm-label').textContent = fmt(parseInt(ejm.value)); };
  if (rjv) rjv.oninput = () => { $('#s-rjv-label').textContent = fmt(parseInt(rjv.value)); };
  if (rjm) rjm.oninput = () => { $('#s-rjm-label').textContent = fmt(parseInt(rjm.value)); };
  const ejSave = $('#s-ej-save');
  if (ejSave) ejSave.onclick = async () => {
    const explicit_join_cents = parseInt(ejv.value);
    const explicit_mic_join_cents = parseInt(ejm.value);
    const join_cents = parseInt(rjv.value);
    const mic_join_cents = parseInt(rjm.value);
    const { status } = await api('/model/profile', {
      method: 'PUT', body: JSON.stringify({ explicit_join_cents, explicit_mic_join_cents,
        join_cents, mic_join_cents }) });
    toast(status === 200 ? t('stage_saved') : t('couldnt_save'));
    if (status === 200) refreshMe();
  };
  // Live schedule slots
  const DAYS = t('days_short').split(',');
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
  // 1-on-1 availability: weekly windows + caps, upcoming slot bookings
  const minToTime = (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
  const timeToMin = (v) => { const [h, m] = String(v || '').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
  async function loadAvail() {
    const { data } = await api('/model/availability');
    if (!data) return;
    const byDay = new Map((data.windows || []).map((w) => [w.weekday, w]));
    document.querySelectorAll('.avail-row').forEach((row) => {
      const w = byDay.get(parseInt(row.dataset.availWd));
      row.querySelector('.avail-on').checked = !!w;
      if (w) {
        row.querySelector('.avail-start').value = minToTime(w.start_min);
        row.querySelector('.avail-end').value = minToTime(w.end_min);
      }
    });
    $('#avail-day-cap').value = data.day_cap == null ? '' : data.day_cap;
    $('#avail-week-cap').value = data.week_cap == null ? '' : data.week_cap;
    const { data: bk } = await api('/bookings');
    const mine = (bk.bookings || []).filter((b) => ['booked', 'approved', 'in_progress'].includes(b.status));
    $('#avail-upcoming').innerHTML = mine.length ? mine.map((b) => `
      <div class="row" style="align-items:center;margin-bottom:8px">
        <span class="grow"><b>${esc(b.other_name)}</b><br>
          <span class="small muted">${bookingWhenCT(b.scheduled_at)} · ${b.duration_min}min · <b style="color:var(--green)">${fmt(b.total_cents)}</b>${b.status === 'in_progress' ? ' · 🔴' : ''}</span></span>
        ${b.status !== 'in_progress' ? `<button class="btn small ghost" data-avail-cancel="${b.id}">Cancel</button>` : ''}
      </div>`).join('') : `<span class="muted small">${t('bk_none_up')}</span>`;
    $('#avail-upcoming').querySelectorAll('[data-avail-cancel]').forEach((btn) => btn.onclick = async () => {
      if (!confirm('Cancel this 1-on-1? He gets a full refund.')) return;
      const { status, data } = await api(`/bookings/${btn.dataset.availCancel}/cancel`, { method: 'POST' });
      toast(status === 200 ? `Cancelled — ${fmt(data.refunded_cents)} refunded to him.` : 'Could not cancel.');
      loadAvail();
    });
  }
  loadAvail();
  $('#avail-save').onclick = async () => {
    const windows = [];
    document.querySelectorAll('.avail-row').forEach((row) => {
      if (!row.querySelector('.avail-on').checked) return;
      windows.push({ weekday: parseInt(row.dataset.availWd),
        start_min: timeToMin(row.querySelector('.avail-start').value),
        end_min: timeToMin(row.querySelector('.avail-end').value) });
    });
    const capVal = (id) => { const v = $(id).value.trim(); return v === '' ? null : parseInt(v); };
    const { status, data } = await api('/model/availability', { method: 'PUT',
      body: JSON.stringify({ windows, day_cap: capVal('#avail-day-cap'), week_cap: capVal('#avail-week-cap') }) });
    toast(status === 200 ? t('bk_avail_saved')
      : (data.message || 'Could not save — windows run on the half hour.'));
    if (status === 200) loadAvail();
  };
  const promoCopy = $('#s-promo-copy');
  if (promoCopy) promoCopy.onclick = async () => {
    const inp = $('#s-promo-link');
    try {
      await navigator.clipboard.writeText(inp.value);
      toast('🔗 Promo link copied!');
    } catch (e) {
      inp.select();
      try { document.execCommand('copy'); toast('🔗 Promo link copied!'); }
      catch (e2) { toast('Tap the link to copy it'); }
    }
  };
  $('#s-photo').onclick = () => {
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
        const { status, data } = await apiUpload('/model/photo', cropped);
        if (status === 200 && data.ok) {
          toast('📷 Photo updated!');
          await refreshMe();
          show('modelSettings', {});
        } else toast('Upload failed — use a JPG/PNG under 5MB.');
      });
    };
    inp.click();
  };
  $('#s-logout').onclick = () => logout();
  renderPkSettingsCard();
  renderPwSettingsCard();
  const sAth = $('#s-ath');
  if (sAth) sAth.onclick = openAthSheet;
  // Preview video upload (offscreen input for iOS)
  const pvBtn = $('#s-preview-video');
  if (pvBtn) pvBtn.onclick = () => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'video/*';
    inp.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0.01;z-index:9999;';
    inp.onchange = async () => {
      const f = inp.files[0]; inp.remove();
      if (!f) return;
      if (f.size > 15 * 1024 * 1024) return toast('Video too big — 15MB max. Keep it short!');
      toast('Uploading… 🎬');
      const fd = new FormData(); fd.append('video', f);
      const headers = {};
      if (S.token) headers['Authorization'] = 'Bearer ' + S.token;
      try {
        const r = await fetch('/api/model/preview-video', { method: 'POST', headers, body: fd });
        const data = await r.json();
        if (r.status === 200 && data.ok) {
          toast('🎬 Preview video live!');
          await refreshMe();
          show('modelSettings', {});
        } else toast('Upload failed — use a short video under 15MB.');
      } catch (e) { toast('Upload failed — check your connection.'); }
    };
    document.body.appendChild(inp);
    inp.click();
  };
  const pvRem = $('#s-preview-remove');
  if (pvRem) pvRem.onclick = async () => {
    const headers = {};
    if (S.token) headers['Authorization'] = 'Bearer ' + S.token;
    const r = await fetch('/api/model/preview-video', { method: 'DELETE', headers });
    if (r.status === 200) { toast('Preview removed — back to photo.'); await refreshMe(); show('modelSettings', {}); }
  };
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
  // ---------- 🚫 Region blocker ----------
  async function loadRegionBlocks() {
    const list = $('#rb-list');
    if (!list) return;
    const { data } = await api('/model/region-blocks');
    const blocks = (data && data.blocks) || [];
    list.innerHTML = blocks.length ? blocks.map((b) => `
      <div class="row" style="justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.06)">
        <span>🚫 <b>${esc(b.label)}</b> <span class="muted small">(${esc(b.level)})</span></span>
        <button class="btn ghost small danger" data-rb-del="${b.id}">${t('rb_remove')}</button>
      </div>`).join('')
      : `<div class="muted small">${t('rb_none')}</div>`;
    list.querySelectorAll('[data-rb-del]').forEach((btn) => btn.onclick = async () => {
      const { status } = await api('/model/region-blocks/' + btn.dataset.rbDel, { method: 'DELETE' });
      if (status === 200) { toast(t('rb_removed')); loadRegionBlocks(); }
      else toast(t('couldnt_save'));
    });
  }
  async function rbFetchOptions(state) {
    const { data } = await api('/geo/options' + (state ? '?state=' + encodeURIComponent(state) : ''));
    return data || {};
  }
  function rbSyncVisibility() {
    const levelSel = $('#rb-level'), countrySel = $('#rb-country');
    if (!levelSel || !countrySel) return;
    const isUS = countrySel.value === 'US';
    // State/county granularity exists for the US only
    levelSel.querySelectorAll('option').forEach((o) => {
      o.disabled = !isUS && (o.value === 'state' || o.value === 'county');
    });
    if (!isUS && (levelSel.value === 'state' || levelSel.value === 'county')) levelSel.value = 'country';
    $('#rb-us-row').hidden = !(isUS && levelSel.value !== 'country');
    $('#rb-county').hidden = levelSel.value !== 'county';
    $('#rb-city').hidden = levelSel.value !== 'city';
  }
  async function rbInit() {
    const levelSel = $('#rb-level');
    if (!levelSel) return;
    const base = await rbFetchOptions();
    $('#rb-country').innerHTML = (base.countries || []).map((c) =>
      `<option value="${c.code}"${c.code === 'US' ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
    $('#rb-state').innerHTML = (base.states || []).map((s) =>
      `<option value="${s.code}">${esc(s.name)}</option>`).join('');
    const loadStateDetail = async () => {
      const d = await rbFetchOptions($('#rb-state').value);
      $('#rb-county').innerHTML = (d.counties || []).map((c) =>
        `<option value="${esc(c)}">${esc(c)}</option>`).join('');
      $('#rb-city-list').innerHTML = (d.cities || []).map((c) =>
        `<option value="${esc(c)}">`).join('');
    };
    levelSel.onchange = rbSyncVisibility;
    $('#rb-country').onchange = rbSyncVisibility;
    $('#rb-state').onchange = loadStateDetail;
    $('#rb-add').onclick = async () => {
      const body = { level: levelSel.value, country_code: $('#rb-country').value };
      if (!$('#rb-us-row').hidden) body.state_code = $('#rb-state').value;
      if (levelSel.value === 'county') body.county_name = $('#rb-county').value;
      if (levelSel.value === 'city') body.city_name = $('#rb-city').value.trim();
      const { status, data } = await api('/model/region-blocks', {
        method: 'POST', body: JSON.stringify(body) });
      if (status === 200) {
        toast('🚫 ' + t('rb_added') + ': ' + (data.label || ''));
        $('#rb-city').value = '';
        loadRegionBlocks();
      } else toast((data && data.message) || t('couldnt_save'));
    };
    await loadStateDetail();
    rbSyncVisibility();
    loadRegionBlocks();
  }
  rbInit();
  // 🪪 ID verification submit (3 files via multipart)
  const gotoHome = $('#goto-home');
  if (gotoHome) gotoHome.onclick = () => show('fanModels', {});
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
      toast('✅ Submitted! SlutCamp will review your ID soon.');
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
        <p><b>Payer:</b> WORLD OF GODZ ENTERTAINMENT LLC</p>
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
    <div class="muted small" style="margin-top:6px">🔒 Encrypted on our server. Only SlutCamp can use this for your 1099 — it's never shown to fans.</div>`;
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
    <div class="chat-wrap">
    <div class="chat-header">
      <button class="icon-btn" id="c-back">‹</button>
      ${avatarHTML(other.display_name, 'sm', other.photo_url)}
      <div class="grow">
        <div class="name">${esc(other.display_name)}</div>
        <div class="status">${conv.is_paused ? t('st_paused') : (other.is_online ? t('st_online') : t('st_offline'))}</div>
      </div>
      ${!isModel && !S.user ? `<span class="small" style="color:var(--pink);font-weight:700">${t('free_left', { n: conv.free_remaining })}</span>` : ''}
      ${canVideo ? `<button class="icon-btn" id="c-video" title="Video call">📹</button>` : ''}
      ${S.user && S.user.role === 'fan' ? `<button class="btn-book" id="c-book" title="${t('book_title')}">${t('book_1on1')}</button>` : ''}
    </div>
    ${conv.is_paused ? `
      <div class="rate-hint" style="background:rgba(248,113,113,.12);color:#fca5a5;font-weight:700">
        ${t('chat_paused_banner')}<br><span class="small">${t('sharing_not_allowed')}</span>
      </div>` : ''}
    ${!isModel && !conv.is_paused ? `
      <div class="rate-hint">${S.user
        ? t('msgs_cost', { price: fmt(other.per_message_cents) })
        : t('free_msgs_left', { n: conv.free_remaining })}</div>` : ''}
    <div id="messages"></div>
    <div id="typing-ind" class="rate-hint hidden"><i>${t('typing')}</i></div>
    <div class="chat-footer">
    <div id="emoji-panel" class="emoji-panel hidden">${['😀','😂','😍','😘','😈','🔥','💦','🍑','❤️','💋','👏','🙏','😎','🤤','🥵','💯','🎉','💸','👀','🤪','😏','🫦','💕'].map((e) => `<button type="button" class="emoji-cell" data-emoji="${e}">${e}</button>`).join('')}</div>
    <div class="chat-input-bar">
      ${!conv.is_paused && S.user && S.user.role === 'fan' ? `<button class="icon-btn" id="c-gift" title="Send a gift">🎁</button>` : ''}
      ${!conv.is_paused && S.user && S.user.role === 'fan' ? `<button class="icon-btn" id="c-tipmenu" title="Tip menu">💰</button>` : ''}
      <div class="composer-pill" id="c-pill">
        <button type="button" class="emoji-btn" id="c-emoji" aria-label="Emoji" ${conv.is_paused ? 'disabled' : ''}>😊</button>
        <textarea id="c-input" rows="1" placeholder="${conv.is_paused ? t('chat_paused_ph') : t('msg_placeholder')}" ${conv.is_paused ? 'disabled' : ''} autocomplete="off" enterkeyhint="send"></textarea>
      </div>
      ${isModel ? `<label class="icon-btn" id="c-cam" for="ppv-file-cam" title="Send a photo or video">📷</label>` : ''}
      <div class="composer-slot">
        <button type="button" class="round-act" id="c-mic" aria-label="Voice note" ${conv.is_paused ? 'disabled' : ''}>🎤</button>
        <button type="button" class="round-act" id="c-send" aria-label="Send" ${conv.is_paused ? 'disabled' : ''}>↑</button>
      </div>
    </div>
    </div>
    <input type="file" id="ppv-file-cam" class="file-offscreen" accept="image/*,video/*">
    </div>`;

  $('#c-back').onclick = () => {
    if (!S.user) show('landing', {});
    else if (isModel) show('modelChats', {});
    else show('fanChats', {});
  };
  // Anti-copy for fans: no selecting/copying messages, no pasting into chat
  if (!isModel) lockCopyForFans(app, $('#c-input'));
  const vb = $('#c-video');
  if (vb) vb.onclick = openFaceTimeSheet;
  if (!isModel && S.user) refreshFtPanel();
  if (isModel) refreshFtCard();
  const bb = $('#c-book');
  if (bb) bb.onclick = () => openSlotBookingSheet(conv.other.id, conv.other.display_name,
    conv.other.per_minute_cents || 399);
  // WhatsApp-style composer shortcuts: the round 🎤 button beside the bubble
  // starts a voice note DIRECTLY on the tap (no sheet hop in between —
  // every intermediate step is a chance for iOS to lose the mic gesture), and
  // the 📷 label (models only) opens the native picker for photo OR video,
  // then joins the PPV price-sheet flow. (A synthetic input.click() gets
  // ignored by iOS in the home-screen app — the label tap is a native
  // gesture, so the picker always opens.)
  const micBtn = $('#c-mic');
  if (micBtn) micBtn.onclick = () => startVoiceRecord();
  const camInp = $('#ppv-file-cam');
  if (camInp) camInp.onchange = () => {
    const f = camInp.files && camInp.files[0];
    camInp.value = '';
    if (!f) return;
    if (f.size > 200 * 1024 * 1024) return toast('File too big — 200MB max.');
    openPpvPriceSheet(f, f.type && f.type.startsWith('video/') ? 'ppv_video' : 'ppv_image');
  };
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
  api(`/conversations/${conv.id}/read`, { method: 'POST' })
    .then(() => refreshTabBadges()).catch(() => {});

  const input = $('#c-input');
  const send = () => {
    const ep = $('#emoji-panel');
    if (ep) ep.classList.add('hidden');
    const r = sendMessage();
    syncChatComposer();
    if (r && r.then) r.then(syncChatComposer);
  };
  $('#c-send').onclick = send;
  input.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };
  let typingTimer = null;
  input.oninput = () => {
    syncChatComposer();
    if (S.ws && S.ws.readyState === 1)
      S.ws.send(JSON.stringify({ type: 'typing', conversation_id: conv.id, is_typing: true }));
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
      if (S.ws && S.ws.readyState === 1)
        S.ws.send(JSON.stringify({ type: 'typing', conversation_id: conv.id, is_typing: false }));
    }, 1500);
  };
  // Emoji picker: 😊 inside the pill toggles the grid above the composer;
  // tapping a cell inserts at the cursor and keeps focus in the input.
  const emojiBtn = $('#c-emoji'), emojiPanel = $('#emoji-panel');
  if (emojiBtn && emojiPanel) {
    emojiBtn.onclick = () => emojiPanel.classList.toggle('hidden');
    emojiPanel.querySelectorAll('[data-emoji]').forEach((b) => {
      b.onclick = () => insertEmojiAtCursor(b.dataset.emoji);
    });
  }
  syncChatComposer();
}

// Insert an emoji into the chat composer at the caret (composer emoji picker).
function insertEmojiAtCursor(emoji) {
  const input = $('#c-input');
  if (!input) return;
  const s = input.selectionStart != null ? input.selectionStart : input.value.length;
  const e = input.selectionEnd != null ? input.selectionEnd : input.value.length;
  input.value = input.value.slice(0, s) + emoji + input.value.slice(e);
  const pos = s + emoji.length;
  input.focus();
  try { input.setSelectionRange(pos, pos); } catch (err) { /* older webviews */ }
  syncChatComposer();
}

async function loadMessages() {
  const { data } = await api(`/conversations/${S.conv.id}/messages?limit=50`);
  S.messages = data.messages || [];
  renderMessages();
}

// Media ids with an unlock request currently in flight (double-tap guard).
// The server also charges at most once per unlock record, but the client
// never fires a second request while one is out.
const unlockingIds = new Set();

function mediaHTML(m) {
  if (!m.media) return '';
  const md = m.media;
  if (md.unlocked) {
    // Every unlocked tile wears a loading veil (spinner + "Loading…") until
    // its bytes are actually ready — no more black/dead tiles while media
    // streams in. The veil returns while a video buffers and turns into a
    // tap-to-retry card if the load fails.
    const veil = `<span class="media-load"><span class="media-spin"></span><span class="media-load-tx">Loading…</span></span>`;
    if (md.kind === 'ppv_image')
      return `<span class="media-wrap media-img is-loading"><img class="ppv-img" data-media-src="${md.id}" alt="photo">${veil}</span>`;
    if (md.kind === 'ppv_video')
      return `<span class="media-wrap media-vid is-loading"><video class="ppv-vid" data-media-src="${md.id}" controls playsinline preload="metadata"></video>${veil}</span>`;
    if (md.kind === 'voice')
      // Custom WhatsApp-style player (no native chrome — the native pill
      // rendered inconsistently and "broke apart" under the veil): one
      // compact pill — pink play button, real-peak waveform, time label.
      // The <audio> lives hidden inside and is driven by the custom UI;
      // its src still comes from hydrateMediaSrc's token URL.
      return `<span class="voice-note is-loading" data-voice="${md.id}" data-dur="${md.duration_sec || 0}">
        <audio class="vn-audio" data-media-src="${md.id}" preload="metadata"></audio>
        <button type="button" class="vn-play" aria-label="Play voice note"><span class="vn-ico">▶</span><span class="vn-spin"></span></button>
        <span class="vn-wave"></span>
        <span class="vn-time">${vnFmtDur(md.duration_sec || 0)}</span>
        <span class="vn-err">↻ Couldn't load — tap to retry</span>
      </span>`;
    return '';
  }
  // Locked: pretty blurred tile, no bytes leak until paid
  const icon = md.kind === 'voice' ? '🎤' : md.kind === 'ppv_video' ? '🎥' : '📸';
  const label = md.kind === 'voice'
    ? `Voice note${md.duration_sec ? ` (${md.duration_sec}s)` : ''}`
    : md.kind === 'ppv_video' ? 'Private video' : 'Private photo';
  const mine = S.user && m.sender_id === S.user.id;
  if (md.kind === 'voice') {
    return `<button class="ppv-lock" data-unlock="${md.id}" ${mine ? 'disabled' : ''}>
    <span class="ppv-lock-bg">${icon}</span>
    <span class="ppv-lock-label">🔒 ${label}</span>
    ${mine ? `<span class="ppv-unlock-price">Priced at ${fmt(md.price_cents)}</span>`
           : `<span class="ppv-unlock-btn">Unlock for ${fmt(md.price_cents)}</span>`}
  </button>`;
  }
  // Locked PPV photo/video (casino rule): the WHOLE tile is the buy button —
  // price shown up front, one tap on the content itself bills his balance and
  // opens it in place. No separate unlock step, no confirmation dialog.
  const unlocking = unlockingIds.has(md.id);
  return `<button class="ppv-lock ppv-tap${unlocking ? ' unlocking' : ''}" data-unlock="${md.id}" ${mine || unlocking ? 'disabled' : ''}>
    <span class="ppv-lock-bg">${icon}</span>
    <span class="ppv-lock-label">🔒 ${label}</span>
    ${mine ? `<span class="ppv-unlock-price">Priced at ${fmt(md.price_cents)}</span>`
           : unlocking
             ? `<span class="ppv-unlock-btn">Unlocking…</span>`
             : `<span class="ppv-unlock-btn">Unlock for ${fmt(md.price_cents)}</span><span class="ppv-tap-hint">Tap to unlock</span>`}
  </button>`;
}

/* Loading veil states for chat media: 'loading' (spinner + "Loading…"),
   'ready' (veil gone), 'error' ("Couldn't load — tap to retry", manual
   retry only). Elements are recreated on every renderMessages, so handlers
   are bound per element at hydration time and never leak across renders. */
function mediaSetState(el, state) {
  const w = el.closest('.media-wrap');
  if (!w) return;
  w.classList.toggle('is-loading', state === 'loading');
  w.classList.toggle('is-error', state === 'error');
  const tx = w.querySelector('.media-load-tx');
  if (tx) tx.textContent = state === 'error' ? "Couldn't load — tap to retry" : 'Loading…';
}

function bindMediaState(el) {
  if (el.dataset.stateBound) return;
  el.dataset.stateBound = '1';
  // Voice notes have their own self-contained player (no veil) — separate path
  if (el.classList.contains('vn-audio')) { bindVoiceNote(el); return; }
  const tag = el.tagName;
  if (tag === 'IMG') {
    el.addEventListener('load', () => mediaSetState(el, 'ready'));
    el.addEventListener('error', () => { if (el.dataset.hydrated) mediaSetState(el, 'error'); });
  } else if (tag === 'VIDEO') {
    el.addEventListener('loadeddata', () => mediaSetState(el, 'ready'));
    el.addEventListener('waiting', () => mediaSetState(el, 'loading'));
    el.addEventListener('seeking', () => mediaSetState(el, 'loading'));
    el.addEventListener('playing', () => mediaSetState(el, 'ready'));
    el.addEventListener('canplay', () => mediaSetState(el, 'ready'));
    el.addEventListener('error', () => { if (el.dataset.hydrated) mediaSetState(el, 'error'); }, true);
  } else if (tag === 'AUDIO') {
    el.addEventListener('canplay', () => mediaSetState(el, 'ready'));
    el.addEventListener('error', () => { if (el.dataset.hydrated) mediaSetState(el, 'error'); }, true);
  }
  const w = el.closest('.media-wrap');
  const veil = w && w.querySelector('.media-load');
  if (veil) veil.addEventListener('click', () => {
    if (!w.classList.contains('is-error')) return;
    delete el.dataset.hydrated;
    hydrateOneMedia(el);
  });
}

async function hydrateOneMedia(el) {
  el.dataset.hydrated = '1';
  const isVn = el.classList.contains('vn-audio');
  const vnPill = isVn ? el.closest('.voice-note') : null;
  if (vnPill) vnSetState(vnPill, 'loading'); else mediaSetState(el, 'loading');
  const fail = () => { if (vnPill) vnSetState(vnPill, 'error'); else mediaSetState(el, 'error'); };
  try {
    const { status, data } = await api(`/media/${el.dataset.mediaSrc}/file-token`, { method: 'POST' });
    if (status === 200 && data.url) {
      el.src = data.url;
      if (vnPill) {
        // Voice: the pill leaves its loading state the moment the stream
        // URL lands; waveform peaks decode in the background and never
        // block playback.
        try { el.load(); } catch (e) { /* fresh el */ }
        vnSetState(vnPill, 'ready');
        vnLoadPeaks(el.dataset.mediaSrc, data.url);
      } else {
        if (el.tagName !== 'IMG') { try { el.load(); } catch (e) { /* fresh el */ } }
        // Audio streams on demand once it has its URL — the native player
        // takes over from here ('canplay' also clears the veil).
        if (el.tagName === 'AUDIO') mediaSetState(el, 'ready');
        if (el.tagName === 'IMG' && el.complete && el.naturalWidth > 0) mediaSetState(el, 'ready');
      }
    } else {
      fail();
    }
  } catch (e) {
    fail();
  }
}

async function hydrateMediaSrc(scope) {
  // Resolve authed file URLs for unlocked media (img/video/audio tags can't send headers)
  const els = (scope || document).querySelectorAll('[data-media-src]');
  for (const el of els) {
    bindMediaState(el);
    if (el.dataset.hydrated) continue;
    await hydrateOneMedia(el);
  }
}

/* ---------------- Custom voice-note player ----------------
   One compact WhatsApp-style pill: pink round play/pause, a 40-bar
   waveform from REAL decoded peaks (played fraction turns pink), and a
   time label (total when idle, elapsed while playing). All states live
   INSIDE the pill — spinner in the button while loading, a self-contained
   retry line on error. Peaks are cached per media id so re-renders never
   refetch; a decode failure falls back to seeded uniform bars and never
   blocks playback. Only one note plays at a time. */
const VN_BARS = 40;
const vnPeaksCache = new Map(); // mediaId -> [VN_BARS normalized peaks]
let vnAudioCtx = null;
let vnCurrent = null; // { pill, audio } — the note currently playing

function vnFmtDur(s) {
  s = Math.max(0, Math.round(s || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function vnSetState(pill, state) {
  pill.classList.toggle('is-loading', state === 'loading');
  pill.classList.toggle('is-error', state === 'error');
}

function vnSetPlayIcon(pill, playing) {
  const ico = pill.querySelector('.vn-ico');
  if (ico) ico.textContent = playing ? '❚❚' : '▶';
}

function bindVoiceNote(audio) {
  const pill = audio.closest('.voice-note');
  if (!pill) return;
  renderVnWave(pill, vnPeaksCache.get(parseInt(pill.dataset.voice)) || null);
  pill.querySelector('.vn-play').onclick = (ev) => { ev.stopPropagation(); vnToggle(pill, audio); };
  pill.querySelector('.vn-wave').onclick = (ev) => vnSeek(ev, pill, audio);
  pill.querySelector('.vn-err').onclick = () => vnRetry(pill, audio);
  audio.addEventListener('timeupdate', () => vnProgress(pill, audio));
  audio.addEventListener('loadedmetadata', () => vnProgress(pill, audio));
  audio.addEventListener('pause', () => {
    vnSetPlayIcon(pill, false);
    if (vnCurrent && vnCurrent.audio === audio) vnCurrent = null;
  });
  audio.addEventListener('ended', () => {
    vnSetPlayIcon(pill, false);
    if (vnCurrent && vnCurrent.audio === audio) vnCurrent = null;
    pill.querySelectorAll('.vn-wave i').forEach((b) => b.classList.remove('on'));
    const label = pill.querySelector('.vn-time');
    if (label) label.textContent = vnFmtDur(
      parseFloat(pill.dataset.dur || '0') || audio.duration || 0);
  });
  audio.addEventListener('error', () => {
    if (audio.dataset.hydrated) vnSetState(pill, 'error');
  }, true);
}

function vnToggle(pill, audio) {
  if (pill.classList.contains('is-error')) return vnRetry(pill, audio);
  if (pill.classList.contains('is-loading')) return; // no stream URL yet
  if (audio.paused) {
    if (vnCurrent && vnCurrent.audio !== audio) {
      vnCurrent.audio.pause();
      vnSetPlayIcon(vnCurrent.pill, false);
    }
    const p = audio.play();
    vnCurrent = { pill, audio };
    vnSetPlayIcon(pill, true);
    if (p && p.catch) p.catch(() => { vnSetState(pill, 'error'); vnSetPlayIcon(pill, false); });
  } else {
    audio.pause();
  }
}

function vnRetry(pill, audio) {
  vnSetState(pill, 'loading');
  delete audio.dataset.hydrated;
  hydrateOneMedia(audio);
}

function vnSeek(ev, pill, audio) {
  const wave = ev.currentTarget;
  const r = wave.getBoundingClientRect();
  if (!r.width) return;
  const frac = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
  const dur = (audio.duration && isFinite(audio.duration)) ? audio.duration
    : parseFloat(pill.dataset.dur || '0');
  if (dur > 0) {
    try { audio.currentTime = frac * dur; } catch (e) { /* metadata not ready */ }
    vnProgress(pill, audio);
  }
}

function vnProgress(pill, audio) {
  const dur = (audio.duration && isFinite(audio.duration)) ? audio.duration
    : parseFloat(pill.dataset.dur || '0');
  const cur = audio.currentTime || 0;
  const frac = dur > 0 ? Math.min(1, cur / dur) : 0;
  const bars = pill.querySelectorAll('.vn-wave i');
  const onN = Math.round(frac * bars.length);
  bars.forEach((b, i) => b.classList.toggle('on', i < onN));
  const label = pill.querySelector('.vn-time');
  if (label) label.textContent = vnFmtDur(cur > 0.05 ? cur : dur);
}

function renderVnWave(pill, peaks) {
  const wave = pill.querySelector('.vn-wave');
  if (!wave) return;
  const bars = peaks || Array.from({ length: VN_BARS }, () => 0.3);
  pill.classList.toggle('vn-wave-loading', !peaks);
  wave.innerHTML = bars.map((p) =>
    `<i style="height:${Math.max(12, Math.round(p * 100))}%"></i>`).join('');
  const audio = pill.querySelector('.vn-audio');
  if (audio) vnProgress(pill, audio);
}

function vnLoadPeaks(mediaId, url) {
  const id = parseInt(mediaId);
  const pill = document.querySelector(`.voice-note[data-voice="${id}"]`);
  if (vnPeaksCache.has(id)) { if (pill) renderVnWave(pill, vnPeaksCache.get(id)); return; }
  if (pill) renderVnWave(pill, null); // uniform low bars + pulse while decoding
  fetch(url)
    .then((r) => { if (!r.ok) throw new Error('fetch_failed'); return r.arrayBuffer(); })
    .then((buf) => decodeVnPeaks(buf))
    .then((peaks) => {
      vnPeaksCache.set(id, peaks);
      const p = document.querySelector(`.voice-note[data-voice="${id}"]`);
      if (p) renderVnWave(p, peaks);
    })
    .catch(() => {
      // Exotic codec / decode unsupported: seeded bars keep the pill solid,
      // and playback (the <audio> element) is completely unaffected.
      const fb = vnFallbackPeaks(id);
      vnPeaksCache.set(id, fb);
      const p = document.querySelector(`.voice-note[data-voice="${id}"]`);
      if (p) renderVnWave(p, fb);
    });
}

function decodeVnPeaks(arrayBuffer) {
  return new Promise((resolve, reject) => {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return reject(new Error('no_audio_context'));
      vnAudioCtx = vnAudioCtx || new AC();
      vnAudioCtx.decodeAudioData(arrayBuffer.slice(0), (decoded) => {
        const ch = decoded.getChannelData(0);
        const block = Math.max(1, Math.floor(ch.length / VN_BARS));
        const step = Math.max(1, Math.floor(block / 32));
        const peaks = [];
        for (let i = 0; i < VN_BARS; i++) {
          let max = 0;
          const start = i * block;
          for (let j = 0; j < block; j += step) {
            const v = Math.abs(ch[start + j] || 0);
            if (v > max) max = v;
          }
          peaks.push(Math.max(0.12, Math.min(1, max)));
        }
        resolve(peaks);
      }, reject);
    } catch (e) { reject(e); }
  });
}

// Deterministic "waveform" for undecodable files — seeded by media id so
// it looks the same on every render (and every device).
function vnFallbackPeaks(mediaId) {
  let seed = ((mediaId || 1) * 2654435761) >>> 0;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    return (seed >>> 8) / 16777216;
  };
  return Array.from({ length: VN_BARS }, () => 0.25 + rnd() * 0.65);
}

/* ---------------- Message reactions + edit ----------------
   🤍 on every bubble opens a 6-emoji popover (❤️ 😍 🔥 😈 💦 👏); one
   reaction per person — same emoji toggles off, a different one replaces.
   Reactions render as a chip overlapping the bubble's bottom corner.
   ✏️ on my own plain-text bubbles inside the 5-minute window opens an
   inline editor; the server holds the final say on the window. */
const REACT_EMOJIS = ['❤️', '😍', '🔥', '😈', '💦', '👏'];
const EDIT_WINDOW_MS = 5 * 60 * 1000;
let editingMsgId = null;
let reactPop = null; // { msgId, el }

function msgTimeMs(m) {
  return new Date(String(m.created_at || '').replace(' ', 'T') + 'Z').getTime();
}

function canEditMsg(m, mine) {
  if (!mine || !S.user || !m.sender_id || m.sender_id !== S.user.id) return false;
  if (m.media || m.media_id || m.gift_json || giftOf(m) || m.is_tip) return false;
  if ((m.body || '').startsWith('💸 Sent a ')) return false;
  return Date.now() - msgTimeMs(m) < EDIT_WINDOW_MS;
}

function reactionChipsHTML(m) {
  const rx = m.reactions || [];
  if (!rx.length) return '';
  const byEmoji = new Map();
  rx.forEach((r) => {
    const e = byEmoji.get(r.emoji) || { emoji: r.emoji, n: 0, mine: false };
    e.n += 1;
    if (r.mine || (S.user && r.user_id === S.user.id)) e.mine = true;
    byEmoji.set(r.emoji, e);
  });
  const groups = [...byEmoji.values()];
  const parts = groups.map((e) => e.n > 1
    ? `${e.emoji}<span class="rx-n">×${e.n}</span>` : e.emoji).join('');
  return `<div class="rx-chips${groups.some((e) => e.mine) ? ' mine' : ''}">${parts}</div>`;
}

function bubbleHTML(m) {
  const meId = S.user ? S.user.id : null;
  const mine = meId ? m.sender_id === meId : m.guest_token === S.guestToken;
  const ticks = mine && m.sender_id
    ? (m.is_read ? ' <span style="color:#7dd3fc">✓✓</span>' : ' <span>✓</span>') : '';
  const g = giftOf(m);
  const editing = editingMsgId === m.id;
  let bodyHTML;
  if (editing) {
    bodyHTML = `<div class="msg-edit">
      <textarea class="msg-edit-in" data-edit-in="${m.id}" rows="2">${esc(m.body)}</textarea>
      <div class="msg-edit-row">
        <button type="button" class="btn ghost small" data-edit-cancel="${m.id}">Cancel</button>
        <button type="button" class="btn small" data-edit-save="${m.id}">Save</button>
      </div></div>`;
  } else {
    bodyHTML = g ? giftBubbleHTML(g) : `${m.is_tip ? '💸 ' : ''}${esc(m.body)}${mediaHTML(m)}`;
  }
  const hasRx = (m.reactions || []).length > 0;
  return `<div class="msg ${mine ? 'out' : 'in'}${g ? ' gift-msg' : ''}${hasRx ? ' has-rx' : ''}${editing ? ' editing' : ''}" data-mid="${m.id}">${bodyHTML}
    <div class="meta">
      <span class="meta-acts">
        <button type="button" class="mini-act" data-react="${m.id}" aria-label="React">🤍</button>
        ${canEditMsg(m, mine) ? `<button type="button" class="mini-act" data-edit="${m.id}" aria-label="Edit">✏️</button>` : ''}
      </span>
      <span class="meta-info">${timeHM(m.created_at)}${m.cost_cents && !g ? ` · <span class="cost">-${fmt(m.cost_cents)}</span>` : ''}${m.edited ? ` · <span class="edited-tag">${t('edited')}</span>` : ''}${ticks}</span>
    </div>
    ${reactionChipsHTML(m)}
  </div>`;
}

function bindMessageActions(scope) {
  if (!scope) return;
  bindLongPressReact(scope);
  scope.querySelectorAll('[data-unlock]').forEach((b) => {
    if (!b.disabled) b.onclick = () => unlockMedia(parseInt(b.dataset.unlock));
  });
  scope.querySelectorAll('[data-react]').forEach((b) => {
    b.onclick = (ev) => { ev.stopPropagation(); openReactPop(parseInt(b.dataset.react), b); };
  });
  scope.querySelectorAll('[data-edit]').forEach((b) => {
    b.onclick = () => startEditMsg(parseInt(b.dataset.edit));
  });
  scope.querySelectorAll('[data-edit-save]').forEach((b) => {
    b.onclick = () => saveEditMsg(parseInt(b.dataset.editSave));
  });
  scope.querySelectorAll('[data-edit-cancel]').forEach((b) => {
    b.onclick = () => cancelEditMsg();
  });
  scope.querySelectorAll('[data-edit-in]').forEach((ta) => {
    ta.oninput = () => autosizeEditIn(ta);
    ta.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        saveEditMsg(parseInt(ta.dataset.editIn));
      }
    };
  });
}

function autosizeEditIn(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 148) + 'px';
}

function focusEditInput() {
  if (!editingMsgId) return;
  const ta = document.querySelector(`[data-edit-in="${editingMsgId}"]`);
  if (ta) {
    ta.focus();
    try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (e) { /* noop */ }
    autosizeEditIn(ta);
  }
}

/* Re-render ONE bubble in place (reaction/edit pushes, my own actions) —
   no scroll change, so reading history is never yanked to the bottom. */
function updateMessageBubble(m) {
  const box = $('#messages');
  if (!box || !m) return;
  const old = box.querySelector(`.msg[data-mid="${m.id}"]`);
  if (!old) return;
  const tmp = document.createElement('div');
  tmp.innerHTML = bubbleHTML(m);
  const node = tmp.firstElementChild;
  old.replaceWith(node);
  bindMessageActions(box);
  hydrateMediaSrc(node);
  focusEditInput();
}

/* Incremental append for the send/receive hot paths. renderMessages()
   rebuilds the ENTIRE list (innerHTML) on every call — that rebuild,
   plus its forced double scroll snap, racing the iOS keyboard/100dvh
   resize, was the visible "glitch" on every send (owner video, Oct 14):
   ghosted/overlapping bubbles, teleports, two-step keyboard motion.
   Here exactly ONE node is added; existing bubbles keep their identity. */
function appendMessageBubble(m) {
  const box = $('#messages');
  if (!box || !m) return false;
  if (box.querySelector(`.msg[data-mid="${m.id}"]`)) { updateMessageBubble(m); return false; }
  const tmp = document.createElement('div');
  tmp.innerHTML = bubbleHTML(m);
  const node = tmp.firstElementChild;
  if (!node) return false;
  box.appendChild(node);
  bindMessageActions(box);
  hydrateMediaSrc(node);
  return true;
}
function chatNearBottom() {
  const box = $('#messages');
  if (!box) return true;
  return box.scrollHeight - box.scrollTop - box.clientHeight < 140;
}
/* Scroll ONCE, next frame, after the textarea collapse + viewport have
   settled — never a synchronous snap, and never touch #app (in-chat it
   doesn't scroll; the old second snap just fought the flex layout). */
function pinChatScroll() {
  const box = $('#messages');
  if (!box) return;
  requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; });
}

function closeReactPop() {
  if (!reactPop) return;
  reactPop.el.remove();
  reactPop = null;
  document.removeEventListener('pointerdown', reactPopOutside, true);
  window.removeEventListener('resize', closeReactPop);
  window.removeEventListener('scroll', closeReactPop, true);
}
function reactPopOutside(e) {
  if (reactPop && !reactPop.el.contains(e.target)) closeReactPop();
}

/* Popover of the 6 reaction emojis, anchored above the 🤍 button (flips
   below it when the bubble sits near the top of the viewport). */
function openReactPop(msgId, anchor) {
  if (reactPop && reactPop.msgId === msgId) { closeReactPop(); return; }
  closeReactPop();
  const m = S.messages.find((x) => x.id === msgId);
  const myRx = m && (m.reactions || []).find((r) => r.mine || (S.user && r.user_id === S.user.id));
  const el = document.createElement('div');
  el.className = 'rx-pop';
  el.innerHTML = REACT_EMOJIS.map((e) =>
    `<button type="button" class="rx-pop-btn${myRx && myRx.emoji === e ? ' on' : ''}" data-rx-pick="${e}">${e}</button>`).join('');
  document.body.appendChild(el);
  const r = anchor.getBoundingClientRect();
  el.style.visibility = 'hidden';
  el.style.left = '0px'; el.style.top = '0px';
  const pw = el.offsetWidth, ph = el.offsetHeight;
  const left = Math.min(Math.max(8, r.left + r.width / 2 - pw / 2), window.innerWidth - pw - 8);
  let top = r.top - ph - 8;
  if (top < 8) top = r.bottom + 8; // flip below near the top of the screen
  el.style.left = `${left}px`; el.style.top = `${top}px`;
  el.style.visibility = '';
  reactPop = { msgId, el };
  el.querySelectorAll('[data-rx-pick]').forEach((b) => {
    b.onclick = (ev) => { ev.stopPropagation(); pickReaction(msgId, b.dataset.rxPick); };
  });
  setTimeout(() => document.addEventListener('pointerdown', reactPopOutside, true), 0);
  window.addEventListener('resize', closeReactPop);
  window.addEventListener('scroll', closeReactPop, true);
}

async function pickReaction(msgId, emoji) {
  closeReactPop();
  const { status, data } = await api(`/messages/${msgId}/react`, {
    method: 'POST', body: JSON.stringify({ emoji }),
  });
  if (status === 200) {
    const m = S.messages.find((x) => x.id === msgId);
    if (m) { m.reactions = data.reactions; updateMessageBubble(m); }
  } else if (status === 403) {
    toast('Only people in this chat can react.');
  } else {
    toast('Could not react.');
  }
}

/* ------------- iMessage-style long-press on the bubble itself -------------
   The 🤍 mini-act button stays, but the owner's ask (2026-10-16) is the
   phone-messages gesture: press-and-hold the MESSAGE ITSELF — text, photo,
   video (incl. a locked PPV tile), voice note, gift — and the same emoji
   popover pops up. Delegated on the #messages container, attached exactly
   once per container element (bindMessageActions re-runs after every
   render; the dataset flag keeps it single). ~500ms hold arms on
   pointerdown; moving >10px, lifting the finger, pointercancel, or a
   scroll cancels. When a hold fires, the click the browser dispatches
   right behind it is swallowed in the capture phase, so pressing a
   locked tile NEVER unlocks/charges, a video never plays, a voice note
   never starts — the press was a reaction gesture, nothing else. */
const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_PX = 10;
const LP_CLICK_SWALLOW_MS = 400;
let lpState = null; // { timer, bubble } while a hold is arming
let lpLastFiredAt = 0; // Date.now() of the last fired long-press

function lpCancel() {
  if (!lpState) return;
  clearTimeout(lpState.timer);
  if (lpState.bubble) lpState.bubble.classList.remove('pressing');
  lpState = null;
}

function bindLongPressReact(box) {
  if (!box || box.dataset.lpBound === '1') return;
  box.dataset.lpBound = '1';

  box.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return; // primary finger/button only
    if (!e.target || !e.target.closest) return;
    // Presses starting inside the open reaction popover are the
    // popover's own business, never a new press.
    if (reactPop && reactPop.el.contains(e.target)) return;
    const bubble = e.target.closest('.msg');
    if (!bubble || !box.contains(bubble)) return;
    // The mini-act buttons keep their own click behavior — arming on
    // them would double-open the popover (🤍) or fight the editor (✏️).
    if (e.target.closest('.mini-act')) return;
    // A message being edited never arms, and presses inside its inline
    // editor (textarea, Save/Cancel) are text work, not a gesture.
    const mid = parseInt(bubble.dataset.mid, 10);
    if (editingMsgId !== null && editingMsgId === mid) return;
    if (e.target.closest('.msg-edit')) return;
    lpCancel();
    bubble.classList.add('pressing');
    const timer = setTimeout(() => {
      const b = lpState && lpState.bubble;
      lpState = null;
      if (!b) return;
      b.classList.remove('pressing');
      lpLastFiredAt = Date.now();
      try { if (navigator.vibrate) navigator.vibrate(10); } catch (err) { /* no haptics — fine */ }
      openReactPop(parseInt(b.dataset.mid, 10), b);
    }, LONG_PRESS_MS);
    lpState = { timer, bubble, x: e.clientX, y: e.clientY };
  });

  box.addEventListener('pointermove', (e) => {
    if (!lpState) return;
    if (Math.abs(e.clientX - lpState.x) > LONG_PRESS_MOVE_PX ||
        Math.abs(e.clientY - lpState.y) > LONG_PRESS_MOVE_PX) lpCancel();
  });
  box.addEventListener('pointerup', lpCancel);
  box.addEventListener('pointercancel', lpCancel);
  box.addEventListener('scroll', lpCancel);

  // Capture-phase click suppression: a click that follows a fired
  // long-press (within LP_CLICK_SWALLOW_MS) dies here, before it can
  // reach the bubble's own handlers (PPV unlock, media play, links).
  box.addEventListener('click', (e) => {
    if (lpLastFiredAt && Date.now() - lpLastFiredAt < LP_CLICK_SWALLOW_MS) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);

  // No iOS/Android long-press callout menu inside the chat.
  box.addEventListener('contextmenu', (e) => { e.preventDefault(); });
}

function startEditMsg(msgId) {
  editingMsgId = msgId;
  const m = S.messages.find((x) => x.id === msgId);
  if (m) updateMessageBubble(m);
}
function cancelEditMsg() {
  const id = editingMsgId;
  editingMsgId = null;
  const m = S.messages.find((x) => x.id === id);
  if (m) updateMessageBubble(m);
}
async function saveEditMsg(msgId) {
  const ta = document.querySelector(`[data-edit-in="${msgId}"]`);
  const text = ta ? ta.value.trim() : '';
  if (!text) return toast('Message cannot be empty.');
  const { status, data } = await api(`/messages/${msgId}/edit`, {
    method: 'POST', body: JSON.stringify({ body: text }),
  });
  const m = S.messages.find((x) => x.id === msgId);
  if (status === 200 && data.flagged) {
    // Safety monitor blocked the edit — original text stays, chat paused.
    // Same toast + paused state as a blocked send (see sendMessage).
    editingMsgId = null;
    if (m) updateMessageBubble(m);
    toast(`⚠️ ${data.strikes >= 3 ? 'FLAGGED FOR REVIEW — ' : ''}Contact sharing is not allowed. Chat paused.`);
    if (S.conv) {
      S.conv.is_paused = true;
      show('chat', { conv: S.conv, keepMessages: true });
    }
    return;
  }
  if (status === 200) {
    editingMsgId = null;
    if (m) { m.body = data.body; m.edited = true; m.edited_at = data.edited_at; updateMessageBubble(m); }
  } else if (status === 403 && data.error === 'edit_window_closed') {
    editingMsgId = null;
    if (m) updateMessageBubble(m);
    toast('Too late to edit this one ⏰');
  } else if (status === 400 && data.error === 'not_editable') {
    editingMsgId = null;
    if (m) updateMessageBubble(m);
    toast('This message cannot be edited.');
  } else {
    toast('Could not edit.');
  }
}

function renderMessages() {
  const box = $('#messages');
  if (!box) return;
  closeReactPop();
  box.innerHTML = S.messages.map(bubbleHTML).join('');
  box.scrollTop = box.scrollHeight;
  hydrateMediaSrc(box);
  bindMessageActions(box);
  focusEditInput();
}

/* One bubble's media state changed (unlock flow) — refresh just it. */
function refreshMediaBubble(mediaId) {
  const m = S.messages.find((x) => x.media && x.media.id === mediaId);
  if (m) updateMessageBubble(m);
}

async function unlockMedia(mediaId) {
  if (unlockingIds.has(mediaId)) return; // double-tap guard: one tap, one charge attempt
  unlockingIds.add(mediaId);
  refreshMediaBubble(mediaId); // PPV tile flips to its "Unlocking…" state
  let status = 0, data = {};
  try {
    ({ status, data } = await api(`/media/${mediaId}/unlock`, { method: 'POST' }));
  } catch (e) { /* network error — handled as a failure below */ }
  unlockingIds.delete(mediaId);
  if (status === 200) {
    // Mark unlocked locally and refresh just that bubble
    S.messages.forEach((m) => {
      if (m.media && m.media.id === mediaId) m.media.unlocked = true;
    });
    refreshMediaBubble(mediaId);
    if (data.balance_cents != null && S.wallet) S.wallet.credits_cents = data.balance_cents;
    toast('🔓 Unlocked!');
  } else if (status === 402) {
    refreshMediaBubble(mediaId); // restore the tappable tile before routing away
    toast(`Need ${fmt(data.needed_cents)} — top up your wallet 💰`);
    if (S.user && S.user.role === 'fan') show('wallet', {});
  } else {
    refreshMediaBubble(mediaId); // restore the tappable tile
    toast('Could not unlock.');
  }
}

/* Composer bubble: auto-growing textarea in a pill, with ONE round action
   button in a fixed slot beside the pill (WhatsApp pattern) that swaps with
   the field's state — empty → 🎤 voice note, text → ↑ send. Both buttons
   live in the same reserved slot and cross-fade, so the swap never shifts
   the layout. The textarea auto-grows with content (capped, then scrolls). */
function syncChatComposer() {
  const input = $('#c-input'), btn = $('#c-send'), mic = $('#c-mic'), pill = $('#c-pill');
  if (!input || !pill) return;
  const hasText = input.value.length > 0;
  if (btn) btn.classList.toggle('show', hasText);
  if (mic) mic.classList.toggle('show', !hasText);
  input.style.height = 'auto';
  const sh = input.scrollHeight;
  input.style.height = Math.min(sh, 148) + 'px';
  pill.classList.toggle('grown', sh > 42);
}

/* Tab bar vanishes while any sheet/modal flow is open (PPV price sheet,
   voice recorder, gift/tip/FaceTime/booking sheets…) and
   pops back the moment it closes. A MutationObserver catches EVERY open and
   close path (send, cancel, backdrop tap, programmatic remove), so the state
   can never desync; leaving a view removes the sheet node, which restores
   the bar too. Sheets are: .sheet-backdrop modals (tip menu, gift, FaceTime,
   booking, priority, stage…) and the fixed overlays #ppv-price-overlay /
   #voice-ov / #tip-ov / #paywall. */
function syncSheetState() {
  const open = !!document.querySelector(
    '#ppv-price-overlay, #voice-ov, #tip-ov, #paywall, .sheet-backdrop');
  document.body.classList.toggle('sheet-open', open);
}
if (window.MutationObserver) {
  new MutationObserver(syncSheetState).observe(document.body,
    { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
}

async function sendMessage() {
  const input = $('#c-input');
  const text = input.value.trim();
  if (!text || !S.conv) return;
  input.value = '';
  syncChatComposer(); // collapse NOW, with the tap — not as a second jump after the reply lands
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
    if (!S.messages.find((x) => x.id === data.message.id)) S.messages.push(data.message);
    appendMessageBubble(data.message); // incremental — never rebuild the thread for one send
    pinChatScroll();
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

/* ---------------- PPV PRICE SHEET ---------------- */

// In-app price picker (replaces fragile prompt() which iOS often blocks)
function openPpvPriceSheet(file, kind) {
  const isVideo = kind === 'ppv_video';
  const label = isVideo ? 'video' : 'photo';
  const overlay = document.createElement('div');
  overlay.id = 'ppv-price-overlay';
  overlay.innerHTML = `
    <div class="crop-box">
      <div class="crop-title">Set unlock price</div>
      <div class="small muted" style="margin-bottom:12px">What should fans pay to unlock this ${label}?</div>
      <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-bottom:14px">
        ${[0, 2.99, 4.99, 9.99, 19.99].map((p) =>
          `<button class="btn small ghost ppv-price" data-p="${p}">${p === 0 ? 'Free' : '$' + p}</button>`).join('')}
      </div>
      <label class="field" style="text-align:left">Custom price ($1–$100, or 0 for free)
        <input class="input" id="ppv-custom-price" type="number" min="0" max="100" step="0.01" placeholder="4.99">
      </label>
      <div class="crop-actions">
        <button class="btn ghost" id="ppv-price-cancel">Cancel</button>
        <button class="btn" id="ppv-price-send">Send 🔒</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  let chosen = null;
  overlay.querySelectorAll('.ppv-price').forEach((b) => {
    b.onclick = () => {
      overlay.querySelectorAll('.ppv-price').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      chosen = parseFloat(b.dataset.p);
      overlay.querySelector('#ppv-custom-price').value = '';
    };
  });
  overlay.querySelector('#ppv-price-cancel').onclick = () => overlay.remove();
  overlay.querySelector('#ppv-price-send').onclick = () => {
    let price = chosen;
    const custom = overlay.querySelector('#ppv-custom-price').value.trim();
    if (custom !== '') price = parseFloat(custom);
    if (price === null || price === undefined || !Number.isFinite(price)) price = 4.99;
    const cents = Math.round(price * 100);
    if (cents !== 0 && (cents < 100 || cents > 10000)) {
      toast('Enter 0 for free, or $1–$100');
      return;
    }
    overlay.remove();
    uploadMedia(file, kind, cents, 0);
  };
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
      if (!S.messages.find((x) => x.id === data.message.id)) S.messages.push(data.message);
      appendMessageBubble(data.message);
      pinChatScroll();
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

/* Voice flow is OVERLAY-FIRST: the card is created synchronously inside the
   tap handler, in a "connecting" state, BEFORE getUserMedia is called — so a
   tap can never produce "nothing". When the stream resolves, the card swaps
   to the Recording UI; on ANY failure (unsupported browser, a synchronous
   throw, a rejected/hung permission request) it swaps to a persistent error
   card with the plain-language reason and a Close button.
   Why: the old mic-first flow gated ALL feedback behind the getUserMedia
   promise. Where navigator.mediaDevices is undefined (some iOS home-screen
   webviews expose no mediaDevices at all), `navigator.mediaDevices
   .getUserMedia` throws synchronously — no prompt, no promise, no .catch
   toast, no overlay: the tap died in total silence. Where mediaDevices
   exists but the webview never presents the permission UI, the promise can
   hang unsettled — same visible result. */
function startVoiceRecord() {
  const session = { cancelled: false, stream: null };
  const ov = showVoiceOverlay(session);
  if (!ov) { toast("Mic couldn't start — try again 🎤", 4000); return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia
      || typeof MediaRecorder === 'undefined') {
    voiceOverlayError(ov, "Voice notes aren't supported in this browser. Try opening SlutCamp in Safari or Chrome, then tap the mic again 🎤");
    return;
  }
  let gum;
  try {
    gum = navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    voiceOverlayError(ov, "The mic couldn't start. Close this and try again 🎤");
    return;
  }
  Promise.resolve(gum).then((stream) => {
    if (session.cancelled || !ov.isConnected) { // card closed while asking
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    session.stream = stream;
    startVoiceUI(stream, ov);
  }).catch((err) => {
    if (session.cancelled || !ov.isConnected) return;
    const name = err && err.name;
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      voiceOverlayError(ov, 'Your mic is blocked for SlutCamp. In Safari: tap the icon at the left of the address bar → Website Settings → Microphone → Allow. Or open iPhone Settings → Safari → Microphone → Allow. Then try again 🎤');
    } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      voiceOverlayError(ov, 'No microphone found on this device 🎤');
    } else {
      voiceOverlayError(ov, "The mic couldn't start. Close this and try again 🎤");
    }
  });
}

/* The voice overlay shell + its "connecting" card. Cancel here also covers
   the permission-prompt wait: it flags the session so a late stream is
   stopped and discarded instead of swapping a dead card into Recording. */
function showVoiceOverlay(session) {
  const old = $('#voice-ov');
  if (old) old.remove();
  const ov = document.createElement('div');
  ov.id = 'voice-ov';
  ov.style.cssText = 'position:fixed;inset:0;z-index:150;background:rgba(16,6,12,.55);display:flex;align-items:center;justify-content:center;padding:20px';
  ov.innerHTML = `
    <div class="card" id="voice-card" style="max-width:340px;text-align:center">
      <div style="font-size:40px">🎤</div>
      <h3 style="margin:8px 0">Getting your mic ready…</h3>
      <p class="muted small">If your phone asks to use the microphone, tap <b>Allow</b> 🎤</p>
      <button class="btn ghost" id="voice-conn-cancel">Cancel</button>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector('#voice-conn-cancel').onclick = () => {
    session.cancelled = true;
    if (session.stream) session.stream.getTracks().forEach((t) => t.stop());
    ov.remove();
  };
  return ov;
}

/* Failure state INSIDE the overlay card (never just a toast): the specific
   reason in plain language + a Close button the user dismisses themselves. */
function voiceOverlayError(ov, msg) {
  const card = ov && ov.querySelector('#voice-card');
  if (!card) { toast(msg, 4500); return; }
  card.innerHTML = `
    <div style="font-size:40px">🎤</div>
    <h3 style="margin:8px 0">Voice note didn't start</h3>
    <p class="small" style="line-height:1.5;text-align:left">${msg}</p>
    <button class="btn" id="voice-err-close" style="width:100%">Close</button>`;
  card.querySelector('#voice-err-close').onclick = () => ov.remove();
}

/* Recorder hint: models see their note is free for the fan to hear; fans
   see their send cost up front (the server charges the model's per-voice
   price like a text charge). The fan's price is read from conv.other when
   present; if not in scope, fall back to the neutral text. */
function voiceHintText() {
  if (S.user && S.user.role === 'model')
    return 'He hears it free 💋';
  const cents = (S.model && S.model.per_voice_cents != null) ? S.model.per_voice_cents
    : (S.conv && S.conv.other && S.conv.other.per_voice_cents != null)
      ? S.conv.other.per_voice_cents : null;
  return cents != null ? `Costs ${fmt(cents)} — comes out of your balance` : 'Sent as a message';
}

function startVoiceUI(stream, ov) {
  const card = ov.querySelector('#voice-card');
  if (!card) { stream.getTracks().forEach((t) => t.stop()); return; }
  card.innerHTML = `
      <div style="font-size:40px" id="voice-mic">🎤</div>
      <h3 style="margin:8px 0">Recording… <span id="voice-secs">0s</span></h3>
      <p class="muted small" id="voice-hint">${voiceHintText()}</p>
      <button class="btn" id="voice-stop">Send voice note</button>
      <button class="btn ghost" id="voice-cancel">Cancel</button>`;

  try {
    const mime = MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4'
      : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
    voiceRec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop());
    voiceOverlayError(ov, 'Voice recording is not supported on this device 🎤');
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
  ov.style.cssText = 'position:fixed;inset:0;z-index:150;background:rgba(16,6,12,.55);display:flex;align-items:center;justify-content:center;padding:20px';
  ov.innerHTML = `
    <div class="card" style="max-width:340px;text-align:center">
      <div style="font-size:44px">🎁</div>
      <h3 style="margin:8px 0">Tip ${esc(S.conv.other.display_name)}</h3>
      <p class="muted small">She gets 60% instantly.</p>
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

/* Call media plumbing shared by FaceTime, chat calls and bookings.
 * The three helpers below exist because of the Oct 14 black-stage bug:
 *  - wireRemoteVideo: ontrack used to ONLY assign srcObject. iOS Safari
 *    will not autoplay an UNMUTED element whose stream is assigned in
 *    code (the muted local preview always played, the remote stage sat
 *    black). Always play() explicitly; if the browser still refuses,
 *    turn the status pill into a tap-to-play button.
 *  - ICE buffering: candidates that arrive before the peer connection
 *    exists or has a remote description used to be silently discarded.
 *    The model does an HTTP round-trip (/facetime/incoming) between the
 *    invite and creating her pc, which reliably ate the fan's first
 *    (host/srflx) candidates. Buffer them, flush after setRemoteDescription.
 *  - Waiting state: a call with no rendering remote video must say so
 *    ("Waiting for her camera…") instead of an infinite black stage. */
let pendingIce = [];            // [{call_id, candidate}] until pc can take them
let callWaitTimer = null;       // 8s "no remote track yet" watchdog
let remoteLive = false;         // remote video actually playing
let remoteTrackSeen = false;    // a remote VIDEO track has arrived at all
let callPeerMediaError = false; // peer told us their camera/mic failed
let callConnTimer = null;       // media-plane supervision deadline (10s)
let callConnFailed = false;     // connection-failure state is on screen

function signalTo(to, payload) {
  if (S.ws && to != null) S.ws.send(JSON.stringify({ type: 'signal', to, payload }));
}

function showCallStatus(text, onTap) {
  const el = $('#call-status');
  if (!el) return;
  el.textContent = text;
  el.onclick = onTap || null;
  el.classList.toggle('tappable', !!onTap);
  el.classList.remove('hidden');
}
function hideCallStatus() {
  const el = $('#call-status');
  if (el) { el.classList.add('hidden'); el.onclick = null; el.classList.remove('tappable'); }
}
function callPeerNoun() { return S.call && S.call.role === 'fan' ? 'her' : 'his'; }
function armCallWaiting() {
  remoteLive = false;
  remoteTrackSeen = false;
  callPeerMediaError = false;
  clearTimeout(callWaitTimer);
  callWaitTimer = setTimeout(() => {
    // Track-ARRIVAL based only (owner ruling, Oct 14): if any remote video
    // track has landed, media is flowing — the label must never appear,
    // even if her room is dark and the picture looks black. It exists
    // solely for "nothing has arrived at all."
    if (S.call && !remoteTrackSeen && !callPeerMediaError)
      showCallStatus(`Waiting for ${callPeerNoun()} camera…`);
  }, 8000);
}
function markRemoteLive() {
  remoteLive = true;
  callPeerMediaError = false;
  clearTimeout(callWaitTimer);
  hideCallStatus();
}
function tryPlayRemote() {
  const vid = $('#remote-video');
  if (!vid || !vid.srcObject) return;
  const p = vid.play();
  if (p && p.catch) p.catch(() => {
    if (S.call && !remoteLive)
      showCallStatus(`▶ Tap to see ${callPeerNoun() === 'her' ? 'her' : 'him'}`,
        () => { vid.play().then(() => markRemoteLive()).catch(() => {}); });
  });
}
function showCallConnFailed() {
  callConnFailed = true;
  showCallStatus('⚠️ Camera connection failed — check your connection and try again');
}
function pcConnected(pc_) {
  return pc_.connectionState === 'connected'
    || pc_.iceConnectionState === 'connected' || pc_.iceConnectionState === 'completed';
}

function wireRemoteVideo(pc_) {
  /* Media-plane supervision. The Oct 14 FaceTime call ran its whole
   * state machine (accept → active → ticks) while NO media flowed in
   * either direction — and nothing in either client ever looked at the
   * peer connection's state, so a media-less call presented as a healthy
   * video call. Now every call pc is supervised: not connected within
   * ~10s of the call starting, or a drop to 'failed' at any point, puts
   * an honest failure state on THIS side's screen (both sides run this,
   * so both sides learn). Billing is untouched — surfacing only. */
  callConnFailed = false;
  clearTimeout(callConnTimer);
  callConnTimer = setTimeout(() => {
    if (S.call && pc === pc_ && !pcConnected(pc_)) showCallConnFailed();
  }, 10000);
  pc_.onconnectionstatechange = () => {
    if (pc !== pc_ || !S.call) return;
    const st = pc_.connectionState;
    if (st === 'connected') {
      clearTimeout(callConnTimer);
      if (callConnFailed) { callConnFailed = false; hideCallStatus(); }
    } else if (st === 'failed') {
      clearTimeout(callConnTimer);
      showCallConnFailed();
    } else if (st === 'disconnected' && !callConnFailed) {
      showCallStatus('📶 Connection dropped — reconnecting…');
    }
  };
  pc_.ontrack = (e) => {
    const vid = $('#remote-video');
    if (e.streams && e.streams[0]) vid.srcObject = e.streams[0];
    if (e.track && e.track.kind === 'video') {
      // A track landed — media is flowing, whatever it looks like (a dark
      // room is near-black video, not a broken call). The waiting label
      // is cancelled for good and cleared if it was somehow up.
      remoteTrackSeen = true;
      clearTimeout(callWaitTimer);
      if (!callPeerMediaError && !remoteLive) hideCallStatus();
      e.track.onunmute = () => tryPlayRemote();
      e.track.onmute = () => {
        if (S.call && remoteLive)
          showCallStatus(`⏸ ${callPeerNoun() === 'her' ? 'Her' : 'His'} camera paused…`);
      };
      e.track.onended = () => {
        if (!S.call) return;
        remoteLive = false;
        showCallStatus(`⚠️ ${callPeerNoun() === 'her' ? 'Her' : 'His'} camera stopped — waiting…`);
      };
    }
    tryPlayRemote();
  };
}
async function addIce(candidate) {
  if (!pc || !pc.remoteDescription || !S.call) {
    pendingIce.push({ call_id: S.call ? S.call.id : null, candidate });
    return;
  }
  try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (e) { /* stale */ }
}
async function flushIce() {
  if (!pc || !pc.remoteDescription || !S.call) return;
  const mine = pendingIce.filter((x) => x.call_id === S.call.id);
  pendingIce = pendingIce.filter((x) => x.call_id !== S.call.id);
  for (const x of mine) {
    try { await pc.addIceCandidate(new RTCIceCandidate(x.candidate)); } catch (e) { /* stale */ }
  }
}

/* Blocking "your camera didn't start" card (model side). The fan is told
 * via a media-error signal; she gets real instructions + a retry that
 * re-runs acceptCall() with the saved offer. Never a silent phantom join. */
function showCallError(kind) {
  const el = $('#call-error');
  if (!el) return;
  $('#call-error-title').textContent =
    kind === 'media' ? '📹 Camera blocked' : '📶 Connection failed';
  $('#call-error-text').textContent = kind === 'media'
    ? "SlutCamp couldn't reach your camera/mic, so he can't see you — he's staring at a black screen. Allow camera & mic access for this site (your browser's site settings), then tap Try again."
    : "The call couldn't connect just now. Check your signal, then tap Try again — he's still waiting.";
  el.classList.remove('hidden');
}
function hideCallError() {
  const el = $('#call-error');
  if (el) el.classList.add('hidden');
}

function updateCallHUD() {
  if (!S.call) return;
  const s = S.call.seconds || 0;
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  const t = $('#call-timer'), c = $('#call-cost');
  if (t) t.textContent = S.call.prepaidMin
    ? `${mm}:${ss} · ${S.call.remainingMin != null ? S.call.remainingMin : S.call.prepaidMin} min left`
    : `${mm}:${ss}`;
  if (c) c.textContent = (S.call.prepaidMin
    ? `📹 FaceTime ${S.call.prepaidMin} min`
    : `~${fmt((S.call.minutes || 0) * S.call.rate)}`) + (S.call.explicit ? ' · 🔞 EXPLICIT' : '');
  updateJoinCountdown();
}

/* The fan's 3-minute join window on a booking call (deadline stamped by
   the server at activation). Render-only — the kill is server-side. */
function updateJoinCountdown() {
  const el = $('#call-join-timer');
  if (!el) return;
  const dl = S.call && S.call.joinDeadline;
  if (!dl || remoteLive) { el.classList.add('hidden'); return; }
  const left = Math.max(0, Math.round((dl - Date.now()) / 1000));
  const mm = Math.floor(left / 60), ss = String(left % 60).padStart(2, '0');
  el.textContent = S.call.role === 'model'
    ? `⏳ Waiting for him to join — ${mm}:${ss} left`
    : `⏳ Waiting for her to pick up — ${mm}:${ss} left`;
  el.classList.remove('hidden');
}

/* Live M:SS for [data-join-cd] countdowns (the fan's join window on the
   Bookings tab). When one hits zero, refresh the bookings view once —
   the server sweep resolves the booking within seconds. */
setInterval(() => {
  document.querySelectorAll('[data-join-cd]').forEach((el) => {
    const left = Math.max(0, Math.round((parseInt(el.dataset.joinCd) - Date.now()) / 1000));
    el.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    if (left === 0 && !el.dataset.cdDone) {
      el.dataset.cdDone = '1';
      if (S.view === 'bookings') show('bookings', {});
    }
  });
}, 1000);

/* ---------------- FaceTime: prepaid requests + queue ---------------- */
const FACETIME_DURATIONS = [10, 15, 30, 45, 60];
let ftPoll = null;
let ftMine = null;

function ftSheet(html) {
  let s = $('#ft-sheet');
  if (s) s.remove();
  s = document.createElement('div');
  s.id = 'ft-sheet';
  s.className = 'sheet-backdrop';
  s.innerHTML = `<div class="sheet">${html}</div>`;
  s.addEventListener('click', (e) => { if (e.target === s) s.remove(); });
  document.body.appendChild(s);
  return s;
}
function ftCloseSheet() { const s = $('#ft-sheet'); if (s) s.remove(); }

function openFaceTimeSheet() {
  const other = S.conv && S.conv.other;
  if (!other) return;
  const rate = other.per_minute_cents || 0;
  ftSheet(`<div class="sheet-title">📹 FaceTime ${esc(other.display_name)}</div>
    <div class="muted small" style="margin-bottom:10px">Pay upfront — if she accepts, you're on. If she's in a call, you take a spot in line and we'll tell you your place + the wait. Full refund if she declines or it doesn't happen.</div>
    ${FACETIME_DURATIONS.map((d) => `
      <button class="sheet-btn ft-dur" data-d="${d}">📹 ${d} minutes<span class="sheet-btn-sub">${fmt(rate * d)}</span></button>`).join('')}`);
  document.querySelectorAll('.ft-dur').forEach((b) => {
    b.onclick = async () => {
      ftCloseSheet();
      const { status, data } = await api('/facetime/request', { method: 'POST',
        body: JSON.stringify({ model_id: other.id, duration_min: Number(b.dataset.d) }) });
      if (status !== 200) {
        if (data.error === 'model_live')
          return toast(data.message || "🔴 She's live — FaceTime is locked during lives. Join her stage or book a 1-on-1!", 5000);
        if (data.error === 'model_offline') return toast('She is offline right now.');
        if (data.error === 'insufficient_credits') return showBuyCredits(data.needed_cents);
        if (data.error === 'already_requested') {
          toast('You already have a FaceTime request with her ⏳');
          return refreshFtPanel();
        }
        if (data.error === 'already_in_line') {
          toast(data.message || "You're already in line with another model ⏳", 4500);
          return refreshFtPanel();
        }
        if (data.error === 'chat_paused') return toast('Chat is paused by the safety monitor.');
        return toast('Could not send the FaceTime request.');
      }
      toast('FaceTime request sent 📹');
      if (S.wallet) refreshMe();
      updateFtPanel(data.request);
    };
  });
}

function ftPanelEl() {
  let el = $('#ft-panel');
  if (!el) {
    el = document.createElement('div');
    el.id = 'ft-panel';
    el.className = 'ft-panel hidden';
    document.body.appendChild(el);
  }
  return el;
}
function startFtPoll() { if (!ftPoll) ftPoll = setInterval(refreshFtPanel, 5000); }
function stopFtPoll() { if (ftPoll) { clearInterval(ftPoll); ftPoll = null; } }

let ftPanelMin = false;

function updateFtPanel(req, reason) {
  const el = ftPanelEl();
  if (!req || ['done', 'declined', 'cancelled', 'expired'].includes(req.status)) {
    ftPanelMin = false;
    const wasActive = !!(ftMine && req && ftMine.id === req.id && ftMine.status !== req.status);
    el.classList.add('hidden');
    stopFtPoll();
    ftMine = null;
    if (wasActive && req) {
      if (req.status === 'declined') toast(`${req.model_name} declined the FaceTime — you were refunded.`, 4000);
      else if (req.status === 'expired') toast('No answer — FaceTime expired, you were refunded.', 4000);
      else if (req.status === 'cancelled' && reason === 'she went live')
        toast(`🔴 ${req.model_name} went live — FaceTime refunded. Join her stage or book a 1-on-1!`, 5000);
      else if (req.status === 'cancelled' && reason === 'she went offline')
        toast(`${req.model_name} went offline — FaceTime refunded.`, 4000);
      else if (req.status === 'cancelled') toast('Your FaceTime turn passed — you were refunded.', 4000);
      refreshMe();
    }
    return;
  }
  ftMine = req;
  if (req.status === 'in_call') { el.classList.add('hidden'); stopFtPoll(); return; }
  el.classList.remove('hidden');
  if (ftPanelMin && req.status === 'queued') {
    // Minimized to a slim pill — he can browse; state restores on tap.
    el.innerHTML = `<div class="ft-line" id="ft-expand" style="cursor:pointer">📹 <b>#${req.position}</b> ${t('bk_waiting_line')} · ~${req.eta_min} ${t('bk_min_wait')} — tap to view</div>`;
    const x = $('#ft-expand');
    if (x) x.onclick = () => { ftPanelMin = false; updateFtPanel(ftMine); };
    startFtPoll();
    return;
  }
  if (req.status === 'pending') {
    el.innerHTML = `<div class="ft-line">⏳ <b>Waiting for ${esc(req.model_name)}</b> to accept your ${req.duration_min}-min FaceTime…</div>
      <div class="ft-sub">Paid ${fmt(req.amount_cents)} · she's got it in her notifications — full refund if she declines or you cancel</div>
      <button class="btn ghost small" id="ft-cancel">Cancel &amp; refund</button>`;
  } else if (req.status === 'queued') {
    el.innerHTML = `<div class="row" style="width:100%;align-items:flex-start">
        <div class="ft-line grow">📹 <b>${t('bk_in_line')} ${esc(req.model_name)}</b> 💋</div>
        <button class="ft-min" id="ft-min" title="Minimize">–</button></div>
      <div class="ft-line" style="font-size:17px"><b>#${req.position}</b> · ${t('bk_turn_in')} <b>${req.eta_min} ${t('bk_min_wait')}</b></div>
      <div class="ft-sub">Your ${req.duration_min}-min FaceTime starts the moment hers ends · paid ${fmt(req.amount_cents)}</div>
      <button class="btn ghost small" id="ft-cancel">${t('bk_leave_line')}</button>`;
    const mn = $('#ft-min');
    if (mn) mn.onclick = () => { ftPanelMin = true; updateFtPanel(ftMine); };
  } else if (req.status === 'invited') {
    el.innerHTML = `<div class="ft-line">💚 <b>${esc(req.model_name)} is ready for you!</b></div>
      <div class="ft-sub">Join now — the spot passes to the next fan in ~90 seconds</div>
      <button class="btn" id="ft-join">${t('bk_start_now')}</button>
      <button class="btn ghost small" id="ft-cancel">Cancel &amp; refund</button>`;
    const j = $('#ft-join');
    if (j) j.onclick = joinFtCall;
  }
  const c = $('#ft-cancel');
  if (c) c.onclick = async () => {
    await api(`/facetime/${req.id}/cancel`, { method: 'POST' }).catch(() => {});
    el.classList.add('hidden');
    stopFtPoll();
    ftMine = null;
    ftPanelMin = false;
    toast('FaceTime cancelled — refunded.');
    refreshMe();
  };
  startFtPoll();
}

async function refreshFtPanel() {
  if (!S.user || S.user.role !== 'fan') return;
  try {
    const { data } = await api('/facetime/queue/me');
    if (data.request) updateFtPanel(data.request);
    else { ftPanelEl().classList.add('hidden'); stopFtPoll(); ftMine = null; ftPanelMin = false; }
  } catch (e) { /* ignore */ }
}

async function joinFtCall() {
  if (!ftMine) return;
  const req = ftMine;
  const { status, data } = await api(`/facetime/${req.id}/join`, { method: 'POST' });
  if (status !== 200) {
    toast('That spot expired — checking your refund…');
    return refreshFtPanel();
  }
  ftPanelEl().classList.add('hidden');
  stopFtPoll();
  beginCallMedia(data.call_id, data.rate_cents, req.model_id, data.prepaid_min);
}

/* Model side: FaceTime request popup (Accept / Decline). Shows on the
   live WS event (and when she taps the request in her notification box),
   stays ~9 seconds, then dismisses ITSELF — dismissal is not a decline:
   the request lives on, actionable, in her notification box until she
   acts, the fan cancels, or her session ends (owner ruling, Oct 15). */
let ftPopupTimer = null;
function showFtRequestCard(req) {
  if (!req || req.status !== 'pending') return;
  hideFtRequestCard();
  const el = document.createElement('div');
  el.id = 'ft-req-modal';
  el.className = 'ft-req-modal';
  el.innerHTML = `<div class="ft-req-card">
      <div style="font-size:32px">📹</div>
      <div class="ft-req-title">${esc(req.fan_name)} wants FaceTime</div>
      <div class="muted">${req.duration_min} minutes · ${fmt(req.amount_cents)} — already paid 💰</div>
      <div class="muted small">If you're in a call, Accept puts him in line. No rush — this also waits in your 🔔 notifications.</div>
      <div class="ft-req-actions">
        <button class="btn" id="ft-acc">Accept ✅</button>
        <button class="btn ghost" id="ft-dec">Decline</button>
      </div>
    </div>`;
  document.body.appendChild(el);
  $('#ft-acc').onclick = () => ftDoAccept(req);
  $('#ft-dec').onclick = () => ftDoDecline(req);
  ftPopupTimer = setTimeout(hideFtRequestCard, 9000);
}
function hideFtRequestCard() {
  if (ftPopupTimer) { clearTimeout(ftPopupTimer); ftPopupTimer = null; }
  const el = $('#ft-req-modal');
  if (el) el.remove();
}
/* Shared by the popup AND the notification-box actions, so both surfaces
   behave identically: busy → he joins her line and she sees his wait;
   free → the normal invited/ring flow. Decline refunds him in full. */
async function ftDoAccept(req) {
  const { status, data } = await api(`/facetime/${req.id}/accept`, { method: 'POST' });
  hideFtRequestCard();
  if (status === 200 && data && data.queued) {
    toast(`He's in your line — #${data.request.position} · about ${data.request.eta_min} min until he's next 📹`, 5000);
  } else if (status === 200) {
    toast("Accepted — he's joining now 📹");
  } else {
    toast('That request is no longer waiting.', 3000);
  }
  refreshFtCard();
  return data;
}
async function ftDoDecline(req) {
  await api(`/facetime/${req.id}/decline`, { method: 'POST' }).catch(() => {});
  hideFtRequestCard();
  toast('Declined — he was refunded.');
  refreshFtCard();
}
async function refreshFtCard() {
  if (!S.user || S.user.role !== 'model') return;
  try {
    const { data } = await api('/facetime/incoming');
    // Pending requests are NOT re-popped here: the popup is a one-shot
    // WS moment; unanswered requests persist in her notification box.
    updateModelFtQueue((data.requests || []).filter((r) => ['queued', 'invited'].includes(r.status)));
    if (S.view === 'notifications') show('notifications', {});
  } catch (e) { /* ignore */ }
}

/* Model side: her FaceTime line — who's waiting, in what order, with a
   Remove (refunds him) per waiter. Visible during calls too, so she can
   manage the line without leaving the call screen. */
let ftQueuePoll = null;
function ftQueuePanelEl() {
  let el = $('#ft-queue-panel');
  if (!el) {
    el = document.createElement('div');
    el.id = 'ft-queue-panel';
    el.className = 'ft-panel ft-queue-panel hidden';
    document.body.appendChild(el);
  }
  return el;
}
function updateModelFtQueue(line) {
  const el = ftQueuePanelEl();
  if (!S.user || S.user.role !== 'model' || !line || !line.length) {
    el.classList.add('hidden');
    if (ftQueuePoll) { clearInterval(ftQueuePoll); ftQueuePoll = null; }
    return;
  }
  el.classList.remove('hidden');
  el.innerHTML = `<div class="ft-line">📹 <b>Your FaceTime line</b> (${line.length})</div>` +
    line.map((r, i) => `
      <div class="ft-q-row">
        <span class="grow">${r.status === 'invited' ? '💚' : `<b>#${i + 1}</b>`} ${esc(r.fan_name)} · ${r.duration_min} min${r.status === 'invited' ? ' · invited — joining…' : ''}</span>
        ${r.status === 'queued' ? `<button class="btn ghost small" data-qremove="${r.id}">${t('bk_remove')}</button>` : ''}
      </div>`).join('');
  el.querySelectorAll('[data-qremove]').forEach((b) => b.onclick = async () => {
    await api(`/facetime/${b.dataset.qremove}/decline`, { method: 'POST' }).catch(() => {});
    toast('Removed from your line — he was refunded.');
    refreshFtCard();
  });
  if (!ftQueuePoll) ftQueuePoll = setInterval(refreshFtCard, 5000);
}

/* Mid-call explicit switch (model offers, fan pays the uplift) */
function syncExplicitBtn() {
  const hud = document.querySelector('#active-call .call-hud');
  if (!hud) return;
  let btn = $('#call-explicit-btn');
  const show = !!(S.call && S.user && S.user.role === 'model' && !S.call.bookingId);
  if (!show) { if (btn) btn.remove(); return; }
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'call-explicit-btn';
    btn.className = 'btn small';
    btn.style.background = 'linear-gradient(135deg,#ef4444,#ec4899)';
    btn.style.marginLeft = '8px';
    hud.appendChild(btn);
    btn.onclick = requestExplicit;
  }
  if (S.call.explicit) { btn.textContent = '🔞 Explicit ON'; btn.disabled = true; }
  else if (S.call.explicitPending) { btn.textContent = '🔞 Offer sent…'; btn.disabled = true; }
  else { btn.textContent = '🔞 Go explicit'; btn.disabled = false; }
}
async function requestExplicit() {
  if (!S.call) return;
  const { status } = await api(`/calls/${S.call.id}/explicit-request`, { method: 'POST' });
  if (status !== 200) return toast('Could not send the explicit offer.');
  S.call.explicitPending = true;
  syncExplicitBtn();
  toast("Offer sent — he pays the uplift for the rest of the call 🔞", 4000);
}
function showExplicitOffer(m) {
  const txt = m.remaining_min != null
    ? `Pay ${fmt(m.extra_cents)} and the rest of this call (${m.remaining_min} min) goes explicit 🔞`
    : `Explicit is double per minute (${fmt(m.per_min_cents * 2)}/min) from now on 🔞`;
  ftSheet(`<div class="sheet-title">🔞 She wants to get explicit</div>
    <div class="muted small" style="margin-bottom:12px">${txt}</div>
    <button class="sheet-btn" id="exp-yes">💦 Yes — go explicit</button>
    <button class="sheet-btn" id="exp-no">Stay normal</button>`);
  $('#exp-yes').onclick = async () => {
    ftCloseSheet();
    const { status } = await api(`/calls/${m.call_id}/explicit-accept`, { method: 'POST' });
    if (status === 402) { toast('Not enough credits for explicit 😕'); return showBuyCredits(m.extra_cents); }
    if (status !== 200) toast('Could not switch to explicit.');
    else refreshMe();
  };
  $('#exp-no').onclick = async () => {
    ftCloseSheet();
    await api(`/calls/${m.call_id}/explicit-decline`, { method: 'POST' }).catch(() => {});
  };
}

async function beginCallMedia(callId, rateCents, modelId, prepaidMin) {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (e) {
    // He already joined server-side (call row + FaceTime request exist).
    // Release the call so it closes out — an unstarted FaceTime refunds —
    // instead of leaving her side waiting on a call that can't happen.
    await api(`/calls/${callId}/end`, { method: 'POST' }).catch(() => {});
    return toast('📹 Camera/mic blocked — allow camera access for this site, then try again. The FaceTime never started, so you were refunded.', 6000);
  }
  try {
    pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
    pc.onicecandidate = (e) => {
      if (e.candidate && S.ws) S.ws.send(JSON.stringify({ type: 'signal', to: modelId,
        payload: { kind: 'ice', call_id: callId, candidate: e.candidate } }));
    };
    wireRemoteVideo(pc);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    S.ws.send(JSON.stringify({ type: 'signal', to: modelId,
      payload: { kind: 'invite', call_id: callId, sdp: offer,
                 from_name: S.user.display_name, rate: rateCents } }));
  } catch (e) {
    await api(`/calls/${callId}/end`, { method: 'POST' }).catch(() => {});
    if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
    if (pc) { try { pc.close(); } catch (err) {} pc = null; }
    return toast('Could not start the call — the FaceTime never started, so you were refunded.', 5000);
  }
  S.call = { id: callId, rate: rateCents, seconds: 0, minutes: 0, role: 'fan',
             prepaidMin: prepaidMin || 0, remainingMin: prepaidMin || null };
  $('#active-call').classList.remove('hidden');
  $('#local-video').srcObject = localStream;
  $('#call-timer').textContent = 'Calling…';
  armCallWaiting();
  callTimerInt = setInterval(() => { if (S.call) { S.call.seconds++; updateCallHUD(); } }, 1000);
  toast('Calling… waiting for her to pick up 📞');
}

async function handleSignal(m) {
  const p = m.payload || {};
  if (p.kind === 'invite') {
    // Incoming call — only models get these (fans never receive invites in v1)
    if (!S.user || S.user.role !== 'model') return;
    S.call = { id: p.call_id, rate: p.rate, seconds: 0, minutes: 0, role: 'model',
               from: m.from, fromName: p.from_name, offer: p.sdp };
    // FaceTime she already accepted: no second ring — connect straight away.
    try {
      const { data } = await api('/facetime/incoming');
      const match = (data.requests || []).find((r) => r.call_id === p.call_id && r.status === 'in_call');
      if (match) {
        S.call.prepaidMin = match.duration_min;
        S.call.remainingMin = match.duration_min;
        acceptCall();
        return;
      }
    } catch (e) { /* fall through to the ring */ }
    $('#call-name').textContent = p.from_name || 'Fan';
    $('#call-avatar').outerHTML = avatarHTML(p.from_name || '?', 'xl').replace('class="avatar xl"', 'id="call-avatar" class="avatar xl"');
    $('#call-overlay').classList.remove('hidden');
    return;
  }
  if (!S.call || p.call_id !== S.call.id) return;
  try {
    if (p.kind === 'answer' && pc) {
      await pc.setRemoteDescription(new RTCSessionDescription(p.sdp));
      await flushIce();
    }
    else if (p.kind === 'ice') await addIce(p.candidate);
    else if (p.kind === 'media-error') {
      // Her camera/mic never started — say so instead of a silent black stage.
      callPeerMediaError = true;
      clearTimeout(callWaitTimer);
      showCallStatus(S.call.role === 'fan'
        ? "⚠️ Her camera is blocked — she's seeing how to fix it"
        : "⚠️ His camera is blocked — he's seeing how to fix it");
    }
    else if (p.kind === 'hangup') endCallUI('Call ended.');
  } catch (e) { /* ignore stale signaling */ }
}

async function acceptCall() {
  $('#call-overlay').classList.add('hidden');
  hideCallError();
  if (!S.call) return;
  // Re-entrant (the error card's Try again lands here): tear down any
  // half-built attempt before rebuilding, so a retry can't leak pcs/streams.
  if (pc) { try { pc.close(); } catch (e) {} pc = null; }
  if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (e) {
    // NEVER phantom-join: the fan must learn her camera didn't start
    // (media-error), and she gets a blocking card with the fix + a retry —
    // not a toast that vanishes while he stares at a black stage.
    signalTo(S.call.from, { kind: 'media-error', call_id: S.call.id,
      reason: (e && e.name) || 'denied' });
    showCallError('media');
    return;
  }
  const to = S.call.from;
  try {
    pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
    pc.onicecandidate = (e) => {
      if (e.candidate && S.ws) S.ws.send(JSON.stringify({ type: 'signal', to,
        payload: { kind: 'ice', call_id: S.call.id, candidate: e.candidate } }));
    };
    wireRemoteVideo(pc);
    await pc.setRemoteDescription(new RTCSessionDescription(S.call.offer));
    await flushIce();
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    S.ws.send(JSON.stringify({ type: 'signal', to, payload: { kind: 'answer', call_id: S.call.id, sdp: answer } }));
    await api(`/calls/${S.call.id}/accept`, { method: 'POST' }); // starts billing clock
  } catch (e) {
    // SDP/connect failure used to be an unhandled rejection = the same
    // silent black stage on his side. Surface it on both sides instead.
    if (pc) { try { pc.close(); } catch (err) {} pc = null; }
    if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
    signalTo(to, { kind: 'media-error', call_id: S.call.id, reason: 'connect' });
    showCallError('connect');
    return;
  }
  $('#active-call').classList.remove('hidden');
  $('#local-video').srcObject = localStream;
  syncExplicitBtn();
  armCallWaiting();
  callTimerInt = setInterval(() => { if (S.call) { S.call.seconds++; updateCallHUD(); } }, 1000);
}

function declineCall() {
  $('#call-overlay').classList.add('hidden');
  hideCallError();
  pendingIce = [];
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
  hideCallError();
  hideCallStatus();
  const jt = $('#call-join-timer');
  if (jt) jt.classList.add('hidden');
  clearInterval(callTimerInt);
  clearTimeout(callWaitTimer);
  clearTimeout(callConnTimer);
  pendingIce = [];
  remoteLive = false;
  remoteTrackSeen = false;
  callPeerMediaError = false;
  callConnFailed = false;
  if (pc) { try { pc.close(); } catch (e) {} pc = null; }
  if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
  $('#remote-video').srcObject = null;
  S.call = null;
  syncExplicitBtn();
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
             brb: false,
             title: data.title || '', chat: [], gifts: [], leaderboard: [] };
  // If she stepped away before the disconnect, land back on the BRB state
  // (mutes her fresh tracks + stops the safety bots until she resumes).
  if (data.brb) applyLiveBrb(true);
  show('liveBroadcast', {});
  loadStreamChat();
  loadLeaderboard();
  toast('🔴 Back live! Welcome back 🎉');
  if (!S.live.brb) {
    startSpeechSafetyBot(sessionId);
    startAudioChunkBot(sessionId);
  }
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
             explicitRate: data.explicit_rate_cents, isExplicit: false, brb: false,
             title: data.title || '', chat: [], gifts: [], leaderboard: [] };
  show('liveBroadcast', {});
  loadStreamChat();
  loadLeaderboard();
  toast('🔴 You are LIVE! Chat is free for fans — gifts = money 💰');
  startSpeechSafetyBot(data.session_id);
  startAudioChunkBot(data.session_id);
}

/* --- Speech safety bot: transcribes the model's mic, flags personal info/socials --- */
let speechRecog = null;
function startSpeechSafetyBot(sessionId) {
  stopSpeechSafetyBot();
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return; // not supported on this browser (e.g. iPhone Safari)
  try {
    speechRecog = new SR();
  } catch (e) { return; }
  speechRecog.continuous = true;
  speechRecog.interimResults = false;
  speechRecog.lang = 'en-US';
  let lastSent = '';
  speechRecog.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (!e.results[i].isFinal) continue;
      const text = e.results[i][0].transcript.trim();
      if (!text || text === lastSent) continue;
      lastSent = text;
      // Send transcript to server for safety scan
      api(`/live/${sessionId}/speech`, {
        method: 'POST', body: JSON.stringify({ text })
      }).then(({ data }) => {
        if (data && data.action === 'killed') {
          stopSpeechSafetyBot();
          toast('🛑 Stream ended by safety bot.');
        } else if (data && data.action === 'warned') {
          toast(data.warning || '⚠️ Watch what you say on live.');
        }
      }).catch(() => {});
    }
  };
  speechRecog.onerror = () => {
    // Restart on recoverable errors so the bot keeps listening
    try { speechRecog.stop(); } catch (e) {}
  };
  speechRecog.onend = () => {
    // Auto-restart while still live (unless we stopped it on purpose)
    if (speechRecog && S.live && S.live.sessionId === sessionId) {
      try { speechRecog.start(); } catch (e) {}
    }
  };
  try { speechRecog.start(); } catch (e) {}
}
function stopSpeechSafetyBot() {
  if (speechRecog) {
    const r = speechRecog;
    speechRecog = null;
    try { r.onend = null; r.stop(); } catch (e) {}
  }
  stopAudioChunkBot();
}

/* --- Audio chunk bot: records 10s mic clips, server transcribes via Whisper --- */
/* Works on iPhone Safari (MediaRecorder) where Web Speech API is unavailable.   */
let audioChunkRecorder = null;
let audioChunkTimer = null;
function startAudioChunkBot(sessionId) {
  stopAudioChunkBot();
  // If the browser has its own speech recognition, that bot already covers
  // this mic — running both would scan the same words twice and double the
  // strikes. Chunks are the fallback for browsers without it (iPhone Safari).
  if (window.SpeechRecognition || window.webkitSpeechRecognition) return;
  const L = S.live;
  if (!L || !L.stream) return;
  if (typeof MediaRecorder === 'undefined') return;
  try {
    // Audio-only stream for the recorder
    const audioTracks = L.stream.getAudioTracks();
    if (!audioTracks.length) return;
    const audioStream = new MediaStream(audioTracks);
    // iPhone Safari records mp4 — ask for it first, like voice notes do.
    // The filename extension must match the real format: Whisper reads it.
    const mime = MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4'
      : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
    const ext = mime === 'audio/mp4' ? 'mp4' : 'webm';
    const sendChunk = (blob) => {
      if (!blob || blob.size < 1000) return; // skip tiny/empty clips
      const fd = new FormData();
      fd.append('audio', blob, 'chunk.' + ext);
      // Result arrives over WebSocket (live:killed / live:speech_warning);
      // this response only confirms the chunk was queued.
      fetch(`/api/live/${sessionId}/audio-chunk`, { method: 'POST', body: fd })
        .catch(() => {});
    };
    const recordOne = () => {
      if (!S.live || S.live.sessionId !== sessionId) { stopAudioChunkBot(); return; }
      try {
        audioChunkRecorder = new MediaRecorder(audioStream, mime ? { mimeType: mime } : undefined);
        const chunks = [];
        audioChunkRecorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
        audioChunkRecorder.onstop = () => sendChunk(new Blob(chunks, { type: mime || 'audio/mp4' }));
        audioChunkRecorder.start();
        audioChunkTimer = setTimeout(() => {
          try { audioChunkRecorder.stop(); } catch (e) {}
          // chain the next 10s clip
          setTimeout(recordOne, 500);
        }, 10000);
      } catch (e) { /* MediaRecorder failed — speech bot still covers desktop */ }
    };
    recordOne();
  } catch (e) {}
}
function stopAudioChunkBot() {
  if (audioChunkTimer) { clearTimeout(audioChunkTimer); audioChunkTimer = null; }
  if (audioChunkRecorder) {
    try { audioChunkRecorder.onstop = null; audioChunkRecorder.stop(); } catch (e) {}
    audioChunkRecorder = null;
  }
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
  if (el) el.textContent = t('watching', { n: livePCs.size });
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
      b.textContent = next ? '🔞 Explicit ON — tap for SFW' : t('go_explicit');
      b.style.background = next
        ? 'linear-gradient(135deg,#10b981,#047857)'
        : 'linear-gradient(135deg,#8b5cf6,#6d28d9)';
    }
    toast(next ? '🔞 Explicit mode — fans see the paywall' : 'Back to SFW preview');
  }
}

/* --- BRB: she steps away without ending the stream. Fans see the BRB card;
   her local tracks are disabled so nothing private leaves her camera/mic. --- */
function liveBrbCardHTML(name) {
  return `
    <img class="brb-lips" src="/img/lips-logo.png" alt="">
    <div class="brb-title">${t('brb_title')}</div>
    <div class="brb-sub">${t('brb_sub')}</div>
    ${name ? `<div class="brb-name">${t('brb_name', { name: esc(name) })}</div>` : ''}`;
}

function liveEndConfirm() { if (confirm('End your live stream?')) endLiveView('Stream ended.'); }

function applyLiveBrb(on) {
  const L = S.live;
  if (!L) return;
  const was = !!L.brb;
  L.brb = on;
  const ov = $('#live-brb-overlay');
  if (ov) ov.classList.toggle('hidden', !on);
  /* The paused-state composition hangs off this one class, driven by
   * the same flag, so it can never desync: while brb is on, the stage
   * shows ONLY the card (+ its exits) and the chat bubble — the normal
   * control stack drops out of the flow entirely instead of piling up
   * under the card (Oct 14, Stacey's screen: two Resumes, two End
   * Streams, toggles and rate line all overlapping the card). */
  const wrap = $('.live-wrap');
  if (wrap) wrap.classList.toggle('brb-on', on);
  // If the keyboard is up, the viewer's card bound rides the band's
  // translated position — re-derive it under the new brb state.
  applyLiveKbOffset();
  if (L.role === 'fan') {
    /* The paused card is never a dead end for viewers either (owner:
     * "I can't exit unless I close the app"): the card itself carries a
     * Leave button, re-created + re-bound on every brb application. The
     * band's own Leave also stays reachable — .live-bottom is z-index 7,
     * above the card's 6. */
    let lb = $('#live-brb-leave');
    if (ov && !lb) {
      lb = document.createElement('button');
      lb.id = 'live-brb-leave';
      lb.className = 'btn ghost';
      lb.style.marginTop = '18px';
      lb.textContent = 'Leave stream';
      ov.appendChild(lb);
    }
    if (lb) lb.onclick = () => endLiveView();
    return;
  }
  if (L.role !== 'model') return;
  const b = $('#live-pause-btn');
  if (b) { b.textContent = on ? t('resume_live') : t('pause_live'); b.onclick = liveToggleBrb; }
  /* Belt-and-braces exit (Oct 14: a session sat paused 17 minutes — her
   * Resume taps were being swallowed above the controls layer, and the
   * server flag could only be cleared by an admin). The BRB card itself
   * carries a Resume button, and every brb state application re-asserts
   * BOTH bindings and re-creates the on-card button if a re-render ever
   * dropped it — while she is paused, a working Resume is guaranteed to
   * be on screen, bound to the toggle. */
  let rb = $('#live-brb-resume');
  if (ov && !rb) {
    rb = document.createElement('button');
    rb.id = 'live-brb-resume';
    rb.className = 'btn';
    rb.style.marginTop = '18px';
    rb.textContent = t('resume_live');
    ov.appendChild(rb);
  }
  if (rb) rb.onclick = liveToggleBrb;
  // The card also carries her End — while paused, Resume AND End are
  // both painted from the brb state, never absent.
  let eb = $('#live-brb-end');
  if (ov && !eb) {
    eb = document.createElement('button');
    eb.id = 'live-brb-end';
    eb.className = 'btn danger';
    eb.style.marginTop = '10px';
    eb.textContent = t('end_stream');
    ov.appendChild(eb);
  }
  if (eb) eb.onclick = liveEndConfirm;
  const endBtn = $('#live-end-btn');
  if (endBtn) endBtn.onclick = liveEndConfirm;
  if (!L.stream || on === was) return;
  const tracks = L.stream.getTracks();
  if (on) {
    // Remember her mic/cam toggle states so Resume restores them exactly.
    L.brbMuted = tracks.map((tr) => tr.enabled);
    tracks.forEach((tr) => { tr.enabled = false; });
    stopSpeechSafetyBot(); // her break-time chatter is private — not monitored
  } else {
    tracks.forEach((tr, i) => { tr.enabled = !L.brbMuted || L.brbMuted[i] !== false; });
    L.brbMuted = null;
    startSpeechSafetyBot(L.sessionId);
    startAudioChunkBot(L.sessionId);
  }
}

async function liveToggleBrb() {
  const L = S.live;
  if (!L || L.role !== 'model') return;
  const { status, data } = await api(`/live/${L.sessionId}/brb`, {
    method: 'POST', body: JSON.stringify({ on: !L.brb }) });
  if (status === 200) applyLiveBrb(!!data.brb);
  else toast(L.brb
    ? "Couldn't resume — check your connection and tap Resume again 📶"
    : "Couldn't pause — check your connection and tap again 📶", 4000);
}

/* --- Live typing band rides the keyboard (owner: "Typing bubble at
 * the bottom. Move with keyboard"). The live bands (.live-bottom /
 * .broadcast-bottom) are position:absolute; bottom:0 inside a 100dvh
 * wrap: when the iOS keyboard opens, the layout viewport does NOT
 * shrink for it — the keyboard overlays the visual viewport and the
 * band stays glued to the layout bottom, hidden behind the keys.
 * (The DM chat footer never had this bug: it is a flex item of the
 * 100dvh shell column — no independent anchor — so it follows the
 * shell by construction; see the audit note at trackLiveBand.)
 * Fix: translate the band by the exact gap between the layout
 * viewport and the visual viewport:
 *   offset = innerHeight − (visualViewport.height + offsetTop)
 * That gap IS the keyboard height when the layout didn't resize, and
 * ≈0 when the platform resized the layout itself — self-correcting
 * on both behaviors. No CSS transition on the transform: iOS streams
 * visualViewport resize events through the keyboard's own animation,
 * so applying the offset directly tracks it 1:1 — a transition would
 * double-animate and lag behind the keys. --- */
let kbTrack = null; // { band, overlay } while a live view is active

function liveKbOffset() {
  const vv = window.visualViewport;
  if (!vv) return 0;
  return Math.max(0, Math.round(window.innerHeight - (vv.height + vv.offsetTop)));
}

function applyLiveKbOffset() {
  if (!kbTrack) return;
  const off = liveKbOffset();
  kbTrack.band.style.transform = off > 0 ? `translateY(${-off}px)` : '';
  /* Viewer BRB card: its CSS bound (bottom:176px) pins it just above
   * the band's RESTING top edge. Keep that exact relationship while
   * the band is translated: card bottom = 176 + offset, so the card
   * always ends where the band currently begins. (The broadcaster's
   * card is pane-bound, not band-bound — nothing to re-derive.) */
  const ov = kbTrack.overlay;
  if (ov) {
    const wrap = kbTrack.band.closest ? kbTrack.band.closest('.live-wrap') : null;
    const bounded = !!wrap && wrap.classList.contains('brb-on')
      && !wrap.classList.contains('broadcast');
    ov.style.bottom = bounded && off > 0 ? `${176 + off}px` : '';
  }
}

function trackLiveBand(band) {
  untrackLiveBand();
  if (!band || !window.visualViewport) return; // no vv → band keeps its flush bottom:0 anchor
  kbTrack = { band, overlay: document.getElementById('live-brb-overlay') };
  window.visualViewport.addEventListener('resize', applyLiveKbOffset);
  window.visualViewport.addEventListener('scroll', applyLiveKbOffset);
  applyLiveKbOffset();
}

function untrackLiveBand() {
  if (!kbTrack) return;
  kbTrack.band.style.transform = '';
  if (kbTrack.overlay) kbTrack.overlay.style.bottom = '';
  if (window.visualViewport) {
    window.visualViewport.removeEventListener('resize', applyLiveKbOffset);
    window.visualViewport.removeEventListener('scroll', applyLiveKbOffset);
  }
  kbTrack = null;
}

function vLiveBroadcast() {
  const L = S.live;
  if (!L) return show('modelChats', {});
  app.innerHTML = `
    <div class="live-wrap broadcast${L.brb ? ' brb-on' : ''}">
      <div id="live-split" class="live-split full">
        <div class="split-pane" id="split-model">
          <video id="live-local" autoplay playsinline muted></video>
          <div class="split-name" id="split-model-name">${esc(S.model?.display_name || 'You')}</div>
          <div id="live-brb-overlay" class="${L.brb ? '' : 'hidden'}">${liveBrbCardHTML(S.model?.display_name || S.user?.display_name || '')}<button class="btn" id="live-brb-resume" style="margin-top:18px">${t('resume_live')}</button><button class="btn danger" id="live-brb-end" style="margin-top:10px">${t('end_stream')}</button></div>
        </div>
        <div class="split-pane hidden" id="split-fan">
          <video id="stage-video" autoplay playsinline muted class="hidden"></video>
          <div id="stage-mic" class="hidden"><span class="stage-mic-emoji">🎙️</span><span class="stage-mic-pulse"></span></div>
          <div class="split-name" id="split-fan-name"></div>
        </div>
      </div>
      <div class="live-top">
        <span class="live-badge">🔴 LIVE</span>
        <span id="live-viewer-count" class="live-viewers">${t('watching', { n: 0 })}</span>
      </div>
      <button id="live-explicit-btn" style="background:linear-gradient(135deg,#8b5cf6,#6d28d9)">${t('go_explicit')}</button>
      ${L.title ? `<div class="live-title">${esc(L.title)}</div>` : ''}
      <div id="priority-banner" class="hidden"></div>
      <div id="gift-stack"></div>
      <div id="game-splash" class="hidden"></div>
      <div id="game-now" class="hidden"></div>
      <div id="stage-pip" class="hidden">
        <div id="stage-info" class="stage-info"></div>
        <button class="btn small danger" id="stage-drop-btn">Drop ⏏️</button>
      </div>
      <div id="stage-requests"></div>
      <div id="live-leaderboard" class="live-leaderboard hidden"></div>
      <div class="broadcast-bottom">
        <div id="stream-chat" class="stream-chat"></div>
        <div class="row live-toggle-row" style="gap:8px;margin-bottom:8px">
          <button class="btn small ghost" id="live-mic-btn" style="flex:1">${t('mic_on')}</button>
          <button class="btn small ghost" id="live-cam-btn" style="flex:1">${t('cam_on')}</button>
        </div>
        <div class="stream-chat-input live-typing-bubble">
          <input id="stream-chat-box" class="input" placeholder="${t('say_fans_ph')}" maxlength="500" autocomplete="off">
          <button class="btn small" id="stream-chat-send" style="margin:0">➤</button>
        </div>
        <div class="live-controls">
          <div class="row live-action-row" style="gap:8px">
            <button class="btn small" id="live-pause-btn" style="background:linear-gradient(135deg,#ff5c9e,#FA4D92)">${L.brb ? t('resume_live') : t('pause_live')}</button>
            <button class="btn small danger" id="live-end-btn">${t('end_stream')}</button>
          </div>
          <div class="muted small" style="text-align:center;margin-top:6px">${t('explicit_rate_note', { price: fmt(L.explicitRate) })}</div>
          <button class="btn small ghost" id="game-panel-btn" style="width:100%;margin-top:8px">🎲 ${t('game_category')} <span id="game-queue-badge" class="hidden" style="background:var(--pink);color:#fff;border-radius:999px;padding:1px 8px;font-weight:800"></span></button>
        </div>
      </div>
    </div>`;
  $('#live-local').srcObject = L.stream;
  $('#game-panel-btn').onclick = openGamePanel;
  refreshGameBadge();
  $('#live-explicit-btn').onclick = liveToggleExplicit;
  $('#live-pause-btn').onclick = liveToggleBrb;
  const brbResumeBtn = $('#live-brb-resume');
  if (brbResumeBtn) brbResumeBtn.onclick = liveToggleBrb;
  const brbEndBtn = $('#live-brb-end');
  if (brbEndBtn) brbEndBtn.onclick = liveEndConfirm;
  $('#live-end-btn').onclick = liveEndConfirm;
  startLeaderboardPolling();
  const sendBox = $('#stream-chat-box');
  const sendIt = () => {
    const v = sendBox.value.trim();
    if (v) { sendStreamChat(v); sendBox.value = ''; }
  };
  $('#stream-chat-send').onclick = sendIt;
  sendBox.onkeydown = (e) => { if (e.key === 'Enter') sendIt(); };
  // Mute mic / camera toggles
  const micBtn = $('#live-mic-btn'), camBtn = $('#live-cam-btn');
  if (micBtn) micBtn.onclick = () => {
    const L2 = S.live; if (!L2 || !L2.stream || L2.brb) return;
    const track = L2.stream.getAudioTracks()[0];
    if (!track) return toast('No mic found');
    track.enabled = !track.enabled;
    micBtn.textContent = track.enabled ? t('mic_on') : t('muted');
    micBtn.classList.toggle('danger', !track.enabled);
  };
  if (camBtn) camBtn.onclick = () => {
    const L2 = S.live; if (!L2 || !L2.stream || L2.brb) return;
    const track = L2.stream.getVideoTracks()[0];
    if (!track) return toast('No camera found');
    track.enabled = !track.enabled;
    camBtn.textContent = track.enabled ? t('cam_on') : t('cam_off');
    camBtn.classList.toggle('danger', !track.enabled);
  };
  renderStreamChat();
  renderLeaderboard();
  renderStageRequests();
  // Mic level meter — shows her if her mic is live
  startMicMeter(L.stream);
  // Poll stage requests every 5s as backup (in case WS events are missed)
  if (S.live.stagePoll) clearInterval(S.live.stagePoll);
  S.live.stagePoll = setInterval(() => {
    if (S.live && S.live.role === 'model') renderStageRequests();
    else clearInterval(S.live.stagePoll);
  }, 5000);
  // Typing band (toggles + bubble + controls together, one unit)
  // rides the keyboard; show() untracks on the way out.
  trackLiveBand($('.broadcast-bottom'));
}

// Live mic level indicator for the broadcaster
function startMicMeter(stream) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    src.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const meter = document.createElement('div');
    meter.id = 'mic-meter';
    meter.innerHTML = '<div id="mic-meter-fill"></div><span>🎤</span>';
    document.querySelector('.live-wrap.broadcast .live-top')?.appendChild(meter);
    const tick = () => {
      if (!S.live || S.live.role !== 'model') { try { ctx.close(); } catch (e) {} meter.remove(); return; }
      analyser.getByteFrequencyData(data);
      const avg = data.reduce((a, b) => a + b, 0) / data.length;
      const fill = meter.querySelector('#mic-meter-fill');
      if (fill) {
        fill.style.width = Math.min(100, avg * 2) + '%';
        fill.style.background = avg > 5 ? '#22c55e' : '#ef4444';
      }
      requestAnimationFrame(tick);
    };
    tick();
  } catch (e) {}
}

/* Stage request modal — big tappable approve/decline, can't be missed */
function showStageRequestModal(req, fee) {
  if (!req || !req.id) return;
  // Remove any existing modal
  const old = $('#stage-req-modal');
  if (old) old.remove();
  const mode = req.mode || 'video';
  const ov = document.createElement('div');
  ov.id = 'stage-req-modal';
  ov.innerHTML = `
    <div style="position:fixed;inset:0;z-index:300;background:rgba(5,2,12,.75);display:flex;align-items:center;justify-content:center;padding:24px" id="srm-bg">
      <div class="card" style="max-width:360px;width:100%;text-align:center;border:2px solid var(--purple)">
        <div style="font-size:48px;margin-bottom:8px">${stageModeEmoji(mode)}</div>
        <h3 style="margin:0 0 4px"><b>${esc(req.fan_name)}</b> wants to join!</h3>
        <p class="muted" style="margin:0 0 16px">${stageModeLabel(mode)} · ${fmt(fee)}${req.is_explicit ? ' 🔞' : ''}</p>
        <div style="display:flex;gap:12px">
          <button class="btn success" id="srm-approve" style="flex:1;padding:16px;font-size:18px">✅ Let them in</button>
          <button class="btn danger" id="srm-decline" style="flex:1;padding:16px;font-size:18px">❌ Decline</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(ov);
  $('#srm-approve').onclick = async () => {
    ov.remove();
    await stageApprove(req.id);
  };
  $('#srm-decline').onclick = async () => {
    ov.remove();
    await stageDecline(req.id);
  };
  // Tapping outside dismisses (but request stays in the list)
  $('#srm-bg').onclick = (e) => { if (e.target.id === 'srm-bg') ov.remove(); };
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
  // TikTok-style split screen: show fan pane alongside model
  const splitFan = $('#split-fan');
  const splitWrap = $('#live-split');
  const fanName = $('#split-fan-name');
  if (splitFan) splitFan.classList.remove('hidden');
  if (splitWrap) splitWrap.classList.add('has-fan');
  if (fanName) fanName.textContent = stage.fan_name || 'Fan';
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
  // Hide split-screen fan pane
  const splitFan = $('#split-fan');
  const splitWrap = $('#live-split');
  if (splitFan) splitFan.classList.add('hidden');
  if (splitWrap) splitWrap.classList.remove('has-fan');
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
  el.classList.remove('hidden');
  const king = top[0];
  const changed = !!(king && L._kingId && L._kingId !== king.fan_id);
  if (king) L._kingId = king.fan_id;
  const medals = ['🥈', '🥉'];
  const chasers = top.slice(1).map((c, i) =>
    `<span>${medals[i]} ${esc(c.fan_name)} · ${fmt(c.total_cents)}</span>`).join('<span class="lb-dot">•</span>');
  el.innerHTML = king
    ? `<div class="lb-king">👑 <b>${esc(king.fan_name)}</b> <span class="lb-amt">${fmt(king.total_cents)}</span></div>
       ${chasers ? `<div class="lb-chasers">${chasers}</div>` : ''}`
    : `<div class="lb-king lb-empty">👑 No king yet — top spender takes the crown</div>`;
  if (changed) {
    el.classList.remove('king-pop');
    void el.offsetWidth;
    el.classList.add('king-pop');
  }
}

// Keep the crown race fresh: instant WS refreshes cover gifts; this poll
// catches joins, tips and explicit-minute spend. Self-clears on view exit.
function startLeaderboardPolling() {
  const L = S.live;
  if (!L || L._lbPoll) return;
  const sid = L.sessionId;
  L._lbPoll = setInterval(() => {
    if (!S.live || S.live.sessionId !== sid) { clearInterval(L._lbPoll); return; }
    loadLeaderboard();
  }, 15000);
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
    bell.title = t('notifications_word');
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
  // FaceTime request bells (link /#ft/<id>) are ACTIONABLE for the model:
  // join them against her live incoming list so a still-pending request
  // renders Accept/Decline right here, and a queued one shows his wait.
  let ftById = {};
  if (S.user && S.user.role === 'model') {
    try {
      const inc = await api('/facetime/incoming');
      for (const r of (inc.data.requests || [])) ftById[r.id] = r;
    } catch (e) { /* box still renders as plain history */ }
  }
  const ftReqOf = (n) => {
    const m = /^#ft\/(\d+)$/.exec(String(n.link || '').replace(/^\//, ''));
    return m ? ftById[parseInt(m[1])] : undefined;
  };
  const when = (n) => new Date((n.created_at || '').replace(' ', 'T') + 'Z').toLocaleString();
  app.innerHTML = `
    <div class="header"><h1>${t('notifications_h')}</h1>
      <div><button class="btn ghost small" id="notif-read-all">${t('mark_all_read')}</button></div></div>
    <div class="screen">
      ${notifs.map((n) => {
        const fr = ftReqOf(n);
        if (fr && fr.status === 'pending') return `
        <div class="list-item ${n.read ? '' : 'unread'}" data-ft-open="${fr.id}">
          <span class="grow">
            <span class="title">${esc(n.title)}</span><br>
            <span class="preview">${esc(fr.fan_name)} wants a FaceTime — ${fr.duration_min} min · ${fmt(fr.amount_cents)}</span><br>
            <span class="small muted">${when(n)}</span>
            <span class="row" style="gap:8px;margin-top:8px">
              <button class="btn small" data-ft-acc="${fr.id}">Accept ✅</button>
              <button class="btn small ghost" data-ft-dec="${fr.id}">Decline</button>
            </span>
          </span>${n.read ? '' : '<span class="unread-dot"></span>'}
        </div>`;
        if (fr && (fr.status === 'queued' || fr.status === 'invited' || fr.status === 'in_call')) return `
        <button class="list-item ${n.read ? '' : 'unread'}" data-notif="${n.id}" data-link="${esc(n.link || '')}">
          <span class="grow">
            <span class="title">${esc(n.title)}</span><br>
            <span class="preview">${fr.status === 'queued'
              ? `⏳ In your FaceTime line — #${fr.position} · his turn in about ${fr.eta_min} min`
              : fr.status === 'invited' ? '💚 Invited — he\'s joining now…'
              : '🔴 On FaceTime now'}</span><br>
            <span class="small muted">${when(n)}</span>
          </span>${n.read ? '' : '<span class="unread-dot"></span>'}
        </button>`;
        return `
        <button class="list-item ${n.read ? '' : 'unread'}" data-notif="${n.id}" data-link="${esc(n.link || '')}">
          <span class="grow">
            <span class="title">${esc(n.title)}</span><br>
            ${n.body ? `<span class="preview">${esc(n.body)}</span><br>` : ''}
            <span class="small muted">${when(n)}</span>
          </span>${n.read ? '' : '<span class="unread-dot"></span>'}
        </button>`;
      }).join('') || '<div class="empty"><div class="big">🔔</div>Nothing yet.<br><span class="small">Follow models to get notified when they go live.</span></div>'}
    </div>`;
  $('#notif-read-all').onclick = async () => {
    await api('/notifications/read', { method: 'POST' });
    refreshNotifBadge();
    show('notifications', {});
  };
  const markRead = async (btn) => {
    await api('/notifications/read', { method: 'POST',
      body: JSON.stringify({ ids: [parseInt(btn.dataset.notif)] }) });
    refreshNotifBadge();
  };
  app.querySelectorAll('[data-notif]').forEach((b) => {
    b.onclick = async () => {
      await markRead(b);
      const link = b.dataset.link;
      if (link === '/#live' && S.user && S.user.role === 'fan') show('fanLive', {});
      else show('notifications', {});
    };
  });
  // Box actions: real Accept/Decline against the live request.
  const markFtRead = async (reqId) => {
    const n = notifs.find((x) => x.link === `/#ft/${reqId}`);
    if (n && !n.read) {
      await api('/notifications/read', { method: 'POST',
        body: JSON.stringify({ ids: [n.id] }) }).catch(() => {});
      refreshNotifBadge();
    }
  };
  app.querySelectorAll('[data-ft-acc]').forEach((b) => {
    b.onclick = async (e) => {
      e.stopPropagation();
      const fr = ftById[parseInt(b.dataset.ftAcc)];
      if (fr) { await markFtRead(fr.id); await ftDoAccept(fr); }
      show('notifications', {});
    };
  });
  app.querySelectorAll('[data-ft-dec]').forEach((b) => {
    b.onclick = async (e) => {
      e.stopPropagation();
      const fr = ftById[parseInt(b.dataset.ftDec)];
      if (fr) { await markFtRead(fr.id); await ftDoDecline(fr); }
      show('notifications', {});
    };
  });
  // Tapping the pending item (outside the buttons) opens the request card.
  app.querySelectorAll('[data-ft-open]').forEach((row) => {
    row.onclick = () => {
      const fr = ftById[parseInt(row.dataset.ftOpen)];
      if (fr) showFtRequestCard(fr);
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
      ${context === 'chat' ? `
      <button class="tip-item" id="tip-custom-row" style="margin-top:8px">
        <span class="tip-emoji">💸</span>
        <span class="grow"><span class="title">Custom tip amount</span></span>
        <span class="tip-price">$1+</span>
      </button>` : ''}
      <button class="btn ghost" id="tip-close" style="margin-top:10px">Close</button>
    </div>`;
  document.body.appendChild(sheet);
  const close = () => sheet.remove();
  $('#tip-close').onclick = close;
  const customRow = $('#tip-custom-row');
  if (customRow) customRow.onclick = () => { close(); openTipModal(); };
  sheet.onclick = (e) => { if (e.target === sheet) close(); };
  sheet.querySelectorAll('[data-tip]').forEach((b) => {
    b.onclick = () => sendTipMenuPick(parseInt(b.dataset.tip), modelId, modelName, context);
  });
}

// Tip-MENU pick (POST /api/models/:id/tip). Named distinctly from the plain
// tip modal's sendTip(amountCents → POST /api/tips): the two used to share
// the name sendTip, and this later declaration shadowed the modal's for
// EVERY call site — plain in-chat tipping posted to /api/models/undefined/tip
// and failed silently (production bug, fixed Oct 14).
async function sendTipMenuPick(menuId, modelId, modelName, context) {
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

/* ---------------- GAME CATEGORY (her priced request list on live) ---------------- */

// Splash: his name + his request across the upper stage, on BOTH stages.
let gameSplashTimer = null;
function showGameSplash(m) {
  const el = $('#game-splash');
  if (!el) return;
  el.innerHTML = `🔥 <b>${esc(m.fan_name)}</b> ${t('game_bought')}: ${esc(m.label)} <span class="game-splash-price">${fmt(m.price_cents)}</span>`;
  el.classList.remove('hidden', 'show');
  void el.offsetWidth; // restart the CSS animation
  el.classList.add('show');
  clearTimeout(gameSplashTimer);
  gameSplashTimer = setTimeout(() => { el.classList.add('hidden'); el.classList.remove('show'); }, 4600);
}

// NOW chip: what she's doing right now, with a live countdown when the
// item has a duration. Clears on game:update, expiry, or view change.
function showGameNow(m) {
  const L = S.live;
  if (!L) return;
  clearGameNow();
  const el = $('#game-now');
  if (!el) return;
  L.gameNowId = m.request_id;
  const end = m.duration_sec ? Date.now() + m.duration_sec * 1000 : 0;
  const paint = () => {
    if (!$('#game-now') || (S.live && S.live.gameNowId !== m.request_id)) { clearGameNow(); return; }
    let cd = '';
    if (end) {
      const left = Math.max(0, Math.round((end - Date.now()) / 1000));
      if (left <= 0) { clearGameNow(); return; }
      cd = ` · ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    }
    el.innerHTML = `🎲 <b>${t('game_now')}:</b> ${esc(m.label)} — ${esc(m.fan_name)}${cd}`;
  };
  el.classList.remove('hidden');
  paint();
  if (end) L.gameNowInt = setInterval(paint, 500);
}

function clearGameNow() {
  const L = S.live;
  if (L && L.gameNowInt) { clearInterval(L.gameNowInt); L.gameNowInt = null; }
  if (L) L.gameNowId = null;
  const el = $('#game-now');
  if (el) { el.classList.add('hidden'); el.innerHTML = ''; }
}

// Her stage button badge: open requests waiting in the queue.
async function refreshGameBadge() {
  const L = S.live;
  if (!L || L.role !== 'model') return;
  const badge = $('#game-queue-badge');
  if (!badge) return;
  try {
    const { status, data } = await api(`/live/${L.sessionId}/game-queue`);
    if (status !== 200 || !data || !S.live || S.live.sessionId !== L.sessionId) return;
    const n = (data.requests || []).filter((r) => r.status === 'pending' || r.status === 'current').length;
    badge.textContent = n;
    badge.classList.toggle('hidden', n === 0);
  } catch (e) { /* badge is a bonus */ }
}

/* ---- FAN: the Game Category sheet ---- */

async function openGameSheet() {
  const L = S.live;
  if (!L || L.role !== 'fan') return;
  let sheet = $('#game-sheet');
  if (sheet) sheet.remove();
  sheet = document.createElement('div');
  sheet.id = 'game-sheet';
  sheet.className = 'sheet-backdrop';
  sheet.innerHTML = `
    <div class="sheet">
      <div class="sheet-title">🎲 ${t('game_category')}
        <span class="muted small">· ${fmt(S.wallet ? S.wallet.credits_cents : 0)}</span></div>
      <div id="game-sheet-body"><div class="muted" style="text-align:center;padding:14px">…</div></div>
      <button class="btn ghost" id="game-close" style="margin-top:10px">Close</button>
    </div>`;
  document.body.appendChild(sheet);
  $('#game-close').onclick = () => sheet.remove();
  sheet.onclick = (e) => { if (e.target === sheet) sheet.remove(); };
  renderGameSheetBody();
}

async function renderGameSheetBody() {
  const L = S.live;
  const body = $('#game-sheet-body');
  if (!L || L.role !== 'fan' || !body) return;
  const { status, data } = await api(`/live/${L.sessionId}/game-menu`);
  if (!$('#game-sheet-body')) return; // sheet closed mid-fetch
  if (status !== 200 || !data) {
    body.innerHTML = '<div class="muted" style="text-align:center;padding:14px">—</div>';
    return;
  }
  L.gameOn = !!data.game_on;
  if (!data.game_on) {
    body.innerHTML = `<div class="muted" style="text-align:center;padding:18px 6px">${t('game_off_msg')}</div>`;
    return;
  }
  const secs = [['regular', t('game_regular')], ['explicit', t('game_explicit')], ['special', t('game_specials')]];
  body.innerHTML = secs.map(([key, title]) => {
    const items = (data.sections && data.sections[key]) || [];
    if (!items.length) return '';
    return `<div class="game-sec-h">${title}</div>` + items.map((it) => {
      const locked = key === 'explicit' && !data.is_explicit;
      const resting = key === 'special' && !it.special_ready;
      const dur = it.duration_sec ? ` <span class="muted small">· ${it.duration_sec}s</span>` : '';
      const right = resting
        ? `<span class="muted small">${t('game_resting')}</span>`
        : `<span class="tip-price">${fmt(it.price_cents)}</span>${locked ? ' <span>🔒</span>' : ''}`;
      return `<button class="game-row${locked ? ' locked' : ''}${resting ? ' resting' : ''}" data-game-buy="${it.id}" ${locked || resting ? 'disabled' : ''}>
        <span class="grow"><span class="title">${esc(it.label)}</span>${dur}
        ${locked ? `<div class="muted small">🔒 ${t('game_unlocks_explicit')}</div>` : ''}</span>
        <span class="game-row-right">${right}</span>
      </button>`;
    }).join('');
  }).join('') || '<div class="muted" style="text-align:center;padding:14px">—</div>';
  body.querySelectorAll('[data-game-buy]').forEach((b) => {
    b.onclick = () => buyGameItem(parseInt(b.dataset.gameBuy));
  });
}

// One tap buys — no confirm dialog (casino rule, same as PPV). The only
// interruption is an empty balance → top-up.
async function buyGameItem(itemId) {
  const L = S.live;
  if (!L) return;
  const { status, data } = await api(`/live/${L.sessionId}/game-buy`, {
    method: 'POST', body: JSON.stringify({ item_id: itemId }) });
  if (status === 200) {
    if (data.balance_cents != null && S.wallet) S.wallet.credits_cents = data.balance_cents;
    toast('🎲 Sent! Watch her screen 🔥', 3000);
    renderGameSheetBody(); // a bought special flips to Resting, balance repaints
  } else if (status === 402) {
    toast(`Need ${fmt(data.needed_cents)} — top up your wallet 💰`, 3500);
    showBuyCredits(data.needed_cents);
  } else if (status === 403 && data.error === 'explicit_locked') {
    toast(`🔒 ${t('game_unlocks_explicit')}`, 3000);
    renderGameSheetBody();
  } else if (status === 409) {
    toast(t('game_resting'), 2500);
    renderGameSheetBody();
  } else if (status === 423) {
    toast(t('game_off_msg'), 3000);
    renderGameSheetBody();
  } else {
    toast("Hmm — that one didn't go through.");
  }
}

/* ---- MODEL: list builder + work queue, inside her live ---- */

let gameEditId = null;

async function openGamePanel() {
  const L = S.live;
  if (!L || L.role !== 'model') return;
  gameEditId = null;
  let sheet = $('#game-sheet');
  if (sheet) sheet.remove();
  sheet = document.createElement('div');
  sheet.id = 'game-sheet';
  sheet.className = 'sheet-backdrop';
  sheet.innerHTML = `
    <div class="sheet game-panel">
      <div class="sheet-title">🎲 ${t('game_category')}</div>
      <div id="game-sheet-body"><div class="muted" style="text-align:center;padding:14px">…</div></div>
      <button class="btn ghost" id="game-close" style="margin-top:10px">Close</button>
    </div>`;
  document.body.appendChild(sheet);
  $('#game-close').onclick = () => sheet.remove();
  sheet.onclick = (e) => { if (e.target === sheet) sheet.remove(); };
  renderGamePanelBody();
}

function gameItemEditorHTML(it) {
  return `<div class="game-editor" data-editor="${it.id}">
    <input class="input game-ed-label" type="text" maxlength="80" value="${esc(it.label)}" placeholder="${t('game_label_ph')}">
    <div class="row" style="gap:8px;margin-top:8px">
      <input class="input game-ed-price" type="number" min="1" max="1000" step="0.5" value="${(it.price_cents / 100).toFixed(2)}" placeholder="${t('game_price_ph')}" style="flex:1">
      <input class="input game-ed-duration" type="number" min="0" max="600" step="5" value="${it.duration_sec || ''}" placeholder="${t('game_duration_ph')}" style="flex:1">
    </div>
    <label class="game-active-lbl"><input type="checkbox" class="game-ed-active" ${it.active ? 'checked' : ''}> ${t('game_active')}</label>
    <div class="row" style="gap:8px;margin-top:8px">
      <button class="btn small" data-game-save="${it.id}" style="flex:1">${t('game_save')}</button>
      <button class="btn small danger" data-game-delete="${it.id}" style="flex:1">${t('game_delete')}</button>
    </div>
  </div>`;
}

async function renderGamePanelBody() {
  const L = S.live;
  const body = $('#game-sheet-body');
  if (!L || L.role !== 'model' || !body) return;
  const [{ data: itemsData }, { data: queueData }] = await Promise.all([
    api('/game/items'),
    api(`/live/${L.sessionId}/game-queue`),
  ]);
  if (!$('#game-sheet-body')) return;
  const items = (itemsData && itemsData.items) || [];
  const gameOn = !!(queueData && queueData.game_on);
  L.gameOn = gameOn;
  const reqs = (queueData && queueData.requests) || [];
  const open = reqs.filter((r) => r.status === 'pending' || r.status === 'current');
  const done = reqs.filter((r) => r.status === 'done').slice(-3);

  const queueHTML = `
    <div class="game-sec-h">🎯 ${t('game_queue')}</div>
    ${open.length ? open.map((r) => `
      <div class="game-req-row${r.status === 'current' ? ' current' : ''}">
        <span class="grow"><b>${esc(r.fan_name)}</b> · ${esc(r.label)} <span class="tip-price">${fmt(r.price_cents)}</span></span>
        ${r.status === 'pending' ? `<button class="btn small" data-game-start="${r.id}">${t('game_start')}</button>` : ''}
        <button class="btn small" data-game-done="${r.id}">${t('game_done')}</button>
        <button class="btn small danger" data-game-skip="${r.id}">${t('game_skip')}</button>
      </div>`).join('')
    : `<div class="muted small" style="padding:4px 2px 8px">${t('game_no_requests')}</div>`}
    ${done.map((r) => `<div class="game-req-row done"><span class="grow muted">✓ <b>${esc(r.fan_name)}</b> · ${esc(r.label)}</span><span class="muted small">${fmt(r.price_cents)}</span></div>`).join('')}`;

  const secs = [['regular', t('game_regular')], ['explicit', t('game_explicit')], ['special', t('game_specials')]];
  const itemsHTML = `<div class="muted small" style="margin:12px 0 2px">${t('game_your_turn')}</div>` +
    secs.map(([key, title]) => {
      const list = items.filter((i) => i.section === key);
      return `<div class="game-sec-h">${title}</div>` + list.map((it) => `
        <div class="game-item-row${it.active ? '' : ' inactive'}" data-game-edit="${it.id}">
          <span class="grow"><span class="title">${esc(it.label)}</span>${it.duration_sec ? ` <span class="muted small">· ${it.duration_sec}s</span>` : ''}</span>
          <span class="tip-price">${fmt(it.price_cents)}</span>
          ${key === 'special' ? `<button class="btn small ${it.special_ready ? '' : 'ghost'}" data-game-ready="${it.id}" data-ready="${it.special_ready ? 0 : 1}">${it.special_ready ? t('game_ready') : t('game_resting')}</button>` : ''}
        </div>
        ${gameEditId === it.id ? gameItemEditorHTML(it) : ''}`).join('') + `
        <div class="game-add" data-add="${key}">
          <input class="input game-add-label" type="text" maxlength="80" placeholder="${t('game_label_ph')}">
          <input class="input game-add-price" type="number" min="1" max="1000" step="0.5" placeholder="${t('game_price_ph')}">
          <input class="input game-add-duration" type="number" min="0" max="600" step="5" placeholder="${t('game_duration_ph')}">
          <button class="btn small" data-game-add="${key}">${t('game_add_own')}</button>
        </div>`;
    }).join('');

  body.innerHTML = `
    <button class="btn" id="game-toggle" style="width:100%;background:${gameOn ? 'linear-gradient(135deg,#10b981,#047857)' : 'var(--card2)'}">${gameOn ? '🟢 ' + t('game_on') : '⚪ ' + t('game_off')}</button>
    ${queueHTML}
    ${itemsHTML}`;

  $('#game-toggle').onclick = async () => {
    const { status } = await api(`/live/${L.sessionId}/game`, {
      method: 'POST', body: JSON.stringify({ on: !gameOn }) });
    if (status === 200) renderGamePanelBody();
  };
  body.querySelectorAll('[data-game-start]').forEach((b) => {
    b.onclick = () => gameResolve(parseInt(b.dataset.gameStart), 'start');
  });
  body.querySelectorAll('[data-game-done]').forEach((b) => {
    b.onclick = () => gameResolve(parseInt(b.dataset.gameDone), 'done');
  });
  body.querySelectorAll('[data-game-skip]').forEach((b) => {
    b.onclick = () => gameResolve(parseInt(b.dataset.gameSkip), 'skip');
  });
  body.querySelectorAll('[data-game-ready]').forEach((b) => {
    b.onclick = async (e) => {
      e.stopPropagation();
      const { status } = await api(`/game/items/${b.dataset.gameReady}/ready`, {
        method: 'POST', body: JSON.stringify({ ready: b.dataset.ready === '1' }) });
      if (status === 200) renderGamePanelBody();
    };
  });
  body.querySelectorAll('[data-game-edit]').forEach((row) => {
    row.onclick = () => {
      gameEditId = gameEditId === parseInt(row.dataset.gameEdit) ? null : parseInt(row.dataset.gameEdit);
      renderGamePanelBody();
    };
  });
  body.querySelectorAll('[data-game-save]').forEach((b) => {
    b.onclick = () => gameSaveItem(parseInt(b.dataset.gameSave));
  });
  body.querySelectorAll('[data-game-delete]').forEach((b) => {
    b.onclick = async () => {
      const { status } = await api(`/game/items/${b.dataset.gameDelete}`, { method: 'DELETE' });
      if (status === 200) { gameEditId = null; renderGamePanelBody(); }
    };
  });
  body.querySelectorAll('[data-game-add]').forEach((b) => {
    b.onclick = () => gameAddItem(b.dataset.gameAdd);
  });
  refreshGameBadge();
}

function gameItemError(data) {
  if (data && data.error === 'label_not_allowed')
    return toast('⚠️ That label is not allowed — no contact or payment info in game items.', 4000);
  toast('⚠️ Check the label (1–80 chars), price ($1–$1,000) and seconds (5–600).', 4000);
}

async function gameSaveItem(id) {
  const ed = document.querySelector(`[data-editor="${id}"]`);
  if (!ed) return;
  const label = ed.querySelector('.game-ed-label').value.trim();
  const price = Math.round(parseFloat(ed.querySelector('.game-ed-price').value || '0') * 100);
  const durRaw = ed.querySelector('.game-ed-duration').value;
  const duration_sec = durRaw === '' ? null : parseInt(durRaw);
  const active = ed.querySelector('.game-ed-active').checked;
  const { status, data } = await api(`/game/items/${id}`, {
    method: 'PUT', body: JSON.stringify({ label, price_cents: price, duration_sec, active }) });
  if (status === 200) { gameEditId = null; renderGamePanelBody(); toast('✓ Saved'); }
  else gameItemError(data);
}

async function gameAddItem(section) {
  const box = document.querySelector(`[data-add="${section}"]`);
  if (!box) return;
  const label = box.querySelector('.game-add-label').value.trim();
  const price = Math.round(parseFloat(box.querySelector('.game-add-price').value || '0') * 100);
  const durRaw = box.querySelector('.game-add-duration').value;
  const duration_sec = durRaw === '' ? null : parseInt(durRaw);
  const { status, data } = await api('/game/items', {
    method: 'POST', body: JSON.stringify({ section, label, price_cents: price, duration_sec }) });
  if (status === 200) renderGamePanelBody();
  else gameItemError(data);
}

async function gameResolve(id, action) {
  const { status } = await api(`/game/requests/${id}/resolve`, {
    method: 'POST', body: JSON.stringify({ action }) });
  if (status === 200) { renderGamePanelBody(); refreshGameBadge(); }
  else toast("That request already changed — list refreshed.", 2500), renderGamePanelBody();
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
    // Pick an English voice explicitly — browsers often fail silently without one
    const setVoice = () => {
      const voices = speechSynthesis.getVoices();
      const en = voices.find((v) => v.lang && v.lang.toLowerCase().startsWith('en'));
      if (en) u.voice = en;
      // iOS/Safari quirk: speak must be called after voices load
      speechSynthesis.speak(u);
    };
    const voices = speechSynthesis.getVoices();
    if (voices.length) setVoice();
    else {
      // Wait for voices to load, then speak (with 2s fallback)
      let done = false;
      const onVoices = () => { if (!done) { done = true; setVoice(); } };
      speechSynthesis.onvoiceschanged = onVoices;
      setTimeout(onVoices, 2000);
    }
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
  // Regular joins are model-priced too (her Settings, $5–$1,000)
  if (L && Number.isInteger(L.joinCents) && Number.isInteger(L.micJoinCents)) {
    return mode === 'mic' ? L.micJoinCents : L.joinCents;
  }
  if (S.model && Number.isInteger(S.model.join_cents)) {
    return mode === 'mic' ? (S.model.mic_join_cents || 500) : S.model.join_cents;
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
    // Show self-view PiP so the fan can see himself on stage
    const selfView = $('#fan-selfview');
    if (selfView && mode === 'video') {
      selfView.srcObject = stream;
      selfView.classList.remove('hidden');
      selfView.play().catch(() => {});
      // Try native iOS Picture-in-Picture (floats like FaceTime)
      try {
        if (document.pictureInPictureEnabled && !selfView.disablePictureInPicture) {
          await selfView.requestPictureInPicture().catch(() => {});
        } else if (selfView.webkitSupportsPresentationMode && selfView.webkitSetPresentationMode) {
          // iOS Safari fallback
          selfView.webkitSetPresentationMode('picture-in-picture');
        }
      } catch (e) {}
    }
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
    const selfView = $('#fan-selfview');
    if (selfView) {
      try {
        if (document.pictureInPictureElement === selfView) document.exitPictureInPicture().catch(() => {});
        else if (selfView.webkitPresentationMode === 'picture-in-picture') selfView.webkitSetPresentationMode('inline');
      } catch (e) {}
      selfView.srcObject = null; selfView.classList.add('hidden');
    }
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
    if (v) {
      v.srcObject = e.streams[0];
      // iOS: ensure audio track is enabled (not just unmuted)
      e.streams[0].getAudioTracks().forEach((t) => { t.enabled = true; });
      v.play().catch(() => {
        // If autoplay fails, show tap-to-play
        const btn = $('#live-unmute');
        if (btn) {
          btn.classList.remove('hidden');
          btn.textContent = '▶️ Tap to watch';
          btn.onclick = () => {
            v.muted = false;
            v.removeAttribute('muted');
            e.streams[0].getAudioTracks().forEach((t) => { t.enabled = true; });
            v.play().then(() => btn.classList.add('hidden')).catch(() => {});
          };
        }
      });
      // Show unmute button since we start muted for autoplay
      const ub = $('#live-unmute');
      if (ub) {
        ub.classList.remove('hidden');
        ub.onclick = () => {
          v.muted = false;
          v.removeAttribute('muted');
          e.streams[0].getAudioTracks().forEach((t) => { t.enabled = true; });
          v.play().catch(() => {});
          ub.classList.add('hidden');
        };
      }
    }
    startLiveMonitor();
  };

  S.live = { sessionId, role: 'fan', pc, modelId: data.model_id,
             modelName: data.model_name, explicitRate: data.explicit_rate_cents,
             paying: !!data.is_paying, blurred: false, monitorOn: false, aiReady: false,
             countdownInt: null, giftCountdownInt: null, title: data.title || '',
             isExplicit: !!data.is_explicit, brb: !!data.brb, explicitUntil: data.explicit_until || 0,
             entryPaid: !!data.explicit_paid, entryCents: data.explicit_entry_cents || 499,
             explicitJoinCents: data.explicit_join_cents || 2500,
             explicitMicJoinCents: data.explicit_mic_join_cents || 1500,
             joinCents: data.join_cents || 1000,
             micJoinCents: data.mic_join_cents || 500,
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
    // If AI loads late (after retry), activate it
    window.addEventListener('nsfw-ready', function onReady() {
      if (!S.live || S.live.role !== 'fan' || S.live.sessionId !== sessionId) return;
      const s2 = $('#live-ai-status');
      if (s2) { s2.textContent = '🛡️ AI monitor active'; S.live.aiReady = true; }
      startLiveMonitor();
      window.removeEventListener('nsfw-ready', onReady);
    });
  }
}

/* --- Fan live watch view --- */

function vLiveWatch() {
  const L = S.live;
  if (!L) return show('fanModels', {});
  app.innerHTML = `
    <div class="live-wrap${L.brb ? ' brb-on' : ''}">
      <video id="live-remote" autoplay playsinline muted></video>
      <button id="live-unmute" class="hidden" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);z-index:10;padding:12px 24px;border-radius:999px;border:none;background:rgba(0,0,0,.7);color:#fff;font-size:16px;font-weight:700;cursor:pointer">🔊 Tap for sound</button>
      <video id="fan-selfview" autoplay playsinline muted class="hidden"></video>
      <div id="live-blur-overlay" class="hidden">
        <div style="font-size:52px">🔞</div>
        <div id="live-blur-title" style="font-weight:800;font-size:19px;margin:8px 0">She's getting explicit…</div>
        <button class="btn" id="live-pay-btn">Pay to keep watching</button>
        <button class="btn ghost" id="live-gift-btn" style="margin-top:8px">🎁 Send a gift to unblur</button>
        <div class="muted small" id="live-countdown" style="margin-top:8px"></div>
        <button class="btn ghost" id="live-stay-free" style="margin-top:8px">Keep watching free (blurred)</button>
      </div>
      <div id="live-brb-overlay" class="${L.brb ? '' : 'hidden'}">${liveBrbCardHTML(L.modelName)}<button class="btn ghost" id="live-brb-leave" style="margin-top:18px">Leave stream</button></div>
      <div id="gift-anim" class="hidden"></div>
      <div id="gift-stack"></div>
      <div id="game-splash" class="hidden"></div>
      <div id="game-now" class="hidden"></div>
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
      <div class="live-bottom">
        <div class="live-actions-row">
          <button class="btn small" id="gift-open-btn" style="margin:0;background:linear-gradient(135deg,#ec4899,#8b5cf6)">🎁</button>
          <button class="btn small" id="tipmenu-open-btn" style="margin:0;background:linear-gradient(135deg,#f59e0b,#f97316)" aria-label="Tip menu">💰</button>
          <button class="btn small" id="priority-open-btn" style="margin:0;background:linear-gradient(135deg,#f59e0b,#ef4444)" aria-label="Send priority message">📢</button>
          <button class="btn small" id="stage-join-btn" style="margin:0;background:linear-gradient(135deg,#8b5cf6,#3b82f6)" aria-label="Join live on camera">🎥</button>
          <button class="btn small" id="game-open-btn" style="margin:0;background:linear-gradient(135deg,#ff5c9e,#FA4D92)" aria-label="Game Category">🎲</button>
        </div>
        <div class="stream-chat-input fan live-typing-bubble">
          <input id="stream-chat-box" class="input" placeholder="Chat is FREE — say hi! 💬" maxlength="500" autocomplete="off">
          <button class="btn small" id="stream-chat-send" style="margin:0" aria-label="Send">➤</button>
        </div>
        <div id="stage-banner" class="hidden"></div>
        <div class="live-controls">
          <button class="btn ghost" id="live-leave-btn">Leave stream</button>
        </div>
      </div>
    </div>`;
  $('#live-leave-btn').onclick = () => endLiveView();
  const brbLeave = $('#live-brb-leave');
  if (brbLeave) brbLeave.onclick = () => endLiveView();
  const sf = $('#live-stay-free');
  if (sf) sf.onclick = () => { clearInterval(S.live.countdownInt); $('#live-blur-overlay').classList.add('hidden'); };
  const sendBox = $('#stream-chat-box');
  // Two-row band (owner's design): the action icons own the row above,
  // the typing bubble owns its own full-width row — no width war, no
  // focus-expansion needed; typed text is always fully visible.
  const sendIt = () => {
    const v = sendBox.value.trim();
    if (v) { sendStreamChat(v); sendBox.value = ''; }
  };
  const stageSendBtn = $('#stream-chat-send');
  stageSendBtn.onclick = sendIt;
  // Keep the input focused (and the keyboard up) when send is tapped.
  stageSendBtn.addEventListener('pointerdown', (e) => e.preventDefault());
  sendBox.onkeydown = (e) => { if (e.key === 'Enter') sendIt(); };
  lockCopyForFans($('#stream-chat'), sendBox);
  $('#gift-open-btn').onclick = openGiftPanel;
  $('#game-open-btn').onclick = openGameSheet;
  const tmob = $('#tipmenu-open-btn');
  if (tmob && S.live) tmob.onclick = () => openTipMenuSheet(S.live.modelId, S.live.modelName || 'her', 'live');
  $('#priority-open-btn').onclick = openPriorityPanel;
  $('#stage-join-btn').onclick = requestStageJoin;
  loadStageState();
  startLeaderboardPolling();
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
  // Typing band rides the keyboard; show() untracks on the way out.
  trackLiveBand($('.live-bottom'));
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
              $('#split-fan').appendChild(a);
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
                $('#split-fan').appendChild(btn);
              }
            });
            const mic = $('#stage-mic');
            if (mic) mic.classList.remove('hidden');
          } else {
            const v = $('#stage-video');
            if (v) {
              v.srcObject = e.streams[0];
              v.classList.remove('hidden');
              v.muted = true; // Muted so iOS allows autoplay; audio plays via separate element below
              v.play().catch(() => {});
              // Play audio through a separate element so she hears you too
              const audioTracks = e.streams[0].getAudioTracks();
              if (audioTracks.length) {
                let a = $('#stage-audio-video');
                if (!a) {
                  a = document.createElement('audio');
                  a.id = 'stage-audio-video'; a.autoplay = true; a.playsInline = true;
                  $('#split-fan').appendChild(a);
                }
                a.srcObject = new MediaStream(audioTracks);
                a.play().catch(() => {});
              }
            }
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
    stopSpeechSafetyBot();
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

/* ---------------- PWA install: "Add to Home Screen" ---------------- */
// Every fan AND every model gets an elegant, dismissible invitation — a
// slim card on the Home view (fans and models share fanModels), plus a
// permanent row in the fan Wallet / in Model Settings. Never a blocking
// popup: an invitation, not a nag (casino rule). One shared implementation
// and one shared dismissed/installed flag, so whoever installs stops
// seeing it everywhere.
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
});
window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
  try { localStorage.setItem('sc_ath_dismissed', '1'); } catch (e) { /* ignore */ }
  const card = $('#ath-card');
  if (card) card.remove();
  toast(t('ath_installed'));
});

function athIsStandalone() {
  return !!((window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
    window.navigator.standalone);
}

// Which manual fallback the sheet shows when no native install prompt was
// captured: Android gets the ⋮-menu steps (the how-to video demonstrates
// iOS, so it would only confuse there); everything else keeps iOS steps.
function athPlatform() {
  const ua = (window.navigator && window.navigator.userAgent) || '';
  if (/Android/i.test(ua)) return 'android';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if (window.navigator && window.navigator.platform === 'MacIntel' &&
      window.navigator.maxTouchPoints > 1) return 'ios'; // iPadOS posing as Mac
  return 'other';
}

// Card markup — rendered with the Home view (shared by fans and models),
// but visible only for a signed-in fan or model, in a browser (not the
// installed app), who has not dismissed it on this device.
function athCardHTML() {
  if (!S.user || (S.user.role !== 'fan' && S.user.role !== 'model')) return '';
  if (athIsStandalone()) return '';
  try { if (localStorage.getItem('sc_ath_dismissed') === '1') return ''; } catch (e) { /* ignore */ }
  return `
  <div class="card ath-card" id="ath-card">
    <button class="ath-x" id="ath-dismiss" aria-label="Dismiss">✕</button>
    <div class="ath-t">📲 ${t('ath_card_t')}</div>
    <div class="muted small ath-sub">${t('ath_card_sub')}</div>
    <button class="btn" id="ath-open">${t('ath_btn')}</button>
  </div>`;
}

function wireAthCard() {
  const card = $('#ath-card');
  if (!card) return;
  $('#ath-open').onclick = openAthSheet;
  $('#ath-dismiss').onclick = () => {
    try { localStorage.setItem('sc_ath_dismissed', '1'); } catch (e) { /* ignore */ }
    card.remove();
  };
}

// The add sheet — paths: the browser's native install prompt when one was
// captured (Android/Chrome); otherwise platform steps — Android without a
// captured prompt gets the ⋮-menu steps only (no video: it demonstrates
// iOS), and iOS (which has no install prompt) gets the video + Share steps.
function openAthSheet() {
  const sheet = document.createElement('div');
  sheet.className = 'sheet-backdrop';
  const fallback = athPlatform() === 'android'
    ? `<div class="ath-steps">
         <div>${t('ath_astep1')}</div>
         <div>${t('ath_astep2')}</div>
         <div>${t('ath_astep3')}</div>
       </div>`
    : `<video class="ath-video" controls playsinline preload="metadata" src="/video/add-to-home-screen.mp4"></video>
       <div class="ath-steps">
         <div>${t('ath_step1')}</div>
         <div>${t('ath_step2')}</div>
         <div>${t('ath_step3')}</div>
       </div>`;
  sheet.innerHTML = `
    <div class="sheet">
      <div style="font-weight:800;font-size:18px;margin-bottom:12px">${t('ath_sheet_t')}</div>
      ${deferredPrompt
        ? `<button class="btn" id="ath-install" style="width:100%;min-height:44px">${t('ath_install_btn')}</button>`
        : fallback}
      <button class="btn ghost" id="ath-close" style="width:100%;margin-top:12px">${t('cancel')}</button>
    </div>`;
  document.body.appendChild(sheet);
  const close = () => {
    const v = sheet.querySelector('video');
    if (v) { try { v.pause(); } catch (e) { /* ignore */ } }
    sheet.remove();
  };
  sheet.querySelector('#ath-close').onclick = close;
  sheet.onclick = (e) => { if (e.target === sheet) close(); };
  const ib = sheet.querySelector('#ath-install');
  if (ib) ib.onclick = async () => {
    if (!deferredPrompt) return;
    const ev = deferredPrompt;
    deferredPrompt = null;
    try { ev.prompt(); } catch (e) { /* ignore */ }
    let choice = null;
    try { choice = await ev.userChoice; } catch (e) { /* ignore */ }
    if (choice && choice.outcome === 'accepted') {
      try { localStorage.setItem('sc_ath_dismissed', '1'); } catch (e) { /* ignore */ }
      const card = $('#ath-card');
      if (card) card.remove();
      close();
      toast(t('ath_installed'));
    }
  };
}

/* ---------------- call overlay buttons ---------------- */

$('#call-accept').onclick = acceptCall;
$('#call-decline').onclick = declineCall;
$('#call-hangup').onclick = hangupCall;
$('#call-error-retry').onclick = () => { hideCallError(); acceptCall(); };
$('#call-error-end').onclick = () => { hideCallError(); hangupCall(); };
$('#remote-video').addEventListener('playing', markRemoteLive);

/* ---------------- 18+ age gate ---------------- */
// Resolves when the visitor has verified they are 18+. The full-screen
// date-of-birth gate pops on EVERY visit for anyone who is not signed in
// (Corry, Oct 14, 2026) — passing is never remembered across loads.
// Signed-in accounts skip it: they attested 18+ with a DOB at signup.
function checkAgeGate() {
  return new Promise((resolve) => {
    if (S.token) return resolve();
    // Retire the old "remember me" flag from earlier versions.
    try { localStorage.removeItem('slutcamp_age_ok'); } catch (e) { /* ignore */ }
    const gate = $('#age-gate');
    gate.classList.remove('hidden');
    // The gate's text lives in static HTML (English at first paint) —
    // paint it from the dictionary in the visitor's current language,
    // picker included, and repaint in place if she switches language
    // right here at the door (see setLang).
    const paintGate = () => {
      const q = $('#gate-q');
      if (!q) return;
      q.textContent = t('gate_verify_h');
      $('#gate-sub').textContent = t('gate_sub');
      $('#gate-btn').textContent = t('gate_btn');
      $('#gate-lang').innerHTML = langPillsHTML();
    };
    gateLangRefresh = paintGate;
    paintGate();
    // Set max to today so future dates can't be picked
    const dob = $('#age-dob');
    dob.max = new Date().toISOString().slice(0, 10);
    $('#age-form').onsubmit = (e) => {
      e.preventDefault();
      const err = $('#age-error');
      err.classList.add('hidden');
      const val = dob.value;
      if (!val) {
        err.textContent = t('gate_err_empty');
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
        err.textContent = t('gate_err_invalid');
        err.classList.remove('hidden');
        return;
      }
      let age = now.getFullYear() - birth.getFullYear();
      const hadBirthday = now.getMonth() > birth.getMonth() ||
        (now.getMonth() === birth.getMonth() && now.getDate() >= birth.getDate());
      if (!hadBirthday) age--;
      gateLangRefresh = null;
      if (age >= 18) {
        gate.classList.add('hidden');
        resolve();
      } else {
        gate.querySelector('.age-gate-card').innerHTML =
          '<h1 class="age-gate-logo">SLUT<span>CAMP</span></h1>' +
          '<div class="age-gate-denied">' + t('gate_denied') + '</div>' +
          '<p><a href="https://www.google.com">' + t('gate_back_google') + '</a></p>';
      }
    };
  });
}

/* ---------------- presence heartbeat ----------------
   Pings /api/presence/ping every 30s while the app is open, so the
   Moderator panel can show a live headcount. Logged-in users ping under
   their session; guests under their guest token — or a persistent
   anonymous id (generated once) until they have one. Counts only; the
   ping carries no content. Fire-and-forget: a failed ping must never
   break or slow the app. */
function presenceAnonId() {
  let id = null;
  try { id = localStorage.getItem('wc_anon'); } catch (e) { /* storage unavailable */ }
  if (!id || !/^[a-f0-9]{32}$/.test(id)) {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    id = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    try { localStorage.setItem('wc_anon', id); } catch (e) { /* ignore */ }
  }
  return id;
}

function presencePing() {
  try {
    if (S.token || S.guestToken) {
      api('/presence/ping', { method: 'POST', body: '{}' }).catch(() => {});
    } else {
      fetch('/api/presence/ping', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ anon_id: presenceAnonId() }),
      }).catch(() => {});
    }
  } catch (e) { /* heartbeat must never break the app */ }
}

function startPresenceHeartbeat() {
  presencePing();
  setInterval(presencePing, 30000);
}

/* ---------------- forced refresh on every deploy ----------------
   Asce's rule (2026-10-16): NOBODY sits on a stale build — users are
   lazy and will not refresh themselves, even when they're logged in
   with the app just sitting open. The server stamps every deploy with
   a build id (GET /api/build-id); this watcher polls it, and the
   moment the deployed build no longer matches the build this page
   loaded under, it reloads the page — but ONLY once the app is idle,
   so an update never cuts off a call, a live, a purchase, or a
   half-typed message. While busy it re-checks every 30s and reloads
   at the first quiet moment.
   Login survives the reload untouched: the session token lives in
   localStorage ('wc_token'), which a page reload does not clear.
   The companion half is the service worker: a new deploy serves a
   byte-different /sw.js (deploy-scoped cache name) whose worker
   skipWaiting()s, deletes every old cache on activate, and claims
   this page — so the reload below always lands on fully fresh
   assets, cache-first files (pop-up art, icons) included. */
let _updatePending = false;
let _updateReloading = false;

function updateBusy() {
  try {
    // Broadcasting or watching a live — app.js maintains this body flag
    // exactly for the live views (liveBroadcast / liveWatch).
    if (document.body && document.body.classList.contains('in-live')) return true;
    // In a 1-on-1 call, dialing one, or staring at a call error — the
    // same overlay signals the Halloween pop-up engine checks before
    // it dares appear (#call-overlay / #active-call / #call-error,
    // visible exactly while they lack the .hidden class).
    const callIds = ['call-overlay', 'active-call', 'call-error'];
    for (const id of callIds) {
      const el = document.getElementById(id);
      if (el && !el.classList.contains('hidden')) return true;
    }
    // Any sheet / modal flow open — PPV price sheet, tip/gift/FaceTime/
    // booking sheets, the paywall: a purchase may be mid-flight. The
    // body flag is maintained by syncSheetState(); the selector is the
    // same one it watches.
    if (document.body && document.body.classList.contains('sheet-open')) return true;
    if (document.querySelector('#ppv-price-overlay, #voice-ov, #tip-ov, #paywall, .sheet-backdrop')) return true;
    // Typing (chat box, any form field) — never eat someone's text.
    const a = document.activeElement;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) return true;
  } catch (e) { return true; } // if we cannot tell, we are busy — never force it
  return false;
}

function tryApplyUpdate() {
  if (!_updatePending || _updateReloading) return;
  if (updateBusy()) return; // the 30s defer loop below keeps retrying
  _updateReloading = true;
  try { location.reload(); } catch (e) { _updateReloading = false; }
}

function startUpdateWatcher() {
  let baseline = null;
  let baselineSet = false;
  const check = async () => {
    try {
      const r = await fetch('/api/build-id', { cache: 'no-store' });
      if (!r.ok) return;
      const d = await r.json();
      if (!d || !d.build) return; // server can't identify its build — stay put
      if (!baselineSet) { baseline = d.build; baselineSet = true; return; }
      if (d.build !== baseline) { _updatePending = true; tryApplyUpdate(); }
    } catch (e) { /* offline or a mid-deploy blip — the next poll retries */ }
  };
  check();
  setInterval(check, 60000);          // poll the deployed build every 60s
  setInterval(tryApplyUpdate, 30000); // while busy, retry the reload every 30s
  // The service worker swapping under us (the new deploy's worker
  // claimed this page) is the same signal from the other side — funnel
  // it into the same idle-only reload path. The hadController guard
  // keeps the very first claim (fresh install) from counting as an
  // update.
  try {
    if ('serviceWorker' in navigator) {
      let hadController = !!navigator.serviceWorker.controller;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController) { hadController = true; return; }
        _updatePending = true;
        tryApplyUpdate();
      });
    }
  } catch (e) {}
}

/* ---------------- boot ---------------- */

(async function boot() {
  // Start the animated splash badge downloading IMMEDIATELY — boot
  // awaits the age gate before the splash renders, and the 916KB lips
  // animation must already be warm (index.html preloads it too) so it
  // is moving the moment the badge appears, on every open.
  try { const pre = new Image(); pre.src = '/img/logo-lips-anim.webp'; } catch (e) {}
  // CCBill browser return (?ccbill=success|fail): stash + clean the URL now;
  // routeInitial lands the fan back in the wallet with the right message.
  // (Credits themselves only ever come from CCBill's server webhook.)
  try {
    const qs = new URLSearchParams(window.location.search);
    let dirty = false;
    const cb = qs.get('ccbill');
    if (cb === 'success' || cb === 'fail') { window.__ccbillReturn = cb; dirty = true; }
    const pi = qs.get('pay_invoice');
    if (pi && /^\d+$/.test(pi)) {
      window.__payInvoice = parseInt(pi, 10);
      try { localStorage.setItem('sc_pay_invoice', String(window.__payInvoice)); } catch (e) {}
      dirty = true;
    }
    if (!window.__payInvoice) {
      try {
        const saved = localStorage.getItem('sc_pay_invoice');
        if (saved && /^\d+$/.test(saved)) window.__payInvoice = parseInt(saved, 10);
      } catch (e) {}
    }
    if (dirty) window.history.replaceState({}, '', window.location.pathname + window.location.hash);
  } catch (e) {}
  // Phantom deep-link returns (?phantom=connect|sent): consume them first —
  // a connect return continues straight into the payment send.
  try {
    if (await phantomHandleReturn(new URLSearchParams(window.location.search))) {
      try { window.history.replaceState({}, '', window.location.pathname + window.location.hash); } catch (e) {}
    }
  } catch (e) {}
  // Age gate first — nothing else renders until confirmed 18+
  await checkAgeGate();
  startPresenceHeartbeat();
  startUpdateWatcher();
  setupResumeSplash();
  // Visitor analytics: log one visit per session (powers Corry's growth dashboard)
  try {
    if (!sessionStorage.getItem('sc_visit')) {
      sessionStorage.setItem('sc_visit', '1');
      fetch('/api/track/visit', { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: window.location.pathname + window.location.hash, referrer: document.referrer })
      }).catch(() => {});
    }
  } catch (e) {}
  // Welcome splash on EVERY arrival — every link, every entry point, every
  // fresh page load (Corry: nobody bypasses the welcome page). No session
  // gate. After Enter (or the ~6s auto-enter) we route to wherever the
  // link actually pointed: promo profile, join flow, admin, or home.
  vWelcomeSplash(() => { bootSplashDone = true; routeInitial(); });
})();

async function routeInitial() {
  // The splash handed off — its in-place language hook is done.
  splashLangRefresh = null;
  // Old secret admin route: #boss → management lives in Slut Manager now
  if (window.location.hash === '#boss') {
    location.replace('/manager');
    return;
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
  // Affiliate invite link: #affiliate/CODE → recruiter signup with agreement
  const affMatch = window.location.hash.match(/^#affiliate\/([a-f0-9]{18})$/);
  if (affMatch) {
    try { window.history.replaceState({}, '', window.location.pathname); } catch (e) {}
    return vAffiliateSignup(affMatch[1]);
  }
  // Model promo link: #m/USERNAME → open that model's chat/live directly
  const promoMatch = window.location.hash.match(/^#m\/([a-zA-Z0-9_]+)$/);
  if (promoMatch) {
    await ensureGuest();
    wsConnect();
    const promoUsername = promoMatch[1].toLowerCase();
    try { window.history.replaceState({}, '', window.location.pathname); } catch (e) {}
    // Resolve username to model and open their chat (or live stream)
    try {
      const { data } = await api('/models');
      const models = data.models || [];
      const target = models.find((m) => (m.username || '').toLowerCase() === promoUsername);
      if (target) {
        if (S.token) {
          const { status } = await api('/me');
          if (status === 200) {
            await refreshMe();
            if (S.user.role === 'fan') {
              if (target.live_session_id) return watchLive(target.live_session_id);
              return openChatWithModel(target.id);
            }
          }
        }
        // Guest or non-fan: show model list (they can sign up then chat)
        return show('fanModels', {});
      }
    } catch (e) {}
    return show('fanModels', {});
  }
  if (S.token) {
    const { status } = await api('/me');
    if (status === 200) {
      await refreshMe();
      wsConnect();
      if (S.user.role === 'admin') {
        // Arriving from Slut Manager's Preview button (one-shot flag in
        // localStorage) → straight into the fan preview. Any other arrival
        // gets the manager-account interstitial — never silently inside.
        let fromManager = false;
        try {
          fromManager = localStorage.getItem('sc_manager_preview') === '1';
          localStorage.removeItem('sc_manager_preview');
        } catch (e) {}
        if (fromManager) { S.previewFan = true; return show('fanModels', {}); }
        return show('managerGate', {});
      }
      if (S.user.role === 'model') {
        await checkContractGate();
        return show('modelChats', {});
      }
      if (S.user.role === 'recruiter') return show('recruiter', {});
      if (window.__ccbillReturn && S.user.role === 'fan') {
        const r = window.__ccbillReturn; window.__ccbillReturn = null;
        setTimeout(() => toast(t(r === 'success' ? 'ccbill_success' : 'ccbill_fail')), 700);
        return show('wallet', {});
      }
      if (window.__payInvoice && S.user.role === 'fan') return show('wallet', {});
      return show('fanModels', {});
    }
    S.token = null;
    localStorage.removeItem('wc_token');
  }
  await ensureGuest();
  wsConnect();
  show('landing', {});
}

// Secret admin route on hash change (after initial load)
window.addEventListener('hashchange', () => {
  if (window.location.hash === '#boss') location.replace('/manager');
});

/* ---------------- resume splash (installed-PWA reopen) ----------------
   boot()'s splash only runs on a real page load. An installed PWA
   reopened from the home screen often just resumes the frozen WebView
   — no load, no boot, no lips (the owner's "I opened the app and the
   logo didn't pop up", 2026-10-16). So: when the app comes back to
   the foreground after being hidden for a real while (>= 60s), show
   the splash again as an OVERLAY on top of exactly where the user
   was. Enter (or the same ~6s auto-enter) removes ONLY the overlay —
   no routing, no re-render, the user lands back on their screen.
   Guards: the boot splash must have completed once (never compete
   with it), no splash may already be up (no stacking), and the user
   must not be busy — the exact idle test the update watcher uses
   (updateBusy: live/call/sheets/typing/voice overlay). Busy = skip
   entirely, never queue a splash for later. */
const RESUME_SPLASH_HIDDEN_MS = 60000;
let bootSplashDone = false;
let resumeSplashOpen = false;
let appHiddenAt = 0;

function setupResumeSplash() {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { appHiddenAt = Date.now(); return; }
    const awayMs = appHiddenAt ? Date.now() - appHiddenAt : 0;
    appHiddenAt = 0;
    if (awayMs >= RESUME_SPLASH_HIDDEN_MS) maybeShowResumeSplash();
  });
  // bfcache freeze/restore (iOS Safari/PWA): pagehide stamps the same
  // hidden-since clock, and a persisted pageshow is a resume — judged
  // by the same guards, and maybeShowResumeSplash's own flags make a
  // double fire (visibilitychange AND pageshow) a no-op.
  window.addEventListener('pagehide', () => { appHiddenAt = Date.now(); });
  window.addEventListener('pageshow', (e) => {
    if (!e.persisted) return;
    const awayMs = appHiddenAt ? Date.now() - appHiddenAt : 0;
    appHiddenAt = 0;
    if (awayMs >= RESUME_SPLASH_HIDDEN_MS) maybeShowResumeSplash();
  });
}

function maybeShowResumeSplash() {
  if (!bootSplashDone || resumeSplashOpen) return;
  if (document.getElementById('splash-enter')) return; // a splash is already up
  if (updateBusy()) return; // busy — skip entirely, do not queue
  resumeSplashOpen = true;
  vWelcomeSplash(() => { resumeSplashOpen = false; }, { overlay: true });
}

/* Welcome splash — shown on EVERY fresh page load, for every entry point.
   After Enter (or ~6s auto-enter) it hands off to routeInitial(), which
   lands the visitor wherever their link pointed. Audio is best-effort:
   a blocked/failed voice greeting never delays or blocks entering. */
function vWelcomeSplash(onDone, opts) {
  // Overlay mode (the resume splash): the SAME splash floated over the
  // live app inside a throwaway host element — app DOM, tabbar and the
  // language hook are NOT touched, and Enter removes only the host
  // (see enter() below), returning the user to exactly their screen.
  const overlayMode = !!(opts && opts.overlay);
  let host = null;
  // While the splash is up, a language switch just re-labels the splash
  // in place (see setLang) — the destination routing still waits for
  // Enter. The hook dies the moment routeInitial takes over.
  // (Boot mode only — the hook stays boot-mode only.)
  if (!overlayMode) {
    splashLangRefresh = () => {
      const t1 = document.getElementById('splash-t1');
      if (!t1) return;
      t1.textContent = t('splash_welcome');
      document.getElementById('splash-t2').textContent = t('splash_paradise');
      document.getElementById('splash-t3').textContent = t('splash_nutt');
      document.getElementById('splash-enter').textContent = t('enter');
      document.getElementById('splash-lang').innerHTML = langPillsHTML();
    };
    tabbar.classList.add('hidden'); tabbar.innerHTML = '';
  }
  const splashMarkup = `
    <div style="position:fixed;inset:0;overflow:hidden;background:radial-gradient(ellipse at center,#2a1040 0%,#0a0510 70%);display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:9999;animation:fadeIn .5s ease">
      <img src="/img/lips-logo.png" alt="" aria-hidden="true" style="position:absolute;top:46%;left:50%;transform:translate(-50%,-50%);width:min(135vw,680px);max-width:none;opacity:.10;filter:blur(3px);pointer-events:none">
      <div style="position:relative;z-index:1;display:flex;flex-direction:column;align-items:center">
      <div style="animation:logoPop 1s cubic-bezier(.34,1.56,.64,1) both">
        <img src="/img/logo-lips-anim.webp" alt="SlutCamp" onerror="this.onerror=null;this.src='/img/lips-logo.png'" style="display:block;margin:0 auto 14px;width:108px;height:108px;border-radius:50%;object-fit:cover;border:2px solid rgba(255,92,158,.65);box-shadow:0 0 28px rgba(255,45,120,.55),0 0 64px rgba(184,41,221,.35)">
        <div style="font-size:64px;font-weight:900;letter-spacing:2px">
          <span style="color:#fff">SLUT</span><span style="background:linear-gradient(135deg,#ff2d78,#b829dd);-webkit-background-clip:text;background-clip:text;color:transparent">CAMP</span>
        </div>
        <div style="text-align:center;font-size:28px;margin-top:8px">🏕️💦</div>
      </div>
      <div style="margin-top:24px;text-align:center;animation:fadeIn 1s ease .5s both">
        <div id="splash-t1" style="font-size:20px;font-weight:700;color:#fff">${t('splash_welcome')}</div>
        <div id="splash-t2" style="font-size:16px;color:#ff8ab5;margin-top:4px">${t('splash_paradise')}</div>
        <div id="splash-t3" style="font-size:14px;color:#a78bfa;margin-top:8px">${t('splash_nutt')}</div>
      </div>
      <button id="splash-enter" class="btn" style="margin-top:32px;animation:fadeIn 1s ease 1s both;background:linear-gradient(135deg,#ff2d78,#b829dd);font-size:18px;padding:14px 48px;border-radius:30px">
        ${t('enter')}
      </button>
      <div class="lang-row" id="splash-lang" style="margin-top:20px;animation:fadeIn 1s ease 1.2s both">${langPillsHTML()}</div>
      </div>
      <style>
        @keyframes logoPop { 0% { transform:scale(.3);opacity:0 } 60% { transform:scale(1.1) } 100% { transform:scale(1);opacity:1 } }
        @keyframes fadeIn { from { opacity:0 } to { opacity:1 } }
      </style>
    </div>`;
  if (overlayMode) {
    host = document.createElement('div');
    host.innerHTML = splashMarkup;
    document.body.appendChild(host);
  } else {
    app.innerHTML = splashMarkup;
  }
  // Play the sexy voice greeting (best-effort — browsers may block autoplay
  // until the visitor taps; the tap retries it, failure never blocks entry)
  let audio = null;
  const playGreeting = () => {
    try {
      if (!audio) { audio = new Audio('/audio/welcome.mp3'); audio.volume = 0.9; }
      const p = audio.play();
      if (p && p.catch) p.catch(() => {});
    } catch (e) {}
  };
  playGreeting();
  // Hand off to the real destination exactly once, whichever comes first:
  // the Enter tap or the ~6s auto-enter timer below.
  let handedOff = false;
  const enter = () => {
    if (handedOff) return;
    handedOff = true;
    closeLangSheet();
    playGreeting();
    // Overlay mode: remove ONLY the overlay host — the app underneath
    // (view, tabbar, scroll, chat state) is exactly as the user left it.
    if (host) { host.remove(); host = null; }
    if (typeof onDone === 'function') onDone();
  };
  $('#splash-enter').onclick = enter;
  // Auto-enter after 6 seconds — unconditional, audio state can't stop it
  setTimeout(() => { if (document.getElementById('splash-enter')) enter(); }, 6000);
}

/* ---------------- TERMS OF SERVICE ---------------- */

function vTerms() {
  tabbar.classList.add('hidden');
  app.innerHTML = `
    <div class="header">
      <h1>Slut<span class="logo">Camp</span> 📜</h1>
      <div class="sub">Terms of Service · Last updated October 15, 2026</div>
    </div>
    <div class="screen">
      <div class="card">
        <div style="font-weight:800;margin-bottom:8px">1. 18+ Only</div>
        <div class="small muted">SlutCamp is strictly for adults 18 and older. By using this app you confirm you are at least 18. Models must complete ID verification with SlutCamp before going live (18 U.S.C. §2257 compliance).</div>
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
        <div class="small muted">Models keep <b>60%</b> of everything fans spend on them; the platform keeps 40%. Payouts are sent by SlutCamp (currently processed manually). Models add their bank details in the app and request withdrawals anytime; pending requests are paid out on SlutCamp's schedule.</div>
      </div>
      <div class="card">
        <div style="font-weight:800;margin-bottom:8px">5. Live Streams & Explicit Content</div>
        <div class="small muted">Group streams are free to watch; explicit viewing requires a paid entry fee plus ongoing gifts to stay unblurred. Stage joins (video or mic) are 3 minutes, then timed out — re-pay to return. The model approves every stage join; declined requests are refunded in full. Priority messages are paid banners with optional paid voice.</div>
      </div>
      <div class="card">
        <div style="font-weight:800;margin-bottom:8px">6. 1-on-1 Bookings &amp; No-Shows</div>
        <div class="small muted">Booking a private 1-on-1 reserves the model's time just for you — bookings are paid upfront. When your 1-on-1 goes active, you have <b>3 minutes</b> to join the call; if you're a no-show, <b>there is no refund</b> — you booked a slot another fan could have taken, and her time was reserved for you. If the model doesn't start within <b>5 minutes</b> of the booked time, that's her no-show: you get a <b>full refund, automatically</b>. Fans can cancel for a full refund <b>2+ hours</b> before the start (requested bookings: 1+ hour ahead); the model can cancel anytime for a full refund.</div>
      </div>
      <div class="card">
        <div style="font-weight:800;margin-bottom:8px">7. Model Access</div>
        <div class="small muted">Model accounts are invite-only. SlutCamp may deactivate or remove any model account at any time, for any reason. Deactivated models keep earned balances available for withdrawal.</div>
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
      <p class="muted small" style="text-align:center;margin:16px 0">These terms are a plain-language summary, not legal advice.<br>Operated by World of Godz Entertainment LLC.<br><a href="javascript:void(0)" id="t-privacy" style="color:var(--pink)">Privacy Policy</a> · <a href="javascript:void(0)" id="t-billing" style="color:var(--pink)">Billing & Refunds</a> · <a href="javascript:void(0)" id="t-2257" style="color:var(--pink)">2257 Statement</a> · <a href="javascript:void(0)" id="t-dmca" style="color:var(--pink)">DMCA / Copyright takedown →</a></p>
      <button class="btn ghost" id="t-back">← Back</button>
    </div>`;
  $('#t-back').onclick = () => history.length > 1 ? history.back() : show('landing', {});
  $('#t-dmca').onclick = () => show('dmca', {});
  $('#t-privacy').onclick = () => show('privacy', {});
  $('#t-billing').onclick = () => show('billing', {});
  $('#t-2257').onclick = () => show('statement2257', {});
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
  // Back in the foreground: resync the tab + home-screen icon badges —
  // messages may have landed (and been read elsewhere) while we were away.
  if (!document.hidden && S.user) refreshTabBadges();
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
        <label class="field">SlutCamp URL(s) where it appears (one per line)<textarea class="input" id="dm-urls" rows="3" maxlength="4000" placeholder="https://slutcamp.app/…"></textarea></label>
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

/* ---------------- PRIVACY POLICY (public) ---------------- */

function vPrivacy() {
  tabbar.classList.add('hidden');
  app.innerHTML = `
    <div class="header">
      <h1>Slut<span class="logo">Camp</span> 🔒</h1>
      <div class="sub">Privacy Policy · Last updated October 13, 2026</div>
    </div>
    <div class="screen">
      <div class="card">
        <div style="font-weight:800;margin-bottom:8px">1. Who operates SlutCamp</div>
        <div class="small muted">SlutCamp is operated by World of Godz Entertainment LLC ("WOGENT"), San Antonio, Texas, USA. This policy explains what information the platform collects, why, and the choices you have. Privacy questions: <b>support@slutcamp.app</b>.</div>
      </div>
      <div class="card">
        <div style="font-weight:800;margin-bottom:8px">2. Information you give us</div>
        <div class="small muted">Account details (username, email address, password — stored hashed — and your 18+ date-of-birth confirmation), profile information and photos, messages, media and content you send or post, and — for models — identity documents for age and identity verification and tax information (such as a W-9) used for payouts and 1099 reporting.</div>
      </div>
      <div class="card">
        <div style="font-weight:800;margin-bottom:8px">3. Payment information</div>
        <div class="small muted">Purchases are processed by CCBill, our authorized third-party billing processor. Your full card number goes directly to the processor — we never receive or store it. We keep a record of what you bought, the amount, and when.</div>
      </div>
      <div class="card">
        <div style="font-weight:800;margin-bottom:8px">4. Information collected automatically</div>
        <div class="small muted">IP address, device and browser details, timestamps, and usage activity. Your 18+ confirmation is recorded with a timestamp and IP address. We use local storage on your device to keep you signed in and remember your language preference.</div>
      </div>
      <div class="card">
        <div style="font-weight:800;margin-bottom:8px">5. How we use information</div>
        <div class="small muted">To run the platform (accounts, chats, calls, live streams, and your wallet), process payments and model payouts, verify age and identity, handle required tax reporting, communicate with you, and keep the platform safe and legal.</div>
      </div>
      <div class="card">
        <div style="font-weight:800;margin-bottom:8px">6. Safety monitoring</div>
        <div class="small muted">Chats and live streams are monitored for safety and rule compliance, including automated tools that detect sharing of contact or payment information and other prohibited conduct (see the Terms of Service). Do not put private information in chats that you would not want reviewed for safety.</div>
      </div>
      <div class="card">
        <div style="font-weight:800;margin-bottom:8px">7. What we share</div>
        <div class="small muted">We do not sell personal information. We share only what is needed: with our billing processor to take payments, with hosting and service providers to run the app, with tax authorities for required reporting (for example, model 1099 forms), and when required by law or legal process, or to protect someone from harm.</div>
      </div>
      <div class="card">
        <div style="font-weight:800;margin-bottom:8px">8. How long we keep it</div>
        <div class="small muted">Account information is kept while your account is active. Transaction and tax records are kept as long as the law requires. Performer verification records (18 U.S.C. § 2257) are retained for at least five years, as federal law requires. Older chat messages and chat media are deleted automatically on a rolling basis (generally after 14 days). Money records are never deleted.</div>
      </div>
      <div class="card">
        <div style="font-weight:800;margin-bottom:8px">9. Your choices</div>
        <div class="small muted">You can update your profile at any time in Settings. To ask about, correct, or delete your personal information, email us at the address in section 1. Some records (transactions, tax filings, and 2257 verification records) must be kept by law even after an account closes.</div>
      </div>
      <div class="card">
        <div style="font-weight:800;margin-bottom:8px">10. Adults only</div>
        <div class="small muted">SlutCamp is an 18+ service. We do not knowingly collect information from anyone under 18, and accounts found to belong to minors are removed.</div>
      </div>
      <div class="card">
        <div style="font-weight:800;margin-bottom:8px">11. Changes</div>
        <div class="small muted">We may update this policy from time to time. The current version always lives on this page, with the date at the top.</div>
      </div>
      <p class="muted small" style="text-align:center;margin:16px 0">This policy is a plain-language summary, not legal advice.<br>Operated by World of Godz Entertainment LLC.<br><a href="javascript:void(0)" id="pv-terms" style="color:var(--pink)">Terms of Service</a> · <a href="javascript:void(0)" id="pv-billing" style="color:var(--pink)">Billing & Refunds</a> · <a href="javascript:void(0)" id="pv-2257" style="color:var(--pink)">2257 Statement</a> · <a href="javascript:void(0)" id="pv-dmca" style="color:var(--pink)">DMCA</a></p>
      <button class="btn ghost" id="p-back">← Back</button>
    </div>`;
  $('#p-back').onclick = () => history.length > 1 ? history.back() : show('landing', {});
  $('#pv-terms').onclick = () => show('terms', {});
  $('#pv-billing').onclick = () => show('billing', {});
  $('#pv-2257').onclick = () => show('statement2257', {});
  $('#pv-dmca').onclick = () => show('dmca', {});
}

/* ---------------- BILLING, REFUNDS & CANCELLATION (public) ---------------- */

function vBilling() {
  tabbar.classList.add('hidden');
  app.innerHTML = `
    <div class="header">
      <h1>Slut<span class="logo">Camp</span> 💳</h1>
      <div class="sub">Billing, Refunds & Cancellation · Last updated October 13, 2026</div>
    </div>
    <div class="screen">
      <div class="card">
        <div style="font-weight:800;margin-bottom:8px">1. Who is billing you</div>
        <div class="small muted">SlutCamp is operated by World of Godz Entertainment LLC. All card payments are processed securely by <b>CCBill</b>, our authorized third-party billing processor.</div>
      </div>
      <div class="card">
        <div style="font-weight:800;margin-bottom:8px">2. What shows on your statement</div>
        <div class="small muted">Charges appear discreetly as a CCBill charge referencing <b>"WOGENT"</b>. The word "SlutCamp" will never appear on your card statement.</div>
      </div>
      <div class="card">
        <div style="font-weight:800;margin-bottom:8px">3. What you are buying</div>
        <div class="small muted">Fans buy credit packages for the SlutCamp wallet. The full price is shown before you confirm — no hidden fees and no surprise charges. Credits are added to your wallet as soon as payment clears, and can be spent on chats, calls, gifts, live access, and bookings at the rates shown in the app.</div>
      </div>
      <div class="card">
        <div style="font-weight:800;margin-bottom:8px">4. Recurring charges</div>
        <div class="small muted">SlutCamp does not currently charge automatic recurring subscriptions — you only pay when you choose to buy credits. If a recurring plan is ever offered, its full price and renewal terms will be shown before checkout, and you will be able to cancel it at any time from your wallet or through CCBill.</div>
      </div>
      <div class="card">
        <div style="font-weight:800;margin-bottom:8px">5. Refunds</div>
        <div class="small muted">Spent credits are non-refundable (see Terms of Service, section 9). Unused credits stay in your wallet and are not redeemable for cash. If you were charged in error, charged twice for the same purchase, or a paid purchase never reached your wallet, contact us within 60 days of the charge and we will make it right — approved refunds are returned to your original payment method, generally within 5–10 business days.</div>
      </div>
      <div class="card">
        <div style="font-weight:800;margin-bottom:8px">6. Cancellation</div>
        <div class="small muted">You may stop using SlutCamp at any time. Cancellation stops any future charges; it does not refund charges already made. To close your account or cancel any billing arrangement, email us (section 8) or contact CCBill consumer support.</div>
      </div>
      <div class="card">
        <div style="font-weight:800;margin-bottom:8px">7. Chargebacks</div>
        <div class="small muted">Please contact us before disputing a charge with your bank — most billing problems are simple misunderstandings that we can fix quickly, including refunding genuine billing errors. Accounts with chargebacks may be closed and any remaining wallet credits forfeited.</div>
      </div>
      <div class="card">
        <div style="font-weight:800;margin-bottom:8px">8. Get help</div>
        <div class="small muted">Billing and account support:<br>Email: <b>support@slutcamp.app</b><br>Phone (call or text): <b>(210) 943-6509</b><br>In the app: message the admin from your inbox.<br>CCBill consumer support (24/7): <a href="https://support.ccbill.com" target="_blank" rel="noopener" style="color:var(--pink)">support.ccbill.com</a><br>Copyright / DMCA matters: use the DMCA page linked below.</div>
      </div>
      <div class="card">
        <div style="font-weight:800;margin-bottom:8px">9. Paying with crypto</div>
        <div class="small muted">You can also load credits with Bitcoin (BTC), USDT, Ethereum (ETH), Solana (SOL) or XRP from the Wallet tab. The exchange rate is locked when your invoice is created and stays fixed for 30 minutes — send the exact amount shown to the address on your invoice. Two coins need one extra detail, shown big on your invoice: for <b>XRP</b>, always include the destination tag, and for <b>Solana</b>, send the exact amount to the last decimal — the tag and the exact amount are how your payment is matched to your account. Credits are added automatically after 1 network confirmation. Crypto loads are final: once credits are in your wallet they follow the same rules as card loads (section 5), and crypto cannot be refunded back to a wallet address. If you send less than the invoice amount, you receive proportional credits automatically when the payment window closes. If you send more than the package price, the package is credited in full and the extra amount is recorded — email us (section 8) with your transaction ID and we will make it right.</div>
      </div>
      <p class="muted small" style="text-align:center;margin:16px 0">This page is a plain-language summary, not legal advice.<br>Operated by World of Godz Entertainment LLC.<br><a href="javascript:void(0)" id="bl-terms" style="color:var(--pink)">Terms of Service</a> · <a href="javascript:void(0)" id="bl-privacy" style="color:var(--pink)">Privacy Policy</a> · <a href="javascript:void(0)" id="bl-2257" style="color:var(--pink)">2257 Statement</a> · <a href="javascript:void(0)" id="bl-dmca" style="color:var(--pink)">DMCA</a></p>
      <button class="btn ghost" id="b-back">← Back</button>
    </div>`;
  $('#b-back').onclick = () => history.length > 1 ? history.back() : show('landing', {});
  $('#bl-terms').onclick = () => show('terms', {});
  $('#bl-privacy').onclick = () => show('privacy', {});
  $('#bl-2257').onclick = () => show('statement2257', {});
  $('#bl-dmca').onclick = () => show('dmca', {});
}

/* ---------------- 2257 COMPLIANCE STATEMENT (public) ---------------- */

function vStatement2257() {
  tabbar.classList.add('hidden');
  app.innerHTML = `
    <div class="header">
      <h1>Slut<span class="logo">Camp</span> 📋</h1>
      <div class="sub">18 U.S.C. § 2257 Record-Keeping Requirements Compliance Statement</div>
    </div>
    <div class="screen">
      <div class="card">
        <div style="font-weight:800;margin-bottom:8px">Compliance statement</div>
        <div class="small muted">All models, actors, actresses, and other persons who appear in any visual depiction of actual or simulated sexually explicit conduct appearing on or otherwise contained in this website were over the age of eighteen (18) years at the time of the creation of such depictions.</div>
      </div>
      <div class="card">
        <div style="font-weight:800;margin-bottom:8px">Performer verification</div>
        <div class="small muted">Every performer on SlutCamp must pass government-issued ID verification before appearing in any content, chat, or live stream. For content created by independent creators, the producing creator maintains the original production records, and the Custodian of Records below maintains the platform's age and identity verification records for every performer who appears on this website.</div>
      </div>
      <div class="card">
        <div style="font-weight:800;margin-bottom:8px">📮 Custodian of Records</div>
        <div class="small muted">The records required to be maintained pursuant to 18 U.S.C. § 2257 and 28 C.F.R. Part 75 are kept by the Custodian of Records at the following address, and are available for inspection during normal business hours:<br><br>
        <b>Custodian of Records</b><br>
        World of Godz Entertainment LLC dba SlutCamp<br>
        7511 Oak Chase St<br>
        San Antonio, TX 78239, USA</div>
      </div>
      <div class="card">
        <div style="font-weight:800;margin-bottom:8px">Content complaints</div>
        <div class="small muted">To report content, request a removal, or raise a concern about any depiction on this website, email <b>support@slutcamp.app</b> or use the DMCA / takedown page linked below. Content complaints are reviewed and resolved within 7 business days.</div>
      </div>
      <p class="muted small" style="text-align:center;margin:16px 0">Operated by World of Godz Entertainment LLC.<br><a href="javascript:void(0)" id="sf-terms" style="color:var(--pink)">Terms of Service</a> · <a href="javascript:void(0)" id="sf-privacy" style="color:var(--pink)">Privacy Policy</a> · <a href="javascript:void(0)" id="sf-billing" style="color:var(--pink)">Billing & Refunds</a> · <a href="javascript:void(0)" id="sf-dmca" style="color:var(--pink)">DMCA</a></p>
      <button class="btn ghost" id="s-back">← Back</button>
    </div>`;
  $('#s-back').onclick = () => history.length > 1 ? history.back() : show('landing', {});
  $('#sf-terms').onclick = () => show('terms', {});
  $('#sf-privacy').onclick = () => show('privacy', {});
  $('#sf-billing').onclick = () => show('billing', {});
  $('#sf-dmca').onclick = () => show('dmca', {});
}
