/** 申请在频道内的生命周期状态。 */
export type ApplicationStatus = 'reserved' | 'watching' | 'queued' | 'ended';

/** 申请入场的结果。 */
export interface ApplyResult {
  /** 申请标识（频道内唯一）。 */
  requestId: string;
  userId: string;
  /**
   * true：该申请有效（直接获席、进入候补，或幂等重放了此前已受理的申请）。
   * false：被拒绝——用户在该频道已有其他未结束申请，或该标识的申请已结束不可复活。
   */
  accepted: boolean;
  /** 调用结束后该申请的状态；新申请被拒绝时为 null。 */
  status: ApplicationStatus | null;
  /** 保留/观看的到期时刻（Unix 毫秒）；其余情况为 null。 */
  expiresAt: number | null;
  /** 因用户已有未结束申请而被拒时，给出那个申请的标识。 */
  conflictRequestId: string | null;
}

export type ConfirmFailureReason = 'not-found' | 'not-active' | 'ended';

export interface ConfirmResult {
  ok: boolean;
  /** 确认/续期成功后的到期时刻；失败时为 null。 */
  expiresAt: number | null;
  reason?: ConfirmFailureReason;
}

export interface LeaveResult {
  /** true 表示该申请因本次调用而结束；false 表示它此前已结束或不存在。 */
  ended: boolean;
}

export interface SeatInfo {
  requestId: string;
  userId: string;
  status: 'reserved' | 'watching';
  expiresAt: number;
}

export interface QueueEntry {
  requestId: string;
  userId: string;
  /** 候补位置，从 1 开始。 */
  position: number;
}

/** 频道在某个时刻的状态快照（已反映到期与补位）。 */
export interface ChannelState {
  channelId: string;
  capacity: number;
  /** 保留 + 观看的席位总数。 */
  occupied: number;
  seats: SeatInfo[];
  queue: QueueEntry[];
}

/** 候补获席通知事件。 */
export interface SeatAssignedEvent {
  channelId: string;
  userId: string;
  requestId: string;
  /** 本次占位的到期时刻（自实际分配时起算）。 */
  expiresAt: number;
}

/** 上层提供的异步通知接收方。允许抛错，失败不撤销占位。 */
export type SeatNotifier = (event: SeatAssignedEvent) => Promise<void>;

export interface AdmissionOptions {
  /** SQLite 文件路径，或 ':memory:'。 */
  dbPath: string;
  /** 频道容量：固定值或由上层按频道给出。 */
  capacity: number | ((channelId: string) => number);
  /** 候补获席的异步通知接收方。 */
  notify: SeatNotifier;
  /** 时钟，默认 Date.now；测试可注入。 */
  now?: () => number;
  /** 占位时长（毫秒），默认 60_000。 */
  holdMs?: number;
}
