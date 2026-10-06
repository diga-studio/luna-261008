# task26100897

进程内通话归属组件（TypeScript，纯内存，无外部服务依赖）。

## 运行

```sh
npm install
npm test
```

`npm run build` 仅编译（输出到 `dist/`）。

## 结构

- `src/types.ts` — 公开类型：操作结果、快照、`HandoffFn`、`KeyConflictError`。
- `src/call-ownership.ts` — `CallOwnershipService`，实现 `openCall` / `transferCall` / `closeCall` / `snapshot`。
- `test/` — 基于 `node:test` 的测试；`test/helpers.ts` 提供可暂停/成功/失败的受控 `handoff`。

## 设计要点

- **状态**：`calls`（callId → 归属座席）与 `agentCall`（座席 → callId）两张内存表，snapshot 同步读取，保证两份数据一致；转接确认未完成时读到的是完整的转接前状态。
- **并发**：每个写操作声明其资源集（通话、源/目标座席），按资源链接到该资源当前末尾的 Promise 之后执行。等待边总是从后注册的操作指向先注册的操作，构成无环图，无死锁；不共享资源的操作（如无关的 C→D 转接）互不阻塞，无需全局队列或全局锁。等待 `handoff` 期间只阻塞共享资源的操作。
- **转接**：前置条件（归属、目标空闲、非自转）在执行轮到该操作时按已提交状态检查；通过后 `await handoff(...)`，成功才同步提交新归属，抛错返回 `HANDOFF_FAILED` 且归属不变。不存在"先发布后补偿"。
- **幂等键**：组件级命名空间，记录 `{操作+参数指纹, 结果Promise}`。同 key 同参数的在途调用共享同一 Promise，完成后重放原结果（含业务失败与确认失败），不重新执行、不重查前置条件；同 key 不同操作或参数同步抛出 `KeyConflictError`。
- **callId**：单调递增序号，唯一且永不复用。
