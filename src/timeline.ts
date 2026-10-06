import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { openCaseDatabase } from "./database.js";
import { MACB_KINDS } from "./types.js";
import type {
  ArtifactRecord,
  FirstPageOptions,
  MacbKind,
  TimelineEvent,
  TimelinePage,
} from "./types.js";

const KIND_RANK: Record<MacbKind, number> = { M: 0, A: 1, C: 2, B: 3 };

interface SnapshotRow {
  id: string;
  version: number;
  tag: string | null;
  page_size: number;
  last_time: number | null;
  last_artifact_id: number | null;
  last_kind_rank: number | null;
  has_more: number;
}

interface EventRow {
  artifact_id: number;
  kind: string;
  time: number;
}

function validateRecord(record: ArtifactRecord): void {
  if (!Number.isSafeInteger(record.id) || record.id < 0) {
    throw new TypeError(`artifact id must be a non-negative safe integer, got ${record.id}`);
  }
  if (!Array.isArray(record.tags)) {
    throw new TypeError("tags must be an array of strings");
  }
  for (const tag of record.tags) {
    if (typeof tag !== "string") {
      throw new TypeError("tags must be an array of strings");
    }
  }
  for (const kind of MACB_KINDS) {
    const value = record.times[kind];
    if (value !== null && !Number.isSafeInteger(value)) {
      throw new TypeError(`time ${kind} must be a safe integer or null, got ${value}`);
    }
  }
}

/**
 * 单案件时间线。每个实例对应一个 SQLite 案件库文件。
 */
