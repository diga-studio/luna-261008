import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanSql } from '../src/index.ts';

const CASES: Array<[string, string[]]> = [
  ['DROP TABLE a /* ; , */ , b;', ['DROP_TABLE:a', 'DROP_TABLE:b']],
  ['TRUNCATE t -- comment with ;\n, t2;', ['TRUNCATE:t', 'TRUNCATE:t2']],
  ['DROP TABLE IF EXISTS "a"."b"."c";', ['DROP_TABLE:a.b.c']],
  [';;;', []],
  ['ALTER TABLE t RENAME TO t2;', []],
  ['DROP TABLE e;', ['DROP_TABLE:e']],
  ['ALTER TABLE t ADD COLUMN c int, DROP COLUMN d, ADD COLUMN e int, DROP f;', ['DROP_COLUMN:t.d', 'DROP_COLUMN:t.f']],
  ['drop /*c*/ table /*c*/ x;', ['DROP_TABLE:x']],
  ['TRUNCATE /*c*/ only /*c*/ t /*c*/ * /*c*/ cascade;', ['TRUNCATE:t']],
  ['ALTER TABLE t DROP CONSTRAINT c, DROP COLUMN d;', ['DROP_COLUMN:t.d']],
  ['ALTER TABLE t ALTER COLUMN c SET DEFAULT (SELECT drop_x FROM y), DROP COLUMN z;', ['DROP_COLUMN:t.z']],
  ['DROP TABLE "MiXeD"."t""q";', ['DROP_TABLE:MiXeD.t"q']],
];

test('边角用例回归', () => {
  for (const [sql, expected] of CASES) {
    const r = scanSql(sql);
    const got = r.hits.map((h) => `${h.operation}:${h.table}${h.column !== undefined ? '.' + h.column : ''}`);
    assert.deepEqual(got, expected, sql);
    assert.equal(r.complete, true, sql);
  }
});
