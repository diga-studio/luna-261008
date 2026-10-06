/** 加工档：普通 1 倍、覆膜 1.5 倍、模切 2 倍 */
export type Grade = 'normal' | 'lamination' | 'diecut';

/** 印机静态参数：一次排程会话内不变 */
export interface MachineSpec {
  /** 印机标识 */
  readonly id: string;
  /** 每小时印张产能 */
  readonly sheetsPerHour: number;
  /** 最早空闲时刻（整数秒，已计入在制作业剩余工期） */
  readonly availableAt: number;
}

/** 加入等待作业的入参 */
export interface AddJobInput {
  readonly id: string;
  readonly machineId: string;
  /** 优先级 1-5，数字越小越靠前 */
  readonly priority: number;
  /** 实际上机张数，<= 1_000_000 */
  readonly sheets: number;
  readonly grade: Grade;
}

/** 修改作业的入参；改派到不同印机时视为在新印机重新入队 */
export interface UpdateJobInput {
  readonly machineId?: string;
  readonly priority?: number;
  readonly sheets?: number;
  readonly grade?: Grade;
}

/** 单作业查询结果 */
export interface JobStatus {
  readonly id: string;
  readonly machineId: string;
  /** 排队位置，从 1 开始 */
  readonly position: number;
  /** 预计开始时刻（整数秒） */
  readonly startAt: number;
  /** 预计完成时刻（整数秒） */
  readonly finishAt: number;
}
