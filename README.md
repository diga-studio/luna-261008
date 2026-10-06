# purchase-reconciliation

采购三方核销库（采购订单 / 收货 / 发票 / 核销结果），TypeScript 实现，SQLite 持久化，供上层直接调用。本模块不执行付款。

## 构建与测试

```bash
npm install
npm test        # 等价于 tsc 构建 + node --test
```

仅依赖 Node.js（>= 22.5，使用内置 `node:sqlite`）与开发依赖 `typescript`、`@types/node`，无需任何外部服务。

## 数据约定

- 金额、单价：分的整数；数量：千分之一采购单位的整数。一律用 `bigint` 表示，单值最多 18 位，累加精确（BigInt）。
- 基准金额 = 票量 × 合同单价 / 1000，仅最后一步四舍五入到分，恰好半分向上；2% 容差比较不舍入、不近似。
- 本期只处理同币种、不含税价格；不处理订单变更与替代品。

## API

```ts
import { ReconciliationLibrary } from 'purchase-reconciliation';

const lib = ReconciliationLibrary.open('data.sqlite'); // 或 ':memory:'

await lib.registerPurchaseOrder(opId, { poId, currency, lines: [{ lineId, orderedQty, unitPrice }] });
await lib.recordReceipt(opId, { receiptId, lines: [{ poId, poLineId, qtyQualified, qtyPending, qtyRejected }] });
await lib.registerInvoice(opId, { invoiceId, currency, lines: [{ poId, poLineId, qty, amount }] });
await lib.voidInvoice(opId, invoiceId);
const snap = lib.getSnapshot(); // 各票状态(seq/state) + 各订单行合格量/核销票量/核销票额
lib.close();
```

- 每个写操作携带全库唯一业务操作号 `opId`：同号同内容重试返回 `duplicate` 且无新增副作用（不改变登记顺序、不复活撤销票、不重放旧更正）；同号不同内容返回 `conflict` 且数据不变。
- 收货更正：同一 `receiptId` 再次登记即整单替换原内容，可减少合格数量。
- 每次写入后按当前有效数据全量重算分配（不保留旧匹配资格）：按首次登记序号升序，能整票加入的最早发票先占额度，不满足者不阻塞更晚候选，迭代至没有可加入的发票。
- 核销规则：单票行偏差 ≤ 2%；加入后累计偏差 ≤ 2%；累计票量 ≤ min(订购量, 当前合格收货量) × 105%（等于边界可核销）；基准为零时金额只能为零；整票所有行满足才可结算，否则整票待匹配、不占额度。
- 并发：所有写操作内部串行化，并发结果等价于保持完成顺序的某个串行执行；查询只能看到完整版本。成功写入返回后立即可见，正常关闭再打开结果不变。

## 结构

- `src/types.ts` 公共类型
- `src/money.ts` 精确金额计算（BigInt）
- `src/engine.ts` 分配引擎（纯函数，可独立用于对账）
- `src/db.ts` SQLite 打开与建表
- `src/library.ts` 公共 API：幂等、串行化、重算与持久化
- `test/` 验收测试（node:test）
