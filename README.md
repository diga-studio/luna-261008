# audit-archive-ledger

合规审计归档库（TypeScript，无接口层，由上层直接调用）。在线审计记录存入
SQLite，超过保留窗口的历史记录归档为本地 gzip 文件；分页读取把两者合并成
同一份编号升序的账本。

## 构建与测试

```sh
npm install
npm test        # 编译 src/ 与 test/ 并运行全部测试
npm run build   # 只编译库到 dist/
```

仅依赖 Node.js（>= 22.13，使用内置 `node:sqlite` 与 `node:zlib`），
无原生模块、无外部服务。

## API

```ts
import { AuditLedger } from "audit-archive-ledger";

const ledger = AuditLedger.open({ dir: "/var/lib/audit" });

// 追加：返回严格递增、永不复用的编号；正文为 JSON 字符串，原样保存。
const id = ledger.append(Date.now(), JSON.stringify({ action: "login" }));

// 归档：把调用时已存在、事件时间严格早于 cutoffMs 的记录移入 gzip 归档，
// 从 SQLite 删除其正文。等于 cutoffMs 的记录留在线上。
const archived = ledger.archive(cutoffMs);

// 分页读取：统一覆盖在线与归档记录，编号升序，不重复、不遗漏。
let offset = 0;
for (;;) {
  const page = ledger.readPage(offset, 1000);
  // ...page.records
  if (page.nextOffset === null) break;
  offset = page.nextOffset;
}

ledger.close();
```

## 目录布局

```
<dir>/
  online.db                 SQLite（WAL + synchronous=FULL）
  archives/
    archive-000001.jsonl.gz 每行一条 JSON 记录的 gzip 文件
    archive-000002.jsonl.gz
```

## 崩溃安全设计

- **追加**：SQLite 事务提交即持久（WAL + FULL sync）。已返回的追加在任何
  后续进程退出后仍然存在；未返回的追加要么完整存在要么完全不存在。
- **归档**：先把记录写入 `*.tmp`、fsync、原子重命名为正式归档文件、
  fsync 目录，然后在一个 SQLite 事务里登记归档清单并删除在线记录。
  - 在事务提交前退出：磁盘上留下孤儿归档文件，但记录仍在线。下次
    `open()` 时恢复流程删除孤儿文件与 `*.tmp`，重试同一截止时刻即可
    重新迁移，不产生重复正文。
  - 在事务提交后退出：归档已完成。
  - 两种情况下账本都完整，任何编号只有一个版本。
- **恢复**：`open()` 是唯一的恢复入口，重新打开后的第一个业务操作面对
  的就是已恢复的完整账本。

## 测试

`npm test` 覆盖：

- 乱序/迟到/恰好等于截止时刻的记录，多次归档后分页结果与独立保留的
  原始账本完全一致，且只有严格早于截止时刻的正文被移出 SQLite；
- 归档在 6 个内部注入点被真实 SIGKILL，反复重启重试，每次恢复都能读出
  完整账本，最终归档完成且无残缺文件、无永久重复正文；
- 追加中途 SIGKILL 后已提交记录完整保留、编号不复用；
- 全部在线记录归档后重启继续追加，编号仍严格递增，新旧记录一起无重复、
  无遗漏地分页读回。
