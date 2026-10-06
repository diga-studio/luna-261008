/** 步骤种类：人工步骤 / 等待步骤 */
export type StepKind = "manual" | "wait";

/** 单个步骤定义 */
export interface StepDefinition {
  /** 唯一编号 */
  readonly id: string;
  readonly kind: StepKind;
  /** 前置依赖步骤编号列表（可为空） */
  readonly dependsOn?: readonly string[];
  /** 等待步骤：等待时长，正整数毫秒 */
  readonly durationMs?: number;
  /** 等待步骤：是否需要人工环境确认 */
  readonly requiresConfirmation?: boolean;
  /** 等待步骤：提醒触发偏移（从本轮开始计时算起，正整数毫秒，小于等待时长，最多 3 个） */
  readonly reminders?: readonly number[];
}

/** 工序定义：执行期间不可变 */
export interface ProcessDefinition {
  readonly steps: readonly StepDefinition[];
}

/** 步骤执行状态 */
export type StepStatus = "locked" | "unlocked" | "completed";

/** 单步执行结果视图 */
export interface StepResult {
  readonly id: string;
  readonly status: StepStatus;
  /** 本轮等待计时起点（未开始等待则为 null） */
  readonly waitStartedAt: number | null;
  /** 本轮人工确认时刻（未确认则为 null） */
  readonly confirmedAt: number | null;
  /** 实际完成时刻（未完成为 null） */
  readonly completedAt: number | null;
}

/** 一条已产生的提醒记录（历史保留，含所属轮次） */
export interface ReminderRecord {
  readonly stepId: string;
  readonly offsetMs: number;
  readonly at: number;
  readonly round: number;
}

/** 整体执行结果视图 */
export interface ExecutionResult {
  readonly currentTime: number;
  readonly steps: Readonly<Record<string, StepResult>>;
  readonly reminders: readonly ReminderRecord[];
}
