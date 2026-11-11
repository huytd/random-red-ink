'use strict';

const { loadSettings, saveSettings, MAX_LEVEL } = globalThis.RC_SETTINGS;

// Cumulative vocabulary sizes: official for HSK, from the word lists for JLPT.
const WORDS = {
  hsk3: [500, 1272, 2245, 3245, 4316, 5456, 11092],
  hsk2: [150, 300, 600, 1200, 2500, 5000],
  jlpt: [717, 1384, 3524, 5430, 8128],
};
const LANGUAGE_NAMES = { zh: 'Chinese', ja: 'Japanese' };

const $ = (id) => document.getElementById(id);
let settings;
let tab = null;
let host = null;

function setRadio(group, value) {
  for (const b of group.querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.value === String(value)));
}

// The level setting and its buttons for the current language: HSK 1-6 (+ 7-9), or
// JLPT N5-N1 stored as 1-5.
function levelInfo() {
  if (settings.language === 'ja') {
    return { key: 'jlptLevel', system: 'jlpt', max: 5, label: (n) => `N${6 - n}`, range: (n) => (n === 1 ? 'N5' : `N5–N${6 - n}`) };
  }
  return {
    key: 'level',
    system: settings.system,
    max: MAX_LEVEL[settings.system],
    label: (n) => (n === 7 ? '7–9' : String(n)),
    range: (n) => (n === 1 ? 'level 1' : `levels 1–${n === 7 ? '9' : n}`),
  };
}

// ---- Translator --------------------------------------------------------------
// Sentences are translated by Chrome's built-in Translator API in the extension's
// offscreen document. Its language model has to be downloaded once, and Chrome only starts
// that after a click, so the popup has the Download button.

const targetLanguage = () => (settings.language === 'ja' ? 'ja' : settings.script === 'traditional' ? 'zh-Hant' : 'zh');
const translatorOptions = () => ({ sourceLanguage: 'en', targetLanguage: targetLanguage() });
let translatorAvailability = null; // 'available' | 'downloadable' | 'downloading' | 'unavailable' | 'unsupported' | 'error'
let downloading = false;

async function checkTranslator() {
  if (typeof self.Translator?.availability !== 'function') return 'unsupported';
  try {
    return await Translator.availability(translatorOptions());
  } catch {
    return 'error';
  }
}

// progress: null for none, 'busy' for a moving bar, or 0..1. Chrome may report only 0 and
// 1, so 0 shows a moving bar too.
function showTranslator(text, { button = false, progress = null, hint = '' } = {}) {
  $('translator').hidden = !text;
  $('translator-text').textContent = text || '';
  $('translator-download').hidden = !button;
  $('translator-download').disabled = downloading;
  const bar = $('translator-progress');
  bar.hidden = progress === null;
  if (typeof progress === 'number' && progress > 0) bar.value = progress;
  else bar.removeAttribute('value');
  $('translator-download').parentElement.hidden = !button && progress === null;
  $('translator-hint').hidden = !hint;
  $('translator-hint').textContent = hint;
}

// The language packs the translator needs, as chrome://on-device-translation-internals
// names them.
const packNames = () => `English (en) and ${LANGUAGE_NAMES[settings.language]} (${targetLanguage()})`;

async function renderTranslator() {
  if (downloading) return;
  if (settings.mode !== 'sentence' || !settings.enabled) {
    showTranslator(null);
    return;
  }
  const name = LANGUAGE_NAMES[settings.language];
  const target = targetLanguage();
  translatorAvailability = await checkTranslator();
  if (downloading || target !== targetLanguage()) return; // changed while checking
  switch (translatorAvailability) {
    case 'available': return showTranslator(null);
    case 'downloadable':
      return showTranslator(`Sentences are translated on your computer by Chrome. Download its English → ${name} model once to start.`, { button: true });
    case 'downloading':
      return showTranslator(`Chrome is downloading the English → ${name} model. Click Download to follow it; you can close this popup meanwhile.`, { button: true, progress: 'busy' });
    case 'unavailable': return showTranslator(`Chrome can’t translate English to ${name} on this computer. Switch Replace to Words.`);
    case 'unsupported': return showTranslator('Sentences need Chrome’s built-in translator (Chrome 138 or later on a computer). Switch Replace to Words.');
    default: return showTranslator('Chrome’s translator didn’t answer. Try again, or switch Replace to Words.');
  }
}

// Tells open tabs waiting for the translator to start.
async function translatorReady() {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) chrome.tabs.sendMessage(t.id, { type: 'rc-translator-ready' }).catch(() => {});
}

