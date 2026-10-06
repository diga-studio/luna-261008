import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from './db.js';
import type {
  AdmissionOptions,
  ApplicationStatus,
  ApplyResult,
  ChannelState,
  ConfirmResult,
  LeaveResult,
  SeatAssignedEvent,
  SeatNotifier,
} from './types.js';

interface ApplicationRow {
  channel_id: string;
  request_id: string;
  user_id: string;
  status: ApplicationStatus;
  expires_at: number | null;
}

const ACTIVE_STATUSES = "('reserved', 'watching')";

/** 直播频道观众入场服务：申请、确认/续期、退出、状态查询。 */
export class AdmissionService {
  private readonly db: DatabaseSync;
  private readonly capacityOf: (channelId: string) => number;
  private readonly notifier: SeatNotifier;
  private readonly now: () => number;
  private readonly holdMs: number;

  constructor(options: AdmissionOptions) {
    this.db = openDatabase(options.dbPath);
    this.capacityOf =
      typeof options.capacity === 'function' ? options.capacity : () => options.capacity as number;
    this.notifier = options.notify;
    this.now = options.now ?? (() => Date.now());
    this.holdMs = options.holdMs ?? 60_000;
  }

  /** 申请入场。幂等：同一 requestId 重复提交返回当前状态，不产生副作用。 */
  async apply(channelId: string, userId: string, requestId: string): Promise<ApplyResult> {
    const now = this.now();
    await this.settleChannel(channelId, now);

    const existing = this.getApplication(channelId, requestId);
    if (existing) {
      // 重复提交同一申请：不新增占位、不改候补顺序、不延长期限；已结束的不复活。
      return {
        requestId,
        userId: existing.user_id,
        accepted: existing.status !== 'ended',
        status: existing.status,
        expiresAt: existing.expires_at,
        conflictRequestId: null,
      };
    }

    const conflict = this.getActiveApplicationOfUser(channelId, userId);
    if (conflict) {
      // 新申请不能替换尚未结束的申请。
      return {
        requestId,
        userId,
        accepted: false,
        status: null,
        expiresAt: null,
        conflictRequestId: conflict.request_id,
      };
    }

    const capacity = this.capacityOf(channelId);
    const occupied = this.countOccupied(channelId);
    const queued = this.countQueued(channelId);
    const directSeat = occupied < capacity && queued === 0;
    const status: ApplicationStatus = directSeat ? 'reserved' : 'queued';
    const expiresAt = directSeat ? now + this.holdMs : null;
    this.db
      .prepare(
        `INSERT INTO applications (channel_id, request_id, user_id, status, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(channelId, requestId, userId, status, expiresAt, now, now);

    return { requestId, userId, accepted: true, status, expiresAt, conflictRequestId: null };
  }

  /** 确认（保留→观看）或续期（观看→延长 60 秒）。 */
  async confirm(channelId: string, userId: string, requestId: string): Promise<ConfirmResult> {
    const now = this.now();
    await this.settleChannel(channelId, now);

    const row = this.getApplication(channelId, requestId);
    if (!row || row.user_id !== userId) {
      return { ok: false, expiresAt: null, reason: 'not-found' };
    }
    if (row.status === 'ended') {
      return { ok: false, expiresAt: null, reason: 'ended' };
    }
    if (row.status === 'queued') {
      return { ok: false, expiresAt: null, reason: 'not-active' };
    }
    const expiresAt = now + this.holdMs;
    this.db
      .prepare(
        `UPDATE applications SET status = 'watching', expires_at = ?, updated_at = ?
         WHERE channel_id = ? AND request_id = ?`,
      )
      .run(expiresAt, now, channelId, requestId);
    return { ok: true, expiresAt };
  }

  /** 退出：结束指定申请并释放席位。 */
  async leave(channelId: string, userId: string, requestId: string): Promise<LeaveResult> {
    const now = this.now();
    await this.settleChannel(channelId, now);

    const row = this.getApplication(channelId, requestId);
    if (!row || row.user_id !== userId || row.status === 'ended') {
      return { ended: false };
    }
    this.endApplication(channelId, requestId, now);
    await this.promote(channelId, now);
    return { ended: true };
  }

  /** 查看频道状态（反映当前时刻已到期席位与补位结果）。 */
  async getChannelState(channelId: string): Promise<ChannelState> {
    const now = this.now();
    await this.settleChannel(channelId, now);

    const seatRows = this.db
      .prepare(
        `SELECT request_id, user_id, status, expires_at FROM applications
         WHERE channel_id = ? AND status IN ${ACTIVE_STATUSES}
         ORDER BY expires_at ASC, rowid ASC`,
      )
      .all(channelId) as unknown as Array<{
      request_id: string;
      user_id: string;
      status: 'reserved' | 'watching';
      expires_at: number;
    }>;
    const queueRows = this.db
      .prepare(
        `SELECT request_id, user_id FROM applications
         WHERE channel_id = ? AND status = 'queued'
         ORDER BY rowid ASC`,
      )
      .all(channelId) as unknown as Array<{ request_id: string; user_id: string }>;

    return {
      channelId,
      capacity: this.capacityOf(channelId),
      occupied: seatRows.length,
      seats: seatRows.map((row) => ({
        requestId: row.request_id,
        userId: row.user_id,
        status: row.status,
        expiresAt: row.expires_at,
      })),
      queue: queueRows.map((row, index) => ({
        requestId: row.request_id,
        userId: row.user_id,
        position: index + 1,
      })),
    };
  }

  /** 关闭底层数据库连接。 */
  close(): void {
    this.db.close();
  }

  /** 让频道状态推进到当前时刻：先结束到期申请，再按候补顺序补位并通知。 */
  private async settleChannel(channelId: string, now: number): Promise<void> {
    // 到期时刻等于当前时刻即失效。
    this.db
      .prepare(
        `UPDATE applications SET status = 'ended', expires_at = NULL, updated_at = ?
         WHERE channel_id = ? AND status IN ${ACTIVE_STATUSES} AND expires_at <= ?`,
      )
      .run(now, channelId, now);
    await this.promote(channelId, now);
  }

  /** 按成功入队的先后顺序补位；补位 60 秒自实际分配时起算，通知失败不撤销占位。 */
  private async promote(channelId: string, now: number): Promise<void> {
    const capacity = this.capacityOf(channelId);
    const events: SeatAssignedEvent[] = [];
    for (;;) {
      const occupied = this.countOccupied(channelId);
      if (occupied >= capacity) break;
      const next = this.db
        .prepare(
          `SELECT request_id, user_id FROM applications
           WHERE channel_id = ? AND status = 'queued'
           ORDER BY rowid ASC LIMIT 1`,
        )
        .get(channelId) as unknown as { request_id: string; user_id: string } | undefined;
      if (!next) break;
      const expiresAt = now + this.holdMs;
      // 占位先生效，再发通知。
      this.db
        .prepare(
          `UPDATE applications SET status = 'reserved', expires_at = ?, updated_at = ?
           WHERE channel_id = ? AND request_id = ?`,
        )
        .run(expiresAt, now, channelId, next.request_id);
      events.push({
        channelId,
        userId: next.user_id,
        requestId: next.request_id,
        expiresAt,
      });
    }
    for (const event of events) {
      try {
        await this.notifier(event);
      } catch {
        // 接收方抛错不撤销占位，也不延长期限。
      }
    }
  }

  private getApplication(channelId: string, requestId: string): ApplicationRow | undefined {
    return this.db
      .prepare(
        `SELECT channel_id, request_id, user_id, status, expires_at FROM applications
         WHERE channel_id = ? AND request_id = ?`,
      )
      .get(channelId, requestId) as unknown as ApplicationRow | undefined;
  }

  private getActiveApplicationOfUser(
    channelId: string,
    userId: string,
  ): ApplicationRow | undefined {
    return this.db
      .prepare(
        `SELECT channel_id, request_id, user_id, status, expires_at FROM applications
         WHERE channel_id = ? AND user_id = ? AND status != 'ended'
         ORDER BY rowid ASC LIMIT 1`,
      )
      .get(channelId, userId) as unknown as ApplicationRow | undefined;
  }

  private endApplication(channelId: string, requestId: string, now: number): void {
    this.db
      .prepare(
        `UPDATE applications SET status = 'ended', expires_at = NULL, updated_at = ?
         WHERE channel_id = ? AND request_id = ?`,
      )
      .run(now, channelId, requestId);
  }

  private countOccupied(channelId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM applications
         WHERE channel_id = ? AND status IN ${ACTIVE_STATUSES}`,
      )
      .get(channelId) as unknown as { n: number };
    return row.n;
  }

  private countQueued(channelId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM applications
         WHERE channel_id = ? AND status = 'queued'`,
      )
      .get(channelId) as unknown as { n: number };
    return row.n;
  }
}
