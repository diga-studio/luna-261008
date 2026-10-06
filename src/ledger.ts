import type { DatabaseSync, StatementSync } from "node:sqlite";
import { PoolAllocator } from "./allocation.js";
import { openDatabase } from "./db.js";
import type { ContractProfit, RevenueInput } from "./types.js";

const MAX_AMOUNT_CENTS = 1_000_000_000_000n;
const MAX_SQLITE_INTEGER = 9_223_372_036_854_775_807n;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

// SQLite 扩展错误码：主键冲突 / 唯一约束冲突
const SQLITE_CONSTRAINT_PRIMARYKEY = 1555;
const SQLITE_CONSTRAINT_UNIQUE = 2067;

function isConstraintError(err: unknown): boolean {
  const code = (err as { errcode?: number }).errcode;
  return code === SQLITE_CONSTRAINT_PRIMARYKEY || code === SQLITE_CONSTRAINT_UNIQUE;
}

function isValidDate(date: string): boolean {
  if (!DATE_RE.test(date)) return false;
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  // 用 UTC 日期回读校验真实存在的日期
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

function isValidMonth(month: string): boolean {
  if (!MONTH_RE.test(month)) return false;
  const m = Number(month.slice(5, 7));
  return m >= 1 && m <= 12;
}

function checkAmount(name: string, value: bigint, min: bigint): void {
  if (typeof value !== "bigint") {
    throw new TypeError(`${name} 必须是 bigint`);
  }
  if (value < min || value > MAX_AMOUNT_CENTS) {
    throw new RangeError(
      `${name} 必须在 [${min}, ${MAX_AMOUNT_CENTS}] 分之间，收到 ${value}`,
    );
  }
}

function checkNonEmpty(name: string, value: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} 必须是非空字符串`);
  }
}

interface RevenueRow {
  id: bigint;
  contract_id: string;
  product: string;
  biz_date: string;
  month: string;
  amount_cents: bigint;
  direct_cost_cents: bigint;
}

/** 合同利润分摊库主入口。所有调用串行执行。 */
export class ProfitLedger {
  private readonly db: DatabaseSync;
  private readonly stmtInsertRevenue: StatementSync;
  private readonly stmtUpdateRevenue: StatementSync;
  private readonly stmtSelectRevenueById: StatementSync;
  private readonly stmtSelectPoolRevenues: StatementSync;
  private readonly stmtSelectPoolAmount: StatementSync;
  private readonly stmtUpdateAllocated: StatementSync;
  private readonly stmtInsertPool: StatementSync;
  private readonly stmtQueryProfit: StatementSync;
  private readonly allocator = new PoolAllocator();

  constructor(dbPath: string) {
    this.db = openDatabase(dbPath);
    this.stmtInsertRevenue = this.db.prepare(
      `INSERT INTO revenue (id, contract_id, product, biz_date, month, amount_cents, direct_cost_cents, allocated_cents)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
    );
    this.stmtUpdateRevenue = this.db.prepare(
      `UPDATE revenue SET amount_cents = ?, direct_cost_cents = ? WHERE id = ?`,
    );
    this.stmtSelectRevenueById = this.db.prepare(
      `SELECT id, contract_id, product, biz_date, month, amount_cents, direct_cost_cents
       FROM revenue WHERE id = ?`,
    );
    this.stmtSelectRevenueById.setReadBigInts(true);
    this.stmtSelectPoolRevenues = this.db.prepare(
      `SELECT id, amount_cents FROM revenue WHERE product = ? AND month = ?`,
    );
    this.stmtSelectPoolRevenues.setReadBigInts(true);
    this.stmtSelectPoolAmount = this.db.prepare(
      `SELECT amount_cents FROM fixed_cost_pool WHERE product = ? AND month = ?`,
    );
    this.stmtSelectPoolAmount.setReadBigInts(true);
    this.stmtUpdateAllocated = this.db.prepare(
      `UPDATE revenue SET allocated_cents = ? WHERE id = ?`,
    );
    this.stmtInsertPool = this.db.prepare(
      `INSERT INTO fixed_cost_pool (product, month, amount_cents) VALUES (?, ?, ?)`,
    );
    this.stmtQueryProfit = this.db.prepare(
      `SELECT contract_id,
              SUM(amount_cents)        AS revenue_cents,
              SUM(direct_cost_cents)   AS direct_cost_cents,
              SUM(allocated_cents)     AS allocated_cents
       FROM revenue
       WHERE biz_date >= ? AND biz_date < ?
       GROUP BY contract_id
       ORDER BY contract_id`,
    );
    this.stmtQueryProfit.setReadBigInts(true);
  }

  /** 录入某产品某 UTC 自然月的固定成本（分）。录入后不可修改，重复录入抛错。 */
  recordFixedCost(product: string, month: string, amountCents: bigint): void {
    checkNonEmpty("product", product);
    if (!isValidMonth(month)) {
      throw new RangeError(`month 必须是合法的 YYYY-MM，收到 ${month}`);
    }
    checkAmount("amountCents", amountCents, 0n);

    this.db.exec("BEGIN");
    try {
      this.stmtInsertPool.run(product, month, amountCents);
      this.reallocatePool(product, month);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      if (isConstraintError(err)) {
        throw new Error(
          `成本池 (${product}, ${month}) 已存在，固定成本录入后不可修改`,
        );
      }
      throw err;
    }
  }

  /** 批量新增或修订收入。修订只允许改变收入金额与直接成本。 */
  upsertRevenues(items: readonly RevenueInput[]): void {
    if (items.length === 0) return;
    const seen = new Set<bigint>();
    for (const item of items) this.validateRevenue(item, seen);

    this.db.exec("BEGIN");
    try {
      const affectedPools = new Map<string, [string, string]>();
      for (const item of items) {
        const month = item.bizDate.slice(0, 7);
        // 先尝试直接插入（新增是常见路径，避免每笔一次 SELECT）
        let inserted = false;
        try {
          this.stmtInsertRevenue.run(
            item.id,
            item.contractId,
            item.product,
            item.bizDate,
            month,
            item.amountCents,
            item.directCostCents,
          );
          inserted = true;
        } catch (err) {
          if (!isConstraintError(err)) throw err;
        }
        if (!inserted) {
          const existing = this.stmtSelectRevenueById.get(item.id) as
            | RevenueRow
            | undefined;
          if (existing === undefined) throw new Error(`收入 ${item.id} 插入失败`);
          if (
            existing.contract_id !== item.contractId ||
            existing.product !== item.product ||
            existing.biz_date !== item.bizDate
          ) {
            throw new Error(
              `收入 ${item.id} 已存在，修订只允许改变收入金额和直接成本`,
            );
          }
          if (
            existing.amount_cents !== item.amountCents ||
            existing.direct_cost_cents !== item.directCostCents
          ) {
            this.stmtUpdateRevenue.run(
              item.amountCents,
              item.directCostCents,
              item.id,
            );
          }
        }
        affectedPools.set(`${item.product} ${month}`, [item.product, month]);
      }
      for (const [product, month] of affectedPools.values()) {
        this.reallocatePool(product, month);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * 按合同查询 [fromDate, toDate) 区间利润。
   * 日期格式 YYYY-MM-DD（UTC），含起日、不含止日。
   */
  queryProfit(fromDate: string, toDate: string): ContractProfit[] {
    if (!isValidDate(fromDate)) {
      throw new RangeError(`fromDate 必须是合法的 YYYY-MM-DD，收到 ${fromDate}`);
    }
    if (!isValidDate(toDate)) {
      throw new RangeError(`toDate 必须是合法的 YYYY-MM-DD，收到 ${toDate}`);
    }
    if (fromDate >= toDate) return [];

    const rows = this.stmtQueryProfit.all(fromDate, toDate) as unknown as Array<{
      contract_id: string;
      revenue_cents: bigint;
      direct_cost_cents: bigint;
      allocated_cents: bigint;
    }>;
    return rows.map((row) => ({
      contractId: row.contract_id,
      revenueCents: row.revenue_cents,
      directCostCents: row.direct_cost_cents,
      allocatedFixedCostCents: row.allocated_cents,
      netProfitCents:
        row.revenue_cents - row.direct_cost_cents - row.allocated_cents,
    }));
  }

  /** 正常关闭数据库。 */
  close(): void {
    this.db.close();
  }

  private validateRevenue(item: RevenueInput, seen: Set<bigint>): void {
    if (typeof item.id !== "bigint" || item.id < 1n || item.id > MAX_SQLITE_INTEGER) {
      throw new RangeError(`收入编号必须是 [1, ${MAX_SQLITE_INTEGER}] 的 bigint`);
    }
    if (seen.has(item.id)) {
      throw new Error(`同一批次中收入编号 ${item.id} 重复`);
    }
    seen.add(item.id);
    checkNonEmpty("contractId", item.contractId);
    checkNonEmpty("product", item.product);
    if (!isValidDate(item.bizDate)) {
      throw new RangeError(
        `bizDate 必须是合法的 UTC 日期 YYYY-MM-DD，收到 ${item.bizDate}`,
      );
    }
    checkAmount("amountCents", item.amountCents, 1n);
    checkAmount("directCostCents", item.directCostCents, 0n);
  }

  /** 重算一个成本池的全部分摊并落库（须在事务内调用）。 */
  private reallocatePool(product: string, month: string): void {
    const poolRow = this.stmtSelectPoolAmount.get(product, month) as
      | { amount_cents: bigint }
      | undefined;
    const poolAmount = poolRow?.amount_cents ?? 0n;

    // 流式读入可复用缓冲，避免大池产生大量临时对象
    this.allocator.reset();
    for (const row of this.stmtSelectPoolRevenues.iterate(product, month)) {
      const r = row as unknown as { id: bigint; amount_cents: bigint };
      this.allocator.add(r.id, r.amount_cents);
    }
    const n = this.allocator.size;
    if (n === 0) return;

    const allocated = this.allocator.compute(poolAmount);
    for (let i = 0; i < n; i++) {
      this.stmtUpdateAllocated.run(allocated[i]!, this.allocator.idAt(i));
    }
  }
}
