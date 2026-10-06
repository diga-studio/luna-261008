# 主动学习实验内核（可断点续跑）

TypeScript 实现，状态持久化于 SQLite（Node 内置 `node:sqlite`，零原生依赖）。
单写进程、串行调用；进程可在任意时刻被杀死，重开同一数据库后仅凭
`(experimentId, strategy, roundNo)` 即可恢复，轨迹与不间断执行完全一致。

## 要求

- Node.js >= 22.5（22.5–23.3 需 `--experimental-sqlite`，测试脚本已带）
- `npm install` 后 `npm test` 即可运行

## API

```ts
const kernel = new ExperimentKernel({ dbPath: "exp.db" });
const id = kernel.createExperiment(data, seed);        // data: { seed, pool, validation }
const r = kernel.runRound(id, "uncertainty", 1);       // 或 "random"；返回 null 表示实验结束
const results = kernel.readResults(id);                // 已提交轨迹
```

## 恢复设计

- **选样持久化**：每轮取第一个标签前，选样 ID 序列、所用模型与训练输入版本
  （已提交标签数）先落盘（`rounds` 表，`status='in_progress'`）。恢复时直接复用，
  不重新抽样。
- **逐标签持久化**：每取一个标签立即写入 `round_labels`（各自独立事务），
  恢复时从 `fetch_order` 断点继续，不重取。
- **原子发布**：轮末在同一事务中更新池可用性、轮次状态、累计预算与验证准确率。
  未发布轮次的标签不参与训练（训练查询只 join 已提交轮），也不出现在
  `readResults` 中。
- **确定性随机**：random 策略的 PRNG 由 `(实验seed, 轮号)` 派生（splitmix32），
  不依赖进程内随机状态；seed 存于库中，恢复无需调用方再提供。

## 口径

- 模型：本策略已提交标签（含种子）的两类特征均值；预测取平方距离较小者，相等取 0。
- uncertainty：按两类平方距离差绝对值升序，同分按 ID 升序。
- random：均匀无放回，每批 32，不足取剩余全部，最多 20 轮，池耗尽即结束。
- 预算：只计本策略已提交轮次的新标签，种子不计费。

## 测试

`npm test` 包含真实 SIGKILL 子进程测试：第 7 个标签落盘后杀死、发布后与返回前
杀死，重启续跑并与不间断执行逐轮比对；另覆盖真值变更不影响当前批次、策略交错
执行轨迹不变等。
