import { deepEqual, equal } from "node:assert/strict";
import { test } from "node:test";
import { ProgressStore } from "../src/progressStore.js";
import { LocalReceiver } from "../src/receiver.js";
import { SourceStore } from "../src/sourceStore.js";
import { SyncEngine } from "../src/syncEngine.js";
import { TargetStore } from "../src/targetStore.js";
import type { Batch } from "../src/types.js";
import {
  appendRecords,
  cleanup,
  FlakyReceiver,
  makeTempDir,
  progressFile,
  SilentReceiver,
  sortedEntries,
  sourceFile,
  SpyReceiver,
  targetFile,
} from "./helpers.js";

import type { Receiver } from "../src/types.js";

function openEngine<R extends Receiver>(dir: string, makeReceiver: (target: TargetStore) => R) {
  const source = new SourceStore(sourceFile(dir));
  const target = new TargetStore(targetFile(dir));
  const progress = new ProgressStore(progressFile(dir));
  const receiver = makeReceiver(target);
  const engine = new SyncEngine(source, progress, receiver);
  return { source, target, progress, engine, receiver };
}

function healthy(dir: string) {
  return openEngine(dir, (t) => new LocalReceiver(t));
}

function assertTargetMatchesSource(source: SourceStore, target: TargetStore): void {
  deepEqual(sortedEntries(target.getAllValues()), sortedEntries(source.summarize()));
}

test("basic sync: multiple rounds reach the independent summary", () => {
  const dir = makeTempDir();
  try {
    const { source, target, engine } = healthy(dir);
    appendRecords(source, 2500, 7);
    const first = engine.advance();
    equal(first.status, "completed");
    equal(first.watermark, 2500);
    assertTargetMatchesSource(source, target);

    appendRecords(source, 500, 7);
    const second = engine.advance();
    equal(second.status, "completed");
    equal(second.watermark, 3000);
    assertTargetMatchesSource(source, target);
  } finally {
    cleanup(dir);
  }
});

test("advance with no new records applies nothing", () => {
  const dir = makeTempDir();
  try {
    const { source, target, engine, receiver: spy } = openEngine(dir, (t) => new SpyReceiver(t));
    const empty = engine.advance();
    equal(empty.status, "completed");
    equal(empty.watermark, 0);
    equal(spy.submissions.length, 0);

    appendRecords(source, 10, 2);
    engine.advance();
    equal(spy.submissions.length, 1);
    const again = engine.advance();
    equal(again.confirmedBatches, 0);
    equal(spy.submissions.length, 1);
    assertTargetMatchesSource(source, target);
  } finally {
    cleanup(dir);
  }
});

test("partial batch apply, then restart resumes and completes", () => {
  const dir = makeTempDir();
  try {
    // First run: receiver applies a prefix of the first batch, then crashes
    // on every submission, so the advance ends incomplete.
    const run1 = openEngine(dir, (t) => new FlakyReceiver(t, 100, 400));
    appendRecords(run1.source, 1500, 5);
    const result1 = run1.engine.advance();
    equal(result1.status, "incomplete");
    equal(result1.pendingBatchId, "r1-b0");
    equal(result1.watermark, 0);
    // Only the 400-record prefix may be applied.
    equal(run1.target.getValue("obj-0"), 80);

    // Restart from the same files with a healthy receiver.
    const run2 = openEngine(dir, (t) => new SpyReceiver(t));
    const result2 = run2.engine.advance();
    equal(result2.status, "completed");
    equal(result2.watermark, 1500);
    // The retried batch keeps its identity and full membership.
    const retried = run2.receiver.submissions.filter((s) => s.batchId === "r1-b0");
    equal(retried.length > 0, true);
    equal(retried[0]?.size, 1000);
    assertTargetMatchesSource(run2.source, run2.target);
  } finally {
    cleanup(dir);
  }
});

test("fully applied batch with lost ack is not applied twice after restart", () => {
  const dir = makeTempDir();
  try {
    // crashAfter >= batch size: everything applied, ack never returned.
    const run1 = openEngine(dir, (t) => new FlakyReceiver(t, 100, 1000));
    appendRecords(run1.source, 1000, 4);
    const result1 = run1.engine.advance();
    equal(result1.status, "incomplete");
    equal(run1.target.getValue("obj-0"), 250);

    // Restart: the target already has the whole batch; redelivery must return
    // the existing ack without re-applying.
    const run2 = openEngine(dir, (t) => new SpyReceiver(t));
    const result2 = run2.engine.advance();
    equal(result2.status, "completed");
    equal(result2.watermark, 1000);
    equal(run2.target.getValue("obj-0"), 250);
    assertTargetMatchesSource(run2.source, run2.target);
  } finally {
    cleanup(dir);
  }
});

