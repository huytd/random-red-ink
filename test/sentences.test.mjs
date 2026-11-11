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
const { chance, wordIndex, stemIndex, segment, traditionalMap, tidy, MIN_CHANCE } = globalThis.RC_SENTENCES;
const { tag } = globalThis.RC_TAGGER;

const lookups = (level, onlyLevel = false) => ({
  all: createLookup(zh, { system: 'hsk3', level, onlyLevel: false }),
  fresh: onlyLevel ? createLookup(zh, { system: 'hsk3', level, onlyLevel: true }) : null,
});

// [sentence, chance] for each sentence in text.
const chances = (text, l) => {
  const tags = tag(text);
  return tags.sentences.map(({ start, end }) => {
    const s = text.slice(start, end).trim();
    return [s, chance(s, tags.filter((t) => t.start >= start && t.end <= end).map((t) => ({ ...t, start: t.start - start, end: t.end - start })), l)];
  });
};
// The sentences in text that a learner with these lookups can mostly read.
const pick = (text, l) => chances(text, l).filter(([, c]) => c === 1).map(([s]) => s);
// The sentences that are never picked.
const never = (text, l) => chances(text, l).filter(([, c]) => c === 0).map(([s]) => s);

test('the tagger splits sentences without breaking at abbreviations', () => {
  const text = 'Hi there. Mr. Smith went to Washington. Did he? Yes!';
  assert.deepEqual(tag(text).sentences.map(({ start, end }) => text.slice(start, end)), ['Hi there.', 'Mr. Smith went to Washington.', 'Did he?', 'Yes!']);
});

test('picks the sentences a learner can mostly read at their level', () => {
  const text = 'Today I want to tell you about my friend. The government announced new restrictions on imports last week. Researchers found that the protein binds to receptors in the membrane.';
  assert.deepEqual(pick(text, lookups(1)), ['Today I want to tell you about my friend.']);
  assert.deepEqual(pick(text, lookups(4)), ['Today I want to tell you about my friend.', 'The government announced new restrictions on imports last week.']);
});

test('harder sentences are picked less often, but still picked', () => {
  const [[, hard]] = chances('Researchers found that the protein binds to receptors in the membrane.', lookups(1));
  assert.ok(hard >= MIN_CHANCE && hard < 0.6, String(hard));
});

test('skips headings, menus and very long sentences', () => {
  for (const text of ['Home', 'About us', 'I LIKE TO EAT RICE EVERY DAY.', `${'I like to eat rice and '.repeat(8)}drink tea.`]) {
    assert.deepEqual(never(text, lookups(6)), [text]);
  }
});

test('with "only new words", a sentence needs a word introduced at the level', () => {
  // weekend (周末) is HSK 2; every other word is HSK 1.
  const text = 'I like to drink tea every day. We watch movies with our friends on the weekend.';
  assert.deepEqual(pick(text, lookups(2)), ['I like to drink tea every day.', 'We watch movies with our friends on the weekend.']);
  assert.deepEqual(pick(text, lookups(2, true)), ['We watch movies with our friends on the weekend.']);
  assert.deepEqual(never(text, lookups(2, true)), ['I like to drink tea every day.']);
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

test('tidies the model\'s punctuation', () => {
  // opus-mt-en-zh output, as the model writes it.
  assert.equal(tidy('今天我想告诉你我的朋友', 'Today I want to tell you about my friend.', 'zh'), '今天我想告诉你我的朋友。');
  assert.equal(tidy('你能帮我找到我的手机吗?', 'Can you help me find my phone?', 'zh'), '你能帮我找到我的手机吗？');
  assert.equal(tidy('云南地区可能已开始喝茶,因为在那里,茶用于药用目的。', 'x.', 'zh'), '云南地区可能已开始喝茶，因为在那里，茶用于药用目的。');
  assert.equal(tidy('私たちは朝ご飯を食べ,お茶を飲む', 'We eat breakfast and drink tea.', 'ja'), '私たちは朝ご飯を食べ、お茶を飲む。');
  // English and numbers keep their punctuation.
  assert.equal(tidy('我用 Node.js 3.5 版。', 'I use Node.js 3.5.', 'zh'), '我用 Node.js 3.5 版。');
});

test('turns stray simplified characters into traditional ones', () => {
  const trad = traditionalMap(zh);
  // As the dictionary writes them: 上周 and 宣布 are the same in traditional characters.
  assert.equal(tidy('政府上周宣布了新的进口限制。', 'x.', 'zh', trad), '政府上周宣布了新的進口限制。');
  assert.equal(tidy('我们周末学习汉语。', 'x.', 'zh', trad), '我們週末學習漢語。');
  assert.equal(tidy('你能幫我找到我的手機嗎?', 'x?', 'zh', trad), '你能幫我找到我的手機嗎？');
});
