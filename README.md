# workshop-rescheduler

车间排程调整库（TypeScript，纯内存）。由上层规划工具调用，支持对当前排程的
调整预览与应用：临时插单或机器调配时移动一道工序，锁定承诺不被破坏，其余工序
尽量少动。

## 模型

- 规划窗口为 48 个连续时间格（每格 15 分钟），时间一律用整数格表示。
- 机器有类型与可用时间区间（半开区间 `[start, end)`），同一时刻只执行一道工序，
  相邻工序可首尾相接。
- 作业是严格有序的工序链，后继开工不早于前序完工；每道工序要求机器类型，
  固定占用 1–8 格，整个占用区间必须连续落在机器可用时间内。
- 当前排程中每道工序有机器、开工时间与锁定标记。

## 使用

```ts
import { Rescheduler } from "workshop-rescheduler";

const rescheduler = new Rescheduler(problem, initialSchedule);

// 预览：返回候选排程，不改变当前排程
const preview = rescheduler.preview({ opId: "Q1", machineId: "M1", start: 4 });
if (preview.ok) {
  console.log(preview.schedule, preview.changedCount, preview.totalDeviation);
}

// 应用：按相同规则整体替换当前排程；无解时当前排程保持不变
const applied = rescheduler.apply({ opId: "Q1", machineId: "M1", start: 4 });
```

求解目标（字典序）：先最小化机器或开工时间发生变化的未锁定工序数，再最小化
这些工序相对原计划开工时间的绝对位移总和；目标工序不计入这两个目标。
锁定工序的机器与起止时间原样保留；指定调整必须兑现；无解时报告 `ok: false`。

## 构建与测试

```sh
npm install
npm test        # 编译并运行全部测试（node:test）
npm run build   # 仅编译到 dist/
```

仅依赖 Node.js 与 devDependencies 中的 `typescript`、`@types/node`。
