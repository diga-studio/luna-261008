# hot-lead-router

Hot 线索路由库（TypeScript，进程内状态）：在满足行业与预算技能匹配的前提下，
最小化团队累计分配数的均衡值（平方和），并以可解释、可复现的轮转规则裁决平局。

## 使用

```ts
import { routeBatch, type TeamSnapshot, type Lead } from "hot-lead-router";

const snapshot: TeamSnapshot = {
  roster: [
    {
      id: "甲",
      available: true,
      skills: [{ industry: "家电", minBudgetCents: 0, maxBudgetCents: 300_00 }],
      historicalCount: 0,
    },
    // ...
  ],
  rotationStart: 0,
};

const leads: Lead[] = [
  { id: "L1", industry: "家电", budgetCents: 100_00 },
];

const { assignments, state } = routeBatch(snapshot, leads);
// state 可 JSON 序列化读出，下一批重新载入，结果与连续调用完全一致。
```

## 规则

- 候选人：当前可用，且任意一条技能命中（行业相同，预算落在 `[min, max)` 区间，单位整数美分）。
- 目标：整批最小化 `Σ(历史累计 + 本批新分配)²`，保证全局最优而非逐条贪心。
- 平局裁决：按线索输入顺序逐条比较“从当时轮转起点到分配对象的前进步数”，
  步数少者优先；每次成功分配后起点移到被选销售的下一位（末尾回首位）；
  无候选人的线索保持未分配，不改计数与起点。
- 名单顺序跨批次固定；暂时不可用不清零历史累计数。
- `routeBatch` 为纯函数：相同快照与输入必产生相同结果。

实现为精确动态规划：状态是各销售的本批新分配数向量，
同一计数向量只保留步数序列字典序最小的路径（较差前缀不可能在后续翻盘）。
批次很大时状态数随组合数增长，适合 Hot 线索的小批量实时路由。

## 构建与测试

```sh
npm install
npm test        # 编译并运行全部测试
npm run build   # 仅编译到 dist/
```

仅依赖 Node.js 与 devDependency `typescript`，无其他运行时依赖。
