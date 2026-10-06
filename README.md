# training-loadcurve

离线训练更正与负荷曲线库（TypeScript + SQLite）。支持员工离线补录、教练更正历史记录，
并行批次安全合并，读取视图与推荐曲线始终来自同一份已提交状态。

## 环境要求

- Node.js >= 23.4（使用内置 `node:sqlite`，无任何原生/外部服务依赖）
- `npm install` 后 `npm test` 即可运行全部测试

## 业务规则

- 周期固定 52 周，每周 3 次训练，每次每动作 3 组，目标每组 10 次；每位员工最多 20 个动作。
- 每 2 周为一段（共 26 段）。各动作第一段推荐 40 磅；仅当上一段 18 组都有记录、
  次数均 ≥ 10 且实际重量均 ≥ 上一段推荐重量时，下一段 +5 磅，否则维持。缺记录视为不达标。
- 更正或撤回历史组记录后，后续推荐自动重新推导，实际训练数据不随之修改。

## 快速开始

```ts
import { TrainingStore } from "training-loadcurve";

const store = new TrainingStore("training.db");
await store.createCycle("emp-1", ["squat", "bench"]);

// 打开批次，异步逐条输入；输入未结束时不发布任何修改
const batch = await store.beginBatch("emp-1", "batch-2026-10-06-a");
await batch.add({
  key: { employeeId: "emp-1", exerciseId: "squat", week: 1, session: 1, set: 1 },
  baseVersion: 0,                 // 从未录入过的组以初始版本 0 为依据
  entry: { weightLbs: 40, reps: 10 },
});
const receipt = await batch.commit(); // 整批接受或整批拒绝
console.log(receipt.commitId, receipt.committedVersion);

// 撤回一组（省略 entry）；撤回也算更改，版本递增
const fix = await store.beginBatch("emp-1", "batch-2026-10-06-b");
await fix.add({
  key: { employeeId: "emp-1", exerciseId: "squat", week: 1, session: 1, set: 1 },
  baseVersion: 1,
});
await fix.commit();

// 打开读取视图：固定在打开时的已提交版本，分段读取
const reader = await store.openReader("emp-1");
for (let segment = 1; segment <= 26; segment++) {
  const view = await reader.readSegment(segment);
  for (const ex of view.exercises) {
    console.log(segment, ex.exerciseId, ex.recommendationLbs, ex.sets);
  }
}
await reader.close();

// 查询某组当前版本（用于构造后续提交的 baseVersion）
const state = await store.getSetState("emp-1", "squat", 1, 1, 1);

await store.close();
```

## 并发与一致性语义

- **组级版本冲突**：每组提交带 `baseVersion`；提交时任一组已被其他批次更改
  （含撤回），整批拒绝（`CommitRejected`，`reason: "VERSION_CONFLICT"`），不留任何修改。
  不同组的并发修改互不影响。
- **批次幂等**：同一员工同一 `batchId` 以相同内容重传，只返回首次成功提交的凭据，
  不再应用内容（即使组版本已过时、组后来又被更正）；并发重传只产生一次提交。
  相同 `batchId` 不同内容会被拒绝（`BATCH_ID_CONFLICT`）。
- **视图快照**：`openReader` 固定当前已提交版本；慢速分段读取期间的新提交不会混入，
  新打开的视图包含最新完整已提交状态。
- **不阻塞**：批次输入阶段不持有任何锁；同员工一个批次输入停顿，不影响其他批次
  提交与新视图打开。

## 持久化与崩溃恢复

- 全部已提交状态存于单个 SQLite 文件（WAL 模式，`synchronous=FULL`）。
- 未提交批次只存在于内存，进程退出后没有任何影响。
- 每次提交在单个事务内写入：组变更日志、当前状态、提交凭据，原子生效。
- 提交成功但回复丢失时，凭 `batchId` 重传即可取回原凭据，不会产生新版本。

## 脚本

- `npm run build`：编译到 `dist/`
- `npm test`：构建并运行全部测试（含 100 员工 × 20 动作 × 52 周的规模测试）
