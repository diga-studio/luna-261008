# process-execution

现场工序执行库（TypeScript，纯内存，无接口层），由上层应用直接调用。

## 构建与测试

```bash
npm install
npm test        # 编译并运行全部测试
npm run build   # 仅编译到 dist/
```

仅依赖 Node.js 与 npm（开发依赖：typescript、@types/node）。

## 使用

```ts
import { ProcessExecution } from 'process-execution';

const exec = new ProcessExecution(
  {
    steps: [
      { id: 'preheat', kind: 'wait', durationMs: 3_600_000, reminders: [1_800_000] },
      { id: 'cure', kind: 'wait', durationMs: 7_200_000, requiresConfirmation: true },
      { id: 'assemble', kind: 'manual' },
    ],
    dependencies: [
      { from: 'preheat', to: 'cure' },
      { from: 'cure', to: 'assemble' },
    ],
  },
  Date.now(), // 本次执行的开始时刻（业务时间，整数毫秒）
);

exec.advanceTime(t);      // 推进业务时间（非递减）
exec.confirm('cure', t);  // 提交现场确认
exec.revert('cure', t);   // 回退：目标及其全部后继本轮结果失效
const result = exec.getResult(); // 查看执行结果
```

## 语义要点

- 每次 `advanceTime` / `confirm` / `revert` 都先处理截至该时刻的全部到期提醒与自动完成，再处理现场操作；同一毫秒到期的事件先于该毫秒的操作。
- 等待步骤解锁即计时；`requiresConfirmation` 时需同时满足等满时长与确认，完成时刻取两者最后满足的时刻。
- 自动完成立即解锁后继；一次推进跨越整条等待链时，各步骤按依赖实际达成的时刻开始和结束。
- 提醒每轮最多产生一次；回退后旧轮未到期提醒永远不再出现，已产生的保留为历史（`round` 区分轮次）。
- 回退只影响目标及其直接、间接后继；影响范围之外的完成结果、确认事实、计时起点与提醒完全不变。
- `getResult()` 中每个步骤可辨认 `locked` / `unlocked` / `completed`，并给出 `waitStartedAt`、`completedAt`、`confirmedAt` 与全部已产生提醒。