function download() {
  if (typeof self.Translator?.create !== 'function') return;
  const name = LANGUAGE_NAMES[settings.language];
  downloading = true;
  const text = `Downloading the English → ${name} model… Chrome downloads it in the background, so it won’t show in DevTools’ Network panel.`;
  let progress = 'busy';
  showTranslator(text, { button: true, progress });
  // Slow or stuck: Chrome's own page shows the language packs and can install them.
  const slow = setTimeout(() => {
    showTranslator(text, {
      button: true,
      progress,
      hint: `Taking a while? Open Chrome’s language packs below and check that ${packNames()} are installing; you can install them there, then click Download again.`,
    });
    $('translator-download').disabled = false; // to try again
  }, 20000);
  // Called straight from the click, which Chrome requires to start a download.
  Translator.create({
    ...translatorOptions(),
    monitor(m) {
      m.addEventListener('downloadprogress', (e) => {
        progress = e.loaded;
        $('translator-progress').hidden = false;
        if (e.loaded > 0) $('translator-progress').value = e.loaded;
        $('translator-text').textContent = e.loaded > 0 && e.loaded < 1 ? `Downloading the English → ${name} model… ${Math.round(e.loaded * 100)}%` : text;
      });
    },
  }).then(async (t) => {
    clearTimeout(slow);
    t.destroy?.();
    downloading = false;
    showTranslator(null);
    await translatorReady();
    setTimeout(refreshStatus, 800);
  }, (e) => {
    clearTimeout(slow);
    downloading = false;
    showTranslator(`The download didn’t finish: ${e?.name ? `${e.name}: ` : ''}${e?.message || e}`, {
      button: true,
      hint: `Try again, or install ${packNames()} on Chrome’s language packs page.`,
    });
  });
}

// The slider's setting: sentences and words each keep their own share.
const frequencyKey = () => (settings.mode === 'sentence' ? 'sentenceFrequency' : 'frequency');

function render() {
  const ja = settings.language === 'ja';
  const sentences = settings.mode === 'sentence';
  document.body.classList.toggle('off', !settings.enabled);
  $('enabled').checked = settings.enabled;
  setRadio($('language'), settings.language);
  setRadio($('system'), settings.system);
  setRadio($('script'), settings.script);
  $('system').hidden = ja;
  $('script-row').hidden = ja;
  $('reading-label').textContent = ja ? 'Show furigana above words' : 'Show pinyin above words';
  $('footer').textContent = sentences
    ? 'Click a sentence to hear it and see the English, or a word in it for its meaning.'
    : `Click a ${LANGUAGE_NAMES[settings.language]} word on the page to hear it and see its meaning.`;

  const info = levelInfo();
  const level = settings[info.key];
  const levels = $('levels');
  levels.setAttribute('aria-label', ja ? 'JLPT level' : 'HSK level');
  levels.classList.toggle('six', info.max === 6);
  levels.classList.toggle('five', info.max === 5);
  levels.replaceChildren(...Array.from({ length: info.max }, (_, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.dataset.value = i + 1;
    b.textContent = info.label(i + 1);
    if (b.textContent.length > 2) b.className = 'wide';
    b.setAttribute('aria-label', ja ? `JLPT ${b.textContent}` : `Level ${b.textContent}`);
    return b;
  }));
  setRadio(levels, level);

  const sizes = WORDS[info.system];
  const n = level - 1;
  const added = sizes[n] - (n ? sizes[n - 1] : 0);
  if (sentences) {
    $('level-hint').textContent = settings.onlyLevel
      ? `Prefers sentences made of the ${sizes[n].toLocaleString()} words up to this level, with at least one of the ${added.toLocaleString()} it introduces.`
      : `Prefers sentences made of the ${sizes[n].toLocaleString()} words of ${info.range(level)}.`;
  } else {
    $('level-hint').textContent = settings.onlyLevel
      ? `Uses the ${added.toLocaleString()} words introduced at this level.`
      : `Uses ${sizes[n].toLocaleString()} words, ${info.range(level)}.`;
  }
  $('only-level').checked = settings.onlyLevel;
  $('only-level-label').textContent = sentences ? 'Only sentences with a word new at this level' : 'Only words new at this level';

  setRadio($('mode'), settings.mode);
  $('frequency').value = settings[frequencyKey()];
  $('frequency-value').textContent = `${settings[frequencyKey()]}%`;
  $('frequency-label').textContent = sentences ? 'Share of sentences' : 'Share of words';
  $('range-few').textContent = sentences ? 'A few sentences' : 'A few words';
  $('range-most').textContent = sentences ? 'Most sentences' : 'Most words';
  $('mode-hint').textContent = sentences
    ? 'Translates whole sentences with Chrome’s built-in translator, on your device.'
    : 'Swaps single words for their translation, keeping the English word order.';
  $('show-pinyin').checked = settings.showPinyin;

  if (host) $('site-enabled').checked = !settings.disabledSites.includes(host);
  renderTranslator();
}

