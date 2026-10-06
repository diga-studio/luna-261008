/** 签到状态：可用、执行任务计入区域；休息、离岗不计入但会终止上一条签到。 */
export enum CheckinStatus {
  Available = "available",
  Working = "working",
  Rest = "rest",
  OffDuty = "off_duty",
}

/** 一次签到提交（某个事件的某个修订版本）。 */
export interface CheckinSubmission {
  /** 全局唯一事件编号 */
  eventId: number;
  /** 工人编号（同一事件固定不变） */
  workerId: number;
  /** 发生时间，整数毫秒 */
  occurredAt: number;
  status: CheckinStatus;
  /** 所在区域标识 */
  zoneId: string;
  /** 整数修订号，同一事件只采用最大修订号 */
  revision: number;
}

/** 一个区域在查询区间内的核算结果。 */
export interface ZoneUtilization {
  zoneId: string;
  /** 累计占用时长，人·毫秒 */
  occupiedMs: number;
  /** 利用率 = occupiedMs / (capacity * intervalMs)，可超过 1 */
  utilization: number;
}
