import test from "node:test";
import assert from "node:assert/strict";
import { Messenger } from "../src/index.js";
import { DeliverRecorder, flushMicrotasks, tempDbPath } from "./helpers.js";

test("reopen keeps messages, seqs and acks; only unacked are redelivered in seq order", async () => {
  const { dbPath, cleanup } = tempDbPath();
  const recorder = new DeliverRecorder();

  // Phase 1: enqueue while offline, with duplicates and a conflict.
  const first = new Messenger(dbPath, recorder.fn);
  assert.equal(first.enqueue("conv", "m1", "one"), 1);
  assert.equal(first.enqueue("conv", "m2", "two"), 2);
  assert.equal(first.enqueue("conv", "m1", "one"), 1); // duplicate: same seq, no new row
  assert.throws(() => first.enqueue("conv", "m2", "CHANGED"), /different text/);
  assert.equal(first.enqueue("conv", "m3", "three"), 3);

  // Phase 2: go online, exhaust quota for m1/m2, ack m3.
  first.setOnline("conv", true);
  first.pump(0);
  assert.deepEqual(recorder.seqsFor("conv"), [1, 2, 3]);
  for (const t of [5000, 10000, 15000]) {
    for (const call of recorder.calls.slice()) {
      if (call.messageId === "m1" || call.messageId === "m2") {
        call.reject(new Error("fail"));
      }
    }
    await flushMicrotasks();
    first.pump(t);
  }
  // m1 and m2 each got 4 attempts (t=0,5000,10000,15000); quota exhausted.
  assert.deepEqual(
    recorder.seqsFor("conv").filter((s) => s === 1).length,
    4
  );
  assert.deepEqual(
    recorder.seqsFor("conv").filter((s) => s === 2).length,
    4
  );
  first.pump(20000);
  assert.equal(recorder.calls.length, 4 + 4 + 1);
  first.acknowledge("conv", 3);
  first.close();

  // Phase 3: reopen. New instance starts offline; nothing is delivered.
  const before = recorder.calls.length;
  const second = new Messenger(dbPath, recorder.fn);
  second.pump(25000);
  assert.equal(recorder.calls.length, before);

  // Original messageIds still return their original seqs.
  assert.equal(second.enqueue("conv", "m1", "one"), 1);
  assert.equal(second.enqueue("conv", "m2", "two"), 2);
  assert.equal(second.enqueue("conv", "m3", "three"), 3);
  assert.throws(() => second.enqueue("conv", "m1", "CHANGED"), /different text/);

  // Back online: only unacknowledged m1/m2 are redelivered, first
  // attempts in original seq order, with a fresh quota.
  second.setOnline("conv", true);
  second.pump(30000);
  assert.deepEqual(recorder.seqsFor("conv").slice(before), [1, 2]);
  recorder.calls[before]?.reject(new Error("fail"));
  recorder.calls[before + 1]?.reject(new Error("fail"));
  await flushMicrotasks();
  second.pump(35000);
  assert.deepEqual(recorder.seqsFor("conv").slice(before), [1, 2, 1, 2]);
  second.close();
  cleanup();
});
