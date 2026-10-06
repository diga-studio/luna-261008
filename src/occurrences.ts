import { utcInstantsForWallTime, wallClockAt } from "./timezone.js";
import type { ScheduleRule } from "./types.js";

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const QUARTER = 15 * MINUTE;

/**
 * A wall-clock step can map to UTC instants at most this far apart, because
 * IANA offsets span well under 24h. A buffered candidate older than the
 * current wall step minus this margin can never be overtaken by a later step.
 */
const SAFE_SPAN = 48 * HOUR;

function weekdayOf(wallMs: number): number {
  const sunday0 = new Date(wallMs).getUTCDay();
  return ((sunday0 + 6) % 7) + 1;
}

function validate(rule: ScheduleRule): void {
  if (rule.kind === "daily" || rule.kind === "weekly") {
    if (!Number.isInteger(rule.hour) || rule.hour < 0 || rule.hour > 23) {
      throw new RangeError(`hour must be an integer in [0, 23], got ${rule.hour}`);
    }
    if (!Number.isInteger(rule.minute) || rule.minute < 0 || rule.minute > 59) {
      throw new RangeError(`minute must be an integer in [0, 59], got ${rule.minute}`);
    }
  }
  if (rule.kind === "weekly") {
    if (!Number.isInteger(rule.weekday) || rule.weekday < 1 || rule.weekday > 7) {
      throw new RangeError(`weekday must be an integer in [1, 7], got ${rule.weekday}`);
    }
  }
}

interface WallPlan {
  firstStep: number;
  stepMs: number;
  matches: (wallMs: number) => boolean;
}

function planFor(rule: ScheduleRule, after: number): WallPlan {
  const wall = wallClockAt(after, rule.timeZone);
  switch (rule.kind) {
    case "every-15-minutes":
      return {
        firstStep: Math.floor(wallClockMs(wall) / QUARTER) * QUARTER,
        stepMs: QUARTER,
        matches: () => true,
      };
    case "hourly":
      return {
        firstStep: Math.floor(wallClockMs(wall) / QUARTER) * QUARTER,
        stepMs: QUARTER,
        matches: (wallMs) => wallMs % HOUR === 0,
      };
    case "daily":
      return {
        firstStep: Date.UTC(wall.year, wall.month - 1, wall.day, rule.hour, rule.minute),
        stepMs: DAY,
        matches: () => true,
      };
    case "weekly":
      return {
        firstStep: Date.UTC(wall.year, wall.month - 1, wall.day, rule.hour, rule.minute),
        stepMs: DAY,
        matches: (wallMs) => weekdayOf(wallMs) === rule.weekday,
      };
  }
}

function wallClockMs(wall: ReturnType<typeof wallClockAt>): number {
  return (
    Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) +
    wall.millisecond
  );
}

function insertSorted(buffer: number[], value: number): void {
  let lo = 0;
  let hi = buffer.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (buffer[mid]! < value) lo = mid + 1;
    else hi = mid;
  }
  buffer.splice(lo, 0, value);
}

/**
 * Infinite ascending stream of trigger instants strictly after `after`.
 * Consumers must stop pulling once they have enough; the generator only
 * yields instants that are provably final (no later wall step can produce
 * an earlier instant).
 */
function* generate(rule: ScheduleRule, after: number): Generator<number, never, void> {
  validate(rule);
  const plan = planFor(rule, after);
  const buffer: number[] = [];
  let wallCursor = plan.firstStep;
  for (;;) {
    if (plan.matches(wallCursor)) {
      for (const instant of utcInstantsForWallTime(wallCursor, rule.timeZone)) {
        if (instant > after) {
          insertSorted(buffer, instant);
        }
      }
    }
    const safeHorizon = wallCursor - SAFE_SPAN;
    while (buffer.length > 0 && buffer[0]! < safeHorizon) {
      yield buffer.shift()!;
    }
    wallCursor += plan.stepMs;
  }
}

/**
 * The first `limit` trigger instants (UTC ms) of `rule` strictly after
 * `after`, ascending.
 */
export function nextOccurrences(rule: ScheduleRule, after: number, limit: number): number[] {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new RangeError(`limit must be a non-negative integer, got ${limit}`);
  }
  const result: number[] = [];
  if (limit === 0) return result;
  for (const instant of generate(rule, after)) {
    result.push(instant);
    if (result.length === limit) break;
  }
  return result;
}

/** Every trigger instant of `rule` in the half-open window (fromMs, toMs]. */
export function occurrencesInWindow(rule: ScheduleRule, fromMs: number, toMs: number): number[] {
  const result: number[] = [];
  if (toMs <= fromMs) return result;
  for (const instant of generate(rule, fromMs)) {
    if (instant > toMs) break;
    result.push(instant);
  }
  return result;
}
