'use strict';
/*
 * theme.js — SlutCamp seasonal theme engine ("facelift" system).
 *
 * What it does:
 *   - Picks a holiday theme from the calendar (see CALENDAR below), or
 *     from an explicit override, and dresses the public app in it:
 *     a CSS variable pack (public/css/themes/<name>.css), a slim greeting
 *     banner, a gentle falling-emoji particle layer, and — Halloween
 *     only — a slim house-promo strip under the banner.
 *   - When the season ends, the calendar simply stops resolving a theme
 *     and the app is back to normal. Zero server involvement, zero app
 *     logic: this file only ever ADDS decoration. If anything in here
 *     throws, the catch-all strips the decorations and the app runs on
 *     untouched — a theme bug can never break SlutCamp.
 *
 * Overrides (for previews and support):
 *   ?theme=<name>   force a pack (halloween, christmas, ...) — saved to
 *                   localStorage 'sc_theme_override' so it sticks.
 *   ?theme=off      force NO theme — also saved.
 *   ?theme=auto     clear the saved override; calendar decides again.
 *   A stored override beats the calendar; unknown names are ignored.
 *
 * Packs: metadata lives in THEMES below and MUST mirror the files in
 * public/css/themes/ (tests enforce the match both ways). Variable
 * overrides live in the CSS packs under :root[data-theme='<name>'].
 * Structural banner/particle CSS is shared: css/themes/theme-base.css.
 *
 * Node (tests) gets { THEMES, resolveTheme, calendarTheme, easterSunday,
 * fourthThursdayOfNovember, POPUP_MODELS, POPUP_POSES, POPUP_SCHEDULE,
 * popupCombos, popupImagePath, nextPopupInterval, createPopupPicker }
 * via module.exports; browsers get the same object as
 * window.SeasonalTheme.
 */
