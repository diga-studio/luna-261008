# 现场工序执行库

纯内存的 TypeScript 现场工序执行库，由上层应用直接调用，无接口层、无外部服务依赖。

## 使用

```bash
npm install
npm test        # 构建 dist/ 并运行 node:test 测试
npm run build   # 仅构建
```

```ts
import { ProcessExecution } from "field-process-execution";

const exec = new ProcessExecution(
  {
    steps: [
      { id: "preheat", kind: "wait", durationMs: 3_600_000, reminders: [1_800_000] },
      { id: "cure", kind: "wait", durationMs: 7_200_000, dependsOn: ["preheat"], requiresConfirmation: true },
      { id: "assemble", kind: "manual", dependsOn: ["cure"] },
    ],
  },
  0, // 执行开始的业务时间（整数毫秒）
);

exec.advanceTime(10_000_000);   // 推进业务时间，离线多久就跨多久
exec.confirm("cure", 10_000_000); // 现场确认（人工步骤或等待步骤的环境确认）
exec.rollback("preheat", 12_000_000); // 回退：目标及全部后继本轮失效并重新计时
const result = exec.getResult(); // 每步状态 / 计时起点 / 确认与完成时刻 / 已产生提醒
```

## 语义要点

- **解锁**：前置全部完成后解锁；无前置步骤在执行开始时刻解锁。等待步骤解锁即开始计时。
- **确认**：人工步骤确认即完成；需要环境确认的等待步骤取「计时结束」与「首次确认」中较晚者为完成时刻。未解锁不能确认，重复确认不改变任何事实。
- **提醒**：每个等待步骤最多 3 个，按本轮计时起点的偏移触发，每轮每条只产生一次，全部保留在结果历史中。
- **推进**：每次推进或现场操作前，先处理截至该时刻的全部到期提醒与自动完成；完成立即解锁后继，长等待链按依赖实际达成时刻逐段计时。
- **回退**：目标及其全部直接、间接后继的本轮完成、确认、计时失效，旧轮未到期提醒永不再出现；可立即解锁者从回退时刻重新计时。影响范围之外的步骤（计时、确认、结果）完全不变。

## 结构

- `src/types.ts` — 定义与结果视图的公共类型
- `src/definition.ts` — 工序定义校验与拓扑排序
- `src/execution.ts` — 执行引擎（事件最小堆驱动，推进无需真实等待）
- `test/execution.test.ts` — 验收场景测试
