interface NormalizedDecimal {
  /** false when the value is zero (sign and exponent are then irrelevant). */
  readonly nonzero: boolean;
  readonly negative: boolean;
  /** Mantissa digits with leading and trailing zeros stripped. */
  readonly digits: string;
  /** Exponent such that value = 0.digits * 10^exp (digits[0] !== '0'). */
  readonly exp: number;
}

function normalize(raw: string): NormalizedDecimal {
  let i = 0;
  let negative = false;
  if (raw.charCodeAt(0) === 45 /* - */) {
    negative = true;
    i = 1;
  }
  let intEnd = raw.length;
  for (let j = i; j < raw.length; j++) {
    const c = raw.charCodeAt(j);
    if (c === 46 /* . */ || c === 101 /* e */ || c === 69 /* E */) {
      intEnd = j;
      break;
    }
  }
  let fracStart = -1;
  let fracEnd = -1;
  let expStart = -1;
  for (let j = intEnd; j < raw.length; j++) {
    const c = raw.charCodeAt(j);
    if (c === 46) {
      fracStart = j + 1;
      fracEnd = raw.length;
    } else if (c === 101 || c === 69) {
      if (fracStart >= 0) fracEnd = j;
      expStart = j + 1;
      break;
    }
  }
  if (fracStart >= 0 && fracEnd < 0) fracEnd = expStart >= 0 ? expStart - 1 : raw.length;

  let exp = 0;
  if (expStart >= 0) {
    // Exponent magnitude is guaranteed <= 1e9, so it parses exactly.
    exp = Number(raw.slice(expStart));
  }
  const intDigits = raw.slice(i, intEnd);
  const fracDigits = fracStart >= 0 ? raw.slice(fracStart, fracEnd) : '';
  const mantissa = intDigits + fracDigits;
  // value = mantissa * 10^(exp - fracDigits.length)
  let pointExp = exp - fracDigits.length;

  // Strip leading zeros: they do not change the exponent base because we
  // track value = digits * 10^pointExp with digits as an integer string.
  let start = 0;
  while (start < mantissa.length && mantissa.charCodeAt(start) === 48) start++;
  // Strip trailing zeros, folding them into the exponent.
  let end = mantissa.length;
  while (end > start && mantissa.charCodeAt(end - 1) === 48) end--;
  const digits = mantissa.slice(start, end);
  if (digits.length === 0) {
    return { nonzero: false, negative: false, digits: '', exp: 0 };
  }
  pointExp += mantissa.length - end;
  // Convert to 0.digits * 10^exp form: exp = pointExp + digits.length.
  return { nonzero: true, negative, digits, exp: pointExp + digits.length };
}

/**
 * Compares two JSON number literals by exact decimal value.
 * Returns true when both denote the same mathematical value
 * ("1" == "1.0" == "10e-1", -0 == 0). Handles mantissas of arbitrary
 * length and exponents with absolute value up to 1e9 in O(mantissa) time
 * without materializing big integers.
 */
export function numberLiteralsEqual(a: string, b: string): boolean {
  if (a === b) return true;
  const na = normalize(a);
  const nb = normalize(b);
  if (na.nonzero !== nb.nonzero) return false;
  if (!na.nonzero) return true;
  return na.negative === nb.negative && na.exp === nb.exp && na.digits === nb.digits;
}
