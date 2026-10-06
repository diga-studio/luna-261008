import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  AuditLog,
  verifyExport,
  type AuditRecord,
  type ExportPackage,
  type SealCredential,
  type TimeWindow,
} from "../src/index.js";

function withDb<T>(fn: (dbPath: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "audit-test-"));
  try {
    return fn(join(dir, "audit.db"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Direct filter of the sealed prefix: the ground truth for exports. */
function directFilter(
  records: AuditRecord[],
  count: number,
  window: TimeWindow,
): AuditRecord[] {
  return records
    .slice(0, count)
    .filter((r) => r.timestampMs >= window.startMs && r.timestampMs < window.endMs);
}

const SAMPLE: Array<[number, string, string]> = [
  [10, "boot", "init"],
  [20, "init", "login"],
  [20, "login", "read"],
  [20, "read", "write"],
  [30, "write", "logout"],
  [40, "logout", "shutdown"],
];

function fill(log: AuditLog, sample = SAMPLE): AuditRecord[] {
  return sample.map(([ts, prev, next], i) => ({
    seq: i + 1,
    timestampMs: ts,
    prevState: prev,
    nextState: next,
  })).map((r) => {
    log.append(r.timestampMs, r.prevState, r.nextState);
    return r;
  });
}

test("roundtrip: append, seal, export, verify matches direct filter", () => {
  withDb((db) => {
    const log = new AuditLog(db);
    const records = fill(log);
    const cred = log.seal();
    assert.equal(cred.count, records.length);

    const window = { startMs: 20, endMs: 40 };
    const pkg = log.export(window, cred);
    const hits = verifyExport(pkg, window, cred);
    assert.deepEqual(hits, directFilter(records, cred.count, window));
    assert.deepEqual(hits.map((r) => r.seq), [2, 3, 4, 5]);
    log.close();
  });
});

test("equal timestamps across the window boundary and across the seal prefix end", () => {
  withDb((db) => {
    const log = new AuditLog(db);
    const all: AuditRecord[] = [];
    const push = (ts: number, prev: string, next: string) => {
      const seq = log.append(ts, prev, next);
      all.push({ seq, timestampMs: ts, prevState: prev, nextState: next });
    };
    // Seal a prefix whose end cuts through a run of equal timestamps,
    // then keep appending more records with the same timestamp.
    push(20, "a", "b");
    push(20, "b", "c");
    push(20, "c", "d");
    const cred = log.seal();
    assert.equal(cred.count, 3);
    push(20, "d", "e"); // same timestamp, but outside the sealed prefix
    push(20, "e", "f");

    const window = { startMs: 20, endMs: 21 };
    const pkg = log.export(window, cred);
    assert.equal(pkg.count, 3);
    const hits = verifyExport(pkg, window, cred);
    assert.deepEqual(hits, directFilter(all, cred.count, window));
    assert.deepEqual(hits.map((r) => r.seq), [1, 2, 3]);
    log.close();
  });
});

test("window in a record gap yields an empty but provable result", () => {
  withDb((db) => {
    const log = new AuditLog(db);
    const records = fill(log);
    const cred = log.seal();
    const window = { startMs: 32, endMs: 38 };
    const pkg = log.export(window, cred);
    const hits = verifyExport(pkg, window, cred);
    assert.deepEqual(hits, []);
    assert.deepEqual(hits, directFilter(records, cred.count, window));
    // No state text of any record leaks in an empty-window export.
    assert.ok(pkg.entries.every((e) => e.kind === "sealed"));
    log.close();
  });
});

test("empty database seals and verifies", () => {
  withDb((db) => {
    const log = new AuditLog(db);
    const cred = log.seal();
    assert.equal(cred.count, 0);
    const window = { startMs: 0, endMs: 1000 };
    const hits = verifyExport(log.export(window, cred), window, cred);
    assert.deepEqual(hits, []);
    log.close();
  });
});

test("verification rejects a package with a hit record omitted", () => {
  withDb((db) => {
    const log = new AuditLog(db);
    fill(log);
    const cred = log.seal();
    const window = { startMs: 20, endMs: 40 };
    const pkg = log.export(window, cred);

    // Remove one hit entry entirely.
    const removed = pkg.entries.findIndex((e) => e.kind === "record");
    const tampered: ExportPackage = {
      count: pkg.count,
      entries: pkg.entries.filter((_, i) => i !== removed),
    };
    assert.throws(() => verifyExport(tampered, window, cred), /verification failed/);

    // Replace the hit with a sealed entry reusing its real hash+timestamp:
    // the position still falls inside the window, so it must be rejected.
    const real = pkg.entries[removed];
    assert.equal(real.kind, "record");
    if (real.kind === "record") {
      // Recover the real content hash by exporting a disjoint window that
      // hides this record, then splice that sealed entry in.
      const hiding = log.export({ startMs: 0, endMs: 0 }, cred);
      const sealedVersion = hiding.entries[removed];
      assert.equal(sealedVersion.kind, "sealed");
      const disguised: ExportPackage = {
        count: pkg.count,
        entries: pkg.entries.map((e, i) => (i === removed ? sealedVersion : e)),
      };
      assert.throws(() => verifyExport(disguised, window, cred), /withheld|verification failed/);
    }
    log.close();
  });
});

test("verification rejects modified state text", () => {
  withDb((db) => {
    const log = new AuditLog(db);
    fill(log);
    const cred = log.seal();
    const window = { startMs: 20, endMs: 40 };
    const pkg = log.export(window, cred);
    const tampered: ExportPackage = {
      count: pkg.count,
      entries: pkg.entries.map((e) =>
        e.kind === "record" && e.record.seq === 3
          ? { kind: "record", record: { ...e.record, nextState: "forged" } }
          : e,
      ),
    };
    assert.throws(() => verifyExport(tampered, window, cred), /verification failed/);
    log.close();
  });
});

test("verification rejects a non-empty result disguised as empty", () => {
  withDb((db) => {
    const log = new AuditLog(db);
    fill(log);
    const cred = log.seal();
    const window = { startMs: 20, endMs: 40 };
    // Attacker converts every hit into a sealed entry (real hashes, real
    // timestamps) so the package claims the window is empty.
    const hiding = log.export({ startMs: 0, endMs: 0 }, cred);
    const disguised: ExportPackage = { count: cred.count, entries: hiding.entries };
    assert.throws(() => verifyExport(disguised, window, cred), /withheld|verification failed/);

    // Attacker additionally lies about the timestamps of hidden records to
    // push them outside the window; the chain head must catch this.
    const lying: ExportPackage = {
      count: cred.count,
      entries: disguised.entries.map((e) =>
        e.kind === "sealed" && e.timestampMs >= window.startMs && e.timestampMs < window.endMs
          ? { ...e, timestampMs: window.endMs }
          : e,
      ),
    };
    assert.throws(() => verifyExport(lying, window, cred), /verification failed/);
    log.close();
  });
});

test("verification is bound to the caller's window and credential", () => {
  withDb((db) => {
    const log = new AuditLog(db);
    fill(log);
    const cred = log.seal();
    const window = { startMs: 20, endMs: 40 };
    const pkg = log.export(window, cred);

    // Same package, wider caller window: sealed positions now fall inside.
    assert.throws(
      () => verifyExport(pkg, { startMs: 0, endMs: 100 }, cred),
      /verification failed/,
    );
    // Same package, foreign credential.
    const other: SealCredential = { count: cred.count, head: "00".repeat(32) };
    assert.throws(() => verifyExport(pkg, window, other), /verification failed/);
    log.close();
  });
});

test("reopening the database keeps credentials valid and allows appending", () => {
  withDb((db) => {
    const log = new AuditLog(db);
    fill(log);
    const cred = log.seal();
    log.close();

    const reopened = new AuditLog(db);
    const window = { startMs: 20, endMs: 40 };
    const hits = verifyExport(reopened.export(window, cred), window, cred);
    assert.deepEqual(hits.map((r) => r.seq), [2, 3, 4, 5]);

    // Continue appending after reopen; old credential still verifies, and a
    // new seal covers the grown prefix.
    reopened.append(50, "shutdown", "archived");
    const hitsAgain = verifyExport(reopened.export(window, cred), window, cred);
    assert.deepEqual(hitsAgain.map((r) => r.seq), [2, 3, 4, 5]);
    const cred2 = reopened.seal();
    assert.equal(cred2.count, 7);
    const wide = { startMs: 50, endMs: 51 };
    const late = verifyExport(reopened.export(wide, cred2), wide, cred2);
    assert.deepEqual(late.map((r) => r.seq), [7]);
    reopened.close();
  });
});

test("export refuses a database that no longer matches the credential", () => {
  withDb((db) => {
    const log = new AuditLog(db);
    fill(log);
    const cred = log.seal();
    log.close();

    // Attacker rewrites the database after sealing.
    const raw = new DatabaseSync(db);
    raw.prepare("UPDATE records SET next = ? WHERE seq = ?").run("forged", 3);
    raw.close();

    const log2 = new AuditLog(db);
    assert.throws(() => log2.export({ startMs: 20, endMs: 40 }, cred), /tampered/);
    log2.close();
  });
});

test("append enforces integer, non-decreasing timestamps", () => {
  withDb((db) => {
    const log = new AuditLog(db);
    log.append(10, "a", "b");
    assert.throws(() => log.append(9, "b", "c"), /before the last/);
    assert.throws(() => log.append(1.5, "b", "c"), /integer/);
    log.append(10, "b", "c"); // equal timestamps are allowed
    log.close();
  });
});
