import test from 'node:test';
import assert from 'node:assert/strict';
import { checkContent, type MatchHit } from '../src/index.js';
import { buildLexicon } from '../src/lexicon.js';

function summarize(hits: MatchHit[]) {
  return hits.map((h) => ({ word: h.word, ranges: h.ranges }));
}

test('敏感词横跨强调与链接标签，重叠词条全部命中', () => {
  //            0123 4567 8901234567 8901
  //            a*b[ c]( https://x  )d*
  const content = 'a*b[c](https://x)d*';
  const lexicon = buildLexicon(['abc', 'bcd', 'abcd', 'bc']);
  const hits = checkContent(lexicon, content);
  assert.deepEqual(summarize(hits), [
    { word: 'abc', ranges: [{ start: 0, end: 1 }, { start: 2, end: 3 }, { start: 4, end: 5 }] },
    { word: 'bc', ranges: [{ start: 2, end: 3 }, { start: 4, end: 5 }] },
    { word: 'abcd', ranges: [{ start: 0, end: 1 }, { start: 2, end: 3 }, { start: 4, end: 5 }, { start: 17, end: 18 }] },
    { word: 'bcd', ranges: [{ start: 2, end: 3 }, { start: 4, end: 5 }, { start: 17, end: 18 }] },
  ]);
});

test('链接地址与代码内容不产生误报', () => {
  const lexicon = buildLexicon(['abc', 'bc', 'code']);
  const hits = checkContent(lexicon, '[标签](https://abc.example/bc) `code`');
  assert.deepEqual(hits, []);
});

test('代码区域与换行是匹配边界，两侧文字不能拼成命中', () => {
  const lexicon = buildLexicon(['ab', 'ba', 'acbd']);
  // 行内代码隔开
  assert.deepEqual(checkContent(lexicon, 'a`x`b'), []);
  // 围栏代码块隔开
  assert.deepEqual(checkContent(lexicon, 'a\n```\nx\n```\nb'), []);
  // 软换行隔开
  assert.deepEqual(checkContent(lexicon, 'a\nb'), []);
  // 段落隔开
  assert.deepEqual(checkContent(lexicon, 'a\n\nb'), []);
  // 同一行可见文字连贯匹配
  const hits = checkContent(lexicon, 'ab');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].word, 'ab');
});

test('同一词条的每次出现都返回', () => {
  const lexicon = buildLexicon(['ab']);
  const hits = checkContent(lexicon, 'ab ab *ab*');
  assert.equal(hits.length, 3);
  assert.deepEqual(hits.map((h) => h.ranges), [
    [{ start: 0, end: 2 }],
    [{ start: 3, end: 5 }],
    [{ start: 7, end: 9 }],
  ]);
});

test('同一词条的自重叠出现都返回', () => {
  const lexicon = buildLexicon(['aa']);
  const hits = checkContent(lexicon, 'aaa');
  assert.deepEqual(hits.map((h) => h.ranges), [
    [{ start: 0, end: 2 }],
    [{ start: 1, end: 3 }],
  ]);
});

test('映回相同原文范围的命中不去重', () => {
  // “ﬁ”与“fi”归一化后相同，两个词条都必须命中同一原文范围
  const lexicon = buildLexicon(['ﬁ', 'fi']);
  const hits = checkContent(lexicon, 'fi');
  assert.equal(hits.length, 2);
  assert.deepEqual(hits.map((h) => h.word).sort(), ['fi', 'ﬁ']);
  for (const hit of hits) assert.deepEqual(hit.ranges, [{ start: 0, end: 2 }]);
});

test('可见文字相同时，有无格式标记的命中词条与次数一致', () => {
  const lexicon = buildLexicon(['abc', 'bc', 'abcd']);
  const baseline = checkContent(lexicon, 'xabcdy')
    .map((h) => h.word)
    .sort();
  const variants = ['xa*b[c](https://x)d*y', 'x*[abcd](https://x)*y', 'x*a**bc**d*y'];
  for (const variant of variants) {
    const words = checkContent(lexicon, variant).map((h) => h.word).sort();
    assert.deepEqual(words, baseline, `variant: ${variant}`);
  }
});
