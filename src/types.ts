/** 周期常量：52 周，每周 3 次训练，每次每动作 3 组，目标每组 10 次。 */
export const WEEKS_PER_CYCLE = 52;
export const SESSIONS_PER_WEEK = 3;
export const SETS_PER_SESSION = 3;
export const TARGET_REPS = 10;
export const MAX_EXERCISES_PER_EMPLOYEE = 20;
export const WEEKS_PER_SEGMENT = 2;
export const SEGMENTS_PER_CYCLE = WEEKS_PER_CYCLE / WEEKS_PER_SEGMENT; // 26
export const SETS_PER_SEGMENT =
  WEEKS_PER_SEGMENT * SESSIONS_PER_WEEK * SETS_PER_SESSION; // 18
export const INITIAL_RECOMMENDATION_LBS = 40;
export const RECOMMENDATION_STEP_LBS = 5;

/** 一组训练的唯一定位。 */
export interface SetKey {
  employeeId: string;
  exerciseId: string;
  /** 1..52 */
  week: number;
  /** 1..3（周内的第几次训练） */
  session: number;
  /** 1..3（一次训练内的第几组） */
  set: number;
}

/** 一组训练的实际记录。 */
export interface SetEntry {
  weightLbs: number;
  reps: number;
}

/** 批次内对一组的操作：录入/更正（提供 entry）或撤回（entry 省略）。 */
export interface SetOperation {
  key: SetKey;
  /** 该操作所依据的组版本；从未录入过的组为 0。 */
  baseVersion: number;
  /** 省略表示撤回该组记录。 */
  entry?: SetEntry;
}

/** 提交成功后的凭据。 */
export interface CommitReceipt {
  /** 唯一提交凭据。 */
  commitId: string;
  /** 提交后的已提交版本（单调递增）。 */
  committedVersion: number;
  /** 对应的批次标识。 */
  batchId: string;
}

/** 一段（2 周）内某动作的读取结果。 */
export interface ExerciseSegmentView {
  exerciseId: string;
  /** 该段推荐重量（磅）。 */
  recommendationLbs: number;
  /** 该段 18 组的记录；未记录的组为 null。 */
  sets: Array<SetEntry | null>;
}

/** 一段的完整读取结果（全部动作）。 */
export interface SegmentView {
  /** 1..26 */
  segment: number;
  committedVersion: number;
  exercises: ExerciseSegmentView[];
}

export type RejectReason =
  | "VERSION_CONFLICT"
  | "BATCH_ID_CONFLICT"
  | "INVALID_OPERATION"
  | "CYCLE_NOT_FOUND"
  | "BATCH_ALREADY_CLOSED";

export class CommitRejected extends Error {
  readonly reason: RejectReason;
  constructor(reason: RejectReason, message: string) {
    super(message);
    this.name = "CommitRejected";
    this.reason = reason;
  }
}
