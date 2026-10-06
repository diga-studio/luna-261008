import { mulRoundHalfEvenToCents, parseDecimal } from "./decimal.js";
import type { RowErrorCode } from "./types.js";

export interface ValidatedRow {
  resourceId: string;
  usageDate: string;
  quantity: string;
  unitCost: string;
  totalCost: string;
}

export interface RowValidation {
  errors: RowErrorCode[];
  /** True when field count is right and resource_id + usage_date are valid. */
  keyValid: boolean;
  row: ValidatedRow | null;
}

const QUANTITY_SPEC = { maxIntegerDigits: 16, maxFractionDigits: 6, allowNegative: false };
const UNIT_COST_SPEC = { maxIntegerDigits: 16, maxFractionDigits: 8, allowNegative: true };
const TOTAL_COST_SPEC = { maxIntegerDigits: 16, maxFractionDigits: 2, allowNegative: true };

/** Validate one decoded record (5 fields expected). Reports every error found. */
export function validateRow(fields: string[]): RowValidation {
  if (fields.length !== 5) {
    return { errors: ["FIELD_COUNT"], keyValid: false, row: null };
  }
  const [resourceId, usageDate, quantity, unitCost, totalCost] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  const errors: RowErrorCode[] = [];

  const resourceOk = resourceId.length > 0;
  if (!resourceOk) errors.push("EMPTY_RESOURCE_ID");

  const dateOk = isValidDate(usageDate);
  if (!dateOk) errors.push("INVALID_DATE");

  const q = parseDecimal(quantity, QUANTITY_SPEC);
  if (q === null) errors.push("INVALID_QUANTITY");

  const u = parseDecimal(unitCost, UNIT_COST_SPEC);
  if (u === null) errors.push("INVALID_UNIT_COST");

  const t = parseDecimal(totalCost, TOTAL_COST_SPEC);
  if (t === null) errors.push("INVALID_TOTAL_COST");

  if (q !== null && u !== null && t !== null) {
    const expectedCents = mulRoundHalfEvenToCents(q, u);
    const actualCents = t.scaled * 10n ** BigInt(2 - t.scale);
    if (expectedCents !== actualCents) errors.push("TOTAL_MISMATCH");
  }

  const keyValid = resourceOk && dateOk;
  const row =
    errors.length === 0
      ? { resourceId, usageDate, quantity, unitCost, totalCost }
      : null;
  return { errors, keyValid, row };
}

/** Strict YYYY-MM-DD, real Gregorian date, year 0001-9999. */
export function isValidDate(text: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1]!;
}
