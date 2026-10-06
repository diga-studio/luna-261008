/** Parsed decimal: value = scaled / 10^scale. */
export interface Decimal {
  scaled: bigint;
  scale: number;
}

export interface DecimalSpec {
  maxIntegerDigits: number;
  maxFractionDigits: number;
  allowNegative: boolean;
}

/**
 * Parse and validate a decimal literal; null when invalid.
 * Requires an integer part; no exponent, no plus sign, no whitespace.
 */
export function parseDecimal(text: string, spec: DecimalSpec): Decimal | null {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) return null;
  const [, sign, intPart, fracPart] = m;
  if (sign === "-" && !spec.allowNegative) return null;
  if (intPart!.length > spec.maxIntegerDigits) return null;
  const frac = fracPart ?? "";
  if (frac.length > spec.maxFractionDigits) return null;
  const digits = intPart! + frac;
  let scaled = BigInt(digits);
  if (sign === "-") scaled = -scaled;
  return { scaled, scale: frac.length };
}

/**
 * Returns round_half_even(q * u) expressed in cents (scale 2).
 * Exact bigint arithmetic; no binary floating point involved.
 */
export function mulRoundHalfEvenToCents(q: Decimal, u: Decimal): bigint {
  const product = q.scaled * u.scaled;
  const scale = q.scale + u.scale;
  if (scale <= 2) {
    return product * 10n ** BigInt(2 - scale);
  }
  const div = 10n ** BigInt(scale - 2);
  const negative = product < 0n;
  const abs = negative ? -product : product;
  const quo = abs / div;
  const rem = abs % div;
  const twice = rem * 2n;
  let rounded: bigint;
  if (twice > div) {
    rounded = quo + 1n;
  } else if (twice < div) {
    rounded = quo;
  } else {
    rounded = quo % 2n === 0n ? quo : quo + 1n;
  }
  return negative ? -rounded : rounded;
}
