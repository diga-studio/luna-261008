import type {
  InstanceResult,
  SimulationResult,
  TaskSpec,
  TimelineSegment,
} from "./types.js";

interface MutableInstance {
  readonly taskIndex: number;
  readonly instanceIndex: number;
  readonly releaseTime: number;
  readonly deadline: number;
  remaining: number;
  startTime: number | null;
  completionTime: number | null;
}

interface MutableSegment {
  start: number;
  end: number;
  taskIndex: number | null;
  taskName: string | null;
  instanceIndex: number | null;
}

function validate(tasks: readonly TaskSpec[], horizon: number): void {
  if (!Number.isInteger(horizon) || horizon < 0) {
    throw new TypeError(`horizon must be a non-negative integer, got ${horizon}`);
  }
  tasks.forEach((task, i) => {
    const where = `tasks[${i}] (${String(task.name)})`;
    if (!Number.isInteger(task.priority)) {
      throw new TypeError(`${where}: priority must be an integer, got ${task.priority}`);
    }
    if (!Number.isInteger(task.executionTime) || task.executionTime <= 0) {
      throw new TypeError(`${where}: executionTime must be a positive integer, got ${task.executionTime}`);
    }
    if (!Number.isInteger(task.period) || task.period <= 0) {
      throw new TypeError(`${where}: period must be a positive integer, got ${task.period}`);
    }
    if (!Number.isInteger(task.offset) || task.offset < 0) {
      throw new TypeError(`${where}: offset must be a non-negative integer, got ${task.offset}`);
    }
    if (!Number.isInteger(task.relativeDeadline) || task.relativeDeadline <= 0) {
      throw new TypeError(`${where}: relativeDeadline must be a positive integer, got ${task.relativeDeadline}`);
    }
  });
}

/**
 * 在 [0, horizon) 上仿真单核固定优先级抢占式调度。
 *
 * - 第 k 个实例在 offset + k * period 释放（k 从 0 开始），仅释放时刻 < horizon 的实例参与。
 * - 优先级数字越小越优先；并列时按释放时刻、再按任务输入顺序。
 * - 更高优先级实例立即抢占，恢复时只执行剩余耗时，切换耗时为零。
 * - 实例超时后仍可运行；恰好在截止时刻完成算按时。
 * - 同一时刻先结算完成与截止状态，再处理释放。
 * - 时间线为最大连续执行片段（含空闲），不改变执行对象的事件不会切碎片段。
 */
export function simulate(tasks: readonly TaskSpec[], horizon: number): SimulationResult {
  validate(tasks, horizon);

  // 预生成所有释放时刻 < horizon 的实例，按 (释放时刻, 任务输入顺序, k) 排序。
  const released: MutableInstance[] = [];
  tasks.forEach((task, taskIndex) => {
    for (let k = 0; ; k += 1) {
      const releaseTime = task.offset + k * task.period;
      if (releaseTime >= horizon) break;
      released.push({
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
  released.sort(
    (a, b) =>
      a.releaseTime - b.releaseTime ||
      a.taskIndex - b.taskIndex ||
      a.instanceIndex - b.instanceIndex,
  );

  // a 是否严格优先于 b（选就绪队首 / 判断抢占共用）。
  const outranks = (a: MutableInstance, b: MutableInstance): boolean => {
    const pa = tasks[a.taskIndex].priority;
    const pb = tasks[b.taskIndex].priority;
    if (pa !== pb) return pa < pb;
    if (a.releaseTime !== b.releaseTime) return a.releaseTime < b.releaseTime;
    return a.taskIndex < b.taskIndex;
  };

  const timeline: MutableSegment[] = [];
  const emit = (start: number, end: number, inst: MutableInstance | null): void => {
    if (end <= start) return;
    const last = timeline[timeline.length - 1];
    const taskIndex = inst === null ? null : inst.taskIndex;
    const instanceIndex = inst === null ? null : inst.instanceIndex;
    if (
      last !== undefined &&
      last.end === start &&
      last.taskIndex === taskIndex &&
      last.instanceIndex === instanceIndex
    ) {
      last.end = end; // 合并为最大连续片段
      return;
    }
    timeline.push({
      start,
      end,
      taskIndex,
      taskName: inst === null ? null : tasks[inst.taskIndex].name,
      instanceIndex,
    });
  };

  const ready: MutableInstance[] = [];
  let nextReleaseIdx = 0;
  const nextReleaseTime = (): number =>
    nextReleaseIdx < released.length ? released[nextReleaseIdx].releaseTime : Infinity;
  const collectReleases = (t: number): void => {
    while (nextReleaseIdx < released.length && released[nextReleaseIdx].releaseTime === t) {
      ready.push(released[nextReleaseIdx]);
      nextReleaseIdx += 1;
    }
  };
  const bestReadyIndex = (): number => {
    let best = -1;
    for (let i = 0; i < ready.length; i += 1) {
      if (best < 0 || outranks(ready[i], ready[best])) best = i;
    }
    return best;
  };

  collectReleases(0);
  let t = 0;
  let current: MutableInstance | null = null;

  while (t < horizon) {
    if (current === null && ready.length > 0) {
      current = ready.splice(bestReadyIndex(), 1)[0];
      if (current.startTime === null) current.startTime = t;
    }

    const runUntil =
      current === null
        ? Math.min(nextReleaseTime(), horizon)
        : Math.min(t + current.remaining, nextReleaseTime(), horizon);

    emit(t, runUntil, current);
    if (current !== null) {
      current.remaining -= runUntil - t;
    }
    t = runUntil;

    // 同一时刻：先结算完成，再处理释放。时刻 H 的完成也计入结果。
    if (current !== null && current.remaining === 0) {
      current.completionTime = t;
      current = null;
    }
    if (t >= horizon) break;
    collectReleases(t);

    // 严格更高优先级才抢占；同优先级不抢占。
    if (current !== null) {
      const best = bestReadyIndex();
      if (best >= 0 && outranks(ready[best], current)) {
        ready.push(current);
        current = null;
      }
    }
  }

  const instances: InstanceResult[] = released.map((inst) => ({
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
  }));

  const segments: TimelineSegment[] = timeline.map((s) => ({ ...s }));
  return { horizon, timeline: segments, instances };
}
