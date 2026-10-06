/** 任务规格：所有时间均为整数微秒。 */
export interface TaskSpec {
  /** 任务名（用于结果标识）。 */
  readonly name: string;
  /** 优先级，整数，数字越小越优先。 */
  readonly priority: number;
  /** 单次实例执行耗时，正整数。 */
  readonly executionTime: number;
  /** 释放周期，正整数。 */
  readonly period: number;
  /** 首次释放偏移，非负整数。 */
  readonly offset: number;
  /** 相对截止时间，正整数。 */
  readonly relativeDeadline: number;
}

/** 单个任务实例（第 k 次释放）的结算结果。 */
export interface InstanceResult {
  /** 任务在输入数组中的下标。 */
  readonly taskIndex: number;
  /** 任务名。 */
  readonly taskName: string;
  /** 实例序号 k，从 0 开始。 */
  readonly instanceIndex: number;
  /** 释放时刻 = offset + k * period。 */
  readonly releaseTime: number;
  /** 绝对截止时刻 = releaseTime + relativeDeadline。 */
  readonly deadline: number;
  /** 首次开始执行时刻；到 H 仍未开始则为 null。 */
  readonly startTime: number | null;
  /** 完成时刻；到 H 仍未完成则为 null。 */
  readonly completionTime: number | null;
  /** 到 H 为止的剩余执行耗时（已完成则为 0）。 */
  readonly remainingTime: number;
  /** 是否按时完成；到 H 仍未完成为 null。恰好在截止时刻完成算按时。 */
  readonly metDeadline: boolean | null;
  /** 是否发生截止时间违约：完成时刻晚于截止时刻，或到 H 仍未完成且截止时刻已过。 */
  readonly missedDeadline: boolean;
}

/** 时间线上的最大连续执行片段；taskIndex 为 null 表示空闲。 */
export interface TimelineSegment {
  readonly start: number;
  readonly end: number;
  readonly taskIndex: number | null;
  readonly taskName: string | null;
  readonly instanceIndex: number | null;
}

/** 仿真结果，覆盖 [0, H)。 */
export interface SimulationResult {
  readonly horizon: number;
  /** 按时间顺序的最大连续执行片段，含空闲段，拼接后覆盖 [0, H)。 */
  readonly timeline: readonly TimelineSegment[];
  /** 所有释放时刻 < H 的实例的结算结果，按 (释放时刻, 任务输入顺序, k) 排序。 */
  readonly instances: readonly InstanceResult[];
}
