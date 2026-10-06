import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DestructiveScanner, scanSql, type ScanResult } from '../src/index.ts';

const COMPLEX_SQL = [
  `-- 注释里的 DROP TABLE fake; 与 TRUNCATE fake2`,
  `/* 块注释 /* 嵌套 */ 含分号; 与逗号, */`,
  `CREATE TABLE t1 (id int, note text DEFAULT 'DROP TABLE x;');`,
  `INSERT INTO t1 VALUES (1, 'truncate t2'), (2, $$DROP TABLE y$$), (3, $T$阿é$T$);`,
  `DROP TABLE IF EXISTS public."Order", "weird.name" CASCADE;`,
  `TRUNCATE TABLE ONLY t3, t4 *, ONLY s."t5é" RESTART IDENTITY CASCADE;`,
  `ALTER TABLE t5 ADD CONSTRAINT c1 CHECK (note <> 'drop column z'),`,
  `  DROP COLUMN IF EXISTS "old""col" CASCADE,`,
  `  ALTER COLUMN id SET DEFAULT nextval('s'),`,
  `  DROP c6;`,
  `DELETE FROM t7;`,
  `ALTER TABLE t8 DROP CONSTRAINT c2, ADD COLUMN x int;`,
  `TRUNCATE last_one`,
].join('\n');

function scanChunked(bytes: Uint8Array, cuts: number[]): ScanResult {
  const scanner = new DestructiveScanner();
  let prev = 0;
  for (const cut of cuts) {
    scanner.push(bytes.subarray(prev, cut));
    prev = cut;
  }
  scanner.push(bytes.subarray(prev));
  return scanner.finish();
}

function norm(r: ScanResult): unknown {
  return r.hits.map((h) => [h.operation, h.table, h.column, h.offset]).concat([['complete', undefined, undefined, r.complete ? 1 : 0]] as never);
}

test('整段基线命中清单', () => {
  const r = scanSql(COMPLEX_SQL);
  assert.equal(r.complete, true);
  const tables = r.hits.map((h) => `${h.operation}:${h.table}${h.column ? '.' + h.column : ''}`);
  assert.deepEqual(tables, [
    'DROP_TABLE:public.Order',
    'DROP_TABLE:weird.name',
    'TRUNCATE:t3',
    'TRUNCATE:t4',
    'TRUNCATE:s.t5é',
    'DROP_COLUMN:t5.old"col',
    'DROP_COLUMN:t5.c6',
    'TRUNCATE:last_one',
  ]);
  // 偏移均指向破坏性关键字本身
  const bytes = new TextEncoder().encode(COMPLEX_SQL);
  for (const h of r.hits) {
    const kw = new TextDecoder().decode(bytes.subarray(h.offset, h.offset + 5)).toUpperCase();
    assert.ok(kw === 'DROP ' || kw.startsWith('TRUNC'), `offset ${h.offset} -> ${kw}`);
  }
});

test('任意单点断开与整段结果一致', () => {
  const bytes = new TextEncoder().encode(COMPLEX_SQL);
  const whole = norm(scanSql(COMPLEX_SQL));
  for (let cut = 0; cut <= bytes.length; cut++) {
    assert.deepEqual(norm(scanChunked(bytes, [cut])), whole, `cut=${cut}`);
  }
});

test('逐字节分段与整段结果一致', () => {
  const bytes = new TextEncoder().encode(COMPLEX_SQL);
  const whole = norm(scanSql(COMPLEX_SQL));
  const cuts = Array.from({ length: bytes.length - 1 }, (_, i) => i + 1);
  assert.deepEqual(norm(scanChunked(bytes, cuts)), whole);
});

test('随机多点分段与整段结果一致（确定性种子）', () => {
  const bytes = new TextEncoder().encode(COMPLEX_SQL);
  const whole = norm(scanSql(COMPLEX_SQL));
  let seed = 42;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let trial = 0; trial < 50; trial++) {
    const cutCount = 1 + Math.floor(rand() * 8);
    const cuts = Array.from({ length: cutCount }, () => Math.floor(rand() * (bytes.length + 1))).sort((a, b) => a - b);
    assert.deepEqual(norm(scanChunked(bytes, cuts)), whole, `trial=${trial} cuts=${cuts}`);
  }
});

test('截断输入的分段一致性', () => {
  const sql = `DROP TABLE a; TRUNCATE t$$x; ALTER TABLE q DROP COLUMN w; /* 未闭合`;
  const bytes = new TextEncoder().encode(sql);
  const whole = norm(scanSql(sql));
  assert.equal(scanSql(sql).complete, false);
  for (let cut = 0; cut <= bytes.length; cut++) {
    assert.deepEqual(norm(scanChunked(bytes, [cut])), whole, `cut=${cut}`);
  }
});

test('事件之间相互独立', () => {
  const a = scanSql('DROP TABLE evt_a;');
  const b = scanSql('TRUNCATE evt_b;');
  assert.deepEqual(a.hits.map((h) => h.table), ['evt_a']);
  assert.deepEqual(b.hits.map((h) => h.table), ['evt_b']);
});
