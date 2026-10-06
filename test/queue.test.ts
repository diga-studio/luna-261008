import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createQueue } from "../src/queue";
import type { Queue } from "../src/types";
import {
  TrainerRig,
  expectedOrder,
  flush,
  makeImages,
} from "./helpers";

function withQueue(
  imageCount: number,
  scoreOf: (id: number) => number,
  fn: (queue: Queue, rig: TrainerRig) => void | Promise<void>
): Promise<void> | void {
  const dir = mkdtempSync(join(tmpdir(), "alq-test-"));
  const rig = new TrainerRig();
  const queue = createQueue(
    join(dir, "queue.db"),
    makeImages(imageCount, scoreOf),
    rig.trainer
  );
  const cleanup = (): void => {
    queue.close();
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    const result = fn(queue, rig);
    if (result instanceof Promise) {
      return result.finally(cleanup);
    }
    cleanup();
    return undefined;
  } catch (err) {
    cleanup();
    throw err;
  }
}

function labelRange(queue: Queue, from: number, to: number, label: string): void {
  for (let id = from; id <= to; id++) {
    queue.setLabel(id, label);
  }
}

function ids(items: Array<{ id: number }>): number[] {
  return items.map((item) => item.id);
}

test("orders generation 0 by band, score desc, id asc", () => {
  const scores = new Map([
    [1, 0.5],
    [2, 0.9],
    [3, 0.4],
    [4, 0.1],
    [5, 0.5],
    [6, 0.65],
  ]);
  withQueue(6, (id) => scores.get(id) ?? 0, (queue) => {
    const batch = queue.getBatch(10);
    equal(batch.generation, 0);
    deepEqual(ids(batch.items), [6, 1, 5, 3, 2, 4]);
    deepEqual(
      batch.items.map((item) => item.score),
      [0.65, 0.5, 0.5, 0.4, 0.9, 0.1]
    );
    deepEqual(ids(queue.getBatch(2).items), [6, 1]);

    queue.setLabel(1, "cat");
    deepEqual(ids(queue.getBatch(10).items), [6, 5, 3, 2, 4]);
    queue.setLabel(1, null);
    deepEqual(ids(queue.getBatch(10).items), [6, 1, 5, 3, 2, 4]);
  });
});

test("counts only effective changes and rejects unknown images", () => {
  withQueue(25, () => 0.9, (queue, rig) => {
    labelRange(queue, 1, 19, "a");
    queue.setLabel(1, "a"); // same value: not a change
    queue.setLabel(20, null); // never labelled: not a change
    deepEqual(rig.startedGenerations, []);
    queue.setLabel(20, "a");
    deepEqual(rig.startedGenerations, [20]);

    let threw = false;
    try {
      queue.setLabel(999, "x");
    } catch {
      threw = true;
    }
    ok(threw, "setLabel on an unknown image id must throw");
  });
});

test("interleaved generations 20 and 40: newer wins, older finishing last does not regress", async () => {
  await withQueue(50, () => 0.9, async (queue, rig) => {
    labelRange(queue, 1, 20, "a");
    deepEqual(rig.startedGenerations, [20]);

    // 20 more effective changes while generation 20 is still paused.
    labelRange(queue, 1, 10, "b");
    labelRange(queue, 21, 30, "a");
    deepEqual(rig.startedGenerations, [20, 40]);

    // Snapshots are frozen at trigger time.
    const snap20 = rig.run(20).labels;
    const snap40 = rig.run(40).labels;
    equal(snap20.size, 20);
    equal(snap20.get(1), "a");
    equal(snap40.size, 30);
    equal(snap40.get(1), "b");
    equal(snap40.get(21), "a");
    deepEqual(rig.run(20).features.get(7), [7, 14]);

    // Interleaved output: generation 20 first, then 40, then 20 again.
    const gen40Scores = new Map<number, number>();
    for (let id = 1; id <= 50; id++) {
      gen40Scores.set(id, ((id * 37) % 51) / 51);
    }
    const first: Array<readonly [number, number]> = [];
    const rest: Array<readonly [number, number]> = [];
    for (let id = 1; id <= 50; id++) {
      (id <= 25 ? first : rest).push([id, 0.3]);
    }
    await rig.run(20).emitAll(first);
    await rig.run(40).emitAll(gen40Scores);
    await rig.run(20).emitAll(rest);

    // Nothing published yet: queries still see generation 0 only.
    const unlabelled = Array.from({ length: 20 }, (_, i) => 31 + i);
    const before = queue.getBatch(5);
    equal(before.generation, 0);
    deepEqual(ids(before.items), [31, 32, 33, 34, 35]);
    ok(before.items.every((item) => item.score === 0.9));

    // Generation 40 completes and publishes first.
    rig.run(40).succeed();
    await flush();
    const after40 = queue.getBatch(5);
    equal(after40.generation, 40);
    const expected40 = expectedOrder(gen40Scores, unlabelled).slice(0, 5);
    deepEqual(
      after40.items,
      expected40.map((id) => ({ id, score: gen40Scores.get(id) }))
    );

    // Generation 20 completes last: it must not overwrite generation 40.
    rig.run(20).succeed();
    await flush();
    const after20 = queue.getBatch(50);
    equal(after20.generation, 40);
    deepEqual(
      after20.items,
      expectedOrder(gen40Scores, unlabelled).map((id) => ({
        id,
        score: gen40Scores.get(id),
      }))
    );
    ok(after20.items.every((item) => item.score !== 0.3));
  });
});

