/** 加工档：普通 1 倍、覆膜 1.5 倍、模切 2 倍。 */
export type ProcessingGrade = 'normal' | 'lamination' | 'diecut';

/** 加工倍数的两倍，用整数避免浮点误差：normal=2, lamination=3, diecut=4。 */
export const GRADE_MULTIPLIER_X2: Readonly<Record<ProcessingGrade, number>> = {
  normal: 2,
  lamination: 3,
  diecut: 4,
};

export const MIN_PRIORITY = 1;
export const MAX_PRIORITY = 5;
export const MAX_MACHINES = 16;
export const MAX_SHEETS = 1_000_000;

/** 印机配置：一次排程会话内不变。 */
export interface MachineConfig {
  /** 印机标识，调用方自定，需唯一。 */
  readonly id: string;
  /** 每小时印张产能，正整数。 */
  readonly sheetsPerHour: number;
  /** 最早空闲时刻（整数秒，已含在制作业剩余工期）。 */
  readonly availableFrom: number;
}

/** 单个作业的排队查询结果。 */
export interface QueuePosition {
  /** 在该印机等待队列中的位置，从 1 开始。 */
  readonly position: number;
  /** 预计开始时刻（整数秒）。 */
  readonly startAt: number;
  /** 预计完成时刻（整数秒）。 */
  readonly completeAt: number;
  /** 该作业自身耗时（整数秒，已按作业单独向上取整）。 */
  readonly duration: number;
  /** 所在印机标识。 */
  readonly machineId: string;
}

/** 修改作业的字段；未提供的字段保持不变。 */
export interface JobChanges {
  readonly machineId?: string;
  readonly priority?: number;
  readonly sheets?: number;
  readonly grade?: ProcessingGrade;
}
