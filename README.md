# dd-engagement-stats

尽调文档参与度统计库（TypeScript + SQLite）。由上层应用调用，提供活动事件导入与文档日报查询。

## 要求

- Node.js >= 22.5（使用内置 `node:sqlite`，无原生依赖、无外部服务）

## 构建与测试

```bash
npm install
npm test
```

## 使用

```ts
import { createStats } from 'dd-engagement-stats';

const stats = createStats('./data.sqlite'); // 或 ':memory:'

stats.importEvents([
  {
    eventId: 'evt-0001',      // 全局唯一 ASCII ID
    roomId: 'room-1',
    sessionId: 'sess-1',
    userId: 'user-1',
    timestamp: Date.UTC(2024, 2, 1, 23, 50),
    action: 'open',           // 'open' | 'download' | 'other'
    docId: 'doc-a',           // open / download 必填
  },
]);

const report = stats.getDailyReport('room-1', 'doc-a', '2024-03-01');
// { roomId, docId, date, opens, uniqueReaders, downloads, avgDwellMs }
// 当天无任何数据时返回 null；无有效停留时 avgDwellMs 为 null

stats.close();
```

## 语义说明

- 导入幂等：同一 `eventId` 只影响指标一次，允许任意顺序、任意分批、整批重投。
- 会话内业务顺序按 `(timestamp, eventId)` 升序；一次打开的停留是到同会话下一条动作的时间差，超过 20 分钟或无后继不计入平均停留（恰好 20 分钟与间隔 0 有效）。
- 日报按房间 + 文档 + UTC 自然日；打开/下载按各自发生日期计数，跨午夜停留全部归打开发生的日期；同一用户当天同文档只算一个独立阅读用户。
- 日报在查询时基于全部已接收事件实时计算，迟到事件会自动修正历史日期的结果。
