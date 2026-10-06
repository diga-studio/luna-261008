/** 申请在其生命周期内可能处于的状态。 */
export type ApplicationState =
  | 'reserved' // 已获席，等待确认（保留期）
  | 'watching' // 已确认，正在观看
  | 'queued' // 候补排队中
  | 'ended'; // 已结束（退出或到期），不可复活

/** 席位保留/观看的统一时长（毫秒）。 */
export const SESSION_TTL_MS = 60_000;

/** 单条申请的持久化记录。 */
export interface ApplicationRecord {
  channelId: string;
  requestId: string;
  userId: string;
  state: ApplicationState;
  /** 仅 reserved/watching 有效：到期时刻（epoch ms）。当前时刻 >= 该值即已失效。 */
  expiresAt: number | null;
  /** 仅 queued 有效：入队序号，单调递增，决定补位顺序。 */
  queueSeq: number | null;
  createdAt: number;
  updatedAt: number;
}

/** apply 的返回结果。 */
export type ApplyResult =
  | { kind: 'reserved'; record: ApplicationRecord }
  | { kind: 'queued'; record: ApplicationRecord; position: number }
  | { kind: 'duplicate'; record: ApplicationRecord }
  | { kind: 'ended'; record: ApplicationRecord }
  | { kind: 'conflict'; existing: ApplicationRecord };

/** confirm / renew 的返回结果。 */
export type ConfirmResult =
  | { kind: 'confirmed'; record: ApplicationRecord }
  | { kind: 'renewed'; record: ApplicationRecord }
  | { kind: 'not-active'; record: ApplicationRecord | null };

/** leave 的返回结果。 */
export type LeaveResult =
  | { kind: 'left'; record: ApplicationRecord }
  | { kind: 'not-active'; record: ApplicationRecord | null };

/** 频道状态快照。 */
export interface ChannelStatus {
  channelId: string;
  capacity: number;
  reservedCount: number;
  watchingCount: number;
  occupiedCount: number;
  queued: Array<{ requestId: string; userId: string; position: number }>;
}

/** 上层提供的异步通知接收方：候补获席时调用，携带申请标识。 */
export type SeatNotifier = (event: {
  channelId: string;
  requestId: string;
  userId: string;
}) => Promise<void>;

export interface AdmissionOptions {
  /** SQLite 文件路径，或 ':memory:'。 */
  dbPath: string;
  /** 频道容量：固定值或按频道查询。 */
  capacity: number | ((channelId: string) => number);
  /** 候补获席的异步通知接收方。 */
  notifier?: SeatNotifier | undefined;
  /** 时钟，便于测试；默认 Date.now。 */
  now?: (() => number) | undefined;
}
