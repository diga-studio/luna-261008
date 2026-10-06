# AudienceNexus

进程内分群计算库（TypeScript）：支持画像持续更新、嵌套规则分群与精确交集统计。
所有操作顺序调用，不涉及并发、持久化或故障恢复。

## 构建与测试

```sh
npm install
npm test        # tsc 编译 + node --test 运行全部测试
npm run build   # 仅编译到 dist/
```

## API

```ts
import { AudienceNexus } from "audience-nexus";

const nexus = new AudienceNexus();

// 按 userId 新增或整条替换画像；同批重复 userId 以最后一条为准
nexus.upsertBatch([
  { userId: "u1", engagementScore: 80, region: "BJ", purchaseTags: ["books"] },
]);

// 新增或替换分群定义，立即计算并保存人数
nexus.saveSegment("seg-1", {
  type: "AND",
  children: [
    { type: "SCORE", min: 60, max: 100 },
    { type: "OR", children: [{ type: "REGION", region: "BJ" }, { type: "TAG", tag: "books" }] },
  ],
});

nexus.stats("seg-1");            // { segmentId, count }
nexus.stats("seg-1", "seg-2");   // { segmentId, otherSegmentId, count, otherCount, intersection }
```

规则树：组节点仅 `AND` / `OR`，根组为第一层、最多三层，每棵树最多 16 个叶子；
叶子为分数闭区间（`SCORE`）、地区相等（`REGION`）、包含购买标签（`TAG`）。
分数或地区为 `null` 时对应叶子为假。未定义的 segmentId 调用 `stats` 会抛错。

## 设计

- **画像存储**（`src/profile-store.ts`）：userId → 稠密下标；字段列式存放；
  维护倒排索引：分数桶（0–100）、region → 用户集合、tag → 用户集合。
  `upsertBatch` 先在批内按 userId 去重（最后一条生效），再对实际变化的画像产出增量
  （分数/地区是否变化、标签增删），批内被覆盖的中间状态不会落库。
- **分群表**（`src/segments.ts`）：每个分群保存一份用户位图（`src/bitset.ts`，
  Uint32Array）与精确人数。
  - `saveSegment` 通过倒排索引把叶子直接落成位图（分数=桶并集，地区/标签=成员集合），
    组节点按 AND/OR 做位图级运算——不逐条读取画像求值。
  - `upsertBatch` 只对本批实际变化的画像做增量传播：经"叶子 → 分群"引用索引
    （分数/地区/标签）筛出可能受影响的分群，仅对这些分群重新判断该画像并翻转位图，
    不重算全部画像 × 全部关系。
  - `stats` 直接读取保存的人数；交集为两位图 AND 后 popcount，是精确值而非估计；
    分群与自身交集等于自身人数。
- 叶子全局去重（叶子注册表），单画像重判时按代际戳缓存叶子结果，重复叶子只求值一次。

## 测试

- `test/random.test.ts`：小样本随机规则/更新，对照独立逐画像求值器（`test/reference.ts`），
  持续核对全部分群人数与抽样分群对交集；含批内重复 userId、标签移除、null 替换、
  分数边界、规则替换、重复 OR 分支。
- `test/shared-rules.test.ts`：两个分群共享部分规则，一批替换同时造成进入、退出、
  留在交集的画像，验证人数与交集同步变化。
- `test/stress.test.ts`：10 万画像、2000 分群、2 万地区、5 万标签（每画像 ≤8 标签）；
  完整加载 + 保存全部分群 + 100 批 × 128 条更新 + 穿插 2000 次分群对查询；
  断言全程 < 60s、峰值 RSS < 384 MiB 并打印耗时与峰值内存；
  对可独立算出结果的宽分群（>90% 覆盖）、窄分群及其交集做精确校验。
