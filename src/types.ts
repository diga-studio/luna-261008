export type Label = 0 | 1;

export interface DataRow {
  id: number;
  features: number[];
  label: Label;
}

export interface ExperimentData {
  /** labeled seed set (contains both classes) */
  seed: DataRow[];
  /** candidate pool; labels are the hidden truth (oracle) */
  pool: DataRow[];
  /** independent validation set, used only for scoring */
  validation: DataRow[];
}

export type Strategy = "uncertainty" | "random";

export const STRATEGIES: readonly Strategy[] = ["uncertainty", "random"];

export interface RoundResult {
  round: number;
  /** selected candidate ids, in selection order */
  selectedIds: number[];
  /** cumulative committed label budget (seed labels not counted) */
  budget: number;
  /** validation accuracy after training on this round's committed labels */
  valAccuracy: number;
}

export interface ExperimentResults {
  experimentId: string;
  strategies: Record<Strategy, RoundResult[]>;
}

export interface Kernel {
  createExperiment(data: ExperimentData, seed: number): string;
  runRound(experimentId: string, strategy: Strategy, roundNo: number): RoundResult;
  readResults(experimentId: string): ExperimentResults;
  close(): void;
}
