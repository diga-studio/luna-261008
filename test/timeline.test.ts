import assert from "node:assert/strict";
import test from "node:test";
import { CaseTimeline } from "../src/index.js";
import type { TimelineEvent } from "../src/index.js";
import { applyBatches, computeTimeline, tempDbPath } from "./helpers.js";

function collectAll(tl: CaseTimeline, snapshotId: string, first: TimelineEvent[]): TimelineEvent[] {
  const all = [...first];
  let page = tl.queryNextPage(snapshotId);
  while (true) {
    all.push(...page.events);
    if (!page.hasMore) break;
    page = tl.queryNextPage(snapshotId);
  }
  return all;
}

test("相同 MACB 时间与缺失时间：整段时间线与独立全量计算一致", () => {
  const { dbPath, cleanup } = tempDbPath();
  try {
    const tl = new CaseTimeline(dbPath);
    // 四个时间完全相同：必须保留四个事件
    // 部分缺失：缺失时间不生成事件
    // 全部缺失：不生成任何事件
    tl.submitBatch([
      { id: 1, tags: ["doc"], times: { M: 1000, A: 1000, C: 1000, B: 1000 } },
      { id: 2, tags: ["img", "doc"], times: { M: null, A: 500, C: null, B: 500 } },
      { id: 3, tags: [], times: { M: null, A: null, C: null, B: null } },
      { id: 4, tags: ["doc"], times: { M: 500, A: null, C: 2000, B: null } },
    ]);

    const expected = computeTimeline(
      applyBatches([
        [
          { id: 1, tags: ["doc"], times: { M: 1000, A: 1000, C: 1000, B: 1000 } },
          { id: 2, tags: ["img", "doc"], times: { M: null, A: 500, C: null, B: 500 } },
          { id: 3, tags: [], times: { M: null, A: null, C: null, B: null } },
          { id: 4, tags: ["doc"], times: { M: 500, A: null, C: 2000, B: null } },
        ],
      ])
    );
    assert.equal(expected.length, 8); // 4 + 2 + 0 + 2

    // 单页全量
    const single = tl.queryFirstPage({ pageSize: 1000 });
    assert.equal(single.hasMore, false);
    assert.deepEqual(single.events, expected);

    // 每页一条逐页拼接
    const paged = tl.queryFirstPage({ pageSize: 1 });
    assert.equal(paged.hasMore, true);
    const all = collectAll(tl, paged.snapshotId, paged.events);
    assert.deepEqual(all, expected);

    // 相同时间按制品编号、再按 M/A/C/B 排序
    assert.deepEqual(
      all.filter((e) => e.time === 1000).map((e) => `${e.artifactId}:${e.kind}`),
      ["1:M", "1:A", "1:C", "1:B"]
    );
    assert.deepEqual(
      all.filter((e) => e.time === 500).map((e) => `${e.artifactId}:${e.kind}`),
      ["2:A", "2:B", "4:M"]
    );

    // 标签完全相等过滤
    const expectedDoc = computeTimeline(
      applyBatches([
        [
          { id: 1, tags: ["doc"], times: { M: 1000, A: 1000, C: 1000, B: 1000 } },
          { id: 2, tags: ["img", "doc"], times: { M: null, A: 500, C: null, B: 500 } },
          { id: 3, tags: [], times: { M: null, A: null, C: null, B: null } },
          { id: 4, tags: ["doc"], times: { M: 500, A: null, C: 2000, B: null } },
        ],
      ]),
      "doc"
    );
    const tagged = tl.queryFirstPage({ tag: "doc", pageSize: 1000 });
    assert.deepEqual(tagged.events, expectedDoc);
    // 完全相等：'do' 不匹配 'doc'
    const partial = tl.queryFirstPage({ tag: "do", pageSize: 1000 });
    assert.equal(partial.events.length, 0);

    tl.close();
  } finally {
    cleanup();
  }
});

test("批次原子可见：快照要么看到整个批次，要么完全看不到", () => {
  const { dbPath, cleanup } = tempDbPath();
  try {
    const tl = new CaseTimeline(dbPath);
    tl.submitBatch([
      { id: 1, tags: ["a"], times: { M: 10, A: null, C: null, B: null } },
    ]);
    const before = tl.queryFirstPage({ pageSize: 100 });

    // 一个批次包含多条记录
    tl.submitBatch([
      { id: 2, tags: ["a"], times: { M: 20, A: null, C: null, B: null } },
      { id: 3, tags: ["a"], times: { M: 30, A: null, C: null, B: null } },
      { id: 1, tags: ["a", "b"], times: { M: 40, A: null, C: null, B: null } },
    ]);

    // 旧快照看不到批次中的任何一条（包括修订）
    const rest = collectAll(tl, before.snapshotId, []);
    const oldAll = [...before.events, ...rest];
    assert.deepEqual(
      oldAll.map((e) => `${e.artifactId}:${e.kind}:${e.time}`),
      ["1:M:10"]
    );
    assert.deepEqual(oldAll[0].tags, ["a"]);

    // 新快照看到批次中的全部
    const after = tl.queryFirstPage({ pageSize: 100 });
    assert.deepEqual(
      after.events.map((e) => `${e.artifactId}:${e.kind}:${e.time}`),
      ["2:M:20", "3:M:30", "1:M:40"]
    );
    tl.close();
  } finally {
    cleanup();
  }
});
