# tunnel-availability

供上层报表任务调用的隧道可用率统计库（TypeScript + SQLite）。

## 要求

- Node.js >= 22.5（使用内置 `node:sqlite`，无原生依赖）
- `npm install` 后 `npm test` 即可运行全部测试

## 用法

```ts
import { TunnelAvailability } from 'tunnel-availability';

const stats = new TunnelAvailability('data.sqlite'); // 或 ':memory:'

// 1. 录入固定拓扑（运行期间不变）
stats.addTunnel('t1', '站点A', '站点B', 'ifaceA1', 'ifaceB1');
stats.addTunnel('t2', '站点A', '站点B', 'ifaceA1', 'ifaceB2'); // 可共享接口

// 2. 追加状态记录（可乱序、可重复；recordId 全局唯一且只生效一次）
stats.appendRecord({ recordId: 'r1', objectType: 'interface', objectId: 'ifaceA1', seq: 1, bizTime: 0, state: 'up' });
stats.appendRecord({ recordId: 'r2', objectType: 'tunnel', objectId: 't1', seq: 1, bizTime: 0, state: 'Active' });

// 3. 生成站点对报告，窗口 [start, end)，单位毫秒
const report = stats.report('站点A', '站点B', 0, 3_600_000);
// => { connectedMs, availability, ... }
```

## 语义

- 接口状态：`'up'` / `'down'`；隧道仅 `'Active'` 视为可用，其余生命周期状态均不可用。
- 首条状态记录之前对象一律不可用；状态持续到同对象下一条记录的业务时间。
- 同一对象同一毫秒有多条记录时，以 `seq` 最大者为准，与到达顺序无关。
- 隧道有效 = 自身 Active 且两端绑定接口均 up；站点对可连通 = 至少一条隧道有效，
  并行隧道重叠可用时间只计一次，共享接口故障影响所有使用它的隧道。
- 每次报告等同于把调用前已接收的全部记录按业务时间重放；迟到记录会改变历史窗口结果。

## 脚本

- `npm run build`：编译到 `dist/`
- `npm test`：构建并运行 `node:test` 测试（含逐毫秒重放的独立参考实现对照）
