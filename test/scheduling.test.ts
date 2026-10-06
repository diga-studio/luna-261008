import { test } from "node:test";
import assert from "node:assert/strict";
import { replay } from "../src/index.js";
import type { SimInput } from "../src/index.js";

test("两个活动间的排队传播（手算核对）", () => {
  // A 容量1 恒定时长10，B 容量1 恒定时长5；c1、c2 同时在0到达，路径均为 [A,B]
  const input: SimInput = {
    activities: {
      A: { samples: [10], capacity: 1 },
      B: { samples: [5], capacity: 1 },
    },
    cases: [
      { id: "c1", arrival: 0, activities: ["A", "B"] },
      { id: "c2", arrival: 0, activities: ["A", "B"] },
    ],
  };
  const r = replay(input, {}, 42, 0);
  const step = (caseId: string, index: number) =>
    r.steps.find((s) => s.caseId === caseId && s.index === index)!;
  // c1 先派发（就绪相同，caseId 字典序优先）
  assert.deepEqual(step("c1", 0), { caseId: "c1", index: 0, activity: "A", ready: 0, start: 0, end: 10 });
  assert.deepEqual(step("c1", 1), { caseId: "c1", index: 1, activity: "B", ready: 10, start: 10, end: 15 });
  // c2 在 A 上排队到 10，B 上无需再等
  assert.deepEqual(step("c2", 0), { caseId: "c2", index: 0, activity: "A", ready: 0, start: 10, end: 20 });
  assert.deepEqual(step("c2", 1), { caseId: "c2", index: 1, activity: "B", ready: 20, start: 20, end: 25 });
  assert.deepEqual(r.completions, [
    { caseId: "c1", completion: 15 },
    { caseId: "c2", completion: 25 },
  ]);
});

test("重复活动串行执行", () => {
  const input: SimInput = {
    activities: {
      A: { samples: [3], capacity: 1 },
      B: { samples: [2], capacity: 1 },
    },
    cases: [{ id: "c1", arrival: 0, activities: ["A", "B", "A"] }],
  };
  const r = replay(input, {}, 1, 0);
  assert.deepEqual(
    r.steps.map((s) => [s.index, s.ready, s.start, s.end]),
    [
      [0, 0, 0, 3],
      [1, 3, 3, 5],
      [2, 5, 5, 8],
    ],
  );
  assert.deepEqual(r.completions, [{ caseId: "c1", completion: 8 }]);
});

test("同刻完成与零时长级联", () => {
  // A 容量2 恒定时长4：c1、c2 同时开始同时完成
  const input: SimInput = {
    activities: { A: { samples: [4], capacity: 2 } },
    cases: [
      { id: "c1", arrival: 0, activities: ["A"] },
      { id: "c2", arrival: 0, activities: ["A"] },
    ],
  };
  const r = replay(input, {}, 7, 0);
  assert.deepEqual(r.completions, [
    { caseId: "c1", completion: 4 },
    { caseId: "c2", completion: 4 },
  ]);
  for (const s of r.steps) {
    assert.equal(s.start, 0);
    assert.equal(s.end, 4);
  }

  // 零时长级联：A 时长0，两个 A 步骤与 B 在同一时刻链式就绪
  const zero: SimInput = {
    activities: {
      A: { samples: [0], capacity: 1 },
      B: { samples: [7], capacity: 1 },
    },
    cases: [{ id: "z", arrival: 5, activities: ["A", "A", "B"] }],
  };
  const rz = replay(zero, {}, 7, 0);
  assert.deepEqual(
    rz.steps.map((s) => [s.index, s.ready, s.start, s.end]),
    [
      [0, 5, 5, 5],
      [1, 5, 5, 5],
      [2, 5, 5, 12],
    ],
  );
  assert.deepEqual(rz.completions, [{ caseId: "z", completion: 12 }]);
});

test("增加容量允许服务重叠", () => {
  const input: SimInput = {
    activities: { A: { samples: [4], capacity: 1 } },
    cases: [
      { id: "c1", arrival: 0, activities: ["A"] },
      { id: "c2", arrival: 0, activities: ["A"] },
    ],
  };
  const base = replay(input, {}, 3, 0);
  assert.deepEqual(base.completions, [
    { caseId: "c1", completion: 4 },
    { caseId: "c2", completion: 8 },
  ]);
  const wider = replay(input, { capacity: { A: 2 } }, 3, 0);
  assert.deepEqual(wider.completions, [
    { caseId: "c1", completion: 4 },
    { caseId: "c2", completion: 4 },
  ]);
});

test("缩短时长向下取整，可为0；删除活动跳过全部出现", () => {
  const input: SimInput = {
    activities: {
      A: { samples: [10], capacity: 1 },
      B: { samples: [1], capacity: 1 },
    },
    cases: [{ id: "c1", arrival: 0, activities: ["A", "B", "A"] }],
  };
  // 缩短 50%：10 -> 5
  const half = replay(input, { shorten: { A: 50 } }, 9, 0);
  assert.deepEqual(
    half.steps.map((s) => [s.index, s.start, s.end]),
    [
      [0, 0, 5],
      [1, 5, 6],
      [2, 6, 11],
    ],
  );
  // 缩短 99%：10 -> floor(10*0.01) = 0
  const almost = replay(input, { shorten: { A: 99 } }, 9, 0);
  assert.deepEqual(
    almost.steps.map((s) => [s.index, s.start, s.end]),
    [
      [0, 0, 0],
      [1, 0, 1],
      [2, 1, 1],
    ],
  );
  // 删除 A：跳过其全部出现，仅保留 B（原始下标1）
  const removed = replay(input, { remove: ["A"] }, 9, 0);
  assert.deepEqual(
    removed.steps.map((s) => [s.index, s.activity, s.start, s.end]),
    [[1, "B", 0, 1]],
  );
  assert.deepEqual(removed.completions, [{ caseId: "c1", completion: 1 }]);
  // 删除全部活动：空路径在到达时完成
  const emptied = replay(input, { remove: ["A", "B"] }, 9, 0);
  assert.deepEqual(emptied.steps, []);
  assert.deepEqual(emptied.completions, [{ caseId: "c1", completion: 0 }]);
});
