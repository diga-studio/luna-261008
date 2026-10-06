import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { GuestConnect, type SessionEvent } from "../src/index.js";

function tempDb(): string {
  return join(mkdtempSync(join(tmpdir(), "gc-merge-")), "test.db");
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

function shuffled<T>(items: T[], seed: number): T[] {
  const out = [...items];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

test("batch order and duplicate delivery do not affect the result", () => {
  const events: SessionEvent[] = [
    ev("s1", "ap-a", 1, 10, { k: "a1" }),
    ev("s1", "ap-a", 2, 20, { k: "a2" }),
    ev("s1", "ap-b", 1, 15, { k: "b1" }),
    ev("s2", "ap-a", 3, 10, { k: "s2a" }),
    ev("s2", "ap-b", 2, 10, { k: "s2b" }),
    ev("s3", "ap-c", 1, 5, { k: "c1" }),
  ];

  const finals: string[] = [];
  for (const seed of [1, 2, 3]) {
    const db = tempDb();
    try {
      const gc = new GuestConnect(db);
      // Split the shuffled batch into two merges and re-deliver some events.
      const batch = shuffled(events, seed);
      gc.merge(batch.slice(0, 3));
      gc.merge([...batch.slice(3), batch[0], batch[4]]); // duplicates mixed in
      gc.merge([batch[1]]); // pure duplicate batch, still bumps the version
      finals.push(
        JSON.stringify([
          gc.read(gc.currentVersion, "s1"),
          gc.read(gc.currentVersion, "s2"),
          gc.read(gc.currentVersion, "s3"),
        ]),
      );
      gc.close();
    } finally {
      cleanup(db);
    }
  }
  assert.equal(finals[0], finals[1]);
  assert.equal(finals[1], finals[2]);

  // Expected: s1 -> a2 (ts 20), s2 -> s2b (ts tie, ap-b > ap-a), s3 -> c1.
  assert.deepEqual(JSON.parse(finals[0]), [{ k: "a2" }, { k: "s2b" }, { k: "c1" }]);
});

test("same-timestamp conflicts resolve by sourceAp then sourceSeq", () => {
  const db = tempDb();
  try {
    const gc = new GuestConnect(db);
    gc.merge([
      ev("s", "ap-b", 1, 10, { w: "b1" }),
      ev("s", "ap-a", 9, 10, { w: "a9" }),
    ]);
    assert.deepEqual(gc.read(gc.currentVersion, "s"), { w: "b1" }); // ap-b > ap-a

    gc.merge([ev("s", "ap-b", 2, 10, { w: "b2" })]);
    assert.deepEqual(gc.read(gc.currentVersion, "s"), { w: "b2" }); // same ap, seq 2 > 1

    gc.merge([ev("s", "ap-a", 10, 10, { w: "a10" })]); // loses, but enters dedup
    assert.deepEqual(gc.read(gc.currentVersion, "s"), { w: "b2" });
    gc.close();
  } finally {
    cleanup(db);
  }
});

test("deletion blocks older updates; history stays readable", () => {
  const db = tempDb();
  try {
    const gc = new GuestConnect(db);
    const v1 = gc.merge([ev("s", "ap-a", 1, 10, { k: "alive" })]);
    const v2 = gc.merge([ev("s", "ap-a", 2, 30, null)]); // delete at ts 30
    assert.equal(gc.read(v2, "s"), undefined);

    // Older update (ts 20) arrives after the delete: must not resurrect.
    const v3 = gc.merge([ev("s", "ap-b", 1, 20, { k: "zombie" })]);
    assert.equal(gc.read(v3, "s"), undefined);

    // Newer update (ts 40) beats the tombstone.
    const v4 = gc.merge([ev("s", "ap-b", 2, 40, { k: "revived" })]);
    assert.deepEqual(gc.read(v4, "s"), { k: "revived" });

    // Historical versions remain queryable.
    assert.deepEqual(gc.read(v1, "s"), { k: "alive" });
    assert.equal(gc.read(v2, "s"), undefined);
    assert.equal(gc.read(v3, "s"), undefined);
    gc.close();
  } finally {
    cleanup(db);
  }
});

test("no-op merge still bumps the version; version 0 is empty", () => {
  const db = tempDb();
  try {
    const gc = new GuestConnect(db);
    assert.equal(gc.currentVersion, 0);
    assert.equal(gc.read(0, "anything"), undefined);
    const v1 = gc.merge([]);
    assert.equal(v1, 1);
    const v2 = gc.merge([ev("s", "ap-a", 1, 1, { k: 1 })]);
    assert.equal(v2, 2);
    const v3 = gc.merge([ev("s", "ap-a", 1, 1, { k: 1 })]); // duplicate: no state change
    assert.equal(v3, 3);
    assert.deepEqual(gc.read(v3, "s"), { k: 1 });
    gc.close();
  } finally {
    cleanup(db);
  }
});
