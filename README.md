# audit-rework-review

审计项目的返工与复核模块。以库的形式被上层调用，状态持久化到 SQLite（Node 内置 `node:sqlite`，零运行时依赖）。

## 环境要求

- Node.js >= 22.13（`node:sqlite` 内置模块，推荐 Node 24）
- 安装与测试：`npm install && npm test`（仅开发依赖 typescript / @types/node）

## API

```ts
import { AuditModule } from 'audit-rework-review';

const m = new AuditModule('data/audit.db');
m.initProject({
  projectId: 'p1',
  steps: [{ id: 'A', text: '底稿A' }, { id: 'B' }],
  edges: [['A', 'B']],          // [前驱, 后继]，必须无环
});

m.submitReview('p1', { requestKey: 'k1', stepId: 'A', expectedVersion: 0, text: '新底稿' });
m.signOff('p1',      { requestKey: 'k2', stepId: 'A', expectedVersion: 1 });
m.rework('p1',       { requestKey: 'k3', stepId: 'A', expectedVersion: 2 });
const snap = m.getSnapshot('p1');
m.close();
```

- 步骤状态：`todo`（待办）→ `pending_review`（待复核）→ `done`（已完成）；初始版本 0、状态待办。
- 提交复核：仅 `todo` 可进入，所有直接前驱必须 `done`；可同时更新底稿文本；成功版本 +1。
- 签核：仅 `pending_review` 可进入，前驱全部 `done`；成功版本 +1。
- 返工：任意状态可发起；目标与全部直接/间接后继回到 `todo`，文本保留，版本各 +1（多通路共享后继只加一次）；范围外步骤不变。
- 三类变更均携带 `expectedVersion` 与项目内唯一 `requestKey`。

## 返回结果（调用方可区分三类结果）

```ts
type MutationResult =
  | { kind: 'ok'; affected: StepSnapshot[] }                 // 成功，含受影响步骤最新状态
  | { kind: 'version_conflict'; stepId; currentVersion }     // 预期版本不符，无任何变化
  | { kind: 'precondition_failed'; stepId; reason }          // 业务前提不满足，无任何变化
  | { kind: 'request_key_conflict'; requestKey };            // 同键不同内容，拒绝执行
```

幂等规则：相同键且内容相同成功请求的重放返回原结果、不重复改状态，且优先于版本检查；未成功的请求不占用键，可同键重试。

## 并发与一致性

- 单进程内所有变更为同步执行 + SQLite 事务（`BEGIN IMMEDIATE`），天然等价于某个串行顺序；32 个并发调用安全。
- 一次返工的版本变化、状态变化与请求记录在同一事务内提交，失败整体回滚，不留局部变化。
- 快照读取对应一个完整状态；任意快照中已完成步骤的所有前驱均已完成后才可签核，不变量由前置检查与返工级联共同保证。
- 正常关闭后重开，步骤状态与请求记录全部保留，重放仍返回原结果。

## 测试

`npm test` 覆盖：多层菱形依赖返工（共享后继只加一次版本、不相干支线不变）、上游返工与下游签核并发、返工后旧版本签核拒绝、成功请求在项目变化及重开后的重放、随机操作序列下与独立参考模型逐步对比、10000 步骤 / 50000 依赖规模冒烟。
