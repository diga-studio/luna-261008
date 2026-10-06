# LeadPulse

进程内存中的线索时效评分库（TypeScript）。销售团队可随时查询线索评分，
并解释分数来自哪些行为；行为允许迟到、乱序、重复上报；分数随时间衰减；
运营调整权重后，可按新规则重新查看任意历史时刻的分数。

## 快速开始

```bash
npm install
npm test      # 编译并运行全部自动化测试
npm run bench # 运行 200 线索 / 50 万事件规模的耗时与内存实测
```

仅依赖 Node.js 与 `devDependencies` 中的 `typescript`、`@types/node`，
不需要 Docker、数据库或任何监听端口的服务。

## API

```ts
import { LeadPulse } from "leadpulse";

const lp = new LeadPulse();

// 1. 登记线索（公司人数登记后不变）
lp.registerLead("lead-1", 320);

// 2. 接收行为事件（允许乱序；相同 id 重复投递只计一次）
lp.ingestEvent({
  id: "evt-001",
  leadId: "lead-1",
  type: "demo_request", // pricing_view | whitepaper_download | webinar_attend | demo_request
  occurredAt: 1_700_000_000_000, // unix 毫秒
});

// 3. 调整事件权重（0-100 整数，可分别调整，立即生效，含历史查询）
lp.setWeights({ demo_request: 40 });

// 4. 查询指定时刻评分（始终使用调用时最新权重）
const result = lp.scoreAt("lead-1", Date.now());
```

`scoreAt` 返回：

| 字段 | 含义 |
| --- | --- |
| `companyScore` | 公司人数固定分（不衰减）：1-50→10，51-200→20，201-1000→35，>1000→50 |
| `behaviorScore` | 全部行为衰减后的贡献合计 |
| `totalScore` | 未截断总分（`companyScore + behaviorScore`） |
| `score` | 最终分数，限制在 0-100 |
| `breakdown` | 各行为类型在三个年龄段的事件数量与贡献 |

## 计分规则

- 默认权重：`pricing_view` 15、`whitepaper_download` 10、
  `webinar_attend` 20、`demo_request` 30；同类型多次行为分别计分。
- 事件去重按稳定编号 `id`：相同编号只计一次，不同编号即使内容相同也分别计入。
- 查询时只计算已接收且 `occurredAt <= queryAt` 的事件。
- 衰减按事件年龄（`queryAt - occurredAt`，一日 = 86400000 ms）：
  不超过 30 日保留 100%；超过 30 日但不超过 90 日保留 75%；
  超过 90 日保留 40%（绝对档位，非连乘）。
- 贡献以 0.01 分为最小单位精确计算（内部以整数“百分之一分”累加，
  无浮点误差），不逐项取整；未截断总分不因最终分达到 100 而丢弃。
- 所有查询（包括查询过去时刻）均使用调用时最新权重，不维护历史规则版本。

## 设计要点

- 每条线索按行为类型各维护一个按 `occurredAt` 排序的时间戳数组，
  写入先进入小型待合并缓冲区（满 256 条或查询时归并），
  乱序写入摊销 O(log n)，查询对每个类型做 3 次二分查找，O(log n)。
- 全局 `Set` 保存已见事件编号用于去重。
- 权重只存当前一份，查询时实时计算，因此调权后任意历史时刻的
  下一次查询立即反映新规则。

## 实测（本机，Node 24）

规模：200 条线索、500,000 条事件（其中一条线索 300,000 条），
事件时间散布于 365 天历史内并随机乱序到达，另含 1% 重复投递。

| 指标 | 实测 | 预算 |
| --- | --- | --- |
| 初始装载 50 万事件 | ~540 ms | — |
| 混合负载（10,000 写入 + 20,000 查询 + 100 次调权） | ~70 ms | ≤ 5 s |
| 组件堆内存（扣除测试输入与 Node 基础开销） | ~15 MiB | ≤ 256 MiB |

运行 `npm run bench` 可复现上述实测。
