# FlowForge 增量同步组件

把持续产生的业务增量按高水位同步到目标的 TypeScript 库。来源记录、目标结果与
同步进度分别用本地 JSON 文件独立持久化（原子写入：临时文件 + rename），进程可在
任意时刻退出，重新打开同一份数据后自动恢复，无需人工对账。

## 构建与测试

```sh
npm install
npm test        # 等价于 tsc 编译 + node --test
```

唯一开发依赖是 `typescript`，运行时不依赖任何第三方包、数据库或服务。

## 快速上手

```ts
import { SourceStore, TargetStore, ProgressStore, LocalReceiver, SyncEngine } from "flowforge";

const source = new SourceStore("data/source.json");     // 只追加的来源
const target = new TargetStore("data/target.json");     // 目标累计值 + 批次去重账本
const progress = new ProgressStore("data/progress.json"); // 同步水位与轮次状态
const engine = new SyncEngine(source, progress, new LocalReceiver(target));

source.append("order-1", 5);          // 追加来源记录（seq 自动严格递增）
const result = engine.advance();      // 推进同步，直到追平或批次未确认
console.log(result.status, result.watermark);
console.log(engine.getProgress());    // 查看同步进度
console.log(target.getValue("order-1")); // 查看目标累计值
```

## 语义

- **轮次与批次**：一轮同步首次开始时固定来源上界，按顺序每 1000 条一批（尾批按
  实际条数）。批次标识（`r{轮次}-b{序号}`）、成员与顺序一旦确定永久不变；轮次进行
  中追加的记录留给下一轮。
- **确认与水位**：接收端只有整批入账完成才返回确认；水位只推进到已获整批确认的
  连续来源前缀。每次 `advance()` 对同一未确认批次最多提交 4 次，仍无确认则返回
  `incomplete`；再次推进或重启后继续原轮次、原批次。
- **去重**：目标只按批次身份去重。同批次重投时，已入账记录不会重复累加，未入账
  部分会被补齐；已完成批次的重复投递直接返回既有确认。不同批次分别生效。
- **崩溃恢复**：目标每入账一条记录即落盘，进度在每次状态变化后落盘，三者无共同
  提交点。重启后从各自文件恢复，最终每条来源增量恰好生效一次。

## 接收端接口

`LocalReceiver` 是真实落盘的本地接收端。如需对接其他目标，实现
`Receiver` 接口即可：`submitBatch(batch): BatchAck | null`，返回 `null` 或抛出
异常都表示本次未确认（已入账的前缀由目标持久化保留，重投时自动补齐）。
