import assert from "node:assert/strict";
import test from "node:test";
import { simulate } from "../src/index.js";
import type { JobResult, TaskSpec, TimelineSegment } from "../src/index.js";

const A: TaskSpec = { name: "A", priority: 0, executionTime: 2, period: 5, offset: 0, relativeDeadline: 2 };
const B: TaskSpec = { name: "B", priority: 1, executionTime: 4, period: 6, offset: 0, relativeDeadline: 6 };

test("给定用例：A/B 双任务，H=12（人工推算的独立参考结果）", () => {
  const { timeline, jobs } = simulate([A, B], 12);

  const wantTimeline: TimelineSegment[] = [
    { start: 0, end: 2, instance: { taskIndex: 0, jobIndex: 0 } },
    { start: 2, end: 5, instance: { taskIndex: 1, jobIndex: 0 } },
    // A1 在 [5,7) 连续执行：t=6 的 B1 释放不改变执行对象，不得切碎。
    { start: 5, end: 7, instance: { taskIndex: 0, jobIndex: 1 } },
    // B0 被抢占后在 t=7 恢复，只执行剩余 1µs。
    { start: 7, end: 8, instance: { taskIndex: 1, jobIndex: 0 } },
    { start: 8, end: 10, instance: { taskIndex: 1, jobIndex: 1 } },
    { start: 10, end: 12, instance: { taskIndex: 0, jobIndex: 2 } },
  ];
  assert.deepEqual(timeline, wantTimeline);

  const wantJobs: JobResult[] = [
    // A0 恰好在截止时刻 2 完成，算按时。
    { taskIndex: 0, jobIndex: 0, releaseTime: 0, deadline: 2, completionTime: 2, metDeadline: true },
    { taskIndex: 0, jobIndex: 1, releaseTime: 5, deadline: 7, completionTime: 7, metDeadline: true },
    // A2 恰好在 H=12 完成（等于截止时刻 12），计入结果且算按时。
    { taskIndex: 0, jobIndex: 2, releaseTime: 10, deadline: 12, completionTime: 12, metDeadline: true },
    // B0 超时后仍运行到完成，不取消。
    { taskIndex: 1, jobIndex: 0, releaseTime: 0, deadline: 6, completionTime: 8, metDeadline: false },
    // B1 在 H 前未完成，记为违约，不悄悄丢弃。
    { taskIndex: 1, jobIndex: 1, releaseTime: 6, deadline: 12, completionTime: null, metDeadline: false },
  ];
  assert.deepEqual(jobs, wantJobs);
});

test("完成与释放同刻：先结算完成，再处理释放", () => {
  const C: TaskSpec = { name: "C", priority: 0, executionTime: 2, period: 4, offset: 0, relativeDeadline: 2 };
  const D: TaskSpec = { name: "D", priority: 1, executionTime: 1, period: 10, offset: 2, relativeDeadline: 5 };
  const { timeline, jobs } = simulate([C, D], 6);

  // t=2：C0 完成与 D0 释放同刻，D0 紧接着运行，中间无空闲。
  assert.deepEqual(timeline, [
    { start: 0, end: 2, instance: { taskIndex: 0, jobIndex: 0 } },
    { start: 2, end: 3, instance: { taskIndex: 1, jobIndex: 0 } },
    { start: 3, end: 4, instance: null },
    { start: 4, end: 6, instance: { taskIndex: 0, jobIndex: 1 } },
  ]);
  assert.deepEqual(
    jobs.map((j) => [j.completionTime, j.metDeadline]),
    [
      [2, true],
      [6, true],
      [3, true],
    ],
  );
});

test("截止事件不切碎时间线：超时实例连续运行", () => {
  const E: TaskSpec = { name: "E", priority: 0, executionTime: 5, period: 10, offset: 0, relativeDeadline: 3 };
  const { timeline, jobs } = simulate([E], 10);

  // E0 的截止时刻 3 落在执行区间内部，片段不得断开。
  assert.deepEqual(timeline, [
    { start: 0, end: 5, instance: { taskIndex: 0, jobIndex: 0 } },
    { start: 5, end: 10, instance: null },
  ]);
  assert.deepEqual(jobs, [
    { taskIndex: 0, jobIndex: 0, releaseTime: 0, deadline: 3, completionTime: 5, metDeadline: false },
  ]);
});

test("同优先级按释放时刻、再按输入顺序选择", () => {
  const F: TaskSpec = { name: "F", priority: 1, executionTime: 2, period: 10, offset: 0, relativeDeadline: 10 };
  const G: TaskSpec = { name: "G", priority: 1, executionTime: 2, period: 10, offset: 0, relativeDeadline: 10 };
  const { timeline } = simulate([F, G], 5);
  // 同刻释放、同优先级：输入顺序靠前者先运行。
  assert.deepEqual(timeline, [
    { start: 0, end: 2, instance: { taskIndex: 0, jobIndex: 0 } },
    { start: 2, end: 4, instance: { taskIndex: 1, jobIndex: 0 } },
    { start: 4, end: 5, instance: null },
  ]);
});