async function update(patch) {
  Object.assign(settings, patch);
  render();
  await saveSettings(patch);
  setTimeout(refreshStatus, 600);
}

// What the page's translator is doing, for sentence mode: null when it's ready.
function translatorStatus(s) {
  const name = LANGUAGE_NAMES[settings.language];
  switch (s.translator) {
    case 'checking': return 'Starting the translator…';
    case 'needs-download': return `Waiting for the ${name} translator`;
    case 'unsupported': return 'Chrome’s translator isn’t available';
    case 'unavailable': return `Chrome can’t translate into ${name} here`;
    case 'error': return 'The translator didn’t start. Reload the page, or switch to Words.';
    default: return null;
  }
}

let statusTimer = 0;
async function refreshStatus() {
  const site = $('site');
  if (!tab) return;
  clearTimeout(statusTimer);
  try {
    const s = await chrome.tabs.sendMessage(tab.id, { type: 'rc-status' });
    host = s.host;
    site.classList.remove('unavailable');
    $('site-host').textContent = s.host || 'This page';
    $('site-enabled').checked = !settings.disabledSites.includes(host);
    $('reroll').disabled = !s.running;
    if (!settings.enabled) $('site-status').textContent = 'Paused everywhere';
    else if (settings.disabledSites.includes(host)) $('site-status').textContent = 'Paused on this site';
    else if (!s.english) $('site-status').textContent = 'This page isn’t in English';
    else if (settings.mode === 'sentence' && translatorStatus(s)) {
      $('site-status').textContent = translatorStatus(s);
      if (s.translator === 'checking') statusTimer = setTimeout(refreshStatus, 1000);
      // Downloaded since this tab loaded: start it.
      if (s.translator === 'needs-download' && translatorAvailability === 'available') {
        chrome.tabs.sendMessage(tab.id, { type: 'rc-translator-ready' }).catch(() => {});
        statusTimer = setTimeout(refreshStatus, 1000);
      }
    } else {
      const unit = settings.mode === 'sentence' ? 'sentence' : 'word';
      $('site-status').textContent = `${s.count} ${unit}${s.count === 1 ? '' : 's'} in ${LANGUAGE_NAMES[settings.language]}`;
      // Sentences arrive one by one from the translator.
      if (settings.mode === 'sentence' && s.running) statusTimer = setTimeout(refreshStatus, 1500);
    }
  } catch {
    site.classList.add('unavailable');
    $('site-host').textContent = 'This page';
    $('site-status').textContent = 'Not available here — reload the tab or open a regular web page.';
  }
}

function bindRadio(group, key, parse = (v) => v) {
  group.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-value]');
    if (b) update({ [key]: parse(b.dataset.value) });
  });
}

async function main() {
  settings = await loadSettings();
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  render();

  $('enabled').addEventListener('change', (e) => update({ enabled: e.target.checked }));
  $('system').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-value]');
    // Level 7–9 only exists in HSK 3.0.
    if (b) update({ system: b.dataset.value, level: Math.min(settings.level, MAX_LEVEL[b.dataset.value]) });
  });
  bindRadio($('language'), 'language');
  bindRadio($('mode'), 'mode');
  bindRadio($('script'), 'script');
  $('levels').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-value]');
    if (b) update({ [levelInfo().key]: Number(b.dataset.value) });
  });
  $('only-level').addEventListener('change', (e) => update({ onlyLevel: e.target.checked }));
  $('show-pinyin').addEventListener('change', (e) => update({ showPinyin: e.target.checked }));
  $('frequency').addEventListener('input', (e) => { $('frequency-value').textContent = `${e.target.value}%`; });
  $('frequency').addEventListener('change', (e) => update({ [frequencyKey()]: Number(e.target.value) }));
  $('site-enabled').addEventListener('change', (e) => {
    if (!host) return;
    const others = settings.disabledSites.filter((h) => h !== host);
    update({ disabledSites: e.target.checked ? others : [...others, host] });
  });
  $('translator-download').addEventListener('click', download);
  $('translator-packs').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://on-device-translation-internals' }));
  $('reroll').addEventListener('click', async () => {
    if (!tab) return;
    await chrome.tabs.sendMessage(tab.id, { type: 'rc-reroll' }).catch(() => {});
    setTimeout(refreshStatus, 600);
  });

  refreshStatus();
}

main();
