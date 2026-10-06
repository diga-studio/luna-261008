import type { DatabaseSync, StatementSync } from "node:sqlite";
import { allocatePoolArrays } from "./allocation.js";
import { openDatabase } from "./db.js";
import type { ContractProfit, DateRange, RevenueInput } from "./types.js";

const MAX_MONEY = 1_000_000_000_000n; // 单个金额上限：1000000000000 分
const MAX_INT64 = 0x7fff_ffff_ffff_ffffn;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

function toBigInt(value: number | bigint, what: string): bigint {
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new TypeError(`${what} must be an integer, got ${value}`);
    }
    return BigInt(value);
  }
  return value;
}

function checkId(value: number | bigint, what: string): bigint {
  const v = toBigInt(value, what);
  if (v <= 0n || v > MAX_INT64) {
    throw new RangeError(`${what} must be a positive int64, got ${v}`);
  }
  return v;
}

function checkMoney(value: number | bigint, what: string, allowZero: boolean): bigint {
  const v = toBigInt(value, what);
  if (v < 0n || (!allowZero && v === 0n) || v > MAX_MONEY) {
    throw new RangeError(
      `${what} must be ${allowZero ? "0" : "1"}..${MAX_MONEY} cents, got ${v}`,
    );
  }
  return v;
}

function checkDate(value: string, what: string): string {
  if (!DATE_RE.test(value)) {
    throw new TypeError(`${what} must be YYYY-MM-DD, got ${JSON.stringify(value)}`);
  }
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new RangeError(`${what} is not a valid calendar date: ${value}`);
  }
  // 用 UTC 解析验证真实存在（如排除 2 月 30 日）。
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new RangeError(`${what} is not a valid calendar date: ${value}`);
  }
  return value;
}

function checkMonth(value: string): string {
  if (!MONTH_RE.test(value)) {
    throw new TypeError(`month must be YYYY-MM, got ${JSON.stringify(value)}`);
  }
  const month = Number(value.slice(5, 7));
  if (month < 1 || month > 12) {
    throw new RangeError(`month is not valid: ${value}`);
  }
  return value;
}

interface PoolKey {
  productId: bigint;
  month: string;
}

/**
 * 合同利润台账：固定成本分摊与利润查询。
 *
 * 不变式：revenues.allocated 始终等于该收入所属完整成本池统一分摊的结果，
 * 与查询区间无关。任何会改变池内容的写操作完成后，立即重算受影响池。
 */
export class ProfitLedger {
  private readonly db: DatabaseSync;
  private closed = false;

  private readonly stmtInsertPool: StatementSync;
  private readonly stmtGetPool: StatementSync;
  private readonly stmtGetRevenue: StatementSync;
  private readonly stmtInsertRevenue: StatementSync;
  private readonly stmtUpdateRevenue: StatementSync;
  private readonly stmtPoolRevenues: StatementSync;
  private readonly stmtPoolCount: StatementSync;
  private readonly stmtClearAllocBatch: StatementSync;
  private readonly stmtInsertAllocBatch: StatementSync;
  private readonly stmtApplyAllocBatch: StatementSync;
  private readonly stmtQuery: StatementSync;

