# task26100802 — 主动学习标注队列

TypeScript + SQLite（`node:sqlite`，无原生依赖）实现的主动学习标注队列库。
面向单项目、单进程内异步并发：训练异步进行期间，标注与查询始终保持一致。

## 运行

```sh
npm install
npm test
```

只需要 Node.js（>= 22.5，建议 24）与 npm；`npm install` 安装 `typescript`
（唯一依赖），`npm test` 先编译到 `dist/` 再用 `node --test` 运行测试。
SQLite 使用 Node 内置的 `node:sqlite`，不需要任何外部服务。

## API

```ts
import { createQueue } from "al-label-queue";

const queue = createQueue(path, images, trainer);
```

- `createQueue(path, images, trainer)`：在 `path` 建立 SQLite 数据库。
  `images` 为 `{ id, features, score }[]`（id 为唯一正整数，score ∈ [0, 1]，属于代 0）。
- `queue.setLabel(imageId, label)`：写入定稿类别；`null` 表示撤回。
  写相同值不算变更。变更入库后即返回，不等待训练。
- `queue.getBatch(size)`：返回 `{ generation, items }` —— 当前已发布评分代号，
  以及该代完整排序下前 `size` 幅未标注图像的 `{ id, score }`。只查询，不领取。

`trainer(generation, snapshot, features, emit)` 由调用方提供：

- 每累计 20 次有效标注变更恰好启动一代，代号为触发时的累计变更数。
- `snapshot` 为只读标注快照（`get/has/size/entries()`），精确对应触发该代的
  那次变更；之后任意改标、撤回都不会影响它，即使 trainer 稍后才读取。
- `emit(scores)` 可等待，分批输出 `[imageId, score]`（score ∈ [0, 1]）。
  成功训练须对全部图像各输出一次后返回；失败通过抛错结束。

## 设计要点

- **发布语义**：`emit` 的评分先写入 `pending_scores`；trainer 成功返回后，
  若该代完整且高于当前已发布代，就在**一个事务**内把整代评分应用到
  `images.score` 并推进 `published_gen`。评分代只前进不回退；失败代只删除
  其 pending 数据，不触碰已发布状态。
- **快照**：所有有效标注变更追加进只增不改的 `label_events`（序号为累计变更
  数）。快照 = 序号截断，读取时取 `seq <= 触发序号` 的每图最新事件，因此零拷贝
  且永远精确。
- **查询**：`bucket`（score ∈ [0.35, 0.65] 为 0，否则 1）是生成列，配合部分索引
  `(bucket, score DESC, id) WHERE label IS NULL`，`getBatch` 走索引 `LIMIT`，
  不全量读取、不排序、不维护截断候选池。所有数据库操作同步执行，单线程下
  两次连续读之间不会有任何提交，因此每次 `getBatch` 等价于某一时刻的一致视图。
- **并发**：trainer 以分离的 promise 链启动，绝不串行排队；SQLite 事务只存在
  于同步代码段内，等待 trainer 期间不持有任何锁或事务。

## 布局

- `src/types.ts` — 公共类型
- `src/queue.ts` — 队列实现（建库、变更计数、训练代调度、发布）
- `src/snapshot.ts` — 基于事件日志的标注快照
- `test/queue.test.ts` — 并发/一致性测试（显式闸门控制 trainer，无 sleep 猜测）
- `types/node-shim.d.ts` — 所用 Node 内置模块的最小类型声明
