/** A fixed supply batch: existing inventory or confirmed in-transit supply. */
export interface FixedBatch {
  /** Arrival day. May be -2 or -1 (initial stock) or a day within the horizon. */
  arrivalDay: number;
  /** Quantity in base units (non-negative integer). */
  quantity: number;
}

/** A new purchase order produced by the planner. */
export interface Order {
  /** Day the order arrives (0 = today). */
  arrivalDay: number;
  /** Quantity in base units: positive multiple of packSize, >= MOQ. */
  quantity: number;
}

export interface PlanInput {
  /** Number of planning days, 1..60. Day 0 is today. */
  days: number;
  /** Daily raw-material demand, length === days. */
  demand: number[];
  /** Existing batches (initial stock / confirmed in-transit). */
  fixedBatches: FixedBatch[];
  /** Days on which new purchases are allowed to arrive. */
  allowedArrivalDays: number[];
  /** Purchase lead time in days; order day = arrivalDay - leadTime must be >= 0. */
  leadTime: number;
  /** Pack size; order quantities must be positive multiples of it. */
  packSize: number;
  /** Minimum order quantity. */
  moq: number;
}

export interface PlanSuccess {
  feasible: true;
  orders: Order[];
  totalQuantity: number;
  orderCount: number;
}

export interface PlanInfeasible {
  feasible: false;
}

export type PlanResult = PlanSuccess | PlanInfeasible;

/** Per-day simulation outcome produced by replay. */
export interface DayRecord {
  day: number;
  /** Quantity consumed to satisfy the day's demand. */
  consumed: number;
  /** Quantity that expired at the start of the day. */
  expired: number;
  /** On-hand balance at the end of the day (after consumption). */
  balance: number;
}

export interface ReplayResult {
  feasible: boolean;
  days: DayRecord[];
  /** Total purchased quantity across all replayed orders. */
  totalQuantity: number;
  /** Number of orders. */
  orderCount: number;
  /** First day on which demand could not be met, if any. */
  shortageDay?: number;
  /** Validation problems with the supplied orders, if any. */
  errors: string[];
}
