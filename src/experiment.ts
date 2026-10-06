import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./db.js";
import { predict, trainModel, uncertaintyScore } from "./model.js";
import { deriveRoundRng, sampleWithoutReplacement } from "./random.js";
import type {
  ExperimentData,
  ExperimentResults,
  LabeledRow,
  Model,
  RoundResult,
  Strategy,
} from "./types.js";

export interface KernelOptions {
  dbPath: string;
  /** 仅测试用：每持久化一个标签后同步回调 */
  afterLabelPersisted?: (count: number) => void;
  /** 仅测试用：轮次发布后、runRound 返回前同步回调 */
  beforeRunRoundReturn?: () => void;
}

const BATCH_SIZE = 32;
const MAX_ROUNDS = 20;
const STRATEGIES: Strategy[] = ["uncertainty", "random"];

interface RoundRow {
  status: string;
  selected_ids: string;
  model: string;
  train_version: number;
  validation_accuracy: number | null;
  cumulative_budget: number | null;
}

export class ExperimentKernel {
  private db: DatabaseSync;
  private afterLabelPersisted?: (count: number) => void;
  private beforeRunRoundReturn?: () => void;

  constructor(options: KernelOptions) {
    this.db = openDatabase(options.dbPath);
    this.afterLabelPersisted = options.afterLabelPersisted;
    this.beforeRunRoundReturn = options.beforeRunRoundReturn;
  }

  createExperiment(data: ExperimentData, seed: number): string {
    const ids = new Set<number>();
    for (const r of [...data.seed, ...data.pool, ...data.validation]) {
      if (!Number.isInteger(r.id)) throw new Error(`row id must be an integer: ${r.id}`);
      if (ids.has(r.id)) throw new Error(`duplicate row id: ${r.id}`);
      ids.add(r.id);
    }
    const labels = new Set(data.seed.map((r) => r.label));
    if (!labels.has(0) || !labels.has(1)) {
      throw new Error("seed set must contain both classes");
    }
    const id = randomUUID();
    this.db.exec("BEGIN");
    try {
      this.db.prepare("INSERT INTO experiments (id, seed) VALUES (?, ?)").run(id, seed);
      const insSeed = this.db.prepare(
        "INSERT INTO seed_rows (experiment_id, row_id, features, label) VALUES (?, ?, ?, ?)",
      );
      for (const r of data.seed) insSeed.run(id, r.id, JSON.stringify(r.features), r.label);
      const insVal = this.db.prepare(
        "INSERT INTO validation_rows (experiment_id, row_id, features, label) VALUES (?, ?, ?, ?)",
      );
      for (const r of data.validation) insVal.run(id, r.id, JSON.stringify(r.features), r.label);
      const insPool = this.db.prepare(
        "INSERT INTO pool_rows (experiment_id, strategy, row_id, features, truth, available) VALUES (?, ?, ?, ?, ?, 1)",
      );
      for (const strategy of STRATEGIES) {
        for (const r of data.pool) insPool.run(id, strategy, r.id, JSON.stringify(r.features), r.truth);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return id;
  }

  runRound(experimentId: string, strategy: Strategy, roundNo: number): RoundResult | null {
    if (!STRATEGIES.includes(strategy)) throw new Error(`unknown strategy: ${strategy}`);
    if (!Number.isInteger(roundNo) || roundNo < 1) throw new Error(`invalid roundNo: ${roundNo}`);
    const exp = this.db
      .prepare("SELECT seed FROM experiments WHERE id = ?")
      .get(experimentId) as { seed: number } | undefined;
    if (!exp) throw new Error(`unknown experiment: ${experimentId}`);

    const existing = this.getRound(experimentId, strategy, roundNo);
    if (existing?.status === "committed") {
      return {
        roundNo,
        selectedIds: JSON.parse(existing.selected_ids) as number[],
        cumulativeBudget: existing.cumulative_budget!,
        validationAccuracy: existing.validation_accuracy!,
      };
    }

    let selectedIds: number[];
    let model: Model;
    if (existing) {
      selectedIds = JSON.parse(existing.selected_ids) as number[];
      model = JSON.parse(existing.model) as Model;
      const committedLabels = this.countCommittedLabels(experimentId, strategy);
      if (committedLabels !== existing.train_version) {
        throw new Error("training input version mismatch on resume");
      }
    } else {
      const lastCommitted = this.lastCommittedRound(experimentId, strategy);
      if (roundNo !== lastCommitted + 1) {
        throw new Error(`round ${roundNo} cannot start: next round is ${lastCommitted + 1}`);
      }
      if (roundNo > MAX_ROUNDS) return null;
      const pool = this.availablePool(experimentId, strategy);
      if (pool.length === 0) return null;
      const trainVersion = this.countCommittedLabels(experimentId, strategy);
      model = trainModel(this.trainingRows(experimentId, strategy));
      selectedIds = this.selectBatch(exp.seed, strategy, roundNo, model, pool);
      // 获取第一个标签前：选样序列与训练输入版本必须已持久化
      this.db
        .prepare(
          "INSERT INTO rounds (experiment_id, strategy, round_no, status, selected_ids, model, train_version) VALUES (?, ?, ?, 'in_progress', ?, ?, ?)",
        )
        .run(experimentId, strategy, roundNo, JSON.stringify(selectedIds), JSON.stringify(model), trainVersion);
    }

    // 逐个取标签，每取一个先持久化再取下一个
    const fetched = this.fetchedLabels(experimentId, strategy, roundNo);
    const getTruth = this.db.prepare(
      "SELECT truth FROM pool_rows WHERE experiment_id = ? AND strategy = ? AND row_id = ?",
    );
    const insLabel = this.db.prepare(
      "INSERT INTO round_labels (experiment_id, strategy, round_no, row_id, label, fetch_order) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (let i = fetched.length; i < selectedIds.length; i++) {
      const row = getTruth.get(experimentId, strategy, selectedIds[i]) as { truth: number };
      insLabel.run(experimentId, strategy, roundNo, selectedIds[i], row.truth, i);
      this.afterLabelPersisted?.(i + 1);
    }

    // 收齐本轮标签后训练并计算验证准确率
    const finalModel = trainModel(this.trainingRowsWithRound(experimentId, strategy, roundNo));
    const accuracy = this.validationAccuracy(experimentId, finalModel);
    const prevBudget = this.previousBudget(experimentId, strategy, roundNo);
    const cumulativeBudget = prevBudget + selectedIds.length;

    // 发布：标签可见性、累计预算、轮次结果在同一事务生效
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          "UPDATE pool_rows SET available = 0 WHERE experiment_id = ? AND strategy = ? AND row_id IN (SELECT row_id FROM round_labels WHERE experiment_id = ? AND strategy = ? AND round_no = ?)",
        )
        .run(experimentId, strategy, experimentId, strategy, roundNo);
      this.db
        .prepare(
          "UPDATE rounds SET status = 'committed', validation_accuracy = ?, cumulative_budget = ? WHERE experiment_id = ? AND strategy = ? AND round_no = ?",
        )
        .run(accuracy, cumulativeBudget, experimentId, strategy, roundNo);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }

    this.beforeRunRoundReturn?.();
    return { roundNo, selectedIds, cumulativeBudget, validationAccuracy: accuracy };
  }

