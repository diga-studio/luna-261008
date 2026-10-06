# tiered-archive-store

档案分层存储库：对象文件保存在本地目录，对象归属、SHA-256 校验值与容量记录持久化到 SQLite（Node 内置 `node:sqlite`，无任何第三方依赖）。

## 运行要求

- Node.js >= 23.6（或 22.6+ 配合 `--experimental-strip-types`，测试脚本已内置该 flag）
- `npm install && npm test`

## API

```ts
import { TieredArchiveStore } from './src/index.ts';

const store = new TieredArchiveStore({
  dbPath: '/data/meta.db',
  tiers: [
    { tier: 'hot',  dir: '/data/hot',  capacityBytes: 1_000_000 },
    { tier: 'warm', dir: '/data/warm', capacityBytes: 5_000_000 },
    { tier: 'cold', dir: '/data/cold', capacityBytes: 9_000_000 },
  ],
});

const id = await store.store('hot', buf.length, asyncIterableOfChunks); // 返回唯一编号
await store.migrate(id, 'warm');       // 迁移到指定层
const buf = await store.read(id);      // 逐字节读回
store.locate(id);                      // { id, tier, sizeBytes, sha256 }
store.capacity();                      // 各层 { capacityBytes, usedBytes, availableBytes }
store.close();
```

## 语义

- 容量按内容字节计费，初始化后不可变；恰好填满允许，超 1 字节即抛 `CapacityExceededError`，且不留任何占用。
- 存入时按声明长度立即预留目标层容量；流中断或长度不符不会发布对象，临时文件与预留一并清除。
- 迁移期间源层照常计费、目标层按完整大小预留；目标副本校验 SHA-256 通过并落盘后才切换归属，源副本删除前源容量不释放。
- 迁移全程对象可读，内容与存入时逐字节一致。
- 崩溃后重新打开：未完成的预留与临时文件自动回收，已完成的结果完整保留。
