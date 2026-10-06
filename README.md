# SignalDeck 班次播放时轴库

只回答两个问题：某瞬间某 group 的屏幕该播什么（`resolve`），以及一段时间内播放内容如何变化（`timeline`）。不做设备管理与内容编辑；配置在调用期间不可变，数据全部在内存中。

## 使用

```ts
import { resolve, timeline, type PlaybackConfig } from "signaldeck-playback-timeline";

const frame = resolve(config, "group-a", Date.now());      // { sourceId, contentId } | null
const segs = timeline(config, "group-a", fromMs, toMs);    // [{ startUtcMs, endUtcMs, frame }]
```

- 时间统一为 UTC 整数毫秒，区间左闭右开；每日窗口用本地 "HH:mm"（时区固定 America/New_York）。
- 窗口按本地日历逐日生成：回拨重复时刻起点取较早、终点取较晚；跳时不存在的时刻前移缺失时长；转换后为空的当日窗口丢弃。
- 轮播相位从窗口当日实际 UTC 起点按真实经过时长循环，被覆盖时不暂停、不重启。
- 紧急告警（优先级 5）立即覆盖普通内容，重叠时选起点较晚者（并列取 id 较小者）。

## 开发

```sh
npm install
npm test      # vitest
npm run build # tsc -> dist/
```
