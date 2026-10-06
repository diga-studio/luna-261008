import assert from "node:assert/strict";
import { test } from "node:test";
import { simulate } from "../src/index.js";
import type { SimulationResult, TaskSpec, TimelineSegment } from "../src/index.js";

const A: TaskSpec = { name: "A", priority: 0, executionTime: 2, period: 5, offset: 0, relativeDeadline: 2 };
const B: TaskSpec = { name: "B", priority: 1, executionTime: 4, period: 6, offset: 0, relativeDeadline: 6 };

function seg(start: number, end: number, taskIndex: number | null, taskName: string | null, instanceIndex: number | null): TimelineSegment {
  return { start, end, taskIndex, taskName, instanceIndex };
}

test("spec scenario: A(p0,e2,T5,D2) + B(p1,e4,T6,D6), H=12", () => {
  const r = simulate([A, B], 12);

  // 手工核算：A0[0,2) → B0[2,5) → A1 抢占 [5,7) → B0 恢复 [7,8) → B1[8,10) → A2[10,12)
  assert.deepEqual(r.timeline, [
    seg(0, 2, 0, "A", 0),
    seg(2, 5, 1, "B", 0),
    seg(5, 7, 0, "A", 1),
    seg(7, 8, 1, "B", 0),
    seg(8, 10, 1, "B", 1),
    seg(10, 12, 0, "A", 2),
  ]);

  const inst = (task: string, k: number) =>
    r.instances.find((i) => i.taskName === task && i.instanceIndex === k);

  // A0 恰好在截止时刻 2 完成，算按时
  assert.deepEqual(inst("A", 0), {
    taskIndex: 0, taskName: "A", instanceIndex: 0,
    releaseTime: 0, deadline: 2, startTime: 0, completionTime: 2,
    remainingTime: 0, metDeadline: true, missedDeadline: false,
  });
  // B0 被 A1 抢占后恢复，8 完成，超过截止时刻 6
  assert.deepEqual(inst("B", 0), {
    taskIndex: 1, taskName: "B", instanceIndex: 0,
    releaseTime: 0, deadline: 6, startTime: 2, completionTime: 8,
    remainingTime: 0, metDeadline: false, missedDeadline: true,
  });
  // A1 在截止时刻 7 恰好完成
  assert.deepEqual(inst("A", 1), {
    taskIndex: 0, taskName: "A", instanceIndex: 1,
    releaseTime: 5, deadline: 7, startTime: 5, completionTime: 7,
    remainingTime: 0, metDeadline: true, missedDeadline: false,
  });
  // B1 被 A2 抢占，到 H 剩 2µs，截止时刻 12 已过 → 违约
  assert.deepEqual(inst("B", 1), {
    taskIndex: 1, taskName: "B", instanceIndex: 1,
    releaseTime: 6, deadline: 12, startTime: 8, completionTime: null,
    remainingTime: 2, metDeadline: null, missedDeadline: true,
  });
  // A2 恰好在时刻 H=12 完成，完成计入结果且算按时
  assert.deepEqual(inst("A", 2), {
    taskIndex: 0, taskName: "A", instanceIndex: 2,
    releaseTime: 10, deadline: 12, startTime: 10, completionTime: 12,
    remainingTime: 0, metDeadline: true, missedDeadline: false,
  });
  assert.equal(r.instances.length, 5);
});

test("completion, deadline and release at the same instant", () => {
  // A 在 t=2 完成（恰为截止时刻）；B 在 t=2 释放；先结算完成再处理释放。
  const r = simulate([
    { name: "A", priority: 0, executionTime: 2, period: 100, offset: 0, relativeDeadline: 2 },
    { name: "B", priority: 0, executionTime: 3, period: 100, offset: 2, relativeDeadline: 3 },
  ], 8);
  assert.deepEqual(r.timeline, [
    seg(0, 2, 0, "A", 0),
    seg(2, 5, 1, "B", 0),
    seg(5, 8, null, null, null),
  ]);
  const a0 = r.instances.find((i) => i.taskName === "A")!;
  assert.equal(a0.completionTime, 2);
  assert.equal(a0.metDeadline, true);
  const b0 = r.instances.find((i) => i.taskName === "B")!;
  assert.equal(b0.startTime, 2);
  assert.equal(b0.completionTime, 5);
  assert.equal(b0.metDeadline, true);
});

