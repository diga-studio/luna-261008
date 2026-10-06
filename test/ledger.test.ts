import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProfitLedger, type ContractProfit, type RevenueInput } from "../src/index.js";

function rev(
  id: bigint,
  contractId: string,
  product: string,
  bizDate: string,
  amountCents: bigint,
  directCostCents: bigint,
): RevenueInput {
  return { id, contractId, product, bizDate, amountCents, directCostCents };
}

function byContract(rows: ContractProfit[]): Map<string, ContractProfit> {
  return new Map(rows.map((r) => [r.contractId, r]));
}

function totals(rows: ContractProfit[]): {
  revenue: bigint;
  direct: bigint;
  allocated: bigint;
  net: bigint;
} {
  let revenue = 0n, direct = 0n, allocated = 0n, net = 0n;
  for (const r of rows) {
    revenue += r.revenueCents;
    direct += r.directCostCents;
    allocated += r.allocatedFixedCostCents;
    net += r.netProfitCents;
  }
  return { revenue, direct, allocated, net };
}

test("固定成本重复录入抛错", () => {
  const ledger = new ProfitLedger(":memory:");
  ledger.recordFixedCost("P1", "2026-01", 100n);
  assert.throws(() => ledger.recordFixedCost("P1", "2026-01", 200n), /不可修改/);
  ledger.close();
});

test("尚无收入的池暂不分摊；无池的收入分摊为 0", () => {
  const ledger = new ProfitLedger(":memory:");
  ledger.recordFixedCost("P1", "2026-01", 1000n); // 无收入
  ledger.upsertRevenues([
    rev(1n, "C1", "P2", "2026-01-10", 500n, 100n), // P2 无成本池
  ]);
  const rows = ledger.queryProfit("2026-01-01", "2026-02-01");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.allocatedFixedCostCents, 0n);
  assert.equal(rows[0]!.netProfitCents, 400n);
  ledger.close();
});

test("分摊只按收入金额占比，与合同数量和直接成本无关；净利润可为负", () => {
  const ledger = new ProfitLedger(":memory:");
  ledger.recordFixedCost("P1", "2026-01", 90n);
  ledger.upsertRevenues([
    rev(1n, "C1", "P1", "2026-01-05", 100n, 9999n),
    rev(2n, "C2", "P1", "2026-01-15", 200n, 0n),
  ]);
  const rows = byContract(ledger.queryProfit("2026-01-01", "2026-02-01"));
  assert.equal(rows.get("C1")!.allocatedFixedCostCents, 30n);
  assert.equal(rows.get("C2")!.allocatedFixedCostCents, 60n);
  assert.equal(rows.get("C1")!.netProfitCents, 100n - 9999n - 30n);
  ledger.close();
});

test("完整月份与任意日期切片：分段查询相加等于完整区间", () => {
  const ledger = new ProfitLedger(":memory:");
  ledger.recordFixedCost("P1", "2026-01", 123_456n);
  ledger.recordFixedCost("P1", "2026-02", 77_777n);
  const items: RevenueInput[] = [];
  // 1 月 31 天每天两笔、2 月若干笔，跨多个合同
  let id = 1n;
  for (let d = 1; d <= 31; d++) {
    const date = `2026-01-${String(d).padStart(2, "0")}`;
    items.push(rev(id++, `C${(d % 5) + 1}`, "P1", date, 1000n + BigInt(d) * 7n, 300n));
    items.push(rev(id++, `C${((d + 2) % 5) + 1}`, "P1", date, 2000n + BigInt(d) * 3n, 0n));
  }
  for (let d = 1; d <= 10; d++) {
    const date = `2026-02-${String(d).padStart(2, "0")}`;
    items.push(rev(id++, `C${(d % 5) + 1}`, "P1", date, 500n + BigInt(d), 10n));
  }
  ledger.upsertRevenues(items);

  const full = totals(ledger.queryProfit("2026-01-01", "2026-03-01"));
  // 任意切片：若干段拼起来
  const slices: Array<[string, string]> = [
    ["2026-01-01", "2026-01-08"],
    ["2026-01-08", "2026-01-15"],
    ["2026-01-15", "2026-01-22"],
    ["2026-01-22", "2026-02-01"],
    ["2026-02-01", "2026-02-14"],
    ["2026-02-14", "2026-03-01"],
  ];
  let revenue = 0n, direct = 0n, allocated = 0n, net = 0n;
  for (const [from, to] of slices) {
    const t = totals(ledger.queryProfit(from, to));
    revenue += t.revenue;
    direct += t.direct;
    allocated += t.allocated;
    net += t.net;
  }
  assert.equal(revenue, full.revenue);
  assert.equal(direct, full.direct);
  assert.equal(allocated, full.allocated);
  assert.equal(net, full.net);
  // 每个池的全月分摊之和恰好等于池金额
  const jan = totals(ledger.queryProfit("2026-01-01", "2026-02-01"));
  assert.equal(jan.allocated, 123_456n);
  const feb = totals(ledger.queryProfit("2026-02-01", "2026-03-01"));
  assert.equal(feb.allocated, 77_777n);
  ledger.close();
});

