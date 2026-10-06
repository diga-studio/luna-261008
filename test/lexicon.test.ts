import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadLexicon, checkContent } from '../src/index.js';

// npm test runs from the package root.
const wordsPath = join(process.cwd(), 'test', 'fixtures', 'words.txt');

test('loadLexicon 从本地文件加载词库，去重并跳过空行', () => {
  const lexicon = loadLexicon(wordsPath);
  assert.deepEqual(lexicon.words, ['敏感词', 'abc', 'ＡＢＣ']);
});

test('加载的词库可直接用于检查', () => {
  const lexicon = loadLexicon(wordsPath);
  const hits = checkContent(lexicon, '这是敏感词，也是 ABC');
  assert.deepEqual(
    hits.map((h) => [h.word, h.ranges] as const),
    [
      ['敏感词', [{ start: 2, end: 5 }]],
      ['abc', [{ start: 9, end: 12 }]],
      ['ＡＢＣ', [{ start: 9, end: 12 }]],
    ],
  );
});
