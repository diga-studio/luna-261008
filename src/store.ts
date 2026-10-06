import { DatabaseSync } from 'node:sqlite';
import type { DimensionValues, Weights } from './types.js';

/** 一条评级版本记录（含撤销记录，撤销时 values 为空映射）。 */
export interface VersionRow {
  businessId: string;
  ratingId: string;
  subjectId: string;
  values: DimensionValues;
}

/**
 * SQLite 持久化层。
 * 版本表只追加不更新：所有版本与撤销记录都保留，旧版本内容不可覆盖。
 * 权重以十进制文本存储，保证读取后精确还原。
 */
export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS weights (
        business_id TEXT NOT NULL,
        label TEXT NOT NULL,
        weight TEXT NOT NULL,
        PRIMARY KEY (business_id, label)
      );
      CREATE TABLE IF NOT EXISTS versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        business_id TEXT NOT NULL,
        rating_id TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        values_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_versions_scope
        ON versions (business_id, subject_id, rating_id, id);
    `);
  }

  /** 整体替换某业务的维度权重。 */
  replaceWeights(businessId: string, weights: Weights): void {
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare('DELETE FROM weights WHERE business_id = ?')
        .run(businessId);
      const insert = this.db.prepare(
        'INSERT INTO weights (business_id, label, weight) VALUES (?, ?, ?)',
      );
      for (const [label, weight] of Object.entries(weights)) {
        insert.run(businessId, label, String(weight));
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getWeights(businessId: string): Weights {
    const rows = this.db
      .prepare('SELECT label, weight FROM weights WHERE business_id = ?')
      .all(businessId) as unknown as Array<{ label: string; weight: string }>;
    const weights: Weights = {};
    for (const row of rows) {
      weights[row.label] = Number(row.weight);
    }
    return weights;
  }

  /** 查询某评级已归属的主体；不存在返回 undefined。 */
  getSubjectOfRating(
    businessId: string,
    ratingId: string,
  ): string | undefined {
    const row = this.db
      .prepare(
        `SELECT subject_id FROM versions
         WHERE business_id = ? AND rating_id = ?
         ORDER BY id LIMIT 1`,
      )
      .get(businessId, ratingId) as unknown as
      | { subject_id: string }
      | undefined;
    return row?.subject_id;
  }

  /** 追加一个评级新版本（或撤销记录）。 */
  appendVersion(row: VersionRow): void {
    this.db
      .prepare(
        `INSERT INTO versions (business_id, rating_id, subject_id, values_json)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        row.businessId,
        row.ratingId,
        row.subjectId,
        JSON.stringify(row.values),
      );
  }

  /** 取某主体在某业务下、每条逻辑评级的最新版本。 */
  getLatestVersions(businessId: string, subjectId: string): VersionRow[] {
    const rows = this.db
      .prepare(
        `SELECT v.rating_id, v.subject_id, v.values_json
         FROM versions v
         WHERE v.business_id = ? AND v.subject_id = ?
           AND v.id = (
             SELECT MAX(id) FROM versions
             WHERE business_id = v.business_id AND rating_id = v.rating_id
           )`,
      )
      .all(businessId, subjectId) as unknown as Array<{
      rating_id: string;
      subject_id: string;
      values_json: string;
    }>;
    return rows.map((row) => ({
      businessId,
      ratingId: row.rating_id,
      subjectId: row.subject_id,
      values: JSON.parse(row.values_json) as DimensionValues,
    }));
  }

  close(): void {
    this.db.close();
  }
}
