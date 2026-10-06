import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { createQueue } from "../src/index.js";
import type {
  EmitFn,
  LabelQueue,
  LabelSnapshot,
} from "../src/index.js";
import { Gate, Signal, flush, makeImages, tempDbPath } from "./helpers.js";

interface TrainerCall {
  generation: number;
  snapshot: LabelSnapshot;
  emit: EmitFn;
}

test("interleaved generations: 40 publishes before 20 finishes; 20 is discarded", async () => {
  const { path, cleanup } = tempDbPath();
  try {
    const calls: TrainerCall[] = [];
    const called = new Map<number, Signal>();
    const calledSignal = (gen: number): Signal => {
      let s = called.get(gen);
      if (!s) {
        s = new Signal();
        called.set(gen, s);
      }
      return s;
    };
    const gate20 = new Gate();
    const gate20Reached = new Signal();

    const queue: LabelQueue = createQueue(
      path,
      makeImages(60, () => 0.9),
      async (generation, snapshot, features, emit) => {
        calls.push({ generation, snapshot, emit });
        calledSignal(generation).open();
        equal(features.size, 60);
        if (generation === 20) {
          // Emit half, pause, emit the rest after the gate opens.
          const first: Array<readonly [number, number]> = [];
          const rest: Array<readonly [number, number]> = [];
          for (let id = 1; id <= 60; id++) {
            (id <= 30 ? first : rest).push([id, 0.5] as const);
          }
          await emit(first);
          gate20Reached.open();
          await gate20.wait();
          await emit(rest);
        } else if (generation === 40) {
          const all: Array<readonly [number, number]> = [];
          for (let id = 1; id <= 60; id++) all.push([id, 0.1] as const);
          await emit(all);
        } else {
          throw new Error(`unexpected generation ${generation}`);
        }
      },
    );

    // 20 valid changes -> generation 20 starts.
    for (let id = 1; id <= 20; id++) queue.setLabel(id, "cat");
    await calledSignal(20).wait();
    const call20 = calls.find((c) => c.generation === 20);
    ok(call20, "trainer called for generation 20");
    await gate20Reached.wait();

    // Generation 20 emitted half its scores but is paused: queries must
    // still see generation 0 with initial scores only.
    const during20 = queue.getBatch(10);
    equal(during20.generation, 0);
    equal(during20.items.length, 10);
    ok(during20.items.every((item) => item.score === 0.9));
    deepEqual(
      during20.items.map((item) => item.id),
      [21, 22, 23, 24, 25, 26, 27, 28, 29, 30],
    );

    // Snapshot of generation 20: exactly the 20 "cat" labels.
    equal(call20.snapshot.generation, 20);
    equal(call20.snapshot.size, 20);
    equal(call20.snapshot.get(1), "cat");
    equal(call20.snapshot.get(20), "cat");
    equal(call20.snapshot.get(21), undefined);
    ok(!call20.snapshot.has(21));

    // 20 more changes -> generation 40 starts while 20 is still paused.
    for (let id = 21; id <= 40; id++) queue.setLabel(id, "dog");
    await calledSignal(40).wait();
    const call40 = calls.find((c) => c.generation === 40);
    ok(call40, "trainer called for generation 40 while 20 was paused");

    // Snapshot of generation 40 sees all 40 labels.
    equal(call40.snapshot.size, 40);
    equal(call40.snapshot.get(21), "dog");
    equal(call40.snapshot.get(40), "dog");

    // The snapshot of generation 20 is unaffected by the newer labels,
    // even though it is read only now.
    equal(call20.snapshot.size, 20);
    equal(call20.snapshot.get(21), undefined);
    deepEqual(
      [...call20.snapshot.entries()].map(([id, label]) => [id, label]),
      Array.from({ length: 20 }, (_, i) => [i + 1, "cat"]),
    );

    // Generation 40 completes and publishes first.
    await flush();
    const after40 = queue.getBatch(10);
    equal(after40.generation, 40);
    equal(after40.items.length, 10);
    ok(after40.items.every((item) => item.score === 0.1));
    deepEqual(
      after40.items.map((item) => item.id),
      [41, 42, 43, 44, 45, 46, 47, 48, 49, 50],
    );

    // Now let generation 20 finish. It is older than the published
    // generation, so its scores must be discarded entirely.
    gate20.open();
    await flush();
    await flush();
    const final = queue.getBatch(10);
    equal(final.generation, 40);
    ok(final.items.every((item) => item.score === 0.1));

    // Exactly one trainer invocation per generation, in trigger order.
    deepEqual(
      calls.map((c) => c.generation),
      [20, 40],
    );
    queue.close();
  } finally {
    cleanup();
  }
});

