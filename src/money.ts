/** 精确金额/数量计算：全部基于 bigint。 */

function abs(v: bigint): bigint {
  return v < 0n ? -v : v;
}

/**
 * 基准金额 = 票量(千分之一单位) * 单价(分) / 1000，仅最后一步四舍五入到分，
 * 恰好半分向上。支持负数（对称处理）。
 */
export function baselineAmount(qtyMilli: bigint, unitPrice: bigint): bigint {
  const product = qtyMilli * unitPrice;
  if (product >= 0n) {
    return (product + 500n) / 1000n;
  }
  return -((-product + 500n) / 1000n);
}

/**
 * 判断 amount 与基准金额（已按规则舍入到分）的偏差是否不超过基准的 2%。
 * 比较本身用整数交叉相乘：|amount - baseline| * 100 <= baseline * 2，
 * 不舍入、不近似。基准为零时仅允许金额为零（右侧为 0 自然覆盖）。
 */
export function withinTolerance(amount: bigint, qtyMilli: bigint, unitPrice: bigint): boolean {
  const baseline = baselineAmount(qtyMilli, unitPrice);
  return abs(amount - baseline) * 100n <= baseline * 2n;
}
