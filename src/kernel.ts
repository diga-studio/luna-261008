import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./db";
import { accuracy, classMeans, selectUncertainty } from "./model";
import { hashSeed, mulberry32 } from "./prng";
import {
  DataRow,
  ExperimentData,
  ExperimentResults,
  Kernel,
  Label,
  RoundResult,
  Strategy,
  STRATEGIES,
} from "./types";

const BATCH_SIZE = 32;
const MAX_ROUNDS = 20;

/** test-only hooks, invoked synchronously inside the kernel */
export const __testHooks: {
  afterLabelPersisted?: (info: { experimentId: string; strategy: Strategy; round: number; count: number }) => void;
  afterCommit?: (info: { experimentId: string; strategy: Strategy; round: number }) => void;
} = {};

interface StrategyState {
  committedRounds: number;
  budget: number;
  trainIds: number[];
  poolIds: number[];
}

interface RoundRow {
  status: string;
  selection: number[];
  trainVersion: string;
  labels: Record<string, Label>;
  accuracy: number | null;
  budget: number | null;
}

function validateDataset(data: ExperimentData): void {
  const all = [...data.seed, ...data.pool, ...data.validation];
  if (all.length === 0 || all.length > 10000) throw new Error("dataset must contain 1..10000 rows");
  if (data.seed.length === 0) throw new Error("seed set must not be empty");
  if (data.validation.length === 0) throw new Error("validation set must not be empty");
  const ids = new Set<number>();
  let dims = -1;
  for (const row of all) {
    if (!Number.isInteger(row.id)) throw new Error("row id must be an integer");
    if (ids.has(row.id)) throw new Error(`duplicate row id ${row.id}`);
    ids.add(row.id);
    if (row.label !== 0 && row.label !== 1) throw new Error("label must be 0 or 1");
    if (!Array.isArray(row.features) || row.features.length === 0 || row.features.length > 256) {
      throw new Error("features must have 1..256 dimensions");
    }
    if (dims === -1) dims = row.features.length;
    if (row.features.length !== dims) throw new Error("inconsistent feature dimensions");
  }
  const classes = new Set(data.seed.map((r) => r.label));
  if (classes.size !== 2) throw new Error("seed set must contain both classes");
}

