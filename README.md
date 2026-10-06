# task26100807

容器/VM 共享资源调度账本（内存实现），TypeScript 编写。

## 使用

```bash
npm install
npm test
```

## API

- `new ResourceLedger(capacities, { prepare, destroy })`：`capacities` 为
  `{ [node]: { cpu, memory } }`（CPU 为整数 millicore，内存为整数 MiB）；
  `prepare(item)` 异步返回资源句柄，`destroy(handle)` 保证最终成功。
- `deploy(key, items)`：整批预占后并发创建；全部成功返回 `{ ok: true }`，
  任一失败则补偿后返回 `{ ok: false, reason }`。容量不足直接拒绝，不调用
  `prepare`。同 key 同内容重试共享首次结果；同 key 不同内容抛冲突。
- `cancel(key)`：取消创建中或运行中的批次，销毁完成且额度归还后完成；
  重复取消无副作用。
- `inspect()`：返回各节点容量/占用与各批次状态（creating / running /
  compensating / failed / cancelled）。
