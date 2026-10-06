# purchase-reconciliation

采购三方核销库（TypeScript + SQLite，零原生依赖）：登记采购订单、收货与发票，
按当前有效数据重新分配核销额度，产出可结算清单。本模块不执行付款。

## 要求与构建

- Node.js ≥ 22.5（使用内置 `node:sqlite`，无需任何数据库服务或原生编译）
- `npm install` 后 `npm test` 即可运行全部测试；`npm run build` 仅编译到 `dist/`

## 快速开始

```ts
import { ReconciliationStore } from 'purchase-reconciliation';

const store = ReconciliationStore.open('data.db');

// 初始化：登记固定采购订单及行（数量 = 千分之一采购单位，单价 = 分）
store.registerOrder('op-001', {
  orderId: 'PO-1',
  currency: 'CNY',
  lines: [{ lineId: 'L1', qty: 100_000, priceCents: 100 }],
});

// 登记或更正收货（同一 receiptId 整体替换；仅合格数量提供额度）
store.registerReceipt('op-002', {
  receiptId: 'GR-1',
  lines: [{ orderId: 'PO-1', lineId: 'L1', qualified: 60_000, pending: 5_000, unqualified: 0 }],
});

// 登记发票（行指向订单行，金额 = 分）
store.registerInvoice('op-003', {
  invoiceId: 'INV-1',
  lines: [{ orderId: 'PO-1', lineId: 'L1', qty: 50_000, amountCents: 5_000 }],
});

store.voidInvoice('op-004', 'INV-1'); // 撤销发票

const snap = store.getSnapshot();
// snap.invoices: [{ invoiceId, seq, status: 'SETTLED' | 'PENDING' | 'VOIDED' }]
// snap.lines:    [{ orderId, lineId, qualifiedQty, matchedQty, matchedAmountCents, baselineCents }]
store.close();
```

## 业务规则要点

- 数量、金额、单价均为整数（数量 = 千分之一采购单位，金额/单价 = 分），
  接口接受 `bigint | number | string`，单个数值最多 18 位，内部以 `bigint` 精确累加。
- 基准金额 = 票量 × 合同价，仅在最后四舍五入到分（恰好半分向上）；
  容差比较用精确整数运算（`|金额-基准| ≤ 基准×2%`），不舍入、不近似。
- 每张发票按订单行合计判断：单票偏差 ≤ 2%，且加入后该订单行累计票额对累计票量
  基准的偏差 ≤ 2%；基准为零时金额只能为零。
- 加入后每行累计核销票量不得超过订购量的 105%，也不得超过当前合格收货量的 105%；
  等于边界可核销，少开票不要求耗尽收货。
- 整票所有行均满足才成为可结算（`SETTLED`），否则整票待匹配（`PENDING`），不占任何额度。
- 每次更新按当前有效数据从头重分配：当前能整票加入的最早登记发票（序号 `seq` 可查询）
  优先获得额度，不满足者不阻塞更晚候选，分配持续到没有可加入的发票。
  撤票不参与；收货更正后原可结算票可回到待匹配。
- 每次写入携带全库唯一业务操作号：同号同内容重试无副作用（不改变登记顺序、
  不复活撤销票、不重放旧更正）；同号不同内容抛出 `OpConflictError` 且数据不变。

## 一致性与持久化

- 每次写入（含重分配）在单个 SQLite 事务内完成，返回即对 `getSnapshot()` 可见；
  查询只会看到完整版本。
- 单进程内写入天然串行，并发调用结果等价于某个保持完成顺序的串行执行。
- 正常 `close()` 后重新 `open()` 结果不变（WAL 模式）；不保证运行中被强杀后的恢复。
- 规模：2000 张发票 × 每票 20 行的全量登记约 40ms（内存缓存 + 增量候选扫描）。

## 项目结构

- `src/types.ts` — 公共类型（输入与快照）
- `src/num.ts` — 18 位整数校验、基准金额、2% 容差、105% 上限、半分向上舍入
- `src/matching.ts` — 纯函数额度分配（优先级循环扫描至不动点）
- `src/store.ts` — `ReconciliationStore`：幂等写入、事务、重分配、快照
- `src/db.ts` — SQLite 打开与建表
- `test/` — node:test 测试（含独立参考实现比对、并发与重放、重开一致性）
