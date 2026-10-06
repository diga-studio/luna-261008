import { DatabaseSync } from "node:sqlite";
import { SqlLabelSnapshot } from "./snapshot.js";
import type {
  Batch,
  EmitFn,
  ImageInput,
  Label,
  LabelQueue,
  Trainer,
} from "./types.js";

/** One training generation is triggered per this many valid label changes. */
export const CHANGES_PER_GENERATION = 20;

/** Scores in this closed interval sort ahead of all others. */
const FOCUS_LOW = 0.35;
const FOCUS_HIGH = 0.65;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS images (
  id        INTEGER PRIMARY KEY,
  features  TEXT NOT NULL,
  score     REAL NOT NULL,
  score_gen INTEGER NOT NULL,
  label     TEXT,
  bucket    INTEGER GENERATED ALWAYS AS (
              CASE WHEN score >= ${FOCUS_LOW} AND score <= ${FOCUS_HIGH}
                   THEN 0 ELSE 1 END
            ) STORED
);
CREATE TABLE IF NOT EXISTS label_events (
  seq      INTEGER PRIMARY KEY,
  image_id INTEGER NOT NULL,
  label    TEXT
);
CREATE INDEX IF NOT EXISTS idx_label_events_image
  ON label_events (image_id, seq);
CREATE TABLE IF NOT EXISTS pending_scores (
  gen      INTEGER NOT NULL,
  image_id INTEGER NOT NULL,
  score    REAL NOT NULL,
  PRIMARY KEY (gen, image_id)
);
CREATE INDEX IF NOT EXISTS idx_queue
  ON images (bucket, score DESC, id)
  WHERE label IS NULL;
