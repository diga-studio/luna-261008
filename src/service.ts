import { randomUUID } from 'node:crypto';
import { AlertDatabase, alertRowToRecord } from './db.js';
import { isInSilenceWindow, nextSilenceEndAfter } from './silence.js';
import type {
  AcknowledgeAlertInput,
  AlertRecord,
  BusinessTime,
  NotificationRecord,
  RegisterSegmentInput,
  RegisterSegmentResult,
} from './types.js';

/** 负面评分阈值：严格小于 -0.5 视为负面 */
export const NEGATIVE_THRESHOLD = -0.5;
/** 连续负面分段触发告警的数量 */
export const CONSECUTIVE_NEGATIVE_TRIGGER = 3;
/** 创建 -> 警告 升级间隔（毫秒） */
export const ESCALATION_TO_WARNING_MS = 15 * 60 * 1000;
/** 创建 -> 严重 升级间隔（毫秒） */
export const ESCALATION_TO_CRITICAL_MS = 30 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

interface DueEvent {
  time: number;
  /** 同一时刻先升级，再处理静默结束 */
  kind: 'escalate_warning' | 'escalate_critical' | 'silence_end';
  alertId?: string;
}

function eventOrder(kind: DueEvent['kind']): number {
  return kind === 'silence_end' ? 1 : 0;
}

/** 坐席负面情绪告警服务：登记分段、确认告警、推进业务时间、读取状态与通知 */
export class AlertingService {
  private readonly db: AlertDatabase;

  constructor(dbPath: string) {
    this.db = new AlertDatabase(dbPath);
  }

  close(): void {
    this.db.close();
  }

  /** 登记一个分段评分；重复投递（同 callId + segmentSeq）幂等 */
  registerSegment(input: RegisterSegmentInput): RegisterSegmentResult {
    const time = normalizeBusinessTime(input.businessTime);
    return this.db.transaction(() => {
      this.processDueEvents(time);

      if (this.db.getSegmentScore(input.callId, input.segmentSeq) !== null) {
        // 重复投递：内容相同，直接忽略
        return { createdAlert: null };
      }
      this.db.insertSegment(input.callId, input.segmentSeq, input.score, time);

      const callState = this.db.getCallState(input.callId) ?? {
        lastSeq: 0,
        consecutiveNegatives: 0,
      };
      const consecutiveNegatives =
        input.score < NEGATIVE_THRESHOLD ? callState.consecutiveNegatives + 1 : 0;
      this.db.upsertCallState(
        input.callId,
        Math.max(callState.lastSeq, input.segmentSeq),
        consecutiveNegatives,
      );

      if (consecutiveNegatives !== CONSECUTIVE_NEGATIVE_TRIGGER) {
        return { createdAlert: null };
      }

      const alertId = randomUUID();
      this.db.insertAlert(alertId, input.callId, time);
      if (!isInSilenceWindow(time)) {
        this.db.insertNotificationIfAbsent(randomUUID(), alertId, input.callId, 'INFO', time);
      }
      const alert = this.db.getAlert(alertId);
      return { createdAlert: alert === null ? null : alertRowToRecord(alert) };
    });
  }

  /** 确认告警：停止后续升级与通知；重复确认幂等 */
  acknowledgeAlert(input: AcknowledgeAlertInput): void {
    const time = normalizeBusinessTime(input.businessTime);
    this.db.transaction(() => {
      this.processDueEvents(time);
      const alert = this.db.getAlert(input.alertId);
      if (alert === null) {
        throw new Error(`alert not found: ${input.alertId}`);
      }
      this.db.acknowledgeAlert(input.alertId, time);
    });
  }

  /** 推进业务时间：处理截至该时间的所有到期事件 */
  advanceTime(businessTime: BusinessTime): void {
    const time = normalizeBusinessTime(businessTime);
    this.db.transaction(() => {
      this.processDueEvents(time);
    });
  }