test("failed generation keeps the old published generation fully intact", async () => {
  const { path, cleanup } = tempDbPath();
  try {
    const calls: TrainerCall[] = [];
    const called = new Map<number, Signal>();
    const calledSignal = (gen: number): Signal => {
      let s = called.get(gen);
      if (!s) {
        s = new Signal();
        called.set(gen, s);
      }
      return s;
    };
    const gate40 = new Gate();
    const gate40Reached = new Signal();
    const trainerPromises = new Map<number, Promise<void>>();

    const queue = createQueue(
      path,
      makeImages(40, () => 0.5),
      (generation, snapshot, _features, emit) => {
        calls.push({ generation, snapshot, emit });
        calledSignal(generation).open();
        const run = (async () => {
          if (generation === 20) {
            const all: Array<readonly [number, number]> = [];
            for (let id = 1; id <= 40; id++) all.push([id, 0.8] as const);
            await emit(all);
          } else if (generation === 40) {
            // Emit only half of the scores, pause, then fail.
            const half: Array<readonly [number, number]> = [];
            for (let id = 1; id <= 20; id++) half.push([id, 0.1] as const);
            await emit(half);
            gate40Reached.open();
            await gate40.wait();
            throw new Error("training failed");
          } else {
            throw new Error(`unexpected generation ${generation}`);
          }
        })();
        trainerPromises.set(generation, run);
        return run;
      },
    );

    // Generation 20 publishes scores of 0.8 for every image.
    for (let id = 1; id <= 20; id++) queue.setLabel(id, "a");
    await calledSignal(20).wait();
    await trainerPromises.get(20);
    await flush();
    const published = queue.getBatch(100);
    equal(published.generation, 20);
    equal(published.items.length, 20);
    ok(published.items.every((item) => item.score === 0.8));

    // Generation 40 starts, emits half of its scores, then pauses.
    for (let id = 21; id <= 40; id++) queue.setLabel(id, "b");
    await calledSignal(40).wait();
    await gate40Reached.wait();
    const call40 = calls.find((c) => c.generation === 40);
    ok(call40);

    // Mid-generation relabel + withdrawal (changes 41 and 42).
    queue.setLabel(1, "c");
    queue.setLabel(21, null);

    // While generation 40 is paused: still generation 20, no pending
    // scores leak into queries.
    const during = queue.getBatch(100);
    equal(during.generation, 20);
    ok(during.items.every((item) => item.score === 0.8));
    // Every image except 21 is labeled; withdrawn image 21 is the only
    // candidate, and relabeled image 1 stays out.
    deepEqual(
      during.items.map((item) => [item.id, item.score]),
      [[21, 0.8]],
    );

    // The snapshot of generation 40 predates the relabel/withdrawal.
    equal(call40.snapshot.get(1), "a");
    equal(call40.snapshot.get(21), "b");
    equal(call40.snapshot.size, 40);

    // Generation 40 fails: nothing from it may be published.
    gate40.open();
    await trainerPromises.get(40)?.catch(() => {});
    await flush();
    const after = queue.getBatch(100);
    equal(after.generation, 20);
    deepEqual(
      after.items.map((item) => [item.id, item.score]),
      [[21, 0.8]],
    );

    queue.close();
  } finally {
    cleanup();
  }
});

test("a previously last-ranked image jumps to the front in a new generation", async () => {
  const { path, cleanup } = tempDbPath();
  try {
    const started = new Signal();
    const gate = new Gate();
    const gateReached = new Signal();
    let trainerPromise: Promise<void> | null = null;

    // Image 100 ranks last under generation 0 (score 0.01); all others 0.9.
    const queue = createQueue(
      path,
      makeImages(100, (id) => (id === 100 ? 0.01 : 0.9)),
      (generation, _snapshot, _features, emit) => {
        equal(generation, 20);
        started.open();
        trainerPromise = (async () => {
          // New scores: image 100 -> 0.5 (focus interval), others 0.85.
          const scoreOf = (id: number) => (id === 100 ? 0.5 : 0.85);
          const first: Array<readonly [number, number]> = [];
          const rest: Array<readonly [number, number]> = [];
          for (let id = 1; id <= 100; id++) {
            (id <= 50 ? first : rest).push([id, scoreOf(id)] as const);
          }
          await emit(first);
          gateReached.open();
          await gate.wait();
          await emit(rest);
        })();
        return trainerPromise;
      },
    );

    const initial = queue.getBatch(5);
    equal(initial.generation, 0);
    deepEqual(
      initial.items.map((item) => item.id),
      [1, 2, 3, 4, 5],
    );

    for (let id = 1; id <= 20; id++) queue.setLabel(id, "x");
    await started.wait();
    await gateReached.wait();

    // Half of the new generation's scores are stored as pending, but
    // queries must still see the complete old generation: no mixing.
    const during = queue.getBatch(5);
    equal(during.generation, 0);
    deepEqual(
      during.items.map((item) => [item.id, item.score]),
      [
        [21, 0.9],
        [22, 0.9],
        [23, 0.9],
        [24, 0.9],
        [25, 0.9],
      ],
    );

    gate.open();
    await trainerPromise;
    await flush();

    // After publishing generation 20, image 100 (previously last) leads
    // the queue because 0.5 is inside the focus interval [0.35, 0.65].
    // This is impossible if queries reuse a truncated old candidate pool.
    const published = queue.getBatch(5);
    equal(published.generation, 20);
    deepEqual(
      published.items.map((item) => [item.id, item.score]),
      [
        [100, 0.5],
        [21, 0.85],
        [22, 0.85],
        [23, 0.85],
        [24, 0.85],
      ],
    );

    // No score from generation 0 survives anywhere in the new ordering.
    const full = queue.getBatch(100);
    ok(full.items.every((item) => item.score === 0.5 || item.score === 0.85));
    equal(full.items[full.items.length - 1]?.id, 99);

    queue.close();
  } finally {
    cleanup();
  }
});

