# task26100806

CraftBridge 人才推荐组件（TypeScript 库，进程内存储，无持久化）。

## 构建与测试

```sh
npm install
npm test
```

唯一开发依赖是 `typescript`；测试使用 Node 内置 `node:test`，无需其他服务。

## API

```ts
import { TalentRecommender } from "craftbridge-talent-recommender";

const engine = new TalentRecommender();
engine.loadTalents(talents);      // 整批装载（替换全部人才）
engine.replaceTalent(talent);     // 按编号替换一名人才
engine.setRules(rules);           // 调整全局匹配规则
const ids = engine.recommend(project); // 推荐最多 20 人，按总分降序
```

- `Talent`：正整数 `id`、非空专业标签集合 `tags`（illustrator / animator /
  photographer / ux-designer）、`quality`（0–500，平均星级×100，无评价为 0）、
  `hourlyRate`（1–100000 美分）、`available`、`experienceYears`（0–40）。
- `Project`：非空 `tags`、`budgetMin`/`budgetMax`（1–100000 美分，下限≤上限）、
  `allowList`（豁免质量门槛）、`blockList`（无条件排除，优先于允许名单）。
- `MatchRules`：五项非负整数权重（合计 100）与 `minQuality` 质量门槛。

评分：标签交并比、质量/500、预算适配度 min(1, 时薪/下限, 上限/时薪)、
可接单 0/1、min(工龄,20)/20；每项乘 10000 向下取整（BigInt 精确整数运算，
不受浮点误差影响）后乘权重求和。入选要求与项目有共同标签且达到质量门槛
（允许名单仅豁免门槛）。同分按编号升序，不足 20 人返回全部合格者。
每次推荐都基于当前人才池与规则实时计算，修改立即生效。
