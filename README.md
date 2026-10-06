# flow-sim

资源受限的流程仿真库（TypeScript）：精确重算容量与时长修改引起的排队传播。

## 安装与测试

```sh
npm install
npm test        # 类型检查 + 编译 + node:test 全部用例
npm run build   # 仅编译到 dist/
```

仅依赖 Node.js（>=18）与 devDependencies 中的 typescript，无其他服务要求。

## API

```ts
import { replay, compare } from "flow-sim";
```

### 输入

```ts
interface SimInput {
  cases: Array<{ id: string; arrival: number; activities: string[] }>;
  activities: Record<string, { samples: number[]; capacity: number }>;
}

interface Scenario {
  remove?: string[];                 // 删除活动（跳过其全部出现）
  shorten?: Record<string, number>;  // 缩短时长百分比 1..99，向下取整，可为 0
  capacity?: Record<string, number>; // 覆盖容量 1..50
}
```

### replay(input, scenario, seed, round)

执行一轮事件驱动仿真，返回保留步骤的 `{ caseId, index, activity, ready, start, end }`
（按 caseId、原始下标排序）及各 case 完成时间（按 caseId 排序）。

### compare(input, scenario, seed, rounds)

执行 rounds（100..10000）轮基线与方案配对仿真，返回
`{ baseline, scenario, diff }`，各含 `mean` / `median`：
每轮 case 耗时（完成减到达）的均值/中位数，再跨轮取均值；`diff = scenario - baseline`。

## 语义要点

- 活动队列按（就绪时间, caseId ASCII 字典序）派发；步骤非抢占，占用一个工位直到结束。
- 同一时刻先处理全部完成与到达事件，再批量派发；零时长步骤在下一批同一时刻完成并级联。
- 时长抽样由 (seed, round, caseId, 原始步骤下标) 确定性决定，按样本出现次数加权，
  与容量、删除、调度及 case/样本输入顺序无关；先抽样再应用缩短。
- 各活动独立工位池，事件驱动推进时钟，compare 不保留各轮完整轨迹。