(function () {
  /* ---------------------------------------------------------------- */
  /* Pack metadata: greeting banner text, particle emojis, and the     */
  /* browser chrome color (theme-color meta). Keep in sync with the    */
  /* CSS files in public/css/themes/.                                  */
  /* ---------------------------------------------------------------- */
  var THEMES = {
    halloween: {
      greeting: '🎃 Wicked season is here — tricks, treats & after-dark delights, all October long 🦇',
      emojis: ['🎃', '👻', '🦇', '🕷️', '🌕', '🔮'],
      themeColor: '#12060f',
      promo: '🎃 Wicked deals all October — spooky specials waiting in Lives 🦇',
    },
    thanksgiving: {
      greeting: '🦃 Grateful for you — pull up a chair, the feast runs all week 🍂',
      emojis: ['🦃', '🍂', '🥧', '🍁', '🌽'],
      themeColor: '#170c06',
    },
    christmas: {
      greeting: '🎄 Naughty or nice? Festive treats are waiting under the tree ✨',
      emojis: ['🎄', '❄️', '🎁', '⭐', '🔔'],
      themeColor: '#08130c',
    },
    newyear: {
      greeting: '🥂 New year, new desires — let’s ring it in together 🎆',
      emojis: ['🥂', '🎆', '✨', '🎉', '🍾'],
      themeColor: '#0a0a12',
    },
    valentines: {
      greeting: '💘 Be ours — Cupid is working overtime this week 💋',
      emojis: ['💘', '💋', '🌹', '💌', '❤️'],
      themeColor: '#1c0812',
    },
    stpatricks: {
      greeting: '🍀 Feeling lucky? Chase the rainbow with us 🌈',
      emojis: ['🍀', '🌈', '💰', '🍺', '☘️'],
      themeColor: '#07130a',
    },
    easter: {
      greeting: '🐣 Spring fever — a little hunt, a lot of treats 🌷',
      emojis: ['🐣', '🐰', '🌷', '🥚', '🦋'],
      themeColor: '#150e1c',
    },
    july4: {
      greeting: '🎆 Sparks fly — fireworks, freedom & a long hot weekend 🇺🇸',
      emojis: ['🎆', '🇺🇸', '⭐', '🎇', '🍒'],
      themeColor: '#080d1a',
    },
  };

  /* ---------------------------------------------------------------- */
  /* Calendar                                                          */
  /*                                                                   */
  /* Windows (local date, both ends inclusive):                        */
  /*   halloween     Oct 1 – Oct 31                                    */
  /*   thanksgiving  Nov 20 – 4th Thursday of November                 */
  /*   christmas     Dec 1 – Dec 25                                    */
  /*   newyear       Dec 28 – Jan 2                                    */
  /*   valentines    Feb 7 – Feb 14                                    */
  /*   stpatricks    Mar 10 – Mar 17                                   */
  /*   easter        Good Friday – Easter Sunday (computed)            */
  /*   july4         Jun 27 – Jul 4                                    */
  /*                                                                   */
  /* The windows never overlap by construction. If a future window     */
  /* ever did overlap, the computed feasts (easter, thanksgiving) are  */
  /* checked first and win — they are the more specific holidays.      */
  /* ---------------------------------------------------------------- */

  /* Easter Sunday via the Anonymous Gregorian computus.
     Returns { month, day } (month is 3 = March or 4 = April). */
  function easterSunday(year) {
    var a = year % 19;
    var b = Math.floor(year / 100);
    var c = year % 100;
    var d = Math.floor(b / 4);
    var e = b % 4;
    var f = Math.floor((b + 8) / 25);
    var g = Math.floor((b - f + 1) / 3);
    var h = (19 * a + b - d - g + 15) % 30;
    var i = Math.floor(c / 4);
    var k = c % 4;
    var l = (32 + 2 * e + 2 * i - h - k) % 7;
    var mm = Math.floor((a + 11 * h + 22 * l) / 451);
    var month = Math.floor((h + l - 7 * mm + 114) / 31);
    var day = ((h + l - 7 * mm + 114) % 31) + 1;
    return { month: month, day: day };
  }

  /* Day-of-month (22–28) of the 4th Thursday of November. */
  function fourthThursdayOfNovember(year) {
    var dow = new Date(year, 10, 1).getDay(); // 0=Sun … 4=Thu … 6=Sat
    var firstThursday = 1 + ((4 - dow + 7) % 7);
    return firstThursday + 21;
  }

  /* The theme the calendar alone calls for on `date` (a Date), or null. */
  function calendarTheme(date) {
    var y = date.getFullYear();
    var m = date.getMonth() + 1;
    var d = date.getDate();

    // Easter: Good Friday through Easter Sunday (computed feast first).
    var es = easterSunday(y);
    var dayOnly = new Date(y, m - 1, d).getTime();
    var goodFriday = new Date(y, es.month - 1, es.day - 2).getTime();
    var easterDay = new Date(y, es.month - 1, es.day).getTime();
    if (dayOnly >= goodFriday && dayOnly <= easterDay) return 'easter';

    // Thanksgiving: Nov 20 through the 4th Thursday of November.
    if (m === 11 && d >= 20 && d <= fourthThursdayOfNovember(y)) return 'thanksgiving';

    if (m === 10) return 'halloween'; // Oct 1–31
    if (m === 12 && d <= 25) return 'christmas'; // Dec 1–25
    if ((m === 12 && d >= 28) || (m === 1 && d <= 2)) return 'newyear'; // Dec 28 – Jan 2
    if (m === 2 && d >= 7 && d <= 14) return 'valentines'; // Feb 7–14
    if (m === 3 && d >= 10 && d <= 17) return 'stpatricks'; // Mar 10–17
    if ((m === 6 && d >= 27) || (m === 7 && d <= 4)) return 'july4'; // Jun 27 – Jul 4
    return null;
  }

  /*
   * resolveTheme(date, override) → theme name | null. Pure.
   *   override 'off'          → null (explicitly no theme)
   *   override known name     → that theme, whatever the date
   *   override null/unknown   → the calendar decides
   */
  function resolveTheme(date, override) {
    if (override != null && override !== '') {
      var o = String(override).toLowerCase();
      if (o === 'off') return null;
      if (Object.prototype.hasOwnProperty.call(THEMES, o)) return o;
    }
    return calendarTheme(date);
  }

  /* ---------------------------------------------------------------- */
  /* Halloween pop-up girls (pure logic; DOM glue is browser-side).   */
  /*                                                                   */
  /* While the halloween pack is active AND a fan/model is logged in, */
  /* an anime witch pops into a bottom corner every few minutes: a    */
  /* kiss-blower (winking, hearts) or a twerker, rotating through six  */
  /* models. She is strictly decorative — pointer-events:none, a few  */
  /* seconds on screen, never in the way. Art: public/img/popups/     */
  /* <model>-<pose>.webp — the roster below MUST mirror those files   */
  /* (tests enforce the match both ways).                             */
  /* ---------------------------------------------------------------- */
  var POPUP_MODELS = ['pink', 'purple', 'blonde', 'red', 'black', 'silver'];
  var POPUP_POSES = ['kiss', 'twerk'];
  var POPUP_SCHEDULE = {
    firstDelayMs: 20000,      // first pop 20 seconds after login
    intervalMinMs: 210000,    // then every 3.5–5 minutes, randomized
    intervalMaxMs: 300000,
    showMs: 6000,             // ~6 seconds on screen per pop
  };

  /* All model × pose combinations, in roster order. */
  function popupCombos() {
    var out = [];
    for (var i = 0; i < POPUP_MODELS.length; i++) {
      for (var j = 0; j < POPUP_POSES.length; j++) {
        out.push({ model: POPUP_MODELS[i], pose: POPUP_POSES[j] });
      }
    }
    return out;
  }

  function popupImagePath(combo) {
    return '/img/popups/' + combo.model + '-' + combo.pose + '.webp';
  }

  /* Randomized gap until the next pop, within the schedule bounds. */
  function nextPopupInterval(random) {
    var rand = typeof random === 'function' ? random : Math.random;
    var span = POPUP_SCHEDULE.intervalMaxMs - POPUP_SCHEDULE.intervalMinMs;
    return POPUP_SCHEDULE.intervalMinMs + Math.floor(rand() * (span + 1));
  }

  /*
   * Shuffle-bag picker: draws model × pose combos without replacement
   * until every combo has appeared, then refills and reshuffles. On top
   * of that, whenever the bag still holds the other pose, the same pose
   * type never plays twice in a row (no twerk-twerk / kiss-kiss runs).
   * `random` is injectable so tests can drive it deterministically.
   */
  function createPopupPicker(random) {
    var rand = typeof random === 'function' ? random : Math.random;
    var bag = [];
    var lastPose = null;
    function refill() {
      bag = popupCombos();
      for (var i = bag.length - 1; i > 0; i--) {
        var j = Math.floor(rand() * (i + 1));
        var t = bag[i]; bag[i] = bag[j]; bag[j] = t;
      }
    }
    refill();
    return {
      next: function () {
        if (!bag.length) refill();
        var pick = 0;
        if (lastPose) {
          var others = [];
          for (var i = 0; i < bag.length; i++) {
            if (bag[i].pose !== lastPose) others.push(i);
          }
          if (others.length) pick = others[Math.floor(rand() * others.length)];
        }
        var combo = bag.splice(pick, 1)[0];
        lastPose = combo.pose;
        return combo;
      },
      remaining: function () { return bag.length; },
    };
  }

  var api = {
    THEMES: THEMES,
    resolveTheme: resolveTheme,
    calendarTheme: calendarTheme,
    easterSunday: easterSunday,
    fourthThursdayOfNovember: fourthThursdayOfNovember,
    POPUP_MODELS: POPUP_MODELS,
    POPUP_POSES: POPUP_POSES,
    POPUP_SCHEDULE: POPUP_SCHEDULE,
    popupCombos: popupCombos,
    popupImagePath: popupImagePath,
    nextPopupInterval: nextPopupInterval,
    createPopupPicker: createPopupPicker,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  /* ---------------------------------------------------------------- */
  /* Browser side. Node never reaches here.                            */
  /* ---------------------------------------------------------------- */
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  window.SeasonalTheme = api;

  var OVERRIDE_KEY = 'sc_theme_override';
  var PARTICLE_COUNT = 12;

  function storageGet(store, key) {
    try { return store.getItem(key); } catch (e) { return null; }
  }
  function storageSet(store, key, val) {
    try { store.setItem(key, val); } catch (e) { /* private mode — fine */ }
  }
  function storageRemove(store, key) {
    try { store.removeItem(key); } catch (e) { /* ignore */ }
  }

  /* Effective override: a ?theme= in the URL wins right now and is
     persisted; a stored override from an earlier visit applies next. */
  function currentOverride() {
    var stored = storageGet(window.localStorage, OVERRIDE_KEY);
    try {
      var q = new URLSearchParams(window.location.search);
      if (q.has('theme')) {
        var v = (q.get('theme') || '').toLowerCase();
        if (v === 'auto') {
          storageRemove(window.localStorage, OVERRIDE_KEY);
          stored = null;
        } else if (v) {
          storageSet(window.localStorage, OVERRIDE_KEY, v);
          stored = v;
        }
      }
    } catch (e) { /* URL parsing is best-effort */ }
    return stored;
  }

  function loadCss(href) {
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    document.head.appendChild(link);
    return link;
  }

  function renderBanner(name, meta) {
    var dismissedKey = 'sc_theme_banner_dismissed_' + name;
    if (storageGet(window.sessionStorage, dismissedKey)) return;
    var banner = document.createElement('div');
    banner.className = 'sc-theme-banner';
    banner.setAttribute('role', 'note');

    var text = document.createElement('span');
    text.className = 'sc-theme-banner-text';
    text.textContent = meta.greeting;
    banner.appendChild(text);

    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'sc-theme-banner-close';
    close.setAttribute('aria-label', 'Dismiss seasonal banner');
    close.textContent = '✕';
    close.addEventListener('click', function () {
      storageSet(window.sessionStorage, dismissedKey, '1');
      if (banner.parentNode) banner.parentNode.removeChild(banner);
    });
    banner.appendChild(close);

    // Inside the phone column when there is one, so the strip sits
    // natively on top of the app; body top as the fallback.
    var host = document.getElementById('phone') || document.body;
    host.insertBefore(banner, host.firstChild);
  }

  /* Slim house-promo strip under the greeting banner. Halloween ONLY:
     the explicit name gate is the contract (tests pin it), and no other
     pack carries a promo field. In-flow in the #phone column like the
     banner, so app.js navigation (which only rewrites #app) can never
     wipe it. */
  function renderPromo(name, meta) {
    if (name !== 'halloween' || !meta.promo) return;
    var promo = document.createElement('div');
    promo.className = 'sc-theme-promo';
    promo.setAttribute('role', 'note');
    promo.textContent = meta.promo;
    var host = document.getElementById('phone') || document.body;
    var banner = host.querySelector('.sc-theme-banner');
    if (banner && banner.parentNode === host) {
      host.insertBefore(promo, banner.nextSibling);
    } else {
      host.insertBefore(promo, host.firstChild);
    }
  }

  function renderParticles(meta) {
    var reduced = false;
    try {
      reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (e) { /* if we can't tell, still render gently */ }
    if (reduced) return;

    var layer = document.createElement('div');
    layer.className = 'sc-theme-particles';
    layer.setAttribute('aria-hidden', 'true');
    for (var i = 0; i < PARTICLE_COUNT; i++) {
      var s = document.createElement('span');
      s.textContent = meta.emojis[i % meta.emojis.length];
      s.style.left = (Math.random() * 96).toFixed(2) + '%';
      s.style.fontSize = (14 + Math.random() * 14).toFixed(0) + 'px';
      s.style.animationDuration = (9 + Math.random() * 10).toFixed(2) + 's';
      s.style.animationDelay = (-Math.random() * 14).toFixed(2) + 's';
      layer.appendChild(s);
    }
    document.body.appendChild(layer);
  }

  /* ---------------------------------------------------------------- */
  /* Halloween pop-up girls — browser glue.                            */
  /*                                                                   */
  /* Runs ONLY when the resolved theme is 'halloween' and a login      */
  /* token ('wc_token') is present. The public app serves fans and     */
  /* models from the same screens, so both see her; the Manager never  */
  /* loads theme.js, so she never appears there. Login state is        */
  /* checked at start, on 'storage' events (other tabs) and on a slow  */
  /* poll (same-tab SPA login/logout): she starts when you log in and  */
  /* stops when you log out. Every step is best-effort — any error     */
  /* quietly disables the pop-ups, never the app.                      */
  /* ---------------------------------------------------------------- */
  var popup = {
    running: false,
    picker: null,
    timer: null,
    hideTimer: null,
    outTimer: null,
    node: null,
  };

  function popupToken() {
    return storageGet(window.localStorage, 'wc_token');
  }

  function popupReducedMotion() {
    try {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (e) { return false; }
  }

  /* True while the user is in a 1:1 call or a live room — she never
     interrupts those. Signals maintained by app.js itself: the call
     overlays (#call-overlay / #active-call / #call-error) lose their
     .hidden class while up, and <body> carries .in-live exactly for
     the liveBroadcast / liveWatch views. */
  function popupBlockedByCallOrLive() {
    try {
      if (document.body && document.body.classList.contains('in-live')) return true;
      var ids = ['call-overlay', 'active-call', 'call-error'];
      for (var i = 0; i < ids.length; i++) {
        var el = document.getElementById(ids[i]);
        if (el && !el.classList.contains('hidden')) return true;
      }
    } catch (e) { /* if we cannot tell, do not block */ }
    return false;
  }

  function popupClearTimers() {
    if (popup.timer) { window.clearTimeout(popup.timer); popup.timer = null; }
    if (popup.hideTimer) { window.clearTimeout(popup.hideTimer); popup.hideTimer = null; }
    if (popup.outTimer) { window.clearTimeout(popup.outTimer); popup.outTimer = null; }
  }

  function popupRemoveNode() {
    if (popup.node && popup.node.parentNode) popup.node.parentNode.removeChild(popup.node);
    popup.node = null;
  }

  function popupSchedule(delayMs) {
    if (!popup.running) return;
    if (popup.timer) window.clearTimeout(popup.timer);
    popup.timer = window.setTimeout(popupShow, delayMs);
  }

  function popupStart() {
    if (popup.running) return;
    popup.running = true;
    if (!popup.picker) popup.picker = createPopupPicker(Math.random);
    popupSchedule(POPUP_SCHEDULE.firstDelayMs);
  }

  function popupStop() {
    popup.running = false;
    popupClearTimers();
    popupRemoveNode();
  }

  function popupCheckLogin() {
    try {
      if (popupToken()) popupStart();
      else if (popup.running) popupStop();
    } catch (e) { /* best-effort only */ }
  }

  function popupShow() {
    popup.timer = null;
    try {
      if (!popup.running) return;
      if (!popupToken()) { popupStop(); return; }
      // Skip this cycle (retry after a normal interval) when the
      // moment is wrong: tab hidden, a pop already on screen, or the
      // user is in a call / live room.
      if (document.hidden || popup.node || popupBlockedByCallOrLive()) {
        popupSchedule(nextPopupInterval(Math.random));
        return;
      }
      var combo = popup.picker.next();
      var img = new Image();
      img.onload = function () {
        try { popupRender(combo, img); }
        catch (e) { popupSchedule(nextPopupInterval(Math.random)); }
      };
      img.onerror = function () {
        // Missing art must never break the rhythm — skip silently.
        try { popupSchedule(nextPopupInterval(Math.random)); } catch (e) { /* ignore */ }
      };
      img.src = popupImagePath(combo);
    } catch (e) {
      try { popupSchedule(nextPopupInterval(Math.random)); } catch (e2) { /* give up quietly */ }
    }
  }

  function popupRender(combo, img) {
    if (!popup.running || popup.node) {
      popupSchedule(nextPopupInterval(Math.random));
      return;
    }
    var box = document.createElement('div');
    box.className = 'sc-popup sc-popup--' + combo.pose +
      (Math.random() < 0.5 ? ' sc-popup--left' : ' sc-popup--right');
    box.setAttribute('aria-hidden', 'true');
    // Hard rule, enforced inline as well as in the pack CSS: she can
    // never be clicked and can never block what the user is doing.
    box.style.pointerEvents = 'none';

    var bounce = document.createElement('div');
    bounce.className = 'sc-popup-bounce';
    img.className = 'sc-popup-img';
    img.alt = '';
    img.draggable = false;
    img.style.pointerEvents = 'none';
    bounce.appendChild(img);
    box.appendChild(bounce);

    if (combo.pose === 'kiss') {
      var glyphs = ['💋', '💜', '🧡', '💋', '💜'];
      for (var i = 0; i < glyphs.length; i++) {
        var fx = document.createElement('span');
        fx.className = 'sc-popup-fx';
        fx.textContent = glyphs[i];
        fx.style.left = (18 + Math.random() * 60).toFixed(0) + '%';
        fx.style.setProperty('--fx-x', (Math.random() * 56 - 28).toFixed(0) + 'px');
        fx.style.animationDelay = (i * 0.45).toFixed(2) + 's';
        fx.style.pointerEvents = 'none';
        box.appendChild(fx);
      }
    }

    document.body.appendChild(box);
    popup.node = box;

    var OUT_MS = 450; // matches the sc-pop-out animation duration
    popup.hideTimer = window.setTimeout(function () {
      popup.hideTimer = null;
      if (popup.node === box) box.classList.add('sc-popup--out');
      popup.outTimer = window.setTimeout(function () {
        popup.outTimer = null;
        if (popup.node === box) popupRemoveNode();
        popupSchedule(nextPopupInterval(Math.random));
      }, OUT_MS);
    }, POPUP_SCHEDULE.showMs - OUT_MS);
  }

  function initPopups(themeName) {
    try {
      if (themeName !== 'halloween') return;
      if (popupReducedMotion()) return;
      popupCheckLogin();
      window.addEventListener('storage', function (e) {
        if (!e || e.key === 'wc_token' || e.key === null) popupCheckLogin();
      });
      window.setInterval(popupCheckLogin, 15000);
    } catch (e) { /* pop-ups are decoration; never break the app */ }
  }

  function stripDecorations() {
    var nodes = document.querySelectorAll('.sc-theme-banner, .sc-theme-promo, .sc-theme-particles');
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].parentNode) nodes[i].parentNode.removeChild(nodes[i]);
    }
  }

  function init() {
    try {
      var name = resolveTheme(new Date(), currentOverride());
      if (!name) return; // no season, no override → zero footprint
      var meta = THEMES[name];
      document.documentElement.dataset.theme = name;
      // Base first so the pack wins on equal specificity.
      loadCss('/css/themes/theme-base.css');
      loadCss('/css/themes/' + name + '.css');
      var themeColor = document.querySelector('meta[name="theme-color"]');
      if (themeColor && meta.themeColor) themeColor.setAttribute('content', meta.themeColor);
      renderBanner(name, meta);
      renderPromo(name, meta);
      renderParticles(meta);
      initPopups(name);
    } catch (e) {
      // A theme must never break the app: remove what we added, move on.
      try { stripDecorations(); } catch (e2) { /* nothing more to do */ }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
