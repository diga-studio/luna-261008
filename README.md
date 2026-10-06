# SentinelCore 离线威胁事件补偿模块

TypeScript 库，为运行时代理与安全汇总侧提供断连容忍的威胁事件补传能力。
两侧各自使用 SQLite（WAL + 事务）独立持久化，进程随时中断后均可独立恢复。

## 构建与测试

```sh
npm install
npm test
```

仅依赖 Node.js 内置模块（`node:sqlite`，需 Node.js >= 22.5，建议 >= 24）；
`typescript` 与 `@types/node` 为开发依赖，声明在 `package.json` 中。

## 组成

- `AgentStore`（`src/agent.ts`）：代理侧。本地接收事件（`receiveEvent`）、
  取出待补传批次（`pendingEvents`）、应用确认回执并清理正文（`applyAck`）。
- `AggregatorStore`（`src/aggregator.ts`）：汇总侧。应用补传事件（`applyEvents`，
  返回各代理确认回执）、查询连续前缀记录（`records`）与确认水位（`watermark`）。
- `src/types.ts`：`EventEnvelope`、`AckMessage`、`ReceiveResult`、`ThreatRecord` 等类型。

## 用法

```ts
import { AgentStore, AggregatorStore } from './src';

// 代理侧：接收事件（同一 eventId 重试幂等，返回原序号）
const agent = new AgentStore('agent.db', 'agent-1');
const { seq } = agent.receiveEvent('evt-001', Buffer.from([...]));

// 补传一轮：取出待补传事件 -> 送达汇总侧 -> 回执送回代理
const batch = agent.pendingEvents(100);        // 可分批、可乱序送达
const acks = aggregator.applyEvents(batch);    // 汇总侧去重并推进水位
for (const ack of acks) agent.applyAck(ack);   // 水位以内正文被清理

// 汇总侧：只公开从序号 1 开始无缺口的连续前缀
const records = aggregator.records('agent-1');
const watermark = aggregator.watermark('agent-1');
```

## 保证

- 序号按代理独立分配，从 1 连续递增；同一事件标识永远对应同一序号。
- 接收、补传应用、确认清理均在单事务内完成，进程中断不产生半提交状态。
- 重复送达与重复回执幂等；过期回执不会使水位倒退。
- 确认水位以内的事件正文被清理释放空间；清理后原标识重提仍返回原序号，
  不会重新补传成新记录。

## 测试

`npm test` 覆盖：接收中断后原标识重试、汇总侧已保存但回执丢失、
确认后清理中断（均通过 SIGKILL 子进程模拟真实崩溃）、两侧独立重启恢复、
乱序/部分/重复补传、双代理交错补传的缺口隔离，以及 10000 条 4KiB 积压。
