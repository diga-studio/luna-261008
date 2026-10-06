# al-kernel

可断点续跑的主动学习实验内核（TypeScript + SQLite，单写进程、串行调用）。

## 要求

- Node.js >= 22.13（使用内置 `node:sqlite`，无原生依赖）
- `npm install` 后 `npm test` 即可构建并运行全部测试

## API

```ts
import { openKernel } from "./src";

const kernel = openKernel("experiment.db");
const expId = kernel.createExperiment(data, seed);   // data: { seed, pool, validation }
const round = kernel.runRound(expId, "uncertainty", 1); // 或 "random"
const results = kernel.readResults(expId);
kernel.close();
```

- `createExperiment(data, seed)`：校验并持久化全部数据（含候选池隐藏真值），返回实验 ID。
  之后恢复只需实验 ID，无需重新提供数据或 seed。
- `runRound(experimentId, strategy, roundNo)`：完成或恢复指定轮次（轮号从 1 开始）。
  已提交轮次重试返回原结果，不推进；跳轮抛错。每批 32 行、不足取剩余全部、最多 20 轮、池耗尽抛 `pool exhausted`。
- `readResults(experimentId)`：返回两个策略各自的已提交轨迹（选样 ID 顺序、累计预算、验证准确率）。

## 规则实现

- 模型：本策略已提交标签（种子集 + 已提交轮次）的两类特征均值；预测取平方距离较小类，相等取 0。
- uncertainty：按 `|d0 - d1|` 升序、同分按 ID 升序选样；只用上一已提交轮的模型。
- random：以实验 seed 确定性播种（`hashSeed(seed, "random", roundNo)` + mulberry32 + Fisher-Yates），
  均匀无放回，不依赖进程内随机状态。
- 两个策略各自维护独立训练集/候选池/预算，标签互不共享；验证集只用于计分；种子不计入预算。

## 持久化与恢复

- 每轮开始选样时，先持久化选样序列与训练输入版本（`rounds` 表），再获取第一个标签。
- 每获取一个标签立即单条 UPDATE 落盘（自动提交即原子持久），恢复时跳过已取标签续取。
- 轮末在一个事务内同时发布：轮次状态、标签可见性、累计预算、验证准确率。
- 未发布轮次的标签只存在于 `rounds.labels`，不进入训练集也不出现在公开轨迹。
- SQLite 使用 WAL + `synchronous=FULL`，进程被 SIGKILL 后已提交数据不丢失。
- 恢复后不重新抽样：选样序列从数据库读取，因此任意次终止/恢复后的轨迹与不间断执行完全一致。

## 测试

`npm test` 先 `tsc` 构建再运行 `node --test`。终止恢复测试通过真实子进程 + SIGKILL 完成
（`test/child.ts` 提供仅测试用的暂停点钩子 `__testHooks`，由环境变量 `AL_HOOK` 配置）：

- 随机批次第 7 个标签落盘后 SIGKILL：验证 7 条进展仍在、公开轨迹停在上一轮、续跑与不间断执行逐轮一致；
- 篡改 oracle 验证：已持久化的 7 个标签被复用（不重新查真值），未查询真值改变不影响当前批次；
- 轮次提交后、`runRound` 返回前 SIGKILL：重试同轮返回原结果，后续选样与预算不变；
- 交换两策略执行顺序，各自完整轨迹不变。
