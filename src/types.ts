/** 动作类型 */
export type ActionType = 'open' | 'download' | 'other';

/** 活动事件（不可变，同一事件 ID 内容始终相同） */
export interface ActivityEvent {
  /** 全局唯一 ASCII 事件 ID */
  eventId: string;
  roomId: string;
  sessionId: string;
  userId: string;
  /** UTC 毫秒时间戳 */
  timestamp: number;
  action: ActionType;
  /** open / download 事件携带 */
  docId?: string;
}

/** 导入结果 */
export interface ImportResult {
  /** 本批收到的事件数 */
  received: number;
  /** 实际新入库的事件数（去重后） */
  inserted: number;
}

/** 文档日报 */
export interface DailyReport {
  roomId: string;
  docId: string;
  /** UTC 自然日，YYYY-MM-DD */
  date: string;
  /** 打开次数 */
  opens: number;
  /** 独立阅读用户数 */
  uniqueReaders: number;
  /** 下载次数 */
  downloads: number;
  /** 平均停留毫秒；无有效停留时为 null */
  avgDwellMs: number | null;
}
