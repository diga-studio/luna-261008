import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ExperimentKernel, type ExperimentData } from "../src/index.js";
import { makeData } from "./helpers.js";

function tmpdb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "al-basic-"));
  return path.join(dir, "test.db");
}

test("createExperiment 校验输入", () => {
  const kernel = new ExperimentKernel({ dbPath: tmpdb() });
  const data = makeData({ seedRows: 4, poolRows: 10, valRows: 4 });
  assert.throws(() =>
    kernel.createExperiment({ ...data, seed: data.seed.filter((r) => r.label === 0) }, 1),
  );
  const dup = makeData({ seedRows: 4, poolRows: 10, valRows: 4 });
  dup.pool[0].id = dup.seed[0].id;
  assert.throws(() => kernel.createExperiment(dup, 1));
  kernel.close();
});

test("runRound 参数校验与轮次顺序", () => {
  const kernel = new ExperimentKernel({ dbPath: tmpdb() });
  const id = kernel.createExperiment(makeData({ poolRows: 100 }), 7);
  assert.throws(() => kernel.runRound(id, "uncertainty", 0));
  assert.throws(() => kernel.runRound(id, "uncertainty", 2));
  assert.throws(() => kernel.runRound("no-such-id", "uncertainty", 1));
  assert.throws(() => kernel.runRound(id, "bogus" as never, 1));
  kernel.close();
});

test("已提交轮重试返回原结果且不推进", () => {
  const kernel = new ExperimentKernel({ dbPath: tmpdb() });
  const id = kernel.createExperiment(makeData({ poolRows: 100 }), 7);
  const first = kernel.runRound(id, "uncertainty", 1);
  const retry = kernel.runRound(id, "uncertainty", 1);
  assert.deepStrictEqual(retry, first);
  assert.strictEqual(kernel.readResults(id).strategies.uncertainty.rounds.length, 1);
  kernel.close();
});

test("uncertainty 选样：分数升序、同分按ID升序", () => {
  const data: ExperimentData = {
    seed: [
      { id: 1, features: [0, 0], label: 0 },
      { id: 2, features: [4, 4], label: 1 },
    ],
    pool: [
      { id: 10, features: [0, 0], truth: 0 },
      { id: 11, features: [2, 2], truth: 1 },
      { id: 12, features: [1, 1], truth: 0 },
      { id: 13, features: [3, 3], truth: 1 },
      { id: 14, features: [2, 0], truth: 0 },
    ],
    validation: [
      { id: 20, features: [2, 2], label: 0 }, // 距离相等 -> 预测0 -> 正确
      { id: 21, features: [4, 4], label: 1 },
    ],
  };
  const kernel = new ExperimentKernel({ dbPath: tmpdb() });
  const id = kernel.createExperiment(data, 1);
  const r1 = kernel.runRound(id, "uncertainty", 1)!;
  assert.deepStrictEqual(r1.selectedIds, [11, 12, 13, 14, 10]);
  assert.strictEqual(r1.cumulativeBudget, 5);
  // 收齐本轮标签后重训：mean0=[0.75,0.25], mean1=[3,3]
  // [2,2] 预测为1(错)，[4,4] 预测为1(对)
  assert.strictEqual(r1.validationAccuracy, 0.5);
  kernel.close();
});

test("距离相等时预测为0", async () => {
  const { predict } = await import("../src/model.js");
  const model = { mean0: [0, 0], mean1: [4, 4] };
  assert.strictEqual(predict(model, [2, 2]), 0);
  assert.strictEqual(predict(model, [3, 3]), 1);
  assert.strictEqual(predict(model, [1, 1]), 0);
});

test("池耗尽结束：不足一批取剩余全部，之后返回 null", () => {
  const kernel = new ExperimentKernel({ dbPath: tmpdb() });
  const id = kernel.createExperiment(makeData({ poolRows: 200 }), 7);
  const budgets: number[] = [];
  for (let r = 1; r <= 8; r++) {
    const res = kernel.runRound(id, "random", r);
    if (res === null) break;
    budgets.push(res.cumulativeBudget);
  }
  assert.deepStrictEqual(budgets, [32, 64, 96, 128, 160, 192, 200]);
  assert.strictEqual(kernel.runRound(id, "random", 8), null);
  kernel.close();
});

