import assert from "node:assert/strict";
import test from "node:test";
import {
  SEGMENTS_PER_CYCLE,
  SetEntry,
  TrainingStore,
} from "../src/index";
import { independentCurve, keyOf, setPosInSegment, tempDbPath } from "./helpers";

const EMPLOYEES = 100;
const EXERCISES_PER_EMPLOYEE = 20;

function exerciseIds(): string[] {
  return Array.from({ length: EXERCISES_PER_EMPLOYEE }, (_, i) => `ex${i}`);
}

async function submitFullCycle(
  store: TrainingStore,
  employeeId: string,
  batchId: string,
): Promise<void> {
  const batch = await store.beginBatch(employeeId, batchId);
  for (const ex of exerciseIds()) {
    for (let week = 1; week <= 52; week++) {
      for (let session = 1; session <= 3; session++) {
        for (let set = 1; set <= 3; set++) {
          const segment = Math.ceil(week / 2);
          await batch.add({
            key: { employeeId, exerciseId: ex, week, session, set },
            baseVersion: 0,
            entry: { weightLbs: 40 + (segment - 1) * 5, reps: 10 },
          });
        }
      }
    }
  }
  await batch.commit();
}

test(
  "规模：100 员工 × 20 动作 × 52 周，32 个批次同时输入",
  { timeout: 120_000 },
  async () => {
    const store = new TrainingStore(tempDbPath());
    const employees = Array.from(
      { length: EMPLOYEES },
      (_, i) => `emp-${i}`,
    );
    for (const emp of employees) {
      await store.createCycle(emp, exerciseIds());
    }

    // 32 个批次同时输入并提交（不同员工，互不阻塞）。
    const t0 = performance.now();
    const concurrent = employees.slice(0, 32).map((emp, i) =>
      submitFullCycle(store, emp, `full-${i}`),
    );
    await Promise.all(concurrent);
    const ms32 = performance.now() - t0;
    console.log(`32 个整周期批次并发提交耗时 ${ms32.toFixed(0)}ms`);

    // 其余员工串行补齐。
    for (let i = 32; i < EMPLOYEES; i++) {
      await submitFullCycle(store, employees[i] as string, `full-${i}`);
    }

    // 抽查：曲线与独立推导一致（全部 18 组达标 → 每段 +5）。
    const reader = await store.openReader("emp-0");
    const recs: number[] = [];
    const records = new Map<string, SetEntry>();
    for (let seg = 1; seg <= SEGMENTS_PER_CYCLE; seg++) {
      const view = await reader.readSegment(seg);
      const ex0 = view.exercises.find((e) => e.exerciseId === "ex0");
      assert.ok(ex0);
      recs.push(ex0.recommendationLbs);
      ex0.sets.forEach((entry, i) => {
        if (entry) {
          const pos = setPosInSegment(seg, i);
          records.set(`ex0|${pos.week}|${pos.session}|${pos.set}`, entry);
        }
      });
    }
    assert.deepEqual(recs, independentCurve("ex0", records));
    assert.equal(recs[25], 40 + 25 * 5);
    await reader.close();

    // 满负荷下：停顿批次不阻塞同员工的 10 组批次与新视图。
    const stalled = await store.beginBatch("emp-0", "stalled-scale");
    await stalled.add({
      key: keyOf("emp-0", "ex1", 1, 1, 1),
      baseVersion: 0,
      entry: { weightLbs: 40, reps: 10 },
    });
    const stallTimer = setTimeout(() => {
      void stalled.commit().catch(() => undefined);
    }, 5000);

    const fast = await store.beginBatch("emp-0", "fast-scale");
    for (let i = 0; i < 10; i++) {
      const pos = setPosInSegment(1, i);
      await fast.add({
        key: keyOf("emp-0", "ex2", pos.week, pos.session, pos.set),
        baseVersion: 1,
        entry: { weightLbs: 45, reps: 12 },
      });
    }
    const t1 = performance.now();
    await fast.commit();
    const commitMs = performance.now() - t1;
    assert.ok(commitMs < 500, `提交耗时 ${commitMs.toFixed(1)}ms 超过 500ms`);

    const t2 = performance.now();
    const reader2 = await store.openReader("emp-0");
    const openMs = performance.now() - t2;
    assert.ok(openMs < 500, `打开视图耗时 ${openMs.toFixed(1)}ms 超过 500ms`);
    await reader2.close();

    clearTimeout(stallTimer);
    await stalled.abort();
    await store.close();
  },
);
