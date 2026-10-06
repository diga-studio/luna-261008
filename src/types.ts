/** Alert severity levels, ordered by escalation. */
export type AlertLevel = 'INFO' | 'WARN' | 'CRITICAL';

export const LEVEL_ORDER: Record<AlertLevel, number> = {
  INFO: 0,
  WARN: 1,
  CRITICAL: 2,
};

/** Input for registering one conversation segment score. */
export interface SegmentInput {
  callId: string;
  segmentIndex: number;
  score: number;
  /** Non-decreasing UTC business time, epoch milliseconds. */
  businessTime: number;
}

export interface AlertRecord {
  id: string;
  callId: string;
  createdAt: number;
  level: AlertLevel;
  confirmedAt: number | null;
}

export interface NotificationRecord {
  id: string;
  alertId: string;
  callId: string;
  level: AlertLevel;
  /** Logical business time when the notification took effect. */
  publishedAt: number;
}

export interface AlertStatus {
  alert: AlertRecord;
  notifications: NotificationRecord[];
}
