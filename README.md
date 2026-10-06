# 工业设备盘点对账库

TypeScript + SQLite（`node:sqlite`，零原生依赖）实现的盘点对账库，由上层调用。
账册、盘点任务、提交结果、冻结基线、操作日志与调整单全部持久化到本地 SQLite 文件。

## 运行要求

- Node.js >= 22.5（内置 `node:sqlite`）
- `npm install && npm test` 即可构建并运行全部测试

## API 概览

```ts
import { InventoryReconciliation } from "inventory-reconciliation";

const lib = new InventoryReconciliation("inventory.db");

lib.loadInitialLedger([{ tag: "D1", area: "A", custodian: "张三", mark: "pending" }]);
lib.registerTransfer({ tag: "D1", area: "B", custodian: "李四" }); // 日常调拨

const task = lib.openTask(["A", "B"]);        // 冻结整份账册为基线
lib.submitResults(task.id, [                   // 提交整份盘点结果，提交后固定
  { tag: "D1", area: "B", custodian: "李四" },
]);
lib.getDiffs(task.id);                         // 差异清单（短缺/盈余/位置/保管人）
const result = lib.approveTask(task.id);       // 审批：全部通过才落账
lib.getAdjustment(task.id);                    // 调整单（仅实际改变的字段及前后值）
```

## 核心规则实现

- **冻结基线**：`openTask` 在同一事务内快照整份账册（`baselines` 表）并记录操作日志水位
  （`baseline_seq`），后续调拨与审批都不修改基线。
- **差异判定**：只由基线与提交结果决定，不随当前账册变化。短缺/盈余/位置/保管人差异可同时存在。
- **逐字段审批**：当前值等于基线值则改为目标值；已等于目标值视为收敛跳过；两者都不是则冲突。
  只有目标与基线不同的字段参与修改，其余字段保留审批时的当前值。
- **短缺额外约束**：任务开启后区域或保管人曾发生实际变化（以 `op_log` 为准），即使改回基线值
  也判冲突，优先于字段收敛规则。
- **原子落账**：审批在单个 `IMMEDIATE` 事务内完成；任何冲突即整单回滚，不生成调整单，可重试。
  成功生成唯一调整单（`adjustments.task_id` 唯一），重复审批直接返回原调整单，不重新判断。
- **并发与一致性**：所有写操作（调拨、开任务、提交、审批）都在事务中执行，读取不会看到
  部分审批结果；SQLite WAL 模式。

## 目录结构

- `src/types.ts` — 公开类型
- `src/db.ts` — 数据库打开、表结构、事务助手
- `src/ledger.ts` — 初始账册、日常调拨（含操作日志）、账册查询
- `src/tasks.ts` — 开任务（冻结基线）、提交结果、差异计算
- `src/approval.ts` — 审批、调整单
- `src/index.ts` — 门面类 `InventoryReconciliation`
- `test/reconciliation.test.ts` — 验收测试（含 50,000 台设备 × 10 任务冒烟）
