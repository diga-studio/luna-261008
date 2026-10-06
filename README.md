# rtos-sched-sim

单核 RTOS 任务调度仿真库（TypeScript），供设备编排平台在部署前分析固定任务集合的
抢占、积压与截止时间违约。纯函数、零运行时依赖，结果直接交回调用方。

## 语义

- 每个任务含优先级、执行耗时、周期、非负首次释放偏移、相对截止时间；
  所有时间均为整数微秒，执行耗时 / 周期 / 相对截止时间均为正。
- 第 k 个实例（k 从 0 开始）在 `offset + k * period` 释放，截止时刻为释放时刻加相对截止时间。
- 允许执行耗时或截止时间大于周期：旧实例未完成也照常释放新实例。
- 单核一次只执行一个实例；优先级数字越小越优先，并列时按释放时刻、再按任务输入顺序。
- 更高优先级实例立即抢占，恢复时只执行剩余耗时，切换耗时为零。
- 实例超时后仍可运行，不取消、不跳过；恰好在截止时刻完成算按时。
- 同一时刻先结算完成与截止状态，再处理释放。
- 仿真覆盖 `[0, H)`：仅释放时刻 `< H` 的实例参与；时刻 H 的完成与截止状态计入结果，
  但不释放时刻 H 的新实例。
- 时间线为按顺序的最大连续执行片段（含空闲段）；不改变执行对象的释放 / 截止事件不会切碎片段。

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

// result.timeline  —— 最大连续执行片段（taskIndex 为 null 表示空闲）
// result.instances —— 每个实例的释放/开始/完成/剩余时间与截止状态
```

### 结果结构

- `TimelineSegment`：`{ start, end, taskIndex, taskName, instanceIndex }`，
  拼接后连续覆盖 `[0, H)`；`taskIndex === null` 为空闲段。
- `InstanceResult`：`releaseTime`、`deadline`、`startTime`、`completionTime`
  （到 H 未发生则为 `null`）、`remainingTime`、`metDeadline`（未完成为 `null`）、
  `missedDeadline`（完成晚于截止，或到 H 未完成且截止时刻已过）。

非法输入（非整数、非正的执行耗时 / 周期 / 相对截止时间、负偏移、负 H 等）抛出 `TypeError`。

## 构建与测试

```sh
npm install
npm test        # 先 tsc 构建，再用 node:test 运行全部测试
```

测试包含：题目给定场景的手工核算结果、抢占后恢复、完成 / 截止 / 释放同刻、
执行耗时大于周期的实例交叠，以及 300 组随机小规模用例与独立的
逐微秒参考实现（`test/reference.ts`）交叉验证。
