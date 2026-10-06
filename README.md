# RetailPulse 区域营销内容分配库

在进程内存中完成素材曝光分配：满足全部人群组分支的整数额度与素材共享上限，
使总收益（曝光量 × 收益分之和）最大。无法满足全部额度时明确返回无可行方案。

## 构建与测试

```sh
npm install
npm test        # 自动先执行 tsc 构建，再运行 node:test 测试
npm run build   # 仅构建到 dist/
```

仅需 Node.js（18+）与 npm，无数据库、缓存等外部服务，不监听任何端口。

## API

```ts
import { solveAllocation } from 'retailpulse-allocation';

const result = solveAllocation({
  materials: [{ materialId: 'M1', capacity: 100 }],
  groups: [{
    groupId: 'R1|S1',
    regionCode: 'R1',
    segmentId: 'S1',
    demand: 100,
    branches: [
      { branchId: 1, percent: 50 },
      { branchId: 2, percent: 50 },
    ],
  }],
  combinations: [
    { materialId: 'M1', groupId: 'R1|S1', branchId: 1, profit: 10 },
    { materialId: 'M1', groupId: 'R1|S1', branchId: 2, profit: -3 },
  ],
});

if (result.ok) {
  result.allocations;   // [{ materialId, groupId, branchId, impressions }, ...]（仅含曝光量 > 0 的组合）
  result.totalProfit;   // bigint，精确整数，不受安全整数范围限制
} else {
  result.reason;        // 'infeasible'
}
```

- `splitBranchQuotas(demand, branches)`：最大余数法分摊。先取
  `floor(demand * percent / 100)`，剩余按小数部分从大到小每分支最多补一份，
  小数部分相同则分支编号小者优先。全程整数运算，结果精确。
- 输入非法（百分比合计不为 100、分支数不在 2-5、引用了未定义的素材/人群/分支、
  容量或需求为负等）会抛出 `TypeError` / `RangeError`。
- 同一组合重复提供收益分时，按最高收益分生效。

## 实现说明

- 分配问题建模为最小费用流：源点 → 素材（容量 = 素材上限，费用 0）→
  人群分支（容量 ∞，费用 = -收益分）→ 汇点（容量 = 分支额度，费用 0）。
  推送恰好等于总需求的流量；推不满即无可行方案。
- 求解器为 SSP（连续最短路）+ Johnson 势，支持负收益；初始势由 Bellman-Ford 计算。
- 流量/容量使用 `number`（均 ≤ 1e12 < 2^53，整数精确）；总收益用 `BigInt` 累加，
  即使超过 `Number.MAX_SAFE_INTEGER` 也无舍入误差。
- 规模验证：500 素材 × 200 人群组 × 5 分支 × 20000 组合、总需求 1e11，
  单次求解约 0.2s、堆内存增量约 5MiB（限制：30s / 512MiB）。

## 目录结构

- `src/types.ts` — 输入输出类型定义
- `src/quota.ts` — 百分比 → 整数额度分摊（最大余数法）
- `src/mincostflow.ts` — 最小费用流求解器
- `src/allocator.ts` — 输入校验、建模与主入口 `solveAllocation`
- `test/` — 自动化测试（node:test）
