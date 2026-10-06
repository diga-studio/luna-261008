import test from "node:test";
import assert from "node:assert/strict";
import { Messenger } from "../src/index.js";
import { DeliverRecorder, flushMicrotasks, tempDbPath } from "./helpers.js";

test("deliver synchronously acks then returns a pending promise; later failure must not resend", async () => {
  const { dbPath, cleanup } = tempDbPath();
  const recorder = new DeliverRecorder();
  const messenger = new Messenger(dbPath, recorder.fn);
  try {
    const seq1 = messenger.enqueue("conv", "m1", "hello");
    messenger.setOnline("conv", true);

    // deliver acks the very message it is delivering, synchronously,
    // then returns a promise that stays pending.
    recorder.onCall = (call) => {
      if (call.messageId === "m1") {
        messenger.acknowledge("conv", call.seq);
      }
    };
    messenger.pump(0);
    assert.deepEqual(recorder.seqsFor("conv"), [1]);
    assert.equal(seq1, 1);

    // The pending deliver must not block later messages.
    messenger.enqueue("conv", "m2", "world");
    messenger.pump(10);
    assert.deepEqual(recorder.seqsFor("conv"), [1, 2]);

    // Now the first deliver fails, long after its message was acked.
    const first = recorder.calls[0];
    assert.ok(first !== undefined);
    first.reject(new Error("delivery failed"));
    await flushMicrotasks();

    // No resend of the acked message, ever — even far past retry times.
    messenger.pump(100000);
    messenger.pump(200000);
    assert.deepEqual(recorder.seqsFor("conv"), [1, 2]);

    // Reconnect must not resurrect it either.
    messenger.setOnline("conv", false);
    messenger.setOnline("conv", true);
    messenger.pump(300000);
    assert.deepEqual(recorder.seqsFor("conv"), [1, 2, 2]);
  } finally {
    messenger.close();
    cleanup();
  }
});
