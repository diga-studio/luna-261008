import test from "node:test";
import assert from "node:assert/strict";
import { Rescheduler } from "../src/index.js";
import type { Problem, Schedule } from "../src/index.js";
import {
  assertLegalSchedule,
  assertLockedPreserved,
  bruteForceOptimum,
} from "./helpers.js";

/**
 * 场景：M1 从第 4 格才可用，M2 只在前 3 格可用。
 * J1 的 P2 锁定在 M3 第 6 格开工，P1（2 格）必须在此之前完工。
 * 把 J2 的 Q1 调到 M1 第 4 格后，P1 在 M1 上无处可去，
 * 唯一最优解是 P1 跨作业换到 M2 并提前到第 1 格。
 */
function buildProblem(): { problem: Problem; schedule: Schedule } {
  const problem: Problem = {
    machines: [
      { id: "M1", type: "A", available: [{ start: 4, end: 48 }] },
      { id: "M2", type: "A", available: [{ start: 0, end: 3 }] },
      { id: "M3", type: "B", available: [{ start: 0, end: 48 }] },
    ],
    jobs: [
      {
        id: "J1",
        operations: [
          { id: "P1", machineType: "A", duration: 2 },
          { id: "P2", machineType: "B", duration: 2 },
        ],
      },
      {
        id: "J2",
        operations: [{ id: "Q1", machineType: "A", duration: 4 }],
      },
      {
        id: "J3",
        operations: [{ id: "R1", machineType: "B", duration: 2 }],
      },
    ],
  };
  const schedule: Schedule = {
    placements: [
      { opId: "P1", machineId: "M1", start: 4, locked: false },
      { opId: "P2", machineId: "M3", start: 6, locked: true },
      { opId: "Q1", machineId: "M1", start: 8, locked: false },
      { opId: "R1", machineId: "M3", start: 20, locked: false },
    ],
  };
  return { problem, schedule };
}

test("跨作业换机并提前，守住未来锁定后继", () => {
  const { problem, schedule } = buildProblem();
  const rescheduler = new Rescheduler(problem, schedule);
  const request = { opId: "Q1", machineId: "M1", start: 4 };

  const result = rescheduler.preview(request);
  assert.ok(result.ok, `预览应当有解: ${result.ok ? "" : result.reason}`);

  // 硬约束：资源占用、依赖关系、窗口与可用时间。
  assertLegalSchedule(problem, result.schedule);
  // 锁定安排不变。
  assertLockedPreserved(schedule, result.schedule);

  const byOp = new Map(result.schedule.placements.map((p) => [p.opId, p]));
  // 目标工序按指定兑现。
  assert.deepEqual(byOp.get("Q1"), { opId: "Q1", machineId: "M1", start: 4, locked: false });
  // P1 必须换到 M2 并提前到第 1 格（1+2<=3 可用，3<=6 守住锁定的 P2）。
  assert.deepEqual(byOp.get("P1"), { opId: "P1", machineId: "M2", start: 1, locked: false });
  // 无干系工序保持不动。
  assert.deepEqual(byOp.get("R1"), { opId: "R1", machineId: "M3", start: 20, locked: false });

  // 与独立暴力枚举的最优值一致：先比变化工序数，再比位移总和。
  const optimum = bruteForceOptimum(problem, schedule, request);
  assert.ok(optimum, "暴力枚举应当有解");
  assert.equal(result.changedCount, optimum!.changedCount, "变化工序数应最少");
  assert.equal(result.totalDeviation, optimum!.totalDeviation, "同变化数下位移总和应最小");
  assert.equal(result.changedCount, 1);
  assert.equal(result.totalDeviation, 3);

  // 预览不改变当前排程。
  assert.deepEqual(rescheduler.getSchedule(), schedule);
});

test("应用后整体替换当前排程", () => {
  const { problem, schedule } = buildProblem();
  const rescheduler = new Rescheduler(problem, schedule);
  const request = { opId: "Q1", machineId: "M1", start: 4 };

  const previewed = rescheduler.preview(request);
  assert.ok(previewed.ok);

  const applied = rescheduler.apply(request);
  assert.ok(applied.ok, `应用应当有解: ${applied.ok ? "" : applied.reason}`);
  // 应用与预览按相同规则求解，结果一致。
  assert.deepEqual(applied.schedule, previewed.schedule);
  assert.deepEqual(rescheduler.getSchedule(), applied.schedule);
  assertLegalSchedule(problem, rescheduler.getSchedule());
  assertLockedPreserved(schedule, rescheduler.getSchedule());
});

test("无解时预览与应用均不改变原排程", () => {
  const { problem, schedule } = buildProblem();
  const rescheduler = new Rescheduler(problem, schedule);
  // P1 指定到第 5 格开工，7 格完工，晚于锁定后继 P2 的第 6 格开工，必然无解。
  const request = { opId: "P1", machineId: "M1", start: 5 };

  const previewed = rescheduler.preview(request);
  assert.ok(!previewed.ok, "预览应当报告无解");
  assert.deepEqual(rescheduler.getSchedule(), schedule, "预览不得改变当前排程");

  const applied = rescheduler.apply(request);
  assert.ok(!applied.ok, "应用应当报告无解");
  assert.deepEqual(rescheduler.getSchedule(), schedule, "应用不得留下部分调整的状态");
});

test("非法请求直接报告无解", () => {
  const { problem, schedule } = buildProblem();
  const rescheduler = new Rescheduler(problem, schedule);

  // 锁定工序不可作为调整目标。
  assert.ok(!rescheduler.preview({ opId: "P2", machineId: "M3", start: 10 }).ok);
  // 机器类型不符。
  assert.ok(!rescheduler.preview({ opId: "Q1", machineId: "M3", start: 4 }).ok);
  // 超出机器可用时间。
  assert.ok(!rescheduler.preview({ opId: "Q1", machineId: "M2", start: 0 }).ok);
  // 超出规划窗口。
  assert.ok(!rescheduler.preview({ opId: "Q1", machineId: "M1", start: 46 }).ok);

  assert.deepEqual(rescheduler.getSchedule(), schedule);
});
