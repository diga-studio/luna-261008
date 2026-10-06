# LeadPulse 时效评分库

TypeScript 实现的进程内存线索评分库，由上层直接调用。支持登记线索、接收行为事件、调整事件权重、查询指定时刻评分四项能力，单工作区。

## 快速开始

```bash
npm install
npm test        # 构建并运行自动化测试
npm run bench   # 运行规模负载的耗时与内存实测
```

只依赖 Node.js 与 npm 中的开发依赖（typescript、@types/node），不需要任何外部服务。

## API

```ts
import { LeadPulse } from 'leadpulse';

const engine = new LeadPulse();
engine.registerLead('lead-1', 120);                 // 登记线索（公司人数不变）
engine.recordEvent({                                // 接收行为事件，乱序/重复均可
  id: 'evt-1', leadId: 'lead-1',
  occurredAt: Date.now(), type: 'demo_request',
});
engine.setWeight('demo_request', 40);               // 调整权重（0-100 整数，立即生效）
const r = engine.getScore('lead-1', Date.now());    // 查询指定时刻评分
```

- 行为类型：`pricing_view` / `whitepaper_download` / `webinar_attend` / `demo_request`，默认权重 15 / 10 / 20 / 30。
- 公司人数分：1-50 → 10，51-200 → 20，201-1000 → 35，>1000 → 50，不衰减。
- 衰减：年龄 ≤30 日保留全部，30-90 日保留 75%，>90 日保留 40%（一日 = 86400000 ms）。
- 相同事件编号只计一次；不同编号分别计入；迟到事件立即影响之后的历史查询。
- 查询结果含各类型在三个年龄段的事件数量、贡献分（精确到 0.01）、未截断总分与截断到 0-100 的最终分；所有查询使用调用时最新权重。

## 结构

- `src/types.ts` — 类型与常量
- `src/engine.ts` — 评分引擎（每线索每类型有序时间序列 + 小二分缓冲，查询按年龄段计数）
- `test/` — 自动化测试（极简内置框架，不依赖外部测试库）
- `perf/benchmark.ts` — 规模负载实测

## 实测（本机 Node v24）

200 线索、50 万初始事件（单热点线索 30 万）、跨度 365 天：

- 装载约 455 ms（约 110 万事件/秒）
- 1 万写 + 2 万查 + 100 次调权交错：约 165 ms（预算 5000 ms）
- 组件堆内存：约 +30 MiB（预算 256 MiB）
