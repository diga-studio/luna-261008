import { DatabaseSync } from 'node:sqlite';
import { AdContent, Revision } from './types';

export interface RevisionRow {
  version: number;
  content: AdContent;
  createdAt: number;
}

export interface DedupRow {
  resultVersion: number;
  content: AdContent;
  firstSuccessAt: number;
}

interface RevisionSqlRow {
  version: number;
  title: string;
  body: string;
  cta: string;
  background_color: string;
  font: string;
  created_at: number;
}

interface DedupSqlRow {
  result_version: number;
  title: string;
  body: string;
  cta: string;
  background_color: string;
  font: string;
  first_success_at: number;
}

function rowToContent(row: {
  title: string;
  body: string;
  cta: string;
  background_color: string;
  font: string;
}): AdContent {
  return {
    title: row.title,
    body: row.body,
    cta: row.cta,
    backgroundColor: row.background_color,
    font: row.font,
  };
}

/** SQLite 访问层：只负责读写，不含业务裁决。 */
export class Database {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        current_version INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS revisions (
        project_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        cta TEXT NOT NULL,
        background_color TEXT NOT NULL,
        font TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (project_id, version)
      );
      CREATE TABLE IF NOT EXISTS dedup (
        project_id TEXT NOT NULL,
        base_version INTEGER NOT NULL,
        content_key TEXT NOT NULL,
        result_version INTEGER NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        cta TEXT NOT NULL,
        background_color TEXT NOT NULL,
        font TEXT NOT NULL,
        first_success_at INTEGER NOT NULL,
        PRIMARY KEY (project_id, base_version, content_key)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  createProject(projectId: string, content: AdContent, now: number): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare('INSERT INTO projects (id, current_version, created_at) VALUES (?, 1, ?)')
        .run(projectId, now);
      this.insertRevision(projectId, 1, content, now);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  projectExists(projectId: string): boolean {
    return (
      this.db.prepare('SELECT 1 AS x FROM projects WHERE id = ?').get(projectId) !== undefined
    );
  }

  currentVersion(projectId: string): number | null {
    const row = this.db
      .prepare('SELECT current_version AS v FROM projects WHERE id = ?')
      .get(projectId) as { v: number } | undefined;
    return row === undefined ? null : row.v;
  }

  getRevision(projectId: string, version: number): RevisionRow | null {
    const row = this.db
      .prepare(
        `SELECT version, title, body, cta, background_color, font, created_at
         FROM revisions WHERE project_id = ? AND version = ?`,
      )
      .get(projectId, version) as RevisionSqlRow | undefined;
    if (row === undefined) return null;
    return { version: row.version, content: rowToContent(row), createdAt: row.created_at };
  }

  /** 最近 limit 个修订（含当前），按版本升序返回。 */
  recentRevisions(projectId: string, limit: number): Revision[] {
    const rows = this.db
      .prepare(
        `SELECT version, title, body, cta, background_color, font, created_at
         FROM revisions WHERE project_id = ?
         ORDER BY version DESC LIMIT ?`,
      )
      .all(projectId, limit) as unknown as RevisionSqlRow[];
    return rows
      .reverse()
      .map((row) => ({
        projectId,
        version: row.version,
        content: rowToContent(row),
        createdAt: row.created_at,
      }));
  }

  findDedup(projectId: string, baseVersion: number, contentKey: string): DedupRow | null {
    const row = this.db
      .prepare(
        `SELECT result_version, title, body, cta, background_color, font, first_success_at
         FROM dedup WHERE project_id = ? AND base_version = ? AND content_key = ?`,
      )
      .get(projectId, baseVersion, contentKey) as DedupSqlRow | undefined;
    if (row === undefined) return null;
    return {
      resultVersion: row.result_version,
      content: rowToContent(row),
      firstSuccessAt: row.first_success_at,
    };
  }

  /**
   * 在单个事务内完成：校验当前版本仍为 expectedCurrentVersion，
   * 插入新修订并写入去重记录。版本已变化时返回 null。
   * 修订行内部全部保留（供基线补全与去重），对外仅暴露最近 20 个。
   */
  commitRevision(
    projectId: string,
    expectedCurrentVersion: number,
    content: AdContent,
    dedup: { baseVersion: number; contentKey: string; firstSuccessAt: number },
    now: number,
  ): RevisionRow | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.currentVersion(projectId);
      if (current !== expectedCurrentVersion) {
        this.db.exec('ROLLBACK');
        return null;
      }
      const newVersion = expectedCurrentVersion + 1;
      this.insertRevision(projectId, newVersion, content, now);
      this.db
        .prepare('UPDATE projects SET current_version = ? WHERE id = ?')
        .run(newVersion, projectId);
      this.db
        .prepare(
          `INSERT OR REPLACE INTO dedup
             (project_id, base_version, content_key, result_version,
              title, body, cta, background_color, font, first_success_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          projectId,
          dedup.baseVersion,
          dedup.contentKey,
          newVersion,
          content.title,
          content.body,
          content.cta,
          content.backgroundColor,
          content.font,
          dedup.firstSuccessAt,
        );
      this.db.exec('COMMIT');
      return { version: newVersion, content, createdAt: now };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private insertRevision(projectId: string, version: number, content: AdContent, now: number): void {
    this.db
      .prepare(
        `INSERT INTO revisions
           (project_id, version, title, body, cta, background_color, font, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        projectId,
        version,
        content.title,
        content.body,
        content.cta,
        content.backgroundColor,
        content.font,
        now,
      );
  }
}
