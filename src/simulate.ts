import type {
  InstanceRef,
  JobResult,
  SimulationResult,
  TaskSpec,
  TimelineSegment,
} from "./types.js";

interface Job {
  taskIndex: number;
  jobIndex: number;
  release: number;
  deadline: number;
  remaining: number;
  completion: number | null;
  priorityKey: number;
}

interface ReleaseEvent {
  time: number;
  taskIndex: number;
  jobIndex: number;
}

function assertInteger(value: number, label: string): void {
  if (!Number.isInteger(value)) {
    throw new RangeError(`${label} must be an integer, got ${value}`);
  }
}

function validateTasks(tasks: TaskSpec[]): void {
  tasks.forEach((task, i) => {
    const label = `tasks[${i}]`;
    assertInteger(task.priority, `${label}.priority`);
    assertInteger(task.executionTime, `${label}.executionTime`);
    assertInteger(task.period, `${label}.period`);
    assertInteger(task.offset, `${label}.offset`);
    assertInteger(task.relativeDeadline, `${label}.relativeDeadline`);
    if (task.executionTime <= 0) {
      throw new RangeError(`${label}.executionTime must be positive`);
    }
    if (task.period <= 0) {
      throw new RangeError(`${label}.period must be positive`);
    }
    if (task.relativeDeadline <= 0) {
      throw new RangeError(`${label}.relativeDeadline must be positive`);
    }
    if (task.offset < 0) {
      throw new RangeError(`${label}.offset must be non-negative`);
    }
  });
}

/** 选择下一个执行的实例：优先级小者优先，其次释放时刻早者，再其次任务输入顺序。 */
function pickNext(ready: Job[]): Job {
  let best = ready[0];
  for (let i = 1; i < ready.length; i += 1) {
    const job = ready[i];
    if (
      job.priorityKey < best.priorityKey ||
      (job.priorityKey === best.priorityKey &&
        (job.release < best.release ||
          (job.release === best.release && job.taskIndex < best.taskIndex)))
    ) {
      best = job;
    }
  }
  return best;
}

/**
 * 在 [0, H) 上仿真单核固定优先级抢占式调度。
 *
 * - 实例在 offset + k * period 释放（k 从 0 开始），仅释放时刻 < H 的实例参与。
 * - 超时实例不取消、不跳过；恰好在截止时刻完成算按时。
 * - 同一时刻先结算完成，再处理释放；时刻 H 的完成仍计入。
 * - 时间线输出最大连续执行片段（含空闲），不因无关事件切碎。
 */
export function simulate(tasks: TaskSpec[], horizon: number): SimulationResult {
  validateTasks(tasks);
  assertInteger(horizon, "horizon");
  if (horizon < 0) {
    throw new RangeError("horizon must be non-negative");
  }

  const releases: ReleaseEvent[] = [];
  tasks.forEach((task, taskIndex) => {
    for (let k = 0; ; k += 1) {
      const time = task.offset + k * task.period;
      if (time >= horizon) break;
      releases.push({ time, taskIndex, jobIndex: k });
    }
  });
  releases.sort(
    (a, b) => a.time - b.time || a.taskIndex - b.taskIndex || a.jobIndex - b.jobIndex,
  );

  const jobs: Job[] = releases.map((r) => ({
    taskIndex: r.taskIndex,
    jobIndex: r.jobIndex,
    release: r.time,
    deadline: r.time + tasks[r.taskIndex].relativeDeadline,
    remaining: tasks[r.taskIndex].executionTime,
    completion: null,
    priorityKey: tasks[r.taskIndex].priority,
  }));

  const timeline: TimelineSegment[] = [];
  const ready: Job[] = [];
  let releaseCursor = 0;
  let t = 0;

  const refOf = (job: Job): InstanceRef => ({
    taskIndex: job.taskIndex,
    jobIndex: job.jobIndex,
  });

  const emit = (instance: InstanceRef | null, start: number, end: number): void => {
    if (end <= start) return;
    const last = timeline[timeline.length - 1];
    const same =
      last !== undefined &&
      last.end === start &&
      ((last.instance === null && instance === null) ||
        (last.instance !== null &&
          instance !== null &&
          last.instance.taskIndex === instance.taskIndex &&
          last.instance.jobIndex === instance.jobIndex));
    if (same) {
      last.end = end;
    } else {
      timeline.push({ start, end, instance });
    }
  };

  while (t < horizon) {
    // 先结算恰好此时完成的实例（在下方运行循环中处理），再吸收此时刻的释放。
    while (releaseCursor < releases.length && releases[releaseCursor].time === t) {
      ready.push(jobs[releaseCursor]);
      releaseCursor += 1;
    }

    const nextRelease =
      releaseCursor < releases.length ? releases[releaseCursor].time : horizon;

    if (ready.length === 0) {
      const idleEnd = Math.min(nextRelease, horizon);
      emit(null, t, idleEnd);
      t = idleEnd;
      continue;
    }

    const current = pickNext(ready);
    const runEnd = Math.min(t + current.remaining, nextRelease, horizon);
    emit(refOf(current), t, runEnd);
    current.remaining -= runEnd - t;
    t = runEnd;
    if (current.remaining === 0) {
      current.completion = t;
      ready.splice(ready.indexOf(current), 1);
    }
  }

  const results: JobResult[] = jobs
    .map((job) => ({
      taskIndex: job.taskIndex,
      jobIndex: job.jobIndex,
      releaseTime: job.release,
      deadline: job.deadline,
      completionTime: job.completion,
      metDeadline: job.completion !== null && job.completion <= job.deadline,
    }))
    .sort((a, b) => a.taskIndex - b.taskIndex || a.jobIndex - b.jobIndex);

  return { timeline, jobs: results };
}
