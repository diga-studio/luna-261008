# task26100882

离线训练更正与负荷曲线模块（TypeScript 库，SQLite 持久化）。

## 需求与运行

- Node.js >= 22.5（使用内置 `node:sqlite`，无任何运行时依赖）
- `npm install` 安装唯一的开发依赖 `typescript`，然后 `npm test` 即可构建并运行全部测试
- 不需要 Docker、数据库服务或任何监听端口；持久化只用一个 SQLite 文件

```bash
npm install
npm test
```

## 领域模型

- 一个训练周期固定 52 周，每周 3 次训练，每次每个动作 3 组，目标每组 10 次；每位员工最多 20 个动作。
- 每 2 周为一段（共 26 段，每段每动作 18 组）。各动作第一段推荐 40 磅；
  仅当上一段 18 组都有记录、次数均 ≥ 10 且实际重量均 ≥ 上一段推荐重量时，下一段增加 5 磅，否则维持。
  缺记录视为不达标，各动作独立推导；更正/撤回历史组记录后，后续推荐在读取时重新推导，实际训练数据不被改写。

## API 概览

```ts
import { createTrainingModule } from './src/index.js';

const module = createTrainingModule('training.db'); // 或 ':memory:'
module.createCycle('employee-1', 20);               // 建立周期（动作数 1..20）

// 批次：内容可由上层异步逐条提供，未 commit 前不发布任何修改
const batch = module.beginBatch('employee-1', 'batch-42');
batch.add({ kind: 'upsert',  key, weightLbs: 45, reps: 10, baseVersion: 0 });
batch.add({ kind: 'withdraw', key, baseVersion: 7 });
const result = await batch.commit();                // 整批接受或整批拒绝
// result.ok === true  -> { credential, commitSeq } 唯一提交凭据
// result.ok === false -> { reason, conflicts }     不留下任何修改

// 读取视图：打开时钉住一个已提交状态，之后的新提交不会混入
const view = module.openView('employee-1');
view.commitSeq;                      // 视图对应的提交版本
view.readSegmentSets(1, 0);          // 动作 1、第 0 段的 18 组（含每组版本号）
view.readCurve();                    // 全部动作的推荐曲线 [动作][段]
view.close();
```

- `baseVersion`：每组提交所依据的版本。未录入过的组为 `0`；否则为视图返回的该组
  `version`（即最后修改它的提交序号）。提交时任一组版本已过期，整批拒绝并返回冲突组。
  不同组的并发修改互不影响，都能成功。
- 幂等重传：同一员工同一 `batchId` 以相同内容重传（即使版本已过时、组后来又被更正），
  返回首次提交的凭据，不产生新版本；同一 `batchId` 内容不同则拒绝。
- 并发：只支持单进程内并行调用。批次输入阶段不占任何锁；提交按员工串行化，
  不同员工互不影响，停顿的批次不会阻塞其他提交或新视图。
- 崩溃恢复：进程任意时刻退出后重开，未提交批次无任何影响，已提交批次的记录、
  曲线与凭据完整保留（WAL + 事务）。

## 设计要点

- **历史追加存储**：每次提交对每组改动向 `set_history` 追加一行（含 `commit_id`），
  撤回以墓碑行表示。当前状态 = 每组最新一行；钉在提交 `S` 的视图 = 每组 `commit_id <= S`
  的最新一行。因此慢速分段读取与并发提交天然隔离。
- **提交串行化**：每个员工一条 Promise 链，提交体是同步事务
  （校验版本 → 写 `commits` → 追加 `set_history`），要么整批落盘要么整体回滚。
- **幂等键**：`commits` 表 `UNIQUE(employee_id, batch_id)` + 内容哈希，
  重传命中即返回原凭据；回复丢失后重传不会产生新版本。
- **曲线推导**：纯函数 `deriveExerciseCurve`（`src/curve.ts`）从 468 个组槽位推导 26 段推荐，
  读取视图时按当时钉住的状态现算，保证记录与曲线始终属于同一份已提交结果。

## 目录结构

- `src/types.ts` — 领域常量与公开类型
- `src/curve.ts` — 推荐曲线纯函数推导
- `src/schema.ts` — SQLite 建表（cycles / commits / set_history）
- `src/engine.ts` — 批次、提交、读取视图的实现
- `src/node-shims.d.ts` — 极简 Node 类型声明（免去 `@types/node` 依赖）
- `test/` — node:test 测试：曲线规则、并发提交、视图隔离、持久化与重传、规模性能
