# live-channel-admission

直播频道观众入场库（TypeScript），由上层直接调用，无接口层。席位、候补与申请状态持久化在 SQLite（Node 内置 `node:sqlite`，无需外部服务）。

## 要求

- Node.js ≥ 22.5（22.5–23.3 需加 `--experimental-sqlite`；≥ 23.4 开箱即用，推荐 Node 24）
- `npm install && npm test`

## 能力

- `apply(channelId, userId, requestId)` 申请入场：有空位且无更早候补则直接获席（保留 60 秒），否则入候补。
- `confirm(channelId, userId, requestId)` 确认（保留 → 观看）或续期（观看中延长 60 秒）。
- `leave(channelId, userId, requestId)` 退出并释放席位，按入队先后补位。
- `status(channelId)` 频道状态快照，先按当前时刻结算到期与补位再返回。

## 规则要点

- 每次申请携带用户标识与频道内唯一的申请标识；重复提交幂等（不新增占位、不改候补顺序、不延长期限）；已结束申请不复活，再入场须用新标识。
- 一个用户在同一频道最多一个未结束申请。
- 保留与观看都占容量；每次有效确认/续期把到期时刻设为当前时刻 + 60 秒；当前时刻等于到期时刻即失效。
- 补位的 60 秒从实际分配时刻起算；补位通知通过上层提供的异步接收方发出，通知失败不撤销占位。

## 用法

```ts
import { ChannelAdmission } from 'live-channel-admission';

const admission = new ChannelAdmission({
  dbPath: 'state.db',          // 或 ':memory:'
  capacity: 100,               // 或 (channelId) => number
  notifier: async ({ channelId, requestId, userId }) => {
    // 上层推送“候补已获席”通知
  },
});

const r = await admission.apply('ch-1', 'user-9', 'req-abc');
```

## 脚本

- `npm run build` 编译到 `dist/`
- `npm test` 编译并运行 `node --test`
