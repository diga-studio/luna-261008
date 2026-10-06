import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { AuditArchive } from "../src/index.ts";
import type { AuditRecord } from "../src/index.ts";

/** Pristine copy of everything ever appended, kept independently of the library. */
export class OriginalLedger {
  readonly records: AuditRecord[] = [];

  recordAppend(id: number, eventTimeMs: number, body: unknown): void {
    this.records.push({ id, eventTimeMs, body: structuredClone(body) });
  }

  sorted(): AuditRecord[] {
    return [...this.records].sort((a, b) => a.id - b.id);
  }
}

export function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "audit-archive-test-"));
}

/** Drain the whole ledger through paginated reads. */
export function readAll(archive: AuditArchive, pageSize = 7): AuditRecord[] {
  const out: AuditRecord[] = [];
  let cursor = 0;
  for (;;) {
    const page = archive.readPage(cursor, pageSize);
    out.push(...page.records);
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return out;
}

/** The paged ledger must equal the original ledger exactly: ids ascending, no gaps, no dupes, bodies intact. */
export function assertLedgerMatches(actual: AuditRecord[], ledger: OriginalLedger): void {
  const expected = ledger.sorted();
  assert.equal(actual.length, expected.length, "record count");
  for (let i = 0; i < expected.length; i++) {
    assert.deepEqual(actual[i], expected[i], `record at position ${i}`);
    if (i > 0) {
      assert.ok(actual[i]!.id > actual[i - 1]!.id, "ids strictly ascending");
    }
  }
  assert.equal(new Set(actual.map((r) => r.id)).size, actual.length, "no duplicate ids");
}

/** Rows still present in the SQLite online table, straight from the file. */
export function sqliteOnlineRows(dir: string): Array<{ id: number; eventTimeMs: number; bodyJson: string }> {
  const db = new DatabaseSync(join(dir, "ledger.sqlite"), { readOnly: true });
  try {
    const rows = db
      .prepare("SELECT id, event_time_ms AS eventTimeMs, body AS bodyJson FROM online_records ORDER BY id")
      .all() as Array<{ id: number | bigint; eventTimeMs: number | bigint; bodyJson: string }>;
    return rows.map((r) => ({ id: Number(r.id), eventTimeMs: Number(r.eventTimeMs), bodyJson: r.bodyJson }));
  } finally {
    db.close();
  }
}

/** File names inside the segments directory. */
export function segmentDirFiles(dir: string): string[] {
  return readdirSync(join(dir, "segments")).sort();
}
