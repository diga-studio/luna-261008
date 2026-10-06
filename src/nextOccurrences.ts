import { localToUtc, utcToLocal } from "./timezone.js";
import type { ScheduleRule } from "./types.js";

/**
 * Safety margin covering any UTC-offset magnitude (max is 14h) plus any
 * historical overlap span, so wall-clock slots this far before/after an
 * instant can never resolve to a UTC instant on the other side of it.
 */
const MARGIN_MS = 2 * 24 * 3600_000;

const MINUTE_MS = 60_000;
const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;

function validate(rule: ScheduleRule): void {
  // Validates the IANA zone eagerly (unknown zones throw RangeError).
  utcToLocal(0, rule.timeZone);
  if (rule.kind === "daily" || rule.kind === "weekly") {
    if (
      !Number.isInteger(rule.hour) ||
      rule.hour < 0 ||
      rule.hour > 23 ||
      !Number.isInteger(rule.minute) ||
      rule.minute < 0 ||
      rule.minute > 59
    ) {
      throw new RangeError(`invalid time of day: ${rule.hour}:${rule.minute}`);
    }
  }
  if (rule.kind === "weekly") {
    if (
      !Number.isInteger(rule.weekday) ||
      rule.weekday < 1 ||
      rule.weekday > 7
    ) {
      throw new RangeError(`invalid weekday: ${rule.weekday}`);
    }
  }
}

interface SlotCursor {
  /** Pseudo-UTC ms of the next wall-clock slot to try. */
  next: number;
  /** Advance the cursor by one period (in wall-clock terms). */
  step: number;
}

/**
 * First wall-clock slot (as pseudo-UTC ms) whose UTC resolution could still
 * fall strictly after `after`, plus the wall-clock step between slots.
 */
function slotCursor(rule: ScheduleRule, after: number): SlotCursor {
  const local = utcToLocal(after, rule.timeZone);
  const wallNow = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second,
  );
  // Start early enough that overlap-second-occurrences just before `after`
  // in wall time are still considered; the `> after` filter drops the rest.
  const start = wallNow - MARGIN_MS;
  switch (rule.kind) {
    case "every15Minutes": {
      const slot = Math.floor(start / (15 * MINUTE_MS)) * (15 * MINUTE_MS);
      return { next: slot, step: 15 * MINUTE_MS };
    }
    case "hourly": {
      const slot = Math.floor(start / HOUR_MS) * HOUR_MS;
      return { next: slot, step: HOUR_MS };
    }
    case "daily": {
      const dayStart = Math.floor(start / DAY_MS) * DAY_MS;
      return {
        next: dayStart + rule.hour * HOUR_MS + rule.minute * MINUTE_MS,
        step: DAY_MS,
      };
    }
    case "weekly": {
      const dayStart = Math.floor(start / DAY_MS) * DAY_MS;
      // ISO weekday of the pseudo-UTC day: 1970-01-01 was a Thursday (4).
      const startWeekday = ((((dayStart / DAY_MS) % 7) + 7) % 7 + 3) % 7 + 1;
      const deltaDays = (rule.weekday - startWeekday + 7) % 7;
      return {
        next:
          (dayStart + deltaDays * DAY_MS) +
          rule.hour * HOUR_MS +
          rule.minute * MINUTE_MS,
        step: 7 * DAY_MS,
      };
    }
  }
}

function fieldsOf(wallMs: number) {
  const d = new Date(wallMs);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: 0,
    weekday: 0, // unused by localToUtc
  };
}

/**
 * The first `limit` trigger instants (UTC ms) of `rule` strictly after
 * `after`, in ascending UTC order.
 *
 * Works in local calendar space: each wall-clock slot is resolved through
 * the zone's UTC offsets, so nonexistent local times are skipped and
 * repeated local times yield both UTC instants.
 */
export function nextOccurrences(
  rule: ScheduleRule,
  after: number,
  limit: number,
): number[] {
  validate(rule);
  if (!Number.isInteger(limit) || limit < 0) {
    throw new RangeError(`invalid limit: ${limit}`);
  }
  if (limit === 0) {
    return [];
  }
  const cursor = slotCursor(rule, after);
  const found: number[] = [];
  for (;;) {
    const instants = localToUtc(fieldsOf(cursor.next), rule.timeZone);
    for (const instant of instants) {
      if (instant > after) {
        found.push(instant);
      }
    }
    cursor.next += cursor.step;
    found.sort((a, b) => a - b);
    // The first `limit` results are final once every future slot resolves
    // later than the current limit-th result: future wall slots are at
    // least cursor.next, and any UTC offset is well within MARGIN_MS.
    if (found.length >= limit && cursor.next - MARGIN_MS > found[limit - 1]!) {
      return found.slice(0, limit);
    }
  }
}