test("最多20轮", () => {
  const kernel = new ExperimentKernel({ dbPath: tmpdb() });
  const id = kernel.createExperiment(makeData({ poolRows: 1000 }), 7);
  for (let r = 1; r <= 20; r++) {
    assert.notStrictEqual(kernel.runRound(id, "uncertainty", r), null);
  }
  assert.strictEqual(kernel.runRound(id, "uncertainty", 21), null);
  kernel.close();
});

test("累计预算只计本策略已提交新标签，种子不计费，策略间互不影响", () => {
  const kernel = new ExperimentKernel({ dbPath: tmpdb() });
  const id = kernel.createExperiment(makeData({ seedRows: 6, poolRows: 100 }), 7);
  const u1 = kernel.runRound(id, "uncertainty", 1)!;
  const r1 = kernel.runRound(id, "random", 1)!;
  assert.strictEqual(u1.cumulativeBudget, 32);
  assert.strictEqual(r1.cumulativeBudget, 32);
  // 两策略选样独立：random 的选择不影响 uncertainty 第2轮
  const kernel2 = new ExperimentKernel({ dbPath: tmpdb() });
  const id2 = kernel2.createExperiment(makeData({ seedRows: 6, poolRows: 100 }), 7);
  kernel2.runRound(id2, "uncertainty", 1);
  const u2solo = kernel2.runRound(id2, "uncertainty", 2)!;
  const u2 = kernel.runRound(id, "uncertainty", 2)!;
  assert.deepStrictEqual(u2.selectedIds, u2solo.selectedIds);
  kernel.close();
  kernel2.close();
});

test("仅改变尚未查询的真值，当前批次不变", () => {
  const data = makeData({ poolRows: 200 });
  const run = (mutate: boolean): number[] => {
    const dbPath = tmpdb();
    const kernel = new ExperimentKernel({ dbPath });
    const id = kernel.createExperiment(data, 7);
    kernel.runRound(id, "uncertainty", 1);
    if (mutate) {
      const db = new DatabaseSync(dbPath);
      db.prepare("UPDATE pool_rows SET truth = 1 - truth WHERE strategy = 'uncertainty' AND available = 1").run();
      db.close();
    }
    const r2 = kernel.runRound(id, "uncertainty", 2)!;
    kernel.close();
    return r2.selectedIds;
  };
  assert.deepStrictEqual(run(true), run(false));
});

test("交换策略执行顺序，各自完整轨迹不变", () => {
  const data = makeData({ poolRows: 200 });
  const runInterleaved = (interleave: boolean) => {
    const kernel = new ExperimentKernel({ dbPath: tmpdb() });
    const id = kernel.createExperiment(data, 7);
    if (interleave) {
      for (let r = 1; r <= 20; r++) {
        const u = kernel.runRound(id, "uncertainty", r);
        const rr = kernel.runRound(id, "random", r);
        if (u === null && rr === null) break;
      }
    } else {
      for (const s of ["uncertainty", "random"] as const) {
        for (let r = 1; r <= 20; r++) if (kernel.runRound(id, s, r) === null) break;
      }
    }
    const results = kernel.readResults(id);
    kernel.close();
    return results.strategies;
  };
  assert.deepStrictEqual(runInterleaved(true), runInterleaved(false));
});

test("相同输入和seed的两次不间断执行轨迹一致", () => {
  const data = makeData({ poolRows: 200 });
  const run = () => {
    const kernel = new ExperimentKernel({ dbPath: tmpdb() });
    const id = kernel.createExperiment(data, 999);
    for (const s of ["uncertainty", "random"] as const) {
      for (let r = 1; r <= 20; r++) if (kernel.runRound(id, s, r) === null) break;
    }
    const results = kernel.readResults(id);
    kernel.close();
    return results.strategies;
  };
  assert.deepStrictEqual(run(), run());
});
