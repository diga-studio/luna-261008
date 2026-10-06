# ShelfSync 馆际预约模块

TypeScript 库，由上层系统调用，状态保存在 SQLite（`node:sqlite`，无外部服务依赖）。

## 要求

- Node.js >= 22.5（使用内置 `node:sqlite` 与 `node:test`）

## 构建与测试

```sh
npm install
npm test
```

## API

```ts
import { ShelfSync } from 'shelfsync';

const lib = new ShelfSync('state.db'); // 或 ':memory:'

// 建立馆藏（首次；初始均在架）
lib.addCopy('题名', '册条码', '分馆');
lib.addCopies([{ title, barcode, branch }, ...]);

// 预约（针对题名，记录领取分馆；按接受先后排队）
const reservationId = lib.reserve('题名', '读者', '领取分馆');

// 撤销未领取预约（解除绑定；在途册仍沿原调拨到馆）
lib.cancel(reservationId);

// 领取（仅当前绑定读者、在领取分馆、册已到馆）；返回借出凭据
const loanCredential = lib.checkout(reservationId, '读者', '领取分馆');

// 入馆办理：归还借出（任意分馆）或调拨到馆（目的分馆）
// 凭据必须对应当前那次借出/调拨；已完成或未知凭据为无操作
lib.checkin(loanCredential, '分馆');

// 查询：核对预约与实物去向
lib.getReservation(reservationId); // 状态、绑定册条码、队列序号
lib.getCopy('册条码');             // 状态、所在/目的分馆、当前预约/借出/调拨凭据
lib.listQueue('题名');             // 未完成预约队列（按接受先后）
lib.getTransfer(调拨凭据);          // 调拨去向与是否到馆

lib.close();
```

## 设计要点

- **串行化**：单连接 + `BEGIN IMMEDIATE` 事务包裹每笔办理，并发发起的结果等价于某个逐笔办理顺序；查询在事务外不会看到半完成的分配。
- **分配**：每笔办理结束时，按排队顺序为未绑定预约选册——在架空闲册服务任意分馆，无绑定在途册仅服务其目的分馆；同一预约按“领取馆在架 > 运往领取馆的在途 > 外馆在架”优先级、同级按条码字典序选册；不兼容的队首可被跳过。
- **调拨**：一旦产生目的分馆固定，到馆前不可领取、不可改道；撤销在途预约只解除绑定，册仍沿原调拨到馆后重新参与分配。
- **凭据**：借出与调拨均使用一次性 UUID 凭据，入馆只对应当前未完成的借出/调拨，旧凭据重复到达为无操作。
- **持久化**：正常关闭重开后预约、借出、在途状态保持一致（SQLite 文件存储）。

## 测试

`npm test` 覆盖验收场景：跨馆优先于本馆、不兼容队首跳过、撤销在途预约后重新绑定与再次调拨、旧凭据幂等、并发撤销/领取竞争一致性、关闭重开持久化，以及 10 馆 / 10 万册 / 2 万未完成预约下 100 笔办理 p95 < 200ms 的性能检查。
