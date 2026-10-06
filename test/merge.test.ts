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

function deleteEvent(
  sessionId: string,
  sourceAp: string,
  sourceSeq: number,
  updatedAt: number,
): SessionEvent {
  return { sessionId, sourceAp, sourceSeq, updatedAt, kind: "delete" };
}

test("reordered and duplicated delivery converges to the same state", () => {
  const events: SessionEvent[] = [
    valueEvent("s1", "ap-a", 1, 100, { v: "a1" }),
    valueEvent("s1", "ap-b", 1, 300, { v: "b1" }),
    valueEvent("s1", "ap-a", 2, 200, { v: "a2" }),
    valueEvent("s2", "ap-a", 3, 50, { v: "s2" }),
  ];
  const reordered: SessionEvent[] = [
    events[2]!,
    events[0]!,
    events[3]!,
    events[1]!,
    events[1]!,
    events[0]!,
  ];

  const run = (batch: SessionEvent[]): Map<string, unknown> => {
    const { dir, file } = tempDbPath();
    try {
      const store = new GuestConnectStore(file);
      const version = store.merge(batch);
      const result = new Map<string, unknown>([
        ["s1", store.read(version, "s1")],
        ["s2", store.read(version, "s2")],
      ]);
      store.close();
      return result;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const first = run(events);
  const second = run(reordered);
  assert.deepEqual(first, second);
  assert.deepEqual(first.get("s1"), { v: "b1" });
  assert.deepEqual(first.get("s2"), { v: "s2" });
});

test("duplicate events in later merges are ignored", () => {
  const { dir, file } = tempDbPath();
  try {
    const store = new GuestConnectStore(file);
    const v1 = store.merge([valueEvent("s1", "ap-a", 1, 100, { v: 1 })]);
    const v2 = store.merge([
      valueEvent("s1", "ap-a", 1, 100, { v: 1 }),
      valueEvent("s1", "ap-a", 1, 100, { v: 1 }),
    ]);
    assert.equal(v2, v1 + 1);
    assert.deepEqual(store.read(v2, "s1"), { v: 1 });
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("same-timestamp conflicts across APs resolve by sourceAp then sourceSeq", () => {
  const { dir, file } = tempDbPath();
  try {
    const store = new GuestConnectStore(file);
    const v1 = store.merge([
      valueEvent("s1", "ap-b", 5, 100, { v: "b5" }),
      valueEvent("s1", "ap-a", 9, 100, { v: "a9" }),
    ]);
    assert.deepEqual(store.read(v1, "s1"), { v: "b5" });

    const v2 = store.merge([valueEvent("s1", "ap-b", 4, 100, { v: "b4" })]);
    assert.deepEqual(store.read(v2, "s1"), { v: "b5" });

    const v3 = store.merge([valueEvent("s1", "ap-b", 6, 100, { v: "b6" })]);
    assert.deepEqual(store.read(v3, "s1"), { v: "b6" });

    const v4 = store.merge([valueEvent("s1", "ap-c", 1, 100, { v: "c1" })]);
    assert.deepEqual(store.read(v4, "s1"), { v: "c1" });
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("delete blocks older updates; history before delete stays readable", () => {
  const { dir, file } = tempDbPath();
  try {
    const store = new GuestConnectStore(file);
    const v1 = store.merge([valueEvent("s1", "ap-a", 1, 100, { v: "old" })]);
    const v2 = store.merge([deleteEvent("s1", "ap-a", 2, 200)]);

    assert.equal(store.read(v2, "s1"), undefined);
    assert.deepEqual(store.read(v1, "s1"), { v: "old" });

    const v3 = store.merge([valueEvent("s1", "ap-a", 3, 150, { v: "zombie" })]);
    assert.equal(store.read(v3, "s1"), undefined);

    const v4 = store.merge([valueEvent("s1", "ap-b", 1, 250, { v: "new" })]);
    assert.deepEqual(store.read(v4, "s1"), { v: "new" });
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("merge with no effective change still bumps the version", () => {
  const { dir, file } = tempDbPath();
  try {
    const store = new GuestConnectStore(file);
    const v1 = store.merge([valueEvent("s1", "ap-a", 1, 100, { v: 1 })]);
    const v2 = store.merge([]);
    const v3 = store.merge([valueEvent("s1", "ap-a", 1, 100, { v: 1 })]);
    assert.equal(v1, 1);
    assert.equal(v2, 2);
    assert.equal(v3, 3);
    assert.deepEqual(store.read(v3, "s1"), { v: 1 });
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("version 0 is the empty state", () => {
  const { dir, file } = tempDbPath();
  try {
    const store = new GuestConnectStore(file);
    store.merge([valueEvent("s1", "ap-a", 1, 100, { v: 1 })]);
    assert.equal(store.read(0, "s1"), undefined);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