  readResults(experimentId: string): ExperimentResults {
    const exp = this.db.prepare("SELECT id FROM experiments WHERE id = ?").get(experimentId);
    if (!exp) throw new Error(`unknown experiment: ${experimentId}`);
    const strategies = {} as Record<Strategy, { rounds: RoundResult[] }>;
    for (const strategy of STRATEGIES) {
      const rows = this.db
        .prepare(
          "SELECT round_no, selected_ids, cumulative_budget, validation_accuracy FROM rounds WHERE experiment_id = ? AND strategy = ? AND status = 'committed' ORDER BY round_no",
        )
        .all(experimentId, strategy) as unknown as Array<{
        round_no: number;
        selected_ids: string;
        cumulative_budget: number;
        validation_accuracy: number;
      }>;
      strategies[strategy] = {
        rounds: rows.map((r) => ({
          roundNo: r.round_no,
          selectedIds: JSON.parse(r.selected_ids) as number[],
          cumulativeBudget: r.cumulative_budget,
          validationAccuracy: r.validation_accuracy,
        })),
      };
    }
    return { experimentId, strategies };
  }

  close(): void {
    this.db.close();
  }

  private getRound(experimentId: string, strategy: Strategy, roundNo: number): RoundRow | undefined {
    return this.db
      .prepare(
        "SELECT status, selected_ids, model, train_version, validation_accuracy, cumulative_budget FROM rounds WHERE experiment_id = ? AND strategy = ? AND round_no = ?",
      )
      .get(experimentId, strategy, roundNo) as RoundRow | undefined;
  }

