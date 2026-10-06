# subtitle-retime

字幕全局校时库，供视频本地化编辑器调用。字幕数据由调用方传入，计算全部在
内存中完成，返回调整后的时间轴与总偏移成本。

## 安装与测试

```sh
npm install
npm test        # 编译 TypeScript 并运行全部测试
npm run build   # 仅编译到 dist/
```

仅需 Node.js（>= 18.17）；开发依赖（typescript、@types/node）均在
package.json 中声明。

## 用法

```ts
import { adjustTrack, CueInput } from "subtitle-retime";

const result = adjustTrack(cues, videoDurationMs);
if (result.ok) {
  // result.cues:      与输入等长、同序的 { start, end }（整数毫秒）
  // result.totalCost: 全轨加权偏移成本（全局最小）
} else {
  // 无解：约束无法同时满足（不会返回部分修复结果）
}
```

### 输入（`CueInput`）

| 字段 | 含义 |
| --- | --- |
| `start` / `end` | 原开始/结束时刻，整数毫秒，`0 <= start < end <= videoDuration` |
| `minDuration` | 译文所需的最低展示时长（毫秒） |
| `weight` | 同步重要性权重，整数 1–9 |
| `locked` | 人工确认的片段；开始与结束必须原样保留 |

第三个可选参数 `gapMs` 指定相邻字幕最小间隔，默认 80 毫秒。

## 语义保证

- 不删段、不调换顺序、不改文本；只调整未锁定段的开始/结束。
- 调整后：开始不早于 0、结束不晚于视频总长、每段展示时长不低于
  `minDuration`、相邻间隔不小于 `gapMs`、锁定段原样保留。
- 总成本 `sum(weight * (|start偏移| + |end偏移|))` 达到全局最小，
  而非逐段贪心。
- 并列最优时按（第一段开始、第一段结束、第二段开始、……）的字典序
  选择时刻更早的时间轴；结果完全确定。
- 约束无法同时满足时返回 `{ ok: false }`，不放松任何硬约束。

## 算法与复杂度

把 2n 个字幕边界看作链式变量，减去必要间距的累积量后，问题化为加权
L1 保序回归（isotonic regression），用 PAVA（Pool Adjacent Violators）
配合双堆加权中位数求解，并取逐分量最小的最优解（即字典序最早）。
锁定段作为不动点把链切成独立子问题。

- 时间：`O(n log n)`，100000 段实测约 0.1 秒（限制 5 秒）。
- 内存：`O(n)`，实测增量约 12 MiB（限制 256 MiB）。
- 支持最多 100000 段、视频总长最多 7 天；耗时与可选毫秒位置数量无关。

## 测试

- `test/adjust.test.ts`：验收用例（含 4000ms 双段、锁定段可行/无解、
  边界钳制等已知结果）。
- `test/isotonic.test.ts`、`test/adjust-random.test.ts`：与独立暴力
  DP 求解器在数万随机样例上对拍（成本最优性 + 字典序选择 + 可行性）。
- `test/perf.test.ts`：100000 段长轨道，验证已知全局最优、全部硬约束、
  耗时与内存上限。
