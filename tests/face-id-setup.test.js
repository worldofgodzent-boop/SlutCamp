'use strict';
/*
 * Face ID setup button — field-defect regression tests (Oct 19 2026).
 *
 * Two field reports, one investigation:
 *  (1) "Set up Face ID on this device" in model Settings was a DEAD
 *      TAP: no prompt, no error, no feedback of any kind.
 *  (2) A model with the app installed kept getting kicked back to
 *      the age-verification gate after signing in.
 *
 * What the diagnosis found (reproduced by executing the pre-fix code
 * in a vm harness against a real local server):
 *  - The ceremony client logic itself is sound — with a cooperating
 *    authenticator the shipped code completed the full round trip
 *    (that path stays pinned end-to-end by tests/passkey.test.js,
 *    which drives the real server with a software authenticator).
 *  - BUT every failure/feedback path around it was silent or nearly:
 *    · a never-settling navigator.credentials.create() (the
 *      installed-app WebView hang class) hung the handler FOREVER —
 *      zero feedback, the exact dead tap reported;
 *    · a refusal (NotAllowedError) produced only one faint
 *      "muted small" line under the button — no toast;
 *    · during the register-options fetch (up to the 15s api
 *      timeout) the tap showed nothing at all — no busy state;
 *    · pkSupported() can be true while no platform authenticator
 *      is usable; isUserVerifyingPlatformAuthenticatorAvailable()
 *      was never consulted.
 *  - Symptom (2) is routeInitial(): on ANY non-200 /api/me at cold
 *    start — including status 0 (network blip) and 500 — it deleted
 *    the stored wc_token. One transient failure permanently signed
 *    the user out, and the next open hit the by-design age gate
 *    (which shows for anyone with no token). Both password and
 *    passkey sign-ins store the token identically (afterLogin), so
 *    both died the same death.
 *
 * These tests EXECUTE the fixed client code (sliced verbatim from
 * public/js/app.js into a vm with a fake DOM + stubbed platform
 * credentials, mirroring the diagnosis harness) and pin:
 *  - refusal → inline message AND toast, button restored;
 *  - never-settling ceremony → the pkCeremony watchdog turns the
 *    silence into the visible "cancelled" message + toast;
 *  - the tap shows a busy state (disabled + pk_working) while the
 *    options fetch is in flight;
 *  - a definitive "no platform authenticator" answer renders the
 *    unsupported card instead of a doomed button;
 *  - routeInitial keeps wc_token on transient /me failures
 *    (0 / 500 / 200) and clears it only on 401 / 403.
 * Server ceremony behavior (options/verify auth + error shapes) is
 * already pinned by tests/passkey.test.js and is not duplicated here.
 * The watchdog's 60s is scaled down inside the vm via a setTimeout
 * shim so the hang scenario runs in milliseconds.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const REPO = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(REPO, 'public/js/app.js'), 'utf8');

/* ---------------- slice the shipped client code ---------------- */
const sA = APP.indexOf('function pkSupported()');
const eA = APP.indexOf('/* Login screen:');
const sB = APP.indexOf('async function renderPkSettingsCard()');
const eB = APP.indexOf('/* Settings card (fan wallet + model settings): change your password.');
assert.ok([sA, eA, sB, eB].every((i) => i !== -1), 'passkey client slice markers must exist');
const PK_CODE = APP.slice(sA, eA) + '\n' + APP.slice(sB, eB);

/* ---------------- fake DOM (mirrors the diagnosis harness) ---------------- */
function makeDom() {
  const registry = new Map();
  class El {
    constructor(id) {
      this.id = id || ''; this._html = ''; this.textContent = ''; this.onclick = null;
      this.disabled = false; this.dataset = {}; this.style = {}; this.isConnected = true;
      this.classList = { add() {}, remove() {}, contains: () => false, toggle() {} };
    }
    set innerHTML(v) {
      this._html = String(v);
      for (const m of this._html.matchAll(/id="([^"]+)"/g)) {
        if (!registry.has(m[1])) registry.set(m[1], new El(m[1]));
      }
      this._delBtns = [...this._html.matchAll(/data-pk-del="([^"]+)"/g)]
        .map((m) => { const e = new El(''); e.dataset.pkDel = m[1]; return e; });
    }
    get innerHTML() { return this._html; }
    querySelectorAll(sel) { return sel === '[data-pk-del]' ? (this._delBtns || []) : []; }
  }
  const host = new El('pk-card');
  registry.set('pk-card', host);
  const document = {
    getElementById: (id) => registry.get(id) || null,
    querySelector: (sel) => (sel.startsWith('#') ? registry.get(sel.slice(1)) || null : null),
  };
  return { registry, host, document };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Watchdog delays (>5s in the shipped code) fire after 60ms in the vm.
