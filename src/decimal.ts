import { TrialError } from './types.js';

/**
 * 精确十进制定点运算：内部以 bigint 保存“值 × SCALE”。
 * 用量最多 6 位小数，损耗率换算因子分母为 10^6（百分数最多 4 位小数），
 * 故 SCALE = 10^12 可精确表示所有中间结果。
 */
export const SCALE: bigint = 1_000_000_000_000n;

const LOSS_FACTOR_SCALE: bigint = 1_000_000n;

const DECIMAL_RE = /^(\d+)(?:\.(\d+))?$/;

function parseParts(text: string, maxDecimals: number, what: string): [string, string] {
  const m = DECIMAL_RE.exec(text);
  if (m === null) {
    throw new TrialError('INVALID_INPUT', `${what} 不是合法的十进制文本: ${JSON.stringify(text)}`);
  }
  const frac = m[2] ?? '';
  if (frac.length > maxDecimals) {
    throw new TrialError('INVALID_INPUT', `${what} 小数位超过 ${maxDecimals} 位: ${JSON.stringify(text)}`);
  }
  return [m[1] as string, frac];
}

/** 解析十进制文本为定点值（内部表示，值 × 10^12） */
export function parseDecimal(text: string, maxDecimals: number): bigint {
  const [intPart, frac] = parseParts(text, maxDecimals, '数量');
  const fracPadded = (frac + '000000000000').slice(0, 12);
  return BigInt(intPart) * SCALE + BigInt(fracPadded);
}

/** 解析整数十进制文本（根件需求），返回定点值 */
export function parseInteger(text: string): bigint {
  const [intPart, frac] = parseParts(text, 0, '根件需求');
  void frac;
  return BigInt(intPart) * SCALE;
}

/** 解析损耗率百分数文本（0~100，最多 4 位小数），返回“1 + rate/100”乘以 10^6 的因子 */
export function parseLossFactor(text: string | undefined): bigint {
  if (text === undefined) {
    return LOSS_FACTOR_SCALE + LOSS_FACTOR_SCALE / 40n; // 缺省 2.5% → 1.025 × 10^6
  }
  const [intPart, frac] = parseParts(text, 4, '损耗率');
  // rate/100 = (intPart.frac) / 100，放大 10^6 倍：intPart × 10^4 + frac(补齐4位)
  const fracPadded = (frac + '0000').slice(0, 4);
  const rateScaled = BigInt(intPart) * 10_000n + BigInt(fracPadded);
  if (rateScaled > 1_000_000n) {
    throw new TrialError('INVALID_INPUT', `损耗率超出 0~100 范围: ${JSON.stringify(text)}`);
  }
  return LOSS_FACTOR_SCALE + rateScaled;
}

/** 组件需求 = 父件数量(定点) × 用量(定点) × 损耗因子(10^6 缩放)，结果仍为定点值 */
export function multiplyLine(parentScaled: bigint, usageScaled: bigint, lossFactor: bigint): bigint {
  return (parentScaled * usageScaled * lossFactor) / (SCALE * LOSS_FACTOR_SCALE);
}

/** 定点值向上取整到整件（返回整数 bigint） */
export function ceilToInteger(scaled: bigint): bigint {
  return (scaled + SCALE - 1n) / SCALE;
}

/** 整数 bigint 转十进制文本 */
export function integerToText(value: bigint): string {
  return value.toString(10);
}
