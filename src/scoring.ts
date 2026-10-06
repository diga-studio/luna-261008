import {
  add,
  div,
  lessThan,
  mul,
  rationalFromInt,
  rationalFromNumber,
  toNumber,
  type Rational,
} from './rational.js';
import type { CreditResult, DimensionValues, Weights } from './types.js';

const RESTRICTION_THRESHOLD = rationalFromInt(40n);
const DEFAULT_SCORE = rationalFromInt(100n);

/**
 * 纯函数评分：输入当前权重与主体各逻辑评级的最新有效版本，
 * 输出信用分与是否限制邀评。
 *
 * 对每个已配置且存在有效观测的维度，先求该主体所有有效逻辑评级
 * 在此维度上的算术平均，再按权重求这些维度平均值的加权平均。
 * 没有观测的维度不参与分母；没有任何参与维度时信用分为 100。
 * 未配置标签的值不参与评分。全程使用精确有理数，避免边界舍入误差。
 */
export function computeCredit(
  weights: Weights,
  latestVersions: DimensionValues[],
): CreditResult {
  const sums = new Map<string, bigint>();
  const counts = new Map<string, bigint>();
  for (const values of latestVersions) {
    for (const [label, value] of Object.entries(values)) {
      if (!(label in weights)) {
        continue;
      }
      sums.set(label, (sums.get(label) ?? 0n) + BigInt(value));
      counts.set(label, (counts.get(label) ?? 0n) + 1n);
    }
  }

  let weightedSum = rationalFromInt(0n);
  let weightTotal = rationalFromInt(0n);
  for (const [label, sum] of sums) {
    const count = counts.get(label)!;
    const weight = rationalFromNumber(weights[label]);
    const average = div(
      rationalFromInt(sum),
      rationalFromInt(100n * count),
    );
    weightedSum = add(weightedSum, mul(weight, average));
    weightTotal = add(weightTotal, weight);
  }

  const score: Rational =
    weightTotal.num === 0n ? DEFAULT_SCORE : div(weightedSum, weightTotal);
  return {
    score: toNumber(score),
    restricted: lessThan(score, RESTRICTION_THRESHOLD),
  };
}
