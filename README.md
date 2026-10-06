# sentiment-alert

坐席负面情绪告警库（TypeScript + SQLite），供上层应用直接调用，无接口层。

## 要求

- Node.js >= 22.5（使用内置 `node:sqlite`，无原生依赖）

## 构建与测试

```sh
npm install
npm test        # 编译并运行全部测试
npm run build   # 仅编译到 dist/
```

## 使用

```ts
import { openDatabase, AlertService } from 'sentiment-alert';

const svc = new AlertService(openDatabase('alerts.db')); // 或 ':memory:'

// 1. 登记分段评分（businessTime 为不倒退的 UTC 业务时间，epoch 毫秒）
svc.registerSegment({ callId: 'call-1', segmentIndex: 0, score: -0.6, businessTime: Date.now() });

// 2. 确认告警
svc.confirmAlert(alertId, Date.now());

// 3. 推进业务时间（处理截至该时间的升级/静默结束事件）
svc.advanceTime(Date.now());

// 4. 读取告警状态与历史通知
svc.getAlertStatus(alertId);   // { alert, notifications }
svc.listAlerts(callId?);
svc.listNotifications(callId?);
```

## 规则摘要

- 评分 < -0.5 为负面；每路通话内连续第 3 个负面分段创建信息级（INFO）告警，
  创建时间取第三个分段登记时的业务时间；遇到 >= -0.5 的评分重新计数。
- 未确认告警创建 15 分钟后升为 WARN，30 分钟后升为 CRITICAL；确认后停止升级与通知。
- 静默窗口 UTC+8 每日 22:00（含）至次日 06:00（不含）：INFO/WARN 通知被抑制，
  CRITICAL 照常发布；静默结束时仅补发当时等级一条通知。
- 每个告警每个等级最多一条通知；重复评分、确认或时间推进均为幂等。
