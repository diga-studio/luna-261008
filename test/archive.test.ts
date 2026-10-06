import test from "node:test";
import assert from "node:assert/strict";
import { AuditArchive } from "../src/index.ts";
import {
  OriginalLedger,
  assertLedgerMatches,
  makeTempDir,
  readAll,
  segmentDirFiles,
  sqliteOnlineRows,
} from "./helpers.ts";

const T0 = 1_700_000_000_000; // arbitrary base instant (ms UTC)
const HOUR = 3_600_000;

test("out-of-order times, late arrivals, exact-cutoff records, repeated archive passes", () => {
  const dir = makeTempDir();
  const ledger = new OriginalLedger();
  const archive = AuditArchive.open({ dir });

  const append = (eventTimeMs: number, body: unknown) => {
    const id = archive.append(eventTimeMs, body);
    ledger.recordAppend(id, eventTimeMs, body);
    return id;
  };

  // Batch 1: deliberately shuffled event times; ids do not track time.
  const times = [T0 + 5 * HOUR, T0, T0 + 9 * HOUR, T0 + 2 * HOUR, T0 + 7 * HOUR, T0 + 1 * HOUR];
  for (const t of times) {
    append(t, { kind: "batch1", t });
  }

  const cutoff1 = T0 + 4 * HOUR;
  // Records exactly at the cutoff must stay online.
  append(cutoff1, { kind: "exact-cutoff" });

  const r1 = archive.archive(cutoff1);
  assert.equal(r1.archivedCount, 3); // T0, T0+1h, T0+2h
  assert.deepEqual(
    sqliteOnlineRows(dir).map((r) => r.eventTimeMs).sort((a, b) => a - b),
    [T0 + 5 * HOUR, T0 + 7 * HOUR, T0 + 9 * HOUR, cutoff1].sort((a, b) => a - b),
    "only strictly-earlier bodies left SQLite",
  );
  assertLedgerMatches(readAll(archive), ledger);

  // Late arrivals with old timestamps land after the first archive pass.
  append(T0 + 1 * HOUR, { kind: "late", t: T0 + 1 * HOUR });
  append(T0 + 3 * HOUR, { kind: "late", t: T0 + 3 * HOUR });
  append(T0 + 30 * HOUR, { kind: "future" });

  // Re-running the same cutoff picks up the late records (next pass duty).
  const r2 = archive.archive(cutoff1);
  assert.equal(r2.archivedCount, 2);
  assertLedgerMatches(readAll(archive), ledger);

  // A pass with nothing to archive is a no-op and creates no files.
  const filesBefore = segmentDirFiles(dir);
  const r3 = archive.archive(T0 - 1);
  assert.equal(r3.archivedCount, 0);
  assert.equal(r3.segmentFile, null);
  assert.deepEqual(segmentDirFiles(dir), filesBefore);

  // Second window: archive everything up to T0+10h. The exact-cutoff record
  // of cutoff1 is strictly before cutoff2, so it now moves out.
  const cutoff2 = T0 + 10 * HOUR;
  const r4 = archive.archive(cutoff2);
  assert.equal(r4.archivedCount, 4); // 5h, 7h, 9h, exact-cutoff
  assert.deepEqual(
    sqliteOnlineRows(dir).map((r) => r.eventTimeMs),
    [T0 + 30 * HOUR],
    "only the future record remains online",
  );

  // Full paged read still matches the original ledger exactly.
  assertLedgerMatches(readAll(archive, 3), ledger);

  // Reopen: same view, ids keep climbing.
  archive.close();
  const reopened = AuditArchive.open({ dir });
  assertLedgerMatches(readAll(reopened, 4), ledger);
  const nextId = reopened.append(T0 + 40 * HOUR, { kind: "after-reopen" });
  ledger.recordAppend(nextId, T0 + 40 * HOUR, { kind: "after-reopen" });
  assert.equal(nextId, ledger.records.length, "ids never reuse archived slots");
  assertLedgerMatches(readAll(reopened, 5), ledger);
  reopened.close();
});
