import { parseDecimal, roundToCentsHalfEven } from './decimal.js';
import type { RowErrorCode } from './types.js';

export interface RowValidation {
  errors: RowErrorCode[];
  /** True when field count is right and resource_id/usage_date are valid. */
  keyValid: boolean;
  key: { resourceId: string; usageDate: string } | null;
}

const FIELD_COUNT = 5;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Strict YYYY-MM-DD, real proleptic Gregorian date, year 0001-9999. */
export function isValidUsageDate(text: string): boolean {
  const m = DATE_RE.exec(text);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (year < 1 || year > 9999) return false;
  if (month < 1 || month > 12) return false;
  const maxDay =
    month === 2 && isLeapYear(year) ? 29 : (DAYS_IN_MONTH[month - 1] as number);
  return day >= 1 && day <= maxDay;
}

/** Validate one decoded data record. All problems are reported. */
export function validateRow(fields: string[]): RowValidation {
  const errors: RowErrorCode[] = [];
  if (fields.length !== FIELD_COUNT) {
    return { errors: ['FIELD_COUNT'], keyValid: false, key: null };
  }
  const [resourceId, usageDate, quantityText, unitCostText, totalCostText] =
    fields as [string, string, string, string, string];

  const resourceIdOk = resourceId.length > 0;
  if (!resourceIdOk) errors.push('RESOURCE_ID_EMPTY');
  const usageDateOk = isValidUsageDate(usageDate);
  if (!usageDateOk) errors.push('USAGE_DATE_INVALID');

  const quantity = parseDecimal(quantityText, 16, 6, false);
  if (!quantity) errors.push('USAGE_QUANTITY_INVALID');
  const unitCost = parseDecimal(unitCostText, 16, 8, true);
  if (!unitCost) errors.push('UNIT_COST_INVALID');
  const totalCost = parseDecimal(totalCostText, 16, 2, true);
  if (!totalCost) errors.push('TOTAL_COST_INVALID');

  if (quantity && unitCost && totalCost) {
    // quantity (scale<=6) * unitCost (scale<=8): exact product at scale s1+s2.
    const productScaled = quantity.scaled * unitCost.scaled;
    const productScale = quantity.scale + unitCost.scale;
    const expectedCents = roundToCentsHalfEven(productScaled, productScale);
    const actualCents =
      totalCost.scale <= 2
        ? totalCost.scaled * 10n ** BigInt(2 - totalCost.scale)
        : -1n; // unreachable: totalCost scale is capped at 2
    if (expectedCents !== actualCents) errors.push('TOTAL_COST_MISMATCH');
  }

  const keyValid = resourceIdOk && usageDateOk;
  return {
    errors,
    keyValid,
    key: keyValid ? { resourceId, usageDate } : null,
  };
}