const scaledSetTimeout = (fn, ms, ...a) => setTimeout(fn, ms > 5000 ? 60 : ms, ...a);

function makeCtx({ credentials, api, uvpaa }) {
  const dom = makeDom();
  const toasts = [];
  const PKC = function () {};
  if (uvpaa !== undefined) PKC.isUserVerifyingPlatformAuthenticatorAvailable = async () => uvpaa;
  const ctx = {
    console, setTimeout: scaledSetTimeout, clearTimeout, AbortController, atob, btoa,
    Promise, JSON, Object, Array, String, Error, Uint8Array,
    window: { PublicKeyCredential: PKC, isSecureContext: true },
    navigator: { credentials, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' },
    document: dom.document,
    $: (sel) => dom.document.querySelector(sel),
    t: (k, params) => (params && params.date ? `${k}:${params.date}` : k),
    esc: (s) => String(s),
    toast: (msg) => toasts.push(msg),
    confirm: () => true,
    api,
  };
  ctx.window.navigator = ctx.navigator;
  vm.createContext(ctx);
  vm.runInContext(PK_CODE, ctx);
  return { ctx, dom, toasts };
}

const okApi = async (path) => {
  if (path.includes('/list')) return { status: 200, data: { credentials: [] } };
  if (path.includes('register-options')) {
    return { status: 200, data: { challenge: 'AA', rp: { id: 'x', name: 'SlutCamp' }, user: { id: 'AA', name: 'u', displayName: 'U' } } };
  }
  if (path.includes('register-verify')) return { status: 200, data: { ok: true } };
  return { status: 404, data: {} };
};

/* ---------------- the previously-silent paths ---------------- */

test('setup refusal (NotAllowedError) → inline message AND toast, button restored', async () => {
  const credentials = { create: async () => { const e = new Error('denied'); e.name = 'NotAllowedError'; throw e; } };
  const { ctx, dom, toasts } = makeCtx({ credentials, api: okApi });
  await ctx.renderPkSettingsCard();
  const btn = dom.registry.get('pk-setup');
  assert.ok(btn && typeof btn.onclick === 'function', 'setup button is bound');
  await btn.onclick();
  assert.deepEqual(toasts, ['pk_err_cancelled'], 'failure must reach the loud toast channel');
  assert.equal(dom.registry.get('pk-msg').textContent, 'pk_err_cancelled', 'failure must land in the card');
  assert.equal(btn.disabled, false, 'button is tappable again after a failure');
});

test('setup with a never-settling ceremony → watchdog produces the visible cancelled message', async () => {
  const credentials = { create: () => new Promise(() => {}) }; // the installed-app hang
  const { ctx, dom, toasts } = makeCtx({ credentials, api: okApi });
  await ctx.renderPkSettingsCard();
  const btn = dom.registry.get('pk-setup');
  await btn.onclick(); // completes via the watchdog, not the platform
  assert.deepEqual(toasts, ['pk_err_cancelled'], 'a hung ceremony must not stay silent');
  assert.equal(dom.registry.get('pk-msg').textContent, 'pk_err_cancelled');
  assert.equal(btn.disabled, false, 'button recovers after the watchdog fires');
});

test('setup shows a busy state while the options fetch is in flight', async () => {
  const slowApi = async (path, opts) => {
    if (path.includes('register-options')) await sleep(300);
    return okApi(path, opts);
  };
  const credentials = { create: () => new Promise(() => {}) };
  const { ctx, dom } = makeCtx({ credentials, api: slowApi });
  await ctx.renderPkSettingsCard();
  const btn = dom.registry.get('pk-setup');
  const msg = dom.registry.get('pk-msg');
  const p = btn.onclick(); p.catch(() => {});
  await sleep(120); // mid-fetch
  assert.equal(btn.disabled, true, 'button disables while working');
  assert.equal(btn.textContent, 'pk_working', 'button label shows the working state');
  assert.equal(msg.textContent, 'pk_working', 'card message shows the working state');
  await p;
});

test('no platform authenticator (definitive) → unsupported card, no doomed button', async () => {
  const credentials = { create: async () => { throw new Error('must not be called'); } };
  const { ctx, dom } = makeCtx({ credentials, api: okApi, uvpaa: false });
  await ctx.renderPkSettingsCard();
  assert.match(dom.host.innerHTML, /pk_unsupported/, 'unsupported note renders');
  assert.equal(dom.registry.has('pk-setup'), false, 'no setup button is offered');
});

test('server refusing register-options → visible generic error, not silence', async () => {
  const failApi = async (path) => {
    if (path.includes('/list')) return { status: 200, data: { credentials: [] } };
    return { status: 500, data: { error: 'server_error' } };
  };
  const credentials = { create: async () => { throw new Error('must not be called'); } };
  const { ctx, dom, toasts } = makeCtx({ credentials, api: failApi });
  await ctx.renderPkSettingsCard();
  await dom.registry.get('pk-setup').onclick();
  assert.deepEqual(toasts, ['pk_err_generic']);
  assert.equal(dom.registry.get('pk-msg').textContent, 'pk_err_generic');
});

test('setup happy path (client side) → verify posted, success toast, card re-renders', async () => {
  const seen = [];
  const api = async (path, opts) => { seen.push([path, opts]); return okApi(path, opts); };
  const ab = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  const credentials = {
    create: async () => ({
      id: 'Y3JlZA', rawId: ab(new Uint8Array([1, 2, 3])), type: 'public-key', authenticatorAttachment: 'platform',
      getClientExtensionResults: () => ({}),
      response: {
        clientDataJSON: ab(new Uint8Array([123, 125])),
        attestationObject: ab(new Uint8Array([1, 2, 3])),
        getTransports: () => ['internal'], getPublicKeyAlgorithm: () => -7, getAuthenticatorData: () => ab(new Uint8Array([0])),
      },
    }),
  };
  const { ctx, dom, toasts } = makeCtx({ credentials, api });
  await ctx.renderPkSettingsCard();
  await dom.registry.get('pk-setup').onclick();
  assert.deepEqual(toasts, ['pk_on_toast'], 'success toasts');
  const verify = seen.find(([p]) => p.includes('register-verify'));
  assert.ok(verify, 'register-verify was posted');
  const body = JSON.parse(verify[1].body);
  assert.ok(body.response && body.response.response && typeof body.response.response.clientDataJSON === 'string',
    'verify body carries the credential JSON');
});

/* ---------------- symptom 2: session durability at boot ---------------- */

function routeInitialBlock() {
  const g = APP.indexOf("await ensureGuest();\n  wsConnect();\n  show('landing', {});");
  assert.ok(g !== -1, 'routeInitial landing fall-through must exist');
  const start = APP.lastIndexOf('if (S.token) {', g);
  assert.ok(start !== -1, 'routeInitial token block must exist');
  return APP.slice(start, g);
}

async function bootWithMeStatus(status) {
  const removed = [];
  const S = { token: 'tok-abc', user: { role: 'fan' } };
  const localStorage = { removeItem: (k) => removed.push(k), setItem() {}, getItem: () => null };
  const script = new vm.Script(`(async () => { ${routeInitialBlock()} })()`);
  await script.runInContext(vm.createContext({
    S, localStorage, console,
    api: async () => ({ status, data: {} }),
    refreshMe: async () => {}, wsConnect: () => {}, show: () => 'shown', checkContractGate: async () => {},
    window: { __ccbillReturn: null, __payInvoice: null, location: { hash: '' } },
  }));
  return removed.includes('wc_token');
}

test('routeInitial keeps the session token on transient /me failures (0, 500)', async () => {
  assert.equal(await bootWithMeStatus(0), false, 'network failure must not sign the user out');
  assert.equal(await bootWithMeStatus(500), false, 'a server hiccup must not sign the user out');
  assert.equal(await bootWithMeStatus(200), false, 'a healthy boot keeps the token');
});

test('routeInitial clears the token only on a definitive refusal (401, 403)', async () => {
  assert.equal(await bootWithMeStatus(401), true, 'a dead session is cleared');
  assert.equal(await bootWithMeStatus(403), true, 'a banned/frozen refusal is cleared');
});

/* ---------------- source pins for the wiring ---------------- */

test('pins: ceremony watchdog + visible-feedback wiring', () => {
  assert.match(APP, /async function pkCeremony\(run\)/, 'pkCeremony watchdog exists');
  assert.match(APP, /PK_CEREMONY_TIMEOUT_MS = 60000/, 'watchdog matches the server ceremony timeout');
  const card = APP.slice(sB, eB);
  assert.match(card, /pkCeremony\(\(signal\) => navigator\.credentials\.create/, 'setup runs create() under the watchdog');
  assert.match(card, /toast\(txt\)/, 'setup failures toast as well as writing the card');
  assert.match(card, /isUserVerifyingPlatformAuthenticatorAvailable/, 'render consults platform-authenticator availability');
  assert.match(card, /pk_working/, 'busy state uses the localized pk_working string');
  const login = APP.slice(eA, sB);
  assert.match(login, /pkCeremony\(\(signal\) => navigator\.credentials\.get/, 'sign-in runs get() under the watchdog');
  assert.match(APP, /pk_working: 'Waiting for Face ID…'/, 'pk_working exists in the EN dictionary (parity is pinned by languages-13)');
});
