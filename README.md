# perf-scoring-engine

可增量更新的绩效评分引擎（TypeScript，零运行时依赖）。

## 规则

- 模板是一棵树：节点 ID 唯一，边权重为正；叶子定义原始分上下界，线性归一化到 0–100。
- 评分按（叶子指标, 维度, 评价人）唯一。维度 `manager`/`peer`/`self` 权重固定 50/30/20。
- 叶子内：每个维度先对未回避评价人的有效评分等权平均；缺失维度不参与，剩余维度按权重重新归一化；三维度全缺则叶子缺值。
- 内部节点只在直接子节点间聚合：忽略缺值子节点，按剩余边权重重新归一化；全部缺值则该节点缺值。零分是有效分数。
- 模板在实例生命周期内固定。

## API

```ts
import { createEngine } from './src/engine';

const engine = createEngine(template, ratings, recusedEvaluators);
engine.setRating(metricId, dimension, evaluatorId, scoreOrNull); // null 撤回；被回避者的评分也保存
engine.setRecused(evaluatorId, recused);                         // 幂等；取消回避后用其最新评分
engine.read(probe?);                                             // { rootScore, coefficient? }
```

- `rootScore`：当前根分数，无有效评分时为 `null`。
- `probe = { metricId, dimension, evaluatorId }` 时返回 `coefficient`：该记录归一化分数在当前聚合表达式中所乘的因子；记录不存在或被回避时为 0。根分数非 null 时，全部有效系数之和为 1，且 `Σ coefficient × 归一化分数 = rootScore`。

## 开发

```sh
npm install
npm test   # 构建 + 运行全部测试（node:test）
```

- `src/types.ts` — 公开类型
- `src/engine.ts` — 增量引擎（只沿变更叶子的祖先链重算，系数按需沿路径求积）
- `test/helpers.js` — 独立全量参考实现（测试对照用）
- `test/random.test.js` — 随机修改 vs 全量重算：根分数、全部贡献系数、系数和
- `test/recusal.test.js` — 回避导致子树缺值、回避期间改分、取消回避
