/** 整数毫秒时间戳 */
export type Timestamp = number;

/** 左闭右开时段 [start, end) */
export interface TimeRange {
  start: Timestamp;
  end: Timestamp;
}

/** 教员资源：多个可用时段（可重叠或相接，按并集判断） */
export interface InstructorResource {
  id: string;
  availability: TimeRange[];
}

/** 场地资源：固定人数容量，可同时容纳多场课 */
export interface VenueResource {
  id: string;
  capacity: number;
}

/** 初始化配置：资源与无冲突的初始日程 */
export interface SchedulerConfig {
  instructors: InstructorResource[];
  venues: VenueResource[];
  sessions?: Session[];
}

/** 一场课 */
export interface Session {
  id: string;
  start: Timestamp;
  end: Timestamp;
  instructorId: string;
  venueId: string;
  traineeIds: string[];
}

/** 批次变更：每个 id 至多出现一次 */
export type BatchChange =
  | { kind: "add"; session: Session }
  | { kind: "replace"; session: Session }
  | { kind: "delete"; sessionId: string };

export type ResourceKind = "instructor" | "venue" | "trainee";

/** 负载超过容量 */
export interface OverbookedConflict {
  type: "overbooked";
  resourceKind: ResourceKind;
  resourceId: string;
  /** 违规发生的时刻区间（负载超容的时间段） */
  start: Timestamp;
  end: Timestamp;
  /** 该时段内的负载与容量 */
  load: number;
  capacity: number;
  /** 参与超载的场次 id */
  sessionIds: string[];
}

/** 仅教员：该时刻有课但不在可用时段并集内 */
export interface UnavailableConflict {
  type: "unavailable";
  resourceKind: "instructor";
  resourceId: string;
  /** 不在可用时段内的违规时间区间 */
  start: Timestamp;
  end: Timestamp;
  /** 涉及该违规区间的场次 id */
  sessionIds: string[];
}

export type Conflict = OverbookedConflict | UnavailableConflict;

export interface ConflictReport {
  conflicts: Conflict[];
}

export type BatchResult =
  | { ok: true }
  | { ok: false; report: ConflictReport };
