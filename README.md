# 订单拆并与库存预留库

供上层 OMS 直接调用的 TypeScript 库：区分原始订单与履约单，支持履约单的拆分、
合并与按原始订单取消，并保证库存预留与容量占用始终恰好对应当前生效履约单。
业务数据通过 Node.js 内置 `node:sqlite` 持久化到本地 SQLite 文件。

## 构建与测试

只依赖 Node.js（v22.5+，建议 v24）与 npm：

```sh
npm install
npm test
```

`npm test` 会用 TypeScript 编译到 `dist/` 并运行 Node.js 内置测试 runner。
唯一的开发依赖是 `typescript`；运行时无任何第三方依赖。

## API 概览

```ts
import { OrderInventoryService } from './src';

const svc = new OrderInventoryService('data.db');

svc.configureLocation('L1', 100, { SKU_A: { total: 1000, safetyStock: 50 } });
const fo = svc.submitOrder('ORDER-1', 'L1', { SKU_A: 10 });      // -> Result<string> 履约单ID
svc.split(fo.value, [/* 至少两张新单的规格 */]);
svc.merge([foId1, foId2], 'L2');                                 // 至少两张生效单
svc.cancelOrder('ORDER-1');                                      // 按原始订单取消，幂等
svc.getLocationUsage('L1');                                      // 库存预留与容量占用快照
svc.getOrderQuantities('ORDER-1');                               // 订单在生效单中的数量汇总
svc.listActiveFulfillments();                                    // 全部生效履约单（副本）
svc.close();
```

所有方法均为同步：一次调用要么完整生效并落盘（单个 SQLite 事务），要么整体
不变；同进程并发调用只会看到某次操作之前或之后的完整状态。

## 目录结构

- `src/types.ts` — 公开类型定义
- `src/service.ts` — 核心业务逻辑（拆并、取消、资源校验）
- `src/store.ts` — SQLite 持久化层
- `src/node-shims.d.ts` — 所用 Node 内置模块的最小类型声明
- `test/` — 自动化测试（合并/拆分/取消、资源约束、并发、持久化、规模冒烟）
