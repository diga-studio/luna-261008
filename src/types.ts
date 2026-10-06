// Domain constants for a training cycle.
export const WEEKS_PER_CYCLE = 52;
export const SESSIONS_PER_WEEK = 3;
export const SETS_PER_SESSION = 3;
export const TARGET_REPS = 10;
export const SEGMENT_WEEKS = 2;
export const SEGMENT_COUNT = WEEKS_PER_CYCLE / SEGMENT_WEEKS; // 26
export const SESSIONS_PER_SEGMENT = SEGMENT_WEEKS * SESSIONS_PER_WEEK; // 6
export const SETS_PER_SEGMENT = SESSIONS_PER_SEGMENT * SETS_PER_SESSION; // 18
export const SETS_PER_EXERCISE = WEEKS_PER_CYCLE * SESSIONS_PER_WEEK * SETS_PER_SESSION; // 468
export const INITIAL_LOAD_LBS = 40;
export const INCREMENT_LBS = 5;
export const MAX_EXERCISES = 20;

/** Identifies one set within an employee's cycle. All fields are 1-based. */
export interface SetKey {
  exerciseIndex: number; // 1..exerciseCount (<= 20)
  week: number; // 1..52
  session: number; // 1..3
  setIndex: number; // 1..3
}

export interface SetRecord extends SetKey {
  weightLbs: number;
  reps: number;
}

/** A set record as seen in a read view, tagged with its version. */
export interface VersionedSetRecord extends SetRecord {
  /** Commit sequence that last changed this set (what submissions base on). */
  version: number;
}

/**
 * Version a submission is based on. 0 means "the set has never been
 * recorded". Otherwise it is the commit sequence that last changed the set.
 */
export type SetVersion = number;

export interface UpsertOp {
  kind: 'upsert';
  key: SetKey;
  weightLbs: number;
  reps: number;
  baseVersion: SetVersion;
}

export interface WithdrawOp {
  kind: 'withdraw';
  key: SetKey;
  baseVersion: SetVersion;
}

export type BatchOp = UpsertOp | WithdrawOp;

export type CommitResult =
  | { ok: true; credential: string; commitSeq: number }
  | { ok: false; reason: string; conflicts: SetKey[] };

/** An open, not-yet-committed batch. Content may be added asynchronously. */
export interface BatchHandle {
  readonly employeeId: string;
  readonly batchId: string;
  add(op: BatchOp): void;
  commit(): Promise<CommitResult>;
  abort(): void;
}

/**
 * A consistent read view: all sets, curves and the version come from the
 * same committed state, regardless of later commits.
 */
export interface ReadView {
  readonly employeeId: string;
  /** Commit sequence this view is pinned to. */
  readonly commitSeq: number;
  /**
   * 18 slots (week, session, setIndex order) for one exercise and one
   * 0-based segment; null = no record at this view's committed state.
   */
  readSegmentSets(exerciseIndex: number, segmentIndex: number): (VersionedSetRecord | null)[];
  /** Recommended load per exercise per segment: [exerciseIndex-1][segment]. */
  readCurve(): number[][];
  close(): void;
}

export interface TrainingModule {
  createCycle(employeeId: string, exerciseCount: number): void;
  beginBatch(employeeId: string, batchId: string): BatchHandle;
  openView(employeeId: string): ReadView;
  close(): void;
}
