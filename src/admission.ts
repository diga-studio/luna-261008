import { AdmissionStore } from './db.js';
import { SESSION_TTL_MS } from './types.js';
import type {
  AdmissionOptions,
  ApplicationRecord,
  ApplyResult,
  ChannelStatus,
  ConfirmResult,
  LeaveResult,
  SeatNotifier,
} from './types.js';

/**
 * 直播频道观众入场库。
 *
 * 不变式（每次公开调用结束时成立）：
 * - reserved + watching 总数 <= 频道容量；
 * - 只要候补队列非空，就不存在可分配的空位；
 * - 已结束的申请不会复活。
 */
export class ChannelAdmission {
  private readonly store: AdmissionStore;
  private readonly capacityOf: (channelId: string) => number;
  private readonly notifier: SeatNotifier | undefined;
  private readonly now: () => number;

  constructor(options: AdmissionOptions) {
    this.store = new AdmissionStore(options.dbPath);
    this.capacityOf =
      typeof options.capacity === 'function' ? options.capacity : () => options.capacity as number;
    this.notifier = options.notifier;
    this.now = options.now ?? Date.now;
  }

  close(): void {
    this.store.close();
  }

  /** 申请入场：携带用户标识与频道内唯一的申请标识。 */
  async apply(channelId: string, userId: string, requestId: string): Promise<ApplyResult> {
    const now = this.now();
    const { result, promoted } = this.store.transaction(() => {
      const promoted = this.sweep(channelId, now);

      const existing = this.store.get(channelId, requestId);
      if (existing) {
        // 重试不新增占位、不改变候补顺序、不延长期限；已结束的申请不复活。
        return {
          result: existing.state === 'ended'
            ? ({ kind: 'ended', record: existing } satisfies ApplyResult)
            : ({ kind: 'duplicate', record: existing } satisfies ApplyResult),
          promoted,
        };
      }

      const active = this.store.findActiveByUser(channelId, userId);
      if (active) {
        // 一个用户在同一频道最多一个未结束申请；新申请不能替换它。
        return { result: { kind: 'conflict', existing: active } satisfies ApplyResult, promoted };
      }

      const capacity = this.capacityOf(channelId);
      const seatedCount = this.store.listSeated(channelId).length;
      const queue = this.store.listQueued(channelId);
      const record: ApplicationRecord = {
        channelId,
        requestId,
        userId,
        state: 'queued',
        expiresAt: null,
        queueSeq: null,
        createdAt: now,
        updatedAt: now,
      };

      if (seatedCount < capacity && queue.length === 0) {
        record.state = 'reserved';
        record.expiresAt = now + SESSION_TTL_MS;
        this.store.insert(record);
        return { result: { kind: 'reserved', record } satisfies ApplyResult, promoted };
      }

      record.queueSeq = this.store.nextQueueSeq(channelId);
      this.store.insert(record);
      return {
        result: { kind: 'queued', record, position: queue.length + 1 } satisfies ApplyResult,
        promoted,
      };
    });
    await this.notifyPromoted(promoted);
    return result;
  }

  /** 确认（reserved -> watching）或续期（watching 延长 60 秒）。只作用于指定申请。 */
  async confirm(channelId: string, userId: string, requestId: string): Promise<ConfirmResult> {
    const now = this.now();
    const { result, promoted } = this.store.transaction(() => {
      const promoted = this.sweep(channelId, now);
      const record = this.store.get(channelId, requestId);
      if (!record || record.userId !== userId) {
        return { result: { kind: 'not-active', record } satisfies ConfirmResult, promoted };
      }
      if (record.state === 'reserved') {
        record.state = 'watching';
        record.expiresAt = now + SESSION_TTL_MS;
        record.updatedAt = now;
        this.store.update(record);
        return { result: { kind: 'confirmed', record } satisfies ConfirmResult, promoted };
      }
      if (record.state === 'watching') {
        record.expiresAt = now + SESSION_TTL_MS;
        record.updatedAt = now;
        this.store.update(record);
        return { result: { kind: 'renewed', record } satisfies ConfirmResult, promoted };
      }
      // queued / ended：迟到的确认不改变任何状态。
      return { result: { kind: 'not-active', record } satisfies ConfirmResult, promoted };
    });
    await this.notifyPromoted(promoted);
    return result;
  }

  /** 退出：结束指定申请并释放席位（若有），随后按候补顺序补位。 */
  async leave(channelId: string, userId: string, requestId: string): Promise<LeaveResult> {
    const now = this.now();
    const { result, promoted } = this.store.transaction(() => {
      const promoted = this.sweep(channelId, now);
      const record = this.store.get(channelId, requestId);
      if (!record || record.userId !== userId || record.state === 'ended') {
        return { result: { kind: 'not-active', record } satisfies LeaveResult, promoted };
      }
      record.state = 'ended';
      record.expiresAt = null;
      record.queueSeq = null;
      record.updatedAt = now;
      this.store.update(record);
      promoted.push(...this.promote(channelId, now));
      return { result: { kind: 'left', record } satisfies LeaveResult, promoted };
    });
    await this.notifyPromoted(promoted);
    return result;
  }

  /** 频道状态快照：先按当前时刻结算到期与补位，再返回。 */
  async status(channelId: string): Promise<ChannelStatus> {
    const now = this.now();
    const { status, promoted } = this.store.transaction(() => {
      const promoted = this.sweep(channelId, now);
      const seated = this.store.listSeated(channelId);
      const queued = this.store.listQueued(channelId);
      const status: ChannelStatus = {
        channelId,
        capacity: this.capacityOf(channelId),
        reservedCount: seated.filter((r) => r.state === 'reserved').length,
        watchingCount: seated.filter((r) => r.state === 'watching').length,
        occupiedCount: seated.length,
        queued: queued.map((r, i) => ({ requestId: r.requestId, userId: r.userId, position: i + 1 })),
      };
      return { status, promoted };
    });
    await this.notifyPromoted(promoted);
    return status;
  }

  /**
   * 结算到当前时刻：到期席位结束，再按候补顺序补位。
   * 返回本次补位获得席位的申请（用于提交后通知）。
   */
  private sweep(channelId: string, now: number): ApplicationRecord[] {
    for (const expired of this.store.listExpiredSeated(channelId, now)) {
      expired.state = 'ended';
      expired.expiresAt = null;
      expired.updatedAt = now;
      this.store.update(expired);
    }
    return this.promote(channelId, now);
  }

  /** 用候补填满空位；补位的新 60 秒从实际分配时刻（now）起算。 */
  private promote(channelId: string, now: number): ApplicationRecord[] {
    const capacity = this.capacityOf(channelId);
    const promoted: ApplicationRecord[] = [];
    let seatedCount = this.store.listSeated(channelId).length;
    for (const next of this.store.listQueued(channelId)) {
      if (seatedCount >= capacity) break;
      next.state = 'reserved';
      next.expiresAt = now + SESSION_TTL_MS;
      next.queueSeq = null;
      next.updatedAt = now;
      this.store.update(next);
      seatedCount += 1;
      promoted.push(next);
    }
    return promoted;
  }

  /** 占位已在事务中生效后才发通知；接收方抛错不撤销占位。 */
  private async notifyPromoted(promoted: ApplicationRecord[]): Promise<void> {
    if (!this.notifier) return;
    for (const record of promoted) {
      try {
        await this.notifier({
          channelId: record.channelId,
          requestId: record.requestId,
          userId: record.userId,
        });
      } catch {
        // 通知失败不撤销占位，也不延长期限。
      }
    }
  }
}
