# audit-rework-review

审计项目的返工与复核模块。作为库由上层调用，状态持久化到 SQLite（使用 Node.js 内置 `node:sqlite`，无原生依赖）。

## 要求

- Node.js >= 22.18（依赖内置 `node:sqlite` 与 TypeScript 类型剥离）
- `npm install` 后 `npm test` 即可运行全部测试

## 命令

- `npm test`：运行测试（Node 内置 test runner 直接执行 `tests/*.test.ts`）
- `npm run build`：编译库到 `dist/`
- `npm run typecheck`：对 `src/` 与 `tests/` 做类型检查

## 数据模型

每个项目初始化时提供固定的无环依赖图（`initProject`）。每个步骤有：

- `text`：底稿文本
- `version`：版本号，初始为 0
- `status`：`todo`（待办）→ `in_review`（待复核）→ `completed`（已完成）

## API

```ts
import { AuditStore } from 'audit-rework-review';

const store = new AuditStore('path/to/audit.db'); // 或 ':memory:'
store.initProject({ projectId, steps, dependencies });

await store.submit(projectId, { kind: 'submit', requestKey, stepId, expectedVersion, text? });
await store.signoff(projectId, { kind: 'signoff', requestKey, stepId, expectedVersion });
await store.rework(projectId, { kind: 'rework', requestKey, stepId, expectedVersion });
const snapshot = await store.getSnapshot(projectId);
store.close();
```

### 变更语义

- **提交复核（submit）**：仅 `todo` → `in_review`，所有直接前驱必须 `completed`；可同时更新底稿文本；成功后目标版本 +1。
- **签核（signoff）**：仅 `in_review` → `completed`，所有直接前驱必须 `completed`；成功后目标版本 +1。
- **返工（rework）**：目标步骤与全部直接/间接后继统一回到 `todo`，底稿文本保留，原签核失效；每个受影响步骤版本只 +1（与路径条数、原状态无关）；范围以外步骤完全不变。

### 结果类型

```ts
type ChangeResult =
  | { type: 'ok'; kind; affected: { stepId; version; status }[] }
  | { type: 'version_conflict'; stepId; currentVersion }   // 预期版本不符，无任何变化
  | { type: 'precondition_failed'; reason }                // 业务前提不满足，无任何变化
  | { type: 'request_key_conflict'; requestKey };          // 相同键、不同内容
```

### 幂等

- 每个变更携带项目内唯一的 `requestKey`。
- 相同键且内容相同：返回首次成功的原始结果，不再改状态，且优先于版本检查。
- 相同键但内容不同：返回 `request_key_conflict`，不执行。
- 未成功的请求不占用键，可修正后重用。

### 并发与一致性

- 所有变更在单个 SQLite 事务内同步完成（`BEGIN IMMEDIATE` … `COMMIT`），同一进程的并发调用天然串行化，结果等价于某个顺序执行。
- 快照读取是单条查询，永远对应一个完整状态。
- 不变量：任意快照中，`completed` 步骤的所有前驱都是 `completed`。
- 进程正常关闭后重开（同一数据库文件），状态与幂等键记录完整保留。
