import type { DateString } from "./types.js";

/**
 * A calendar day represented as an integer day number, comparable with
 * <, >, ===. Independent of the host machine timezone.
 */
export type DayNumber = number;

/** Parse "MM/DD/YYYY" into a DayNumber. Throws on malformed input. */
export function parseDate(date: DateString): DayNumber {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(date);
  if (!match) {
    throw new Error(`invalid date "${date}": expected MM/DD/YYYY`);
  }
  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  if (month < 1 || month > 12) {
    throw new Error(`invalid date "${date}": month out of range`);
  }
  if (day < 1 || day > daysInMonth(year, month)) {
    throw new Error(`invalid date "${date}": day out of range`);
  }
  return daysFromCivil(year, month, day);
}

/** The day after the given day. */
export function nextDay(day: DayNumber): DayNumber {
  return day + 1;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  const lengths = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return lengths[month - 1]!;
}

/**
 * Days since 1970-01-01 for a proleptic Gregorian date, computed with
 * integer arithmetic only (Howard Hinnant's days_from_civil), so results
 * never depend on the host timezone.
 */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (month + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}
