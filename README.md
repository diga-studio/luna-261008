# press-wait-queue

供生产排程看板调用的印机等待队列库（TypeScript）。数据只保存在进程内存中，无接口层、无外部依赖。

## 安装与测试

```sh
npm install
npm test
```

`npm test` 编译 `src/` 与 `test/` 后用 Node 内置测试运行器执行全部功能与性能测试。

## 用法

```ts
import { SchedulingEngine } from 'press-wait-queue';

const engine = new SchedulingEngine([
  { id: 'P1', sheetsPerHour: 3600, availableFrom: 1_000 },
  { id: 'P2', sheetsPerHour: 1800, availableFrom: 5_000 },
]);

engine.addJob('JOB-1', 'P1', 3, 1000, 'normal');      // 加入等待作业
engine.updateJob('JOB-1', { priority: 1 });           // 调整优先级（保留入队先后）
engine.updateJob('JOB-1', { machineId: 'P2' });       // 改派（在新印机重新入队）
engine.updateJob('JOB-1', { sheets: 2000, grade: 'diecut' }); // 修改加工量
engine.removeJob('JOB-1');                            // 撤出等待作业

const q = engine.queryJob('JOB-1');
// { position, startAt, completeAt, duration, machineId }
```

## 业务规则

- 优先级 1–5，数字越小越靠前；同级按进入当前印机队列的先后排列。
- 修改优先级或加工量保留原入队先后；只有改派到不同印机才重新入队。
- 加工档：`normal` 1 倍、`lamination` 1.5 倍、`diecut` 2 倍。
- 单作业耗时 = `ceil(上机张数 × 加工倍数 × 3600 / 每小时产能)` 秒，逐作业取整后再累加。
- 每台印机从 `availableFrom` 起连续加工，中间不留空档；正在生产的作业不进入等待队列。

## 设计

- 每台印机一棵 Treap（有序统计树），键为 `(priority, seq)`，子树维护作业数与耗时和。
- 加入 / 修改 / 撤出 / 查询均为 `O(log n)`；查询位置与预计时刻通过前缀统计一次完成。
- 上限：16 台印机、10 万个等待作业；耗时与时刻用整数秒表示（在约束规模下精确不溢出）。

## 目录

- `src/types.ts` — 公开类型与常量
- `src/treap.ts` — 有序统计树
- `src/engine.ts` — `SchedulingEngine`
- `test/engine.test.ts` — 功能测试（含与独立参照的随机对照）
- `test/reference.ts` — 按业务规则从头计算的独立参照实现
- `test/perf.test.ts` — 5 万次变更 + 5 万次查询的耗时与内存测试（80% 作业集中单机）
