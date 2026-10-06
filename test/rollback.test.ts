import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { GuestConnectStore } from "../src/index.js";
import type { SessionEvent } from "../src/index.js";

function tempDbPath(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "guestconnect-"));
  return { dir, file: join(dir, "store.sqlite") };
}

function valueEvent(
  sessionId: string,
  sourceAp: string,
  sourceSeq: number,
  updatedAt: number,
  value: Record<string, unknown>,
): SessionEvent {
  return {
    sessionId,
    sourceAp,
    sourceSeq,
    updatedAt,
    kind: "value",
    value: value as never,
  };
}

test("rollback restores state; replayed abandoned events stay ignored; new events merge on restored state", () => {
  const { dir, file } = tempDbPath();
  try {
    const store = new GuestConnectStore(file);

    const v1 = store.merge([valueEvent("s1", "ap-a", 1, 10, { v: 10 })]);
    const v2 = store.merge([valueEvent("s1", "ap-a", 2, 30, { v: 30 })]);
    assert.deepEqual(store.read(v2, "s1"), { v: 30 });

    const v3 = store.rollback(v1);
    assert.ok(v3 > v2);
    assert.deepEqual(store.read(v3, "s1"), { v: 10 });

    // Abandoned branch versions remain readable.
    assert.deepEqual(store.read(v2, "s1"), { v: 30 });
    assert.deepEqual(store.read(v1, "s1"), { v: 10 });

    // Retransmission of the already-processed ts=30 event is ignored:
    // dedup is global and is not restored by rollback.
    const v4 = store.merge([valueEvent("s1", "ap-a", 2, 30, { v: 30 })]);
    assert.deepEqual(store.read(v4, "s1"), { v: 10 });

    // A first-seen event with ts=20 wins over the restored winner (ts=10),
    // even though 20 < 30 from the abandoned branch.
    const v5 = store.merge([valueEvent("s1", "ap-b", 1, 20, { v: 20 })]);
    assert.deepEqual(store.read(v5, "s1"), { v: 20 });

    // The abandoned branch version still reads its original value.
    assert.deepEqual(store.read(v2, "s1"), { v: 30 });
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rollback to version 0 clears all sessions but keeps dedup", () => {
  const { dir, file } = tempDbPath();
  try {
    const store = new GuestConnectStore(file);
    const v1 = store.merge([valueEvent("s1", "ap-a", 1, 10, { v: 1 })]);
    const v2 = store.rollback(0);
    assert.equal(store.read(v2, "s1"), undefined);
    assert.deepEqual(store.read(v1, "s1"), { v: 1 });

    // Already-seen event cannot resurrect the session after rollback.
    const v3 = store.merge([valueEvent("s1", "ap-a", 1, 10, { v: 1 })]);
    assert.equal(store.read(v3, "s1"), undefined);

    // A genuinely new event still applies.
    const v4 = store.merge([valueEvent("s1", "ap-a", 2, 5, { v: 2 })]);
    assert.deepEqual(store.read(v4, "s1"), { v: 2 });
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rollback restores deletion tombstones so older updates stay blocked", () => {
  const { dir, file } = tempDbPath();
  try {
    const store = new GuestConnectStore(file);
    store.merge([valueEvent("s1", "ap-a", 1, 10, { v: 1 })]);
    const vDeleted = store.merge([
      { sessionId: "s1", sourceAp: "ap-a", sourceSeq: 2, updatedAt: 20, kind: "delete" },
    ]);
    store.merge([valueEvent("s1", "ap-a", 3, 30, { v: 3 })]);

    const v4 = store.rollback(vDeleted);
    assert.equal(store.read(v4, "s1"), undefined);

    // ts=25 is newer than the restored tombstone (ts=20) but the event was
    // never seen before, so it applies; ts=15 is older and stays blocked.
    const v5 = store.merge([valueEvent("s1", "ap-b", 1, 15, { v: "old" })]);
    assert.equal(store.read(v5, "s1"), undefined);
    const v6 = store.merge([valueEvent("s1", "ap-b", 2, 25, { v: "new" })]);
    assert.deepEqual(store.read(v6, "s1"), { v: "new" });
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rollback rejects invalid versions", () => {
  const { dir, file } = tempDbPath();
  try {
    const store = new GuestConnectStore(file);
    store.merge([valueEvent("s1", "ap-a", 1, 10, { v: 1 })]);
    assert.throws(() => store.rollback(-1), RangeError);
    assert.throws(() => store.rollback(99), RangeError);
    assert.throws(() => store.read(99, "s1"), RangeError);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
