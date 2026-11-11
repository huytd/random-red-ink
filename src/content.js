// Translates a random share of English sentences into Chinese or Japanese with a small
// translation model that runs on the computer, preferring the ones a learner can mostly read at their HSK or JLPT
// level (or, in word mode, swaps single words for their translation). Clicking a sentence
// or a word in it opens a card with the reading, audio and meanings.
(() => {
  'use strict';
  if (globalThis.__randomRedInkLoaded) return;
  globalThis.__randomRedInkLoaded = true;

  const { createLookup, findMatches, LEVEL_COL } = globalThis.RC_MATCHER;
  const sentences = globalThis.RC_SENTENCES;
  const { loadSettings } = globalThis.RC_SETTINGS;
  let dict = null; // RC_DICTS[language], injected on demand by the background worker
  const tagger = globalThis.RC_TAGGER;

  const MAX_REPLACEMENTS = 400; // words per page, keeps long pages readable and fast
  const MAX_SENTENCES = 60; // sentences per page; each one is a call to the translator
  const CHUNK_MS = 12; // work per idle slice
  const MAX_BLOCK_TEXT = 4000; // characters tagged together
  // Text inside one of these is tagged as a unit, so "<b>Building</b> apps" still reads
  // as a verb.
  const BLOCK_TAGS = new Set([
    'P', 'LI', 'DT', 'DD', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TD', 'TH', 'CAPTION', 'FIGCAPTION',
    'BLOCKQUOTE', 'DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'MAIN', 'ASIDE', 'NAV', 'SUMMARY',
    'LABEL', 'BODY',
  ]);
  const SKIP_SELECTOR = [
    'script', 'style', 'noscript', 'template', 'textarea', 'input', 'select', 'option', 'button',
    'code', 'pre', 'kbd', 'samp', 'var', 'svg', 'math', 'canvas', 'iframe', 'title', 'head',
    '[contenteditable]:not([contenteditable="false"])', '[translate="no"]', '.notranslate',
    '.rc-word', '.rc-group', '.rc-sentence', '#random-red-ink-popover',
  ].join(',');

  let settings = null;
  let lookup = null;
  let lookups = null; // sentence mode: { all, fresh } for RC_SENTENCES.chance
  let wordIdx = null; // sentence mode: dictionary words by spelling, for RC_SENTENCES.segment
  let stems = null; // and Japanese stems
  let scanned = new WeakSet(); // text nodes already considered
  const created = new WeakSet(); // text nodes this script made, safe to merge back together
  let count = 0;
  let running = false;
  let run = 0; // bumped on every (re)start so stale work stops
  let observer = null;
  const queue = [];
  let flushTimer = 0;

  // ---- Scanning --------------------------------------------------------------

  function siteDisabled(s) {
    return s.disabledSites.includes(location.hostname);
  }

  function pageLooksEnglish() {
    const lang = (document.documentElement.lang || '').toLowerCase();
    return !lang || lang.startsWith('en');
  }

  function shouldRun(s) {
    return s.enabled && !siteDisabled(s) && pageLooksEnglish();
  }

  function skippedElement(el) {
    return !el || el.closest(SKIP_SELECTOR) !== null || el.isContentEditable;
  }

  function collectText(root, out) {
    if (root.nodeType === Node.TEXT_NODE) {
      if (!scanned.has(root) && !skippedElement(root.parentElement)) out.push(root);
      return;
    }
    if (root.nodeType !== Node.ELEMENT_NODE || skippedElement(root)) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          return node.matches(SKIP_SELECTOR) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
        }
        return scanned.has(node) || !/[A-Za-z]{2}|\bI\b/.test(node.nodeValue) ? NodeFilter.FILTER_SKIP : NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let n; (n = walker.nextNode()); ) out.push(n);
  }

  // part: { id, orig, prefix?, suffix?, ...Pinyin } from findMatches; prefix and suffix are
  // grammar the Chinese needs: 最/更 for superlatives and comparatives, 的 after a
  // possessive, a measure word after a number.
  const traditional = () => dict.lang === 'zh' && settings.script === 'traditional';
  const langTag = () => (dict.lang === 'ja' ? 'ja' : traditional() ? 'zh-Hant' : 'zh-Hans');

  // part.surface: the word as written in a translated sentence, which for a conjugated
  // Japanese word is only its stem (飲 of 飲みます for 飲む).
  function makeWord(part) {
    const [simp, trad, pinyin] = dict.words[part.id];
    const word = part.surface || (traditional() ? trad : simp);
    const hanzi = (part.prefix || '') + word + (part.suffix || '');
    const span = document.createElement('span');
    span.className = 'rc-word';
    span.lang = langTag();
    span.dataset.rcId = part.id;
    if (part.orig) span.dataset.rcOrig = part.orig;
    if (part.surface) span.dataset.rcSurface = part.surface;
    if (part.suffix) {
      span.dataset.rcSuffix = part.suffix;
      span.dataset.rcSuffixPinyin = part.suffixPinyin || '';
    }
    if (part.prefix) {
      span.dataset.rcPrefix = part.prefix;
      span.dataset.rcPrefixPinyin = part.prefixPinyin || '';
    }
    // Readings above the word: pinyin over the whole word, or furigana over just the
    // kanji of a Japanese word: 食(た)べる, お茶(ちゃ), 私(わたし)の.
    if (settings.showPinyin && pinyin !== word) {
      if (dict.lang === 'ja' && word !== simp && simp.startsWith(word)) {
        span.append(...furigana(simp, pinyin, word.length)); // a stem: 食べ of 食べる
      } else if (dict.lang === 'ja') {
        span.append(...furigana(part.prefix || '', part.prefixPinyin || ''), ...furigana(word, pinyin), part.suffix || '');
      } else {
        span.append(ruby(hanzi, [part.prefixPinyin, pinyin, part.suffixPinyin].filter(Boolean).join(' ')));
      }
    } else {
      span.textContent = hanzi;
    }
    return span;
  }

  function ruby(base, reading) {
    const r = document.createElement('ruby');
    const rt = document.createElement('rt');
    rt.textContent = reading;
    r.append(base, rt);
    return r;
  }

  // Nodes for a Japanese word with its reading over the kanji only: the kana it starts and
  // ends with (お茶 おちゃ, 食べる たべる) are already the reading, so they go without.
  // length: how much of the word to show, for a stem (食べ of 食べる).
  const kana = (c) => /[\p{Script=Hiragana}\p{Script=Katakana}ー]/u.test(c);
  function furigana(word, reading, length = word.length) {
    if (!word) return [];
    if (length < word.length) {
      const nodes = furigana(word, reading);
      let cut = word.length - length; // stems drop kana, which are plain text at the end
      while (cut > 0 && typeof nodes[nodes.length - 1] === 'string') {
        const last = nodes.pop();
        if (last.length > cut) nodes.push(last.slice(0, last.length - cut));
        cut -= Math.min(cut, last.length);
      }
      return nodes;
    }
    if (word === reading || ![...word].some((c) => !kana(c))) return [word];
    let pre = 0;
    while (pre < word.length && kana(word[pre]) && word[pre] === reading[pre]) pre++;
    let suf = 0;
    while (suf < word.length - pre && kana(word[word.length - 1 - suf]) && word[word.length - 1 - suf] === reading[reading.length - 1 - suf]) suf++;
    const core = word.slice(pre, word.length - suf);
    const coreReading = reading.slice(pre, reading.length - suf);
    return [word.slice(0, pre), ruby(core, coreReading), word.slice(word.length - suf)].filter((n) => n !== '');
  }

  // A single word, or a group of words reordered for Chinese grammar ("How I" -> "我 怎么"),
  // which is restored to English as a whole.
  function makeMatch(m, original) {
    if (m.parts.length === 1) return makeWord({ ...m.parts[0], orig: original });
    const group = document.createElement('span');
    group.className = 'rc-group';
    group.dataset.rcOrig = original;
    m.parts.forEach((p, n) => {
      if (n) group.append(' ');
      group.append(p.text ?? makeWord(p));
    });
    return group;
  }

  function processTextNode(node, tags) {
    scanned.add(node);
    if (!node.parentNode || count >= MAX_REPLACEMENTS) return;
    const text = node.nodeValue;
    const matches = findMatches(text, lookup, tags).filter(() => Math.random() * 100 < settings.frequency);
    if (!matches.length) return;

    const frag = document.createDocumentFragment();
    const piece = (s) => {
      const t = document.createTextNode(s);
      scanned.add(t);
      created.add(t);
      frag.append(t);
    };
    let pos = 0;
    for (const m of matches) {
      if (count >= MAX_REPLACEMENTS) break;
      if (m.start > pos) piece(text.slice(pos, m.start));
      frag.append(makeMatch(m, text.slice(m.start, m.end)));
      pos = m.end;
      count++;
    }
    if (pos < text.length) piece(text.slice(pos));
    node.parentNode.replaceChild(frag, node);
  }

  function enqueue(node) {
    queue.push(node);
    if (!flushTimer) flushTimer = setTimeout(flush, 150);
  }

  function flush() {
    flushTimer = 0;
    if (!running) return;
    const nodes = [];
    for (const root of queue.splice(0)) if (root.isConnected) collectText(root, nodes);
    processInSlices(nodes);
  }

  function blockOf(node) {
    let el = node.parentElement;
    while (el && !BLOCK_TAGS.has(el.tagName)) el = el.parentElement;
    return el;
  }

  // Runs of consecutive text nodes in the same block.
  function groupByBlock(nodes) {
    const groups = [];
    let cur = null;
    for (const node of nodes) {
      const block = blockOf(node);
      if (!cur || cur.block !== block || cur.length + node.nodeValue.length > MAX_BLOCK_TEXT) {
        cur = { block, nodes: [], length: 0 };
        groups.push(cur);
      }
      cur.nodes.push(node);
      cur.length += node.nodeValue.length + 1;
    }
    return groups;
  }

  // Tags a block's text in one go and processes each of its text nodes with its share.
  function processGroup(group) {
    if (settings.mode === 'sentence') return processSentences(group);
    const texts = group.nodes.map((n) => n.nodeValue);
    let tags = null;
    try {
      tags = tagger ? tagger.tag(texts.join(' ')) : null;
    } catch {
      tags = null; // matching by spelling alone still works
    }
    let offset = 0;
    let t = 0;
    group.nodes.forEach((node, k) => {
      const end = offset + texts[k].length;
      let mine;
      if (tags) {
        mine = [];
        while (t < tags.length && tags[t].start < offset) t++;
        for (let u = t; u < tags.length && tags[u].start < end; u++) {
          if (tags[u].end <= end) mine.push({ ...tags[u], start: tags[u].start - offset, end: tags[u].end - offset });
        }
      }
      processTextNode(node, mine);
      offset = end + 1;
    });
  }

  function processInSlices(nodes) {
    const mine = run;
    const groups = groupByBlock(nodes);
    let i = 0;
    const step = () => {
      if (!running || run !== mine) return;
      const until = performance.now() + CHUNK_MS;
      while (i < groups.length && performance.now() < until && !full()) processGroup(groups[i++]);
      if (i < groups.length && !full()) idle(step);
    };
    step();
  }

  const full = () => (settings.mode === 'sentence' ? count + jobs.length >= MAX_SENTENCES : count >= MAX_REPLACEMENTS);

  // ---- Sentences -------------------------------------------------------------

  // Sentences that contain one of these stay English: controls would stop working, and
  // images, code or line breaks would be lost. Links are fine: they come back with the
  // English.
  const BLOCKERS = 'img, picture, svg, video, audio, iframe, input, button, select, textarea, br, code, kbd, .rc-word, .rc-sentence';
  const originals = new WeakMap(); // .rc-sentence -> the English it replaced (DocumentFragment)
  let jobs = []; // { range, text } waiting for the translator, in page order
  let pumping = false;
  // Letters and digits only: text nodes with just punctuation (the ", " between two links)
  // aren't collected, so the joined text can lack some of the page's commas.
  const squash = (s) => s.replace(/[^\p{L}\p{N}]+/gu, '');

  // Picks sentences in a block, easy ones more often, and queues them for translation. A
  // sentence can run across several text nodes ("I <b>really</b> like tea."), so each is
  // a Range.
  function processSentences(group) {
    for (const n of group.nodes) scanned.add(n);
    const texts = group.nodes.map((n) => n.nodeValue);
    const joined = texts.join(' ');
    let tags = null;
    try {
      tags = tagger ? tagger.tag(joined) : null;
    } catch {
      tags = null;
    }
    if (!tags?.sentences) return;
    const starts = [];
    let offset = 0;
    for (const t of texts) {
      starts.push(offset);
      offset += t.length + 1;
    }
    const nodeAt = (pos) => {
      let k = starts.length - 1;
      while (k > 0 && starts[k] > pos) k--;
      return k;
    };
    for (const sentence of tags.sentences) {
      if (full()) break;
      let { start, end } = sentence;
      while (start < end && /\s/.test(joined[start])) start++;
      while (end > start && /\s/.test(joined[end - 1])) end--;
      const text = joined.slice(start, end);
      const mine = tags.filter((t) => t.start >= start && t.end <= end).map((t) => ({ ...t, start: t.start - start, end: t.end - start }));
      // Easy sentences are picked at the slider's rate, harder ones less often.
      if (Math.random() * 100 >= settings.sentenceFrequency * sentences.chance(text, mine, lookups)) continue;
      const a = nodeAt(start);
      const b = nodeAt(end - 1);
      const range = document.createRange();
      try {
        range.setStart(group.nodes[a], start - starts[a]);
        range.setEnd(group.nodes[b], end - starts[b]);
      } catch {
        continue;
      }
      // The page's own text: the joined text has a space between nodes ("I <b>really</b>").
      if (safeRange(range, text)) jobs.push({ range, text: range.toString().replace(/\s+/g, ' ').trim() });
    }
    pump();
  }

  // True when range still holds just this sentence and nothing that replacing it would break.
  function safeRange(range, text) {
    if (!range.startContainer.isConnected || squash(range.toString()) !== squash(text)) return false;
    const common = range.commonAncestorContainer;
    const el = common.nodeType === Node.ELEMENT_NODE ? common : common.parentElement;
    if (!el || el.closest('[role="button"], .rc-sentence, .rc-word') || skippedElement(el)) return false;
    return !range.cloneContents().querySelector(BLOCKERS);
  }

  // The queued sentence to translate next: the first one on screen, else the first one.
  function nextJob() {
    for (let i = 0; i < jobs.length; i++) {
      const r = jobs[i].range.getBoundingClientRect();
      if (r.bottom > 0 && r.top < innerHeight && (r.width || r.height)) return i;
    }
    return 0;
  }

  // Translates the queued sentences one at a time and puts each translation in the page.
  async function pump() {
    if (pumping) return;
    pumping = true;
    const mine = run;
    try {
      while (jobs.length && running && run === mine) {
        const job = jobs.splice(nextJob(), 1)[0];
        let translated = '';
        try {
          translated = (await translate(job.text)).trim();
        } catch {
          continue;
        }
        if (!running || run !== mine) break;
        if (translated && count < MAX_SENTENCES) replaceSentence(job, translated);
      }
    } finally {
      pumping = false;
    }
    if (running && jobs.length) pump(); // queued by a restart while this one was finishing
  }

  function replaceSentence({ range, text }, translated) {
    if (!safeRange(range, text)) return; // the page changed in the meantime
    if (observer) onMutations(observer.takeRecords());
    const wrap = makeSentence(translated, text);
    const english = range.extractContents();
    range.insertNode(wrap);
    for (const n of [wrap.previousSibling, wrap.nextSibling]) if (n?.nodeType === Node.TEXT_NODE) scanned.add(n);
    observer?.takeRecords(); // the changes above are ours
    originals.set(wrap, english);
    count++;
  }

  function makeSentence(translated, english) {
    const wrap = document.createElement('span');
    wrap.className = 'rc-sentence';
    wrap.lang = langTag();
    wrap.dataset.rcOrig = english;
    wrap.dataset.rcText = translated;
    for (const part of sentences.segment(translated, dict.lang, wordIdx, stems)) {
      wrap.append(part.id === undefined ? part.text : makeWord({ id: part.id, surface: part.text }));
    }
    return wrap;
  }

  // Puts the English sentence back as it was, links and formatting included.
  function restoreSentence(wrap) {
    const english = originals.get(wrap);
    originals.delete(wrap);
    if (!english) return wrap.remove();
    const walker = document.createTreeWalker(english, NodeFilter.SHOW_TEXT);
    for (let n; (n = walker.nextNode()); ) scanned.add(n);
    wrap.replaceWith(english);
  }

  // The sentence's reading, from its dictionary words: pinyin, or kana for Japanese.
  function sentenceReading(wrap) {
    const ja = dict.lang === 'ja';
    const parts = [];
    for (const n of wrap.childNodes) {
      if (n.nodeType === Node.ELEMENT_NODE && n.classList.contains('rc-word')) {
        const [simp, , reading] = dict.words[Number(n.dataset.rcId)];
        const surface = n.dataset.rcSurface || simp;
        parts.push(ja ? reading.slice(0, reading.length - (simp.length - surface.length)) : reading);
      } else {
        parts.push(n.textContent);
      }
    }
    return ja ? parts.join('') : parts.join(' ').replace(/\s+([，。！？、；：,.!?”」）)])/g, '$1').replace(/\s+/g, ' ').trim();
  }

  // ---- Translator ------------------------------------------------------------

  // Sentences are translated on the computer by a small ONNX translation model in the
  // extension's offscreen document (src/offscreen/), which the background worker passes
  // them to. The model is downloaded once, with the popup's Download button.
  let translatorState = 'off'; // 'off' | 'checking' | 'ready' | 'needs-download' | 'error'
  let tradMap = null; // simplified -> traditional characters, for traditional Chinese
  let translatorTarget = null; // the language it's ready for
  const translations = new Map(); // "target English" -> translation, for Shuffle

  const targetLanguage = (s) => (s.language === 'ja' ? 'ja' : s.script === 'traditional' ? 'zh-Hant' : 'zh');

  const STATES = { ready: 'ready', downloadable: 'needs-download', downloading: 'needs-download' };

  // Resolves to true once the translator for target is ready.
  async function ensureTranslator(target) {
    if (translatorTarget === target && translatorState === 'ready') return true;
    translatorTarget = null;
    translatorState = 'checking';
    let res = null;
    try {
      res = await chrome.runtime.sendMessage({ type: 'rc-translator', lang: target });
    } catch {
      res = null; // the extension was reloaded since this page loaded
    }
    translatorState = STATES[res?.state] || 'error';
    if (translatorState !== 'ready') return false;
    translatorTarget = target;
    return true;
  }

  async function translate(text) {
    const key = `${translatorTarget} ${text}`;
    if (!translations.has(key)) {
      const res = await chrome.runtime.sendMessage({ type: 'rc-translate', lang: translatorTarget, text });
      if (!res?.ok) throw new Error(res?.error || 'translation failed');
      if (translatorTarget === 'zh-Hant') tradMap ||= sentences.traditionalMap(dict);
      translations.set(key, sentences.tidy(res.text, text, dict.lang, translatorTarget === 'zh-Hant' ? tradMap : null));
    }
    return translations.get(key);
  }

  const idle = (fn) => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 500 }) : setTimeout(fn, 16));

  function start() {
    running = true;
    run++;
    const ja = settings.language === 'ja';
    const system = ja ? 'jlpt' : settings.system;
    const level = ja ? settings.jlptLevel : settings.level;
    lookup = createLookup(dict, { system, level, onlyLevel: settings.onlyLevel });
    if (settings.mode === 'sentence') {
      // How readable a sentence is depends on how many of its words are at or below the
      // level; with "only new words", it also needs a word introduced at the level.
      lookups = {
        all: createLookup(dict, { system, level, onlyLevel: false }),
        fresh: settings.onlyLevel ? lookup : null,
      };
      wordIdx = sentences.wordIndex(dict, LEVEL_COL[system], traditional() ? 1 : 0);
      stems = ja ? sentences.stemIndex(dict, LEVEL_COL[system]) : null;
    }
    enqueue(document.body);
    observer = new MutationObserver(onMutations);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function onMutations(records) {
    for (const r of records) {
      if (r.type === 'characterData') {
        scanned.delete(r.target);
        enqueue(r.target);
      } else {
        for (const n of r.addedNodes) {
          const ours = n.nodeType === Node.ELEMENT_NODE && n.matches('.rc-word, .rc-group, .rc-sentence');
          if (!ours && !scanned.has(n)) enqueue(n);
        }
      }
    }
  }

  function stop() {
    running = false;
    observer?.disconnect();
    observer = null;
    queue.length = 0;
    jobs = [];
    closePopover();
    for (const el of document.querySelectorAll('.rc-sentence')) restoreSentence(el);
    for (const el of document.querySelectorAll('.rc-group, .rc-word')) if (el.isConnected) restoreWord(el);
    count = 0;
    scanned = new WeakSet();
  }

  // Puts the English back, merged with the neighbouring text this script split off, so a
  // later pass sees "every day" as one phrase again. The page's own text nodes are left
  // alone, as frameworks may hold on to them.
  function restoreWord(el) {
    const target = el.closest('.rc-group') || el;
    const t = document.createTextNode(target.dataset.rcOrig);
    target.replaceWith(t);
    for (const side of ['previousSibling', 'nextSibling']) {
      const n = t[side];
      if (n && n.nodeType === Node.TEXT_NODE && created.has(n)) {
        t.nodeValue = side === 'previousSibling' ? n.nodeValue + t.nodeValue : t.nodeValue + n.nodeValue;
        n.remove();
      }
    }
    scanned.add(t);
    created.add(t);
  }

  // The dictionary for a language, which the background worker injects into this page the
  // first time it's needed (each is over a megabyte, so only the chosen one is loaded).
  async function loadDict(lang) {
    if (!globalThis.RC_DICTS?.[lang]) {
      const res = await chrome.runtime.sendMessage({ type: 'rc-load-dict', lang });
      if (!res?.ok) throw new Error(`could not load the ${lang} dictionary`);
    }
    return globalThis.RC_DICTS[lang];
  }

  let applying = 0;
  async function apply() {
    const mine = ++applying;
    const next = await loadSettings();
    let nextDict = null;
    try {
      if (shouldRun(next) && document.body) nextDict = await loadDict(next.language);
    } catch {
      nextDict = null; // the extension was reloaded or the page can't be scripted
    }
    if (mine !== applying) return; // a newer change superseded this one
    stop();
    settings = next;
    dict = nextDict;
    if (!dict) return;
    if (settings.mode === 'word') {
      translatorState = 'off';
      return start();
    }
    if (await ensureTranslator(targetLanguage(settings)) && mine === applying) start();
  }

  // ---- Popover ---------------------------------------------------------------

  let pop = null; // { host, card, word }: word is the .rc-word or .rc-sentence it's for

  const POPOVER_CSS = `
    :host { all: initial; }
    .card {
      --bg: #ffffff; --fg: #1f1f1f; --muted: #6b6b6b; --line: #e7e2dc; --accent: #c8402a; --chip: #fbeae6;
      position: fixed; z-index: 2147483647; width: 280px; box-sizing: border-box;
      padding: 14px 16px 12px; border-radius: 12px; background: var(--bg); color: var(--fg);
      border: 1px solid var(--line); box-shadow: 0 12px 32px rgba(0,0,0,.18), 0 2px 6px rgba(0,0,0,.08);
      font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; text-align: left;
    }
    @media (prefers-color-scheme: dark) {
      .card { --bg: #23211f; --fg: #f2efea; --muted: #a8a29b; --line: #3a3633; --accent: #ff7a5c; --chip: #3b2620; }
    }
    .row { display: flex; align-items: center; gap: 10px; }
    .hanzi { font: 600 34px/1.1 "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif; letter-spacing: .02em; }
    .alt { color: var(--muted); font-size: 16px; }
    .pinyin { margin-top: 2px; font-size: 18px; color: var(--accent); font-weight: 500; }
    .speak {
      margin-left: auto; width: 34px; height: 34px; flex: none; border-radius: 50%; border: 1px solid var(--line);
      background: transparent; color: var(--fg); cursor: pointer; display: grid; place-items: center; padding: 0;
    }
    .speak:hover { background: var(--chip); color: var(--accent); border-color: transparent; }
    .speak svg { width: 18px; height: 18px; }
    .badge { display: inline-block; margin-top: 8px; padding: 1px 8px; border-radius: 999px; background: var(--chip); color: var(--accent); font-size: 12px; font-weight: 600; }
    ol { margin: 8px 0 0; padding-left: 20px; }
    li { margin: 2px 0; }
    .grammar { margin: 8px 0 0; padding: 6px 8px; border-radius: 8px; background: var(--chip); font-size: 13px; }
    .foot { display: flex; align-items: center; gap: 8px; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--line); color: var(--muted); font-size: 13px; }
    .foot b { color: var(--fg); font-weight: 600; }
    .show-en { margin-left: auto; border: none; background: none; color: var(--accent); font: inherit; font-weight: 600; cursor: pointer; padding: 2px 0; }
    .show-en:hover { text-decoration: underline; }
    .foot .link { margin-left: 0; }
    .card.wide { width: 360px; }
    .sentence { font: 500 20px/1.5 "PingFang SC", "Hiragino Sans", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif; }
    .row.top { align-items: flex-start; }
    .reading { margin-top: 4px; font-size: 14px; color: var(--accent); }
    .english { margin: 8px 0 0; color: var(--fg); }
  `;

  const SPEAKER_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>';

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function speakButton(text) {
    const speak = el('button', 'speak');
    speak.type = 'button';
    speak.title = 'Listen';
    speak.setAttribute('aria-label', 'Listen to pronunciation');
    speak.innerHTML = SPEAKER_SVG;
    speak.addEventListener('click', () => say(text));
    return speak;
  }

  function linkButton(text, cls, onClick) {
    const b = el('button', cls, text);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  // Opens a card for target (a word or sentence) built from children.
  function openCard(target, label, children, cls = '') {
    closePopover();
    const host = el('div');
    host.id = 'random-red-ink-popover';
    const root = host.attachShadow({ mode: 'open' });
    const style = el('style');
    style.textContent = POPOVER_CSS;
    const card = el('div', `card ${cls}`.trim());
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', label);
    card.append(...children);
    root.append(style, card);
    document.documentElement.append(host);
    pop = { host, card, word: target };
    target.classList.add('rc-active');
    position();
    window.addEventListener('scroll', position, true);
    window.addEventListener('resize', position);
  }

  function showSentence(wrap) {
    const text = wrap.dataset.rcText;
    const top = el('div', 'row top');
    const sentence = el('span', 'sentence', text);
    sentence.lang = langTag();
    top.append(sentence, speakButton(text));
    const reading = sentenceReading(wrap);
    const foot = el('div', 'foot');
    foot.append(el('span', null, 'Translated on your device'), linkButton('Show English', 'show-en', () => {
      closePopover();
      restoreSentence(wrap);
      count--;
    }));
    openCard(wrap, text, [top, ...(reading && reading !== text ? [el('div', 'reading', reading)] : []), el('p', 'english', wrap.dataset.rcOrig), foot], 'wide');
  }

  function showPopover(word) {
    const id = Number(word.dataset.rcId);
    const [simp, trad, pinyin, , , meanings] = dict.words[id];
    const ja = dict.lang === 'ja';
    const hanzi = traditional() ? trad : simp;
    const other = traditional() ? simp : trad;
    const level = dict.words[id][LEVEL_COL[ja ? 'jlpt' : settings.system]];
    const inSentence = word.closest('.rc-sentence');

    const suffix = word.dataset.rcSuffix || '';
    const prefix = word.dataset.rcPrefix || '';
    const top = el('div', 'row');
    const h = el('span', 'hanzi', prefix + hanzi + suffix);
    h.lang = langTag();
    top.append(h);
    if (other !== hanzi) top.append(el('span', 'alt', prefix + other + suffix));
    top.append(speakButton(prefix + simp + suffix));

    const list = el('ol');
    for (const m of meanings.split(' | ')) list.append(el('li', null, m));
    // Grammar the extension added: 我的 / 私の "my", 三本 "three (books)", 最高 / 一番高い
    // "highest".
    const english = (word.dataset.rcOrig || '').toLowerCase();
    const { grammar: g } = dict;
    let note = '';
    if (suffix === g.possessive[0]) note = `${suffix} ${word.dataset.rcSuffixPinyin} marks possession: ${hanzi}${suffix} = “${english}”.`;
    else if (suffix) note = `${suffix} ${word.dataset.rcSuffixPinyin} is the measure word Chinese puts between a number and this noun.`;
    if (prefix) note = `${prefix} ${word.dataset.rcPrefixPinyin} means “${prefix === g.most[0] ? 'most' : 'more'}”: ${prefix}${hanzi} = “${english}”.`;
    const grammar = note ? el('p', 'grammar', note) : null;

    const foot = el('div', 'foot');
    if (inSentence) {
      // A word in a translated sentence: back to the sentence, or its English.
      foot.append(linkButton('Whole sentence', 'show-en link', () => showSentence(inSentence)), linkButton('Show English', 'show-en', () => {
        closePopover();
        restoreSentence(inSentence);
        count--;
      }));
    } else {
      const orig = el('span');
      orig.append('English: ', el('b', null, word.dataset.rcOrig));
      foot.append(orig, linkButton('Show English', 'show-en', () => {
        closePopover();
        restoreWord(word);
        count--;
      }));
    }

    const label = ja ? `JLPT N${6 - level}` : settings.system === 'hsk2' ? `HSK 2.0 · Level ${level}` : `HSK 3.0 · Level ${level === 7 ? '7–9' : level}`;
    const fullPinyin = [word.dataset.rcPrefixPinyin, pinyin, word.dataset.rcSuffixPinyin].filter(Boolean).join(' ');
    openCard(word, `${hanzi} ${pinyin}`, [top, el('div', 'pinyin', fullPinyin), el('span', 'badge', label), list, ...(grammar ? [grammar] : []), foot]);
  }

  function position() {
    if (!pop) return;
    if (!pop.word.isConnected) return closePopover();
    const r = pop.word.getBoundingClientRect();
    const c = pop.card.getBoundingClientRect();
    const margin = 8;
    let top = r.bottom + margin;
    if (top + c.height > innerHeight - margin && r.top - margin - c.height > margin) top = r.top - margin - c.height;
    const left = Math.min(Math.max(r.left + r.width / 2 - c.width / 2, margin), innerWidth - c.width - margin);
    pop.card.style.top = `${Math.round(top)}px`;
    pop.card.style.left = `${Math.round(left)}px`;
  }

  function closePopover() {
    if (!pop) return;
    pop.word.classList.remove('rc-active');
    pop.host.remove();
    pop = null;
    window.removeEventListener('scroll', position, true);
    window.removeEventListener('resize', position);
  }

  function say(text) {
    const lang = dict.speech;
    try {
      chrome.runtime.sendMessage({ type: 'rc-speak', text, lang })
        .then((res) => { if (!res?.ok) speakInPage(text, lang); })
        .catch(() => speakInPage(text, lang));
    } catch {
      speakInPage(text, lang); // the extension was reloaded since this page loaded
    }
  }

  // Fallback when the extension's TTS is unavailable. lang: 'zh-CN' or 'ja-JP'.
  function speakInPage(text, lang) {
    if (!window.speechSynthesis) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    u.rate = 0.8;
    const voices = speechSynthesis.getVoices();
    const base = lang.slice(0, 2);
    u.voice = voices.find((v) => v.lang.replace('_', '-').toLowerCase() === lang.toLowerCase()) || voices.find((v) => v.lang.startsWith(base)) || null;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  }

  window.addEventListener('click', (e) => {
    if (pop && e.composedPath().includes(pop.host)) return;
    const target = e.target instanceof Element ? e.target : null;
    const word = target?.closest('.rc-word');
    const sentence = word ? null : target?.closest('.rc-sentence');
    if (!word && !sentence) return closePopover();
    // Words inside links shouldn't navigate.
    e.preventDefault();
    e.stopPropagation();
    if (pop?.word === (word || sentence)) return closePopover();
    if (word) showPopover(word);
    else showSentence(sentence);
  }, true);

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePopover();
  }, true);

  // ---- Wiring ----------------------------------------------------------------

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync') apply();
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'rc-status') {
      sendResponse({ host: location.hostname, count, running, english: pageLooksEnglish(), translator: translatorState });
    } else if (msg?.type === 'rc-reroll') {
      apply();
      sendResponse({ ok: true });
    } else if (msg?.type === 'rc-translator-ready') {
      // The popup just downloaded the translator this page was waiting for.
      if (settings?.mode === 'sentence' && translatorState !== 'ready') apply();
      sendResponse({ ok: true });
    }
  });

  apply();
})();
