# task26100897

进程内通话归属组件（TypeScript，纯内存，无外部服务依赖）。

## 使用

```bash
npm install
npm test        # 编译 src + test 并运行 node:test 测试
npm run build   # 仅编译 src 到 dist/
```

## 设计要点

- `CallOwnership`（`src/call-ownership.ts`）维护 `calls: callId -> agentId` 与
  `agents: agentId -> callId` 两张映射，保证：每个未关闭通话恰有一名归属座席，
  每名座席最多持有一个未关闭通话。
- 并发控制：每个写操作声明自己涉及的资源（callId / agentId），按资源 promise 链
  串行化；资源集合不相交的操作并发执行。没有全局队列，等待 `handoff` 期间只占用
  自己的链位置，不持全局锁，因此不相关的写操作在转接暂停期间仍可完成。
- `transferCall` 在通过前置条件检查后 `await handoff(...)`，成功才提交新归属；
  抛错则归属不变。提交前不对外发布中间状态，`snapshot()` 同步读取已提交状态，
  转接确认未完成时读到的仍是完整的转接前状态。
- 三个写操作共享组件级 key 命名空间：同 key 同操作同参数的在途调用复用同一
  promise，完成后重放首次结果（含业务失败与确认失败）；同 key 不同操作或参数
  立即返回 `KEY_CONFLICT`，不覆盖原记录。重放不会重新执行或改变当前状态。

## 测试

`test/` 使用 `node:test`，通过 `ControllableHandoff`（`test/helpers.ts`）显式
控制每次确认的成功 / 失败 / 暂停时机，并用 `Promise.race` 的同步订阅语义
（`wasSettled`）确定性地断言“仍在等待”，不依赖任何 sleep。
