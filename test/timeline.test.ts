import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ForensicTimeline } from '../src/index.js';
import type { ArtifactRecord, EventKind, TimelineEvent } from '../src/index.js';

const KIND_ORDER: EventKind[] = ['M', 'A', 'C', 'B'];

/** 独立全量计算：从制品记录直接推导应有的事件序列。 */
function computeExpected(records: ArtifactRecord[], tag?: string): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  for (const record of records) {
    if (tag !== undefined && !record.tags.includes(tag)) continue;
    const times: [EventKind, number | null][] = [
      ['M', record.mtime],
      ['A', record.atime],
      ['C', record.ctime],
      ['B', record.btime],
    ];
    for (const [kind, ts] of times) {
      if (ts !== null) events.push({ artifactId: record.id, kind, timestamp: ts });
    }
  }
  events.sort((a, b) =>
    a.timestamp - b.timestamp ||
    a.artifactId - b.artifactId ||
    KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)
  );
  return events;
}

/** 逐页读完一个快照，返回拼接后的完整事件序列。 */
function drain(timeline: ForensicTimeline, snapshotId: number, firstPage: TimelineEvent[]): TimelineEvent[] {
  const all = [...firstPage];
  for (;;) {
    const page = timeline.nextPage(snapshotId);
    all.push(...page.events);
    if (!page.hasMore) return all;
  }
}

function freshDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'timeline-')), 'case.db');
}

test('相同 MACB 时间与缺失时间：事件数量、顺序、内容与独立全量计算一致', () => {
  const timeline = new ForensicTimeline(freshDbPath());
  const T = 1_700_000_000_123;
  const records: ArtifactRecord[] = [
    // 四个时间完全相同：必须保留四个事件
    { id: 1, tags: ['disk'], mtime: T, atime: T, ctime: T, btime: T },
    // 全部缺失：不产生事件
    { id: 2, tags: ['disk'], mtime: null, atime: null, ctime: null, btime: null },
    // 部分缺失
    { id: 3, tags: ['mem'], mtime: T - 5, atime: null, ctime: T - 5, btime: null },
    // 与 1 号时间相同，检验编号次序
    { id: 4, tags: ['disk'], mtime: T, atime: null, ctime: null, btime: T + 1 },
  ];
  timeline.ingest(records);

  // 小页尺寸翻页，拼接结果须与全量计算一致
  const { snapshotId, page } = timeline.openTimeline({ pageSize: 3 });
  const got = drain(timeline, snapshotId, page.events);
  assert.deepEqual(got, computeExpected(records));

  // 四个相同时间的事件按 M、A、C、B 排列
  const atT = got.filter((e) => e.artifactId === 1 && e.timestamp === T);
  assert.deepEqual(atT.map((e) => e.kind), ['M', 'A', 'C', 'B']);

  // 标签过滤：完全相等匹配
  const disk = timeline.openTimeline({ tag: 'disk', pageSize: 100 });
  assert.deepEqual(
    drain(timeline, disk.snapshotId, disk.page.events),
    computeExpected(records, 'disk')
  );
  timeline.closeSnapshot(disk.snapshotId);

  timeline.closeSnapshot(snapshotId);
  timeline.close();
});

