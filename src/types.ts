/** 可信工作负载中的一个 case。 */
export interface CaseInput {
  /** 唯一 ASCII 标识。 */
  id: string;
  /** 非负整数到达毫秒。 */
  arrival: number;
  /** 活动名称序列，允许重复。 */
  activities: string[];
}

/** 活动定义：历史服务时长样本（非负整数毫秒）与基线容量（1..50）。 */
export interface ActivityDef {
  samples: number[];
  capacity: number;
}

/** 仿真输入。 */
export interface SimInput {
  cases: CaseInput[];
  activities: Record<string, ActivityDef>;
}

/** 方案：可组合删除、缩短（1..99%）、容量覆盖（1..50）。 */
export interface Scenario {
  remove?: string[];
  shorten?: Record<string, number>;
  capacity?: Record<string, number>;
}

/** 单个保留步骤的重放记录。 */
export interface StepRecord {
  caseId: string;
  /** 原始下标（在未删除序列中的位置）。 */
  index: number;
  activity: string;
  ready: number;
  start: number;
  end: number;
}

/** replay 的返回结果。 */
export interface ReplayResult {
  steps: StepRecord[];
  /** 每个 case 的完成时间（按 caseId 字典序）。 */
  completions: Array<{ caseId: string; completion: number }>;
}

/** 跨轮统计：每轮平均/中位 case 耗时的跨轮均值。 */
export interface CompareStats {
  mean: number;
  median: number;
}

/** compare 的返回结果。 */
export interface CompareResult {
  baseline: CompareStats;
  scenario: CompareStats;
  /** scenario - baseline */
  diff: CompareStats;
}
