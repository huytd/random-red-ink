// Background work for the content script: injecting the dictionary a page needs, passing
// sentences (and the popup's model downloads) to the translation model in the offscreen
// document, and speaking words with chrome.tts, which has voices even on pages that block
// or override the Web Speech API.

const LANGUAGES = new Set(['zh', 'ja']);
const TARGETS = new Set(['zh', 'zh-Hant', 'ja']);

// The translation model runs in a document: service workers can't keep it loaded.
const OFFSCREEN_URL = chrome.runtime.getURL('src/offscreen/offscreen.html');
let creating = null;
async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [OFFSCREEN_URL] });
  if (existing.length) return;
  creating ||= chrome.offscreen
    .createDocument({ url: OFFSCREEN_URL, reasons: ['WORKERS'], justification: 'Runs the on-device translation model (ONNX Runtime WebAssembly), which needs a document to stay loaded.' })
    .finally(() => { creating = null; });
  await creating;
}

// Right after it's created, the offscreen document may still be loading transformers.js
// and not listening yet, so a message without an answer is sent again.
async function toOffscreen(msg) {
  await ensureOffscreen();
  for (let attempt = 0; ; attempt++) {
    const res = await chrome.runtime.sendMessage({ ...msg, to: 'offscreen' }).catch(() => undefined);
    if (res !== undefined || attempt >= 50) return res;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
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
  // Content scripts report the web page's URL; the popup (and other extension pages) their own.
  const fromExtension = sender.id === chrome.runtime.id && Boolean(sender.url?.startsWith(chrome.runtime.getURL('')));
  const fromPage = Boolean(sender.tab) && !fromExtension;
  const forOffscreen = (fromPage && (msg?.type === 'rc-translator' || msg?.type === 'rc-translate'))
    || (fromExtension && (msg?.type === 'rc-model-status' || msg?.type === 'rc-model-download'));
  if (forOffscreen && TARGETS.has(msg.lang)) {
    toOffscreen({ type: msg.type, lang: msg.lang, text: msg.text })
      .then((res) => sendResponse(res || { ok: false, state: 'error' }), (e) => sendResponse({ ok: false, state: 'error', error: String(e?.message || e) }));
    return true;
  }
  // A model finished downloading: pages waiting for it can start.
  if (msg?.type === 'rc-model-ready' && fromExtension) {
    chrome.tabs.query({}).then((tabs) => {
      for (const t of tabs) chrome.tabs.sendMessage(t.id, { type: 'rc-translator-ready' }).catch(() => {});
    });
    return;
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
