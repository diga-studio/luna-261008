import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze } from "../src/index.js";
import { COMPLEX_SQL, expectedComplexHits } from "./fixture.js";

/** Byte offset of `search` in `sql`, searched from byte `from`. */
function off(sql: string, search: string, from = 0): number {
  const idx = Buffer.from(sql, "utf8").indexOf(search, from);
  assert.notEqual(idx, -1, `not found: ${search}`);
  return idx;
}

test("DROP TABLE variants", () => {
  const r = analyze(
    `DROP TABLE users;` +
      `drop table if exists public."Users" cascade;` +
      `DROP TABLE IF EXISTS "a.b"."C""d" RESTRICT;`,
  );
  assert.equal(r.status, "ok");
  assert.deepEqual(r.hits, [
    { operation: "dropTable", table: ["users"], offset: 0 },
    { operation: "dropTable", table: ["public", "Users"], offset: 17 },
    { operation: "dropTable", table: ["a.b", 'C"d'], offset: 61 },
  ]);
});

test("TRUNCATE variants", () => {
  const sql =
    `TRUNCATE TABLE ONLY metrics *, "My Schema"."Events", 仅表 RESTART IDENTITY CASCADE;` +
    `TRUNCATE a, ONLY b, c * CONTINUE IDENTITY;` +
    `truncate only t2 restrict`;
  const r = analyze(sql);
  assert.equal(r.status, "ok");
  const t2 = off(sql, "truncate only t2");
  assert.deepEqual(r.hits, [
    { operation: "truncate", table: ["metrics"], offset: 0 },
    { operation: "truncate", table: ["My Schema", "Events"], offset: 0 },
    { operation: "truncate", table: ["仅表"], offset: 0 },
    { operation: "truncate", table: ["a"], offset: off(sql, "TRUNCATE a") },
    { operation: "truncate", table: ["b"], offset: off(sql, "TRUNCATE a") },
    { operation: "truncate", table: ["c"], offset: off(sql, "TRUNCATE a") },
    { operation: "truncate", table: ["t2"], offset: t2 },
  ]);
});

test("ALTER TABLE drop column variants", () => {
  const sql =
    `ALTER TABLE config DROP COLUMN old_col, DROP IF EXISTS "Quoted Col" CASCADE, DROP last_col;` +
    `ALTER TABLE IF EXISTS ONLY "T" * DROP c1;` +
    `ALTER TABLE t DROP CONSTRAINT fk;` +
    `ALTER TABLE t DROP "constraint";`;
  const r = analyze(sql);
  assert.equal(r.status, "ok");
  const p1 = off(sql, "ALTER TABLE config");
  const p2 = off(sql, "ALTER TABLE IF EXISTS");
  const p4 = off(sql, `ALTER TABLE t DROP "constraint"`);
  assert.deepEqual(r.hits, [
    { operation: "dropColumn", table: ["config"], column: "old_col", offset: off(sql, "DROP COLUMN old_col", p1) },
    { operation: "dropColumn", table: ["config"], column: "Quoted Col", offset: off(sql, "DROP IF EXISTS", p1) },
    { operation: "dropColumn", table: ["config"], column: "last_col", offset: off(sql, "DROP last_col", p1) },
    { operation: "dropColumn", table: ["T"], column: "c1", offset: off(sql, "DROP c1", p2) },
    { operation: "dropColumn", table: ["t"], column: "constraint", offset: off(sql, 'DROP "constraint"', p4) },
  ]);
});

test("false positives inside strings, comments, dollar quotes and identifiers", () => {
  const sql =
    `-- DROP TABLE line_fake;\n` +
    `/* block /* nested DROP TABLE nested_fake; */ still comment TRUNCATE c */\n` +
    `SELECT 'DROP TABLE str_fake;', E'truncate e\\'fake', $$DROP TABLE dollar_fake$$, $Tag$ALTER TABLE x$Tag$;\n` +
    `SELECT a$b, "drop table" FROM t;\n` +
    `DROP TABLE real1;`;
  const r = analyze(sql);
  assert.equal(r.status, "ok");
  assert.deepEqual(r.hits, [
    { operation: "dropTable", table: ["real1"], offset: off(sql, "DROP TABLE real1") },
  ]);
});

test("other statements and non-threat commands produce no hits", () => {
  const sql =
    `DELETE FROM users WHERE id = 1;` +
    `DROP VIEW v; DROP INDEX i; DROP CONSTRAINT x;` +
    `UPDATE t SET c = 'drop table u';` +
    `CREATE TABLE t (a TEXT DEFAULT 'x;y', b INT CHECK (b IN (1, 2, 3)));`;
  const r = analyze(sql);
  assert.equal(r.status, "ok");
  assert.deepEqual(r.hits, []);
});

