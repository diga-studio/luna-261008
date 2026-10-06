# task26100866

临床服务成本分摊库（TypeScript，纯内存计算，无接口层）。把药品、检验和护理成本单据
按部门权重一次性分摊，生成既能逐单据追溯、又能整批平衡的结果。

## 规则

- 每张单据有唯一编号、非负金额（十进制文本，精确到四位小数）及各部门整数权重，
  权重合计 10000，允许为 0。
- 理想分摊额 = 金额 × 权重 / 10000，全程以 1e-8 精度精确计算，不预先舍入。
- 每条实际分摊额只取理想额向下或向上到四位小数的值；理想额本已精确到四位小数时
  原样保留。每张单据的实际分摊合计等于原金额。
- 每个部门的实际汇总也只取理想汇总向下或向上到四位小数的值；整批金额不增不减。
- 在所有满足条件的方案中，先使最大部门绝对偏差全局最小，再使全部明细绝对偏差
  之和全局最小（通过最小费用循环流求解，保证最优）。

## 使用

```ts
import { allocateCosts } from "clinical-cost-allocation";

const result = allocateCosts({
  departments: ["A", "B", "C"],
  documents: [
    { id: "doc-1", amount: "100.0000", weights: { A: 4000, B: 4000, C: 2000 } },
  ],
});
// result.details              逐单据 × 部门明细（含理想额与实际额，保留来源单据编号）
// result.departmentSummaries  部门汇总（含理想额、实际额与偏差）
// result.totalAmount          整批总额（等于各单据金额之和）
// result.maxDepartmentDeviation 最大部门绝对偏差
```

## 开发

```sh
npm install
npm test        # vitest，含与暴力枚举对照的最优性随机测试
npm run build   # tsc 编译到 dist/
```
