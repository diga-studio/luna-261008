/** 规划窗口总格数，每格 15 分钟。 */
export const HORIZON_SLOTS = 48;

/** 半开区间 [start, end)，单位为格。 */
export interface Interval {
  start: number;
  end: number;
}

/** 机器：有类型与若干可用时间区间。 */
export interface Machine {
  id: string;
  type: string;
  available: Interval[];
}

/** 工序定义：属于某作业，要求机器类型，固定占用 1..8 格。 */
export interface Operation {
  id: string;
  machineType: string;
  duration: number;
}

/** 作业：严格有序的工序链。 */
export interface Job {
  id: string;
  operations: Operation[];
}

/** 排程中一道工序的落位。 */
export interface Placement {
  opId: string;
  machineId: string;
  /** 开工时间（格），整数。 */
  start: number;
  locked: boolean;
}

/** 完整排程：每道工序恰好一条落位。 */
export interface Schedule {
  placements: Placement[];
}

/** 静态问题描述：机器与作业。 */
export interface Problem {
  machines: Machine[];
  jobs: Job[];
}

/** 一次调整请求：指定某未锁定工序的新机器与新开工时间。 */
export interface AdjustmentRequest {
  opId: string;
  machineId: string;
  start: number;
}

export interface SolveOk {
  ok: true;
  schedule: Schedule;
  /** 发生机器或开工时间变化的（非目标、未锁定）工序数。 */
  changedCount: number;
  /** 变化工序相对原计划开工时间的绝对位移总和。 */
  totalDeviation: number;
}

export interface SolveFail {
  ok: false;
  reason: string;
}

export type SolveResult = SolveOk | SolveFail;
