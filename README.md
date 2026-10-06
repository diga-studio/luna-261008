# tunnel-availability

供上层报表任务调用的隧道可用率统计库。固定拓扑与状态历史保存在 SQLite（Node.js 内置 `node:sqlite`，无原生依赖），状态变化由上层录入。

## 要求

- Node.js >= 22.5（内置 `node:sqlite`）
- `npm install` 后 `npm test` 即可运行全部测试

## 使用

```ts
import {
  TunnelAvailabilityLibrary,
  InterfaceStatus,
  ObjectKind,
} from "tunnel-availability";

const lib = new TunnelAvailabilityLibrary("data.sqlite"); // ":memory:" 亦可

// 1. 录入固定拓扑（运行期间不变）
lib.addTunnel({
  tunnelId: "tun1",
  siteA: "A",
  siteB: "B",
  interfaceA: "ifA1",
  interfaceB: "ifB1",
});

// 2. 追加状态记录（可乱序、可重复；recordId 唯一，同对象同毫秒取 seq 最大者）
lib.addStatusRecord({
  recordId: "r1",
  objectId: "ifA1",
  objectKind: ObjectKind.Interface,
  timestampMs: 1000,
  seq: 1,
  state: InterfaceStatus.Up,
});
lib.addStatusRecord({
  recordId: "r2",
  objectId: "tun1",
  objectKind: ObjectKind.Tunnel,
  timestampMs: 1000,
  seq: 1,
  state: "Active", // 隧道仅 Active 视为可用
});

// 3. 生成报告：窗口 [start, end)，返回可连通时长与可用率
const report = lib.report("A", "B", 0, 60_000);
// => { connectedMs, availability, ... }

lib.close();
```

## 语义

- 接口状态只有 `Up` / `Down`；隧道仅 `Active` 视为可用，其余生命周期状态均不可用。
- 首条状态记录之前对象一律不可用；状态持续到同对象下一条记录的业务时间。
- 隧道有效 ⟺ 隧道自身且两端绑定接口同时可用；站点对可连通 ⟺ 其间至少一条隧道有效。
- 并行隧道重叠可用时间只计一次；共享接口故障影响所有使用它的隧道。
- 报告窗口含起点不含终点；每次报告等同于把已接收记录按业务时间重放，迟到记录会改写历史窗口的后续查询结果。

## 脚本

- `npm run build`：编译 TypeScript 到 `dist/`
- `npm test`：构建并运行 `node:test` 测试（含共享接口故障、同毫秒并行隧道接力、乱序/重复/迟到记录，以及与逐毫秒独立参考实现的随机化对拍）