export function openKernel(dbPath: string): Kernel {
  const db: DatabaseSync = openDatabase(dbPath);

  const stmtInsertExp = db.prepare("INSERT INTO experiments (id, seed) VALUES (?, ?)");
  const stmtInsertSeed = db.prepare("INSERT INTO seed_rows (exp_id, row_id, features, label) VALUES (?, ?, ?, ?)");
  const stmtInsertPool = db.prepare("INSERT INTO pool_rows (exp_id, row_id, features, label) VALUES (?, ?, ?, ?)");
  const stmtInsertVal = db.prepare("INSERT INTO val_rows (exp_id, row_id, features, label) VALUES (?, ?, ?, ?)");
  const stmtInitState = db.prepare(
    "INSERT INTO strategy_state (exp_id, strategy, committed_rounds, budget, train_ids, pool_ids) VALUES (?, ?, 0, 0, '[]', ?)"
  );
  const stmtGetExp = db.prepare("SELECT seed FROM experiments WHERE id = ?");
  const stmtGetState = db.prepare(
    "SELECT committed_rounds, budget, train_ids, pool_ids FROM strategy_state WHERE exp_id = ? AND strategy = ?"
  );
  const stmtGetRound = db.prepare(
    "SELECT status, selection, train_version, labels, accuracy, budget FROM rounds WHERE exp_id = ? AND strategy = ? AND round_no = ?"
  );
  const stmtInsertRound = db.prepare(
    "INSERT INTO rounds (exp_id, strategy, round_no, status, selection, train_version, labels) VALUES (?, ?, ?, 'labeling', ?, ?, '{}')"
  );
  const stmtUpdateLabels = db.prepare(
    "UPDATE rounds SET labels = ? WHERE exp_id = ? AND strategy = ? AND round_no = ?"
  );
  const stmtCommitRound = db.prepare(
    "UPDATE rounds SET status = 'committed', accuracy = ?, budget = ? WHERE exp_id = ? AND strategy = ? AND round_no = ?"
  );
  const stmtUpdateState = db.prepare(
    "UPDATE strategy_state SET committed_rounds = ?, budget = ?, train_ids = ?, pool_ids = ? WHERE exp_id = ? AND strategy = ?"
  );
  const stmtSeedRows = db.prepare("SELECT row_id, features, label FROM seed_rows WHERE exp_id = ? ORDER BY row_id");
  const stmtPoolRow = db.prepare("SELECT features, label FROM pool_rows WHERE exp_id = ? AND row_id = ?");
  const stmtPoolLabel = db.prepare("SELECT label FROM pool_rows WHERE exp_id = ? AND row_id = ?");
  const stmtValRows = db.prepare("SELECT features, label FROM val_rows WHERE exp_id = ? ORDER BY row_id");
  const stmtCommittedLabels = db.prepare(
    "SELECT labels FROM rounds WHERE exp_id = ? AND strategy = ? AND status = 'committed' ORDER BY round_no"
  );
  const stmtCommittedRounds = db.prepare(
    "SELECT round_no, selection, accuracy, budget FROM rounds WHERE exp_id = ? AND strategy = ? AND status = 'committed' ORDER BY round_no"
  );

  function createExperiment(data: ExperimentData, seed: number): string {
    validateDataset(data);
    if (!Number.isInteger(seed)) throw new Error("seed must be an integer");
    const id = randomUUID();
    const poolIds = JSON.stringify(data.pool.map((r) => r.id));
    db.exec("BEGIN");
    try {
      stmtInsertExp.run(id, seed);
      for (const row of data.seed) stmtInsertSeed.run(id, row.id, JSON.stringify(row.features), row.label);
      for (const row of data.pool) stmtInsertPool.run(id, row.id, JSON.stringify(row.features), row.label);
      for (const row of data.validation) stmtInsertVal.run(id, row.id, JSON.stringify(row.features), row.label);
      for (const strategy of STRATEGIES) stmtInitState.run(id, strategy, poolIds);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return id;
  }

  function requireExperiment(experimentId: string): number {
    const row = stmtGetExp.get(experimentId) as { seed: number } | undefined;
    if (!row) throw new Error(`unknown experiment ${experimentId}`);
    return row.seed;
  }

  function loadState(experimentId: string, strategy: Strategy): StrategyState {
    const row = stmtGetState.get(experimentId, strategy) as
      | { committed_rounds: number; budget: number; train_ids: string; pool_ids: string }
      | undefined;
    if (!row) throw new Error(`missing state for ${experimentId}/${strategy}`);
    return {
      committedRounds: row.committed_rounds,
      budget: row.budget,
      trainIds: JSON.parse(row.train_ids) as number[],
      poolIds: JSON.parse(row.pool_ids) as number[],
    };
  }

  function loadRound(experimentId: string, strategy: Strategy, roundNo: number): RoundRow | null {
    const row = stmtGetRound.get(experimentId, strategy, roundNo) as
      | { status: string; selection: string; train_version: string; labels: string; accuracy: number | null; budget: number | null }
      | undefined;
    if (!row) return null;
    return {
      status: row.status,
      selection: JSON.parse(row.selection) as number[],
      trainVersion: row.train_version,
      labels: JSON.parse(row.labels) as Record<string, Label>,
      accuracy: row.accuracy,
      budget: row.budget,
    };
  }

  function trainRowsFor(experimentId: string, strategy: Strategy): DataRow[] {
    const rows: DataRow[] = [];
    for (const r of stmtSeedRows.iterate(experimentId) as Iterable<{ row_id: number; features: string; label: number }>) {
      rows.push({ id: r.row_id, features: JSON.parse(r.features), label: r.label as Label });
    }
    // only labels committed by THIS strategy enter its training set
    for (const r of stmtCommittedLabels.iterate(experimentId, strategy) as Iterable<{ labels: string }>) {
      const labels = JSON.parse(r.labels) as Record<string, Label>;
      for (const [idText, label] of Object.entries(labels)) {
        const id = Number(idText);
        const p = stmtPoolRow.get(experimentId, id) as { features: string; label: number };
        rows.push({ id, features: JSON.parse(p.features), label });
      }
    }
    return rows;
  }

  function trainVersionOf(rows: DataRow[]): string {
    let text = "";
    for (const r of rows) text += `${r.id}:${r.label};`;
    return String(hashSeed(text));
  }

  function selectBatch(experimentId: string, seed: number, strategy: Strategy, roundNo: number, state: StrategyState, trainRows: DataRow[]): number[] {
    const k = Math.min(BATCH_SIZE, state.poolIds.length);
    if (strategy === "random") {
      const rand = mulberry32(hashSeed(seed, "random", roundNo));
      const shuffled = [...state.poolIds];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      return shuffled.slice(0, k);
    }
    const model = classMeans(trainRows);
    const poolRows = state.poolIds.map((id) => {
      const r = stmtPoolRow.get(experimentId, id) as { features: string; label: number };
      return { id, features: JSON.parse(r.features) as number[] };
    });
    return selectUncertainty(poolRows, model, k);
  }

  function runRound(experimentId: string, strategy: Strategy, roundNo: number): RoundResult {
    if (!STRATEGIES.includes(strategy)) throw new Error(`unknown strategy ${strategy}`);
    if (!Number.isInteger(roundNo) || roundNo < 1) throw new Error("roundNo must be a positive integer");
    if (roundNo > MAX_ROUNDS) throw new Error(`exceeds max rounds (${MAX_ROUNDS})`);
    const seed = requireExperiment(experimentId);
    const state = loadState(experimentId, strategy);

    if (roundNo <= state.committedRounds) {
      const committed = loadRound(experimentId, strategy, roundNo);
      if (!committed || committed.status !== "committed") throw new Error(`round ${roundNo} not committed`);
      return { round: roundNo, selectedIds: committed.selection, budget: committed.budget!, valAccuracy: committed.accuracy! };
    }
    if (roundNo > state.committedRounds + 1) {
      throw new Error(`round ${roundNo} out of order; next round is ${state.committedRounds + 1}`);
    }

    const trainRows = trainRowsFor(experimentId, strategy);
    const trainVersion = trainVersionOf(trainRows);

    let round = loadRound(experimentId, strategy, roundNo);
    if (!round) {
      if (state.poolIds.length === 0) throw new Error("pool exhausted");
      const selection = selectBatch(experimentId, seed, strategy, roundNo, state, trainRows);
      stmtInsertRound.run(experimentId, strategy, roundNo, JSON.stringify(selection), trainVersion);
      round = loadRound(experimentId, strategy, roundNo)!;
    } else if (round.status === "committed") {
      return { round: roundNo, selectedIds: round.selection, budget: round.budget!, valAccuracy: round.accuracy! };
    } else if (round.trainVersion !== trainVersion) {
      throw new Error(`train input version mismatch for round ${roundNo}`);
    }

    const labels = round.labels;
    for (const id of round.selection) {
      if (labels[String(id)] !== undefined) continue;
      const row = stmtPoolLabel.get(experimentId, id) as { label: number } | undefined;
      if (!row) throw new Error(`oracle label missing for row ${id}`);
      labels[String(id)] = row.label as Label;
      stmtUpdateLabels.run(JSON.stringify(labels), experimentId, strategy, roundNo);
      __testHooks.afterLabelPersisted?.({
        experimentId,
        strategy,
        round: roundNo,
        count: Object.keys(labels).length,
      });
    }

    const newTrainRows = trainRows.concat(
      round.selection.map((id) => {
        const r = stmtPoolRow.get(experimentId, id) as { features: string; label: number };
        return { id, features: JSON.parse(r.features) as number[], label: labels[String(id)] };
      })
    );
    const model = classMeans(newTrainRows);
    const valRows = [...stmtValRows.iterate(experimentId)] as { features: string; label: number }[];
    const acc = accuracy(
      model,
      valRows.map((r) => ({ features: JSON.parse(r.features) as number[], label: r.label as Label }))
    );
    const newBudget = state.budget + round.selection.length;
    const newTrainIds = state.trainIds.concat(round.selection);
    const selected = new Set(round.selection);
    const newPoolIds = state.poolIds.filter((id) => !selected.has(id));

    db.exec("BEGIN");
    try {
      stmtCommitRound.run(acc, newBudget, experimentId, strategy, roundNo);
      stmtUpdateState.run(roundNo, newBudget, JSON.stringify(newTrainIds), JSON.stringify(newPoolIds), experimentId, strategy);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    __testHooks.afterCommit?.({ experimentId, strategy, round: roundNo });
    return { round: roundNo, selectedIds: round.selection, budget: newBudget, valAccuracy: acc };
  }

  function readResults(experimentId: string): ExperimentResults {
    requireExperiment(experimentId);
    const strategies = {} as Record<Strategy, RoundResult[]>;
    for (const strategy of STRATEGIES) {
      const rows = stmtCommittedRounds.all(experimentId, strategy) as {
        round_no: number;
        selection: string;
        accuracy: number;
        budget: number;
      }[];
      strategies[strategy] = rows.map((r) => ({
        round: r.round_no,
        selectedIds: JSON.parse(r.selection) as number[],
        budget: r.budget,
        valAccuracy: r.accuracy,
      }));
    }
    return { experimentId, strategies };
  }

  return {
    createExperiment,
    runRound,
    readResults,
    close: () => db.close(),
  };
}
