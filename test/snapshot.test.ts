import assert from "node:assert/strict";
import test from "node:test";
import { CaseTimeline } from "../src/index.js";
import type { ArtifactRecord, TimelineEvent } from "../src/index.js";
import { applyBatches, computeTimeline, tempDbPath } from "./helpers.js";

const batch1: ArtifactRecord[] = [
  { id: 1, tags: ["x"], times: { M: 100, A: null, C: null, B: null } },
  { id: 2, tags: ["x"], times: { M: 200, A: null, C: null, B: null } },
  { id: 3, tags: ["x"], times: { M: 300, A: null, C: null, B: null } },
  { id: 4, tags: ["x"], times: { M: 400, A: null, C: null, B: null } },
  { id: 5, tags: ["y"], times: { M: 150, A: null, C: null, B: null } },
];

// 翻页期间发生：新增记录、把未展示事件修订到已翻过的位置、把记录移出原标签
const batch2: ArtifactRecord[] = [
  { id: 6, tags: ["x"], times: { M: 50, A: null, C: null, B: null } },
  { id: 3, tags: ["x"], times: { M: 50, A: null, C: null, B: null } },
  { id: 4, tags: ["y"], times: { M: 400, A: null, C: null, B: null } },
  { id: 2, tags: ["x"], times: { M: 250, A: null, C: null, B: null } },
];

test("翻页期间的导入与修订不改变旧快照；关闭重开后可接续；新快照反映修订", () => {
  const { dbPath, cleanup } = tempDbPath();
  try {
    let tl = new CaseTimeline(dbPath);
    tl.submitBatch(batch1);

    // 首屏建立快照（tag = 'x'，每页 1 条）
    const first = tl.queryFirstPage({ tag: "x", pageSize: 1 });
    assert.deepEqual(
      first.events.map((e) => `${e.artifactId}:${e.kind}:${e.time}`),
      ["1:M:100"]
    );
    assert.equal(first.hasMore, true);
    const snapshotId = first.snapshotId;

    // 翻页期间其他人提交修订批次
    tl.submitBatch(batch2);

    // 续页仍看到首屏时的证据版本
    const page2 = tl.queryNextPage(snapshotId);
    assert.deepEqual(
      page2.events.map((e) => `${e.artifactId}:${e.kind}:${e.time}`),
      ["2:M:200"]
    );
    assert.equal(page2.hasMore, true);

    // 关闭并重开库，用同一快照标识接续翻页
    tl.close();
    tl = new CaseTimeline(dbPath);

    const collected: TimelineEvent[] = [...first.events, ...page2.events];
    let page = tl.queryNextPage(snapshotId);
    while (true) {
      collected.push(...page.events);
      if (!page.hasMore) break;
      page = tl.queryNextPage(snapshotId);
    }

    // 旧快照逐页拼接 == 首屏时的全量结果，无重无漏
    const expectedOld = computeTimeline(applyBatches([batch1]), "x");
    assert.deepEqual(collected, expectedOld);
    assert.deepEqual(
      collected.map((e) => `${e.artifactId}:${e.kind}:${e.time}`),
      ["1:M:100", "2:M:200", "3:M:300", "4:M:400"]
    );
    // 事件内容（含标签）也是旧版本的
    assert.deepEqual(collected[3].tags, ["x"]);

    // 结束快照后不能继续翻页
    tl.endSnapshot(snapshotId);
    assert.throws(() => tl.queryNextPage(snapshotId), /unknown or ended snapshot/);

    // 新快照反映此前已提交的修订
    const fresh = tl.queryFirstPage({ tag: "x", pageSize: 100 });
    const expectedNew = computeTimeline(applyBatches([batch1, batch2]), "x");
    assert.deepEqual(fresh.events, expectedNew);
    assert.deepEqual(
      fresh.events.map((e) => `${e.artifactId}:${e.kind}:${e.time}`),
      ["3:M:50", "6:M:50", "1:M:100", "2:M:250"]
    );

    // 不带标签的新首屏同样反映修订后的完整时间线
    const freshAll = tl.queryFirstPage({ pageSize: 100 });
    assert.deepEqual(
      freshAll.events,
      computeTimeline(applyBatches([batch1, batch2]))
    );

    tl.close();
  } finally {
    cleanup();
  }
});

test("快照跨重开保留筛选条件与游标；结束后彻底失效", () => {
  const { dbPath, cleanup } = tempDbPath();
  try {
    let tl = new CaseTimeline(dbPath);
    tl.submitBatch([
      { id: 1, tags: ["x"], times: { M: 1, A: 2, C: 3, B: 4 } },
      { id: 2, tags: ["x"], times: { M: 5, A: 6, C: 7, B: 8 } },
    ]);
    const first = tl.queryFirstPage({ tag: "x", pageSize: 3 });
    assert.equal(first.events.length, 3);
    tl.close();

    tl = new CaseTimeline(dbPath);
    const rest: TimelineEvent[] = [];
    let page = tl.queryNextPage(first.snapshotId);
    while (true) {
      rest.push(...page.events);
      if (!page.hasMore) break;
      page = tl.queryNextPage(first.snapshotId);
    }
    assert.deepEqual(
      [...first.events, ...rest].map((e) => `${e.artifactId}:${e.kind}`),
      ["1:M", "1:A", "1:C", "1:B", "2:M", "2:A", "2:C", "2:B"]
    );

    tl.endSnapshot(first.snapshotId);
    tl.close();

    // 结束后即使重开库也无法恢复该快照
    tl = new CaseTimeline(dbPath);
    assert.throws(() => tl.queryNextPage(first.snapshotId), /unknown or ended snapshot/);
    tl.close();
  } finally {
    cleanup();
  }
});
