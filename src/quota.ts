import type { AudienceGroupInput, BranchQuota } from "./types";

/**
 * 按最大余数法把一个人群组的曝光需求分摊为各分支的精确整数额度：
 * 1. 各分支先取 floor(demand * percent / 100)；
 * 2. 剩余曝光按小数部分从大到小补给，每个分支最多补一份；
 * 3. 小数部分相同时，分支编号小的优先。
 *
 * 需求为 0 的组返回全 0 额度。
 */
export function computeBranchQuotas(group: AudienceGroupInput): BranchQuota[] {
  const { demand, branches } = group;
  const base = branches.map((b) => ({
    branchId: b.branchId,
    // demand <= 1e9、percent <= 100，乘积 <= 1e11，在安全整数范围内，取模精确。
    floor: Math.floor((demand * b.percent) / 100),
    remainder: (demand * b.percent) % 100,
  }));

  let allocated = 0;
  for (const b of base) allocated += b.floor;
  let leftover = demand - allocated;

  // 余数从大到小；余数相同则分支编号小的优先。每个分支最多补一份。
  const order = [...base].sort((a, b) => b.remainder - a.remainder || a.branchId - b.branchId);
  const bonus = new Map<number, number>();
  for (const b of order) {
    if (leftover <= 0) break;
    if (b.remainder === 0) break;
    bonus.set(b.branchId, 1);
    leftover -= 1;
  }

  return branches.map((b) => ({
    regionCode: group.regionCode,
    segmentId: group.segmentId,
    branchId: b.branchId,
    quota: demand === 0 ? 0 : base.find((x) => x.branchId === b.branchId)!.floor + (bonus.get(b.branchId) ?? 0),
  }));
}