test("tail batch pending while source keeps appending; identity and members stay fixed", () => {
  const dir = makeTempDir();
  try {
    // Fail only the tail batch (200 records) of round 1.
    const run1 = openEngine(dir, (t) => new FlakyReceiver(t, 4, 0, "r1-b1"));
    appendRecords(run1.source, 1200, 3);
    const result1 = run1.engine.advance();
    equal(result1.status, "incomplete");
    equal(result1.pendingBatchId, "r1-b1");
    equal(result1.watermark, 1000);
    deepEqual(
      run1.receiver.submissions.map((s) => [s.batchId, s.size]),
      [
        ["r1-b0", 1000],
        ["r1-b1", 200],
        ["r1-b1", 200],
        ["r1-b1", 200],
        ["r1-b1", 200],
      ],
    );

    // More records arrive while r1-b1 is still unconfirmed.
    appendRecords(run1.source, 300, 3);

    // Restart: the pending tail batch keeps id, members and size; the new
    // records are deferred to the next round.
    const run2 = openEngine(dir, (t) => new SpyReceiver(t));
    const result2 = run2.engine.advance();
    equal(result2.status, "completed");
    equal(result2.watermark, 1500);
    deepEqual(
      run2.receiver.submissions.map((s) => [s.batchId, s.size]),
      [
        ["r1-b1", 200],
        ["r2-b0", 300],
      ],
    );
    assertTargetMatchesSource(run2.source, run2.target);
  } finally {
    cleanup(dir);
  }
});

test("four unconfirmed submissions per advance; next advance keeps the same batch", () => {
  const dir = makeTempDir();
  try {
    const run1 = openEngine(dir, () => new SilentReceiver());
    appendRecords(run1.source, 10, 1);

    const first = run1.engine.advance();
    equal(first.status, "incomplete");
    equal(first.pendingBatchId, "r1-b0");
    equal(run1.receiver.submissions.length, 4);

    const second = run1.engine.advance();
    equal(second.status, "incomplete");
    equal(second.pendingBatchId, "r1-b0");
    equal(run1.receiver.submissions.length, 8);

    // Restart and advance with a healthy receiver: same batch, now confirmed.
    const run2 = healthy(dir);
    const third = run2.engine.advance();
    equal(third.status, "completed");
    equal(third.watermark, 10);
    assertTargetMatchesSource(run2.source, run2.target);
  } finally {
    cleanup(dir);
  }
});

test("repeat advance, redelivery of a confirmed batch and reopening change nothing", () => {
  const dir = makeTempDir();
  try {
    const run1 = healthy(dir);
    const target = run1.target;
    appendRecords(run1.source, 1200, 6);
    const done = run1.engine.advance();
    equal(done.status, "completed");
    const before = sortedEntries(target.getAllValues());

    // Repeated advance: no new round, no new submissions.
    const again = run1.engine.advance();
    equal(again.confirmedBatches, 0);
    deepEqual(sortedEntries(target.getAllValues()), before);

    // Redeliver an already-confirmed batch: existing ack, no re-apply.
    const source = new SourceStore(sourceFile(dir));
    const batch: Batch = {
      batchId: "r1-b0",
      round: 1,
      index: 0,
      records: source.range(0, 1000),
    };
    const ack = run1.receiver.submitBatch(batch);
    equal(ack?.batchId, "r1-b0");
    deepEqual(sortedEntries(target.getAllValues()), before);

    // Reopen all stores from disk: values and progress are unchanged.
    const run2 = healthy(dir);
    deepEqual(sortedEntries(run2.target.getAllValues()), before);
    const progress = run2.engine.getProgress();
    equal(progress.watermark, 1200);
    equal(progress.roundActive, false);
    const afterReopen = run2.engine.advance();
    equal(afterReopen.confirmedBatches, 0);
    deepEqual(sortedEntries(run2.target.getAllValues()), before);
    assertTargetMatchesSource(run2.source, run2.target);
  } finally {
    cleanup(dir);
  }
});
