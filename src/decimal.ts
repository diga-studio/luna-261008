/**
 * 精确十进制定点数：value = mantissa / 10^scale。
 * 基于 BigInt，保证极大数量与极小尾数的数学精确性。
 */
export interface Decimal {
  readonly mantissa: bigint;
  readonly scale: number;
}

const DECIMAL_RE = /^(\d+)(?:\.(\d+))?$/;
const INTEGER_RE = /^\d+$/;

/** 解析十进制文本（非负，可带小数点），校验格式与小数位数上限。 */
export function parseDecimal(text: string, maxFractionDigits: number, what: string): Decimal {
  const m = DECIMAL_RE.exec(text);
  if (m === null) {
    throw new Error(`invalid decimal for ${what}: ${JSON.stringify(text)}`);
  }
  const frac = m[2] ?? '';
  if (frac.length > maxFractionDigits) {
    throw new Error(`too many fraction digits for ${what}: ${JSON.stringify(text)} (max ${maxFractionDigits})`);
  }
  const mantissa = BigInt(m[1]! + frac);
  return { mantissa, scale: frac.length };
}

/** 解析非负整数十进制文本。 */
export function parseInteger(text: string, what: string): bigint {
  if (!INTEGER_RE.test(text)) {
    throw new Error(`invalid integer for ${what}: ${JSON.stringify(text)}`);
  }
  return BigInt(text);
}

export function decimalFromBigint(value: bigint): Decimal {
  return { mantissa: value, scale: 0 };
}

function pow10(n: number): bigint {
  return 10n ** BigInt(n);
}

export function addDecimal(a: Decimal, b: Decimal): Decimal {
  if (a.scale === b.scale) {
    return { mantissa: a.mantissa + b.mantissa, scale: a.scale };
  }
  if (a.scale > b.scale) {
    return { mantissa: a.mantissa + b.mantissa * pow10(a.scale - b.scale), scale: a.scale };
  }
  return { mantissa: a.mantissa * pow10(b.scale - a.scale) + b.mantissa, scale: b.scale };
}

export function multiplyDecimal(a: Decimal, b: Decimal): Decimal {
  return { mantissa: a.mantissa * b.mantissa, scale: a.scale + b.scale };
}

/** 向上取整到整数（ceil），返回 BigInt。值必须非负。 */
export function ceilDecimal(a: Decimal): bigint {
  if (a.mantissa < 0n) {
    throw new Error('ceilDecimal expects a non-negative value');
  }
  if (a.scale === 0) {
    return a.mantissa;
  }
  const unit = pow10(a.scale);
  const q = a.mantissa / unit;
  return a.mantissa % unit === 0n ? q : q + 1n;
}

/** BigInt 转十进制文本。 */
export function bigintToText(value: bigint): string {
  return value.toString(10);
}
