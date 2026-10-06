# ShipCycle 发布门禁模块

TypeScript 库，数据持久化在 SQLite（Node.js 内置 `node:sqlite`，无原生依赖、无外部服务）。

## 要求

- Node.js >= 22.13（`node:sqlite` 稳定可用）

## 使用

```bash
npm install
npm test
```

```ts
import { ShipCycle } from 'shipcycle-gate';

const sc = new ShipCycle({ path: 'gate.db' }); // ':memory:' 表示纯内存

// 1. 初始化发布（至少一个组件 + 至少一个 GTM 清单项，初始 Planning）
await sc.initRelease({ releaseId: 'R1', components: ['web', 'api'], checklistItems: ['announce'] });

// 2. 批量更新门禁事实（Bug 严重度/状态、追加测试、期望状态、清单标记；整批一次生效）
await sc.applyBatch('R1', {
  bugs: [{ bugId: 'B1', componentId: 'web', severity: 'P0', status: 'Open' }],
  tests: [{ componentId: 'web', testId: 'T1', completedAt: Date.now(), passed: 96, total: 100, skipped: 2 }],
  expectedStates: [{ componentId: 'web', state: 'Ready' }],
  checklist: [{ item: 'announce', done: true }],
});

// 3. 查看门禁：可发布性、阻塞原因、依据、确认凭据
const preview = await sc.previewGate('R1');

// 4. 携带有效凭据确认发布（同一发布只能成功一次）
const result = await sc.confirmRelease('R1', preview.token!);
```

## 规则摘要

- 实际状态：存在 Open/In Progress 的 P0 Bug → `Blocked`；期望 Ready 但最新测试不达标 → `In Progress`；其余等于期望状态。自动阻塞不覆盖保存的期望。
- 最新测试：完成时间最晚者；并列取测试标识字典序最大者。通过率 = passed/total（skipped 计入分母），≥95% 达标；total=0 或无测试不达标。
- 确认凭据：预览后任何已生效批次改变了本发布的期望状态、最新测试、P0 阻塞集合或清单标记即失效（改回原值同样失效）；无关发布变更、不改变 P0 集合的普通 Bug 更新、未成为最新的迟到测试不影响。
- 确认与批次更新、预览在进程内串行生效（同步驱动 + 单事务），确认成功保存不可变门禁依据；失败不留痕迹。
