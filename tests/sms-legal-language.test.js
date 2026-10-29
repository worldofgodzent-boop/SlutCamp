'use strict';
/*
 * SMS legal language (Telnyx 10DLC campaign prerequisite) — pins:
 *   - Fan Terms §15 (Text Messaging / SMS) in ALL 13 languages: the
 *     transactional-only SMS program — sign-in verification codes and
 *     account-security notices, opt-in in Settings > Phone with a
 *     confirmation code, variable frequency, msg & data rates, STOP /
 *     HELP, consent not a condition of purchase, support contacts,
 *     no marketing messages.
 *   - Privacy Policy §12 clause (mobile number used only for those
 *     codes/notices, never sold, not shared for marketing, Telnyx's
 *     required opt-in non-sharing language, retention while the
 *     account is active / deletion on request or closure).
 *
 * NOTE on languages: the Fan Terms live in the localized
 * legal_terms_html table (13 languages), but the Privacy Policy is a
 * single English view (vPrivacy in public/js/app.js) that the app
 * serves to every user regardless of language — there is no localized
 * privacy table in the codebase. The privacy assertions therefore pin
 * the clause in that one view.
 *
 * Program facts come from the Telnyx prep packet
 * (~/workspace/projects/telnyx-application-prep-2026-10-21.md) §3C/§4.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const APP_JS = fs.readFileSync(path.join(REPO, 'public', 'js', 'app.js'), 'utf8');

/* Same extraction helper as tests/ccbill-compliance-fixes.test.js. */
function stringLiterals(s, marker) {
  const out = [];
  let from = 0;
  for (;;) {
    const ki = s.indexOf(marker, from);
    if (ki < 0) break;
    let j = ki + marker.length;
    while (s[j] !== "'") j++;
    let k = j + 1, esc = false;
    for (; k < s.length; k++) {
      const c = s[k];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === "'") break;
    }
    out.push(eval(s.slice(j, k + 1)));
    from = k + 1;
  }
  return out;
}

/* §15 title marker per language, in legal_terms_html table order. */
const SMS15_TITLES = [
  '15. Text Messaging (SMS)',          // en
  '15. Mensajería de texto (SMS)',     // es
  '15. Mensagens de texto (SMS)',      // pt
  '15. Messagerie texte (SMS)',        // fr
  '15. Textnachrichten (SMS)',         // de
  '15. Текстовые сообщения (SMS)',     // ru
  '15. テキストメッセージ（SMS）',        // ja
  '15. 短信（SMS）',                    // zh
  '15. 문자 메시지(SMS)',               // ko
  '15. Messaggi di testo (SMS)',       // it
  '15. Wiadomości tekstowe (SMS)',     // pl
  '15. Sms-berichten',                 // nl
  '15. Metin Mesajları (SMS)',         // tr
];

test('terms: SMS §15 exists in all 13 languages with STOP, HELP, support email + phone', () => {
  const pages = stringLiterals(APP_JS, 'legal_terms_html:');
  assert.equal(pages.length, 13, 'legal_terms_html in all 13 languages');
  for (const [i, p] of pages.entries()) {
    assert.ok(p.includes(SMS15_TITLES[i]), `lang ${i}: §15 title "${SMS15_TITLES[i]}"`);
    assert.ok(p.includes('STOP'), `lang ${i}: STOP keyword present`);
    assert.ok(p.includes('HELP'), `lang ${i}: HELP keyword present`);
    assert.ok(p.includes('admin@slutcamp.app'), `lang ${i}: support email present`);
    assert.ok(p.includes('(210) 943-6509'), `lang ${i}: support phone present`);
    assert.ok(p.includes('World Of Godz Entertainment LLC'), `lang ${i}: operator named`);
    // §15 is the LAST numbered section, appended after §14, before the footer.
    const i14 = p.indexOf('14.');
    const i15 = p.indexOf(SMS15_TITLES[i]);
    assert.ok(i14 >= 0 && i15 > i14, `lang ${i}: §15 follows §14`);
  }
});

test('terms EN: §15 paragraph carries every required program element', () => {
  const en = stringLiterals(APP_JS, 'legal_terms_html:')[0];
  const s15 = en.slice(en.indexOf('15. Text Messaging (SMS)'));
  for (const needle of [
    'sends text messages only for transactional purposes',
    'sign-in verification codes and account-security notices',
    'No marketing or promotional messages are sent under this program',
    'in Settings > Phone you voluntarily enter your mobile number',
    'confirm it by entering the one-time code we text to it',
    'no messages are sent before the number is confirmed',
    'Message frequency varies',
    'normally only when you sign in or your account changes',
    'Message and data rates may apply',
    'opt out at any time by replying STOP',
    'reply HELP for help',
    'is not a condition of purchase',
    'admin@slutcamp.app',
    '(210) 943-6509',
    'Carriers are not liable for delayed or undelivered messages',
  ]) {
    assert.ok(s15.includes(needle), `EN §15 contains: ${needle}`);
  }
});

test('terms: displayed date unchanged by this build (redate is a separate decision)', () => {
  const en = stringLiterals(APP_JS, 'legal_terms_html:')[0];
  assert.ok(en.includes('Terms of Service · Last updated October 27, 2026'), 'EN Terms still dated October 27, 2026');
});

test('privacy: §12 SMS clause in vPrivacy with the required opt-in non-sharing language', () => {
  const start = APP_JS.indexOf('function vPrivacy()');
  assert.ok(start >= 0, 'vPrivacy exists');
  const view = APP_JS.slice(start, APP_JS.indexOf('function vBilling()', start));
  assert.ok(view.includes('12. Text messaging (SMS) and your mobile number'), 'privacy §12 title');
  const s12 = view.slice(view.indexOf('12. Text messaging (SMS)'));
  for (const needle of [
    'If you add a mobile number in Settings and confirm it',
    'we use that number only to send the sign-in verification codes and account-security notices',
    'Your mobile number is never sold, and it is not shared for marketing',
    // Telnyx's required opt-in language (prep packet §4), verbatim:
    'We will not share your opt-in to an SMS campaign with any third party for purposes unrelated to providing you with the services of that campaign.',
    'We may share your Personal Data, including your SMS opt-in or consent status, with third parties that help us provide our messaging services',
    'All categories of information collected exclude text messaging originator opt-in data and consent; this information will not be shared with any third parties.',
    'We keep your mobile number while your account is active',
    'close your account, and we will delete it, except where records must be kept by law (see section 8)',
  ]) {
    assert.ok(s12.includes(needle), `privacy §12 contains: ${needle.slice(0, 60)}…`);
  }
  // Privacy date line untouched by this build.
  assert.ok(view.includes('Privacy Policy · Last updated October 13, 2026'), 'privacy date unchanged');
});
