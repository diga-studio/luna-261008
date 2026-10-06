/** 一次文件下载事件。timestamp 为整数 UTC 秒。 */
export interface DownloadEvent {
  eventId: string;
  employeeId: string;
  fileId: string;
  timestamp: number;
}

/** 左闭右开区间 [start, end)，单位秒。 */
export interface Interval {
  start: number;
  end: number;
}

/** 单个员工在一次批次中的告警净变化。 */
export interface AlertChange {
  employeeId: string;
  /** 本次批次新增的告警区间（极大、左闭右开）。 */
  added: Interval[];
  /** 本次批次删除的告警区间（被延长或合并掉的旧区间）。 */
  removed: Interval[];
}

/** 文件活跃窗口长度（秒）：下载于 t 的文件在 [t, t+600) 内活跃。 */
export const ACTIVE_WINDOW_SECONDS = 600;

/** 触发告警所需的活跃不同文件数下限。 */
export const ALERT_THRESHOLD = 51;
