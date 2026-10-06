import { DatabaseSync, StatementSync } from "node:sqlite";
import type { BatchItem, ImageInput } from "./types";

/**
 * Thin synchronous wrapper around the SQLite database. All methods are
 * synchronous (node:sqlite is synchronous), so no async trainer work can
 * interleave inside any of them; multi-statement mutations are wrapped in
 * explicit transactions.
 */
export class Store {
  private readonly db: DatabaseSync;
  private readonly stmtGetLabel: StatementSync;
  private readonly stmtSetLabel: StatementSync;
  private readonly stmtBumpCount: StatementSync;
  private readonly stmtGetCount: StatementSync;
  private readonly stmtPublishedGeneration: StatementSync;
  private readonly stmtSetPublishedGeneration: StatementSync;
  private readonly stmtTopBatch: StatementSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS images (
        id INTEGER PRIMARY KEY,
        features TEXT NOT NULL,
        label TEXT
      );
      CREATE TABLE IF NOT EXISTS published_scores (
        image_id INTEGER PRIMARY KEY,
        score REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_published_order
        ON published_scores (
          (score BETWEEN 0.35 AND 0.65) DESC,
          score DESC,
          image_id ASC
        );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO meta (key, value) VALUES
        ('change_count', 0),
        ('published_generation', 0);
    `);
    this.stmtGetLabel = this.db.prepare(
      "SELECT label FROM images WHERE id = ?"
    );
    this.stmtSetLabel = this.db.prepare(
      "UPDATE images SET label = ? WHERE id = ?"
    );
    this.stmtBumpCount = this.db.prepare(
      "UPDATE meta SET value = value + 1 WHERE key = 'change_count'"
    );
    this.stmtGetCount = this.db.prepare(
      "SELECT value FROM meta WHERE key = 'change_count'"
    );
    this.stmtPublishedGeneration = this.db.prepare(
      "SELECT value FROM meta WHERE key = 'published_generation'"
    );
    this.stmtSetPublishedGeneration = this.db.prepare(
      "UPDATE meta SET value = ? WHERE key = 'published_generation'"
    );
    this.stmtTopBatch = this.db.prepare(
      `SELECT s.image_id AS id, s.score AS score
       FROM published_scores s
       JOIN images i ON i.id = s.image_id
       WHERE i.label IS NULL
       ORDER BY (s.score BETWEEN 0.35 AND 0.65) DESC, s.score DESC, s.image_id ASC
       LIMIT ?`
    );
  }

  /** Bulk-insert the initial images and their generation-0 scores. */
  insertImages(images: ImageInput[]): void {
    const insertImage = this.db.prepare(
      "INSERT INTO images (id, features, label) VALUES (?, ?, NULL)"
    );
    const insertScore = this.db.prepare(
      "INSERT INTO published_scores (image_id, score) VALUES (?, ?)"
    );
    this.db.exec("BEGIN");
    try {
      for (const image of images) {
        insertImage.run(image.id, JSON.stringify(image.features));
        insertScore.run(image.id, image.score);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Returns the current label, `null` for unlabelled, `undefined` if unknown. */
  getLabel(imageId: number): string | null | undefined {
    const row = this.stmtGetLabel.get(imageId) as
      | { label: string | null }
      | undefined;
    return row === undefined ? undefined : row.label;
  }

  /**
   * Persist a label change and, if it is an effective change, bump the
   * cumulative change counter. Returns the new counter value, or -1 when
   * the write was a no-op.
   */
  applyLabel(imageId: number, label: string | null): number {
    const current = this.getLabel(imageId);
    if (current === undefined) {
      throw new Error(`unknown image id: ${imageId}`);
    }
    if (current === label) {
      return -1;
    }
    this.db.exec("BEGIN");
    try {
      this.stmtSetLabel.run(label, imageId);
      this.stmtBumpCount.run();
      const row = this.stmtGetCount.get() as { value: number };
      this.db.exec("COMMIT");
      return row.value;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Read-only snapshot of all current labels (unlabelled images omitted). */
  snapshotLabels(): Map<number, string> {
    const rows = this.db
      .prepare("SELECT id, label FROM images WHERE label IS NOT NULL")
      .all() as Array<{ id: number; label: string }>;
    const labels = new Map<number, string>();
    for (const row of rows) {
      labels.set(row.id, row.label);
    }
    return labels;
  }

  publishedGeneration(): number {
    const row = this.stmtPublishedGeneration.get() as { value: number };
    return row.value;
  }

  /**
   * Atomically replace the published scores with a newer generation's.
   * The caller must guarantee `generation` is greater than the currently
   * published one; it is re-checked inside the transaction.
   */
  publish(generation: number, scores: ReadonlyMap<number, number>): void {
    const insert = this.db.prepare(
      "INSERT INTO published_scores (image_id, score) VALUES (?, ?)"
    );
    this.db.exec("BEGIN");
    try {
      const current = this.publishedGeneration();
      if (generation <= current) {
        this.db.exec("ROLLBACK");
        return;
      }
      this.db.exec("DELETE FROM published_scores");
      for (const [imageId, score] of scores) {
        insert.run(imageId, score);
      }
      this.stmtSetPublishedGeneration.run(generation);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * Top `size` unlabelled images under the published scores: the band
   * [0.35, 0.65] first, then the rest; each group by score descending,
   * ties by id ascending. Single statement => single consistent snapshot.
   */
  topBatch(size: number): BatchItem[] {
    const rows = this.stmtTopBatch.all(size) as Array<{
      id: number;
      score: number;
    }>;
    return rows.map((row) => ({ id: row.id, score: row.score }));
  }

  close(): void {
    this.db.close();
  }
}
