import { DatabaseSync } from "node:sqlite";
import type {
  Answers,
  ReadScoresResult,
  RecalculateResult,
  Weights,
} from "./types.js";

export interface RecalculateBatchInfo {
  revision: number;
  /** 本批次完成打分后的累计已回算响应数。 */
  processed: number;
}

export interface ScorerOptions {
  /** SQLite 文件路径，缺省为内存数据库。 */
  dbPath?: string;
  /** 已发布的版本 1 的权重。 */
  initialWeights: Weights;
  /**
   * 回算每完成一个批次后调用（可返回 Promise）。
   * 主要用于测试与进度观测；回算期间 submit 照常接受。
   */
  onRecalculateBatch?: (info: RecalculateBatchInfo) => void | Promise<void>;
}

const BATCH_SIZE = 500;

function validateAnswers(answers: Answers): void {
  if (
    !Array.isArray(answers) ||
    answers.length !== 3 ||
    answers.some((a) => !Number.isInteger(a) || a < 1 || a > 10)
  ) {
    throw new Error("answers must be three integers between 1 and 10");
  }
}

function validateWeights(weights: Weights): void {
  if (
    !Array.isArray(weights) ||
    weights.length !== 3 ||
    weights.some((w) => !Number.isInteger(w) || w < 0) ||
    weights[0] + weights[1] + weights[2] !== 100
  ) {
    throw new Error("weights must be three non-negative integers summing to 100");
  }
}

function scoreOf(answers: Answers, weights: Weights): number {
  return (
    (answers[0] * weights[0] +
      answers[1] * weights[1] +
      answers[2] * weights[2]) /
    100
  );
}

export class Scorer {
  private readonly db: DatabaseSync;
  private readonly onRecalculateBatch?: ScorerOptions["onRecalculateBatch"];

