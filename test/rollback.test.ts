import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { GuestConnect, type SessionEvent } from "../src/index.js";

function tempDb(): string {
  return join(mkdtempSync(join(tmpdir(), "gc-rollback-")), "test.db");
}

function cleanup(path: string): void {
  rmSync(join(path, ".."), { recursive: true, force: true });
}

function ev(
  sessionId: string,
  sourceAp: string,
  sourceSeq: number,
  updatedAt: number,
  value: Record<string, unknown> | null,
): SessionEvent {
  return { sessionId, sourceAp, sourceSeq, updatedAt, value };
}

test("rollback restores state, keeps dedup, and abandoned versions stay readable", () => {
  const db = tempDb();
  try {
    const gc = new GuestConnect(db);
    const v1 = gc.merge([ev("s", "ap-a", 1, 10, { k: "ten" })]);
    const v2 = gc.merge([ev("s", "ap-a", 2, 30, { k: "thirty" })]);
    assert.deepEqual(gc.read(v2, "s"), { k: "thirty" });

    // Roll back to the version holding ts=10.
    const v3 = gc.rollback(v1);
    assert.equal(v3, 3);
    assert.deepEqual(gc.read(v3, "s"), { k: "ten" });

    // Retransmit of the already-processed ts=30 event: ignored (dedup survives rollback).
    const v4 = gc.merge([ev("s", "ap-a", 2, 30, { k: "thirty" })]);
    assert.deepEqual(gc.read(v4, "s"), { k: "ten" });

    // First-seen ts=20 event merges against the restored state and wins over ts=10.
    const v5 = gc.merge([ev("s", "ap-b", 1, 20, { k: "twenty" })]);
    assert.deepEqual(gc.read(v5, "s"), { k: "twenty" });

    // The abandoned branch's version still reads its original value.
    assert.deepEqual(gc.read(v2, "s"), { k: "thirty" });
    assert.deepEqual(gc.read(v1, "s"), { k: "ten" });
    gc.close();
  } finally {
    cleanup(db);
  }
});

test("rollback restores tombstones so old updates cannot resurrect sessions", () => {
  const db = tempDb();
  try {
    const gc = new GuestConnect(db);
    gc.merge([ev("s", "ap-a", 1, 10, { k: "alive" })]);
    const v2 = gc.merge([ev("s", "ap-a", 2, 50, null)]); // deleted at ts 50
    gc.merge([ev("s", "ap-a", 3, 60, { k: "later" })]); // newer value on top
    const v4 = gc.rollback(v2); // restore the deleted state
    assert.equal(gc.read(v4, "s"), undefined);

    // ts 55 is newer than the tombstone's ts 50 but older than the abandoned ts 60:
    // comparisons must use the restored winner (ts 50), so this update wins...
    const v5 = gc.merge([ev("s", "ap-b", 1, 55, { k: "fifty-five" })]);
    assert.deepEqual(gc.read(v5, "s"), { k: "fifty-five" });

    // ...while a ts 40 update loses against the restored tombstone.
    gc.merge([ev("s", "ap-b", 2, 40, { k: "forty" })]);
    assert.deepEqual(gc.read(gc.currentVersion, "s"), { k: "fifty-five" });
    gc.close();
  } finally {
    cleanup(db);
  }
});

test("rollback to version 0 clears all sessions but keeps dedup", () => {
  const db = tempDb();
  try {
    const gc = new GuestConnect(db);
    gc.merge([ev("s", "ap-a", 1, 10, { k: "v" })]);
    const v2 = gc.rollback(0);
    assert.equal(gc.read(v2, "s"), undefined);
    // Same event retransmitted after rollback to empty: still a duplicate.
    const v3 = gc.merge([ev("s", "ap-a", 1, 10, { k: "v" })]);
    assert.equal(gc.read(v3, "s"), undefined);
    gc.close();
  } finally {
    cleanup(db);
  }
});

test("rollback rejects unknown versions", () => {
  const db = tempDb();
  try {
    const gc = new GuestConnect(db);
    gc.merge([ev("s", "ap-a", 1, 10, { k: "v" })]);
    assert.throws(() => gc.rollback(2), RangeError);
    assert.throws(() => gc.rollback(-1), RangeError);
    assert.throws(() => gc.read(2, "s"), RangeError);
    gc.close();
  } finally {
    cleanup(db);
  }
});
