# 工业设备盘点对账库

用 TypeScript + SQLite（Node.js 内置 `node:sqlite`，无原生依赖）实现的设备盘点对账库。
账册、盘点任务与调整单全部持久化到本地 SQLite 文件，由上层应用直接调用。

## 构建与测试

```bash
npm install
npm test        # tsc 编译后运行 node:test 测试
```

只依赖 devDependencies 中的 `typescript` 与 `@types/node`，运行时使用 Node.js（>= 22.5）内置模块。

## API 概览

```ts
import { InventoryLedger } from './src/index.js';

const ledger = new InventoryLedger('inventory.db');

ledger.initLedger(devices);            // 载入初始账册（仅一次）
const taskId = ledger.openTask(['East', 'North']); // 开启盘点，冻结整份账册为基线
ledger.transfer(tag, area, custodian); // 登记日常调拨（位置/保管人，标记不变）
ledger.submitResult(taskId, entries);  // 提交整份盘点结果，提交后固定
ledger.getTaskResult(taskId);          // 查看任务结果与差异清单
const result = ledger.approve(taskId); // 审批：全部通过才落账并生成唯一调整单
ledger.getLedger();                    // 查看当前账册
ledger.getAdjustment(id);              // 查看调整单
```

## 核心规则实现

- **冻结基线**：`openTask` 在事务中把当时整份账册复制进 `baselines` 表，后续任何变化都不修改它；
  差异判定（短缺/盈余/位置/保管人）只看基线与提交结果，不随当前账册变化。
- **字段级审批**：每个参与字段（目标值 ≠ 基线值才参与）独立判断——
  当前值等于基线值则改为目标值；已等于目标值视为收敛跳过；两者都不是则冲突。
  不相关设备、未参与字段与已收敛字段都不会导致失败。
- **短缺保护**：短缺项提议把标记改为“待查”时，若任务开启后该设备的位置或保管人
  曾发生实际变化（以字段级变更流水 `events` 为准，调回也算），优先判冲突。
- **整单原子性**：审批在单个 `BEGIN IMMEDIATE` 事务内完成，任何冲突即整体回滚，
  不生成调整单，可修正后重新审批；成功则生成唯一调整单，只记录实际改变的字段及前后值。
  已成功任务再次审批直接返回原调整单，不重新判断、不写账。
- **并发与一致性**：调拨与审批都在事务中整体提交，读取只会看到完整结果；
  SQLite（WAL 模式）保证冻结基线对应一个完整账册时点。

## 数据表

| 表 | 说明 |
| --- | --- |
| `devices` | 当前账册 |
| `tasks` / `task_scope` | 盘点任务与区域范围 |
| `baselines` | 开启任务时冻结的整份账册基线 |
| `submissions` | 提交的盘点结果（固定不可改） |
| `events` | 字段级变更流水（调拨与审批落账） |
| `adjustments` / `adjustment_items` | 调整单及明细 |

## 测试

`test/reconcile.test.ts` 覆盖：

- 重叠任务并发审批：兼容变更正确合并、相同目标收敛、含冲突批次整单不落账（可重试）；
- 短缺设备调出又调回仍被拦截（无实际变化的调拨不拦截）；
- 成功审批后再调拨并重试审批：账册不回滚、调整单不重复；
- 持久化：关闭重开 SQLite 文件后账册、任务、调整单状态完整；
- 差异清单与最终账册同按冻结基线和操作记录独立计算的预期一致；
- 规模：50,000 台设备、10 个同时待审批的任务全部审批落账。
