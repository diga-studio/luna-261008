# backup-repair

离线备份设备的完整性校验与单块修复库（TypeScript，由上层调用）。
版本清单与损坏报告存本地 JSON 文件，块正文按内容寻址（SHA-256）存本地文件，
进程在任意一步被强制终止后，重新打开仓库即可自动恢复，无需重新扫描整个仓库。

## 构建与测试

```sh
npm install
npm test        # 等价于 tsc -p tsconfig.json && node --test "dist/test/**/*.test.js"
```

只依赖 Node.js（>= 18）与开发依赖 typescript / @types/node，不需要任何数据库或常驻服务。

## 能力概览

```ts
import { BackupRepairStore } from 'backup-repair';

const store = await BackupRepairStore.open(repoDir);   // 打开并自动崩溃恢复
await store.import(manifest, initialBlocks);           // 导入固定清单与初始块（仅一次）
const report = await store.validate();                 // 完整校验，结束后原子替换报告
const result = await store.submitRepair(hash, chunks); // 提交单块修复（逐段字节）
const current = await store.getReport();               // 读取当前损坏报告
await store.close();
```

- 清单记录版本标识、按文件顺序排列的块哈希及长度；块按 4 MiB 切分，末块可更短。
- 相同哈希只有一份正文，可跨版本共享、可在同一版本内重复引用。
- 报告包含损坏块（missing / length-mismatch / hash-mismatch）及受影响版本，
  重复引用不重复计数；`damagedVersions` 为仍含损坏块的版本列表。
- 修复成功前（长度与 SHA-256 均匹配清单）不替换原块、不解除损坏记录；
  被拒绝的补传不改变块与报告；正确补传可重复提交，幂等。
- 各操作串行执行。

## 仓库目录布局

```
manifest.json    固定版本清单（导入后不变）
blocks/<hash>    块正文，按内容寻址
report.json      当前损坏报告（仅完整校验结束时原子替换）
repair.journal   修复意向日志（崩溃恢复用）
```

## 崩溃恢复设计

- 所有状态变更都走「写临时文件 → fsync → rename → 目录 fsync」，崩溃只会留下
  临时文件，重新打开时清理；目标文件要么是旧内容要么是新内容，不存在半写块。
- 修复流程：写修复日志 → 流式写入并校验块 → rename 块文件 → 更新报告 → 删日志。
  重新打开时若发现日志：块已正确（长度+SHA-256 匹配）则补交报告更新（提交）；
  否则仅删除日志（回滚）。两种收敛状态之外不会出现块与报告只更新一侧的情况。
- 恢复只按日志处理单个被中断的修复，最多读取一个块的正文（≤ 4 MiB，
  远低于 16 MiB 上限），不依赖重新执行完整校验；`store.recoveryBytesRead`
  可读取上次恢复期间读取的块正文字节数。
- 完整校验先在内存构建新报告，最后一步才原子替换 `report.json`；
  被中断的校验不会暴露半份报告，此前的完整报告保持可用。

## 测试

`test/` 下为 node:test 测试，覆盖：

- 多版本共享且重复引用的两个坏块：修好一个仅解除对应损坏，全部修好后
  按清单重组的字节与原始数据一致（`repair.test.ts`）。
- 修复数据只写一部分、块文件与报告仅一侧完成更新、返回成功后被杀等
  进程终止场景：用真实子进程 + SIGKILL 验证恢复规则与幂等重传，
  并验证单块恢复的正文读取量上限（`crash.test.ts`，崩溃点由
  `BACKUP_REPAIR_CRASH_AT` 环境变量注入）。
- 校验能力、串行性、清单合法性与各类边界（`validate.test.ts`）。
