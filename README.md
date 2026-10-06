# ShelfSync 馆际预约模块

由上层调用的 TypeScript 库，覆盖预约、撤销、入馆、领取四类办理；全部状态保存在 SQLite（使用 Node.js 内置 `node:sqlite`，无原生扩展、无外部服务）。

## 构建与测试

```sh
npm install   # 仅安装 typescript（devDependency）
npm test      # 编译并运行全部自动化测试
```

要求 Node.js ≥ 22.5（内置 `node:sqlite`）；不依赖 Docker、数据库服务或任何监听端口。

## API 概览

```ts
import { ShelfSync } from './src/shelfsync.js';

const lib = new ShelfSync('data.db');   // 或 ':memory:'
await lib.registerCopy(title, barcode, branch);        // 首次建立馆藏（初始在架）
const { holdId } = await lib.placeHold(title, reader, pickupBranch);
await lib.cancelHold(holdId);
await lib.checkin(credential, branch);  // 归还（借出凭据，任意分馆）或调拨到馆（调拨凭据）
const res = await lib.pickup(holdId, reader, branch); // res.loanCredential 为借出凭据
// 核对查询
await lib.getHold(holdId);   await lib.listHolds(title);
await lib.getCopy(barcode);  await lib.listCopies();
await lib.getTransfer(cred); await lib.getLoan(cred);
lib.close();
```

## 关键设计

- **状态模型**：册（`on_shelf` / `in_transit` / `checked_out`）与预约（`pending` / `bound` / `ready` / `fulfilled` / `cancelled`）分表存储，册上记录当前关联预约与当前调拨/借出凭据。
- **分配**：每笔办理结束时对受影响题名执行一轮分配（`src/allocation.ts`）。按 `queue_seq` 排队；在架空闲册可供任意分馆预约，无绑定在途册仅供其目的分馆预约；队首不兼容时跳过；选册优先级为 领取馆在架 > 运往领取馆的在途 > 他馆在架，同级按条码字典序。
- **调拨**：产生时目的分馆固定并签发不复用的调拨凭据；撤销在途预约只解除绑定，册仍沿原调拨到馆，可在途中重新绑定同目的分馆的新预约。
- **凭据**：调拨 `T-n`、借出 `L-n`，序号持久化于 `counters` 表，重启后延续、绝不复用。入馆必须对应当前那次借出/调拨；已完成或已失效的旧凭据到达时不改变任何状态。
- **并发**：所有办理同步执行并包裹在 `BEGIN IMMEDIATE` 事务中，并发调用等价于某个逐笔办理顺序；查询不会看到半完成的分配。领取与撤销竞争时，先提交者生效。
- **持久化**：正常 `close()` 后重开，预约、借出、在途状态与凭据序号全部保持一致。

## 测试

`test/` 下为 `node:test` 自动化测试，覆盖验收要求：分配优先级与队首跳过、在途撤销/重新绑定/再次调拨/旧凭据幂等、并发撤销与领取竞争、100 笔并发混合办理的一致性核对、关闭重开持久化，以及 10 分馆/1 万册/2 千未完成预约规模下 100 笔并发办理 p95 < 200ms 的性能冒烟。