`;

/**
 * Create a labeling queue backed by a SQLite database at `path`.
 *
 * All database work is synchronous (node:sqlite), so no SQLite transaction
 * or lock is ever held across an `await`: trainer invocations run as
 * detached promise chains and only re-enter the database for short,
 * synchronous emit/publish/discard steps.
 */
export function createQueue(
  path: string,
  images: readonly ImageInput[],
  trainer: Trainer,
): LabelQueue {
  validateImages(images);

  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");

  const features = new Map<number, readonly number[]>();

  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(
      `INSERT INTO meta (key, value) VALUES
         ('change_count', 0),
         ('published_gen', 0)`,
    );
    const insert = db.prepare(
      `INSERT INTO images (id, features, score, score_gen, label)
       VALUES (?, ?, ?, 0, NULL)`,
    );
    for (const image of images) {
      insert.run(image.id, JSON.stringify(image.features), image.score);
      features.set(image.id, image.features);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    db.close();
    throw err;
  }

  const stmtLabelOf = db.prepare(`SELECT label FROM images WHERE id = ?`);
  const stmtSetLabel = db.prepare(`UPDATE images SET label = ? WHERE id = ?`);
  const stmtBumpChanges = db.prepare(
    `UPDATE meta SET value = value + 1 WHERE key = 'change_count' RETURNING value`,
  );
  const stmtInsertEvent = db.prepare(
    `INSERT INTO label_events (seq, image_id, label) VALUES (?, ?, ?)`,
  );
  const stmtPublishedGen = db.prepare(
    `SELECT value FROM meta WHERE key = 'published_gen'`,
  );
  const stmtSetPublishedGen = db.prepare(
    `UPDATE meta SET value = ? WHERE key = 'published_gen'`,
  );
  const stmtGetBatch = db.prepare(
    `SELECT id, score FROM images
      WHERE label IS NULL
      ORDER BY bucket, score DESC, id
      LIMIT ?`,
  );
  const stmtInsertPending = db.prepare(
    `INSERT OR REPLACE INTO pending_scores (gen, image_id, score)
     VALUES (?, ?, ?)`,
  );
  const stmtPendingCount = db.prepare(
    `SELECT COUNT(*) AS n FROM pending_scores WHERE gen = ?`,
  );
  const stmtPublishScores = db.prepare(
    `UPDATE images
        SET score = (SELECT p.score FROM pending_scores p
                      WHERE p.gen = ? AND p.image_id = images.id),
            score_gen = ?
      WHERE id IN (SELECT p2.image_id FROM pending_scores p2 WHERE p2.gen = ?)`,
  );
  const stmtDeletePending = db.prepare(
    `DELETE FROM pending_scores WHERE gen = ?`,
  );

  /** Generations whose trainer is still running. */
  const activeGenerations = new Set<number>();

  function readPublishedGen(): number {
    return Number(stmtPublishedGen.get()?.value ?? 0);
  }

  function setLabel(imageId: number, label: Label | null): void {
    const value = label ?? null;
    if (value !== null && typeof value !== "string") {
      throw new TypeError("label must be a string or null");
    }
    let changeCount = 0;
    let changed = false;
    db.exec("BEGIN IMMEDIATE");
    try {
      const row = stmtLabelOf.get(imageId);
      if (!row) {
        throw new RangeError(`unknown image id: ${imageId}`);
      }
      const current = row.label === null ? null : String(row.label);
      if (current !== value) {
        stmtSetLabel.run(value, imageId);
        changeCount = Number(stmtBumpChanges.get()?.value);
        stmtInsertEvent.run(changeCount, imageId, value);
        changed = true;
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    // Training starts only after the triggering change is committed, and
    // setLabel returns without waiting for it.
    if (changed && changeCount % CHANGES_PER_GENERATION === 0) {
      startGeneration(changeCount);
    }
  }

  function getBatch(size: number): Batch {
    if (!Number.isInteger(size) || size < 0) {
      throw new RangeError("size must be a non-negative integer");
    }
    // Synchronous statements on a single thread: nothing can commit
    // between reading the generation and reading the rows, so the pair
    // is a consistent view of one moment in time.
    const generation = readPublishedGen();
    const rows = stmtGetBatch.all(size);
    return {
      generation,
      items: rows.map((row) => ({
        id: Number(row.id),
        score: Number(row.score),
      })),
    };
  }

  function startGeneration(generation: number): void {
    const snapshot = new SqlLabelSnapshot(db, generation, generation);
    const emit: EmitFn = (scores) => emitScores(generation, scores);
    activeGenerations.add(generation);
    // Detached promise chain: generations are never queued behind each
    // other, so a paused older generation cannot block newer ones.
    Promise.resolve()
      .then(() => trainer(generation, snapshot, features, emit))
      .then(
        () => completeGeneration(generation),
        () => failGeneration(generation),
      );
  }

  async function emitScores(
    generation: number,
    scores: ReadonlyArray<readonly [number, number]>,
  ): Promise<void> {
    if (!activeGenerations.has(generation)) {
      throw new Error(`generation ${generation} is no longer active`);
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const pair of scores) {
        const [imageId, score] = pair;
        if (!features.has(imageId)) {
          throw new RangeError(`unknown image id: ${imageId}`);
        }
        if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1) {
          throw new RangeError(`score out of range [0, 1]: ${score}`);
        }
        stmtInsertPending.run(generation, imageId, score);
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  function completeGeneration(generation: number): void {
    activeGenerations.delete(generation);
    db.exec("BEGIN IMMEDIATE");
    try {
      const emitted = Number(stmtPendingCount.get(generation)?.n ?? 0);
      const published = readPublishedGen();
      // Publish only a complete generation, and only if no higher
      // generation has already been published: generations never regress.
      if (emitted === features.size && generation > published) {
        stmtPublishScores.run(generation, generation, generation);
        stmtSetPublishedGen.run(generation);
      }
      stmtDeletePending.run(generation);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  function failGeneration(generation: number): void {
    activeGenerations.delete(generation);
    db.exec("BEGIN IMMEDIATE");
    try {
      stmtDeletePending.run(generation);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  function close(): void {
    db.close();
  }

  return { setLabel, getBatch, close };
}

function validateImages(images: readonly ImageInput[]): void {
  const seen = new Set<number>();
  for (const image of images) {
    if (!Number.isInteger(image.id) || image.id <= 0) {
      throw new RangeError(`image id must be a positive integer: ${image.id}`);
    }
    if (seen.has(image.id)) {
      throw new RangeError(`duplicate image id: ${image.id}`);
    }
    seen.add(image.id);
    if (
      typeof image.score !== "number" ||
      !Number.isFinite(image.score) ||
      image.score < 0 ||
      image.score > 1
    ) {
      throw new RangeError(`initial score out of range [0, 1]: ${image.score}`);
    }
    if (!Array.isArray(image.features)) {
      throw new TypeError("features must be an array of numbers");
    }
  }
}
