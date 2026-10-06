import { DatabaseSync } from "node:sqlite";
import type { Answers, RecalculateResult, ScoresResult, Weights } from "./types.js";

export interface ScorerOptions {
  /** SQLite 文件路径；缺省为内存数据库。 */
  dbPath?: string;
  /** 已发布的版本 1 的权重（仅在新建空数据库时生效）。 */
  weights: Weights;
  /** 回算时每批处理的响应数，默认 500。主要用于测试。 */
  batchSize?: number;
}

const DEFAULT_BATCH_SIZE = 500;

interface ResponseRow {
  id: string;
  a1: number;
  a2: number;
  a3: number;
}

function validateAnswers(answers: Answers): void {
  if (!Array.isArray(answers) || answers.length !== 3) {
    throw new Error("answers must be a tuple of 3 integers in [1, 10]");
  }
  for (const a of answers) {
    if (!Number.isInteger(a) || a < 1 || a > 10) {
      throw new Error("answers must be a tuple of 3 integers in [1, 10]");
    }
  }
}

function validateWeights(weights: Weights): void {
  if (!Array.isArray(weights) || weights.length !== 3) {
    throw new Error("weights must be a tuple of 3 non-negative integers summing to 100");
  }
  let sum = 0;
  for (const w of weights) {
    if (!Number.isInteger(w) || w < 0) {
      throw new Error("weights must be a tuple of 3 non-negative integers summing to 100");
    }
    sum += w;
  }
  if (sum !== 100) {
    throw new Error("weights must be a tuple of 3 non-negative integers summing to 100");
  }
}

function scoreOf(a: ResponseRow, w: Weights): number {
  return (a.a1 * w[0] + a.a2 * w[1] + a.a3 * w[2]) / 100;
}

export class Scorer {
  private readonly db: DatabaseSync;
  private readonly batchSize: number;
  private lastRegisteredRevision: number;
  private publishedRevision: number;

  constructor(options: ScorerOptions) {
    validateWeights(options.weights);
    this.db = new DatabaseSync(options.dbPath ?? ":memory:");
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS responses (
        id TEXT PRIMARY KEY,
        a1 INTEGER NOT NULL,
        a2 INTEGER NOT NULL,
        a3 INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS versions (
        revision INTEGER PRIMARY KEY,
        w1 INTEGER NOT NULL,
        w2 INTEGER NOT NULL,
        w3 INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'published', 'superseded'))
      );
      CREATE TABLE IF NOT EXISTS scores (
        response_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        score REAL NOT NULL,
        PRIMARY KEY (response_id, revision)
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );
    `);
    const published = this.db
      .prepare(`SELECT value FROM meta WHERE key = 'published_revision'`)
      .get() as { value: number } | undefined;
    if (published === undefined) {
      this.db.exec("BEGIN");
      try {
        this.db
          .prepare(`INSERT INTO versions (revision, w1, w2, w3, status) VALUES (1, ?, ?, ?, 'published')`)
          .run(...options.weights);
        this.db.prepare(`INSERT INTO meta (key, value) VALUES ('published_revision', 1)`).run();
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
      this.publishedRevision = 1;
    } else {
      this.publishedRevision = published.value;
    }
    const maxRevision = this.db
      .prepare(`SELECT MAX(revision) AS m FROM versions`)
      .get() as { m: number };
    this.lastRegisteredRevision = maxRevision.m;
  }

  async submit(id: string, answers: Answers): Promise<void> {
    validateAnswers(answers);
    if (typeof id !== "string" || id.length === 0) {
      throw new Error("id must be a non-empty string");
    }
    const revision = this.publishedRevision;
    const weights = this.weightsOf(revision);
    const row: ResponseRow = { id, a1: answers[0], a2: answers[1], a3: answers[2] };
    const score = scoreOf(row, weights);
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(`INSERT INTO responses (id, a1, a2, a3) VALUES (?, ?, ?, ?)`)
        .run(id, answers[0], answers[1], answers[2]);
      this.db
        .prepare(`INSERT INTO scores (response_id, revision, score) VALUES (?, ?, ?)`)
        .run(id, revision, score);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  async recalculate(revision: number, weights: Weights): Promise<RecalculateResult> {
    validateWeights(weights);
    if (!Number.isInteger(revision) || revision !== this.lastRegisteredRevision + 1) {
      throw new Error(`revision must be ${this.lastRegisteredRevision + 1}, got ${revision}`);
    }
    this.db
      .prepare(`INSERT INTO versions (revision, w1, w2, w3, status) VALUES (?, ?, ?, ?, 'pending')`)
      .run(revision, ...weights);
    this.lastRegisteredRevision = revision;

    const missingStmt = this.db.prepare(`
      SELECT r.id, r.a1, r.a2, r.a3
      FROM responses r
      LEFT JOIN scores s ON s.response_id = r.id AND s.revision = ?
      WHERE s.response_id IS NULL
      LIMIT ?
    `);
    const insertScore = this.db.prepare(
      `INSERT OR IGNORE INTO scores (response_id, revision, score) VALUES (?, ?, ?)`
    );

    for (;;) {
      // 让出事件循环，使回算期间可以继续接收 submit / readScores。
      await new Promise((resolve) => setImmediate(resolve));
      const missing = missingStmt.all(revision, this.batchSize) as unknown as ResponseRow[];
      if (missing.length === 0) break;
      this.db.exec("BEGIN");
      try {
        for (const row of missing) {
          insertScore.run(row.id, revision, scoreOf(row, weights));
        }
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
    }

    // 发布尝试：同步事务内复查，保证与 submit 不会交错。
    this.db.exec("BEGIN");
    try {
      const missingCount = (
        this.db
          .prepare(
            `SELECT COUNT(*) AS c
             FROM responses r
             LEFT JOIN scores s ON s.response_id = r.id AND s.revision = ?
             WHERE s.response_id IS NULL`
          )
          .get(revision) as { c: number }
      ).c;
      const newerCount = (
        this.db
          .prepare(`SELECT COUNT(*) AS c FROM versions WHERE revision > ?`)
          .get(revision) as { c: number }
      ).c;
      let result: RecalculateResult;
      if (missingCount === 0 && newerCount === 0) {
        this.db.prepare(`UPDATE versions SET status = 'published' WHERE revision = ?`).run(revision);
        this.db.prepare(`UPDATE meta SET value = ? WHERE key = 'published_revision'`).run(revision);
        this.publishedRevision = revision;
        result = "published";
      } else {
        this.db.prepare(`UPDATE versions SET status = 'superseded' WHERE revision = ?`).run(revision);
        result = "superseded";
      }
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  async readScores(ids: string[]): Promise<ScoresResult> {
    const revision = this.publishedRevision;
    const stmt = this.db.prepare(
      `SELECT score FROM scores WHERE response_id = ? AND revision = ?`
    );
    const scores: Record<string, number> = {};
    for (const id of ids) {
      const row = stmt.get(id, revision) as { score: number } | undefined;
      if (row !== undefined) {
        scores[id] = row.score;
      }
    }
    return { revision, scores };
  }

  close(): void {
    this.db.close();
  }

  private weightsOf(revision: number): Weights {
    const row = this.db
      .prepare(`SELECT w1, w2, w3 FROM versions WHERE revision = ?`)
      .get(revision) as { w1: number; w2: number; w3: number } | undefined;
    if (row === undefined) {
      throw new Error(`unknown revision ${revision}`);
    }
    return [row.w1, row.w2, row.w3];
  }
}
