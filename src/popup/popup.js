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

// ---- Translation model -------------------------------------------------------
// Sentences are translated on the computer by a small ONNX translation model in the
// extension's offscreen document (src/offscreen/). It's downloaded once, from Hugging
// Face, when the Download button is clicked; the offscreen document keeps downloading if
// the popup closes, and tells open tabs when it's done.

const targetLanguage = () => (settings.language === 'ja' ? 'ja' : settings.script === 'traditional' ? 'zh-Hant' : 'zh');
const MODEL_NAMES = { zh: 'opus-mt-en-zh', 'zh-Hant': 'opus-mt-en-zh', ja: 'FuguMT en-ja' };
let modelTimer = 0;

async function modelStatus() {
  try {
    return (await chrome.runtime.sendMessage({ type: 'rc-model-status', lang: targetLanguage() })) || { state: 'error' };
  } catch (e) {
    return { state: 'error', error: String(e?.message || e) };
  }
}

function showModel(text, { button = false, progress = null, hint = '' } = {}) {
  $('translator').hidden = !text;
  $('translator-text').textContent = text || '';
  $('translator-download').hidden = !button;
  const bar = $('translator-progress');
  bar.hidden = progress === null;
  if (typeof progress === 'number' && progress > 0) bar.value = progress;
  else bar.removeAttribute('value'); // a moving bar until sizes are known
  $('translator-download').parentElement.hidden = !button && progress === null;
  $('translator-hint').hidden = !hint;
  $('translator-hint').textContent = hint;
}

async function renderTranslator() {
  clearTimeout(modelTimer);
  if (settings.mode !== 'sentence' || !settings.enabled) return showModel(null);
  const target = targetLanguage();
  const s = await modelStatus();
  if (target !== targetLanguage()) return; // changed while asking
  const name = LANGUAGE_NAMES[settings.language];
  const size = `${Math.round(s.total || 0)} MB`;
  switch (s.state) {
    case 'ready': return showModel(null);
    case 'downloading':
      modelTimer = setTimeout(renderTranslator, 500);
      return showModel(`Downloading the ${name} translation model… ${Math.round(s.loaded)} of ${size}. You can close this popup.`, { progress: s.loaded / s.total });
    case 'error':
      return showModel(`The ${name} translation model didn’t download.`, { button: true, hint: s.error || '' });
    default:
      return showModel(`Sentences are translated on your computer by a small ${name} translation model (${MODEL_NAMES[target]}, ${size}). Download it once to start.`, { button: true });
  }
}

async function downloadModel() {
  $('translator-download').disabled = true;
  try {
    await chrome.runtime.sendMessage({ type: 'rc-model-download', lang: targetLanguage() });
  } finally {
    $('translator-download').disabled = false;
  }
  renderTranslator();
}

// The offscreen document finished a download: refresh, and the page will start.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'rc-model-ready') {
    renderTranslator();
    setTimeout(refreshStatus, 1500);
  }
});

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
    ? 'Translates whole sentences with a small translation model that runs on your computer.'
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
    case 'needs-download': return `Waiting for the ${name} translation model`;
    case 'error': return 'The translation model didn’t start. Reload the page, or switch to Words.';
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
      if (s.translator === 'checking' || s.translator === 'needs-download') statusTimer = setTimeout(refreshStatus, 1500);
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
  $('translator-download').addEventListener('click', downloadModel);
  $('reroll').addEventListener('click', async () => {
    if (!tab) return;
    await chrome.tabs.sendMessage(tab.id, { type: 'rc-reroll' }).catch(() => {});
    setTimeout(refreshStatus, 600);
  });

  refreshStatus();
}

main();
