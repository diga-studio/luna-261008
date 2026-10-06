import assert from "node:assert/strict";
import { test } from "node:test";
import { simulate } from "../src/index.js";
import type { TaskSpec } from "../src/index.js";
import { simulateReference } from "./reference.js";

// 确定性伪随机数（mulberry32），保证测试可复现。
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}

function randomTasks(rand: () => number): TaskSpec[] {
  const count = 1 + Math.floor(rand() * 4);
  const tasks: TaskSpec[] = [];
  for (let i = 0; i < count; i += 1) {
    tasks.push({
      name: `T${i}`,
      priority: Math.floor(rand() * 4),
      executionTime: 1 + Math.floor(rand() * 6),
      period: 1 + Math.floor(rand() * 8),
      offset: Math.floor(rand() * 5),
      relativeDeadline: 1 + Math.floor(rand() * 10),
    });
  }
  return tasks;
}

test("event-driven simulator matches tick-based reference on randomized cases", () => {
  const rand = mulberry32(0xc0ffee);
  const cases = 300;
  for (let c = 0; c < cases; c += 1) {
    const tasks = randomTasks(rand);
    const horizon = 1 + Math.floor(rand() * 40);
    const actual = simulate(tasks, horizon);
    const expected = simulateReference(tasks, horizon);
    const label = `case ${c}: ${JSON.stringify(tasks)} H=${horizon}`;
    assert.deepEqual(actual.timeline, expected.timeline, `timeline mismatch: ${label}`);
    assert.deepEqual(actual.instances, expected.instances, `instances mismatch: ${label}`);

    // 不变量：时间线连续覆盖 [0,H)，片段最大（相邻不同实例），无零长片段。
    let prevEnd = 0;
    for (let i = 0; i < actual.timeline.length; i += 1) {
      const s = actual.timeline[i];
      assert.ok(s.end > s.start, `zero-length segment: ${label}`);
      assert.equal(s.start, prevEnd, `gap/overlap: ${label}`);
      if (i > 0) {
        const p = actual.timeline[i - 1];
        assert.ok(
          p.taskIndex !== s.taskIndex || p.instanceIndex !== s.instanceIndex,
          `segment not maximal: ${label}`,
        );
      }
      prevEnd = s.end;
    }
    assert.equal(prevEnd, horizon, `timeline does not cover [0,H): ${label}`);

    // 不变量：每个实例的已执行时间（时间线统计）与 remainingTime 吻合。
    const executed = new Map<string, number>();
    for (const s of actual.timeline) {
      if (s.taskIndex === null) continue;
      const key = `${s.taskIndex}:${s.instanceIndex}`;
      executed.set(key, (executed.get(key) ?? 0) + (s.end - s.start));
    }
    for (const inst of actual.instances) {
      const key = `${inst.taskIndex}:${inst.instanceIndex}`;
      const ran = executed.get(key) ?? 0;
      assert.equal(
        ran + inst.remainingTime,
        tasks[inst.taskIndex].executionTime,
        `executed+remaining mismatch: ${label}`,
      );
      if (inst.completionTime !== null) {
        assert.equal(inst.remainingTime, 0, `completed but remaining: ${label}`);
        assert.equal(inst.metDeadline, inst.completionTime <= inst.deadline, label);
      }
    }
  }
});
