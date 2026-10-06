/** IANA time zone name, e.g. "America/New_York". */
export type TimeZone = string;

/** A schedule rule: a time zone plus exactly one recurrence kind. */
export type ScheduleRule =
  | { kind: "every-15-minutes"; timeZone: TimeZone }
  | { kind: "hourly"; timeZone: TimeZone }
  | { kind: "daily"; timeZone: TimeZone; hour: number; minute: number }
  | { kind: "weekly"; timeZone: TimeZone; weekday: number; hour: number; minute: number };

/** A named schedule: unique id plus one rule. */
export interface Schedule {
  scheduleId: string;
  rule: ScheduleRule;
}

/** One trigger item inside a due window. */
export interface DueItem {
  scheduleId: string;
  /** UTC millisecond timestamp at which the schedule fires. */
  time: number;
}

/** A page of due items plus an opaque cursor for the next page. */
export interface DuePage {
  items: DueItem[];
  /** Pass as `cursor` to fetch the next page; null when the window is exhausted. */
  nextCursor: string | null;
}
