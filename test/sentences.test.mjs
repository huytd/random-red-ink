import { test } from 'node:test';
import assert from 'node:assert/strict';

await import('../vendor/compromise.js');
await import('../src/tagger.js');
await import('../src/dict-zh.js');
await import('../src/dict-ja.js');
await import('../src/matcher.js');
await import('../src/sentences.js');
const zh = globalThis.RC_DICTS.zh;
const ja = globalThis.RC_DICTS.ja;
const { createLookup, LEVEL_COL } = globalThis.RC_MATCHER;
const { readable, wordIndex, stemIndex, segment } = globalThis.RC_SENTENCES;
const { tag } = globalThis.RC_TAGGER;

const lookups = (level, onlyLevel = false) => ({
  all: createLookup(zh, { system: 'hsk3', level, onlyLevel: false }),
  fresh: onlyLevel ? createLookup(zh, { system: 'hsk3', level, onlyLevel: true }) : null,
});

// The sentences in text that a learner with these lookups can mostly read.
const pick = (text, l) => {
  const tags = tag(text);
  return tags.sentences
    .map(({ start, end }) => [text.slice(start, end).trim(), tags.filter((t) => t.start >= start && t.end <= end).map((t) => ({ ...t, start: t.start - start, end: t.end - start }))])
    .filter(([s, t]) => readable(s, t, l))
    .map(([s]) => s);
};

test('the tagger splits sentences without breaking at abbreviations', () => {
  const text = 'Hi there. Mr. Smith went to Washington. Did he? Yes!';
  assert.deepEqual(tag(text).sentences.map(({ start, end }) => text.slice(start, end)), ['Hi there.', 'Mr. Smith went to Washington.', 'Did he?', 'Yes!']);
});

test('picks the sentences a learner can mostly read at their level', () => {
  const text = 'Today I want to tell you about my friend. The government announced new restrictions on imports last week. Researchers found that the protein binds to receptors in the membrane.';
  assert.deepEqual(pick(text, lookups(1)), ['Today I want to tell you about my friend.']);
  assert.deepEqual(pick(text, lookups(4)), ['Today I want to tell you about my friend.', 'The government announced new restrictions on imports last week.']);
});

test('skips headings, menus and very long sentences', () => {
  assert.deepEqual(pick('Home', lookups(6)), []);
  assert.deepEqual(pick('About us', lookups(6)), []);
  assert.deepEqual(pick('I LIKE TO EAT RICE EVERY DAY.', lookups(6)), []);
  const long = `${'I like to eat rice and '.repeat(8)}drink tea.`;
  assert.deepEqual(pick(long, lookups(6)), []);
});

test('with "only new words", a sentence needs a word introduced at the level', () => {
  // weekend (周末) is HSK 2; every other word is HSK 1.
  const text = 'I like to drink tea every day. We watch movies with our friends on the weekend.';
  assert.deepEqual(pick(text, lookups(2)), ['I like to drink tea every day.', 'We watch movies with our friends on the weekend.']);
  assert.deepEqual(pick(text, lookups(2, true)), ['We watch movies with our friends on the weekend.']);
});

test('finds dictionary words in a Chinese translation', () => {
  const index = wordIndex(zh, LEVEL_COL.hsk3, 0);
  const parts = segment('我们早上喜欢喝茶，吃米饭。', 'zh', index);
  assert.equal(parts.map((p) => p.text).join(''), '我们早上喜欢喝茶，吃米饭。');
  assert.deepEqual(parts.filter((p) => p.id !== undefined).map((p) => zh.words[p.id][0]), ['我们', '早上', '喜欢', '喝', '茶', '吃', '米饭']);
});

test('finds traditional characters in a traditional translation', () => {
  const index = wordIndex(zh, LEVEL_COL.hsk3, 1);
  const words = segment('我們喜歡學習。', 'zh', index).filter((p) => p.id !== undefined);
  assert.deepEqual(words.map((p) => zh.words[p.id][0]), ['我们', '喜欢', '学习']);
});

test('finds conjugated Japanese words by their stem', () => {
  const index = wordIndex(ja, LEVEL_COL.jlpt, 0);
  const stems = stemIndex(ja, LEVEL_COL.jlpt);
  const show = (text) => segment(text, 'ja', index, stems).map((p) => (p.id === undefined ? p.text : `[${p.text}=${ja.words[p.id][0]}]`)).join('');
  assert.equal(show('私たちは朝にお茶を飲みます。'), '[私=私]たちは[朝=朝]に[お茶=お茶]を[飲=飲む]みます。');
  assert.equal(show('パンを食べました。'), '[パン=パン]を[食べ=食べる]ました。');
  assert.equal(show('この山はとても高くて美しいです。'), 'この[山=山]は[とても=とても][高=高い]くて[美しい=美しい]です。');
  assert.equal(show('話を聞いて、話したいです。'), '[話=話]を[聞=聞く]いて、[話=話す]したいです。');
  assert.equal(show('手伝ってくれますか？'), '[手伝=手伝う]ってくれますか？');
  assert.equal(show('学校に行きます。'), '[学校=学校]に[行=行く]きます。');
  assert.equal(show('ご飯を食べる。'), '[ご飯=御飯]を[食べる=食べる]。');
});
