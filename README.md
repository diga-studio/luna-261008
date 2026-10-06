# SentinelCore 离线威胁事件补偿模块

TypeScript 库，由上层调用。代理侧（`AgentSide`）本地接收威胁事件并补传，
汇总侧（`SummarySide`）按代理公开无缺口连续前缀。两侧各自用 SQLite 文件
独立持久化，可独立运行、独立重启恢复。

## 构建与测试

```sh
npm install
npm test
```

仅需 Node.js（建议 >= 22.5，使用内置 `node:sqlite`，无原生依赖）。

## API 概览

- `new AgentSide(dbPath)`
  - `receiveEvent(eventId, body)` → `{ seq, created }`：幂等接收，同一
    `eventId` 永远映射到同一序号（每代理从 1 连续递增）。
  - `pendingEvents()` → `ThreatEvent[]`：未确认事件，按序号升序，用于补传。
  - `applyAck(watermark)`：应用汇总侧回执，单调不回退；清理已确认正文，
    保留 `eventId -> seq` 映射。
  - `confirmedWatermark()` → `number`。
- `new SummarySide(dbPath)`
  - `ingest(agentId, events)` → `number`：批量入库（去重），返回该代理
    当前连续确认水位，可作为回执发回代理。
  - `records(agentId)` → `SummaryRecord[]`：从序号 1 开始的无缺口公开前缀。
  - `watermark(agentId)` → `number`。

## 使用流程

1. 代理调用 `receiveEvent` 接收事件（汇总侧不可用也能成功返回）。
2. 连接恢复后，反复将 `pendingEvents()` 发给汇总侧 `ingest`。
3. 汇总侧返回的水位作为回执，代理调用 `applyAck` 清理已确认正文。
4. 回执丢失、重复补传、任一侧重启均不影响最终一致性。
