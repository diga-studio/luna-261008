const AMOUNT_PATTERN = /^\d+(\.\d{1,4})?$/;

/**
 * Parse a non-negative decimal text with at most 4 fractional digits
 * into integer units of 1e-4. Throws on invalid input.
 */
export function parseAmountToUnits(text: string): number {
  if (!AMOUNT_PATTERN.test(text)) {
    throw new Error(
      `invalid amount "${text}": expected a non-negative decimal with at most 4 fractional digits`,
    );
  }
  const dot = text.indexOf(".");
  const intPart = dot === -1 ? text : text.slice(0, dot);
  const fracPart = dot === -1 ? "" : text.slice(dot + 1);
  const units =
    Number(intPart) * 10000 + Number((fracPart + "0000").slice(0, 4));
  if (!Number.isSafeInteger(units)) {
    throw new Error(`amount "${text}" exceeds the supported range`);
  }
  return units;
}

/** Format integer 1e-4 units as decimal text with exactly 4 fractional digits. */
export function formatUnits(units: number): string {
  if (!Number.isSafeInteger(units) || units < 0) {
    throw new Error(`cannot format ${units} as 1e-4 units`);
  }
  const intPart = Math.floor(units / 10000);
  const fracPart = units % 10000;
  return `${intPart}.${String(fracPart).padStart(4, "0")}`;
}

const SUB_UNITS_PER_UNIT = 100000000n;

/**
 * Format an exact value given in 1e-8 sub-units as decimal text
 * (up to 8 fractional digits, trailing zeros trimmed beyond 4).
 */
export function formatSubUnits(subUnits: bigint): string {
  if (subUnits < 0n) {
    throw new Error("formatSubUnits expects a non-negative value");
  }
  const intPart = subUnits / SUB_UNITS_PER_UNIT;
  let frac = String(subUnits % SUB_UNITS_PER_UNIT).padStart(8, "0");
  while (frac.length > 4 && frac.endsWith("0")) {
    frac = frac.slice(0, -1);
  }
  return `${intPart}.${frac}`;
}

/** Format a signed exact value given in 1e-8 sub-units. */
export function formatSignedSubUnits(subUnits: bigint): string {
  if (subUnits < 0n) {
    return `-${formatSubUnits(-subUnits)}`;
  }
  return formatSubUnits(subUnits);
}
