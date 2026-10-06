/** 场次输入（创建或替换）。时间区间为左闭右开 [start, end)，单位：整数分钟。 */
export interface SessionInput {
  id: string;
  instructorId: string;
  venueId: string;
  start: number;
  end: number;
  capacity: number; // 1..50
}

/** 场次当前状态（含已确认学员）。 */
export interface SessionState extends SessionInput {
  trainees: string[];
}

/** 某一对重叠场次共享的冲突资源。 */
export type ConflictResource =
  | { kind: 'instructor'; id: string }
  | { kind: 'venue'; id: string }
  | { kind: 'trainee'; id: string };

/** 一对时间重叠的场次及其共享的冲突资源。 */
export interface OverlapConflict {
  sessionIds: [string, string];
  resources: ConflictResource[];
}

/** 报名容量超限。 */
export interface CapacityViolation {
  sessionId: string;
  capacity: number;
  enrolled: number;
}

/** 操作失败时的完整诊断。 */
export interface ConflictReport {
  overlaps: OverlapConflict[];
  capacityViolations: CapacityViolation[];
}

export type BatchResult =
  | { ok: true }
  | { ok: false; report: ConflictReport };

export type EnrollmentResult =
  | { ok: true }
  | { ok: false; report: ConflictReport };
