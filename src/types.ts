export interface FixedBatch {
  /** Arrival day: -2 or -1 means initial stock, 0..N-1 means confirmed in-transit. */
  arrivalDay: number;
  quantity: number;
}

export interface PlanInput {
  /** Number of planning days, 1..60. Day 0 is today. */
  days: number;
  /** Daily demand, length === days, non-negative integers. */
  demand: number[];
  /** Existing batches (initial stock or confirmed in-transit). */
  fixedBatches: FixedBatch[];
  /** Days on which new purchases are allowed to arrive. */
  allowedArrivalDays: number[];
  leadTime: number;
  packSize: number;
  moq: number;
}

export interface Order {
  arrivalDay: number;
  quantity: number;
}

export type PlanResult =
  | { feasible: true; orders: Order[]; totalQuantity: number; orderCount: number }
  | { feasible: false };

export interface DailyRecord {
  day: number;
  consumed: number;
  expired: number;
  endBalance: number;
}

export interface ReplayResult {
  feasible: boolean;
  /** Present when the orders themselves are invalid (rule violation). */
  error?: string;
  daily: DailyRecord[];
  totalConsumed: number;
  totalExpired: number;
}
