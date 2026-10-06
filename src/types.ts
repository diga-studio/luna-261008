/** 告警等级：信息 -> 警告 -> 严重 */
export type AlertLevel = 'INFO' | 'WARNING' | 'CRITICAL';

/** 告警记录（读取模型） */
export interface AlertRecord {
  alertId: string;
  callId: string;
  /** 告警创建的业务时间（UTC 毫秒） */
  createdAt: number;
  /** 当前等级（随升级事件推进） */
  level: AlertLevel;
  /** 确认时间；未确认为 null */
  acknowledgedAt: number | null;
}

/** 通知记录（读取模型），occurredAt 为逻辑发生时间而非补算时间 */
export interface NotificationRecord {
  notificationId: string;
  alertId: string;
  callId: string;
  level: AlertLevel;
  occurredAt: number;
}

/** 业务时间输入：UTC 毫秒时间戳或 Date */
export type BusinessTime = number | Date;

export interface RegisterSegmentInput {
  callId: string;
  segmentSeq: number;
  score: number;
  businessTime: BusinessTime;
}

export interface RegisterSegmentResult {
  /** 本次登记是否触发了新告警（连续第三个负面分段） */
  createdAlert: AlertRecord | null;
}

export interface AcknowledgeAlertInput {
  alertId: string;
  businessTime: BusinessTime;
}
