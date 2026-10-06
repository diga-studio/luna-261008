# forensic-timeline

本地取证时间线库（TypeScript）。每个实例对应一个案件，制品记录与查询快照持久化到 SQLite（使用 Node.js 内置 `node:sqlite`，无原生依赖、无外部服务）。库只接收已整理好的制品记录，不负责解析磁盘镜像。

## 要求

- Node.js >= 22.5（22.x 需要 `--experimental-sqlite`，测试脚本已带上；23.4+ 无需任何标志）

## 构建与测试

```sh
npm install
npm test
```

## 数据模型

- 每条制品：案件内唯一且不复用的数字编号、标签集合、M/A/C/B 四个毫秒精度 UTC 时间（`null` 表示缺失）。
- 每个非缺失时间独立生成一个事件；四个时间相同也保留四个事件；缺失时间不生成事件。
- 同一编号再次提交时整条记录替换为新版本；一个批次要么全部可见，要么全部不可见（单事务提交）。

## 用法

```ts
import { CaseTimeline } from "forensic-timeline";

const tl = new CaseTimeline("/path/to/case.db");

// 批量录入 / 修订（原子可见）
tl.submitBatch([
  { id: 1, tags: ["doc"], times: { M: 1728000000000, A: null, C: null, B: 1728000001000 } },
]);

// 首屏：建立快照（持久化，关闭重开后仍可续页）
const first = tl.queryFirstPage({ tag: "doc", pageSize: 50 });

// 续页：沿用首屏的筛选条件与证据版本，不受后续导入/修订影响
const next = tl.queryNextPage(first.snapshotId);

// 结束快照
tl.endSnapshot(first.snapshotId);

tl.close();
```

## 一致性保证

- 事件排序：时间升序 → 制品编号升序 → M、A、C、B。
- 标签过滤为完全相等匹配。
- 首屏建立快照时固定证据版本；续页始终返回该版本下的结果：后续新增、修订（包括把未展示事件移到已翻过的位置、改变标签匹配）都不会改变快照结果，不重不漏。
- 快照状态（版本、筛选条件、游标）持久化在 SQLite 中，正常关闭重开后可用快照标识继续翻页；`endSnapshot` 后彻底失效。
- 新的首屏查询反映此前所有已提交的修订。

## 实现要点

- 事件与标签以版本区间 `[version_from, version_to)` 存储，批次提交时递增全局版本号并在单事务内关闭旧区间、写入新区间。
- 快照记录证据版本与 keyset 游标 `(time, artifact_id, kind_rank)`，分页为 keyset 分页。
