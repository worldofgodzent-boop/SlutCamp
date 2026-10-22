'use strict';
/*
 * lib/relay.js — Cloudflare Realtime (SFU) streaming relay.
 *
 * Why: public lives used to be a direct phone-to-viewer WebRTC mesh —
 * the model's phone sent one copy per viewer, so a crowd collapsed her
 * uplink. With the relay she publishes ONE copy to Cloudflare and each
 * viewer pulls from Cloudflare's edge. Battles (two hosts, one crowd)
 * ride the same relay. 1-on-1 video calls and Private Rooms stay
 * direct P2P by design and never touch this module.
 *
 * Shape (developers.cloudflare.com/realtime/sfu, Connection API):
 *   base  https://rtc.live.cloudflare.com/v1
 *   auth  Authorization: Bearer <APP SECRET> — server-side only, the
 *         secret never reaches a browser.
 *   POST /apps/{appId}/sessions/new                     -> { sessionId }
 *   POST /apps/{appId}/sessions/{id}/tracks/new         publish (local
 *        tracks + the browser's offer) -> answer; subscribe (remote
 *        tracks) -> SFU offer the browser must answer
 *   PUT  /apps/{appId}/sessions/{id}/renegotiate        subscriber answer
 *   PUT  /apps/{appId}/sessions/{id}/tracks/close       cleanup
 *
 * Config (env; the relay is "configured" only when both are set):
 *   CF_REALTIME_APP_ID     the SFU App ID from the Cloudflare dashboard
 *   CF_REALTIME_APP_SECRET the SFU App Secret (the Bearer token above)
 *   CF_REALTIME_API_BASE   optional override (tests / future regions)
 *
 * DARK BY DEFAULT: unconfigured => configured() is false, the server
 * answers every /api/relay/* call with 503 relay_disabled, and every
 * client behaves exactly as the pre-relay mesh. Nothing here is
 * allowed to break a live: callers treat any throw as "use the mesh".
 */
const API_BASE_DEFAULT = 'https://rtc.live.cloudflare.com/v1';
const CALL_TIMEOUT_MS = 10000;

function cfg() {
  return {
    appId: process.env.CF_REALTIME_APP_ID || '',
    appSecret: process.env.CF_REALTIME_APP_SECRET || '',
    base: String(process.env.CF_REALTIME_API_BASE || API_BASE_DEFAULT).replace(/\/+$/, ''),
  };
}

function configured() {
  const c = cfg();
  return !!(c.appId && c.appSecret);
}

function relayError(code, extra) {
  const e = new Error(code);
  e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
}

async function call(method, pathParts, body) {
  const c = cfg();
  if (!configured()) throw relayError('relay_not_configured');
  const url = `${c.base}/apps/${encodeURIComponent(c.appId)}/${pathParts}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), CALL_TIMEOUT_MS);
  let r;
  try {
    r = await fetch(url, {
      method,
      signal: ctl.signal,
      headers: {
        authorization: `Bearer ${c.appSecret}`,
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw relayError('relay_network', { cause: e });
  } finally {
    clearTimeout(timer);
  }
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* non-JSON body */ }
  if (!r.ok) throw relayError('relay_upstream', { status: r.status, body: json || text });
  return json || {};
}

/* A fresh SFU session for one endpoint (one publisher or one viewer). */
async function createSession() {
  const j = await call('POST', 'sessions/new');
  if (!j.sessionId) throw relayError('relay_bad_response');
  return j.sessionId;
}

/* Publish the browser's local tracks: body carries its offer SDP, the
 * SFU answers — the answer goes back to the browser verbatim. */
async function publishTracks(sessionId, sessionDescription, tracks) {
  return call('POST', `sessions/${encodeURIComponent(sessionId)}/tracks/new`,
    { sessionDescription, tracks });
}

/* Subscribe: request remote tracks (publisher sessionId + trackName)
 * into a viewer session. The SFU returns its own offer; the browser
 * answers it and the answer comes back through renegotiate(). */
async function subscribeTracks(sessionId, tracks) {
  return call('POST', `sessions/${encodeURIComponent(sessionId)}/tracks/new`,
    { tracks });
}

async function renegotiate(sessionId, sessionDescription) {
  return call('PUT', `sessions/${encodeURIComponent(sessionId)}/renegotiate`,
    { sessionDescription });
}

/* Best-effort cleanup; tracks also GC at Cloudflare after ~30s of
 * inactivity, so a failed close is never fatal. */
async function closeTracks(sessionId, tracks) {
  return call('PUT', `sessions/${encodeURIComponent(sessionId)}/tracks/close`,
    { tracks });
}

module.exports = {
  cfg, configured,
  createSession, publishTracks, subscribeTracks, renegotiate, closeTracks,
};