test("failed generation after relabel and withdrawal keeps the old generation intact", async () => {
  const initial = new Map<number, number>();
  for (let id = 1; id <= 30; id++) {
    initial.set(id, 0.9 - id * 0.02);
  }
  await withQueue(30, (id) => initial.get(id) ?? 0, async (queue, rig) => {
    labelRange(queue, 1, 20, "a");
    const run = rig.run(20);

    // Half of the new generation's scores are emitted...
    const half: Array<readonly [number, number]> = [];
    for (let id = 1; id <= 15; id++) {
      half.push([id, 0.5]);
    }
    await run.emitAll(half);

    // ...then labels change: relabel image 1, withdraw image 2.
    queue.setLabel(1, "b");
    queue.setLabel(2, null);
    deepEqual(rig.startedGenerations, [20]);

    // ...and the training fails.
    run.fail(new Error("training blew up"));
    await flush();

    // The old generation is fully intact; eligibility follows current labels.
    const unlabelled = [2, ...Array.from({ length: 10 }, (_, i) => 21 + i)];
    const batch = queue.getBatch(30);
    equal(batch.generation, 0);
    deepEqual(
      batch.items,
      expectedOrder(initial, unlabelled).map((id) => ({
        id,
        score: initial.get(id),
      }))
    );
    ok(batch.items.some((item) => item.id === 2 && item.score === initial.get(2)));
    ok(batch.items.every((item) => item.id !== 1));
    ok(batch.items.every((item) => item.score !== 0.5));
  });
});

test("a back-ranked image jumps to the front under a complete new generation", async () => {
  await withQueue(60, (id) => (id === 60 ? 0.01 : 0.9), async (queue, rig) => {
    labelRange(queue, 1, 20, "a");
    const run = rig.run(20);

    // Before publishing, image 60 is the very last candidate.
    const before = queue.getBatch(60);
    equal(before.items[before.items.length - 1].id, 60);

    const scores: Array<readonly [number, number]> = [];
    for (let id = 1; id <= 60; id++) {
      scores.push([id, id === 60 ? 0.5 : 0.8]);
    }
    await run.emitAll(scores);
    run.succeed();
    await flush();

    // Image 60 leads the queue; no stale or mixed scores anywhere.
    const top = queue.getBatch(3);
    equal(top.generation, 20);
    deepEqual(top.items, [
      { id: 60, score: 0.5 },
      { id: 21, score: 0.8 },
      { id: 22, score: 0.8 },
    ]);
    const all = queue.getBatch(60);
    equal(all.items.length, 40);
    deepEqual(ids(all.items), [60, ...Array.from({ length: 39 }, (_, i) => 21 + i)]);
    ok(all.items.every((item) => item.score === 0.5 || item.score === 0.8));
  });
});

test("invalid emitted scores fail the generation without touching the published one", async () => {
  await withQueue(25, () => 0.9, async (queue, rig) => {
    labelRange(queue, 1, 20, "a");
    const run = rig.run(20);

    let rejected = false;
    try {
      await run.emit(1, 1.5);
    } catch {
      rejected = true;
    }
    ok(rejected, "emit must reject scores outside [0, 1]");

    const scores: Array<readonly [number, number]> = [];
    for (let id = 1; id <= 25; id++) {
      scores.push([id, 0.5]);
    }
    await run.emitAll(scores);
    run.succeed();
    await flush();

    const batch = queue.getBatch(5);
    equal(batch.generation, 0);
    ok(batch.items.every((item) => item.score === 0.9));
  });
});
