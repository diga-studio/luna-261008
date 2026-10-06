/** 签到状态：可用、执行任务计入区域；休息、离岗不计入但会终止上一条签到。 */
export const enum CheckinStatus {
  Available = "available",
  Working = "working",
  Break = "break",
  OffDuty = "off_duty",
}

/** 计入区域占用的状态集合。 */
export const COUNTED_STATUSES: ReadonlySet<string> = new Set([
  CheckinStatus.Available,
  CheckinStatus.Working,
]);

/** 一条签到事件（某一修订版本）。 */
export interface CheckinEvent {
  /** 全局唯一事件编号。 */
  eventId: number;
  /** 工人编号，同一事件的所有修订中固定不变。 */
  workerId: number;
  /** 发生时间，整数毫秒（Unix 纪元）。 */
  occurredAtMs: number;
  /** 签到状态。 */
  status: CheckinStatus;
  /** 所在区域标识。 */
  zone: string;
  /** 整数修订号，同一事件只采用修订号最大的版本。 */
  revision: number;
}

/** 单个区域在查询区间内的统计结果。 */
export interface ZoneUtilization {
  zone: string;
  /** 累计占用时长，人毫秒。 */
  occupiedMs: number;
  /** 区域容量（正整数），由调用方提供。 */
  capacity: number;
  /** 利用率 = occupiedMs / (capacity * 区间长度)，可能超过 1。 */
  utilization: number;
}

/** 一条签到生效的最长时长：10 分钟。 */
export const CHECKIN_TTL_MS = 10 * 60 * 1000;
