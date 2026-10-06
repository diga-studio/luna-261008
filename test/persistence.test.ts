import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { GuestConnect, type SessionEvent } from "../src/index.js";

function tempDb(): string {
  return join(mkdtempSync(join(tmpdir(), "gc-persist-")), "test.db");
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

test("versions, session state and dedup survive close and reopen", () => {
  const db = tempDb();
  try {
    let v1: number, v2: number, v3: number;
    {
      const gc = new GuestConnect(db);
      v1 = gc.merge([ev("s1", "ap-a", 1, 10, { k: "one" }), ev("s2", "ap-a", 2, 10, { k: "two" })]);
      v2 = gc.merge([ev("s1", "ap-a", 3, 20, null)]); // delete s1
      v3 = gc.rollback(v1); // restore both sessions
      gc.close();
    }

    const gc = new GuestConnect(db); // reopen
    assert.equal(gc.currentVersion, v3);
    // All historical versions still queryable.
    assert.deepEqual(gc.read(v1, "s1"), { k: "one" });
    assert.equal(gc.read(v2, "s1"), undefined);
    assert.deepEqual(gc.read(v2, "s2"), { k: "two" });
    assert.deepEqual(gc.read(v3, "s1"), { k: "one" });

    // Dedup survived: retransmitting processed events changes nothing.
    const v4 = gc.merge([ev("s1", "ap-a", 1, 10, { k: "one" }), ev("s1", "ap-a", 3, 20, null)]);
    assert.equal(v4, v3 + 1);
    assert.deepEqual(gc.read(v4, "s1"), { k: "one" });
    assert.deepEqual(gc.read(v4, "s2"), { k: "two" });

    // New events keep merging on the restored state after reopen.
    const v5 = gc.merge([ev("s1", "ap-b", 1, 15, { k: "fifteen" })]);
    assert.deepEqual(gc.read(v5, "s1"), { k: "fifteen" });
    gc.close();
  } finally {
    cleanup(db);
  }
});
