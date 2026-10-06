# hot-lead-router

进程内 Hot 线索路由库，由上层资格系统调用。在满足技能匹配与可用性的候选人中，
按“整批均衡值最小 + 可复现轮转裁决”的规则分配线索。

## 要求

- Node.js >= 22.18（测试直接用 Node 内置运行器执行 TypeScript，无需额外测试框架）
- `npm install` 后 `npm test` 即可运行；`npm run build` 产出 `dist/`

## 用法

```ts
import { LeadRouter } from "hot-lead-router";

const router = new LeadRouter({
  reps: [
    {
      id: "甲",
      available: true,
      assignedCount: 0,
      skills: [{ industry: "tech", minBudget: 0, maxBudget: 100_00 }],
    },
  ],
  rotationStart: 0,
});

const { assignments } = router.routeBatch([
  { id: "L1", industry: "tech", budget: 50_00 },
]);

// 读出状态供下一批重新载入，结果与连续调用完全一致
const state = router.getState();
const next = new LeadRouter(state);
```

## 规则

- 技能：行业相同且预算落在 `[minBudget, maxBudget)`（整数美分）即满足该条；满足任意一条且当前可用的销售为候选人。
- 每条有候选人的线索必分配；无候选人的线索保持未分配，不影响计数与轮转起点。
- 均衡值：整批完成后 `sum((历史累计 + 本批新增)^2)`，取全局最小的完整方案（深度优先搜索 + 下界剪枝）。
- 裁决：均衡值相同按线索顺序逐条比较，从该方案当时轮转起点沿固定名单循环前进，步数更少者优先；
  每次成功分配后起点移到被选者下一位（末尾回绕）。
- 名单顺序跨批次固定；暂时不可用不清零累计数，恢复后历史数保留。
