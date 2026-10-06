import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AuditLedger } from "../src/index.js";
import type { CrashPoint } from "../src/index.js";
import {
  CHILD_CUTOFF,
  CHILD_RECORD_COUNT,
  childBody,
  childTime,
} from "./crashPattern.js";
import {
  assertArchiveDirClean,
  assertMatchesOriginal,
  makeTempDir,
  readAll,
} from "./helpers.js";

const CHILD_PATH = fileURLToPath(new URL("./crashChild.js", import.meta.url));

function originalLedger(): Map<number, { eventTimeMs: number; body: string }> {
  const map = new Map<number, { eventTimeMs: number; body: string }>();
  for (let i = 0; i < CHILD_RECORD_COUNT; i++) {
    map.set(i + 1, { eventTimeMs: childTime(i), body: childBody(i) });
  }
  return map;
}

function runChild(env: Record<string, string>): void {
  const result = spawnSync(process.execPath, [CHILD_PATH], {
    env: { ...process.env, ...env },
    stdio: "pipe",
  });
  assert.equal(
    result.status,
    null,
    `child should die by signal, got status ${result.status}: ${result.stderr}`,
  );
  assert.equal(result.signal, "SIGKILL");
}

const CRASH_POINTS: CrashPoint[] = [
  "afterTempFileWritten",
  "afterTempFileSynced",
  "afterRename",
  "afterDirSync",
  "beforeManifestCommit",
  "afterManifestCommit",
];

test("archive killed mid-flight at every point: recover, retry, complete", () => {
  for (const point of CRASH_POINTS) {
    const dir = makeTempDir("ledger-crash-");
    const original = originalLedger();

    // Child appends all records, then dies mid-archive at `point`.
    runChild({
      LEDGER_DIR: dir,
      APPEND_COUNT: String(CHILD_RECORD_COUNT),
      DO_ARCHIVE: "1",
      CRASH_POINT: point,
    });

    // Reopen: the full ledger must be readable with every body intact.
    let ledger = AuditLedger.open({ dir });
    assertMatchesOriginal(readAll(ledger, 5), original);
    ledger.close();

    // Retry in a second child that dies again at a different point,
    // to prove repeated kill+restart cycles stay consistent. Skipped when
    // the first crash happened after the manifest commit: that archive is
    // already complete and a retry has nothing left to migrate.
    if (point !== "afterManifestCommit") {
      const secondPoint =
        point === "afterRename" ? "afterDirSync" : "afterRename";
      runChild({ LEDGER_DIR: dir, DO_ARCHIVE: "1", CRASH_POINT: secondPoint });

      ledger = AuditLedger.open({ dir });
      assertMatchesOriginal(readAll(ledger, 5), original);
      ledger.close();
    }

    // Final retry completes the archive (a no-op if the first crash
    // happened after the manifest commit and already finished it).
    ledger = AuditLedger.open({ dir });
    const archived = ledger.archive(CHILD_CUTOFF);
    const wantOnline = [...original.keys()].filter(
      (id) => original.get(id)!.eventTimeMs >= CHILD_CUTOFF,
    );
    const alreadyComplete = point === "afterManifestCommit";
    assert.equal(
      archived,
      alreadyComplete ? 0 : original.size - wantOnline.length,
    );
    assert.deepEqual(ledger.onlineIds(), wantOnline);
    assertMatchesOriginal(readAll(ledger, 5), original);
    // Exactly one committed archive, no temp/orphan files left behind.
    assertArchiveDirClean(dir, 1);
    ledger.close();

    // After a final restart the ledger is still whole.
    ledger = AuditLedger.open({ dir });
    assertMatchesOriginal(readAll(ledger, 5), original);
    assertArchiveDirClean(dir, 1);
    ledger.close();
  }
});

test("append killed mid-flight: committed prefix survives, ids never reused", () => {
  const dir = makeTempDir("ledger-append-crash-");
  const killedAfter = 17;

  runChild({
    LEDGER_DIR: dir,
    APPEND_COUNT: String(CHILD_RECORD_COUNT),
    KILL_AFTER_APPEND: String(killedAfter),
  });

  const ledger = AuditLedger.open({ dir });
  const records = readAll(ledger, 4);
  // Every record whose append committed is fully present, nothing partial.
  assert.equal(records.length, killedAfter);
  for (const [i, record] of records.entries()) {
    assert.equal(record.id, i + 1);
    assert.equal(record.eventTimeMs, childTime(i));
    assert.equal(record.body, childBody(i));
  }

  // Appending after the crash continues with fresh, never-reused ids.
  const nextId = ledger.append(childTime(100), childBody(100));
  assert.ok(nextId > killedAfter, `id ${nextId} reused after crash`);
  ledger.close();
});
