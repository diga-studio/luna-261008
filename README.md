# FlowForge 增量同步组件

把持续产生的业务增量按高水位分批同步到目标，崩溃与重启后自动恢复，
保证每条来源增量恰好入账一次。纯 TypeScript 库，只依赖 Node.js 内置模块，
来源、目标、同步进度分别用本地 JSON 文件独立持久化（原子写入）。

## 使用

```ts
import { openLocalStack } from "flowforge-sync";

// 打开（或创建）一整套本地组件；重启后用同一目录即可恢复。
const { source, sink, engine } = openLocalStack("./data");

// 追加来源记录：seq 严格递增、不可变。
source.append({ seq: 1, objectId: "obj-a", delta: 10 });

// 推进同步：固定本轮来源上界，按每批 1000 条顺序提交；
// 同一未确认批次每次推进最多提交 4 次，仍无确认则返回未完成。
const result = engine.advance();
// result = { highWater, roundCompleted, batchesAcked }

// 查看进度与目标累计值。
engine.status();        // { highWater, sourceMaxSeq, round }
sink.totalOf("obj-a");  // 目标对象累计值
```

## 语义

- 一轮同步首次开始时固定来源上界；恢复时仍处理原上界，期间追加的记录
  留给下一轮。已确定的批次标识、成员及顺序永久不变。
- 接收端只按批次身份去重：同批次重投时，已入账记录不再累加，未入账部分
  补齐；完成后的重复投递返回既有确认。
- 同步水位只推进到已获得整批确认的连续来源前缀；本轮全部确认后才允许
  开始下一轮。
- 进程可在任意时刻退出：每条记录入账后即落盘，重新打开同一份数据后
  目标累计值与去重结果一致，反复推进最终完成，无需人工对账。

## 开发

```sh
npm install   # 仅安装 typescript（devDependency）
npm test      # 编译 src 与 test，并用 node:test 运行全部测试
```

## 结构

- `src/types.ts` — 公共类型（来源记录、批次、进度、推进结果等）
- `src/source.ts` — `FileSourceStore`：追加式来源存储
- `src/sink.ts` — `FileSink`：按批次去重的接收端（含故障注入钩子）
- `src/progress.ts` — `FileProgressStore`：同步进度存储
- `src/engine.ts` — `SyncEngine`：分批推进与恢复的执行器
- `test/sync.test.ts` — 崩溃恢复、尾批、确认丢失、重投等验收测试
