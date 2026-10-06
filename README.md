# RetailPulse 区域营销内容分配库

在多个地域营销人员共用素材曝光预算、同时维持各人群组 A/B 实验比例的场景下，
生成满足全部投放约束、整体收益最高的素材分配方案。纯进程内存计算，无任何持久化与外部服务依赖。

## 安装与测试

```bash
npm install
npm test
```

仅需 Node.js（>= 18）与 npm；`typescript` 与 `@types/node` 为 devDependencies，`npm install` 后即可直接构建、测试。

## 使用

```ts
import { allocate } from "retailpulse-allocation";

const result = allocate({
  materials: [{ materialId: "M1", capacity: 1_000_000 }],
  groups: [
    {
      regionCode: "CN-EAST",
      segmentId: "young",
      demand: 1000,
      branches: [
        { branchId: 1, percent: 50 },
        { branchId: 2, percent: 50 },
      ],
    },
  ],
  allowed: [
    { materialId: "M1", regionCode: "CN-EAST", segmentId: "young", branchId: 1, profitPerImpression: 120 },
    { materialId: "M1", regionCode: "CN-EAST", segmentId: "young", branchId: 2, profitPerImpression: 80 },
  ],
});

if (result.feasible) {
  console.log(result.allocations);   // 各组合分到的曝光量（仅曝光量 > 0 的组合）
  console.log(result.branchQuotas);  // 每个分支的精确整数额度
  console.log(result.totalProfit);   // bigint，超出安全整数范围仍精确
} else {
  console.log(result.shortages);     // 无法满足额度的分支及缺口
}
```

## 规则说明

- **人群组**：由 `regionCode + segmentId` 确定，含 2–5 个实验分支；分支百分比为大于 0 的整数且合计 100。
- **额度分摊**：最大余数法——各分支先取 `floor(demand × percent / 100)`，剩余曝光按小数部分从大到小
  每个分支补一份；小数部分相同则分支编号小者优先。需求为 0 的组不分配曝光。
- **投放约束**：仅允许投放调用方给出的 (素材, 地域, 人群组, 分支) 组合；每个分支恰好获得其整数额度；
  每份素材的总分配量不超过其曝光上限（上限被所有地域、人群组、分支共同消耗）。
- **优化目标**：在满足全部约束的前提下最大化 `Σ 曝光量 × 收益分`；收益分可为负，不会因负收益而少分配。
- **不可行**：无法满足全部额度时返回 `{ feasible: false, shortages }`，不返回部分完成的计划。
- **精确性**：`totalProfit` 以 `bigint` 返回，绝对值超过 `Number.MAX_SAFE_INTEGER` 时仍无舍入误差。
- **重复组合**：同一 (素材, 人群组, 分支) 在 `allowed` 中出现多次时，按最高收益分合并。
- 输入非法（百分比合计不为 100、分支数不在 2–5、引用不存在的素材/人群组/分支等）时抛出 `Error`。

## 实现

分配问题建模为二分图上的**最小费用最大流**：

```
源 -> 素材（容量=曝光上限，费用 0）
素材 -> (人群组, 分支)（容量=分支额度，费用=-收益分，仅允许组合）
(人群组, 分支) -> 汇（容量=分支额度，费用 0）
```

求解器采用 SSP（连续最短路）+ Johnson 势能 + 二叉堆 Dijkstra，每次沿最短路推送瓶颈流量；
流量与费用在安全整数范围内用 `number` 计算，总收益用 `bigint` 精确累加。

## 规模与性能

验收规模：500 份素材、200 个人群组（200 个地域）、20000 个允许组合、总曝光需求 1000 亿。
本机实测单次计算约 1–2 秒、堆内存增量约 15 MiB（限制：30 秒 / 512 MiB）。

## 目录结构

- `src/types.ts` — 公共类型
- `src/quota.ts` — 分支额度最大余数法分摊
- `src/validate.ts` — 输入校验
- `src/minCostFlow.ts` — 最小费用流求解器
- `src/allocate.ts` — 建图、求解与结果汇总
- `test/` — 单元测试与规模/精度验收测试
