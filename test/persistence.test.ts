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

test("versions, session state and dedup survive close and reopen", () => {
  const { dir, file } = tempDbPath();
  try {
    let store = new GuestConnectStore(file);
    const v1 = store.merge([
      valueEvent("s1", "ap-a", 1, 10, { v: 1 }),
      valueEvent("s2", "ap-b", 1, 40, { v: "b" }),
    ]);
    const v2 = store.merge([
      {
        sessionId: "s2",
        sourceAp: "ap-b",
        sourceSeq: 2,
        updatedAt: 50,
        kind: "delete",
      },
    ]);
    const v3 = store.rollback(v1);
    store.close();

    store = new GuestConnectStore(file);
    assert.equal(store.currentVersion(), v3);
    assert.deepEqual(store.read(v1, "s1"), { v: 1 });
    assert.deepEqual(store.read(v1, "s2"), { v: "b" });
    assert.equal(store.read(v2, "s2"), undefined);
    assert.deepEqual(store.read(v3, "s2"), { v: "b" });

    const v4 = store.merge([
      valueEvent("s1", "ap-a", 1, 10, { v: 1 }),
      valueEvent("s2", "ap-b", 2, 50, { v: "zombie" }),
    ]);
    assert.equal(v4, v3 + 1);
    assert.deepEqual(store.read(v4, "s1"), { v: 1 });
    assert.deepEqual(store.read(v4, "s2"), { v: "b" });

    const v5 = store.merge([valueEvent("s1", "ap-a", 2, 20, { v: 2 })]);
    assert.deepEqual(store.read(v5, "s1"), { v: 2 });
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rollback performed before reopen remains effective after reopen", () => {
  const { dir, file } = tempDbPath();
  try {
    let store = new GuestConnectStore(file);
    const v1 = store.merge([valueEvent("s1", "ap-a", 1, 10, { v: 10 })]);
    const v2 = store.merge([valueEvent("s1", "ap-a", 2, 30, { v: 30 })]);
    const v3 = store.rollback(v1);
    store.close();

    store = new GuestConnectStore(file);
    assert.deepEqual(store.read(v3, "s1"), { v: 10 });
    assert.deepEqual(store.read(v2, "s1"), { v: 30 });

    const v4 = store.merge([valueEvent("s1", "ap-a", 2, 30, { v: 30 })]);
    assert.deepEqual(store.read(v4, "s1"), { v: 10 });
    const v5 = store.merge([valueEvent("s1", "ap-b", 1, 20, { v: 20 })]);
    assert.deepEqual(store.read(v5, "s1"), { v: 20 });
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