export class CaseTimeline {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = openCaseDatabase(dbPath);
  }

  /** 批量录入/修订：同一编号整条替换；批次原子可见 */
  submitBatch(records: ArtifactRecord[]): void {
    if (records.length === 0) return;
    for (const record of records) validateRecord(record);

    // 同批次内同一编号以后出现的为准
    const byId = new Map<number, ArtifactRecord>();
    for (const record of records) byId.set(record.id, record);

    this.db.exec("BEGIN");
    try {
      const versionRow = this.db
        .prepare("SELECT value FROM meta WHERE key = 'version'")
        .get() as { value: string };
      const version = Number(versionRow.value) + 1;

      const closeTags = this.db.prepare(
        "UPDATE artifact_tags SET version_to = ? WHERE artifact_id = ? AND version_to IS NULL"
      );
      const closeEvents = this.db.prepare(
        "UPDATE events SET version_to = ? WHERE artifact_id = ? AND version_to IS NULL"
      );
      const insertTag = this.db.prepare(
        "INSERT INTO artifact_tags (artifact_id, tag, version_from, version_to) VALUES (?, ?, ?, NULL)"
      );
      const insertEvent = this.db.prepare(
        "INSERT INTO events (artifact_id, kind, kind_rank, time, version_from, version_to) VALUES (?, ?, ?, ?, ?, NULL)"
      );

      for (const record of byId.values()) {
        closeTags.run(version, record.id);
        closeEvents.run(version, record.id);
        const tags = [...new Set(record.tags)].sort();
        for (const tag of tags) insertTag.run(record.id, tag, version);
        for (const kind of MACB_KINDS) {
          const time = record.times[kind];
          if (time !== null) {
            insertEvent.run(record.id, kind, KIND_RANK[kind], time, version);
          }
        }
      }

      this.db
        .prepare("INSERT INTO batches (version, record_count, created_at) VALUES (?, ?, ?)")
        .run(version, byId.size, Date.now());
      this.db
        .prepare("UPDATE meta SET value = ? WHERE key = 'version'")
        .run(String(version));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** 首屏：建立快照（持久化），返回第一页 */
  queryFirstPage(options: FirstPageOptions): TimelinePage {
    if (!Number.isSafeInteger(options.pageSize) || options.pageSize <= 0) {
      throw new TypeError("pageSize must be a positive safe integer");
    }
    const versionRow = this.db
      .prepare("SELECT value FROM meta WHERE key = 'version'")
      .get() as { value: string };
    const snapshot: SnapshotRow = {
      id: randomUUID(),
      version: Number(versionRow.value),
      tag: options.tag ?? null,
      page_size: options.pageSize,
      last_time: null,
      last_artifact_id: null,
      last_kind_rank: null,
      has_more: 1,
    };
    return this.runPage(snapshot);
  }

  /** 续页：沿用首屏的筛选条件与证据版本 */
  queryNextPage(snapshotId: string): TimelinePage {
    const row = this.db
      .prepare(
        "SELECT id, version, tag, page_size, last_time, last_artifact_id, last_kind_rank, has_more FROM snapshots WHERE id = ?"
      )
      .get(snapshotId) as SnapshotRow | undefined;
    if (!row) {
      throw new Error(`unknown or ended snapshot: ${snapshotId}`);
    }
    return this.runPage(row);
  }

  /** 结束快照，释放其状态 */
  endSnapshot(snapshotId: string): void {
    this.db.prepare("DELETE FROM snapshots WHERE id = ?").run(snapshotId);
  }

  close(): void {
    this.db.close();
  }

  private runPage(snapshot: SnapshotRow): TimelinePage {
    const params: Record<string, number | string> = {
      v: snapshot.version,
      limit: snapshot.page_size + 1,
    };
    let sql = `
      SELECT e.artifact_id AS artifact_id, e.kind AS kind, e.time AS time
      FROM events e
      WHERE e.version_from <= :v
        AND (e.version_to IS NULL OR e.version_to > :v)
    `;
    if (snapshot.tag !== null) {
      sql += `
        AND EXISTS (
          SELECT 1 FROM artifact_tags t
          WHERE t.artifact_id = e.artifact_id
            AND t.tag = :tag
            AND t.version_from <= :v
            AND (t.version_to IS NULL OR t.version_to > :v)
        )
      `;
      params.tag = snapshot.tag;
    }
    if (snapshot.last_time !== null) {
      sql += `
        AND (
          e.time > :ct
          OR (e.time = :ct AND e.artifact_id > :caid)
          OR (e.time = :ct AND e.artifact_id = :caid AND e.kind_rank > :ckr)
        )
      `;
      params.ct = snapshot.last_time;
      params.caid = snapshot.last_artifact_id as number;
      params.ckr = snapshot.last_kind_rank as number;
    }
    sql += " ORDER BY e.time, e.artifact_id, e.kind_rank LIMIT :limit";

    const rows = this.db.prepare(sql).all(params) as unknown as EventRow[];
    const hasMore = rows.length > snapshot.page_size;
    const pageRows = hasMore ? rows.slice(0, snapshot.page_size) : rows;

    const events: TimelineEvent[] = pageRows.map((row) => ({
      artifactId: row.artifact_id,
      kind: row.kind as MacbKind,
      time: row.time,
      tags: this.tagsAt(snapshot.version, row.artifact_id),
    }));

    const last = pageRows[pageRows.length - 1];
    const upsert = this.db.prepare(`
      INSERT INTO snapshots
        (id, version, tag, page_size, last_time, last_artifact_id, last_kind_rank, has_more, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        last_time = excluded.last_time,
        last_artifact_id = excluded.last_artifact_id,
        last_kind_rank = excluded.last_kind_rank,
        has_more = excluded.has_more
    `);
    upsert.run(
      snapshot.id,
      snapshot.version,
      snapshot.tag,
      snapshot.page_size,
      last ? last.time : snapshot.last_time,
      last ? last.artifact_id : snapshot.last_artifact_id,
      last ? KIND_RANK[last.kind as MacbKind] : snapshot.last_kind_rank,
      hasMore ? 1 : 0,
      Date.now()
    );
    return { snapshotId: snapshot.id, events, hasMore };
  }

  private tagsAt(version: number, artifactId: number): string[] {
    const rows = this.db
      .prepare(
        `SELECT tag FROM artifact_tags
         WHERE artifact_id = ?
           AND version_from <= ?
           AND (version_to IS NULL OR version_to > ?)
         ORDER BY tag`
      )
      .all(artifactId, version, version) as unknown as { tag: string }[];
    return rows.map((row) => row.tag);
  }
}