test("追加收入改变同池其他合同的分摊，且总和仍等于池金额", () => {
  const ledger = new ProfitLedger(":memory:");
  ledger.recordFixedCost("P1", "2026-01", 100n);
  ledger.upsertRevenues([rev(1n, "C1", "P1", "2026-01-05", 100n, 0n)]);
  assert.equal(
    byContract(ledger.queryProfit("2026-01-01", "2026-02-01")).get("C1")!
      .allocatedFixedCostCents,
    100n,
  );
  // 追加一笔后，C1 的归属成本变化
  ledger.upsertRevenues([rev(2n, "C2", "P1", "2026-01-06", 300n, 0n)]);
  const rows = byContract(ledger.queryProfit("2026-01-01", "2026-02-01"));
  assert.equal(rows.get("C1")!.allocatedFixedCostCents, 25n);
  assert.equal(rows.get("C2")!.allocatedFixedCostCents, 75n);
  ledger.close();
});

test("批量修订同池收入：整批生效后统一分摊，未修改合同的成本同步变化", () => {
  const ledger = new ProfitLedger(":memory:");
  ledger.recordFixedCost("P1", "2026-01", 1000n);
  ledger.upsertRevenues([
    rev(1n, "C1", "P1", "2026-01-05", 100n, 10n),
    rev(2n, "C2", "P1", "2026-01-06", 100n, 20n),
    rev(3n, "C3", "P1", "2026-01-07", 200n, 30n),
  ]);
  const before = byContract(ledger.queryProfit("2026-01-01", "2026-02-01"));
  assert.equal(before.get("C1")!.allocatedFixedCostCents, 250n);
  assert.equal(before.get("C3")!.allocatedFixedCostCents, 500n);

  // 批量修订 id1、id2 的金额与直接成本（不改归属/日期）
  ledger.upsertRevenues([
    rev(1n, "C1", "P1", "2026-01-05", 900n, 11n),
    rev(2n, "C2", "P1", "2026-01-06", 900n, 22n),
  ]);
  const after = byContract(ledger.queryProfit("2026-01-01", "2026-02-01"));
  // 总额 2000：C1=450, C2=450, C3=100
  assert.equal(after.get("C1")!.allocatedFixedCostCents, 450n);
  assert.equal(after.get("C2")!.allocatedFixedCostCents, 450n);
  assert.equal(after.get("C3")!.allocatedFixedCostCents, 100n);
  assert.equal(after.get("C1")!.directCostCents, 11n);
  assert.equal(after.get("C2")!.directCostCents, 22n);
  const t = totals([...after.values()]);
  assert.equal(t.allocated, 1000n);
  ledger.close();
});

test("修订不允许改变合同、产品或日期", () => {
  const ledger = new ProfitLedger(":memory:");
  ledger.upsertRevenues([rev(1n, "C1", "P1", "2026-01-05", 100n, 0n)]);
  assert.throws(
    () => ledger.upsertRevenues([rev(1n, "C2", "P1", "2026-01-05", 100n, 0n)]),
    /只允许/,
  );
  assert.throws(
    () => ledger.upsertRevenues([rev(1n, "C1", "P2", "2026-01-05", 100n, 0n)]),
    /只允许/,
  );
  assert.throws(
    () => ledger.upsertRevenues([rev(1n, "C1", "P1", "2026-01-06", 100n, 0n)]),
    /只允许/,
  );
  ledger.close();
});

test("输入校验：金额边界与日期合法性", () => {
  const ledger = new ProfitLedger(":memory:");
  assert.throws(
    () => ledger.upsertRevenues([rev(1n, "C1", "P1", "2026-01-05", 0n, 0n)]),
    RangeError,
  );
  assert.throws(
    () => ledger.upsertRevenues([rev(1n, "C1", "P1", "2026-01-05", 100n, -1n)]),
    RangeError,
  );
  assert.throws(
    () =>
      ledger.upsertRevenues([
        rev(1n, "C1", "P1", "2026-01-05", 1_000_000_000_001n, 0n),
      ]),
    RangeError,
  );
  assert.throws(
    () => ledger.upsertRevenues([rev(1n, "C1", "P1", "2026-02-30", 100n, 0n)]),
    RangeError,
  );
  assert.throws(
    () => ledger.upsertRevenues([rev(0n, "C1", "P1", "2026-01-05", 100n, 0n)]),
    RangeError,
  );
  assert.throws(() => ledger.recordFixedCost("P1", "2026-13", 100n), RangeError);
  assert.throws(() => ledger.queryProfit("2026-13-01", "2027-01-01"), RangeError);
  // 边界值可用
  ledger.upsertRevenues([
    rev(1n, "C1", "P1", "2026-01-05", 1_000_000_000_000n, 1_000_000_000_000n),
  ]);
  ledger.close();
});

