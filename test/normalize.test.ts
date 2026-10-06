import test from 'node:test';
import assert from 'node:assert/strict';
import { checkContent } from '../src/index.js';
import { buildLexicon } from '../src/lexicon.js';

test('基础字母与组合音标被格式节点隔开仍属同一字素簇', () => {
  // "*e*" + U+0301：可见字素簇 é 横跨强调边界
  const content = '*e*́';
  const lexicon = buildLexicon(['é']);
  const hits = checkContent(lexicon, content);
  assert.equal(hits.length, 1);
  // 覆盖 e 与组合音标的原文范围，排除中间的强调标记
  assert.deepEqual(hits[0].ranges, [{ start: 1, end: 2 }, { start: 3, end: 4 }]);
});

test('组合音标拆分后，词条同样以组合形式命中', () => {
  const content = 'café';
  const lexicon = buildLexicon(['café']);
  const hits = checkContent(lexicon, content);
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0].ranges, [{ start: 0, end: 4 }]);
});

test('全角字符“ＡbＣ”命中“abc”，区间覆盖完整原字符', () => {
  const content = 'ＡbＣ';
  const lexicon = buildLexicon(['abc']);
  const hits = checkContent(lexicon, content);
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0].ranges, [{ start: 0, end: 3 }]);
});

test('“ﬁ”命中“i”时覆盖整个原字符', () => {
  const content = 'ﬁ';
  const lexicon = buildLexicon(['i']);
  const hits = checkContent(lexicon, content);
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0].ranges, [{ start: 0, end: 1 }]);
});

test('“ﬁ”整体命中“fi”，且不会被格式标记切开', () => {
  const content = '*ﬁ*x';
  const lexicon = buildLexicon(['fix']);
  const hits = checkContent(lexicon, content);
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0].ranges, [{ start: 1, end: 2 }, { start: 3, end: 4 }]);
});

test('实体解码参与匹配，区间覆盖实体完整原文范围', () => {
  //            0123456 7
  //            a&#x62;c  -> 可见 "abc"
  const content = 'a&#x62;c';
  const lexicon = buildLexicon(['abc', 'b']);
  const hits = checkContent(lexicon, content);
  assert.equal(hits.length, 2);
  const abc = hits.find((h) => h.word === 'abc')!;
  const b = hits.find((h) => h.word === 'b')!;
  assert.deepEqual(abc.ranges, [{ start: 0, end: 8 }]);
  assert.deepEqual(b.ranges, [{ start: 1, end: 7 }]);
});

test('命名实体与转义字符的完整原文范围被覆盖', () => {
  const content = '&amp;\\*';
  const lexicon = buildLexicon(['&', '*', '&*']);
  const hits = checkContent(lexicon, content);
  assert.equal(hits.length, 3);
  const byWord = new Map(hits.map((h) => [h.word, h]));
  assert.deepEqual(byWord.get('&')!.ranges, [{ start: 0, end: 5 }]);
  assert.deepEqual(byWord.get('*')!.ranges, [{ start: 5, end: 7 }]);
  assert.deepEqual(byWord.get('&*')!.ranges, [{ start: 0, end: 7 }]);
});

test('不可见字符被忽略且不进入命中区间', () => {
  const content = 'a​b﻿c';
  const lexicon = buildLexicon(['abc']);
  const hits = checkContent(lexicon, content);
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0].ranges, [
    { start: 0, end: 1 },
    { start: 2, end: 3 },
    { start: 4, end: 5 },
  ]);
});

test('不可见字符穿插不影响跨格式命中', () => {
  const content = '*a​b*‍c';
  const lexicon = buildLexicon(['abc']);
  const hits = checkContent(lexicon, content);
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0].ranges, [
    { start: 1, end: 2 },
    { start: 3, end: 4 },
    { start: 6, end: 7 },
  ]);
});

test('词条中的不可见字符同样被忽略', () => {
  const content = 'abc';
  const lexicon = buildLexicon(['a​bc']);
  const hits = checkContent(lexicon, content);
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0].ranges, [{ start: 0, end: 3 }]);
});

test('命中区间不切断代理对', () => {
  const content = '𠀀abc';
  const lexicon = buildLexicon(['abc', '𠀀']);
  const hits = checkContent(lexicon, content);
  assert.equal(hits.length, 2);
  const abc = hits.find((h) => h.word === 'abc')!;
  const astral = hits.find((h) => h.word === '𠀀')!;
  assert.deepEqual(abc.ranges, [{ start: 2, end: 5 }]);
  assert.deepEqual(astral.ranges, [{ start: 0, end: 2 }]);
});

test('大小写不依赖区域设置', () => {
  const content = 'ABCİ';
  const lexicon = buildLexicon(['abci̇']);
  const hits = checkContent(lexicon, content);
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0].ranges, [{ start: 0, end: 4 }]);
});
