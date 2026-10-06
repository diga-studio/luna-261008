import { TimelineStore } from './database.js';
import { SnapshotStore } from './snapshot.js';
import { EVENT_KIND_ORDER } from './types.js';
import type { ArtifactRecord, EventKind, TimelineEvent, TimelinePage } from './types.js';

const DEFAULT_PAGE_SIZE = 100;

/** 从一条制品记录展开事件：每个非缺失时间各一个事件。 */
function recordToEvents(record: ArtifactRecord): TimelineEvent[] {
  const times: Record<EventKind, number | null> = {
    M: record.mtime,
    A: record.atime,
    C: record.ctime,
    B: record.btime,
  };
  const events: TimelineEvent[] = [];
  for (const kind of EVENT_KIND_ORDER) {
    const timestamp = times[kind];
    if (timestamp !== null) {
      events.push({ artifactId: record.id, kind, timestamp });
    }
  }
  return events;
}

/** 排序：时间升序；再按制品编号升序；再按 M、A、C、B。 */
function compareEvents(a: TimelineEvent, b: TimelineEvent): number {
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
  if (a.artifactId !== b.artifactId) return a.artifactId - b.artifactId;
  return EVENT_KIND_ORDER.indexOf(a.kind) - EVENT_KIND_ORDER.indexOf(b.kind);
}

/**
 * 取证时间线库主入口。一个实例对应一个案件（一个 SQLite 文件）。
 */
export class ForensicTimeline {
  private readonly store: TimelineStore;
  private readonly snapshots: SnapshotStore;

  constructor(dbPath: string) {
    this.store = new TimelineStore(dbPath);
    this.snapshots = new SnapshotStore(this.store.db);
    this.snapshots.initSchema();
  }

  /** 批量录入或修订制品记录；同编号整体替换。批次原子生效。 */
  ingest(records: ArtifactRecord[]): void {
    this.store.applyBatch(records);
  }

  /**
   * 首屏查询：建立快照并返回第一页。
   * tag 为 null/undefined 表示不按标签过滤；否则按完全相等匹配。
   */
  openTimeline(options?: { tag?: string; pageSize?: number }): { snapshotId: number; page: TimelinePage } {
    const tag = options?.tag ?? null;
    const pageSize = options?.pageSize ?? DEFAULT_PAGE_SIZE;
    if (!Number.isInteger(pageSize) || pageSize <= 0) {
      throw new Error(`pageSize must be a positive integer, got ${pageSize}`);
    }
    const events = this.store
      .loadAllRecords()
      .filter((record) => tag === null || record.tags.includes(tag))
      .flatMap(recordToEvents)
      .sort(compareEvents);
    const snapshotId = this.snapshots.create(tag, pageSize, events);
    return { snapshotId, page: this.snapshots.nextPage(snapshotId) };
  }

  /** 续页：沿用首屏的筛选条件与证据版本。 */
  nextPage(snapshotId: number): TimelinePage {
    return this.snapshots.nextPage(snapshotId);
  }

  /** 结束快照。 */
  closeSnapshot(snapshotId: number): void {
    this.snapshots.close(snapshotId);
  }

  /** 关闭库；未结束的快照在重新打开后仍可续页。 */
  close(): void {
    this.store.close();
  }
}
