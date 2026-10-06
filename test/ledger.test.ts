import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProfitLedger } from "../src/index.js";
import type { ContractProfit } from "../src/index.js";

function tempDb(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "ledger-test-"));
  return { dir, path: join(dir, "test.db") };
}

function profitsByContract(rows: ContractProfit[]): Map<bigint, ContractProfit> {
  return new Map(rows.map((r) => [r.contractId, r]));
}

test("基本流程：录池、录收入、按合同查询利润", () => {
  const { dir, path } = tempDb();
  try {
    const ledger = new ProfitLedger(path);
    ledger.setPoolFixedCost(1, "2026-01", 100);
    ledger.upsertRevenues([
      { id: 1, contractId: 10, productId: 1, bizDate: "2026-01-05", amount: 60, directCost: 6 },
      { id: 2, contractId: 11, productId: 1, bizDate: "2026-01-20", amount: 40, directCost: 4 },
    ]);
    const rows = profitsByContract(ledger.queryProfits({ from: "2026-01-01", to: "2026-02-01" }));
    const c10 = rows.get(10n)!;
    assert.equal(c10.revenue, 60n);
    assert.equal(c10.directCost, 6n);
    assert.equal(c10.allocatedFixedCost, 60n);
    assert.equal(c10.netProfit, -6n); // 允许净利润为负
    const c11 = rows.get(11n)!;
    assert.equal(c11.allocatedFixedCost, 40n);
    ledger.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("大额金额且余数相同：与精确理论份额一致", () => {
  const { dir, path } = tempDb();
  try {
    const ledger = new ProfitLedger(path);
    // 池固定成本 999999999999（奇数），两笔等额大额收入 1e12。
    // 理论份额 = 999999999999/2 = 499999999999.5，余数相同 -> 编号小者 +1。
    ledger.setPoolFixedCost(1, "2026-03", 999_999_999_999);
    ledger.upsertRevenues([
      { id: 100, contractId: 1, productId: 1, bizDate: "2026-03-10", amount: 1_000_000_000_000, directCost: 0 },
      { id: 50, contractId: 2, productId: 1, bizDate: "2026-03-11", amount: 1_000_000_000_000, directCost: 0 },
    ]);
    const rows = profitsByContract(ledger.queryProfits({ from: "2026-03-01", to: "2026-04-01" }));
    assert.equal(rows.get(2n)!.allocatedFixedCost, 500_000_000_000n); // id=50 较小
    assert.equal(rows.get(1n)!.allocatedFixedCost, 499_999_999_999n);
    assert.equal(
      rows.get(1n)!.allocatedFixedCost + rows.get(2n)!.allocatedFixedCost,
      999_999_999_999n,
    );
    ledger.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("日期切片：分段查询之和等于完整区间，区间不影响归属成本", () => {
  const { dir, path } = tempDb();
  try {
    const ledger = new ProfitLedger(path);
    ledger.setPoolFixedCost(1, "2026-01", 1_000_000);
    ledger.upsertRevenues([
      { id: 1, contractId: 1, productId: 1, bizDate: "2026-01-03", amount: 100, directCost: 1 },
      { id: 2, contractId: 1, productId: 1, bizDate: "2026-01-15", amount: 200, directCost: 2 },
      { id: 3, contractId: 2, productId: 1, bizDate: "2026-01-28", amount: 300, directCost: 3 },
    ]);
    const full = ledger.queryProfits({ from: "2026-01-01", to: "2026-02-01" });
    const seg1 = ledger.queryProfits({ from: "2026-01-01", to: "2026-01-10" });
    const seg2 = ledger.queryProfits({ from: "2026-01-10", to: "2026-01-20" });
    const seg3 = ledger.queryProfits({ from: "2026-01-20", to: "2026-02-01" });

    const sum = (rows: ContractProfit[], id: bigint, key: "revenue" | "allocatedFixedCost") =>
      rows.filter((r) => r.contractId === id).reduce((acc, r) => acc + r[key], 0n);
    const fullMap = profitsByContract(full);

    // 合同 1：跨两个分段，归属成本按整池分摊后逐笔归属，不随区间重算。
    assert.equal(sum(seg1, 1n, "allocatedFixedCost") + sum(seg2, 1n, "allocatedFixedCost"),
      fullMap.get(1n)!.allocatedFixedCost);
    // 合同 2：只在第三段。
    assert.equal(sum(seg3, 2n, "allocatedFixedCost"), fullMap.get(2n)!.allocatedFixedCost);
    // 三段相加等于完整区间（收入与分摊都成立）。
    for (const id of [1n, 2n]) {
      assert.equal(
        sum(seg1, id, "revenue") + sum(seg2, id, "revenue") + sum(seg3, id, "revenue"),
        fullMap.get(id)!.revenue,
      );
      assert.equal(
        sum(seg1, id, "allocatedFixedCost") + sum(seg2, id, "allocatedFixedCost") + sum(seg3, id, "allocatedFixedCost"),
        fullMap.get(id)!.allocatedFixedCost,
      );
    }
    // 全池分摊总额等于池金额。
    const totalAlloc = full.reduce((acc, r) => acc + r.allocatedFixedCost, 0n);
    assert.equal(totalAlloc, 1_000_000n);
    ledger.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("追加收入改变同池其他合同的归属成本，且总和仍等于池金额", () => {
  const { dir, path } = tempDb();
  try {
    const ledger = new ProfitLedger(path);
    ledger.setPoolFixedCost(1, "2026-02", 1000);
    ledger.upsertRevenues([
      { id: 1, contractId: 1, productId: 1, bizDate: "2026-02-01", amount: 100, directCost: 0 },
    ]);
    let rows = profitsByContract(ledger.queryProfits({ from: "2026-02-01", to: "2026-03-01" }));
    assert.equal(rows.get(1n)!.allocatedFixedCost, 1000n); // 独占全池

    // 追加另一合同的收入后，合同 1 的归属成本必须下降。
    ledger.upsertRevenues([
      { id: 2, contractId: 2, productId: 1, bizDate: "2026-02-02", amount: 300, directCost: 0 },
    ]);
    rows = profitsByContract(ledger.queryProfits({ from: "2026-02-01", to: "2026-03-01" }));
    assert.equal(rows.get(1n)!.allocatedFixedCost, 250n);
    assert.equal(rows.get(2n)!.allocatedFixedCost, 750n);
    ledger.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("批量修订：同池未修改收入的成本同步变化，整批统一生效", () => {
  const { dir, path } = tempDb();
  try {
    const ledger = new ProfitLedger(path);
    ledger.setPoolFixedCost(1, "2026-04", 900);
    ledger.setPoolFixedCost(2, "2026-04", 500);
    ledger.upsertRevenues([
      { id: 1, contractId: 1, productId: 1, bizDate: "2026-04-01", amount: 100, directCost: 10 },
      { id: 2, contractId: 2, productId: 1, bizDate: "2026-04-02", amount: 200, directCost: 20 },
      { id: 3, contractId: 3, productId: 2, bizDate: "2026-04-03", amount: 50, directCost: 5 },
    ]);
    // 一次批量：修订 id=1 的金额（100->500）与直接成本，同时修订 id=3。
    ledger.upsertRevenues([
      { id: 1, contractId: 1, productId: 1, bizDate: "2026-04-01", amount: 500, directCost: 7 },
      { id: 3, contractId: 3, productId: 2, bizDate: "2026-04-03", amount: 50, directCost: 8 },
    ]);
    const rows = profitsByContract(ledger.queryProfits({ from: "2026-04-01", to: "2026-05-01" }));
    // 池 1：500:200 -> 900 按 5:2 分摊 = 642.857..., 257.142...
    // 精确：500*900/700 = 642 余 600；200*900/700 = 257 余 100 -> id=1 补 1。
    assert.equal(rows.get(1n)!.allocatedFixedCost, 643n);
    assert.equal(rows.get(2n)!.allocatedFixedCost, 257n);
    assert.equal(rows.get(1n)!.allocatedFixedCost + rows.get(2n)!.allocatedFixedCost, 900n);
    // 合同 1 的直接成本已修订。
    assert.equal(rows.get(1n)!.directCost, 7n);
    // 池 2：合同 3 独占，直接成本已修订为 8。
    assert.equal(rows.get(3n)!.allocatedFixedCost, 500n);
    assert.equal(rows.get(3n)!.directCost, 8n);
    ledger.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("关闭重开后收入、成本池与利润结果一致", () => {
  const { dir, path } = tempDb();
  try {
    let ledger = new ProfitLedger(path);
    ledger.setPoolFixedCost(1, "2026-05", 777);
    ledger.upsertRevenues([
      { id: 1, contractId: 1, productId: 1, bizDate: "2026-05-01", amount: 100, directCost: 1 },
      { id: 2, contractId: 2, productId: 1, bizDate: "2026-05-02", amount: 200, directCost: 2 },
    ]);
    const before = ledger.queryProfits({ from: "2026-05-01", to: "2026-06-01" });
    ledger.close();

    ledger = new ProfitLedger(path);
    const after = ledger.queryProfits({ from: "2026-05-01", to: "2026-06-01" });
    assert.deepEqual(after, before);
    // 重开后池成本不可修改。
    assert.throws(() => ledger.setPoolFixedCost(1, "2026-05", 1), /already set/);
    // 重开后仍可追加收入并触发重分摊。
    ledger.upsertRevenues([
      { id: 3, contractId: 3, productId: 1, bizDate: "2026-05-03", amount: 300, directCost: 3 },
    ]);
    const rows = ledger.queryProfits({ from: "2026-05-01", to: "2026-06-01" });
    assert.equal(rows.reduce((acc, r) => acc + r.allocatedFixedCost, 0n), 777n);
    ledger.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("无收入的池暂不分摊；无池的月份分摊为 0；池不跨月转嫁", () => {
  const { dir, path } = tempDb();
  try {
    const ledger = new ProfitLedger(path);
    ledger.setPoolFixedCost(1, "2026-06", 500); // 该池永远无收入
    ledger.setPoolFixedCost(1, "2026-07", 300);
    ledger.upsertRevenues([
      { id: 1, contractId: 1, productId: 1, bizDate: "2026-07-10", amount: 100, directCost: 0 },
      { id: 2, contractId: 1, productId: 1, bizDate: "2026-08-10", amount: 100, directCost: 0 }, // 无池月份
    ]);
    const rows = profitsByContract(ledger.queryProfits({ from: "2026-06-01", to: "2026-09-01" }));
    // 6 月池的 500 不分摊到 7/8 月；8 月无池则分摊为 0。
    assert.equal(rows.get(1n)!.allocatedFixedCost, 300n);
    ledger.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("输入校验：非法金额、重复池、修订改归属、非法日期", () => {
  const { dir, path } = tempDb();
  try {
    const ledger = new ProfitLedger(path);
    ledger.setPoolFixedCost(1, "2026-01", 100);
    assert.throws(() => ledger.setPoolFixedCost(1, "2026-01", 200), /already set/);
    assert.throws(() => ledger.setPoolFixedCost(1, "2026-13", 100));
    assert.throws(() => ledger.setPoolFixedCost(1, "2026-02", -1));
    assert.throws(() => ledger.setPoolFixedCost(1, "2026-02", 1_000_000_000_001));

    ledger.upsertRevenues([
      { id: 1, contractId: 1, productId: 1, bizDate: "2026-01-05", amount: 100, directCost: 0 },
    ]);
    // 修订不允许改合同/产品/日期。
    assert.throws(() =>
      ledger.upsertRevenues([
        { id: 1, contractId: 2, productId: 1, bizDate: "2026-01-05", amount: 100, directCost: 0 },
      ]), /attribution/);
    assert.throws(() =>
      ledger.upsertRevenues([
        { id: 1, contractId: 1, productId: 1, bizDate: "2026-01-06", amount: 100, directCost: 0 },
      ]), /attribution/);
    // 非法金额与日期。
    assert.throws(() =>
      ledger.upsertRevenues([
        { id: 2, contractId: 1, productId: 1, bizDate: "2026-01-05", amount: 0, directCost: 0 },
      ]));
    assert.throws(() =>
      ledger.upsertRevenues([
        { id: 2, contractId: 1, productId: 1, bizDate: "2026-02-30", amount: 1, directCost: 0 },
      ]));
    assert.throws(() =>
      ledger.upsertRevenues([
        { id: 2, contractId: 1, productId: 1, bizDate: "2026-01-05", amount: 1, directCost: -1 },
      ]));
    // 查询区间 from 必须早于 to。
    assert.throws(() => ledger.queryProfits({ from: "2026-01-10", to: "2026-01-10" }));
    ledger.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
