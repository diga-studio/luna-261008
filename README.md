# download-alert-tracker

检测员工批量下载行为的内存告警库：同一员工在任意 600 秒窗口内活跃的不同文件数达到 51 个即进入告警状态。

## 构建与测试

```sh
npm install
npm test
```

只需要 Node.js；`typescript` 与 `@types/node` 为 devDependencies，`npm test` 会先编译再运行 `node:test` 测试。

## API

```ts
import { DownloadAlertTracker } from './src/index.js';

const tracker = new DownloadAlertTracker();

// 接收一批下载事件（可乱序、可重复 eventId），返回本批造成的告警净变化。
const changes = tracker.ingest([
  { eventId: 'e1', employeeId: 'emp1', fileId: 'f1', timestamp: 1728000000 },
]);
// changes: [{ employeeId, added: Interval[], removed: Interval[] }]

// 查询某员工当前全部告警区间（极大、左闭右开、互不相接）。
const alerts = tracker.getAlerts('emp1');
// alerts: [{ start, end }, ...]
```

## 语义

- 时间为 `t` 的下载使该文件在 `[t, t+600)` 内活跃（含起点、不含终点）；同一文件的多次下载可延长活跃时间，但任意时刻只计一个文件。
- 某时刻活跃文件数 ≥ 51 时该员工处于告警状态；告警输出为唯一的极大左闭右开区间集合，相接区间自动合并，不产生零长度区间。
- 同一时刻的下载与失效同时生效；区间终点由文件失效时刻精确决定。
- `eventId` 全局唯一，重复事件（含整批重放）不改变状态、返回空变化。
- 结果只取决于已接收的事件集合，与到达顺序、批次划分无关；迟到事件会修订历史告警（延长或合并区间以 `removed` + `added` 表达）。
