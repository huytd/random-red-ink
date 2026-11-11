// Background work for the content script: injecting the dictionary a page needs, passing
// sentences to the translator in the offscreen document, and speaking words with
// chrome.tts, which has voices even on pages that block or override the Web Speech API.

const LANGUAGES = new Set(['zh', 'ja']);
const TARGETS = new Set(['zh', 'zh-Hant', 'ja']);

// The Translator API needs a document; service workers don't have it.
const OFFSCREEN_URL = chrome.runtime.getURL('src/offscreen/offscreen.html');
let creating = null;
async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [OFFSCREEN_URL] });
  if (existing.length) return;
  creating ||= chrome.offscreen
    .createDocument({ url: OFFSCREEN_URL, reasons: ['WORKERS'], justification: 'Runs Chrome’s on-device Translator API, which service workers don’t have.' })
    .finally(() => { creating = null; });
  await creating;
}

async function toOffscreen(msg) {
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ ...msg, to: 'offscreen' });
}

// The voice for a BCP 47 tag like 'zh-CN' or 'ja-JP': an exact match, else the language.
const pickVoice = (voices, lang) => {
  const norm = (l) => (l || '').replace('_', '-').toLowerCase();
  return voices.find((v) => norm(v.lang) === norm(lang)) || voices.find((v) => norm(v.lang).startsWith(norm(lang).slice(0, 2)));
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'rc-load-dict' && LANGUAGES.has(msg.lang) && sender.tab) {
    chrome.scripting
      .executeScript({ target: { tabId: sender.tab.id, frameIds: [sender.frameId ?? 0] }, files: [`src/dict-${msg.lang}.js`] })
      .then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
    return true;
  }
  if ((msg?.type === 'rc-translator' || msg?.type === 'rc-translate') && TARGETS.has(msg.lang) && sender.tab) {
    toOffscreen({ type: msg.type, lang: msg.lang, text: msg.text })
      .then((res) => sendResponse(res || { ok: false, state: 'error' }), (e) => sendResponse({ ok: false, state: 'error', error: String(e?.message || e) }));
    return true;
  }
  if (msg?.type === 'rc-speak' && typeof msg.text === 'string') {
    const lang = typeof msg.lang === 'string' ? msg.lang : 'zh-CN';
    chrome.tts.getVoices((voices) => {
      const voice = pickVoice(voices, lang);
      if (!voice) return sendResponse({ ok: false });
      chrome.tts.speak(msg.text, { voiceName: voice.voiceName, lang: voice.lang || lang, rate: 0.8 });
      sendResponse({ ok: true });
    });
    return true;
  }
});
