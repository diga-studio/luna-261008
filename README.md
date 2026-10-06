# task26100807

容器/VM 共享资源调度账本（TypeScript，纯内存，无外部服务）。

## 构建与测试

```sh
npm install
npm test
```

只依赖 Node.js（>= 21，`node --test` 支持 glob）；`typescript` 与 `@types/node` 在
`package.json` 的 `devDependencies` 中。

## 接口

`src/ledger.ts` 导出 `ResourceLedger`：

- `new ResourceLedger(capacities, prepare, destroy)`
  - `capacities`: `{ [node]: { cpuMillicores, memoryMiB } }`，构造时给定。
  - `prepare(item)`: 异步返回资源句柄；失败保证未创建资源。
  - `destroy(handle)`: 异步销毁，保证最终成功。
- `deploy(key, items)`: 跨节点整批预占后并发创建；全部成功返回 `{ ok: true }`；
  任一失败则整批补偿，补偿完成后返回 `{ ok: false, reason: "prepare-failed" }`；
  容量不足直接返回 `{ ok: false, reason: "insufficient-capacity" }`，不调用 `prepare`。
- `cancel(key)`: 取消创建中或运行中的批次，所有资源销毁且预占归还后才返回；
  重复取消/未知 key 无副作用；已决定的 deploy 结果不被改写。
- `inspect()`: 返回各节点容量/占用与所有批次状态
  （`creating` / `running` / `compensating` / `destroying` / `failed` / `cancelled`）。

## 语义要点

- 节点占用 = 待创建 + 创建中 + 已创建但未确认销毁的条目用量之和，两项均不超容量。
- 单项创建失败立即归还该项额度；其余额度保留到相应创建失败或销毁确认。
- 迟到的创建成功会被销毁，已取消/已失败批次不会复活。
- 同 key 同有序条目内容的重试（处理中或终结后）共享第一次 deploy 的最终结果
  （包括容量拒绝），不会重复创建；同 key 不同内容返回 `conflict` 且不影响原批次。
