/**
 * America/New_York civil-time to UTC conversion.
 * Implemented from the US DST rules (post-2007): DST starts on the second
 * Sunday of March at 02:00 local standard time and ends on the first Sunday
 * of November at 02:00 local daylight time. No fixed UTC offset is used.
 */

const HOUR_MS = 3_600_000;
const STD_OFFSET_MS = -5 * HOUR_MS;
const DST_OFFSET_MS = -4 * HOUR_MS;

/** Day of month of the n-th Sunday (1-based n) of a month. */
function nthSunday(year: number, monthIndex: number, n: number): number {
  const first = new Date(Date.UTC(year, monthIndex, 1));
  const firstSunday = 1 + ((7 - first.getUTCDay()) % 7);
  return firstSunday + (n - 1) * 7;
}

/** UTC instant when DST starts in the given (UTC/local) year. */
function dstStartUtc(year: number): number {
  return Date.UTC(year, 2, nthSunday(year, 2, 2), 7, 0, 0, 0);
}

/** UTC instant when DST ends in the given (UTC/local) year. */
function dstEndUtc(year: number): number {
  return Date.UTC(year, 10, nthSunday(year, 10, 1), 6, 0, 0, 0);
}

/** UTC offset (ms) of America/New_York at the given UTC instant. */
export function utcOffsetMsAt(utcMs: number): number {
  // DST transitions happen in March and November; at UTC year boundaries
  // New York is always on standard time, so the UTC year is safe to use.
  const year = new Date(utcMs).getUTCFullYear();
  return utcMs >= dstStartUtc(year) && utcMs < dstEndUtc(year)
    ? DST_OFFSET_MS
    : STD_OFFSET_MS;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function parseDate(date: string): [number, number, number] {
  const [y, m, d] = date.split("-").map(Number);
  return [y, m, d];
}

function parseTime(time: string): [number, number] {
  const [hh, mm] = time.split(":").map(Number);
  return [hh, mm];
}

/**
 * Convert a local wall-clock time to UTC.
 * date: local calendar date "YYYY-MM-DD"; time: "HH:mm".
 * kind is:
 *  - "unique": exactly one matching instant
 *  - "ambiguous": two matching instants (fall-back); utcMs is the earlier one
 *  - "gap": no matching instant (spring-forward); utcMs is the wall time
 *    shifted forward by the missing duration, converted to UTC
 */
export function localToUtc(
  date: string,
  time: string
): { utcMs: number; kind: "unique" | "ambiguous" | "gap" } {
  const [y, m, d] = parseDate(date);
  const [hh, mm] = parseTime(time);
  // Wall-clock reading interpreted as if it were UTC.
  const wallMs = Date.UTC(y, m - 1, d, hh, mm, 0, 0);
  const utcStd = wallMs - STD_OFFSET_MS;
  const utcDst = wallMs - DST_OFFSET_MS;
  const validStd = utcOffsetMsAt(utcStd) === STD_OFFSET_MS;
  const validDst = utcOffsetMsAt(utcDst) === DST_OFFSET_MS;
  if (validStd && validDst) {
    // Fall-back: two instants; the earlier one is the daylight reading.
    return { utcMs: Math.min(utcStd, utcDst), kind: "ambiguous" };
  }
  if (validStd) return { utcMs: utcStd, kind: "unique" };
  if (validDst) return { utcMs: utcDst, kind: "unique" };
  // Spring-forward gap: shift the wall time forward by the missing
  // duration (DST - STD = +1h) and read it with the daylight offset.
  const shifted = wallMs + (DST_OFFSET_MS - STD_OFFSET_MS);
  return { utcMs: shifted - DST_OFFSET_MS, kind: "gap" };
}

/** Convert a UTC instant to local wall-clock date and time. */
export function utcToLocal(utcMs: number): { date: string; time: string } {
  const shifted = new Date(utcMs + utcOffsetMsAt(utcMs));
  const date = `${shifted.getUTCFullYear()}-${pad2(
    shifted.getUTCMonth() + 1
  )}-${pad2(shifted.getUTCDate())}`;
  const time = `${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}`;
  return { date, time };
}

/** Add n days to a local date "YYYY-MM-DD". */
export function addDays(date: string, n: number): string {
  const [y, m, d] = parseDate(date);
  const shifted = new Date(Date.UTC(y, m - 1, d + n));
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(
    shifted.getUTCDate()
  )}`;
}
