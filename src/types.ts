/** 一个时间格为 15 分钟，规划窗口固定为 48 格。 */
export const PLANNING_WINDOW_SLOTS = 48;

/** 机器可用时间区间，包含起点、不包含终点。 */
export interface TimeInterval {
  readonly start: number;
  readonly end: number;
}

export interface Machine {
  readonly id: string;
  readonly type: string;
  /** 可用区间列表，互不重叠，均为 [start, end)。 */
  readonly availability: readonly TimeInterval[];
}

export interface Operation {
  readonly id: string;
  /** 要求的机器类型，只能安排在同类型机器上。 */
  readonly machineType: string;
  /** 固定占用时长，1 至 8 格。 */
  readonly duration: number;
}

export interface Job {
  readonly id: string;
  /** 严格有序的工序链，后继开工不得早于前序完工。 */
  readonly operations: readonly Operation[];
}

/** 当前排程中一道工序的安排。 */
export interface Placement {
  readonly operationId: string;
  readonly machineId: string;
  readonly start: number;
  readonly locked: boolean;
}

/** 一次调整：指定一道未锁定工序的新机器和新开工时间，必须兑现。 */
export interface Adjustment {
  readonly operationId: string;
  readonly machineId: string;
  readonly start: number;
}

export interface PreviewSuccess {
  readonly ok: true;
  /** 候选排程（完整安排列表），不改变当前排程。 */
  readonly placements: readonly Placement[];
  /** 非目标工序中机器或开工时间发生变化的工序数量。 */
  readonly changedCount: number;
  /** 非目标工序相对原计划开工时间的绝对位移总和。 */
  readonly totalDisplacement: number;
}

export interface PreviewFailure {
  readonly ok: false;
  readonly reason: string;
}

export type PreviewResult = PreviewSuccess | PreviewFailure;

export interface ApplySuccess {
  readonly ok: true;
  readonly placements: readonly Placement[];
  readonly changedCount: number;
  readonly totalDisplacement: number;
}

export interface ApplyFailure {
  readonly ok: false;
  readonly reason: string;
}

export type ApplyResult = ApplySuccess | ApplyFailure;
