# live-channel-admission

直播频道观众入场库（TypeScript）。由上层直接调用，无接口层；席位、候补与申请状态持久化在 SQLite（使用 Node.js 内置 `node:sqlite`，无原生依赖）。

## 要求

- Node.js ≥ 22.5（`node:sqlite`；推荐 ≥ 24）
- `npm install` 后 `npm test` 即可运行全部测试

## 能力

| 方法 | 说明 |
| --- | --- |
| `apply(channelId, userId, requestId)` | 申请入场。有空位且无更早候补时直接获席（保留 60 秒），否则按入队先后进入候补。 |
| `confirm(channelId, userId, requestId)` | 确认（保留→观看）或续期。每次有效调用把到期时刻更新为当前时刻 +60 秒。 |
| `leave(channelId, userId, requestId)` | 退出：结束指定申请并释放席位，候补按顺序补位。 |
| `getChannelState(channelId)` | 频道状态快照，已反映当前时刻到期的席位与相应补位。 |

## 语义要点

- 每次申请携带用户标识与频道内唯一的申请标识；一个用户在同一频道最多一个未结束申请。
- 重复提交同一申请幂等：不新增占位、不改候补顺序、不延长期限；已结束的申请不会复活，再次入场须用新标识。
- 保留与观看都占容量，总数不超过容量；存在候补时不留可分配空位。
- 当前时刻等于到期时刻即失效，不能再续期；退出或到期即结束申请并释放席位。
- 补位获得的新 60 秒自实际分配时刻起算；通过上层提供的异步接收方通知（携带申请标识），通知不早于占位生效，接收方抛错不撤销占位。
- 确认、续期、退出只作用于指定申请；旧申请的迟到操作不影响该用户后来的新席位。

## 用法

```ts
import { AdmissionService } from 'live-channel-admission';

const service = new AdmissionService({
  dbPath: 'admission.db',        // 或 ':memory:'
  capacity: 100,                 // 或 (channelId) => number，由上层预设
  notify: async (event) => {
    // 候补获席通知：event 含 channelId / userId / requestId / expiresAt
    await pushToUser(event.userId, event.requestId);
  },
  // now: () => Date.now(),      // 可注入时钟（测试用）
  // holdMs: 60_000,             // 占位时长，默认 60 秒
});

const r = await service.apply('ch-1', 'user-1', 'req-9f3');
// r.status: 'reserved' | 'queued'；r.accepted === false 表示被拒（已有未结束申请）

await service.confirm('ch-1', 'user-1', 'req-9f3');   // 确认 / 续期
await service.leave('ch-1', 'user-1', 'req-9f3');     // 退出
const state = await service.getChannelState('ch-1');  // { capacity, occupied, seats, queue }

service.close();
```

## 脚本

- `npm run build`：编译到 `dist/`
- `npm test`：编译并运行全部测试（`node:test`）
