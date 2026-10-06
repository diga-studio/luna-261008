/**
 * Time-zone helpers: convert between UTC millisecond timestamps and local
 * wall-clock calendar fields for an IANA zone, resolving gaps (nonexistent
 * local times) and overlaps (repeated local times).
 */

export interface LocalFields {
  readonly year: number;
  readonly month: number; // 1-12
  readonly day: number; // 1-31
  readonly hour: number; // 0-23
  readonly minute: number; // 0-59
  readonly second: number; // 0-59
  readonly weekday: number; // 1 (Monday) - 7 (Sunday)
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(timeZone);
  if (fmt === undefined) {
    // Throws RangeError for an unknown IANA zone: that is the validation point.
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      calendar: "gregory",
      numberingSystem: "latn",
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatterCache.set(timeZone, fmt);
  }
  return fmt;
}

/** Days since 1970-01-01 for a proleptic Gregorian civil date. */
export function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400; // [0, 399]
  const mp = (month + 9) % 12; // [0, 11], March = 0
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function weekdayOf(year: number, month: number, day: number): number {
  const days = daysFromCivil(year, month, day);
  // 1970-01-01 (days = 0) was a Thursday; ISO weekday of Thursday is 4.
  return ((((days % 7) + 7) % 7) + 3) % 7 + 1;
}

/** Local wall-clock fields of a UTC instant in `timeZone`. */
export function utcToLocal(utcMs: number, timeZone: string): LocalFields {
  const parts = formatterFor(timeZone).formatToParts(new Date(utcMs));
  let year = 0;
  let month = 0;
  let day = 0;
  let hour = 0;
  let minute = 0;
  let second = 0;
  for (const part of parts) {
    const value = Number(part.value);
    switch (part.type) {
      case "year":
        year = value;
        break;
      case "month":
        month = value;
        break;
      case "day":
        day = value;
        break;
      case "hour":
        // Some environments emit 24 for midnight even with hourCycle h23.
        hour = value === 24 ? 0 : value;
        break;
      case "minute":
        minute = value;
        break;
      case "second":
        second = value;
        break;
      default:
        break;
    }
  }
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    weekday: weekdayOf(year, month, day),
  };
}

/** Offset (local wall clock minus UTC), in ms, at a UTC instant. */
function offsetAt(utcMs: number, timeZone: string): number {
  const local = utcToLocal(utcMs, timeZone);
  const localAsUtc = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second,
  );
  const utcSecond = utcMs - (utcMs % 1000);
  return localAsUtc - utcSecond;
}

function sameWallClock(a: LocalFields, b: LocalFields): boolean {
  return (
    a.year === b.year &&
    a.month === b.month &&
    a.day === b.day &&
    a.hour === b.hour &&
    a.minute === b.minute &&
    a.second === b.second
  );
}

/**
 * All UTC instants whose local wall-clock time equals the given fields
 * (seconds are taken from `fields.second`; milliseconds are always zero).
 * Empty array if the local time does not exist (gap); two entries (UTC
 * ascending) if it occurs twice (overlap); otherwise one entry.
 */
export function localToUtc(fields: LocalFields, timeZone: string): number[] {
  const pseudoUtc = Date.UTC(
    fields.year,
    fields.month - 1,
    fields.day,
    fields.hour,
    fields.minute,
    fields.second,
  );
  // Seed with offsets observed around the wall time, then iterate to a
  // fixpoint so transitions inside the window (overlaps, date-line jumps)
  // are all discovered.
  const offsets = new Set<number>([
    offsetAt(pseudoUtc - 26 * 3600_000, timeZone),
    offsetAt(pseudoUtc, timeZone),
    offsetAt(pseudoUtc + 26 * 3600_000, timeZone),
  ]);
  for (let round = 0; round < 4; round++) {
    const before = offsets.size;
    const discovered: number[] = [];
    for (const offset of offsets) {
      discovered.push(offsetAt(pseudoUtc - offset, timeZone));
    }
    for (const offset of discovered) {
      offsets.add(offset);
    }
    if (offsets.size === before) {
      break;
    }
  }
  const instants: number[] = [];
  for (const offset of offsets) {
    const candidate = pseudoUtc - offset;
    if (sameWallClock(utcToLocal(candidate, timeZone), fields)) {
      instants.push(candidate);
    }
  }
  instants.sort((a, b) => a - b);
  return instants;
}
