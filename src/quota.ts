/**
 * 按最大余数法把需求拆成各分支的整数额度：
 * 先取 floor(demand * percent / 100)，剩余按小数部分从大到小补给，
 * 小数部分相同则分支编号小者优先，每个分支最多补一份。
 * 需求为 0 时所有分支额度为 0。
 * 全程使用整数运算（demand * percent <= 1e11，远小于 2^53），结果精确。
 */
export function splitBranchQuotas(
  demand: number,
  branches: ReadonlyArray<{ branchId: number; percent: number }>,
): Map<number, number> {
  const items = branches.map((branch) => {
    const numerator = demand * branch.percent;
    return {
      branchId: branch.branchId,
      base: Math.floor(numerator / 100),
      remainder: numerator % 100,
    };
  });

  let leftover = demand;
  for (const item of items) {
    leftover -= item.base;
  }

  const order = items
    .map((item, index) => ({ ...item, index }))
    .sort((a, b) => b.remainder - a.remainder || a.branchId - b.branchId);

  const quotas = new Map<number, number>();
  for (const item of items) {
    quotas.set(item.branchId, item.base);
  }
  for (let i = 0; i < leftover; i += 1) {
    const target = order[i];
    quotas.set(target.branchId, (quotas.get(target.branchId) ?? 0) + 1);
  }
  return quotas;
}