  /** 读取某路通话的告警状态（不消费任何数据） */
  getAlerts(callId: string): AlertRecord[] {
    return this.db.listAlerts(callId).map(alertRowToRecord);
  }

  /** 读取历史通知；不传 callId 时返回全部 */
  getNotifications(callId?: string): NotificationRecord[] {
    return this.db.listNotifications(callId);
  }

  /**
   * 处理 (lastProcessed, now] 内的所有到期事件。
   * 同一时刻先升级、再处理静默结束；调用方在此之后再应用本次业务动作。
   */
  private processDueEvents(now: number): void {
    const lastProcessed = this.db.getLastProcessedTime();
    if (lastProcessed !== null && now < lastProcessed) {
      throw new Error(
        `business time must not go backwards: last=${lastProcessed}, got=${now}`,
      );
    }
    const since = lastProcessed === null ? Number.NEGATIVE_INFINITY : lastProcessed;

    const events: DueEvent[] = [];
    const unacknowledged = this.db.listUnacknowledgedAlerts();
    for (const alert of unacknowledged) {
      const warningAt = alert.created_at + ESCALATION_TO_WARNING_MS;
      const criticalAt = alert.created_at + ESCALATION_TO_CRITICAL_MS;
      if (warningAt > since && warningAt <= now) {
        events.push({ time: warningAt, kind: 'escalate_warning', alertId: alert.alert_id });
      }
      if (criticalAt > since && criticalAt <= now) {
        events.push({ time: criticalAt, kind: 'escalate_critical', alertId: alert.alert_id });
      }
    }

    if (unacknowledged.length > 0) {
      const earliestCreated = Math.min(...unacknowledged.map((a) => a.created_at));
      const lowerBound = Math.max(since, earliestCreated);
      for (
        let boundary = nextSilenceEndAfter(lowerBound);
        boundary <= now;
        boundary += DAY_MS
      ) {
        events.push({ time: boundary, kind: 'silence_end' });
      }
    }

    events.sort((a, b) => a.time - b.time || eventOrder(a.kind) - eventOrder(b.kind));

    for (const event of events) {
      if (event.kind === 'silence_end') {
        this.handleSilenceEnd(event.time);
      } else {
        this.handleEscalation(event);
      }
    }

    this.db.setLastProcessedTime(now);
  }

  private handleEscalation(event: DueEvent): void {
    const alertId = event.alertId;
    if (alertId === undefined) return;
    const alert = this.db.getAlert(alertId);
    if (alert === null || alert.acknowledged_at !== null) return;

    if (event.kind === 'escalate_warning') {
      if (alert.level !== 'INFO') return;
      this.db.setAlertLevel(alertId, 'WARNING');
      if (!isInSilenceWindow(event.time)) {
        this.db.insertNotificationIfAbsent(randomUUID(), alertId, alert.call_id, 'WARNING', event.time);
      }
    } else {
      if (alert.level !== 'WARNING') return;
      this.db.setAlertLevel(alertId, 'CRITICAL');
      // 严重级不受静默窗口限制
      this.db.insertNotificationIfAbsent(randomUUID(), alertId, alert.call_id, 'CRITICAL', event.time);
    }
  }

  /** 静默结束：仍未确认的告警只补发当时等级一条，跳过此前被抑制的等级 */
  private handleSilenceEnd(time: number): void {
    for (const alert of this.db.listUnacknowledgedAlerts()) {
      if (alert.created_at >= time) continue;
      this.db.insertNotificationIfAbsent(randomUUID(), alert.alert_id, alert.call_id, alert.level, time);
    }
  }
}

export function normalizeBusinessTime(time: BusinessTime): number {
  const ms = typeof time === 'number' ? time : time.getTime();
  if (!Number.isFinite(ms)) {
    throw new Error(`invalid business time: ${String(time)}`);
  }
  return ms;
}

export { alertRowToRecord };
