// Translates sentences for the content script with Chrome's built-in Translator API, which
// isn't available in the service worker. The background worker creates this document and
// passes it { to: 'offscreen', type, lang, text } messages.
'use strict';

const translators = new Map(); // target language -> Promise<Translator>

// The translator for lang, or { state } when there isn't one yet: 'downloadable' until the
// popup's Download button has created one for the extension (which needs a click), and
// 'unavailable' or 'unsupported' when Chrome can't translate into lang.
async function translator(lang) {
  const T = self.Translator;
  if (typeof T?.create !== 'function') return { state: 'unsupported' };
  if (!translators.has(lang)) {
    const options = { sourceLanguage: 'en', targetLanguage: lang };
    const availability = await T.availability(options);
    if (availability !== 'available') return { state: availability };
    const created = T.create(options);
    translators.set(lang, created);
    created.catch(() => translators.delete(lang));
  }
  return { instance: await translators.get(lang) };
}

async function handle(msg) {
  const t = await translator(msg.lang);
  if (!t.instance) return { ok: false, state: t.state };
  if (msg.type === 'rc-translator') return { ok: true, state: 'ready' };
  if (msg.type === 'rc-translate') return { ok: true, text: await t.instance.translate(String(msg.text)) };
  return { ok: false, state: 'error' };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.to !== 'offscreen') return;
  handle(msg).then(sendResponse, (e) => sendResponse({ ok: false, state: 'error', error: String(e?.message || e) }));
  return true;
});
