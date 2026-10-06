import type { IntInput } from './types.js';

const MAX_ABS = 10n ** 18n - 1n;

/** 归一化为 bigint；拒绝小数、负数与超过 18 位的值。 */
export function toInt(value: IntInput, field: string): bigint {
  let out: bigint;
  if (typeof value === 'bigint') {
    out = value;
  } else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(`${field}: number 必须为安全整数，收到 ${value}`);
    }
    out = BigInt(value);
  } else if (typeof value === 'string') {
    if (!/^(0|[1-9][0-9]*)$/.test(value)) {
      throw new RangeError(`${field}: 字符串必须为非负整数，收到 ${value}`);
    }
    out = BigInt(value);
  } else {
    throw new TypeError(`${field}: 不支持的类型 ${typeof value}`);
  }
  if (out < 0n) {
    throw new RangeError(`${field}: 不允许负数，收到 ${out}`);
  }
  if (out > MAX_ABS) {
    throw new RangeError(`${field}: 超过 18 位上限，收到 ${out}`);
  }
  return out;
}

/** 毫分转分，仅最后四舍五入，恰好半分向上。 */
export function roundHalfUpToCents(milli: bigint): bigint {
  if (milli >= 0n) {
    return (milli + 500n) / 1000n;
  }
  return -((-milli + 500n) / 1000n);
}

/** 基准金额（分）：票量 × 合同价，精确到毫分后仅在最后四舍五入到分。 */
export function baselineCents(qty: bigint, priceCents: bigint): bigint {
  return roundHalfUpToCents(qty * priceCents);
}

/**
 * 判断 |金额 - 基准金额| 是否不超过基准金额的 2%；基准为零时金额必须为零。
 * 比较本身用 50*|diff| <= base 精确整数运算，不舍入、不用近似值。
 */
export function withinTolerance(amountCents: bigint, qty: bigint, priceCents: bigint): boolean {
  const base = baselineCents(qty, priceCents);
  if (base === 0n) {
    return amountCents === 0n;
  }
  const diff = amountCents > base ? amountCents - base : base - amountCents;
  return diff * 50n <= base;
}

/** 判断 数量 是否不超过 上限 的 105%（含边界）：qty*20 <= cap*21，精确比较。 */
export function withinCap105(qty: bigint, cap: bigint): boolean {
  return qty * 20n <= cap * 21n;
}
