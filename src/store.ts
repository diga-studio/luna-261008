import { DatabaseSync } from "node:sqlite";
import { DimensionValues, Weights } from "./types";

export interface RatingVersion {
  ratingId: string;
  subjectId: string;
  values: DimensionValues;
}

/** SQLite-backed append-only persistence for configs and rating versions. */
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
      CREATE INDEX IF NOT EXISTS idx_versions_subject
        ON versions (business_id, subject_id);
      CREATE INDEX IF NOT EXISTS idx_versions_rating
        ON versions (business_id, rating_id);
    `);
  }

  replaceWeights(businessId: string, weights: Weights): void {
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare("DELETE FROM weights WHERE business_id = ?")
        .run(businessId);
      const insert = this.db.prepare(
        "INSERT INTO weights (business_id, label, weight) VALUES (?, ?, ?)"
      );
      for (const [label, weight] of Object.entries(weights)) {
        if (!Number.isFinite(weight) || weight < 0) {
          throw new Error(`invalid weight for label ${label}: ${weight}`);
        }
        insert.run(businessId, label, String(weight));
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  getWeights(businessId: string): Weights {
    const rows = this.db
      .prepare("SELECT label, weight FROM weights WHERE business_id = ?")
      .all(businessId) as unknown as { label: string; weight: string }[];
    const weights: Weights = {};
    for (const row of rows) {
      weights[row.label] = Number(row.weight);
    }
    return weights;
  }

  /** Append a new version for a rating. Empty values mean revocation. */
  appendVersion(
    businessId: string,
    subjectId: string,
    ratingId: string,
    values: DimensionValues
  ): void {
    const owner = this.db
      .prepare(
        `SELECT subject_id FROM versions
         WHERE business_id = ? AND rating_id = ?
         ORDER BY id ASC LIMIT 1`
      )
      .get(businessId, ratingId) as { subject_id: string } | undefined;
    if (owner !== undefined && owner.subject_id !== subjectId) {
      throw new Error(
        `rating ${ratingId} already belongs to subject ${owner.subject_id}`
      );
    }
    for (const [label, value] of Object.entries(values)) {
      if (!Number.isInteger(value)) {
        throw new Error(`value for label ${label} is not an integer: ${value}`);
      }
    }
    this.db
      .prepare(
        `INSERT INTO versions (business_id, rating_id, subject_id, values_json)
         VALUES (?, ?, ?, ?)`
      )
      .run(businessId, ratingId, subjectId, JSON.stringify(values));
  }

  /** Latest version of every rating the subject has in the business. */
  latestVersions(businessId: string, subjectId: string): RatingVersion[] {
    const rows = this.db
      .prepare(
        `SELECT v.rating_id AS rating_id, v.subject_id AS subject_id,
                v.values_json AS values_json
         FROM versions v
         JOIN (
           SELECT rating_id, MAX(id) AS max_id
           FROM versions
           WHERE business_id = ? AND subject_id = ?
           GROUP BY rating_id
         ) latest ON latest.max_id = v.id`
      )
      .all(businessId, subjectId) as unknown as {
      rating_id: string;
      subject_id: string;
      values_json: string;
    }[];
    return rows.map((row) => ({
      ratingId: row.rating_id,
      subjectId: row.subject_id,
      values: JSON.parse(row.values_json) as DimensionValues,
    }));
  }

  close(): void {
    this.db.close();
  }
}