test("大额金额分摊与理论份额一致", () => {
  const ledger = new ProfitLedger(":memory:");
  ledger.recordFixedCost("P1", "2026-01", 1_000_000_000_000n);
  ledger.upsertRevenues([
    rev(1n, "C1", "P1", "2026-01-05", 1_000_000_000_000n, 0n),
    rev(2n, "C2", "P1", "2026-01-06", 999_999_999_999n, 0n),
    rev(3n, "C3", "P1", "2026-01-07", 1n, 0n),
  ]);
  const rows = byContract(ledger.queryProfit("2026-01-01", "2026-02-01"));
  // 总额 1999999999999+1 = 2000000000000
  // C1: floor(1e12 * 1e12 / 2e12) = 500000000000
  // C2: floor(1e12 * 999999999999 / 2e12) = 499999999999（余 499999999999.5→499999999999）
  // C3: floor(1e12 * 1 / 2e12) = 0
  // 余数 1：小数部分 C2=0.5 最大 → C2 +1
  assert.equal(rows.get("C1")!.allocatedFixedCostCents, 500_000_000_000n);
  assert.equal(rows.get("C2")!.allocatedFixedCostCents, 500_000_000_000n);
  assert.equal(rows.get("C3")!.allocatedFixedCostCents, 0n);
  const t = totals([...rows.values()]);
  assert.equal(t.allocated, 1_000_000_000_000n);
  ledger.close();
});

test("正常关闭并重新打开后，收入、成本池和利润结果一致", () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-"));
  const dbPath = join(dir, "test.db");
  try {
    const before: ContractProfit[] = (() => {
      const ledger = new ProfitLedger(dbPath);
      ledger.recordFixedCost("P1", "2026-01", 1000n);
      ledger.upsertRevenues([
        rev(1n, "C1", "P1", "2026-01-05", 100n, 10n),
        rev(2n, "C2", "P1", "2026-01-06", 300n, 20n),
      ]);
      const rows = ledger.queryProfit("2026-01-01", "2026-02-01");
      ledger.close();
      return rows;
    })();

    const ledger2 = new ProfitLedger(dbPath);
    const after = ledger2.queryProfit("2026-01-01", "2026-02-01");
    assert.deepEqual(after, before);
    // 重新打开后固定成本仍不可修改
    assert.throws(() => ledger2.recordFixedCost("P1", "2026-01", 1n), /不可修改/);
    // 重新打开后仍可继续追加并重算
    ledger2.upsertRevenues([rev(3n, "C3", "P1", "2026-01-07", 400n, 0n)]);
    const t = totals(ledger2.queryProfit("2026-01-01", "2026-02-01"));
    assert.equal(t.allocated, 1000n);
    ledger2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("查询区间含起日、不含止日；空区间返回空", () => {
  const ledger = new ProfitLedger(":memory:");
  ledger.upsertRevenues([
    rev(1n, "C1", "P1", "2026-01-05", 100n, 0n),
    rev(2n, "C1", "P1", "2026-01-10", 200n, 0n),
  ]);
  const rows = ledger.queryProfit("2026-01-05", "2026-01-10");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.revenueCents, 100n);
  assert.deepEqual(ledger.queryProfit("2026-01-10", "2026-01-10"), []);
  assert.deepEqual(ledger.queryProfit("2026-01-11", "2026-01-10"), []);
  ledger.close();
});

test("先录收入后录固定成本：录入时触发整池分摊", () => {
  const ledger = new ProfitLedger(":memory:");
  ledger.upsertRevenues([
    rev(1n, "C1", "P1", "2026-01-05", 100n, 0n),
    rev(2n, "C2", "P1", "2026-01-06", 300n, 0n),
  ]);
  assert.equal(
    byContract(ledger.queryProfit("2026-01-01", "2026-02-01")).get("C1")!
      .allocatedFixedCostCents,
    0n,
  );
  ledger.recordFixedCost("P1", "2026-01", 100n);
  const rows = byContract(ledger.queryProfit("2026-01-01", "2026-02-01"));
  assert.equal(rows.get("C1")!.allocatedFixedCostCents, 25n);
  assert.equal(rows.get("C2")!.allocatedFixedCostCents, 75n);
  ledger.close();
});

test("同一批次内收入编号重复抛错，且整批回滚", () => {
  const ledger = new ProfitLedger(":memory:");
  assert.throws(
    () =>
      ledger.upsertRevenues([
        rev(1n, "C1", "P1", "2026-01-05", 100n, 0n),
        rev(1n, "C2", "P1", "2026-01-06", 200n, 0n),
      ]),
    /重复/,
  );
  assert.deepEqual(ledger.queryProfit("2026-01-01", "2026-02-01"), []);
  ledger.close();
});

test("批次中途出错时整批回滚", () => {
  const ledger = new ProfitLedger(":memory:");
  ledger.upsertRevenues([rev(1n, "C1", "P1", "2026-01-05", 100n, 0n)]);
  // 第二笔试图改变已有收入的合同 → 整批失败，第一笔新增也不生效
  assert.throws(() =>
    ledger.upsertRevenues([
      rev(2n, "C2", "P1", "2026-01-06", 200n, 0n),
      rev(1n, "C9", "P1", "2026-01-05", 100n, 0n),
    ]),
  );
  const rows = ledger.queryProfit("2026-01-01", "2026-02-01");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.contractId, "C1");
  assert.equal(rows[0]!.revenueCents, 100n);
  ledger.close();
});
