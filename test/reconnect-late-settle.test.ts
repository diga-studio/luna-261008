import test from "node:test";
import assert from "node:assert/strict";
import { Messenger } from "../src/index.js";
import { DeliverRecorder, flushMicrotasks, tempDbPath } from "./helpers.js";

test("overlapping pumps, reconnect while in-flight, late settle must not pollute quota or schedule", async () => {
  const { dbPath, cleanup } = tempDbPath();
  const recorder = new DeliverRecorder();
  const messenger = new Messenger(dbPath, recorder.fn);
  try {
    messenger.enqueue("conv", "m1", "payload");
    messenger.setOnline("conv", true);

    // Two overlapping pumps: the second must not double-initiate.
    messenger.pump(0);
    messenger.pump(0);
    assert.deepEqual(recorder.seqsFor("conv"), [1]);
    const oldCall = recorder.calls[0];
    assert.ok(oldCall !== undefined);

    // Disconnect and reconnect while the first deliver is still pending.
    messenger.setOnline("conv", false);
    messenger.setOnline("conv", true);

    // New online period: fresh quota, first attempt goes out at t=100.
    messenger.pump(100);
    assert.deepEqual(recorder.seqsFor("conv"), [1, 1]);
    const newCall = recorder.calls[1];
    assert.ok(newCall !== undefined);

    // The pre-disconnect call settles late, after the new attempt started.
    // It must not clear the new in-flight attempt, spend quota, or
    // shift the schedule.
    oldCall.resolve("ok");
    await flushMicrotasks();
    messenger.pump(100);
    messenger.pump(5000);
    assert.deepEqual(recorder.seqsFor("conv"), [1, 1]);

    // The new attempt fails at t=5500; next retry due at 100+5000=5100
    // (set at initiation), unaffected by the late settle.
    newCall.reject(new Error("boom"));
    await flushMicrotasks();
    messenger.pump(5099);
    assert.deepEqual(recorder.seqsFor("conv"), [1, 1]);
    messenger.pump(5100);
    assert.deepEqual(recorder.seqsFor("conv"), [1, 1, 1]);

    // Fresh quota is exactly 4 attempts for this online period
    // (t=100, 5100, 10100, 15100); the old period's attempt did not count.
    recorder.calls[2]?.reject(new Error("boom"));
    await flushMicrotasks();
    messenger.pump(10100);
    recorder.calls[3]?.reject(new Error("boom"));
    await flushMicrotasks();
    messenger.pump(15100);
    assert.deepEqual(recorder.seqsFor("conv"), [1, 1, 1, 1, 1]);
    recorder.calls[4]?.reject(new Error("boom"));
    await flushMicrotasks();

    // Quota exhausted: message stays pending but no more attempts.
    messenger.pump(20100);
    messenger.pump(1000000);
    assert.deepEqual(recorder.seqsFor("conv"), [1, 1, 1, 1, 1]);
  } finally {
    messenger.close();
    cleanup();
  }
});
