# press-wait-queue

供生产排程看板调用的印机等待队列库（TypeScript，纯进程内存，无接口层）。

## 能力

- 加入等待作业、修改作业的印机/优先级/加工量、撤出等待作业
- 查询任一作业的排队位置、预计开始时刻与完成时刻（整数秒）
- 每台印机固定每小时产能与最早空闲时刻；从最早空闲时刻起连续加工，不留空档
- 优先级 1-5，数字越小越靠前；同级按进入当前印机队列的先后排列
- 修改优先级或加工量保留原入队先后；改派他机视为在新印机重新入队
- 单作业耗时 = ceil(上机张数 × 加工档倍数 × 3600 / 每小时产能)，逐作业取整后再累加
  （加工档：普通 1 倍 `normal`、覆膜 1.5 倍 `lamination`、模切 2 倍 `diecut`）

## 用法

```ts
import { Scheduler } from './src';

const scheduler = new Scheduler([
  { id: 'P1', sheetsPerHour: 3600, availableAt: 1_700_000_000 },
  { id: 'P2', sheetsPerHour: 7200, availableAt: 1_700_000_300 },
]);

scheduler.addJob({ id: 'J1', machineId: 'P1', priority: 2, sheets: 3600, grade: 'normal' });
scheduler.updateJob('J1', { priority: 1 });                 // 提升优先级，保留入队先后
scheduler.updateJob('J1', { machineId: 'P2' });             // 改派，在 P2 重新入队
scheduler.removeJob('J1');

const status = scheduler.query('J1');
// { id, machineId, position, startAt, finishAt }
```

## 实现

每台印机一棵 treap（`src/treap.ts`）：BST 键为 `(优先级, 入队序号)`，子树维护
作业数与耗时和。插入、删除、排名、前缀耗时均为 O(log n)，变更后查询立即反映新队列。

## 测试

```sh
npm install
npm test
```

覆盖：急单插入后撤出（原作业先推迟再恢复、最早空闲时刻不变）、优先级反复调整与
跨印机改派（同级先后规则与两条队列工期）、逐作业取整累计差异、随机操作与独立参照
全量比对，以及 16 台印机 / 10 万作业下 5 万次变更 + 5 万次查询的耗时与内存
（含 80% 作业集中一台印机、变更集中队首、查询集中队尾的场景）。
