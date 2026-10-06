/** 精确有理数，用于信用分的无误差计算与边界比较。 */
export interface Rational {
  readonly num: bigint;
  readonly den: bigint;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x === 0n ? 1n : x;
}

function normalize(num: bigint, den: bigint): Rational {
  if (den === 0n) {
    throw new Error('rational with zero denominator');
  }
  if (den < 0n) {
    return normalize(-num, -den);
  }
  const g = gcd(num, den);
  return { num: num / g, den: den / g };
}

/** 由十进制数构造精确有理数（支持小数与科学计数法表示）。 */
export function rationalFromNumber(value: number): Rational {
  if (!Number.isFinite(value)) {
    throw new Error(`weight must be finite, got ${value}`);
  }
  const text = value.toString().toLowerCase();
  const [mantissaPart, exponentPart] = text.split('e');
  const exponent = exponentPart === undefined ? 0 : Number(exponentPart);
  const negative = mantissaPart.startsWith('-');
  const mantissa = negative ? mantissaPart.slice(1) : mantissaPart;
  const [intPart, fracPart = ''] = mantissa.split('.');
  const digits = BigInt((intPart === '' ? '0' : intPart) + fracPart);
  const num = negative ? -digits : digits;
  const scale = fracPart.length - exponent;
  if (scale >= 0) {
    return normalize(num, 10n ** BigInt(scale));
  }
  return normalize(num * 10n ** BigInt(-scale), 1n);
}

export function rationalFromInt(value: bigint): Rational {
  return { num: value, den: 1n };
}

export function add(a: Rational, b: Rational): Rational {
  return normalize(a.num * b.den + b.num * a.den, a.den * b.den);
}

export function mul(a: Rational, b: Rational): Rational {
  return normalize(a.num * b.num, a.den * b.den);
}

export function div(a: Rational, b: Rational): Rational {
  if (b.num === 0n) {
    throw new Error('division by zero rational');
  }
  return normalize(a.num * b.den, a.den * b.num);
}

/** a < b 的精确比较。 */
export function lessThan(a: Rational, b: Rational): boolean {
  return a.num * b.den < b.num * a.den;
}

export function toNumber(r: Rational): number {
  return Number(r.num) / Number(r.den);
}
