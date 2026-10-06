export type Strategy = "uncertainty" | "random";

export interface LabeledRow {
  id: number;
  features: number[];
  label: 0 | 1;
}

export interface CandidateRow {
  id: number;
  features: number[];
  /** 隐藏真值，仅 oracle 可取 */
  truth: 0 | 1;
}

export interface ExperimentData {
  seed: LabeledRow[];
  pool: CandidateRow[];
  validation: LabeledRow[];
}

export interface RoundResult {
  roundNo: number;
  selectedIds: number[];
  cumulativeBudget: number;
  validationAccuracy: number;
}

export interface ExperimentResults {
  experimentId: string;
  strategies: Record<Strategy, { rounds: RoundResult[] }>;
}

export interface Model {
  mean0: number[];
  mean1: number[];
}
