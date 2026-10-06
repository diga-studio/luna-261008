export interface CostDocument {
  /** Unique document identifier. */
  id: string;
  /** Non-negative amount as decimal text with at most 4 fractional digits. */
  amount: string;
  /** Integer weight per department; weights must sum to 10000. */
  weights: Record<string, number>;
}

export interface AllocationInput {
  /** Common department list shared by all documents. */
  departments: string[];
  documents: CostDocument[];
}

export interface AllocationDetail {
  documentId: string;
  department: string;
  /** Ideal allocation, exact decimal text (up to 8 fractional digits). */
  idealAmount: string;
  /** Actual allocation, decimal text with exactly 4 fractional digits. */
  amount: string;
}

export interface DepartmentSummary {
  department: string;
  /** Sum of ideal allocations, exact decimal text. */
  idealAmount: string;
  /** Sum of actual allocations, 4 fractional digits. */
  amount: string;
  /** amount - idealAmount, signed exact decimal text. */
  deviation: string;
}

export interface AllocationResult {
  details: AllocationDetail[];
  departmentSummaries: DepartmentSummary[];
  /** Batch total, equals the sum of all document amounts. */
  totalAmount: string;
  /** Max absolute department deviation, exact decimal text. */
  maxDepartmentDeviation: string;
}
