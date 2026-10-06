import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { openDatabase } from './db.js';
import type {
  Barcode,
  BranchId,
  CopyInfo,
  CopyStatus,
  Credential,
  ReaderId,
  ReservationInfo,
  ReservationStatus,
  Title,
  TransferInfo,
} from './types.js';

interface CopyRow {
  barcode: string;
  title: string;
  branch: string;
  status: string;
}

interface ReservationRow {
  id: number;
  title: string;
  reader: string;
  pickup_branch: string;
  status: string;
  copy_barcode: string | null;
}

const ACTIVE_RESERVATION_STATUSES = "('pending','ready')";

export class ShelfSync {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = openDatabase(dbPath);
  }

  close(): void {
    this.db.close();
  }

  /** 串行化每笔办理：单连接 + IMMEDIATE 事务，结果等价于逐笔顺序办理。 */
  private transact<T>(fn: () => T): T {
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

  /** 首次建立馆藏：题名、册条码、所在分馆；初始均在架。 */
  addCopy(title: Title, barcode: Barcode, branch: BranchId): void {
    this.transact(() => {
      this.db
        .prepare('INSERT INTO copies (barcode, title, branch, status) VALUES (?, ?, ?, ?)')
        .run(barcode, title, branch, 'on_shelf');
      this.allocate(title);
    });
  }

  /** 批量建立馆藏：单事务写入，之后对涉及的题名统一完成分配。 */
  addCopies(entries: Array<{ title: Title; barcode: Barcode; branch: BranchId }>): void {
    this.transact(() => {
      const stmt = this.db.prepare(
        'INSERT INTO copies (barcode, title, branch, status) VALUES (?, ?, ?, ?)',
      );
      const titles = new Set<Title>();
      for (const entry of entries) {
        stmt.run(entry.barcode, entry.title, entry.branch, 'on_shelf');
        titles.add(entry.title);
      }
      for (const title of titles) this.allocate(title);
    });
  }

  /** 预约题名，返回预约 id；按接受先后排队。 */
  reserve(title: Title, reader: ReaderId, pickupBranch: BranchId): number {
    return this.transact(() => {
      const { lastInsertRowid } = this.db
        .prepare(
          "INSERT INTO reservations (title, reader, pickup_branch, status) VALUES (?, ?, ?, 'pending')",
        )
        .run(title, reader, pickupBranch);
      this.allocate(title);
      return Number(lastInsertRowid);
    });
  }

  /** 撤销未领取预约：解除绑定；在途册仍沿原调拨到馆。 */
  cancel(reservationId: number): void {
    this.transact(() => {
      const row = this.getReservationRow(reservationId);
      if (!row) throw new Error(`reservation ${reservationId} not found`);
      if (row.status === 'cancelled') return;
      if (row.status === 'completed') {
        throw new Error(`reservation ${reservationId} already completed`);
      }
      this.db
        .prepare(
          "UPDATE reservations SET status = 'cancelled', copy_barcode = NULL WHERE id = ?",
        )
        .run(reservationId);
      this.allocate(row.title);
    });
  }

  /** 领取已到馆册，返回借出凭据。只有当前绑定读者能在领取分馆领取。 */
  checkout(reservationId: number, reader: ReaderId, branch: BranchId): Credential {
    return this.transact(() => {
      const row = this.getReservationRow(reservationId);
      if (!row) throw new Error(`reservation ${reservationId} not found`);
      if (row.status !== 'ready') {
        throw new Error(`reservation ${reservationId} is not ready for pickup`);
      }
      if (row.reader !== reader) {
        throw new Error(`reservation ${reservationId} belongs to another reader`);
      }
      if (row.pickup_branch !== branch) {
        throw new Error(`reservation ${reservationId} must be picked up at ${row.pickup_branch}`);
      }
      const barcode = row.copy_barcode;
      if (!barcode) throw new Error(`reservation ${reservationId} has no bound copy`);
      const copy = this.getCopyRow(barcode);
      if (!copy || copy.status !== 'on_shelf' || copy.branch !== branch) {
        throw new Error(`copy ${barcode} is not available at ${branch}`);
      }
      const credential = randomUUID();
      this.db
        .prepare('INSERT INTO loans (credential, barcode, reader) VALUES (?, ?, ?)')
        .run(credential, barcode, reader);
      this.db.prepare("UPDATE copies SET status = 'checked_out' WHERE barcode = ?").run(barcode);
      this.db
        .prepare(
          "UPDATE reservations SET status = 'completed', copy_barcode = NULL WHERE id = ?",
        )
        .run(reservationId);
      return credential;
    });
  }

  /**
   * 入馆办理：归还借出（任意分馆）或调拨到馆（目的分馆）。
   * 凭据必须对应当前那次借出/调拨；已完成或未知凭据为无操作。
   */
  checkin(credential: Credential, branch: BranchId): void {
    this.transact(() => {
      const loan = this.db
        .prepare('SELECT credential, barcode, returned FROM loans WHERE credential = ?')
        .get(credential) as { credential: string; barcode: string; returned: number } | undefined;
      if (loan) {
        if (loan.returned) return;
        this.db.prepare('UPDATE loans SET returned = 1 WHERE credential = ?').run(credential);
        this.db
          .prepare("UPDATE copies SET status = 'on_shelf', branch = ? WHERE barcode = ?")
          .run(branch, loan.barcode);
        const copy = this.getCopyRow(loan.barcode);
        if (copy) this.allocate(copy.title);
        return;
      }
      const transfer = this.db
        .prepare(
          'SELECT credential, barcode, to_branch, arrived FROM transfers WHERE credential = ?',
        )
        .get(credential) as
        | { credential: string; barcode: string; to_branch: string; arrived: number }
        | undefined;
      if (transfer) {
        if (transfer.arrived) return;
        if (transfer.to_branch !== branch) {
          throw new Error(
            `transfer ${credential} must be checked in at ${transfer.to_branch}`,
          );
        }
        this.db.prepare('UPDATE transfers SET arrived = 1 WHERE credential = ?').run(credential);
        this.db
          .prepare("UPDATE copies SET status = 'on_shelf', branch = ? WHERE barcode = ?")
          .run(transfer.to_branch, transfer.barcode);
        // 若册仍绑定着预约，到馆后进入可领取状态。
        this.db
          .prepare(
            `UPDATE reservations SET status = 'ready'
             WHERE copy_barcode = ? AND status = 'pending' AND pickup_branch = ?`,
          )
          .run(transfer.barcode, transfer.to_branch);
        const copy = this.getCopyRow(transfer.barcode);
        if (copy) this.allocate(copy.title);
        return;
      }
      // 未知凭据：不改变状态。
    });
  }

  /**
   * 分配：按排队顺序为未绑定预约寻找可用册。
   * 在架空闲册可供任意分馆预约；无绑定在途册只供其目的分馆预约。
   * 优先级：领取馆在架 > 运往领取馆的在途 > 其他馆在架；同级按条码字典序。
   */
  private allocate(title: Title): void {
    interface Candidate {
      barcode: string;
      kind: 'shelf' | 'transit';
      branch: string;
    }
    const shelfRows = this.db
      .prepare(
        `SELECT c.barcode AS barcode, c.branch AS branch
         FROM copies c
         WHERE c.title = ? AND c.status = 'on_shelf'
           AND NOT EXISTS (
             SELECT 1 FROM reservations r
             WHERE r.copy_barcode = c.barcode AND r.status IN ${ACTIVE_RESERVATION_STATUSES}
           )`,
      )
      .all(title) as unknown as Array<{ barcode: string; branch: string }>;
    const transitRows = this.db
      .prepare(
        `SELECT c.barcode AS barcode, t.to_branch AS branch
         FROM copies c
         JOIN transfers t ON t.barcode = c.barcode AND t.arrived = 0
         WHERE c.title = ? AND c.status = 'in_transit'
           AND NOT EXISTS (
             SELECT 1 FROM reservations r
             WHERE r.copy_barcode = c.barcode AND r.status IN ${ACTIVE_RESERVATION_STATUSES}
           )`,
      )
      .all(title) as unknown as Array<{ barcode: string; branch: string }>;

    const shelfPool: Candidate[] = shelfRows.map((r) => ({
      barcode: r.barcode,
      kind: 'shelf',
      branch: r.branch,
    }));
    const transitPool: Candidate[] = transitRows.map((r) => ({
      barcode: r.barcode,
      kind: 'transit',
      branch: r.branch,
    }));

    const waiting = this.db
      .prepare(
        `SELECT id, pickup_branch FROM reservations
         WHERE title = ? AND status = 'pending' AND copy_barcode IS NULL
         ORDER BY id`,
      )
      .all(title) as unknown as Array<{ id: number; pickup_branch: string }>;

    for (const res of waiting) {
      const pickup = res.pickup_branch;
      const candidates: Array<{ candidate: Candidate; priority: number }> = [];
      for (const c of shelfPool) {
        candidates.push({ candidate: c, priority: c.branch === pickup ? 1 : 3 });
      }
      for (const c of transitPool) {
        if (c.branch === pickup) candidates.push({ candidate: c, priority: 2 });
      }
      if (candidates.length === 0) continue;
      candidates.sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return a.candidate.barcode < b.candidate.barcode
          ? -1
          : a.candidate.barcode > b.candidate.barcode
            ? 1
            : 0;
      });
      const chosen = candidates[0]!.candidate;
      if (chosen.kind === 'shelf') {
        shelfPool.splice(shelfPool.indexOf(chosen), 1);
        if (chosen.branch === pickup) {
          this.db
            .prepare(
              "UPDATE reservations SET copy_barcode = ?, status = 'ready' WHERE id = ?",
            )
            .run(chosen.barcode, res.id);
        } else {
          // 产生调拨：目的分馆固定为领取分馆。
          const credential = randomUUID();
          const fromBranch = chosen.branch;
          this.db
            .prepare(
              'INSERT INTO transfers (credential, barcode, from_branch, to_branch) VALUES (?, ?, ?, ?)',
            )
            .run(credential, chosen.barcode, fromBranch, pickup);
          this.db
            .prepare("UPDATE copies SET status = 'in_transit' WHERE barcode = ?")
            .run(chosen.barcode);
          this.db
            .prepare('UPDATE reservations SET copy_barcode = ? WHERE id = ?')
            .run(chosen.barcode, res.id);
        }
      } else {
        transitPool.splice(transitPool.indexOf(chosen), 1);
        this.db
          .prepare('UPDATE reservations SET copy_barcode = ? WHERE id = ?')
          .run(chosen.barcode, res.id);
      }
    }
  }

  private getReservationRow(id: number): ReservationRow | undefined {
    return this.db
      .prepare(
        'SELECT id, title, reader, pickup_branch, status, copy_barcode FROM reservations WHERE id = ?',
      )
      .get(id) as unknown as ReservationRow | undefined;
  }

  private getCopyRow(barcode: Barcode): CopyRow | undefined {
    return this.db
      .prepare('SELECT barcode, title, branch, status FROM copies WHERE barcode = ?')
      .get(barcode) as unknown as CopyRow | undefined;
  }

  /** 查询预约状态。 */
  getReservation(reservationId: number): ReservationInfo | null {
    const row = this.getReservationRow(reservationId);
    if (!row) return null;
    return {
      id: row.id,
      title: row.title,
      reader: row.reader,
      pickupBranch: row.pickup_branch,
      status: row.status as ReservationStatus,
      copyBarcode: row.copy_barcode,
      seq: row.id,
    };
  }

  /** 查询册的状态、所在/目的分馆、当前关联的预约、借出与调拨凭据。 */
  getCopy(barcode: Barcode): CopyInfo | null {
    const copy = this.getCopyRow(barcode);
    if (!copy) return null;
    const reservation = this.db
      .prepare(
        `SELECT id FROM reservations
         WHERE copy_barcode = ? AND status IN ${ACTIVE_RESERVATION_STATUSES}
         ORDER BY id DESC LIMIT 1`,
      )
      .get(barcode) as { id: number } | undefined;
    const loan = this.db
      .prepare('SELECT credential FROM loans WHERE barcode = ? AND returned = 0')
      .get(barcode) as { credential: string } | undefined;
    const transfer = this.db
      .prepare('SELECT credential, to_branch FROM transfers WHERE barcode = ? AND arrived = 0')
      .get(barcode) as { credential: string; to_branch: string } | undefined;
    return {
      barcode: copy.barcode,
      title: copy.title,
      branch: copy.branch,
      status: copy.status as CopyStatus,
      transitTo: copy.status === 'in_transit' && transfer ? transfer.to_branch : null,
      reservationId: reservation ? reservation.id : null,
      loanCredential: loan ? loan.credential : null,
      transferCredential: transfer ? transfer.credential : null,
    };
  }

  /** 某题名的未完成预约队列（按接受先后）。 */
  listQueue(title: Title): ReservationInfo[] {
    const rows = this.db
      .prepare(
        `SELECT id, title, reader, pickup_branch, status, copy_barcode
         FROM reservations
         WHERE title = ? AND status IN ${ACTIVE_RESERVATION_STATUSES}
         ORDER BY id`,
      )
      .all(title) as unknown as ReservationRow[];
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      reader: row.reader,
      pickupBranch: row.pickup_branch,
      status: row.status as ReservationStatus,
      copyBarcode: row.copy_barcode,
      seq: row.id,
    }));
  }

  getTransfer(credential: Credential): TransferInfo | null {
    const row = this.db
      .prepare(
        'SELECT credential, barcode, from_branch, to_branch, arrived FROM transfers WHERE credential = ?',
      )
      .get(credential) as
      | {
          credential: string;
          barcode: string;
          from_branch: string;
          to_branch: string;
          arrived: number;
        }
      | undefined;
    if (!row) return null;
    return {
      credential: row.credential,
      barcode: row.barcode,
      fromBranch: row.from_branch,
      toBranch: row.to_branch,
      arrived: row.arrived !== 0,
    };
  }
}