  constructor(dbPath: string) {
    this.db = openDatabase(dbPath);
    this.db.exec(`
      CREATE TEMP TABLE IF NOT EXISTS alloc_batch (
        id INTEGER PRIMARY KEY,
        allocated INTEGER NOT NULL
      );
    `);

    this.stmtInsertPool = this.db.prepare(
      "INSERT INTO pools (product_id, month, fixed_cost) VALUES (?, ?, ?)",
    );
    this.stmtGetPool = this.db.prepare(
      "SELECT fixed_cost FROM pools WHERE product_id = ? AND month = ?",
    );
    this.stmtGetRevenue = this.db.prepare(
      "SELECT contract_id, product_id, biz_date FROM revenues WHERE id = ?",
    );
    this.stmtInsertRevenue = this.db.prepare(
      `INSERT INTO revenues (id, contract_id, product_id, biz_date, month, amount, direct_cost, allocated)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
    );
    this.stmtUpdateRevenue = this.db.prepare(
      "UPDATE revenues SET amount = ?, direct_cost = ? WHERE id = ?",
    );
    this.stmtPoolRevenues = this.db.prepare(
      "SELECT id, amount FROM revenues WHERE product_id = ? AND month = ?",
    );
    this.stmtPoolCount = this.db.prepare(
      "SELECT COUNT(*) AS n FROM revenues WHERE product_id = ? AND month = ?",
    );
    this.stmtClearAllocBatch = this.db.prepare("DELETE FROM alloc_batch");
    this.stmtInsertAllocBatch = this.db.prepare(
      "INSERT INTO alloc_batch (id, allocated) VALUES (?, ?)",
    );
    this.stmtApplyAllocBatch = this.db.prepare(
      `UPDATE revenues SET allocated = ab.allocated
       FROM alloc_batch ab WHERE revenues.id = ab.id`,
    );
    this.stmtQuery = this.db.prepare(
      `SELECT contract_id, SUM(amount) AS revenue, SUM(direct_cost) AS direct_cost,
              SUM(allocated) AS allocated
       FROM revenues
       WHERE biz_date >= ? AND biz_date < ?
       GROUP BY contract_id
       ORDER BY contract_id`,
    );

    for (const stmt of [
      this.stmtGetPool,
      this.stmtGetRevenue,
      this.stmtPoolRevenues,
      this.stmtPoolCount,
      this.stmtQuery,
    ]) {
      stmt.setReadBigInts(true);
    }
  }

  /** 录入某产品某 UTC 自然月的固定成本（分）。同一池只允许录入一次，录入后触发该池分摊。 */
  setPoolFixedCost(productId: number | bigint, month: string, fixedCost: number | bigint): void {
    this.assertOpen();
    const pid = checkId(productId, "productId");
    const m = checkMonth(month);
    const cost = checkMoney(fixedCost, "fixedCost", true);

    this.db.exec("BEGIN");
    try {
      this.stmtInsertPool.run(pid, m, cost);
      this.recomputePool({ productId: pid, month: m });
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      if (err instanceof Error && /UNIQUE|PRIMARY KEY/i.test(err.message)) {
        throw new Error(`pool (${pid}, ${m}) fixed cost already set and cannot be modified`);
      }
      throw err;
    }
  }

  /**
   * 批量新增或修订收入。修订只改变收入金额和直接成本，归属（合同/产品/日期）不可变。
   * 整批在一个事务内完成，随后统一重算所有受影响成本池。
   */
  upsertRevenues(revenues: readonly RevenueInput[]): void {
    this.assertOpen();
    if (revenues.length === 0) return;

    const seen = new Set<bigint>();
    const affectedPools = new Map<string, PoolKey>();
    this.db.exec("BEGIN");
    try {
      for (const input of revenues) {
        const id = checkId(input.id, "revenue id");
        if (seen.has(id)) {
          throw new Error(`duplicate revenue id in batch: ${id}`);
        }
        seen.add(id);
        const bizDate = checkDate(input.bizDate, "bizDate");
        const r = {
          id,
          contractId: checkId(input.contractId, "contractId"),
          productId: checkId(input.productId, "productId"),
          bizDate,
          month: bizDate.slice(0, 7),
          amount: checkMoney(input.amount, "amount", false),
          directCost: checkMoney(input.directCost, "directCost", true),
        };
        const existing = this.stmtGetRevenue.get(r.id) as
          | { contract_id: bigint; product_id: bigint; biz_date: string }
          | undefined;
        if (existing === undefined) {
          this.stmtInsertRevenue.run(
            r.id, r.contractId, r.productId, r.bizDate, r.month, r.amount, r.directCost,
          );
        } else {
          if (
            existing.contract_id !== r.contractId ||
            existing.product_id !== r.productId ||
            existing.biz_date !== r.bizDate
          ) {
            throw new Error(
              `revenue ${r.id} revision cannot change contract/product/date attribution`,
            );
          }
          this.stmtUpdateRevenue.run(r.amount, r.directCost, r.id);
        }
        affectedPools.set(`${r.productId}|${r.month}`, {
          productId: r.productId,
          month: r.month,
        });
      }
      for (const pool of affectedPools.values()) {
        this.recomputePool(pool);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** 查询 [range.from, range.to) 内按合同聚合的利润。 */
  queryProfits(range: DateRange): ContractProfit[] {
    this.assertOpen();
    const from = checkDate(range.from, "range.from");
    const to = checkDate(range.to, "range.to");
    if (from >= to) {
      throw new RangeError(`range.from (${from}) must be before range.to (${to})`);
    }
    const rows = this.stmtQuery.all(from, to) as unknown as Array<{
      contract_id: bigint;
      revenue: bigint;
      direct_cost: bigint;
      allocated: bigint;
    }>;
    return rows.map((row) => ({
      contractId: row.contract_id,
      revenue: row.revenue,
      directCost: row.direct_cost,
      allocatedFixedCost: row.allocated,
      netProfit: row.revenue - row.direct_cost - row.allocated,
    }));
  }

  /** 正常关闭数据库。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("ledger is closed");
    }
  }

  /**
   * 重算一个成本池的统一分摊并写回 revenues.allocated。
   * 必须在事务内调用。池尚无固定成本记录时，该池收入的分摊保持 0。
   */
  private recomputePool(pool: PoolKey): void {
    const poolRow = this.stmtGetPool.get(pool.productId, pool.month) as
      | { fixed_cost: bigint }
      | undefined;
    if (poolRow === undefined) {
      return; // 固定成本尚未录入，暂不分摊
    }
    const countRow = this.stmtPoolCount.get(pool.productId, pool.month) as
      | { n: bigint }
      | undefined;
    const count = Number(countRow?.n ?? 0n);
    if (count === 0) {
      return; // 尚无收入的池暂不分摊
    }
    const ids = new BigInt64Array(count);
    const amounts = new BigInt64Array(count);
    let i = 0;
    for (const row of this.stmtPoolRevenues.iterate(pool.productId, pool.month)) {
      const { id, amount } = row as { id: bigint; amount: bigint };
      ids[i] = id;
      amounts[i] = amount;
      i++;
    }
    const allocated = allocatePoolArrays(poolRow.fixed_cost, ids, amounts);

    this.stmtClearAllocBatch.run();
    for (let k = 0; k < count; k++) {
      this.stmtInsertAllocBatch.run(ids[k]!, allocated[k]!);
    }
    this.stmtApplyAllocBatch.run();
  }
}