test('翻页期间新增、修订、移出标签、关闭重开：旧快照无重无漏，新快照反映修订', () => {
  const dbPath = freshDbPath();
  let timeline = new ForensicTimeline(dbPath);

  const v1: ArtifactRecord[] = [
    { id: 1, tags: ['disk'], mtime: 1000, atime: null, ctime: null, btime: null },
    { id: 2, tags: ['disk'], mtime: 2000, atime: null, ctime: null, btime: null },
    { id: 3, tags: ['disk'], mtime: 3000, atime: null, ctime: null, btime: null },
    { id: 4, tags: ['disk'], mtime: 4000, atime: null, ctime: null, btime: null },
    { id: 5, tags: ['mem'], mtime: 5000, atime: null, ctime: null, btime: null },
  ];
  timeline.ingest(v1);

  // 首屏：tag=disk，pageSize=2，快照版本即 v1
  const first = timeline.openTimeline({ tag: 'disk', pageSize: 2 });
  const snapshotId = first.snapshotId;
  const collected = [...first.page.events];
  assert.deepEqual(collected, [
    { artifactId: 1, kind: 'M', timestamp: 1000 },
    { artifactId: 2, kind: 'M', timestamp: 2000 },
  ]);

  // 翻页期间的并发变更：
  // a) 新增匹配与不匹配标签的记录
  // b) 把尚未展示的事件（id=4）修订到已翻过的位置（500）
  // c) 把尚未展示的事件（id=3）移出原标签
  timeline.ingest([
    { id: 6, tags: ['disk'], mtime: 1500, atime: null, ctime: null, btime: null },
    { id: 7, tags: ['other'], mtime: 2500, atime: null, ctime: null, btime: null },
  ]);
  timeline.ingest([
    { id: 4, tags: ['disk'], mtime: 500, atime: null, ctime: null, btime: null },
  ]);
  timeline.ingest([
    { id: 3, tags: ['archived'], mtime: 3000, atime: null, ctime: null, btime: null },
  ]);

  // 关闭并重开库，接续翻页
  timeline.close();
  timeline = new ForensicTimeline(dbPath);

  const rest = drain(timeline, snapshotId, []);
  collected.push(...rest);

  // 旧快照逐页拼接 == 首屏时的全量结果（v1, tag=disk），无重无漏
  assert.deepEqual(collected, computeExpected(v1, 'disk'));

  // 新快照反映全部修订
  const current: ArtifactRecord[] = [
    { id: 1, tags: ['disk'], mtime: 1000, atime: null, ctime: null, btime: null },
    { id: 2, tags: ['disk'], mtime: 2000, atime: null, ctime: null, btime: null },
    { id: 3, tags: ['archived'], mtime: 3000, atime: null, ctime: null, btime: null },
    { id: 4, tags: ['disk'], mtime: 500, atime: null, ctime: null, btime: null },
    { id: 5, tags: ['mem'], mtime: 5000, atime: null, ctime: null, btime: null },
    { id: 6, tags: ['disk'], mtime: 1500, atime: null, ctime: null, btime: null },
    { id: 7, tags: ['other'], mtime: 2500, atime: null, ctime: null, btime: null },
  ];
  const fresh = timeline.openTimeline({ tag: 'disk', pageSize: 2 });
  assert.deepEqual(
    drain(timeline, fresh.snapshotId, fresh.page.events),
    computeExpected(current, 'disk')
  );

  // 结束快照后不可再翻页
  timeline.closeSnapshot(snapshotId);
  timeline.closeSnapshot(fresh.snapshotId);
  assert.throws(() => timeline.nextPage(snapshotId), /closed/);
  timeline.close();
});

test('批次原子性：失败批次整体不可见，成功批次整体可见', () => {
  const timeline = new ForensicTimeline(freshDbPath());
  timeline.ingest([
    { id: 1, tags: ['disk'], mtime: 1000, atime: null, ctime: null, btime: null },
  ]);

  // 含非法记录的批次：整体回滚
  const bad: ArtifactRecord[] = [
    { id: 2, tags: ['disk'], mtime: 2000, atime: null, ctime: null, btime: null },
    // SQLite INTEGER PRIMARY KEY 不接受字符串 id，触发约束错误
    { id: 'not-a-number' as unknown as number, tags: [], mtime: 1, atime: null, ctime: null, btime: null },
  ];
  assert.throws(() => timeline.ingest(bad));

  // 快照只能看到批次提交前的状态：既看不到半个失败批次，也能看到完整成功批次
  const s1 = timeline.openTimeline({ pageSize: 100 });
  assert.deepEqual(
    drain(timeline, s1.snapshotId, s1.page.events),
    [{ artifactId: 1, kind: 'M', timestamp: 1000 }]
  );
  timeline.closeSnapshot(s1.snapshotId);

  // 多记录成功批次：一次性全部可见
  timeline.ingest([
    { id: 2, tags: ['disk'], mtime: 2000, atime: null, ctime: null, btime: null },
    { id: 3, tags: ['disk'], mtime: 3000, atime: null, ctime: null, btime: null },
  ]);
  const s2 = timeline.openTimeline({ pageSize: 100 });
  assert.equal(drain(timeline, s2.snapshotId, s2.page.events).length, 3);
  timeline.closeSnapshot(s2.snapshotId);
  timeline.close();
});
