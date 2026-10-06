/**
 * Time-zone helpers built on the platform Intl (ICU) data. All wall-clock
 * times are expressed as "wall ms": the millisecond value the wall clock
 * would show if it were read as UTC.
 */

interface DateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(timeZone);
  if (fmt === undefined) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatterCache.set(timeZone, fmt);
  }
  return fmt;
}

function partsAt(utcMs: number, timeZone: string): DateTimeParts {
  const parts = formatterFor(timeZone).formatToParts(utcMs);
  const values: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== "literal") {
      values[part.type] = Number(part.value);
    }
  }
  return {
    year: values["year"]!,
    month: values["month"]!,
    day: values["day"]!,
    hour: values["hour"]!,
    minute: values["minute"]!,
    second: values["second"]!,
  };
}

/** Milliseconds of `utcMs` within its second (always non-negative). */
function millisOf(utcMs: number): number {
  return ((utcMs % 1000) + 1000) % 1000;
}

/** Wall-clock reading of `utcMs` in `timeZone`, as wall ms. */
function wallMsAt(utcMs: number, timeZone: string): number {
  const p = partsAt(utcMs, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) + millisOf(utcMs);
}

/**
 * Offset (ms) of `timeZone` ahead of UTC at instant `utcMs`:
 * localWallClock = utc + offset.
 */
export function offsetAt(utcMs: number, timeZone: string): number {
  return wallMsAt(utcMs, timeZone) - utcMs;
}

const HOUR = 3_600_000;

/**
 * Probe offsets around the wall time. Any UTC instant whose wall reading is
 * `wallMs` lies within +/-14h of it (the largest IANA offsets), and offset
 * transitions can reach 24h (e.g. Pacific/Apia 2011), so probe generously.
 */
const PROBE_DELTAS = [-26, -12, -6, -3, -1, 0, 1, 3, 6, 12, 26].map((h) => h * HOUR);

/**
 * All UTC instants whose local wall-clock reading in `timeZone` equals
 * `wallMs`, ascending. Empty when the wall time is skipped by a forward
 * transition; two entries when it is repeated by a backward transition.
 */
export function utcInstantsForWallTime(wallMs: number, timeZone: string): number[] {
  const offsets = new Set<number>();
  for (const delta of PROBE_DELTAS) {
    offsets.add(offsetAt(wallMs + delta, timeZone));
  }
  const instants: number[] = [];
  for (const offset of offsets) {
    const candidate = wallMs - offset;
    if (wallMsAt(candidate, timeZone) === wallMs && !instants.includes(candidate)) {
      instants.push(candidate);
    }
  }
  instants.sort((a, b) => a - b);
  return instants;
}

/** Local wall-clock components of a UTC instant in a time zone. */
export interface WallClock {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
  weekday: number; // 1 (Monday) - 7 (Sunday)
}

export function wallClockAt(utcMs: number, timeZone: string): WallClock {
  const p = partsAt(utcMs, timeZone);
  const dayMs = Date.UTC(p.year, p.month - 1, p.day);
  const sunday0 = new Date(dayMs).getUTCDay();
  return {
    year: p.year,
    month: p.month,
    day: p.day,
    hour: p.hour,
    minute: p.minute,
    second: p.second,
    millisecond: millisOf(utcMs),
    weekday: ((sunday0 + 6) % 7) + 1,
  };
}
