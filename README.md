# active-learning-queue

主动学习标注队列库（TypeScript + SQLite）。调用方提供图像特征与异步训练
函数，本库负责标注状态、训练代调度与评分发布，保证异步训练期间队列查询
始终一致。

## 运行要求

- Node.js >= 23.4（`node:sqlite` 免标志；22.5+ 需 `--experimental-sqlite`）
- `npm install && npm test`（编译 TypeScript 并运行 `node --test`）

## API

```ts
import { createQueue } from "./src";

const queue = createQueue(path, images, trainer);
queue.setLabel(imageId, label);   // label: string | null（null 撤回标注）
const { generation, items } = queue.getBatch(size);
queue.close();
```

- `createQueue(path, images, trainer)`：每幅图像含唯一正整数 `id`、
  `features` 与初始 `score`（代 0，立即发布）。同步返回，不等待训练。
- `setLabel(imageId, label)`：写入定稿类别；`null` 撤回。写入相同值不算
  变更。变更入库后即返回，不等待训练。
- `getBatch(size)`：只读查询，返回当前已发布代号及该代评分下完整排序的
  前 `size` 个未标注图像，不领取图像。

每累计 20 次有效标注变更恰好启动一个训练代，代号为触发时的累计变更数。
`trainer(generation, labels, features, emit)` 收到触发时刻的只读标注快照
（之后的改标/撤回不影响它）、全部图像特征和可等待的 `emit(imageId,
score)`。

## 设计要点

- **并发模型**：`node:sqlite` 为同步驱动，所有库操作（`setLabel` /
  `getBatch` / 发布）都是同步的，不会在等待 trainer 时持有锁或事务；
  各代训练并发启动、互不排队，较旧的代可以最后完成。
- **代际发布**：trainer 的 emit 先进入该代私有的内存缓冲；trainer 成功
  返回且输出覆盖全部图像后，才在单个事务里整体替换已发布评分——且仅当
  该代高于当前已发布代。失败或半成品代的评分永远不会进入查询结果，
  评分代只前进不回退。
- **一致性**：`getBatch` 是单条 SQL 语句，天然对应某一时刻的一致快照，
  不会混合新旧评分，也不存在刷新窗口。
- **排序**：`[0.35, 0.65]` 闭区间优先，其余随后；组内 score 降序、同分
  id 升序。排序由 SQLite 表达式索引
  `((score BETWEEN 0.35 AND 0.65) DESC, score DESC, image_id ASC)` 支撑，
  `LIMIT` 直接走索引，50 万图像下单次查询亚毫秒，不截断候选池、不全量
  排序。
- **标注与评分解耦**：候选资格只看当前标注状态；撤回标注的图像按当前
  已发布代评分重新入队，迟到的旧代评分不会让它重新入队或改变顺序。

## 测试

`test/queue.test.ts` 用可显式暂停/放行的 trainer（`test/helpers.ts` 的
`TrainerRig`）确定性地覆盖：

- 代 20 与代 40 交错输出、代 40 先发布、代 20 最后完成不回退，期间校验
  两代各自的标注快照与查询结果；
- 新代输出一半后改标与撤回，随后训练抛错，旧代完整保留、候选资格正确；
- 原本排名最后的图像在完整新代中跃居首位，验证无混合评分、无候选池
  截断；
- 初始排序、无效变更不计数、非法 emit 评分使该代失败且不影响已发布代。
