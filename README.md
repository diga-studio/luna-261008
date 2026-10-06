# forensic-timeline

本地取证时间线库（TypeScript）。每个实例对应一个案件，制品记录与查询状态持久化到 SQLite（使用 Node.js 内置 `node:sqlite`，无原生编译依赖、无外部服务）。

## 要求

- Node.js >= 22.5（提供 `node:sqlite`）

## 构建与测试

```sh
npm install
npm test
```

## 用法

```ts
import { ForensicTimeline } from 'forensic-timeline';

const timeline = new ForensicTimeline('case.db');

// 批量录入 / 修订（同编号整体替换，批次原子生效）
timeline.ingest([
  { id: 1, tags: ['disk'], mtime: 1700000000123, atime: null, ctime: null, btime: 1700000000456 },
]);

// 首屏：建立快照（可按标签过滤，完全相等匹配）
const { snapshotId, page } = timeline.openTimeline({ tag: 'disk', pageSize: 100 });

// 续页：沿用首屏的筛选条件与证据版本，不受后续修订影响；关闭重开库后仍可续页
const next = timeline.nextPage(snapshotId);

// 结束快照
timeline.closeSnapshot(snapshotId);
timeline.close();
```

## 行为约定

- 每条制品有案件内唯一且不复用的数字编号、标签集合，以及 M/A/C/B 四个毫秒精度 UTC 时间；每个非缺失时间独立生成一个事件（四个时间相同也保留四个事件），缺失时间不生成事件。
- 事件排序：时间升序 → 制品编号升序 → M、A、C、B。
- 首屏建立快照时把筛选后的完整事件序列物化到 SQLite，续页按游标读取；此后新增或修订的记录不会改变该快照的结果。新的首屏查询反映此前已提交的修订。
- 批次写入在单个事务中完成：要么全部可见，要么全部不可见。