  private lastCommittedRound(experimentId: string, strategy: Strategy): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(MAX(round_no), 0) AS last FROM rounds WHERE experiment_id = ? AND strategy = ? AND status = 'committed'",
      )
      .get(experimentId, strategy) as { last: number };
    return row.last;
  }

  private countCommittedLabels(experimentId: string, strategy: Strategy): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM round_labels rl JOIN rounds r ON r.experiment_id = rl.experiment_id AND r.strategy = rl.strategy AND r.round_no = rl.round_no WHERE rl.experiment_id = ? AND rl.strategy = ? AND r.status = 'committed'",
      )
      .get(experimentId, strategy) as { n: number };
    return row.n;
  }

  private trainingRows(experimentId: string, strategy: Strategy): LabeledRow[] {
    const seedRows = this.db
      .prepare("SELECT row_id, features, label FROM seed_rows WHERE experiment_id = ? ORDER BY row_id")
      .all(experimentId) as unknown as Array<{ row_id: number; features: string; label: 0 | 1 }>;
    const committed = this.db
      .prepare(
        "SELECT rl.row_id, p.features, rl.label FROM round_labels rl JOIN rounds r ON r.experiment_id = rl.experiment_id AND r.strategy = rl.strategy AND r.round_no = rl.round_no JOIN pool_rows p ON p.experiment_id = rl.experiment_id AND p.strategy = rl.strategy AND p.row_id = rl.row_id WHERE rl.experiment_id = ? AND rl.strategy = ? AND r.status = 'committed' ORDER BY rl.row_id",
      )
      .all(experimentId, strategy) as unknown as Array<{ row_id: number; features: string; label: 0 | 1 }>;
    return [...seedRows, ...committed].map((r) => ({
      id: r.row_id,
      features: JSON.parse(r.features) as number[],
      label: r.label,
    }));
  }

  /** 训练集 = 种子 + 已提交轮标签 + 指定轮已取齐的标签（仅用于轮末训练） */
  private trainingRowsWithRound(experimentId: string, strategy: Strategy, roundNo: number): LabeledRow[] {
    const base = this.trainingRows(experimentId, strategy);
    const current = this.db
      .prepare(
        "SELECT rl.row_id, p.features, rl.label FROM round_labels rl JOIN pool_rows p ON p.experiment_id = rl.experiment_id AND p.strategy = rl.strategy AND p.row_id = rl.row_id WHERE rl.experiment_id = ? AND rl.strategy = ? AND rl.round_no = ? ORDER BY rl.fetch_order",
      )
      .all(experimentId, strategy, roundNo) as unknown as Array<{ row_id: number; features: string; label: 0 | 1 }>;
    return [
      ...base,
      ...current.map((r) => ({ id: r.row_id, features: JSON.parse(r.features) as number[], label: r.label })),
    ];
  }

  private availablePool(experimentId: string, strategy: Strategy): Array<{ id: number; features: number[] }> {
    const rows = this.db
      .prepare(
        "SELECT row_id, features FROM pool_rows WHERE experiment_id = ? AND strategy = ? AND available = 1 ORDER BY row_id",
      )
      .all(experimentId, strategy) as unknown as Array<{ row_id: number; features: string }>;
    return rows.map((r) => ({ id: r.row_id, features: JSON.parse(r.features) as number[] }));
  }

  private selectBatch(
    seed: number,
    strategy: Strategy,
    roundNo: number,
    model: Model,
    pool: Array<{ id: number; features: number[] }>,
  ): number[] {
    if (strategy === "uncertainty") {
      return pool
        .map((p) => ({ id: p.id, score: uncertaintyScore(model, p.features) }))
        .sort((a, b) => a.score - b.score || a.id - b.id)
        .slice(0, BATCH_SIZE)
        .map((p) => p.id);
    }
    const rng = deriveRoundRng(seed, roundNo);
    return sampleWithoutReplacement(pool, BATCH_SIZE, rng).map((p) => p.id);
  }

  private fetchedLabels(experimentId: string, strategy: Strategy, roundNo: number): number[] {
    const rows = this.db
      .prepare(
        "SELECT row_id FROM round_labels WHERE experiment_id = ? AND strategy = ? AND round_no = ? ORDER BY fetch_order",
      )
      .all(experimentId, strategy, roundNo) as unknown as Array<{ row_id: number }>;
    return rows.map((r) => r.row_id);
  }

  private validationAccuracy(experimentId: string, model: Model): number {
    const rows = this.db
      .prepare("SELECT features, label FROM validation_rows WHERE experiment_id = ?")
      .all(experimentId) as unknown as Array<{ features: string; label: 0 | 1 }>;
    if (rows.length === 0) return 0;
    let correct = 0;
    for (const r of rows) {
      if (predict(model, JSON.parse(r.features) as number[]) === r.label) correct++;
    }
    return correct / rows.length;
  }

  private previousBudget(experimentId: string, strategy: Strategy, roundNo: number): number {
    const row = this.db
      .prepare(
        "SELECT cumulative_budget AS b FROM rounds WHERE experiment_id = ? AND strategy = ? AND status = 'committed' AND round_no < ? ORDER BY round_no DESC LIMIT 1",
      )
      .get(experimentId, strategy, roundNo) as { b: number } | undefined;
    return row?.b ?? 0;
  }
}
