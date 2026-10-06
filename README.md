# task26100833

资源受限的流程仿真库（TypeScript）：精确重算容量与时长修改引起的排队传播。

## 使用

```bash
npm install
npm test        # 构建并运行全部测试
npm run build   # 仅构建（dist/ 与 dist-test/）
```

## API

```ts
import { replay, compare } from "flow-sim";
```

### `replay(input, scenario, seed, round)`

执行一轮仿真，返回：

- `steps`：保留步骤（被删除活动的步骤不出现），按开始顺序记录
  `caseId`、`activityId`、原始下标 `stepIndex`、`ready`/`start`/`end` 时间；
- `completions`：每个 case 的完成时间（空路径在到达时完成）。

### `compare(input, scenario, seed, rounds)`

执行 `rounds`（100–10000）轮基线与方案配对仿真，返回基线、方案各自
每轮平均及中位 case 耗时（完成 − 到达）的跨轮均值，以及方案减基线的差值。
每轮轨迹用完即弃，不保留。

### 输入

```ts
interface SimulationInput {
  activities: { id: string; samples: number[]; capacity: number }[];
  cases: { id: string; arrival: number; path: string[] }[];
}

interface Scenario {
  remove?: string[];                    // 删除活动（跳过其全部出现）
  shorten?: Record<string, number>;     // 活动 -> 缩短百分比 1..99（向下取整，可为 0）
  capacity?: Record<string, number>;    // 活动 -> 容量覆盖 1..50
}
```

空 scenario（`{}`）即基线；未指定部分沿用基线。

## 语义要点

- 事件驱动仿真：同一时刻先处理全部完成事件与外部到达，再为各活动批量派发；
  零时长步骤在同一时刻的下一批完成，级联至无即时事件才推进时钟。
- 活动队列按（就绪时间, case 标识 ASCII 字典序）派发；步骤非抢占；
  各活动工位池独立，同活动重叠服务数不超过容量。
- 每步原始抽样由 `(seed, round, caseId, 原始步骤下标)` 唯一确定，
  按历史样本出现次数加权，且与容量、删除、调度及 case/样本输入顺序无关；
  先抽原始时长再应用缩短修改。
