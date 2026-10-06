import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AuditArchive } from "../src/index.ts";
import type { AuditRecord } from "../src/index.ts";
import { readSegment } from "../src/segment.ts";
import { CHILD_HOUR, CHILD_T0, childBody, childEventTime } from "./crash-fixture.ts";
import {
  OriginalLedger,
  assertLedgerMatches,
  makeTempDir,
  readAll,
  segmentDirFiles,
  sqliteOnlineRows,
} from "./helpers.ts";

const CHILD = fileURLToPath(new URL("./crash-child.ts", import.meta.url));

function runChild(dir: string, env: Record<string, string>): { status: number | null; stdout: string } {
  const res = spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", CHILD],
    { env: { ...process.env, CRASH_DIR: dir, ...env }, encoding: "utf8" },
  );
  if (res.error) throw res.error;
  return { status: res.status, stdout: res.stdout.trim() };
}

/** Every id 1..N appears exactly once across segment files and SQLite. */
function assertNoLossNoDupes(dir: string, total: number): void {
  const seen: number[] = [];
  for (const name of segmentDirFiles(dir)) {
    assert.ok(name.endsWith(".jsonl.gz"), `no leftover partial file: ${name}`);
    for (const rec of readSegment(join(dir, "segments", name))) {
      seen.push(rec.id);
    }
  }
  for (const row of sqliteOnlineRows(dir)) {
    seen.push(row.id);
  }
  seen.sort((a, b) => a - b);
  assert.deepEqual(seen, Array.from({ length: total }, (_, i) => i + 1), "ids 1..N exactly once");
}

test("real process exit mid-archive, repeated restarts and retries", () => {
  const dir = makeTempDir();
  const ledger = new OriginalLedger();
  const COUNT = 50;

  // Populate through a child process; ids 1..COUNT in append order.
  let r = runChild(dir, { CRASH_ACTION: "append", CRASH_COUNT: String(COUNT) });
  assert.equal(r.status, 0);
  for (let i = 0; i < COUNT; i++) {
    ledger.recordAppend(i + 1, childEventTime(i), childBody(i));
  }

  const cutoff1 = CHILD_T0 + 10 * CHILD_HOUR;
  const expectedArchived1 = Array.from({ length: COUNT }, (_, i) => childEventTime(i)).filter(
    (t) => t < cutoff1,
  ).length;
  assert.ok(expectedArchived1 > 0 && expectedArchived1 < COUNT);

  // Crash after the segment is sealed on disk but before the SQLite commit.
  r = runChild(dir, { CRASH_ACTION: "archive", CRASH_CUTOFF: String(cutoff1), CRASH_HOOK: "afterSegmentSealed" });
  assert.equal(r.status, 1, "child died mid-archive");

  // Restart: recovery must face a complete ledger and clean up the orphan.
  {
    const reopened = AuditArchive.open({ dir });
    assertLedgerMatches(readAll(reopened, 6), ledger);
    assert.equal(segmentDirFiles(dir).length, 0, "orphan sealed file removed by recovery");
    // Retry the same cutoff: must finish the migration.
    const result = reopened.archive(cutoff1);
    assert.equal(result.archivedCount, expectedArchived1);
    assertLedgerMatches(readAll(reopened, 6), ledger);
    reopened.close();
  }
  assertNoLossNoDupes(dir, COUNT);

  // Append more online, then crash after the commit but before returning.
  const extra = 10;
  {
    const archive = AuditArchive.open({ dir });
    for (let i = 0; i < extra; i++) {
      const id = archive.append(childEventTime(COUNT + i), childBody(COUNT + i));
      ledger.recordAppend(id, childEventTime(COUNT + i), childBody(COUNT + i));
    }
    archive.close();
  }
  const cutoff2 = CHILD_T0 + 20 * CHILD_HOUR;
  r = runChild(dir, { CRASH_ACTION: "archive", CRASH_CUTOFF: String(cutoff2), CRASH_HOOK: "afterCommit" });
  assert.equal(r.status, 1, "child died after commit, before returning");

  // Restart: the committed archive is visible; retrying the same cutoff is a no-op.
  {
    const reopened = AuditArchive.open({ dir });
    assertLedgerMatches(readAll(reopened, 9), ledger);
    const retry = reopened.archive(cutoff2);
    assert.equal(retry.archivedCount, 0, "already-committed records are not re-archived");
    assert.equal(retry.segmentFile, null);
    assertLedgerMatches(readAll(reopened, 9), ledger);
    reopened.close();
  }
  assertNoLossNoDupes(dir, COUNT + extra);

  // A stray partial write (*.tmp) plus a forged orphan segment are swept on open.
  writeFileSync(join(dir, "segments", "999999.jsonl.gz.tmp"), "partial garbage");
  writeFileSync(join(dir, "segments", "999998.jsonl.gz"), "not a real segment");
  {
    const reopened = AuditArchive.open({ dir });
    assertLedgerMatches(readAll(reopened, 11), ledger);
    assert.ok(segmentDirFiles(dir).every((n) => !n.startsWith("99999")), "leftovers swept");
    reopened.close();
  }
  assertNoLossNoDupes(dir, COUNT + extra);

  // Repeated restart cycles: crash at seal, recover, verify, retry; then keep
  // restarting and retrying the same cutoff — every retry is a clean no-op.
  const cutoff3 = CHILD_T0 + 23 * CHILD_HOUR; // covers everything
  for (let round = 0; round < 3; round++) {
    r = runChild(dir, { CRASH_ACTION: "archive", CRASH_CUTOFF: String(cutoff3), CRASH_HOOK: "afterSegmentSealed" });
    if (round === 0) {
      assert.equal(r.status, 1, "round 0: child died mid-archive with real disk writes");
    } else {
      assert.equal(r.status, 0, `round ${round}: nothing left, hook never fires`);
      assert.deepEqual(JSON.parse(r.stdout), { archivedCount: 0, segmentFile: null });
    }
    const reopened = AuditArchive.open({ dir });
    assertLedgerMatches(readAll(reopened, 13), ledger);
    const result = reopened.archive(cutoff3);
    if (round === 0) {
      assert.ok(result.archivedCount > 0, "first successful retry migrates the rest");
    } else {
      assert.equal(result.archivedCount, 0, "later rounds have nothing left to migrate");
    }
    assertLedgerMatches(readAll(reopened, 13), ledger);
    reopened.close();
    assertNoLossNoDupes(dir, COUNT + extra);
  }

  // Final state: everything archived, SQLite holds no bodies.
  assert.equal(sqliteOnlineRows(dir).length, 0);
  const finalRead = (() => {
    const a = AuditArchive.open({ dir });
    const all = readAll(a, 5);
    a.close();
    return all;
  })();
  assertLedgerMatches(finalRead, ledger);
  const all: AuditRecord[] = finalRead;
  assert.equal(all.length, COUNT + extra);
});
