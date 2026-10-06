import { DatabaseSync } from 'node:sqlite';
import { openDatabase, nextSeq } from './db.js';
import { allocateTitle } from './allocation.js';
import type {
  Barcode,
  BranchId,
  CancelResult,
  CheckinResult,
  CopyInfo,
  Credential,
  HoldInfo,
  LoanInfo,
  PickupResult,
  PlaceHoldResult,
  ReaderId,
  Title,
  TransferInfo,
} from './types.js';

interface HoldRow {
  hold_id: number;
  title: string;
  reader: string;
  pickup_branch: string;
  status: HoldInfo['status'];
  queue_seq: number;
  barcode: string | null;
}

interface CopyRow {
  barcode: string;
  title: string;
  status: CopyInfo['status'];
  branch: string | null;
  hold_id: number | null;
  transfer_credential: string | null;
  loan_credential: string | null;
}

function toHoldInfo(r: HoldRow): HoldInfo {
  return {
    holdId: r.hold_id,
    title: r.title,
    reader: r.reader,
    pickupBranch: r.pickup_branch,
    status: r.status,
    queueSeq: r.queue_seq,
    barcode: r.barcode,
  };
}

function toCopyInfo(r: CopyRow): CopyInfo {
  return {
    barcode: r.barcode,
    title: r.title,
    status: r.status,
    branch: r.branch,
    holdId: r.hold_id,
    transferCredential: r.transfer_credential,
    loanCredential: r.loan_credential,
  };
}

/**
 * ShelfSync 馆际预约模块。
 * 由上层调用；所有状态保存在 SQLite。
 * 所有办理操作同步执行并包裹在事务中：并发调用的结果等价于
 * 某个逐笔办理顺序，查询不会看到半完成的分配。
 */
