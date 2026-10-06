// 独立参考实现：按 1µs 离散步长暴力推进，用于交叉验证事件驱动实现。
import type { SimulationResult, TaskSpec, TimelineSegment } from "../src/index.js";

interface RefInstance {
  taskIndex: number;
  instanceIndex: number;
  releaseTime: number;
  deadline: number;
  remaining: number;
  startTime: number | null;
  completionTime: number | null;
}

export function simulateReference(
  tasks: readonly TaskSpec[],
  horizon: number,
): SimulationResult {
  const instances: RefInstance[] = [];
  tasks.forEach((task, taskIndex) => {
    for (let k = 0; ; k += 1) {
      const releaseTime = task.offset + k * task.period;
      if (releaseTime >= horizon) break;
      instances.push({
        taskIndex,
        instanceIndex: k,
        releaseTime,
        deadline: releaseTime + task.relativeDeadline,
        remaining: task.executionTime,
        startTime: null,
        completionTime: null,
      });
    }
  });
  instances.sort(
    (a, b) =>
      a.releaseTime - b.releaseTime ||
      a.taskIndex - b.taskIndex ||
      a.instanceIndex - b.instanceIndex,
  );

  const outranks = (a: RefInstance, b: RefInstance): boolean => {
    const pa = tasks[a.taskIndex].priority;
    const pb = tasks[b.taskIndex].priority;
    if (pa !== pb) return pa < pb;
    if (a.releaseTime !== b.releaseTime) return a.releaseTime < b.releaseTime;
    return a.taskIndex < b.taskIndex;
  };

  const ready: RefInstance[] = [];
  let nextIdx = 0;
  const timeline: TimelineSegment[] = [];
  let running: RefInstance | null = null;
  let segStart = 0;

  const closeSegment = (end: number): void => {
    if (end <= segStart) return;
    timeline.push({
      start: segStart,
      end,
      taskIndex: running === null ? null : running.taskIndex,
      taskName: running === null ? null : tasks[running.taskIndex].name,
      instanceIndex: running === null ? null : running.instanceIndex,
    });
  };

  for (let t = 0; t < horizon; t += 1) {
    // 上一拍 [t-1, t) 的完成已在上一拍末尾结算；此处先处理时刻 t 的释放。
    while (nextIdx < instances.length && instances[nextIdx].releaseTime === t) {
      ready.push(instances[nextIdx]);
      nextIdx += 1;
    }
    let best: RefInstance | null = null;
    for (const inst of ready) {
      if (inst.remaining > 0 && (best === null || outranks(inst, best))) best = inst;
    }
    if (best !== running) {
      closeSegment(t);
      running = best;
      segStart = t;
    }
    if (running !== null) {
      if (running.startTime === null) running.startTime = t;
      running.remaining -= 1;
      if (running.remaining === 0) running.completionTime = t + 1;
    }
  }
  closeSegment(horizon);

  return {
    horizon,
    timeline,
    instances: instances.map((inst) => ({
      taskIndex: inst.taskIndex,
      taskName: tasks[inst.taskIndex].name,
      instanceIndex: inst.instanceIndex,
      releaseTime: inst.releaseTime,
      deadline: inst.deadline,
      startTime: inst.startTime,
      completionTime: inst.completionTime,
      remainingTime: inst.remaining,
      metDeadline:
        inst.completionTime === null ? null : inst.completionTime <= inst.deadline,
      missedDeadline:
        inst.completionTime === null
          ? inst.deadline <= horizon
          : inst.completionTime > inst.deadline,
    })),
  };
}
