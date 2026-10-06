# compliance-audit-archive

合规审计归档库（TypeScript，无接口层，上层直接引用）。在线审计记录存 SQLite，
超过保留窗口的记录迁移到本地 gzip 归档段；分页读取统一覆盖在线与归档记录，
对外呈现同一份编号严格递增的账本。

## 使用

```ts
import { AuditArchive } from "./src/index.ts";

const archive = AuditArchive.open({ dir: "/var/lib/audit" });

// 追加：返回严格递增、永不复用的编号；返回即已持久化
const id = archive.append(Date.now(), { action: "login", user: "u-1" });

// 归档：把事件时间严格早于截止时刻的记录移入 gzip 段，正文从 SQLite 删除
const { archivedCount, segmentFile } = archive.archive(sevenYearCutoffMs);

// 分页：编号升序，统一覆盖在线与归档记录
let cursor = 0;
for (;;) {
  const page = archive.readPage(cursor, 1000);
  // ...page.records
  if (page.nextCursor === null) break;
  cursor = page.nextCursor;
}

archive.close();
```

## 目录布局

```
dir/
  ledger.sqlite              在线记录 + 编号计数器 + 归档段清单（WAL, synchronous=FULL）
  segments/000001.jsonl.gz   已提交的归档段（JSONL + gzip，编号升序）
  segments/*.tmp             未完成的写入，恢复时清除
```

## 崩溃恢复协议

`archive()` 的提交顺序：

1. 段内容写入 `*.tmp`，fsync 后原子 rename 为正式名（rename 即"封段"，正式名文件必定完整）；
2. 单个 SQLite 事务完成：清单登记段文件 + 删除在线表中的对应正文。

进程在任意时刻退出：

- 崩溃在 1 之前/之中：留下 `*.tmp`，恢复时删除，记录仍完整在线；
- 崩溃在 1 之后、2 之前：留下未登记的孤儿段，恢复时删除（记录仍在线，删除避免永久重复正文）；
- 崩溃在 2 之中：事务回滚，等同上一条；
- 崩溃在 2 之后：归档已生效，段文件是正文的唯一归宿。

`open()` 时先执行恢复（清理残文件、校验已提交段齐全），因此重新打开后的第一个
业务操作面对的总是完整账本。重试相同截止时刻的归档会最终迁完，且不会产生重复。

## 编号与一致性

- 编号来自 SQLite 计数器，追加与计数器自增同事务提交；即使在线记录全部归档，
  编号也持续递增、永不复用。
- 事件时间可乱序/迟到；归档按 `event_time_ms < cutoff` 选择，不依赖编号连续性。
- 恰好等于截止时刻的记录保留在线。
- 追加成功返回后，记录在任何后续进程退出与重启之后仍然存在。

## 约束

单进程串行调用；数据量 ≤ 10 万条；仅抵抗进程突然退出（不含断电、磁盘损坏、外部篡改）。

## 构建与测试

```sh
npm install
npm test        # 类型检查 + node:test（Node.js >= 24，使用内置 node:sqlite）
```

测试用独立保留的原始账本核对编号、时间与正文，覆盖：乱序/迟到/恰等于截止时刻的
多轮归档、真实进程退出后的反复重启重试、全部归档后重启继续追加等场景。
