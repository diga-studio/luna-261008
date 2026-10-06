import assert from "node:assert/strict";
import test from "node:test";
import {
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

const EMP = "emp-view";
const EXERCISES = ["squat", "press"];

async function seedSegment(
  store: TrainingStore,
  batchId: string,
  segment: number,
  weight: number,
): Promise<void> {
  const batch = await store.beginBatch(EMP, batchId);
  for (const op of fillSegmentOps(EMP, "squat", segment, 0, {
    weightLbs: weight,
    reps: 10,
  })) {
    await batch.add(op);
  }
  await batch.commit();
}

test("旧视图分段读取期间的新提交不混入；新视图与独立推导一致", async () => {
  const store = new TrainingStore(tempDbPath());
  await store.createCycle(EMP, EXERCISES);
  // squat 第 1、2 段达标：推荐曲线 40, 45, 50, ...
  await seedSegment(store, "seed-1", 1, 40);
  await seedSegment(store, "seed-2", 2, 45);

  // 打开旧视图并慢速读第 1 段。
  const oldReader = await store.openReader(EMP);
  const oldVersion = oldReader.committedVersion;
  const oldSeg1 = await oldReader.readSegment(1);
  const oldSquat1 = oldSeg1.exercises.find((e) => e.exerciseId === "squat");
  assert.equal(oldSquat1?.recommendationLbs, 40);
  assert.equal(oldSquat1?.sets.filter(Boolean).length, SETS_PER_SEGMENT);

  // 提交一次更正：撤回第 1 段一组 → 连锁改变后续推荐（45→40, 50→45）。
  const withdrawn = setPosInSegment(1, 5);
  const fix = await store.beginBatch(EMP, "withdraw-1");
  await fix.add({
    key: keyOf(EMP, "squat", withdrawn.week, withdrawn.session, withdrawn.set),
    baseVersion: 1,
  });
  const fixReceipt = await fix.commit();
  assert.ok(fixReceipt.committedVersion > oldVersion);

  // 旧视图继续读后续段：记录与曲线仍是旧的已提交状态。
  const oldSeg2 = await oldReader.readSegment(2);
  const oldSeg3 = await oldReader.readSegment(3);
  assert.equal(oldSeg2.committedVersion, oldVersion);
  assert.equal(
    oldSeg2.exercises.find((e) => e.exerciseId === "squat")?.recommendationLbs,
    45,
  );
  assert.equal(
    oldSeg3.exercises.find((e) => e.exerciseId === "squat")?.recommendationLbs,
    50,
  );
  const oldSeg1Again = await oldReader.readSegment(1);
  assert.equal(
    oldSeg1Again.exercises
      .find((e) => e.exerciseId === "squat")
      ?.sets.filter(Boolean).length,
    SETS_PER_SEGMENT,
    "旧视图中被撤回的组仍然存在",
  );
  await oldReader.close();

  // 新视图：包含撤回后的完整状态，且与独立推导一致。
  const newReader = await store.openReader(EMP);
  assert.equal(newReader.committedVersion, fixReceipt.committedVersion);
  const records = new Map<string, SetEntry>();
  const recs: number[] = [];
  for (let seg = 1; seg <= SEGMENTS_PER_CYCLE; seg++) {
    const view = await newReader.readSegment(seg);
    const squat = view.exercises.find((e) => e.exerciseId === "squat");
    assert.ok(squat);
    recs.push(squat.recommendationLbs);
    squat.sets.forEach((entry, i) => {
      if (entry) {
        const pos = setPosInSegment(seg, i);
        records.set(`squat|${pos.week}|${pos.session}|${pos.set}`, entry);
      }
    });
  }
  assert.equal(recs[1], 40, "第 2 段推荐应连锁下调");
  assert.equal(recs[2], 45, "第 3 段推荐应连锁下调");
  assert.deepEqual(recs, independentCurve("squat", records));
  const newSeg1 = await newReader.readSegment(1);
  assert.equal(
    newSeg1.exercises
      .find((e) => e.exerciseId === "squat")
      ?.sets.filter(Boolean).length,
    SETS_PER_SEGMENT - 1,
  );
  await newReader.close();
  await store.close();
});

test("同员工批次输入停顿 5 秒不阻塞其他提交与新视图", async () => {
  const store = new TrainingStore(tempDbPath());
  await store.createCycle(EMP, EXERCISES);

  // 一个批次输入中途停顿（5 秒后才会继续，测试结束前不会提交）。
  const stalled = await store.beginBatch(EMP, "stalled");
  await stalled.add({
    key: keyOf(EMP, "press", 1, 1, 1),
    baseVersion: 0,
    entry: { weightLbs: 40, reps: 10 },
  });
  const stallTimer = setTimeout(() => {
    void stalled.commit().catch(() => undefined);
  }, 5000);

  // 另一个已收齐的 10 组批次须在 500ms 内完成提交。
  const fast = await store.beginBatch(EMP, "fast-10");
  for (let i = 0; i < 10; i++) {
    const pos = setPosInSegment(1, i);
    await fast.add({
      key: keyOf(EMP, "squat", pos.week, pos.session, pos.set),
      baseVersion: 0,
      entry: { weightLbs: 40, reps: 10 },
    });
  }
  const t0 = performance.now();
  const receipt = await fast.commit();
  const commitMs = performance.now() - t0;
  assert.ok(
    commitMs < 500,
    `10 组批次提交耗时 ${commitMs.toFixed(1)}ms，超过 500ms`,
  );

  // 新读取视图须在 500ms 内打开，且包含该提交。
  const t1 = performance.now();
  const reader = await store.openReader(EMP);
  const openMs = performance.now() - t1;
  assert.ok(openMs < 500, `打开视图耗时 ${openMs.toFixed(1)}ms，超过 500ms`);
  assert.equal(reader.committedVersion, receipt.committedVersion);
  const seg1 = await reader.readSegment(1);
  assert.equal(
    seg1.exercises
      .find((e) => e.exerciseId === "squat")
      ?.sets.filter(Boolean).length,
    10,
  );
  await reader.close();

  clearTimeout(stallTimer);
  await stalled.abort();
  await store.close();
});
