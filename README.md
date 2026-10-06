# signaldeck-schedule

SignalDeck 班次播放时轴库：给定不可变配置，回答“某块屏幕此刻该播什么”
以及“一段时间内播放内容如何变化”。不做设备管理，不做内容编辑。

## 接口

```ts
import { resolve, timeline } from "signaldeck-schedule";

resolve(config, group, tUtc);            // -> { sourceId, contentId } | null
timeline(config, group, fromUtc, toUtc); // -> Segment[]（无空洞、无重叠、相邻同 frame 已合并）
```

- 时间统一为 UTC 整数毫秒，区间左闭右开。
- 每日班次窗口用 America/New_York 本地 "HH:mm" 描述，按当地日历逐日生成；
  夏令时回拨起点取较早瞬间、终点取较晚瞬间，春季跳时的不存在时刻向前
  移动缺失时长；转换后终点不晚于起点的当日窗口为空。
- 同组窗口取 priority 最高者，并列取 id 字典序最小者；紧急告警（优先级 5）
  立即覆盖，重叠告警取起点较晚者，再并列取 id 最小者。
- 轮播相位从窗口当日实际 UTC 起点按真实经过时长累计，被覆盖时不暂停。

## 开发

```sh
npm install
npm test     # tsc 编译 + node:test
npm run build
```

代码结构：`src/timezone.ts`（纽约时区换算，按美国 DST 规则实现，不用固定
偏移）、`src/windows.ts`（逐日窗口实例化与轮播相位）、`src/schedule.ts`
（resolve / 事件驱动的 timeline 扫描）。