  constructor(options: ScorerOptions) {
    validateWeights(options.initialWeights);
    this.onRecalculateBatch = options.onRecalculateBatch;
    this.db = new DatabaseSync(options.dbPath ?? ":memory:");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS responses (
        id TEXT PRIMARY KEY,
        a1 INTEGER NOT NULL,
        a2 INTEGER NOT NULL,
        a3 INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS scores (
        response_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        score REAL NOT NULL,
        PRIMARY KEY (response_id, revision)
      );
      CREATE TABLE IF NOT EXISTS revisions (
        revision INTEGER PRIMARY KEY,
        w1 INTEGER NOT NULL,
        w2 INTEGER NOT NULL,
        w3 INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );
    `);
    const hasMeta = this.db
      .prepare(`SELECT value FROM meta WHERE key = 'published_revision'`)
      .get() as { value: number } | undefined;
    if (!hasMeta) {
      const [w1, w2, w3] = options.initialWeights;
      this.db.exec(`
        INSERT INTO revisions (revision, w1, w2, w3) VALUES (1, ${w1}, ${w2}, ${w3});
        INSERT INTO meta (key, value) VALUES ('published_revision', 1);
        INSERT INTO meta (key, value) VALUES ('latest_revision', 1);
      `);
    }
  }

  async submit(id: string, answers: Answers): Promise<void> {
    validateAnswers(answers);
    // 同步事务：插入响应并按当前发布版本打分，返回即完成。
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(`INSERT INTO responses (id, a1, a2, a3) VALUES (?, ?, ?, ?)`)
        .run(id, answers[0], answers[1], answers[2]);
      const published = this.publishedRevision();
      const weights = this.weightsOf(published);
      this.db
        .prepare(
          `INSERT INTO scores (response_id, revision, score) VALUES (?, ?, ?)`,
        )
        .run(id, published, scoreOf(answers, weights));
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  async recalculate(
    revision: number | undefined,
    weights: Weights,
  ): Promise<RecalculateResult> {
    validateWeights(weights);
    // 登记新评分版本（同步执行，保证版本号按调用登记顺序严格递增）。
    const rev = this.registerRevision(revision, weights);

    let processed = 0;
    for (;;) {
      const batch = this.db
        .prepare(
          `SELECT r.id, r.a1, r.a2, r.a3
           FROM responses r
           LEFT JOIN scores s
             ON s.response_id = r.id AND s.revision = ?
           WHERE s.response_id IS NULL
           ORDER BY r.rowid
           LIMIT ?`,
        )
        .all(rev, BATCH_SIZE) as Array<{
        id: string;
        a1: number;
        a2: number;
        a3: number;
      }>;

      if (batch.length === 0) {
        // 尝试发布：发布检查与发布指针更新在同一事务中原子完成。
        const outcome = this.tryPublish(rev);
        if (outcome === "retry") continue;
        return outcome;
      }

      this.db.exec("BEGIN");
      try {
        const insert = this.db.prepare(
          `INSERT INTO scores (response_id, revision, score) VALUES (?, ?, ?)`,
        );
        for (const row of batch) {
          const score =
            (row.a1 * weights[0] + row.a2 * weights[1] + row.a3 * weights[2]) /
            100;
          insert.run(row.id, rev, score);
        }
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
      processed += batch.length;

      if (this.onRecalculateBatch) {
        await this.onRecalculateBatch({ revision: rev, processed });
      }
      // 让出事件循环，回算期间继续接收 submit。
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  async readScores(ids: string[]): Promise<ReadScoresResult> {
    // 单个同步读事务：一次读取中的所有分数属于同一个已发布版本。
    const revision = this.publishedRevision();
    const stmt = this.db.prepare(
      `SELECT score FROM scores WHERE response_id = ? AND revision = ?`,
    );
    const scores = [];
    for (const id of ids) {
      const row = stmt.get(id, revision) as { score: number } | undefined;
      if (row) scores.push({ id, score: row.score });
    }
    return { revision, scores };
  }

  close(): void {
    this.db.close();
  }

  private publishedRevision(): number {
    const row = this.db
      .prepare(`SELECT value FROM meta WHERE key = 'published_revision'`)
      .get() as { value: number };
    return row.value;
  }

  private latestRevision(): number {
    const row = this.db
      .prepare(`SELECT value FROM meta WHERE key = 'latest_revision'`)
      .get() as { value: number };
    return row.value;
  }

  private weightsOf(revision: number): Weights {
    const row = this.db
      .prepare(`SELECT w1, w2, w3 FROM revisions WHERE revision = ?`)
      .get(revision) as { w1: number; w2: number; w3: number } | undefined;
    if (!row) throw new Error(`unknown revision ${revision}`);
    return [row.w1, row.w2, row.w3];
  }

  private registerRevision(
    revision: number | undefined,
    weights: Weights,
  ): number {
    const latest = this.latestRevision();
    const rev = revision ?? latest + 1;
    if (!Number.isInteger(rev) || rev <= latest) {
      throw new Error(
        `revision must be an integer greater than the latest registered revision (${latest})`,
      );
    }
    this.db
      .prepare(`INSERT INTO revisions (revision, w1, w2, w3) VALUES (?, ?, ?, ?)`)
      .run(rev, weights[0], weights[1], weights[2]);
    this.db
      .prepare(`UPDATE meta SET value = ? WHERE key = 'latest_revision'`)
      .run(rev);
    return rev;
  }

  /**
   * 在单个事务中：确认无遗漏响应，且没有更新的版本已登记，然后原子切换发布指针。
   * 返回 "retry" 表示事务内又发现了新响应，需要继续回算。
   */
  private tryPublish(rev: number): RecalculateResult | "retry" {
    this.db.exec("BEGIN");
    try {
      const missing = this.db
        .prepare(
          `SELECT COUNT(*) AS n
           FROM responses r
           LEFT JOIN scores s
             ON s.response_id = r.id AND s.revision = ?
           WHERE s.response_id IS NULL`,
        )
        .get(rev) as { n: number };
      if (missing.n > 0) {
        this.db.exec("ROLLBACK");
        return "retry";
      }
      if (this.latestRevision() > rev) {
        this.db.exec("ROLLBACK");
        return "superseded";
      }
      this.db
        .prepare(`UPDATE meta SET value = ? WHERE key = 'published_revision'`)
        .run(rev);
      this.db.exec("COMMIT");
      return "published";
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}
