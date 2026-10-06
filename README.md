# contract-profit-allocation

合同利润的固定成本分摊库（TypeScript + SQLite）。多个合同共享同一产品线的
固定运营费用时，把固定成本按统一规则归属到每笔收入，使任意日期切片的利润
都能相互核对。

## 特性

- 录入产品 × UTC 自然月的固定成本（录入后不可修改）
- 批量新增 / 修订收入（修订只允许改变收入金额与直接成本）
- 按日期区间 `[from, to)` 查询合同利润：收入、直接成本、分摊固定成本、净利润
- 分摊规则：成本池（一个产品的一个 UTC 自然月）的固定成本按收入金额占比
  分给该池全部收入；每笔分摊为精确理论份额向下取整，或在其上补 1 分
  （小数部分大者优先，并列时收入编号小者优先）；每池分摊之和恰好等于池金额
- 每笔收入的归属成本只由完整成本池决定，与查询区间无关
- 金额全部以 bigint 分计算，精确到分；持久化到 SQLite，正常关闭重开后结果一致

## 使用

```ts
import { ProfitLedger } from "contract-profit-allocation";

const ledger = new ProfitLedger("data.db"); // 或 ":memory:"

ledger.recordFixedCost("P1", "2026-01", 1_000_000n);

ledger.upsertRevenues([
  { id: 1n, contractId: "C1", product: "P1", bizDate: "2026-01-05",
    amountCents: 100_000n, directCostCents: 30_000n },
  { id: 2n, contractId: "C2", product: "P1", bizDate: "2026-01-06",
    amountCents: 300_000n, directCostCents: 50_000n },
]);

const rows = ledger.queryProfit("2026-01-01", "2026-02-01");
// [{ contractId, revenueCents, directCostCents, allocatedFixedCostCents, netProfitCents }, ...]

ledger.close();
```

约束：收入编号为全局唯一正整数；收入金额为正整数分、直接成本与固定成本为
非负整数分，单个金额不超过 1_000_000_000_000 分；日期为 UTC `YYYY-MM-DD`。

## 构建与测试

```bash
npm install   # 仅需 Node.js（>= 22.13，内置 node:sqlite），无原生依赖
npm test      # 编译并运行全部自动化测试
npm run bench # 规模验证：24 个月 × 100 产品 × 2000 合同 × 500000 笔收入
```

## 设计说明

- **存储**：`fixed_cost_pool(product, month)` 与 `revenue(...)` 两张表，
  每笔收入冗余 `allocated_cents` 列保存当前归属成本；查询是对
  `revenue` 的一次区间聚合（覆盖索引 `(contract_id, biz_date, ...)`，
  GROUP BY 有序、无需回表）。
- **重分摊**：追加 / 修订收入或录入固定成本后，对受影响成本池整体重算
  并落库，同一批量调用在一个事务内完成，调用返回即对后续查询可见。
- **精度**：池金额 × 收入额可达 10^24，超出 64 位，全部用 BigInt 计算。
- **内存**：分摊器复用缓冲区，流式读取池内收入，稳态活跃占用约 20MB。
  `npm run bench` 使用 `--max-old-space-size=96` 限制 V8 老生代预留
  （默认策略在突发分配下会预留远超实际需要的堆，导致 RSS 虚高），
  限制后进程驻留稳定在 256MiB 以内。
