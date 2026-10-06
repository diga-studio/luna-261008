# workshop-rescheduler

车间排程调整库（TypeScript，纯内存），供上层规划工具调用。

## 模型

- 规划窗口为 48 个连续时间格，每格 15 分钟，时间一律用整数格表示。
- 机器有类型与可用区间（含起点、不含终点），同时只能执行一道工序，相邻工序可首尾相接。
- 作业由严格有序的工序链组成，后继开工不得早于前序完工。
- 每道工序有机器类型要求与 1~8 格固定时长，占用区间必须连续落在同一台同类型机器的可用时间内，不跨停机、不出窗口。

## 用法

```ts
import { WorkshopScheduler } from "workshop-rescheduler";

const scheduler = new WorkshopScheduler(machines, jobs, initialPlacements);

// 预览：返回候选排程，不改变当前排程
const preview = scheduler.preview({ operationId: "Q1", machineId: "M1", start: 2 });

// 应用：按相同规则整体替换当前排程；无解时当前排程保持不变
const applied = scheduler.apply({ operationId: "Q1", machineId: "M1", start: 2 });
```

- 指定的调整必须兑现；所有锁定工序（包括未来的）机器与起止时间原样保留。
- 其余未锁定工序可提前、推迟或换到同类型机器。优化目标按字典序：
  先最小化机器或开工时间发生变化的工序数量，再最小化它们相对原计划
  开工时间的绝对位移总和（目标工序均不计入）。
- `preview` / `apply` 返回 `{ ok: true, placements, changedCount, totalDisplacement }`
  或 `{ ok: false, reason }`；失败时当前排程不受任何影响。

## 构建与测试

```sh
npm install
npm test
```

仅依赖 Node.js 与 `devDependencies` 中的 `typescript`、`@types/node`；
测试使用 Node 内置测试运行器，无需其他服务。
