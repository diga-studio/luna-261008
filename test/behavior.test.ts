import test from "node:test";
import assert from "node:assert/strict";
import { Messenger } from "../src/index.js";
import { DeliverRecorder, flushMicrotasks, tempDbPath } from "./helpers.js";

test("seq is gapless per conversation and independent across conversations", () => {
  const { dbPath, cleanup } = tempDbPath();
  const messenger = new Messenger(dbPath, () => Promise.resolve());
  try {
    assert.equal(messenger.enqueue("a", "a1", "x"), 1);
    assert.equal(messenger.enqueue("b", "b1", "x"), 1);
    assert.equal(messenger.enqueue("a", "a2", "x"), 2);
    assert.equal(messenger.enqueue("b", "b2", "x"), 2);
    assert.equal(messenger.enqueue("a", "a3", "x"), 3);
  } finally {
    messenger.close();
    cleanup();
  }
});

test("offline conversations never initiate deliver; first deliveries go in seq order", () => {
  const { dbPath, cleanup } = tempDbPath();
  const recorder = new DeliverRecorder();
  const messenger = new Messenger(dbPath, recorder.fn);
  try {
    messenger.enqueue("c", "m1", "1");
    messenger.enqueue("c", "m2", "2");
    messenger.enqueue("c", "m3", "3");
    messenger.pump(0); // offline: nothing
    assert.equal(recorder.calls.length, 0);
    messenger.setOnline("c", true);
    messenger.pump(0);
    assert.deepEqual(recorder.seqsFor("c"), [1, 2, 3]);
  } finally {
    messenger.close();
    cleanup();
  }
});

test("unacked old message does not block first delivery of newer messages", async () => {
  const { dbPath, cleanup } = tempDbPath();
  const recorder = new DeliverRecorder();
  const messenger = new Messenger(dbPath, recorder.fn);
  try {
    messenger.enqueue("c", "m1", "old");
    messenger.setOnline("c", true);
    messenger.pump(0);
    assert.deepEqual(recorder.seqsFor("c"), [1]);
    // m1 stays unacked and in-flight; new message still goes out.
    messenger.enqueue("c", "m2", "new");
    messenger.pump(1);
    assert.deepEqual(recorder.seqsFor("c"), [1, 2]);
    await flushMicrotasks();
  } finally {
    messenger.close();
    cleanup();
  }
});

test("retry waits at least 5000ms since last initiation; failed calls spend quota", async () => {
  const { dbPath, cleanup } = tempDbPath();
  const recorder = new DeliverRecorder();
  const messenger = new Messenger(dbPath, recorder.fn);
  try {
    messenger.enqueue("c", "m1", "x");
    messenger.setOnline("c", true);
    messenger.pump(1000);
    assert.equal(recorder.calls.length, 1);
    recorder.calls[0]?.reject(new Error("boom"));
    await flushMicrotasks();
    messenger.pump(5999); // too early: 1000+5000=6000
    assert.equal(recorder.calls.length, 1);
    messenger.pump(6000);
    assert.equal(recorder.calls.length, 2);
    // Successful settle also spends the attempt; no instant retry.
    recorder.calls[1]?.resolve("ok");
    await flushMicrotasks();
    messenger.pump(6001);
    assert.equal(recorder.calls.length, 2);
  } finally {
    messenger.close();
    cleanup();
  }
});

test("repeated setOnline(true) does not reset quota; repeated setOnline(false) is a no-op", async () => {
  const { dbPath, cleanup } = tempDbPath();
  const recorder = new DeliverRecorder();
  const messenger = new Messenger(dbPath, recorder.fn);
  try {
    messenger.enqueue("c", "m1", "x");
    messenger.setOnline("c", true);
    messenger.setOnline("c", true);
    messenger.pump(0);
    for (const t of [5000, 10000, 15000]) {
      recorder.calls[recorder.calls.length - 1]?.reject(new Error("boom"));
      await flushMicrotasks();
      messenger.setOnline("c", true); // repeated: must NOT reset quota
      messenger.pump(t);
    }
    assert.equal(recorder.calls.length, 4);
    messenger.setOnline("c", true);
    messenger.pump(20000); // quota exhausted; repeated online did not reset
    assert.equal(recorder.calls.length, 4);
    messenger.setOnline("c", false);
    messenger.setOnline("c", false);
    messenger.pump(30000);
    assert.equal(recorder.calls.length, 4);
  } finally {
    messenger.close();
    cleanup();
  }
});

test("duplicate and late ACKs are harmless; unknown seq ACK is a no-op", async () => {
  const { dbPath, cleanup } = tempDbPath();
  const recorder = new DeliverRecorder();
  const messenger = new Messenger(dbPath, recorder.fn);
  try {
    messenger.enqueue("c", "m1", "x");
    messenger.setOnline("c", true);
    messenger.pump(0);
    assert.equal(recorder.calls.length, 1);
    messenger.acknowledge("c", 1);
    messenger.acknowledge("c", 1); // duplicate
    messenger.acknowledge("c", 999); // unknown seq
    messenger.setOnline("c", false);
    messenger.acknowledge("c", 1); // late ACK while offline
    recorder.calls[0]?.resolve("ok");
    await flushMicrotasks();
    messenger.setOnline("c", true);
    messenger.pump(100000);
    assert.equal(recorder.calls.length, 1); // never resent
  } finally {
    messenger.close();
    cleanup();
  }
});

test("a slow delivery in one conversation never blocks another", async () => {
  const { dbPath, cleanup } = tempDbPath();
  const recorder = new DeliverRecorder();
  const messenger = new Messenger(dbPath, recorder.fn);
  try {
    messenger.enqueue("slow", "s1", "x");
    messenger.enqueue("fast", "f1", "y");
    messenger.setOnline("slow", true);
    messenger.setOnline("fast", true);
    messenger.pump(0);
    assert.deepEqual(recorder.seqsFor("slow"), [1]);
    assert.deepEqual(recorder.seqsFor("fast"), [1]);
    // slow's promise stays pending forever; fast keeps retrying on schedule.
    recorder.forConversation("fast")[0]?.reject(new Error("boom"));
    await flushMicrotasks();
    messenger.pump(5000);
    assert.deepEqual(recorder.seqsFor("fast"), [1, 1]);
    assert.deepEqual(recorder.seqsFor("slow"), [1]);
  } finally {
    messenger.close();
    cleanup();
  }
});

test("deliver throwing synchronously counts as a failed attempt", () => {
  const { dbPath, cleanup } = tempDbPath();
  let calls = 0;
  const messenger = new Messenger(dbPath, () => {
    calls += 1;
    throw new Error("sync failure");
  });
  try {
    messenger.enqueue("c", "m1", "x");
    messenger.setOnline("c", true);
    messenger.pump(0);
    messenger.pump(0);
    assert.equal(calls, 1);
    messenger.pump(5000);
    assert.equal(calls, 2);
  } finally {
    messenger.close();
    cleanup();
  }
});
