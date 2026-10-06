import type { Hit } from "../src/index.js";

/**
 * Complex workload mixing real destructive statements with look-alike text
 * inside strings, comments, dollar quotes and quoted identifiers.
 */
export const COMPLEX_SQL: string =
  `-- 假命令: DROP TABLE comment_fake;\n` +
  `CREATE TABLE t (id INT, note TEXT DEFAULT 'truncate me; drop table str_fake');\n` +
  `/* 块注释 /* 嵌套 DROP TABLE nested_fake */ 仍在注释中 */\n` +
  `DROP TABLE IF EXISTS public.users, "Order""s", 日志表 CASCADE;\n` +
  `TRUNCATE TABLE ONLY metrics *, "My Schema"."Events", 仅表 RESTART IDENTITY CASCADE;\n` +
  `ALTER TABLE config DROP COLUMN old_col, ` +
  `ADD CONSTRAINT ck CHECK (note <> 'drop column x; truncate y'), ` +
  `DROP IF EXISTS "Quoted Col" CASCADE, ` +
  `ALTER COLUMN note SET DEFAULT E'drop table e\\'fake', ` +
  `DROP CONSTRAINT fk_other, DROP last_col;\n` +
  `SELECT $$ DROP TABLE dollar_fake; TRUNCATE dollar_fake $$;\n` +
  `SELECT $Body$ALTER TABLE body_fake DROP COLUMN x$Body$;\n` +
  `DELETE FROM users WHERE id = 1;\n` +
  `DROP VIEW some_view;\n` +
  `ALTER TABLE "weird.name" DROP "select";\n`;

/** Byte offset of `search` in `sql`, searched from byte `from`. */
export function byteOffset(sql: string, search: string, from = 0): number {
  const idx = Buffer.from(sql, "utf8").indexOf(search, from);
  if (idx < 0) throw new Error(`not found: ${search}`);
  return idx;
}

/** Hand-listed expected hits for COMPLEX_SQL. */
export function expectedComplexHits(): Hit[] {
  const sql = COMPLEX_SQL;
  const pDrop = byteOffset(sql, "DROP TABLE IF EXISTS");
  const pTrunc = byteOffset(sql, "TRUNCATE TABLE ONLY");
  const pAlter = byteOffset(sql, "ALTER TABLE config");
  const pWeird = byteOffset(sql, `ALTER TABLE "weird.name"`);
  return [
    { operation: "dropTable", table: ["public", "users"], offset: pDrop },
    { operation: "dropTable", table: ['Order"s'], offset: pDrop },
    { operation: "dropTable", table: ["日志表"], offset: pDrop },
    { operation: "truncate", table: ["metrics"], offset: pTrunc },
    { operation: "truncate", table: ["My Schema", "Events"], offset: pTrunc },
    { operation: "truncate", table: ["仅表"], offset: pTrunc },
    { operation: "dropColumn", table: ["config"], column: "old_col", offset: byteOffset(sql, "DROP COLUMN old_col", pAlter) },
    { operation: "dropColumn", table: ["config"], column: "Quoted Col", offset: byteOffset(sql, "DROP IF EXISTS", pAlter) },
    { operation: "dropColumn", table: ["config"], column: "last_col", offset: byteOffset(sql, "DROP last_col", pAlter) },
    { operation: "dropColumn", table: ["weird.name"], column: "select", offset: byteOffset(sql, 'DROP "select"', pWeird) },
  ];
}