export class ShelfSync {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = openDatabase(dbPath);
  }

  close(): void {
    this.db.close();
  }

  /** 在单条事务内执行多步写操作。 */
  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private getHoldRow(holdId: number): HoldRow | undefined {
    return this.db.prepare('SELECT * FROM holds WHERE hold_id = ?').get(holdId) as
      | HoldRow
      | undefined;
  }

  private getCopyRow(barcode: Barcode): CopyRow | undefined {
    return this.db.prepare('SELECT * FROM copies WHERE barcode = ?').get(barcode) as
      | CopyRow
      | undefined;
  }

  /** 首次建立馆藏：登记一册在架馆藏。 */
  async registerCopy(title: Title, barcode: Barcode, branch: BranchId): Promise<void> {
    this.tx(() => {
      const existing = this.getCopyRow(barcode);
      if (existing) throw new Error(`copy already registered: ${barcode}`);
      this.db
        .prepare(
          `INSERT INTO copies (barcode, title, status, branch, hold_id, transfer_credential, loan_credential)
           VALUES (?, ?, 'on_shelf', ?, NULL, NULL, NULL)`,
        )
        .run(barcode, title, branch);
      allocateTitle(this.db, title);
    });
  }

  /** 读者对题名发起预约，指定领取分馆；进入队尾。 */
  async placeHold(title: Title, reader: ReaderId, pickupBranch: BranchId): Promise<PlaceHoldResult> {
    return this.tx(() => {
      const queueSeq = nextSeq(this.db, 'hold_queue');
      const res = this.db
        .prepare(
          `INSERT INTO holds (title, reader, pickup_branch, status, queue_seq, barcode)
           VALUES (?, ?, ?, 'pending', ?, NULL)`,
        )
        .run(title, reader, pickupBranch, queueSeq);
      const holdId = Number(res.lastInsertRowid);
      allocateTitle(this.db, title);
      return { holdId };
    });
  }

  /** 撤销未领取的预约。 */
  async cancelHold(holdId: number): Promise<CancelResult> {
    return this.tx(() => {
      const hold = this.getHoldRow(holdId);
      if (!hold) return { ok: false as const, reason: 'not_found' as const };
      if (hold.status === 'cancelled') return { ok: false as const, reason: 'already_cancelled' as const };
      if (hold.status === 'fulfilled') return { ok: false as const, reason: 'already_fulfilled' as const };

      if (hold.barcode) {
        // 解除绑定。若册在途，仍沿原调拨到馆（目的分馆不变），仅解除关联。
        this.db.prepare('UPDATE copies SET hold_id = NULL WHERE barcode = ?').run(hold.barcode);
        this.db
          .prepare(`UPDATE transfers SET hold_id = NULL WHERE barcode = ? AND status = 'open'`)
          .run(hold.barcode);
      }
      this.db
        .prepare(`UPDATE holds SET status = 'cancelled', barcode = NULL WHERE hold_id = ?`)
        .run(holdId);
      allocateTitle(this.db, hold.title);
      return { ok: true as const };
    });
  }

  /** 入馆办理：归还（借出凭据，可在任意分馆）或调拨到馆（调拨凭据）。 */
  async checkin(credential: Credential, branch: BranchId): Promise<CheckinResult> {
    return this.tx(() => {
      const transfer = this.db
        .prepare('SELECT * FROM transfers WHERE credential = ?')
        .get(credential) as
        | { credential: string; barcode: string; dest_branch: string; hold_id: number | null; status: string }
        | undefined;
      if (transfer) {
        if (transfer.status === 'closed') return { ok: false as const, reason: 'already_closed' as const };
        this.db.prepare(`UPDATE transfers SET status = 'closed' WHERE credential = ?`).run(credential);
        const copy = this.getCopyRow(transfer.barcode);
        if (!copy || copy.transfer_credential !== credential) {
          // 旧凭据：册已进入后续借出/调拨，不得改变其状态
          return { ok: false as const, reason: 'already_closed' as const };
        }
        // 调拨到馆：目的分馆固定，以调拨单为准
        this.db
          .prepare(
            `UPDATE copies SET status = 'on_shelf', branch = ?, transfer_credential = NULL
             WHERE barcode = ?`,
          )
          .run(transfer.dest_branch, transfer.barcode);
        if (transfer.hold_id !== null) {
          // 绑定预约的册到馆：预约进入可领取状态
          this.db.prepare(`UPDATE holds SET status = 'ready' WHERE hold_id = ?`).run(transfer.hold_id);
        }
        allocateTitle(this.db, copy.title);
        return { ok: true as const, kind: 'transfer' as const };
      }

      const loan = this.db.prepare('SELECT * FROM loans WHERE credential = ?').get(credential) as
        | { credential: string; barcode: string; reader: string; hold_id: number; status: string }
        | undefined;
      if (loan) {
        if (loan.status === 'closed') return { ok: false as const, reason: 'already_closed' as const };
        this.db.prepare(`UPDATE loans SET status = 'closed' WHERE credential = ?`).run(credential);
        const copy = this.getCopyRow(loan.barcode);
        if (!copy || copy.loan_credential !== credential) {
          return { ok: false as const, reason: 'already_closed' as const };
        }
        // 归还：可在任意分馆入馆，成为该分馆在架册
        this.db
          .prepare(
            `UPDATE copies SET status = 'on_shelf', branch = ?, loan_credential = NULL
             WHERE barcode = ?`,
          )
          .run(branch, loan.barcode);
        allocateTitle(this.db, copy.title);
        return { ok: true as const, kind: 'loan' as const };
      }

      return { ok: false as const, reason: 'unknown_credential' as const };
    });
  }

  /** 读者在指定分馆领取已到馆的册。 */
  async pickup(holdId: number, reader: ReaderId, branch: BranchId): Promise<PickupResult> {
    return this.tx(() => {
      const hold = this.getHoldRow(holdId);
      if (!hold) return { ok: false as const, reason: 'not_found' as const };
      if (hold.status === 'cancelled') return { ok: false as const, reason: 'already_cancelled' as const };
      if (hold.status === 'fulfilled') return { ok: false as const, reason: 'already_fulfilled' as const };
      if (hold.reader !== reader) return { ok: false as const, reason: 'wrong_reader' as const };
      if (hold.pickup_branch !== branch) return { ok: false as const, reason: 'wrong_branch' as const };
      if (hold.status !== 'ready' || !hold.barcode) return { ok: false as const, reason: 'not_ready' as const };

      const copy = this.getCopyRow(hold.barcode);
      if (!copy || copy.status !== 'on_shelf' || copy.branch !== hold.pickup_branch || copy.hold_id !== holdId) {
        return { ok: false as const, reason: 'not_ready' as const };
      }

      const credential = `L-${nextSeq(this.db, 'loan')}`;
      this.db
        .prepare(
          `INSERT INTO loans (credential, barcode, reader, hold_id, status)
           VALUES (?, ?, ?, ?, 'open')`,
        )
        .run(credential, hold.barcode, reader, holdId);
      this.db
        .prepare(
          `UPDATE copies SET status = 'checked_out', branch = NULL, hold_id = NULL,
             loan_credential = ?
           WHERE barcode = ?`,
        )
        .run(credential, hold.barcode);
      this.db.prepare(`UPDATE holds SET status = 'fulfilled' WHERE hold_id = ?`).run(holdId);
      allocateTitle(this.db, hold.title);
      return { ok: true as const, loanCredential: credential };
    });
  }

  /** 查询预约。 */
  async getHold(holdId: number): Promise<HoldInfo | null> {
    const row = this.getHoldRow(holdId);
    return row ? toHoldInfo(row) : null;
  }

  /** 查询某题名的预约队列（按接受顺序）。 */
  async listHolds(title: Title): Promise<HoldInfo[]> {
    const rows = this.db
      .prepare('SELECT * FROM holds WHERE title = ? ORDER BY queue_seq ASC')
      .all(title) as unknown as HoldRow[];
    return rows.map(toHoldInfo);
  }

  /** 查询册的当前状态与去向。 */
  async getCopy(barcode: Barcode): Promise<CopyInfo | null> {
    const row = this.getCopyRow(barcode);
    return row ? toCopyInfo(row) : null;
  }

  /** 核对用：列出全部册的当前状态与去向。 */
  async listCopies(): Promise<CopyInfo[]> {
    const rows = this.db.prepare('SELECT * FROM copies ORDER BY barcode ASC').all() as unknown as CopyRow[];
    return rows.map(toCopyInfo);
  }

  /** 查询调拨单。 */
  async getTransfer(credential: Credential): Promise<TransferInfo | null> {
    const row = this.db.prepare('SELECT * FROM transfers WHERE credential = ?').get(credential) as
      | { credential: string; barcode: string; dest_branch: string; hold_id: number | null; status: 'open' | 'closed' }
      | undefined;
    if (!row) return null;
    return {
      credential: row.credential,
      barcode: row.barcode,
      destBranch: row.dest_branch,
      holdId: row.hold_id,
      status: row.status,
    };
  }

  /** 查询借出记录。 */
  async getLoan(credential: Credential): Promise<LoanInfo | null> {
    const row = this.db.prepare('SELECT * FROM loans WHERE credential = ?').get(credential) as
      | { credential: string; barcode: string; reader: string; hold_id: number; status: 'open' | 'closed' }
      | undefined;
    if (!row) return null;
    return {
      credential: row.credential,
      barcode: row.barcode,
      reader: row.reader,
      holdId: row.hold_id,
      status: row.status,
    };
  }
}
