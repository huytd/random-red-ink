// Sentence mode: decides which English sentences a learner can mostly read at their level,
// and finds the dictionary words in a translated sentence so they can be clicked. Loaded
// as a content script after src/matcher.js (sets globalThis.RC_SENTENCES) and imported by
// the tests.
(function (root) {
  'use strict';

  // A sentence is easy enough when this share of its content words (not grammar words or
  // names) has a translation at the learner's level. Harder sentences are picked less
  // often, down to MIN_CHANCE, rather than never: at HSK 1 hardly any real sentence is
  // easy enough.
  const MIN_COVERAGE = 0.6;
  const MIN_CHANCE = 0.25;
  // Sentences shorter than this are mostly headings, buttons and menu items; longer ones
  // are hard to take in at once.
  const MIN_WORDS = 4;
  const MAX_WORDS = 30;
  const WORD_RE = /[A-Za-zÀ-ÖØ-öø-ÿ]+(?:['’][A-Za-zÀ-ÖØ-öø-ÿ]+)*/g;
  const HAN = /\p{Script=Han}/u;
  const MAX_WORD_LENGTH = 6; // characters in the longest dictionary word looked for

  const wordCount = (text) => (text.match(WORD_RE) || []).length;

  // { words, known }: how many content words the sentence has, and how many of them are
  // part of a match at the learner's level. tags: from RC_TAGGER.tag, relative to text.
  function readability(text, tags, lookup) {
    const { findMatches } = root.RC_MATCHER;
    const content = tags.filter((t) => !t.skip && !t.name && /[A-Za-z]/.test(text.slice(t.start, t.end)));
    const matches = findMatches(text, lookup, tags);
    const known = content.filter((t) => matches.some((m) => t.start >= m.start && t.end <= m.end)).length;
    return { words: content.length, known };
  }

  // How likely text is to be translated for this learner, from 0 to 1: 0 for headings,
  // menus, very long sentences and, with lookups.fresh (the "only words new at this level"
  // lookup), sentences without a word new at the level; 1 for sentences mostly made of
  // words at the level; in between for harder ones.
  function chance(text, tags, lookups) {
    const n = wordCount(text);
    if (n < MIN_WORDS || n > MAX_WORDS) return 0;
    if (!/[a-z]/.test(text)) return 0; // ALL-CAPS banners
    const { words, known } = readability(text, tags, lookups.all);
    if (words < 2) return 0;
    if (lookups.fresh && !root.RC_MATCHER.findMatches(text, lookups.fresh, tags).length) return 0;
    return Math.min(1, MIN_CHANCE + (1 - MIN_CHANCE) * (known / words / MIN_COVERAGE));
  }

  // Map from a word as written to its dictionary row, for the words that have a level in
  // this syllabus. col: the level column (RC_MATCHER.LEVEL_COL); form: 0 for simplified
  // Chinese and Japanese, 1 for traditional Chinese.
  function wordIndex(dict, col, form = 0) {
    const index = new Map();
    const add = (key, id) => {
      const prev = index.get(key);
      if (prev === undefined || dict.words[id][col] < dict.words[prev][col]) index.set(key, id);
    };
    dict.words.forEach((row, id) => {
      if (!(row[col] > 0)) return;
      add(row[form], id);
      // 御飯 is usually written ご飯, 御茶 お茶.
      if (dict.lang === 'ja' && row[0][0] === '御' && /^[ごお]/.test(row[2])) add(row[2][0] + row[0].slice(1), id);
    });
    return index;
  }

  // Japanese verbs and い-adjectives by their stem, as the word segmenter splits
  // conjugated forms: 飲|み|ます, 食|べ|ま|した, 高|く|て. Map from stem to
  // [{ id, word, next }], where next lists the kana that may follow the stem (null: any).
  const HIRAGANA = /^[\p{Script=Hiragana}]+$/u;
  const GODAN = { う: 'わいえおっ', く: 'かきけこい', ぐ: 'がぎげごい', す: 'さしせそ', つ: 'たちてとっ', ぬ: 'なにねのん', ぶ: 'ばびべぼん', む: 'まみめもん', る: 'らりれろっ' };
  const ICHIDAN_STEM_END = /[いきしちにひみりぎじびぴえけせてねへめれげぜべぺ]$/u;
  function stemIndex(dict, col) {
    const stems = new Map();
    dict.words.forEach((row, id) => {
      const word = row[0];
      if (!(row[col] > 0) || word.length < 2 || !HAN.test(word)) return;
      const end = word.slice(-1);
      const stem = word.slice(0, -1);
      let next;
      if (end === 'い' && HAN.test(stem.slice(-1))) next = 'くかけさそ'; // 高い: 高く, 高かった
      else if (end === 'る' && (ICHIDAN_STEM_END.test(stem) || stem.length === 1)) next = null; // 食べる, 見る (or godan 帰る)
      else if (GODAN[end]) next = GODAN[end];
      else return;
      if (!stems.has(stem)) stems.set(stem, []);
      stems.get(stem).push({ id, word, next });
    });
    for (const list of stems.values()) list.sort((a, b) => dict.words[a.id][col] - dict.words[b.id][col]);
    return stems;
  }

  // { id, length } for a conjugated Japanese word starting at text[pos]: a stem (飲 before
  // み, 食べ before ま) followed by an ending it allows, that takes in all the kanji of its
  // segment (which ends at segEnd). A particle after the stem means it's a noun: 話を, 話す.
  const PARTICLES = 'はがをにでとものへや';
  function conjugated(text, pos, segEnd, stems) {
    for (let n = Math.min(MAX_WORD_LENGTH, text.length - pos - 1); n >= 1; n--) {
      const list = stems.get(text.slice(pos, pos + n));
      const next = text[pos + n];
      if (!list || !HIRAGANA.test(next) || PARTICLES.includes(next) || HAN.test(text.slice(pos + n, segEnd))) continue;
      const plain = list.find((c) => text.startsWith(c.word, pos)); // not conjugated: 食べる
      if (plain) return { id: plain.id, length: plain.word.length };
      const hit = list.find((c) => !c.next || c.next.includes(next));
      if (hit) return { id: hit.id, length: n };
    }
    return null;
  }

  // Splits a translated sentence into [{ text, id? }], where id is the dictionary row of a
  // word the learner can click. Words come from the browser's word segmenter; a segment
  // that isn't in the dictionary may start a conjugated Japanese word (with stems from
  // stemIndex), or is searched for the longest dictionary words that start with a Han
  // character (喝茶 -> 喝 + 茶), so kana endings and particles stay plain text.
  function segment(text, lang, index, stems = null) {
    const out = [];
    const plain = (s) => {
      if (!s) return;
      const last = out[out.length - 1];
      if (last && last.id === undefined) last.text += s;
      else out.push({ text: s });
    };
    const segments = typeof Intl.Segmenter === 'function'
      ? Array.from(new Intl.Segmenter(lang, { granularity: 'word' }).segment(text), (s) => ({ start: s.index, end: s.index + s.segment.length }))
      : [{ start: 0, end: text.length }];
    let pos = 0; // text before pos is done; a conjugated word can reach into later segments
    for (const seg of segments) {
      if (seg.end <= pos) continue;
      const whole = seg.start >= pos;
      const s = text.slice(Math.max(seg.start, pos), seg.end);
      // Verbs first, so 話|した is 話す rather than the noun 話.
      const verb = stems && whole && HAN.test(s) ? conjugated(text, seg.start, seg.end, stems) : null;
      if (verb) {
        out.push({ text: text.slice(seg.start, seg.start + verb.length), id: verb.id });
        pos = seg.start + verb.length;
        if (pos < seg.end) {
          plain(text.slice(pos, seg.end)); // the ending: 行|き
          pos = seg.end;
        }
        continue;
      }
      if (whole && index.has(s)) {
        out.push({ text: s, id: index.get(s) });
        pos = seg.end;
        continue;
      }
      let i = 0;
      let rest = '';
      while (i < s.length) {
        let hit = '';
        if (HAN.test(s[i])) {
          for (let n = Math.min(MAX_WORD_LENGTH, s.length - i); n >= 1; n--) {
            if (index.has(s.slice(i, i + n))) {
              hit = s.slice(i, i + n);
              break;
            }
          }
        }
        if (hit) {
          plain(rest);
          rest = '';
          out.push({ text: hit, id: index.get(hit) });
          i += hit.length;
        } else {
          rest += s[i++];
        }
      }
      plain(rest);
      pos = seg.end;
    }
    return out;
  }

  const api = { readability, chance, wordIndex, stemIndex, segment, MIN_COVERAGE, MIN_CHANCE, MIN_WORDS, MAX_WORDS };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RC_SENTENCES = api;
})(globalThis);
