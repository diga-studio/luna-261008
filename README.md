# PipeForge 单仓库版本保留组件

TypeScript 实现的 PipeForge 单仓库（generic）版本保留组件。每个版本只含一个文件，
二进制流式写入本地目录，元数据保存在内存中。不含鉴权与审批，晋级请求视为已获批准。

## 构建与测试

```sh
npm install
npm test        # tsc 编译后运行 node:test 测试
npm run build   # 仅编译到 dist/
```

仅依赖 Node.js（>= 20）与 devDependencies 中的 `typescript` / `@types/node`，
不需要数据库、缓存、消息队列或任何监听端口的服务。

## API

```ts
import { Repository, LocalFileStore } from "./src/index.js";

const repo = new Repository({ store: new LocalFileStore("./data") });

const handle = await repo.put("1.2.3", byteStream); // 完整写入后才发布，初始 dev
repo.promote(handle, "staging");                    // 仅允许 dev->staging->production
repo.promote(handle, "production");
const stream = repo.open(handle);                   // 异步下载流（Readable）
const retired = await repo.collect();               // 返回本次逻辑淘汰的句柄
```

## 设计要点

- **发布**：`put` 先把字节流写入临时文件（`stream/pipeline` 背压控制，单边缓冲
  远小于 4 MiB，支持 500 MiB 文件），再原子 rename 并登记元数据；同版本可见内容
  唯一，重复版本拒绝覆盖。
- **保留**：production 永久豁免且不占名额；非 production 保留 SemVer 优先级最高
  的 25 个（预发布标识参与比较，构建元数据不参与；优先级相同则较晚发布者优先）。
- **竞态**：元数据修改均为同步短操作，文件 I/O 不持锁。`collect` 选出候选后、
  逐条淘汰前会重新校验资格（非 production 且不在当时前 25），淘汰前完成的晋级
  受到保护。`onCollectCandidates` 钩子可确定性地在候选选出后暂停，用于测试交错。
- **回收**：每个上传有唯一 `fileKey`，逻辑淘汰后立即允许同版本重传（写入新文件），
  旧句柄与旧回收动作无法触及新内容。已打开的下载流通过引用计数保护，`collect`
  不等待下载结束；最后一个流关闭后物理删除自动完成，无需再次调用 `collect`。

## 目录结构

- `src/semver.ts` — SemVer 2.0.0 解析与优先级比较
- `src/storage.ts` — `FileStore` 抽象与本地目录实现（临时文件 + 原子 rename）
- `src/repository.ts` — 仓库元数据、四个操作与保留清理
- `test/` — 单元测试与确定性竞态测试（钩子/文件操作替身，无 sleep）
