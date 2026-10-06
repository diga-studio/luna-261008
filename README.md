# tiered-archive-store

档案分层存储库（TypeScript）。对象文件保存在三个本地目录（Hot / Warm / Cold，
可位于不同文件系统），对象归属、SHA-256 校验值与容量记账持久化到 SQLite
（`node:sqlite`，零原生依赖）。生命周期策略与迁移资格由调用方决定，本库只
负责存入与获准的迁移。

## 要求

- Node.js >= 22.13（`node:sqlite` 免标志可用；推荐 Node 24）
- `npm install && npm test`

## API

```ts
import { ArchiveStore } from "tiered-archive-store";

const store = ArchiveStore.open({
  dbPath: "/data/meta.sqlite",
  tiers: {
    hot:  { dir: "/fast/hot",  capacityBytes: 1_000_000 },
    warm: { dir: "/mid/warm",  capacityBytes: 5_000_000 },
    cold: { dir: "/slow/cold", capacityBytes: 9_000_000 },
  },
});

const id = await store.put("hot", asyncIterableOfChunks, totalLength);
await store.migrate(id, "cold");
const buf = await store.read(id);
const info = store.stat(id);      // { id, tier, sizeBytes, sha256 }
const usage = store.usage();      // 每层 capacity/used/reserved/available
store.close();
```

## 语义

- **容量**：按内容字节计费，每层容量初始化时固定（重开时校验一致）。
  存入按调用方声明的完整长度在接收第一个字节之前预留；恰好填满允许，
  超出 1 字节即拒绝（`CapacityExceededError`），且不留任何占用。
- **发布**：内容完整落盘（字节数与声明一致、fsync、改名就位、元数据
  事务提交）之前对象不可读；流中断或长度不符不发布对象，临时文件先
  清除再释放预留。
- **迁移**：源层持续按完整大小计费，目标层按完整大小预留；目标副本
  完整形成后先清除源副本，再提交元数据（目标预留转为正式占用，不二
  次扣费）。复制失败时源对象保持可读，目标临时内容清除后释放预留。
  迁移期间读取始终返回最初存入的逐字节内容。
- **崩溃恢复**：重新打开时自动清理中断的存入/迁移留下的预留与临时
  文件；已提交但未完成的改名/迁移会被补完；未被元数据引用的文件被
  清扫。正常结束后重开，已完成结果全部保留。

## 测试

`npm test` 覆盖：存入/迁移的容量边界（恰好填满、超出 1 字节）、流中断
与复制失败后的空间复用、迁移期间的容量预留与可读性、崩溃恢复、重开
持久化，以及结束后逐字节读回 + 各层目录实际字节与账本独立对账。
