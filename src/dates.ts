/**
 * Day serial number: an integer counting days since the Unix epoch,
 * computed with UTC arithmetic so results never depend on the host
 * machine timezone. Unbounded interval ends map to -/+ Infinity.
 */
export type DayNumber = number;

const DATE_PATTERN = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const MS_PER_DAY = 86400000;

/** Parse an MM/DD/YYYY date into a day serial number. Throws on invalid input. */
export function parseDate(date: string): DayNumber {
  const match = DATE_PATTERN.exec(date);
  if (!match) {
    throw new Error(`invalid date "${date}": expected MM/DD/YYYY`);
  }
  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  if (month < 1 || month > 12) {
    throw new Error(`invalid date "${date}": month out of range`);
  }
  // Date.UTC normalizes overflows; compare round-trip to reject
  // impossible days such as 02/30/2024.
  const millis = Date.UTC(year, month - 1, day);
  const check = new Date(millis);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    throw new Error(`invalid date "${date}": day out of range`);
  }
  return millis / MS_PER_DAY;
}

/** Parse an optional interval bound; null maps to the given infinity. */
export function parseBound(date: string | null, infinity: DayNumber): DayNumber {
  return date === null ? infinity : parseDate(date);
}
