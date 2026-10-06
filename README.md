# shift-zone-utilization

班次区域利用率核算库（TypeScript + SQLite），由上层生产管理系统调用。

## 要求

- Node.js >= 22.5（使用内置 `node:sqlite`，无任何原生/外部服务依赖）

## 构建与测试

```sh
npm install
npm test
```

## 使用

```ts
import { CheckinStatus, UtilizationLedger } from "shift-zone-utilization";

const ledger = new UtilizationLedger("data.sqlite"); // 或 ":memory:"

// 提交签到 / 修订：同一 eventId 只采用最大 revision
ledger.submitCheckin({
  eventId: 1,
  workerId: 42,
  occurredAt: 1759708800000, // 整数毫秒
  status: CheckinStatus.Working,
  zoneId: "assembly",
  revision: 0,
});

// 查询 [startMs, endMs) 内各区域累计占用时长（人·毫秒）与利用率
const results = ledger.queryUtilization(
  1759708800000,
  1759737600000,
  new Map([["assembly", 10]]), // 区域容量：正整数，统计期内固定
);
// => [{ zoneId: "assembly", occupiedMs: 123, utilization: 0.000... }]

ledger.close();
```

## 语义

- 同一事件只采用修订号最大的版本；重复提交或较旧修订不产生影响。
- 按事件最新版本的发生时间解释历史，与到达顺序无关；同一工人同一发生时刻只采用事件编号最大者。
- 签到自发生时刻生效，至该工人下一条有效签到或 10 分钟后结束（取较早者）。
- 可用 / 执行任务计入所在区域；休息 / 离岗不计入但会终止上一条签到。
- 统计区间左闭右开；利用率 = 累计占用时长 / (容量 × 区间长度)，可超过 100%，不截断。
- 每次查询依据 SQLite 中全部有效签到即时计算，提交或修订后下一次查询立即反映。

## 结构

- `src/types.ts` — 类型定义
- `src/store.ts` — SQLite 持久化（保存全部修订记录）
- `src/calculator.ts` — 有效签到解释与占用时长核算
- `src/index.ts` — `UtilizationLedger` 入口
- `test/` — 场景测试 + 与独立参考实现逐次提交对比的随机化测试
