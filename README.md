# OpsCentral 调度展开库

只计算调度应当触发的时刻，不执行任何工作流。输入、输出均为 UTC 毫秒时间戳；
调度规则按规则中指定的 IANA 时区的本地日历解释（每日/每周是本地日历语义，
不是固定时长间隔）。

## 规则

每条规则包含 `timeZone`（IANA 时区名）及以下一种周期：

- `{ kind: "every-15-minutes" }`：本地分钟为 00、15、30、45 时触发。
- `{ kind: "hourly" }`：本地分钟为 00 时触发。
- `{ kind: "daily", hour, minute }`：每天在指定本地时刻触发。
- `{ kind: "weekly", weekday, hour, minute }`：每周在指定本地星期（周一=1 … 周日=7）与时刻触发。

所有触发的本地秒和毫秒均为零。时区跳转导致本地时刻不存在时跳过该次（不顺延）；
本地时刻重复时两个实际 UTC 时刻都产生触发。

## API

```ts
import { nextOccurrences, pageDue } from "opscentral-scheduler";

// 严格晚于 after 的前 limit 个触发时刻（UTC ms，递增）
nextOccurrences(rule, after, limit);

// 分页返回全部计划在左开右闭区间 (from, to] 内的触发项。
// 排序：先按 UTC 时刻，再按 scheduleId 的 UTF-16 码元顺序。
// 首次调用不传 cursor；pageSize 可在调用间改变。
const page = pageDue(schedules, from, to, pageSize, page?.nextCursor ?? undefined);
// => { items: [{ scheduleId, time }], nextCursor: string | null }
```

## 构建与测试

```sh
npm install
npm test
```

仅需 Node.js（>= 18）与 npm；时区数据来自 Node 内置的 Intl/ICU。
