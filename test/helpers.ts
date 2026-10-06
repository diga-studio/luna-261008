import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { AuditLedger } from "../src/index.js";
import type { AuditRecord } from "../src/index.js";

export function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Page through the whole ledger and return all records in id order. */
export function readAll(ledger: AuditLedger, pageSize = 7): AuditRecord[] {
  const out: AuditRecord[] = [];
  let offset = 0;
  for (;;) {
    const page = ledger.readPage(offset, pageSize);
    out.push(...page.records);
    if (page.nextOffset === null) {
      break;
    }
    offset = page.nextOffset;
  }
  return out;
}

/**
 * Assert the ledger content equals the independently kept original ledger
 * (id -> {eventTimeMs, body}) exactly: same ids ascending, no duplicates,
 * no omissions, identical times and bodies.
 */
export function assertMatchesOriginal(
  records: AuditRecord[],
  original: Map<number, { eventTimeMs: number; body: string }>,
): void {
  assert.equal(records.length, original.size, "record count mismatch");
  const seen = new Set<number>();
  let prev = 0;
  for (const record of records) {
    assert.ok(record.id > prev, `ids not strictly ascending at ${record.id}`);
    prev = record.id;
    assert.ok(!seen.has(record.id), `duplicate id ${record.id}`);
    seen.add(record.id);
    const want = original.get(record.id);
    assert.ok(want, `unexpected record id ${record.id}`);
    assert.equal(record.eventTimeMs, want.eventTimeMs, `time of id ${record.id}`);
    assert.equal(record.body, want.body, `body of id ${record.id}`);
  }
}

/** Assert no leftover temp files and only committed archives on disk. */
export function assertArchiveDirClean(dir: string, committedCount: number): void {
  const entries = readdirSync(join(dir, "archives"));
  const tmp = entries.filter((e) => e.endsWith(".tmp"));
  assert.deepEqual(tmp, [], "leftover temp files");
  const finals = entries.filter((e) => !e.endsWith(".tmp"));
  assert.equal(finals.length, committedCount, "archive file count mismatch");
  for (const [i, name] of finals.sort().entries()) {
    const want = `archive-${String(i + 1).padStart(6, "0")}.jsonl.gz`;
    assert.equal(name, want, `unexpected archive file ${name}`);
  }
}
