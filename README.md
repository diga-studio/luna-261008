# order-split-merge-inventory

订单拆并与库存预留库（TypeScript），由上层 OMS 直接调用，业务数据持久化在本地 JSON 文件（原子写：临时文件 + rename）。无外部服务依赖，不监听任何端口。

## 要求

- Node.js >= 18（仅运行时依赖，无原生模块）

## 构建与测试

```sh
npm install
npm test        # 先 tsc 编译到 dist/，再用 node:test 跑全部测试
npm run build   # 仅编译
```

## 概念

- **原始订单（Original Order）**：客户订单，标识由上层保证唯一。取消以原始订单为单位。
- **履约单（Fulfillment Order）**：执行单。提交原始订单时生成一张生效履约单并预留其全部 SKU 数量；拆分/合并产生新履约单，被拆/被并的单随即失效。每张生效履约单占用其地点一个容量名额。
- 履约单的每行数量都保留原始订单归属：`sku -> (orderId -> quantity)`。

## API

```ts
import { OrderInventoryStore } from './src/index.js';

const store = OrderInventoryStore.open({ filePath: 'data/state.json' });

// 初始化（运行期间不修改；每地点仅可配置一次）
await store.configureLocation('L1', {
  capacity: 100,                                   // 生效履约单名额
  skus: { A: { total: 1000, safetyStock: 50 } },   // 库存总量 / 安全库存
});

// 提交原始订单：生成生效履约单并预留，返回履约单 ID
const f1 = await store.submitOrder('O1', 'L1', [{ sku: 'A', quantity: 5 }]);

// 拆分：按原始订单及 SKU 汇总必须与被拆单完全相等；成功后被拆单失效
const [t1, t2] = await store.split(f1, [
  { locationId: 'L1', lines: [{ orderId: 'O1', sku: 'A', quantity: 2 }] },
  { locationId: 'L2', lines: [{ orderId: 'O1', sku: 'A', quantity: 3 }] },
]);

// 合并：相同 SKU 累加，原始订单归属不丢失；成功后输入单全部失效
const merged = await store.merge([t1, t2], 'L1');

// 取消：按原始订单移除其在所有生效履约单中的数量并释放库存；
// 合并单仍有其他订单数量时继续生效占名额，变空才释放名额；重复取消不再次释放
await store.cancelOrder('O1');

// 查询（同步，读取的是某个完整操作前/后的一致状态）
store.getFulfillment(merged);
store.listActiveFulfillments();
store.getOrder('O1');
store.getLocationSku('L1', 'A');      // { total, safetyStock, reserved, available }
store.getLocationCapacity('L1');      // { capacity, used, available }

await store.flush();  // 立即落盘（可选）
await store.close();  // 等待在途操作完成并落盘；之后重开状态不变
```

## 语义与不变量

- **资源按“操作完成后”核算**：校验先移除输入单占用再加上输出单占用，原预留参与重新核算。因此同地点原地拆并不会因库存被输入单自己占满而失败；资源不足时整个操作不生效，输入单与原预留保持不变。
- **库存约束**：同地点同 SKU 预留总量 ≤ 库存总量 − 安全库存；地点生效履约单数 ≤ 容量。
- **数量守恒**：每个未取消原始订单，其在所有生效履约单中的各 SKU 数量之和恒等于提交量；取消后为零。已取消订单的数量已从履约单移除，拆并的等量校验使其无法被重新带回。
- **原子性**：所有变更经内部队列串行化，先完整校验再一次性应用；失败（`StoreError`）不留任何变更。读取只能看到某次完整操作之前或之后的状态。
- **持久化**：每次变更置脏，`flush()`/`close()` 时整体原子写入 JSON 文件；重新打开后由履约单重建资源占用与订单索引。正常关闭后重开，订单归属与资源占用不变；不保证运行中被强杀后的恢复。

## 错误

所有业务校验失败抛出 `StoreError`，`code` 取值：`LOCATION_NOT_FOUND`、`ORDER_NOT_FOUND`、`ORDER_ALREADY_EXISTS`、`FULFILLMENT_NOT_FOUND`、`FULFILLMENT_NOT_ACTIVE`、`INSUFFICIENT_STOCK`、`INSUFFICIENT_CAPACITY`、`QUANTITY_MISMATCH`、`INVALID_ARGUMENT`、`STORE_CLOSED`。

## 性能

资源占用（各地点预留/名额）与“订单 -> 履约单”索引均增量维护，单次操作复杂度只与本次涉及的单据规模成正比。规模测试覆盖 200 地点、2 万订单、2 万生效履约单、64 并发的提交/合并/拆分/取消交错（`test/scale.test.ts`）。

## 目录

- `src/types.ts`：对外类型
- `src/state.ts`：内部状态、独立汇总与派生视图重建
- `src/store.ts`：`OrderInventoryStore` 主实现（串行化、校验、变更）
- `src/persistence.ts`：JSON 文件持久化（原子写）
- `test/`：验收与回归测试（node:test）
