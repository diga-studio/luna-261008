import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanSql, type Hit } from '../src/index.ts';

function ops(hits: Hit[]): string[] {
  return hits.map((h) => `${h.operation}:${h.table}${h.column !== undefined ? '.' + h.column : ''}@${h.offset}`);
}

test('DROP TABLE 基本形式', () => {
  const r = scanSql('DROP TABLE foo;');
  assert.equal(r.complete, true);
  assert.deepEqual(ops(r.hits), ['DROP_TABLE:foo@0']);
});

test('DROP TABLE IF EXISTS、多表、CASCADE/RESTRICT、限定名', () => {
  const r = scanSql('DROP TABLE IF EXISTS public."Order", "weird.name" CASCADE;');
  assert.deepEqual(ops(r.hits), [
    'DROP_TABLE:public.Order@0',
    'DROP_TABLE:weird.name@0',
  ]);
  assert.deepEqual(r.hits[0].tableParts, ['public', 'Order']);
  assert.deepEqual(r.hits[1].tableParts, ['weird.name']);
  const r2 = scanSql('drop table a restrict');
  assert.deepEqual(ops(r2.hits), ['DROP_TABLE:a@0']);
});

test('DROP TABLE 末尾无分号', () => {
  const r = scanSql('DROP TABLE foo');
  assert.equal(r.complete, true);
  assert.deepEqual(ops(r.hits), ['DROP_TABLE:foo@0']);
});

test('TRUNCATE 全选项', () => {
  const r = scanSql('TRUNCATE TABLE ONLY t3, t4 *, ONLY s.t5 RESTART IDENTITY CASCADE;');
  assert.deepEqual(ops(r.hits), [
    'TRUNCATE:t3@0',
    'TRUNCATE:t4@0',
    'TRUNCATE:s.t5@0',
  ]);
  const r2 = scanSql('truncate t1, t2 CONTINUE IDENTITY RESTRICT');
  assert.deepEqual(ops(r2.hits), ['TRUNCATE:t1@0', 'TRUNCATE:t2@0']);
});

test('ALTER TABLE 删列：多动作混合', () => {
  const sql = `ALTER TABLE t5 ADD CONSTRAINT c1 CHECK (note <> 'drop column z'), DROP COLUMN IF EXISTS "old""col" CASCADE, ALTER COLUMN id SET DEFAULT nextval('s'), DROP c6;`;
  const r = scanSql(sql);
  const dropOffset = sql.indexOf('DROP COLUMN IF EXISTS');
  const drop2Offset = sql.lastIndexOf('DROP c6');
  assert.deepEqual(ops(r.hits), [
    `DROP_COLUMN:t5.old"col@${dropOffset}`,
    `DROP_COLUMN:t5.c6@${drop2Offset}`,
  ]);
});

test('ALTER TABLE IF EXISTS ONLY 与星号', () => {
  const sql = 'ALTER TABLE IF EXISTS ONLY sch."Tab" * DROP COLUMN c1, DROP IF EXISTS c2 RESTRICT;';
  const r = scanSql(sql);
  assert.deepEqual(ops(r.hits), [
    `DROP_COLUMN:sch.Tab.c1@${sql.indexOf('DROP COLUMN')}`,
    `DROP_COLUMN:sch.Tab.c2@${sql.lastIndexOf('DROP IF EXISTS')}`,
  ]);
});

test('非威胁语句不产生命中', () => {
  const r = scanSql(`
    DELETE FROM t7;
    DROP INDEX idx;
    DROP VIEW v;
    ALTER TABLE t8 DROP CONSTRAINT c2, ADD COLUMN x int;
    ALTER INDEX foo RENAME TO bar;
    SELECT 1;
  `);
  assert.equal(r.complete, true);
  assert.deepEqual(r.hits, []);
});

test('注释、字符串、标识符中的破坏性文本不命中', () => {
  const r = scanSql(`
    -- DROP TABLE a;
    /* TRUNCATE b; /* DROP TABLE c; */ */
    SELECT 'DROP TABLE d;', E'TRUNCATE\\n e', $$DROP TABLE f$$, $tag$ALTER TABLE g DROP COLUMN h$tag$;
    CREATE TABLE "drop table" ("truncate" int);
    SELECT drop_table_count FROM t WHERE name = 'alter table t drop column x';
  `);
  assert.equal(r.complete, true);
  assert.deepEqual(r.hits, []);
});

test('其他动作表达式中的类删列文本不命中', () => {
  const r = scanSql(`
    ALTER TABLE t ADD CONSTRAINT c CHECK (txt ~ 'drop column [a-z]+' AND len > 0),
                  ALTER COLUMN x SET DEFAULT 'drop column y',
                  ADD COLUMN z text DEFAULT $$drop column w$$;
  `);
  assert.equal(r.complete, true);
  assert.deepEqual(r.hits, []);
});

test('引号与括号内的分号不结束语句', () => {
  const sql = `INSERT INTO t VALUES ('a;b'), ($$c;d$$);
SELECT 1 /* ; */;
SELECT f(1; 2);
DROP TABLE real;`;
  const r = scanSql(sql);
  // 括号未闭合前分号不生效；括号闭合后的 DROP TABLE real 是顶层语句
  assert.deepEqual(ops(r.hits), [`DROP_TABLE:real@${sql.indexOf('DROP TABLE real')}`]);
});

test('命中偏移定位到破坏性关键字（多语句）', () => {
  const sql = 'SELECT 1; DROP TABLE a; TRUNCATE b; ALTER TABLE c DROP d;';
  const r = scanSql(sql);
  assert.deepEqual(ops(r.hits), [
    `DROP_TABLE:a@${sql.indexOf('DROP')}`,
    `TRUNCATE:b@${sql.indexOf('TRUNCATE')}`,
    `DROP_COLUMN:c.d@${sql.lastIndexOf('DROP')}`,
  ]);
});

test('未引用标识符仅 ASCII 大写转小写', () => {
  const r = scanSql('DROP TABLE ÄBC, ABC;');
  // Ä 是多字节，保持不变；ASCII 的 BC -> bc
  assert.deepEqual(ops(r.hits), ['DROP_TABLE:Äbc@0', 'DROP_TABLE:abc@0']);
});

test('末尾截断：未闭合构造报告不完整，已完成语句命中保留', () => {
  const r = scanSql(`DROP TABLE a; SELECT 'unclosed`);
  assert.equal(r.complete, false);
  assert.deepEqual(ops(r.hits), ['DROP_TABLE:a@0']);

  const r2 = scanSql(`DROP TABLE "unclosed`);
  assert.equal(r2.complete, false);
  assert.deepEqual(r2.hits, []);

  const r3 = scanSql(`DROP TABLE b /* tail`);
  assert.equal(r3.complete, false);
  assert.deepEqual(r3.hits, []);

  const r4 = scanSql(`TRUNCATE c; ALTER TABLE d DROP COLUMN e; /* open`);
  assert.equal(r4.complete, false);
  assert.deepEqual(ops(r4.hits), ['TRUNCATE:c@0', 'DROP_COLUMN:d.e@26']);
});