test("only effective changes count; exactly one generation per 20 changes", async () => {
  const { path, cleanup } = tempDbPath();
  try {
    const generations: number[] = [];
    const genStarted = new Signal();
    const queue = createQueue(
      path,
      makeImages(10, () => 0.5),
      async (generation, _snapshot, _features, emit) => {
        generations.push(generation);
        genStarted.open();
        const all: Array<readonly [number, number]> = [];
        for (let id = 1; id <= 10; id++) all.push([id, 0.7] as const);
        await emit(all);
      },
    );

    // No-op writes do not count.
    queue.setLabel(1, "x");
    queue.setLabel(1, "x"); // same value: no change
    queue.setLabel(2, null); // withdraw an unlabeled image: no change
    queue.setLabel(1, "y"); // relabel: change
    queue.setLabel(1, null); // withdraw: change
    queue.setLabel(1, null); // still unlabeled: no change
    // Effective changes so far: 3 (1=x, 1=y, 1=null).
    for (let id = 2; id <= 10; id++) queue.setLabel(id, "z"); // 9 more -> 12
    for (let id = 2; id <= 8; id++) queue.setLabel(id, null); // 7 more -> 19
    await flush();
    deepEqual(generations, []);

    queue.setLabel(2, "w"); // 20th effective change -> generation 20
    await genStarted.wait();
    deepEqual(generations, [20]);
    await flush();
    equal(queue.getBatch(1).generation, 20);

    queue.close();
  } finally {
    cleanup();
  }
});

test("getBatch validates its argument and never blocks on training", async () => {
  const { path, cleanup } = tempDbPath();
  try {
    const neverOpens = new Gate();
    const started = new Signal();
    const queue = createQueue(
      path,
      makeImages(30, (id) => id / 100),
      async (_generation, _snapshot, _features, emit) => {
        started.open();
        await emit([[1, 0.5]]);
        await neverOpens.wait(); // paused forever: queries must still work
      },
    );
    for (let id = 1; id <= 20; id++) queue.setLabel(id, "a");
    await started.wait();

    const batch = queue.getBatch(0);
    equal(batch.generation, 0);
    deepEqual(batch.items, []);
    equal(queue.getBatch(3).items.length, 3);
    // setLabel also proceeds without waiting for the paused trainer.
    queue.setLabel(21, "b");
    equal(queue.getBatch(10).items.length, 9);

    queue.close();
  } finally {
    cleanup();
  }
});

test("emit rejects invalid scores and rolls back the whole batch", async () => {
  const { path, cleanup } = tempDbPath();
  try {
    const errors: unknown[] = [];
    const started = new Signal();
    const queue = createQueue(
      path,
      makeImages(25, () => 0.5),
      async (generation, _snapshot, _features, emit) => {
        equal(generation, 20);
        started.open();
        // A batch containing an invalid score must be rejected as a whole.
        try {
          await emit([
            [1, 0.9],
            [2, 1.5],
          ]);
        } catch (err) {
          errors.push(err);
        }
        try {
          await emit([[999, 0.5]]);
        } catch (err) {
          errors.push(err);
        }
        // The valid pair above was rolled back too; emit everything now.
        const all: Array<readonly [number, number]> = [];
        for (let id = 1; id <= 25; id++) all.push([id, 0.6] as const);
        await emit(all);
      },
    );
    for (let id = 1; id <= 20; id++) queue.setLabel(id, "a");
    await started.wait();
    await flush();
    await flush();

    equal(errors.length, 2);
    ok(errors.every((err) => err instanceof RangeError));
    const batch = queue.getBatch(10);
    equal(batch.generation, 20);
    ok(batch.items.every((item) => item.score === 0.6));

    queue.close();
  } finally {
    cleanup();
  }
});
