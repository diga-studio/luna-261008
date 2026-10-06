# rtos-sched-sim

单核 RTOS 固定优先级抢占式任务调度仿真库（TypeScript），供设备编排平台直接调用。

## 使用

```ts
import { simulate } from "rtos-sched-sim";

const result = simulate(
  [
    { name: "A", priority: 0, executionTime: 2, period: 5, offset: 0, relativeDeadline: 2 },
    { name: "B", priority: 1, executionTime: 4, period: 6, offset: 0, relativeDeadline: 6 },
  ],
  12,
);
// result.timeline: [0, H) 上的最大连续执行片段（含空闲）
// result.jobs: 每个已释放实例的释放/截止/完成时刻与是否按时
```

## 语义

- 第 k 个实例在 `offset + k * period` 释放（k 从 0 开始），仅释放时刻 `< H` 的实例参与仿真。
- 单核一次只执行一个实例；优先级数字小者优先，同优先级按释放时刻、再按输入顺序。
- 更高优先级实例立即抢占，恢复时只执行剩余耗时，切换耗时为零。
- 超时实例不取消、不跳过；恰好在截止时刻完成算按时；同一时刻先结算完成再处理释放。
- 时刻 H 的完成与截止状态计入结果，但不释放时刻 H 的新实例。

## 构建与测试

```sh
npm install
npm test
```
