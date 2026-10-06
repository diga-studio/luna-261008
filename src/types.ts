/**
 * Public types for the clinical cost allocation library.
 *
 * Amounts are decimal text with up to 4 fractional digits (general-ledger
 * precision). Ideal (unrounded) amounts are tracked internally at 1e-8
 * precision and never pre-rounded.
 */

/** Weight of one department on a single cost document. */
export interface DepartmentWeight {
  /** Department identifier, must appear in the batch department list. */
  departmentId: string;
  /** Integer weight in [0, 10000]. Weights of a document must sum to 10000. */
  weight: number;
}

/** One cost document (pharmacy / lab / nursing charge). */
export interface CostDocument {
  /** Unique document identifier within the batch. */
  documentId: string;
  /** Non-negative amount as decimal text, at most 4 fractional digits. */
  amount: string;
  /** Per-department integer weights; missing departments count as 0. */
  weights: DepartmentWeight[];
}

/** A batch of cost documents sharing one department list. */
export interface AllocationBatch {
  /** Shared department list for the whole batch. */
  departments: string[];
  /** Cost documents to allocate. */
  documents: CostDocument[];
}

/** Allocation of one document to one department. */
export interface AllocationDetail {
  documentId: string;
  departmentId: string;
  /** Ideal (unrounded) share, decimal text with up to 8 fractional digits. */
  idealAmount: string;
  /** Actual allocated amount, decimal text with exactly 4 fractional digits. */
  actualAmount: string;
  /** |actual - ideal|, decimal text with up to 8 fractional digits. */
  deviation: string;
}

/** Aggregated allocation of one department across the batch. */
export interface DepartmentSummary {
  departmentId: string;
  /** Sum of ideal shares (unrounded), decimal text. */
  idealAmount: string;
  /** Sum of actual allocations, decimal text with exactly 4 fractional digits. */
  actualAmount: string;
  /** |actual - ideal|, decimal text. */
  deviation: string;
}

/** Batch-level totals and optimality metrics. */
export interface AllocationTotals {
  /** Sum of all ideal shares (equals sum of document amounts). */
  idealAmount: string;
  /** Sum of all actual allocations (equals idealAmount at 4-decimal scale). */
  actualAmount: string;
  /** max over departments of |actual sum - ideal sum| (globally minimized). */
  maxDepartmentDeviation: string;
  /** Sum of |actual - ideal| over all document/department cells (minimized). */
  totalDetailDeviation: string;
}

/** Full allocation result: per-document details plus department summaries. */
export interface AllocationResult {
  details: AllocationDetail[];
  departments: DepartmentSummary[];
  totals: AllocationTotals;
}
