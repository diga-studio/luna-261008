# doc-engagement-stats

尽调文档参与度统计库（TypeScript + SQLite，基于 Node 内置 `node:sqlite`，无原生依赖）。

## 要求

- Node.js >= 23.4（`node:sqlite` 自该版本起无需 flag）

## 使用

```bash
npm install
npm test        # 编译并运行全部测试
npm run build   # 仅编译到 dist/
```

```ts
import { EngagementTracker } from "doc-engagement-stats";

const tracker = new EngagementTracker("data.db");
tracker.importEvents([
  { eventId: "e1", roomId: "R1", sessionId: "S1", userId: "U1",
    timestamp: Date.UTC(2024, 0, 1, 23, 50), action: "open", documentId: "D1" },
]);
const report = tracker.getDailyReport("R1", "D1", "2024-01-01");
// { openCount, uniqueReaders, downloadCount, avgDwellMs }
tracker.close();
```

## 规则要点

- 事件按 `eventId` 幂等去重，支持任意顺序、任意分批、整批重投。
- 会话内业务顺序按 (时间戳, eventId 字典序) 升序；打开的停留时间算到同会话下一条动作为止。
- 停留 > 20 分钟或无后继不计入平均停留；恰好 20 分钟与 0 均有效；停留全部归打开发生日。
- 日报按 (房间, 文档, UTC 自然日) 查询；同一用户多会话当天只算一个独立阅读用户。
