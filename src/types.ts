/** 步骤种类：人工步骤 / 等待步骤 */
export type StepKind = 'manual' | 'wait';

/** 单个步骤定义 */
export interface StepDefinition {
  /** 唯一编号 */
  id: string;
  kind: StepKind;
  /** 等待步骤的时长（正整数毫秒）；人工步骤不使用 */
  durationMs?: number;
  /** 等待步骤是否额外要求人工环境确认 */
  requiresConfirmation?: boolean;
  /** 提醒触发偏移（从本轮开始计时算起，正整数毫秒，小于等待时长，最多 3 个） */
  reminders?: number[];
}

/** 工序定义：步骤集合 + 前置依赖（from 完成后 to 才可能解锁） */
export interface ProcessDefinition {
  steps: StepDefinition[];
  dependencies: { from: string; to: string }[];
}

/** 步骤执行状态 */
export type StepStatus = 'locked' | 'unlocked' | 'completed';

/** 一条已产生的提醒记录（历史保留） */
export interface FiredReminder {
  /** 触发偏移（相对本轮计时起点） */
  offsetMs: number;
  /** 实际触发时刻 */
  firedAt: number;
  /** 第几轮执行（从 1 开始，回退后重新执行递增） */
  round: number;
}

/** 单个步骤的执行结果视图 */
export interface StepResult {
  id: string;
  status: StepStatus;
  /** 当前轮次（回退会开启新一轮） */
  round: number;
  /** 本轮等待计时起点（仅等待步骤且本轮已解锁） */
  waitStartedAt: number | null;
  /** 本轮实际完成时刻 */
  completedAt: number | null;
  /** 本轮人工确认时刻（未确认则为 null） */
  confirmedAt: number | null;
  /** 已产生的全部提醒（含历史轮次） */
  reminders: FiredReminder[];
}

/** 整体执行结果视图 */
export interface ExecutionResult {
  /** 当前业务时间 */
  now: number;
  steps: StepResult[];
}
