import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Lexer, type Token } from '../src/lexer.ts';

function lexAll(input: string, chunkSize?: number): { tokens: Token[]; clean: boolean } {
  const tokens: Token[] = [];
  const lexer = new Lexer((t) => tokens.push({ ...t }));
  const bytes = new TextEncoder().encode(input);
  if (chunkSize === undefined) {
    lexer.push(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += chunkSize) {
      lexer.push(bytes.subarray(i, i + chunkSize));
    }
  }
  return { tokens, clean: lexer.finish() };
}

function summary(tokens: Token[]): string {
  return tokens.map((t) => (t.kind === 'ident' ? `I:${t.text}${t.quoted ? '!' : ''}` : t.kind === 'punct' ? `P:${t.text}` : 'O')).join(' ');
}

test('基本标识符与关键字小写化', () => {
  const { tokens, clean } = lexAll('DROP TABLE Foo;"Bar"."B""az"');
  assert.equal(clean, true);
  assert.equal(summary(tokens), 'I:drop I:table I:foo P:; I:Bar! P:. I:B"az!');
});

test('行注释与嵌套块注释被跳过', () => {
  const { tokens, clean } = lexAll('a -- x ;\n b /* c /* d */ e ; */ f');
  assert.equal(clean, true);
  assert.equal(summary(tokens), 'I:a I:b I:f');
});

test('普通字符串反斜杠不转义', () => {
  // 'a\' 结束后 b 是独立标识符
  const { tokens } = lexAll(`'a\\' b`);
  assert.equal(summary(tokens), 'I:b');
});

test('E 字符串反斜杠转义', () => {
  // E'a\\'' 中 \\' 是转义引号，字符串延续到最后的引号
  const { tokens, clean } = lexAll(`E'a\\'' x`);
  assert.equal(clean, true);
  assert.equal(summary(tokens), 'I:x');
});

test('字符串中成对单引号', () => {
  const { tokens, clean } = lexAll(`'a''b' c`);
  assert.equal(clean, true);
  assert.equal(summary(tokens), 'I:c');
});

test('美元引号与大小写敏感标签', () => {
  const { tokens, clean } = lexAll(`$Tag$a ; $Tag$ x $tag$ y`);
  // $tag$ 与 $Tag$ 大小写不同，不匹配；$tag$ 开启了新字符串直到 EOF，未闭合
  assert.equal(clean, false);
  assert.equal(summary(tokens), 'I:x');
  const r2 = lexAll(`$$ body $$ z`);
  assert.equal(summary(r2.tokens), 'I:z');
});

test('标识符内美元符号不开字符串', () => {
  const { tokens } = lexAll('abc$def ghi');
  assert.equal(summary(tokens), 'I:abc$def I:ghi');
});

test('参数占位符不是字符串', () => {
  const { tokens } = lexAll('a = $1 and b');
  assert.equal(summary(tokens), 'I:a O O I:and I:b');
});

test('未闭合构造报告不干净', () => {
  assert.equal(lexAll(`select 'abc`).clean, false);
  assert.equal(lexAll(`select "abc`).clean, false);
  assert.equal(lexAll(`select /* abc`).clean, false);
  assert.equal(lexAll(`select /* a /* b */`).clean, false);
  assert.equal(lexAll(`select $$abc`).clean, false);
  assert.equal(lexAll(`select E'abc`).clean, false);
  // 末尾引号即闭合
  assert.equal(lexAll(`select 'abc'`).clean, true);
  assert.equal(lexAll(`select "abc"`).clean, true);
  // 行注释到 EOF 合法
  assert.equal(lexAll(`select a -- tail`).clean, true);
});

test('偏移量按字节计算', () => {
  const { tokens } = lexAll('é DROP');
  const drop = tokens.find((t) => t.text === 'drop')!;
  assert.equal(drop.offset, 3); // é 占 2 字节 + 空格
});

test('任意分段与整段结果一致（含多字节字符内部）', () => {
  const sql = `DrOp /* c/*c*/c */ TÁBLE "é""x" , E'a\\'; $$ d ; $$ -- t`;
  const whole = lexAll(sql);
  const bytes = new TextEncoder().encode(sql);
  for (let cut = 0; cut <= bytes.length; cut++) {
    const tokens: Token[] = [];
    const lexer = new Lexer((t) => tokens.push({ ...t }));
    lexer.push(bytes.subarray(0, cut));
    lexer.push(bytes.subarray(cut));
    const clean = lexer.finish();
    assert.deepEqual(tokens.map((t) => [t.kind, t.text, t.quoted, t.offset]), whole.tokens.map((t) => [t.kind, t.text, t.quoted, t.offset]), `cut=${cut}`);
    assert.equal(clean, whole.clean, `cut=${cut}`);
  }
});
