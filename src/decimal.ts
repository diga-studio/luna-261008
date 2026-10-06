import type { NormalizedNumber } from './types';

const NUMBER_RE = /^-?(?:0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/;

/**
 * Normalize a JSON number literal to an exact decimal of the form
 * sign * digits * 10^exp, with leading/trailing zeros stripped from digits.
 * Never materializes the value, so exponents up to 1e9 and mantissas up to
 * 4096 digits cost only a few string scans.
 */
export function normalizeNumber(raw: string): NormalizedNumber {
  const match = NUMBER_RE.exec(raw);
  if (match === null) {
    throw new Error(`invalid JSON number literal: ${raw}`);
  }
  const negative = raw.charCodeAt(0) === 45; // '-'
  const mantissaStart = negative ? 1 : 0;
  let mantissaEnd = raw.length;
  let expPart = 0;
  const expMatch = match[2];
  if (expMatch !== undefined) {
    const eIdx = raw.indexOf('e') !== -1 ? raw.indexOf('e') : raw.indexOf('E');
    mantissaEnd = eIdx;
    expPart = parseExponent(expMatch);
  }
  const frac = match[1];
  const fracLen = frac !== undefined ? frac.length : 0;
  // Concatenated significant digits: integer part + fraction part.
  const intPart = raw.slice(mantissaStart, frac !== undefined ? mantissaEnd - fracLen - 1 : mantissaEnd);
  const combined = frac !== undefined ? intPart + frac : intPart;
  // Exponent of the combined digit string before zero-stripping.
  let exp = expPart - fracLen;
  // Strip leading zeros.
  let start = 0;
  while (start < combined.length && combined.charCodeAt(start) === 48) {
    start += 1;
  }
  // Strip trailing zeros, crediting the exponent.
  let end = combined.length;
  while (end > start && combined.charCodeAt(end - 1) === 48) {
    end -= 1;
    exp += 1;
  }
  if (start >= end) {
    return { sign: 0, digits: '', exp: 0 };
  }
  return { sign: negative ? -1 : 1, digits: combined.slice(start, end), exp };
}

/** Parse an exponent literal; |exp| <= 1e9 per spec, so it fits a JS number. */
function parseExponent(text: string): number {
  let i = 0;
  let neg = false;
  if (text.charCodeAt(0) === 43 || text.charCodeAt(0) === 45) {
    neg = text.charCodeAt(0) === 45;
    i = 1;
  }
  let value = 0;
  for (; i < text.length; i += 1) {
    value = value * 10 + (text.charCodeAt(i) - 48);
  }
  return neg ? -value : value;
}

/** Exact decimal equality: same sign, same significant digits, same exponent. */
export function normalizedEqual(a: NormalizedNumber, b: NormalizedNumber): boolean {
  return a.sign === b.sign && a.exp === b.exp && a.digits === b.digits;
}
