import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from './db.js';
import type {
  AdContent,
  ContentPatch,
  CreateProjectResult,
  Revision,
  RevisionStoreOptions,
  SubmitResult,
} from './types.js';

export const DEDUP_WINDOW_MS = 5000;
export const HISTORY_LIMIT = 20;

const FIELDS = ['title', 'body', 'cta', 'backgroundColor', 'font'] as const;
type Field = (typeof FIELDS)[number];

const COLUMN_BY_FIELD: Record<Field, string> = {
  title: 'title',
  body: 'body',
  cta: 'cta',
  backgroundColor: 'background_color',
  font: 'font',
};

interface RevisionRow {
  version: number;
  title: string;
  body: string;
  cta: string;
  background_color: string;
  font: string;
  created_at: number;
}

interface DedupRow {
  id: number;
  baseline_title: string;
  baseline_body: string;
  baseline_cta: string;
  baseline_background_color: string;
  baseline_font: string;
  title: string;
  body: string;
  cta: string;
  background_color: string;
  font: string;
  result_version: number;
  first_success_at: number;
}

function rowToContent(row: RevisionRow): AdContent {
  return {
    title: row.title,
    body: row.body,
    cta: row.cta,
    backgroundColor: row.background_color,
    font: row.font,
  };
}

function assertContent(content: AdContent): void {
  for (const field of FIELDS) {
    if (typeof content[field] !== 'string') {
      throw new TypeError(`content.${field} must be a string`);
    }
  }
}

function assertPatch(patch: ContentPatch): void {
  const provided = FIELDS.filter((field) => patch[field] !== undefined);
  if (provided.length === 0) {
    throw new TypeError('patch must contain at least one field');
  }
  for (const field of provided) {
    if (typeof patch[field] !== 'string') {
      throw new TypeError(`patch.${field} must be a string`);
    }
  }
}

export class RevisionStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(options?: RevisionStoreOptions) {
    this.db = openDatabase(options?.dbPath ?? ':memory:');
    this.now = options?.now ?? Date.now;
  }

  createProject(projectId: string, content: AdContent): CreateProjectResult {
    assertContent(content);
    const existing = this.db
      .prepare('SELECT id FROM projects WHERE id = ?')
      .get(projectId);
    if (existing) {
      throw new Error(`project already exists: ${projectId}`);
    }
    const createdAt = this.now();
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare('INSERT INTO projects (id, created_at) VALUES (?, ?)')
        .run(projectId, createdAt);
      this.insertRevision(projectId, 1, content, createdAt);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return { projectId, version: 1, content: { ...content } };
  }

  submitRevision(projectId: string, baseVersion: number, patch: ContentPatch): SubmitResult {
    assertPatch(patch);
    const now = this.now();

    const project = this.db
      .prepare('SELECT id FROM projects WHERE id = ?')
      .get(projectId);
    if (!project) {
      throw new Error(`project not found: ${projectId}`);
    }

    // 有效去重优先于版本冲突判断。
    const dedupHit = this.findValidDedup(projectId, baseVersion, patch, now);
    if (dedupHit) {
      return {
        status: 'ok',
        version: dedupHit.result_version,
        content: {
          title: dedupHit.title,
          body: dedupHit.body,
          cta: dedupHit.cta,
          backgroundColor: dedupHit.background_color,
          font: dedupHit.font,
        },
        deduplicated: true,
      };
    }

    const currentRow = this.db
      .prepare(
        'SELECT * FROM revisions WHERE project_id = ? ORDER BY version DESC LIMIT 1',
      )
      .get(projectId) as unknown as RevisionRow;
    if (baseVersion !== currentRow.version) {
      return { status: 'conflict', currentVersion: currentRow.version };
    }

    const baseline = rowToContent(currentRow);
    const completed: AdContent = { ...baseline };
    for (const field of FIELDS) {
      if (patch[field] !== undefined) {
        completed[field] = patch[field] as string;
      }
    }

    const newVersion = currentRow.version + 1;
    this.db.exec('BEGIN');
    try {
      this.insertRevision(projectId, newVersion, completed, now);
      this.pruneHistory(projectId);
      this.db
        .prepare('DELETE FROM dedup_records WHERE project_id = ? AND ? - first_success_at >= ?')
        .run(projectId, now, DEDUP_WINDOW_MS);
      this.db
        .prepare(
          `INSERT INTO dedup_records (
             project_id, base_version,
             baseline_title, baseline_body, baseline_cta,
             baseline_background_color, baseline_font,
             title, body, cta, background_color, font,
             result_version, first_success_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          projectId,
          baseVersion,
          baseline.title,
          baseline.body,
          baseline.cta,
          baseline.backgroundColor,
          baseline.font,
          completed.title,
          completed.body,
          completed.cta,
          completed.backgroundColor,
          completed.font,
          newVersion,
          now,
        );
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return { status: 'ok', version: newVersion, content: completed, deduplicated: false };
  }

  getCurrent(projectId: string): Revision | null {
    const row = this.db
      .prepare(
        'SELECT * FROM revisions WHERE project_id = ? ORDER BY version DESC LIMIT 1',
      )
      .get(projectId) as unknown as RevisionRow | undefined;
    if (!row) {
      return null;
    }
    return {
      projectId,
      version: row.version,
      content: rowToContent(row),
      createdAt: row.created_at,
    };
  }

  getHistory(projectId: string): Revision[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM revisions WHERE project_id = ? ORDER BY version DESC LIMIT ?',
      )
      .all(projectId, HISTORY_LIMIT) as unknown as RevisionRow[];
    return rows.map((row) => ({
      projectId,
      version: row.version,
      content: rowToContent(row),
      createdAt: row.created_at,
    }));
  }

  close(): void {
    this.db.close();
  }

  private insertRevision(
    projectId: string,
    version: number,
    content: AdContent,
    createdAt: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO revisions (
           project_id, version, title, body, cta, background_color, font, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        projectId,
        version,
        content.title,
        content.body,
        content.cta,
        content.backgroundColor,
        content.font,
        createdAt,
      );
  }

  private pruneHistory(projectId: string): void {
    this.db
      .prepare(
        `DELETE FROM revisions
         WHERE project_id = ?
           AND version <= (
             SELECT MAX(version) - ? FROM revisions WHERE project_id = ?
           )`,
      )
      .run(projectId, HISTORY_LIMIT, projectId);
  }

  /**
   * 查找有效去重记录：同一项目、同一基线版本，且补全缺失字段后的完整内容相同。
   * 记录中保存了首次提交时的基线内容，因此即使该基线修订已被挤出历史，
   * 仍能判定等价性。
   */
  private findValidDedup(
    projectId: string,
    baseVersion: number,
    patch: ContentPatch,
    now: number,
  ): DedupRow | null {
    const rows = this.db
      .prepare(
        `SELECT * FROM dedup_records
         WHERE project_id = ? AND base_version = ? AND ? - first_success_at < ?`,
      )
      .all(projectId, baseVersion, now, DEDUP_WINDOW_MS) as unknown as DedupRow[];
    for (const row of rows) {
      const baseline: AdContent = {
        title: row.baseline_title,
        body: row.baseline_body,
        cta: row.baseline_cta,
        backgroundColor: row.baseline_background_color,
        font: row.baseline_font,
      };
      const matches = FIELDS.every((field) => {
        const value = patch[field] !== undefined ? patch[field] : baseline[field];
        return value === row[COLUMN_BY_FIELD[field] as keyof DedupRow];
      });
      if (matches) {
        return row;
      }
    }
    return null;
  }
}
