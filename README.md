# 驻内存增量阶梯佣金引擎

面向单个销售代表 2026 年第一季度的成交佣金计算。TypeScript 实现，纯驻内存，
不考虑并发、持久化与崩溃恢复；输入均假定为合法且落在季度内。

## 构建与测试

```sh
npm install
npm test
```

`npm test` 会用 `tsc` 编译 `src/` 与 `test/`，再以 Node 内置 test runner 执行全部测试。
除 Node.js 与 npm 外无其他运行时依赖。

## API

```ts
const engine = new CommissionEngine(planVersions); // 不可变计划版本数组
engine.upsertDeal(deal);        // 新增或整体替换同一 externalId 的成交
engine.removeDeal(externalId);  // 删除成交
engine.explainDeal(externalId); // => DealExplanation
```

`DealExplanation` 包含 `priorCumulativeCents`（前序累计）、`planVersionId`、
`slices`（每片记录累计区间、分摊金额、费率基点）与 `payableCents`（最终支付分）。
所有金额均为十进制整数字符串（分），内部以 `BigInt` 计算，无精度损失。

## 设计

- **排序与累计**：成交按 `(closeDate, externalId)` 排序（同日按 ASCII 字典序）。
  使用一棵以该二元组为键、带随机优先级的 **Treap**，每个节点维护子树
  `amountCents` 之和（`BigInt`）。前序累计 = 键严格小于本单的子树和，
  一次下落即可求得。
- **计划版本**：构造时按生效起点排序，查询时二分定位覆盖 `closeDate` 的版本，
  再按成交类型选阶梯。版本切换与成交类型均不重置累计值。
- **切片计费**：本单覆盖 `[prior, prior + amount)` 左闭右开区间，与最多 4 档
  求交得到切片；精确累加 `Σ sliceAmount × rateBps` 后一次性除以 10000，
  仅在最终支付分上四舍五入（恰好半分向上），不做逐切片舍入。

## 复杂度

设 `n` 为当前成交数，阶梯数为常数：

| 操作 | 期望时间 | 说明 |
| --- | --- | --- |
| `upsertDeal` | O(log n) | 旧键删除 + 新键插入（替换时），路径上更新子树和 |
| `removeDeal` | O(log n) | Treap 删除 |
| `explainDeal` | O(log n) | 前缀和查询 + 常数级切片计算 |

修订只触及 Treap 的一条根到叶路径，**不会**逐笔重写后续成交的佣金；
每次 `explainDeal` 都基于当前全集即时算出正确结果，无需调用方触发重算。
空间为 O(n)：每笔成交恰好一个 Treap 节点加一条哈希表索引，
不预存任何前缀数组或历史修订状态。

## 测试

- `test/randomized.test.ts`：固定种子（mulberry32）交错执行 4000 次
  补录 / 替换 / 删除 / 查询，与 `test/reference.ts`（独立的全量排序参考
  计算器，不复用生产计算代码）逐字段比对；日期集中于版本边界以覆盖
  同日排序、跨档成交与版本切换后沿用旧累计。
- `test/targeted.test.ts`：构造逐切片舍入与整单舍入结果不同的跨档成交
  （逐片得 3、整单得 2，引擎输出 2）；恰好半分向上；以及超过
  `Number.MAX_SAFE_INTEGER` 的累计金额下切片边界与支付分的精确性。
- `test/scale.test.ts`：20 万笔同日成交（externalId 升序装载），随后
  2000 次早期修订与末端查询交错，每 100 次用参考计算器校验一次，
  结束时再抽查多位置成交。实测（Apple Silicon，Node 24）：

  ```
  load:    ~236ms 总计, ~1.2us/笔
  revise:  ~5ms  总计, ~2.5us/次
  query:   ~2.5ms 总计, ~1.3us/次
  ```
