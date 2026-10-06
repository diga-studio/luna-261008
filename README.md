# download-alert-tracker

员工批量下载告警库（TypeScript，单进程、内存态）：检测同一员工在任意
600 秒窗口内下载超过 50 个不同文件的行为。

## 规则

- 时刻 `t` 的下载使该文件在 `[t, t+600)` 内活跃（左闭右开）。
- 同一员工对同一文件的多次下载可延长活跃时间，但任意时刻只贡献 1 个文件。
- 某时刻活跃的不同文件数达到 51 即进入告警；告警表示为唯一的极大
  左闭右开区间集合，相接区间自动合并，不产生零长度区间。
- 结果只取决于已接收事件的集合，与到达顺序、批次划分无关；
  `eventId` 全局唯一，重复事件（含整批重放）不改变状态。

## API

```ts
import { AlertTracker } from "./src";

const tracker = new AlertTracker();

// 接收一批事件，返回净变化：每个受影响员工的 { added, removed } 区间列表。
// 延长/合并旧告警表现为删除旧区间、添加新区间；批内中间状态不外泄。
const changes = tracker.ingest([
  { eventId: "e1", employeeId: "emp1", fileId: "f1", timestamp: 1000 },
]);

// 查询某员工当前全部告警区间（按起点升序）。
const alerts = tracker.getAlerts("emp1");
```

## 构建与测试

```sh
npm install
npm test        # 编译并运行 node:test 测试
npm run build   # 仅编译到 dist/
```

## 实现说明

状态仅为"每个员工、每个文件的下载时间戳有序集合"（对乱序不敏感）。
每个批次处理后，对受影响员工用扫描线重算全部告警区间（先合并每个文件的
活跃区间，再统计任意时刻活跃文件数），与批次前的区间做差集得到净变化。
