# 驻内存增量阶梯佣金引擎

面向单个销售代表 2026 年第一季度的阶梯佣金计算。成交可乱序补录、修改、删除，
任何操作完成后查询立即反映当前成交全集。全程使用 `BigInt` 运算，累计金额与
中间乘积不受 `Number.MAX_SAFE_INTEGER` 限制。

## 构建与测试

```sh
npm install
npm test        # vitest run
npm run build   # tsc -> dist/
```

## API

```ts
import { CommissionEngine } from "./src/engine.js";

const engine = new CommissionEngine(planVersions); // 生效区间互不重叠、覆盖整个季度
engine.upsertDeal({ externalId, amountCents, closeDate, dealType }); // 新增或整体替换
engine.removeDeal(externalId);
const explanation = engine.explainDeal(externalId);
// => { externalId, priorAccumulatedCents, planVersionId, slices[], paymentCents }
```

- 排序：`closeDate` 日历序，同日按 `externalId` 的 ASCII 字典序。
- 前序累计 = 全部前序成交金额之和，新业务与续约共同累计；切换计划版本或
  成交类型均不重置累计。
- 每单覆盖 `[前序累计, 前序累计 + 本单金额)` 左闭右开区间，按跨越的门槛切片，
  逐片 `金额 × 基点` 精确累加后除以 10000，仅在最终支付分数上四舍五入
  （恰好半分向上），不做逐片舍入。

## 实现与复杂度

- 核心结构是随机化 Treap（`src/treap.ts`），键为 `(closeDate, externalId)`，
  子树聚合金额和（BigInt）与节点数；优先级由固定种子的 mulberry32 生成，
  行为可复现。
- `upsertDeal` / `removeDeal`：一次删除加一次插入（或单次插入），期望
  `O(log n)`；只沿树路径更新聚合，不重写任何后续成交。
- `explainDeal`：`sumBefore` 沿树路径求前缀和 `O(log n)`，版本二分
  `O(log v)`，切片 `O(档位数)`（≤4，视为常数）。
- 空间 `O(n)`：每成交一个树节点加一条索引记录，不预存前缀和或修订历史。

## 测试

- `test/randomized.test.ts`：固定种子交错补录/替换/删除/查询，与独立的全量
  排序参考计算器（`test/reference.ts`，不复用生产代码）逐字段比较；含同日
  排序与版本切换沿用旧累计的定向用例。
- `test/amounts.test.ts`：跨档成交的整单舍入 vs 逐片舍入差异、恰好半分向上、
  超 `Number.MAX_SAFE_INTEGER` 的累计与切片边界、删除早期成交后后续档位变化。
- `test/scale.test.ts`：20 万笔同日成交（externalId 升序装载）+ 2000 次早期
  修订与末端查询交错，抽样与参考计算器核对修订后结果，并输出实测耗时。

本机实测（Apple Silicon，Node 24）：装载 200000 笔约 237ms（≈1.2µs/笔），
2000 次修订约 7ms（≈3.6µs/次），2000 次末端查询约 2ms（≈0.9µs/次）。
