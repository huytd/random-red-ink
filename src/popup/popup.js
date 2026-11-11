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
    case 'needs-click': return `Click anywhere on the page to download Chrome’s ${name} translator (one time).`;
    case 'downloading': return `Downloading the ${name} translator… ${Math.round((s.progress || 0) * 100)}%`;
    case 'unsupported': return 'Sentences need Chrome’s built-in translator (Chrome 138 or later). Switch to Words to use this browser.';
    case 'unavailable': return `Chrome can’t translate English to ${name} on this device. Switch to Words.`;
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
      if (['checking', 'needs-click', 'downloading'].includes(s.translator)) statusTimer = setTimeout(refreshStatus, 1000);
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
  $('reroll').addEventListener('click', async () => {
    if (!tab) return;
    await chrome.tabs.sendMessage(tab.id, { type: 'rc-reroll' }).catch(() => {});
    setTimeout(refreshStatus, 600);
  });

  refreshStatus();
}

main();
