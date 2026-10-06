/** 任务定义：所有时间均为整数微秒。 */
export interface TaskSpec {
  /** 任务名称（用于结果展示，可重复时由输入顺序区分）。 */
  name: string;
  /** 优先级，数字越小越优先。 */
  priority: number;
  /** 单次实例执行耗时，正整数微秒。 */
  executionTime: number;
  /** 释放周期，正整数微秒。 */
  period: number;
  /** 首次释放偏移，非负整数微秒。 */
  offset: number;
  /** 相对截止时间，正整数微秒。 */
  relativeDeadline: number;
}

/** 时间线上的一个最大连续执行片段。 */
export interface TimelineSegment {
  /** 片段起始时刻（含）。 */
  start: number;
  /** 片段结束时刻（不含）。 */
  end: number;
  /** 正在执行的实例；空闲片段为 null。 */
  instance: InstanceRef | null;
}

/** 实例引用：任务输入下标 + 实例序号 k（从 0 开始）。 */
export interface InstanceRef {
  /** 任务在输入数组中的下标。 */
  taskIndex: number;
  /** 实例序号，第 k 个实例在 offset + k * period 释放。 */
  jobIndex: number;
}

/** 单个实例的结算结果。 */
export interface JobResult extends InstanceRef {
  /** 释放时刻。 */
  releaseTime: number;
  /** 绝对截止时刻 = 释放时刻 + 相对截止时间。 */
  deadline: number;
  /** 完成时刻；H 前未完成的实例为 null。 */
  completionTime: number | null;
  /** 是否按时完成（恰好在截止时刻完成算按时；未完成视为违约）。 */
  metDeadline: boolean;
}

/** 仿真输出。 */
export interface SimulationResult {
  /** 按时间顺序的最大连续执行片段（含空闲），覆盖 [0, H)。 */
  timeline: TimelineSegment[];
  /** 所有已释放实例（释放时刻 < H）的结算结果。 */
  jobs: JobResult[];
}
