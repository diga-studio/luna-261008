# survey-rescoring

问卷历史响应的在线重评分组件（TypeScript + SQLite，库函数调用）。

- 三个固定数值指标，答案为 1..10 的整数；响应保存 id 与完整答案，提交后不可修改。
- 评分版本包含三个非负整数权重（和为 100）；得分 = Σ(答案 × 权重) / 100。
- 回算期间继续接收响应；新版本发布时原子切换，一次读取中的所有分数都属于同一个已发布版本。
- 较新 recalculate 一旦登记，旧的未发布任务只能返回 `"superseded"`，版本与分数不会倒退。

## 要求

- Node.js >= 23.4（使用内置 `node:sqlite`，无任何原生/外部服务依赖）。

## 使用

```ts
import { Scorer } from "./src/index.js";

const scorer = new Scorer({ weights: [50, 30, 20] }); // 版本 1 已发布；可传 dbPath 持久化
await scorer.submit("r1", [10, 8, 6]);
const result = await scorer.recalculate(2, [0, 0, 100]); // "published" | "superseded"
const { revision, scores } = await scorer.readScores(["r1"]);
scorer.close();
```

## 构建与测试

```sh
npm install
npm test        # 编译 src 与 test 后运行 node:test
npm run build   # 仅编译 src 到 dist/
```
