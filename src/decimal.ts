export interface ParsedDecimal {
  /** Value scaled by 10^scale, exact. */
  scaled: bigint;
  scale: number;
}

const DECIMAL_RE = /^(-?)(\d+)(?:\.(\d+))?$/;

/**
 * Parse a strict decimal literal: optional '-', required integer part of at
 * most maxIntDigits digits, optional fraction of at most maxFracDigits.
 * No exponent, no '+', no surrounding whitespace, no empty integer part.
 * Returns null when invalid.
 */
export function parseDecimal(
  text: string,
  maxIntDigits: number,
  maxFracDigits: number,
  allowNegative: boolean,
): ParsedDecimal | null {
  const m = DECIMAL_RE.exec(text);
  if (!m) return null;
  const [, sign, intPart, fracPart] = m;
  if (sign === '-' && !allowNegative) return null;
  if (intPart === undefined || intPart.length > maxIntDigits) return null;
  const frac = fracPart ?? '';
  if (frac.length > maxFracDigits) return null;
  const digits = intPart + frac;
  const scale = frac.length;
  let scaled = BigInt(digits === '' ? '0' : digits);
  if (sign === '-' && scaled !== 0n) scaled = -scaled;
  return { scaled, scale };
}

/** 10^n as bigint for small non-negative n. */
function pow10(n: number): bigint {
  return 10n ** BigInt(n);
}

/**
 * Rescale a value scaled by 10^fromScale to cents (scale 2), rounding to
 * nearest with ties-to-even. Requires fromScale >= 2.
 */
export function roundToCentsHalfEven(scaled: bigint, fromScale: number): bigint {
  if (fromScale < 2) {
    return scaled * pow10(2 - fromScale);
  }
  const factor = pow10(fromScale - 2);
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const quotient = abs / factor;
  const remainder = abs % factor;
  const twice = remainder * 2n;
  let rounded: bigint;
  if (twice < factor) {
    rounded = quotient;
  } else if (twice > factor) {
    rounded = quotient + 1n;
  } else {
    // Exact midpoint: round to even cent.
    rounded = quotient % 2n === 0n ? quotient : quotient + 1n;
  }
  return negative ? -rounded : rounded;
}
