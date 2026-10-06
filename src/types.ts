/** IANA time zone name, e.g. "America/New_York". */
export type TimeZone = string;

/** Every 15 minutes: fires at local minutes 00, 15, 30, 45. */
export interface Every15MinutesRule {
  readonly kind: "every15Minutes";
  readonly timeZone: TimeZone;
}

/** Hourly: fires at local minute 00. */
export interface HourlyRule {
  readonly kind: "hourly";
  readonly timeZone: TimeZone;
}

/** Daily: fires at the given local hour/minute. */
export interface DailyRule {
  readonly kind: "daily";
  readonly timeZone: TimeZone;
  readonly hour: number; // 0-23
  readonly minute: number; // 0-59
}

/** Weekly: fires at the given local weekday (Mon=1..Sun=7), hour, minute. */
export interface WeeklyRule {
  readonly kind: "weekly";
  readonly timeZone: TimeZone;
  readonly weekday: number; // 1 (Monday) - 7 (Sunday)
  readonly hour: number; // 0-23
  readonly minute: number; // 0-59
}

export type ScheduleRule =
  | Every15MinutesRule
  | HourlyRule
  | DailyRule
  | WeeklyRule;

export interface Schedule {
  readonly scheduleId: string;
  readonly rule: ScheduleRule;
}

/** A single due occurrence: schedule `scheduleId` fires at UTC instant `at` (ms). */
export interface DueItem {
  readonly scheduleId: string;
  readonly at: number;
}

/** Opaque pagination cursor for pageDue. */
export type PageCursor = string;

export interface PageResult {
  readonly items: readonly DueItem[];
  /** Present when more items remain in the window; pass back as `cursor`. */
  readonly nextCursor?: PageCursor;
}
