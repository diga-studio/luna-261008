# 绩效评分引擎

可增量更新的绩效评分引擎（TypeScript）：指标树、评价人回避、缺值重分权、单条评分贡献解释。

## 使用

```bash
npm install
npm test        # tsc 构建 + node:test 运行全部验证
npm run build   # 仅构建到 dist/
```

要求：Node.js（建议 >= 22）与 npm；无其他外部服务依赖。

## API

```ts
import { createEngine } from './src/index.js';

const engine = createEngine(template, ratings, recusedEvaluators);
engine.setRating(metricId, dimension, evaluatorId, scoreOrNull); // null 撤回
engine.setRecused(evaluatorId, recused);                         // 幂等
engine.read();              // { root }
engine.read(probe);         // { root, coefficient }
```

- `template`：树。叶子 `{ kind:'leaf', id, min, max }`，内部节点 `{ kind:'internal', id, children:[{ node, weight }] }`。实例生命周期内固定。
- 维度：`manager`/`peer`/`self`，固定权重 50/30/20；维度内未回避有效评分等权平均，缺失维度按剩余权重重新归一化。
- 内部节点只在直接子节点间聚合，缺值子节点忽略并按剩余边权重重分权；零分是有效分。
- `coefficient`：该评分归一化值在根分表达式中的系数；记录不存在或被回避时为 0。根分非 null 时全部系数之和为 1。

## 结构

- `src/types.ts` — 公共类型
- `src/engine.ts` — 增量引擎（每次更新沿祖先链 O(深度) 重算）
- `test/oracle.ts` — 独立全量计算基准
- `test/engine.test.ts` — 随机对照测试 + 回避/缺值场景测试