test("higher priority release preempts; same priority does not", () => {
  const r = simulate([
    { name: "lo", priority: 2, executionTime: 10, period: 100, offset: 0, relativeDeadline: 100 },
    { name: "mid", priority: 1, executionTime: 2, period: 100, offset: 3, relativeDeadline: 100 },
    { name: "hi", priority: 0, executionTime: 1, period: 100, offset: 4, relativeDeadline: 100 },
  ], 20);
  // lo[0,3) → mid 抢占 [3,4) → hi 抢占 [4,5) → mid 恢复 [5,6) → lo 恢复 [6,13) → idle
  assert.deepEqual(r.timeline, [
    seg(0, 3, 0, "lo", 0),
    seg(3, 4, 1, "mid", 0),
    seg(4, 5, 2, "hi", 0),
    seg(5, 6, 1, "mid", 0),
    seg(6, 13, 0, "lo", 0),
    seg(13, 20, null, null, null),
  ]);
});

test("execution time larger than period: instances overlap, same task does not preempt itself", () => {
  const r = simulate([
    { name: "C", priority: 0, executionTime: 5, period: 3, offset: 0, relativeDeadline: 10 },
  ], 9);
  // C0[0,5) → C1[5,9)（C1 在 t=3 的释放不打断 C0，也不切碎片段）
  assert.deepEqual(r.timeline, [
    seg(0, 5, 0, "C", 0),
    seg(5, 9, 0, "C", 1),
  ]);
  const [c0, c1, c2] = r.instances;
  assert.equal(c0.completionTime, 5);
  assert.equal(c0.metDeadline, true);
  assert.deepEqual([c1.startTime, c1.remainingTime, c1.missedDeadline], [5, 1, false]);
  assert.deepEqual([c2.startTime, c2.remainingTime, c2.missedDeadline], [null, 5, false]);
});

test("offset shifts first release; idle before it", () => {
  const r = simulate([
    { name: "D", priority: 0, executionTime: 1, period: 4, offset: 3, relativeDeadline: 1 },
  ], 10);
  assert.deepEqual(r.timeline, [
    seg(0, 3, null, null, null),
    seg(3, 4, 0, "D", 0),
    seg(4, 7, null, null, null),
    seg(7, 8, 0, "D", 1),
    seg(8, 10, null, null, null),
  ]);
  assert.equal(r.instances.length, 2); // 释放时刻 3 和 7，11 >= H 不释放
});

test("overdue instance keeps running and completes late", () => {
  const r = simulate([
    { name: "E", priority: 0, executionTime: 4, period: 100, offset: 0, relativeDeadline: 2 },
  ], 10);
  assert.deepEqual(r.timeline, [seg(0, 4, 0, "E", 0), seg(4, 10, null, null, null)]);
  const e0 = r.instances[0];
  assert.equal(e0.completionTime, 4);
  assert.equal(e0.metDeadline, false);
  assert.equal(e0.missedDeadline, true);
});

test("no release at exactly H; empty task set yields pure idle", () => {
  const r = simulate([
    { name: "F", priority: 0, executionTime: 1, period: 5, offset: 0, relativeDeadline: 1 },
  ], 10);
  assert.equal(r.instances.length, 2); // 释放时刻 0 和 5，10 不释放
  const idle = simulate([], 7);
  assert.deepEqual(idle.timeline, [seg(0, 7, null, null, null)]);
  assert.equal(idle.instances.length, 0);
});

test("zero horizon yields empty result", () => {
  const r = simulate([A], 0);
  assert.deepEqual(r.timeline, []);
  assert.deepEqual(r.instances, []);
});

test("timeline is contiguous, covers [0,H), and segments are maximal", () => {
  const check = (r: SimulationResult) => {
    let prevEnd = 0;
    let prev: TimelineSegment | null = null;
    for (const s of r.timeline) {
      assert.ok(s.end > s.start, "no zero-length segment");
      assert.equal(s.start, prevEnd, "contiguous");
      if (prev !== null) {
        assert.ok(
          prev.taskIndex !== s.taskIndex || prev.instanceIndex !== s.instanceIndex,
          "adjacent segments must not run the same instance",
        );
      }
      prevEnd = s.end;
      prev = s;
    }
    assert.equal(prevEnd, r.horizon, "covers [0,H)");
  };
  check(simulate([A, B], 12));
  check(simulate([A, B], 50));
  check(simulate([], 3));
});

test("invalid inputs are rejected", () => {
  const bad: Array<[readonly TaskSpec[], number]> = [
    [[{ ...A, executionTime: 0 }], 10],
    [[{ ...A, executionTime: -1 }], 10],
    [[{ ...A, period: 0 }], 10],
    [[{ ...A, offset: -1 }], 10],
    [[{ ...A, relativeDeadline: 0 }], 10],
    [[{ ...A, executionTime: 1.5 }], 10],
    [[{ ...A, priority: 0.5 }], 10],
    [[A], -1],
    [[A], 2.5],
  ];
  for (const [tasks, h] of bad) {
    assert.throws(() => simulate(tasks, h), TypeError);
  }
});
