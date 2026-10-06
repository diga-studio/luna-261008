# subtitle-align

字幕全局校时库（TypeScript）：由视频本地化编辑器调用，对一条字幕轨道做
内存内全局校时，返回调整后的时间轴与总偏移成本。

## 安装与测试

```sh
npm install
npm test
```

仅依赖 Node.js（>= 18）与开发依赖 `typescript`，无运行时依赖。

## 使用

```ts
import { alignSubtitleTrack } from "subtitle-align";

const result = alignSubtitleTrack(
  [
    { start: 1000, end: 2000, minDuration: 1000, weight: 1, locked: false },
    { start: 1500, end: 2500, minDuration: 1000, weight: 9, locked: false },
  ],
  4000
);

if (result.ok) {
  // result.segments: [{ start: 420, end: 1420 }, { start: 1500, end: 2500 }]
  // result.totalCost: 1160n（bigint，精确）
} else {
  // 约束无法同时满足：无解
}
```

## 规则

- 输入按对白顺序排列；每段含原开始/结束时刻（整数毫秒）、最低展示时长、
  权重（1..9）、锁定标记。
- 未锁定段的开始/结束可调整；不删段、不调换顺序、不改文本。
- 调整后：开始 >= 0，结束 <= 视频总时长，展示时长 >= 最低展示时长，
  后一段开始比前一段结束至少晚 80ms（`MIN_GAP_MS`）。
- 锁定段的开始与结束原样保留。
- 偏移成本 = (|开始偏移| + |结束偏移|) × 权重，全轨求和并取**全局最小**。
- 总成本相同时，按（第一段开始、第一段结束、第二段开始、…）字典序
  选择时刻更早的结果。
- 约束无法同时满足时返回 `{ ok: false }`，不放松任何约束，也不返回
  部分修复结果。

## 实现要点

把每段的（开始, 结束）排成链式变量 `x[1..2n]`，约束为
`x[j+1] - x[j] >= c[j]`（段内为最低展示时长，段间为 80ms）。代换
`y[j] = x[j] - C[j]`（C 为 c 的前缀和）后化为**加权 L1 保序回归**，
用下加权中位数 PAVA（双堆维护中位数，小堆并入大堆）求得逐分量最小、
即字典序最小的最优解；锁定段把链切成独立自由区间，区间边界转化为
上下界后对解做截断。复杂度 O(n log² n)，10 万段实测约 0.15s。

## 目录

- `src/types.ts` — 输入/输出类型
- `src/isotonic.ts` — 加权 L1 保序回归（PAVA）
- `src/align.ts` — 轨道校时主流程（建模、可行性判定、求解）
- `test/acceptance.test.js` — 验收场景
- `test/brute-force.test.js` — 与暴力 DP 的随机对拍
- `test/perf.test.js` — 10 万段性能与已知结果验证