test("semicolons inside strings and parens do not end statements", () => {
  const sql = `INSERT INTO t VALUES ('a;b'), (row(1, 2)); DROP TABLE after_ins;`;
  const r = analyze(sql);
  assert.equal(r.status, "ok");
  assert.deepEqual(r.hits, [
    { operation: "dropTable", table: ["after_ins"], offset: off(sql, "DROP TABLE after_ins") },
  ]);
});

test("commas inside parens, brackets and strings do not split ALTER actions", () => {
  const sql =
    `ALTER TABLE t ADD CONSTRAINT c CHECK (a IN (1, 2, 3) AND b = 'x,y'), ` +
    `ADD d INT[] DEFAULT ARRAY[1, 2], DROP COLUMN victim;`;
  const r = analyze(sql);
  assert.equal(r.status, "ok");
  assert.deepEqual(r.hits, [
    { operation: "dropColumn", table: ["t"], column: "victim", offset: off(sql, "DROP COLUMN victim") },
  ]);
});

test("identifier normalization rules", () => {
  const r = analyze(
    `DROP TABLE USERS, "USERS", ÄBC, "ÄBC", "a""b", 混合Case;`,
  );
  assert.equal(r.status, "ok");
  assert.deepEqual(r.hits, [
    { operation: "dropTable", table: ["users"], offset: 0 },
    { operation: "dropTable", table: ["USERS"], offset: 0 },
    { operation: "dropTable", table: ["Äbc"], offset: 0 },
    { operation: "dropTable", table: ["ÄBC"], offset: 0 },
    { operation: "dropTable", table: ['a"b'], offset: 0 },
    { operation: "dropTable", table: ["混合case"], offset: 0 },
  ]);
});

test("dollar tag must match exactly, identifiers may contain dollars", () => {
  const ok = analyze(`SELECT $Tag$x$Tag$; DROP TABLE t;`);
  assert.equal(ok.status, "ok");
  assert.deepEqual(ok.hits, [
    { operation: "dropTable", table: ["t"], offset: 20 },
  ]);

  const unterminated = analyze(`SELECT $Tag$x$tag$; DROP TABLE t;`);
  assert.equal(unterminated.status, "incomplete");
  assert.deepEqual(unterminated.hits, []);

  const ident = analyze(`DROP TABLE a$b, c$$d;`);
  assert.equal(ident.status, "ok");
  assert.deepEqual(ident.hits, [
    { operation: "dropTable", table: ["a$b"], offset: 0 },
    { operation: "dropTable", table: ["c$$d"], offset: 0 },
  ]);
});

test("empty and comment-only input", () => {
  assert.deepEqual(analyze(""), { status: "ok", hits: [] });
  assert.deepEqual(analyze("  ; ;\n-- x\n/* y */"), { status: "ok", hits: [] });
  assert.deepEqual(analyze("DROP TABLE t -- tail comment"), {
    status: "ok",
    hits: [{ operation: "dropTable", table: ["t"], offset: 0 }],
  });
});

test("unterminated structures report incomplete and keep only finished statements", () => {
  const a = analyze(`DROP TABLE done1; TRUNCATE done2; SELECT 'unterminated`);
  assert.equal(a.status, "incomplete");
  assert.deepEqual(a.hits, [
    { operation: "dropTable", table: ["done1"], offset: 0 },
    { operation: "truncate", table: ["done2"], offset: 18 },
  ]);

  const b = analyze(`DROP TABLE c, d /* never closed`);
  assert.equal(b.status, "incomplete");
  assert.deepEqual(b.hits, []);

  const c = analyze(`ALTER TABLE t DROP COLUMN victim, ADD x TEXT DEFAULT $$open`);
  assert.equal(c.status, "incomplete");
  assert.deepEqual(c.hits, []);

  const d = analyze(`DROP TABLE "abc`);
  assert.equal(d.status, "incomplete");
  assert.deepEqual(d.hits, []);

  const e = analyze(`TRUNCATE q; SELECT E'back\\`);
  assert.equal(e.status, "incomplete");
  assert.deepEqual(e.hits, [
    { operation: "truncate", table: ["q"], offset: 0 },
  ]);
});

test("complex mixed workload matches the hand-listed expectation", () => {
  const r = analyze(COMPLEX_SQL);
  assert.equal(r.status, "ok");
  assert.deepEqual(r.hits, expectedComplexHits());
});
