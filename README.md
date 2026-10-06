# sentiment-alerting

坐席负面情绪告警模块（TypeScript 库，无接口层），状态与通知持久化到 SQLite（Node.js 内置 `node:sqlite`，无原生依赖、无外部服务）。

## 要求

- Node.js >= 22.5（使用内置 `node:sqlite` 与 `node:test`）

## 构建与测试

```bash
npm install
npm test
```

## API

```ts
import { AlertingService } from 'sentiment-alerting';

const svc = new AlertingService('state.db'); // ':memory:' 可纯内存运行

// 1. 登记分段评分（重复投递同 callId + segmentSeq 幂等）
svc.registerSegment({ callId, segmentSeq, score, businessTime });

// 2. 确认告警（停止后续升级与通知；重复确认幂等）
svc.acknowledgeAlert({ alertId, businessTime });

// 3. 推进业务时间（处理截至该时间的所有到期事件）
svc.advanceTime(businessTime);

// 4. 读取告警状态与历史通知（读取不消费）
svc.getAlerts(callId);
svc.getNotifications(callId?);

svc.close();
```

`businessTime` 为 UTC 毫秒时间戳或 `Date`，所有写操作携带的业务时间不得倒退。

## 规则摘要

- 评分严格小于 `-0.5` 为负面；每路通话内连续第 3 个负面分段创建信息级告警，继续负面不再创建，评分 >= `-0.5` 重新计数；不同负面连续段产生独立告警。
- 告警创建时间取第三个分段登记时的业务时间；未确认告警 15 分钟升警告、30 分钟升严重；确认停止升级与通知，不删除已有通知，不影响该通话之后的新告警。
- 静默窗口为 UTC+8 每日 22:00（含）至次日 06:00（不含）：信息/警告级通知在窗口内不发布，严重级照常；静默不暂停升级计时；静默结束时仍未确认的告警只补发当时等级一条，跳过被抑制的等级。
- 处理每次写操作前，先处理截至该业务时间的所有到期事件；同一时刻先升级、再处理静默结束、最后处理确认。通知记录逻辑发生时间而非补算时间。
- 每个告警每个等级最多一条通知；重复评分、确认或时间推进均幂等。