test("执行耗时大于周期：旧实例未完成也照常释放新实例", () => {
  const H: TaskSpec = { name: "H", priority: 0, executionTime: 3, period: 2, offset: 0, relativeDeadline: 100 };
  const { jobs } = simulate([H], 5);
  // 释放时刻 0/2/4 共 3 个实例；单核按释放先后执行，H=5 时仅第 0 个完成。
  assert.deepEqual(
    jobs.map((j) => [j.releaseTime, j.completionTime]),
    [
      [0, 3],
      [2, null],
      [4, null],
    ],
  );
});

test("边界：空任务集与 H=0", () => {
  assert.deepEqual(simulate([], 5), { timeline: [{ start: 0, end: 5, instance: null }], jobs: [] });
  assert.deepEqual(simulate([A], 0), { timeline: [], jobs: [] });
});

test("输入校验：非整数与非正值抛 RangeError", () => {
  const bad = (patch: Partial<TaskSpec>) => ({ ...A, ...patch });
  assert.throws(() => simulate([bad({ executionTime: 0 })], 1), RangeError);
  assert.throws(() => simulate([bad({ period: -1 })], 1), RangeError);
  assert.throws(() => simulate([bad({ relativeDeadline: 1.5 })], 1), RangeError);
  assert.throws(() => simulate([bad({ offset: -3 })], 1), RangeError);
  assert.throws(() => simulate([A], -1), RangeError);
});

// ---- 独立参考实现：逐微秒步进的暴力仿真，与事件驱动实现交叉验证 ----

function referenceSimulate(tasks: TaskSpec[], horizon: number): { timeline: TimelineSegment[]; jobs: JobResult[] } {
  interface RefJob {
    taskIndex: number;
    jobIndex: number;
    release: number;
    deadline: number;
    remaining: number;
    completion: number | null;
  }
  const jobs: RefJob[] = [];
  tasks.forEach((task, taskIndex) => {
    for (let k = 0; task.offset + k * task.period < horizon; k += 1) {
      const release = task.offset + k * task.period;
      jobs.push({
        taskIndex,
        jobIndex: k,
        release,
        deadline: release + task.relativeDeadline,
        remaining: task.executionTime,
        completion: null,
      });
    }
  });

  const timeline: TimelineSegment[] = [];
  for (let t = 0; t < horizon; t += 1) {
    // 同一时刻先结算完成，再处理释放。
    const ready = jobs.filter((j) => j.release <= t && j.completion === null);
    let current: RefJob | null = null;
    for (const j of ready) {
      if (
        current === null ||
        tasks[j.taskIndex].priority < tasks[current.taskIndex].priority ||
        (tasks[j.taskIndex].priority === tasks[current.taskIndex].priority &&
          (j.release < current.release ||
            (j.release === current.release && j.taskIndex < current.taskIndex)))
      ) {
        current = j;
      }
    }
    const instance = current === null ? null : { taskIndex: current.taskIndex, jobIndex: current.jobIndex };
    const last = timeline[timeline.length - 1];
    const same =
      last !== undefined &&
      ((last.instance === null && instance === null) ||
        (last.instance !== null &&
          instance !== null &&
          last.instance.taskIndex === instance.taskIndex &&
          last.instance.jobIndex === instance.jobIndex));
    if (same) {
      last.end = t + 1;
    } else {
      timeline.push({ start: t, end: t + 1, instance });
    }
    if (current !== null) {
      current.remaining -= 1;
      if (current.remaining === 0) current.completion = t + 1;
    }
  }

  return {
    timeline,
    jobs: jobs
      .map((j) => ({
        taskIndex: j.taskIndex,
        jobIndex: j.jobIndex,
        releaseTime: j.release,
        deadline: j.deadline,
        completionTime: j.completion,
        metDeadline: j.completion !== null && j.completion <= j.deadline,
      }))
      .sort((a, b) => a.taskIndex - b.taskIndex || a.jobIndex - b.jobIndex),
  };
}

test("与逐微秒参考实现交叉验证：确定性伪随机用例", () => {
  let seed = 26100873;
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  for (let round = 0; round < 200; round += 1) {
    const taskCount = 1 + rand(4);
    const tasks: TaskSpec[] = Array.from({ length: taskCount }, (_, i) => ({
      name: `T${i}`,
      priority: rand(4),
      executionTime: 1 + rand(8),
      period: 1 + rand(10),
      offset: rand(6),
      relativeDeadline: 1 + rand(12),
    }));
    const horizon = 1 + rand(60);
    assert.deepEqual(simulate(tasks, horizon), referenceSimulate(tasks, horizon));
  }
});
