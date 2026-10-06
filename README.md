# survey-rescorer

问卷 问卷历史响应的在线重评分组件（TypeScript + SQLite，库函数调用）。

## 要求

- Node.js >= 22.5（使用内置 `node:sqlite`，无需原生编译与外部服务）

## 使用

```bash
npm install
npm test
```

## API

```ts
import { Scorer } from "./src/scorer.js";

const scorer = new Scorer({ initialWeights: [50, 30, 20] }); // 版本1随初始化发布

await scorer.submit("r1", [10, 8, 6]);            // 保存响应，返回即完成
const done = scorer.recalculate(2, [0, 0, 100]); // 登记版本2并回算，回算期间照常接收 submit
const result = await done;                        // "published" | "superseded"
const { revision, scores } = await scorer.readScores(["r1"]);
```

- `submit(id, answers)`：answers 为 3 个 1–10 的整数；提交后不可修改。
- `recalculate(revision, weights)`：weights 为 3 个和为 100 的非负整数；
  `revision` 可省略（按登记顺序自动递增），提供时必须大于已登记的最大版本号。
- `readScores(ids)`：返回当前已发布版本及所请求响应在该版本下的分数；
  一次读取中的所有分数属于同一个已发布版本。

## 并发与原子性设计

- 所有写操作（submit、批次回算、发布）都在 SQLite 事务中完成；
  发布检查（无遗漏响应、无更新版本登记）与发布指针切换在同一事务中原子执行。
- 回算循环直到“无遗漏响应”检查与发布在同一事务中通过才结束，
  因此发布前完成的 submit（包括回算期间新增的）必然已有新版本分数。
- 新版本登记即更新 `latest_revision`；旧任务发布时发现 `latest_revision > 自身`
  则返回 `"superseded"`，不会回退发布指针，也只写自己版本的分数行。
