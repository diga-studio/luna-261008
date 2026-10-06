# shift-zone-utilization

班次区域利用率核算库（TypeScript + SQLite），由上层生产管理系统调用。

## 使用

```bash
npm install
npm test
```

```ts
import { UtilizationService, CheckinStatus } from "shift-zone-utilization";

const service = new UtilizationService("checkins.db"); // 或 ":memory:"

// 提交签到 / 修订（同一 eventId 只采用最大 revision）
service.submitCheckin({
  eventId: 1,
  workerId: 101,
  occurredAtMs: 1_759_600_000_000,
  status: CheckinStatus.Working,
  zone: "assembly",
  revision: 1,
});

// 查询 [start, end) 内各区域累计占用时长（人毫秒）与利用率
const rows = service.getUtilization(startMs, endMs, { assembly: 8, packing: 6 });
// rows: [{ zone, occupiedMs, capacity, utilization }]
```

## 语义

- 同一事件只采用修订号最大的版本；重复提交、较旧修订不影响结果。
- 按发生时间（而非到达顺序）解释；同一工人同一时刻只取事件编号最大者。
- 签到自发生时刻生效，至下一条有效签到或 10 分钟后结束（取较早者）。
- 可用/执行任务计入所在区域；休息/离岗不计入但终止上一条签到。
- 查询区间左闭右开；区间开始前的签到可影响区间开头。
- 利用率 = 累计占用时长 / (容量 × 区间长度)，超过 100% 照实返回。
- 提交/修订后下一次查询立即反映变化（每次查询基于 SQLite 最新数据直接计算）。

## 结构

- `src/types.ts` — 事件与结果类型、常量
- `src/store.ts` — SQLite 持久层（`node:sqlite`，无原生依赖）
- `src/engine.ts` — 占用时长核心计算
- `src/index.ts` — `UtilizationService` 对外 API
- `test/` — 场景测试与独立暴力校验器（`test/helpers.ts`）
