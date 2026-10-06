import assert from "node:assert/strict";
import test from "node:test";
import {
  CommitRejected,
  SEGMENTS_PER_CYCLE,
  SETS_PER_SEGMENT,
  SetEntry,
  TrainingStore,
} from "../src/index";
import {
  fillSegmentOps,
  independentCurve,
  keyOf,
  setPosInSegment,
  tempDbPath,
} from "./helpers";

const EMP = "emp-conc";
const EXERCISES = ["squat", "bench"];

async function readAllRecords(
  store: TrainingStore,
): Promise<{ records: Map<string, SetEntry>; recs: Map<string, number[]> }> {
  const reader = await store.openReader(EMP);
  const records = new Map<string, SetEntry>();
  const recs = new Map<string, number[]>();
  for (let seg = 1; seg <= SEGMENTS_PER_CYCLE; seg++) {
    const view = await reader.readSegment(seg);
    for (const ex of view.exercises) {
      if (!recs.has(ex.exerciseId)) recs.set(ex.exerciseId, []);
      (recs.get(ex.exerciseId) as number[]).push(ex.recommendationLbs);
      ex.sets.forEach((entry, i) => {
        if (entry) {
          const pos = setPosInSegment(seg, i);
          records.set(
            `${ex.exerciseId}|${pos.week}|${pos.session}|${pos.set}`,
            entry,
          );
        }
      });
    }
  }
  await reader.close();
  return { records, recs };
}

test("并发更正同一段的不同组：两批均成功，曲线与从头推导一致", async () => {
  const store = new TrainingStore(tempDbPath());
  await store.createCycle(EMP, EXERCISES);

  // 打底：squat 第 1、2 段全部按推荐重量完成（40、45 磅，每组 10 次）。
  for (const [segment, weight] of [
    [1, 40],
    [2, 45],
  ] as const) {
    const batch = await store.beginBatch(EMP, `seed-seg${segment}`);
    for (const op of fillSegmentOps(EMP, "squat", segment, 0, {
      weightLbs: weight,
      reps: 10,
    })) {
      await batch.add(op);
    }
    await batch.commit();
  }

  // 两个批次并发更正同一段的不同组（都依据各自组的当前版本 1）。
  const posA = setPosInSegment(2, 0);
  const posB = setPosInSegment(2, 1);
  const batchA = await store.beginBatch(EMP, "fix-A");
  await batchA.add({
    key: keyOf(EMP, "squat", posA.week, posA.session, posA.set),
    baseVersion: 1,
    entry: { weightLbs: 50, reps: 12 },
  });
  const batchB = await store.beginBatch(EMP, "fix-B");
  await batchB.add({
    key: keyOf(EMP, "squat", posB.week, posB.session, posB.set),
    baseVersion: 1,
    entry: { weightLbs: 50, reps: 11 },
  });
  const [receiptA, receiptB] = await Promise.all([
    batchA.commit(),
    batchB.commit(),
  ]);
  assert.notEqual(receiptA.commitId, receiptB.commitId);
  assert.ok(receiptA.committedVersion !== receiptB.committedVersion);

  // 最终曲线必须与对最终记录从头独立推导完全一致。
  const { records, recs } = await readAllRecords(store);
  for (const ex of EXERCISES) {
    assert.deepEqual(recs.get(ex), independentCurve(ex, records));
  }
  // 两处更正都在。
  const stateA = await store.getSetState(EMP, "squat", posA.week, posA.session, posA.set);
  const stateB = await store.getSetState(EMP, "squat", posB.week, posB.session, posB.set);
  assert.deepEqual(stateA.entry, { weightLbs: 50, reps: 12 });
  assert.deepEqual(stateB.entry, { weightLbs: 50, reps: 11 });
  await store.close();
});

test("依据相同组版本的重叠批次只能成功一个，失败批次不留修改", async () => {
  const store = new TrainingStore(tempDbPath());
  await store.createCycle(EMP, EXERCISES);

  const seed = await store.beginBatch(EMP, "seed");
  await seed.add({
    key: keyOf(EMP, "bench", 1, 1, 1),
    baseVersion: 0,
    entry: { weightLbs: 40, reps: 10 },
  });
  await seed.commit();

  // 两个批次都依据 bench(1,1,1) 的版本 1，且各自还带一条不重叠的修改。
  const batchA = await store.beginBatch(EMP, "overlap-A");
  await batchA.add({
    key: keyOf(EMP, "bench", 1, 1, 1),
    baseVersion: 1,
    entry: { weightLbs: 45, reps: 10 },
  });
  await batchA.add({
    key: keyOf(EMP, "bench", 1, 1, 2),
    baseVersion: 0,
    entry: { weightLbs: 40, reps: 10 },
  });
  const batchB = await store.beginBatch(EMP, "overlap-B");
  await batchB.add({
    key: keyOf(EMP, "bench", 1, 1, 1),
    baseVersion: 1,
    entry: { weightLbs: 50, reps: 12 },
  });
  await batchB.add({
    key: keyOf(EMP, "bench", 1, 1, 3),
    baseVersion: 0,
    entry: { weightLbs: 40, reps: 10 },
  });

  const results = await Promise.allSettled([batchA.commit(), batchB.commit()]);
  const succeeded = results.filter((r) => r.status === "fulfilled");
  const failed = results.filter((r) => r.status === "rejected");
  assert.equal(succeeded.length, 1);
  assert.equal(failed.length, 1);
  assert.ok(
    (failed[0] as PromiseRejectedResult).reason instanceof CommitRejected,
  );
  assert.equal(
    ((failed[0] as PromiseRejectedResult).reason as CommitRejected).reason,
    "VERSION_CONFLICT",
  );

  // 失败批次不留下任何修改：它独有的那条记录不存在。
  const winnerIsA =
    results[0].status === "fulfilled" ;
  const head = await store.getSetState(EMP, "bench", 1, 1, 1);
  assert.deepEqual(
    head.entry,
    winnerIsA ? { weightLbs: 45, reps: 10 } : { weightLbs: 50, reps: 12 },
  );
  assert.equal(head.version, 2);
  const loserOnly = await store.getSetState(
    EMP,
    "bench",
    1,
    1,
    winnerIsA ? 3 : 2,
  );
  assert.equal(loserOnly.version, 0);
  assert.equal(loserOnly.entry, null);
  const winnerOnly = await store.getSetState(
    EMP,
    "bench",
    1,
    1,
    winnerIsA ? 2 : 3,
  );
  assert.deepEqual(winnerOnly.entry, { weightLbs: 40, reps: 10 });

  // 曲线仍与独立推导一致。
  const { records, recs } = await readAllRecords(store);
  for (const ex of EXERCISES) {
    assert.deepEqual(recs.get(ex), independentCurve(ex, records));
  }
  await store.close();
});
