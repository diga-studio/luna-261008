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

const T0 = 1_800_000_000_000;
const DAY = 86_400_000;

test("archive everything, reopen, keep appending: ids climb, ledger stays whole", () => {
  const dir = makeTempDir();
  const ledger = new OriginalLedger();

  const appendAll = (archive: AuditArchive, specs: Array<[number, unknown]>) => {
    const ids: number[] = [];
    for (const [t, body] of specs) {
      const id = archive.append(t, body);
      ledger.recordAppend(id, t, body);
      ids.push(id);
    }
    return ids;
  };

  // Phase 1: append and archive every online record.
  const archive1 = AuditArchive.open({ dir });
  const ids1 = appendAll(archive1, [
    [T0 + 3 * DAY, { phase: 1, n: 0 }],
    [T0 + 1 * DAY, { phase: 1, n: 1 }],
    [T0 + 2 * DAY, { phase: 1, n: 2 }],
  ]);
  assert.deepEqual(ids1, [1, 2, 3]);
  const r1 = archive1.archive(T0 + 10 * DAY);
  assert.equal(r1.archivedCount, 3);
  assert.equal(sqliteOnlineRows(dir).length, 0, "online table fully drained");
  archive1.close();

  // Phase 2: reopen against an empty online table; ids must not restart.
  const archive2 = AuditArchive.open({ dir });
  assertLedgerMatches(readAll(archive2), ledger);
  const ids2 = appendAll(archive2, [
    [T0 + 5 * DAY, { phase: 2, n: 0 }],
    [T0 + 4 * DAY, { phase: 2, n: 1 }],
  ]);
  assert.deepEqual(ids2, [4, 5], "ids strictly increase across the fully-archived boundary");
  const r2 = archive2.archive(T0 + 10 * DAY);
  assert.equal(r2.archivedCount, 2);
  assert.equal(sqliteOnlineRows(dir).length, 0);
  archive2.close();

  // Phase 3: reopen again, append more, archive partially, read everything back.
  const archive3 = AuditArchive.open({ dir });
  const ids3 = appendAll(archive3, [
    [T0 + 6 * DAY, { phase: 3, n: 0 }],
    [T0 + 30 * DAY, { phase: 3, n: 1 }],
  ]);
  assert.deepEqual(ids3, [6, 7]);
  const r3 = archive3.archive(T0 + 10 * DAY);
  assert.equal(r3.archivedCount, 1, "only the record inside the window moves");
  assert.deepEqual(
    sqliteOnlineRows(dir).map((r) => r.id),
    [7],
    "the record outside the window stays online",
  );

  // Old and new records page back together: no dupes, no omissions, id order.
  assertLedgerMatches(readAll(archive3, 2), ledger);
  assertLedgerMatches(readAll(archive3, 100), ledger);
  archive3.close();

  // One more restart to prove the mixed ledger survives on disk.
  const archive4 = AuditArchive.open({ dir });
  assertLedgerMatches(readAll(archive4, 3), ledger);
  archive4.close();

  // Sanity: three sealed segments, no leftovers.
  assert.deepEqual(segmentDirFiles(dir), ["000001.jsonl.gz", "000002.jsonl.gz", "000003.jsonl.gz"]);
});
