# contract-profit-ledger

合同利润的固定成本分摊库（TypeScript + SQLite），由上层调用。

多个合同共享同一产品线的交付团队与固定运营费用。本模块把"产品 x UTC 自然月"
成本池的固定成本，按收入金额占比统一分摊到每笔收入并持久化归属结果，使任意
日期切片的合同利润可以相互核对：同一合同换查询区间，历史成本不变。

## 运行要求

- Node.js >= 24（使用内置 `node:sqlite`，无任何原生/外部依赖）
- `npm install` 后 `npm test` 即可运行全部测试与规模验证

```bash
npm install
npm test        # 编译 + 单元测试 + 集成测试 + 规模验证
npm run build   # 仅编译库到 dist/
```

## API

```ts
import { ProfitLedger } from "contract-profit-ledger";

const ledger = new ProfitLedger("ledger.db");   // 打开或创建 SQLite 文件

// 录入某产品某 UTC 自然月（YYYY-MM）的固定成本（分）。每池只能录入一次，之后不可修改。
ledger.setPoolFixedCost(productId, "2026-01", 1_000_000);

// 批量新增或修订收入（同一批次是一个事务）。
// 修订只改变 amount 与 directCost；contractId / productId / bizDate 不可变。
ledger.upsertRevenues([
  { id: 1n, contractId: 10n, productId: 1n, bizDate: "2026-01-05",
    amount: 6000n, directCost: 600n },
  // ...
]);

// 查询 [from, to) 区间按合同聚合的利润。金额为 bigint（分），净利润允许为负。
const rows = ledger.queryProfits({ from: "2026-01-01", to: "2026-02-01" });
// => [{ contractId, revenue, directCost, allocatedFixedCost, netProfit }, ...]

ledger.close();  // 正常关闭；重新打开后收入、成本池与利润结果一致
```

约束：收入编号为全局唯一正整数；金额为整数分，收入金额 > 0、直接成本 >= 0，
单项不超过 1_000_000_000_000 分。所有金额计算使用 bigint，结果精确到分。

## 分摊规则

- 成本池 = 一个产品的一个 UTC 自然月。池固定成本按收入金额占比分给该池全部收入，
  与合同数量、直接成本无关；不跨月转嫁。
- 每笔收入的分摊金额 = 精确理论份额向下取整，或向下取整 + 1 分。
  补 1 分时理论份额小数部分（余数）较大者优先；余数相同则收入编号较小者优先。
  有收入的池，分摊之和恰好等于池金额；无收入的池暂不分摊。
- 每笔收入的归属成本只由完整成本池决定，与查询区间无关；查询不做重新分摊。
- 追加或修订收入会在同一事务内重算受影响池，批量调用结束后所有受影响合同的
  查询统一反映整批变更。

## 实现要点

- `src/allocation.ts`：纯分摊数学。全部 bigint 运算（中间乘积可达 1e24，超出
  double 精确范围），类型化数组实现，单池 100000 笔时内存保持低位。
- `src/ledger.ts`：`ProfitLedger`。批量 upsert 在一个事务内完成写入与受影响
  池的重分摊；分摊结果写回 `revenues.allocated` 列。
- `src/db.ts`：schema。`pools(product_id, month)` 主键保证池成本只能录入一次；
  覆盖索引 `(biz_date, contract_id, amount, direct_cost, allocated)` 支撑区间
  聚合查询。
- 查询直接对 `allocated` 列做 `GROUP BY contract_id` 聚合，区间切片天然满足
  "分段相加等于完整区间"。

## 测试与规模验证

- `test/allocation.test.ts`：分摊数学（含 > 2^53 大额中间乘积、余数相同按编号
   tie-break、随机规模下总和精确等于池金额且每笔只取 floor/floor+1）。
- `test/ledger.test.ts`：集成测试。大额金额与余数相同的分摊、完整月份与任意
  日期切片对账、追加/批量修订引起其他合同成本变化且总和不变、关闭重开一致、
  输入校验。
- `test/scale.test.ts`：可复现规模验证（固定随机种子）。24 个月 x 100 产品 x
  2000 合同 x 500000 笔收入，最大池 100000 笔；报告查询 p95/p100、批量修订
  耗时与内存峰值，并断言：100 次查询 >= 95 次 < 300ms、100000 笔池中修订
  1000 笔 < 3s、进程 RSS 峰值 < 256 MiB。

本机参考结果（Apple Silicon，Node 24）：

```
收入加载（500000 笔）: ~40 s（测试数据准备，非验收指标）
查询 100 次: p95 ≈ 85 ms, p100 ≈ 110 ms, <300ms 占比 100/100
批量修订 1000 笔（100000 笔池）: ≈ 550 ms
进程驻留内存峰值: ≈ 226 MiB
```
